import { describe, expect, it } from "vitest";
import { transitionRun } from "./transitions.js";

describe("run transitions", () => {
  it("allows the normal migration lifecycle", () => {
    expect(transitionRun("draft", "connected")).toBe("connected");
    expect(transitionRun("planned", "running")).toBe("running");
    expect(transitionRun("running", "applied")).toBe("applied");
  });

  it("lets users go back and re-plan or re-discover before applying", () => {
    expect(transitionRun("planned", "selected")).toBe("selected");
    expect(transitionRun("selected", "discovering")).toBe("discovering");
    expect(transitionRun("applied", "rolled_back")).toBe("rolled_back");
  });

  it("rejects illegal transitions", () => {
    expect(() => transitionRun("rolled_back", "running")).toThrow("Illegal");
    expect(() => transitionRun("draft", "completed")).toThrow(
      "Illegal run transition",
    );
  });
});
