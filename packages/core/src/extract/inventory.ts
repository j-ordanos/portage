import type { CoolifyReader } from "../clients/coolify.js";
import {
  type EnvVar,
  IR_VERSION,
  IRApplication,
  IRCompose,
  IRDatabase,
  IR as IRSchema,
  type IR as IRType,
} from "../ir/schema.js";
import type { Vault } from "../vault.js";

export interface ExtractOptions {
  sourceUrl: string;
  sourceVersion: string;
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringField(value: unknown, key: string, fallback = ""): string {
  const field = record(value)[key];
  return typeof field === "string" ? field : fallback;
}

function sharedRefs(value: unknown): string[] {
  const text = typeof value === "string" ? value : "";
  return Array.from(
    text.matchAll(/\{\{\s*(team|project|environment)\.([A-Za-z0-9_]+)\s*\}\}/g),
    (match) => `${match[1]}.${match[2]}`,
  );
}

async function mapEnvs(rawEnvs: unknown, vault: Vault) {
  if (!Array.isArray(rawEnvs)) return [];
  const envByKey = new Map<string, EnvVar>();
  for (const raw of rawEnvs) {
    const item = record(raw);
    const key = typeof item.key === "string" ? item.key : "";
    if (!key) continue;
    const rawValue = item.value;
    const hidden =
      item.is_hidden === true ||
      item.locked === true ||
      item.shown_once === true;
    const valuePresent = typeof rawValue === "string";
    const availability = hidden
      ? "redacted"
      : valuePresent
        ? "available"
        : "missing";
    const valueRef =
      availability === "available" ? await vault.put(rawValue as string) : null;
    envByKey.set(key, {
      key,
      availability,
      valueRef,
      isSecretGuess: /(SECRET|TOKEN|PASSWORD|KEY|PRIVATE|CREDENTIAL|DSN)/i.test(
        key,
      ),
      refs: sharedRefs(rawValue),
      scope:
        item.is_buildtime === true && item.is_runtime === true
          ? "both"
          : item.is_runtime === true
            ? "runtime"
            : item.is_buildtime === true
              ? "buildtime"
              : "unknown",
      isPreview: item.is_preview === true,
      isMultiline: typeof rawValue === "string" && rawValue.includes("\n"),
      isLiteral: item.is_literal === true,
    });
  }
  return [...envByKey.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

export async function extractInventory(
  reader: CoolifyReader,
  vault: Vault,
  options: ExtractOptions,
): Promise<IRType> {
  const probe = await reader.probe();
  const version = probe.version || options.sourceVersion;
  const [projectsRaw, appsRaw, databasesRaw, servicesRaw, serversRaw] =
    await Promise.all([
      reader.listProjects().catch(() => []),
      reader.listApplications().catch(() => []),
      reader.listDatabases().catch(() => []),
      reader.listServices().catch(() => []),
      reader.listServers().catch(() => []),
    ]);

  const projects = [];
  for (const rawProject of projectsRaw) {
    const project = record(rawProject);
    const srcId = stringField(
      project,
      "uuid",
      stringField(project, "id", "unknown-project"),
    );
    let projectDetail: Record<string, unknown> = project;
    try {
      projectDetail = record(await reader.getProject(srcId));
    } catch {
      projectDetail = project;
    }
    const environmentsRaw = Array.isArray(projectDetail.environments)
      ? projectDetail.environments
      : [];
    const environmentsSource =
      environmentsRaw.length > 0
        ? environmentsRaw
            .map((item) => record(item))
            .map((item) => ({
              srcId: stringField(item, "uuid", stringField(item, "id")),
              name: stringField(item, "name", "production"),
              id:
                typeof item.id === "number"
                  ? item.id
                  : typeof item.id === "string"
                    ? Number(item.id)
                    : undefined,
            }))
        : [{ srcId: `${srcId}:production`, name: "production", id: undefined }];

    const environments = [];
    for (const environmentSource of environmentsSource) {
      const environmentName = environmentSource.name;
      const appResources = [];
      for (const rawApp of appsRaw) {
        const app = record(rawApp);
        const appEnvironmentId =
          typeof app.environment_id === "number"
            ? app.environment_id
            : typeof app.environment_id === "string"
              ? Number(app.environment_id)
              : undefined;
        if (
          environmentSource.id !== undefined &&
          appEnvironmentId !== undefined &&
          appEnvironmentId !== environmentSource.id
        ) {
          continue;
        }
        if (
          environmentSource.id === undefined &&
          stringField(app, "project_uuid") &&
          stringField(app, "project_uuid") !== srcId
        ) {
          continue;
        }
        const appUuid = stringField(app, "uuid", stringField(app, "id"));
        if (!appUuid) continue;
        try {
          const [detail, envs, storages] = await Promise.all([
            reader.getApplication(appUuid),
            reader.getApplicationEnvs(appUuid),
            reader.getApplicationStorages(appUuid),
          ]);
          const appDetail = record(detail);
          const gitRepo =
            stringField(appDetail, "git_repository") ||
            stringField(appDetail, "git_full_url");
          const dockerImage =
            stringField(appDetail, "docker_registry_image_name") ||
            stringField(appDetail, "docker_image");
          const rawPack = stringField(appDetail, "build_pack", "unknown");
          const pack =
            rawPack === "nixpacks" ||
            rawPack === "dockerfile" ||
            rawPack === "railpack" ||
            rawPack === "static" ||
            rawPack === "dockerimage"
              ? rawPack
              : "other";
          const source = gitRepo
            ? {
                type: "git" as const,
                repo: gitRepo,
                branch: stringField(appDetail, "git_branch", "main"),
                provider: "public" as const,
              }
            : {
                type: "image" as const,
                image: dockerImage || "unknown",
                tag: "latest",
              };
          const mounts = [];
          for (const storage of Array.isArray(storages) ? storages : []) {
            const mount = record(storage);
            const mountPath = stringField(mount, "mount_path");
            if (mountPath) {
              const hostPath = stringField(mount, "host_path");
              mounts.push({
                type: hostPath ? ("bind" as const) : ("volume" as const),
                name: stringField(mount, "name") || undefined,
                ...(hostPath ? { hostPath } : {}),
                mountPath,
              });
            }
          }
          const ports: number[] = [];
          const exposed = appDetail.ports_exposes;
          if (typeof exposed === "string") {
            for (const portText of exposed.split(/[,\s]+/)) {
              const port = Number(portText);
              if (Number.isInteger(port)) ports.push(port);
            }
          } else if (typeof exposed === "number") {
            ports.push(exposed);
          }
          const domains = [];
          const fqdn = stringField(appDetail, "fqdn");
          if (fqdn) {
            for (const source of fqdn.split(/[,\s]+/).filter(Boolean)) {
              const host = source.replace(/^https?:\/\//, "").split(/[/?]/)[0];
              if (host) {
                domains.push({
                  host,
                  https: source.startsWith("https://"),
                  ...(ports[0] ? { port: ports[0] } : {}),
                  source,
                });
              }
            }
          }
          const healthcheck =
            appDetail.health_check_enabled === true
              ? {
                  enabled: true,
                  path:
                    typeof appDetail.health_check_path === "string"
                      ? appDetail.health_check_path
                      : undefined,
                  port:
                    typeof appDetail.health_check_port === "number"
                      ? appDetail.health_check_port
                      : ports[0],
                  retries:
                    typeof appDetail.health_check_retries === "number"
                      ? appDetail.health_check_retries
                      : undefined,
                  timeoutS:
                    typeof appDetail.health_check_timeout === "number"
                      ? appDetail.health_check_timeout
                      : undefined,
                  intervalS:
                    typeof appDetail.health_check_interval === "number"
                      ? appDetail.health_check_interval
                      : undefined,
                }
              : { enabled: false };
          const limits = {
            ...(typeof appDetail.limits_memory === "string"
              ? { memory: appDetail.limits_memory }
              : {}),
            ...(typeof appDetail.limits_cpus === "string"
              ? { cpus: appDetail.limits_cpus }
              : {}),
          };
          appResources.push(
            IRApplication.parse({
              kind: "application",
              srcId: appUuid,
              name: stringField(appDetail, "name", appUuid),
              projectSrcId: srcId,
              environmentName,
              compat: "auto",
              issues: [],
              source,
              build: {
                pack,
                rawPack,
                baseDir:
                  typeof appDetail.base_directory === "string"
                    ? appDetail.base_directory
                    : undefined,
                dockerfilePath:
                  typeof appDetail.dockerfile_location === "string"
                    ? appDetail.dockerfile_location
                    : typeof appDetail.dockerfile === "string"
                      ? appDetail.dockerfile
                      : undefined,
                publishDir:
                  typeof appDetail.publish_directory === "string"
                    ? appDetail.publish_directory
                    : undefined,
                installCmd:
                  typeof appDetail.install_command === "string"
                    ? appDetail.install_command
                    : undefined,
                buildCmd:
                  typeof appDetail.build_command === "string"
                    ? appDetail.build_command
                    : undefined,
                startCmd:
                  typeof appDetail.start_command === "string"
                    ? appDetail.start_command
                    : undefined,
              },
              ports,
              domains,
              env: await mapEnvs(envs, vault),
              mounts,
              healthcheck,
              ...(Object.keys(limits).length ? { limits } : {}),
              preDeployCmd:
                typeof appDetail.pre_deployment_command === "string"
                  ? appDetail.pre_deployment_command
                  : undefined,
              postDeployCmd:
                typeof appDetail.post_deployment_command === "string"
                  ? appDetail.post_deployment_command
                  : undefined,
            }),
          );
        } catch {
          appResources.push(
            IRApplication.parse({
              kind: "application",
              srcId: appUuid,
              name: stringField(app, "name", appUuid),
              projectSrcId: srcId,
              environmentName,
              compat: "manual",
              issues: [
                {
                  ruleId: "E-001",
                  severity: "error",
                  message: "One application could not be read completely",
                  fix: "Retry discovery or migrate this resource manually.",
                },
              ],
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
            }),
          );
        }
      }

      const composeResources = [];
      for (const rawService of servicesRaw) {
        const service = record(rawService);
        const srcId = stringField(service, "uuid", stringField(service, "id"));
        if (!srcId) continue;
        composeResources.push(
          IRCompose.parse({
            kind: "compose",
            srcId,
            name: stringField(service, "name", srcId),
            projectSrcId: srcId,
            environmentName,
            compat: "partial",
            issues: [
              {
                ruleId: "R-070",
                severity: "warn",
                message: "Compose details require lab verification",
                fix: "Review magic variables and Coolify-specific labels.",
              },
            ],
            composeRaw: stringField(service, "docker_compose", ""),
            isTemplateService: service.type === "template",
            domains: [],
            env: [],
            mounts: [],
          }),
        );
      }

      const databaseResources = [];
      for (const rawDatabase of databasesRaw) {
        const database = record(rawDatabase);
        const srcId = stringField(
          database,
          "uuid",
          stringField(database, "id"),
        );
        if (!srcId) continue;
        const engineRaw = stringField(database, "type", "other");
        const engine =
          engineRaw === "postgres" ||
          engineRaw === "mysql" ||
          engineRaw === "mariadb" ||
          engineRaw === "mongo" ||
          engineRaw === "redis"
            ? engineRaw
            : "other";
        databaseResources.push(
          IRDatabase.parse({
            kind: "database",
            srcId,
            name: stringField(database, "name", srcId),
            projectSrcId: srcId,
            environmentName,
            compat: engine === "other" ? "manual" : "partial",
            issues:
              engine === "other"
                ? [
                    {
                      ruleId: "R-063",
                      severity: "warn",
                      message: "Unsupported database engine",
                      fix: "Create this database manually.",
                    },
                  ]
                : [],
            engine,
            image: stringField(database, "docker_image", "unknown"),
            passwordRef: null,
            passwordAvailability: "missing",
            publiclyExposed: false,
            mounts: [],
            backupsConfigured: false,
          }),
        );
      }

      environments.push({
        srcId: environmentSource.srcId,
        name: environmentName,
        sharedEnv: [],
        resources: [...appResources, ...composeResources, ...databaseResources],
      });
    }

    projects.push({
      srcId,
      name: stringField(project, "name", srcId),
      description:
        typeof project.description === "string"
          ? project.description
          : undefined,
      sharedEnv: [],
      environments,
    });
  }

  const ir = IRSchema.parse({
    irVersion: IR_VERSION,
    source: {
      url: options.sourceUrl,
      version,
      readAt: new Date().toISOString(),
    },
    teamSharedEnv: [],
    projects,
    servers: serversRaw.map((raw) => ({
      srcId: stringField(raw, "uuid", stringField(raw, "id", "unknown-server")),
      name: stringField(raw, "name", "Unknown server"),
      ip:
        typeof record(raw).ip === "string"
          ? (record(raw).ip as string)
          : undefined,
    })),
    notes: [],
  });
  return ir;
}
