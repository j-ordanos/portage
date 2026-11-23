import { randomBytes } from "node:crypto";
import { parse as parseDotenv } from "dotenv";
import type { DokployClient } from "../clients/dokploy.js";
import { AppError } from "../errors.js";
import { migrationMarker } from "../plan/build-plan.js";
import type { Options, Step } from "../plan/types.js";
import type { DatabaseEngine } from "../resources/data.js";
import { buildDokployEnv } from "../transform/env.js";
import type { Vault } from "../vault.js";

export interface IdMapStore {
  get(
    runId: string,
    srcId: string,
    srcKind: string,
  ): Promise<{ targetId: string; created: boolean } | undefined>;
  put(
    runId: string,
    srcId: string,
    srcKind: string,
    targetId: string,
    created: boolean,
  ): Promise<void>;
}

export interface ApplyContext {
  runId: string;
  dokploy: DokployClient;
  vault: Vault;
  idMap: IdMapStore;
  options: Options;
}

export interface StepResult {
  targetId?: string;
  created?: boolean;
  note?: string;
  /** Non-secret warnings produced at execution time (e.g. a generated password). */
  warnings?: string[];
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : {};
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const need = (payload: Rec, key: string): string => {
  const value = str(payload[key]);
  if (!value)
    throw new AppError("INTERNAL", `Step payload is missing '${key}'`);
  return value;
};
const lower = (s: string) => s.toLowerCase();
const stripLeadingSlash = (path: string) => path.replace(/^\/+/, "");

const RESOURCE_KINDS = ["application", "compose", "database"] as const;
const DB_ENGINES: DatabaseEngine[] = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
];

/** Databases store `<engine>:<id>` in the id-map so rollback never has to guess the engine. */
export function splitDatabaseTarget(targetId: string): {
  engine: DatabaseEngine;
  id: string;
} {
  const [engine, ...rest] = targetId.split(":");
  if (!DB_ENGINES.includes(engine as DatabaseEngine) || rest.length === 0) {
    throw new AppError("INTERNAL", "Database target id is missing its engine");
  }
  return { engine: engine as DatabaseEngine, id: rest.join(":") };
}

async function parent(ctx: ApplyContext, srcId: string, kind: string) {
  const entry = await ctx.idMap.get(ctx.runId, srcId, kind);
  if (!entry) {
    throw new AppError(
      "INTERNAL",
      `Missing ${kind} for '${srcId}'; a dependency step did not complete`,
      {
        hint: "Retry the failed earlier step first.",
      },
    );
  }
  return entry.targetId;
}

async function ownResource(ctx: ApplyContext, srcId: string) {
  for (const kind of RESOURCE_KINDS) {
    const entry = await ctx.idMap.get(ctx.runId, srcId, kind);
    if (entry) return { kind, ...entry };
  }
  throw new AppError(
    "INTERNAL",
    `Resource '${srcId}' has not been created yet`,
  );
}

/** Crash recovery: a resource carrying our marker in `description` was created by an earlier attempt. */
async function findOurs(
  ctx: ApplyContext,
  projectId: string,
  environmentId: string,
  srcId: string,
  type: "applications" | "compose" | DatabaseEngine,
): Promise<string | undefined> {
  const project = await ctx.dokploy.projectOne(projectId);
  const environment = project.environments?.find(
    (e) => e.environmentId === environmentId,
  );
  const list = (environment as Rec | undefined)?.[type];
  if (!Array.isArray(list)) return undefined;
  const marker = migrationMarker(srcId);
  const idKey =
    type === "applications"
      ? "applicationId"
      : type === "compose"
        ? "composeId"
        : `${type}Id`;
  const hit = list.map(rec).find((item) => item.description === marker);
  return hit ? str(hit[idKey]) : undefined;
}

function generatedPassword(): string {
  return randomBytes(18).toString("base64url");
}

