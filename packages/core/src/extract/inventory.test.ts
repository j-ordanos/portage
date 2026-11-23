import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CoolifyReader } from "../clients/coolify.js";
import { IR } from "../ir/schema.js";
import { MemoryVault } from "../vault.js";
import { extractInventory } from "./inventory.js";

const env = (
  key: string,
  value: string,
  extra: Record<string, unknown> = {},
) => ({
  key,
  value,
  real_value: value,
  is_buildtime: true,
  is_runtime: true,
  is_preview: false,
  is_coolify: false,
  is_shown_once: false,
  is_literal: false,
  is_multiline: false,
  ...extra,
});

const gitApp = {
  uuid: "app-git",
  name: "matchmaker:main-uhmdhdtjjrwutrokdrxf5trt",
  environment_id: 1,
  build_pack: "railpack",
  git_repository: "acme/matchmaker",
  git_branch: "main",
  git_commit_sha: "HEAD",
  source_type: "App\\Models\\GithubApp",
  source_id: 0,
  private_key_id: null,
  fqdn: "http://app-git.1.2.3.4.sslip.io",
  ports_exposes: "3000",
  base_directory: "/",
  publish_directory: "/",
  health_check_enabled: false,
  limits_memory: "0",
  limits_cpus: "0",
};
const imageApp = {
  uuid: "app-img",
  name: "seed-nginx",
  environment_id: 1,
  build_pack: "dockerimage",
  git_repository: "coollabsio/coolify", // junk default Coolify leaves on image apps
  git_branch: "main",
  docker_registry_image_name: "nginx",
  docker_registry_image_tag: "alpine",
  fqdn: "https://seed.example.test,http://seed.example.test",
  ports_exposes: "80",
};
const composeApp = {
  uuid: "app-compose",
  name: "name-server:main-gy6jmv1qi2qlvvgqepidcsmt",
  environment_id: 1,
  build_pack: "dockercompose",
  git_repository: "acme/name-server",
  git_branch: "main",
  source_type: "App\\Models\\GithubApp",
  source_id: 0,
  docker_compose_location: "/docker-compose.yml",
  docker_compose_raw: "services:\n  web:\n    image: nginx\n",
  docker_compose:
    "services:\n  web:\n    labels:\n      - coolify.managed=true\n",
  docker_compose_domains: JSON.stringify({
    web: { domain: "http://x.test,https://x.test,https://www.x.test" },
  }),
};
const sshApp = {
  ...gitApp,
  uuid: "app-ssh",
  name: "private-app",
  git_repository: "git@github.com:acme/private.git",
  private_key_id: 1,
  source_type: null,
  source_id: null,
};
const postgres = {
  uuid: "db-pg",
  name: "seed-postgres",
  database_type: "standalone-postgresql",
  image: "postgres:16-alpine",
  postgres_user: "seed_user",
  postgres_db: "seed_db",
  postgres_password: "CANARY_PG_PASSWORD",
  internal_db_url: "postgres://seed_user:CANARY_PG_PASSWORD@db-pg:5432/seed_db",
  is_public: true,
  public_port: 5433,
};
const redis = {
  uuid: "db-redis",
  name: "seed-redis",
  database_type: "standalone-redis",
  image: "redis:7-alpine",
  is_public: false,
};
const clickhouse = {
  uuid: "db-ch",
  name: "ch",
  database_type: "standalone-clickhouse",
  image: "ch",
};
const service = {
  uuid: "svc-kuma",
  name: "seed-uptime-kuma",
  service_type: "uptime-kuma",
  docker_compose_raw:
    "services:\n  uptime-kuma:\n    image: louislam/uptime-kuma:2\n",
  applications: [
    { name: "uptime-kuma", fqdn: "http://uptimekuma-x.1.2.3.4.sslip.io" },
  ],
};

