import type { CoolifyReader } from "../clients/coolify.js";

type Rec = Record<string, unknown>;

const env = (key: string, value: string, extra: Rec = {}): Rec => ({
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

export interface FakeCoolifyCanaries {
  appSecret: string;
  dbPassword: string;
}

/**
 * A tiny Coolify 4.7.5 with realistic response shapes: one project, one production environment,
 * a public git app with a secret env var and a volume, a docker-image app with a domain, and a Postgres.
 */
export function createFakeCoolify(
  canaries: FakeCoolifyCanaries,
): CoolifyReader {
  const gitApp: Rec = {
    uuid: "app-git",
    name: "web:main-abcdefghijklmnopqrstuvwx",
    environment_id: 1,
    build_pack: "nixpacks",
    git_repository: "acme/web",
    git_branch: "main",
    git_commit_sha: "HEAD",
    source_type: "App\\Models\\GithubApp",
    source_id: 0,
    fqdn: "https://web.acme.test",
    ports_exposes: "3000",
    base_directory: "/",
    publish_directory: "/",
    build_command: "npm run build",
  };
  const imageApp: Rec = {
    uuid: "app-img",
    name: "proxy",
    environment_id: 1,
    build_pack: "dockerimage",
    git_repository: "coollabsio/coolify",
    docker_registry_image_name: "nginx",
    docker_registry_image_tag: "alpine",
    fqdn: "https://proxy.acme.test",
    ports_exposes: "80",
  };
  const postgres: Rec = {
    uuid: "db-pg",
    name: "main-db",
    environment_id: 1,
    database_type: "standalone-postgresql",
    image: "postgres:16-alpine",
    postgres_user: "acme",
    postgres_db: "acme",
    postgres_password: canaries.dbPassword,
    is_public: false,
  };
  const byUuid: Record<string, Rec> = {
    "app-git": gitApp,
    "app-img": imageApp,
    "db-pg": postgres,
  };
  const envs: Record<string, Rec[]> = {
    "app-git": [
      env("API_SECRET", canaries.appSecret),
      env("API_SECRET", canaries.appSecret, { is_preview: true }),
      env("GREETING", "hello world"),
      env("SERVICE_URL_WEB", "https://x", { is_coolify: true }),
    ],
  };
  return {
    probe: async () => ({
      version: "4.7.5",
      abilities: { read: true, write: false, sensitiveRead: "unknown" },
      warnings: [],
    }),
    listProjects: async () => [{ uuid: "p1", name: "Acme" }],
    listApplications: async () => [gitApp, imageApp],
    listDatabases: async () => [postgres],
    listServices: async () => [],
    listServers: async () => [
      { uuid: "s1", name: "localhost", ip: "10.0.0.1" },
    ],
    listGithubApps: async () => [
      { id: 0, name: "Public GitHub", is_public: true },
    ],
    getProject: async () => ({
      uuid: "p1",
      name: "Acme",
      environments: [{ id: 1, uuid: "e1", name: "production" }],
    }),
    getEnvironment: async () => ({
      applications: [gitApp, imageApp],
      postgresqls: [postgres],
      redis: [],
      services: [],
    }),
    getApplication: async (u) => byUuid[u],
    getApplicationEnvs: async (u) => envs[u] ?? [],
    getApplicationStorages: async (u) =>
      u === "app-git"
        ? [{ name: "app-git-uploads", mount_path: "/data", host_path: null }]
        : [],
    getDatabase: async (u) => byUuid[u],
    getDatabaseEnvs: async () => [],
    getDatabaseStorages: async () => [],
    getDatabaseBackups: async () => [],
    getService: async () => ({}),
    getServiceEnvs: async () => [],
    getServiceStorages: async () => [],
  };
}
