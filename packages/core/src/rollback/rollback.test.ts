import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import {
  buildRollbackPlan,
  executeRollbackStep,
  requireRollbackConfirmation,
} from "./rollback.js";

describe("rollback planning", () => {
  it("excludes adopted resources and orders deletes in reverse dependency order", () => {
    const plan = buildRollbackPlan([
      {
        srcId: "project",
        srcKind: "project",
        targetId: "project-1",
        created: true,
      },
      {
        srcId: "environment",
        srcKind: "environment",
        targetId: "env-1",
        created: true,
      },
      {
        srcId: "app",
        srcKind: "application",
        targetId: "app-1",
        created: true,
      },
      {
        srcId: "domain",
        srcKind: "domain",
        targetId: "domain-1",
        created: true,
      },
      {
        srcId: "adopted",
        srcKind: "application",
        targetId: "existing-app",
        created: false,
      },
    ]);

    expect(plan.steps.map((step) => step.payload.targetKind)).toEqual([
      "domain",
      "application",
      "environment",
      "project",
    ]);
  });

  it("requires exact typed confirmation", () => {
    expect(() =>
      requireRollbackConfirmation("acme-prod", "DELETE acme-prod"),
    ).not.toThrow();
    expect(() =>
      requireRollbackConfirmation("acme-prod", "delete acme-prod"),
    ).toThrow("Rollback confirmation");
  });
});

describe("rollback execution", () => {
  it("treats an already missing resource as successfully deleted", async () => {
    const missing = vi.fn(async () => {
      throw new AppError("UPSTREAM_NOT_FOUND", "Already deleted");
    });
    const plan = buildRollbackPlan([
      {
        srcId: "app",
        srcKind: "application",
        targetId: "app-1",
        created: true,
      },
    ]);
    const step = plan.steps[0];
    if (!step) throw new Error("Expected rollback step");
    await expect(
      executeRollbackStep(step, {
        domainDelete: vi.fn(),
        mountDelete: vi.fn(),
        applicationDelete: missing,
        composeDelete: vi.fn(),
        databaseDelete: vi.fn(),
        environmentDelete: vi.fn(),
        projectDelete: vi.fn(),
      }),
    ).resolves.toEqual({ deleted: true, targetId: "app-1" });
  });

  it("never calls project deletion for adopted projects", () => {
    const plan = buildRollbackPlan([
      {
        srcId: "project",
        srcKind: "project",
        targetId: "existing",
        created: false,
      },
    ]);
    expect(plan.steps).toEqual([]);
  });
});
