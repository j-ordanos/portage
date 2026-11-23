import type { EventRow } from "../db/store.js";

type Listener = (event: EventRow) => void;

/** In-process fan-out of run events to SSE connections. */
export class EventHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(runId: string, listener: Listener): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  emit(runId: string, event: EventRow): void {
    for (const listener of this.listeners.get(runId) ?? []) listener(event);
  }
}
