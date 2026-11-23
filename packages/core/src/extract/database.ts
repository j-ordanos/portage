import type { IRDatabase } from "../ir/schema.js";
import { IRDatabase as DatabaseSchema } from "../ir/schema.js";
import type { Vault } from "../vault.js";
import { mapStorages } from "./storage.js";
import { arr, cleanName, num, rec, str } from "./util.js";

type Engine = IRDatabase["engine"];

/** database_type looks like "standalone-postgresql" (verified). Anything unknown becomes "other". */
export function engineOf(databaseType: string | undefined): Engine {
  const t = (databaseType ?? "").toLowerCase();
  if (t.includes("postgres")) return "postgres";
  if (t.includes("mariadb")) return "mariadb";
  if (t.includes("mysql")) return "mysql";
  if (t.includes("mongo")) return "mongo";
  if (t.includes("redis") && !t.includes("keydb")) return "redis";
  return "other";
}

const FIELDS: Record<
  Exclude<Engine, "other">,
  { db?: string; user?: string; password?: string; root?: string }
> = {
  postgres: {
    db: "postgres_db",
    user: "postgres_user",
    password: "postgres_password",
  },
  mysql: {
    db: "mysql_database",
    user: "mysql_user",
    password: "mysql_password",
    root: "mysql_root_password",
  },
  mariadb: {
    db: "mariadb_database",
    user: "mariadb_user",
    password: "mariadb_password",
    root: "mariadb_root_password",
  },
  mongo: {
    db: "mongo_initdb_database",
    user: "mongo_initdb_root_username",
    password: "mongo_initdb_root_password",
  },
  redis: {},
};

function envValue(envs: unknown, key: string): string | undefined {
  for (const e of arr(envs)) {
    const item = rec(e);
    if (item.key === key) {
      const v = item.real_value ?? item.value;
      if (typeof v === "string" && v !== "") return v;
    }
  }
  return undefined;
}

/** Credentials are copied to the vault only; `internal_db_url` (contains the password) is intentionally ignored. */
export async function mapDatabase(
  detail: Record<string, unknown>,
  envs: unknown,
  storages: unknown,
  backups: unknown,
  ctx: { projectSrcId: string; environmentName: string; vault: Vault },
): Promise<IRDatabase> {
  const uuid = str(detail, "uuid") ?? "";
  const engine = engineOf(str(detail, "database_type") ?? str(detail, "type"));
  const f = engine === "other" ? {} : FIELDS[engine];
  const password =
    (f.password ? str(detail, f.password) : undefined) ??
    (engine === "redis" ? envValue(envs, "REDIS_PASSWORD") : undefined);
  const rootPassword = f.root ? str(detail, f.root) : undefined;
  const passwordRef = password ? await ctx.vault.put(password) : null;
  const rootPasswordRef = rootPassword
    ? await ctx.vault.put(rootPassword)
    : null;
  const rawName = str(detail, "name");
  const name = cleanName(rawName, uuid);
  const issues: IRDatabase["issues"] = [];
  if (engine === "other") {
    issues.push({
      ruleId: "R-063",
      severity: "warn",
      message: `Unsupported database engine '${str(detail, "database_type") ?? "unknown"}'`,
      fix: "Create this database manually in Dokploy.",
    });
  }
  const publicPort = num(detail, "public_port");
  return DatabaseSchema.parse({
    srcId: uuid,
    name,
    projectSrcId: ctx.projectSrcId,
    environmentName: ctx.environmentName,
    compat: "auto",
    issues,
    ...(rawName && rawName !== name ? { sourceName: rawName } : {}),
    kind: "database",
    engine,
    image: str(detail, "image") ?? "unknown",
    ...(f.db && str(detail, f.db) ? { dbName: str(detail, f.db) } : {}),
    ...(f.user && str(detail, f.user)
      ? { dbUser: str(detail, f.user) }
      : engine === "redis" && envValue(envs, "REDIS_USERNAME")
        ? { dbUser: envValue(envs, "REDIS_USERNAME") }
        : {}),
    passwordRef,
    rootPasswordRef,
    passwordAvailability: passwordRef ? "available" : "missing",
    publiclyExposed: detail.is_public === true,
    ...(publicPort ? { publicPort } : {}),
    mounts: await mapStorages(storages, ctx.vault, uuid),
    backupsConfigured:
      arr(backups).length > 0 || arr(detail.backup_configs).length > 0,
  });
}
