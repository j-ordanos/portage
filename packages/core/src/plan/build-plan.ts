import { parse as parseYaml } from "yaml";
import type {
  IR,
  IRApplication,
  IRCompose,
  IRDatabase,
  IRProject,
  IRResource,
} from "../ir/schema.js";
import { analyzeCompose } from "../transform/compose.js";
import {
  mapDomains,
  parseDomain,
  validDomainHost,
} from "../transform/domains.js";
import {
  type Options,
  type Plan,
  Plan as PlanSchema,
  type Step,
} from "./types.js";

export interface TargetProject {
  projectId: string;
  name: string;
  environments: Array<{
    environmentId: string;
    name: string;
    /** Names of apps/compose/databases already in the environment (collision check when adopting). */
    resourceNames: string[];
  }>;
}

/** Read-only picture of the Dokploy target, gathered before planning. */
export interface TargetSnapshot {
  projects?: TargetProject[];
  /** Existing domain hosts (lowercase) for conflict warnings. */
  domains?: string[];
  serverIds?: string[];
}

/** Marker written to every resource we create; lets crash recovery prove a resource is ours. */
export function migrationMarker(srcId: string): string {
  return `Migrated from Coolify (${srcId})`;
}

export function appName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 40);
  return slug || "resource";
}

const lower = (value: string) => value.toLowerCase();

/** `name`, or `name*` (then `name**`, …) until it no longer collides with `taken` (case-insensitive). */
function uniqueName(name: string, taken: string[], marker: string): string {
  const used = new Set(taken.map(lower));
  let candidate = name;
  while (used.has(lower(candidate))) candidate += marker;
  return candidate;
}

function composePort(composeRaw: string, service: string): number | undefined {
  try {
    const doc = parseYaml(composeRaw) as {
      services?: Record<string, { expose?: unknown[]; ports?: unknown[] }>;
    };
    const svc = doc?.services?.[service];
    const expose = svc?.expose?.[0];
    if (expose !== undefined && Number.isInteger(Number(expose))) {
      return Number(expose);
    }
    const first = svc?.ports?.[0];
    if (typeof first === "string") {
      const container = first.split(":").pop()?.split("/")[0];
      if (container && Number.isInteger(Number(container)))
        return Number(container);
    }
    if (first && typeof first === "object" && "target" in first) {
      return Number((first as { target: unknown }).target) || undefined;
    }
  } catch {
    // invalid YAML is reported by the compose rules
  }
  return undefined;
}

interface Ctx {
  options: Options;
  snapshot: TargetSnapshot;
  steps: Step[];
  notes: string[];
}

interface NewStep {
  kind: Step["kind"];
  intent: Step["intent"];
  srcId: string;
  dependsOn: number[];
  label: string;
  payload: Record<string, unknown>;
  vaultRefs: string[];
  warnings: string[];
}

function add(ctx: Ctx, step: NewStep): number {
  const seq = ctx.steps.length + 1;
  ctx.steps.push({ ...step, seq });
  return seq;
}

function envPayload(resource: IRApplication | IRCompose) {
  return resource.env
    .filter((variable) => !variable.isPreview)
    .map((variable) => ({
      key: variable.key,
      valueRef: variable.valueRef,
      availability: variable.availability,
      scope: variable.scope,
      isPreview: variable.isPreview,
      isMultiline: variable.isMultiline,
      isLiteral: variable.isLiteral,
      isSecretGuess: variable.isSecretGuess,
      refs: variable.refs,
    }));
}

function warningsOf(resource: IRResource): string[] {
  return resource.issues
    .filter((issue) => issue.severity !== "info")
    .map((issue) => `${issue.ruleId}: ${issue.message}`);
}

/** Tool-native build commands carried over as env vars (Dokploy has no dedicated fields). */
function buildCommandEnv(app: IRApplication): Record<string, string> {
  const prefix =
    app.build.pack === "nixpacks"
      ? "NIXPACKS"
      : app.build.pack === "railpack"
        ? "RAILPACK"
        : undefined;
  if (!prefix) return {};
  return {
    ...(app.build.installCmd
      ? { [`${prefix}_INSTALL_CMD`]: app.build.installCmd }
      : {}),
    ...(app.build.buildCmd
      ? { [`${prefix}_BUILD_CMD`]: app.build.buildCmd }
      : {}),
    ...(app.build.startCmd
      ? { [`${prefix}_START_CMD`]: app.build.startCmd }
      : {}),
  };
}

