import { describe, expect, it } from "vitest";
import { resetCrashedSteps } from "./worker.js";

describe("worker crash recovery", () => {
  it("moves running steps back to pending", () => {
    expect(
      resetCrashedSteps([
        { seq: 1, state: "done" },
        { seq: 2, state: "running" },
        { seq: 3, state: "pending" },
      ]),
    ).toEqual([
      { seq: 1, state: "done" },
      { seq: 2, state: "pending" },
      { seq: 3, state: "pending" },
    ]);
  });
});
