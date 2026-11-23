import type { IRApplication, IRCompose, Issue } from "../ir/schema.js";
import {
  IRApplication as AppSchema,
  IRCompose as ComposeSchema,
} from "../ir/schema.js";
import type { Vault } from "../vault.js";
import { mapEnvs } from "./env.js";
import { mapStorages } from "./storage.js";
import { cleanName, num, parseFqdns, rec, str } from "./util.js";

export interface GithubAppInfo {
  name: string;
  isPublic: boolean;
}

export interface AppContext {
  projectSrcId: string;
  environmentName: string;
  vault: Vault;
  githubApps: Map<number, GithubAppInfo>;
}

type Source = NonNullable<IRCompose["source"]>;

/**
 * Where does the code come from?  (Verified on Coolify 4.7.5)
 *  - build_pack "dockerimage"            -> image source; git_* fields hold junk defaults, ignore them
 *  - private_key_id set                  -> deploy key (ssh url)
 *  - source_type GithubApp + source_id   -> look the id up in /github-apps: is_public = built-in "Public GitHub"
 *  - GitlabApp / other source types      -> gitlab / other
 */
export function mapSource(
  detail: Record<string, unknown>,
  ctx: Pick<AppContext, "githubApps">,
): { source: Source; issues: Issue[] } {
  const issues: Issue[] = [];
  const pack = str(detail, "build_pack");
  if (pack === "dockerimage") {
    const image = str(detail, "docker_registry_image_name") ?? "unknown";
    return {
      source: {
        type: "image",
        image,
        tag: str(detail, "docker_registry_image_tag") ?? "latest",
      },
      issues,
    };
  }
  const repo = str(detail, "git_repository") ?? "unknown";
  const branch = str(detail, "git_branch") ?? "main";
  const commit = str(detail, "git_commit_sha");
  const sourceType = str(detail, "source_type") ?? "";
  const sourceId = num(detail, "source_id");
  const isSsh = /^(git@|ssh:\/\/)/.test(repo);
  let provider: "github-app" | "deploy-key" | "public" | "gitlab" | "other";
  if (str(detail, "private_key_id") !== undefined || isSsh) {
    provider = "deploy-key";
  } else if (sourceType.endsWith("GithubApp")) {
    const app =
      sourceId !== undefined ? ctx.githubApps.get(sourceId) : undefined;
    provider = app && !app.isPublic ? "github-app" : "public";
  } else if (sourceType.endsWith("GitlabApp")) {
    provider = "gitlab";
  } else if (/^https?:\/\//.test(repo)) {
    provider = "public";
  } else {
    provider = "other";
  }
  const url = /^https?:\/\//.test(repo)
    ? repo
    : isSsh
      ? undefined
      : `https://github.com/${repo}`;
  return {
    source: {
      type: "git",
      repo,
      branch,
      provider,
      ...(commit && commit !== "HEAD" ? { commit } : {}),
      ...(url ? { url } : {}),
    },
    issues,
  };
}

function baseResource(
  detail: Record<string, unknown>,
  uuid: string,
  ctx: AppContext,
) {
  const rawName = str(detail, "name");
  const name = cleanName(rawName, uuid);
  return {
    srcId: uuid,
    name,
    projectSrcId: ctx.projectSrcId,
    environmentName: ctx.environmentName,
    compat: "auto" as const,
    issues: [] as Issue[],
    ...(rawName && rawName !== name ? { sourceName: rawName } : {}),
    ...(str(detail, "description")
      ? { description: str(detail, "description") }
      : {}),
  };
}

function ports(detail: Record<string, unknown>): number[] {
  return (str(detail, "ports_exposes") ?? "")
    .split(/[,\s]+/)
    .map(Number)
    .filter((p) => Number.isInteger(p) && p > 0);
}

