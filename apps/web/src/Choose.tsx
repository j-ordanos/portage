import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Database,
  FolderOpen,
  KeyRound,
  Layers,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorText } from "./api";
import type {
  GitResource,
  GitView,
  Inventory,
  InvResource,
  UserOptions,
} from "./types";
import {
  CompatBadge,
  Dialog,
  EmptyState,
  ErrorState,
  Pagination,
  Skeleton,
  Spinner,
  sentence,
} from "./ui";

const KIND = {
  application: { Icon: Package, label: "App" },
  compose: { Icon: Layers, label: "Compose" },
  database: { Icon: Database, label: "Database" },
} as const;

interface Target {
  projects: Array<{ projectId: string; name: string }>;
  servers: Array<{ serverId: string; name: string }>;
}

const LEFT_PAGE = 8;
const RIGHT_PAGE = 10;

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
  onChangeServers,
}: {
  runId: string;
  onPlanned: () => void;
  onChangeServers: () => void;
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
  const [active, setActive] = useState<string | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [leftQuery, setLeftQuery] = useState("");
  const [leftPage, setLeftPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [onlyReview, setOnlyReview] = useState(false);
  const [page, setPage] = useState(1);
  const [closedEnvs, setClosedEnvs] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState(false);

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
      setActive(
        (prev) =>
          prev ??
          inventory.projects.find((p) =>
            p.environments.some((e) => e.resources.length > 0),
          )?.srcId ??
          inventory.projects[0]?.srcId ??
          null,
      );
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

  /* ---------- loading and failure ---------- */
  if (error && !inv) {
    return (
      <ErrorState
        message={error.message}
        hint={error.hint ?? "Check the servers in Settings, then try again."}
        onRetry={() => void load()}
      />
    );
  }
  if (!inv || !options) return <ChooseSkeleton />;

  /* ---------- derived ---------- */
  const lq = leftQuery.trim().toLowerCase();
  const projectMatches = (p: Inventory["projects"][number]) =>
    !lq ||
    p.name.toLowerCase().includes(lq) ||
    p.environments.some((e) =>
      e.resources.some((r) => r.name.toLowerCase().includes(lq)),
    );
  const leftList = inv.projects.filter(projectMatches);
  const leftPages = Math.max(1, Math.ceil(leftList.length / LEFT_PAGE));
  const leftShown = leftList.slice(
    (Math.min(leftPage, leftPages) - 1) * LEFT_PAGE,
    Math.min(leftPage, leftPages) * LEFT_PAGE,
  );

  const project = inv.projects.find((p) => p.srcId === active) ?? null;
  const q = query.trim().toLowerCase();
  const matches = (r: InvResource) =>
    (!q || `${r.name} ${r.summary} ${r.kind}`.toLowerCase().includes(q)) &&
    (!onlyReview || r.compat !== "auto");
  const rows = project
    ? project.environments.flatMap((env) =>
        closedEnvs.has(env.srcId)
          ? []
          : env.resources
              .filter(matches)
              .map((r) => ({ env: env.name, envId: env.srcId, r })),
      )
    : [];
  const pages = Math.max(1, Math.ceil(rows.length / RIGHT_PAGE));
  const safePage = Math.min(page, pages);
  const shown = rows.slice((safePage - 1) * RIGHT_PAGE, safePage * RIGHT_PAGE);

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
  const noGitTargets =
    git &&
    git.github.length === 0 &&
    git.ssh.length === 0 &&
    git.resources.length > 0;

  const projectStats = (p: Inventory["projects"][number]) => {
    const rs = p.environments.flatMap((e) => e.resources);
    return {
      total: rs.length,
      on: rs.filter(isOn).length,
      ok: rs.filter((r) => r.compat === "auto").length,
      warn: rs.filter((r) => r.compat === "partial").length,
      bad: rs.filter((r) => r.compat === "manual").length,
      ids: rs.filter((r) => !hasError(r)).map((r) => r.srcId),
    };
  };
  const activeStats = project ? projectStats(project) : null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Choose what to move</h1>
          <p>
            {all.length} resources in {inv.projects.length} projects on Coolify{" "}
            {inv.source.version}.{" "}
            {needReview > 0
              ? `${needReview} need a look before they move.`
              : "Everything is ready to move."}
          </p>
        </div>
        <div className="row">
          <button
            type="button"
            className="btn quiet"
            onClick={() => void load()}
          >
            <RefreshCw size={16} aria-hidden="true" /> Rescan
          </button>
        </div>
      </div>

      {inv.notes.map((n) => (
        <div key={n.ruleId + n.message} className="alert warn">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>{n.message}</strong> {n.fix}
          </div>
        </div>
      ))}
      {noGitTargets ? (
        <div className="alert warn">
          <KeyRound size={18} aria-hidden="true" />
          <div>
            <strong>Dokploy has no GitHub App or SSH key yet.</strong>
            <p>
              Private repositories will be created unlinked. Add one in Dokploy
              under Settings, then check again.
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
        <div className="card">
          <EmptyState
            icon={<FolderOpen size={26} aria-hidden="true" />}
            title="No projects found"
            action={
              <button type="button" className="btn" onClick={onChangeServers}>
                Use a different server
              </button>
            }
          >
            The Coolify token can read this server, but it sees no projects.
            Check that the token belongs to the right team.
          </EmptyState>
        </div>
      ) : (
        <div className="mdl" data-left={leftOpen}>
          {/* ---------------- left: projects ---------------- */}
          <aside className="pane left" aria-label="Projects">
            {leftOpen ? (
              <>
                <div className="pane-head">
                  <h2 className="grow">Projects</h2>
                  <span className="muted small">{leftList.length}</span>
                  <button
                    type="button"
                    className="btn quiet icon"
                    onClick={() => setLeftOpen(false)}
                    aria-label="Collapse project list"
                  >
                    <PanelLeftClose size={16} aria-hidden="true" />
                  </button>
                </div>
                <label className="search">
                  <Search size={15} aria-hidden="true" />
                  <input
                    type="search"
                    placeholder="Search projects"
                    aria-label="Search projects"
                    value={leftQuery}
                    onChange={(e) => {
                      setLeftQuery(e.target.value);
                      setLeftPage(1);
                    }}
                  />
                </label>
                <div className="proj-list">
                  {leftShown.length === 0 ? (
                    <p className="muted small" style={{ padding: "0.75rem" }}>
                      No project matches “{leftQuery}”.
                    </p>
                  ) : null}
                  {leftShown.map((p) => {
                    const s = projectStats(p);
                    const isActive = p.srcId === active;
                    const open = expanded.has(p.srcId);
                    return (
                      <div
                        key={p.srcId}
                        className="proj"
                        data-active={isActive}
                      >
                        <div className="proj-row">
                          <input
                            type="checkbox"
                            aria-label={`Move everything in ${p.name}`}
                            disabled={s.total === 0}
                            checked={s.total > 0 && s.on === s.total}
                            ref={(el) => {
                              if (el)
                                el.indeterminate = s.on > 0 && s.on < s.total;
                            }}
                            onChange={(e) =>
                              setSelected(s.ids, e.target.checked)
                            }
                          />
                          <button
                            type="button"
                            className="proj-name"
                            aria-current={isActive ? "true" : undefined}
                            onClick={() => {
                              setActive(p.srcId);
                              setPage(1);
                              setQuery("");
                            }}
                          >
                            <strong>{p.name}</strong>
                            <span
                              className="dots"
                              aria-label={`${s.ok} ready, ${s.warn} need a look, ${s.bad} manual`}
                            >
                              {s.total === 0 ? (
                                <span className="faint small">Empty</span>
                              ) : null}
                              {s.ok > 0 ? (
                                <span className="d ok">{s.ok}</span>
                              ) : null}
                              {s.warn > 0 ? (
                                <span className="d warn">{s.warn}</span>
                              ) : null}
                              {s.bad > 0 ? (
                                <span className="d bad">{s.bad}</span>
                              ) : null}
                            </span>
                          </button>
                          {p.environments.length > 1 || s.total > 0 ? (
                            <button
                              type="button"
                              className="btn quiet icon small"
                              aria-expanded={open}
                              aria-label={`${open ? "Hide" : "Show"} environments of ${p.name}`}
                              onClick={() =>
                                setExpanded((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(p.srcId)) next.delete(p.srcId);
                                  else next.add(p.srcId);
                                  return next;
                                })
                              }
                            >
                              {open ? (
                                <ChevronDown size={14} aria-hidden="true" />
                              ) : (
                                <ChevronRight size={14} aria-hidden="true" />
                              )}
                            </button>
                          ) : null}
                        </div>
                        {open ? (
                          <ul className="env-list">
                            {p.environments.map((e) => (
                              <li key={e.srcId}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setActive(p.srcId);
                                    setPage(1);
                                    setClosedEnvs(
                                      new Set(
                                        p.environments
                                          .filter((x) => x.srcId !== e.srcId)
                                          .map((x) => x.srcId),
                                      ),
                                    );
                                  }}
                                >
                                  {e.name}
                                  <span className="faint">
                                    {e.resources.filter(isOn).length}/
                                    {e.resources.length}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <Pagination
                  page={Math.min(leftPage, leftPages)}
                  pageSize={LEFT_PAGE}
                  total={leftList.length}
                  onPage={setLeftPage}
                  label="projects"
                />
              </>
            ) : (
              <button
                type="button"
                className="rail-toggle"
                onClick={() => setLeftOpen(true)}
                aria-label="Expand project list"
              >
                <PanelLeftOpen size={18} aria-hidden="true" />
                <span>Projects</span>
              </button>
            )}
          </aside>

          {/* ---------------- right: resources of the active project ---------------- */}
          <section
            className="pane right"
            aria-label={project ? `Resources in ${project.name}` : "Resources"}
          >
            {project && activeStats ? (
              <>
                <div className="pane-head">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <h2 style={{ overflowWrap: "anywhere" }}>{project.name}</h2>
                    <div className="muted small">
                      {project.environments.length} environment
                      {project.environments.length === 1 ? "" : "s"} ·{" "}
                      {activeStats.on} of {activeStats.total} will move
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn small"
                    disabled={activeStats.total === 0}
                    onClick={() => setSelected(activeStats.ids, true)}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    disabled={activeStats.total === 0}
                    onClick={() =>
                      setSelected(
                        project.environments.flatMap((e) =>
                          e.resources.map((r) => r.srcId),
                        ),
                        false,
                      )
                    }
                  >
                    Select none
                  </button>
                </div>
                <div className="toolbar">
                  <label className="search grow">
                    <Search size={15} aria-hidden="true" />
                    <input
                      type="search"
                      placeholder={`Search in ${project.name}`}
                      aria-label="Search resources"
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setPage(1);
                      }}
                    />
                  </label>
                  <label className="check" style={{ margin: 0 }}>
                    <input
                      type="checkbox"
                      checked={onlyReview}
                      onChange={(e) => {
                        setOnlyReview(e.target.checked);
                        setPage(1);
                      }}
                    />
                    <span>Only what needs a look</span>
                  </label>
                  {closedEnvs.size > 0 ? (
                    <button
                      type="button"
                      className="btn small quiet"
                      onClick={() => setClosedEnvs(new Set())}
                    >
                      Show all environments
                    </button>
                  ) : null}
                </div>

                {activeStats.total === 0 ? (
                  <EmptyState
                    icon={<FolderOpen size={24} aria-hidden="true" />}
                    title="Nothing to move here"
                  >
                    This project has no apps, databases or compose stacks.
                  </EmptyState>
                ) : rows.length === 0 ? (
                  <EmptyState
                    icon={<Search size={24} aria-hidden="true" />}
                    title="No resources match"
                    action={
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => {
                          setQuery("");
                          setOnlyReview(false);
                          setClosedEnvs(new Set());
                        }}
                      >
                        Clear filters
                      </button>
                    }
                  >
                    Try a different search or remove the filters.
                  </EmptyState>
                ) : (
                  <div>
                    {shown.map((row, i) => {
                      const first =
                        i === 0 || shown[i - 1]?.envId !== row.envId;
                      return (
                        <div key={row.r.srcId}>
                          {first ? (
                            <button
                              type="button"
                              className="env-head"
                              aria-expanded
                              onClick={() =>
                                setClosedEnvs((prev) =>
                                  new Set(prev).add(row.envId),
                                )
                              }
                              title="Collapse this environment"
                            >
                              <ChevronDown size={14} aria-hidden="true" />{" "}
                              {row.env}
                            </button>
                          ) : null}
                          <ResourceRow
                            r={row.r}
                            on={isOn(row.r)}
                            acknowledged={acknowledged.has(row.r.srcId)}
                            git={gitOf(row.r.srcId)}
                            gitView={git}
                            gitBusy={gitBusy}
                            onToggle={(on) => setSelected([row.r.srcId], on)}
                            onAcknowledge={(on) => acknowledge(row.r, on)}
                            onGit={(value) =>
                              void chooseGit(row.r.srcId, value)
                            }
                          />
                        </div>
                      );
                    })}
                    <Pagination
                      page={safePage}
                      pageSize={RIGHT_PAGE}
                      total={rows.length}
                      onPage={setPage}
                      label="resources"
                    />
                  </div>
                )}
                {closedEnvs.size > 0 &&
                project.environments.filter((e) => closedEnvs.has(e.srcId))
                  .length > 0 ? (
                  <div className="collapsed-envs">
                    {project.environments
                      .filter((e) => closedEnvs.has(e.srcId))
                      .map((e) => (
                        <button
                          key={e.srcId}
                          type="button"
                          className="env-head"
                          aria-expanded={false}
                          onClick={() =>
                            setClosedEnvs((prev) => {
                              const next = new Set(prev);
                              next.delete(e.srcId);
                              return next;
                            })
                          }
                        >
                          <ChevronRight size={14} aria-hidden="true" /> {e.name}{" "}
                          <span className="faint">
                            ({e.resources.length} hidden)
                          </span>
                        </button>
                      ))}
                  </div>
                ) : null}
              </>
            ) : (
              <EmptyState
                icon={<FolderOpen size={24} aria-hidden="true" />}
                title="Pick a project"
              >
                Choose a project on the left to see what is in it.
              </EmptyState>
            )}
          </section>
        </div>
      )}

      {/* ---------------- sticky summary ---------------- */}
      <div className="actionbar" role="region" aria-label="Summary">
        <div className="sum">
          <strong>{chosen.length}</strong> to move
          <span className="faint"> · </span>
          {withResources.length} projects, {count("application")} apps,{" "}
          {count("compose")} compose, {count("database")} databases
          {target === null ? (
            <span className="faint small"> · checking names…</span>
          ) : renames.length > 0 ? (
            <span
              className="chip warn"
              title={renames.map((r) => `${r.from} → ${r.to}`).join("\n")}
            >
              <AlertTriangle size={12} aria-hidden="true" /> {renames.length}{" "}
              renamed with {options.collisionMarker}
            </span>
          ) : null}
        </div>
        {error ? (
          <span className="field-error" role="alert">
            {error.message}
          </span>
        ) : null}
        <div className="row" style={{ gap: "0.5rem", flexWrap: "nowrap" }}>
          <button type="button" className="btn quiet" onClick={onChangeServers}>
            <ArrowLeft size={16} aria-hidden="true" /> Change servers
          </button>
          <button type="button" className="btn" onClick={() => setDrawer(true)}>
            <SlidersHorizontal size={16} aria-hidden="true" /> Options
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || chosen.length === 0}
            onClick={() => void submit()}
          >
            {busy ? <Spinner label="Building plan…" /> : "Review plan"}
          </button>
        </div>
      </div>

      <Dialog
        open={drawer}
        variant="drawer"
        onClose={() => setDrawer(false)}
        title="Options"
        description="How names, values and domains are handled."
      >
        <OptionsForm
          options={options}
          patch={patch}
          target={target}
          renames={renames}
        />
      </Dialog>
    </>
  );
}

function ChooseSkeleton() {
  return (
    <div aria-busy="true" aria-label="Reading your projects">
      <div className="page-head">
        <div
          style={{ display: "grid", gap: "0.6rem", width: "min(28rem, 100%)" }}
        >
          <Skeleton w="60%" h="2rem" />
          <Skeleton w="85%" h="0.9rem" />
        </div>
      </div>
      <div className="mdl" data-left="true">
        <div
          className="pane left"
          style={{
            padding: "1rem",
            display: "grid",
            gap: "0.75rem",
            alignContent: "start",
          }}
        >
          <Skeleton h="2.25rem" r="8px" />
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} h="2.5rem" r="8px" />
          ))}
        </div>
        <div
          className="pane right"
          style={{
            padding: "1rem",
            display: "grid",
            gap: "0.75rem",
            alignContent: "start",
          }}
        >
          <Skeleton w="40%" h="1.4rem" />
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} h="4rem" r="8px" />
          ))}
        </div>
      </div>
    </div>
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
    (i) => i.severity !== "info" && !(git && i.ruleId === "R-020"),
  );
  const privateRepo =
    !git && r.kind !== "database" && r.issues.some((i) => i.ruleId === "R-020");
  return (
    <div className="res-row" data-compat={r.compat} data-on={on}>
      <input
        type="checkbox"
        aria-label={`Move ${r.name}`}
        checked={on}
        disabled={errors.length > 0 && !props.acknowledged}
        onChange={(e) => props.onToggle(e.target.checked)}
      />
      <div className="body">
        <div className="top">
          <strong className="name">{r.name}</strong>
          <span className="kind">
            <Icon size={14} aria-hidden="true" />
            {label}
          </span>
          <span className="grow" />
          <CompatBadge compat={r.compat} />
        </div>
        <div className="what">{r.summary}</div>
        {errors.length > 0 ? (
          <label className="check" style={{ fontSize: "0.8125rem" }}>
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
        {privateRepo && props.gitBusy ? (
          <div className="access">
            <Spinner label="Checking Git access in Dokploy…" />
          </div>
        ) : null}
        {notes.length > 0 ? (
          <ul className="notes">
            {notes.map((i) => (
              <li key={i.ruleId + i.message}>{sentence(i.message, i.fix)}</li>
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
    ? `deploy key “${git.coolify.keyName}”`
    : git.coolify.appName
      ? `GitHub App “${git.coolify.appName}”${git.coolify.appOrg ? ` (${git.coolify.appOrg})` : ""}`
      : "its Git source";
  return (
    <div className={`access ${linked ? "ok" : "warn"}`}>
      {linked ? (
        <CircleCheck size={16} aria-hidden="true" />
      ) : (
        <AlertTriangle size={16} aria-hidden="true" />
      )}
      <div className="text">
        <div>{link.reason}.</div>
        <div className="why small">Coolify used {from}.</div>
      </div>
      <label className="pick-git small">
        <span className="muted">Git access</span>
        <select
          className="select compact"
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
          <option value="url">Don’t link, I’ll do it in Dokploy</option>
        </select>
      </label>
    </div>
  );
}

function OptionsForm({
  options,
  patch,
  target,
  renames,
}: {
  options: UserOptions;
  patch: (c: Partial<UserOptions>) => void;
  target: Target | null;
  renames: Array<{ from: string; to: string }>;
}) {
  const radio = (
    name: string,
    checked: boolean,
    onChange: () => void,
    label: React.ReactNode,
  ) => (
    <label className="check">
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
  return (
    <div className="options">
      <fieldset>
        <legend>If a project name already exists in Dokploy</legend>
        {radio(
          "collision",
          options.collisionPolicy === "suffix",
          () => patch({ collisionPolicy: "suffix" }),
          <>
            Create a new one, marked with{" "}
            <input
              className="input tiny"
              aria-label="Marker"
              value={options.collisionMarker}
              maxLength={8}
              onChange={(e) =>
                patch({ collisionMarker: e.target.value || "*" })
              }
            />
          </>,
        )}
        {radio(
          "collision",
          options.collisionPolicy === "adopt",
          () => patch({ collisionPolicy: "adopt" }),
          "Add to the existing project",
        )}
        {radio(
          "collision",
          options.collisionPolicy === "skip",
          () => patch({ collisionPolicy: "skip" }),
          "Skip it",
        )}
        {renames.length > 0 && options.collisionPolicy === "suffix" ? (
          <ul className="notes" style={{ marginTop: "0.5rem" }}>
            {renames.map((r) => (
              <li key={r.from}>
                <code>{r.from}</code> becomes <code>{r.to}</code>
              </li>
            ))}
          </ul>
        ) : null}
      </fieldset>
      <fieldset>
        <legend>Environment variable values</legend>
        {radio(
          "secrets",
          options.secretsMode === "import-values",
          () => patch({ secretsMode: "import-values" }),
          "Copy values where Coolify exposes them",
        )}
        {radio(
          "secrets",
          options.secretsMode === "names-only",
          () => patch({ secretsMode: "names-only" }),
          "Create the names only, with empty values",
        )}
      </fieldset>
      <fieldset>
        <legend>Coolify environments</legend>
        {radio(
          "envs",
          options.envStrategy === "map",
          () => patch({ envStrategy: "map" }),
          "Keep them as environments",
        )}
        {radio(
          "envs",
          options.envStrategy === "flatten",
          () => patch({ envStrategy: "flatten" }),
          "Merge into one environment per project",
        )}
      </fieldset>
      <fieldset>
        <legend>Domains</legend>
        {radio(
          "domains",
          options.domainPolicy === "keep-original",
          () => patch({ domainPolicy: "keep-original" }),
          "Keep the original domains",
        )}
        {radio(
          "domains",
          options.domainPolicy === "temp-suffix",
          () => patch({ domainPolicy: "temp-suffix" }),
          "Use a temporary base domain",
        )}
        {options.domainPolicy === "temp-suffix" ? (
          <input
            className="input mono"
            style={{ marginTop: "0.25rem" }}
            aria-label="Base domain"
            placeholder="migrate.example.com"
            value={options.tempBase ?? ""}
            onChange={(e) => patch({ tempBase: e.target.value })}
          />
        ) : null}
      </fieldset>
      {target && target.servers.length > 0 ? (
        <label className="field">
          Dokploy server
          <select
            className="select"
            value={options.serverId ?? ""}
            onChange={(e) =>
              patch(
                e.target.value
                  ? { serverId: e.target.value }
                  : { serverId: undefined as never },
              )
            }
          >
            <option value="">Default (the Dokploy host)</option>
            {target.servers.map((srv) => (
              <option key={srv.serverId} value={srv.serverId}>
                {srv.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
