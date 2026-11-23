import type { EnvVar } from "../ir/schema.js";

export type SecretMode = "names-only" | "import-values" | "prompt";

export interface EnvTransformOptions {
  defaultMode: SecretMode;
  perVar?: Record<string, SecretMode>;
  resolveValue?: (ref: string) => Promise<string>;
}

export function normalizeEnv(vars: EnvVar[]): EnvVar[] {
  const byKey = new Map<string, EnvVar>();
  for (const variable of vars) {
    if (!variable.isPreview) byKey.set(variable.key, variable);
  }
  return [...byKey.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

export function serializeEnv(vars: EnvVar[]): string {
  return normalizeEnv(vars)
    .map((variable) => `${variable.key}=${serializeValue("")}`)
    .join("\n");
}

export function serializeValue(value: string): string {
  if (value === "" || /^[A-Za-z0-9_./:@+-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function rewriteSharedRefs(value: string): string {
  return value
    .replace(/\{\{\s*project\.([A-Za-z0-9_]+)\s*\}\}/g, "${{project.$1}}")
    .replace(
      /\{\{\s*environment\.([A-Za-z0-9_]+)\s*\}\}/g,
      "${{environment.$1}}",
    );
}

export async function buildEnvString(
  srcId: string,
  vars: EnvVar[],
  options: EnvTransformOptions,
): Promise<string> {
  const lines: string[] = [];
  for (const variable of normalizeEnv(vars)) {
    const mode =
      options.perVar?.[`${srcId}:${variable.key}`] ?? options.defaultMode;
    let value = "";
    if (
      mode === "import-values" &&
      variable.availability === "available" &&
      variable.valueRef &&
      options.resolveValue
    ) {
      value = await options.resolveValue(variable.valueRef);
      value = rewriteSharedRefs(value);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.key)) continue;
    lines.push(`${variable.key}=${serializeValue(value)}`);
  }
  return lines.join("\n");
}
