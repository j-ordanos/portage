import { Download, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "./api";
import { copy } from "./copy";
import type { RollbackPreview, RunView, VerifyCheck } from "./types";
import { Dialog, ErrorBox, Spinner } from "./ui";

export function Finish({
  runId,
  onGone,
}: {
  runId: string;
  onGone: () => void;
}) {
  const [run, setRun] = useState<RunView | null>(null);
  const [checks, setChecks] = useState<VerifyCheck[] | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  const [rollback, setRollback] = useState<RollbackPreview | null>(null);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

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
      if (r.hasPlan)
        setReport(await api<string>("GET", `/runs/${runId}/report.md`));
    } catch (e) {
      setError(errorText(e));
    }
  }, [runId]);
  useEffect(() => {
    void load();
  }, [load]);

  const reenter = async () => {
    if (!newKey) return;
    try {
      await api("PUT", `/runs/${runId}/credentials`, { dokployApiKey: newKey });
      setNewKey(null); // the key now lives only on the server
      await load();
    } catch (e) {
      setError(errorText(e));
    }
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
    return error ? (
      <ErrorBox message={error.message} hint={error.hint} />
    ) : (
      <Spinner />
    );
  const failed = checks?.filter((c) => c.status === "fail") ?? [];
  const rolledBack = run.status === "rolled_back";

  return (
    <main>
      <h1>{rolledBack ? "Rolled back" : copy.finish.title}</h1>
      {rolledBack ? (
        <div className="alert ok">
          Everything this tool created in Dokploy was deleted.
        </div>
      ) : (
        <div className="alert ok">{copy.finish.deployed}</div>
      )}

      {!rolledBack ? (
        <section className="card">
          <h2>Verification</h2>
          {!run.credentialsActive ? (
            <div className="alert warn">
              <div>
                The API credentials for this run expired. Enter the Dokploy key
                again to verify or roll back.
                <div className="row">
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Dokploy API key"
                    value={newKey ?? ""}
                    onChange={(e) => setNewKey(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn small"
                    disabled={!newKey}
                    onClick={() => void reenter()}
                  >
                    Save key
                  </button>
                </div>
              </div>
            </div>
          ) : checks === null ? (
            <Spinner label={copy.finish.verifying} />
          ) : failed.length === 0 ? (
            <p className="ok-text">
              {copy.finish.verified} ({checks.length} checks)
            </p>
          ) : (
            <ul>
              {failed.map((c) => (
                <li key={`${c.resource}${c.check}`} className="bad-text">
                  {c.resource}: {c.check} {c.detail ? `(${c.detail})` : ""}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {report && !rolledBack ? (
        <section className="card">
          <div className="row">
            <h2 className="grow">{copy.finish.report}</h2>
            <a
              className="btn small"
              href={`/api/runs/${runId}/report.md`}
              download="migration-report.md"
            >
              <Download size={14} aria-hidden="true" /> {copy.finish.download}
            </a>
            <a
              className="btn small"
              href={`/api/runs/${runId}/manifest.json`}
              download="manifest.json"
            >
              {copy.finish.manifest}
            </a>
          </div>
          <pre className="report">{report}</pre>
        </section>
      ) : null}

      <div className="alert warn">
        <ShieldAlert size={18} aria-hidden="true" />
        <div>{copy.finish.revoke}</div>
      </div>
      {error ? <ErrorBox message={error.message} hint={error.hint} /> : null}

      <section className="card danger-zone">
        {!rolledBack ? (
          <>
            <h2>{copy.finish.rollbackTitle}</h2>
            <p>{copy.finish.rollbackBody}</p>
            <button
              type="button"
              className="btn danger"
              onClick={() => void openRollback()}
            >
              {copy.finish.rollbackAction}
            </button>
          </>
        ) : null}
        <div className="actions">
          <button type="button" className="btn" onClick={() => void purge()}>
            {copy.finish.purge}
          </button>
          <button type="button" className="btn primary" onClick={onGone}>
            {copy.finish.again}
          </button>
        </div>
      </section>

      <Dialog
        open={rollback !== null}
        title={copy.finish.rollbackTitle}
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
            <label>
              {copy.finish.rollbackPhrase}:{" "}
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
                {copy.review.cancel}
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
                  copy.finish.rollbackAction
                )}
              </button>
            </div>
          </>
        ) : null}
      </Dialog>
    </main>
  );
}
