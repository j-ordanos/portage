import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Every file under `dir`, skipping tests. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/**
 * The production image installs only `dependencies`. A package that runtime code imports but that is listed under
 * `devDependencies` works on a developer machine and crashes in the container (this happened once with `dotenv`).
 */
describe("runtime imports are real dependencies", () => {
  for (const pkg of ["packages/core", "apps/server"]) {
    it(pkg, () => {
      const root = join(__dirname, "../../..", pkg);
      const manifest = JSON.parse(
        readFileSync(join(root, "package.json"), "utf8"),
      ) as { name: string; dependencies?: Record<string, string> };
      const declared = new Set(Object.keys(manifest.dependencies ?? {}));
      const used = new Set<string>();
      for (const file of sources(join(root, "src"))) {
        for (const match of readFileSync(file, "utf8").matchAll(
          /(?:from|import\()\s*"([^."][^"]*)"/g,
        )) {
          const spec = match[1] as string;
          if (spec.startsWith("node:")) continue;
          used.add(
            spec.startsWith("@")
              ? spec.split("/").slice(0, 2).join("/")
              : (spec.split("/")[0] as string),
          );
        }
      }
      expect([...used].filter((name) => !declared.has(name))).toEqual([]);
    });
  }
});
