import {
  AppError,
  type ApplyContext,
  runPlan,
  type StepRecord,
} from "@migrator/core";
import type { Store } from "../db/store.js";
import type { EventHub } from "./hub.js";
import type { RunService } from "./service.js";
import { parseUserOptions, toCoreOptions } from "./user-options.js";

interface Active {
  stop: "pause" | "cancel" | null;
  done: Promise<void>;
}

/**
 * Runs plans in the background, one active run per Dokploy URL.
 * State lives in SQLite, so a crash or restart resumes from the first unfinished step.
 */
export class ApplyManager {
  private readonly active = new Map<string, Active>();

  constructor(
    private readonly service: RunService,
    private readonly store: Store,
    private readonly hub: EventHub,
    private readonly options: {
      sleep?: (ms: number) => Promise<void>;
      pauseBetweenWritesMs?: number;
    } = {},
  ) {}

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Resolves when the background run for `runId` finished (used by tests and graceful shutdown). */
  async idle(runId: string): Promise<void> {
    await this.active.get(runId)?.done;
  }

  start(runId: string): void {
    const run = this.service.getRun(runId);
    if (this.active.has(runId))
      throw Object.assign(
        new AppError("RUN_LOCKED", "This run is already applying"),
        { status: 409 },
      );
    if (!run.plan)
      throw Object.assign(
        new AppError("CONFIG_INVALID", "Create a plan before applying"),
        { status: 409 },
      );
    if (
      !["planned", "paused", "paused_failed", "running"].includes(run.status)
    ) {
      throw Object.assign(
        new AppError(
          "RUN_LOCKED",
          `Cannot apply a run in status '${run.status}'`,
        ),
        { status: 409 },
      );
    }
    const clash = this.store
      .listRuns()
      .find(
        (r) =>
          r.id !== runId &&
          r.dokployUrl === run.dokployUrl &&
          r.status === "running",
      );
    if (clash) {
      throw Object.assign(
        new AppError(
          "RUN_LOCKED",
          "Another migration is already writing to this Dokploy",
          { hint: "Wait for it to finish or pause it." },
        ),
        { status: 409 },
      );
    }
    this.service.credentials(runId); // fail now (401) rather than inside the background task

    const state: Active = { stop: null, done: Promise.resolve() };
    this.active.set(runId, state);
    this.store.updateRun(runId, { status: "running" });
    this.emit(runId, "info", "Apply started");
    state.done = this.loop(runId, state).finally(() =>
      this.active.delete(runId),
    );
  }

  private emit(
    runId: string,
    level: "info" | "warn" | "error",
    message: string,
    seq?: number,
  ) {
    this.hub.emit(runId, this.store.addEvent(runId, level, message, seq));
  }

  private async loop(runId: string, state: Active): Promise<void> {
    try {
      const run = this.service.getRun(runId);
      const plan = run.plan;
      if (!plan) return;
      const creds = this.service.credentials(runId);
      const ir = this.service.ir(runId);
      const ctx: ApplyContext = {
        runId,
        dokploy: this.service.deps.dokploy(creds.dokploy),
        vault: this.store.vault(runId),
        idMap: this.store.idMap(runId),
        options: toCoreOptions(ir, parseUserOptions(run.options)),
      };
      this.store.resetRunningSteps(runId);
      const initial = this.store.stepRecords(runId);
      const byseq = new Map(plan.steps.map((s) => [s.seq, s]));
      const outcome = await runPlan(plan, ctx, {
        initial,
        hooks: {
          ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
          shouldStop: () => state.stop !== null,
          onUpdate: async (step, record: StepRecord) => {
            this.store.saveStep(runId, step.seq, record);
            const redact = (t: string) => this.store.redactor(runId).redact(t);
            if (record.state === "done")
              this.emit(
                runId,
                "info",
                `${step.label}${record.note ? ` — ${redact(record.note)}` : ""}`,
                step.seq,
              );
            else if (record.state === "failed")
              this.emit(
                runId,
                "error",
                `${step.label} failed: ${redact(record.error?.message ?? "unknown error")}`,
                step.seq,
              );
            else if (record.state === "skipped")
              this.emit(
                runId,
                "warn",
                `${step.label} skipped${record.note ? ` (${record.note})` : ""}`,
                step.seq,
              );
            else if (record.state === "running" && record.attempts > 1)
              this.emit(
                runId,
                "warn",
                `${step.label}: retrying (attempt ${record.attempts})`,
                step.seq,
              );
            for (const w of record.warnings ?? [])
              this.emit(runId, "warn", redact(w), step.seq);
            if (record.state === "done" && this.options.pauseBetweenWritesMs) {
              await (
                this.options.sleep ??
                ((ms: number) => new Promise((r) => setTimeout(r, ms)))
              )(this.options.pauseBetweenWritesMs);
            }
            void byseq;
          },
        },
      });
      if (outcome.status === "completed") {
        this.store.purgeVault(runId); // values are no longer needed once everything is written
        this.store.updateRun(runId, { status: "applied" });
        this.emit(
          runId,
          "info",
          "Apply finished: resources were created but NOT deployed",
        );
      } else if (outcome.status === "failed") {
        this.store.updateRun(runId, { status: "paused_failed" });
        this.emit(
          runId,
          "error",
          "Apply paused: a step failed. Retry it, skip it, or roll back.",
        );
      } else if (state.stop === "cancel") {
        this.store.updateRun(runId, { status: "cancelled" });
        this.emit(
          runId,
          "warn",
          "Apply cancelled. Resources already created remain in Dokploy (use rollback to remove them).",
        );
      } else {
        this.store.updateRun(runId, { status: "paused" });
        this.emit(runId, "info", "Apply paused");
      }
    } catch (error) {
      const message =
        error instanceof AppError
          ? error.message
          : "Apply stopped unexpectedly";
      this.store.updateRun(runId, { status: "paused_failed" });
      this.emit(runId, "error", message);
    }
  }

  /** Finishes the current step, then stops. */
  pause(runId: string): void {
    const state = this.active.get(runId);
    if (state) state.stop = "pause";
  }
  cancel(runId: string): void {
    const state = this.active.get(runId);
    if (state) state.stop = "cancel";
    else this.store.updateRun(runId, { status: "cancelled" });
  }
  retry(runId: string, seq: number): void {
    this.store.resetStep(runId, seq);
    this.start(runId);
  }
  /** Skips a failed step; its dependents are skipped by the runner. */
  skip(runId: string, seq: number): void {
    this.store.saveStep(runId, seq, {
      state: "skipped",
      attempts: 0,
      note: "skipped by user",
    });
    this.start(runId);
  }

  /** On boot: runs that were `running` when the process died continue where they stopped. */
  resumeInterrupted(): number {
    let resumed = 0;
    for (const run of this.store
      .listRuns()
      .filter((r) => r.status === "running")) {
      try {
        this.store.updateRun(run.id, { status: "paused" }); // allow start()'s status gate
        this.start(run.id);
        resumed++;
      } catch {
        this.store.updateRun(run.id, { status: "paused_failed" });
      }
    }
    return resumed;
  }
}
