import {
  CheckCircle2,
  CircleDashed,
  Loader2,
  MinusCircle,
  Pause,
  Play,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import type { LogEvent, PlanView, RunView, Step } from "./types";
import { Alert, ErrorState, Skeleton } from "./ui";

const ICON = {
  pending: <CircleDashed size={16} aria-label="pending" />,
  running: <Loader2 size={16} className="spin" aria-label="running" />,
  done: <CheckCircle2 size={16} className="ok-text" aria-label="done" />,
  failed: <XCircle size={16} className="bad-text" aria-label="failed" />,
  skipped: <MinusCircle size={16} className="faint" aria-label="skipped" />,
} as const;

export function Migrate({
  runId,
  onFinished,
  onRollback,
}: {
  runId: string;
  onFinished: () => void;
  onRollback: () => void;
}) {
  const [run, setRun] = useState<RunView | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [log, setLog] = useState<LogEvent[]>([]);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  const [live, setLive] = useState<"connecting" | "live" | "lost">(
    "connecting",
  );
  const logEnd = useRef<HTMLDivElement>(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished; // keep the effect stable: a new callback must not reopen the event stream

  const refresh = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([
        api<RunView>("GET", `/runs/${runId}`),
        api<PlanView>("GET", `/runs/${runId}/plan`),
      ]);
      setRun(r);
      setSteps(p.steps);
      if (
        ["applied", "verified", "completed", "rolled_back"].includes(r.status)
      )
        finishedRef.current();
    } catch (e) {
      setError(errorText(e));
    }
  }, [runId]);

  // Live updates: SSE (the browser reconnects and resumes from the last event id) plus a light poll as a safety net.
  useEffect(() => {
    void refresh();
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onopen = () => setLive("live");
    source.onerror = () => setLive("lost");
    source.addEventListener("log", (e) => {
      const event = JSON.parse((e as MessageEvent<string>).data) as LogEvent;
      setLog((prev) =>
        prev.some((x) => x.id === event.id)
          ? prev
          : [...prev, event].slice(-300),
      );
      void refresh();
    });
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      source.close();
      clearInterval(timer);
    };
  }, [runId, refresh]);

  useEffect(() => {
    logEnd.current?.scrollIntoView?.({ block: "nearest" });
  }, [log.length]);

  const act = async (path: string) => {
    setError(null);
    try {
      await api("POST", `/runs/${runId}${path}`);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!run) {
    return error ? (
      <ErrorState
        message={error.message}
        hint={error.hint}
        onRetry={() => void refresh()}
      />
    ) : (
      <div aria-busy="true" aria-label="Loading progress">
        <Skeleton w="14rem" h="2rem" />
        <div style={{ margin: "1.25rem 0" }}>
          <Skeleton h="0.5rem" r="999px" />
        </div>
        <Skeleton h="14rem" r="12px" />
      </div>
    );
  }
  const total = Math.max(run.progress.total, 1);
  const finished = run.progress.done + run.progress.skipped;
  const failed = steps.find((s) => s.state === "failed");
  const current = steps.find((s) => s.state === "running");
  const paused = run.status === "paused" || run.status === "paused_failed";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {run.status === "paused_failed"
              ? "A step needs attention"
              : paused
                ? "Paused"
                : "Creating your projects in Dokploy"}
          </h1>
          <p>
            Nothing is deployed. You can leave this page; the migration keeps
            running on the server.
          </p>
        </div>
        <span
          className={`chip ${live === "live" ? "ok" : live === "lost" ? "warn" : ""}`}
          title="Live updates"
        >
          <span className="dot" />{" "}
          {live === "live"
            ? "Live"
            : live === "lost"
              ? "Reconnecting"
              : "Connecting"}
        </span>
      </div>

      <div
        className="meter"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={finished}
        aria-label="Migration progress"
      >
        <span style={{ width: `${(finished / total) * 100}%` }} />
      </div>
      <p className="muted" aria-live="polite" style={{ marginTop: 0 }}>
        {finished} of {run.progress.total} steps
        {current ? `: ${current.label}` : ""}
      </p>

      {failed ? (
        <Alert tone="bad">
          <strong>
            Step {failed.seq} failed: {failed.label}
          </strong>
          <p>{failed.error?.message}</p>
          {failed.error?.hint ? (
            <p className="muted">{failed.error.hint}</p>
          ) : null}
          <div className="actions" style={{ margin: "0.75rem 0 0" }}>
            <button
              type="button"
              className="btn small"
              onClick={() => void act(`/steps/${failed.seq}/retry`)}
            >
              Retry step
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() => void act(`/steps/${failed.seq}/skip`)}
            >
              Skip step
            </button>
            <button
              type="button"
              className="btn small danger"
              onClick={onRollback}
            >
              Roll back
            </button>
          </div>
        </Alert>
      ) : null}
      {run.status === "paused" ? (
        <div className="actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => void act("/apply")}
          >
            <Play size={16} aria-hidden="true" /> Resume
          </button>
          <button type="button" className="btn danger" onClick={onRollback}>
            Roll back
          </button>
        </div>
      ) : null}
      {run.applying ? (
        <div className="actions">
          <button
            type="button"
            className="btn"
            onClick={() => void act("/pause")}
          >
            <Pause size={16} aria-hidden="true" /> Pause
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={() => void act("/cancel")}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {error && !failed ? (
        <ErrorState message={error.message} hint={error.hint} />
      ) : null}

      <div className="two">
        <section aria-label="Steps">
          <h2 style={{ marginBottom: "0.6rem" }}>Steps</h2>
          <ol className="timeline">
            {steps.map((s) => (
              <li key={s.seq} className={s.state}>
                {ICON[s.state]}
                <span>{s.label}</span>
              </li>
            ))}
          </ol>
        </section>
        <section aria-label="Activity">
          <h2 style={{ marginBottom: "0.6rem" }}>Activity</h2>
          <div className="log" aria-live="polite">
            {log.length === 0 ? (
              <span className="faint">Waiting for the first update…</span>
            ) : null}
            {log.map((l) => (
              <div key={l.id} className={l.level}>
                {l.message}
              </div>
            ))}
            <div ref={logEnd} />
          </div>
        </section>
      </div>
    </>
  );
}
