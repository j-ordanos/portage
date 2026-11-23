import { describe, expect, it } from "vitest";
import { IR } from "../ir/schema.js";
import { renderCompatJson, renderManifest } from "./report.js";

const ir = IR.parse({
  irVersion: 1,
  source: {
    url: "https://coolify.example",
    version: "4.3.1",
    readAt: "2026-11-20T00:00:00Z",
  },
  teamSharedEnv: [],
  projects: [],
  servers: [],
  notes: [],
});

describe("exports", () => {
  it("renders compatibility JSON deterministically", () => {
    expect(JSON.parse(renderCompatJson(ir)).irVersion).toBe(1);
  });

  it("renders a secret-free manifest", () => {
    const manifest = renderManifest(
      ir,
      { planVersion: 1, createdAt: "2026-11-20T00:00:00Z", steps: [] },
      [],
      {
        id: "run-1",
        createdAt: "2026-11-20T00:00:00Z",
        targetUrl: "https://dokploy.example",
      },
    );
    expect(manifest).not.toContain("CANARY_SECRET");
    expect(manifest).not.toContain("valueRef");
    expect(JSON.parse(manifest).manifestVersion).toBe(1);
  });
});
