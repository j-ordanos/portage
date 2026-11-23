import { Container } from "lucide-react";
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
    <main className="login">
      <div className="brand">
        <Container size={24} aria-hidden="true" />
        {copy.product}
      </div>
      <h1 style={{ marginTop: "1.4rem" }}>{copy.signIn.title}</h1>
      <p className="lede">{copy.tagline}</p>
      <form className="dock" onSubmit={submit}>
        <label className="field">
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
