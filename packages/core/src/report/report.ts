import type { IR, IRResource } from "../ir/schema.js";
import type { Plan } from "../plan/types.js";

export interface ManifestResult {
  seq: number;
  kind: string;
  state: string;
  srcId: string;
  targetId?: string;
}

export function renderManifest(
  ir: IR,
  plan: Plan,
  results: ManifestResult[],
  run: {
    id: string;
    createdAt: string;
    targetUrl: string;
    targetVersion?: string;
  },
): string {
  return JSON.stringify(
    {
      manifestVersion: 1,
      tool: { name: "coolify-dokploy-migrator", version: "0.1.0" },
      run: {
        id: run.id,
        createdAt: run.createdAt,
        source: ir.source,
        target: { url: run.targetUrl, version: run.targetVersion },
      },
      ir: {
        irVersion: ir.irVersion,
        source: ir.source,
        teamSharedEnv: ir.teamSharedEnv.map((variable) => ({
          key: variable.key,
          availability: variable.availability,
        })),
        projects: ir.projects.map((project) => ({
          srcId: project.srcId,
          name: project.name,
          environments: project.environments.map((environment) => ({
            srcId: environment.srcId,
            name: environment.name,
            resources: environment.resources.map((resource) => ({
              srcId: resource.srcId,
              name: resource.name,
              kind: resource.kind,
              compat: resource.compat,
              issues: resource.issues,
            })),
          })),
        })),
      },
      plan,
      results,
      manualItems: ir.projects.flatMap((project) =>
        project.environments.flatMap((environment) =>
          environment.resources.flatMap((resource) =>
            resource.issues
              .filter((issue) => issue.severity !== "info")
              .map((issue) => ({
                type: "compatibility",
                resource: resource.name,
                detail: `${issue.ruleId}: ${issue.message}`,
              })),
          ),
        ),
      ),
    },
    null,
    2,
  );
}

export function renderCompatJson(ir: IR): string {
  return JSON.stringify(
    {
      irVersion: ir.irVersion,
      source: ir.source,
      resources: ir.projects.flatMap((project) =>
        project.environments.flatMap((environment) =>
          environment.resources.map((resource) => ({
            srcId: resource.srcId,
            name: resource.name,
            kind: resource.kind,
            compat: resource.compat,
            issues: resource.issues,
          })),
        ),
      ),
    },
    null,
    2,
  );
}

export function renderCompatMarkdown(ir: IR): string {
  const resources = ir.projects.flatMap((project) =>
    project.environments.flatMap((environment) =>
      environment.resources.map((resource): [string, IRResource] => [
        project.name,
        resource,
      ]),
    ),
  );
  const lines = [
    "# Compatibility report",
    "",
    "| Project | Resource | Kind | Compat | Issues |",
    "|---|---|---|---|---|",
  ];
  for (const [project, resource] of resources) {
    lines.push(
      `| ${project} | ${resource.name} | ${resource.kind} | ${resource.compat} | ${resource.issues.length} |`,
    );
  }
  for (const [project, resource] of resources) {
    if (!resource.issues.length) continue;
    lines.push("", `## ${project} — ${resource.name}`);
    for (const issue of resource.issues) {
      lines.push(
        `- **${issue.ruleId}** ${issue.message}${issue.fix ? ` — Fix: ${issue.fix}` : ""}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
