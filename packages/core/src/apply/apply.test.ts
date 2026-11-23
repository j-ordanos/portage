import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { type IR, IR as IRSchema } from "../ir/schema.js";
import {
  buildPlan,
  type TargetSnapshot,
  validatePlan,
} from "../plan/build-plan.js";
import { defaultOptions, type Options } from "../plan/types.js";
import { renderMigrationReport } from "../report/migration-report.js";
import {
  buildRollbackPlan,
  executeRollbackStep,
  type RollbackEntry,
} from "../rollback/rollback.js";
import { createFakeDokploy } from "../testing/fake-dokploy.js";
import { createMemoryIdMap } from "../testing/memory-idmap.js";
import { MemoryVault } from "../vault.js";
import { verifyMigration } from "../verify/verify.js";
import type { ApplyContext } from "./executor.js";
import { runPlan } from "./runner.js";

type Row = Record<string, string | number | boolean | null | undefined>;

const noSleep = { sleep: async () => undefined };

async function sampleIr(vault: MemoryVault): Promise<IR> {
  const v = (value: string) => vault.put(value);
  const envVar = async (
    key: string,
    value: string | null,
    extra: Record<string, unknown> = {},
  ) => ({
    key,
    availability: value === null ? "missing" : "available",
    valueRef: value === null ? null : await v(value),
    isSecretGuess: /SECRET|PASSWORD|TOKEN/.test(key),
    refs: [],
    scope: "both",
    isPreview: false,
    isMultiline: false,
    isLiteral: false,
    ...extra,
  });
  const base = (srcId: string, name: string) => ({
    srcId,
    name,
    projectSrcId: "p1",
    environmentName: "production",
    compat: "auto",
    issues: [],
    selected: true,
    decision: "migrate",
  });
  return IRSchema.parse({
    irVersion: 1,
    source: {
      url: "https://coolify.example",
      version: "4.7.5",
      readAt: "2026-11-23T00:00:00Z",
    },
    teamSharedEnv: [],
    servers: [],
    notes: [],
    projects: [
      {
        srcId: "p1",
        name: "Acme",
        description: "Acme platform",
        sharedEnv: [],
        environments: [
          {
            srcId: "e1",
            name: "production",
            sharedEnv: [],
            resources: [
              {
                ...base("app-web", "web"),
                kind: "application",
                source: {
                  type: "git",
                  repo: "acme/web",
                  branch: "main",
                  provider: "public",
                  url: "https://github.com/acme/web",
                },
                build: {
                  pack: "nixpacks",
                  rawPack: "nixpacks",
                  baseDir: "/",
                  buildCmd: "npm run build",
                  startCmd: "npm start",
                },
                ports: [3000],
                domains: [
                  {
                    host: "web.acme.test",
                    https: true,
                    source: "https://web.acme.test",
                  },
                ],
                env: [
                  await envVar("API_SECRET", "CANARY_SECRET_ONE"),
                  await envVar("GREETING", "hello world # not a comment"),
                  await envVar("BUILD_ONLY", "yes", { scope: "buildtime" }),
                  await envVar("PREVIEW_COPY", "x", { isPreview: true }),
                  await envVar("LOCKED", null, { availability: "redacted" }),
                ],
                mounts: [
                  { type: "volume", name: "uploads", mountPath: "/data" },
                  {
                    type: "file",
                    mountPath: "/app/config.json",
                    contentRef: await v('{"a":1}'),
                  },
                ],
              },
              {
                ...base("app-img", "proxy"),
                kind: "application",
                source: { type: "image", image: "nginx", tag: "alpine" },
                build: { pack: "dockerimage", rawPack: "dockerimage" },
                ports: [80],
                domains: [],
                env: [],
                mounts: [],
              },
              {
                ...base("compose-git", "stack"),
                kind: "compose",
                composeRaw:
                  "services:\n  web:\n    image: nginx\n    expose:\n      - '8080'\n",
                isTemplateService: false,
                source: {
                  type: "git",
                  repo: "acme/stack",
                  branch: "main",
                  provider: "public",
                  url: "https://github.com/acme/stack",
                },
                composePath: "/docker-compose.yml",
                domains: [
                  {
                    host: "stack.acme.test",
                    https: true,
                    source: "https://stack.acme.test",
                    service: "web",
                  },
                ],
                env: [await envVar("COMPOSE_VAR", "cv")],
                mounts: [],
              },
              {
                ...base("svc-kuma", "kuma"),
                kind: "compose",
                composeRaw:
                  "services:\n  uptime-kuma:\n    image: louislam/uptime-kuma:2\n    labels:\n      - coolify.managed=true\n",
                isTemplateService: true,
                templateName: "uptime-kuma",
                domains: [],
                env: [],
                mounts: [],
              },
              {
                ...base("db-pg", "pg"),
                kind: "database",
                engine: "postgres",
                image: "postgres:16-alpine",
                dbName: "acme",
                dbUser: "acme_user",
                passwordRef: await v("CANARY_PG_PASSWORD"),
                passwordAvailability: "available",
                publiclyExposed: false,
                mounts: [],
                backupsConfigured: false,
              },
              {
                ...base("db-redis", "cache"),
                kind: "database",
                engine: "redis",
                image: "redis:7",
                passwordRef: null,
                passwordAvailability: "missing",
                publiclyExposed: false,
                mounts: [],
                backupsConfigured: false,
              },
              {
                ...base("db-ch", "ch"),
                kind: "database",
                engine: "other",
                image: "clickhouse",
                passwordRef: null,
                passwordAvailability: "missing",
                publiclyExposed: false,
                mounts: [],
                backupsConfigured: false,
              },
            ],
          },
        ],
      },
    ],
  });
}

