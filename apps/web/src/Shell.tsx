import { Check, Container, LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { copy } from "./copy";
import type { RunView } from "./types";

const host = (url: string) =>
  url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** Left rail: where you are in the journey, and which two servers this run is connected to. */
export function Shell({
  stage,
  run,
  onHome,
  onSignOut,
  children,
}: {
  stage: number;
  run: RunView | null;
  onHome: () => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  return (
    <div className="app">
      <aside className="rail">
        <a href="#/" className="brand" onClick={onHome}>
          <Container size={22} aria-hidden="true" />
          {copy.product}
        </a>
        <ol className="journey" aria-label="Progress">
          {copy.steps.map((label, i) => (
            <li
              key={label}
              className={i < stage ? "done" : i === stage ? "current" : ""}
              aria-current={i === stage ? "step" : undefined}
            >
              <span className="pip">
                {i < stage ? <Check size={12} aria-hidden="true" /> : null}
              </span>
              {label}
            </li>
          ))}
        </ol>
        <div className="ends">
          {run ? (
            <>
              <div className="end">
                <b>From Coolify {run.coolifyVersion ?? ""}</b>
                <span title={run.coolifyUrl}>{host(run.coolifyUrl)}</span>
              </div>
              <div className="end">
                <b>To Dokploy {run.dokployVersion ?? ""}</b>
                <span title={run.dokployUrl}>{host(run.dokployUrl)}</span>
              </div>
            </>
          ) : null}
          <button type="button" className="btn quiet small" onClick={onSignOut}>
            <LogOut size={14} aria-hidden="true" /> {copy.common.signOut}
          </button>
        </div>
      </aside>
      {children}
    </div>
  );
}
