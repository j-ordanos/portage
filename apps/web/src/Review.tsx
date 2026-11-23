import { AlertTriangle, Database, Layers, Package } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorText } from "./api";
import type { Inventory, PlanView, Step } from "./types";
import {
  Alert,
  Dialog,
  ErrorState,
  plain,
  plural,
  Skeleton,
  Spinner,
} from "./ui";

const CREATES = [
  "CREATE_PROJECT",
  "CREATE_APPLICATION",
  "CREATE_COMPOSE",
  "CREATE_DATABASE",
];
const ICON = {
  CREATE_APPLICATION: Package,
  CREATE_COMPOSE: Layers,
  CREATE_DATABASE: Database,
} as const;

/** Collapse the raw step list into one entry per created resource, carrying its settings count and warnings. */
export function groupSteps(steps: Step[]) {
  const groups: Array<{ head: Step; warnings: string[]; extras: number }> = [];
  let current: (typeof groups)[number] | undefined;
  for (const step of steps) {
    if (CREATES.includes(step.kind)) {
      current = { head: step, warnings: [...step.warnings], extras: 0 };
      groups.push(current);
    } else if (current && step.srcId === current.head.srcId) {
      current.extras++;
      for (const w of step.warnings)
        if (!current.warnings.includes(w)) current.warnings.push(w);
    }
  }
  return groups;
}

/** Plain wording, and no "credentials are not migrated" note next to "Git access linked". */
const tidy = (warnings: string[]) => {
  const linked = warnings.some((w) => w.startsWith("Git access linked"));
  return warnings.filter((w) => !(linked && /^R-020/.test(w))).map(plain);
};

const targetName = (label: string) =>
  label.replace(
    /^(Create|Use existing) (project|application|compose|\w+ database) /,
    "",
  );

/** `Acme*` -> [`Acme`, `*`]: the part that Dokploy shows differently from Coolify is highlighted. */
function Name({ from, to }: { from: string; to: string }) {
  return to.toLowerCase().startsWith(from.toLowerCase()) &&
    to.length > from.length ? (
    <>
      {to.slice(0, from.length)}
      <mark>{to.slice(from.length)}</mark>
    </>
  ) : (
    to
  );
}

