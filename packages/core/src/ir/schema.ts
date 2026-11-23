import { z } from "zod";

export const IR_VERSION = 1;
export const Availability = z.enum(["available", "redacted", "missing"]);
export const Compat = z.enum(["auto", "partial", "manual"]);
export const Severity = z.enum(["info", "warn", "error"]);

export const Issue = z
  .object({
    ruleId: z.string(),
    severity: Severity,
    message: z.string(),
    path: z.string().optional(),
    fix: z.string().optional(),
  })
  .passthrough();

export const EnvVar = z
  .object({
    key: z.string(),
    availability: Availability,
    valueRef: z.string().nullable(),
    isSecretGuess: z.boolean(),
    refs: z.array(z.string()),
    scope: z.enum(["runtime", "buildtime", "both", "unknown"]),
    isPreview: z.boolean(),
    isMultiline: z.boolean().default(false),
    isLiteral: z.boolean().default(false),
    comment: z.string().optional(),
  })
  .passthrough();

export const Domain = z
  .object({
    host: z.string(),
    https: z.boolean(),
    port: z.number().int().optional(),
    path: z.string().optional(),
    source: z.string(),
  })
  .passthrough();

export const Mount = z
  .object({
    type: z.enum(["volume", "bind", "file"]),
    name: z.string().optional(),
    hostPath: z.string().optional(),
    mountPath: z.string(),
    contentRef: z.string().nullable().optional(),
  })
  .passthrough();

export const Source = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("git"),
      repo: z.string(),
      branch: z.string(),
      provider: z.enum([
        "github-app",
        "deploy-key",
        "public",
        "gitlab",
        "bitbucket",
        "gitea",
        "other",
      ]),
      commit: z.string().optional(),
      url: z.string().optional(),
      sshKeyRef: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("image"),
      image: z.string(),
      tag: z.string(),
      registryHint: z.string().optional(),
    })
    .passthrough(),
]);

export const Build = z
  .object({
    pack: z.enum([
      "nixpacks",
      "dockerfile",
      "railpack",
      "static",
      "dockerimage",
      "other",
    ]),
    baseDir: z.string().optional(),
    dockerfilePath: z.string().optional(),
    publishDir: z.string().optional(),
    installCmd: z.string().optional(),
    buildCmd: z.string().optional(),
    startCmd: z.string().optional(),
    dockerBuildStage: z.string().optional(),
    rawPack: z.string(),
  })
  .passthrough();

const ResourceBase = z
  .object({
    srcId: z.string(),
    name: z.string(),
    projectSrcId: z.string(),
    environmentName: z.string(),
    serverSrcId: z.string().optional(),
    compat: Compat,
    issues: z.array(Issue),
    selected: z.boolean().default(true),
    decision: z
      .enum(["migrate", "skip", "acknowledge-manual"])
      .default("migrate"),
  })
  .passthrough();

export const IRApplication = ResourceBase.extend({
  kind: z.literal("application"),
  source: Source,
  build: Build,
  ports: z.array(z.number()),
  domains: z.array(Domain),
  env: z.array(EnvVar),
  mounts: z.array(Mount),
}).passthrough();

export const IRCompose = ResourceBase.extend({
  kind: z.literal("compose"),
  composeRaw: z.string(),
  isTemplateService: z.boolean(),
  templateName: z.string().optional(),
  source: Source.optional(),
  composePath: z.string().optional(),
  domains: z.array(Domain.extend({ service: z.string() })),
  env: z.array(EnvVar),
  mounts: z.array(Mount),
}).passthrough();

export const IRDatabase = ResourceBase.extend({
  kind: z.literal("database"),
  engine: z.enum(["postgres", "mysql", "mariadb", "mongo", "redis", "other"]),
  image: z.string(),
  dbName: z.string().optional(),
  dbUser: z.string().optional(),
  passwordRef: z.string().nullable(),
  rootPasswordRef: z.string().nullable().optional(),
  passwordAvailability: Availability,
  publiclyExposed: z.boolean(),
  publicPort: z.number().optional(),
  mounts: z.array(Mount),
  backupsConfigured: z.boolean(),
}).passthrough();

export const IRResource = z.discriminatedUnion("kind", [
  IRApplication,
  IRCompose,
  IRDatabase,
]);

export const IREnvironment = z
  .object({
    srcId: z.string(),
    name: z.string(),
    sharedEnv: z.array(EnvVar),
    resources: z.array(IRResource),
  })
  .passthrough();

export const IRProject = z
  .object({
    srcId: z.string(),
    name: z.string(),
    description: z.string().optional(),
    sharedEnv: z.array(EnvVar),
    environments: z.array(IREnvironment),
  })
  .passthrough();

export const IRServer = z
  .object({
    srcId: z.string(),
    name: z.string(),
    ip: z.string().optional(),
  })
  .passthrough();

export const IR = z
  .object({
    irVersion: z.literal(IR_VERSION),
    source: z
      .object({
        url: z.string(),
        version: z.string(),
        readAt: z.string(),
      })
      .passthrough(),
    teamSharedEnv: z.array(EnvVar),
    projects: z.array(IRProject),
    servers: z.array(IRServer),
    notes: z.array(Issue),
  })
  .passthrough();

export type IR = z.infer<typeof IR>;
export type Issue = z.infer<typeof Issue>;
export type EnvVar = z.infer<typeof EnvVar>;
export type Domain = z.infer<typeof Domain>;
export type Mount = z.infer<typeof Mount>;
export type Source = z.infer<typeof Source>;
export type Build = z.infer<typeof Build>;
export type IRApplication = z.infer<typeof IRApplication>;
export type IRCompose = z.infer<typeof IRCompose>;
export type IRDatabase = z.infer<typeof IRDatabase>;
export type IRResource = z.infer<typeof IRResource>;
export type IRProject = z.infer<typeof IRProject>;
export type IREnvironment = z.infer<typeof IREnvironment>;
