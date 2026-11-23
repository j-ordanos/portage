import {
  AppError,
  buildPlan,
  buildRollbackPlan,
  type CoolifyReader,
  candidatesFor,
  type DokployClient,
  executeRollbackStep,
  extractInventory,
  type GitCandidates,
  type GitLink,
  type GitSnapshot,
  IR,
  type Plan,
  type RollbackEntry,
  renderCompatMarkdown,
  renderManifest,
  renderMigrationReport,
  requireRollbackConfirmation,
  resolveGitLink,
  runRules,
  sshFingerprint,
  type TargetSnapshot,
  validatePlan,
  validateUpstreamUrl,
  verifyMigration,
} from "@migrator/core";
import type { Config } from "../config.js";
import type { Credentials, RunRow, Store } from "../db/store.js";
import {
  allResources,
  isBlocked,
  parseUserOptions,
  toCoreOptions,
  type UserOptions,
} from "./user-options.js";

export interface Deps {
  coolify(creds: Credentials["coolify"]): CoolifyReader;
  dokploy(creds: Credentials["dokploy"]): DokployClient;
}

const http = (message: string, status: number, code = "CONFIG_INVALID") =>
  Object.assign(new AppError(code as never, message), { status });

export class RunService {
  constructor(
    readonly store: Store,
    readonly deps: Deps,
    private readonly config: Config,
  ) {}

  private normalizeUrl(input: string, allowInsecureHttp: boolean): string {
    const allowedHosts = this.config.UPSTREAM_ALLOWED_HOSTS?.split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    try {
      return validateUpstreamUrl(
        input,
        {
          allowPrivate: this.config.UPSTREAM_ALLOW_PRIVATE,
          ...(allowedHosts?.length ? { allowedHosts } : {}),
        },
        allowInsecureHttp,
      ).toString();
    } catch (error) {
      throw http(error instanceof Error ? error.message : "Invalid URL", 400);
    }
  }

  getRun(runId: string): RunRow {
    const run = this.store.getRun(runId);
    if (!run) throw http("Run not found", 404, "UPSTREAM_NOT_FOUND");
    return run;
  }

  credentials(runId: string): Credentials {
    const creds = this.store.getCredentials(runId);
    if (!creds) {
      throw http(
        "Credentials expired for this run; enter the API keys again",
        401,
        "UPSTREAM_AUTH",
      );
    }
    return creds;
  }

