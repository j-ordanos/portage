import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, createFakeCoolify, createFakeDokploy } from "@migrator/core";
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

const PASSWORD = "correct horse battery";

async function setup(
  overrides: Partial<Config> = {},
  extra: {
    privateRepos?: boolean;
    seed?: Parameters<typeof createFakeDokploy>[0];
    /** Skip creating the owner account and connections (for sign-up tests). */
    bare?: boolean;
  } = {},
) {
  const config: Config = {
    MASTER_KEY: randomBytes(32).toString("base64"),
    MASTER_KEY_SOURCE: "env",
    DATA_DIR: dir,
    PORT: 3000,
    ALLOW_SIGNUP: true,
    UPSTREAM_ALLOW_PRIVATE: true,
    LOG_LEVEL: "info",
    RUN_RETENTION_DAYS: 30,
    ...overrides,
  };
  fake = createFakeDokploy({
    projects: [{ name: "acme", environments: ["production"] }],
    ...extra.seed,
  });
  const app = createApp({
    config,
    clients: {
      coolify: (c) => {
        if (c.token === "WRONG_TOKEN")
          throw new AppError("UPSTREAM_AUTH", "Upstream authentication failed");
        return createFakeCoolify(CANARY, {
          privateRepos: extra.privateRepos === true,
        });
      },
      dokploy: () => fake.client,
    },
    sleep: async () => undefined,
  });
  const headers = {
    "Content-Type": "application/json",
    "X-Requested-With": "migrator",
  };
  const asUser =
    (cookie: string) =>
    async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`http://localhost${path}`, {
        method,
        headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      let json: unknown = text;
      try {
        json = JSON.parse(text);
      } catch {
        // markdown/text responses
      }
      return {
        status: res.status,
        body: json as Json,
        text,
        cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
      };
    };
  const signUp = async (email: string) => {
    const res = await asUser("")("POST", "/api/auth/register", {
      email,
      password: PASSWORD,
    });
    return { res, call: asUser(res.cookie) };
  };

  let call = asUser("");
  let cookie = "";
  let runBody: { coolifyConnectionId: string; dokployConnectionId: string } = {
    coolifyConnectionId: "",
    dokployConnectionId: "",
  };
  if (!extra.bare) {
    const owner = await signUp("owner@example.com");
    call = owner.call;
    cookie = owner.res.cookie;
    const coolify = await call("POST", "/api/connections", {
      kind: "coolify",
      name: "Lab Coolify",
      url: "https://coolify.example",
      secret: CANARY.coolifyToken,
    });
    const dokploy = await call("POST", "/api/connections", {
      kind: "dokploy",
      name: "Lab Dokploy",
      url: "https://dokploy.example",
      secret: CANARY.dokployKey,
    });
    runBody = {
      coolifyConnectionId: coolify.body.connection.id,
      dokployConnectionId: dokploy.body.connection.id,
    };
  }
  return { app, config, call, cookie, runBody, signUp, asUser };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "migrator-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function runToApplied(ctx: Awaited<ReturnType<typeof setup>>) {
  const created = await ctx.call("POST", "/api/runs", ctx.runBody);
  const id = created.body.runId as string;
  await ctx.call("POST", `/api/runs/${id}/discover`);
  await ctx.call("POST", `/api/runs/${id}/plan`);
  await ctx.call("POST", `/api/runs/${id}/apply`);
  await ctx.app.manager.idle(id);
  return id;
}

