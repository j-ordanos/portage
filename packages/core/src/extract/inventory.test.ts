import { describe, expect, it } from "vitest";
import type { CoolifyReader } from "../clients/coolify.js";
import { IR } from "../ir/schema.js";
import { MemoryVault } from "../vault.js";
import { extractInventory } from "./inventory.js";

describe("inventory extraction", () => {
  it("stores secret values only in the vault and returns a valid deterministic IR", async () => {
    const reader: CoolifyReader = {
      probe: async () => ({
        version: "4.3.1",
        abilities: { read: true, write: false, sensitiveRead: true },
        warnings: [],
      }),
      listProjects: async () => [
        {
          uuid: "project-1",
          name: "Acme",
          environments: [{ name: "production" }],
        },
      ],
      listApplications: async () => [
        { uuid: "app-1", name: "API", project_uuid: "project-1" },
      ],
      listDatabases: async () => [],
      listServices: async () => [],
      listServers: async () => [],
      getProject: async () => ({
        environments: [{ uuid: "env-1", id: 1, name: "production" }],
      }),
      getApplication: async () => ({
        name: "API",
        git_repository: "https://github.com/acme/api",
        git_branch: "main",
        build_pack: "nixpacks",
      }),
      getApplicationEnvs: async () => [
        { key: "DATABASE_URL", value: "CANARY_DB_SECRET", is_hidden: true },
        { key: "NORMAL", value: "visible-value" },
      ],
      getApplicationStorages: async () => [],
    };
    const vault = new MemoryVault();
    const ir = await extractInventory(reader, vault, {
      sourceUrl: "https://coolify.example",
      sourceVersion: "4.3.1",
    });

    expect(IR.parse(ir)).toEqual(ir);
    expect(JSON.stringify(ir)).not.toContain("CANARY_DB_SECRET");
    expect(JSON.stringify(ir)).not.toContain("visible-value");

    const app = ir.projects[0]?.environments[0]?.resources[0];
    expect(app?.kind).toBe("application");
  });
});
