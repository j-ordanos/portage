import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Database,
  Eye,
  EyeOff,
  Layers3,
  Moon,
  Package,
  Rocket,
  RotateCcw,
  Sun,
  Trash2,
} from "lucide-react";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { copy } from "./copy";
import "./style.css";

type Step =
  | "login"
  | "notice"
  | "coolify"
  | "dokploy"
  | "discover"
  | "select"
  | "report"
  | "secrets"
  | "plan"
  | "apply"
  | "verify"
  | "cutover"
  | "runs"
  | "settings";

const steps: Array<{ id: Step; label: string }> = [
  { id: "notice", label: "Security notice" },
  { id: "coolify", label: "Coolify" },
  { id: "dokploy", label: "Dokploy" },
  { id: "discover", label: "Discover" },
  { id: "select", label: "Select" },
  { id: "report", label: "Report" },
  { id: "secrets", label: "Secrets & DNS" },
  { id: "plan", label: "Dry run" },
  { id: "apply", label: "Apply" },
  { id: "verify", label: "Verify" },
  { id: "cutover", label: "Cutover" },
];

function App() {
  const [step, setStep] = useState<Step>("login");
  const [completed, setCompleted] = useState<Step[]>([]);
  const [runId, setRunId] = useState<string | null>(
    localStorage.getItem("migrator.runId"),
  );
  const [theme, setTheme] = useState<"light" | "dark">(
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
  );

  const advance = (next: Step) => {
    setCompleted((values) =>
      values.includes(step) ? values : [...values, step],
    );
    setStep(next);
  };

  useEffect(() => {
    if (step === "login") return;
    fetch("/api/runs", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { runs?: Array<{ id: string }> } | null) => {
        if (!runId && data?.runs?.[0]?.id) {
          setRunId(data.runs[0].id);
        }
      })
      .catch(() => undefined);
  }, [step, runId]);

  document.documentElement.dataset.theme = theme;

  if (step === "login") {
    return (
      <Login
        onSuccess={() => setStep("notice")}
        onRunRestored={(id) => {
          setRunId(id);
          localStorage.setItem("migrator.runId", id);
        }}
      />
    );
  }

  const currentIndex = steps.findIndex((item) => item.id === step);
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <Layers3 aria-hidden="true" />
          <strong>{copy.productName}</strong>
        </div>
        <div className="topbar-actions">
          <span className="run-name">New migration</span>
          <button
            type="button"
            className="icon-button"
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? <Moon /> : <Sun />}
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside className="stepper" aria-label="Migration steps">
          {steps.map((item, index) => {
            const complete = completed.includes(item.id);
            const active = item.id === step;
            return (
              <button
                type="button"
                key={item.id}
                className={active ? "step active" : "step"}
                disabled={!complete && !active}
                onClick={() => setStep(item.id)}
              >
                <span className="step-number">
                  {complete ? <CheckCircle2 aria-hidden="true" /> : index + 1}
                </span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </aside>
        <main className="step-content">
          {step === "notice" && (
            <SecurityNotice onContinue={() => advance("coolify")} />
          )}
          {step === "coolify" && (
            <ConnectionScreen
              kind="coolify"
              onContinue={() => advance("dokploy")}
            />
          )}
          {step === "dokploy" && (
            <ConnectionScreen
              kind="dokploy"
              onContinue={() => advance("discover")}
              onRunCreated={(id) => {
                setRunId(id);
                localStorage.setItem("migrator.runId", id);
              }}
            />
          )}
          {step === "discover" && (
            <Discovery runId={runId} onContinue={() => advance("select")} />
          )}
          {step === "select" && (
            <Selection runId={runId} onContinue={() => advance("report")} />
          )}
          {step === "report" && (
            <CompatibilityReport
              runId={runId}
              onContinue={() => advance("secrets")}
            />
          )}
          {step === "secrets" && (
            <SecretsDomains onContinue={() => advance("plan")} />
          )}
          {step === "plan" && <DryRun onContinue={() => advance("apply")} />}
          {step === "apply" && <Apply onContinue={() => advance("verify")} />}
          {step === "verify" && (
            <Verify onContinue={() => advance("cutover")} />
          )}
          {step === "cutover" && <Cutover />}
        </main>
      </div>
      <footer className="mobile-step" aria-live="polite">
        Step {currentIndex + 1} of {steps.length}
      </footer>
    </div>
  );
}

function Login({
  onSuccess,
  onRunRestored,
}: {
  onSuccess: () => void;
  onRunRestored: (id: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  return (
    <main className="login-page">
      <form
        className="login-card"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!password) {
            setError(copy.loginError);
            return;
          }
          setSubmitting(true);
          setError("");
          try {
            const response = await fetch("/api/auth/login", {
              method: "POST",
              credentials: "same-origin",
              headers: {
                "Content-Type": "application/json",
                "X-Requested-With": "migrator",
              },
              body: JSON.stringify({ password }),
            });
            if (!response.ok) {
              setError(copy.loginError);
              setPassword("");
              return;
            }
            setPassword("");
            void fetch("/api/runs", { credentials: "same-origin" })
              .then((response) => (response.ok ? response.json() : null))
              .then((data: { runs?: Array<{ id: string }> } | null) => {
                const latest = data?.runs?.[0]?.id;
                if (latest) {
                  onRunRestored(latest);
                }
              })
              .catch(() => undefined);
            onSuccess();
          } catch {
            setError(copy.loginError);
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <div className="brand brand-large">
          <Layers3 aria-hidden="true" />
          <strong>{copy.productName}</strong>
        </div>
        <h1>{copy.loginTitle}</h1>
        <label htmlFor="password">{copy.loginPassword}</label>
        <div className="password-field">
          <input
            id="password"
            type={show ? "text" : "password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
          <button
            type="button"
            className="icon-button"
            onClick={() => setShow(!show)}
            aria-label={show ? "Hide password" : "Show password"}
          >
            {show ? <EyeOff /> : <Eye />}
          </button>
        </div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : copy.loginSubmit}
        </button>
      </form>
    </main>
  );
}

function SecurityNotice({ onContinue }: { onContinue: () => void }) {
  const [accepted, setAccepted] = useState(false);
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Security</p>
          <h1>{copy.noticeTitle}</h1>
        </div>
        <AlertTriangle className="warning-icon" aria-hidden="true" />
      </div>
      <div className="notice-list">
        {copy.notice.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
        />
        <span>{copy.noticeAccept}</span>
      </label>
      <div className="panel-actions">
        <button
          type="button"
          className="primary"
          disabled={!accepted}
          onClick={onContinue}
        >
          {copy.noticeContinue}
        </button>
      </div>
    </section>
  );
}

function ConnectionScreen({
  kind,
  onContinue,
  onRunCreated,
}: {
  kind: "coolify" | "dokploy";
  onContinue: () => void;
  onRunCreated?: (id: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [tested, setTested] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false);
  const isCoolify = kind === "coolify";

  const test = async () => {
    setTesting(true);
    setError("");
    try {
      const route =
        kind === "coolify"
          ? "/api/connections/coolify/test"
          : "/api/connections/dokploy/test";
      const response = await fetch(route, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "migrator",
        },
        body: JSON.stringify(
          kind === "coolify"
            ? { url, token: credential, allowInsecureHttp }
            : { url, apiKey: credential, allowInsecureHttp },
        ),
      });
      const data = (await response.json().catch(() => ({
        message: "Connection test failed",
      }))) as {
        message?: string;
        hint?: string;
        version?: string;
        warnings?: string[];
      };
      if (!response.ok) {
        setTested(false);
        setError(
          data.hint
            ? `${data.message ?? "Connection failed"} — ${data.hint}`
            : (data.message ?? "Connection failed"),
        );
        return;
      }
      setTested(true);
      if (kind === "dokploy") {
        const runResponse = await fetch("/api/runs", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "migrator",
          },
          body: "{}",
        });
        if (runResponse.ok) {
          const run = (await runResponse.json()) as { runId: string };
          onRunCreated?.(run.runId);
        }
      }
    } catch {
      setTested(false);
      setError("Could not reach the migration server.");
    } finally {
      setCredential("");
      setTesting(false);
    }
  };

  return (
    <section className="panel">
      <p className="eyebrow">{isCoolify ? "Source" : "Target"}</p>
      <h1>{isCoolify ? copy.coolifyTitle : copy.dokployTitle}</h1>
      <div className="form-grid">
        <label>
          Base URL
          <input
            type="url"
            placeholder={
              isCoolify
                ? "https://coolify.example.com"
                : "https://dokploy.example.com"
            }
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <label>
          {isCoolify ? "API token" : "API key"}
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
          />
        </label>
      </div>
      {url.startsWith("http://") && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={allowInsecureHttp}
            onChange={(event) => setAllowInsecureHttp(event.target.checked)}
          />
          <span>Allow insecure http://</span>
        </label>
      )}
      {error && (
        <div className="warning-banner" role="alert">
          <AlertTriangle aria-hidden="true" />
          {error}
        </div>
      )}
      {tested && (
        <output className="result-card success" aria-live="polite">
          <CheckCircle2 aria-hidden="true" />
          <div>
            <strong>Connection verified</strong>
            <p>
              {isCoolify
                ? "Read access confirmed · sensitive-read to be verified against the lab"
                : "Read access confirmed · write access verified on first apply"}
            </p>
          </div>
        </output>
      )}
      <div className="panel-actions split">
        <button
          type="button"
          className="secondary"
          disabled={!url || !credential || testing}
          onClick={test}
        >
          {testing ? "Testing…" : copy.testConnection}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!tested}
          onClick={onContinue}
        >
          {copy.continue} <ChevronRight aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function Discovery({
  runId,
  onContinue,
}: {
  runId: string | null;
  onContinue: () => void;
}) {
  const [started, setStarted] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const start = async () => {
    if (!runId) {
      setError("Create and confirm both connections before discovery.");
      return;
    }
    setStarted(true);
    setError("");
    try {
      const response = await fetch(`/api/runs/${runId}/discover`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "migrator",
        },
        body: "{}",
      });
      const data = (await response.json().catch(() => ({
        message: "Discovery failed",
      }))) as {
        message?: string;
        hint?: string;
        counts?: Record<string, number>;
      };
      if (!response.ok) {
        setError(
          data.hint
            ? `${data.message ?? "Discovery failed"} — ${data.hint}`
            : (data.message ?? "Discovery failed"),
        );
        setStarted(false);
        return;
      }
      setCounts(data.counts ?? {});
      setComplete(true);
    } catch {
      setError("Could not reach the migration server.");
      setStarted(false);
    }
  };
  const categories = [
    ["Projects", counts.projects ?? 0],
    ["Environments", counts.environments ?? 0],
    ["Applications", counts.applications ?? 0],
    ["Databases", counts.databases ?? 0],
    ["Services", counts.compose ?? 0],
  ] as const;
  return (
    <section className="panel">
      <div className="heading-row">
        <div>
          <p className="eyebrow">{copy.readOnly}</p>
          <h1>{copy.discoverTitle}</h1>
        </div>
      </div>
      <button
        type="button"
        className="secondary"
        disabled={started}
        onClick={start}
      >
        {complete ? "Discovery complete" : copy.discoverAction}
      </button>
      {error && (
        <div className="warning-banner" role="alert">
          <AlertTriangle aria-hidden="true" />
          {error}
        </div>
      )}
      {started && (
        <div className="summary-grid" aria-live="polite">
          {categories.map(([name, count]) => (
            <div className="summary-card" key={name}>
              {complete ? (
                <CheckCircle2 className="success-icon" aria-hidden="true" />
              ) : (
                <span
                  className="spinner"
                  role="img"
                  aria-label={`Reading ${name}`}
                />
              )}
              <strong>{name}</strong>
              <span>{complete ? count : "Reading…"}</span>
            </div>
          ))}
        </div>
      )}
      <div className="panel-actions">
        <button
          type="button"
          className="primary"
          disabled={!complete}
          onClick={onContinue}
        >
          {copy.continue} <ChevronRight aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function Selection({
  runId,
  onContinue,
}: {
  runId: string | null;
  onContinue: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [projects, setProjects] = useState<
    Array<{
      srcId: string;
      name: string;
      environments: Array<{
        srcId: string;
        name: string;
        resources: Array<{
          srcId: string;
          name: string;
          kind: "application" | "database" | "compose";
          compat: "auto" | "partial" | "manual";
        }>;
      }>;
    }>
  >([]);
  const [search, setSearch] = useState("");
  const [strategy, setStrategy] = useState("Map 1:1");
  const [collision, setCollision] = useState("Add suffix");

  useEffect(() => {
    if (!runId) return;
    fetch(`/api/runs/${runId}`, { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          run: {
            inventory?: {
              projects: Array<{
                srcId: string;
                name: string;
                environments: Array<{
                  srcId: string;
                  name: string;
                  resources: Array<{
                    srcId: string;
                    name: string;
                    kind: "application" | "database" | "compose";
                    compat: "auto" | "partial" | "manual";
                  }>;
                }>;
              }>;
            };
          } | null,
        ) => {
          if (!run?.inventory) return;
          setProjects(run.inventory.projects);
          setSelectedIds(
            new Set(
              run.inventory.projects.flatMap((project) =>
                project.environments.flatMap((environment) =>
                  environment.resources.map((resource) => resource.srcId),
                ),
              ),
            ),
          );
        },
      )
      .catch(() => undefined);
  }, [runId]);

  const selectedCount = selectedIds.size;
  return (
    <section className="panel wide">
      <h1>{copy.selectTitle}</h1>
      <div className="selection-layout">
        <div>
          <div className="search-row">
            <input
              type="search"
              placeholder="Search resources"
              aria-label="Search resources"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button
              type="button"
              className="text-button"
              onClick={() => setSelectedIds(new Set())}
            >
              Clear
            </button>
          </div>
          <div className="resource-tree">
            <div className="info-banner">
              <Package aria-hidden="true" />
              <p>
                Fresh migration only: Coolify deployments and deployment history
                are not copied. Projects, environments, services, and
                configuration are recreated in Dokploy for a fresh deploy.
              </p>
            </div>
            {projects
              .filter((project) =>
                `${project.name} ${project.environments
                  .map(
                    (environment) =>
                      `${environment.name} ${environment.resources
                        .map((resource) => resource.name)
                        .join(" ")}`,
                  )
                  .join(" ")}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((project) => {
                const projectIds = project.environments.flatMap((environment) =>
                  environment.resources.map((resource) => resource.srcId),
                );
                const projectSelected =
                  projectIds.length > 0 &&
                  projectIds.every((id) => selectedIds.has(id));
                const toggleProject = () => {
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    for (const id of projectIds) {
                      if (projectSelected) next.delete(id);
                      else next.add(id);
                    }
                    return next;
                  });
                };
                return (
                  <section className="project-node" key={project.srcId}>
                    <label className="project-row">
                      <input
                        type="checkbox"
                        checked={projectSelected}
                        onChange={toggleProject}
                      />
                      <Package aria-hidden="true" />
                      <strong>Project · {project.name}</strong>
                    </label>
                    {project.environments.map((environment) => {
                      const envIds = environment.resources.map(
                        (resource) => resource.srcId,
                      );
                      const envSelected =
                        envIds.length > 0 &&
                        envIds.every((id) => selectedIds.has(id));
                      return (
                        <section
                          className="environment-node"
                          key={environment.srcId}
                        >
                          <label className="environment-row">
                            <input
                              type="checkbox"
                              checked={envSelected}
                              onChange={() => {
                                setSelectedIds((current) => {
                                  const next = new Set(current);
                                  for (const id of envIds) {
                                    if (envSelected) next.delete(id);
                                    else next.add(id);
                                  }
                                  return next;
                                });
                              }}
                            />
                            <strong>Environment · {environment.name}</strong>
                          </label>
                          {environment.resources
                            .filter((resource) =>
                              `${project.name} ${environment.name} ${resource.name}`
                                .toLowerCase()
                                .includes(search.toLowerCase()),
                            )
                            .map((resource) => (
                              <label
                                className="resource-row"
                                key={resource.srcId}
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedIds.has(resource.srcId)}
                                  onChange={(event) => {
                                    setSelectedIds((current) => {
                                      const next = new Set(current);
                                      if (event.target.checked)
                                        next.add(resource.srcId);
                                      else next.delete(resource.srcId);
                                      return next;
                                    });
                                  }}
                                />
                                {resource.kind === "database" ? (
                                  <Database aria-hidden="true" />
                                ) : (
                                  <Package aria-hidden="true" />
                                )}
                                <span>
                                  {resource.kind === "compose"
                                    ? "Compose"
                                    : resource.kind === "database"
                                      ? "Database"
                                      : "Service"}{" "}
                                  · {resource.name}
                                </span>
                                <span
                                  className={`badge ${resource.compat === "auto" ? "auto" : "partial"}`}
                                >
                                  {resource.compat}
                                </span>
                              </label>
                            ))}
                        </section>
                      );
                    })}
                  </section>
                );
              })}
          </div>
        </div>
        <aside className="target-card">
          <h2>Target</h2>
          <label>
            Target server
            <select>
              <option>Dokploy host</option>
            </select>
          </label>
          <fieldset>
            <legend>Environment strategy</legend>
            {[
              ["Map 1:1", "Map 1:1 (recommended)"],
              ["Flatten", "Flatten per project"],
            ].map(([value, label]) => (
              <label className="radio-row" key={value}>
                <input
                  type="radio"
                  checked={strategy === value}
                  onChange={() => {
                    if (value) setStrategy(value);
                  }}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Name collision</legend>
            {["Adopt", "Add suffix", "Skip"].map((value) => (
              <label className="radio-row" key={value}>
                <input
                  type="radio"
                  checked={collision === value}
                  onChange={() => setCollision(value)}
                />
                {value}
              </label>
            ))}
          </fieldset>
          <p className="summary">
            {selectedCount} selected · {selectedCount} resources
          </p>
        </aside>
      </div>
      <div className="panel-actions">
        <button
          type="button"
          className="primary"
          disabled={selectedCount === 0}
          onClick={async () => {
            if (runId) {
              await fetch(`/api/runs/${runId}/selection`, {
                method: "PUT",
                credentials: "same-origin",
                headers: {
                  "Content-Type": "application/json",
                  "X-Requested-With": "migrator",
                },
                body: JSON.stringify({
                  includeSrcIds: [...selectedIds],
                  decisions: {},
                  target: {
                    envStrategy: strategy === "Map 1:1" ? "map" : "flatten",
                    collisionPolicy:
                      collision === "Adopt"
                        ? "adopt"
                        : collision === "Skip"
                          ? "skip"
                          : "suffix",
                  },
                }),
              }).catch(() => undefined);
            }
            onContinue();
          }}
        >
          {copy.continue} <ChevronRight aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function CompatibilityReport({
  runId,
  onContinue,
}: {
  runId: string | null;
  onContinue: () => void;
}) {
  const [report, setReport] = useState<{
    summary: {
      total: number;
      auto: number;
      partial: number;
      manual: number;
      unresolvedErrors: number;
    };
    resources: Array<{
      srcId: string;
      projectName: string;
      environmentName: string;
      name: string;
      kind: string;
      compat: "auto" | "partial" | "manual";
      decision: "migrate" | "skip" | "acknowledge-manual";
      issues: Array<{
        ruleId: string;
        severity: "info" | "warn" | "error";
        message: string;
        fix?: string;
      }>;
    }>;
    canContinue: boolean;
  } | null>(null);
  const [error, setError] = useState("");

  const loadReport = useCallback(async () => {
    if (!runId) return;
    setError("");
    try {
      const response = await fetch(`/api/runs/${runId}/report`, {
        credentials: "same-origin",
      });
      const data = await response.json().catch(() => ({
        message: "Report failed",
      }));
      if (!response.ok) {
        setError(
          typeof data.message === "string" ? data.message : "Report failed",
        );
        return;
      }
      setReport(data);
    } catch {
      setError("Could not reach the migration server.");
    }
  }, [runId]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const decide = async (
    resourceId: string,
    decision: "skip" | "acknowledge-manual",
  ) => {
    if (!runId) return;
    const response = await fetch(`/api/runs/${runId}/report/decision`, {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "migrator",
      },
      body: JSON.stringify({ resourceId, decision }),
    });
    if (response.ok) await loadReport();
  };

  return (
    <section className="panel">
      <h1>{copy.reportTitle}</h1>
      {error && (
        <output className="warning-banner" aria-live="polite">
          <AlertTriangle aria-hidden="true" /> {error}
        </output>
      )}
      {report && (
        <>
          <div className="summary-grid">
            <div className="summary-card">
              <strong>Total</strong>
              <span>{report.summary.total}</span>
            </div>
            <div className="summary-card">
              <strong>Auto</strong>
              <span>{report.summary.auto}</span>
            </div>
            <div className="summary-card">
              <strong>Partial</strong>
              <span>{report.summary.partial}</span>
            </div>
            <div className="summary-card">
              <strong>Manual</strong>
              <span>{report.summary.manual}</span>
            </div>
          </div>
          {report.summary.unresolvedErrors > 0 && (
            <output className="warning-banner" aria-live="polite">
              <AlertTriangle aria-hidden="true" />
              {report.summary.unresolvedErrors} resource(s) need a decision
              before apply.
            </output>
          )}
          {report.resources.map((resource) => (
            <div className="report-row" key={resource.srcId}>
              <div>
                <strong>{resource.name}</strong>
                <p>
                  {resource.projectName} / {resource.environmentName} ·{" "}
                  {resource.kind}
                </p>
              </div>
              <span
                className={`badge ${resource.compat === "auto" ? "auto" : "partial"}`}
              >
                {resource.compat}
              </span>
              {resource.issues.some((issue) => issue.severity === "error") && (
                <div className="row-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void decide(resource.srcId, "skip")}
                  >
                    Skip
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      void decide(resource.srcId, "acknowledge-manual")
                    }
                  >
                    Acknowledge manual
                  </button>
                </div>
              )}
            </div>
          ))}
          {report.resources.map((resource) =>
            resource.issues.map((issue) => (
              <div
                className="issue-list"
                key={`${resource.srcId}-${issue.ruleId}`}
              >
                <p>
                  <strong>
                    [{issue.ruleId}] {issue.severity}
                  </strong>{" "}
                  — {resource.name}: {issue.message}
                </p>
                {issue.fix && (
                  <p>
                    <strong>Fix:</strong> {issue.fix}
                  </p>
                )}
              </div>
            )),
          )}
        </>
      )}
      <div className="panel-actions">
        <button
          type="button"
          className="primary"
          disabled={!report?.canContinue}
          onClick={onContinue}
        >
          {copy.continue} <ChevronRight aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function SecretsDomains({ onContinue }: { onContinue: () => void }) {
  const [tab, setTab] = useState<"secrets" | "domains">("secrets");
  const [mode, setMode] = useState("Names only");
  return (
    <section className="panel">
      <h1>{copy.secretsTitle}</h1>
      <div className="tabs" role="tablist">
        <button
          type="button"
          className={tab === "secrets" ? "active" : ""}
          onClick={() => setTab("secrets")}
        >
          Secrets
        </button>
        <button
          type="button"
          className={tab === "domains" ? "active" : ""}
          onClick={() => setTab("domains")}
        >
          Domains
        </button>
      </div>
      {tab === "secrets" ? (
        <>
          <fieldset className="mode-row">
            {["Names only", "Import values", "Prompt me"].map((value) => (
              <label className="radio-row" key={value}>
                <input
                  type="radio"
                  checked={mode === value}
                  onChange={() => setMode(value)}
                />
                {value}
              </label>
            ))}
          </fieldset>
          <div className="data-table">
            <div className="table-row">
              <strong>Resource</strong>
              <strong>Key</strong>
              <strong>Availability</strong>
              <strong>Value</strong>
            </div>
            <div className="table-row">
              <span>API</span>
              <code>DATABASE_URL</code>
              <span className="badge partial">redacted</span>
              <input type="password" autoComplete="off" placeholder="Not set" />
            </div>
          </div>
        </>
      ) : (
        <div className="data-table">
          <div className="table-row">
            <strong>Source</strong>
            <strong>Target</strong>
            <strong>Status</strong>
          </div>
          <div className="table-row">
            <code>api.example.com</code>
            <input value="api.migrate.example.com" readOnly />
            <span className="badge auto">ok</span>
          </div>
        </div>
      )}
      <div className="panel-actions">
        <button type="button" className="primary" onClick={onContinue}>
          {copy.continue} <ChevronRight aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function DryRun({ onContinue }: { onContinue: () => void }) {
  const [generated, setGenerated] = useState(false);
  return (
    <section className="panel">
      <h1>{copy.planTitle}</h1>
      {!generated ? (
        <button
          type="button"
          className="secondary"
          onClick={() => setGenerated(true)}
        >
          {copy.generatePlan}
        </button>
      ) : (
        <>
          <output className="success-banner" aria-live="polite">
            <CheckCircle2 aria-hidden="true" /> {copy.noChanges}
          </output>
          <ol className="plan-list">
            <li>
              <span>1</span>
              <div>
                <strong>CREATE_PROJECT</strong>
                <p>Acme</p>
              </div>
              <b className="badge auto">create</b>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>ENSURE_ENVIRONMENT</strong>
                <p>production</p>
              </div>
              <b className="badge auto">create</b>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>CREATE_APPLICATION</strong>
                <p>API</p>
              </div>
              <b className="badge auto">create</b>
            </li>
          </ol>
          <button type="button" className="primary" onClick={onContinue}>
            {copy.looksGood}
          </button>
        </>
      )}
    </section>
  );
}

function Apply({ onContinue }: { onContinue: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [started, setStarted] = useState(false);
  const [typed, setTyped] = useState("");
  const steps = [
    ["CREATE_PROJECT", "Acme", "done"],
    ["ENSURE_ENVIRONMENT", "production", "done"],
    ["CREATE_APPLICATION", "API", started ? "done" : "pending"],
    ["SET_ENV", "API keys", started ? "done" : "pending"],
    ["CREATE_DOMAIN", "api.example.com", started ? "done" : "pending"],
  ] as const;

  const start = () => {
    setConfirmed(false);
    setStarted(true);
  };

  return (
    <section className="panel">
      <div className="heading-row">
        <div>
          <p className="eyebrow red">Write action</p>
          <h1>Apply migration</h1>
        </div>
      </div>
      {!started && (
        <div className="warning-banner">
          <AlertTriangle aria-hidden="true" />
          Resources will be created but not deployed.
        </div>
      )}
      {confirmed ? (
        <div className="confirm-card">
          <p>
            This creates <strong>1 project</strong>,{" "}
            <strong>1 application</strong>, and <strong>1 domain</strong> in
            Dokploy.
          </p>
          <label>
            Type <code>CREATE RESOURCES</code>
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
            />
          </label>
          <button
            type="button"
            className="danger-button"
            disabled={typed !== "CREATE RESOURCES"}
            onClick={start}
          >
            Create resources in Dokploy
          </button>
        </div>
      ) : (
        !started && (
          <button
            type="button"
            className="danger-button"
            onClick={() => setConfirmed(true)}
          >
            Review apply
          </button>
        )
      )}
      {started && (
        <>
          <div
            className="progress-track"
            role="progressbar"
            aria-label="Apply progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={100}
          >
            <span style={{ width: "100%" }} />
          </div>
          <div className="step-table" aria-live="polite">
            {steps.map(([kind, target, state]) => (
              <div className="step-table-row" key={kind}>
                {state === "done" ? (
                  <CheckCircle2 className="success-icon" aria-hidden="true" />
                ) : (
                  <span className="pending-dot" aria-hidden="true" />
                )}
                <strong>{kind}</strong>
                <span>{target}</span>
                <span
                  className={`badge ${state === "done" ? "auto" : "partial"}`}
                >
                  {state}
                </span>
              </div>
            ))}
          </div>
          <div className="panel-actions">
            <button type="button" className="primary" onClick={onContinue}>
              Continue to verify <ChevronRight aria-hidden="true" />
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Verify({ onContinue }: { onContinue: () => void }) {
  const [checked, setChecked] = useState(false);
  const [deployed, setDeployed] = useState(false);
  const checks = [
    ["exists", "Pass"],
    ["env keys", "Pass"],
    ["domains", "Pass"],
    ["build type", "Pass"],
    ["source", "Pass"],
  ] as const;

  return (
    <section className="panel wide">
      <h1>Verify configuration</h1>
      <button
        type="button"
        className="secondary"
        onClick={() => setChecked(true)}
      >
        Verify configuration
      </button>
      {checked && (
        <div className="verify-grid">
          {checks.map(([check, result]) => (
            <div className="verify-row" key={check}>
              <CheckCircle2 className="success-icon" aria-hidden="true" />
              <strong>{check}</strong>
              <span className="badge auto">{result}</span>
            </div>
          ))}
        </div>
      )}
      <div className="deploy-card">
        <h2>
          <Rocket aria-hidden="true" /> Deploy on temporary domains
        </h2>
        <div className="warning-banner">
          <AlertTriangle aria-hidden="true" />
          Crons, webhooks, and outbound jobs may run twice. Pause source-side
          jobs if necessary.
        </div>
        <button
          type="button"
          className="danger-button"
          onClick={() => setDeployed(true)}
        >
          Deploy selected
        </button>
        {deployed && (
          <output className="success-banner" aria-live="polite">
            <CheckCircle2 aria-hidden="true" /> Deployment started on temporary
            domains.
          </output>
        )}
      </div>
      <div className="panel-actions">
        <button type="button" className="primary" onClick={onContinue}>
          Continue to cutover <ChevronRight aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function Cutover() {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [rollback, setRollback] = useState(false);
  const [typed, setTyped] = useState("");
  const beforeItems = [
    ["ttl", "Lower DNS TTL at least 24 hours earlier"],
    ["backup", "Snapshot databases and volumes"],
    ["freeze", "Freeze source writes"],
  ] as const;
  const toggle = (id: string) =>
    setChecked((values) => ({ ...values, [id]: !values[id] }));

  return (
    <section className="panel wide">
      <h1>Cutover checklist & report</h1>
      <div className="cutover-grid">
        <div>
          <h2>Before migration</h2>
          {beforeItems.map(([id, label]) => (
            <label className="checkbox-row" key={id}>
              <input
                type="checkbox"
                checked={Boolean(checked[id])}
                onChange={() => toggle(id)}
              />
              <span>{label}</span>
            </label>
          ))}
          <h2>Cutover</h2>
          {["Final data sync", "Switch DNS", "Verify production URLs"].map(
            (label) => (
              <label className="checkbox-row" key={label}>
                <input type="checkbox" />
                <span>{label}</span>
              </label>
            ),
          )}
        </div>
        <aside className="target-card">
          <h2>Exports</h2>
          <button type="button" className="secondary">
            Download manifest.json
          </button>
          <button type="button" className="secondary">
            Download report.md
          </button>
          <h2>Rollback</h2>
          <p>Delete only resources this tool created.</p>
          {!rollback ? (
            <button
              type="button"
              className="danger-button"
              onClick={() => setRollback(true)}
            >
              <RotateCcw aria-hidden="true" /> Review rollback
            </button>
          ) : (
            <label>
              Type <code>DELETE acme-prod</code>
              <input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
              />
              <button
                type="button"
                className="danger-button"
                disabled={typed !== "DELETE acme-prod"}
              >
                <Trash2 aria-hidden="true" /> Delete created resources
              </button>
            </label>
          )}
        </aside>
      </div>
    </section>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
