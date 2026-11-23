import { ArrowRight, FolderKanban, KeyRound, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "./api";
import { go } from "./router";
import { useToast } from "./toast";
import type { RunListItem } from "./types";
import {
  ago,
  Dialog,
  EmptyState,
  ErrorState,
  hostOf,
  RunStatus,
  Skeleton,
} from "./ui";

interface Item extends RunListItem {
  progress?: { total: number; done: number };
}

export function Dashboard() {
  const [runs, setRuns] = useState<Item[] | null>(null);
  const [connCount, setConnCount] = useState<number | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  const [removing, setRemoving] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, c] = await Promise.all([
        api<{ runs: Item[] }>("GET", "/runs"),
        api<{ connections: unknown[] }>("GET", "/connections"),
      ]);
      setRuns(r.runs);
      setConnCount(c.connections.length);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api("DELETE", `/runs/${removing.id}`);
      toast("Migration deleted");
      setRemoving(null);
      await load();
    } catch (e) {
      toast(errorText(e).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Your migrations</h1>
          <p>Pick up where you left off, or start a new one.</p>
        </div>
        <button
          type="button"
          className="btn primary"
          onClick={() => go({ page: "new" })}
        >
          <Plus size={18} aria-hidden="true" /> New migration
        </button>
      </div>

      {error ? (
        <ErrorState
          message={error.message}
          hint={error.hint}
          onRetry={() => void load()}
        />
      ) : null}

      {!error && runs === null ? (
        <div className="runs" aria-busy="true" aria-label="Loading migrations">
          {[0, 1, 2].map((i) => (
            <div className="run" key={i}>
              <div style={{ display: "grid", gap: "0.5rem" }}>
                <Skeleton w="40%" h="1.1rem" />
                <Skeleton w="65%" h="0.8rem" />
              </div>
              <Skeleton w="6rem" h="2rem" r="8px" />
            </div>
          ))}
        </div>
      ) : null}

      {runs && connCount === 0 ? (
        <div className="card">
          <EmptyState
            icon={<KeyRound size={26} aria-hidden="true" />}
            title="Add your two servers first"
            action={
              <a className="btn primary" href="#/settings">
                Add a connection
              </a>
            }
          >
            Save your Coolify and Dokploy addresses and API keys once. Portage
            keeps them encrypted, so you never type them again.
          </EmptyState>
        </div>
      ) : null}

      {runs && connCount !== 0 && runs.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<FolderKanban size={26} aria-hidden="true" />}
            title="No migrations yet"
            action={
              <button
                type="button"
                className="btn primary"
                onClick={() => go({ page: "new" })}
              >
                Start your first migration
              </button>
            }
          >
            Choose a Coolify server and a Dokploy server. Portage reads your
            projects and shows exactly what it would create before touching
            anything.
          </EmptyState>
        </div>
      ) : null}

      {runs && runs.length > 0 ? (
        <div className="runs">
          {runs.map((r) => {
            const pct =
              r.progress && r.progress.total > 0
                ? Math.round((r.progress.done / r.progress.total) * 100)
                : null;
            return (
              <div className="run" key={r.id}>
                <div>
                  <div className="row">
                    <span className="name">{r.name}</span>
                    <RunStatus status={r.status} />
                  </div>
                  <div className="meta">
                    <span className="mono">
                      {hostOf(r.coolifyUrl)} → {hostOf(r.dokployUrl)}
                    </span>
                    <span>Updated {ago(r.updatedAt)}</span>
                    {pct !== null && r.status !== "rolled_back" ? (
                      <span className="row" style={{ gap: "0.5rem" }}>
                        <span className="bar" role="presentation">
                          <i style={{ width: `${pct}%` }} />
                        </span>
                        {pct}%
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="row" style={{ gap: "0.4rem" }}>
                  <button
                    type="button"
                    className="btn quiet icon"
                    aria-label={`Delete ${r.name}`}
                    onClick={() => setRemoving(r)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => go({ page: "run", id: r.id, stage: null })}
                  >
                    Open <ArrowRight size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Delete this migration?"
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setRemoving(null)}
            >
              Keep it
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              Delete migration
            </button>
          </>
        }
      >
        <p>
          This removes Portage's record of <strong>{removing?.name}</strong>.
          Anything already created in Dokploy stays there. To remove it, roll
          the migration back first.
        </p>
      </Dialog>
    </>
  );
}