function domainSteps(
  ctx: Ctx,
  resource: IRApplication | IRCompose,
  parent: number,
  kind: "application" | "compose",
): void {
  const parsed = (
    resource.domains as Array<{
      host: string;
      https: boolean;
      port?: number;
      path?: string;
      source: string;
      service?: string;
    }>
  ).map((d) => ({
    ...parseDomain(d.source),
    ...(d.port ? { port: d.port } : {}),
    host: d.host,
    https: d.https,
    ...(d.path ? { path: d.path } : {}),
    source: d.source,
    service: d.service,
  }));
  const mapped = mapDomains(
    parsed,
    ctx.options.domains.policy,
    ctx.options.domains.tempBase,
    ctx.options.domains.map,
  );
  mapped.forEach((domain, index) => {
    const original = parsed[index];
    const service = original?.service;
    const warnings: string[] = [];
    if (!validDomainHost(domain.host)) {
      warnings.push(
        `Host '${domain.host}' is not a valid hostname; domain skipped`,
      );
      ctx.notes.push(
        `${resource.name}: invalid domain '${domain.host}' needs manual setup`,
      );
      return;
    }
    if (ctx.snapshot.domains?.includes(lower(domain.host))) {
      warnings.push(`CONFLICT: ${domain.host} already exists in Dokploy`);
    }
    if (
      ctx.options.domains.policy !== "keep-original" &&
      original &&
      domain.host === original.host
    ) {
      warnings.push(
        "No temporary domain base set; the original domain is kept",
      );
    } else if (ctx.options.domains.policy === "keep-original") {
      warnings.push(
        "Original domain kept: it will serve traffic only after DNS points here",
      );
    }
    const port =
      domain.port ??
      (resource.kind === "compose" && service
        ? composePort(resource.composeRaw, service)
        : undefined) ??
      (resource.kind === "application" ? resource.ports[0] : undefined) ??
      (kind === "compose" ? 80 : 3000);
    add(ctx, {
      kind: "CREATE_DOMAIN",
      intent: "create",
      srcId: resource.srcId,
      dependsOn: [parent],
      label: `Create domain ${domain.host}`,
      payload: {
        itemKey: `${domain.host}${domain.path ?? ""}`,
        resourceKind: kind,
        host: domain.host,
        https: domain.https,
        port,
        ...(domain.path ? { path: domain.path } : {}),
        ...(service ? { serviceName: service } : {}),
      },
      vaultRefs: [],
      warnings,
    });
  });
}

function planApplication(
  ctx: Ctx,
  resource: IRApplication,
  envKey: string,
  projectSrcId: string,
  name: string,
  parents: number[],
): void {
  const create = add(ctx, {
    kind: "CREATE_APPLICATION",
    intent: "create",
    srcId: resource.srcId,
    dependsOn: parents,
    label: `Create application ${name}`,
    payload: {
      name,
      appName: appName(name),
      projectSrcId,
      environmentKey: envKey,
    },
    vaultRefs: [],
    warnings: warningsOf(resource),
  });
  const gitProvider =
    resource.source.type === "git" ? resource.source.provider : undefined;
  const source = add(ctx, {
    kind: "CONFIGURE_SOURCE",
    intent: "create",
    srcId: resource.srcId,
    dependsOn: [create],
    label: `Configure ${resource.source.type === "git" ? "git" : "image"} source for ${name}`,
    payload: {
      target: "application",
      source: resource.source,
      baseDir: resource.build.baseDir,
    },
    vaultRefs: [],
    warnings:
      gitProvider && gitProvider !== "public"
        ? [
            "Private repository: relink the Git provider/SSH key in Dokploy before deploying",
          ]
        : [],
  });
  const build = add(ctx, {
    kind: "CONFIGURE_BUILD",
    intent: "create",
    srcId: resource.srcId,
    dependsOn: [source],
    label: `Configure build for ${name}`,
    payload: { build: resource.build },
    vaultRefs: [],
    warnings:
      resource.build.pack === "other"
        ? [
            `Build pack '${resource.build.rawPack}' cannot be mapped; set it manually`,
          ]
        : [],
  });
  const extra = buildCommandEnv(resource);
  if (resource.env.length > 0 || Object.keys(extra).length > 0) {
    add(ctx, {
      kind: "SET_ENV",
      intent: "create",
      srcId: resource.srcId,
      dependsOn: [build],
      label: `Set environment for ${name}`,
      payload: {
        target: "application",
        env: envPayload(resource),
        extra,
        splitBuildArgs: resource.build.pack === "dockerfile",
      },
      vaultRefs: resource.env
        .map((variable) => variable.valueRef)
        .filter((ref): ref is string => ref !== null),
      warnings: [],
    });
  }
  const slug = appName(name);
  resource.mounts.forEach((mount, index) => {
    const baseName = mount.name ?? `data${index + 1}`;
    add(ctx, {
      kind: "CREATE_MOUNT",
      intent: "create",
      srcId: resource.srcId,
      dependsOn: [create],
      label: `Create mount ${mount.mountPath}`,
      payload: {
        itemKey: mount.mountPath,
        type: mount.type,
        mountPath: mount.mountPath,
        serviceType: "application",
        ...(mount.hostPath ? { hostPath: mount.hostPath } : {}),
        // Docker volume names are global on the host; prefix with the app so two apps never share "data".
        ...(mount.type === "volume"
          ? { volumeName: `${slug}-${baseName}` }
          : {}),
        ...(mount.type === "file"
          ? { filePath: mount.mountPath.split("/").pop() ?? "file" }
          : {}),
      },
      vaultRefs: mount.contentRef ? [mount.contentRef] : [],
      warnings:
        mount.type === "bind"
          ? ["Bind mount host path may not exist on the target server"]
          : mount.type === "volume"
            ? ["Volume created empty; data is not copied by this tool"]
            : [],
    });
  });
  domainSteps(ctx, resource, create, "application");
}

