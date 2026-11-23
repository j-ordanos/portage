import type { IR } from "../ir/schema.js";
import type { Plan } from "../plan/types.js";
import {
  databaseMigrationSnippets,
  volumeMigrationSnippets,
} from "../resources/data.js";
import type { VerifyCheck } from "../verify/verify.js";

export interface ReportStepRecord {
  seq: number;
  state: string;
  targetId?: string;
  note?: string;
  warnings?: string[];
}

export interface MigrationReportInput {
  ir: IR;
  plan: Plan;
  records: ReportStepRecord[];
  verify?: VerifyCheck[];
  target: { url: string; version?: string };
  generatedAt: string;
}

/**
 * The to-do list a person follows after the tool is done. Contains key NAMES, hosts and ids only:
 * never a secret value (a test scans the output for canaries).
 */
export function renderMigrationReport(input: MigrationReportInput): string {
  const { ir, plan, records, verify } = input;
  const recordBySeq = new Map(records.map((r) => [r.seq, r]));
  const created = plan.steps.filter((s) =>
    [
      "CREATE_PROJECT",
      "CREATE_APPLICATION",
      "CREATE_COMPOSE",
      "CREATE_DATABASE",
    ].includes(s.kind),
  );
  const done = (seq: number) => recordBySeq.get(seq)?.state === "done";
  const resources = new Map(
    ir.projects.flatMap((p) =>
      p.environments.flatMap((e) =>
        e.resources.map((r) => [r.srcId, { r, project: p.name }] as const),
      ),
    ),
  );
  const out: string[] = [];
  const h = (text: string) => out.push("", text, "");

  out.push("# Coolify → Dokploy migration report", "");
  out.push(`Generated ${input.generatedAt}`, "");
  out.push(`- Source: Coolify ${ir.source.version} (${ir.source.url})`);
  out.push(
    `- Target: Dokploy ${input.target.version ?? "?"} (${input.target.url})`,
  );
  out.push(
    "- **Nothing was deployed.** Resources were created and configured only; review them in Dokploy, then deploy.",
  );

  h("## Created in Dokploy");
  out.push("| Kind | Name | Source id |", "|---|---|---|");
  for (const step of created) {
    if (!done(step.seq)) continue;
    const kind = step.kind.replace("CREATE_", "").toLowerCase();
    const renamed = step.payload.renamedFrom
      ? ` (was \`${String(step.payload.renamedFrom)}\`)`
      : "";
    out.push(
      `| ${kind} | ${String(step.payload.name)}${renamed} | \`${step.srcId}\` |`,
    );
  }
  const notDone = created.filter((s) => !done(s.seq));
  if (notDone.length) {
    out.push(
      "",
      `**Not created (${notDone.length}):** ${notDone.map((s) => String(s.payload.name)).join(", ")}`,
    );
  }

  if (verify?.length) {
    const failed = verify.filter((c) => c.status === "fail");
    h("## Verification");
    out.push(
      failed.length === 0
        ? `All ${verify.length} read-back checks passed.`
        : `${failed.length} of ${verify.length} checks failed:`,
    );
    for (const c of failed)
      out.push(
        `- ❌ ${c.resource}: ${c.check}${c.detail ? ` (${c.detail})` : ""}`,
      );
  }

  const todo: string[] = [];
  // git relink
  for (const step of plan.steps.filter(
    (s) => s.kind === "CONFIGURE_SOURCE" && done(s.seq),
  )) {
    const src = step.payload.source as
      | { type?: string; provider?: string; repo?: string }
      | undefined;
    if (src?.type === "git" && src.provider && src.provider !== "public") {
      todo.push(
        `- [ ] **Relink Git access** for \`${resources.get(step.srcId)?.r.name ?? step.srcId}\` (\`${src.repo}\`, ${src.provider}). Dokploy cannot read this private repository until you connect a Git provider or SSH key.`,
      );
    }
  }
  // generated credentials
  for (const rec of records) {
    for (const w of rec.warnings ?? []) {
      if (/password generated/.test(w)) {
        const step = plan.steps.find((s) => s.seq === rec.seq);
        todo.push(
          `- [ ] **New database password** was generated for \`${String(step?.payload.name ?? step?.srcId)}\` (source password unreadable). Update every app that connects to it.`,
        );
      }
    }
  }
  // unreadable secrets
  for (const { r } of resources.values()) {
    if (r.kind === "database") continue;
    const missing = r.env
      .filter((v) => !v.isPreview && v.availability !== "available")
      .map((v) => v.key);
    if (missing.length)
      todo.push(
        `- [ ] **Enter values** for \`${r.name}\`: ${missing.map((k) => `\`${k}\``).join(", ")} (Coolify did not expose them).`,
      );
  }
  // magic variables
  for (const step of plan.steps.filter((s) => s.kind === "CREATE_COMPOSE")) {
    const vars = (step.payload.needsValue as string[] | undefined) ?? [];
    if (vars.length)
      todo.push(
        `- [ ] **Set values** for Coolify magic variables in \`${String(step.payload.name)}\`: ${vars.map((v) => `\`${v}\``).join(", ")}.`,
      );
  }
  // build commands / manual
  for (const step of plan.steps) {
    for (const w of step.warnings) {
      if (/cannot be mapped|not valid hostname/i.test(w))
        todo.push(`- [ ] ${String(step.label)}: ${w}`);
    }
  }
  for (const note of (plan as { notes?: string[] }).notes ?? [])
    todo.push(`- [ ] ${note}`);
  if (todo.length) {
    h("## Manual to-do");
    out.push(...todo);
  }

  const dbs = created.filter(
    (s) => s.kind === "CREATE_DATABASE" && done(s.seq),
  );
  const volumes = plan.steps.filter(
    (s) =>
      s.kind === "CREATE_MOUNT" && s.payload.type === "volume" && done(s.seq),
  );
  if (dbs.length || volumes.length) {
    h("## Data (not copied by this tool)");
    out.push("Placeholders only; fill in hosts and credentials yourself.");
    for (const step of dbs) {
      const snip = databaseMigrationSnippets(step.payload.engine as never);
      out.push(
        "",
        `### ${String(step.payload.name)} (${String(step.payload.engine)})`,
        "```bash",
        snip.dump,
        snip.restore,
        "```",
      );
    }
    for (const step of volumes) {
      const snip = volumeMigrationSnippets();
      out.push(
        "",
        `### Volume \`${String(step.payload.volumeName)}\``,
        "```bash",
        snip.dump,
        snip.restore,
        "```",
      );
    }
  }

  const domainSteps = plan.steps.filter(
    (s) => s.kind === "CREATE_DOMAIN" && done(s.seq),
  );
  if (domainSteps.length) {
    h("## Domains / DNS");
    out.push("| Host | Resource | Port |", "|---|---|---|");
    for (const step of domainSteps) {
      out.push(
        `| ${String(step.payload.host)} | ${resources.get(step.srcId)?.r.name ?? step.srcId} | ${String(step.payload.port ?? "")} |`,
      );
    }
    out.push(
      "",
      "Point DNS at the Dokploy server only at cutover. Lower the TTL at least 24 h before.",
    );
  }

  h("## Cutover checklist");
  out.push(
    "- [ ] Back up every database and volume on the source, off-server",
    "- [ ] Relink Git providers / registries / SSH keys on migrated apps",
    "- [ ] Restore database dumps and volume archives on the target",
    "- [ ] Deploy on temporary domains; run smoke tests (watch for cron jobs/webhooks running twice)",
    "- [ ] Freeze writes on the source, do a final data sync",
    "- [ ] Switch DNS to Dokploy; verify TLS, background jobs, integrations",
    "- [ ] Keep the source running for several days; **do not delete it**",
    "- [ ] **Revoke** the temporary Coolify token and the Dokploy API key used for this migration",
  );
  return `${out.join("\n")}\n`;
}
