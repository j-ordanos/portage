import { describe, expect, it } from "vitest";
import { transitionRun } from "./transitions.js";

describe("run transitions", () => {
  it("allows the normal migration lifecycle", () => {
    expect(transitionRun("draft", "connected")).toBe("connected");
    expect(transitionRun("planned", "running")).toBe("running");
    expect(transitionRun("running", "applied")).toBe("applied");
  });

  it("rejects illegal transitions", () => {
    expect(() => transitionRun("draft", "completed")).toThrow(
      "Illegal run transition",
    );
  });
});