  /** Test both connections (read-only) and start a run. Credentials are sealed immediately. */
  async connect(input: {
    coolify: { url: string; token: string; allowInsecureHttp?: boolean };
    dokploy: { url: string; apiKey: string; allowInsecureHttp?: boolean };
  }): Promise<{
    run: RunRow;
    coolify: { version: string; warnings: string[] };
    dokploy: { version: string; authStyle: string };
  }> {
    const coolifyUrl = this.normalizeUrl(
      input.coolify.url,
      input.coolify.allowInsecureHttp === true,
    );
    const dokployUrl = this.normalizeUrl(
      input.dokploy.url,
      input.dokploy.allowInsecureHttp === true,
    );
    const credentials: Credentials = {
      coolify: { url: coolifyUrl, token: input.coolify.token },
      dokploy: { url: dokployUrl, apiKey: input.dokploy.apiKey },
    };
    const reader = this.deps.coolify(credentials.coolify);
    const coolifyProbe = await reader.probe();
    const client = this.deps.dokploy(credentials.dokploy);
    const dokployProbe = await client.probe();
    await client.projectAll();
    const run = this.store.createRun({
      name: `Migration ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      coolifyUrl,
      dokployUrl,
      coolifyVersion: coolifyProbe.version,
      dokployVersion: dokployProbe.version,
      credentials,
    });
    return {
      run,
      coolify: {
        version: coolifyProbe.version,
        warnings: coolifyProbe.warnings,
      },
      dokploy: {
        version: dokployProbe.version,
        authStyle: dokployProbe.authStyle,
      },
    };
  }

  /** Re-enter the Dokploy key (and optionally Coolify token) after the 24 h credential TTL or a revoked key. */
  async reenterCredentials(
    runId: string,
    input: { dokployApiKey?: string; coolifyToken?: string },
  ): Promise<void> {
    const run = this.getRun(runId);
    const current = this.store.getCredentials(runId, false);
    const credentials: Credentials = {
      coolify: {
        url: run.coolifyUrl,
        token: input.coolifyToken ?? current?.coolify.token ?? "",
      },
      dokploy: {
        url: run.dokployUrl,
        apiKey: input.dokployApiKey ?? current?.dokploy.apiKey ?? "",
      },
    };
    await this.deps.dokploy(credentials.dokploy).projectAll(); // fail early if the key is wrong
    this.store.setCredentials(runId, credentials);
  }

  async discover(runId: string): Promise<IR> {
    const run = this.getRun(runId);
    if (
      ["running", "applied", "verified", "completed", "rolled_back"].includes(
        run.status,
      )
    ) {
      throw http(
        "This run already applied; start a new migration to discover again",
        409,
        "RUN_LOCKED",
      );
    }
    const creds = this.credentials(runId);
    this.store.purgeVault(runId); // a re-discovery starts from a clean vault
    this.store.updateRun(runId, { status: "discovering" });
    try {
      const reader = this.deps.coolify(creds.coolify);
      const raw = await extractInventory(reader, this.store.vault(runId), {
        sourceUrl: creds.coolify.url,
        sourceVersion: run.coolifyVersion ?? "unknown",
      });
      const ir = runRules(raw, { sensitiveRead: true });
      this.store.updateRun(runId, {
        status: "discovered",
        ir,
        plan: null,
        options: run.options ?? {},
      });
      this.store.addEvent(
        runId,
        "info",
        `Discovery finished: ${allResources(ir).length} resources in ${ir.projects.length} projects`,
      );
      return ir;
    } catch (error) {
      this.store.updateRun(runId, { status: "connected" });
      throw error;
    }
  }

  ir(runId: string): IR {
    const run = this.getRun(runId);
    if (!run.ir)
      throw http("Run has no inventory yet; run discovery first", 409);
    return IR.parse(run.ir);
  }

  userOptions(runId: string): UserOptions {
    return parseUserOptions(this.getRun(runId).options);
  }

  setOptions(runId: string, patch: unknown): UserOptions {
    const run = this.getRun(runId);
    if (
      ["running", "applied", "verified", "completed", "rolled_back"].includes(
        run.status,
      )
    ) {
      throw http("Options are locked after apply", 409, "RUN_LOCKED");
    }
    const merged = parseUserOptions({
      ...parseUserOptions(run.options),
      ...(patch as object),
    });
    this.store.updateRun(runId, {
      options: merged,
      status: run.ir ? "selected" : run.status,
      plan: null,
    });
    return merged;
  }

  /** What the UI shows after discovery: every resource with compat, issues and whether it is selected/blocked. */
  inventory(runId: string) {
    const ir = this.ir(runId);
    const user = this.userOptions(runId);
    const included = new Set(
      user.include ?? allResources(ir).map((r) => r.resource.srcId),
    );
    return {
      source: ir.source,
      notes: ir.notes,
      servers: ir.servers,
      projects: ir.projects.map((p) => ({
        srcId: p.srcId,
        name: p.name,
        environments: p.environments.map((e) => ({
          srcId: e.srcId,
          name: e.name,
          resources: e.resources.map((r) => ({
            srcId: r.srcId,
            name: r.name,
            kind: r.kind,
            compat: r.compat,
            issues: r.issues,
            selected: included.has(r.srcId),
            blocked: isBlocked(r, user),
            summary: summarize(r),
          })),
        })),
      })),
    };
  }

  /** Read-only look at Dokploy for the options screen: servers and existing project names. */
  async target(runId: string) {
    const client = this.deps.dokploy(this.credentials(runId).dokploy);
    const [projects, servers] = await Promise.all([
      client.projectAll(),
      client.serverAll().catch(() => []),
    ]);
    return {
      projects: projects.map((p) => ({ projectId: p.projectId, name: p.name })),
      servers: servers
        .map((s) => ({ serverId: s.serverId ?? "", name: s.name }))
        .filter((s) => s.serverId),
    };
  }

  /** What Dokploy can link to: GitHub Apps (with the repos each can reach) and SSH keys. Failures degrade to "unknown". */
  private async gitSnapshot(client: DokployClient): Promise<GitSnapshot> {
    const [providers, keys] = await Promise.all([
      client.gitProviders().catch(() => []),
      client.sshKeys().catch(() => []),
    ]);
    const github = await Promise.all(
      providers
        .flatMap((p) =>
          p.githubId ? [{ githubId: p.githubId, name: p.name }] : [],
        )
        .map(async (p) => ({
          githubId: p.githubId,
          label: p.name,
          repos: await client
            .githubRepositories(p.githubId)
            .then((r) => new Set(r))
            .catch(() => null),
        })),
    );
    return {
      github,
      ssh: keys.map((k) => {
        const fingerprint = k.publicKey
          ? sshFingerprint(k.publicKey)
          : undefined;
        return {
          sshKeyId: k.sshKeyId,
          name: k.name,
          ...(fingerprint ? { fingerprint } : {}),
        };
      }),
    };
  }

  /** Resources whose repository needs credentials in Dokploy. */
  private privateRepos(ir: IR) {
    return allResources(ir).flatMap(({ project, environment, resource }) =>
      (resource.kind === "application" || resource.kind === "compose") &&
      resource.source?.type === "git" &&
      resource.source.provider !== "public"
        ? [{ project, environment, resource, source: resource.source }]
        : [],
    );
  }

  /** Data for the Git access picker: what was resolved automatically and every alternative. */
  async gitView(runId: string) {
    const ir = this.ir(runId);
    const user = this.userOptions(runId);
    const snapshot = await this.gitSnapshot(
      this.deps.dokploy(this.credentials(runId).dokploy),
    );
    const included = new Set(
      user.include ?? allResources(ir).map((r) => r.resource.srcId),
    );
    return {
      github: snapshot.github.map((g) => ({
        githubId: g.githubId,
        label: g.label,
        reposKnown: g.repos !== null,
      })),
      ssh: snapshot.ssh.map((k) => ({ sshKeyId: k.sshKeyId, label: k.name })),
      resources: this.privateRepos(ir)
        .filter((r) => included.has(r.resource.srcId))
        .map(({ project, resource, source }) => {
          const info = {
            provider: source.provider,
            repo: source.repo,
            url: source.url,
            keyName: source.keyName,
            keyFingerprint: source.keyFingerprint,
          };
          const override = user.gitOverrides[resource.srcId];
          const resolved: GitLink = resolveGitLink(info, snapshot, override);
          const candidates: GitCandidates = candidatesFor(info, snapshot);
          return {
            srcId: resource.srcId,
            name: resource.name,
            project: project.name,
            repo: source.repo,
            branch: source.branch,
            provider: source.provider,
            coolify: {
              appName: source.appName,
              appOrg: source.appOrg,
              keyName: source.keyName,
            },
            resolved,
            candidates,
            overridden: override !== undefined,
          };
        }),
    };
  }

  /** Dry run: read Dokploy, build the plan, store it. Makes no writes. */
  async plan(runId: string): Promise<{ plan: Plan; problems: string[] }> {
    const run = this.getRun(runId);
    if (
      ["running", "applied", "verified", "completed", "rolled_back"].includes(
        run.status,
      )
    ) {
      throw http("This run already applied", 409, "RUN_LOCKED");
    }
    const ir = this.ir(runId);
    const user = this.userOptions(runId);
    const client = this.deps.dokploy(this.credentials(runId).dokploy);
    const existing = await client.projectAll();
    const names = (env: Record<string, unknown>) =>
      [
        "applications",
        "compose",
        "postgres",
        "mysql",
        "mariadb",
        "mongo",
        "redis",
      ].flatMap((key) =>
        ((env[key] as Array<{ name?: string }> | undefined) ?? [])
          .map((r) => r.name)
          .filter((n): n is string => Boolean(n)),
      );
    const snapshot: TargetSnapshot = {
      projects: existing.map((p) => ({
        projectId: p.projectId,
        name: p.name,
        environments: (p.environments ?? []).map((e) => ({
          environmentId: e.environmentId,
          name: e.name,
          resourceNames: names(e as Record<string, unknown>),
        })),
      })),
    };
    const gitSnapshot = await this.gitSnapshot(client);
    const gitLinks: Record<string, GitLink> = {};
    for (const { resource, source } of this.privateRepos(ir)) {
      gitLinks[resource.srcId] = resolveGitLink(
        {
          provider: source.provider,
          repo: source.repo,
          url: source.url,
          keyName: source.keyName,
          keyFingerprint: source.keyFingerprint,
        },
        gitSnapshot,
        user.gitOverrides[resource.srcId],
      );
    }
    const plan = buildPlan(ir, toCoreOptions(ir, user), {
      ...snapshot,
      gitLinks,
    });
    const problems = validatePlan(plan);
    if (problems.length > 0)
      throw http(`Plan is invalid: ${problems.join("; ")}`, 500, "INTERNAL");
    this.store.replaceSteps(runId, plan);
    this.store.updateRun(runId, { plan, status: "planned" });
    return { plan, problems };
  }

  planView(runId: string) {
    const run = this.getRun(runId);
    const plan = run.plan;
    return {
      status: run.status,
      steps: this.store.listSteps(runId),
      notes: (plan as { notes?: string[] } | null)?.notes ?? [],
      hasPlan: plan !== null,
    };
  }

  async verify(runId: string) {
    const run = this.getRun(runId);
    if (!run.plan) throw http("Nothing to verify yet", 409);
    const client = this.deps.dokploy(this.credentials(runId).dokploy);
    const checks = await verifyMigration(
      run.plan,
      this.store.idMap(runId).entries(),
      client,
    );
    const redactor = this.store.redactor(runId);
    const safe = checks.map((c) => ({
      ...c,
      ...(c.detail ? { detail: redactor.redact(c.detail) } : {}),
    }));
    if (run.status === "applied")
      this.store.updateRun(runId, {
        status: safe.every((c) => c.status !== "fail") ? "verified" : "applied",
      });
    return safe;
  }

  async report(runId: string): Promise<{ markdown: string; manifest: string }> {
    const run = this.getRun(runId);
    if (!run.ir || !run.plan)
      throw http("Report is available after planning", 409);
    const ir = IR.parse(run.ir);
    const records = this.store.listSteps(runId).map((s) => ({
      seq: s.seq,
      state: s.state,
      ...(s.targetId ? { targetId: s.targetId } : {}),
      ...(s.note ? { note: s.note } : {}),
      warnings: s.warnings,
    }));
    let verify: Awaited<ReturnType<RunService["verify"]>> | undefined;
    if (
      ["applied", "verified", "completed"].includes(run.status) &&
      this.store.getCredentials(runId, false)
    ) {
      verify = await this.verify(runId).catch(() => undefined);
    }
    const markdown = renderMigrationReport({
      ir,
      plan: run.plan,
      records,
      ...(verify ? { verify } : {}),
      target: {
        url: run.dokployUrl,
        ...(run.dokployVersion ? { version: run.dokployVersion } : {}),
      },
      generatedAt: new Date().toISOString(),
    });
    const manifest = renderManifest(
      ir,
      run.plan,
      records.map((r) => ({
        seq: r.seq,
        kind: run.plan?.steps.find((s) => s.seq === r.seq)?.kind ?? "",
        state: r.state,
        srcId: run.plan?.steps.find((s) => s.seq === r.seq)?.srcId ?? "",
        ...(r.targetId ? { targetId: r.targetId } : {}),
      })),
      {
        id: run.id,
        createdAt: new Date(run.createdAt).toISOString(),
        targetUrl: run.dokployUrl,
        ...(run.dokployVersion ? { targetVersion: run.dokployVersion } : {}),
      },
    );
    return { markdown, manifest };
  }

  compatMarkdown(runId: string): string {
    return renderCompatMarkdown(this.ir(runId));
  }

  /** What rollback would delete: only resources this run created, never adopted ones. */
  rollbackPreview(runId: string) {
    const run = this.getRun(runId);
    const entries = this.rollbackEntries(runId);
    const plan = buildRollbackPlan(entries);
    return {
      runName: run.name,
      confirmPhrase: `DELETE ${run.name}`,
      items: plan.steps.map((s) => ({
        kind: String(s.payload.targetKind),
        label: s.label,
      })),
    };
  }

  private rollbackEntries(runId: string): RollbackEntry[] {
    const run = this.getRun(runId);
    const nameOf = new Map<string, string>();
    for (const step of run.plan?.steps ?? []) {
      if (typeof step.payload.name === "string")
        nameOf.set(step.srcId, step.payload.name);
      if (typeof step.payload.host === "string")
        nameOf.set(
          `${step.srcId}|domain|${String(step.payload.itemKey)}`,
          step.payload.host,
        );
      if (typeof step.payload.mountPath === "string")
        nameOf.set(
          `${step.srcId}|mount|${String(step.payload.itemKey)}`,
          step.payload.mountPath,
        );
    }
    return this.store
      .idMap(runId)
      .entries()
      .map((e) => ({
        srcId: e.srcId,
        srcKind: e.srcKind as RollbackEntry["srcKind"],
        targetId: e.targetId,
        created: e.created,
        label: nameOf.get(e.srcId) ?? e.targetId,
      }));
  }

  async rollback(runId: string, confirm: string): Promise<{ deleted: number }> {
    const run = this.getRun(runId);
    if (run.status === "running")
      throw http(
        "Pause or cancel the run before rolling back",
        409,
        "RUN_LOCKED",
      );
    requireRollbackConfirmation(run.name, confirm);
    const client = this.deps.dokploy(this.credentials(runId).dokploy);
    const plan = buildRollbackPlan(this.rollbackEntries(runId));
    let deleted = 0;
    for (const step of plan.steps) {
      await executeRollbackStep(step, client);
      deleted++;
      this.store.addEvent(
        runId,
        "info",
        `Deleted ${step.label.replace(/^Delete created /, "")}`,
      );
    }
    this.store.clearIdMap(runId);
    this.store.purgeVault(runId);
    this.store.updateRun(runId, { status: "rolled_back" });
    return { deleted };
  }

  purge(runId: string): void {
    this.getRun(runId);
    this.store.deleteRun(runId);
  }
}

function summarize(
  r: IR["projects"][number]["environments"][number]["resources"][number],
): string {
  if (r.kind === "application") {
    const src =
      r.source.type === "git"
        ? `${r.source.repo}@${r.source.branch}`
        : `${r.source.image}:${r.source.tag}`;
    return `${r.build.rawPack} · ${src}`;
  }
  if (r.kind === "compose")
    return r.isTemplateService
      ? `template ${r.templateName ?? ""}`.trim()
      : r.source?.type === "git"
        ? `compose · ${r.source.repo}@${r.source.branch}`
        : "compose";
  return `${r.engine} · ${r.image}`;
}
