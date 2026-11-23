import { defaultOptions, type IR, type Options } from "@migrator/core";
import { z } from "zod";

/** What the UI edits. Flat on purpose: easy to render, easy to validate. */
export const UserOptions = z.object({
  /** srcIds to migrate. Undefined = everything that is not blocked. */
  include: z.array(z.string()).optional(),
  /** resources with blocking errors that the user accepts to migrate anyway. */
  acknowledge: z.array(z.string()).default([]),
  collisionPolicy: z.enum(["suffix", "adopt", "skip"]).default("suffix"),
  collisionMarker: z.string().min(1).max(8).default("*"),
  envStrategy: z.enum(["map", "flatten"]).default("map"),
  secretsMode: z.enum(["import-values", "names-only"]).default("import-values"),
  serverId: z.string().min(1).optional(),
  domainPolicy: z
    .enum(["keep-original", "temp-suffix", "custom"])
    .default("keep-original"),
  tempBase: z.string().min(1).optional(),
  domainMap: z.record(z.string()).default({}),
  githubProviderId: z.string().min(1).optional(),
  sshKeyId: z.string().min(1).optional(),
});
export type UserOptions = z.infer<typeof UserOptions>;

export function parseUserOptions(raw: unknown): UserOptions {
  return UserOptions.parse(raw ?? {});
}

export function allResources(ir: IR) {
  return ir.projects.flatMap((p) =>
    p.environments.flatMap((e) =>
      e.resources.map((resource) => ({ project: p, environment: e, resource })),
    ),
  );
}

/** A resource is blocked when it has an error issue the user has not acknowledged. */
export function isBlocked(
  resource: IR["projects"][number]["environments"][number]["resources"][number],
  user: UserOptions,
): boolean {
  return (
    resource.issues.some((i) => i.severity === "error") &&
    !user.acknowledge.includes(resource.srcId)
  );
}

export function toCoreOptions(ir: IR, user: UserOptions): Options {
  const all = allResources(ir).map((r) => r.resource);
  const include = (user.include ?? all.map((r) => r.srcId)).filter((id) =>
    all.some((r) => r.srcId === id),
  );
  const options = defaultOptions(include);
  for (const id of user.acknowledge)
    options.selection.decisions[id] = "acknowledge-manual";
  options.target.collisionPolicy = user.collisionPolicy;
  options.target.collisionMarker = user.collisionMarker;
  options.target.envStrategy = user.envStrategy;
  if (user.serverId) options.target.serverId = user.serverId;
  if (user.githubProviderId)
    options.target.githubProviderId = user.githubProviderId;
  if (user.sshKeyId) options.target.sshKeyId = user.sshKeyId;
  options.secrets.defaultMode = user.secretsMode;
  options.domains.policy = user.domainPolicy;
  if (user.tempBase) options.domains.tempBase = user.tempBase;
  options.domains.map = user.domainMap;
  return options;
}
