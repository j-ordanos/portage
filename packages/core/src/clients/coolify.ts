import { z } from "zod";
import { AppError } from "../errors.js";
import { type HttpOptions, requestUpstream } from "./http.js";

const CoolifyVersion = z.object({
  version: z.string().optional(),
  data: z.object({ version: z.string().optional() }).optional(),
});

export interface CoolifyReader {
  probe(): Promise<{
    version: string;
    abilities: {
      read: boolean;
      write: false;
      sensitiveRead: boolean | "unknown";
    };
    warnings: string[];
  }>;
  listProjects(): Promise<unknown[]>;
  listApplications(): Promise<unknown[]>;
  listDatabases(): Promise<unknown[]>;
  listServices(): Promise<unknown[]>;
  listServers(): Promise<unknown[]>;
  getProject(uuid: string): Promise<unknown>;
  getApplication(uuid: string): Promise<unknown>;
  getApplicationEnvs(uuid: string): Promise<unknown[]>;
  getApplicationStorages(uuid: string): Promise<unknown[]>;
  /** Authoritative grouping: applications/databases/services that live in one environment. */
  getEnvironment(
    projectUuid: string,
    environmentName: string,
  ): Promise<unknown>;
  getDatabase(uuid: string): Promise<unknown>;
  getDatabaseEnvs(uuid: string): Promise<unknown[]>;
  getDatabaseStorages(uuid: string): Promise<unknown[]>;
  getDatabaseBackups(uuid: string): Promise<unknown[]>;
  getService(uuid: string): Promise<unknown>;
  getServiceEnvs(uuid: string): Promise<unknown[]>;
  getServiceStorages(uuid: string): Promise<unknown[]>;
  listGithubApps(): Promise<unknown[]>;
  /** Deploy keys: name + fingerprint are used for matching; the private key is never read into the IR. */
  listSecurityKeys(): Promise<unknown[]>;
}

export function createCoolifyReader(
  options: HttpOptions & { token: string },
): CoolifyReader {
  const get = (path: string) =>
    requestUpstream({
      ...options,
      path,
      headers: { Authorization: `Bearer ${options.token}`, ...options.headers },
    });

  const list = async (path: string): Promise<unknown[]> => {
    const value = await get(path);
    if (Array.isArray(value)) return value;
    const parsed = z.object({ data: z.array(z.unknown()) }).safeParse(value);
    if (parsed.success) return parsed.data.data;
    throw new AppError(
      "SCHEMA_DRIFT",
      "Coolify list response did not match the expected shape",
    );
  };

  const storages = async (path: string): Promise<unknown[]> => {
    const value = await get(path);
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const persistent = Array.isArray(record.persistent_storages)
        ? record.persistent_storages
        : [];
      const files = Array.isArray(record.file_storages)
        ? record.file_storages
        : [];
      return [...persistent, ...files];
    }
    throw new AppError(
      "SCHEMA_DRIFT",
      "Coolify storage response did not match the expected shape",
    );
  };

  return {
    async probe() {
      let version = "unknown";
      try {
        const raw = await get("/api/v1/version");
        if (typeof raw === "string" && raw.trim()) {
          version = raw.trim();
        }
        const parsed = CoolifyVersion.safeParse(raw);
        if (parsed.success) {
          version =
            parsed.data.version ?? parsed.data.data?.version ?? "unknown";
        }
      } catch (error) {
        if (
          error instanceof AppError &&
          (error.code === "UPSTREAM_AUTH" ||
            error.code === "UPSTREAM_FORBIDDEN")
        ) {
          throw error;
        }
      }
      await list("/api/v1/projects");
      return {
        version,
        abilities: { read: true, write: false, sensitiveRead: "unknown" },
        warnings: [
          "Sensitive-read scope could not be verified from the version endpoint.",
        ],
      };
    },
    listProjects: () => list("/api/v1/projects"),
    listApplications: () => list("/api/v1/applications"),
    listDatabases: () => list("/api/v1/databases"),
    listServices: () => list("/api/v1/services"),
    listServers: () => list("/api/v1/servers"),
    async getProject(uuid) {
      return get(`/api/v1/projects/${encodeURIComponent(uuid)}`);
    },
    async getApplication(uuid) {
      return get(`/api/v1/applications/${encodeURIComponent(uuid)}`);
    },
    async getApplicationEnvs(uuid) {
      return list(`/api/v1/applications/${encodeURIComponent(uuid)}/envs`);
    },
    getApplicationStorages: (uuid) =>
      storages(`/api/v1/applications/${encodeURIComponent(uuid)}/storages`),
    getEnvironment: (projectUuid, environmentName) =>
      get(
        `/api/v1/projects/${encodeURIComponent(projectUuid)}/${encodeURIComponent(environmentName)}`,
      ),
    getDatabase: (uuid) => get(`/api/v1/databases/${encodeURIComponent(uuid)}`),
    getDatabaseEnvs: (uuid) =>
      list(`/api/v1/databases/${encodeURIComponent(uuid)}/envs`),
    getDatabaseStorages: (uuid) =>
      storages(`/api/v1/databases/${encodeURIComponent(uuid)}/storages`),
    getDatabaseBackups: (uuid) =>
      list(`/api/v1/databases/${encodeURIComponent(uuid)}/backups`),
    getService: (uuid) => get(`/api/v1/services/${encodeURIComponent(uuid)}`),
    getServiceEnvs: (uuid) =>
      list(`/api/v1/services/${encodeURIComponent(uuid)}/envs`),
    getServiceStorages: (uuid) =>
      storages(`/api/v1/services/${encodeURIComponent(uuid)}/storages`),
    listGithubApps: () => list("/api/v1/github-apps"),
    listSecurityKeys: () => list("/api/v1/security/keys"),
  };
}
