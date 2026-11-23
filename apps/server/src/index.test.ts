import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, createFakeCoolify, createFakeDokploy } from "@migrator/core";
import argon2 from "argon2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Config } from "./config.js";

const CANARY = {
  appSecret: "CANARY_SECRET_APP_7f3a9c",
  dbPassword: "CANARY_DB_PASSWORD_b81e22",
  coolifyToken: "CANARY_TOKEN_COOLIFY_55aa11",
  dokployKey: "CANARY_TOKEN_DOKPLOY_99bb33",
};

// Loose JSON shape for assertions in tests.
// biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary API payloads
type Json = Record<string, any>;

let dir: string;
let fake: ReturnType<typeof createFakeDokploy>;

async function setup(overrides: Partial<Config> = {}) {
  const config: Config = {
    MASTER_KEY: randomBytes(32).toString("base64"),
    ADMIN_PASSWORD_HASH: await argon2.hash("dev-password", {
      type: argon2.argon2id,
    }),
    DATA_DIR: dir,
    PORT: 3000,
    UPSTREAM_ALLOW_PRIVATE: true,
    LOG_LEVEL: "info",
    RUN_RETENTION_DAYS: 30,
    ...overrides,
  };
  fake = createFakeDokploy({
    projects: [{ name: "acme", environments: ["production"] }],
  });
  const app = createApp({
    config,
    clients: {
      coolify: () => createFakeCoolify(CANARY),
      dokploy: () => fake.client,
    },
    sleep: async () => undefined,
  });
  const headers = {
    "Content-Type": "application/json",
    "X-Requested-With": "migrator",
  };
  const login = await app.request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "dev-password" }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`http://localhost${path}`, {
      method,
      headers: { ...headers, Cookie: cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      // markdown/text responses
    }
    return { status: res.status, body: json as Json, text };
  };
  return { app, config, call, cookie };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "migrator-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const connectBody = {
  coolify: { url: "https://coolify.example", token: CANARY.coolifyToken },
  dokploy: { url: "https://dokploy.example", apiKey: CANARY.dokployKey },
};

async function runToApplied(ctx: Awaited<ReturnType<typeof setup>>) {
  const created = await ctx.call("POST", "/api/runs", connectBody);
  const id = created.body.runId as string;
  await ctx.call("POST", `/api/runs/${id}/discover`);
  await ctx.call("POST", `/api/runs/${id}/plan`);
  await ctx.call("POST", `/api/runs/${id}/apply`);
  await ctx.app.manager.idle(id);
  return id;
}

describe("access control", () => {
  it("serves health without a session and rejects every API call without one", async () => {
    const { app } = await setup();
    expect((await app.request("http://localhost/healthz")).status).toBe(200);
    for (const [method, path] of [
      ["GET", "/api/runs"],
      ["POST", "/api/runs"],
      ["GET", "/api/runs/x/events"],
      ["POST", "/api/runs/x/apply"],
    ] as const) {
      expect(
        (await app.request(`http://localhost${path}`, { method })).status,
        path,
      ).toBe(401);
    }
  });

  it("rejects a wrong password and rate-limits repeated attempts", async () => {
    const { app } = await setup();
    const attempt = () =>
      app.request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
  });

  it("requires the CSRF header and a matching Origin on mutations", async () => {
    const { app, cookie } = await setup();
    const post = (headers: Record<string, string>) =>
      app.request("http://localhost/api/runs", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          ...headers,
        },
        body: "{}",
      });
    expect((await post({})).status).toBe(403);
    expect(
      (
        await post({
          "X-Requested-With": "migrator",
          Origin: "https://evil.example",
          Host: "localhost",
        })
      ).status,
    ).toBe(403);
    expect((await post({ "X-Requested-With": "migrator" })).status).toBe(400); // passes the guard, fails validation
  });
});

