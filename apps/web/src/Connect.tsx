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
      if (runId) onRun(runId, false); // connection worked, scan failed: let the user retry from the next screen
    }
  };

  return (
    <main>
      <h1>{copy.connect.title}</h1>
      <p className="muted">{copy.connect.lead}</p>
      <form onSubmit={submit}>
        <div className="grid two">
          <fieldset className="card">
            <legend>{copy.connect.coolify}</legend>
            <label>
              {copy.connect.url}
              <input
                type="url"
                placeholder="https://coolify.example.com"
                value={coolifyUrl}
                onChange={(e) => setCoolifyUrl(e.target.value)}
                required
              />
            </label>
            <label>
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
          <fieldset className="card">
            <legend>{copy.connect.dokploy}</legend>
            <label>
              {copy.connect.url}
              <input
                type="url"
                placeholder="https://dokploy.example.com"
                value={dokployUrl}
                onChange={(e) => setDokployUrl(e.target.value)}
                required
              />
            </label>
            <label>
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
        {insecure ? (
          <label className="check">
            <input
              type="checkbox"
              checked={http}
              onChange={(e) => setHttp(e.target.checked)}
            />
            {copy.connect.http}
          </label>
        ) : null}
        <ul className="notice">
          {copy.connect.notice.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <label className="check">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          {copy.connect.accept}
        </label>
        {error ? <ErrorBox message={error.message} hint={error.hint} /> : null}
        <button
          className="btn primary"
          type="submit"
          disabled={!accepted || phase !== "idle" || (insecure && !http)}
        >
          {phase === "idle" ? (
            copy.connect.submit
          ) : (
            <Spinner
              label={
                phase === "connecting" ? "Connecting…" : copy.connect.scanning
              }
            />
          )}
        </button>
      </form>

      <section aria-labelledby="prev">
        <h2 id="prev">{copy.connect.previous}</h2>
        {runs.length === 0 ? (
          <p className="muted">{copy.connect.none}</p>
        ) : (
          <ul className="runs">
            {runs.map((r) => (
              <li key={r.id}>
                <div>
                  <strong>{r.name}</strong>
                  <div className="muted small">
                    {r.status} · {when(r.updatedAt)}
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
