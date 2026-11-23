import type { EnvVar } from "../ir/schema.js";
import type { Vault } from "../vault.js";
import { arr, rec } from "./util.js";

const SECRET_KEY = /(SECRET|TOKEN|PASSWORD|KEY|PRIVATE|CREDENTIAL|DSN)/i;
const SHARED_REF = /\{\{\s*(team|project|environment)\.([A-Za-z0-9_]+)\s*\}\}/g;

export function sharedRefs(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(SHARED_REF)].map((m) => `${m[1]}.${m[2]}`);
}

export interface MappedEnv {
  env: EnvVar[];
  /** Variables Coolify generates itself (SERVICE_URL_*, SERVICE_FQDN_*): never migrated. */
  coolifyManaged: number;
}

/**
 * Coolify env objects (verified on 4.7.5): key, value, real_value, is_buildtime, is_runtime,
 * is_literal, is_multiline, is_preview, is_shown_once, is_coolify, is_shared.
 * The list repeats every variable, so we de-duplicate by key + preview flag.
 * Values go to the vault; the IR keeps only a reference.
 */
export async function mapEnvs(raw: unknown, vault: Vault): Promise<MappedEnv> {
  const merged = new Map<
    string,
    {
      item: Record<string, unknown>;
      value?: string | undefined;
      bt: boolean;
      rt: boolean;
    }
  >();
  let coolifyManaged = 0;
  for (const entry of arr(raw)) {
    const item = rec(entry);
    const key = typeof item.key === "string" ? item.key : "";
    if (!key) continue;
    if (item.is_coolify === true) {
      coolifyManaged++;
      continue;
    }
    const id = `${key}|${item.is_preview === true ? "p" : "n"}`;
    const value =
      typeof item.real_value === "string"
        ? item.real_value
        : typeof item.value === "string"
          ? item.value
          : undefined;
    const bt = item.is_buildtime === true;
    const rt = item.is_runtime === true;
    const existing = merged.get(id);
    if (existing) {
      existing.bt ||= bt;
      existing.rt ||= rt;
      if (existing.value === undefined) existing.value = value;
      continue;
    }
    merged.set(id, { item, value, bt, rt });
  }

  const env: EnvVar[] = [];
  for (const { item, value, bt, rt } of merged.values()) {
    const key = item.key as string;
    const shownOnce = item.is_shown_once === true;
    const availability =
      value !== undefined && !(shownOnce && value === "")
        ? ("available" as const)
        : shownOnce
          ? ("redacted" as const)
          : ("missing" as const);
    const valueRef =
      availability === "available" ? await vault.put(value as string) : null;
    env.push({
      key,
      availability,
      valueRef,
      isSecretGuess: SECRET_KEY.test(key),
      refs: sharedRefs(value),
      scope: bt && rt ? "both" : rt ? "runtime" : bt ? "buildtime" : "unknown",
      isPreview: item.is_preview === true,
      isMultiline:
        item.is_multiline === true || (value?.includes("\n") ?? false),
      isLiteral: item.is_literal === true,
      ...(typeof item.comment === "string" && item.comment
        ? { comment: item.comment }
        : {}),
    });
  }
  env.sort(
    (a, b) =>
      a.key.localeCompare(b.key) || Number(a.isPreview) - Number(b.isPreview),
  );
  return { env, coolifyManaged };
}
