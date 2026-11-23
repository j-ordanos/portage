import { z } from "zod";
import { AppError } from "../errors.js";
import { type HttpOptions, requestUpstream } from "./http.js";

export type DokployAuthStyle = "x-api-key" | "authorization";

const projectSchema = z
  .object({
    projectId: z.string(),
    name: z.string(),
    environments: z
      .array(z.object({ environmentId: z.string(), name: z.string() }))
      .optional(),
  })
  .passthrough();

export type DokployProject = z.infer<typeof projectSchema>;

const serverSchema = z
  .object({
    serverId: z.string().optional(),
    id: z.string().optional(),
    name: z.string(),
  })
  .passthrough();

export interface DokployClient {
  probe(): Promise<{ version: string; authStyle: DokployAuthStyle }>;
  projectAll(): Promise<DokployProject[]>;
  projectOne(projectId: string): Promise<DokployProject>;
  serverAll(): Promise<Array<z.infer<typeof serverSchema>>>;
  applicationOne(applicationId: string): Promise<unknown>;
  projectCreate(input: {
    name: string;
    description?: string;
  }): Promise<{ projectId: string }>;
  environmentCreate(input: {
    name: string;
    projectId: string;
    description?: string;
  }): Promise<{ environmentId: string }>;
  applicationCreate(input: {
    name: string;
    environmentId: string;
    appName?: string;
  }): Promise<{ applicationId: string }>;
  applicationSaveEnvironment(input: {
    applicationId: string;
    env: string;
  }): Promise<void>;
  applicationDelete(applicationId: string): Promise<void>;
  projectDelete(projectId: string): Promise<void>;
  environmentDelete(environmentId: string): Promise<void>;
  mountDelete(mountId: string): Promise<void>;
  composeCreate(input: {
    name: string;
    environmentId: string;
    composeType?: "docker-compose";
  }): Promise<{ composeId: string }>;
  composeUpdate(input: {
    composeId: string;
    composeFile: string;
    env: string;
  }): Promise<void>;
  composeDelete(composeId: string): Promise<void>;
  databaseCreate(input: {
    engine: "postgres" | "mysql" | "mariadb" | "mongo" | "redis";
    name: string;
    environmentId: string;
    databaseName?: string;
    databaseUser?: string;
    databasePassword?: string;
    dockerImage?: string;
  }): Promise<{ databaseId: string }>;
  databaseDelete(
    engine: "postgres" | "mysql" | "mariadb" | "mongo" | "redis",
    databaseId: string,
  ): Promise<void>;
  mountCreate(input: {
    type: "bind" | "volume" | "file";
    mountPath: string;
    serviceId: string;
    serviceType: "application" | "compose";
    hostPath?: string;
    volumeName?: string;
    content?: string;
  }): Promise<{ mountId: string }>;
  domainCreate(input: {
    host: string;
    applicationId?: string;
    composeId?: string;
    port?: number;
    https?: boolean;
  }): Promise<{ domainId: string }>;
  domainDelete(domainId: string): Promise<void>;
}