const byUuid: Record<string, Record<string, unknown>> = Object.fromEntries(
  [
    gitApp,
    imageApp,
    composeApp,
    sshApp,
    postgres,
    redis,
    clickhouse,
    service,
  ].map((r) => [r.uuid, r]),
);
const envsOf: Record<string, unknown[]> = {
  "app-git": [
    env("DATABASE_URL", "CANARY_SECRET_1"),
    env("DATABASE_URL", "CANARY_SECRET_1"), // Coolify repeats every variable
    env("SERVICE_URL_WEB", "http://x", { is_coolify: true }),
    env("SHARED", "{{environment.SHARED_X}}"),
    env("LOCKED", "", { is_shown_once: true }),
  ],
  "db-redis": [
    env("REDIS_PASSWORD", "CANARY_REDIS_PW"),
    env("REDIS_USERNAME", "default"),
  ],
};

function fakeReader(): CoolifyReader {
  return {
    probe: async () => ({
      version: "4.7.5",
      abilities: { read: true, write: false, sensitiveRead: "unknown" },
      warnings: [],
    }),
    listProjects: async () => [{ uuid: "p1", name: "Acme" }],
    listApplications: async () => [gitApp, imageApp, composeApp, sshApp],
    listDatabases: async () => [postgres, redis, clickhouse],
    listServices: async () => [service],
    listServers: async () => [
      { uuid: "s1", name: "localhost", ip: "10.0.0.1" },
    ],
    listGithubApps: async () => [
      { id: 0, name: "Public GitHub", is_public: true },
    ],
    listSecurityKeys: async () => [],
    getProject: async () => ({
      uuid: "p1",
      name: "Acme",
      environments: [{ id: 1, uuid: "e1", name: "production" }],
    }),
    // grouping comes from the environment call; sshApp is deliberately missing to test the environment_id fallback
    getEnvironment: async () => ({
      applications: [gitApp, imageApp, composeApp],
      postgresqls: [postgres],
      redis: [redis],
      clickhouses: [clickhouse],
      services: [service],
    }),
    getApplication: async (u) => byUuid[u],
    getApplicationEnvs: async (u) => envsOf[u] ?? [],
    getApplicationStorages: async (u) =>
      u === "app-git"
        ? [{ name: "app-git-data", mount_path: "/data", host_path: null }]
        : [],
    getDatabase: async (u) => byUuid[u],
    getDatabaseEnvs: async (u) => envsOf[u] ?? [],
    getDatabaseStorages: async () => [],
    getDatabaseBackups: async () => [],
    getService: async (u) => byUuid[u],
    getServiceEnvs: async () => [],
    getServiceStorages: async () => [],
  };
}

