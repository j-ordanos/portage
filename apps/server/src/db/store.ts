import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type IdMapStore,
  openSealed,
  type Plan,
  Redactor,
  type StepRecord,
  seal,
  type Vault,
} from "@migrator/core";
import Database from "better-sqlite3";

export interface User {
  id: string;
  email: string;
  createdAt: number;
}

/** A saved Coolify or Dokploy server. The secret is sealed on disk and never leaves the server. */
export interface ConnectionRow {
  id: string;
  userId: string;
  kind: "coolify" | "dokploy";
  name: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  /** Result of the last connection test (version or a short error), safe to show. */
  check: { ok: boolean; version?: string; message?: string; at: number } | null;
}

export interface RunRow {
  id: string;
  userId: string | null;
  coolifyConnectionId: string | null;
  dokployConnectionId: string | null;
  name: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  coolifyUrl: string;
  dokployUrl: string;
  coolifyVersion: string | null;
  dokployVersion: string | null;
  options: unknown | null;
  ir: unknown | null;
  plan: Plan | null;
  noticeAcceptedAt: number | null;
}

export interface Credentials {
  coolify: { url: string; token: string };
  dokploy: { url: string; apiKey: string };
}

export interface StepRow {
  seq: number;
  kind: string;
  label: string;
  srcId: string;
  intent: string;
  state: string;
  attempts: number;
  targetId: string | null;
  note: string | null;
  warnings: string[];
  error: { code: string; message: string; hint?: string } | null;
}

export interface EventRow {
  id: number;
  ts: number;
  level: string;
  seq: number | null;
  message: string;
}

