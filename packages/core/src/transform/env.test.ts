import { parse } from "dotenv";
import { describe, expect, it } from "vitest";
import type { EnvVar } from "../ir/schema.js";
import { buildDokployEnv, serializeValue } from "./env.js";

const v = (key: string, over: Partial<EnvVar> = {}): EnvVar => ({
  key,
  availability: "available",
  valueRef: `ref_${key}`,
  isSecretGuess: false,
  refs: [],
  scope: "both",
  isPreview: false,
  isMultiline: false,
  isLiteral: false,
  ...over,
});

describe("serializeValue round-trips through dotenv (Dokploy's parser)", () => {
  const cases: Record<string, string> = {
    plain: "hello",
    empty: "",
    url: "postgres://u:p@host:5432/db?sslmode=require",
    equals: "a=b=c",
    hash: "a#b",
    spaces: "hello world",
    leadingTrailing: "  padded  ",
    doubleQuote: 'say "hi"',
    singleQuote: "it's",
    bothQuotes: `it's "x"`,
    dollar: "$notexpanded",
    multiline: "line1\nline2\nline3",
    unicode: "héllo wörld ✓ 日本",
    longValue: "x".repeat(5000),
    jsonBlob: '{"a":1,"b":["x","y"]}',
  };
  for (const [name, value] of Object.entries(cases)) {
    it(name, () => {
      const parsed = parse(`KEY=${serializeValue(value)}`);
      expect(parsed.KEY).toBe(value);
    });
  }
  it("keeps Dokploy shared-variable tokens raw", () => {
    expect(serializeValue("${{environment.DB_URL}}")).toBe(
      "${{environment.DB_URL}}",
    );
  });
});

describe("buildDokployEnv", () => {
  const values: Record<string, string> = {
    ref_A: "1",
    ref_B: "{{environment.SHARED_X}}",
    ref_C: "build-only",
    ref_D: "team {{team.X}}",
  };
  const resolveValue = async (ref: string) => values[ref] as string;

  it("splits build-time vars, rewrites refs, drops previews and Coolify-invalid keys", async () => {
    const out = await buildDokployEnv(
      "app",
      [
        v("A"),
        v("B"),
        v("C", { scope: "buildtime" }),
        v("A", { isPreview: true }),
        v("bad key"),
      ],
      { defaultMode: "import-values", resolveValue, splitBuildArgs: true },
    );
    expect(out.env).toBe("A=1\nB=${{environment.SHARED_X}}");
    expect(out.buildArgs).toBe("C=build-only");
    expect(out.keys).toEqual(["A", "B", "C"]);
    expect(out.warnings.join()).toContain("bad key");
  });

  it("keeps build-time vars in env unless the build is a Dockerfile (nixpacks/railpack read env)", async () => {
    const out = await buildDokployEnv("app", [v("C", { scope: "buildtime" })], {
      defaultMode: "import-values",
      resolveValue,
    });
    expect(out.env).toBe("C=build-only");
    expect(out.buildArgs).toBe("");
  });

  it("names-only never reads the vault", async () => {
    let reads = 0;
    const out = await buildDokployEnv("app", [v("A"), v("B")], {
      defaultMode: "names-only",
      resolveValue: async () => {
        reads++;
        return "x";
      },
    });
    expect(out.env).toBe("A=\nB=");
    expect(reads).toBe(0);
  });

  it("never guesses unavailable values and warns", async () => {
    const out = await buildDokployEnv(
      "app",
      [v("LOCKED", { availability: "redacted", valueRef: null })],
      { defaultMode: "import-values", resolveValue },
    );
    expect(out.env).toBe("LOCKED=");
    expect(out.warnings.join()).toContain("LOCKED");
  });

  it("flags team-level references and appends generated vars without overriding user keys", async () => {
    const out = await buildDokployEnv(
      "app",
      [v("D"), v("NIXPACKS_BUILD_CMD", { valueRef: "ref_A" })],
      { defaultMode: "import-values", resolveValue },
      { NIXPACKS_BUILD_CMD: "npm run build", NIXPACKS_START_CMD: "npm start" },
    );
    expect(out.warnings.join()).toContain("team-level");
    expect(out.env).toContain("NIXPACKS_BUILD_CMD=1");
    expect(out.env).toContain("NIXPACKS_START_CMD='npm start'");
  });

  it("honours per-variable mode and prompt values", async () => {
    const out = await buildDokployEnv("app", [v("A"), v("B")], {
      defaultMode: "names-only",
      perVar: { "app:A": "import-values", "app:B": "prompt" },
      resolveValue: async (r) =>
        r === "typed" ? "typed-value" : (values[r] as string),
      promptRef: (_src, key) => (key === "B" ? "typed" : undefined),
    });
    expect(out.env).toBe("A=1\nB=typed-value");
  });
});
