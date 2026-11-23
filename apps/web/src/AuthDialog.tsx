import { Eye, EyeOff, Lock } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { useAuth } from "./auth";
import { Dialog, ErrorState, Field, Spinner } from "./ui";

/** Minimal sign-in and sign-up in one dialog: an email, a password, nothing else to fill in. */
export function AuthDialog({
  open,
  mode,
  onMode,
  onClose,
  onDone,
}: {
  open: boolean;
  mode: "signin" | "signup";
  onMode: (m: "signin" | "signup") => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const { refresh, allowSignup } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setError(null);
      setTouched(false);
      setPassword("");
    }
  }, [open, mode]);

  const emailBad =
    touched && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  const passBad = touched && mode === "signup" && password.length < 10;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()) ||
      (mode === "signup" && password.length < 10)
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api("POST", mode === "signup" ? "/auth/register" : "/auth/login", {
        email: email.trim(),
        password,
      });
      setPassword("");
      await refresh();
      onDone();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.status === 429
            ? "Too many attempts. Wait a minute and try again."
            : e.message
          : "Could not reach the server. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const signup = mode === "signup";
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={signup ? "Create your account" : "Welcome back"}
      description={
        signup
          ? "One email and a password. No verification emails, no spam."
          : "Sign in to see your saved servers and migrations."
      }
    >
      <div className="tabs" role="tablist" aria-label="Account">
        <button
          type="button"
          role="tab"
          aria-selected={!signup}
          onClick={() => onMode("signin")}
        >
          Sign in
        </button>
        {allowSignup ? (
          <button
            type="button"
            role="tab"
            aria-selected={signup}
            onClick={() => onMode("signup")}
          >
            Create account
          </button>
        ) : null}
      </div>
      <form onSubmit={submit} noValidate>
        <Field
          label="Email"
          error={emailBad ? "Enter a valid email address." : null}
        >
          {(f) => (
            <input
              {...f}
              className="input"
              type="email"
              autoComplete="email"
              inputMode="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          )}
        </Field>
        <Field
          label="Password"
          hint={signup ? "At least 10 characters." : undefined}
          error={passBad ? "Use at least 10 characters." : null}
        >
          {(f) => (
            <span className="with-action" style={{ display: "block" }}>
              <input
                {...f}
                className="input"
                type={show ? "text" : "password"}
                autoComplete={signup ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="btn quiet icon"
                onClick={() => setShow(!show)}
                aria-label={show ? "Hide password" : "Show password"}
              >
                {show ? (
                  <EyeOff size={16} aria-hidden="true" />
                ) : (
                  <Eye size={16} aria-hidden="true" />
                )}
              </button>
            </span>
          )}
        </Field>
        {error ? <ErrorState message={error} /> : null}
        <button
          type="submit"
          className="btn primary"
          style={{ width: "100%" }}
          disabled={busy}
        >
          {busy ? (
            <Spinner label={signup ? "Creating account…" : "Signing in…"} />
          ) : signup ? (
            "Create account"
          ) : (
            "Sign in"
          )}
        </button>
        <p
          className="muted small row"
          style={{ marginTop: "1rem", gap: "0.4rem" }}
        >
          <Lock size={13} aria-hidden="true" /> Passwords are hashed with
          argon2id. Your server tokens are encrypted.
        </p>
      </form>
    </Dialog>
  );
}
