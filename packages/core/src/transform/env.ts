import type { EnvVar } from "../ir/schema.js";

export type SecretMode = "names-only" | "import-values" | "prompt";

export interface EnvTransformOptions {
  defaultMode: SecretMode;
  perVar?: Record<string, SecretMode>;
  /** Reads a secret from the vault. Only called at the moment the value is written. */
  resolveValue?: (ref: string) => Promise<string>;
  /** `prompt` mode: ref of a value the user typed for `${srcId}:${key}`, if any. */
  promptRef?: (srcId: string, key: string) => string | undefined;
  /**
   * Only Dockerfile builds consume `buildArgs`. nixpacks/railpack/static builders read build-time
   * variables from the environment, so for them build-time-only vars stay in `env`. Default false.
   */
  splitBuildArgs?: boolean;
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Dokploy's own shared-variable tokens survive unquoted.
const DOKPLOY_REF = /\$\{\{(?:project|environment)\.[A-Za-z0-9_]+\}\}/g;
const SAFE = /^[A-Za-z0-9_./:@+,=%-]*$/;

/** Drop preview twins, de-duplicate by key, sort. */
export function normalizeEnv(vars: EnvVar[]): EnvVar[] {
  const byKey = new Map<string, EnvVar>();
  for (const variable of vars) {
    if (!variable.isPreview) byKey.set(variable.key, variable);
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Serialize one value for Dokploy's env string (parsed with dotenv semantics):
 *  - unquoted: `#` starts a comment, edges are trimmed        -> only plain values stay raw
 *  - 'single': fully literal, may span lines                  -> preferred
 *  - "double": only `\n` is expanded                          -> when the value contains `'`
 *  - `backtick`: literal                                      -> when it contains both quote kinds
 */
export function serializeValue(value: string): string {
  if (SAFE.test(value.replace(DOKPLOY_REF, ""))) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value.replace(/\r?\n/g, "\\n")}"`;
  if (!value.includes("`")) return `\`${value}\``;
  return `"${value.replace(/\r?\n/g, "\\n")}"`; // last resort: quotes stay as-is
}

export function serializeEnv(vars: EnvVar[]): string {
  return normalizeEnv(vars)
    .map((variable) => `${variable.key}=`)
    .join("\n");
}

/** Coolify `{{project.X}}` / `{{environment.X}}` -> Dokploy `${{project.X}}` / `${{environment.X}}`. */
export function rewriteSharedRefs(value: string): string {
  return value
    .replace(/\{\{\s*project\.([A-Za-z0-9_]+)\s*\}\}/g, "${{project.$1}}")
    .replace(
      /\{\{\s*environment\.([A-Za-z0-9_]+)\s*\}\}/g,
      "${{environment.$1}}",
    );
}

export interface DokployEnv {
  /** Runtime (and build+runtime) variables -> `application.saveEnvironment.env`. */
  env: string;
  /** Build-time-only variables -> `buildArgs`. */
  buildArgs: string;
  /** Keys written, never values. */
  keys: string[];
  /** Human warnings (no values). */
  warnings: string[];
}

/**
 * Build the complete env strings for one resource. `saveEnvironment` is a full replace,
 * so this is called once per resource.
 * `extra` are tool-generated variables (e.g. NIXPACKS_BUILD_CMD) appended without overriding user keys.
 */
export async function buildDokployEnv(
  srcId: string,
  vars: EnvVar[],
  options: EnvTransformOptions,
  extra: Record<string, string> = {},
): Promise<DokployEnv> {
  const runtime: string[] = [];
  const build: string[] = [];
  const keys: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const variable of normalizeEnv(vars)) {
    if (!KEY.test(variable.key)) {
      warnings.push(
        `Variable '${variable.key}' has a key Dokploy cannot store and was skipped`,
      );
      continue;
    }
    const mode =
      options.perVar?.[`${srcId}:${variable.key}`] ?? options.defaultMode;
    let ref: string | null = null;
    if (mode === "import-values" && variable.availability === "available") {
      ref = variable.valueRef;
    } else if (mode === "prompt") {
      ref = options.promptRef?.(srcId, variable.key) ?? null;
    }
    let value = "";
    if (ref && options.resolveValue) {
      value = rewriteSharedRefs(await options.resolveValue(ref));
    } else if (
      mode === "import-values" &&
      variable.availability !== "available"
    ) {
      warnings.push(
        `Variable '${variable.key}' had no readable value; created empty`,
      );
    }
    if (/\{\{\s*team\./.test(value)) {
      warnings.push(
        `Variable '${variable.key}' references a team-level variable, which Dokploy does not have`,
      );
    }
    seen.add(variable.key);
    keys.push(variable.key);
    const line = `${variable.key}=${serializeValue(value)}`;
    (options.splitBuildArgs && variable.scope === "buildtime"
      ? build
      : runtime
    ).push(line);
  }
  for (const [key, value] of Object.entries(extra).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (seen.has(key)) continue;
    keys.push(key);
    runtime.push(`${key}=${serializeValue(value)}`);
  }
  return {
    env: runtime.join("\n"),
    buildArgs: build.join("\n"),
    keys,
    warnings,
  };
}

/** Back-compat helper: the runtime env string only. */
export async function buildEnvString(
  srcId: string,
  vars: EnvVar[],
  options: EnvTransformOptions,
): Promise<string> {
  return (await buildDokployEnv(srcId, vars, options)).env;
}
