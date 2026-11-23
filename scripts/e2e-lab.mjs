#!/usr/bin/env node
// Live end-to-end on the LAB: Coolify (read-only) -> IR -> plan -> Dokploy (create only) -> read-back verify.
//   node scripts/e2e-lab.mjs              dry run: prints the plan, writes NOTHING
//   node scripts/e2e-lab.mjs --apply      creates everything (undeployed), then verifies
//   node scripts/e2e-lab.mjs --rollback   deletes ONLY what the last --apply created
// Options: --only=<project name>[,..]  --marker=<text>  --adopt | --skip-collisions  --secrets=names-only
// Needs `pnpm build` first. Credentials come from .env (COOLIFY_TOKEN, DOKPLOY_API_KEY); nothing secret is printed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(join(root, "packages/core/dist/index.js"));
for (const f of [".env.lab", ".env"]) {
  const p = join(root, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trim().startsWith("#"))
      process.env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim();
  }
}
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) =>
  args
    .find((a) => a.startsWith(`--${n}=`))
    ?.split("=")
    .slice(1)
    .join("=");
const COOLIFY = process.env.COOLIFY_URL ?? "http://192.168.122.50:8000";
const DOKPLOY = process.env.DOKPLOY_URL ?? "http://localhost:3000";
const stateFile = join(root, "lab", "e2e-state.json");

const dokploy = core.createDokployClient({
  baseUrl: DOKPLOY,
  apiKey: process.env.DOKPLOY_API_KEY,
  timeoutMs: 30000,
});
const log = (...a) => console.log(...a);

if (flag("rollback")) {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const entries = state.entries.map((e) => ({ ...e }));
  const plan = core.buildRollbackPlan(entries);
  log(
    `Rollback: ${plan.steps.length} created resources (adopted/existing ones are never touched)`,
  );
  for (const step of plan.steps) {
    const r = await core.executeRollbackStep(step, dokploy);
    log(
      `  deleted ${step.payload.targetKind} ${step.label.replace(/^Delete created /, "")}${r.deleted ? "" : " (already gone)"}`,
    );
  }
  writeFileSync(stateFile, JSON.stringify({ entries: [] }));
  log("Rollback finished.");
  process.exit(0);
}

// ---- 1. extract (read-only) ----
const reader = core.createCoolifyReader({
  baseUrl: COOLIFY,
  token: process.env.COOLIFY_TOKEN,
  timeoutMs: 30000,
});
const vault = new core.MemoryVault();
let ir = await core.extractInventory(reader, vault, {
  sourceUrl: COOLIFY,
  sourceVersion: "unknown",
});
ir = core.runRules(ir, { sensitiveRead: true });
log(`Coolify ${ir.source.version}: ${ir.projects.length} projects`);

// ---- 2. target snapshot (read-only) ----
const probe = await dokploy.probe();
const existing = await dokploy.projectAll();
const names = (env) =>
  [
    "applications",
    "compose",
    "postgres",
    "mysql",
    "mariadb",
    "mongo",
    "redis",
  ].flatMap((k) => (env[k] ?? []).map((r) => r.name).filter(Boolean));
const snapshot = {
  projects: existing.map((p) => ({
    projectId: p.projectId,
    name: p.name,
    environments: (p.environments ?? []).map((e) => ({
      environmentId: e.environmentId,
      name: e.name,
      resourceNames: names(e),
    })),
  })),
};
log(
  `Dokploy ${probe.version}: ${existing.length} existing projects (${existing.map((p) => p.name).join(", ")})`,
);

// ---- 3. plan ----
const only = opt("only")
  ?.split(",")
  .map((s) => s.trim().toLowerCase());
const projects = ir.projects.filter(
  (p) => !only || only.includes(p.name.toLowerCase()),
);
const ids = projects.flatMap((p) =>
  p.environments.flatMap((e) => e.resources.map((r) => r.srcId)),
);
const options = core.defaultOptions(ids);
if (opt("marker")) options.target.collisionMarker = opt("marker");
if (flag("adopt")) options.target.collisionPolicy = "adopt";
if (flag("skip-collisions")) options.target.collisionPolicy = "skip";
if (opt("secrets")) options.secrets.defaultMode = opt("secrets");
const plan = core.buildPlan({ ...ir, projects }, options, snapshot);
const problems = core.validatePlan(plan);
if (problems.length) throw new Error(`Invalid plan: ${problems.join("; ")}`);
log(`\nPlan: ${plan.steps.length} steps`);
for (const s of plan.steps) {
  if (
    [
      "CREATE_PROJECT",
      "CREATE_APPLICATION",
      "CREATE_COMPOSE",
      "CREATE_DATABASE",
    ].includes(s.kind)
  ) {
    log(
      `  ${String(s.seq).padStart(3)} ${s.kind.padEnd(19)} ${s.payload.name}${s.payload.renamedFrom ? `   (was "${s.payload.renamedFrom}")` : ""}`,
    );
  }
  for (const w of s.warnings.filter(
    (w) => !/^Volume created empty|^Definition only/.test(w),
  ))
    log(`        ! ${w}`);
}
for (const n of plan.notes ?? []) log(`  note: ${n}`);

