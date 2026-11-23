import { z } from "zod";
import { AppError } from "../errors.js";
import { type HttpOptions, requestUpstream } from "./http.js";

export type DokployAuthStyle = "x-api-key" | "authorization";

import type { DatabaseEngine } from "../resources/data.js";

/** Verified on Dokploy v0.31.4: environments carry one array per resource type. */
const resourceRef = z
  .object({
    name: z.string().optional(),
    description: z.string().nullable().optional(),
  })
  .passthrough();
const environmentSchema = z
  .object({
    environmentId: z.string(),
    name: z.string(),
    isDefault: z.boolean().optional(),
    applications: z.array(resourceRef).optional(),
    compose: z.array(resourceRef).optional(),
    postgres: z.array(resourceRef).optional(),
    mysql: z.array(resourceRef).optional(),
    mariadb: z.array(resourceRef).optional(),
    mongo: z.array(resourceRef).optional(),
    redis: z.array(resourceRef).optional(),
  })
  .passthrough();
const projectSchema = z
  .object({
    projectId: z.string(),
    name: z.string(),
    environments: z.array(environmentSchema).optional(),
  })
  .passthrough();
const serverSchema = z
  .object({ serverId: z.string().optional(), name: z.string() })
  .passthrough();

export type DokployEnvironment = z.infer<typeof environmentSchema>;
export type DokployProject = z.infer<typeof projectSchema>;

export interface GitProviderInput {
  applicationId: string;
  customGitUrl: string;
  customGitBranch: string;
  customGitBuildPath: string | null;
  customGitSSHKeyId?: string | null;
}
export interface GithubProviderInput {
  applicationId: string;
  githubId: string;
  owner: string;
  repository: string;
  branch: string;
  buildPath: string;
}
export interface BuildTypeInput {
  applicationId: string;
  buildType:
    | "dockerfile"
    | "nixpacks"
    | "static"
    | "railpack"
    | "heroku_buildpacks"
    | "paketo_buildpacks";
  dockerfile?: string | null;
  dockerContextPath?: string | null;
  dockerBuildStage?: string | null;
  publishDirectory?: string | null;
  isStaticSpa?: boolean | null;
}
export interface ComposeUpdateInput {
  composeId: string;
  composeFile?: string;
  env?: string;
  sourceType?: "git" | "github" | "raw";
  customGitUrl?: string;
  customGitBranch?: string;
  customGitSSHKeyId?: string | null;
  composePath?: string;
  githubId?: string;
  owner?: string;
  repository?: string;
  branch?: string;
}

export interface DokployClient {
  probe(): Promise<{ version: string; authStyle: DokployAuthStyle }>;
  projectAll(): Promise<DokployProject[]>;
  projectOne(projectId: string): Promise<DokployProject>;
  serverAll(): Promise<Array<z.infer<typeof serverSchema>>>;
  applicationOne(applicationId: string): Promise<Record<string, unknown>>;
  composeOne(composeId: string): Promise<Record<string, unknown>>;
  /** project.one returns trimmed database rows; the full row (image, user, …) needs `<engine>.one`. */
  databaseOne(
    engine: DatabaseEngine,
    databaseId: string,
  ): Promise<Record<string, unknown>>;

  projectCreate(input: { name: string; description?: string }): Promise<{
    projectId: string;
    environmentId?: string;
    environmentName?: string;
  }>;
  environmentCreate(input: {
    name: string;
    projectId: string;
    description?: string;
  }): Promise<{ environmentId: string }>;
  applicationCreate(input: {
    name: string;
    environmentId: string;
    appName?: string;
    description?: string;
    serverId?: string;
  }): Promise<{ applicationId: string; appName?: string }>;
  applicationSaveGitProvider(input: GitProviderInput): Promise<void>;
  applicationSaveGithubProvider(input: GithubProviderInput): Promise<void>;
  applicationSaveDockerProvider(input: {
    applicationId: string;
    dockerImage: string;
  }): Promise<void>;
  applicationSaveBuildType(input: BuildTypeInput): Promise<void>;
  applicationUpdate(
    input: { applicationId: string } & Record<string, unknown>,
  ): Promise<void>;
  applicationSaveEnvironment(input: {
    applicationId: string;
    env: string;
    buildArgs?: string;
  }): Promise<void>;
  composeCreate(input: {
    name: string;
    environmentId: string;
    sourceType?: "raw" | "git";
    composeFile?: string;
    appName?: string;
    description?: string;
    serverId?: string;
  }): Promise<{ composeId: string; appName?: string }>;
  composeUpdate(input: ComposeUpdateInput): Promise<void>;
  databaseCreate(input: {
    engine: DatabaseEngine;
    name: string;
    environmentId: string;
    appName?: string;
    description?: string;
    databaseName?: string;
    databaseUser?: string;
    databasePassword: string;
    databaseRootPassword?: string;
    dockerImage?: string;
    serverId?: string;
  }): Promise<{ databaseId: string }>;
  mountCreate(input: {
    type: "bind" | "volume" | "file";
    mountPath: string;
    serviceId: string;
    serviceType: "application" | "compose";
    hostPath?: string;
    volumeName?: string;
    filePath?: string;
    content?: string;
  }): Promise<{ mountId: string }>;
  domainCreate(input: {
    host: string;
    applicationId?: string;
    composeId?: string;
    serviceName?: string;
    port?: number;
    https?: boolean;
    path?: string;
  }): Promise<{ domainId: string }>;

