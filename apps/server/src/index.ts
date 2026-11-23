import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";

export { createApp, VERSION } from "./app.js";

dotenv.config({ path: new URL("../../../.env", import.meta.url), quiet: true });

if (process.env.NODE_ENV !== "test") {
  let config: ReturnType<typeof readConfig>;
  try {
    config = readConfig();
  } catch (error) {
    // never print values: readConfig only names what is wrong
    process.stderr.write(
      `${error instanceof Error ? error.message : "Invalid configuration"}\n`,
    );
    process.exit(1);
  }
  const app = createApp({ config, pauseBetweenWritesMs: 100 });
  const purge = () => app.store.purgeExpired();
  purge();
  setInterval(purge, 60 * 60 * 1000).unref();
  const resumed = app.manager.resumeInterrupted();
  if (resumed > 0)
    process.stdout.write(`Resumed ${resumed} interrupted migration(s)\n`);
  serve({ fetch: app.fetch, port: config.PORT });
  process.stdout.write(`Portage listening on :${config.PORT}\n`);
  if (config.MASTER_KEY_SOURCE === "file") {
    process.stdout.write(
      `Saved tokens are sealed with a key stored in ${config.DATA_DIR}/master.key. For stronger protection set MASTER_KEY (openssl rand -base64 32) so the key lives apart from the data.\n`,
    );
  }
}
