import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { Choose } from "./Choose";
import { Connect } from "./Connect";
import { Finish } from "./Finish";
import { Login } from "./Login";
import { Migrate } from "./Migrate";
import { Review } from "./Review";
import { Shell } from "./Shell";
import { type RunView, stageOf } from "./types";
import { Spinner } from "./ui";

const STAGES = ["connect", "choose", "review", "migrate", "finish"] as const;

/** The run id lives in the URL hash (never a secret), so every screen survives a reload. */
const readHash = () =>
  /^#\/run\/([\w-]+)/.exec(window.location.hash)?.[1] ?? null;

export function App() {
  const [auth, setAuth] = useState<"loading" | "out" | "in">("loading");
  const [runId, setRunId] = useState<string | null>(readHash());
  const [stage, setStage] = useState<(typeof STAGES)[number]>("connect");
  const [run, setRun] = useState<RunView | null>(null);

  const checkAuth = useCallback(() => {
    api("GET", "/auth/me")
      .then(() => setAuth("in"))
      .catch(() => setAuth("out"));
  }, []);
  useEffect(checkAuth, [checkAuth]);

  const open = useCallback(async (id: string | null) => {
    if (!id) {
      window.location.hash = "";
      setRun(null);
      setRunId(null);
      setStage("connect");
      return;
    }
    try {
      const fetched = await api<RunView>("GET", `/runs/${id}`);
      window.location.hash = `#/run/${id}`;
      setRun(fetched);
      setRunId(id);
      setStage(stageOf(fetched.status));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuth("out");
      else {
        window.location.hash = "";
        setRunId(null);
        setStage("connect");
      }
    }
  }, []);

  useEffect(() => {
    if (auth === "in" && runId) void open(runId);
  }, [auth]); // eslint-disable-line: resume the run from the URL once, after sign-in

  const signOut = async () => {
    await api("POST", "/auth/logout").catch(() => undefined);
    setRunId(null);
    setAuth("out");
  };

  if (auth === "loading") return <Spinner />;
  if (auth === "out") return <Login onDone={checkAuth} />;

  const page =
    stage === "connect" || !runId ? (
      <Connect onRun={(id) => void open(id)} />
    ) : stage === "choose" ? (
      <Choose runId={runId} onPlanned={() => void open(runId)} />
    ) : stage === "review" ? (
      <Review
        runId={runId}
        onBack={() => setStage("choose")}
        onStarted={() => void open(runId)}
      />
    ) : stage === "migrate" ? (
      <Migrate
        runId={runId}
        onFinished={() => void open(runId)}
        onRollback={() => setStage("finish")}
      />
    ) : (
      <Finish runId={runId} onGone={() => void open(null)} />
    );

  return (
    <Shell
      stage={STAGES.indexOf(stage)}
      run={run}
      onHome={() => void open(null)}
      onSignOut={() => void signOut()}
    >
      {page}
    </Shell>
  );
}
