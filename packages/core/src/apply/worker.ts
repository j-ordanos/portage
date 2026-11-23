export type StepState = "pending" | "running" | "done" | "failed" | "skipped";

export interface WorkerStep {
  seq: number;
  state: StepState;
  run(
    step: () => Promise<{ targetId?: string }>,
  ): Promise<{ targetId?: string }>;
}

export function resetCrashedSteps<T extends { state: StepState }>(
  steps: T[],
): T[] {
  return steps.map((step) =>
    step.state === "running" ? { ...step, state: "pending" } : step,
  );
}
