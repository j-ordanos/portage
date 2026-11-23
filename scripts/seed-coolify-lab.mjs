#!/usr/bin/env node
// Seeds a DISPOSABLE lab Coolify with one of each resource kind so the extractor has real fixtures.
// Everything lives in one project ("migrator-seed") and nothing is deployed (instant_deploy:false).
// Delete the project in Coolify to clean up. Never run against production.
// Credentials: COOLIFY_URL / COOLIFY_TOKEN from env or .env (never printed).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env.lab", ".env"]) {
  const f = join(root, name);
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trim().startsWith("#"))
      process.env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim();
  }
}
const base = process.env.COOLIFY_URL ?? "http://192.168.122.50:8000";
const token = process.env.COOLIFY_TOKEN;
if (!token) throw new Error("COOLIFY_TOKEN missing");
const PROJECT = "migrator-seed";

async function api(method, path, body) {
  const res = await fetch(new URL(`/api/v1${path}`, base), {
    method,
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}
const log = (m) => console.log(m);
const must = (r, what) => {
  if (r.status >= 300) {
    log(`FAIL ${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    process.exitCode = 1;
    return false;
  }
  log(`ok   ${what}: ${r.status}`);
  return true;
};

const servers = await api("GET", "/servers");
const server = (servers.body ?? [])[0];
if (!server) throw new Error("no server found");
const projects = (await api("GET", "/projects")).body ?? [];
let project = projects.find((p) => p.name === PROJECT);
if (!project) {
  const c = await api("POST", "/projects", {
    name: PROJECT,
    description: "disposable seed for the migrator lab",
  });
  if (!must(c, "create project")) process.exit(1);
  project = c.body;
}
const ctx = {
  project_uuid: project.uuid,
  server_uuid: server.uuid,
  environment_name: "production",
  instant_deploy: false,
};
log(`project ${PROJECT} ready`);

const existing = async (path) =>
  ((await api("GET", path)).body ?? []).map((x) => x.name);
const have = {
  db: await existing("/databases"),
  svc: await existing("/services"),
  app: await existing("/applications"),
};

if (!have.db.includes("seed-postgres"))
  must(
    await api("POST", "/databases/postgresql", {
      ...ctx,
      name: "seed-postgres",
      postgres_user: "seed_user",
      postgres_db: "seed_db",
      postgres_password: "seed-lab-password",
      image: "postgres:16-alpine",
    }),
    "postgres",
  );
if (!have.db.includes("seed-redis"))
  must(
    await api("POST", "/databases/redis", {
      ...ctx,
      name: "seed-redis",
      image: "redis:7-alpine",
    }),
    "redis",
  );
if (!have.db.includes("seed-mysql"))
  must(
    await api("POST", "/databases/mysql", {
      ...ctx,
      name: "seed-mysql",
      mysql_user: "seed",
      mysql_database: "seed",
      mysql_password: "seed-lab-password",
      mysql_root_password: "seed-lab-root",
      image: "mysql:8",
    }),
    "mysql",
  );
if (!have.svc.includes("seed-uptime-kuma"))
  must(
    await api("POST", "/services", {
      ...ctx,
      name: "seed-uptime-kuma",
      type: "uptime-kuma",
    }),
    "service uptime-kuma",
  );

let imageApp;
if (!have.app.includes("seed-nginx")) {
  const r = await api("POST", "/applications/dockerimage", {
    ...ctx,
    name: "seed-nginx",
    docker_registry_image_name: "nginx",
    docker_registry_image_tag: "alpine",
    ports_exposes: "80",
    domains: "https://seed-nginx.lab.test",
  });
  if (must(r, "docker-image app")) imageApp = r.body.uuid;
}
if (imageApp) {
  for (const e of [
    { key: "PLAIN_VAR", value: "hello" },
    { key: "API_TOKEN", value: "seed-secret-value", is_buildtime: false },
    { key: "MULTILINE_VAR", value: "line1\nline2\nline3", is_multiline: true },
    { key: "LITERAL_VAR", value: "$notexpanded", is_literal: true },
    { key: "WITH_HASH", value: "a#b=c d" },
    { key: "SHARED_REF", value: "{{environment.SHARED_X}}" },
  ])
    must(
      await api("POST", `/applications/${imageApp}/envs`, e),
      `env ${e.key}`,
    );
}
if (!have.app.includes("seed-nixpacks")) {
  const r = await api("POST", "/applications/public", {
    ...ctx,
    name: "seed-nixpacks",
    git_repository: "https://github.com/coollabsio/coolify-examples",
    git_branch: "v4.x",
    build_pack: "nixpacks",
    base_directory: "/nodejs",
    ports_exposes: "3000",
    domains: "https://seed-app.lab.test",
  });
  if (must(r, "public nixpacks app")) {
    must(
      await api("POST", `/applications/${r.body.uuid}/envs`, {
        key: "NODE_ENV",
        value: "production",
      }),
      "env NODE_ENV",
    );
    must(
      await api("POST", `/applications/${r.body.uuid}/storages`, {
        type: "persistent",
        name: "seed-data",
        mount_path: "/data",
      }),
      "storage persistent",
    );
    must(
      await api("POST", `/applications/${r.body.uuid}/storages`, {
        type: "file",
        mount_path: "/app/config.json",
        content: '{"seed":true}',
      }),
      "storage file",
    );
  }
}
log("seed finished");
