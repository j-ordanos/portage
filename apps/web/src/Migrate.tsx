import {
  CheckCircle2,
  CircleDashed,
  Loader2,
  MinusCircle,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import { copy } from "./copy";
import type { LogEvent, PlanView, RunView, Step } from "./types";
import { ErrorBox } from "./ui";

const ICON = {
  pending: <CircleDashed size={16} aria-label="pending" />,
  running: <Loader2 size={16} className="spin" aria-label="running" />,
  done: <CheckCircle2 size={16} className="ok-text" aria-label="done" />,
  failed: <XCircle size={16} className="bad-text" aria-label="failed" />,
  skipped: <MinusCircle size={16} className="muted" aria-label="skipped" />,
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

  // Live updates: SSE (auto-reconnect resumes from the last event id) plus a light poll as a safety net.
  useEffect(() => {
    void refresh();
    const source = new EventSource(`/api/runs/${runId}/events`);
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

  if (!run)
    return error ? (
      <ErrorBox message={error.message} hint={error.hint} />
    ) : null;
  const total = Math.max(run.progress.total, 1);
  const finished = run.progress.done + run.progress.skipped;
  const failed = steps.find((s) => s.state === "failed");
  const current = steps.find((s) => s.state === "running");
  const paused = run.status === "paused" || run.status === "paused_failed";

  return (
    <main>
      <h1>
        {run.status === "paused_failed"
          ? copy.migrate.failed
          : paused
            ? copy.migrate.paused
            : copy.migrate.title}
      </h1>
      <div
        className="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={finished}
        aria-label="Migration progress"
      >
        <span style={{ width: `${(finished / total) * 100}%` }} />
      </div>
      <p className="muted" aria-live="polite">
        {finished} of {run.progress.total} steps
        {current ? ` — ${current.label}` : ""}
      </p>

      {failed ? (
        <div className="alert bad" role="alert">
          <XCircle size={18} aria-hidden="true" />
          <div>
            <strong>
              Step {failed.seq} failed: {failed.label}
            </strong>
            <p>{failed.error?.message}</p>
            {failed.error?.hint ? (
              <p className="muted">{failed.error.hint}</p>
            ) : null}
            <div className="actions">
              <button
                type="button"
                className="btn small"
                onClick={() => void act(`/steps/${failed.seq}/retry`)}
              >
                {copy.migrate.retry}
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => void act(`/steps/${failed.seq}/skip`)}
              >
                {copy.migrate.skip}
              </button>
              <button
                type="button"
                className="btn small danger"
                onClick={onRollback}
              >
                {copy.migrate.rollback}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {run.status === "paused" ? (
        <div className="actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => void act("/apply")}
          >
            Resume
          </button>
          <button
            type="button"
            className="btn small danger"
            onClick={onRollback}
          >
            {copy.migrate.rollback}
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
            {copy.migrate.pause}
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={() => void act("/cancel")}
          >
            {copy.migrate.cancel}
          </button>
        </div>
      ) : null}
      {error ? <ErrorBox message={error.message} hint={error.hint} /> : null}

      <div className="grid two">
        <section className="card">
          <h2>Steps</h2>
          <ol className="steps">
            {steps.map((s) => (
              <li key={s.seq} className={s.state}>
                {ICON[s.state]}
                <span>{s.label}</span>
              </li>
            ))}
          </ol>
        </section>
        <section className="card">
          <h2>{copy.migrate.log}</h2>
          <div className="log" aria-live="polite">
            {log.map((l) => (
              <div key={l.id} className={l.level}>
                {l.message}
              </div>
            ))}
            <div ref={logEnd} />
          </div>
        </section>
      </div>
    </main>
  );
}
