import { splitDatabaseTarget } from "../apply/executor.js";
import type { DokployClient } from "../clients/dokploy.js";
import { AppError } from "../errors.js";
import { type Plan, Plan as PlanSchema, type Step } from "../plan/types.js";

export interface RollbackEntry {
  srcId: string;
  srcKind:
    | "domain"
    | "mount"
    | "application"
    | "compose"
    | "database"
    | "environment"
    | "project";
  targetId: string;
  created: boolean;
  label?: string;
}

const reverseOrder: Record<RollbackEntry["srcKind"], number> = {
  domain: 1,
  mount: 2,
  application: 3,
  compose: 3,
  database: 3,
  environment: 4,
  project: 5,
};

export function requireRollbackConfirmation(
  runName: string,
  typedConfirmation: string,
): void {
  const expected = `DELETE ${runName}`;
  if (typedConfirmation !== expected) {
    throw new AppError("RUN_LOCKED", "Rollback confirmation did not match", {
      hint: `Type ${expected} exactly to continue.`,
    });
  }
}

export function buildRollbackPlan(
  entries: RollbackEntry[],
  createdAt?: string,
): Plan {
  const eligible = entries
    .filter((entry) => entry.created)
    .sort((left, right) => {
      const rankDifference =
        reverseOrder[left.srcKind] - reverseOrder[right.srcKind];
      return rankDifference !== 0
        ? rankDifference
        : left.srcId.localeCompare(right.srcId);
    });

  const steps: Step[] = eligible.map((entry, index) => ({
    seq: index + 1,
    kind: "DELETE_CREATED",
    intent: "skip",
    srcId: entry.srcId,
    dependsOn: index === 0 ? [] : [index],
    label: `Delete created ${entry.srcKind} ${entry.label ?? entry.targetId}`,
    payload: {
      targetKind: entry.srcKind,
      targetId: entry.targetId,
    },
    vaultRefs: [],
    warnings: [],
  }));

  return PlanSchema.parse({
    planVersion: 1,
    createdAt: createdAt ?? "1970-01-01T00:00:00.000Z",
    steps,
  });
}

export async function executeRollbackStep(
  step: Step,
  dokploy: Pick<
    DokployClient,
    | "domainDelete"
    | "mountDelete"
    | "applicationDelete"
    | "composeDelete"
    | "databaseDelete"
    | "environmentDelete"
    | "projectDelete"
  >,
): Promise<{ deleted: boolean; targetId: string }> {
  const targetKind =
    typeof step.payload.targetKind === "string" ? step.payload.targetKind : "";
  const targetId =
    typeof step.payload.targetId === "string" ? step.payload.targetId : "";
  if (!targetId)
    throw new AppError("INTERNAL", "Rollback step has no target id");

  try {
    switch (targetKind) {
      case "domain":
        await dokploy.domainDelete(targetId);
        break;
      case "mount":
        await dokploy.mountDelete(targetId);
        break;
      case "application":
        await dokploy.applicationDelete(targetId);
        break;
      case "compose":
        await dokploy.composeDelete(targetId);
        break;
      case "database": {
        // The engine is stored with the id (`postgres:abc`); never guess it.
        const { engine, id } = splitDatabaseTarget(targetId);
        await dokploy.databaseDelete(engine, id);
        break;
      }
      case "environment":
        await dokploy.environmentDelete(targetId);
        break;
      case "project":
        await dokploy.projectDelete(targetId);
        break;
      default:
        throw new AppError(
          "INTERNAL",
          `Unsupported rollback target: ${targetKind}`,
        );
    }
    return { deleted: true, targetId };
  } catch (error) {
    if (error instanceof AppError && error.code === "UPSTREAM_NOT_FOUND") {
      return { deleted: true, targetId };
    }
    throw error;
  }
}