export function Review({
  runId,
  onBack,
  onStarted,
}: {
  runId: string;
  onBack: () => void;
  onStarted: () => void;
}) {
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [inv, setInv] = useState<Inventory | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setError(null);
    Promise.all([
      api<PlanView>("GET", `/runs/${runId}/plan`),
      api<Inventory>("GET", `/runs/${runId}/inventory`),
    ])
      .then(([p, i]) => {
        setPlan(p);
        setInv(i);
      })
      .catch((e) => setError(errorText(e)));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: load only depends on runId
  useEffect(load, [runId]);

  const start = async () => {
    setBusy(true);
    try {
      await api("POST", `/runs/${runId}/apply`);
      onStarted();
    } catch (e) {
      setError(errorText(e));
      setConfirm(false);
      setBusy(false);
    }
  };

  if (error && !plan)
    return (
      <ErrorState message={error.message} hint={error.hint} onRetry={load} />
    );
  if (!plan || !inv) {
    return (
      <div aria-busy="true" aria-label="Building the plan">
        <div className="page-head">
          <div
            style={{
              display: "grid",
              gap: "0.6rem",
              width: "min(26rem, 100%)",
            }}
          >
            <Skeleton w="55%" h="2rem" />
            <Skeleton w="90%" h="0.9rem" />
          </div>
        </div>
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            style={{
              padding: "0.75rem 0",
              borderBottom: "1px solid var(--rule-soft)",
            }}
          >
            <Skeleton w={`${55 + ((i * 13) % 35)}%`} h="1rem" />
          </div>
        ))}
      </div>
    );
  }

  const sourceName = new Map<string, string>();
  for (const p of inv.projects) {
    sourceName.set(p.srcId, p.name);
    for (const e of p.environments)
      for (const r of e.resources) sourceName.set(r.srcId, r.name);
  }
  const groups = groupSteps(plan.steps);
  const blocks: Array<{
    project: (typeof groups)[number];
    items: typeof groups;
  }> = [];
  for (const g of groups) {
    if (g.head.kind === "CREATE_PROJECT")
      blocks.push({ project: g, items: [] });
    else blocks[blocks.length - 1]?.items.push(g);
  }
  const n = (kind: string) => groups.filter((g) => g.head.kind === kind).length;
  const quiet =
    /^Definition only|^Volume created empty|^Original domain kept|^Git access linked/;
  const attention = groups.filter((g) =>
    g.warnings.some((w) => !quiet.test(w)),
  ).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Review the plan</h1>
          <p>
            This is exactly what will exist in Dokploy. Coolify names are on the
            left, the Dokploy names on the right.
          </p>
        </div>
      </div>
      <Alert tone="ok">
        <strong>Nothing has been changed in Dokploy yet.</strong> Resources are
        created and configured, and nothing is deployed.
      </Alert>
      <div className="tally">
        <span>
          <strong>{n("CREATE_PROJECT")}</strong> projects
        </span>
        <span>
          <strong>{n("CREATE_APPLICATION")}</strong> apps
        </span>
        <span>
          <strong>{n("CREATE_COMPOSE")}</strong> compose stacks
        </span>
        <span>
          <strong>{n("CREATE_DATABASE")}</strong> databases
        </span>
        {attention > 0 ? (
          <span className="muted">{attention} with notes</span>
        ) : null}
      </div>

      {blocks.length === 0 ? (
        <Alert tone="warn">
          <strong>The plan is empty.</strong> Every selected resource was
          skipped, for example because a project name already exists and you
          chose to skip it. Go back and change your choices.
        </Alert>
      ) : null}

      {blocks.map(({ project, items }) => (
        <section key={project.head.seq} className="project-block">
          <div className="group-head">
            <h2>
              {sourceName.get(project.head.srcId) ?? "Project"}{" "}
              <span className="faint">→</span>{" "}
              <Name
                from={sourceName.get(project.head.srcId) ?? ""}
                to={targetName(project.head.label)}
              />
            </h2>
            <span className="count">{plural(items.length, "resource")}</span>
          </div>
          {project.warnings.map((w) => (
            <p key={w} className="muted small" style={{ margin: "0.4rem 0 0" }}>
              {w}
            </p>
          ))}
          {items.map((g) => {
            const Icon = ICON[g.head.kind as keyof typeof ICON];
            const from = sourceName.get(g.head.srcId) ?? "";
            return (
              <div key={g.head.seq} className="map">
                <span className="from">{from}</span>
                <span className="arrow" aria-hidden="true">
                  →
                </span>
                <span className="to">
                  {Icon ? (
                    <Icon
                      size={14}
                      aria-hidden="true"
                      style={{ verticalAlign: "-2px", marginRight: "0.35rem" }}
                    />
                  ) : null}
                  <Name from={from} to={targetName(g.head.label)} />
                  {g.extras > 0 ? (
                    <span className="muted small"> · {g.extras} settings</span>
                  ) : null}
                </span>
                {g.warnings.length > 0 ? (
                  <ul className="notes detail">
                    {tidy(g.warnings).map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </section>
      ))}

      {plan.notes.length > 0 ? (
        <section className="section">
          <h2 className="row" style={{ gap: "0.5rem" }}>
            <AlertTriangle size={18} aria-hidden="true" /> Needs manual work
          </h2>
          <ul className="notes">
            {plan.notes.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {error ? <ErrorState message={error.message} hint={error.hint} /> : null}
      <div
        className="actions"
        style={{ display: "flex", gap: "0.6rem", marginTop: "1.5rem" }}
      >
        <button type="button" className="btn" onClick={onBack}>
          Back to choices
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={groups.length === 0}
          onClick={() => setConfirm(true)}
        >
          Create in Dokploy
        </button>
      </div>

      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Create these resources in Dokploy?"
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setConfirm(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void start()}
            >
              {busy ? <Spinner label="Starting…" /> : "Create resources"}
            </button>
          </>
        }
      >
        <p>
          Portage will create {n("CREATE_PROJECT")} projects with{" "}
          {n("CREATE_APPLICATION") + n("CREATE_COMPOSE") + n("CREATE_DATABASE")}{" "}
          resources. They are configured but <strong>not deployed</strong>, and
          you can roll everything back afterwards.
        </p>
      </Dialog>
    </>
  );
}