if (!flag("apply")) {
  log(
    "\nDry run only (no writes). Re-run with --apply to create these in Dokploy.",
  );
  process.exit(0);
}

// ---- 4. apply ----
const entries = new Map();
const idMap = {
  async get(_r, srcId, kind) {
    return entries.get(`${srcId}\u0000${kind}`);
  },
  async put(_r, srcId, kind, targetId, created) {
    entries.set(`${srcId}\u0000${kind}`, {
      srcId,
      srcKind: kind,
      targetId,
      created,
    });
  },
};
const ctx = { runId: "e2e", dokploy, vault, idMap, options };
const started = Date.now();
const outcome = await core.runPlan(plan, ctx, {
  hooks: {
    onUpdate: (step, rec) => {
      if (rec.state === "failed")
        log(
          `  FAILED step ${step.seq} ${step.kind}: ${rec.error.code} ${rec.error.message}`,
        );
    },
  },
});
writeFileSync(
  stateFile,
  JSON.stringify({ entries: [...entries.values()] }, null, 2),
);
const counts = {};
for (const r of outcome.records.values())
  counts[r.state] = (counts[r.state] ?? 0) + 1;
log(
  `\nApply ${outcome.status} in ${((Date.now() - started) / 1000).toFixed(1)}s  ${JSON.stringify(counts)}`,
);
for (const r of outcome.records.values())
  for (const w of r.warnings ?? []) log(`  warn: ${w}`);
if (outcome.status !== "completed") process.exit(1);

// ---- 5. verify (read back) ----
log("\nVerify (read back from Dokploy):");
let bad = 0;
const check = (label, ok, detail = "") => {
  if (!ok) bad++;
  log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
};
for (const project of projects)
  for (const env of project.environments)
    for (const r of env.resources) {
      if (!ids.includes(r.srcId)) continue;
      const planned = plan.steps.find(
        (s) =>
          s.srcId === r.srcId &&
          /^CREATE_(APPLICATION|COMPOSE|DATABASE)$/.test(s.kind),
      );
      if (!planned) continue;
      const target = (await idMap.get("e2e", r.srcId, r.kind))?.targetId;
      if (!target) {
        check(`${r.name}: created`, false);
        continue;
      }
      if (r.kind === "application") {
        const a = await dokploy.applicationOne(target);
        const wantKeys = new Set(
          plan.steps
            .find((s) => s.srcId === r.srcId && s.kind === "SET_ENV")
            ?.payload.env?.map((v) => v.key) ?? [],
        );
        const haveKeys = new Set(
          [
            ...String(a.env ?? "").split("\n"),
            ...String(a.buildArgs ?? "").split("\n"),
          ]
            .map((l) => l.split("=")[0])
            .filter(Boolean),
        );
        const missing = [...wantKeys].filter((k) => !haveKeys.has(k));
        check(
          `${planned.payload.name}: application source/build`,
          r.source.type === "image"
            ? a.sourceType === "docker"
            : a.sourceType === "git" || a.sourceType === "github",
          `${a.sourceType}/${a.buildType}`,
        );
        check(
          `${planned.payload.name}: env keys`,
          missing.length === 0,
          `${wantKeys.size} planned, ${missing.length} missing`,
        );
        check(
          `${planned.payload.name}: domains/mounts`,
          (a.domains?.length ?? 0) === r.domains.length &&
            (a.mounts?.length ?? 0) === r.mounts.length,
          `${a.domains?.length ?? 0}/${r.domains.length} domains, ${a.mounts?.length ?? 0}/${r.mounts.length} mounts`,
        );
      } else if (r.kind === "compose") {
        const c = await dokploy.composeOne(target);
        check(
          `${planned.payload.name}: compose`,
          c.sourceType === (r.source ? "git" : "raw") &&
            (r.source || String(c.composeFile).length > 0),
          `${c.sourceType}, ${c.domains?.length ?? 0}/${r.domains.length} domains`,
        );
      } else if (r.engine !== "other") {
        const [engine, id] = target.split(":");
        const proj = await dokploy.projectOne(
          (await idMap.get("e2e", project.srcId, "project")).targetId,
        );
        const found = proj.environments
          .flatMap((e) => e[engine] ?? [])
          .some((d) => d[`${engine}Id`] === id);
        check(`${planned.payload.name}: ${engine} exists`, found);
      }
    }
log(
  bad === 0
    ? "\nAll checks passed. Nothing was deployed. Inspect in Dokploy, then: node scripts/e2e-lab.mjs --rollback"
    : `\n${bad} check(s) failed`,
);
process.exit(bad === 0 ? 0 : 1);
