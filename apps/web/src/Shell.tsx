import {
  BookOpen,
  Check,
  FolderKanban,
  Settings as Gear,
  LogOut,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAuth } from "./auth";
import { AUTHOR, Logo, REPOSITORY, VERSION } from "./brand";
import type { Route } from "./router";
import { ThemeSwitch } from "./theme";
import { hostOf } from "./ui";

export const STAGES = [
  "connect",
  "choose",
  "review",
  "migrate",
  "finish",
] as const;
export type Stage = (typeof STAGES)[number];
const LABEL: Record<Stage, string> = {
  connect: "Connect",
  choose: "Choose",
  review: "Review",
  migrate: "Migrate",
  finish: "Finish",
};

function AccountMenu() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  if (!user) return null;
  return (
    <div className="menu-wrap" ref={ref}>
      <button
        type="button"
        className="avatar"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen(!open)}
      >
        {user.email.slice(0, 1).toUpperCase()}
      </button>
      {open ? (
        <div className="menu" role="menu">
          <div className="who">
            <div className="small muted">Signed in as</div>
            <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>
              {user.email}
            </div>
          </div>
          <a href="#/settings" role="menuitem" onClick={() => setOpen(false)}>
            <Gear size={16} aria-hidden="true" /> Settings
          </a>
          <a href="#/docs" role="menuitem" onClick={() => setOpen(false)}>
            <BookOpen size={16} aria-hidden="true" /> Documentation
          </a>
          <button type="button" role="menuitem" onClick={() => void signOut()}>
            <LogOut size={16} aria-hidden="true" /> Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function TopBar({
  route,
  onSignIn,
}: {
  route: Route;
  onSignIn?: () => void;
}) {
  const { user } = useAuth();
  const cur = (page: Route["page"][]) =>
    page.includes(route.page) ? "page" : undefined;
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a href="#/" className="brand">
          <Logo />
          Portage
        </a>
        <nav className="nav" aria-label="Main">
          {user ? (
            <a href="#/" aria-current={cur(["home", "run", "new"])}>
              <FolderKanban size={16} aria-hidden="true" /> Migrations
            </a>
          ) : null}
          <a href="#/docs" aria-current={cur(["docs"])}>
            <BookOpen size={16} aria-hidden="true" /> Docs
          </a>
          {user ? (
            <a href="#/settings" aria-current={cur(["settings"])}>
              <Gear size={16} aria-hidden="true" /> Settings
            </a>
          ) : null}
        </nav>
        <span className="spacer" />
        <ThemeSwitch />
        <AccountMenu />
        {!user && onSignIn ? (
          <button type="button" className="btn small" onClick={onSignIn}>
            Sign in
          </button>
        ) : null}
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span>
          Portage v{VERSION} · Made by{" "}
          <a href={AUTHOR.github} target="_blank" rel="noreferrer">
            {AUTHOR.name}
          </a>
        </span>
        <span className="links">
          <a href="#/docs">Docs</a>
          <a href="#/docs/security">Security</a>
          <a href={REPOSITORY} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </span>
      </div>
    </footer>
  );
}

/**
 * The journey, with a way back: every finished step is a link. Once resources are being written to Dokploy
 * (migrate onwards) earlier steps lock, because changing choices then would no longer match what was created.
 */
export function FlowBar({
  current,
  furthest,
  locked,
  onGo,
  coolify,
  dokploy,
}: {
  current: Stage;
  furthest: Stage;
  locked: boolean;
  onGo: (s: Stage) => void;
  coolify?: string;
  dokploy?: string;
}) {
  const ci = STAGES.indexOf(current);
  const fi = STAGES.indexOf(furthest);
  return (
    <div className="flow">
      <div className="flow-inner">
        <ol className="steps" aria-label="Progress">
          {STAGES.map((s, i) => {
            const state = i === ci ? "current" : i < fi || i < ci ? "done" : "";
            const clickable =
              i !== ci && i <= fi && !locked && i < STAGES.indexOf("migrate");
            return (
              <li key={s} className={state}>
                {clickable ? (
                  <button
                    type="button"
                    className="step done"
                    onClick={() => onGo(s)}
                    aria-label={`Back to ${LABEL[s]}`}
                  >
                    <span className="n">
                      <Check size={11} aria-hidden="true" />
                    </span>
                    {LABEL[s]}
                  </button>
                ) : (
                  <span
                    className={`step ${state}`}
                    aria-current={i === ci ? "step" : undefined}
                  >
                    <span className="n">
                      {state === "done" ? (
                        <Check size={11} aria-hidden="true" />
                      ) : (
                        i + 1
                      )}
                    </span>
                    {LABEL[s]}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
        {coolify && dokploy ? (
          <span className="ends" title="Source and target">
            {hostOf(coolify)} <span className="arrow">→</span> {hostOf(dokploy)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function Frame({
  route,
  children,
  flow,
  onSignIn,
}: {
  route: Route;
  children: ReactNode;
  flow?: ReactNode;
  onSignIn?: () => void;
}) {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <TopBar route={route} {...(onSignIn ? { onSignIn } : {})} />
      {flow}
      <main className="page" id="main">
        {children}
      </main>
      <Footer />
    </>
  );
}
