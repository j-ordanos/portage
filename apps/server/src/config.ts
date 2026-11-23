import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const flag = (fallback: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(fallback)
    .transform((value) => value === "true");

const configSchema = z.object({
  /** Optional. When absent a key is generated once and kept in DATA_DIR (see resolveMasterKey). */
  MASTER_KEY: z.string().min(1).optional(),
  DATA_DIR: z.string().default("./data"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().url().optional(),
  /** Anyone can create an account. The very first account is always allowed. */
  ALLOW_SIGNUP: flag("true"),
  /** Allow Coolify/Dokploy at private addresses (home labs). Turn off on a public instance. */
  UPSTREAM_ALLOW_PRIVATE: flag("true"),
  UPSTREAM_ALLOWED_HOSTS: z.string().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  RUN_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
});

export type Config = Omit<z.infer<typeof configSchema>, "MASTER_KEY"> & {
  /** Always present after readConfig: either from the environment or the generated key file. */
  MASTER_KEY: string;
  /** Where the key came from, so the startup message can say how to harden it. */
  MASTER_KEY_SOURCE: "env" | "file";
};

/**
 * The key that seals saved tokens. Preferred: set MASTER_KEY in the environment, so a stolen database
 * file is useless on its own. Otherwise a random 32-byte key is generated on first start and stored next
 * to the database (mode 0600), which still protects tokens from anyone who only sees API responses or backups
 * of the database file, but not from someone who copies the whole data directory.
 */
export function resolveMasterKey(
  dataDir: string,
  fromEnv: string | undefined,
): { key: string; source: "env" | "file" } {
  if (fromEnv) {
    if (Buffer.from(fromEnv, "base64").length !== 32) {
      throw new Error(
        "Invalid configuration: MASTER_KEY must decode to exactly 32 bytes (try: openssl rand -base64 32)",
      );
    }
    return { key: fromEnv, source: "env" };
  }
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "master.key");
  if (existsSync(file)) {
    const key = readFileSync(file, "utf8").trim();
    if (Buffer.from(key, "base64").length !== 32) {
      throw new Error(
        `Invalid configuration: ${file} is not a 32-byte base64 key; delete it only if no connections are saved`,
      );
    }
    return { key, source: "file" };
  }
  const key = randomBytes(32).toString("base64");
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { key, source: "file" };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(`Invalid configuration; invalid: ${fields}`);
  }
  const { key, source } = resolveMasterKey(
    parsed.data.DATA_DIR,
    parsed.data.MASTER_KEY,
  );
  return { ...parsed.data, MASTER_KEY: key, MASTER_KEY_SOURCE: source };
}