export function createDokployClient(
  options: HttpOptions & { apiKey: string },
): DokployClient {
  let authStyle: DokployAuthStyle = "x-api-key";

  const call = (path: string, method: "GET" | "POST" = "GET", body?: unknown) =>
    requestUpstream({
      ...options,
      path,
      method,
      body,
      headers:
        authStyle === "x-api-key"
          ? { "x-api-key": options.apiKey, ...options.headers }
          : { Authorization: `Bearer ${options.apiKey}`, ...options.headers },
    });

  return {
    async probe() {
      const styles: DokployAuthStyle[] = ["x-api-key", "authorization"];
      let lastError: unknown;
      for (const style of styles) {
        authStyle = style;
        try {
          await call("/api/project.all");
          const rawVersion = await call(
            "/api/settings.getDokployVersion",
          ).catch(() => null);
          const parsed = z
            .object({
              version: z.string().optional(),
              data: z.object({ version: z.string() }).optional(),
            })
            .passthrough()
            .safeParse(rawVersion);
          const version = parsed.success
            ? (parsed.data.version ?? parsed.data.data?.version ?? "unknown")
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
      const raw = await call("/api/project.all");
      const parsed = z.array(projectSchema).safeParse(raw);
      if (!parsed.success) {
        throw new AppError(
          "SCHEMA_DRIFT",
          "Dokploy project.all response did not match the expected shape",
        );
      }
      return parsed.data;
    },
    async projectOne(projectId) {
      const raw = await call(
        `/api/project.one?projectId=${encodeURIComponent(projectId)}`,
      );
      const parsed = projectSchema.safeParse(raw);
      if (!parsed.success) {
        throw new AppError(
          "SCHEMA_DRIFT",
          "Dokploy project.one response did not match the expected shape",
        );
      }
      return parsed.data;
    },
    async serverAll() {
      const raw = await call("/api/server.all");
      const parsed = z.array(serverSchema).safeParse(raw);
      if (!parsed.success) {
        throw new AppError(
          "SCHEMA_DRIFT",
          "Dokploy server.all response did not match the expected shape",
        );
      }
      return parsed.data;
    },
    async applicationOne(applicationId) {
      return call(
        `/api/application.one?applicationId=${encodeURIComponent(applicationId)}`,
      );
    },
    async projectCreate(input) {
      const raw = await call("/api/project.create", "POST", input);
      const parsed = z
        .object({ projectId: z.string() })
        .passthrough()
        .safeParse(raw);
      if (!parsed.success) {
        throw new AppError(
          "SCHEMA_DRIFT",
          "Dokploy project.create response did not include projectId",
        );
      }
      return parsed.data;
    },
    async environmentCreate(input) {
      const raw = await call("/api/environment.create", "POST", input);
      const parsed = z
        .object({ environmentId: z.string() })
        .passthrough()
        .safeParse(raw);
      if (!parsed.success) {
        throw new AppError(
          "SCHEMA_DRIFT",
          "Dokploy environment.create response did not include environmentId",
        );
      }
      return parsed.data;
    },
    async applicationCreate(input) {
      const raw = await call("/api/application.create", "POST", input);
      const parsed = z
        .object({ applicationId: z.string() })
        .passthrough()
        .safeParse(raw);
      if (!parsed.success) {
        throw new AppError(
          "SCHEMA_DRIFT",
          "Dokploy application.create response did not include applicationId",
        );
      }
      return parsed.data;
    },
    async applicationSaveEnvironment(input) {
      await call("/api/application.saveEnvironment", "POST", input);
    },
    async applicationDelete(applicationId) {
      await call("/api/application.delete", "POST", { applicationId });
    },
    async projectDelete(projectId) {
      await call("/api/project.remove", "POST", { projectId });
    },
    async environmentDelete(environmentId) {
      await call("/api/environment.remove", "POST", { environmentId });
    },
    async mountDelete(mountId) {
      await call("/api/mounts.delete", "POST", { mountId });
    },
    async domainCreate(input) {
      const raw = await call("/api/domain.create", "POST", input);
      const parsed = z
        .object({ domainId: z.string() })
        .passthrough()
        .safeParse(raw);
      if (!parsed.success) {
        throw new AppError(
          "SCHEMA_DRIFT",
          "Dokploy domain.create response did not include domainId",
        );
      }
      return parsed.data;
    },
    async domainDelete(domainId) {
      await call("/api/domain.delete", "POST", { domainId });
    },
    async composeCreate(input) {
      const raw = await call("/api/compose.create", "POST", input);
      const parsed = z
        .object({ composeId: z.string() })
        .passthrough()
        .safeParse(raw);
      if (!parsed.success) {
        throw new AppError(
          "SCHEMA_DRIFT",
          "Dokploy compose.create response did not include composeId",
        );
      }
      return parsed.data;
    },
    async composeUpdate(input) {
      await call("/api/compose.update", "POST", input);
    },
    async composeDelete(composeId) {
      await call("/api/compose.delete", "POST", { composeId });
    },
    async databaseCreate(input) {
      const { engine, ...body } = input;
      const raw = await call(`/api/${engine}.create`, "POST", body);
      const parsed = z
        .object({ databaseId: z.string(), postgresId: z.string().optional() })
        .passthrough()
        .safeParse(raw);
      if (!parsed.success) {
        throw new AppError(
          "SCHEMA_DRIFT",
          `Dokploy ${engine}.create response did not include databaseId`,
        );
      }
      return {
        databaseId: parsed.data.databaseId ?? parsed.data.postgresId ?? "",
      };
    },
    async databaseDelete(engine, databaseId) {
      await call(`/api/${engine}.remove`, "POST", {
        [`${engine}Id`]: databaseId,
      });
    },
    async mountCreate(input) {
      const raw = await call("/api/mounts.create", "POST", input);
      const parsed = z
        .object({ mountId: z.string() })
        .passthrough()
        .safeParse(raw);
      if (!parsed.success) {
        throw new AppError(
          "SCHEMA_DRIFT",
          "Dokploy mounts.create response did not include mountId",
        );
      }
      return parsed.data;
    },
  };
}