export async function executeStep(
  step: Step,
  ctx: ApplyContext,
): Promise<StepResult> {
  const p = rec(step.payload);
  switch (step.kind) {
    case "CREATE_PROJECT":
      return createProject(step, p, ctx);
    case "ENSURE_ENVIRONMENT":
      return ensureEnvironment(step, p, ctx);
    case "CREATE_APPLICATION":
    case "CREATE_COMPOSE":
    case "CREATE_DATABASE":
      return createResource(step, p, ctx);
    case "CONFIGURE_SOURCE":
      return configureSource(step, p, ctx);
    case "CONFIGURE_BUILD":
      return configureBuild(step, p, ctx);
    case "SET_ENV":
      return setEnv(step, p, ctx);
    case "CREATE_MOUNT":
      return createMount(step, p, ctx);
    case "CREATE_DOMAIN":
      return createDomain(step, p, ctx);
    case "SET_ENV_SHARED":
      return {
        note: "Shared variables cannot be read from Coolify; references were rewritten only",
      };
    default:
      throw new AppError(
        "INTERNAL",
        `Step kind ${step.kind} is not executed during apply`,
      );
  }
}

async function createProject(
  step: Step,
  p: Rec,
  ctx: ApplyContext,
): Promise<StepResult> {
  const done = await ctx.idMap.get(ctx.runId, step.srcId, "project");
  if (done) return { targetId: done.targetId, created: done.created };
  const existingId = str(p.existingProjectId);
  if (step.intent === "adopt" && existingId) {
    await ctx.idMap.put(ctx.runId, step.srcId, "project", existingId, false);
    return {
      targetId: existingId,
      created: false,
      note: "Adopted existing project",
    };
  }
  const created = await ctx.dokploy.projectCreate({
    name: need(p, "name"),
    ...(str(p.description)
      ? { description: str(p.description) as string }
      : {}),
  });
  await ctx.idMap.put(
    ctx.runId,
    step.srcId,
    "project",
    created.projectId,
    true,
  );
  return { targetId: created.projectId, created: true };
}

async function ensureEnvironment(
  step: Step,
  p: Rec,
  ctx: ApplyContext,
): Promise<StepResult> {
  const done = await ctx.idMap.get(ctx.runId, step.srcId, "environment");
  if (done) return { targetId: done.targetId, created: done.created };
  const existingId = str(p.existingEnvironmentId);
  if (existingId) {
    await ctx.idMap.put(
      ctx.runId,
      step.srcId,
      "environment",
      existingId,
      false,
    );
    return { targetId: existingId, created: false };
  }
  const projectId = await parent(ctx, need(p, "projectSrcId"), "project");
  const name = need(p, "name");
  // project.create always yields a default "production" environment: reuse it instead of duplicating.
  const project = await ctx.dokploy.projectOne(projectId);
  const match = project.environments?.find(
    (e) => lower(e.name) === lower(name),
  );
  if (match) {
    await ctx.idMap.put(
      ctx.runId,
      step.srcId,
      "environment",
      match.environmentId,
      false,
    );
    return {
      targetId: match.environmentId,
      created: false,
      note: "Reused existing environment",
    };
  }
  const created = await ctx.dokploy.environmentCreate({ name, projectId });
  await ctx.idMap.put(
    ctx.runId,
    step.srcId,
    "environment",
    created.environmentId,
    true,
  );
  return { targetId: created.environmentId, created: true };
}

