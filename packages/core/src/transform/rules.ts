import type {
  IR,
  IRApplication,
  IRCompose,
  IRDatabase,
  IRResource,
  Issue,
} from "../ir/schema.js";

export interface RuleContext {
  targetDomains?: string[];
  supportedBuildTypes?: string[];
  existingNames?: string[];
  existingDomains?: string[];
  dokployVersion?: string;
  coolifyVersion?: string;
  sensitiveRead?: boolean;
}

export interface TransformedResource {
  resource: IRResource;
  issues: Issue[];
}

function worstCompat(issues: Issue[]): "auto" | "partial" | "manual" {
  if (issues.some((issue) => issue.severity === "error")) return "manual";
  if (issues.some((issue) => issue.ruleId.startsWith("R-"))) return "partial";
  return "auto";
}

function applicationIssues(resource: IRApplication, ctx: RuleContext): Issue[] {
  const issues: Issue[] = [];
  if (resource.build.pack === "static") {
    issues.push({
      ruleId: "R-011",
      severity: "warn",
      message: "Verify static/SPA fallback settings",
      fix: "Review Dokploy static publish and fallback configuration.",
    });
  }
  if (resource.build.pack === "railpack") {
    if (!ctx.supportedBuildTypes?.includes("railpack")) {
      issues.push({
        ruleId: "R-012",
        severity: "warn",
        message: "Railpack is not confirmed by the target",
        fix: "Mapped to nixpacks; verify build behavior.",
      });
    }
  }
  if (resource.build.pack === "other") {
    issues.push({
      ruleId: "R-013",
      severity: "error",
      message: `Cannot map build pack '${resource.build.rawPack}'`,
      fix: "Configure the build type manually.",
    });
  }
  if (resource.source.type === "git" && resource.source.provider !== "public") {
    issues.push({
      ruleId: "R-020",
      severity: "warn",
      message: "Git credentials are not migrated",
      fix: "Relink the Git provider in Dokploy.",
    });
  }
  for (const variable of resource.env) {
    if (variable.availability !== "available") {
      issues.push({
        ruleId: "R-030",
        severity: "warn",
        message: `Value unavailable for ${variable.key}`,
        fix: "Enter the value in the Secrets step.",
        path: `env.${variable.key}`,
      });
    }
    if (variable.refs.some((ref) => ref.startsWith("team."))) {
      issues.push({
        ruleId: "R-032",
        severity: "warn",
        message: "Dokploy has no team-level variables",
        fix: "Inline the team value or add a manual follow-up.",
        path: `env.${variable.key}`,
      });
    }
    if (variable.refs.length === 0) continue;
    if (variable.refs.some((ref) => ref.includes("unknown"))) {
      issues.push({
        ruleId: "R-033",
        severity: "error",
        message: "An environment reference is unresolved",
        fix: "Resolve or remove the unknown shared-variable reference.",
        path: `env.${variable.key}`,
      });
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.key)) {
      issues.push({
        ruleId: "R-034",
        severity: "warn",
        message: `Environment key '${variable.key}' is invalid for target`,
        fix: "Rename or skip this variable.",
      });
    }
  }
  if (resource.mounts.length > 0) {
    issues.push({
      ruleId: "R-050",
      severity: "warn",
      message: "Persistent storage definition is copied only",
      fix: "Copy data separately and verify the target mount.",
    });
  }
  return issues;
}

function composeIssues(resource: IRCompose): Issue[] {
  const issues: Issue[] = [];
  if (resource.isTemplateService) {
    issues.push({
      ruleId: "R-073",
      severity: "warn",
      message: "One-click template settings require re-entry",
      fix: "Prefer Dokploy's equivalent template or configure it manually.",
    });
  }
  if (/SERVICE_(?:FQDN|URL|PASSWORD|USER|BASE64)/.test(resource.composeRaw)) {
    issues.push({
      ruleId: "R-070",
      severity: "warn",
      message: "Compose uses Coolify magic variables",
      fix: "Supply target values for each detected variable.",
    });
  }
  return issues;
}

function databaseIssues(resource: IRDatabase): Issue[] {
  const issues: Issue[] = [
    {
      ruleId: "R-060",
      severity: "warn",
      message: "Database definition is copied; data is not",
      fix: "Create and restore a database backup separately.",
    },
  ];
  if (resource.passwordAvailability !== "available") {
    issues.push({
      ruleId: "R-061",
      severity: "warn",
      message: "Database password is unavailable",
      fix: "Set a new password and update dependent applications.",
    });
  }
  if (resource.publiclyExposed) {
    issues.push({
      ruleId: "R-062",
      severity: "warn",
      message: "Public database exposure is not migrated by default",
      fix: "Expose the target database explicitly only if required.",
    });
  }
  if (resource.engine === "other") {
    issues.push({
      ruleId: "R-063",
      severity: "error",
      message: "Database engine is unsupported",
      fix: "Create it manually on the target.",
    });
  }
  return issues;
}

export function runRules(ir: IR, ctx: RuleContext = {}): IR {
  const transformed = {
    ...ir,
    projects: ir.projects.map((project) => ({
      ...project,
      environments: project.environments.map((environment) => ({
        ...environment,
        resources: environment.resources.map((resource): IRResource => {
          let issues: Issue[] = [...resource.issues];
          if (ctx.sensitiveRead === false) {
            issues.push({
              ruleId: "R-002",
              severity: "warn",
              message: "Secret values unavailable",
              fix: "Create a token with sensitive-read access.",
            });
          }
          if (resource.kind === "application") {
            issues = [...issues, ...applicationIssues(resource, ctx)];
          } else if (resource.kind === "compose") {
            issues = [...issues, ...composeIssues(resource)];
          } else {
            issues = [...issues, ...databaseIssues(resource)];
          }
          const unique = issues.filter(
            (issue, index, all) =>
              all.findIndex(
                (candidate) => candidate.ruleId === issue.ruleId,
              ) === index,
          );
          return {
            ...resource,
            issues: unique,
            compat: worstCompat(unique),
          } as IRResource;
        }),
      })),
    })),
  };
  return transformed;
}
