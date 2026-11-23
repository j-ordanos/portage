import type { IRCompose } from "../ir/schema.js";
import { IRCompose as ComposeSchema } from "../ir/schema.js";
import type { Vault } from "../vault.js";
import { mapEnvs } from "./env.js";
import { arr, cleanName, parseFqdns, rec, str } from "./util.js";

/**
 * Coolify "services" are compose stacks: one-click templates (service_type = "uptime-kuma") or custom compose.
 * Verified on 4.7.5: docker_compose_raw is the clean template; docker_compose is the rendered copy (ignore it);
 * domains live on the sub-applications (applications[].fqdn); /envs only returns Coolify magic vars unless the user added some.
 */
export async function mapService(
  detail: Record<string, unknown>,
  envs: unknown,
  ctx: { projectSrcId: string; environmentName: string; vault: Vault },
): Promise<IRCompose> {
  const uuid = str(detail, "uuid") ?? "";
  const templateName = str(detail, "service_type");
  const domains: IRCompose["domains"] = [];
  let autoSkipped = 0;
  for (const sub of arr(detail.applications)) {
    const service = str(sub, "name") ?? "app";
    const parsed = parseFqdns(str(sub, "fqdn"));
    autoSkipped += parsed.autoSkipped;
    for (const d of parsed.domains) domains.push({ ...d, service });
  }
  const { env, coolifyManaged } = await mapEnvs(envs, ctx.vault);
  const issues: IRCompose["issues"] = [];
  if (autoSkipped > 0) {
    issues.push({
      ruleId: "X-010",
      severity: "info",
      message: "Auto-generated sslip.io domain skipped",
      fix: "Add a real domain in Dokploy if the service needs one.",
    });
  }
  if (coolifyManaged > 0) {
    issues.push({
      ruleId: "X-001",
      severity: "info",
      message: `${coolifyManaged} Coolify-managed variables (SERVICE_URL_*/SERVICE_FQDN_*) were not migrated`,
    });
  }
  const rawName = str(detail, "name");
  const name = cleanName(rawName, uuid);
  return ComposeSchema.parse({
    srcId: uuid,
    name,
    projectSrcId: ctx.projectSrcId,
    environmentName: ctx.environmentName,
    compat: "auto",
    issues,
    ...(rawName && rawName !== name ? { sourceName: rawName } : {}),
    kind: "compose",
    composeRaw: str(detail, "docker_compose_raw") ?? "",
    isTemplateService: templateName !== undefined,
    ...(templateName ? { templateName } : {}),
    domains,
    env,
    mounts: [],
    ...(rec(detail).description
      ? { description: str(detail, "description") }
      : {}),
  });
}
