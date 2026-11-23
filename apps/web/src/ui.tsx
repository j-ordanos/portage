import {
  AlertTriangle,
  CheckCircle2,
  Hand,
  Loader2,
  XCircle,
} from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { copy } from "./copy";
import type { Compat } from "./types";

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner" role="status">
      <Loader2 className="spin" size={16} aria-hidden="true" />
      {label ?? copy.common.loading}
    </span>
  );
}

/** Icon + word + colour: status is never colour alone. */
export function CompatBadge({ compat }: { compat: Compat }) {
  const map = {
    auto: {
      icon: <CheckCircle2 size={14} aria-hidden="true" />,
      text: "Ready",
      tone: "ok",
    },
    partial: {
      icon: <AlertTriangle size={14} aria-hidden="true" />,
      text: "Needs a look",
      tone: "warn",
    },
    manual: {
      icon: <Hand size={14} aria-hidden="true" />,
      text: "Manual",
      tone: "bad",
    },
  }[compat];
  return (
    <span className={`badge ${map.tone}`}>
      {map.icon}
      {map.text}
    </span>
  );
}

export function Alert({
  tone,
  icon,
  children,
}: {
  tone: "ok" | "warn" | "bad";
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`alert ${tone}`}
      role={tone === "bad" ? "alert" : undefined}
    >
      {icon ??
        (tone === "ok" ? (
          <CheckCircle2 size={18} aria-hidden="true" />
        ) : tone === "warn" ? (
          <AlertTriangle size={18} aria-hidden="true" />
        ) : (
          <XCircle size={18} aria-hidden="true" />
        ))}
      <div>{children}</div>
    </div>
  );
}

export function ErrorBox({
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
        <button type="button" className="btn small" onClick={onRetry}>
          {copy.common.retry}
        </button>
      ) : null}
    </Alert>
  );
}

/** Native <dialog>: focus trap, Escape to close and focus return come for free. */
export function Dialog({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="dialog-title"
      onClose={onClose}
    >
      <h2 id="dialog-title">{title}</h2>
      {open ? children : null}
    </dialog>
  );
}

export const when = (ms: number) => new Date(ms).toLocaleString();
