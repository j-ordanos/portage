import { AppError } from "../errors.js";

export type Rec = Record<string, unknown>;

export function rec(value: unknown): Rec {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : {};
}

/** Non-empty string field, else undefined. */
export function str(value: unknown, key: string): string | undefined {
  const field = rec(value)[key];
  return typeof field === "string" && field.trim() !== "" ? field : undefined;
}

export function num(value: unknown, key: string): number | undefined {
  const field = rec(value)[key];
  if (typeof field === "number" && Number.isFinite(field)) return field;
  if (typeof field === "string" && field.trim() !== "") {
    const parsed = Number(field);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Coolify auto-names apps like "matchmaker:main-<24 char id>" or "happy-whale-<24 char id>".
 * Strip the id suffix and the ":branch" part so Dokploy gets a readable name.
 */
export function cleanName(name: string | undefined, uuid: string): string {
  if (!name) return uuid;
  let cleaned = name.replace(/-[a-z0-9]{24}$/, "");
  const colon = cleaned.indexOf(":");
  if (colon > 0) cleaned = cleaned.slice(0, colon);
  cleaned = cleaned.trim();
  return cleaned || uuid;
}

/** Hosts Coolify generates when the user never set a domain. Not worth migrating. */
export function isAutoDomain(host: string): boolean {
  return /\.(sslip\.io|nip\.io|traefik\.me)$/i.test(host);
}

export interface ParsedDomain {
  host: string;
  https: boolean;
  port?: number;
  path?: string;
  source: string;
}

/** Parse a comma separated FQDN list ("https://a.com,http://b.com:3000/x"). */
export function parseFqdns(
  raw: string | undefined,
  defaultPort?: number,
): { domains: ParsedDomain[]; autoSkipped: number } {
  const byKey = new Map<string, ParsedDomain>();
  let autoSkipped = 0;
  for (const token of (raw ?? "").split(/[,\s]+/).filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(token.includes("://") ? token : `http://${token}`);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (!host) continue;
    if (isAutoDomain(host)) {
      autoSkipped++;
      continue;
    }
    const path = url.pathname !== "/" ? url.pathname : undefined;
    const port = url.port ? Number(url.port) : defaultPort;
    const key = `${host}${path ?? ""}`;
    const https = url.protocol === "https:";
    const existing = byKey.get(key);
    if (existing) {
      existing.https = existing.https || https;
      continue;
    }
    byKey.set(key, {
      host,
      https,
      ...(port ? { port } : {}),
      ...(path ? { path } : {}),
      source: token,
    });
  }
  return { domains: [...byKey.values()], autoSkipped };
}

export function causeOf(error: unknown): string {
  if (error instanceof AppError) return `${error.code}: ${error.message}`;
  return "unexpected error";
}

/** Run `fn` over items with bounded concurrency, keeping input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
