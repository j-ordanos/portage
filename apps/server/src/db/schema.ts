import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  coolifyUrl: text("coolify_url").notNull(),
  dokployUrl: text("dokploy_url").notNull(),
  coolifyVersion: text("coolify_version"),
  dokployVersion: text("dokploy_version"),
  dokployAuthStyle: text("dokploy_auth_style"),
  optionsJson: text("options_json").notNull(),
  irJson: text("ir_json"),
  planJson: text("plan_json"),
  noticeAcceptedAt: integer("notice_accepted_at"),
  expiresAt: integer("expires_at").notNull(),
});

export const steps = sqliteTable(
  "steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    srcId: text("src_id").notNull(),
    state: text("state").notNull(),
    intent: text("intent").notNull(),
    payloadJson: text("payload_json").notNull(),
    targetId: text("target_id"),
    attempts: integer("attempts").notNull().default(0),
    errorJson: text("error_json"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (table) => [index("steps_state").on(table.runId, table.state)],
);

export const credentials = sqliteTable("credentials", {
  runId: text("run_id").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const idMap = sqliteTable(
  "id_map",
  {
    runId: text("run_id").notNull(),
    srcId: text("src_id").notNull(),
    srcKind: text("src_kind").notNull(),
    targetId: text("target_id").notNull(),
    created: integer("created", { mode: "boolean" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.srcId, table.srcKind] }),
  ],
);

export const vault = sqliteTable(
  "vault",
  {
    runId: text("run_id").notNull(),
    ref: text("ref").notNull(),
    ciphertext: text("ciphertext").notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.ref] })],
);

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull(),
  ts: integer("ts").notNull(),
  level: text("level").notNull(),
  stepId: text("step_id"),
  message: text("message").notNull(),
});

export const checklist = sqliteTable(
  "checklist",
  {
    runId: text("run_id").notNull(),
    itemId: text("item_id").notNull(),
    done: integer("done", { mode: "boolean" }).notNull().default(false),
    doneAt: integer("done_at"),
  },
  (table) => [primaryKey({ columns: [table.runId, table.itemId] })],
);

export const authAudit = sqliteTable("auth_audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: integer("ts").notNull(),
  ip: text("ip"),
  ok: integer("ok", { mode: "boolean" }).notNull(),
});
