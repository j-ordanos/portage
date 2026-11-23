import type { CoolifyReader } from "../clients/coolify.js";
import {
  IR_VERSION,
  IRApplication,
  IRCompose,
  IRDatabase,
  IR as IRSchema,
  type IR as IRType,
  type Issue,
} from "../ir/schema.js";
import type { Vault } from "../vault.js";
import { type GithubAppInfo, mapApplication } from "./application.js";
import { mapDatabase } from "./database.js";
import { mapService } from "./service.js";
import { arr, causeOf, cleanName, mapLimit, num, rec, str } from "./util.js";

export interface ExtractProgress {
  category: string;
  done: number;
  total?: number;
}

export interface ExtractOptions {
  sourceUrl: string;
  sourceVersion: string;
  onProgress?: (event: ExtractProgress) => void;
  /** Parallel detail fetches per environment. Spec: <= 4. */
  concurrency?: number;
}

type Resource = IRApplication | IRCompose | IRDatabase;
type Ref = {
  kind: "application" | "database" | "service";
  item: Record<string, unknown>;
};

/** Keys of `GET /projects/{uuid}/{env}` (verified on Coolify 4.7.5). */
const DATABASE_KEYS = [
  "postgresqls",
  "mysqls",
  "mariadbs",
  "mongodbs",
  "redis",
  "keydbs",
  "dragonflies",
  "clickhouses",
] as const;

function failedStub(
  ref: Ref,
  ctx: { projectSrcId: string; environmentName: string },
  cause: string,
): Resource {
  const uuid = str(ref.item, "uuid") ?? "unknown";
  const base = {
    srcId: uuid,
    name: cleanName(str(ref.item, "name"), uuid),
    projectSrcId: ctx.projectSrcId,
    environmentName: ctx.environmentName,
    compat: "manual" as const,
    issues: [
      {
        ruleId: "E-001",
        severity: "error" as const,
        message: `Could not read this ${ref.kind} completely (${cause})`,
        fix: "Retry discovery, or recreate this resource manually.",
      },
    ],
  };
  if (ref.kind === "database") {
    return IRDatabase.parse({
      ...base,
      kind: "database",
      engine: "other",
      image: "unknown",
      passwordRef: null,
      passwordAvailability: "missing",
      publiclyExposed: false,
      mounts: [],
      backupsConfigured: false,
    });
  }
  if (ref.kind === "service") {
    return IRCompose.parse({
      ...base,
      kind: "compose",
      composeRaw: "",
      isTemplateService: false,
      domains: [],
      env: [],
      mounts: [],
    });
  }
  return IRApplication.parse({
    ...base,
    kind: "application",
    source: {
      type: "git",
      repo: "unknown",
      branch: "unknown",
      provider: "other",
    },
    build: { pack: "other", rawPack: "unknown" },
    ports: [],
    domains: [],
    env: [],
    mounts: [],
  });
}

function refsOf(envDetail: Record<string, unknown>): Ref[] {
  const out: Ref[] = [];
  for (const item of arr(envDetail.applications)) {
    out.push({ kind: "application", item: rec(item) });
  }
  for (const key of DATABASE_KEYS) {
    for (const item of arr(envDetail[key])) {
      out.push({ kind: "database", item: rec(item) });
    }
  }
  for (const item of arr(envDetail.services)) {
    out.push({ kind: "service", item: rec(item) });
  }
  return out;
}

/**
 * Read a Coolify instance (GET only) into the IR.
 *  - Grouping comes from `GET /projects/{uuid}/{env}`; resources the environment call misses are matched by `environment_id`.
 *  - Every failure becomes an Issue (resource-level `E-001`, global notes `E-002..E-004`); one failure never aborts discovery.
 *  - Env/secret values and database passwords go to the vault; the IR holds references only.
 */
