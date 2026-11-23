import type { IdMapStore } from "../apply/executor.js";

export interface IdMapEntry {
  srcId: string;
  srcKind: string;
  targetId: string;
  created: boolean;
}

/** In-memory id-map for tests and the CLI's JSON store. */
export function createMemoryIdMap(): IdMapStore & {
  entries(runId: string): IdMapEntry[];
} {
  const rows = new Map<string, IdMapEntry & { runId: string }>();
  const key = (runId: string, srcId: string, srcKind: string) =>
    `${runId}\u0000${srcId}\u0000${srcKind}`;
  return {
    async get(runId, srcId, srcKind) {
      const row = rows.get(key(runId, srcId, srcKind));
      return row ? { targetId: row.targetId, created: row.created } : undefined;
    },
    async put(runId, srcId, srcKind, targetId, created) {
      rows.set(key(runId, srcId, srcKind), {
        runId,
        srcId,
        srcKind,
        targetId,
        created,
      });
    },
    entries(runId) {
      return [...rows.values()]
        .filter((r) => r.runId === runId)
        .map(({ runId: _run, ...entry }) => entry);
    },
  };
}
