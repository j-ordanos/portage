import { AppError, validateUpstreamUrl } from "@migrator/core";
import type { Config } from "../config.js";
import type { ConnectionRow, Store } from "../db/store.js";
import type { Deps } from "./service.js";

const fail = (message: string, status: number, code = "CONFIG_INVALID") =>
  Object.assign(new AppError(code as never, message), { status });

export interface ConnectionView {
  id: string;
  kind: "coolify" | "dokploy";
  name: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  check: ConnectionRow["check"];
}

const view = (c: ConnectionRow): ConnectionView => ({
  id: c.id,
  kind: c.kind,
  name: c.name,
  url: c.url,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  lastUsedAt: c.lastUsedAt,
  check: c.check,
});

/**
 * Saved servers. The token or API key is sealed on disk and is never returned by any API: the UI only ever
 * sees "saved". Saving requires a successful connection test, so a typo is caught immediately.
 */
export class ConnectionService {
  constructor(
    private readonly store: Store,
    private readonly deps: Deps,
    private readonly config: Config,
  ) {}

  normalizeUrl(input: string, allowInsecureHttp: boolean): string {
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
      throw fail(
        error instanceof Error ? error.message : "Invalid address",
        400,
      );
    }
  }

  /** Read-only connection test. Returns what the user should see; throws AppError with a hint on failure. */
  async probe(
    kind: "coolify" | "dokploy",
    url: string,
    secret: string,
  ): Promise<{ version: string; warnings: string[] }> {
    if (kind === "coolify") {
      const reader = this.deps.coolify({ url, token: secret });
      const probe = await reader.probe();
      return { version: probe.version, warnings: probe.warnings };
    }
    const client = this.deps.dokploy({ url, apiKey: secret });
    const probe = await client.probe();
    await client.projectAll(); // proves the key can read, not just authenticate
    return { version: probe.version, warnings: [] };
  }

  list(userId: string): ConnectionView[] {
    return this.store.listConnections(userId).map(view);
  }

  private owned(userId: string, id: string): ConnectionRow {
    const row = this.store.getConnection(id, userId);
    if (!row) throw fail("Connection not found", 404, "UPSTREAM_NOT_FOUND");
    return row;
  }

  private checkName(name: unknown): string {
    const clean = typeof name === "string" ? name.trim() : "";
    if (clean.length < 1 || clean.length > 40)
      throw fail("Give the connection a name of 1 to 40 characters", 400);
    return clean;
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof Error && /UNIQUE constraint failed/.test(error.message)
    );
  }

  async create(
    userId: string,
    input: {
      kind: unknown;
      name: unknown;
      url: unknown;
      secret: unknown;
      allowInsecureHttp?: unknown;
    },
  ) {
    if (input.kind !== "coolify" && input.kind !== "dokploy")
      throw fail("Choose Coolify or Dokploy", 400);
    if (
      typeof input.url !== "string" ||
      typeof input.secret !== "string" ||
      input.secret.trim() === ""
    ) {
      throw fail(
        input.kind === "coolify"
          ? "Enter the address and the API token"
          : "Enter the address and the API key",
        400,
      );
    }
    const name = this.checkName(input.name);
    const url = this.normalizeUrl(input.url, input.allowInsecureHttp === true);
    const secret = input.secret.trim();
    const result = await this.probe(input.kind, url, secret);
    try {
      const row = this.store.createConnection({
        userId,
        kind: input.kind,
        name,
        url,
        secret,
        check: { ok: true, version: result.version, at: Date.now() },
      });
      return { connection: view(row), warnings: result.warnings };
    } catch (error) {
      if (this.isDuplicate(error))
        throw fail(
          `You already have a ${input.kind} connection named “${name}”`,
          409,
        );
      throw error;
    }
  }

  async update(
    userId: string,
    id: string,
    input: {
      name?: unknown;
      url?: unknown;
      secret?: unknown;
      allowInsecureHttp?: unknown;
    },
  ) {
    const current = this.owned(userId, id);
    if (this.store.activeRunsUsing(id) > 0)
      throw fail(
        "A migration is using this connection right now. Pause or finish it first.",
        409,
        "RUN_LOCKED",
      );
    const patch: {
      name?: string;
      url?: string;
      secret?: string;
      check?: ConnectionRow["check"];
    } = {};
    if (input.name !== undefined) patch.name = this.checkName(input.name);
    const newUrl =
      typeof input.url === "string" && input.url.trim() !== ""
        ? this.normalizeUrl(input.url, input.allowInsecureHttp === true)
        : undefined;
    const newSecret =
      typeof input.secret === "string" && input.secret.trim() !== ""
        ? input.secret.trim()
        : undefined; // blank = keep the saved one
    let warnings: string[] = [];
    if ((newUrl && newUrl !== current.url) || newSecret) {
      const url = newUrl ?? current.url;
      const secret = newSecret ?? (this.store.connectionSecret(id) as string);
      const result = await this.probe(current.kind, url, secret);
      warnings = result.warnings;
      patch.url = url;
      if (newSecret) patch.secret = newSecret;
      patch.check = { ok: true, version: result.version, at: Date.now() };
    }
    try {
      this.store.updateConnection(id, userId, patch);
    } catch (error) {
      if (this.isDuplicate(error))
        throw fail(
          `You already have a ${current.kind} connection with that name`,
          409,
        );
      throw error;
    }
    return { connection: view(this.owned(userId, id)), warnings };
  }

  /** Re-test a saved connection with its stored secret and remember the outcome. */
  async test(userId: string, id: string) {
    const row = this.owned(userId, id);
    const secret = this.store.connectionSecret(id) as string;
    try {
      const result = await this.probe(row.kind, row.url, secret);
      this.store.updateConnection(id, userId, {
        check: { ok: true, version: result.version, at: Date.now() },
      });
      return {
        connection: view(this.owned(userId, id)),
        warnings: result.warnings,
      };
    } catch (error) {
      const message =
        error instanceof AppError ? error.message : "Could not connect";
      this.store.updateConnection(id, userId, {
        check: { ok: false, message, at: Date.now() },
      });
      throw error;
    }
  }

  delete(userId: string, id: string): void {
    this.owned(userId, id);
    if (this.store.activeRunsUsing(id) > 0)
      throw fail(
        "A migration is using this connection right now. Pause or finish it first.",
        409,
        "RUN_LOCKED",
      );
    this.store.deleteConnection(id, userId);
  }
}
