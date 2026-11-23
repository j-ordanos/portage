import { describe, expect, it } from "vitest";
import { IR } from "../ir/schema.js";
import { buildPlan } from "../plan/build-plan.js";
import {
  type GitLink,
  type GitSnapshot,
  resolveGitLink,
  sshFingerprint,
} from "../plan/git-link.js";
import { defaultOptions } from "../plan/types.js";
import { createFakeDokploy } from "../testing/fake-dokploy.js";
import { createMemoryIdMap } from "../testing/memory-idmap.js";
import { MemoryVault } from "../vault.js";
import { runPlan } from "./runner.js";

const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAh/P3om9kNDHtwXC482JGF3ZE/8oaMLw46fMGk6RfIQ test@lab";
const FINGERPRINT = "YSqbHglVIZM+P5SKq51rr/u5J9YesKuw0UWK8NDVV8s";

const base = (srcId: string, name: string) => ({
  srcId,
  name,
  projectSrcId: "p1",
  environmentName: "production",
  compat: "auto",
  issues: [],
  selected: true,
  decision: "migrate",
});
const app = (srcId: string, name: string, source: Record<string, unknown>) => ({
  ...base(srcId, name),
  kind: "application",
  source,
  build: { pack: "nixpacks", rawPack: "nixpacks", baseDir: "/" },
  ports: [3000],
  domains: [],
  env: [],
  mounts: [],
});

const ir = IR.parse({
  irVersion: 1,
  source: {
    url: "https://coolify.example",
    version: "4.7.5",
    readAt: "2026-11-23T00:00:00Z",
  },
  teamSharedEnv: [],
  servers: [],
  notes: [],
  projects: [
    {
      srcId: "p1",
      name: "Showcase",
      sharedEnv: [],
      environments: [
        {
          srcId: "e1",
          name: "production",
          sharedEnv: [],
          resources: [
            // GitHub App in Coolify; Dokploy's app has a different name but can see the repo
            app("a-ghapp", "web", {
              type: "git",
              repo: "Acme/Web",
              branch: "main",
              provider: "github-app",
              url: "https://github.com/Acme/Web",
              appName: "coolify-acme-app",
              appOrg: "acme",
            }),
            // deploy key in Coolify; same key exists in Dokploy under another name
            app("a-key", "worker", {
              type: "git",
              repo: "git@github.com:acme/worker.git",
              branch: "dev",
              provider: "deploy-key",
              keyName: "worker-key",
              keyFingerprint: FINGERPRINT,
            }),
            // nothing in Dokploy can reach this one
            app("a-orphan", "legacy", {
              type: "git",
              repo: "other/legacy",
              branch: "main",
              provider: "github-app",
              url: "https://github.com/other/legacy",
            }),
            {
              ...base("c-git", "stack"),
              kind: "compose",
              composeRaw: "",
              isTemplateService: false,
              source: {
                type: "git",
                repo: "Acme/Stack",
                branch: "main",
                provider: "github-app",
                url: "https://github.com/Acme/Stack",
              },
              composePath: "/docker-compose.yml",
              domains: [],
              env: [],
              mounts: [],
            },
          ],
        },
      ],
    },
  ],
});

describe("private repositories end to end", () => {
  it("links each repo the way the resolver decided and flags the one it cannot reach", async () => {
    const fake = createFakeDokploy({
      githubProviders: [
        {
          githubId: "gh-dokploy",
          name: "Dokploy-V2.1",
          repos: ["Acme/Web", "acme/stack"],
        },
        { githubId: "gh-empty", name: "Unrelated", repos: ["nobody/nothing"] },
      ],
      sshKeys: [
        {
          sshKeyId: "key-1",
          name: "totally-different-name",
          publicKey: PUBLIC_KEY,
        },
      ],
    });
    // build the snapshot exactly like the server does
    const snapshot: GitSnapshot = {
      github: await Promise.all(
        (await fake.client.gitProviders()).map(async (p) => ({
          githubId: p.githubId as string,
          label: p.name,
          repos: new Set(
            await fake.client.githubRepositories(p.githubId as string),
          ),
        })),
      ),
      ssh: (await fake.client.sshKeys()).map((k) => ({
        sshKeyId: k.sshKeyId,
        name: k.name,
        ...(k.publicKey
          ? { fingerprint: sshFingerprint(k.publicKey) as string }
          : {}),
      })),
    };
    const gitLinks: Record<string, GitLink> = {};
    for (const r of ir.projects[0]?.environments[0]?.resources ?? []) {
      if (
        (r.kind === "application" || r.kind === "compose") &&
        r.source?.type === "git"
      ) {
        gitLinks[r.srcId] = resolveGitLink(r.source, snapshot);
      }
    }
    expect(gitLinks["a-ghapp"]).toMatchObject({
      kind: "github",
      githubId: "gh-dokploy",
    });
    expect(gitLinks["a-key"]).toMatchObject({ kind: "ssh", sshKeyId: "key-1" });
    expect(gitLinks["a-orphan"]).toMatchObject({ kind: "url" });
    expect(gitLinks["c-git"]).toMatchObject({
      kind: "github",
      githubId: "gh-dokploy",
    });

    const options = defaultOptions(["a-ghapp", "a-key", "a-orphan", "c-git"]);
    const plan = buildPlan(ir, options, { gitLinks });
    const warnings = (srcId: string) =>
      plan.steps.find((s) => s.srcId === srcId && s.kind === "CONFIGURE_SOURCE")
        ?.warnings ?? [];
    expect(warnings("a-ghapp")[0]).toContain("Git access linked");
    expect(warnings("a-orphan")[0]).toContain("Relink Git access");

    const vault = new MemoryVault();
    const outcome = await runPlan(
      plan,
      {
        runId: "r",
        dokploy: fake.client,
        vault,
        idMap: createMemoryIdMap(),
        options,
      },
      { hooks: { sleep: async () => undefined } },
    );
    expect(outcome.status).toBe("completed");

    const rows = fake.snapshot().resources;
    const row = (name: string) =>
      rows.find((r) => r.name === name) as Record<string, unknown>;
    // original capitalisation is kept; the app is attached to Dokploy's own GitHub App
    expect(row("web")).toMatchObject({
      sourceType: "github",
      githubId: "gh-dokploy",
      owner: "Acme",
      repository: "Web",
      branch: "main",
    });
    expect(row("worker")).toMatchObject({
      sourceType: "git",
      customGitSSHKeyId: "key-1",
      customGitBranch: "dev",
    });
    expect(row("legacy")).toMatchObject({
      sourceType: "git",
      customGitUrl: "https://github.com/other/legacy",
      customGitSSHKeyId: null,
    });
    expect(row("stack")).toMatchObject({
      sourceType: "github",
      githubId: "gh-dokploy",
      owner: "Acme",
      repository: "Stack",
      composePath: "./docker-compose.yml",
    });
    const stepWarnings = [...outcome.records.values()].flatMap(
      (r) => r.warnings ?? [],
    );
    expect(stepWarnings.filter((w) => w.includes("relink")).length).toBe(1); // only the orphan
  });
});
