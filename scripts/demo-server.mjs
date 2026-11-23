#!/usr/bin/env node
// Runs the REAL app against in-memory fake Coolify and Dokploy servers (no network, no lab, nothing external is touched).
// Useful for trying the interface and for browser tests.   node scripts/demo-server.mjs [port]
// Sign up with any email; add any connection with any URL and token (e.g. https://coolify.demo / demo-token).
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// pnpm only exposes dependencies inside their own package, so resolve the HTTP adapter from apps/server
const req = createRequire(join(root, "apps/server/package.json"));
const { serve } = await import(
  pathToFileURL(req.resolve("@hono/node-server")).href
);
const core = await import(join(root, "packages/core/dist/index.js"));
const { createApp } = await import(join(root, "apps/server/dist/app.js"));
const { randomBytes } = await import("node:crypto");

const port = Number(process.argv[2] ?? 3997);
const fake = core.createFakeDokploy({
  projects: [{ name: "shop", environments: ["production"] }],
  githubProviders: [
    {
      githubId: "gh1",
      name: "Demo GitHub App",
      repos: ["acme/private-api", "acme/keyed"],
    },
  ],
  sshKeys: [{ sshKeyId: "k1", name: "demo-key" }],
});
const canaries = {
  appSecret: "demo-secret-value",
  dbPassword: "demo-db-password",
};
const app = createApp({
  config: {
    MASTER_KEY: randomBytes(32).toString("base64"),
    MASTER_KEY_SOURCE: "env",
    DATA_DIR: mkdtempSync(join(tmpdir(), "portage-demo-")),
    PORT: port,
    ALLOW_SIGNUP: true,
    UPSTREAM_ALLOW_PRIVATE: true,
    LOG_LEVEL: "info",
    RUN_RETENTION_DAYS: 30,
  },
  clients: {
    coolify: () => core.createFakeCoolify(canaries, { privateRepos: true }),
    dokploy: () => fake.client,
  },
  pauseBetweenWritesMs: Number(process.env.DEMO_STEP_MS ?? 0),
});
serve({ fetch: app.fetch, port });
process.stdout.write(
  `Portage demo on http://localhost:${port} (fake Coolify + fake Dokploy, in memory)\n`,
);