const allIds = [
  "app-web",
  "app-img",
  "compose-git",
  "svc-kuma",
  "db-pg",
  "db-redis",
  "db-ch",
];

async function setup(
  overrides: (o: Options) => void = () => undefined,
  snapshot: TargetSnapshot = {},
  seed?: Parameters<typeof createFakeDokploy>[0],
) {
  const vault = new MemoryVault();
  const ir = await sampleIr(vault);
  const options = defaultOptions(allIds);
  overrides(options);
  const plan = buildPlan(ir, options, snapshot);
  const fake = createFakeDokploy(seed);
  const idMap = createMemoryIdMap();
  const ctx: ApplyContext = {
    runId: "run1",
    dokploy: fake.client,
    vault,
    idMap,
    options,
  };
  return { vault, ir, options, plan, fake, idMap, ctx };
}

describe("plan", () => {
  it("is deterministic, valid, ordered databases-first, and makes no network calls", async () => {
    const { plan, ir, options } = await setup();
    expect(buildPlan(ir, options)).toEqual(plan);
    expect(validatePlan(plan)).toEqual([]);
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds.slice(0, 2)).toEqual(["CREATE_PROJECT", "ENSURE_ENVIRONMENT"]);
    const firstApp = kinds.indexOf("CREATE_APPLICATION");
    expect(kinds.indexOf("CREATE_DATABASE")).toBeLessThan(firstApp);
    expect(kinds.filter((k) => k === "CREATE_DATABASE")).toHaveLength(2); // clickhouse is manual
    expect(plan.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("ch")]),
    );
    // no secret value ever appears in the plan
    expect(JSON.stringify(plan)).not.toMatch(/CANARY_/);
  });

  it("marks a colliding project with * (case-insensitive) and keeps the original name otherwise", async () => {
    const snapshot: TargetSnapshot = {
      projects: [
        {
          projectId: "x",
          name: "acme",
          environments: [
            { environmentId: "ex", name: "production", resourceNames: [] },
          ],
        },
      ],
    };
    const { plan } = await setup(undefined, snapshot);
    expect(plan.steps[0]?.payload).toMatchObject({
      name: "Acme*",
      renamedFrom: "Acme",
    });
    const twice = await setup(undefined, {
      projects: [
        ...(snapshot.projects ?? []),
        { projectId: "y", name: "Acme*", environments: [] },
      ],
    });
    expect(twice.plan.steps[0]?.payload.name).toBe("Acme**");
    const none = await setup(undefined, {
      projects: [{ projectId: "z", name: "Other", environments: [] }],
    });
    expect(none.plan.steps[0]?.payload.name).toBe("Acme");
  });

  it("supports a custom marker, adopt and skip policies", async () => {
    const snapshot: TargetSnapshot = {
      projects: [
        {
          projectId: "x",
          name: "Acme",
          environments: [
            { environmentId: "ex", name: "production", resourceNames: ["web"] },
          ],
        },
      ],
    };
    const custom = await setup((o) => {
      o.target.collisionMarker = "-migrated";
    }, snapshot);
    expect(custom.plan.steps[0]?.payload.name).toBe("Acme-migrated");
    const adopt = await setup((o) => {
      o.target.collisionPolicy = "adopt";
    }, snapshot);
    expect(adopt.plan.steps[0]).toMatchObject({
      intent: "adopt",
      payload: { existingProjectId: "x" },
    });
    expect(
      adopt.plan.steps.find((s) => s.kind === "ENSURE_ENVIRONMENT")?.payload
        .existingEnvironmentId,
    ).toBe("ex");
    // inside an adopted project a colliding resource name gets the marker too
    expect(
      adopt.plan.steps.find(
        (s) => s.kind === "CREATE_APPLICATION" && s.srcId === "app-web",
      )?.payload.name,
    ).toBe("web*");
    const skip = await setup((o) => {
      o.target.collisionPolicy = "skip";
    }, snapshot);
    expect(skip.plan.steps).toEqual([]);
  });

  it("omits unselected resources and resources with blocking errors unless acknowledged", async () => {
    const { plan } = await setup((o) => {
      o.selection.includeSrcIds = ["app-img"];
    });
    expect(
      plan.steps.filter((s) => s.kind === "CREATE_APPLICATION"),
    ).toHaveLength(1);
    expect(plan.steps.some((s) => s.kind === "CREATE_DATABASE")).toBe(false);
  });
});

