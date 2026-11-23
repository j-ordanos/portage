import { parse as parseDotenv } from "dotenv";
import { splitDatabaseTarget } from "../apply/executor.js";
import type { DokployClient } from "../clients/dokploy.js";
import type { Plan, Step } from "../plan/types.js";

export interface VerifyCheck {
  resource: string;
  srcId: string;
  check: string;
  status: "pass" | "fail" | "warn";
  /** Keys, hosts and counts only: never values. */
  detail?: string;
}

export interface IdEntry {
  srcId: string;
  srcKind: string;
  targetId: string;
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : {};
const keysOf = (value: unknown): Set<string> =>
  new Set(Object.keys(parseDotenv(typeof value === "string" ? value : "")));
const lower = (value: unknown) => String(value ?? "").toLowerCase();

/**
 * Read everything back from Dokploy and compare it with the plan. Read-only.
 * Compares key sets, hosts, counts and types; env values are never read into the result.
 */
export async function verifyMigration(
  plan: Plan,
  entries: IdEntry[],
  dokploy: Pick<
    DokployClient,
    "applicationOne" | "composeOne" | "projectOne" | "databaseOne"
  >,
): Promise<VerifyCheck[]> {
  const checks: VerifyCheck[] = [];
  const target = (srcId: string, kind: string) =>
    entries.find((e) => e.srcId === srcId && e.srcKind === kind)?.targetId;
  const stepsOf = (srcId: string, kind: Step["kind"]) =>
    plan.steps.filter((s) => s.srcId === srcId && s.kind === kind);

  const creators = plan.steps.filter((s) =>
    ["CREATE_APPLICATION", "CREATE_COMPOSE", "CREATE_DATABASE"].includes(
      s.kind,
    ),
  );
  for (const step of creators) {
    const name = String(step.payload.name ?? step.srcId);
    const add = (
      check: string,
      status: VerifyCheck["status"],
      detail?: string,
    ) =>
      checks.push({
        resource: name,
        srcId: step.srcId,
        check,
        status,
        ...(detail ? { detail } : {}),
      });
    const kind =
      step.kind === "CREATE_APPLICATION"
        ? "application"
        : step.kind === "CREATE_COMPOSE"
          ? "compose"
          : "database";
    const targetId = target(step.srcId, kind);
    if (!targetId) {
      add("exists", "fail", "not created");
      continue;
    }

    try {
      if (kind === "database") {
        const { engine, id } = splitDatabaseTarget(targetId);
        const projectId = target(String(step.payload.projectSrcId), "project");
        const project = projectId
          ? await dokploy.projectOne(projectId)
          : undefined;
        const row = project?.environments
          ?.flatMap((e) => (rec(e)[engine] as Rec[] | undefined) ?? [])
          .find((d) => d[`${engine}Id`] === id);
        add("exists", row ? "pass" : "fail", engine);
        if (
          row &&
          typeof step.payload.image === "string" &&
          step.payload.image !== "unknown"
        ) {
          // project.one returns trimmed database rows (no image): read the full row.
          const full = await dokploy.databaseOne(engine, id);
          add(
            "image",
            lower(full.dockerImage) === lower(step.payload.image)
              ? "pass"
              : "fail",
            String(full.dockerImage),
          );
        }
        continue;
      }

      const stored =
        kind === "application"
          ? await dokploy.applicationOne(targetId)
          : await dokploy.composeOne(targetId);
      add("exists", "pass");

      // source
      for (const source of stepsOf(step.srcId, "CONFIGURE_SOURCE")) {
        const src = rec(source.payload.source);
        if (src.type === "image") {
          const ok =
            stored.sourceType === "docker" &&
            lower(stored.dockerImage).startsWith(lower(src.image));
          add(
            "source",
            ok ? "pass" : "fail",
            `image ${String(stored.dockerImage ?? "-")}`,
          );
        } else {
          const branch = stored.customGitBranch ?? stored.branch;
          const okType =
            stored.sourceType === "git" || stored.sourceType === "github";
          const okBranch = !src.branch || lower(branch) === lower(src.branch);
          add(
            "source",
            okType && okBranch ? "pass" : "fail",
            `${String(stored.sourceType)} @ ${String(branch ?? "-")}`,
          );
        }
      }
      // build type
      for (const build of stepsOf(step.srcId, "CONFIGURE_BUILD")) {
        const pack = rec(build.payload.build).pack;
        if (
          ["nixpacks", "railpack", "static", "dockerfile"].includes(
            String(pack),
          )
        ) {
          add(
            "build type",
            stored.buildType === pack ? "pass" : "fail",
            String(stored.buildType),
          );
        }
      }
      if (kind === "compose" && step.payload.sourceKind === "raw") {
        add(
          "compose file",
          String(stored.composeFile ?? "").length > 0 ? "pass" : "fail",
        );
      }
      // env keys
      for (const envStep of stepsOf(step.srcId, "SET_ENV")) {
        const planned = [
          ...((envStep.payload.env as Rec[] | undefined) ?? []).map((v) =>
            String(v.key),
          ),
          ...Object.keys(rec(envStep.payload.extra)),
        ];
        const present = new Set([
          ...keysOf(stored.env),
          ...keysOf(stored.buildArgs),
        ]);
        const missing = planned.filter((k) => !present.has(k));
        add(
          "environment keys",
          missing.length === 0 ? "pass" : "fail",
          missing.length
            ? `missing: ${missing.slice(0, 8).join(", ")}`
            : `${planned.length} keys`,
        );
      }
      // domains
      const wantedDomains = stepsOf(step.srcId, "CREATE_DOMAIN");
      if (wantedDomains.length > 0) {
        const have = (Array.isArray(stored.domains) ? stored.domains : []).map(
          rec,
        );
        const missing = wantedDomains
          .map((d) => String(d.payload.host))
          .filter((host) => !have.some((d) => lower(d.host) === lower(host)));
        add(
          "domains",
          missing.length === 0 ? "pass" : "fail",
          missing.length
            ? `missing: ${missing.join(", ")}`
            : `${wantedDomains.length} present`,
        );
      }
      // mounts
      const wantedMounts = stepsOf(step.srcId, "CREATE_MOUNT");
      if (wantedMounts.length > 0) {
        const have = (Array.isArray(stored.mounts) ? stored.mounts : []).map(
          rec,
        );
        const missing = wantedMounts
          .map((m) => String(m.payload.mountPath))
          .filter((path) => !have.some((m) => m.mountPath === path));
        add(
          "mounts",
          missing.length === 0 ? "pass" : "fail",
          missing.length
            ? `missing: ${missing.join(", ")}`
            : `${wantedMounts.length} present`,
        );
      }
    } catch (error) {
      add(
        "read back",
        "fail",
        error instanceof Error ? error.message.slice(0, 120) : "unreadable",
      );
    }
  }
  return checks;
}
