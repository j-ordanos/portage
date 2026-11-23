import { AppError } from "../errors.js";
import type { Plan, Step } from "../plan/types.js";
import { type ApplyContext, executeStep, type StepResult } from "./executor.js";

import type { StepState } from "./worker.js";

export interface StepRecord {
  state: StepState;
  attempts: number;
  targetId?: string;
  created?: boolean;
  note?: string;
  warnings?: string[];
  error?: { code: string; message: string; hint?: string };
}

export interface RunHooks {
  /** Called after every state change; persist here. */
  onUpdate?: (step: Step, record: StepRecord) => void | Promise<void>;
  /** Checked between steps; return true to stop (pause/cancel). */
  shouldStop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Backoff between retries of retryable errors. Default 1s, 3s, 9s. */
  backoffMs?: number[];
}

export interface RunOutcome {
  status: "completed" | "failed" | "stopped";
  records: Map<number, StepRecord>;
  failedSeq?: number;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Execute a plan in order. Resumable: pass `initial` records and finished steps are not repeated.
 * A failing step stops the run (`failed`); steps that depend on a failed/skipped step are skipped.
 * Retries only retryable errors; creating executors look for their own marker first, so a retry
 * after a lost response cannot create a duplicate.
 */
export async function runPlan(
  plan: Plan,
  ctx: ApplyContext,
  options: { initial?: Map<number, StepRecord>; hooks?: RunHooks } = {},
): Promise<RunOutcome> {
  const hooks = options.hooks ?? {};
  const sleep = hooks.sleep ?? realSleep;
  const backoff = hooks.backoffMs ?? [1000, 3000, 9000];
  const records = new Map<number, StepRecord>(options.initial ?? []);

  const update = async (step: Step, record: StepRecord) => {
    records.set(step.seq, record);
    await hooks.onUpdate?.(step, record);
  };

  for (const step of [...plan.steps].sort((a, b) => a.seq - b.seq)) {
    const existing = records.get(step.seq);
    if (existing?.state === "done" || existing?.state === "skipped") continue;
    if (hooks.shouldStop?.()) return { status: "stopped", records };

    const blocked = step.dependsOn.some((dep) => {
      const state = records.get(dep)?.state;
      return state === "failed" || state === "skipped";
    });
    if (blocked) {
      await update(step, {
        state: "skipped",
        attempts: 0,
        note: "dependency skipped",
      });
      continue;
    }

    let attempts = existing?.attempts ?? 0;
    while (true) {
      attempts++;
      await update(step, { state: "running", attempts });
      try {
        const result: StepResult = await executeStep(step, ctx);
        await update(step, {
          state: "done",
          attempts,
          ...(result.targetId ? { targetId: result.targetId } : {}),
          ...(result.created !== undefined ? { created: result.created } : {}),
          ...(result.note ? { note: result.note } : {}),
          ...(result.warnings?.length ? { warnings: result.warnings } : {}),
        });
        break;
      } catch (error) {
        const appError =
          error instanceof AppError
            ? error
            : new AppError(
                "INTERNAL",
                "Unexpected error while executing a step",
              );
        const retryIndex = attempts - (existing?.attempts ?? 0) - 1;
        if (appError.retryable && retryIndex < backoff.length) {
          await sleep(backoff[retryIndex] ?? 9000);
          continue;
        }
        await update(step, {
          state: "failed",
          attempts,
          error: {
            code: appError.code,
            message: appError.message,
            ...(appError.hint ? { hint: appError.hint } : {}),
          },
        });
        return { status: "failed", records, failedSeq: step.seq };
      }
    }
  }
  return { status: "completed", records };
}
