/**
 * Per-run registry of live secrets (tokens, API keys, every vault value that was read).
 * `redact` replaces any occurrence with [REDACTED], longest first, and also masks common token shapes.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  constructor(initial: Iterable<string> = []) {
    for (const secret of initial) this.add(secret);
  }

  /** Values shorter than 6 characters are ignored: masking them would mangle ordinary text. */
  add(secret: string | undefined | null): void {
    if (typeof secret === "string" && secret.length >= 6)
      this.secrets.add(secret);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of [...this.secrets].sort(
      (a, b) => b.length - a.length,
    )) {
      out = out.split(secret).join("[REDACTED]");
    }
    return redactPatterns(out);
  }

  get size(): number {
    return this.secrets.size;
  }
}

const PATTERNS: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED PRIVATE KEY]",
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    "[REDACTED JWT]",
  ],
  [
    /((?:token|api[_-]?key|secret|password|passwd)["'\s]*[:=]["'\s]*)[A-Za-z0-9._~+/=-]{16,}/gi,
    "$1[REDACTED]",
  ],
  [/(\/\/[^/\s:@]+:)[^@\s]+@/g, "$1[REDACTED]@"],
];

export function redactPatterns(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS)
    out = out.replace(pattern, replacement);
  return out;
}
