import { describe, expect, it } from "vitest";
import { analyzeCompose } from "../transform/compose.js";
import { databaseMigrationSnippets, volumeMigrationSnippets } from "./data.js";

describe("CP9 compose", () => {
  it("lists every detected magic variable once", () => {
    const raw =
      "services:\n  web:\n    environment:\n      URL: $SERVICE_FQDN_WEB\n      PASS: ${SERVICE_PASSWORD_WEB}\n";
    const result = analyzeCompose(raw);
    expect(result.valid).toBe(true);
    expect(result.needsValue).toEqual([
      "SERVICE_FQDN_WEB",
      "SERVICE_PASSWORD_WEB",
    ]);
  });

  it("rejects malformed compose YAML", () => {
    expect(analyzeCompose("services:\n  web: [").valid).toBe(false);
  });
});

describe("CP9 migration snippets", () => {
  it("uses placeholders for supported database engines", () => {
    const postgres = databaseMigrationSnippets("postgres");
    expect(postgres.dump).toContain("<source-host>");
    expect(postgres.restore).toContain("<target-host>");
  });

  it("provides volume dump and restore placeholders", () => {
    const volume = volumeMigrationSnippets("named-volume");
    expect(volume.dump).toContain("named-volume");
    expect(volume.restore).toContain("<target-volume>");
  });
});
