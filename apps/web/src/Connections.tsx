import {
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  Lock,
  RefreshCw,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { useToast } from "./toast";
import type { Connection } from "./types";
import { ago, Dialog, ErrorState, Field, Spinner, ver } from "./ui";

const COPY = {
  coolify: {
    title: "Coolify",
    secret: "API token",
    placeholder: "https://coolify.example.com",
    help: "In Coolify open Keys & Tokens, then API tokens. A read-only token is enough. Add the “sensitive” permission only if you want environment variable values copied.",
    docs: "#/docs/coolify-token",
  },
  dokploy: {
    title: "Dokploy",
    secret: "API key",
    placeholder: "https://dokploy.example.com",
    help: "In Dokploy open Settings, then Profile, then API/CLI, and create a key. Portage only creates new projects and resources with it.",
    docs: "#/docs/dokploy-key",
  },
} as const;

/** Add or edit a saved server. The secret is tested before anything is saved, and is never shown again. */
export function ConnectionDialog({
  kind,
  existing,
  onClose,
  onSaved,
}: {
  kind: "coolify" | "dokploy";
  existing: Connection | null;
  onClose: () => void;
  onSaved: (c: Connection) => void;
}) {
  const c = COPY[kind];
  const editing = existing !== null;
  const [name, setName] = useState(existing?.name ?? "");
  const [url, setUrl] = useState(existing?.url ?? "");
  const [secret, setSecret] = useState("");
  const [show, setShow] = useState(false);
  const [http, setHttp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{
    message: string;
    hint?: string;
    field?: "url" | "secret" | "name";
  } | null>(null);
  const toast = useToast();

  useEffect(() => {
    setName(existing?.name ?? "");
    setUrl(existing?.url ?? "");
    setSecret("");
    setError(null);
    setHttp(false);
  }, [existing]);

  const insecure = /^http:\/\//i.test(url);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { kind, name, url, secret, allowInsecureHttp: http };
      const res = editing
        ? await api<{ connection: Connection }>(
            "PUT",
            `/connections/${existing.id}`,
            { name, url, secret, allowInsecureHttp: http },
          )
        : await api<{ connection: Connection }>(
            "POST",
            "/connections",
            payload,
          );
      setSecret(""); // gone from the page; the server holds it encrypted
      toast(editing ? "Connection updated" : `${c.title} connected and saved`);
      onSaved(res.connection);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      const field =
        err && /address|url|http|metadata|private/i.test(err.message)
          ? "url"
          : err && err.status === 422
            ? "secret"
            : err?.status === 409
              ? "name"
              : undefined;
      setError({
        message:
          err?.message ??
          "Could not reach the server. Check your connection and try again.",
        ...(err?.hint ? { hint: err.hint } : {}),
        ...(field ? { field } : {}),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? `Edit ${existing.name}` : `Connect ${c.title}`}
      description={c.help}
    >
      <form onSubmit={submit} noValidate>
        <Field
          label="Name"
          hint="Only for you, to tell servers apart."
          error={error?.field === "name" ? error.message : null}
        >
          {(f) => (
            <input
              {...f}
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`My ${c.title}`}
              required
              maxLength={40}
              autoFocus={!editing}
            />
          )}
        </Field>
        <Field
          label="Address"
          error={error?.field === "url" ? error.message : null}
        >
          {(f) => (
            <input
              {...f}
              className="input mono"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={c.placeholder}
              required
            />
          )}
        </Field>
        {insecure ? (
          <label className="check">
            <input
              type="checkbox"
              checked={http}
              onChange={(e) => setHttp(e.target.checked)}
            />
            <span>This address uses http://, not https://. Allow it.</span>
          </label>
        ) : null}
        <Field
          label={c.secret}
          hint={
            <a href={c.docs}>
              How to create one <ExternalLink size={11} aria-hidden="true" />
            </a>
          }
          error={error?.field === "secret" ? error.message : null}
        >
          {(f) => (
            <span className="with-action" style={{ display: "block" }}>
              <input
                {...f}
                className="input mono"
                type={show ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={editing ? "Saved. Leave empty to keep it." : ""}
                required={!editing}
              />
              <button
                type="button"
                className="btn quiet icon"
                onClick={() => setShow(!show)}
                aria-label={show ? `Hide ${c.secret}` : `Show ${c.secret}`}
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
        {error && !error.field ? (
          <ErrorState message={error.message} hint={error.hint} />
        ) : null}
        {error?.hint && error.field ? (
          <p className="muted small">{error.hint}</p>
        ) : null}
        <p className="muted small row" style={{ gap: "0.4rem" }}>
          <Lock size={13} aria-hidden="true" /> Tested before saving, then
          encrypted. It can never be read back, only replaced.
        </p>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={
              busy ||
              !name.trim() ||
              !url.trim() ||
              (!editing && !secret.trim())
            }
          >
            {busy ? (
              <Spinner label="Testing connection…" />
            ) : editing ? (
              "Save changes"
            ) : (
              "Test and save"
            )}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** One saved server: status at a glance, and the four things you do with it. */
export function ConnectionCard({
  c,
  onEdit,
  onDelete,
  onTested,
}: {
  c: Connection;
  onEdit: () => void;
  onDelete: () => void;
  onTested: (c: Connection) => void;
}) {
  const [testing, setTesting] = useState(false);
  const toast = useToast();
  const test = async () => {
    setTesting(true);
    try {
      const res = await api<{ connection: Connection }>(
        "POST",
        `/connections/${c.id}/test`,
      );
      onTested(res.connection);
      toast(`${c.name} is reachable`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not reach it", "bad");
      // pull the recorded failure so the card shows it
      api<{ connections: Connection[] }>("GET", "/connections").then((r) => {
        const fresh = r.connections.find((x) => x.id === c.id);
        if (fresh) onTested(fresh);
      });
    } finally {
      setTesting(false);
    }
  };
  const ok = c.check?.ok === true;
  return (
    <div className="conn">
      <div className="top">
        <div style={{ minWidth: 0 }}>
          <h3 style={{ overflowWrap: "anywhere" }}>{c.name}</h3>
          <div className="url">{c.url.replace(/\/$/, "")}</div>
        </div>
        {c.check ? (
          <span className={`chip ${ok ? "ok" : "bad"}`} title={c.check.message}>
            {ok ? <CheckCircle2 size={13} aria-hidden="true" /> : null}
            {ok ? ver(c.check.version) : "Can't connect"}
          </span>
        ) : (
          <span className="chip">Not tested</span>
        )}
      </div>
      <div className="small muted">
        {c.check ? `Tested ${ago(c.check.at)}` : "Never tested"}
        {c.lastUsedAt ? ` · Used ${ago(c.lastUsedAt)}` : " · Not used yet"}
        {!ok && c.check?.message ? ` · ${c.check.message}` : ""}
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn small"
          onClick={() => void test()}
          disabled={testing}
        >
          {testing ? (
            <Spinner label="Testing…" />
          ) : (
            <>
              <RefreshCw size={14} aria-hidden="true" /> Test
            </>
          )}
        </button>
        <button type="button" className="btn small" onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          className="btn small quiet danger"
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
    </div>
  );
}