describe("coolify extractor (real 4.7.5 shapes)", () => {
  it("groups, classifies and maps every resource kind without leaking secrets", async () => {
    const vault = new MemoryVault();
    const ir = await extractInventory(fakeReader(), vault, {
      sourceUrl: "https://coolify.example",
      sourceVersion: "unknown",
    });
    expect(IR.parse(ir)).toEqual(ir);
    expect(ir.source.version).toBe("4.7.5");
    const json = JSON.stringify(ir);
    for (const canary of [
      "CANARY_SECRET_1",
      "CANARY_PG_PASSWORD",
      "CANARY_REDIS_PW",
    ]) {
      expect(json).not.toContain(canary);
    }

    const resources = ir.projects[0]?.environments[0]?.resources ?? [];
    expect(resources.map((r) => r.name).sort()).toEqual(
      [
        "ch",
        "matchmaker",
        "name-server",
        "private-app",
        "seed-nginx",
        "seed-postgres",
        "seed-redis",
        "seed-uptime-kuma",
      ].sort(),
    );
    for (const r of resources) expect(r.projectSrcId).toBe("p1");

    const git = resources.find((r) => r.srcId === "app-git");
    if (git?.kind !== "application") throw new Error("expected application");
    expect(git.build.pack).toBe("railpack");
    expect(git.source).toMatchObject({
      type: "git",
      provider: "public",
      url: "https://github.com/acme/matchmaker",
    });
    expect(git.domains).toEqual([]); // auto sslip.io domain skipped
    expect(git.issues.map((i) => i.ruleId)).toEqual(
      expect.arrayContaining(["X-010", "X-001"]),
    );
    expect(git.env.map((e) => e.key)).toEqual([
      "DATABASE_URL",
      "LOCKED",
      "SHARED",
    ]); // deduped, coolify var dropped
    expect(git.env.find((e) => e.key === "LOCKED")?.availability).toBe(
      "redacted",
    );
    expect(git.env.find((e) => e.key === "SHARED")?.refs).toEqual([
      "environment.SHARED_X",
    ]);
    expect(git.mounts).toEqual([
      { type: "volume", name: "data", mountPath: "/data" },
    ]);
    const dbUrl = git.env.find((e) => e.key === "DATABASE_URL");
    expect(await vault.get(dbUrl?.valueRef as string)).toBe("CANARY_SECRET_1");

    const img = resources.find((r) => r.srcId === "app-img");
    if (img?.kind !== "application") throw new Error("expected application");
    expect(img.source).toEqual({
      type: "image",
      image: "nginx",
      tag: "alpine",
    });
    expect(img.domains).toEqual([
      expect.objectContaining({
        host: "seed.example.test",
        https: true,
        port: 80,
      }),
    ]);

    const ssh = resources.find((r) => r.srcId === "app-ssh"); // found via environment_id fallback
    if (ssh?.kind !== "application") throw new Error("expected application");
    expect(ssh.source).toMatchObject({ provider: "deploy-key" });

    const compose = resources.find((r) => r.srcId === "app-compose");
    if (compose?.kind !== "compose") throw new Error("expected compose");
    expect(compose.composeRaw).toContain("image: nginx");
    expect(compose.composeRaw).not.toContain("coolify.managed");
    expect(compose.composePath).toBe("/docker-compose.yml");
    expect(compose.isTemplateService).toBe(false);
    expect(
      compose.domains.map((d) => `${d.service}:${d.host}:${d.https}`).sort(),
    ).toEqual(["web:www.x.test:true", "web:x.test:true"]);

    const svc = resources.find((r) => r.srcId === "svc-kuma");
    if (svc?.kind !== "compose") throw new Error("expected compose");
    expect(svc).toMatchObject({
      isTemplateService: true,
      templateName: "uptime-kuma",
      domains: [],
    });

    const pg = resources.find((r) => r.srcId === "db-pg");
    if (pg?.kind !== "database") throw new Error("expected database");
    expect(pg).toMatchObject({
      engine: "postgres",
      dbName: "seed_db",
      dbUser: "seed_user",
      publiclyExposed: true,
      publicPort: 5433,
      passwordAvailability: "available",
    });
    expect(await vault.get(pg.passwordRef as string)).toBe(
      "CANARY_PG_PASSWORD",
    );

    const rd = resources.find((r) => r.srcId === "db-redis");
    if (rd?.kind !== "database") throw new Error("expected database");
    expect(rd.engine).toBe("redis");
    expect(await vault.get(rd.passwordRef as string)).toBe("CANARY_REDIS_PW");

    const ch = resources.find((r) => r.srcId === "db-ch");
    expect(ch).toMatchObject({ engine: "other" });
    expect(ch?.issues.map((i) => i.ruleId)).toContain("R-063");
  });

  it("records failures as issues and keeps going", async () => {
    const reader = fakeReader();
    reader.getApplicationEnvs = async (u) => {
      if (u === "app-img") throw new Error("boom CANARY_TOKEN_X");
      return [];
    };
    reader.listServices = async () => {
      throw new Error("nope");
    };
    const ir = await extractInventory(reader, new MemoryVault(), {
      sourceUrl: "https://coolify.example",
      sourceVersion: "4.7.5",
    });
    const resources = ir.projects[0]?.environments[0]?.resources ?? [];
    const failed = resources.find((r) => r.srcId === "app-img");
    expect(failed?.compat).toBe("manual");
    expect(failed?.issues[0]?.ruleId).toBe("E-001");
    expect(JSON.stringify(ir)).not.toContain("CANARY_TOKEN_X");
    expect(resources.length).toBeGreaterThan(5);
    expect(ir.notes.some((n) => n.ruleId === "E-002")).toBe(true);
  });

  it("is deterministic", async () => {
    const run = async () => {
      const ir = await extractInventory(fakeReader(), new MemoryVault(), {
        sourceUrl: "https://c",
        sourceVersion: "4.7.5",
      });
      return JSON.stringify({
        ...ir,
        source: { ...ir.source, readAt: "" },
      }).replace(/v_[0-9a-f]+/g, "v_");
    };
    expect(await run()).toBe(await run());
  });
});

