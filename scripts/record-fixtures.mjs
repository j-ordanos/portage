#!/usr/bin/env node
// Records REAL API response shapes from the lab Coolify + Dokploy into lab/fixtures/.
// SAFETY: GET requests only (enforced below). Secret-looking values are replaced by
// "<redacted:N chars>" so the *shape and presence* survive but the value does not.
// Credentials come from env vars or a git-ignored `.env.lab` file; they are never printed.
//
//   COOLIFY_URL=http://host:8000  COOLIFY_TOKEN=...
//   DOKPLOY_URL=http://localhost:3000  DOKPLOY_API_KEY=...
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env.lab", ".env"]) {
  const envFile = join(root, name);
  if (!existsSync(envFile)) continue;
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trim().startsWith("#")) {
      process.env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim();
    }
  }
}
// Lab defaults (see docs/STATUS.md); override via env.
process.env.COOLIFY_URL ??= "http://192.168.122.50:8000";
process.env.DOKPLOY_URL ??= "http://localhost:3000";

const SENSITIVE =
  /(^|_)(value|real_value|password|passwd|token|secret|private_key|api_?key|key|credentials?|dsn|webhook_secret|manual_webhook_secret_\w+|dockerfile|custom_labels|content|env|buildArgs|buildSecrets)$/i;
// Compose files are the thing we migrate; keep them only when you opt in (they may hold secrets).
const KEEP_COMPOSE = process.env.KEEP_COMPOSE === "1";
const COMPOSE = /^(docker_compose|docker_compose_raw|composeFile)$/i;
const KEEP = /^(key|is_.*|.*_key_id|ssh_key_id|private_key_id)$/i; // "key" in env objects is a NAME, keep it

function sanitize(node, parentKey = "") {
  if (Array.isArray(node)) return node.map((n) => sanitize(n, parentKey));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = sanitize(v, k);
    return out;
  }
  if (typeof node === "string" && node.length > 0) {
    // URLs with embedded credentials (postgres://user:pass@host) -> keep scheme/host, drop userinfo
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]+@/i.test(node)) {
      return node.replace(/\/\/[^/\s:@]+:[^@\s]+@/, "//<redacted>@");
    }
    if (COMPOSE.test(parentKey) && !KEEP_COMPOSE)
      return `<redacted:${node.length} chars>`;
    const isEnvKeyName = parentKey === "key" || parentKey === "name";
    if (!isEnvKeyName && SENSITIVE.test(parentKey) && !KEEP.test(parentKey)) {
      return `<redacted:${node.length} chars>`;
    }
  }
  return node;
}

async function get(base, path, headers) {
  const url = new URL(path, base);
  const res = await fetch(url, { method: "GET", headers, redirect: "manual" });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _nonJson: true, preview: text.slice(0, 200) };
  }
  return { path, status: res.status, body };
}

