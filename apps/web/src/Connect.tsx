import { ArrowRight, Check, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorText } from "./api";
import { copy } from "./copy";
import type { RunListItem } from "./types";
import { ErrorBox, Spinner, when } from "./ui";

export function Connect({
  onRun,
}: {
  onRun: (runId: string, scanned: boolean) => void;
}) {
  const [coolifyUrl, setCoolifyUrl] = useState("");
  const [token, setToken] = useState("");
  const [dokployUrl, setDokployUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [http, setHttp] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [phase, setPhase] = useState<"idle" | "connecting" | "scanning">(
    "idle",
  );
  const [error, setError] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  const [runs, setRuns] = useState<RunListItem[]>([]);

  useEffect(() => {
    api<{ runs: RunListItem[] }>("GET", "/runs")
      .then((r) => setRuns(r.runs))
      .catch(() => undefined);
  }, []);

  const insecure =
    /^http:\/\//i.test(coolifyUrl) || /^http:\/\//i.test(dokployUrl);
  const busy = phase !== "idle";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setPhase("connecting");
    let runId: string | undefined;
    try {
      const created = await api<{ runId: string }>("POST", "/runs", {
        coolify: { url: coolifyUrl, token, allowInsecureHttp: http },
        dokploy: { url: dokployUrl, apiKey, allowInsecureHttp: http },
      });
      runId = created.runId;
      // secrets are held by the server from here on: clear them from the page
      setToken("");
      setApiKey("");
      setPhase("scanning");
      await api("POST", `/runs/${runId}/discover`);
      onRun(runId, true);
    } catch (e) {
      setError(errorText(e));
      setPhase("idle");
      if (runId) onRun(runId, false); // connected, but the scan failed: retry from the next screen
    }
  };

  return (
    <main className="main">
      <h1>{copy.connect.title}</h1>
      <p className="lede">{copy.connect.lead}</p>

      <form onSubmit={submit}>
        <div className="docks">
          <fieldset
            className="dock"
            data-live={phase === "scanning"}
            disabled={busy}
            style={{ margin: 0 }}
          >
            <h2>{copy.connect.coolify}</h2>
            <p className="role">{copy.connect.coolifyRole}</p>
            <label className="field">
              {copy.connect.url}
              <input
                type="url"
                placeholder="https://coolify.example.com"
                value={coolifyUrl}
                onChange={(e) => setCoolifyUrl(e.target.value)}
                required
              />
            </label>
            <label className="field">
              {copy.connect.token}
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
              />
            </label>
          </fieldset>
          <div
            className="bridge"
            data-state={busy ? "live" : "idle"}
            aria-hidden="true"
          >
            <span className="joint">
              {phase === "scanning" ? (
                <Check size={18} />
              ) : (
                <ArrowRight size={18} />
              )}
            </span>
          </div>
          <fieldset
            className="dock"
            data-live={phase === "scanning"}
            disabled={busy}
            style={{ margin: 0 }}
          >
            <h2>{copy.connect.dokploy}</h2>
            <p className="role">{copy.connect.dokployRole}</p>
            <label className="field">
              {copy.connect.url}
              <input
                type="url"
                placeholder="https://dokploy.example.com"
                value={dokployUrl}
                onChange={(e) => setDokployUrl(e.target.value)}
                required
              />
            </label>
            <label className="field">
              {copy.connect.apiKey}
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required
              />
            </label>
          </fieldset>
        </div>

        <ul className="promise">
          {copy.connect.promises.map((line) => (
            <li key={line}>
              <ShieldCheck size={16} aria-hidden="true" />
              {line}
            </li>
          ))}
        </ul>

        {insecure ? (
          <label className="check">
            <input
              type="checkbox"
              checked={http}
              onChange={(e) => setHttp(e.target.checked)}
            />
            <span>{copy.connect.http}</span>
          </label>
        ) : null}
        <label className="check">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          <span>{copy.connect.accept}</span>
        </label>
        {error ? <ErrorBox message={error.message} hint={error.hint} /> : null}
        <div className="actions">
          <button
            className="btn primary"
            type="submit"
            disabled={!accepted || busy || (insecure && !http)}
          >
            {busy ? (
              <Spinner
                label={
                  phase === "connecting"
                    ? copy.connect.connecting
                    : copy.connect.scanning
                }
              />
            ) : (
              copy.connect.submit
            )}
          </button>
        </div>
      </form>

      <section className="history" aria-labelledby="prev">
        <h2 id="prev">{copy.connect.previous}</h2>
        {runs.length === 0 ? (
          <p className="muted">{copy.connect.none}</p>
        ) : (
          <ul>
            {runs.map((r) => (
              <li key={r.id}>
                <div>
                  <strong>{r.name}</strong>
                  <div className="muted small">
                    {r.status.replace("_", " ")} · {when(r.updatedAt)}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => onRun(r.id, true)}
                >
                  {copy.connect.open}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
