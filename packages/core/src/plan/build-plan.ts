import type { IR, IRProject, IRResource } from "../ir/schema.js";
import {
  type Options,
  type Plan,
  Plan as PlanSchema,
  type Step,
} from "./types.js";

export interface TargetSnapshot {
  projectNames?: string[];
  domainNames?: string[];
  serverIds?: string[];
}

export function appName(name: string, _suffix = "migrated"): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 63) || "resource";
  return slug
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 63);
}

function collisionIntent(
  name: string,
  options: Options,
  snapshot: TargetSnapshot,
): "create" | "adopt" | "skip" {
  if (!snapshot.projectNames?.includes(name)) return "create";
  if (options.target.collisionPolicy === "adopt") return "adopt";
  if (options.target.collisionPolicy === "skip") return "skip";
  return "create";
}

function resourceSteps(
  resource: IRResource,
  project: IRProject,
  projectStep: number,
  envStep: number,
  nextSeq: number,
  options: Options,
): Step[] {
  if (
    !options.selection.includeSrcIds.includes(resource.srcId) ||
    options.selection.decisions[resource.srcId] === "skip"
  ) {
    return [];
  }
  if (resource.issues.some((issue) => issue.severity === "error")) {
    if (options.selection.decisions[resource.srcId] !== "acknowledge-manual") {
      return [];
    }
  }

  const kind =
    resource.kind === "application"
      ? "CREATE_APPLICATION"
      : resource.kind === "compose"
        ? "CREATE_COMPOSE"
        : "CREATE_DATABASE";
  const step: Step = {
    seq: nextSeq,
    kind,
    intent: "create",
    srcId: resource.srcId,
    dependsOn: [projectStep, envStep],
    label:
      resource.kind === "application"
        ? `Create application ${resource.name}`
        : resource.kind === "compose"
          ? `Create compose service ${resource.name}`
          : `Create database ${resource.name}`,
    payload: {
      name: resource.name,
      appName: appName(resource.name, options.target.suffix),
      kind: resource.kind,
      projectSrcId: project.srcId,
      ...(resource.kind === "database"
        ? {
            engine: resource.engine,
            image: resource.image,
            databaseName: resource.dbName,
            databaseUser: resource.dbUser,
          }
        : {}),
      ...(resource.kind === "compose"
        ? {
            composeFile: resource.composeRaw,
            isTemplateService: resource.isTemplateService,
          }
        : {}),
    },
    vaultRefs:
      resource.kind === "database"
        ? resource.passwordRef
          ? [resource.passwordRef]
          : []
        : resource.env
            .map((variable) => variable.valueRef)
            .filter((ref): ref is string => ref !== null),
    warnings: resource.issues.map(
      (issue) => `${issue.ruleId}: ${issue.message}`,
    ),
  };

  let seq = nextSeq + 1;
  const steps: Step[] = [step];
  if (resource.kind === "application") {
    steps.push({
      seq,
      kind: "CONFIGURE_SOURCE",
      intent: "create",
      srcId: resource.srcId,
      dependsOn: [step.seq],
      label: `Configure source for ${resource.name}`,
      payload: { source: resource.source },
      vaultRefs: [],
      warnings:
        resource.source.type === "git" && resource.source.provider !== "public"
          ? ["Git credentials require manual relinking"]
          : [],
    });
    seq++;
    steps.push({
      seq,
      kind: "CONFIGURE_BUILD",
      intent: "create",
      srcId: resource.srcId,
      dependsOn: [step.seq],
      label: `Configure build for ${resource.name}`,
      payload: { build: resource.build },
      vaultRefs: [],
      warnings: [],
    });
    seq++;
    steps.push({
      seq,
      kind: "SET_ENV",
      intent: "create",
      srcId: resource.srcId,
      dependsOn: [step.seq],
      label: `Set environment keys for ${resource.name}`,
      payload: {
        keys: resource.env.map((variable) => variable.key).sort(),
      },
      vaultRefs: resource.env
        .map((variable) => variable.valueRef)
        .filter((ref): ref is string => ref !== null),
      warnings: [],
    });
    seq++;
  }
  for (const mount of resource.mounts) {
    steps.push({
      seq,
      kind: "CREATE_MOUNT",
      intent: "create",
      srcId: resource.srcId,
      dependsOn: [step.seq],
      label: `Create mount ${mount.mountPath}`,
      payload: {
        type: mount.type,
        mountPath: mount.mountPath,
        ...(mount.hostPath ? { hostPath: mount.hostPath } : {}),
        ...(mount.name ? { volumeName: mount.name } : {}),
      },
      vaultRefs: mount.contentRef ? [mount.contentRef] : [],
      warnings:
        mount.type === "bind"
          ? ["Bind mount host path may not exist on the target server"]
          : ["Persistent volume data is not copied by this tool"],
    });
    seq++;
  }
  const domains =
    "domains" in resource && Array.isArray(resource.domains)
      ? (resource.domains as Array<{
          host: string;
          https: boolean;
          port?: number;
          path?: string;
          source: string;
        }>)
      : [];
  for (const domain of domains) {
    steps.push({
      seq,
      kind: "CREATE_DOMAIN",
      intent: "create",
      srcId: resource.srcId,
      dependsOn: [step.seq],
      label: `Create domain ${domain.host}`,
      payload: {
        host:
          options.domains.map[domain.source] ??
          options.domains.map[domain.host] ??
          domain.host,
        https: domain.https,
        port: domain.port,
        path: domain.path,
      },
      vaultRefs: [],
      warnings:
        options.domains.policy === "keep-original"
          ? ["Keeping the original domain may conflict with production DNS"]
          : [],
    });
    seq++;
  }
  return steps;
}