const outRoot = join(root, "lab", "fixtures");
function save(platform, version, name, data, raw = false) {
  const dir = join(outRoot, platform, version.replace(/[^\w.-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name.replace(/[^\w.-]+/g, "_")}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(raw ? data : sanitize(data), null, 2)}\n`,
  );
  return file;
}
const arr = (b) =>
  Array.isArray(b) ? b : Array.isArray(b?.data) ? b.data : [];
const summary = [];
const note = (s) => {
  summary.push(s);
  console.log(s);
};

async function coolify() {
  const base = process.env.COOLIFY_URL;
  const token = process.env.COOLIFY_TOKEN;
  if (!base || !token)
    return note("coolify: skipped (COOLIFY_URL / COOLIFY_TOKEN not set)");
  const h = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const v = await get(base, "/api/v1/version", h);
  const ver = String(
    v.body?._nonJson ? v.body.preview.trim() : (v.body?.version ?? "unknown"),
  );
  const rec = async (name, path) => {
    const r = await get(base, path, h);
    save("coolify", ver, name, r);
    note(`coolify GET ${path} -> ${r.status}`);
    return r;
  };
  save("coolify", ver, "version", v);
  note(`coolify GET /api/v1/version -> ${v.status}`);
  await rec("healthcheck", "/api/v1/healthcheck");
  await rec("teams", "/api/v1/teams");
  await rec("teams_current", "/api/v1/teams/current");
  const projects = await rec("projects", "/api/v1/projects");
  for (const p of arr(projects.body)) {
    const d = await rec(`project_${p.uuid}`, `/api/v1/projects/${p.uuid}`);
    await rec(
      `project_${p.uuid}_environments`,
      `/api/v1/projects/${p.uuid}/environments`,
    );
    const envs = d.body?.environments ?? [];
    for (const e of envs) {
      await rec(
        `project_${p.uuid}_env_${e.name}`,
        `/api/v1/projects/${p.uuid}/${encodeURIComponent(e.name)}`,
      );
      await rec(
        `project_${p.uuid}_env_${e.name}_envs`,
        `/api/v1/projects/${p.uuid}/${encodeURIComponent(e.name)}/envs`,
      );
    }
  }
  for (const [list, kinds] of [
    ["applications", ["", "/envs", "/storages"]],
    ["databases", ["", "/envs", "/storages", "/backups"]],
    ["services", ["", "/envs", "/storages"]],
  ]) {
    const l = await rec(list, `/api/v1/${list}`);
    for (const item of arr(l.body)) {
      for (const k of kinds)
        await rec(
          `${list}_${item.uuid}${k.replace("/", "_")}`,
          `/api/v1/${list}/${item.uuid}${k}`,
        );
    }
  }
  for (const p of [
    "/api/v1/servers",
    "/api/v1/resources",
    "/api/v1/security/keys",
    "/api/v1/github-apps",
    "/api/v1/teams/current/members",
  ]) {
    await rec(p.split("/").slice(3).join("_"), p);
  }
}

async function dokploy() {
  const base = process.env.DOKPLOY_URL;
  const key = process.env.DOKPLOY_API_KEY;
  if (!base || !key)
    return note("dokploy: skipped (DOKPLOY_URL / DOKPLOY_API_KEY not set)");
  const styles = {
    "x-api-key": { "x-api-key": key },
    authorization: { Authorization: key },
    bearer: { Authorization: `Bearer ${key}` },
  };
  let style;
  for (const [name, hdr] of Object.entries(styles)) {
    const r = await get(base, "/api/project.all", {
      ...hdr,
      Accept: "application/json",
    });
    note(`dokploy auth style '${name}' on /api/project.all -> ${r.status}`);
    if (r.status === 200) {
      style = name;
      break;
    }
  }
  if (!style) return note("dokploy: no auth style worked; check the API key");
  const h = { ...styles[style], Accept: "application/json" };
  const vr = await get(base, "/api/settings.getDokployVersion", h);
  const version = String(
    typeof vr.body === "string"
      ? vr.body
      : (vr.body?.version ?? vr.body?.result?.data?.json ?? "unknown"),
  );
  const rec = async (name, path) => {
    const r = await get(base, path, h);
    save("dokploy", version, name, r);
    note(`dokploy GET ${path.split("?")[0]} -> ${r.status}`);
    return r;
  };
  save("dokploy", version, "version", vr);
  const openapi = await get(base, "/api/settings.getOpenApiDocument", h);
  note(`dokploy GET /api/settings.getOpenApiDocument -> ${openapi.status}`);
  save("dokploy", version, "openapi", openapi.body, true); // API schema, not secret
  const projects = await rec("project_all", "/api/project.all");
  for (const p of arr(projects.body)) {
    await rec(
      `project_${p.projectId}`,
      `/api/project.one?projectId=${p.projectId}`,
    );
    await rec(
      `environments_${p.projectId}`,
      `/api/environment.byProjectId?projectId=${p.projectId}`,
    );
  }
  await rec("server_all", "/api/server.all");
  await rec("registry_all", "/api/registry.all");
  await rec("git_providers", "/api/gitProvider.getAll");
  save("dokploy", version, "_auth_style", { style });
}

await coolify();
await dokploy();
writeFileSync(join(outRoot, "RECORDED.log"), `${summary.join("\n")}\n`);
console.log("\nDone. Fixtures written under lab/fixtures/ (values redacted).");
