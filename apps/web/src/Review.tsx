import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorText } from "./api";
import { copy } from "./copy";
import type { PlanView, Step } from "./types";
import { Dialog, ErrorBox, Spinner } from "./ui";

const CREATES = [
  "CREATE_PROJECT",
  "CREATE_APPLICATION",
  "CREATE_COMPOSE",
  "CREATE_DATABASE",
];
const KIND_LABEL: Record<string, string> = {
  CREATE_PROJECT: "Project",
  CREATE_APPLICATION: "App",
  CREATE_COMPOSE: "Compose",
  CREATE_DATABASE: "Database",
};

/** Collapse the raw step list into what a person cares about: what will be created, and what to watch out for. */
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
  const [error, setError] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<PlanView>("GET", `/runs/${runId}/plan`)
      .then(setPlan)
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

  if (!plan)
    return error ? (
      <ErrorBox message={error.message} hint={error.hint} />
    ) : (
      <Spinner />
    );
  const groups = groupSteps(plan.steps);
  const count = (kind: string) =>
    groups.filter((g) => g.head.kind === kind).length;
  const renamed = plan.steps.filter(
    (s) =>
      s.kind === "CREATE_PROJECT" &&
      s.warnings.some((w) => w.includes("already exists")),
  );

  return (
    <main>
      <h1>{copy.review.title}</h1>
      <div className="alert ok">{copy.review.banner}</div>
      <div className="summary">
        <span>
          <strong>{count("CREATE_PROJECT")}</strong> projects
        </span>
        <span>
          <strong>{count("CREATE_APPLICATION")}</strong> apps
        </span>
        <span>
          <strong>{count("CREATE_COMPOSE")}</strong> compose
        </span>
        <span>
          <strong>{count("CREATE_DATABASE")}</strong> databases
        </span>
      </div>
      {renamed.length > 0 ? (
        <div className="alert warn">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            {renamed.length} project name(s) already exist in Dokploy, so the
            new copies are marked:{" "}
            {renamed
              .map((s) => s.label.replace(/^Create project /, ""))
              .join(", ")}
          </div>
        </div>
      ) : null}
      <div className="card">
        {groups.map((g) => (
          <div key={g.head.seq} className="plan-row">
            <div className="row">
              <span className="tag">{KIND_LABEL[g.head.kind]}</span>
              <strong>
                {g.head.label.replace(
                  /^(Create|Use existing) (project|application|compose|\w+ database) /,
                  "",
                )}
              </strong>
              {g.extras > 0 ? (
                <span className="muted small">+ {g.extras} settings</span>
              ) : null}
            </div>
            {g.warnings.length > 0 ? (
              <ul className="issues">
                {g.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
      {plan.notes.length > 0 ? (
        <section className="card">
          <h2>{copy.review.manual}</h2>
          <ul>
            {plan.notes.map((n) => (
              <li key={n}>{n}</li>
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
