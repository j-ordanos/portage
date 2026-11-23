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

// Users can go back (re-select, re-plan, re-discover), so planning-phase states are freely re-enterable.
const planning: RunStatus[] = [
  "connected",
  "discovering",
  "discovered",
  "selected",
  "reported",
  "configured",
  "planned",
];
const allowed: Partial<Record<RunStatus, RunStatus[]>> = {
  draft: ["connected", "cancelled"],
  connected: ["discovering", "cancelled"],
  discovering: ["discovered", "paused_failed", "failed", "cancelled"],
  discovered: [...planning, "cancelled"],
  selected: [...planning, "cancelled"],
  reported: [...planning, "cancelled"],
  configured: [...planning, "cancelled"],
  planned: [...planning, "running", "cancelled"],
  running: ["paused", "paused_failed", "applied", "failed", "cancelled"],
  paused: ["running", "cancelled", "rolled_back"],
  paused_failed: ["running", "cancelled", "failed", "rolled_back"],
  applied: ["verifying", "verified", "completed", "cancelled", "rolled_back"],
  verifying: ["verified", "applied", "paused_failed", "failed", "cancelled"],
  verified: ["verifying", "completed", "cancelled", "rolled_back"],
  completed: ["purged", "rolled_back"],
  cancelled: ["purged", "rolled_back"],
  failed: ["purged", "paused_failed", "rolled_back"],
  rolled_back: ["purged"],
};

export function transitionRun(current: RunStatus, next: RunStatus): RunStatus {
  if (allowed[current]?.includes(next)) return next;
  throw new Error(`Illegal run transition: ${current} -> ${next}`);
}
