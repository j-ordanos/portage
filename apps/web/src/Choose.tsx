import {
  ChevronDown,
  ChevronRight,
  Database,
  Layers,
  Package,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorText } from "./api";
import { copy } from "./copy";
import type { Inventory, InvResource, UserOptions } from "./types";
import { CompatBadge, ErrorBox, Spinner } from "./ui";

const KIND_ICON = {
  application: Package,
  compose: Layers,
  database: Database,
} as const;

interface Target {
  projects: Array<{ projectId: string; name: string }>;
  servers: Array<{ serverId: string; name: string }>;
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
  const [error, setError] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      let inventory: Inventory;
      try {
        inventory = await api<Inventory>("GET", `/runs/${runId}/inventory`);
      } catch {
        await api("POST", `/runs/${runId}/discover`); // first scan failed or never ran
        inventory = await api<Inventory>("GET", `/runs/${runId}/inventory`);
      }
      setInv(inventory);
      setOptions(await api<UserOptions>("GET", `/runs/${runId}/options`));
      api<Target>("GET", `/runs/${runId}/target`)
        .then(setTarget)
        .catch(() => undefined);
    } catch (e) {
      setError(errorText(e));
    }
  }, [runId]);
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
  const acknowledged = new Set(options?.acknowledge ?? []);
  const isOn = (r: InvResource) =>
    selected.has(r.srcId) &&
    (!r.issues.some((i) => i.severity === "error") ||
      acknowledged.has(r.srcId));

  const patch = (change: Partial<UserOptions>) =>
    options && setOptions({ ...options, ...change });
  const setSelected = (ids: string[], on: boolean) => {
    const next = new Set(selected);
    for (const id of ids) on ? next.add(id) : next.delete(id);
    patch({ include: [...next] });
  };
  const acknowledge = (r: InvResource, on: boolean) => {
    const next = new Set(acknowledged);
    on ? next.add(r.srcId) : next.delete(r.srcId);
    patch({ acknowledge: [...next] });
    if (on) setSelected([r.srcId], true);
  };

  const count = all.filter(isOn).length;
  const submit = async () => {
    if (!options) return;
    setBusy(true);
    setError(null);
    try {
      const include = all.filter(isOn).map((r) => r.srcId);
      await api("PUT", `/runs/${runId}/options`, { ...options, include });
      await api("POST", `/runs/${runId}/plan`);
      onPlanned();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  if (error && !inv)
    return (
      <ErrorBox
        message={error.message}
        hint={error.hint}
        onRetry={() => void load()}
      />
    );
  if (!inv || !options) return <Spinner label={copy.connect.scanning} />;
  const q = query.trim().toLowerCase();
  const match = (r: InvResource) =>
    !q || `${r.name} ${r.summary} ${r.kind}`.toLowerCase().includes(q);

  return (
    <main>
      <h1>{copy.choose.title}</h1>
      <p className="muted">
        {copy.choose.lead} Coolify {inv.source.version}.
      </p>
      {inv.notes.map((n) => (
        <div key={n.ruleId + n.message} className="alert warn">
          <strong>{n.message}</strong> {n.fix}
        </div>
      ))}
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
        <button
          type="button"
          className="btn small"
          onClick={() =>
            setSelected(
              all
                .filter((r) => !r.issues.some((i) => i.severity === "error"))
                .map((r) => r.srcId),
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

      {inv.projects.length === 0 ? (
        <p className="muted">No projects were found in Coolify.</p>
      ) : null}
      {inv.projects.map((project) => {
        const resources = project.environments.flatMap((e) => e.resources);
        const ids = resources.map((r) => r.srcId);
        const onCount = resources.filter(isOn).length;
        const isOpen = !open.has(project.srcId); // open by default
        return (
          <section key={project.srcId} className="card project">
            <div className="row">
              <input
                type="checkbox"
                aria-label={`Select all in ${project.name}`}
                checked={onCount === resources.length && resources.length > 0}
                ref={(el) => {
                  if (el)
                    el.indeterminate =
                      onCount > 0 && onCount < resources.length;
                }}
                onChange={(e) =>
                  setSelected(
                    ids.filter((id) =>
                      resources.find(
                        (r) =>
                          r.srcId === id &&
                          !r.issues.some((i) => i.severity === "error"),
                      ),
                    ),
                    e.target.checked,
                  )
                }
              />
              <button
                type="button"
                className="linkish"
                aria-expanded={isOpen}
                onClick={() =>
                  setOpen((prev) =>
                    prev.has(project.srcId)
                      ? new Set([...prev].filter((x) => x !== project.srcId))
                      : new Set(prev).add(project.srcId),
                  )
                }
              >
                {isOpen ? (
                  <ChevronDown size={16} aria-hidden="true" />
                ) : (
                  <ChevronRight size={16} aria-hidden="true" />
                )}
                <strong>{project.name}</strong>
              </button>
              <span className="muted small">
                {onCount} of {resources.length} selected
              </span>
            </div>
            {isOpen
              ? project.environments.map((env) => (
                  <div key={env.srcId} className="env">
                    <div className="muted small">Environment: {env.name}</div>
                    {env.resources.filter(match).map((r) => {
                      const Icon = KIND_ICON[r.kind];
                      const errors = r.issues.filter(
                        (i) => i.severity === "error",
                      );
                      const shown = r.issues.filter(
                        (i) => i.severity !== "info",
                      );
                      return (
                        <div key={r.srcId} className="resource">
                          <div className="row">
                            <input
                              type="checkbox"
                              aria-label={`Migrate ${r.name}`}
                              checked={isOn(r)}
                              disabled={
                                errors.length > 0 && !acknowledged.has(r.srcId)
                              }
                              onChange={(e) =>
                                setSelected([r.srcId], e.target.checked)
                              }
                            />
                            <Icon size={16} aria-hidden="true" />
                            <strong>{r.name}</strong>
                            <span className="muted small grow">
                              {r.summary}
                            </span>
                            <CompatBadge compat={r.compat} />
                          </div>
                          {errors.length > 0 ? (
                            <label className="check indent">
                              <input
                                type="checkbox"
                                checked={acknowledged.has(r.srcId)}
                                onChange={(e) =>
                                  acknowledge(r, e.target.checked)
                                }
                              />
                              {copy.choose.needsDecision}:{" "}
                              {copy.choose.migrateAnyway.toLowerCase()}
                            </label>
                          ) : null}
                          {shown.length > 0 ? (
                            <ul className="issues">
                              {shown.map((i) => (
                                <li key={i.ruleId + i.message}>
                                  <code>{i.ruleId}</code> {i.message}
                                  {i.fix ? (
                                    <span className="muted"> — {i.fix}</span>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ))
              : null}
          </section>
        );
      })}

      <section className="card">
        <button
          type="button"
          className="linkish"
          aria-expanded={showSettings}
          onClick={() => setShowSettings(!showSettings)}
        >
          {showSettings ? (
            <ChevronDown size={16} aria-hidden="true" />
          ) : (
            <ChevronRight size={16} aria-hidden="true" />
          )}
          <strong>{copy.settings.title}</strong>
        </button>
        {showSettings ? (
          <Settings options={options} patch={patch} target={target} />
        ) : (
          <p className="muted small">
            Name collisions are marked with “{options.collisionMarker}”, values
            are copied when readable.
          </p>
        )}
      </section>

      {error ? <ErrorBox message={error.message} hint={error.hint} /> : null}
      <div className="actions">
        <button
          type="button"
          className="btn primary"
          disabled={busy || count === 0}
          onClick={() => void submit()}
        >
          {busy ? (
            <Spinner label="Planning…" />
          ) : (
            `${copy.choose.continue} (${count})`
          )}
        </button>
        {count === 0 ? (
          <span className="muted small">{copy.choose.nothing}</span>
        ) : null}
      </div>
    </main>
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
    <div className="settings">
      <fieldset>
        <legend>{s.collision}</legend>
        <label className="check">
          <input
            type="radio"
            name="collision"
            checked={options.collisionPolicy === "suffix"}
            onChange={() => patch({ collisionPolicy: "suffix" })}
          />
          {s.suffix}
          <input
            className="tiny"
            aria-label="Marker"
            value={options.collisionMarker}
            maxLength={8}
            onChange={(e) => patch({ collisionMarker: e.target.value || "*" })}
          />
        </label>
        <label className="check">
          <input
            type="radio"
            name="collision"
            checked={options.collisionPolicy === "adopt"}
            onChange={() => patch({ collisionPolicy: "adopt" })}
          />
          {s.adopt}
        </label>
        <label className="check">
          <input
            type="radio"
            name="collision"
            checked={options.collisionPolicy === "skip"}
            onChange={() => patch({ collisionPolicy: "skip" })}
          />
          {s.skip}
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
          {s.importValues}
        </label>
        <label className="check">
          <input
            type="radio"
            name="secrets"
            checked={options.secretsMode === "names-only"}
            onChange={() => patch({ secretsMode: "names-only" })}
          />
          {s.namesOnly}
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
          {s.map}
        </label>
        <label className="check">
          <input
            type="radio"
            name="envs"
            checked={options.envStrategy === "flatten"}
            onChange={() => patch({ envStrategy: "flatten" })}
          />
          {s.flatten}
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
          {s.keep}
        </label>
        <label className="check">
          <input
            type="radio"
            name="domains"
            checked={options.domainPolicy === "temp-suffix"}
            onChange={() => patch({ domainPolicy: "temp-suffix" })}
          />
          {s.temp}
        </label>
        {options.domainPolicy === "temp-suffix" ? (
          <input
            aria-label={s.tempBase}
            placeholder={s.tempBase}
            value={options.tempBase ?? ""}
            onChange={(e) => patch({ tempBase: e.target.value })}
          />
        ) : null}
      </fieldset>
      {target && target.servers.length > 0 ? (
        <label>
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
    </div>
  );
}