  applicationDelete(applicationId: string): Promise<void>;
  composeDelete(composeId: string): Promise<void>;
  databaseDelete(engine: DatabaseEngine, databaseId: string): Promise<void>;
  domainDelete(domainId: string): Promise<void>;
  mountDelete(mountId: string): Promise<void>;
  environmentDelete(environmentId: string): Promise<void>;
  projectDelete(projectId: string): Promise<void>;
}

const drift = (what: string) =>
  new AppError(
    "SCHEMA_DRIFT",
    `Dokploy ${what} response did not match the expected shape`,
  );

function pick<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw drift(what);
  return parsed.data;
}

export function createDokployClient(
  options: HttpOptions & { apiKey: string },
): DokployClient {
  let authStyle: DokployAuthStyle = "x-api-key";

  const headers = () =>
    authStyle === "x-api-key"
      ? { "x-api-key": options.apiKey, ...options.headers }
      : { Authorization: `Bearer ${options.apiKey}`, ...options.headers };

  const read = (path: string, query?: Record<string, string>) => {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
    return requestUpstream({
      ...options,
      path: `${path}${qs}`,
      method: "GET",
      headers: headers(),
    });
  };
  // Writes are never retried blindly: a timeout after the server committed would create a duplicate.
  const write = (path: string, body: unknown) =>
    requestUpstream({
      ...options,
      path,
      method: "POST",
      body,
      headers: headers(),
      retries: 0,
    });

  const created = async (
    path: string,
    body: unknown,
    key: string,
    what: string,
  ) => {
    const raw = await write(path, body);
    const value = (raw as Record<string, unknown> | null)?.[key];
    if (typeof value !== "string") throw drift(`${what} (missing ${key})`);
    return { id: value, raw: raw as Record<string, unknown> };
  };
  const object = (raw: unknown, what: string): Record<string, unknown> => {
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      return raw as Record<string, unknown>;
    throw drift(what);
  };

  return {
    async probe() {
      let lastError: unknown;
      for (const style of [
        "x-api-key",
        "authorization",
      ] as DokployAuthStyle[]) {
        authStyle = style;
        try {
          await read("/api/project.all");
          const raw = await read("/api/settings.getDokployVersion").catch(
            () => null,
          );
          const version =
            typeof raw === "string"
              ? raw
              : typeof (raw as { version?: unknown } | null)?.version ===
                  "string"
                ? (raw as { version: string }).version
                : "unknown";
          return { version, authStyle };
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new AppError(
            "UPSTREAM_AUTH",
            "No supported Dokploy auth style worked",
          );
    },
    async projectAll() {
      return pick(
        z.array(projectSchema),
        await read("/api/project.all"),
        "project.all",
      );
    },
    async projectOne(projectId) {
      return pick(
        projectSchema,
        await read("/api/project.one", { projectId }),
        "project.one",
      );
    },
    async serverAll() {
      return pick(
        z.array(serverSchema),
        await read("/api/server.all"),
        "server.all",
      );
    },
    async applicationOne(applicationId) {
      return object(
        await read("/api/application.one", { applicationId }),
        "application.one",
      );
    },
    async composeOne(composeId) {
      return object(
        await read("/api/compose.one", { composeId }),
        "compose.one",
      );
    },

    async databaseOne(engine, databaseId) {
      return object(
        await read(`/api/${engine}.one`, { [`${engine}Id`]: databaseId }),
        `${engine}.one`,
      );
    },

    async projectCreate(input) {
      const raw = object(
        await write("/api/project.create", input),
        "project.create",
      );
      const project = object(raw.project, "project.create project");
      if (typeof project.projectId !== "string")
        throw drift("project.create (missing projectId)");
      const environment = raw.environment as
        | Record<string, unknown>
        | undefined;
      return {
        projectId: project.projectId,
        ...(typeof environment?.environmentId === "string"
          ? { environmentId: environment.environmentId }
          : {}),
        ...(typeof environment?.name === "string"
          ? { environmentName: environment.name }
          : {}),
      };
    },
    async environmentCreate(input) {
      const { id } = await created(
        "/api/environment.create",
        input,
        "environmentId",
        "environment.create",
      );
      return { environmentId: id };
    },
    async applicationCreate(input) {
      const { id, raw } = await created(
        "/api/application.create",
        input,
        "applicationId",
        "application.create",
      );
      return {
        applicationId: id,
        ...(typeof raw.appName === "string" ? { appName: raw.appName } : {}),
      };
    },
    async applicationSaveGitProvider(input) {
      await write("/api/application.saveGitProvider", {
        watchPaths: null,
        enableSubmodules: false,
        customGitSSHKeyId: null,
        ...input,
      });
    },
    async applicationSaveGithubProvider(input) {
      await write("/api/application.saveGithubProvider", {
        triggerType: "push",
        watchPaths: null,
        enableSubmodules: false,
        ...input,
      });
    },
    async applicationSaveDockerProvider(input) {
      await write("/api/application.saveDockerProvider", {
        username: null,
        password: null,
        registryUrl: null,
        ...input,
      });
    },
    async applicationSaveBuildType(input) {
      await write("/api/application.saveBuildType", {
        dockerfile: null,
        dockerContextPath: null,
        dockerBuildStage: null,
        herokuVersion: null,
        railpackVersion: null,
        ...input,
      });
    },
    async applicationUpdate(input) {
      await write("/api/application.update", input);
    },
    async applicationSaveEnvironment(input) {
      await write("/api/application.saveEnvironment", {
        buildArgs: null,
        buildSecrets: null,
        createEnvFile: true,
        ...input,
      });
    },
    async composeCreate(input) {
      const { id, raw } = await created(
        "/api/compose.create",
        { composeType: "docker-compose", ...input },
        "composeId",
        "compose.create",
      );
      return {
        composeId: id,
        ...(typeof raw.appName === "string" ? { appName: raw.appName } : {}),
      };
    },
    async composeUpdate(input) {
      await write("/api/compose.update", input);
    },
    async databaseCreate(input) {
      const { engine, ...body } = input;
      const { id } = await created(
        `/api/${engine}.create`,
        body,
        `${engine}Id`,
        `${engine}.create`,
      );
      return { databaseId: id };
    },
    async mountCreate(input) {
      const { id } = await created(
        "/api/mounts.create",
        input,
        "mountId",
        "mounts.create",
      );
      return { mountId: id };
    },
    async domainCreate(input) {
      const { host, https, ...rest } = input;
      const { id } = await created(
        "/api/domain.create",
        {
          host,
          https: https ?? true,
          certificateType: https === false ? "none" : "letsencrypt",
          domainType: input.composeId ? "compose" : "application",
          ...rest,
        },
        "domainId",
        "domain.create",
      );
      return { domainId: id };
    },

    async applicationDelete(applicationId) {
      await write("/api/application.delete", { applicationId });
    },
    async composeDelete(composeId) {
      await write("/api/compose.delete", { composeId, deleteVolumes: true });
    },
    async databaseDelete(engine, databaseId) {
      await write(`/api/${engine}.remove`, { [`${engine}Id`]: databaseId });
    },
    async domainDelete(domainId) {
      await write("/api/domain.delete", { domainId });
    },
    async mountDelete(mountId) {
      await write("/api/mounts.remove", { mountId });
    },
    async environmentDelete(environmentId) {
      await write("/api/environment.remove", { environmentId });
    },
    async projectDelete(projectId) {
      await write("/api/project.remove", { projectId });
    },
  };
}