describe("accounts and access", () => {
  it("lets visitors see the public page data and anonymous state, but nothing else", async () => {
    const { app } = await setup({}, { bare: true });
    expect((await app.request("http://localhost/healthz")).status).toBe(200);
    const pub = await (await app.request("http://localhost/api/public")).json();
    expect(pub).toMatchObject({ allowSignup: true });
    const me = await app.request("http://localhost/api/auth/me");
    expect(me.status).toBe(200); // "not signed in" is a normal state, not an error
    expect(await me.json()).toEqual({ authenticated: false });
    for (const [method, path] of [
      ["GET", "/api/runs"],
      ["POST", "/api/runs"],
      ["GET", "/api/connections"],
      ["POST", "/api/connections"],
      ["GET", "/api/runs/x/events"],
      ["POST", "/api/runs/x/apply"],
    ] as const) {
      expect(
        (
          await app.request(`http://localhost${path}`, {
            method,
            headers: { "X-Requested-With": "migrator" },
          })
        ).status,
        path,
      ).toBe(401);
    }
  });

  it("creates an account, signs in, and validates input with clear messages", async () => {
    const { signUp, asUser } = await setup({}, { bare: true });
    const anon = asUser("");
    expect(
      (
        await anon("POST", "/api/auth/register", {
          email: "nope",
          password: PASSWORD,
        })
      ).body.message,
    ).toMatch(/valid email/);
    expect(
      (
        await anon("POST", "/api/auth/register", {
          email: "a@b.co",
          password: "short",
        })
      ).body.message,
    ).toMatch(/10 characters/);
    const first = await signUp("Yordanos@Example.com");
    expect(first.res.status).toBe(201);
    expect((await first.call("GET", "/api/auth/me")).body).toMatchObject({
      authenticated: true,
      user: { email: "yordanos@example.com" },
    });
    expect(
      (
        await anon("POST", "/api/auth/register", {
          email: "yordanos@example.com",
          password: PASSWORD,
        })
      ).status,
    ).toBe(409);
    const login = await anon("POST", "/api/auth/login", {
      email: "YORDANOS@example.com",
      password: PASSWORD,
    });
    expect(login.status).toBe(200);
    expect(login.cookie).toContain("portage_session=");
    // the same message for a wrong password and an unknown email: no account enumeration
    const wrong = await anon("POST", "/api/auth/login", {
      email: "yordanos@example.com",
      password: "wrong-password!",
    });
    const unknown = await anon("POST", "/api/auth/login", {
      email: "ghost@example.com",
      password: "wrong-password!",
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it("rate-limits repeated attempts", async () => {
    const { asUser } = await setup({}, { bare: true });
    const anon = asUser("");
    let last = 0;
    for (let i = 0; i < 12; i++)
      last = (
        await anon("POST", "/api/auth/login", {
          email: "x@y.co",
          password: "wrong-password!",
        })
      ).status;
    expect(last).toBe(429);
  });

  it("closes sign-ups when asked, but always lets the very first account in", async () => {
    const { signUp } = await setup({ ALLOW_SIGNUP: false }, { bare: true });
    expect((await signUp("first@example.com")).res.status).toBe(201);
    expect((await signUp("second@example.com")).res.status).toBe(403);
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
    expect((await post({ "X-Requested-With": "migrator" })).status).toBe(400);
  });

  it("accepts the declared PUBLIC_URL as an origin (front end on another host) and still rejects strangers", async () => {
    const { app, cookie } = await setup({
      PUBLIC_URL: "https://portage.launchpad.et",
    });
    const post = (origin: string) =>
      app.request("http://backend.internal/api/runs", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-Requested-With": "migrator",
          Origin: origin,
          Host: "backend.internal",
        },
        body: "{}",
      });
    expect((await post("https://portage.launchpad.et")).status).toBe(400); // allowed through, then fails validation
    expect((await post("https://evil.example")).status).toBe(403);
    expect(
      (await post("https://portage.launchpad.et.evil.example")).status,
    ).toBe(403);
    expect((await post("http://portage.launchpad.et")).status).toBe(403); // wrong scheme is a different origin
  });

  it("changes the password and signs out other sessions", async () => {
    const ctx = await setup();
    const other = await ctx.asUser("")("POST", "/api/auth/login", {
      email: "owner@example.com",
      password: PASSWORD,
    });
    const otherCall = ctx.asUser(other.cookie);
    expect(
      (
        await ctx.call("PUT", "/api/auth/password", {
          current: "not-the-password",
          next: "a brand new password",
        })
      ).status,
    ).toBe(403);
    const changed = await ctx.call("PUT", "/api/auth/password", {
      current: PASSWORD,
      next: "a brand new password",
    });
    expect(changed.status).toBe(200);
    expect((await otherCall("GET", "/api/runs")).status).toBe(401); // every other session was signed out
    expect((await ctx.call("GET", "/api/runs")).status).toBe(401); // including the old cookie of this one
    // ...while the response handed this browser a fresh cookie, so the person stays signed in
    expect((await ctx.asUser(changed.cookie)("GET", "/api/runs")).status).toBe(
      200,
    );
    expect(
      (
        await ctx.asUser("")("POST", "/api/auth/login", {
          email: "owner@example.com",
          password: "a brand new password",
        })
      ).status,
    ).toBe(200);
  });
});

describe("saved connections", () => {
  it("saves a tested connection, never returns the secret, and refuses a bad one", async () => {
    const ctx = await setup({}, { bare: true });
    const { call } = await ctx.signUp("u@example.com");
    const bad = await call("POST", "/api/connections", {
      kind: "coolify",
      name: "Broken",
      url: "https://coolify.example",
      secret: "WRONG_TOKEN",
    });
    expect(bad.status).toBe(422);
    expect((await call("GET", "/api/connections")).body.connections).toEqual(
      [],
    ); // not saved
    const ok = await call("POST", "/api/connections", {
      kind: "coolify",
      name: "Main Coolify",
      url: "https://coolify.example",
      secret: CANARY.coolifyToken,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.connection).toMatchObject({
      kind: "coolify",
      name: "Main Coolify",
      check: { ok: true, version: "4.7.5" },
    });
    for (const response of [
      ok.text,
      (await call("GET", "/api/connections")).text,
    ]) {
      expect(response).not.toContain(CANARY.coolifyToken);
      expect(response).not.toMatch(/secret|ciphertext|token/i);
    }
    expect(
      (
        await call("POST", "/api/connections", {
          kind: "coolify",
          name: "main coolify",
          url: "https://coolify.example",
          secret: CANARY.coolifyToken,
        })
      ).status,
    ).toBe(409);
  });

  it("rejects addresses that point at cloud metadata or use plain http without consent", async () => {
    const { call } = await (await setup({}, { bare: true })).signUp(
      "u@example.com",
    );
    const meta = await call("POST", "/api/connections", {
      kind: "dokploy",
      name: "x",
      url: "https://169.254.169.254",
      secret: "k",
    });
    expect(meta.status).toBe(400);
    const http = await call("POST", "/api/connections", {
      kind: "dokploy",
      name: "y",
      url: "http://dokploy.example",
      secret: "k",
    });
    expect(http.status).toBe(400);
    expect(http.body.message).toMatch(/http/i);
    expect(
      (
        await call("POST", "/api/connections", {
          kind: "dokploy",
          name: "y",
          url: "http://dokploy.example",
          secret: "k",
          allowInsecureHttp: true,
        })
      ).status,
    ).toBe(201);
  });

  it("edits a connection: a blank secret keeps the saved one, a new secret is re-tested", async () => {
    const ctx = await setup();
    const id = ctx.runBody.coolifyConnectionId;
    const renamed = await ctx.call("PUT", `/api/connections/${id}`, {
      name: "Renamed",
      secret: "",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.connection.name).toBe("Renamed");
    const failing = await ctx.call("PUT", `/api/connections/${id}`, {
      secret: "WRONG_TOKEN",
    });
    expect(failing.status).toBe(422);
    // the failed edit changed nothing, the old secret still works
    expect((await ctx.call("POST", `/api/connections/${id}/test`)).status).toBe(
      200,
    );
  });

  it("deletes a connection and lets another account never touch it", async () => {
    const ctx = await setup();
    const other = await ctx.signUp("other@example.com");
    const id = ctx.runBody.dokployConnectionId;
    expect(
      (await other.call("GET", "/api/connections")).body.connections,
    ).toEqual([]);
    expect(
      (await other.call("PUT", `/api/connections/${id}`, { name: "mine now" }))
        .status,
    ).toBe(404);
    expect((await other.call("DELETE", `/api/connections/${id}`)).status).toBe(
      404,
    );
    expect((await other.call("POST", "/api/runs", ctx.runBody)).status).toBe(
      400,
    ); // cannot start a run from someone else's connection
    expect((await ctx.call("DELETE", `/api/connections/${id}`)).status).toBe(
      200,
    );
  });

  it("keeps tokens out of the database file", async () => {
    const ctx = await setup();
    ctx.app.store.db.pragma("wal_checkpoint(TRUNCATE)");
    for (const file of readdirSync(dir)) {
      const bytes = readFileSync(join(dir, file)).toString("latin1");
      expect(bytes.includes(CANARY.coolifyToken), file).toBe(false);
      expect(bytes.includes(CANARY.dokployKey), file).toBe(false);
    }
  });
});

describe("per-account isolation", () => {
  it("never shows or lets one account act on another's migrations", async () => {
    const ctx = await setup();
    const id = (await ctx.call("POST", "/api/runs", ctx.runBody)).body
      .runId as string;
    await ctx.call("POST", `/api/runs/${id}/discover`);
    const other = await ctx.signUp("other@example.com");
    expect((await other.call("GET", "/api/runs")).body.runs).toEqual([]);
    for (const [method, path] of [
      ["GET", `/api/runs/${id}`],
      ["GET", `/api/runs/${id}/inventory`],
      ["POST", `/api/runs/${id}/plan`],
      ["POST", `/api/runs/${id}/apply`],
      ["GET", `/api/runs/${id}/events`],
      ["GET", `/api/runs/${id}/report.md`],
      ["DELETE", `/api/runs/${id}`],
    ] as const) {
      expect((await other.call(method, path)).status, path).toBe(404);
    }
    expect((await ctx.call("GET", `/api/runs/${id}`)).status).toBe(200);
  });

  it("hands runs from the single-password era to the first account", async () => {
    const ctx = await setup({}, { bare: true });
    ctx.app.store.db.exec("PRAGMA foreign_keys = OFF");
    ctx.app.store.db
      .prepare(
        "INSERT INTO runs (id, name, status, created_at, updated_at, expires_at, coolify_url, dokploy_url) VALUES ('old1','Old','applied',1,1,9999999999999,'https://c','https://d')",
      )
      .run();
    const { call } = await ctx.signUp("first@example.com");
    expect(
      (await call("GET", "/api/runs")).body.runs.map(
        (r: { id: string }) => r.id,
      ),
    ).toEqual(["old1"]);
  });
});

describe("full migration through the API", () => {
  it("connect -> discover -> options -> plan -> apply -> verify -> report -> rollback", async () => {
    const ctx = await setup();
    const { call } = ctx;
    const created = await call("POST", "/api/runs", ctx.runBody);
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
    const id = (await call("POST", "/api/runs", ctx.runBody)).body
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
    const id = (await call("POST", "/api/runs", ctx.runBody)).body
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

  it("keeps working after the run's credential copy expires, using the saved connections", async () => {
    const ctx = await setup();
    const { call } = ctx;
    const id = (await call("POST", "/api/runs", ctx.runBody)).body
      .runId as string;
    await call("POST", `/api/runs/${id}/discover`);
    ctx.app.store.db
      .prepare("UPDATE credentials SET expires_at = 1 WHERE run_id = ?")
      .run(id);
    expect((await call("GET", `/api/runs/${id}`)).body.credentialsActive).toBe(
      true,
    );
    expect((await call("POST", `/api/runs/${id}/plan`)).status).toBe(200);
  });

  it("explains clearly when a saved connection was deleted from under a run", async () => {
    const ctx = await setup();
    const { call } = ctx;
    const id = (await call("POST", "/api/runs", ctx.runBody)).body
      .runId as string;
    await call("POST", `/api/runs/${id}/discover`);
    ctx.app.store.db
      .prepare("UPDATE credentials SET expires_at = 1 WHERE run_id = ?")
      .run(id);
    await call("DELETE", `/api/connections/${ctx.runBody.dokployConnectionId}`);
    const res = await call("POST", `/api/runs/${id}/plan`);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/deleted/);
    expect((await call("GET", `/api/runs/${id}`)).body.credentialsActive).toBe(
      false,
    );
  });
});

describe("git access picker", () => {
  const seed = {
    githubProviders: [
      {
        githubId: "gh-dokploy",
        name: "Dokploy-App",
        repos: ["acme/private-api", "acme/keyed"],
      },
      { githubId: "gh-other", name: "Other", repos: ["nobody/else"] },
    ],
    sshKeys: [{ sshKeyId: "key-9", name: "some-key" }],
  };

  it("resolves private repos automatically and lets the user override one", async () => {
    const ctx = await setup({}, { privateRepos: true, seed });
    const { call } = ctx;
    const id = (await call("POST", "/api/runs", ctx.runBody)).body
      .runId as string;
    await call("POST", `/api/runs/${id}/discover`);

    const git = (await call("GET", `/api/runs/${id}/git`)).body;
    expect(git.github.map((g: { label: string }) => g.label)).toEqual([
      "Dokploy-App",
      "Other",
    ]);
    const byName = Object.fromEntries(
      git.resources.map((r: { name: string }) => [r.name, r]),
    );
    // names differ between the two tools; access decides
    expect(byName.api.resolved).toMatchObject({
      kind: "github",
      githubId: "gh-dokploy",
    });
    expect(byName.api.coolify).toMatchObject({
      appName: "Acme Coolify App",
      appOrg: "acme",
    });
    expect(
      byName.api.candidates.github.map(
        (c: { hasAccess: boolean }) => c.hasAccess,
      ),
    ).toEqual([true, false]);
    expect(byName.worker.coolify.keyName).toBe("keyed-deploy");
    expect(byName.worker.resolved).toMatchObject({
      kind: "github",
      githubId: "gh-dokploy",
    }); // no matching key: the app that can reach it
    expect(git.resources.some((r: { name: string }) => r.name === "web")).toBe(
      false,
    ); // public repos need no picker

    // user picks the SSH key for the worker
    const chosen = await call("PUT", `/api/runs/${id}/options`, {
      gitOverrides: { "app-key": { sshKeyId: "key-9" } },
    });
    expect(chosen.status).toBe(200);
    const after = (
      await call("GET", `/api/runs/${id}/git`)
    ).body.resources.find((r: { name: string }) => r.name === "worker");
    expect(after).toMatchObject({
      overridden: true,
      resolved: { kind: "ssh", sshKeyId: "key-9" },
    });

    const planned = (await call("POST", `/api/runs/${id}/plan`)).body
      .steps as Array<{ label: string; warnings: string[] }>;
    expect(
      planned.find((s) => s.label.includes("source for api"))?.warnings[0],
    ).toContain("Git access linked");
    await call("POST", `/api/runs/${id}/apply`);
    await ctx.app.manager.idle(id);
    const rows = fake.snapshot().resources as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.name === "api")).toMatchObject({
      sourceType: "github",
      githubId: "gh-dokploy",
      owner: "Acme",
      repository: "Private-Api",
    });
    expect(rows.find((r) => r.name === "worker")).toMatchObject({
      sourceType: "git",
      customGitSSHKeyId: "key-9",
      customGitBranch: "dev",
    });
  });

  it("still plans when Dokploy has no providers or keys, flagging a manual relink", async () => {
    const ctx = await setup({}, { privateRepos: true });
    const id = (await ctx.call("POST", "/api/runs", ctx.runBody)).body
      .runId as string;
    await ctx.call("POST", `/api/runs/${id}/discover`);
    const plan = (await ctx.call("POST", `/api/runs/${id}/plan`)).body
      .steps as Array<{ label: string; warnings: string[] }>;
    expect(
      plan.find((s) => s.label.includes("source for api"))?.warnings[0],
    ).toContain("Relink Git access");
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
    const id = (await ctx.call("POST", "/api/runs", ctx.runBody)).body
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
    const id = (await ctx.call("POST", "/api/runs", ctx.runBody)).body
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

describe("startup and the lock key", () => {
  it("generates the lock key once, keeps it private, and reuses it", async () => {
    const { readConfig } = await import("./config.js");
    const first = readConfig({ DATA_DIR: dir } as never);
    expect(first.MASTER_KEY_SOURCE).toBe("file");
    expect(Buffer.from(first.MASTER_KEY, "base64")).toHaveLength(32);
    const mode =
      (await import("node:fs")).statSync(join(dir, "master.key")).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readConfig({ DATA_DIR: dir } as never).MASTER_KEY).toBe(
      first.MASTER_KEY,
    );
  });

  it("prefers MASTER_KEY from the environment and rejects a malformed one without printing it", async () => {
    const { readConfig } = await import("./config.js");
    const key = randomBytes(32).toString("base64");
    expect(
      readConfig({ DATA_DIR: dir, MASTER_KEY: key } as never),
    ).toMatchObject({ MASTER_KEY: key, MASTER_KEY_SOURCE: "env" });
    let message = "";
    try {
      readConfig({
        DATA_DIR: dir,
        MASTER_KEY: Buffer.from("short-secret").toString("base64"),
      } as never);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/32 bytes/);
    expect(message).not.toContain("short-secret");
  });

  it("refuses a damaged key file instead of silently replacing it (that would orphan saved tokens)", async () => {
    const { readConfig } = await import("./config.js");
    (await import("node:fs")).writeFileSync(
      join(dir, "master.key"),
      "not-a-key\n",
    );
    expect(() => readConfig({ DATA_DIR: dir } as never)).toThrow(/master\.key/);
  });
});