// Replays the REAL responses recorded from the lab (git-ignored; skipped when absent).
const labDir = join(__dirname, "../../../../lab/fixtures/coolify/4.7.5");
describe.skipIf(!existsSync(join(labDir, "projects.json")))(
  "lab fixtures replay",
  () => {
    const read = (name: string): unknown => {
      const f = join(labDir, `${name}.json`);
      return existsSync(f)
        ? (JSON.parse(readFileSync(f, "utf8")) as { body: unknown }).body
        : [];
    };
    const reader: CoolifyReader = {
      probe: async () => ({
        version: "4.7.5",
        abilities: { read: true, write: false, sensitiveRead: "unknown" },
        warnings: [],
      }),
      listProjects: async () => read("projects") as unknown[],
      listApplications: async () => read("applications") as unknown[],
      listDatabases: async () => read("databases") as unknown[],
      listServices: async () => read("services") as unknown[],
      listServers: async () => read("servers") as unknown[],
      listGithubApps: async () => read("github-apps") as unknown[],
      listSecurityKeys: async () => read("security_keys") as unknown[],
      getProject: async (u) => read(`project_${u}`),
      getEnvironment: async (u, e) => read(`project_${u}_env_${e}`),
      getApplication: async (u) => read(`applications_${u}`),
      getApplicationEnvs: async (u) =>
        read(`applications_${u}_envs`) as unknown[],
      getApplicationStorages: async (u) =>
        flat(read(`applications_${u}_storages`)),
      getDatabase: async (u) => read(`databases_${u}`),
      getDatabaseEnvs: async (u) => read(`databases_${u}_envs`) as unknown[],
      getDatabaseStorages: async (u) => flat(read(`databases_${u}_storages`)),
      getDatabaseBackups: async (u) =>
        read(`databases_${u}_backups`) as unknown[],
      getService: async (u) => read(`services_${u}`),
      getServiceEnvs: async (u) => read(`services_${u}_envs`) as unknown[],
      getServiceStorages: async (u) => flat(read(`services_${u}_storages`)),
    };
    const flat = (v: unknown): unknown[] => {
      const o = v as {
        persistent_storages?: unknown[];
        file_storages?: unknown[];
      };
      return [...(o.persistent_storages ?? []), ...(o.file_storages ?? [])];
    };

    it("builds a valid IR where every resource appears exactly once", async () => {
      const ir = await extractInventory(reader, new MemoryVault(), {
        sourceUrl: "http://lab",
        sourceVersion: "4.7.5",
      });
      expect(IR.parse(ir)).toEqual(ir);
      const ids = ir.projects.flatMap((p) =>
        p.environments.flatMap((e) => e.resources.map((r) => r.srcId)),
      );
      expect(new Set(ids).size).toBe(ids.length);
      expect(ir.notes.filter((n) => n.severity === "error")).toEqual([]);
      for (const p of ir.projects)
        for (const e of p.environments)
          for (const r of e.resources)
            expect(r.issues.map((i) => i.ruleId)).not.toContain("E-001");
    });
  },
);
