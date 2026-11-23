import { describe, expect, it } from "vitest";
import { groupSteps } from "./Review";
import { type Step, stageOf } from "./types";

const step = (over: Partial<Step>): Step => ({
  seq: 1,
  kind: "CREATE_PROJECT",
  label: "Create project Acme",
  srcId: "p",
  intent: "create",
  state: "pending",
  attempts: 0,
  note: null,
  warnings: [],
  error: null,
  ...over,
});

describe("stageOf", () => {
  it("sends every run status to the right screen so any page can be reloaded", () => {
    expect(stageOf("connected")).toBe("connect");
    expect(stageOf("discovered")).toBe("choose");
    expect(stageOf("selected")).toBe("choose");
    expect(stageOf("planned")).toBe("review");
    for (const s of ["running", "paused", "paused_failed"])
      expect(stageOf(s)).toBe("migrate");
    for (const s of ["applied", "verified", "rolled_back", "cancelled"])
      expect(stageOf(s)).toBe("finish");
  });
});

describe("groupSteps", () => {
  it("collapses the raw steps into one row per created resource and merges warnings", () => {
    const groups = groupSteps([
      step({ seq: 1 }),
      step({
        seq: 2,
        kind: "ENSURE_ENVIRONMENT",
        srcId: "e",
        label: "Ensure environment production",
      }),
      step({
        seq: 3,
        kind: "CREATE_APPLICATION",
        srcId: "a",
        label: "Create application web",
        warnings: ["R-020: x"],
      }),
      step({
        seq: 4,
        kind: "CONFIGURE_SOURCE",
        srcId: "a",
        warnings: ["Private repository"],
      }),
      step({ seq: 5, kind: "SET_ENV", srcId: "a", warnings: ["R-020: x"] }),
      step({
        seq: 6,
        kind: "CREATE_DATABASE",
        srcId: "d",
        label: "Create postgres database pg",
      }),
    ]);
    expect(groups.map((g) => g.head.seq)).toEqual([1, 3, 6]);
    expect(groups[1]).toMatchObject({
      extras: 2,
      warnings: ["R-020: x", "Private repository"],
    });
  });
});

describe("rename preview", () => {
  it("adds the marker until the name is free, ignoring case", async () => {
    const { renamed } = await import("./Choose");
    expect(renamed("name-saver", ["Name-Saver", "Other"], "*")).toBe(
      "name-saver*",
    );
    expect(renamed("name-saver", ["Name-Saver", "name-saver*"], "*")).toBe(
      "name-saver**",
    );
    expect(renamed("fresh", ["Name-Saver"], "*")).toBe("fresh");
    expect(renamed("a", ["A"], "-copy")).toBe("a-copy");
  });
});

describe("todoItems", () => {
  it("takes only the manual to-do section of the report", async () => {
    const { todoItems } = await import("./Finish");
    const md =
      "# Report\n\n## Created\n- [ ] not this\n\n## Manual to-do\n\n- [ ] **Relink Git** for `web`\n- [ ] Enter values\n\n## Data\n- [ ] nor this\n";
    expect(todoItems(md)).toEqual(["**Relink Git** for `web`", "Enter values"]);
    expect(todoItems("# nothing")).toEqual([]);
  });
});
