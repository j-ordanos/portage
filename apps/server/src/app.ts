import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  AppError,
  createCoolifyReader,
  createDokployClient,
  redactPatterns,
} from "@migrator/core";
import argon2 from "argon2";
import { Hono, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "./config.js";
import { Store, type User } from "./db/store.js";
import { ApplyManager } from "./runs/apply-manager.js";
import { ConnectionService } from "./runs/connections.js";
import { EventHub } from "./runs/hub.js";
import { type Deps, RunService } from "./runs/service.js";

export const VERSION = "0.1.0";

export interface AppOptions {
  config: Config;
  store?: Store;
  /** Inject fakes in tests. */
  clients?: Deps;
  sleep?: (ms: number) => Promise<void>;
  /** Pause between Dokploy writes (spec: >= 100 ms to avoid hammering Dokploy). */
  pauseBetweenWritesMs?: number;
}

const realClients: Deps = {
  coolify: (c) =>
    createCoolifyReader({ baseUrl: c.url, token: c.token, timeoutMs: 30_000 }),
  dokploy: (c) =>
    createDokployClient({
      baseUrl: c.url,
      apiKey: c.apiKey,
      timeoutMs: 30_000,
    }),
};

/**
 * 401 is reserved for "your session is missing or expired", because the UI signs you out on it.
 * A rejected Coolify/Dokploy credential is the upstream's problem, so it gets 422.
 */
const STATUS_BY_CODE: Record<string, number> = {
  UPSTREAM_AUTH: 422,
  UPSTREAM_FORBIDDEN: 422,
  UPSTREAM_NOT_FOUND: 404,
  UPSTREAM_VALIDATION: 422,
  UPSTREAM_UNREACHABLE: 502,
  UPSTREAM_5XX: 502,
  UPSTREAM_RATE_LIMIT: 429,
  SCHEMA_DRIFT: 502,
  CONFIG_INVALID: 400,
  RUN_LOCKED: 409,
  SECRET_UNAVAILABLE: 409,
};

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;

type Env = { Variables: { user: User } };

export function createApp(options: AppOptions) {
  const { config } = options;
  const store = options.store ?? new Store(config.DATA_DIR, config.MASTER_KEY);
  const deps = options.clients ?? realClients;
  const service = new RunService(store, deps, config);
  const connections = new ConnectionService(store, deps, config);
  const hub = new EventHub();
  const manager = new ApplyManager(service, store, hub, {
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.pauseBetweenWritesMs
      ? { pauseBetweenWritesMs: options.pauseBetweenWritesMs }
      : {}),
  });
  const attempts = new Map<string, { count: number; resetAt: number }>();
  const secureCookie = Boolean(config.PUBLIC_URL?.startsWith("https://"));
  const cookieName = secureCookie ? "__Host-portage" : "portage_session";
  const app = new Hono<Env>();

  // ---- security headers ----
  app.use("*", async (c, next) => {
    await next();
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    if (secureCookie)
      c.header(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
  });

  const readToken = (cookie: string) =>
    cookie.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`))?.[1];
  const PUBLIC = new Set([
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/me",
    "/api/public",
  ]);

  // ---- /api guard: session, body size, CSRF ----
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const length = c.req.header("Content-Length");
    if (length && Number(length) > 1_048_576)
      return c.json({ message: "Request body too large" }, 413);
    const isPublic = PUBLIC.has(c.req.path);
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) &&
      !(isPublic && c.req.path !== "/api/auth/logout")
    ) {
      if (c.req.header("X-Requested-With") !== "migrator")
        return c.json({ message: "Missing migration request header" }, 403);
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
      const origin = c.req.header("Origin");
      if (origin) {
        let host: string;
        try {
          host = new URL(origin).host;
        } catch {
          return c.json({ message: "Invalid Origin header" }, 403);
        }
        if (host !== c.req.header("Host"))
          return c.json({ message: "Origin does not match this server" }, 403);
      }
    }
    const token = readToken(c.req.header("Cookie") ?? "");
    const userId = token ? store.sessionUser(token) : undefined;
    const user = userId ? store.getUser(userId) : undefined;
    if (user) c.set("user", user);
    if (!isPublic && !user)
      return c.json({ message: "Sign in to continue" }, 401);
    await next();
  });

  // A person only ever sees their own runs.
  const ownsRun: MiddlewareHandler<Env> = async (c, next) => {
    const run = store.getRun(c.req.param("id") ?? "");
    const user = c.get("user");
    if (!run || !user || run.userId !== user.id)
      return c.json({ message: "Run not found" }, 404);
    await next();
  };
  app.use("/api/runs/:id", ownsRun);
  app.use("/api/runs/:id/*", ownsRun);

  app.onError((error, c) => {
    const runId = c.req.param("id");
    const redact = (text: string) =>
      redactPatterns(runId ? store.redactor(runId).redact(text) : text);
    if (error instanceof AppError) {
      const status =
        (error as { status?: number }).status ??
        STATUS_BY_CODE[error.code] ??
        500;
      return c.json(
        {
          code: error.code,
          message: redact(error.message),
          ...(error.hint ? { hint: error.hint } : {}),
        },
        status as 400,
      );
    }
    if (error instanceof Error && error.name === "ZodError")
      return c.json(
        { code: "CONFIG_INVALID", message: "Invalid request payload" },
        400,
      );
    process.stderr.write(
      `Unhandled error: ${redact(error instanceof Error ? error.message : "unknown")}\n`,
    );
    return c.json(
      { code: "INTERNAL", message: "Unexpected server error" },
      500,
    );
  });

  app.get("/healthz", (c) => c.json({ ok: true, version: VERSION }));
  app.get("/api/public", (c) =>
    c.json({
      version: VERSION,
      allowSignup: config.ALLOW_SIGNUP || store.userCount() === 0,
      allowPrivateUpstreams: config.UPSTREAM_ALLOW_PRIVATE,
    }),
  );

  // ---- accounts ----
  const limited = (ip: string): boolean => {
    const now = Date.now();
    const hit = attempts.get(ip);
    if (hit && hit.resetAt > now && hit.count >= 8) return true;
    attempts.set(
      ip,
      hit && hit.resetAt > now
        ? { count: hit.count + 1, resetAt: hit.resetAt }
        : { count: 1, resetAt: now + 60_000 },
    );
    return false;
  };
  const startSession = (
    c: { header: (n: string, v: string) => void },
    userId: string,
  ) => {
    const token = store.createSession(userId, SESSION_MS);
    c.header(
      "Set-Cookie",
      `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secureCookie ? "; Secure" : ""}`,
    );
  };
  const ipOf = (c: { req: { header: (n: string) => string | undefined } }) =>
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? "local";

  app.post("/api/auth/register", async (c) => {
    if (limited(ipOf(c)))
      return c.json(
        { message: "Too many attempts. Wait a minute and try again." },
        429,
      );
    const first = store.userCount() === 0;
    if (!first && !config.ALLOW_SIGNUP)
      return c.json({ message: "Sign-ups are closed on this server" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as {
      email?: unknown;
      password?: unknown;
    };
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!EMAIL.test(email))
      return c.json({ message: "Enter a valid email address" }, 400);
    if (password.length < 10)
      return c.json(
        { message: "Use at least 10 characters for the password" },
        400,
      );
    if (password.length > 200)
      return c.json({ message: "That password is too long" }, 400);
    if (store.getUserByEmail(email))
      return c.json(
        {
          message:
            "An account with this email already exists. Sign in instead.",
        },
        409,
      );
    const user = store.createUser(
      email,
      await argon2.hash(password, { type: argon2.argon2id }),
    );
    if (first) store.adoptOrphanRuns(user.id); // upgrade path from the single-password version
    startSession(c, user.id);
    return c.json({ user: { id: user.id, email: user.email } }, 201);
  });
  app.post("/api/auth/login", async (c) => {
    if (limited(ipOf(c)))
      return c.json(
        { message: "Too many attempts. Wait a minute and try again." },
        429,
      );
    const body = (await c.req.json().catch(() => ({}))) as {
      email?: unknown;
      password?: unknown;
    };
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const user = store.getUserByEmail(email);
    // verify against a dummy hash when the user does not exist, so timing does not reveal which emails are registered
    const hash =
      user?.passwordHash ??
      "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const ok =
      typeof body.password === "string" &&
      (await argon2.verify(hash, body.password).catch(() => false));
    if (!user || !ok)
      return c.json({ message: "Email or password is incorrect" }, 401);
    store.touchLogin(user.id);
    startSession(c, user.id);
    return c.json({ user: { id: user.id, email: user.email } });
  });
  app.post("/api/auth/logout", (c) => {
    const token = readToken(c.req.header("Cookie") ?? "");
    if (token) store.deleteSession(token);
    c.header(
      "Set-Cookie",
      `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? "; Secure" : ""}`,
    );
    return c.json({ ok: true });
  });
  // 200 for visitors too: "not signed in" is a normal state of the landing page, not an error
  app.get("/api/auth/me", (c) => {
    const user = c.get("user") as User | undefined;
    return c.json(
      user
        ? { authenticated: true, user: { id: user.id, email: user.email } }
        : { authenticated: false },
    );
  });
  app.put("/api/auth/password", async (c) => {
    const user = c.get("user") as User;
    const body = (await c.req.json().catch(() => ({}))) as {
      current?: unknown;
      next?: unknown;
    };
    const row = store.getUserByEmail(user.email);
    if (
      !row ||
      typeof body.current !== "string" ||
      !(await argon2.verify(row.passwordHash, body.current).catch(() => false))
    ) {
      return c.json({ message: "Your current password is not correct" }, 403);
    }
    if (typeof body.next !== "string" || body.next.length < 10)
      return c.json(
        { message: "Use at least 10 characters for the new password" },
        400,
      );
    store.changePassword(
      user.id,
      await argon2.hash(body.next, { type: argon2.argon2id }),
    );
    startSession(c, user.id); // changing the password signs out every session; keep this one
    return c.json({ ok: true });
  });

  // ---- saved connections ----
  const uid = (c: { get: (k: "user") => User }) => c.get("user").id;
  app.get("/api/connections", (c) =>
    c.json({ connections: connections.list(uid(c)) }),
  );
  app.post("/api/connections", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await connections.create(uid(c), body as never), 201);
  });
  app.put("/api/connections/:id", async (c) =>
    c.json(
      await connections.update(
        uid(c),
        c.req.param("id"),
        (await c.req.json().catch(() => ({}))) as never,
      ),
    ),
  );
  app.post("/api/connections/:id/test", async (c) =>
    c.json(await connections.test(uid(c), c.req.param("id"))),
  );
  app.delete("/api/connections/:id", (c) => {
    connections.delete(uid(c), c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---- runs ----
  const view = (id: string) => {
    const run = service.getRun(id);
    const steps = store.listSteps(id);
    return {
      id: run.id,
      name: run.name,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      coolifyUrl: run.coolifyUrl,
      dokployUrl: run.dokployUrl,
      coolifyVersion: run.coolifyVersion,
      dokployVersion: run.dokployVersion,
      hasInventory: run.ir !== null,
      hasPlan: run.plan !== null,
      applying: manager.isActive(id),
      credentialsActive: service.credentialsAvailable(id),
      progress: {
        total: steps.length,
        done: steps.filter((s) => s.state === "done").length,
        failed: steps.filter((s) => s.state === "failed").length,
        skipped: steps.filter((s) => s.state === "skipped").length,
      },
    };
  };

  app.get("/api/runs", (c) =>
    c.json({
      runs: store.listRuns(uid(c)).map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        coolifyUrl: r.coolifyUrl,
        dokployUrl: r.dokployUrl,
        progress: (() => {
          const steps = store.listSteps(r.id);
          return {
            total: steps.length,
            done: steps.filter((s) => s.state === "done").length,
          };
        })(),
      })),
    }),
  );
  app.post("/api/runs", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      coolifyConnectionId?: string;
      dokployConnectionId?: string;
    } | null;
    if (!body?.coolifyConnectionId || !body.dokployConnectionId) {
      return c.json(
        { message: "Choose a Coolify connection and a Dokploy connection" },
        400,
      );
    }
    const result = await service.connect(uid(c), {
      coolifyConnectionId: body.coolifyConnectionId,
      dokployConnectionId: body.dokployConnectionId,
    });
    return c.json(
      {
        runId: result.run.id,
        coolify: result.coolify,
        dokploy: result.dokploy,
      },
      201,
    );
  });
  app.get("/api/runs/:id", (c) => c.json(view(c.req.param("id"))));
  app.delete("/api/runs/:id", (c) => {
    if (manager.isActive(c.req.param("id")))
      return c.json({ message: "Pause or cancel the run first" }, 409);
    service.purge(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/runs/:id/discover", async (c) => {
    const ir = await service.discover(c.req.param("id"));
    return c.json({ projects: ir.projects.length, notes: ir.notes });
  });
  app.get("/api/runs/:id/inventory", (c) =>
    c.json(service.inventory(c.req.param("id"))),
  );
  app.get("/api/runs/:id/options", (c) =>
    c.json(service.userOptions(c.req.param("id"))),
  );
  app.put("/api/runs/:id/options", async (c) =>
    c.json(
      service.setOptions(
        c.req.param("id"),
        await c.req.json().catch(() => ({})),
      ),
    ),
  );
  app.get("/api/runs/:id/target", async (c) =>
    c.json(await service.target(c.req.param("id"))),
  );
  app.get("/api/runs/:id/git", async (c) =>
    c.json(await service.gitView(c.req.param("id"))),
  );
  app.post("/api/runs/:id/plan", async (c) => {
    await service.plan(c.req.param("id"));
    return c.json(service.planView(c.req.param("id")));
  });
  app.get("/api/runs/:id/plan", (c) =>
    c.json(service.planView(c.req.param("id"))),
  );
  app.get("/api/runs/:id/compat.md", (c) =>
    c.text(service.compatMarkdown(c.req.param("id"))),
  );

  app.post("/api/runs/:id/apply", (c) => {
    manager.start(c.req.param("id"));
    return c.json(view(c.req.param("id")), 202);
  });
  app.post("/api/runs/:id/pause", (c) => {
    manager.pause(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/runs/:id/cancel", (c) => {
    manager.cancel(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/runs/:id/steps/:seq/retry", (c) => {
    manager.retry(c.req.param("id"), Number(c.req.param("seq")));
    return c.json({ ok: true });
  });
  app.post("/api/runs/:id/steps/:seq/skip", (c) => {
    manager.skip(c.req.param("id"), Number(c.req.param("seq")));
    return c.json({ ok: true });
  });

  app.get("/api/runs/:id/events", (c) => {
    const runId = c.req.param("id");
    const last =
      Number(c.req.header("Last-Event-ID") ?? c.req.query("after") ?? 0) || 0;
    return streamSSE(c, async (stream) => {
      let cursor = last;
      for (const event of store.listEvents(runId, last)) {
        await stream.writeSSE({
          id: String(event.id),
          event: "log",
          data: JSON.stringify(event),
        });
        cursor = event.id;
      }
      const unsubscribe = hub.subscribe(runId, (event) => {
        if (event.id <= cursor) return;
        cursor = event.id;
        void stream.writeSSE({
          id: String(event.id),
          event: "log",
          data: JSON.stringify(event),
        });
      });
      stream.onAbort(unsubscribe);
      while (!stream.aborted) {
        await stream.sleep(15_000);
        if (!stream.aborted) await stream.write(": heartbeat\n\n");
      }
      unsubscribe();
    });
  });
  app.get("/api/runs/:id/steps", (c) =>
    c.json({
      steps: store.listSteps(c.req.param("id")),
      status: service.getRun(c.req.param("id")).status,
    }),
  );

  app.post("/api/runs/:id/verify", async (c) =>
    c.json({ checks: await service.verify(c.req.param("id")) }),
  );
  app.get("/api/runs/:id/report.md", async (c) =>
    c.text((await service.report(c.req.param("id"))).markdown),
  );
  app.get("/api/runs/:id/manifest.json", async (c) =>
    c.body((await service.report(c.req.param("id"))).manifest, 200, {
      "Content-Type": "application/json",
    }),
  );
  app.get("/api/runs/:id/rollback", (c) =>
    c.json(service.rollbackPreview(c.req.param("id"))),
  );
  app.post("/api/runs/:id/rollback", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: string };
    return c.json(
      await service.rollback(c.req.param("id"), body.confirm ?? ""),
    );
  });
  app.get("/api/runs/:id/checklist", (c) =>
    c.json(store.getChecklist(c.req.param("id"))),
  );
  app.put("/api/runs/:id/checklist", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      item?: string;
      done?: boolean;
    };
    if (!body.item || typeof body.done !== "boolean")
      return c.json({ message: "item and done are required" }, 400);
    store.setChecklistItem(c.req.param("id"), body.item, body.done);
    return c.json({ ok: true });
  });

  // ---- static SPA ----
  const types: Record<string, string> = {
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".css": "text/css",
    ".js": "text/javascript",
    ".svg": "image/svg+xml",
  };
  app.get("/assets/*", async (c) => {
    const path = new URL(`../dist/web/${c.req.path.slice(1)}`, import.meta.url);
    try {
      return new Response(await readFile(path), {
        headers: {
          "Content-Type":
            types[extname(path.pathname)] ?? "application/octet-stream",
        },
      });
    } catch {
      return c.notFound();
    }
  });
  app.get("/favicon.svg", async (c) => {
    try {
      return new Response(
        await readFile(new URL("../dist/web/favicon.svg", import.meta.url)),
        { headers: { "Content-Type": "image/svg+xml" } },
      );
    } catch {
      return c.notFound();
    }
  });
  app.get("*", async (c) => {
    try {
      return c.html(
        await readFile(
          new URL("../dist/web/index.html", import.meta.url),
          "utf8",
        ),
      );
    } catch {
      return c.text(
        "Portage is running. Build the web app to serve the interface.",
      );
    }
  });

  return Object.assign(app, { store, service, connections, manager, hub });
}
