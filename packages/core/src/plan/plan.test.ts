import { describe, expect, it } from "vitest";
import { IR } from "../ir/schema.js";
import { buildPlan, validatePlan } from "./build-plan.js";
import type { Options } from "./types.js";

const options: Options = {
  selection: { includeSrcIds: ["app-1"], decisions: { "app-1": "migrate" } },
  target: { envStrategy: "map", collisionPolicy: "suffix", suffix: "migrated" },
  secrets: { defaultMode: "names-only", perVar: {} },
  domains: { policy: "temp-suffix", tempBase: "migrate.example.com", map: {} },
  updateAdopted: false,
};

const ir = IR.parse({
  irVersion: 1,
  source: {
    url: "https://coolify.example",
    version: "4.3.1",
    readAt: "2026-11-20T00:00:00Z",
  },
  teamSharedEnv: [],
  projects: [
    {
      srcId: "project-1",
      name: "Acme",
      sharedEnv: [],
      environments: [
        {
          srcId: "env-1",
          name: "production",
          sharedEnv: [],
          resources: [
            {
              kind: "application",
              srcId: "app-1",
              name: "API",
              projectSrcId: "project-1",
              environmentName: "production",
              compat: "auto",
              issues: [],
              selected: true,
              decision: "migrate",
              source: {
                type: "git",
                repo: "https://example.com/api.git",
                branch: "main",
                provider: "public",
              },
              build: { pack: "nixpacks", rawPack: "nixpacks" },
              ports: [3000],
              domains: [
                {
                  host: "api.example.com",
                  https: true,
                  source: "api.example.com",
                },
              ],
              env: [],
              mounts: [],
            },
          ],
        },
      ],
    },
  ],
  servers: [],
  notes: [],
});

describe("plan builder", () => {
  it("builds a deterministic ordered plan without network access", () => {
    const first = buildPlan(ir, options);
    const second = buildPlan(ir, options);
    expect(first).toEqual(second);
    expect(first.steps.map((step) => step.kind)).toEqual([
      "CREATE_PROJECT",
      "ENSURE_ENVIRONMENT",
      "CREATE_APPLICATION",
      "CONFIGURE_SOURCE",
      "CONFIGURE_BUILD",
      "SET_ENV",
      "CREATE_DOMAIN",
    ]);
  });

  it("validates dependencies", () => {
    expect(validatePlan(buildPlan(ir, options))).toEqual([]);
  });
});