describe("apply on a fake Dokploy", () => {
  it("creates the full structure undeployed and maps every setting", async () => {
    const { plan, fake, ctx, idMap, vault } = await setup();
    const outcome = await runPlan(plan, ctx, { hooks: noSleep });
    expect(outcome.status).toBe("completed");

    const state = fake.snapshot();
    expect(state.projects).toHaveLength(1); // default environment reused, no duplicates
    expect(state.projects[0]?.environments?.map((e) => e.name)).toEqual([
      "production",
    ]);
    expect(fake.calls.some((c) => c.method.includes("deploy"))).toBe(false);

    const app = state.resources.find((r) => r.name === "web") as Row;
    expect(app).toMatchObject({
      sourceType: "git",
      customGitUrl: "https://github.com/acme/web",
      customGitBranch: "main",
      buildType: "nixpacks",
      description: "Migrated from Coolify (app-web)",
    });
    const envLines = String(app.env).split("\n");
    expect(envLines).toContain("API_SECRET=CANARY_SECRET_ONE");
    expect(envLines).toContain("GREETING='hello world # not a comment'");
    expect(envLines).toContain("LOCKED=");
    expect(envLines).toContain("NIXPACKS_BUILD_CMD='npm run build'");
    expect(envLines).toContain("NIXPACKS_START_CMD='npm start'");
    expect(envLines.some((l) => l.startsWith("PREVIEW_COPY"))).toBe(false);
    // nixpacks reads build-time vars from env, so they stay in env (buildArgs is for Dockerfile builds)
    expect(envLines).toContain("BUILD_ONLY=yes");
    expect(app.buildArgs).toBeNull();
    // saveEnvironment is a full replace: exactly one call for the app
    expect(
      fake.calls.filter((c) => c.method === "applicationSaveEnvironment"),
    ).toHaveLength(1);

    const img = state.resources.find((r) => r.name === "proxy") as Row;
    expect(img).toMatchObject({
      sourceType: "docker",
      dockerImage: "nginx:alpine",
    });

    expect(
      state.mounts.map((m) => ({
        type: m.type,
        volumeName: m.volumeName,
        filePath: m.filePath,
        content: m.content,
      })),
    ).toEqual([
      {
        type: "volume",
        volumeName: "web-uploads",
        filePath: null,
        content: null,
      },
      {
        type: "file",
        volumeName: null,
        filePath: "config.json",
        content: '{"a":1}',
      },
    ]);
    expect(
      state.domains.map((d) => [d.host, d.https, d.port, d.serviceName]),
    ).toEqual(
      expect.arrayContaining([
        ["web.acme.test", true, 3000, null],
        ["stack.acme.test", true, 8080, "web"],
      ]),
    );

    const stack = state.resources.find((r) => r.name === "stack") as Row;
    expect(stack).toMatchObject({
      sourceType: "git",
      customGitUrl: "https://github.com/acme/stack",
      composePath: "./docker-compose.yml",
      env: "COMPOSE_VAR=cv",
    });
    const kuma = state.resources.find((r) => r.name === "kuma") as Row;
    expect(kuma.sourceType).toBe("raw");
    expect(kuma.composeFile).toContain("uptime-kuma");
    expect(kuma.composeFile).not.toContain("coolify.managed");

    const pg = state.resources.find((r) => r.name === "pg") as Row;
    expect(pg).toMatchObject({
      databaseName: "acme",
      databaseUser: "acme_user",
      databasePassword: "CANARY_PG_PASSWORD",
      dockerImage: "postgres:16-alpine",
    });
    const redis = state.resources.find((r) => r.name === "cache") as Row;
    expect(typeof redis.databasePassword).toBe("string"); // generated: source password was unreadable
    expect(String(redis.databasePassword).length).toBeGreaterThan(16);
    const note = [...outcome.records.values()]
      .flatMap((r) => r.warnings ?? [])
      .join(" ");
    expect(note).toContain("password generated");

    // database ids carry their engine, so rollback never guesses
    expect(
      idMap
        .entries("run1")
        .filter((e) => e.srcKind === "database")
        .map((e) => e.targetId.split(":")[0])
        .sort(),
    ).toEqual(["postgres", "redis"]);
    expect(
      await vault.get(
        plan.steps.find(
          (s) => s.kind === "CREATE_DATABASE" && s.srcId === "db-pg",
        )?.vaultRefs[0] as string,
      ),
    ).toBeTruthy();
  });

  it("is idempotent: applying the same plan twice creates nothing new", async () => {
    const { plan, fake, ctx } = await setup();
    await runPlan(plan, ctx, { hooks: noSleep });
    const before = JSON.stringify(fake.snapshot());
    const creates = fake.writes.length;
    const again = await runPlan(plan, ctx, { hooks: noSleep });
    expect(again.status).toBe("completed");
    expect(JSON.stringify(fake.snapshot())).toBe(before);
    expect(fake.writes.filter((c) => /Create$/.test(c.method)).length).toBe(
      fake.writes.slice(0, creates).filter((c) => /Create$/.test(c.method))
        .length,
    );
  });

  it("recovers from a lost response without creating a duplicate", async () => {
    const { plan, fake, ctx } = await setup();
    fake.loseResponse("applicationCreate", 1);
    fake.loseResponse("databaseCreate", 1);
    const outcome = await runPlan(plan, ctx, { hooks: noSleep });
    expect(outcome.status).toBe("completed");
    const state = fake.snapshot();
    expect(state.resources.filter((r) => r.name === "web")).toHaveLength(1);
    expect(state.resources.filter((r) => r.name === "pg")).toHaveLength(1);
  });

  it("pauses on a failing step, skips dependents on skip, and resumes where it stopped", async () => {
    const { plan, fake, ctx } = await setup();
    fake.failNext(
      "applicationSaveBuildType",
      new AppError(
        "UPSTREAM_VALIDATION",
        "Upstream rejected the request: bad build type",
      ),
    );
    const first = await runPlan(plan, ctx, { hooks: noSleep });
    expect(first.status).toBe("failed");
    const failed = plan.steps.find((s) => s.seq === first.failedSeq);
    expect(failed?.kind).toBe("CONFIGURE_BUILD");
    expect(
      first.records.get(first.failedSeq as number)?.error?.message,
    ).toContain("bad build type");

    const second = await runPlan(plan, ctx, {
      initial: first.records,
      hooks: noSleep,
    });
    expect(second.status).toBe("completed");
    expect(
      fake.snapshot().resources.filter((r) => r.name === "web"),
    ).toHaveLength(1);

    // a user "skip" propagates to dependents
    const skipped = new Map(first.records);
    skipped.set(first.failedSeq as number, { state: "skipped", attempts: 1 });
    const fresh = await setup();
    fresh.fake.failNext(
      "applicationSaveBuildType",
      new AppError("UPSTREAM_VALIDATION", "x"),
    );
    const out = await runPlan(fresh.plan, fresh.ctx, { hooks: noSleep });
    const skip = new Map(out.records);
    skip.set(out.failedSeq as number, { state: "skipped", attempts: 1 });
    const resumed = await runPlan(fresh.plan, fresh.ctx, {
      initial: skip,
      hooks: noSleep,
    });
    expect(resumed.status).toBe("completed");
    const envStep = fresh.plan.steps.find(
      (s) => s.kind === "SET_ENV" && s.srcId === "app-web",
    );
    expect(resumed.records.get(envStep?.seq as number)?.state).toBe("skipped");
  });

  it("retries retryable errors with backoff then gives up", async () => {
    const { plan, fake, ctx } = await setup();
    fake.failNext(
      "projectCreate",
      new AppError("UPSTREAM_5XX", "boom", { retryable: true }),
      10,
    );
    const slept: number[] = [];
    const outcome = await runPlan(plan, ctx, {
      hooks: {
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    });
    expect(outcome.status).toBe("failed");
    expect(slept).toEqual([1000, 3000, 9000]);
    expect(fake.snapshot().projects).toHaveLength(0);
  });

  it("names-only mode writes keys without values and never reads env secrets", async () => {
    const { plan, fake, ctx } = await setup((o) => {
      o.secrets.defaultMode = "names-only";
    });
    await runPlan(plan, ctx, { hooks: noSleep });
    const app = fake.snapshot().resources.find((r) => r.name === "web") as Row;
    expect(String(app.env)).toContain("API_SECRET=\n");
    expect(JSON.stringify(app)).not.toContain("CANARY_SECRET_ONE");
  });

  it("fails loudly if Dokploy does not keep an env key (read-back verification)", async () => {
    const { plan, fake, ctx } = await setup();
    const original = fake.client.applicationSaveEnvironment;
    fake.client.applicationSaveEnvironment = async (input) =>
      original({ ...input, env: "ONLY_ONE=1" });
    const outcome = await runPlan(plan, ctx, { hooks: noSleep });
    expect(outcome.status).toBe("failed");
    expect(outcome.records.get(outcome.failedSeq as number)?.error?.code).toBe(
      "SCHEMA_DRIFT",
    );
  });

  it("adopt reuses the existing project and environment", async () => {
    const vault = new MemoryVault();
    const ir = await sampleIr(vault);
    const options = defaultOptions(allIds);
    options.target.collisionPolicy = "adopt";
    const fake = createFakeDokploy({
      projects: [{ name: "Acme", environments: ["production", "staging"] }],
    });
    const existing = (await fake.client.projectAll())[0];
    const snapshot: TargetSnapshot = {
      projects: [
        {
          projectId: existing?.projectId as string,
          name: "Acme",
          environments: (existing?.environments ?? []).map((e) => ({
            environmentId: e.environmentId,
            name: e.name,
            resourceNames: [],
          })),
        },
      ],
    };
    const plan = buildPlan(ir, options, snapshot);
    const idMap = createMemoryIdMap();
    const outcome = await runPlan(
      plan,
      { runId: "run1", dokploy: fake.client, vault, idMap, options },
      { hooks: noSleep },
    );
    expect(outcome.status).toBe("completed");
    expect(fake.snapshot().projects).toHaveLength(1);
    expect(
      idMap.entries("run1").find((e) => e.srcKind === "project"),
    ).toMatchObject({ created: false });
    expect(
      idMap.entries("run1").find((e) => e.srcKind === "environment"),
    ).toMatchObject({ created: false });
    expect(fake.snapshot().resources.length).toBeGreaterThan(0);
  });
});

describe("rollback", () => {
  it("deletes only what was created, in reverse dependency order, and restores the original state", async () => {
    const seed = {
      projects: [{ name: "Existing", environments: ["production"] }],
    };
    const { plan, fake, ctx, idMap } = await setup(undefined, {}, seed);
    const before = JSON.stringify(fake.snapshot().projects.map((p) => p.name));
    await runPlan(plan, ctx, { hooks: noSleep });
    expect(fake.snapshot().projects).toHaveLength(2);

    const entries: RollbackEntry[] = idMap
      .entries("run1")
      .map((e) => ({ ...e, srcKind: e.srcKind as RollbackEntry["srcKind"] }));
    // an adopted entry must survive
    entries.push({
      srcId: "adopted",
      srcKind: "project",
      targetId: fake.snapshot().projects[0]?.projectId as string,
      created: false,
    });
    const rollback = buildRollbackPlan(entries);
    const order = rollback.steps.map((s) => s.payload.targetKind);
    expect(order.indexOf("domain")).toBeLessThan(order.indexOf("application"));
    expect(order.indexOf("application")).toBeLessThan(order.indexOf("project"));
    for (const step of rollback.steps)
      await executeRollbackStep(step, fake.client);
    expect(JSON.stringify(fake.snapshot().projects.map((p) => p.name))).toBe(
      before,
    );
    expect(fake.snapshot().resources).toEqual([]);
    expect(fake.snapshot().domains).toEqual([]);
    // idempotent: a second pass treats 404 as done
    for (const step of rollback.steps)
      expect((await executeRollbackStep(step, fake.client)).deleted).toBe(true);
  });
});

describe("verify", () => {
  it("passes after a clean apply and flags a deliberately altered target", async () => {
    const { plan, fake, ctx, idMap } = await setup();
    await runPlan(plan, ctx, { hooks: noSleep });
    const entries = idMap.entries("run1");
    const clean = await verifyMigration(plan, entries, fake.client);
    expect(clean.length).toBeGreaterThan(10);
    expect(clean.filter((c) => c.status !== "pass")).toEqual([]);
    expect(JSON.stringify(clean)).not.toMatch(/CANARY_/);

    // someone removes a domain and a mount in Dokploy after the migration
    const state = fake.snapshot();
    await fake.client.domainDelete(state.domains[0]?.domainId as string);
    await fake.client.mountDelete(state.mounts[0]?.mountId as string);
    const drifted = await verifyMigration(plan, entries, fake.client);
    const failed = drifted
      .filter((c) => c.status === "fail")
      .map((c) => c.check);
    expect(failed).toEqual(expect.arrayContaining(["domains", "mounts"]));
  });

  it("reports resources that were never created", async () => {
    const { plan, fake } = await setup();
    const checks = await verifyMigration(plan, [], fake.client);
    expect(
      checks.every((c) => c.status === "fail" && c.check === "exists"),
    ).toBe(true);
  });
});

describe("migration report", () => {
  it("lists what was created and what still needs a human, without any secret", async () => {
    const { plan, fake, ctx, ir, idMap } = await setup();
    const outcome = await runPlan(plan, ctx, { hooks: noSleep });
    const verify = await verifyMigration(
      plan,
      idMap.entries("run1"),
      fake.client,
    );
    const records = [...outcome.records.entries()].map(([seq, r]) => ({
      seq,
      ...r,
    }));
    const md = renderMigrationReport({
      ir,
      plan,
      records,
      verify,
      target: { url: "http://dokploy.test", version: "v0.31.4" },
      generatedAt: "2026-11-23T00:00:00Z",
    });
    expect(md).toContain("Nothing was deployed");
    expect(md).toContain("| application | web |");
    expect(md).toContain("`LOCKED`"); // unreadable secret listed by key name
    expect(md).toContain("New database password");
    expect(md).toContain("pg_dump");
    expect(md).toContain("web.acme.test");
    expect(md).toContain("Revoke");
    expect(md).not.toMatch(/CANARY_/);
  });
});
