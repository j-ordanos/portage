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

describe("router", () => {
  it("parses every route and builds the same link back", async () => {
    const { parse, href } = await import("./router");
    const cases = [
      "#/",
      "#/docs",
      "#/docs/security",
      "#/settings",
      "#/settings/account",
      "#/new",
      "#/run/abc123",
      "#/run/abc123/review",
    ];
    for (const hash of cases) expect(href(parse(hash)), hash).toBe(hash);
    expect(parse("")).toEqual({ page: "home" });
    expect(parse("#/run")).toEqual({ page: "home" });
    expect(parse("#/nonsense")).toEqual({ page: "home" });
    expect(parse("#/run/xyz/finish")).toEqual({
      page: "run",
      id: "xyz",
      stage: "finish",
    });
  });
});

describe("relative time", () => {
  it("speaks plainly about when something happened", async () => {
    const { ago } = await import("./ui");
    const now = 1_000_000_000_000;
    expect(ago(now - 10_000, now)).toBe("just now");
    expect(ago(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(ago(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(ago(now - 2 * 86_400_000, now)).toBe("2 d ago");
  });
});

describe("plain-language helpers", () => {
  it("never shows a double v, a rule id, or an unfinished sentence", async () => {
    const { ver, plural, plain, sentence } = await import("./ui");
    expect(ver("v0.31.4")).toBe("v0.31.4");
    expect(ver("4.7.5")).toBe("v4.7.5");
    expect(ver(null)).toBe("");
    expect(plural(1, "resource")).toBe("1 resource");
    expect(plural(0, "resource")).toBe("0 resources");
    expect(plain("R-073: One-click template settings require re-entry")).toBe(
      "One-click template settings require re-entry",
    );
    expect(plain("Git access linked: yes")).toBe("Git access linked: yes");
    expect(
      sentence(
        "Database definition is copied; data is not",
        "Create and restore a backup separately",
      ),
    ).toBe(
      "Database definition is copied; data is not. Create and restore a backup separately.",
    );
    expect(sentence("Already ends well.", "Fix it.")).toBe(
      "Already ends well. Fix it.",
    );
    expect(sentence("No fix")).toBe("No fix.");
  });
});