const DAY = 24 * 60 * 60 * 1000;
const RUN_TTL = 7 * DAY;
const CRED_TTL = DAY;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_login_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('coolify','dokploy')), name TEXT NOT NULL COLLATE NOCASE,
    url TEXT NOT NULL, ciphertext TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER, check_json TEXT,
    UNIQUE (user_id, kind, name)
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    coolify_url TEXT NOT NULL, dokploy_url TEXT NOT NULL,
    coolify_version TEXT, dokploy_version TEXT,
    options_json TEXT, ir_json TEXT, plan_json TEXT, notice_accepted_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS credentials (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS vault (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ref TEXT NOT NULL, ciphertext TEXT NOT NULL, PRIMARY KEY (run_id, ref)
  );
  CREATE TABLE IF NOT EXISTS steps (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, src_id TEXT NOT NULL, intent TEXT NOT NULL,
    state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, target_id TEXT, note TEXT,
    warnings_json TEXT NOT NULL DEFAULT '[]', error_json TEXT, started_at INTEGER, finished_at INTEGER,
    PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE IF NOT EXISTS id_map (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    src_id TEXT NOT NULL, src_kind TEXT NOT NULL, target_id TEXT NOT NULL, created INTEGER NOT NULL,
    PRIMARY KEY (run_id, src_id, src_kind)
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL, level TEXT NOT NULL, seq INTEGER, message TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_run ON events(run_id, id);
  CREATE TABLE IF NOT EXISTS checklist (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, done_at INTEGER,
    PRIMARY KEY (run_id, item_id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE
  );
`;

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const parse = <T>(text: string | null): T | null =>
  text === null ? null : (JSON.parse(text) as T);

/** Everything the server persists. Secrets (credentials, vault) are sealed with MASTER_KEY before they touch disk. */
export class Store {
  readonly db: Database.Database;
  private readonly redactors = new Map<string, Redactor>();

  constructor(
    dataDir: string,
    private readonly masterKey: string,
  ) {
    if (dataDir !== ":memory:") mkdirSync(dataDir, { recursive: true });
    const location =
      dataDir === ":memory:" ? ":memory:" : join(dataDir, "migrator.db");
    this.db = new Database(location);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Upgrades databases created by earlier versions in place. */
  private migrate(): void {
    const has = (table: string, column: string) =>
      (
        this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).some((c) => c.name === column);
    if (!has("sessions", "user_id")) {
      // sessions from the single-password era have no owner: sign everyone in again
      this.db.exec(
        "DROP TABLE sessions; CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE CASCADE);",
      );
    }
    for (const [column, ddl] of [
      ["user_id", "TEXT REFERENCES users(id) ON DELETE CASCADE"],
      ["coolify_connection_id", "TEXT"],
      ["dokploy_connection_id", "TEXT"],
    ] as const) {
      if (!has("runs", column))
        this.db.exec(`ALTER TABLE runs ADD COLUMN ${column} ${ddl}`);
    }
  }

  // ---- users ----
  userCount(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }
    ).n;
  }
  createUser(email: string, passwordHash: string): User {
    const id = randomBytes(9).toString("base64url");
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, email, passwordHash, now);
    return { id, email, createdAt: now };
  }
  getUserByEmail(email: string): (User & { passwordHash: string }) | undefined {
    const row = this.db
      .prepare(
        "SELECT id, email, password_hash, created_at FROM users WHERE email = ?",
      )
      .get(email) as
      | { id: string; email: string; password_hash: string; created_at: number }
      | undefined;
    return row
      ? {
          id: row.id,
          email: row.email,
          createdAt: row.created_at,
          passwordHash: row.password_hash,
        }
      : undefined;
  }
  getUser(id: string): User | undefined {
    const row = this.db
      .prepare("SELECT id, email, created_at FROM users WHERE id = ?")
      .get(id) as { id: string; email: string; created_at: number } | undefined;
    return row
      ? { id: row.id, email: row.email, createdAt: row.created_at }
      : undefined;
  }
  touchLogin(userId: string): void {
    this.db
      .prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
      .run(Date.now(), userId);
  }
  /** Upgrade path: runs created before accounts existed belong to the first person who signs up. */
  adoptOrphanRuns(userId: string): number {
    return this.db
      .prepare("UPDATE runs SET user_id = ? WHERE user_id IS NULL")
      .run(userId).changes;
  }
  changePassword(userId: string, passwordHash: string): void {
    this.db
      .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run(passwordHash, userId);
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId); // sign out everywhere
  }

  // ---- sessions (token is random 256-bit; only its hash is stored) ----
  createSession(userId: string, ttlMs: number): string {
    const token = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        "INSERT INTO sessions (token_hash, expires_at, user_id) VALUES (?, ?, ?)",
      )
      .run(hashToken(token), Date.now() + ttlMs, userId);
    return token;
  }
  /** The signed-in user's id, or undefined for a missing, expired or unknown session. */
  sessionUser(token: string): string | undefined {
    const row = this.db
      .prepare("SELECT expires_at, user_id FROM sessions WHERE token_hash = ?")
      .get(hashToken(token)) as
      | { expires_at: number; user_id: string | null }
      | undefined;
    if (!row?.user_id) return undefined;
    if (row.expires_at <= Date.now()) {
      this.deleteSession(token);
      return undefined;
    }
    return row.user_id;
  }
  deleteSession(token: string): void {
    this.db
      .prepare("DELETE FROM sessions WHERE token_hash = ?")
      .run(hashToken(token));
  }

  // ---- saved connections ----
  private mapConnection(row: Record<string, unknown>): ConnectionRow {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      kind: row.kind as "coolify" | "dokploy",
      name: row.name as string,
      url: row.url as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      lastUsedAt: (row.last_used_at as number | null) ?? null,
      check: parse(row.check_json as string | null),
    };
  }
  createConnection(input: {
    userId: string;
    kind: "coolify" | "dokploy";
    name: string;
    url: string;
    secret: string;
    check: ConnectionRow["check"];
  }): ConnectionRow {
    const id = randomBytes(9).toString("base64url");
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO connections (id, user_id, kind, name, url, ciphertext, created_at, updated_at, check_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.userId,
        input.kind,
        input.name,
        input.url,
        seal(input.secret, this.masterKey),
        now,
        now,
        input.check ? JSON.stringify(input.check) : null,
      );
    return this.getConnection(id, input.userId) as ConnectionRow;
  }
  listConnections(userId: string): ConnectionRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM connections WHERE user_id = ? ORDER BY kind, name",
        )
        .all(userId) as Record<string, unknown>[]
    ).map((r) => this.mapConnection(r));
  }
  getConnection(id: string, userId: string): ConnectionRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM connections WHERE id = ? AND user_id = ?")
      .get(id, userId) as Record<string, unknown> | undefined;
    return row ? this.mapConnection(row) : undefined;
  }
  /** The decrypted secret. Only server code that is about to call the upstream may use this. */
  connectionSecret(id: string): string | undefined {
    const row = this.db
      .prepare("SELECT ciphertext FROM connections WHERE id = ?")
      .get(id) as { ciphertext: string } | undefined;
    return row ? openSealed(row.ciphertext, this.masterKey) : undefined;
  }
  /** URL + decrypted secret by id, for rebuilding a run's credentials. Server-internal. */
  connectionRaw(id: string): { url: string; secret: string } | undefined {
    const row = this.db
      .prepare("SELECT url, ciphertext FROM connections WHERE id = ?")
      .get(id) as { url: string; ciphertext: string } | undefined;
    return row
      ? { url: row.url, secret: openSealed(row.ciphertext, this.masterKey) }
      : undefined;
  }
  updateConnection(
    id: string,
    userId: string,
    patch: {
      name?: string;
      url?: string;
      secret?: string;
      check?: ConnectionRow["check"];
    },
  ): void {
    const sets = ["updated_at = ?"];
    const values: unknown[] = [Date.now()];
    const set = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.name !== undefined) set("name", patch.name);
    if (patch.url !== undefined) set("url", patch.url);
    if (patch.secret !== undefined)
      set("ciphertext", seal(patch.secret, this.masterKey));
    if (patch.check !== undefined)
      set("check_json", patch.check ? JSON.stringify(patch.check) : null);
    this.db
      .prepare(
        `UPDATE connections SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`,
      )
      .run(...values, id, userId);
  }
  touchConnection(id: string): void {
    this.db
      .prepare("UPDATE connections SET last_used_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }
  deleteConnection(id: string, userId: string): void {
    this.db
      .prepare("DELETE FROM connections WHERE id = ? AND user_id = ?")
      .run(id, userId);
  }
  /** Runs that still need this connection (so it cannot be deleted from under an apply). */
  activeRunsUsing(connectionId: string): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM runs WHERE (coolify_connection_id = ? OR dokploy_connection_id = ?) AND status IN ('running','paused','paused_failed')",
        )
        .get(connectionId, connectionId) as { n: number }
    ).n;
  }

  // ---- runs ----
  createRun(input: {
    userId: string;
    coolifyConnectionId: string;
    dokployConnectionId: string;
    name: string;
    coolifyUrl: string;
    dokployUrl: string;
    coolifyVersion?: string;
    dokployVersion?: string;
    credentials: Credentials;
  }): RunRow {
    const id = randomBytes(9).toString("base64url");
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO runs (id, user_id, coolify_connection_id, dokploy_connection_id, name, status, created_at, updated_at, expires_at, coolify_url, dokploy_url, coolify_version, dokploy_version, notice_accepted_at)
           VALUES (?, ?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.userId,
          input.coolifyConnectionId,
          input.dokployConnectionId,
          input.name,
          now,
          now,
          now + RUN_TTL,
          input.coolifyUrl,
          input.dokployUrl,
          input.coolifyVersion ?? null,
          input.dokployVersion ?? null,
          now,
        );
      this.setCredentials(id, input.credentials);
    })();
    return this.getRun(id) as RunRow;
  }

  private mapRun(row: Record<string, unknown>): RunRow {
    return {
      id: row.id as string,
      userId: (row.user_id as string | null) ?? null,
      coolifyConnectionId: (row.coolify_connection_id as string | null) ?? null,
      dokployConnectionId: (row.dokploy_connection_id as string | null) ?? null,
      name: row.name as string,
      status: row.status as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      expiresAt: row.expires_at as number,
      coolifyUrl: row.coolify_url as string,
      dokployUrl: row.dokploy_url as string,
      coolifyVersion: (row.coolify_version as string | null) ?? null,
      dokployVersion: (row.dokploy_version as string | null) ?? null,
      options: parse(row.options_json as string | null),
      ir: parse(row.ir_json as string | null),
      plan: parse<Plan>(row.plan_json as string | null),
      noticeAcceptedAt: (row.notice_accepted_at as number | null) ?? null,
    };
  }
  getRun(id: string): RunRow | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRun(row) : undefined;
  }
  /** `userId` limits the list to one person's runs; omit it only for server-internal sweeps. */
  listRuns(userId?: string): RunRow[] {
    const rows = (
      userId === undefined
        ? this.db.prepare("SELECT * FROM runs ORDER BY updated_at DESC").all()
        : this.db
            .prepare(
              "SELECT * FROM runs WHERE user_id = ? ORDER BY updated_at DESC",
            )
            .all(userId)
    ) as Record<string, unknown>[];
    return rows.map((r) => this.mapRun(r));
  }
  updateRun(
    id: string,
    patch: {
      status?: string;
      options?: unknown;
      ir?: unknown;
      plan?: Plan | null;
      dokployVersion?: string;
    },
  ): void {
    const sets: string[] = ["updated_at = ?", "expires_at = ?"];
    const values: unknown[] = [Date.now(), Date.now() + RUN_TTL];
    const set = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.options !== undefined)
      set("options_json", JSON.stringify(patch.options));
    if (patch.ir !== undefined) set("ir_json", JSON.stringify(patch.ir));
    if (patch.plan !== undefined)
      set("plan_json", patch.plan === null ? null : JSON.stringify(patch.plan));
    if (patch.dokployVersion !== undefined)
      set("dokploy_version", patch.dokployVersion);
    this.db
      .prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values, id);
  }
  deleteRun(id: string): void {
    this.db.prepare("DELETE FROM runs WHERE id = ?").run(id);
    this.redactors.delete(id);
  }

  // ---- credentials ----
  setCredentials(runId: string, credentials: Credentials): void {
    this.db
      .prepare(
        "INSERT INTO credentials (run_id, ciphertext, expires_at) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET ciphertext = excluded.ciphertext, expires_at = excluded.expires_at",
      )
      .run(
        runId,
        seal(JSON.stringify(credentials), this.masterKey),
        Date.now() + CRED_TTL,
      );
    this.redactors.delete(runId);
  }
  /** Returns undefined after the 24 h idle TTL; callers must ask the user to re-enter the key. */
  getCredentials(runId: string, touch = true): Credentials | undefined {
    const row = this.db
      .prepare(
        "SELECT ciphertext, expires_at FROM credentials WHERE run_id = ?",
      )
      .get(runId) as { ciphertext: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= Date.now()) return undefined;
    if (touch)
      this.db
        .prepare("UPDATE credentials SET expires_at = ? WHERE run_id = ?")
        .run(Date.now() + CRED_TTL, runId);
    return JSON.parse(
      openSealed(row.ciphertext, this.masterKey),
    ) as Credentials;
  }
  deleteCredentials(runId: string): void {
    this.db.prepare("DELETE FROM credentials WHERE run_id = ?").run(runId);
  }

  // ---- redaction: one registry per run, fed by credentials and every vault read ----
  redactor(runId: string): Redactor {
    let redactor = this.redactors.get(runId);
    if (!redactor) {
      redactor = new Redactor();
      const credentials = this.getCredentials(runId, false);
      redactor.add(credentials?.coolify.token);
      redactor.add(credentials?.dokploy.apiKey);
      this.redactors.set(runId, redactor);
    }
    return redactor;
  }

  // ---- vault ----
  vault(runId: string): Vault {
    const redactor = this.redactor(runId);
    return {
      put: async (value) => {
        const ref = `v_${randomBytes(12).toString("hex")}`;
        this.db
          .prepare(
            "INSERT INTO vault (run_id, ref, ciphertext) VALUES (?, ?, ?)",
          )
          .run(runId, ref, seal(value, this.masterKey));
        return ref;
      },
      get: async (ref) => {
        const row = this.db
          .prepare("SELECT ciphertext FROM vault WHERE run_id = ? AND ref = ?")
          .get(runId, ref) as { ciphertext: string } | undefined;
        if (!row) throw new Error(`Vault reference unavailable: ${ref}`);
        const value = openSealed(row.ciphertext, this.masterKey);
        redactor.add(value);
        return value;
      },
      purge: async () => this.purgeVault(runId),
    };
  }
  purgeVault(runId: string): void {
    this.db.prepare("DELETE FROM vault WHERE run_id = ?").run(runId);
  }
  vaultCount(runId: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM vault WHERE run_id = ?")
        .get(runId) as { n: number }
    ).n;
  }

  // ---- steps ----
  replaceSteps(runId: string, plan: Plan): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
      this.db.prepare("DELETE FROM id_map WHERE run_id = ?").run(runId);
      const insert = this.db.prepare(
        "INSERT INTO steps (run_id, seq, kind, label, src_id, intent, state, warnings_json) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
      );
      for (const step of plan.steps)
        insert.run(
          runId,
          step.seq,
          step.kind,
          step.label,
          step.srcId,
          step.intent,
          JSON.stringify(step.warnings),
        );
    })();
  }
  listSteps(runId: string): StepRow[] {
    return (
      this.db
        .prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY seq")
        .all(runId) as Record<string, unknown>[]
    ).map((r) => ({
      seq: r.seq as number,
      kind: r.kind as string,
      label: r.label as string,
      srcId: r.src_id as string,
      intent: r.intent as string,
      state: r.state as string,
      attempts: r.attempts as number,
      targetId: (r.target_id as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      warnings: JSON.parse(r.warnings_json as string) as string[],
      error: parse(r.error_json as string | null),
    }));
  }
  /** Persist one step transition. Error text is redacted before it is stored. */
  saveStep(runId: string, seq: number, record: StepRecord): void {
    const redactor = this.redactor(runId);
    const error = record.error
      ? JSON.stringify({
          ...record.error,
          message: redactor.redact(record.error.message),
          ...(record.error.hint
            ? { hint: redactor.redact(record.error.hint) }
            : {}),
        })
      : null;
    const warnings = record.warnings
      ? JSON.stringify(record.warnings.map((w) => redactor.redact(w)))
      : null;
    this.db
      .prepare(
        `UPDATE steps SET state = ?, attempts = ?, target_id = COALESCE(?, target_id), note = ?, error_json = ?,
           warnings_json = COALESCE(?, warnings_json),
           started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
           finished_at = CASE WHEN ? IN ('done','failed','skipped') THEN ? ELSE finished_at END
         WHERE run_id = ? AND seq = ?`,
      )
      .run(
        record.state,
        record.attempts,
        record.targetId ?? null,
        record.note ?? null,
        error,
        warnings,
        record.state,
        Date.now(),
        record.state,
        Date.now(),
        runId,
        seq,
      );
  }
  stepRecords(runId: string): Map<number, StepRecord> {
    const map = new Map<number, StepRecord>();
    for (const s of this.listSteps(runId)) {
      if (s.state === "done" || s.state === "skipped") {
        map.set(s.seq, {
          state: s.state as StepRecord["state"],
          attempts: s.attempts,
          ...(s.targetId ? { targetId: s.targetId } : {}),
        });
      }
    }
    return map;
  }
  /** After a crash: steps stuck in `running` are safe to redo (executors are idempotent). */
  resetRunningSteps(runId: string): void {
    this.db
      .prepare(
        "UPDATE steps SET state = 'pending' WHERE run_id = ? AND state = 'running'",
      )
      .run(runId);
  }
  resetStep(runId: string, seq: number): void {
    this.db
      .prepare(
        "UPDATE steps SET state = 'pending', error_json = NULL WHERE run_id = ? AND seq = ?",
      )
      .run(runId, seq);
  }

  // ---- id map ----
  idMap(runId: string): IdMapStore & {
    entries(): Array<{
      srcId: string;
      srcKind: string;
      targetId: string;
      created: boolean;
    }>;
  } {
    return {
      get: async (_run, srcId, srcKind) => {
        const row = this.db
          .prepare(
            "SELECT target_id, created FROM id_map WHERE run_id = ? AND src_id = ? AND src_kind = ?",
          )
          .get(runId, srcId, srcKind) as
          | { target_id: string; created: number }
          | undefined;
        return row
          ? { targetId: row.target_id, created: row.created === 1 }
          : undefined;
      },
      put: async (_run, srcId, srcKind, targetId, created) => {
        this.db
          .prepare(
            "INSERT INTO id_map (run_id, src_id, src_kind, target_id, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, src_id, src_kind) DO UPDATE SET target_id = excluded.target_id, created = excluded.created",
          )
          .run(runId, srcId, srcKind, targetId, created ? 1 : 0);
      },
      entries: () =>
        (
          this.db
            .prepare(
              "SELECT src_id, src_kind, target_id, created FROM id_map WHERE run_id = ?",
            )
            .all(runId) as Array<{
            src_id: string;
            src_kind: string;
            target_id: string;
            created: number;
          }>
        ).map((r) => ({
          srcId: r.src_id,
          srcKind: r.src_kind,
          targetId: r.target_id,
          created: r.created === 1,
        })),
    };
  }
  clearIdMap(runId: string): void {
    this.db.prepare("DELETE FROM id_map WHERE run_id = ?").run(runId);
  }

  // ---- events ----
  addEvent(
    runId: string,
    level: "info" | "warn" | "error",
    message: string,
    seq?: number,
  ): EventRow {
    const clean = this.redactor(runId).redact(message);
    const ts = Date.now();
    const info = this.db
      .prepare(
        "INSERT INTO events (run_id, ts, level, seq, message) VALUES (?, ?, ?, ?, ?)",
      )
      .run(runId, ts, level, seq ?? null, clean);
    return {
      id: Number(info.lastInsertRowid),
      ts,
      level,
      seq: seq ?? null,
      message: clean,
    };
  }
  listEvents(runId: string, afterId = 0, limit = 500): EventRow[] {
    return this.db
      .prepare(
        "SELECT id, ts, level, seq, message FROM events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?",
      )
      .all(runId, afterId, limit) as EventRow[];
  }

  // ---- checklist ----
  getChecklist(runId: string): Record<string, boolean> {
    const rows = this.db
      .prepare("SELECT item_id, done FROM checklist WHERE run_id = ?")
      .all(runId) as Array<{ item_id: string; done: number }>;
    return Object.fromEntries(rows.map((r) => [r.item_id, r.done === 1]));
  }
  setChecklistItem(runId: string, itemId: string, done: boolean): void {
    this.db
      .prepare(
        "INSERT INTO checklist (run_id, item_id, done, done_at) VALUES (?, ?, ?, ?) ON CONFLICT(run_id, item_id) DO UPDATE SET done = excluded.done, done_at = excluded.done_at",
      )
      .run(runId, itemId, done ? 1 : 0, done ? Date.now() : null);
  }

  // ---- retention ----
  purgeExpired(now = Date.now()): { credentials: number; runs: number } {
    const credentials = this.db
      .prepare("DELETE FROM credentials WHERE expires_at <= ?")
      .run(now).changes;
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    // a run without credentials can never apply again: its vault values are useless, drop them
    this.db
      .prepare(
        "DELETE FROM vault WHERE run_id NOT IN (SELECT run_id FROM credentials)",
      )
      .run();
    const runs = this.db
      .prepare("DELETE FROM runs WHERE expires_at <= ?")
      .run(now).changes;
    return { credentials, runs };
  }
}
