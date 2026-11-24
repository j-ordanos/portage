import {
  ArrowRight,
  BookOpen,
  Check,
  CircleCheck,
  Github,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "./auth";
import { AUTHOR, Logo, REPOSITORY, VERSION } from "./brand";
import { go } from "./router";
import { ThemeSwitch } from "./theme";

/** One screen, no scrolling on desktop: what it is, one button, and who made it. */
export function Landing({
  onStart,
  onSignIn,
}: {
  onStart: () => void;
  onSignIn: () => void;
}) {
  const { state } = useAuth();
  const signedIn = state === "user";
  return (
    <div className="land">
      <header
        className="topbar"
        style={{
          position: "static",
          background: "none",
          backdropFilter: "none",
          borderBottom: 0,
        }}
      >
        <div className="topbar-inner">
          <a href="#/" className="brand">
            <Logo />
            Portage
          </a>
          <nav className="nav" aria-label="Main">
            <a href="#/docs">Docs</a>
            <a href={REPOSITORY} target="_blank" rel="noreferrer">
              <Github size={16} aria-hidden="true" /> GitHub
            </a>
          </nav>
          <span className="spacer" />
          <ThemeSwitch />
          {signedIn ? (
            <a className="btn small" href="#/">
              Open your migrations
            </a>
          ) : (
            <>
              <button
                type="button"
                className="btn quiet small"
                onClick={onSignIn}
              >
                Sign in
              </button>
              <button type="button" className="btn small" onClick={onStart}>
                Create account
              </button>
            </>
          )}
        </div>
      </header>

      <main className="land-main" id="main">
        <section aria-labelledby="hero">
          <span className="pill">
            <b>v{VERSION}</b> Coolify 4 to Dokploy 0.31
          </span>
          <h1 id="hero">
            Move your projects from Coolify to <em>Dokploy</em>.
          </h1>
          <p className="lede">
            Portage recreates your projects in Dokploy: builds, repositories,
            domains, environment variables, volumes and databases. Nothing is
            deployed, and nothing in Coolify is changed.
          </p>
          <div className="cta">
            <button
              type="button"
              className="btn primary large"
              onClick={signedIn ? () => go({ page: "new" }) : onStart}
            >
              {signedIn ? "Start a migration" : "Get started, it's free"}{" "}
              <ArrowRight size={18} aria-hidden="true" />
            </button>
            <a className="btn large" href="#/docs">
              <BookOpen size={18} aria-hidden="true" /> How it works
            </a>
          </div>
          <ul className="facts">
            <li>
              <strong>
                <ShieldCheck size={16} aria-hidden="true" /> Read-only source
              </strong>
              Coolify is only read, never changed.
            </li>
            <li>
              <strong>
                <CircleCheck size={16} aria-hidden="true" /> Never deploys
              </strong>
              You review, then press deploy yourself.
            </li>
            <li>
              <strong>
                <RotateCcw size={16} aria-hidden="true" /> Fully undoable
              </strong>
              Roll back everything Portage created.
            </li>
          </ul>
        </section>

        <div className="stage" aria-hidden="true">
          <div className="dock">
            <h2>
              <i /> Coolify
            </h2>
            <div className="dock-row ok">
              <b>shop-web</b>
              <span>nixpacks</span>
            </div>
            <div className="dock-row ok">
              <b>shop-api</b>
              <span>dockerfile</span>
            </div>
            <div className="dock-row warn">
              <b>postgres</b>
              <span>16-alpine</span>
            </div>
            <div className="dock-row ok">
              <b>stack</b>
              <span>compose</span>
            </div>
          </div>
          <div className="lane">
            <span className="crate" />
            <span className="crate" />
            <span className="crate" />
          </div>
          <div className="dock to">
            <h2>
              <i /> Dokploy
            </h2>
            <div className="dock-row ok">
              <b>shop-web</b>
              <Check size={14} />
            </div>
            <div className="dock-row ok">
              <b>shop-api</b>
              <Check size={14} />
            </div>
            <div className="dock-row warn">
              <b>postgres</b>
              <Check size={14} />
            </div>
            <div className="dock-row ok">
              <b>stack</b>
              <Check size={14} />
            </div>
          </div>
        </div>
      </main>

      <footer className="land-foot">
        <span>
          Made by{" "}
          <a href={AUTHOR.github} target="_blank" rel="noreferrer">
            {AUTHOR.name}
          </a>
        </span>
        <span className="links">
          <a href="#/docs">Documentation</a>
          <a href="#/docs/security">Security</a>
          <a href={REPOSITORY} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </span>
      </footer>
    </div>
  );
}
