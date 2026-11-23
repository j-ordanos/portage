import { z } from "zod";

export const StepKind = z.enum([
  "CREATE_PROJECT",
  "ENSURE_ENVIRONMENT",
  "SET_ENV_SHARED",
  "CREATE_APPLICATION",
  "CREATE_COMPOSE",
  "CREATE_DATABASE",
  "CONFIGURE_SOURCE",
  "CONFIGURE_BUILD",
  "SET_ENV",
  "CREATE_MOUNT",
  "CREATE_DOMAIN",
  "DEPLOY",
  "VERIFY_CONFIG",
  "VERIFY_HEALTH",
  "DELETE_CREATED",
]);

export const StepIntent = z.enum(["create", "adopt", "skip", "update"]);

export const Step = z
  .object({
    seq: z.number().int(),
    kind: StepKind,
    intent: StepIntent,
    srcId: z.string(),
    dependsOn: z.array(z.number().int()),
    label: z.string(),
    payload: z.record(z.unknown()),
    vaultRefs: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .passthrough();

export const Plan = z
  .object({
    planVersion: z.literal(1),
    createdAt: z.string(),
    steps: z.array(Step),
  })
  .passthrough();

export type Step = z.infer<typeof Step>;
export type Plan = z.infer<typeof Plan>;

export const Options = z
  .object({
    selection: z.object({
      includeSrcIds: z.array(z.string()),
      decisions: z.record(z.enum(["migrate", "skip", "acknowledge-manual"])),
    }),
    target: z.object({
      serverId: z.string().optional(),
      envStrategy: z.enum(["map", "flatten"]),
      /** suffix = still migrate, but mark the new copy with `collisionMarker` (default "*"). */
      collisionPolicy: z.enum(["adopt", "suffix", "skip"]),
      suffix: z.string().optional(),
      collisionMarker: z.string().min(1).max(8).default("*"),
    }),
    secrets: z.object({
      defaultMode: z.enum(["names-only", "import-values", "prompt"]),
      perVar: z.record(z.enum(["names-only", "import-values", "prompt"])),
    }),
    domains: z.object({
      policy: z.enum(["temp-suffix", "keep-original", "custom"]),
      tempBase: z.string().optional(),
      map: z.record(z.string()),
    }),
    updateAdopted: z.boolean(),
  })
  .passthrough();

export type Options = z.infer<typeof Options>;

/** Sensible defaults: migrate everything selected, import values, mark name collisions with `*`. */
export function defaultOptions(includeSrcIds: string[]): Options {
  return Options.parse({
    selection: { includeSrcIds, decisions: {} },
    target: { envStrategy: "map", collisionPolicy: "suffix" },
    secrets: { defaultMode: "import-values", perVar: {} },
    domains: { policy: "keep-original", map: {} },
    updateAdopted: false,
  });
}
