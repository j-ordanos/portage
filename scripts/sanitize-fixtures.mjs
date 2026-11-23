import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../lab/fixtures/", import.meta.url).pathname;
const secretKey =
  /(token|api[-_]?key|password|secret|private[-_]?key|authorization)/i;
const uuid = /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi;
const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const result = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.name.endsWith(".json")) result.push(path);
  }
  return result;
}

for (const path of await files(root)) {
  const input = JSON.parse(await readFile(path, "utf8"));
  const sanitize = (value, key = "") => {
    if (typeof value === "string") {
      if (secretKey.test(key)) return "[REDACTED]";
      return value
        .replace(uuid, "00000000-0000-0000-0000-000000000001")
        .replace(ipv4, "192.0.2.1")
        .replace(email, "fixture@example.invalid");
    }
    if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => [
          childKey,
          sanitize(childValue, childKey),
        ]),
      );
    }
    return value;
  };
  const output = sanitize(input);
  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`);
}