async function createResource(
  step: Step,
  p: Rec,
  ctx: ApplyContext,
): Promise<StepResult> {
  const kind =
    step.kind === "CREATE_APPLICATION"
      ? "application"
      : step.kind === "CREATE_COMPOSE"
        ? "compose"
        : "database";
  const done = await ctx.idMap.get(ctx.runId, step.srcId, kind);
  if (done) return { targetId: done.targetId, created: done.created };

  const environmentId = await parent(
    ctx,
    need(p, "environmentKey"),
    "environment",
  );
  const projectId = await parent(ctx, need(p, "projectSrcId"), "project");
  const name = need(p, "name");
  const description = migrationMarker(step.srcId);
  const serverId = ctx.options.target.serverId;
  const base = {
    name,
    environmentId,
    ...(str(p.appName) ? { appName: str(p.appName) as string } : {}),
    description,
    ...(serverId ? { serverId } : {}),
  };

  if (kind === "application") {
    const recovered = await findOurs(
      ctx,
      projectId,
      environmentId,
      step.srcId,
      "applications",
    );
    const id =
      recovered ?? (await ctx.dokploy.applicationCreate(base)).applicationId;
    await ctx.idMap.put(ctx.runId, step.srcId, "application", id, true);
    return {
      targetId: id,
      created: true,
      ...(recovered ? { note: "Recovered from an interrupted attempt" } : {}),
    };
  }

  if (kind === "compose") {
    const sourceKind = p.sourceKind === "git" ? "git" : "raw";
    const recovered = await findOurs(
      ctx,
      projectId,
      environmentId,
      step.srcId,
      "compose",
    );
    const id =
      recovered ??
      (
        await ctx.dokploy.composeCreate({
          ...base,
          sourceType: "raw",
          composeFile: sourceKind === "raw" ? (str(p.composeFile) ?? "") : "",
        })
      ).composeId;
    await ctx.idMap.put(ctx.runId, step.srcId, "compose", id, true);
    return {
      targetId: id,
      created: true,
      ...(recovered ? { note: "Recovered from an interrupted attempt" } : {}),
    };
  }

  const engine = p.engine as DatabaseEngine;
  if (!DB_ENGINES.includes(engine))
    throw new AppError("INTERNAL", "Unsupported database engine");
  const warnings: string[] = [];
  const read = async (ref: unknown) =>
    typeof ref === "string" ? ctx.vault.get(ref) : undefined;
  let password = await read(p.passwordRef);
  if (!password) {
    password = generatedPassword();
    warnings.push(
      `New ${engine} password generated (source password was unreadable); update dependent apps`,
    );
  }
  const rootPassword =
    engine === "mysql" || engine === "mariadb"
      ? ((await read(p.rootPasswordRef)) ?? generatedPassword())
      : undefined;
  const recovered = await findOurs(
    ctx,
    projectId,
    environmentId,
    step.srcId,
    engine,
  );
  let id = recovered;
  if (!id) {
    const defaultDb = engine === "postgres" ? "postgres" : "app";
    const created = await ctx.dokploy.databaseCreate({
      ...base,
      engine,
      databasePassword: password,
      ...(engine === "postgres" || engine === "mysql" || engine === "mariadb"
        ? { databaseName: str(p.databaseName) ?? defaultDb }
        : {}),
      ...(engine !== "redis"
        ? {
            databaseUser:
              str(p.databaseUser) ??
              (engine === "postgres" ? "postgres" : "app"),
          }
        : {}),
      ...(rootPassword ? { databaseRootPassword: rootPassword } : {}),
      ...(str(p.image) && str(p.image) !== "unknown"
        ? { dockerImage: str(p.image) as string }
        : {}),
    });
    id = created.databaseId;
  }
  await ctx.idMap.put(
    ctx.runId,
    step.srcId,
    "database",
    `${engine}:${id}`,
    true,
  );
  return {
    targetId: `${engine}:${id}`,
    created: true,
    ...(warnings.length ? { warnings } : {}),
  };
}

function imageRef(image: string, tag: string): string {
  const lastSegment = image.split("/").pop() ?? image;
  return lastSegment.includes(":") || image.includes("@")
    ? image
    : `${image}:${tag}`;
}

