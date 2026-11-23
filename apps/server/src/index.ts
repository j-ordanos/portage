import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { serve } from "@hono/node-server";
import {
  AppError,
  createCoolifyReader,
  createDokployClient,
  extractInventory,
  IR,
  MemoryVault,
  runRules,
} from "@migrator/core";
import dotenv from "dotenv";
import { Hono } from "hono";
import { verifyPassword } from "./auth/password.js";
import { readConfig } from "./config.js";
import { JsonRunStore, type PersistedRun } from "./db/json-store.js";
import { openDatabase, purgeExpiredSecrets } from "./db/store.js";

dotenv.config({ path: new URL("../../../.env", import.meta.url) });

export const VERSION = "0.1.0";
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const sessions = new Map<string, number>();

function sessionCookie(token: string, secure: boolean): string {
  if (secure) {
    return `__Host-migrator=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=43200`;
  }
  return `migrator_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`;
}

function readSessionToken(cookieHeader: string): string | undefined {
  return (
    cookieHeader.match(/(?:^|;\s*)__Host-migrator=([^;]+)/)?.[1] ??
    cookieHeader.match(/(?:^|;\s*)migrator_session=([^;]+)/)?.[1]
  );
}

function sealLocal(value: string, encodedKey: string): string {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) throw new Error("MASTER_KEY must decode to 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function openLocal(sealed: string, encodedKey: string): string {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) throw new Error("MASTER_KEY must decode to 32 bytes");
  const data = Buffer.from(sealed, "base64");
  if (data.length < 28) throw new Error("Tampered ciphertext");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

interface ConnectionCredentials {
  coolifyCiphertext?: string;
  dokployCiphertext?: string;
}

const connectionCredentials = new Map<string, ConnectionCredentials>();
let jsonRunStore: JsonRunStore | undefined;

function getRunStore(): JsonRunStore {
  if (!jsonRunStore) {
    const config = readConfig();
    jsonRunStore = new JsonRunStore(config.DATA_DIR);
  }
  return jsonRunStore;
}

interface CoreSecurityModule {
  validateUpstreamUrl(
    input: string,
    options: { allowPrivate: boolean; allowedHosts?: string[] },
    allowInsecureHttp?: boolean,
  ): URL;
}

async function validateConnectionUrl(
  input: string,
  allowPrivate: boolean,
  allowedHosts: string[] | undefined,
  allowInsecureHttp: boolean,
): Promise<URL> {
  const core = (await import(
    "@migrator/core"
  )) as unknown as CoreSecurityModule;
  return core.validateUpstreamUrl(
    input,
    { allowPrivate, ...(allowedHosts?.length ? { allowedHosts } : {}) },
    allowInsecureHttp,
  );
}

export function createApp() {
  const app = new Hono();
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
    const config = readConfig();
    if (config.PUBLIC_URL?.startsWith("https://")) {
      c.header(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
  });
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.path !== "/api/auth/login") {
      const cookie = c.req.header("Cookie") ?? "";
      const token = readSessionToken(cookie);
      const expiresAt = token ? sessions.get(token) : undefined;
      if (!token || !expiresAt || expiresAt <= Date.now()) {
        if (token) sessions.delete(token);
        return c.json({ message: "Unauthorized" }, 401);
      }
    }
    const contentLength = c.req.header("Content-Length");
    if (contentLength && Number(contentLength) > 1_048_576) {
      return c.json({ message: "Request body too large" }, 413);
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
      if (
        c.req.path !== "/api/auth/login" &&
        c.req.header("X-Requested-With") !== "migrator"
      ) {
        return c.json({ message: "Missing migration request header" }, 403);
      }
      const origin = c.req.header("Origin");
      if (origin) {
        const host = c.req.header("Host");
        if (!host) return c.json({ message: "Missing Host header" }, 403);
        let originUrl: URL;
        try {
          originUrl = new URL(origin);
        } catch {
          return c.json({ message: "Invalid Origin header" }, 403);
        }
        if (`${originUrl.host}` !== host) {
          return c.json({ message: "Origin does not match this server" }, 403);
        }
      }
    }
    await next();
  });
  app.get("/healthz", (c) => c.json({ ok: true, version: VERSION }));
  app.post("/api/auth/login", async (c) => {
    const ip =
      c.req.header("CF-Connecting-IP") ??
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
      "unknown";
    const now = Date.now();
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.resetAt > now && attempt.count >= 5) {
      return c.json({ message: "Too many login attempts" }, 429);
    }
    const nextAttempt =
      attempt && attempt.resetAt > now
        ? { count: attempt.count + 1, resetAt: attempt.resetAt }
        : { count: 1, resetAt: now + 60_000 };
    loginAttempts.set(ip, nextAttempt);
    const body = await c.req.json().catch(() => ({}));
    const password =
      typeof body === "object" &&
      body !== null &&
      "password" in body &&
      typeof body.password === "string"
        ? body.password
        : "";
    const config = readConfig();
    const accepted = await verifyPassword(password, config.ADMIN_PASSWORD_HASH);
    if (!accepted) return c.json({ message: "Incorrect password" }, 401);
    loginAttempts.delete(ip);
    const token = randomBytes(32).toString("base64url");
    sessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
    const secure = Boolean(readConfig().PUBLIC_URL?.startsWith("https://"));
    c.header("Set-Cookie", sessionCookie(token, secure));
    return c.json({ ok: true });
  });
  app.get("/api/runs/:id/report", (c) => {
    const run = getRunStore().get(c.req.param("id"));
    if (!run) return c.json({ message: "Run not found" }, 404);
    if (!run.irJson) {
      return c.json({ message: "Discovery is not complete" }, 409);
    }
    try {
      const rawIr = JSON.parse(run.irJson) as unknown;
      const ir = IR.parse(rawIr);
      const transformed = runRules(ir, { sensitiveRead: true });
      const selection = run.selectionJson
        ? (JSON.parse(run.selectionJson) as {
            includeSrcIds?: string[];
            decisions?: Record<
              string,
              "migrate" | "skip" | "acknowledge-manual"
            >;
          })
        : null;
      const include = new Set(selection?.includeSrcIds);
      const decisions = run.decisionsJson
        ? (JSON.parse(run.decisionsJson) as Record<
            string,
            "skip" | "acknowledge-manual"
          >)
        : {};
      const resources = transformed.projects.flatMap((project) =>
        project.environments.flatMap((environment) =>
          environment.resources
            .filter(
              (resource) =>
                !include || include.size === 0 || include.has(resource.srcId),
            )
            .map((resource) => ({
              srcId: resource.srcId,
              projectName: project.name,
              environmentName: environment.name,
              name: resource.name,
              kind: resource.kind,
              compat: resource.compat,
              decision: decisions[resource.srcId] ?? "migrate",
              issues: resource.issues,
            })),
        ),
      );
      const unresolvedErrors = resources.filter(
        (resource) =>
          resource.issues.some((issue) => issue.severity === "error") &&
          resource.decision !== "acknowledge-manual" &&
          resource.decision !== "skip",
      );
      const report = {
        summary: {
          total: resources.length,
          auto: resources.filter((resource) => resource.compat === "auto")
            .length,
          partial: resources.filter((resource) => resource.compat === "partial")
            .length,
          manual: resources.filter((resource) => resource.compat === "manual")
            .length,
          unresolvedErrors: unresolvedErrors.length,
        },
        resources,
        canContinue: unresolvedErrors.length === 0,
      };
      getRunStore().put({
        ...run,
        reportJson: JSON.stringify(report),
        updatedAt: Date.now(),
      });
      return c.json(report);
    } catch (error) {
      return c.json(
        {
          code: "SCHEMA_DRIFT",
          message:
            error instanceof Error
              ? "Persisted inventory could not be parsed"
              : "Compatibility report failed",
        },
        500,
      );
    }
  });
  app.put("/api/runs/:id/report/decision", async (c) => {
    const store = getRunStore();
    const run = store.get(c.req.param("id"));
    if (!run) return c.json({ message: "Run not found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body !== "object" ||
      typeof body.resourceId !== "string" ||
      (body.decision !== "skip" && body.decision !== "acknowledge-manual")
    ) {
      return c.json(
        { message: "Valid resourceId and decision are required" },
        400,
      );
    }
    const decisions = run.decisionsJson
      ? (JSON.parse(run.decisionsJson) as Record<
          string,
          "skip" | "acknowledge-manual"
        >)
      : {};
    decisions[body.resourceId] = body.decision;
    store.put({
      ...run,
      decisionsJson: JSON.stringify(decisions),
      updatedAt: Date.now(),
    });
    return c.json({ ok: true, decision: decisions });
  });
  app.post("/api/auth/logout", (c) => {
    const cookie = c.req.header("Cookie") ?? "";
    const token = readSessionToken(cookie);
    if (token) sessions.delete(token);
    c.header(
      "Set-Cookie",
      "migrator_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    );
    return c.json({ ok: true });
  });
  app.get("/api/auth/me", (c) => c.json({ authenticated: true }));
  app.post("/api/connections/coolify/test", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (
      typeof body !== "object" ||
      body === null ||
      typeof body.url !== "string" ||
      typeof body.token !== "string"
    ) {
      return c.json({ message: "URL and token are required" }, 400);
    }
    const allowInsecureHttp = body.allowInsecureHttp === true;
    try {
      const config = readConfig();
      const allowedHosts = config.UPSTREAM_ALLOWED_HOSTS?.split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean);
      const url = await validateConnectionUrl(
        body.url,
        config.UPSTREAM_ALLOW_PRIVATE,
        allowedHosts,
        allowInsecureHttp,
      );
      const reader = createCoolifyReader({
        baseUrl: url.toString(),
        token: body.token,
      });
      const probe = await reader.probe();
      await reader.listProjects();
      const cookie = c.req.header("Cookie") ?? "";
      const token = readSessionToken(cookie);
      if (token) {
        const config = readConfig();
        const current = connectionCredentials.get(token) ?? {};
        current.coolifyCiphertext = sealLocal(
          JSON.stringify({ url: url.toString(), token: body.token }),
          config.MASTER_KEY,
        );
        connectionCredentials.set(token, current);
      }
      return c.json({
        version: probe.version,
        role: "unknown",
        scopes: probe.abilities,
        warnings: probe.warnings,
      });
    } catch (error) {
      if (error instanceof AppError) {
        return c.json(
          { code: error.code, message: error.message, hint: error.hint },
          error.code === "UPSTREAM_AUTH"
            ? 401
            : error.code === "UPSTREAM_FORBIDDEN"
              ? 403
              : error.code === "UPSTREAM_NOT_FOUND"
                ? 404
                : 502,
        );
      }
      return c.json(
        { code: "CONFIG_INVALID", message: "Invalid or unsafe Coolify URL" },
        400,
      );
    }
  });
  app.post("/api/connections/dokploy/test", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (
      typeof body !== "object" ||
      body === null ||
      typeof body.url !== "string" ||
      typeof body.apiKey !== "string"
    ) {
      return c.json({ message: "URL and API key are required" }, 400);
    }
    const allowInsecureHttp = body.allowInsecureHttp === true;
    try {
      const config = readConfig();
      const allowedHosts = config.UPSTREAM_ALLOWED_HOSTS?.split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean);
      const url = await validateConnectionUrl(
        body.url,
        config.UPSTREAM_ALLOW_PRIVATE,
        allowedHosts,
        allowInsecureHttp,
      );
      const client = createDokployClient({
        baseUrl: url.toString(),
        apiKey: body.apiKey,
      });
      const probe = await client.probe();
      await client.projectAll();
      const cookie = c.req.header("Cookie") ?? "";
      const token = readSessionToken(cookie);
      if (token) {
        const config = readConfig();
        const current = connectionCredentials.get(token) ?? {};
        current.dokployCiphertext = sealLocal(
          JSON.stringify({ url: url.toString(), apiKey: body.apiKey }),
          config.MASTER_KEY,
        );
        connectionCredentials.set(token, current);
      }
      return c.json({
        version: probe.version,
        authStyle: probe.authStyle,
        warnings: ["Write access is verified on first apply."],
      });
    } catch (error) {
      if (error instanceof AppError) {
        return c.json(
          { code: error.code, message: error.message, hint: error.hint },
          error.code === "UPSTREAM_AUTH"
            ? 401
            : error.code === "UPSTREAM_FORBIDDEN"
              ? 403
              : error.code === "UPSTREAM_NOT_FOUND"
                ? 404
                : 502,
        );
      }
      return c.json(
        { code: "CONFIG_INVALID", message: "Invalid or unsafe Dokploy URL" },
        400,
      );
    }
  });
  app.get("/api/runs", (c) => {
    const runs = getRunStore().list();
    return c.json({
      runs: runs.map((run) => ({
        id: run.id,
        name: run.name,
        status: run.status,
        step: run.step,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      })),
    });
  });
  app.post("/api/runs", (c) => {
    const cookie = c.req.header("Cookie") ?? "";
    const sessionToken = readSessionToken(cookie);
    if (!sessionToken) return c.json({ message: "Unauthorized" }, 401);
    const credentials = connectionCredentials.get(sessionToken);
    if (!credentials?.coolifyCiphertext || !credentials.dokployCiphertext) {
      return c.json(
        {
          message:
            "Test and confirm both Coolify and Dokploy connections first",
        },
        400,
      );
    }
    const now = Date.now();
    const id = randomBytes(12).toString("base64url");
    const config = readConfig();
    let coolifyUrl = "";
    let dokployUrl = "";
    let combinedCredentials: {
      coolify: { url: string; token: string };
      dokploy: { url: string; apiKey: string };
    };
    try {
      const coolify = JSON.parse(
        openLocal(credentials.coolifyCiphertext, config.MASTER_KEY),
      ) as { url: string; token: string };
      const dokploy = JSON.parse(
        openLocal(credentials.dokployCiphertext, config.MASTER_KEY),
      ) as { url: string; apiKey: string };
      coolifyUrl = coolify.url;
      dokployUrl = dokploy.url;
      combinedCredentials = { coolify, dokploy };
    } catch {
      return c.json({ message: "Stored connection data is invalid" }, 500);
    }
    const combined = sealLocal(
      JSON.stringify(combinedCredentials),
      config.MASTER_KEY,
    );
    getRunStore().put({
      id,
      name: `migration-${id.slice(0, 8)}`,
      status: "connected",
      step: "discover",
      createdAt: now,
      updatedAt: now,
      coolifyUrl,
      dokployUrl,
      irJson: null,
      credentialsCiphertext: combined,
      vaultCiphertext: {},
      selectionJson: null,
      reportJson: null,
      decisionsJson: null,
    });
    return c.json({ runId: id }, 201);
  });
  app.get("/api/runs/:id", (c) => {
    const run = getRunStore().get(c.req.param("id"));
    if (!run) return c.json({ message: "Run not found" }, 404);
    return c.json({
      id: run.id,
      name: run.name,
      status: run.status,
      step: run.step,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      coolifyUrl: run.coolifyUrl,
      dokployUrl: run.dokployUrl,
      inventory: run.irJson ? JSON.parse(run.irJson) : null,
      selection: run.selectionJson ? JSON.parse(run.selectionJson) : null,
    });
  });
  app.put("/api/runs/:id/selection", async (c) => {
    const store = getRunStore();
    const run = store.get(c.req.param("id"));
    if (!run) return c.json({ message: "Run not found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ message: "Selection payload is required" }, 400);
    }
    store.put({
      ...run,
      status: "selected",
      step: "report",
      selectionJson: JSON.stringify(body),
      updatedAt: Date.now(),
    });
    return c.json({ ok: true });
  });
  app.post("/api/runs/:id/discover", async (c) => {
    const store = getRunStore();
    const run = store.get(c.req.param("id"));
    if (!run) return c.json({ message: "Run not found" }, 404);
    if (!run.credentialsCiphertext) {
      return c.json({ message: "Run credentials are unavailable" }, 400);
    }
    try {
      const config = readConfig();
      const credentials = JSON.parse(
        openLocal(run.credentialsCiphertext, config.MASTER_KEY),
      ) as
        | {
            coolify: { url: string; token: string };
            dokploy: { url: string; apiKey: string };
          }
        | {
            coolify: string;
            dokploy: string;
          };
      const coolify =
        typeof credentials.coolify === "string"
          ? (JSON.parse(credentials.coolify) as { url: string; token: string })
          : credentials.coolify;
      const reader = createCoolifyReader({
        baseUrl: coolify.url,
        token: coolify.token,
      });
      const vault = new MemoryVault();
      const ir = await extractInventory(reader, vault, {
        sourceUrl: coolify.url,
        sourceVersion: "unknown",
      });
      const updated: PersistedRun = {
        ...run,
        status: "discovered",
        step: "select",
        irJson: JSON.stringify(ir),
        updatedAt: Date.now(),
      };
      store.put(updated);
      let environments = 0;
      let applications = 0;
      let databases = 0;
      let compose = 0;
      for (const project of ir.projects) {
        environments += project.environments.length;
        for (const environment of project.environments) {
          for (const resource of environment.resources) {
            if (resource.kind === "application") applications++;
            else if (resource.kind === "database") databases++;
            else if (resource.kind === "compose") compose++;
          }
        }
      }
      const counts = {
        projects: ir.projects.length,
        environments,
        applications,
        databases,
        compose,
      };
      return c.json({
        runId: run.id,
        status: updated.status,
        counts,
        inventory: ir,
      });
    } catch (error) {
      if (error instanceof AppError) {
        return c.json(
          { code: error.code, message: error.message, hint: error.hint },
          502,
        );
      }
      return c.json({ code: "INTERNAL", message: "Discovery failed" }, 500);
    }
  });
  app.get("/assets/*", async (c) => {
    const assetPath = new URL(
      `../dist/web/${c.req.path.slice(1)}`,
      import.meta.url,
    );
    try {
      const body = await readFile(assetPath);
      const contentTypes: Record<string, string> = {
        ".css": "text/css",
        ".js": "text/javascript",
        ".svg": "image/svg+xml",
      };
      return new Response(body, {
        headers: {
          "Content-Type":
            contentTypes[extname(assetPath.pathname)] ??
            "application/octet-stream",
        },
      });
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
      return c.notFound();
    }
  });
  app.get("*", async (c) => {
    try {
      const file = await readFile(
        new URL("../dist/web/index.html", import.meta.url),
        "utf8",
      );
      return c.html(file);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }
    return c.text(
      "Migrator server is running. Build the web app to serve the SPA.",
    );
  });
  return app;
}

if (process.env.NODE_ENV !== "test") {
  const config = readConfig();
  try {
    const database = openDatabase(config.DATA_DIR);
    purgeExpiredSecrets(database);
    setInterval(() => purgeExpiredSecrets(database), 24 * 60 * 60 * 1000);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown SQLite startup error";
    process.stderr.write(
      `Warning: SQLite unavailable; starting without persistence: ${message}\n`,
    );
  }
  serve({ fetch: createApp().fetch, port: config.PORT });
}
