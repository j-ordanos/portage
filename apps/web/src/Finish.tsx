import { CircleCheck, Download, ShieldAlert } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { api, errorText } from "./api";
import type { RollbackPreview, RunView, VerifyCheck } from "./types";
import { Alert, Dialog, ErrorState, Spinner } from "./ui";

/** The to-do items from the report's "Manual to-do" section, in order. */
export function todoItems(markdown: string): string[] {
  const start = markdown.indexOf("## Manual to-do");
  if (start < 0) return [];
  const rest = markdown.slice(start + 15);
  const end = rest.search(/\n## /);
  return (end < 0 ? rest : rest.slice(0, end))
    .split("\n")
    .map((line) => /^- \[ \] (.+)$/.exec(line)?.[1])
    .filter((x): x is string => Boolean(x));
}

/** Render `**bold**` and `` `code` `` from the report text without ever using HTML injection. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    const key = `${i}-${part}`;
    if (part.startsWith("**"))
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`")) return <code key={key}>{part.slice(1, -1)}</code>;
    return part;
  });
}

export function Finish({
  runId,
  stopped = false,
  onBack,
  onGone,
}: {
  runId: string;
  stopped?: boolean;
  onBack?: () => void;
  onGone: () => void;
}) {
  const [run, setRun] = useState<RunView | null>(null);
  const [checks, setChecks] = useState<VerifyCheck[] | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  const [rollback, setRollback] = useState<RollbackPreview | null>(null);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<RunView>("GET", `/runs/${runId}`);
      setRun(r);
      if (r.status === "rolled_back") return;
      if (
        r.credentialsActive &&
        ["applied", "verified", "completed"].includes(r.status)
      ) {
        setChecks(
          (
            await api<{ checks: VerifyCheck[] }>(
              "POST",
              `/runs/${runId}/verify`,
            )
          ).checks,
        );
      }
      if (r.hasPlan) {
        setReport(await api<string>("GET", `/runs/${runId}/report.md`));
        setDone(
          await api<Record<string, boolean>>("GET", `/runs/${runId}/checklist`),
        );
      }
    } catch (e) {
      setError(errorText(e));
    }
  }, [runId]);
  useEffect(() => {
    void load();
  }, [load]);

  const tick = async (id: string, value: boolean) => {
    setDone((prev) => ({ ...prev, [id]: value }));
    await api("PUT", `/runs/${runId}/checklist`, {
      item: id,
      done: value,
    }).catch(() => undefined);
  };
  const openRollback = async () => {
    setError(null);
    try {
      setRollback(await api<RollbackPreview>("GET", `/runs/${runId}/rollback`));
      setPhrase("");
    } catch (e) {
      setError(errorText(e));
    }
  };
  const doRollback = async () => {
    setBusy(true);
    try {
      await api("POST", `/runs/${runId}/rollback`, { confirm: phrase });
      setRollback(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const purge = async () => {
    await api("DELETE", `/runs/${runId}`);
    onGone();
  };

  if (!run)
    return (
      <>
        {error ? (
          <ErrorState message={error.message} hint={error.hint} />
        ) : (
          <Spinner />
        )}
      </>
    );
  const failed = checks?.filter((c) => c.status === "fail") ?? [];
  const rolledBack = run.status === "rolled_back";
  const todo = report ? todoItems(report) : [];

  return (
    <>
      <h1>
        {rolledBack
          ? "Rolled back"
          : stopped
            ? "Migration stopped"
            : "Everything is in Dokploy"}
      </h1>
      <p className="lede">
        {rolledBack
          ? "Everything this tool created in Dokploy was deleted. Coolify was never touched."
          : stopped
            ? "Some resources may already exist in Dokploy. Roll back to remove them, or go back to the progress screen to continue."
            : "Nothing was deployed. Review the resources in Dokploy, then deploy them yourself."}
      </p>

      {!rolledBack && !stopped ? (
        <>
          <section className="section" style={{ marginTop: 0 }}>
            <h2>Read back from Dokploy</h2>
            {!run.credentialsActive ? (
              <Alert tone="warn">
                A saved connection used by this migration was deleted, so
                Portage can no longer read Dokploy to verify it. Add the
                connection again in <a href="#/settings">Settings</a>.
              </Alert>
            ) : checks === null ? (
              <Spinner label={"Checking everything in Dokploy…"} />
            ) : failed.length === 0 ? (
              <p className="verdict">
                <CircleCheck size={20} aria-hidden="true" />
                {"Every check passed."} {checks.length} checks: sources, build
                types, environment keys, domains, mounts, databases.
              </p>
            ) : (
              <Alert tone="bad">
                <strong>
                  {failed.length} of {checks.length} checks failed
                </strong>
                <ul className="notes">
                  {failed.map((c) => (
                    <li key={`${c.resource}${c.check}`}>
                      {c.resource}: {c.check}
                      {c.detail ? ` (${c.detail})` : ""}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
          </section>

          <section className="section">
            <h2>
              {todo.length > 0
                ? "What still needs you"
                : "Nothing else needs you"}
            </h2>
            {todo.length > 0 ? (
              <ul className="todo">
                {todo.map((item, i) => {
                  const id = `todo:${i}`;
                  return (
                    <li key={id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={done[id] === true}
                          onChange={(e) => void tick(id, e.target.checked)}
                        />
                        <span>{inline(item)}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted">
                Open the report below for the cutover checklist.
              </p>
            )}
          </section>

          {report ? (
            <section className="section">
              <div className="row">
                <h2 className="grow">{"Migration report"}</h2>
                <a
                  className="btn small"
                  href={`/api/runs/${runId}/report.md`}
                  download="migration-report.md"
                >
                  <Download size={14} aria-hidden="true" /> {"Download report"}
                </a>
                <a
                  className="btn small"
                  href={`/api/runs/${runId}/manifest.json`}
                  download="manifest.json"
                >
                  {"Download manifest"}
                </a>
              </div>
              <pre className="report">{report}</pre>
            </section>
          ) : null}
        </>
      ) : null}

      <div className="alert warn" style={{ marginTop: "1.6rem" }}>
        <ShieldAlert size={18} aria-hidden="true" />
        <div>
          {
            "Revoke the temporary Coolify token and the Dokploy API key you used for this migration."
          }
        </div>
      </div>
      {error ? <ErrorState message={error.message} hint={error.hint} /> : null}

      <section className="danger-zone">
        {!rolledBack ? (
          <>
            <h2>{"Undo this migration"}</h2>
            <p>
              {
                "Deletes only what this tool created in Dokploy. Existing resources are never touched."
              }
            </p>
            <button
              type="button"
              className="btn danger"
              onClick={() => void openRollback()}
            >
              {"Delete created resources"}
            </button>
          </>
        ) : null}
        <div className="actions">
          {stopped && onBack ? (
            <button type="button" className="btn" onClick={onBack}>
              Back to progress
            </button>
          ) : null}
          <button type="button" className="btn" onClick={() => void purge()}>
            {"Delete this run's data"}
          </button>
          <button type="button" className="btn primary" onClick={onGone}>
            {"Start another migration"}
          </button>
        </div>
      </section>

      <Dialog
        open={rollback !== null}
        title="Undo this migration"
        onClose={() => setRollback(null)}
      >
        {rollback ? (
          <>
            <p>
              These {rollback.items.length} items will be deleted from Dokploy:
            </p>
            <ul className="scroll">
              {rollback.items.map((i, n) => (
                <li key={`${i.kind}${n}`}>
                  {i.kind}: {i.label}
                </li>
              ))}
            </ul>
            <label className="field">
              {"Type this phrase to confirm"}:{" "}
              <code>{rollback.confirmPhrase}</code>
              <input
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="actions">
              <button
                type="button"
                className="btn"
                onClick={() => setRollback(null)}
              >
                {"Cancel"}
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={busy || phrase !== rollback.confirmPhrase}
                onClick={() => void doRollback()}
              >
                {busy ? (
                  <Spinner label="Deleting…" />
                ) : (
                  "Delete created resources"
                )}
              </button>
            </div>
          </>
        ) : null}
      </Dialog>
    </>
  );
}
