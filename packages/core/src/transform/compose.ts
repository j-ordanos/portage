import { parse } from "yaml";
import type { Issue } from "../ir/schema.js";

export interface ComposeAnalysis {
  composeFile: string;
  needsValue: string[];
  issues: Issue[];
  valid: boolean;
}

export function resolveComposeDefaults(
  composeRaw: string,
  knownEnv: Record<string, string>,
): string {
  return composeRaw.replace(
    /\$\{([A-Z0-9_]+):-([^}]*)\}/g,
    (_match, key: string, fallback: string) => knownEnv[key] ?? fallback,
  );
}

const magicPattern =
  /\$\{?(SERVICE_(?:FQDN|URL|PASSWORD|USER|BASE64)(?:_[A-Z0-9]+)?)\}?/g;

export function analyzeCompose(composeRaw: string): ComposeAnalysis {
  let parsed: unknown;
  try {
    parsed = parse(composeRaw);
  } catch {
    return {
      composeFile: composeRaw,
      needsValue: [],
      valid: false,
      issues: [
        {
          ruleId: "R-074",
          severity: "error",
          message: "Compose YAML is invalid",
          fix: "Fix the Compose YAML manually before applying.",
        },
      ],
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      composeFile: composeRaw,
      needsValue: [],
      valid: false,
      issues: [
        {
          ruleId: "R-074",
          severity: "error",
          message: "Compose YAML is invalid",
          fix: "Fix the Compose YAML manually before applying.",
        },
      ],
    };
  }

  const needsValue = Array.from(
    composeRaw.matchAll(magicPattern),
    (match) => match[1] ?? match[0],
  ).filter((value, index, values) => values.indexOf(value) === index);
  const issues: Issue[] = [];
  if (needsValue.length) {
    issues.push({
      ruleId: "R-070",
      severity: "warn",
      message: "Compose uses Coolify magic variables",
      fix: "Enter target values for the listed variables.",
    });
  }
  if (/coolify\./i.test(composeRaw) || /traefik/i.test(composeRaw)) {
    issues.push({
      ruleId: "R-071",
      severity: "warn",
      message: "Compose contains Coolify or Traefik labels",
      fix: "Strip platform-specific labels and verify domains.",
    });
  }
  if (/coolify/i.test(composeRaw) || /external:\s*true/i.test(composeRaw)) {
    issues.push({
      ruleId: "R-072",
      severity: "warn",
      message: "Compose references Coolify or external networking",
      fix: "Remove the external network reference and use target networking.",
    });
  }

  const sanitized = composeRaw
    .replace(/^\s*-[ \t]*coolify\.[^\n]*$/gm, "")
    .replace(/^\s*coolify:[^\n]*$/gm, "")
    .replace(/^\s*coolify\s*$/gm, "");
  return { composeFile: sanitized, needsValue, issues, valid: true };
}
