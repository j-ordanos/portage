import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export function openDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const database = new Database(join(dataDir, "migrator.db"));
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      coolify_url TEXT NOT NULL,
      dokploy_url TEXT NOT NULL,
      options_json TEXT NOT NULL,
      ir_json TEXT,
      plan_json TEXT,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credentials (
      run_id TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vault (
      run_id TEXT NOT NULL,
      ref TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      PRIMARY KEY (run_id, ref)
    );
    CREATE TABLE IF NOT EXISTS id_map (
      run_id TEXT NOT NULL,
      src_id TEXT NOT NULL,
      src_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created INTEGER NOT NULL,
      PRIMARY KEY (run_id, src_id, src_kind)
    );
  `);
  return database;
}

export function purgeExpiredSecrets(
  database: Database.Database,
  now = Date.now(),
) {
  database.prepare("DELETE FROM credentials WHERE expires_at <= ?").run(now);
  database
    .prepare(
      "DELETE FROM vault WHERE run_id NOT IN (SELECT id FROM runs WHERE expires_at > ?)",
    )
    .run(now);
  database
    .prepare(
      "DELETE FROM runs WHERE status IN ('completed','cancelled','failed','rolled_back','purged') AND expires_at <= ?",
    )
    .run(now);
}
