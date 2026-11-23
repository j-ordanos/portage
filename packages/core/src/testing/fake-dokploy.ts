import type { DokployClient, DokployProject } from "../clients/dokploy.js";
import { AppError } from "../errors.js";
import type { DatabaseEngine } from "../resources/data.js";

type Rec = Record<string, unknown>;

export interface FakeCall {
  method: string;
  write: boolean;
}

/**
 * In-memory Dokploy that mimics the behaviour verified on v0.31.4:
 * project.create adds a default "production" environment, appName gets a random suffix,
 * database ids are `<engine>Id`, deletes cascade, env strings round-trip unchanged.
 */
export function createFakeDokploy(
  seed: { projects?: Array<{ name: string; environments?: string[] }> } = {},
) {
  let counter = 0;
  const id = (prefix: string) => `${prefix}_${++counter}`;
  const calls: FakeCall[] = [];
  const failures: Array<{ method: string; error: AppError; times: number }> =
    [];
  /** Throw after the write is committed (simulates a lost response). */
  const lostResponses: Array<{ method: string; times: number }> = [];

  interface Env {
    environmentId: string;
    name: string;
    isDefault: boolean;
    [k: string]: unknown;
  }
  interface Project {
    projectId: string;
    name: string;
    environments: Env[];
  }
  const projects: Project[] = [];
  const resources = new Map<string, Rec>(); // id -> row
  const domains = new Map<string, Rec>();
  const mounts = new Map<string, Rec>();

  const newProject = (name: string, envNames: string[]) => {
    const project: Project = { projectId: id("proj"), name, environments: [] };
    envNames.forEach((envName, i) =>
      project.environments.push({
        environmentId: id("env"),
        name: envName,
        isDefault: i === 0,
      }),
    );
    projects.push(project);
    return project;
  };
  for (const p of seed.projects ?? [])
    newProject(p.name, p.environments ?? ["production"]);

  const record = (method: string, write: boolean) => {
    calls.push({ method, write });
    const failure = failures.find((f) => f.method === method && f.times > 0);
    if (failure) {
      failure.times--;
      throw failure.error;
    }
  };
  const afterCommit = (method: string) => {
    const lost = lostResponses.find((l) => l.method === method && l.times > 0);
    if (lost) {
      lost.times--;
      throw new AppError("UPSTREAM_UNREACHABLE", "Upstream request timed out", {
        retryable: true,
      });
    }
  };
  const envOf = (environmentId: string) => {
    for (const p of projects) {
      const env = p.environments.find((e) => e.environmentId === environmentId);
      if (env) return env;
    }
    throw new AppError("UPSTREAM_NOT_FOUND", "Upstream resource was not found");
  };
  const view = (): DokployProject[] =>
    projects.map((p) => ({
      projectId: p.projectId,
      name: p.name,
      environments: p.environments.map((e) => {
        const inEnv = (type: string) =>
          [...resources.values()].filter(
            (r) => r.environmentId === e.environmentId && r.type === type,
          );
        return {
          environmentId: e.environmentId,
          name: e.name,
          isDefault: e.isDefault,
          applications: inEnv("applications") as never,
          compose: inEnv("compose") as never,
          // Real Dokploy returns trimmed database rows here (no image/credentials); the full row needs <engine>.one
          postgres: inEnv("postgres").map(trimDb) as never,
          mysql: inEnv("mysql").map(trimDb) as never,
          mariadb: inEnv("mariadb").map(trimDb) as never,
          mongo: inEnv("mongo").map(trimDb) as never,
          redis: inEnv("redis").map(trimDb) as never,
        };
      }),
    }));
  const trimDb = (row: Rec): Rec => {
    const {
      dockerImage: _i,
      databasePassword: _p,
      databaseUser: _u,
      databaseName: _n,
      ...rest
    } = row;
    return rest;
  };
  const suffix = () => Math.random().toString(36).slice(2, 8);
  const resourceWith = (key: string, value: string): Rec => {
    const row = resources.get(value);
    if (!row) throw new AppError("UPSTREAM_NOT_FOUND", `${key} not found`);
    return row;
  };
  const childrenOf = (serviceId: string, store: Map<string, Rec>) =>
    [...store.values()].filter(
      (r) => r.applicationId === serviceId || r.composeId === serviceId,
    );

  const client: DokployClient = {
    async probe() {
      record("probe", false);
      return { version: "v0.31.4", authStyle: "x-api-key" };
    },
    async projectAll() {
      record("projectAll", false);
      return view();
    },
    async projectOne(projectId) {
      record("projectOne", false);
      const found = view().find((p) => p.projectId === projectId);
      if (!found)
        throw new AppError(
          "UPSTREAM_NOT_FOUND",
          "Upstream resource was not found",
        );
      return found;
    },
    async serverAll() {
      record("serverAll", false);
      return [];
    },
    async applicationOne(applicationId) {
      record("applicationOne", false);
      const row = resourceWith("application", applicationId);
      return {
        ...row,
        domains: childrenOf(applicationId, domains),
        mounts: childrenOf(applicationId, mounts),
      };
    },
    async composeOne(composeId) {
      record("composeOne", false);
      const row = resourceWith("compose", composeId);
      return {
        ...row,
        domains: childrenOf(composeId, domains),
        mounts: childrenOf(composeId, mounts),
      };
    },

    async databaseOne(engine, databaseId) {
      record("databaseOne", false);
      const row = resources.get(databaseId);
      if (!row || row.type !== engine)
        throw new AppError(
          "UPSTREAM_NOT_FOUND",
          "Upstream resource was not found",
        );
      return { ...row };
    },

    async projectCreate(input) {
      record("projectCreate", true);
      const project = newProject(input.name, ["production"]);
      afterCommit("projectCreate");
      const env = project.environments[0] as Env;
      return {
        projectId: project.projectId,
        environmentId: env.environmentId,
        environmentName: env.name,
      };
    },
    async environmentCreate(input) {
      record("environmentCreate", true);
      const project = projects.find((p) => p.projectId === input.projectId);
      if (!project)
        throw new AppError("UPSTREAM_NOT_FOUND", "project not found");
      const env: Env = {
        environmentId: id("env"),
        name: input.name,
        isDefault: false,
      };
      project.environments.push(env);
      afterCommit("environmentCreate");
      return { environmentId: env.environmentId };
    },
    async applicationCreate(input) {
      record("applicationCreate", true);
      envOf(input.environmentId);
      const applicationId = id("app");
      const appName = `${input.appName ?? input.name}-${suffix()}`;
      resources.set(applicationId, {
        type: "applications",
        applicationId,
        name: input.name,
        appName,
        description: input.description ?? null,
        environmentId: input.environmentId,
        env: null,
        buildArgs: null,
        sourceType: "github",
        buildType: "nixpacks",
      });
      afterCommit("applicationCreate");
      return { applicationId, appName };
    },
    async applicationSaveGitProvider(input) {
      record("applicationSaveGitProvider", true);
      Object.assign(resourceWith("application", input.applicationId), {
        sourceType: "git",
        customGitUrl: input.customGitUrl,
        customGitBranch: input.customGitBranch,
        customGitBuildPath: input.customGitBuildPath,
        customGitSSHKeyId: input.customGitSSHKeyId ?? null,
      });
    },
    async applicationSaveGithubProvider(input) {
      record("applicationSaveGithubProvider", true);
      Object.assign(resourceWith("application", input.applicationId), {
        sourceType: "github",
        owner: input.owner,
        repository: input.repository,
        branch: input.branch,
        githubId: input.githubId,
      });
    },
    async applicationSaveDockerProvider(input) {
      record("applicationSaveDockerProvider", true);
      Object.assign(resourceWith("application", input.applicationId), {
        sourceType: "docker",
        dockerImage: input.dockerImage,
      });
    },
    async applicationSaveBuildType(input) {
      record("applicationSaveBuildType", true);
      Object.assign(resourceWith("application", input.applicationId), {
        buildType: input.buildType,
        dockerfile: input.dockerfile ?? null,
        publishDirectory: input.publishDirectory ?? null,
      });
    },
    async applicationUpdate(input) {
      record("applicationUpdate", true);
      const { applicationId, ...rest } = input;
      Object.assign(resourceWith("application", applicationId), rest);
    },
    async applicationSaveEnvironment(input) {
      record("applicationSaveEnvironment", true);
      Object.assign(resourceWith("application", input.applicationId), {
        env: input.env,
        buildArgs: input.buildArgs ?? null,
      });
    },
    async composeCreate(input) {
      record("composeCreate", true);
      envOf(input.environmentId);
      const composeId = id("comp");
      const appName = `${input.appName ?? input.name}-${suffix()}`;
      resources.set(composeId, {
        type: "compose",
        composeId,
        name: input.name,
        appName,
        description: input.description ?? null,
        environmentId: input.environmentId,
        sourceType: input.sourceType ?? "raw",
        composeFile: input.composeFile ?? "",
        env: null,
      });
      afterCommit("composeCreate");
      return { composeId, appName };
    },
    async composeUpdate(input) {
      record("composeUpdate", true);
      const { composeId, ...rest } = input;
      Object.assign(resourceWith("compose", composeId), rest);
    },
    async databaseCreate(input) {
      record("databaseCreate", true);
      envOf(input.environmentId);
      const databaseId = id(input.engine);
      resources.set(databaseId, {
        type: input.engine,
        [`${input.engine}Id`]: databaseId,
        name: input.name,
        appName: `${input.appName ?? input.name}-${suffix()}`,
        description: input.description ?? null,
        environmentId: input.environmentId,
        databaseName: input.databaseName,
        databaseUser: input.databaseUser,
        databasePassword: input.databasePassword,
        dockerImage: input.dockerImage,
      });
      afterCommit("databaseCreate");
      return { databaseId };
    },
    async mountCreate(input) {
      record("mountCreate", true);
      const mountId = id("mount");
      mounts.set(mountId, {
        mountId,
        type: input.type,
        mountPath: input.mountPath,
        volumeName: input.volumeName ?? null,
        hostPath: input.hostPath ?? null,
        filePath: input.filePath ?? null,
        content: input.content ?? null,
        [input.serviceType === "compose" ? "composeId" : "applicationId"]:
          input.serviceId,
      });
      afterCommit("mountCreate");
      return { mountId };
    },
    async domainCreate(input) {
      record("domainCreate", true);
      const domainId = id("dom");
      domains.set(domainId, {
        domainId,
        host: input.host,
        https: input.https ?? true,
        port: input.port ?? null,
        path: input.path ?? "/",
        serviceName: input.serviceName ?? null,
        applicationId: input.applicationId ?? null,
        composeId: input.composeId ?? null,
      });
      afterCommit("domainCreate");
      return { domainId };
    },

    async applicationDelete(applicationId) {
      record("applicationDelete", true);
      if (!resources.delete(applicationId))
        throw new AppError(
          "UPSTREAM_NOT_FOUND",
          "Upstream resource was not found",
        );
      for (const [k, v] of domains)
        if (v.applicationId === applicationId) domains.delete(k);
      for (const [k, v] of mounts)
        if (v.applicationId === applicationId) mounts.delete(k);
    },
    async composeDelete(composeId) {
      record("composeDelete", true);
      if (!resources.delete(composeId))
        throw new AppError(
          "UPSTREAM_NOT_FOUND",
          "Upstream resource was not found",
        );
      for (const [k, v] of domains)
        if (v.composeId === composeId) domains.delete(k);
    },
    async databaseDelete(engine: DatabaseEngine, databaseId) {
      record("databaseDelete", true);
      const row = resources.get(databaseId);
      if (!row || row.type !== engine)
        throw new AppError(
          "UPSTREAM_NOT_FOUND",
          "Upstream resource was not found",
        );
      resources.delete(databaseId);
    },
    async domainDelete(domainId) {
      record("domainDelete", true);
      if (!domains.delete(domainId))
        throw new AppError(
          "UPSTREAM_NOT_FOUND",
          "Upstream resource was not found",
        );
    },
    async mountDelete(mountId) {
      record("mountDelete", true);
      if (!mounts.delete(mountId))
        throw new AppError(
          "UPSTREAM_NOT_FOUND",
          "Upstream resource was not found",
        );
    },
    async environmentDelete(environmentId) {
      record("environmentDelete", true);
      const project = projects.find((p) =>
        p.environments.some((e) => e.environmentId === environmentId),
      );
      if (!project)
        throw new AppError(
          "UPSTREAM_NOT_FOUND",
          "Upstream resource was not found",
        );
      project.environments = project.environments.filter(
        (e) => e.environmentId !== environmentId,
      );
      for (const [k, v] of resources)
        if (v.environmentId === environmentId) resources.delete(k);
    },
    async projectDelete(projectId) {
      record("projectDelete", true);
      const index = projects.findIndex((p) => p.projectId === projectId);
      if (index < 0)
        throw new AppError(
          "UPSTREAM_NOT_FOUND",
          "Upstream resource was not found",
        );
      const [project] = projects.splice(index, 1);
      for (const env of project?.environments ?? []) {
        for (const [k, v] of resources)
          if (v.environmentId === env.environmentId) resources.delete(k);
      }
    },
  };

  return {
    client,
    calls,
    get writes() {
      return calls.filter((c) => c.write);
    },
    /** Fail the next `times` calls of `method` before they commit. */
    failNext(method: string, error: AppError, times = 1) {
      failures.push({ method, error, times });
    },
    /** Commit the write, then throw a retryable network error (lost response). */
    loseResponse(method: string, times = 1) {
      lostResponses.push({ method, times });
    },
    snapshot() {
      return {
        projects: view(),
        resources: [...resources.values()],
        domains: [...domains.values()],
        mounts: [...mounts.values()],
      };
    },
  };
}

export type FakeDokploy = ReturnType<typeof createFakeDokploy>;
