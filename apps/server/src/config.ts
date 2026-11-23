import { z } from "zod";

const configSchema = z.object({
  MASTER_KEY: z.string().min(1),
  ADMIN_PASSWORD_HASH: z.string().min(1),
  DATA_DIR: z.string().default("/data"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().url().optional(),
  UPSTREAM_ALLOW_PRIVATE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  UPSTREAM_ALLOWED_HOSTS: z.string().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  RUN_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
});

export type Config = z.infer<typeof configSchema>;

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(`Invalid configuration; missing or invalid: ${fields}`);
  }
  const masterKey = Buffer.from(parsed.data.MASTER_KEY, "base64");
  if (masterKey.length !== 32) {
    throw new Error(
      "Invalid configuration: MASTER_KEY must decode to exactly 32 bytes",
    );
  }
  return parsed.data;
}
