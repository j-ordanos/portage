import { Plus, ServerCog } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, api, errorText } from "./api";
import { useAuth } from "./auth";
import { ConnectionCard, ConnectionDialog } from "./Connections";
import { go, type Route } from "./router";
import { useToast } from "./toast";
import type { Connection } from "./types";
import { Dialog, EmptyState, ErrorState, Field, Skeleton, Spinner } from "./ui";

export function Settings({ tab }: { tab: "connections" | "account" }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Your saved servers and your account.</p>
        </div>
      </div>
      <div className="tabs" role="tablist" aria-label="Settings sections">
        <a
          href="#/settings"
          role="tab"
          aria-current={tab === "connections" ? "page" : undefined}
        >
          Connections
        </a>
        <a
          href="#/settings/account"
          role="tab"
          aria-current={tab === "account" ? "page" : undefined}
        >
          Account
        </a>
      </div>
      {tab === "connections" ? <ConnectionsTab /> : <AccountTab />}
    </>
  );
}

function ConnectionsTab() {
  const [list, setList] = useState<Connection[] | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  const [dialog, setDialog] = useState<{
    kind: "coolify" | "dokploy";
    existing: Connection | null;
  } | null>(null);
  const [removing, setRemoving] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    setError(null);
    try {
      setList(
        (await api<{ connections: Connection[] }>("GET", "/connections"))
          .connections,
      );
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api("DELETE", `/connections/${removing.id}`);
      toast(`${removing.name} deleted`);
      setRemoving(null);
      await load();
    } catch (e) {
      toast(errorText(e).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  const replace = (c: Connection) =>
    setList((prev) => (prev ? prev.map((x) => (x.id === c.id ? c : x)) : prev));

  if (error)
    return (
      <ErrorState
        message={error.message}
        hint={error.hint}
        onRetry={() => void load()}
      />
    );

  const section = (
    kind: "coolify" | "dokploy",
    title: string,
    blurb: string,
  ) => {
    const items = list?.filter((c) => c.kind === kind) ?? [];
    return (
      <section className="conn-section" aria-labelledby={`h-${kind}`}>
        <div className="section-head">
          <div>
            <h2 id={`h-${kind}`}>{title}</h2>
            <p className="muted" style={{ margin: "0.15rem 0 0" }}>
              {blurb}
            </p>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => setDialog({ kind, existing: null })}
          >
            <Plus size={16} aria-hidden="true" /> Add {title}
          </button>
        </div>
        {list === null ? (
          <div className="conn-grid" aria-busy="true">
            <div className="conn">
              <Skeleton w="50%" h="1.1rem" />
              <Skeleton w="80%" h="0.8rem" />
              <Skeleton w="8rem" h="2rem" r="6px" />
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<ServerCog size={24} aria-hidden="true" />}
              title={`No ${title} yet`}
            >
              {kind === "coolify"
                ? "Add the Coolify you want to read projects from."
                : "Add the Dokploy you want to create projects in."}
            </EmptyState>
          </div>
        ) : (
          <div className="conn-grid">
            {items.map((c) => (
              <ConnectionCard
                key={c.id}
                c={c}
                onEdit={() => setDialog({ kind, existing: c })}
                onDelete={() => setRemoving(c)}
                onTested={replace}
              />
            ))}
          </div>
        )}
      </section>
    );
  };

  return (
    <>
      <div className="alert info" style={{ marginTop: 0 }}>
        <div>
          Tokens and keys are encrypted on this server and can never be read
          back, only replaced. You pick a saved connection when you start a
          migration.
        </div>
      </div>
      {section(
        "coolify",
        "Coolify",
        "Where your projects live now. It is only read.",
      )}
      {section(
        "dokploy",
        "Dokploy",
        "Where they are going. Portage only creates new resources.",
      )}

      {dialog ? (
        <ConnectionDialog
          kind={dialog.kind}
          existing={dialog.existing}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void load();
          }}
        />
      ) : null}
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Delete ${removing?.name ?? "connection"}?`}
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setRemoving(null)}
            >
              Keep it
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? <Spinner label="Deleting…" /> : "Delete connection"}
            </button>
          </>
        }
      >
        <p>
          The saved address and key are erased. Migrations that used it can no
          longer reach that server until you add it again.
        </p>
      </Dialog>
    </>
  );
}

function AccountTab() {
  const { user, signOut } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("PUT", "/auth/password", { current, next });
      setCurrent("");
      setNext("");
      toast("Password changed. Other devices were signed out.");
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : "Could not change the password",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ maxWidth: "34rem" }}>
      <section className="card pad">
        <h2>Account</h2>
        <p className="muted">
          Signed in as{" "}
          <strong style={{ color: "var(--ink)" }}>{user?.email}</strong>
        </p>
        <button type="button" className="btn" onClick={() => void signOut()}>
          Sign out
        </button>
      </section>
      <form className="card pad" onSubmit={submit}>
        <h2>Change password</h2>
        <div style={{ marginTop: "0.75rem" }}>
          <Field label="Current password">
            {(f) => (
              <input
                {...f}
                className="input"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
              />
            )}
          </Field>
        </div>
        <Field
          label="New password"
          hint="At least 10 characters. Changing it signs out your other devices."
        >
          {(f) => (
            <input
              {...f}
              className="input"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              minLength={10}
            />
          )}
        </Field>
        {error ? <ErrorState message={error} /> : null}
        <button
          type="submit"
          className="btn primary"
          disabled={busy || next.length < 10 || !current}
        >
          {busy ? <Spinner label="Saving…" /> : "Change password"}
        </button>
      </form>
    </div>
  );
}

export type { Route };
export { go };
