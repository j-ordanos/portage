import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Database,
  KeyRound,
  Layers,
  Package,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorText } from "./api";
import { copy } from "./copy";
import type {
  GitResource,
  GitView,
  Inventory,
  InvResource,
  UserOptions,
} from "./types";
import { CompatBadge, ErrorBox, Spinner } from "./ui";

const KIND = {
  application: { Icon: Package, label: "App" },
  compose: { Icon: Layers, label: "Compose" },
  database: { Icon: Database, label: "Database" },
} as const;

interface Target {
  projects: Array<{ projectId: string; name: string }>;
  servers: Array<{ serverId: string; name: string }>;
}

/** `name`, then `name*`, `name**`… until it no longer collides (case-insensitive), same rule as the server. */
export function renamed(name: string, taken: string[], marker: string): string {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  let out = name;
  while (used.has(out.toLowerCase())) out += marker;
  return out;
}

export function Choose({
  runId,
  onPlanned,
}: {
  runId: string;
  onPlanned: () => void;
}) {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [options, setOptions] = useState<UserOptions | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [git, setGit] = useState<GitView | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyReview, setOnlyReview] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(new Set());

  const loadGit = useCallback(async () => {
    setGitBusy(true);
    try {
      setGit(await api<GitView>("GET", `/runs/${runId}/git`));
    } catch {
      setGit(null);
    } finally {
      setGitBusy(false);
    }
  }, [runId]);

  const load = useCallback(async () => {
    setError(null);
    try {
      let inventory: Inventory;
      try {
        inventory = await api<Inventory>("GET", `/runs/${runId}/inventory`);
      } catch {
        await api("POST", `/runs/${runId}/discover`); // the first scan failed or never ran
        inventory = await api<Inventory>("GET", `/runs/${runId}/inventory`);
      }
      setInv(inventory);
      setOptions(await api<UserOptions>("GET", `/runs/${runId}/options`));
      api<Target>("GET", `/runs/${runId}/target`)
        .then(setTarget)
        .catch(() => undefined);
      void loadGit();
    } catch (e) {
      setError(errorText(e));
    }
  }, [runId, loadGit]);
  useEffect(() => {
    void load();
  }, [load]);

  const all = useMemo(
    () =>
      inv?.projects.flatMap((p) =>
        p.environments.flatMap((e) => e.resources),
      ) ?? [],
    [inv],
  );
  const selected = useMemo(
    () => new Set(options?.include ?? all.map((r) => r.srcId)),
    [options, all],
  );
  const acknowledged = useMemo(
    () => new Set(options?.acknowledge ?? []),
    [options],
  );
  const hasError = (r: InvResource) =>
    r.issues.some((i) => i.severity === "error");
  const isOn = (r: InvResource) =>
    selected.has(r.srcId) && (!hasError(r) || acknowledged.has(r.srcId));
  const gitOf = (srcId: string) =>
    git?.resources.find((g) => g.srcId === srcId);

  const patch = (change: Partial<UserOptions>) =>
    setOptions((prev) => (prev ? { ...prev, ...change } : prev));
  const setSelected = (ids: string[], on: boolean) => {
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    patch({ include: [...next] });
  };
  const acknowledge = (r: InvResource, on: boolean) => {
    const next = new Set(acknowledged);
    if (on) next.add(r.srcId);
    else next.delete(r.srcId);
    patch({ acknowledge: [...next] });
    if (on) setSelected([r.srcId], true);
  };

  /** Git access picker: value is "auto", "gh:<id>", "ssh:<id>" or "url". Saved immediately so the plan always matches the screen. */
  const chooseGit = async (srcId: string, value: string) => {
    if (!options) return;
    const overrides = { ...options.gitOverrides };
    if (value === "auto") delete overrides[srcId];
    else if (value === "url") overrides[srcId] = { url: true };
    else if (value.startsWith("gh:"))
      overrides[srcId] = { githubId: value.slice(3) };
    else overrides[srcId] = { sshKeyId: value.slice(4) };
    patch({ gitOverrides: overrides });
    try {
      await api("PUT", `/runs/${runId}/options`, { gitOverrides: overrides });
      await loadGit();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const chosen = all.filter(isOn);
  const submit = async () => {
    if (!options) return;
    setBusy(true);
    setError(null);
    try {
      await api("PUT", `/runs/${runId}/options`, {
        ...options,
        include: chosen.map((r) => r.srcId),
      });
      await api("POST", `/runs/${runId}/plan`);
      onPlanned();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  if (error && !inv)
    return (
      <main className="main">
        <ErrorBox
          message={error.message}
          hint={error.hint}
          onRetry={() => void load()}
        />
      </main>
    );
  if (!inv || !options)
    return (
      <main className="main">
        <Spinner label={copy.connect.scanning} />
      </main>
    );

  const q = query.trim().toLowerCase();
  const visible = (r: InvResource) =>
    (!q || `${r.name} ${r.summary} ${r.kind}`.toLowerCase().includes(q)) &&
    (!onlyReview || r.compat !== "auto");
  const count = (kind: InvResource["kind"]) =>
    chosen.filter((r) => r.kind === kind).length;
  const withResources = inv.projects.filter((p) =>
    p.environments.some((e) => e.resources.some(isOn)),
  );
  const takenNames = target?.projects.map((p) => p.name) ?? [];
  const renames =
    options.collisionPolicy === "suffix"
      ? (() => {
          const used = [...takenNames];
          return withResources.flatMap((p) => {
            const next = renamed(p.name, used, options.collisionMarker);
            used.push(next);
            return next !== p.name ? [{ from: p.name, to: next }] : [];
          });
        })()
      : [];
  const needReview = all.filter((r) => r.compat !== "auto").length;
  const loneDokploy =
    git &&
    git.github.length === 0 &&
    git.ssh.length === 0 &&
    git.resources.length > 0;

  return (
    <main className="main">
      <h1>{copy.choose.title}</h1>
      <p className="lede">
        Found {all.length} resources in {inv.projects.length} projects on
        Coolify {inv.source.version}.{" "}
        {needReview > 0
          ? `${needReview} need a look before they move.`
          : "Everything is ready to move."}
      </p>
      {inv.notes.map((n) => (
        <div key={n.ruleId + n.message} className="alert warn">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>{n.message}</strong> {n.fix}
          </div>
        </div>
      ))}

      <div className="split">
        <div>
          <div className="toolbar">
            <label className="search">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                placeholder={copy.choose.search}
                aria-label={copy.choose.search}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <label className="check" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={onlyReview}
                onChange={(e) => setOnlyReview(e.target.checked)}
              />
              <span>Only what needs a look</span>
            </label>
            <button
              type="button"
              className="btn small"
              onClick={() =>
                setSelected(
                  all.filter((r) => !hasError(r)).map((r) => r.srcId),
                  true,
                )
              }
            >
              {copy.choose.all}
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() =>
                setSelected(
                  all.map((r) => r.srcId),
                  false,
                )
              }
            >
              {copy.choose.none}
            </button>
          </div>

          {loneDokploy ? (
            <div className="alert warn">
              <KeyRound size={18} aria-hidden="true" />
              <div>
                <strong>Dokploy has no GitHub App or SSH key yet.</strong>
                <p>
                  Private repositories will be created unlinked. Add a GitHub
                  App or SSH key in Dokploy under Settings, then check again.
                </p>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => void loadGit()}
                >
                  <RefreshCw size={14} aria-hidden="true" /> Check again
                </button>
              </div>
            </div>
          ) : null}

          {inv.projects.length === 0 ? (
            <p className="muted">
              No projects were found in Coolify for this token.
            </p>
          ) : null}
          {inv.projects.map((project) => {
            const resources = project.environments.flatMap((e) => e.resources);
            const ids = resources
              .filter((r) => !hasError(r))
              .map((r) => r.srcId);
            const onCount = resources.filter(isOn).length;
            const open = !closed.has(project.srcId);
            return (
              <section key={project.srcId} className="group">
                <div className="group-head" data-empty={resources.length === 0}>
                  {resources.length === 0 ? null : (
                    <input
                      type="checkbox"
                      aria-label={`Select everything in ${project.name}`}
                      checked={onCount > 0 && onCount === resources.length}
                      ref={(el) => {
                        if (el)
                          el.indeterminate =
                            onCount > 0 && onCount < resources.length;
                      }}
                      onChange={(e) => setSelected(ids, e.target.checked)}
                    />
                  )}
                  <button
                    type="button"
                    className="btn quiet small"
                    aria-expanded={open}
                    onClick={() =>
                      setClosed((prev) => {
                        const next = new Set(prev);
                        if (next.has(project.srcId)) next.delete(project.srcId);
                        else next.add(project.srcId);
                        return next;
                      })
                    }
                  >
                    {open ? (
                      <ChevronDown size={16} aria-hidden="true" />
                    ) : (
                      <ChevronRight size={16} aria-hidden="true" />
                    )}
                    <h3>{project.name}</h3>
                  </button>
                  <span className="count">
                    {resources.length === 0
                      ? "Nothing to move"
                      : `${onCount} of ${resources.length}`}
                  </span>
                </div>
                {open
                  ? project.environments.map((env) => {
                      const rows = env.resources.filter(visible);
                      if (rows.length === 0) return null;
                      return (
                        <div key={env.srcId}>
                          <div className="env-name">{env.name}</div>
                          {rows.map((r) => (
                            <ResourceRow
                              key={r.srcId}
                              r={r}
                              on={isOn(r)}
                              acknowledged={acknowledged.has(r.srcId)}
                              git={gitOf(r.srcId)}
                              gitBusy={gitBusy}
                              gitView={git}
                              onToggle={(on) => setSelected([r.srcId], on)}
                              onAcknowledge={(on) => acknowledge(r, on)}
                              onGit={(value) => void chooseGit(r.srcId, value)}
                            />
                          ))}
                        </div>
                      );
                    })
                  : null}
              </section>
            );
          })}
        </div>

        <aside className="side" aria-label="What Dokploy will get">
          <h2>What Dokploy will get</h2>
          <ul className="tally">
            <li>
              <b>{withResources.length}</b> projects
            </li>
            <li>
              <b>{count("application")}</b> apps
            </li>
            <li>
              <b>{count("compose")}</b> compose stacks
            </li>
            <li>
              <b>{count("database")}</b> databases
            </li>
          </ul>
          {target === null ? (
            <p className="muted small" role="status">
              Checking names already in Dokploy…
            </p>
          ) : null}
          {renames.length > 0 ? (
            <div className="alert warn" style={{ margin: "0 0 0.8rem" }}>
              <AlertTriangle size={16} aria-hidden="true" />
              <div>
                <strong className="small">
                  Already in Dokploy, so the new copy is marked:
                </strong>
                {renames.map((x) => (
                  <div key={x.from} className="rename">
                    <span>{x.from}</span>
                    <span aria-hidden="true">→</span>
                    <span className="to">
                      {x.to.slice(0, x.from.length)}
                      <mark>{x.to.slice(x.from.length)}</mark>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <p className="muted small" style={{ margin: 0 }}>
            Created and configured, never deployed.
          </p>
          {error ? (
            <ErrorBox message={error.message} hint={error.hint} />
          ) : null}
          <div className="actions">
            <button
              type="button"
              className="btn primary"
              style={{ width: "100%" }}
              disabled={busy || chosen.length === 0}
              onClick={() => void submit()}
            >
              {busy ? (
                <Spinner label="Building the plan…" />
              ) : (
                copy.choose.continue
              )}
            </button>
          </div>
          {chosen.length === 0 ? (
            <p className="muted small">{copy.choose.nothing}</p>
          ) : null}
          <Settings options={options} patch={patch} target={target} />
        </aside>
      </div>
    </main>
  );
}

function ResourceRow(props: {
  r: InvResource;
  on: boolean;
  acknowledged: boolean;
  git: GitResource | undefined;
  gitView: GitView | null;
  gitBusy: boolean;
  onToggle: (on: boolean) => void;
  onAcknowledge: (on: boolean) => void;
  onGit: (value: string) => void;
}) {
  const { r, on, git } = props;
  const { Icon, label } = KIND[r.kind];
  const errors = r.issues.filter((i) => i.severity === "error");
  const notes = r.issues.filter(
    (i) => i.severity !== "info" && !(git && /^R-020$/.test(i.ruleId)),
  );
  return (
    <div className="res" data-compat={r.compat} data-on={on}>
      <input
        type="checkbox"
        aria-label={`Move ${r.name}`}
        checked={on}
        disabled={errors.length > 0 && !props.acknowledged}
        onChange={(e) => props.onToggle(e.target.checked)}
      />
      <div className="name">
        <strong>{r.name}</strong>
        <span className="kind">
          <Icon size={14} aria-hidden="true" />
          {label}
        </span>
      </div>
      <CompatBadge compat={r.compat} />
      <div className="what">{r.summary}</div>
      <div className="more">
        {errors.length > 0 ? (
          <label className="check">
            <input
              type="checkbox"
              checked={props.acknowledged}
              onChange={(e) => props.onAcknowledge(e.target.checked)}
            />
            <span>
              This can’t be moved automatically. Create it anyway and finish it
              by hand.
            </span>
          </label>
        ) : null}
        {git ? (
          <GitAccess git={git} view={props.gitView} onChange={props.onGit} />
        ) : null}
        {r.kind !== "database" &&
        !git &&
        r.summary.includes("@") &&
        r.issues.some((i) => i.ruleId === "R-020") ? (
          props.gitBusy ? (
            <div className="access">
              <Spinner label="Checking Git access in Dokploy…" />
            </div>
          ) : null
        ) : null}
        {notes.length > 0 ? (
          <ul className="notes">
            {notes.map((i) => (
              <li key={i.ruleId + i.message}>
                {i.message}
                {i.fix ? <span> — {i.fix}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/** How a private repository will be reached in Dokploy, with the alternatives. Names of the two tools' apps may differ; access decides. */
function GitAccess({
  git,
  view,
  onChange,
}: {
  git: GitResource;
  view: GitView | null;
  onChange: (value: string) => void;
}) {
  const link = git.resolved;
  const linked = link.kind !== "url";
  const value = !git.overridden
    ? "auto"
    : link.kind === "github"
      ? `gh:${link.githubId}`
      : link.kind === "ssh"
        ? `ssh:${link.sshKeyId}`
        : "url";
  const from = git.coolify.keyName
    ? `Coolify deploy key “${git.coolify.keyName}”`
    : git.coolify.appName
      ? `Coolify GitHub App “${git.coolify.appName}”${git.coolify.appOrg ? ` (${git.coolify.appOrg})` : ""}`
      : "Coolify";
  return (
    <div className={`access ${linked ? "ok" : "warn"}`}>
      {linked ? (
        <CircleCheck size={16} aria-hidden="true" />
      ) : (
        <AlertTriangle size={16} aria-hidden="true" />
      )}
      <div className="text">
        <div>{link.reason}.</div>
        <div className="why small">
          Coolify used: {from.replace(/^Coolify /, "")}.
        </div>
      </div>
      <label className="pick small">
        <span className="muted">Git access</span>
        <select
          className="select"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`Git access for ${git.name}`}
        >
          <option value="auto">Automatic</option>
          {view && view.github.length > 0 ? (
            <optgroup label="Dokploy GitHub Apps">
              {git.candidates.github.map((c) => (
                <option key={c.githubId} value={`gh:${c.githubId}`}>
                  {c.label}
                  {c.hasAccess === true
                    ? " (can access)"
                    : c.hasAccess === false
                      ? " (no access)"
                      : ""}
                </option>
              ))}
            </optgroup>
          ) : null}
          {view && view.ssh.length > 0 ? (
            <optgroup label="Dokploy SSH keys">
              {git.candidates.ssh.map((c) => (
                <option key={c.sshKeyId} value={`ssh:${c.sshKeyId}`}>
                  {c.label}
                  {c.match === "fingerprint"
                    ? " (same key)"
                    : c.match === "name"
                      ? " (same name)"
                      : ""}
                </option>
              ))}
            </optgroup>
          ) : null}
          <option value="url">Don’t link: I’ll do it in Dokploy</option>
        </select>
      </label>
    </div>
  );
}

function Settings({
  options,
  patch,
  target,
}: {
  options: UserOptions;
  patch: (c: Partial<UserOptions>) => void;
  target: Target | null;
}) {
  const s = copy.settings;
  return (
    <details className="settings">
      <summary>{s.title}</summary>
      <fieldset>
        <legend>{s.collision}</legend>
        <label className="check">
          <input
            type="radio"
            name="collision"
            checked={options.collisionPolicy === "suffix"}
            onChange={() => patch({ collisionPolicy: "suffix" })}
          />
          <span>
            {s.suffix}
            <input
              className="tiny"
              aria-label="Marker"
              value={options.collisionMarker}
              maxLength={8}
              onChange={(e) =>
                patch({ collisionMarker: e.target.value || "*" })
              }
            />
          </span>
        </label>
        <label className="check">
          <input
            type="radio"
            name="collision"
            checked={options.collisionPolicy === "adopt"}
            onChange={() => patch({ collisionPolicy: "adopt" })}
          />
          <span>{s.adopt}</span>
        </label>
        <label className="check">
          <input
            type="radio"
            name="collision"
            checked={options.collisionPolicy === "skip"}
            onChange={() => patch({ collisionPolicy: "skip" })}
          />
          <span>{s.skip}</span>
        </label>
      </fieldset>
      <fieldset>
        <legend>{s.secrets}</legend>
        <label className="check">
          <input
            type="radio"
            name="secrets"
            checked={options.secretsMode === "import-values"}
            onChange={() => patch({ secretsMode: "import-values" })}
          />
          <span>{s.importValues}</span>
        </label>
        <label className="check">
          <input
            type="radio"
            name="secrets"
            checked={options.secretsMode === "names-only"}
            onChange={() => patch({ secretsMode: "names-only" })}
          />
          <span>{s.namesOnly}</span>
        </label>
      </fieldset>
      <fieldset>
        <legend>{s.envs}</legend>
        <label className="check">
          <input
            type="radio"
            name="envs"
            checked={options.envStrategy === "map"}
            onChange={() => patch({ envStrategy: "map" })}
          />
          <span>{s.map}</span>
        </label>
        <label className="check">
          <input
            type="radio"
            name="envs"
            checked={options.envStrategy === "flatten"}
            onChange={() => patch({ envStrategy: "flatten" })}
          />
          <span>{s.flatten}</span>
        </label>
      </fieldset>
      <fieldset>
        <legend>{s.domains}</legend>
        <label className="check">
          <input
            type="radio"
            name="domains"
            checked={options.domainPolicy === "keep-original"}
            onChange={() => patch({ domainPolicy: "keep-original" })}
          />
          <span>{s.keep}</span>
        </label>
        <label className="check">
          <input
            type="radio"
            name="domains"
            checked={options.domainPolicy === "temp-suffix"}
            onChange={() => patch({ domainPolicy: "temp-suffix" })}
          />
          <span>{s.temp}</span>
        </label>
        {options.domainPolicy === "temp-suffix" ? (
          <input
            className="select"
            style={{ width: "100%" }}
            aria-label={s.tempBase}
            placeholder={s.tempBase}
            value={options.tempBase ?? ""}
            onChange={(e) => patch({ tempBase: e.target.value })}
          />
        ) : null}
      </fieldset>
      {target && target.servers.length > 0 ? (
        <label className="field">
          {s.server}
          <select
            value={options.serverId ?? ""}
            onChange={(e) =>
              patch(
                e.target.value
                  ? { serverId: e.target.value }
                  : { serverId: undefined as never },
              )
            }
          >
            <option value="">{s.serverDefault}</option>
            {target.servers.map((srv) => (
              <option key={srv.serverId} value={srv.serverId}>
                {srv.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </details>
  );
}
