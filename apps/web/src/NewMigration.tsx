import { ArrowRight, Check, Loader2, Plus, ScanSearch } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "./api";
import { ConnectionDialog } from "./Connections";
import { go } from "./router";
import type { Connection } from "./types";
import { EmptyState, ErrorState, hostOf, Skeleton, ver } from "./ui";

type Phase = "idle" | "connecting" | "scanning";

export function NewMigration() {
  const [list, setList] = useState<Connection[] | null>(null);
  const [loadError, setLoadError] = useState<{
    message: string;
    hint?: string;
  } | null>(null);
  const [coolifyId, setCoolifyId] = useState("");
  const [dokployId, setDokployId] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  const [adding, setAdding] = useState<"coolify" | "dokploy" | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const all = (
        await api<{ connections: Connection[] }>("GET", "/connections")
      ).connections;
      setList(all);
      // one choice is no choice: pick it for the person
      const only = (kind: Connection["kind"]) => {
        const items = all.filter((c) => c.kind === kind);
        return items.length === 1 ? (items[0]?.id ?? "") : "";
      };
      setCoolifyId((prev) => prev || only("coolify"));
      setDokployId((prev) => prev || only("dokploy"));
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const start = async () => {
    setError(null);
    setPhase("connecting");
    let runId: string | undefined;
    try {
      const created = await api<{ runId: string }>("POST", "/runs", {
        coolifyConnectionId: coolifyId,
        dokployConnectionId: dokployId,
      });
      runId = created.runId;
      setPhase("scanning");
      await api("POST", `/runs/${runId}/discover`);
      go({ page: "run", id: runId, stage: null });
    } catch (e) {
      setError(errorText(e));
      setPhase("idle");
      // the run exists once connecting worked; if only the scan failed, the Choose screen can retry it
      if (runId) go({ page: "run", id: runId, stage: null });
    }
  };

  const group = (
    kind: "coolify" | "dokploy",
    title: string,
    role: string,
    value: string,
    set: (id: string) => void,
  ) => {
    const items = list?.filter((c) => c.kind === kind) ?? [];
    return (
      <fieldset
        className="stack"
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
        disabled={phase !== "idle"}
      >
        <legend style={{ padding: 0, marginBottom: "0.6rem" }}>
          <h2>{title}</h2>
          <span className="muted small">{role}</span>
        </legend>
        {list === null ? (
          <div className="pick" style={{ cursor: "default" }}>
            <Skeleton w="55%" h="1rem" />
            <Skeleton w="80%" h="0.75rem" />
          </div>
        ) : items.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<Plus size={22} aria-hidden="true" />}
              title={`Add a ${title} connection`}
            >
              Save its address and{" "}
              {kind === "coolify" ? "API token" : "API key"} once, and it is
              here whenever you need it.
            </EmptyState>
            <div style={{ textAlign: "center", paddingBottom: "1.25rem" }}>
              <button
                type="button"
                className="btn primary"
                onClick={() => setAdding(kind)}
              >
                <Plus size={16} aria-hidden="true" /> Add {title}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="pick-grid" style={{ gridTemplateColumns: "1fr" }}>
              {items.map((c) => (
                <label key={c.id} className="pick">
                  <input
                    type="radio"
                    name={kind}
                    value={c.id}
                    checked={value === c.id}
                    onChange={() => set(c.id)}
                  />
                  <span
                    className="row"
                    style={{
                      justifyContent: "space-between",
                      flexWrap: "nowrap",
                    }}
                  >
                    <strong>{c.name}</strong>
                    {c.check?.ok ? (
                      <span className="chip ok">{ver(c.check.version)}</span>
                    ) : c.check ? (
                      <span className="chip bad">Can't connect</span>
                    ) : null}
                  </span>
                  <span className="url">{hostOf(c.url)}</span>
                </label>
              ))}
            </div>
            <button
              type="button"
              className="btn quiet small"
              style={{ justifySelf: "start" }}
              onClick={() => setAdding(kind)}
            >
              <Plus size={14} aria-hidden="true" /> Add another
            </button>
          </>
        )}
      </fieldset>
    );
  };

  const ready = Boolean(coolifyId && dokployId);
  const live = phase !== "idle";
  const stepState = (n: number) =>
    phase === "scanning"
      ? n < 2
        ? "done"
        : "on"
      : phase === "connecting"
        ? n === 0
          ? "on"
          : ""
        : "";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>New migration</h1>
          <p>
            Choose where to read from and where to create. Nothing is changed in
            either yet.
          </p>
        </div>
      </div>

      {loadError ? (
        <ErrorState
          message={loadError.message}
          hint={loadError.hint}
          onRetry={() => void load()}
        />
      ) : null}

      {!loadError ? (
        <>
          <div className="bridge" data-live={live}>
            {group("coolify", "Coolify", "Read from", coolifyId, setCoolifyId)}
            <span className="joint" aria-hidden="true">
              {live ? (
                <Loader2 size={18} className="spin" />
              ) : (
                <ArrowRight size={18} />
              )}
            </span>
            {group("dokploy", "Dokploy", "Create in", dokployId, setDokployId)}
          </div>

          {live ? (
            <ol className="progress-steps" aria-live="polite">
              {[
                "Checking both connections",
                "Reading your Coolify projects",
              ].map((label, i) => {
                const s = stepState(i);
                return (
                  <li key={label} className={s}>
                    {s === "done" ? (
                      <Check size={16} aria-hidden="true" />
                    ) : s === "on" ? (
                      <Loader2 size={16} className="spin" aria-hidden="true" />
                    ) : (
                      <span style={{ width: 16 }} />
                    )}
                    {label}
                  </li>
                );
              })}
            </ol>
          ) : null}

          {error ? (
            <ErrorState
              message={error.message}
              hint={
                error.hint ?? "Check the connection in Settings and try again."
              }
            />
          ) : null}

          <div className="actions" style={{ marginTop: "1.5rem" }}>
            <button
              type="button"
              className="btn primary large"
              disabled={!ready || live}
              onClick={() => void start()}
            >
              <ScanSearch size={18} aria-hidden="true" /> Scan Coolify
            </button>
            <a className="btn quiet" href="#/">
              Cancel
            </a>
            {!ready && list ? (
              <span className="muted small">
                Choose one of each to continue.
              </span>
            ) : null}
          </div>
        </>
      ) : null}

      {adding ? (
        <ConnectionDialog
          kind={adding}
          existing={null}
          onClose={() => setAdding(null)}
          onSaved={(c) => {
            setAdding(null);
            if (c.kind === "coolify") setCoolifyId(c.id);
            else setDokployId(c.id);
            void load();
          }}
        />
      ) : null}
    </>
  );
}