describe("full migration through the API", () => {
  it("connect -> discover -> options -> plan -> apply -> verify -> report -> rollback", async () => {
    const ctx = await setup();
    const { call } = ctx;
    const created = await call("POST", "/api/runs", connectBody);
    expect(created.status).toBe(201);
    expect(created.body.coolify.version).toBe("4.7.5");
    const id = created.body.runId as string;

    expect((await call("POST", `/api/runs/${id}/discover`)).status).toBe(200);
    const inventory = (await call("GET", `/api/runs/${id}/inventory`)).body;
    const resources = inventory.projects[0].environments[0].resources as Array<{
      name: string;
      kind: string;
      selected: boolean;
    }>;
    expect(resources.map((r) => r.name).sort()).toEqual([
      "main-db",
      "proxy",
      "web",
    ]);
    expect(resources.every((r) => r.selected)).toBe(true);

    // user deselects the proxy; the plan must leave it out
    const proxy = inventory.projects[0].environments[0].resources.find(
      (r: { name: string }) => r.name === "proxy",
    );
    const include = resources
      .filter((r) => r.name !== "proxy")
      .map((r) => (r as unknown as { srcId: string }).srcId);
    expect(
      (await call("PUT", `/api/runs/${id}/options`, { include })).status,
    ).toBe(200);
    expect(proxy).toBeDefined();

    const planned = await call("POST", `/api/runs/${id}/plan`);
    expect(planned.status).toBe(200);
    expect(
      planned.body.steps.some((s: { label: string }) =>
        s.label.includes("proxy"),
      ),
    ).toBe(false);
    // Dokploy already has a project named "acme": the copy is marked with *
    expect(planned.body.steps[0].label).toBe("Create project Acme*");
    expect(fake.writes).toHaveLength(0); // dry run

    expect((await call("POST", `/api/runs/${id}/apply`)).status).toBe(202);
    await ctx.app.manager.idle(id);
    const run = (await call("GET", `/api/runs/${id}`)).body;
    expect(run.status).toBe("applied");
    expect(run.progress.failed).toBe(0);
    expect(run.progress.done).toBe(run.progress.total);
    const state = fake.snapshot();
    expect(state.projects.map((p) => p.name).sort()).toEqual(["Acme*", "acme"]);
    expect(state.resources.map((r) => r.name).sort()).toEqual([
      "main-db",
      "web",
    ]);
    expect(
      fake.calls.some((c) => c.method.toLowerCase().includes("deploy")),
    ).toBe(false);
    // values were imported, and the vault was purged after the run
    expect(
      String(state.resources.find((r) => r.name === "web")?.env),
    ).toContain(`API_SECRET=${CANARY.appSecret}`);
    expect(ctx.app.store.vaultCount(id)).toBe(0);

    const verify = (await call("POST", `/api/runs/${id}/verify`)).body
      .checks as Array<{ status: string }>;
    expect(verify.length).toBeGreaterThan(5);
    expect(verify.every((c) => c.status === "pass")).toBe(true);
    expect((await call("GET", `/api/runs/${id}`)).body.status).toBe("verified");

    const report = await call("GET", `/api/runs/${id}/report.md`);
    expect(report.text).toContain("Acme*");
    expect(report.text).toContain("Nothing was deployed");
    const manifest = await call("GET", `/api/runs/${id}/manifest.json`);
    expect(manifest.body.manifestVersion).toBe(1);

    // rollback: exact phrase required, only created resources are deleted, the original project survives
    const preview = (await call("GET", `/api/runs/${id}/rollback`)).body;
    expect(preview.items.length).toBeGreaterThan(3);
    expect(
      (
        await call("POST", `/api/runs/${id}/rollback`, {
          confirm: "delete everything",
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(fake.snapshot().resources).toHaveLength(2);
    const rolled = await call("POST", `/api/runs/${id}/rollback`, {
      confirm: preview.confirmPhrase,
    });
    expect(rolled.status).toBe(200);
    expect(fake.snapshot().projects.map((p) => p.name)).toEqual(["acme"]);
    expect(fake.snapshot().resources).toEqual([]);
    expect((await call("GET", `/api/runs/${id}`)).body.status).toBe(
      "rolled_back",
    );
  });

  it("pauses on a failing step and finishes after retry", async () => {
    const ctx = await setup();
    const { call } = ctx;
    const id = (await call("POST", "/api/runs", connectBody)).body
      .runId as string;
    await call("POST", `/api/runs/${id}/discover`);
    await call("POST", `/api/runs/${id}/plan`);
    fake.failNext(
      "applicationSaveBuildType",
      new AppError(
        "UPSTREAM_VALIDATION",
        `Upstream rejected the request: bad build ${CANARY.dokployKey}`,
      ),
    );
    await call("POST", `/api/runs/${id}/apply`);
    await ctx.app.manager.idle(id);
    let run = (await call("GET", `/api/runs/${id}`)).body;
    expect(run.status).toBe("paused_failed");
    const steps = (await call("GET", `/api/runs/${id}/steps`)).body
      .steps as Array<{
      seq: number;
      state: string;
      error: { message: string } | null;
    }>;
    const failed = steps.find((s) => s.state === "failed");
    expect(failed?.error?.message).toContain("bad build");
    expect(failed?.error?.message).not.toContain(CANARY.dokployKey); // redacted before storage
    await call("POST", `/api/runs/${id}/steps/${failed?.seq}/retry`);
    await ctx.app.manager.idle(id);
    run = (await call("GET", `/api/runs/${id}`)).body;
    expect(run.status).toBe("applied");
    expect(
      fake.snapshot().resources.filter((r) => r.name === "web"),
    ).toHaveLength(1);
  });

  it("resumes an interrupted run after a restart without duplicates", async () => {
    const ctx = await setup();
    const { call } = ctx;
    const id = (await call("POST", "/api/runs", connectBody)).body
      .runId as string;
    await call("POST", `/api/runs/${id}/discover`);
    await call("POST", `/api/runs/${id}/plan`);
    // simulate a crash: the first half of the steps were done, the process died mid-step
    const steps = ctx.app.store.listSteps(id);
    const half = Math.floor(steps.length / 2);
    const plan = ctx.app.store.getRun(id)?.plan;
    expect(plan).toBeTruthy();
    const { runPlan, defaultOptions } = await import("@migrator/core");
    void defaultOptions;
    let seen = 0;
    const partial = await runPlan(
      plan as never,
      {
        runId: id,
        dokploy: fake.client,
        vault: ctx.app.store.vault(id),
        idMap: ctx.app.store.idMap(id),
        options: (await import("./runs/user-options.js")).toCoreOptions(
          ctx.app.service.ir(id),
          ctx.app.service.userOptions(id),
        ),
      },
      {
        hooks: {
          shouldStop: () => seen++ >= half,
          onUpdate: (step, record) =>
            ctx.app.store.saveStep(id, step.seq, record),
        },
      },
    );
    expect(partial.status).toBe("stopped");
    ctx.app.store.updateRun(id, { status: "running" });
    ctx.app.store.saveStep(id, half + 1, { state: "running", attempts: 1 }); // died mid-step

    expect(ctx.app.manager.resumeInterrupted()).toBe(1);
    await ctx.app.manager.idle(id);
    expect((await call("GET", `/api/runs/${id}`)).body.status).toBe("applied");
    const state = fake.snapshot();
    expect(state.projects.filter((p) => p.name === "Acme*")).toHaveLength(1);
    expect(state.resources.filter((r) => r.name === "web")).toHaveLength(1);
  });

  it("asks for the key again after the credential TTL and works once it is re-entered", async () => {
    const ctx = await setup();
    const { call } = ctx;
    const id = (await call("POST", "/api/runs", connectBody)).body
      .runId as string;
    await call("POST", `/api/runs/${id}/discover`);
    ctx.app.store.db
      .prepare("UPDATE credentials SET expires_at = 1 WHERE run_id = ?")
      .run(id);
    const expired = await call("POST", `/api/runs/${id}/plan`);
    expect(expired.status).toBe(401);
    expect(
      (
        await call("PUT", `/api/runs/${id}/credentials`, {
          dokployApiKey: "NEW_KEY_abcdef123456",
        })
      ).status,
    ).toBe(200);
    expect((await call("POST", `/api/runs/${id}/plan`)).status).toBe(200);
  });
});

describe("secrets never leak", () => {
  it("keeps every canary out of the database file, API responses, events, report and manifest", async () => {
    const ctx = await setup();
    const id = await runToApplied(ctx);
    expect((await ctx.call("GET", `/api/runs/${id}`)).body.status).toBe(
      "applied",
    );

    // collect everything a user or an attacker with the data dir could read
    const surfaces: Record<string, string> = {};
    for (const path of [
      "",
      "/inventory",
      "/options",
      "/steps",
      "/plan",
      "/report.md",
      "/manifest.json",
      "/compat.md",
      "/rollback",
      "/checklist",
    ]) {
      surfaces[`GET ${path}`] = (
        await ctx.call("GET", `/api/runs/${id}${path}`)
      ).text;
    }
    surfaces.runs = (await ctx.call("GET", "/api/runs")).text;
    surfaces.events = JSON.stringify(ctx.app.store.listEvents(id));
    surfaces.verify = (await ctx.call("POST", `/api/runs/${id}/verify`)).text;
    ctx.app.store.db.pragma("wal_checkpoint(TRUNCATE)");
    for (const file of readdirSync(dir))
      surfaces[`file ${file}`] = readFileSync(join(dir, file)).toString(
        "latin1",
      );

    for (const [surface, content] of Object.entries(surfaces)) {
      for (const [name, canary] of Object.entries(CANARY)) {
        // the only place plaintext values may exist is Dokploy itself (import-values mode)
        expect(content.includes(canary), `${name} leaked into ${surface}`).toBe(
          false,
        );
      }
    }
  });

  it("never stores env values when the user chose names-only", async () => {
    const ctx = await setup();
    const id = (await ctx.call("POST", "/api/runs", connectBody)).body
      .runId as string;
    await ctx.call("POST", `/api/runs/${id}/discover`);
    await ctx.call("PUT", `/api/runs/${id}/options`, {
      secretsMode: "names-only",
    });
    await ctx.call("POST", `/api/runs/${id}/plan`);
    await ctx.call("POST", `/api/runs/${id}/apply`);
    await ctx.app.manager.idle(id);
    expect(JSON.stringify(fake.snapshot())).not.toContain(CANARY.appSecret);
    expect(
      String(fake.snapshot().resources.find((r) => r.name === "web")?.env),
    ).toContain("API_SECRET=");
  });

  it("an upstream error echoing a token is redacted in the HTTP response", async () => {
    const ctx = await setup();
    const id = (await ctx.call("POST", "/api/runs", connectBody)).body
      .runId as string;
    await ctx.call("POST", `/api/runs/${id}/discover`);
    fake.failNext(
      "projectAll",
      new AppError(
        "UPSTREAM_VALIDATION",
        `bad credentials ${CANARY.dokployKey}`,
      ),
    );
    const res = await ctx.call("POST", `/api/runs/${id}/plan`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain(CANARY.dokployKey);
  });
});

describe("startup", () => {
  it("rejects a missing or short MASTER_KEY with a clear message and no value", async () => {
    const { readConfig } = await import("./config.js");
    expect(() => readConfig({ ADMIN_PASSWORD_HASH: "x" } as never)).toThrow(
      /MASTER_KEY/,
    );
    expect(() =>
      readConfig({
        MASTER_KEY: Buffer.from("short").toString("base64"),
        ADMIN_PASSWORD_HASH: "x",
      } as never),
    ).toThrow(/32 bytes/);
  });
});
