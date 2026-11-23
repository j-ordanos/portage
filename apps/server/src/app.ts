import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  AppError,
  createCoolifyReader,
  createDokployClient,
  redactPatterns,
  type StepRecord,
} from "@migrator/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { verifyPassword } from "./auth/password.js";
import type { Config } from "./config.js";
import { Store } from "./db/store.js";
import { ApplyManager } from "./runs/apply-manager.js";
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

const STATUS_BY_CODE: Record<string, number> = {
  UPSTREAM_AUTH: 401,
  UPSTREAM_FORBIDDEN: 403,
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

export function createApp(options: AppOptions) {
  const { config } = options;
  const store = options.store ?? new Store(config.DATA_DIR, config.MASTER_KEY);
  const service = new RunService(store, options.clients ?? realClients, config);
  const hub = new EventHub();
  const manager = new ApplyManager(service, store, hub, {
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.pauseBetweenWritesMs
      ? { pauseBetweenWritesMs: options.pauseBetweenWritesMs }
      : {}),
  });
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  const secureCookie = Boolean(config.PUBLIC_URL?.startsWith("https://"));
  const app = new Hono();

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
    cookie.match(/(?:^|;\s*)__Host-migrator=([^;]+)/)?.[1] ??
    cookie.match(/(?:^|;\s*)migrator_session=([^;]+)/)?.[1];

  // ---- /api guard: session, body size, CSRF ----
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const isLogin = c.req.path === "/api/auth/login";
    if (!isLogin) {
      const token = readToken(c.req.header("Cookie") ?? "");
      if (!token || !store.sessionValid(token))
        return c.json({ message: "Unauthorized" }, 401);
    }
    const length = c.req.header("Content-Length");
    if (length && Number(length) > 1_048_576)
      return c.json({ message: "Request body too large" }, 413);
    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) && !isLogin) {
      if (c.req.header("X-Requested-With") !== "migrator")
        return c.json({ message: "Missing migration request header" }, 403);
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
    await next();
  });

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
    if (error instanceof Error && error.name === "ZodError") {
      return c.json(
        { code: "CONFIG_INVALID", message: "Invalid request payload" },
        400,
      );
    }
    process.stderr.write(
      `Unhandled error: ${redact(error instanceof Error ? error.message : "unknown")}\n`,
    );
    return c.json(
      { code: "INTERNAL", message: "Unexpected server error" },
      500,
    );
  });

  app.get("/healthz", (c) => c.json({ ok: true, version: VERSION }));

  // ---- auth ----
  app.post("/api/auth/login", async (c) => {
    const ip =
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? "local";
    const now = Date.now();
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.resetAt > now && attempt.count >= 5)
      return c.json({ message: "Too many login attempts" }, 429);
    loginAttempts.set(
      ip,
      attempt && attempt.resetAt > now
        ? { count: attempt.count + 1, resetAt: attempt.resetAt }
        : { count: 1, resetAt: now + 60_000 },
    );
    const body = (await c.req.json().catch(() => ({}))) as {
      password?: unknown;
    };
    const ok =
      typeof body.password === "string" &&
      (await verifyPassword(body.password, config.ADMIN_PASSWORD_HASH));
    if (!ok) return c.json({ message: "Incorrect password" }, 401);
    loginAttempts.delete(ip);
    const token = store.createSession(12 * 60 * 60 * 1000);
    c.header(
      "Set-Cookie",
      secureCookie
        ? `__Host-migrator=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=43200`
        : `migrator_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`,
    );
    return c.json({ ok: true });
  });
  app.post("/api/auth/logout", (c) => {
    const token = readToken(c.req.header("Cookie") ?? "");
    if (token) store.deleteSession(token);
    c.header(
      "Set-Cookie",
      `${secureCookie ? "__Host-migrator" : "migrator_session"}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
    return c.json({ ok: true });
  });
  app.get("/api/auth/me", (c) =>
    c.json({ authenticated: true, version: VERSION }),
  );
  app.get("/api/settings", (c) =>
    c.json({
      version: VERSION,
      retentionDays: config.RUN_RETENTION_DAYS,
      allowPrivateUpstreams: config.UPSTREAM_ALLOW_PRIVATE,
    }),
  );

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
      credentialsActive: store.getCredentials(id, false) !== undefined,
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
      runs: store.listRuns().map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        coolifyUrl: r.coolifyUrl,
        dokployUrl: r.dokployUrl,
      })),
    }),
  );
  app.post("/api/runs", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      coolify?: { url?: string; token?: string; allowInsecureHttp?: boolean };
      dokploy?: { url?: string; apiKey?: string; allowInsecureHttp?: boolean };
    } | null;
    if (
      !body?.coolify?.url ||
      !body.coolify.token ||
      !body.dokploy?.url ||
      !body.dokploy.apiKey
    ) {
      return c.json(
        {
          message: "Coolify URL + token and Dokploy URL + API key are required",
        },
        400,
      );
    }
    const result = await service.connect({
      coolify: {
        url: body.coolify.url,
        token: body.coolify.token,
        allowInsecureHttp: body.coolify.allowInsecureHttp === true,
      },
      dokploy: {
        url: body.dokploy.url,
        apiKey: body.dokploy.apiKey,
        allowInsecureHttp: body.dokploy.allowInsecureHttp === true,
      },
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
  app.put("/api/runs/:id/credentials", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      dokployApiKey?: string;
      coolifyToken?: string;
    };
    await service.reenterCredentials(c.req.param("id"), body);
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
    service.getRun(runId);
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
        "Migrator server is running. Build the web app to serve the SPA.",
      );
    }
  });

  return Object.assign(app, { store, service, manager, hub });
}

export type { StepRecord };
