import {
  AlertTriangle,
  ArrowRight,
  Database,
  Layers,
  Package,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorText } from "./api";
import { copy } from "./copy";
import type { Inventory, PlanView, Step } from "./types";
import { Alert, Dialog, ErrorBox, Spinner } from "./ui";

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
    <>{to}</>
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

  useEffect(() => {
    Promise.all([
      api<PlanView>("GET", `/runs/${runId}/plan`),
      api<Inventory>("GET", `/runs/${runId}/inventory`),
    ])
      .then(([p, i]) => {
        setPlan(p);
        setInv(i);
      })
      .catch((e) => setError(errorText(e)));
  }, [runId]);

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

  if (!plan || !inv)
    return (
      <main className="main">
        {error ? (
          <ErrorBox message={error.message} hint={error.hint} />
        ) : (
          <Spinner />
        )}
      </main>
    );
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
  const attention = groups.filter((g) =>
    g.warnings.some(
      (w) =>
        !/^Definition only|^Volume created empty|^Original domain kept|^Git access linked/.test(
          w,
        ),
    ),
  ).length;

  return (
    <main className="main">
      <h1>{copy.review.title}</h1>
      <p className="lede">
        Here is what will exist in Dokploy. Coolify names are on the left, the
        Dokploy names on the right.
      </p>
      <Alert tone="ok">
        <strong>{copy.review.banner}</strong> Resources are created and
        configured, and nothing is deployed.
      </Alert>
      <div className="facts">
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
          <span className="muted">{attention} with notes below</span>
        ) : null}
      </div>

      {blocks.map(({ project, items }) => (
        <section key={project.head.seq} className="project-block">
          <div className="group-head">
            <h3>
              {sourceName.get(project.head.srcId) ?? "Project"}{" "}
              <ArrowRight
                size={14}
                aria-hidden="true"
                style={{ verticalAlign: "-2px" }}
              />{" "}
              <Name
                from={sourceName.get(project.head.srcId) ?? ""}
                to={targetName(project.head.label)}
              />
            </h3>
            <span className="count">{items.length} resources</span>
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
                    {g.warnings.map((w) => (
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
          <h2>
            <AlertTriangle
              size={16}
              aria-hidden="true"
              style={{ verticalAlign: "-2px" }}
            />{" "}
            {copy.review.manual}
          </h2>
          <ul className="notes">
            {plan.notes.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {error ? <ErrorBox message={error.message} hint={error.hint} /> : null}
      <div className="actions">
        <button type="button" className="btn" onClick={onBack}>
          {copy.review.back}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={groups.length === 0}
          onClick={() => setConfirm(true)}
        >
          {copy.review.create}
        </button>
      </div>
      <Dialog
        open={confirm}
        title={copy.review.confirmTitle}
        onClose={() => setConfirm(false)}
      >
        <p>{copy.review.confirmBody}</p>
        <div className="actions">
          <button
            type="button"
            className="btn"
            onClick={() => setConfirm(false)}
          >
            {copy.review.cancel}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void start()}
          >
            {busy ? <Spinner label="Starting…" /> : copy.review.confirm}
          </button>
        </div>
      </Dialog>
    </main>
  );
}