/** Coolify "dockercompose" apps -> IRCompose (git repo + compose path, original compose, domains per service). */
async function mapComposeApplication(
  detail: Record<string, unknown>,
  uuid: string,
  envs: unknown,
  ctx: AppContext,
): Promise<IRCompose> {
  const base = baseResource(detail, uuid, ctx);
  const { source } = mapSource(detail, ctx);
  const { env, coolifyManaged } = await mapEnvs(envs, ctx.vault);
  const domains: Array<{
    host: string;
    https: boolean;
    source: string;
    service: string;
    port?: number;
    path?: string;
  }> = [];
  const raw = str(detail, "docker_compose_domains");
  if (raw) {
    try {
      const parsed = rec(JSON.parse(raw));
      for (const [service, value] of Object.entries(parsed)) {
        const list = parseFqdns(str(value, "domain"));
        for (const d of list.domains) domains.push({ ...d, service });
      }
    } catch {
      base.issues.push({
        ruleId: "X-030",
        severity: "warn",
        message: "Could not parse docker_compose_domains",
        fix: "Add the service domains manually in Dokploy.",
      });
    }
  }
  if (coolifyManaged > 0) {
    base.issues.push({
      ruleId: "X-001",
      severity: "info",
      message: `${coolifyManaged} Coolify-managed variables (SERVICE_URL_*/SERVICE_FQDN_*) were not migrated`,
    });
  }
  return ComposeSchema.parse({
    ...base,
    kind: "compose",
    // docker_compose_raw is the user's original file; docker_compose is Coolify-rendered (labels injected) and must not be migrated.
    composeRaw: str(detail, "docker_compose_raw") ?? "",
    isTemplateService: false,
    source,
    composePath:
      str(detail, "docker_compose_location") ?? "/docker-compose.yaml",
    domains,
    env,
    mounts: [],
  });
}

export async function mapApplication(
  detail: Record<string, unknown>,
  envs: unknown,
  storages: unknown,
  ctx: AppContext,
): Promise<IRApplication | IRCompose> {
  const uuid = str(detail, "uuid") ?? "";
  const rawPack = str(detail, "build_pack") ?? "unknown";
  if (rawPack === "dockercompose") {
    return mapComposeApplication(detail, uuid, envs, ctx);
  }
  const base = baseResource(detail, uuid, ctx);
  const pack =
    (
      ["nixpacks", "dockerfile", "railpack", "static", "dockerimage"] as const
    ).find((p) => p === rawPack) ?? "other";
  const { source, issues } = mapSource(detail, ctx);
  base.issues.push(...issues);

  const exposed = ports(detail);
  const fqdn = parseFqdns(str(detail, "fqdn"), exposed[0]);
  if (fqdn.autoSkipped > 0) {
    base.issues.push({
      ruleId: "X-010",
      severity: "info",
      message: "Auto-generated sslip.io domain skipped",
      fix: "Add a real domain in Dokploy if the app needs one.",
    });
  }
  const { env, coolifyManaged } = await mapEnvs(envs, ctx.vault);
  if (coolifyManaged > 0) {
    base.issues.push({
      ruleId: "X-001",
      severity: "info",
      message: `${coolifyManaged} Coolify-managed variables were not migrated`,
    });
  }
  if (str(detail, "dockerfile")) {
    base.issues.push({
      ruleId: "X-020",
      severity: "warn",
      message: "Dockerfile is stored inline in Coolify",
      fix: "Dokploy needs a Dockerfile path in the repo; commit the Dockerfile or paste it manually.",
    });
  }
  const mounts = await mapStorages(storages, ctx.vault, uuid);

  const hcEnabled = detail.health_check_enabled === true;
  const limitsMemory = str(detail, "limits_memory");
  const limitsCpus = str(detail, "limits_cpus");
  const limits = {
    ...(limitsMemory && limitsMemory !== "0" ? { memory: limitsMemory } : {}),
    ...(limitsCpus && limitsCpus !== "0" ? { cpus: limitsCpus } : {}),
  };
  const publishDir = str(detail, "publish_directory");
  const dockerfileLocation = str(detail, "dockerfile_location");
  const stage = str(detail, "dockerfile_target_build");
  const defined = <T extends Record<string, unknown>>(o: T) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

  return AppSchema.parse({
    ...base,
    kind: "application",
    source,
    build: defined({
      pack,
      rawPack,
      baseDir: str(detail, "base_directory"),
      dockerfilePath: dockerfileLocation,
      publishDir: publishDir && publishDir !== "/" ? publishDir : undefined,
      installCmd: str(detail, "install_command"),
      buildCmd: str(detail, "build_command"),
      startCmd: str(detail, "start_command"),
      dockerBuildStage: stage,
    }),
    ports: exposed,
    domains: fqdn.domains,
    env,
    mounts,
    healthcheck: hcEnabled
      ? defined({
          enabled: true,
          path: str(detail, "health_check_path"),
          port: num(detail, "health_check_port") ?? exposed[0],
          intervalS: num(detail, "health_check_interval"),
          timeoutS: num(detail, "health_check_timeout"),
          retries: num(detail, "health_check_retries"),
        })
      : { enabled: false },
    ...(Object.keys(limits).length ? { limits } : {}),
    ...defined({
      preDeployCmd: str(detail, "pre_deployment_command"),
      postDeployCmd: str(detail, "post_deployment_command"),
    }),
  });
}
