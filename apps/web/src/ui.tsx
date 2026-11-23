import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Hand,
  Info,
  Loader2,
  X,
  XCircle,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import type { Compat } from "./types";

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner" role="status">
      <Loader2 className="spin" size={16} aria-hidden="true" />
      {label ?? "Loading…"}
    </span>
  );
}

/** A grey shimmering placeholder with the real element's footprint, so nothing jumps when data arrives. */
export function Skeleton({
  w,
  h = "1rem",
  r,
}: {
  w?: string;
  h?: string;
  r?: string;
}) {
  return (
    <div
      className="skeleton"
      aria-hidden="true"
      style={{
        width: w ?? "100%",
        height: h,
        ...(r ? { borderRadius: r } : {}),
      }}
    />
  );
}

/** Icon + word + colour: status is never colour alone. */
export function CompatBadge({ compat }: { compat: Compat }) {
  const map = {
    auto: {
      icon: <CheckCircle2 size={13} aria-hidden="true" />,
      text: "Ready",
      tone: "ok",
    },
    partial: {
      icon: <AlertTriangle size={13} aria-hidden="true" />,
      text: "Needs a look",
      tone: "warn",
    },
    manual: {
      icon: <Hand size={13} aria-hidden="true" />,
      text: "Manual",
      tone: "bad",
    },
  }[compat];
  return (
    <span className={`chip ${map.tone}`}>
      {map.icon}
      {map.text}
    </span>
  );
}

const RUN_STATUS: Record<
  string,
  { text: string; tone: "ok" | "warn" | "bad" | "info" | "" }
> = {
  connected: { text: "Scanning", tone: "info" },
  discovering: { text: "Scanning", tone: "info" },
  discovered: { text: "Choosing", tone: "info" },
  selected: { text: "Choosing", tone: "info" },
  reported: { text: "Choosing", tone: "info" },
  configured: { text: "Choosing", tone: "info" },
  planned: { text: "Ready to review", tone: "info" },
  running: { text: "Migrating", tone: "info" },
  paused: { text: "Paused", tone: "warn" },
  paused_failed: { text: "Needs attention", tone: "bad" },
  applied: { text: "Created in Dokploy", tone: "ok" },
  verifying: { text: "Verifying", tone: "info" },
  verified: { text: "Verified", tone: "ok" },
  completed: { text: "Completed", tone: "ok" },
  cancelled: { text: "Cancelled", tone: "" },
  failed: { text: "Failed", tone: "bad" },
  rolled_back: { text: "Rolled back", tone: "" },
};
export function RunStatus({ status }: { status: string }) {
  const s = RUN_STATUS[status] ?? {
    text: status.replace(/_/g, " "),
    tone: "" as const,
  };
  return (
    <span className={`chip ${s.tone}`}>
      <span className="dot" />
      {s.text}
    </span>
  );
}

export function Alert({
  tone,
  icon,
  children,
}: {
  tone: "ok" | "warn" | "bad" | "info";
  icon?: ReactNode;
  children: ReactNode;
}) {
  const Icon =
    tone === "ok"
      ? CheckCircle2
      : tone === "warn"
        ? AlertTriangle
        : tone === "bad"
          ? XCircle
          : Info;
  return (
    <div
      className={`alert ${tone}`}
      role={tone === "bad" ? "alert" : undefined}
    >
      {icon ?? <Icon size={18} aria-hidden="true" />}
      <div>{children}</div>
    </div>
  );
}

/** What went wrong, how to fix it, and a way to try again. Never vague, never apologetic. */
export function ErrorState({
  message,
  hint,
  onRetry,
}: {
  message: string;
  hint?: string | undefined;
  onRetry?: () => void;
}) {
  return (
    <Alert tone="bad">
      <strong>{message}</strong>
      {hint ? <p>{hint}</p> : null}
      {onRetry ? (
        <button
          type="button"
          className="btn small"
          style={{ marginTop: "0.6rem" }}
          onClick={onRetry}
        >
          Try again
        </button>
      ) : null}
    </Alert>
  );
}
export const ErrorBox = ErrorState;

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="art">{icon}</div>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

/** Native <dialog>: focus trap, Escape to close and focus return come for free. */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  variant = "dialog",
  description,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  variant?: "dialog" | "drawer";
  description?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const id = `dlg-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <dialog
      ref={ref}
      className={`dialog ${variant === "drawer" ? "drawer" : ""}`}
      aria-labelledby={id}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // click on the backdrop
      }}
    >
      {open ? (
        <>
          <div className="dialog-head">
            <div>
              <h2 id={id}>{title}</h2>
              {description ? (
                <p className="muted small" style={{ margin: "0.25rem 0 0" }}>
                  {description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              className="btn quiet icon"
              onClick={onClose}
              aria-label="Close"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <div className="dialog-body">
            {children}
            {footer ? <div className="dialog-foot">{footer}</div> : null}
          </div>
        </>
      ) : null}
    </dialog>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  label = "items",
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  label?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const shown = new Set(
    [1, pages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pages),
  );
  const list = [...shown].sort((a, b) => a - b);
  return (
    <nav className="pager" aria-label="Pagination">
      <span>
        {from}–{to} of {total} {label}
      </span>
      <span className="pages">
        <button
          type="button"
          className="btn small icon"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        {list.map((p, i) => (
          <span key={p} className="row" style={{ gap: "0.25rem" }}>
            {i > 0 && p - (list[i - 1] ?? 0) > 1 ? (
              <span aria-hidden="true">…</span>
            ) : null}
            <button
              type="button"
              className="btn small icon"
              aria-label={`Page ${p}`}
              aria-current={p === page ? "page" : undefined}
              onClick={() => onPage(p)}
            >
              {p}
            </button>
          </span>
        ))}
        <button
          type="button"
          className="btn small icon"
          aria-label="Next page"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </span>
    </nav>
  );
}

export const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
export const hostOf = (url: string) =>
  url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/**
 * A form field with a real label, and its hint and error linked with aria-describedby, so the accessible name is
 * just the label. The render prop receives the props the control needs.
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null | undefined;
  children: (p: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid": boolean;
  }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const described = [hint ? hintId : "", error ? errId : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        ...(described ? { "aria-describedby": described } : {}),
        "aria-invalid": Boolean(error),
      })}
      {hint ? (
        <span id={hintId} className="hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <p id={errId} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** "0.31.4" and "v0.31.4" both become "v0.31.4". */
export const ver = (v?: string | null) =>
  v ? (v.startsWith("v") ? v : `v${v}`) : "";
/** "1 resource", "2 resources". */
export const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : "s"}`;
/** Rule ids are for the docs and logs, not for people: "R-073: Template needs input" becomes "Template needs input". */
export const plain = (text: string) => text.replace(/^R-\d+:\s*/, "");
/** Join a message and its fix as two readable sentences. */
export const sentence = (message: string, fix?: string) => {
  const end = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
  return fix ? `${end(message)} ${end(fix)}` : end(message);
};
