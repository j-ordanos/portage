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

/** Icon + text + colour, never colour alone. */
export function CompatBadge({ compat }: { compat: Compat }) {
  const map = {
    auto: {
      icon: <CheckCircle2 size={14} aria-hidden="true" />,
      text: "Ready",
      cls: "ok",
    },
    partial: {
      icon: <AlertTriangle size={14} aria-hidden="true" />,
      text: "Review",
      cls: "warn",
    },
    manual: {
      icon: <Hand size={14} aria-hidden="true" />,
      text: "Manual",
      cls: "bad",
    },
  }[compat];
  return (
    <span className={`badge ${map.cls}`}>
      {map.icon}
      {map.text}
    </span>
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
    <div className="alert bad" role="alert">
      <XCircle size={18} aria-hidden="true" />
      <div>
        <strong>{message}</strong>
        {hint ? <p>{hint}</p> : null}
        {onRetry ? (
          <button type="button" className="btn small" onClick={onRetry}>
            {copy.common.retry}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function Stepper({ stage }: { stage: number }) {
  return (
    <ol className="stepper" aria-label="Progress">
      {copy.steps.map((label, index) => (
        <li
          key={label}
          className={index < stage ? "done" : index === stage ? "current" : ""}
          aria-current={index === stage ? "step" : undefined}
        >
          <span className="dot">
            {index < stage ? (
              <CheckCircle2 size={14} aria-hidden="true" />
            ) : (
              index + 1
            )}
          </span>
          {label}
        </li>
      ))}
    </ol>
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
