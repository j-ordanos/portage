export type RunStatus =
  | "draft"
  | "connected"
  | "discovering"
  | "discovered"
  | "selected"
  | "reported"
  | "configured"
  | "planned"
  | "running"
  | "paused"
  | "paused_failed"
  | "applied"
  | "verifying"
  | "verified"
  | "completed"
  | "cancelled"
  | "failed"
  | "rolled_back"
  | "purged";

const allowed: Partial<Record<RunStatus, RunStatus[]>> = {
  draft: ["connected", "cancelled"],
  connected: ["discovering", "cancelled"],
  discovering: ["discovered", "paused_failed", "failed", "cancelled"],
  discovered: ["selected", "cancelled"],
  selected: ["reported", "configured", "cancelled"],
  reported: ["configured", "cancelled"],
  configured: ["planned", "cancelled"],
  planned: ["running", "cancelled"],
  running: ["paused", "paused_failed", "applied", "failed", "cancelled"],
  paused: ["running", "cancelled"],
  paused_failed: ["running", "cancelled", "failed"],
  applied: ["verifying", "verified", "completed", "cancelled"],
  verifying: ["verified", "paused_failed", "failed", "cancelled"],
  verified: ["completed", "cancelled", "rolled_back"],
  completed: ["purged", "rolled_back"],
  cancelled: ["purged"],
  failed: ["purged", "paused_failed"],
  rolled_back: ["purged"],
};

export function transitionRun(current: RunStatus, next: RunStatus): RunStatus {
  if (allowed[current]?.includes(next)) return next;
  throw new Error(`Illegal run transition: ${current} -> ${next}`);
}