async function configureSource(
  step: Step,
  p: Rec,
  ctx: ApplyContext,
): Promise<StepResult> {
  const source = rec(p.source);
  const resource = await ownResource(ctx, step.srcId);
  const warnings: string[] = [];

  if (p.target === "compose") {
    if (source.type !== "git") return { note: "No git source to configure" };
    const url = str(source.url) ?? str(source.repo) ?? "";
    const provider = str(source.provider);
    if (provider !== "public")
      warnings.push(
        "Private repository: relink the Git provider/SSH key in Dokploy",
      );
    await ctx.dokploy.composeUpdate({
      composeId: resource.targetId,
      sourceType: "git",
      customGitUrl: url,
      customGitBranch: str(source.branch) ?? "main",
      customGitSSHKeyId:
        provider === "deploy-key"
          ? (ctx.options.target.sshKeyId ?? null)
          : null,
      composePath: `./${stripLeadingSlash(str(p.composePath) ?? "docker-compose.yml")}`,
    });
    return {
      targetId: resource.targetId,
      created: false,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  const applicationId = resource.targetId;
  if (source.type === "image") {
    await ctx.dokploy.applicationSaveDockerProvider({
      applicationId,
      dockerImage: imageRef(
        str(source.image) ?? "",
        str(source.tag) ?? "latest",
      ),
    });
    return { targetId: applicationId, created: false };
  }
  const provider = str(source.provider);
  const repo = str(source.repo) ?? "";
  const url = str(source.url) ?? repo;
  const buildPath = str(p.baseDir) ?? "/";
  const githubId = ctx.options.target.githubProviderId;
  const ownerRepo = /^([\w.-]+)\/([\w.-]+)$/.exec(repo);
  if (provider === "github-app" && githubId && ownerRepo) {
    await ctx.dokploy.applicationSaveGithubProvider({
      applicationId,
      githubId,
      owner: ownerRepo[1] as string,
      repository: ownerRepo[2] as string,
      branch: str(source.branch) ?? "main",
      buildPath,
    });
    return { targetId: applicationId, created: false };
  }
  if (provider && provider !== "public") {
    warnings.push(
      "Private repository: relink the Git provider/SSH key in Dokploy",
    );
  }
  await ctx.dokploy.applicationSaveGitProvider({
    applicationId,
    customGitUrl: url,
    customGitBranch: str(source.branch) ?? "main",
    customGitBuildPath: buildPath,
    customGitSSHKeyId:
      provider === "deploy-key" ? (ctx.options.target.sshKeyId ?? null) : null,
  });
  return {
    targetId: applicationId,
    created: false,
    ...(warnings.length ? { warnings } : {}),
  };
}

const BUILD_TYPES = {
  nixpacks: "nixpacks",
  railpack: "railpack",
  static: "static",
  dockerfile: "dockerfile",
} as const;

async function configureBuild(
  step: Step,
  p: Rec,
  ctx: ApplyContext,
): Promise<StepResult> {
  const build = rec(p.build);
  const resource = await ownResource(ctx, step.srcId);
  const pack = str(build.pack) ?? "other";
  if (pack === "dockerimage")
    return { note: "Docker image apps have no build step" };
  const buildType = BUILD_TYPES[pack as keyof typeof BUILD_TYPES];
  if (!buildType) {
    return {
      note: `Build pack '${str(build.rawPack) ?? pack}' is not mapped`,
      warnings: [`Set the build type for this app manually`],
    };
  }
  const dockerfile = str(build.dockerfilePath);
  await ctx.dokploy.applicationSaveBuildType({
    applicationId: resource.targetId,
    buildType,
    ...(buildType === "dockerfile" && dockerfile
      ? { dockerfile: stripLeadingSlash(dockerfile) }
      : {}),
    ...(buildType === "dockerfile" && str(build.dockerBuildStage)
      ? { dockerBuildStage: str(build.dockerBuildStage) as string }
      : {}),
    ...(buildType === "static" && str(build.publishDir)
      ? { publishDirectory: str(build.publishDir) as string }
      : {}),
  });
  return { targetId: resource.targetId, created: false };
}

function keysOf(envString: unknown): Set<string> {
  return new Set(
    Object.keys(parseDotenv(typeof envString === "string" ? envString : "")),
  );
}

async function setEnv(
  step: Step,
  p: Rec,
  ctx: ApplyContext,
): Promise<StepResult> {
  const resource = await ownResource(ctx, step.srcId);
  const vars = (Array.isArray(p.env) ? p.env : []).map(
    rec,
  ) as unknown as Parameters<typeof buildDokployEnv>[1];
  const extra = Object.fromEntries(
    Object.entries(rec(p.extra)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  // One call per resource: saveEnvironment is a full replace.
  const built = await buildDokployEnv(
    step.srcId,
    vars,
    {
      defaultMode: ctx.options.secrets.defaultMode,
      perVar: ctx.options.secrets.perVar,
      resolveValue: (ref) => ctx.vault.get(ref),
      splitBuildArgs: p.splitBuildArgs === true,
    },
    extra,
  );
  if (built.keys.length === 0)
    return { note: "No variables to write", warnings: built.warnings };

  let stored: Rec;
  if (p.target === "compose") {
    await ctx.dokploy.composeUpdate({
      composeId: resource.targetId,
      env: built.env,
    });
    stored = await ctx.dokploy.composeOne(resource.targetId);
  } else {
    await ctx.dokploy.applicationSaveEnvironment({
      applicationId: resource.targetId,
      env: built.env,
      ...(built.buildArgs ? { buildArgs: built.buildArgs } : {}),
    });
    stored = await ctx.dokploy.applicationOne(resource.targetId);
  }
  // Read back: every planned key must exist on the target (values are never compared or printed).
  const present = new Set([...keysOf(stored.env), ...keysOf(stored.buildArgs)]);
  const missing = built.keys.filter((key) => !present.has(key));
  if (missing.length > 0) {
    throw new AppError(
      "SCHEMA_DRIFT",
      `Dokploy did not keep ${missing.length} environment key(s): ${missing.slice(0, 5).join(", ")}`,
      {
        hint: "Dokploy may have changed how environment strings are stored.",
      },
    );
  }
  return {
    targetId: resource.targetId,
    created: false,
    ...(built.warnings.length ? { warnings: built.warnings } : {}),
  };
}

async function createMount(
  step: Step,
  p: Rec,
  ctx: ApplyContext,
): Promise<StepResult> {
  const itemKey = `${step.srcId}|mount|${need(p, "itemKey")}`;
  const done = await ctx.idMap.get(ctx.runId, itemKey, "mount");
  if (done) return { targetId: done.targetId, created: done.created };
  const resource = await ownResource(ctx, step.srcId);
  const type = p.type as "bind" | "volume" | "file";
  const content =
    Array.isArray(step.vaultRefs) && step.vaultRefs[0]
      ? await ctx.vault.get(step.vaultRefs[0])
      : undefined;
  const created = await ctx.dokploy.mountCreate({
    type,
    mountPath: need(p, "mountPath"),
    serviceId: resource.targetId,
    serviceType: resource.kind === "compose" ? "compose" : "application",
    ...(str(p.hostPath) ? { hostPath: str(p.hostPath) as string } : {}),
    ...(str(p.volumeName) ? { volumeName: str(p.volumeName) as string } : {}),
    ...(type === "file"
      ? { filePath: str(p.filePath) ?? "file", content: content ?? "" }
      : {}),
  });
  await ctx.idMap.put(ctx.runId, itemKey, "mount", created.mountId, true);
  return { targetId: created.mountId, created: true };
}

async function createDomain(
  step: Step,
  p: Rec,
  ctx: ApplyContext,
): Promise<StepResult> {
  const itemKey = `${step.srcId}|domain|${need(p, "itemKey")}`;
  const done = await ctx.idMap.get(ctx.runId, itemKey, "domain");
  if (done) return { targetId: done.targetId, created: done.created };
  const resource = await ownResource(ctx, step.srcId);
  const isCompose = resource.kind === "compose";
  // Re-check right before creating (state may have changed, or a previous attempt already created it).
  const stored = isCompose
    ? await ctx.dokploy.composeOne(resource.targetId)
    : await ctx.dokploy.applicationOne(resource.targetId);
  const host = need(p, "host");
  const existing = (Array.isArray(stored.domains) ? stored.domains : [])
    .map(rec)
    .find(
      (d) =>
        lower(String(d.host ?? "")) === lower(host) &&
        (str(d.path) ?? "/") === (str(p.path) ?? "/"),
    );
  if (existing && str(existing.domainId)) {
    await ctx.idMap.put(
      ctx.runId,
      itemKey,
      "domain",
      existing.domainId as string,
      true,
    );
    return {
      targetId: existing.domainId as string,
      created: true,
      note: "Domain already present",
    };
  }
  const created = await ctx.dokploy.domainCreate({
    host,
    https: p.https !== false,
    ...(typeof p.port === "number" ? { port: p.port } : {}),
    ...(str(p.path) ? { path: str(p.path) as string } : {}),
    ...(isCompose
      ? {
          composeId: resource.targetId,
          ...(str(p.serviceName)
            ? { serviceName: str(p.serviceName) as string }
            : {}),
        }
      : { applicationId: resource.targetId }),
  });
  await ctx.idMap.put(ctx.runId, itemKey, "domain", created.domainId, true);
  return { targetId: created.domainId, created: true };
}