function planCompose(
  ctx: Ctx,
  resource: IRCompose,
  envKey: string,
  projectSrcId: string,
  name: string,
  parents: number[],
): void {
  const git = resource.source?.type === "git" ? resource.source : undefined;
  const analysis = git ? undefined : analyzeCompose(resource.composeRaw);
  const create = add(ctx, {
    kind: "CREATE_COMPOSE",
    intent: "create",
    srcId: resource.srcId,
    dependsOn: parents,
    label: `Create compose ${name}`,
    payload: {
      name,
      appName: appName(name),
      projectSrcId,
      environmentKey: envKey,
      sourceKind: git ? "git" : "raw",
      // Git compose files live in the repo; raw (service) files are cleaned of Coolify labels.
      composeFile: git ? "" : (analysis?.composeFile ?? resource.composeRaw),
      needsValue: analysis?.needsValue ?? [],
      ...(resource.templateName ? { templateName: resource.templateName } : {}),
    },
    vaultRefs: [],
    warnings: [
      ...warningsOf(resource),
      ...(analysis?.needsValue.length
        ? [
            `Compose uses Coolify magic variables: ${analysis.needsValue.join(", ")}`,
          ]
        : []),
    ],
  });
  let last = create;
  if (git) {
    last = add(ctx, {
      kind: "CONFIGURE_SOURCE",
      intent: "create",
      srcId: resource.srcId,
      dependsOn: [create],
      label: `Configure git source for ${name}`,
      payload: {
        target: "compose",
        source: resource.source,
        composePath: resource.composePath,
      },
      vaultRefs: [],
      warnings:
        git.provider !== "public"
          ? [
              "Private repository: relink the Git provider/SSH key in Dokploy before deploying",
            ]
          : [],
    });
  }
  if (resource.env.length > 0) {
    add(ctx, {
      kind: "SET_ENV",
      intent: "create",
      srcId: resource.srcId,
      dependsOn: [last],
      label: `Set environment for ${name}`,
      payload: { target: "compose", env: envPayload(resource), extra: {} },
      vaultRefs: resource.env
        .map((variable) => variable.valueRef)
        .filter((ref): ref is string => ref !== null),
      warnings: [],
    });
  }
  domainSteps(ctx, resource, create, "compose");
}

function planDatabase(
  ctx: Ctx,
  resource: IRDatabase,
  envKey: string,
  projectSrcId: string,
  name: string,
  parents: number[],
): void {
  if (resource.engine === "other") {
    ctx.notes.push(
      `${resource.name}: unsupported database engine, create it manually in Dokploy`,
    );
    return;
  }
  add(ctx, {
    kind: "CREATE_DATABASE",
    intent: "create",
    srcId: resource.srcId,
    dependsOn: parents,
    label: `Create ${resource.engine} database ${name}`,
    payload: {
      name,
      appName: appName(name),
      projectSrcId,
      environmentKey: envKey,
      engine: resource.engine,
      image: resource.image,
      ...(resource.dbName ? { databaseName: resource.dbName } : {}),
      ...(resource.dbUser ? { databaseUser: resource.dbUser } : {}),
      passwordRef: resource.passwordRef,
      rootPasswordRef: resource.rootPasswordRef ?? null,
    },
    vaultRefs: [resource.passwordRef, resource.rootPasswordRef ?? null].filter(
      (ref): ref is string => ref !== null,
    ),
    warnings: [
      "Definition only: restore the data separately (see data helper)",
      ...(resource.passwordRef === null
        ? [
            "Source password was unreadable; a new password is generated and must be updated in dependents",
          ]
        : []),
      ...(resource.publiclyExposed ? ["Public port is not migrated"] : []),
    ],
  });
}

const kindRank = { database: 0, compose: 1, application: 2 } as const;

