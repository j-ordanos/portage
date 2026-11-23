import { describe, expect, it } from "vitest";
import {
  IR,
  IRApplication,
  type IRApplication as IRApplicationType,
  type IRDatabase,
} from "../ir/schema.js";
import { analyzeCompose, resolveComposeDefaults } from "./compose.js";
import { mapDomains, parseDomain, validDomainHost } from "./domains.js";
import {
  buildEnvString,
  normalizeEnv,
  rewriteSharedRefs,
  serializeValue,
} from "./env.js";
import { runRules } from "./rules.js";

function application(
  overrides: Partial<IRApplicationType> = {},
): IRApplicationType {
  return IRApplication.parse({
    kind: "application",
    srcId: "app-1",
    name: "API",
    projectSrcId: "project-1",
    environmentName: "production",
    compat: "auto",
    issues: [],
    source: {
      type: "git",
      repo: "https://github.com/acme/api",
      branch: "main",
      provider: "public",
    },
    build: { pack: "nixpacks", rawPack: "nixpacks" },
    ports: [],
    domains: [],
    env: [],
    mounts: [],
    ...overrides,
  });
}

function inventory(resources: unknown[]): IR {
  return IR.parse({
    irVersion: 1,
    source: {
      url: "https://coolify.example",
      version: "4.3.1",
      readAt: "2026-11-20T00:00:00.000Z",
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
            resources,
          },
        ],
      },
    ],
    servers: [],
    notes: [],
  });
}

describe("compatibility rules", () => {
  it("marks static builds partial and unknown builds manual", () => {
    const staticIr = runRules(
      inventory([
        application({
          build: { pack: "static", rawPack: "static", publishDir: "dist" },
        }),
      ]),
    );
    expect(staticIr.projects[0]?.environments[0]?.resources[0]?.compat).toBe(
      "partial",
    );

    const unknownIr = runRules(
      inventory([
        application({
          build: { pack: "other", rawPack: "custom-pack" },
        }),
      ]),
    );
    expect(unknownIr.projects[0]?.environments[0]?.resources[0]?.compat).toBe(
      "manual",
    );
  });

  it("is deterministic and adds database definition issues", () => {
    const db: IRDatabase = {
      kind: "database",
      srcId: "db-1",
      name: "Postgres",
      projectSrcId: "project-1",
      environmentName: "production",
      compat: "auto",
      issues: [],
      selected: true,
      decision: "migrate",
      engine: "postgres",
      image: "postgres:16",
      passwordRef: null,
      passwordAvailability: "missing",
      publiclyExposed: false,
      mounts: [],
      backupsConfigured: false,
    };
    const ir = inventory([db]);
    expect(runRules(ir)).toEqual(runRules(ir));
  });
});

describe("environment transformation", () => {
  it("normalizes variables, rewrites refs, and safely quotes values", () => {
    const vars = [
      {
        key: "Z",
        availability: "available" as const,
        valueRef: "v_1",
        isSecretGuess: false,
        refs: [],
        scope: "runtime" as const,
        isPreview: false,
        isMultiline: false,
        isLiteral: false,
      },
      {
        key: "A",
        availability: "available" as const,
        valueRef: "v_2",
        isSecretGuess: false,
        refs: [],
        scope: "runtime" as const,
        isPreview: false,
        isMultiline: false,
        isLiteral: false,
      },
    ];
    expect(normalizeEnv(vars).map((value) => value.key)).toEqual(["A", "Z"]);
    expect(serializeValue("hello world")).toBe('"hello world"');
    expect(serializeValue("hash#tag")).toBe('"hash#tag"');
    expect(serializeValue("line1\nline2")).toBe('"line1\\nline2"');
    expect(rewriteSharedRefs("{{ project.DB_URL }}")).toBe(
      "${{project.DB_URL}}",
    );
  });

  it("builds one env string and never guesses unavailable values", async () => {
    const env = await buildEnvString(
      "app-1",
      [
        {
          key: "DB_URL",
          availability: "missing",
          valueRef: null,
          isSecretGuess: true,
          refs: [],
          scope: "runtime",
          isPreview: false,
          isMultiline: false,
          isLiteral: false,
        },
      ],
      {
        defaultMode: "import-values",
      },
    );
    expect(env).toBe("DB_URL=");
  });
});

describe("domain transformation", () => {
  it("parses and validates domain hosts", () => {
    expect(parseDomain("https://App.Example.com:8443/path")).toEqual({
      host: "app.example.com",
      https: true,
      port: 8443,
      path: "/path",
      source: "https://App.Example.com:8443/path",
    });
    expect(validDomainHost("app.example.com")).toBe(true);
    expect(validDomainHost("bad host")).toBe(false);
  });

  it("applies temp suffix mappings", () => {
    const source = parseDomain("app.example.com");
    expect(
      mapDomains([source], "temp-suffix", "migrate.example.com")[0]?.host,
    ).toBe("app.migrate.example.com");
  });
});

describe("compose analysis", () => {
  it("detects magic variables and strips the result can be parsed", () => {
    const result = analyzeCompose(
      "services:\n  web:\n    image: nginx\n    environment:\n      URL: ${SERVICE_FQDN_WEB}",
    );
    expect(result.valid).toBe(true);
    expect(result.needsValue).toContain("SERVICE_FQDN_WEB");
  });

  it("flags invalid YAML", () => {
    expect(analyzeCompose("services:\n  web: [").valid).toBe(false);
  });

  it("resolves Compose defaults from known environment values", () => {
    expect(
      resolveComposeDefaults("URL=${APP_HOST:-localhost}", {
        APP_HOST: "api.example.com",
      }),
    ).toBe("URL=api.example.com");
  });
});
