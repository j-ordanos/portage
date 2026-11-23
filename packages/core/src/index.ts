import { z } from "zod";

export const healthResponse = z.object({
  ok: z.literal(true),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponse>;

export * from "./apply/executor.js";
export * from "./apply/runner.js";
export * from "./apply/worker.js";
export * from "./clients/coolify.js";
export * from "./clients/dokploy.js";
export * from "./clients/http.js";
export * from "./crypto.js";
export * from "./errors.js";
export * from "./extract/inventory.js";
export * from "./ir/schema.js";
export * from "./plan/build-plan.js";
export * from "./plan/types.js";
export * from "./redact/redact.js";
export * from "./report/migration-report.js";
export * from "./report/report.js";
export * from "./resources/data.js";
export * from "./rollback/failure-matrix.js";
export * from "./rollback/rollback.js";
export * from "./run/transitions.js";
export * from "./security/url-policy.js";
export * from "./testing/fake-coolify.js";
export * from "./testing/fake-dokploy.js";
export * from "./testing/memory-idmap.js";
export * from "./transform/compose.js";
export * from "./transform/domains.js";
export * from "./transform/env.js";
export * from "./transform/rules.js";
export * from "./vault.js";
export * from "./verify/verify.js";