function isSelected(resource: IRResource, options: Options): boolean {
  if (!options.selection.includeSrcIds.includes(resource.srcId)) return false;
  const decision = options.selection.decisions[resource.srcId];
  if (decision === "skip") return false;
  if (resource.issues.some((issue) => issue.severity === "error")) {
    return decision === "acknowledge-manual";
  }
  return true;
}

export function buildPlan(
  ir: IR,
  options: Options,
  snapshot: TargetSnapshot = {},
): Plan {
  const ctx: Ctx = { options, snapshot, steps: [], notes: [] };
  const marker = options.target.collisionMarker;
  const targetProjects = snapshot.projects ?? [];

  for (const project of ir.projects as IRProject[]) {
    const selectedEnvs = project.environments
      .map((environment) => ({
        environment,
        resources: environment.resources.filter((r) => isSelected(r, options)),
      }))
      .filter((entry) => entry.resources.length > 0);
    if (selectedEnvs.length === 0) continue;

    const existing = targetProjects.find(
      (p) => lower(p.name) === lower(project.name),
    );
    let projectName = project.name;
    let intent: "create" | "adopt" = "create";
    if (existing) {
      if (options.target.collisionPolicy === "skip") {
        ctx.notes.push(
          `${project.name}: skipped, a Dokploy project with this name already exists`,
        );
        continue;
      }
      if (options.target.collisionPolicy === "adopt") {
        intent = "adopt";
        projectName = existing.name;
      } else {
        projectName = uniqueName(
          project.name,
          targetProjects.map((p) => p.name),
          marker,
        );
      }
    }

    const projectStep = add(ctx, {
      kind: "CREATE_PROJECT",
      intent,
      srcId: project.srcId,
      dependsOn: [],
      label: `${intent === "adopt" ? "Use existing" : "Create"} project ${projectName}`,
      payload: {
        name: projectName,
        ...(project.description ? { description: project.description } : {}),
        ...(intent === "adopt" && existing
          ? { existingProjectId: existing.projectId }
          : {}),
        ...(projectName !== project.name ? { renamedFrom: project.name } : {}),
      },
      vaultRefs: [],
      warnings:
        projectName !== project.name
          ? [
              `A project named '${project.name}' already exists in Dokploy; the new one is named '${projectName}'`,
            ]
          : [],
    });

    const envSteps = new Map<string, { key: string; step: number }>();
    const flatten = options.target.envStrategy === "flatten";
    for (const { environment, resources } of selectedEnvs) {
      const envName = flatten ? "production" : environment.name;
      const envKey = flatten ? `${project.srcId}:flat` : environment.srcId;
      let envStep = envSteps.get(envKey);
      if (!envStep) {
        const existingEnv = existing?.environments.find(
          (e) => lower(e.name) === lower(envName),
        );
        const step = add(ctx, {
          kind: "ENSURE_ENVIRONMENT",
          intent: "create",
          srcId: envKey,
          dependsOn: [projectStep],
          label: `Ensure environment ${envName}`,
          payload: {
            projectSrcId: project.srcId,
            name: envName,
            ...(intent === "adopt" && existingEnv
              ? { existingEnvironmentId: existingEnv.environmentId }
              : {}),
          },
          vaultRefs: [],
          warnings: [],
        });
        envStep = { key: envKey, step };
        envSteps.set(envKey, envStep);
      }
      const takenNames =
        intent === "adopt"
          ? (existing?.environments.find(
              (e) => lower(e.name) === lower(envName),
            )?.resourceNames ?? [])
          : [];
      const taken = [...takenNames];
      const ordered = [...resources].sort(
        (a, b) =>
          kindRank[a.kind] - kindRank[b.kind] ||
          a.name.localeCompare(b.name) ||
          a.srcId.localeCompare(b.srcId),
      );
      for (const resource of ordered) {
        const name = uniqueName(resource.name, taken, marker);
        taken.push(name);
        const parents = [projectStep, envStep.step];
        if (resource.kind === "application") {
          planApplication(ctx, resource, envKey, project.srcId, name, parents);
        } else if (resource.kind === "compose") {
          planCompose(ctx, resource, envKey, project.srcId, name, parents);
        } else {
          planDatabase(ctx, resource, envKey, project.srcId, name, parents);
        }
      }
    }
  }

  return PlanSchema.parse({
    planVersion: 1,
    createdAt: "1970-01-01T00:00:00.000Z",
    steps: ctx.steps,
    notes: ctx.notes,
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
      if (!seqs.has(dependency)) {
        errors.push(`Missing dependency ${dependency} for step ${step.seq}`);
      } else if (dependency >= step.seq) {
        errors.push(`Step ${step.seq} depends on later step ${dependency}`);
      }
    }
  }
  return errors;
}