export function buildPlan(
  ir: IR,
  options: Options,
  snapshot: TargetSnapshot = {},
): Plan {
  let seq = 1;
  const steps: Step[] = [];
  for (const project of ir.projects) {
    if (
      !project.environments.some((environment) =>
        environment.resources.some((resource) =>
          options.selection.includeSrcIds.includes(resource.srcId),
        ),
      )
    )
      continue;
    const projectIntent = collisionIntent(project.name, options, snapshot);
    steps.push({
      seq,
      kind: "CREATE_PROJECT",
      intent: projectIntent,
      srcId: project.srcId,
      dependsOn: [],
      label: `${projectIntent === "adopt" ? "Adopt" : "Create"} project ${project.name}`,
      payload: { name: project.name, description: project.description },
      vaultRefs: [],
      warnings:
        projectIntent === "skip"
          ? ["Resource name collision; project skipped"]
          : [],
    });
    const projectStep = seq++;
    for (const environment of project.environments) {
      const selected = environment.resources.some((resource) =>
        options.selection.includeSrcIds.includes(resource.srcId),
      );
      if (!selected) continue;
      steps.push({
        seq,
        kind: "ENSURE_ENVIRONMENT",
        intent: "create",
        srcId: environment.srcId,
        dependsOn: [projectStep],
        label: `Ensure environment ${environment.name}`,
        payload: {
          name: environment.name,
          strategy: options.target.envStrategy,
        },
        vaultRefs: [],
        warnings: [],
      });
      const environmentStep = seq++;
      for (const resource of environment.resources) {
        const resourceStepsForPlan = resourceSteps(
          resource,
          project,
          projectStep,
          environmentStep,
          seq,
          options,
        );
        steps.push(...resourceStepsForPlan);
        seq += resourceStepsForPlan.length;
      }
    }
  }
  return PlanSchema.parse({
    planVersion: 1,
    createdAt: "1970-01-01T00:00:00.000Z",
    steps: steps.map((step, index) => ({ ...step, seq: index + 1 })),
  });
}

export function validatePlan(plan: Plan): string[] {
  const errors: string[] = [];
  const seqs = new Set<number>();
  for (const step of plan.steps) {
    if (seqs.has(step.seq)) errors.push(`Duplicate step sequence ${step.seq}`);
    seqs.add(step.seq);
  }
  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (!seqs.has(dependency))
        errors.push(`Missing dependency ${dependency} for step ${step.seq}`);
    }
  }
  return errors;
}
