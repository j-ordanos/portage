export type Compat = "auto" | "partial" | "manual";
export interface Issue {
  ruleId: string;
  severity: "info" | "warn" | "error";
  message: string;
  fix?: string;
}
export interface InvResource {
  srcId: string;
  name: string;
  kind: "application" | "compose" | "database";
  compat: Compat;
  issues: Issue[];
  selected: boolean;
  blocked: boolean;
  summary: string;
}
export interface Inventory {
  source: { url: string; version: string };
  notes: Issue[];
  servers: Array<{ srcId: string; name: string }>;
  projects: Array<{
    srcId: string;
    name: string;
    environments: Array<{
      srcId: string;
      name: string;
      resources: InvResource[];
    }>;
  }>;
}
export interface RunView {
  id: string;
  name: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  coolifyUrl: string;
  dokployUrl: string;
  coolifyVersion: string | null;
  dokployVersion: string | null;
  hasInventory: boolean;
  hasPlan: boolean;
  applying: boolean;
  credentialsActive: boolean;
  progress: { total: number; done: number; failed: number; skipped: number };
}
export interface RunListItem {
  id: string;
  name: string;
  status: string;
  updatedAt: number;
  coolifyUrl: string;
  dokployUrl: string;
}
export interface Step {
  seq: number;
  kind: string;
  label: string;
  srcId: string;
  intent: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
  attempts: number;
  note: string | null;
  warnings: string[];
  error: { code: string; message: string; hint?: string } | null;
}
export interface PlanView {
  status: string;
  steps: Step[];
  notes: string[];
  hasPlan: boolean;
}
export interface UserOptions {
  include?: string[];
  acknowledge: string[];
  collisionPolicy: "suffix" | "adopt" | "skip";
  collisionMarker: string;
  envStrategy: "map" | "flatten";
  secretsMode: "import-values" | "names-only";
  serverId?: string;
  domainPolicy: "keep-original" | "temp-suffix" | "custom";
  tempBase?: string;
  gitOverrides: Record<
    string,
    { githubId?: string; sshKeyId?: string; url?: boolean }
  >;
}
export interface LogEvent {
  id: number;
  ts: number;
  level: "info" | "warn" | "error";
  seq: number | null;
  message: string;
}
export interface VerifyCheck {
  resource: string;
  check: string;
  status: "pass" | "fail" | "warn";
  detail?: string;
}
export interface Rollback {
  runName: string;
  confirmPhrase: string;
  items: Array<{ kind: string; label: string }>;
}

/** Where a run belongs in the guided flow, derived from its server-side status. */
export function stageOf(
  status: string,
): "connect" | "choose" | "review" | "migrate" | "finish" {
  if (["running", "paused", "paused_failed"].includes(status)) return "migrate";
  if (
    [
      "applied",
      "verifying",
      "verified",
      "completed",
      "rolled_back",
      "cancelled",
      "failed",
      "purged",
    ].includes(status)
  )
    return "finish";
  if (status === "planned") return "review";
  if (
    [
      "discovered",
      "selected",
      "reported",
      "configured",
      "discovering",
    ].includes(status)
  )
    return "choose";
  return "connect";
}
export type RollbackPreview = Rollback;

export type GitLink =
  | { kind: "github"; githubId: string; label: string; reason: string }
  | { kind: "ssh"; sshKeyId: string; label: string; reason: string }
  | { kind: "url"; reason: string };

export interface GitResource {
  srcId: string;
  name: string;
  project: string;
  repo: string;
  branch: string;
  provider: string;
  coolify: { appName?: string; appOrg?: string; keyName?: string };
  resolved: GitLink;
  candidates: {
    github: Array<{
      githubId: string;
      label: string;
      hasAccess: boolean | null;
    }>;
    ssh: Array<{
      sshKeyId: string;
      label: string;
      match: "fingerprint" | "name" | null;
    }>;
  };
  overridden: boolean;
}
export interface GitView {
  github: Array<{ githubId: string; label: string; reposKnown: boolean }>;
  ssh: Array<{ sshKeyId: string; label: string }>;
  resources: GitResource[];
}

export interface Connection {
  id: string;
  kind: "coolify" | "dokploy";
  name: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  check: { ok: boolean; version?: string; message?: string; at: number } | null;
}
