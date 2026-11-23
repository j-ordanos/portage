import { FolderX } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { Choose } from "./Choose";
import { Finish } from "./Finish";
import { Migrate } from "./Migrate";
import { Review } from "./Review";
import { go } from "./router";
import { FlowBar, STAGES, type Stage } from "./Shell";
import { type RunView, stageOf } from "./types";
import { EmptyState, ErrorState, Skeleton } from "./ui";

/** One migration, from scan to finish. The screen follows the run's real status, so a reload or another device lands in the right place. */
export function RunPage({
  id,
  stage,
  frame,
}: {
  id: string;
  stage: string | null;
  frame: (flow: React.ReactNode, body: React.ReactNode) => React.ReactNode;
}) {
  const [run, setRun] = useState<RunView | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "error">(
    "loading",
  );
  const [error, setError] = useState<string>("");

  const load = useCallback(async () => {
    try {
      setRun(await api<RunView>("GET", `/runs/${id}`));
      setState("ok");
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setState("missing");
      else if (!(e instanceof ApiError && e.status === 401)) {
        setError(
          e instanceof Error ? e.message : "Could not load this migration",
        );
        setState("error");
      }
    }
  }, [id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch whenever the route's stage changes too
  useEffect(() => {
    setState("loading");
    void load();
  }, [load, stage]);

  if (state === "missing") {
    return frame(
      null,
      <div className="card">
        <EmptyState
          icon={<FolderX size={26} aria-hidden="true" />}
          title="Migration not found"
          action={
            <a className="btn primary" href="#/">
              Back to your migrations
            </a>
          }
        >
          It may have been deleted, or it belongs to another account.
        </EmptyState>
      </div>,
    );
  }
  if (state === "error")
    return frame(
      null,
      <ErrorState message={error} onRetry={() => void load()} />,
    );
  if (!run) {
    return frame(
      null,
      <div aria-busy="true" aria-label="Loading migration">
        <Skeleton w="18rem" h="2.2rem" />
        <div style={{ marginTop: "1rem" }}>
          <Skeleton h="12rem" r="14px" />
        </div>
      </div>,
    );
  }

  const furthest = stageOf(run.status);
  const requested = STAGES.includes(stage as Stage) ? (stage as Stage) : null;
  // earlier steps are reachable until resources are being written; after that the screen is dictated by the run
  const locked = STAGES.indexOf(furthest) >= STAGES.indexOf("migrate");
  // a stopped run (paused, failed, cancelled) can be rolled back from the finish screen
  const stopped = ["paused", "paused_failed", "cancelled", "failed"].includes(
    run.status,
  );
  const current: Stage =
    requested === "finish" && stopped
      ? "finish"
      : requested &&
          !locked &&
          STAGES.indexOf(requested) <= STAGES.indexOf(furthest)
        ? requested
        : furthest;

  /**
   * Navigate AND refetch. Going to the address we are already on fires no hashchange, so without the reload the
   * screen would stay on a stale status (this is what left finished migrations stuck on step 4).
   */
  const open = (s: Stage | null) => {
    go({ page: "run", id, stage: s });
    void load();
  };
  const flow = (
    <FlowBar
      current={current}
      furthest={furthest}
      locked={locked}
      coolify={run.coolifyUrl}
      dokploy={run.dokployUrl}
      onGo={(s) => (s === "connect" ? go({ page: "new" }) : open(s))}
    />
  );

  const body =
    current === "connect" || current === "choose" ? (
      <Choose
        runId={id}
        onPlanned={() => open("review")}
        onChangeServers={() => go({ page: "new" })}
      />
    ) : current === "review" ? (
      <Review
        runId={id}
        onBack={() => open("choose")}
        onStarted={() => open(null)}
      />
    ) : current === "migrate" ? (
      <Migrate
        runId={id}
        onFinished={() => open(null)}
        onRollback={() => open("finish")}
      />
    ) : (
      <Finish
        runId={id}
        stopped={stopped}
        onBack={() => open(null)}
        onGone={() => go({ page: "home" })}
      />
    );

  return frame(flow, body);
}
