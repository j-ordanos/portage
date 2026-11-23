import { type FormEvent, useState } from "react";
import { ApiError, api } from "./api";
import { copy } from "./copy";
import { ErrorBox } from "./ui";

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/auth/login", { password });
      setPassword("");
      onDone();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 429
          ? copy.signIn.tooMany
          : copy.signIn.error,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="narrow">
      <h1>{copy.product}</h1>
      <p className="muted">{copy.tagline}</p>
      <form className="card" onSubmit={submit}>
        <h2>{copy.signIn.title}</h2>
        <label>
          {copy.signIn.password}
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
          />
        </label>
        {error ? <ErrorBox message={error} /> : null}
        <button
          className="btn primary"
          type="submit"
          disabled={busy || password === ""}
        >
          {copy.signIn.submit}
        </button>
      </form>
    </main>
  );
}