export async function extractInventory(
  reader: CoolifyReader,
  vault: Vault,
  options: ExtractOptions,
): Promise<IRType> {
  const notes: Issue[] = [];
  const progress = options.onProgress ?? (() => undefined);
  const limit = options.concurrency ?? 4;

  const guard = async <T>(label: string, fallback: T, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      notes.push({
        ruleId: "E-002",
        severity: "warn",
        message: `Could not read ${label}: ${causeOf(error)}`,
        fix: "Check that the Coolify token has read access, then retry discovery.",
      });
      return fallback;
    }
  };

  const probe = await reader.probe();
  const version =
    probe.version && probe.version !== "unknown"
      ? probe.version
      : options.sourceVersion;

  const [
    projectsRaw,
    serversRaw,
    githubAppsRaw,
    appsList,
    dbsList,
    servicesList,
  ] = await Promise.all([
    guard("projects", [] as unknown[], () => reader.listProjects()),
    guard("servers", [] as unknown[], () => reader.listServers()),
    guard("GitHub apps", [] as unknown[], () => reader.listGithubApps()),
    guard("applications", [] as unknown[], () => reader.listApplications()),
    guard("databases", [] as unknown[], () => reader.listDatabases()),
    guard("services", [] as unknown[], () => reader.listServices()),
  ]);

  const githubApps = new Map<number, GithubAppInfo>();
  for (const raw of githubAppsRaw) {
    const id = num(raw, "id");
    if (id !== undefined) {
      githubApps.set(id, {
        name: str(raw, "name") ?? "GitHub",
        isPublic: rec(raw).is_public === true,
      });
    }
  }

  // Fallback index for resources the environment call does not list (matched by numeric environment_id).
  const listed: Ref[] = [
    ...appsList.map((item) => ({
      kind: "application" as const,
      item: rec(item),
    })),
    ...dbsList.map((item) => ({ kind: "database" as const, item: rec(item) })),
    ...servicesList.map((item) => ({
      kind: "service" as const,
      item: rec(item),
    })),
  ];
  const assigned = new Set<string>();

  const projects: IRType["projects"] = [];
  let resourcesDone = 0;
  const sortedProjects = [...projectsRaw]
    .map(rec)
    .sort(
      (a, b) =>
        (str(a, "name") ?? "").localeCompare(str(b, "name") ?? "") ||
        (str(a, "uuid") ?? "").localeCompare(str(b, "uuid") ?? ""),
    );

  for (const project of sortedProjects) {
    const projectUuid = str(project, "uuid");
    if (!projectUuid) continue;
    const detail = await guard(
      `project ${str(project, "name") ?? projectUuid}`,
      project,
      async () => rec(await reader.getProject(projectUuid)),
    );
    const environmentsRaw = arr(detail.environments).map(rec);
    const environments: IRType["projects"][number]["environments"] = [];

    for (const environment of environmentsRaw) {
      const envName = str(environment, "name") ?? "production";
      const envId = num(environment, "id");
      const ctx = { projectSrcId: projectUuid, environmentName: envName };
      const envDetail = await guard(
        `environment ${envName} of ${str(project, "name") ?? projectUuid}`,
        {} as Record<string, unknown>,
        async () => rec(await reader.getEnvironment(projectUuid, envName)),
      );

      const refs = refsOf(envDetail);
      const seen = new Set(refs.map((r) => str(r.item, "uuid")));
      if (envId !== undefined) {
        for (const candidate of listed) {
          const uuid = str(candidate.item, "uuid");
          if (
            uuid &&
            !seen.has(uuid) &&
            num(candidate.item, "environment_id") === envId
          ) {
            refs.push(candidate);
            seen.add(uuid);
          }
        }
      }

      const resources = await mapLimit(refs, limit, async (ref) => {
        const uuid = str(ref.item, "uuid");
        if (!uuid) return undefined;
        assigned.add(uuid);
        let resource: Resource;
        try {
          if (ref.kind === "application") {
            const [appDetail, envs, storages] = await Promise.all([
              reader.getApplication(uuid).catch(() => ref.item),
              reader.getApplicationEnvs(uuid),
              reader.getApplicationStorages(uuid),
            ]);
            resource = await mapApplication(rec(appDetail), envs, storages, {
              ...ctx,
              vault,
              githubApps,
            });
          } else if (ref.kind === "database") {
            const [dbDetail, envs, storages, backups] = await Promise.all([
              reader.getDatabase(uuid).catch(() => ref.item),
              reader.getDatabaseEnvs(uuid).catch(() => []),
              reader.getDatabaseStorages(uuid).catch(() => []),
              reader.getDatabaseBackups(uuid).catch(() => []),
            ]);
            resource = await mapDatabase(
              rec(dbDetail),
              envs,
              storages,
              backups,
              {
                ...ctx,
                vault,
              },
            );
          } else {
            const [svcDetail, envs] = await Promise.all([
              reader.getService(uuid).catch(() => ref.item),
              reader.getServiceEnvs(uuid).catch(() => []),
            ]);
            resource = await mapService(rec(svcDetail), envs, {
              ...ctx,
              vault,
            });
          }
        } catch (error) {
          resource = failedStub(ref, ctx, causeOf(error));
        }
        progress({ category: "resources", done: ++resourcesDone });
        return resource;
      });

      environments.push({
        srcId: str(environment, "uuid") ?? `${projectUuid}:${envName}`,
        name: envName,
        sharedEnv: [],
        resources: resources
          .filter((r): r is Resource => r !== undefined)
          .sort(
            (a, b) =>
              a.name.localeCompare(b.name) || a.srcId.localeCompare(b.srcId),
          ),
      });
    }

    environments.sort((a, b) => a.name.localeCompare(b.name));
    projects.push({
      srcId: projectUuid,
      name: str(project, "name") ?? projectUuid,
      ...(str(project, "description")
        ? { description: str(project, "description") }
        : {}),
      sharedEnv: [],
      environments,
    });
    progress({
      category: "projects",
      done: projects.length,
      total: sortedProjects.length,
    });
  }

  const orphans = listed.filter((r) => {
    const uuid = str(r.item, "uuid");
    return uuid && !assigned.has(uuid);
  });
  if (orphans.length > 0) {
    notes.push({
      ruleId: "E-004",
      severity: "warn",
      message: `${orphans.length} resource(s) could not be placed in any project/environment and were skipped`,
      fix: "Check the Coolify token's team; resources of other teams are not visible.",
    });
  }

  // Sensitive-read check: env vars exist but none returned a value.
  const allEnv = projects.flatMap((p) =>
    p.environments.flatMap((e) =>
      e.resources.flatMap((r) => (r.kind === "database" ? [] : r.env)),
    ),
  );
  if (
    allEnv.length > 0 &&
    allEnv.every((v) => v.availability !== "available")
  ) {
    notes.push({
      ruleId: "R-002",
      severity: "warn",
      message: "Secret values are unavailable; they will need manual entry",
      fix: "Create a Coolify token with the sensitive-read ability.",
    });
  }

  return IRSchema.parse({
    irVersion: IR_VERSION,
    source: {
      url: options.sourceUrl,
      version,
      readAt: new Date().toISOString(),
    },
    teamSharedEnv: [],
    projects,
    servers: serversRaw
      .map(rec)
      .map((s) => ({
        srcId: str(s, "uuid") ?? "unknown-server",
        name: str(s, "name") ?? "Unknown server",
        ...(str(s, "ip") ? { ip: str(s, "ip") } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    notes,
  });
}
