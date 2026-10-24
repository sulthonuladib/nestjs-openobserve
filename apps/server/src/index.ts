/**
 * Entry point.
 *
 *   :4319  ingest   — internet-facing, gzip in, no sessions, no CORS
 *   :4320  api + UI — private by default
 *
 * `OBSERVE_SINGLE_PORT=1` collapses them onto the API port for a homelab
 * deployment behind one reverse proxy.
 */
import { createApiApp, createIngestApp, type Deps } from "./app";
import { loadConfig } from "./plugins/config";
import { connectDatabase } from "./plugins/database";

const MAX_BATCH_BYTES = 32 * 1024 * 1024; // the wire allows 5000 entries/section

const config = loadConfig();
const connection = await connectDatabase({
  url: config.databaseUrl,
  runMigrations: config.runMigrations,
  maxConnections: config.databasePoolSize,
});

const deps: Deps = { config, db: connection.db };

const listeners: Array<{ stop(): void }> = [];

if (config.singlePort) {
  const app = createApiApp(deps);
  app.listen({
    hostname: config.host,
    port: config.apiPort,
    maxRequestBodySize: MAX_BATCH_BYTES,
  });
  listeners.push(app);
  console.log(`nestjs-observe ${config.version} on http://${config.host}:${config.apiPort}`);
} else {
  const ingest = createIngestApp(deps);
  ingest.listen({
    hostname: config.host,
    port: config.ingestPort,
    maxRequestBodySize: MAX_BATCH_BYTES,
  });
  listeners.push(ingest);

  const api = createApiApp(deps);
  api.listen({
    hostname: config.host,
    port: config.apiPort,
    maxRequestBodySize: 1024 * 1024,
  });
  listeners.push(api);

  console.log(
    `nestjs-observe ${config.version}\n` +
      `  ingest    http://${config.host}:${config.ingestPort}   <- set OBSERVE_ENDPOINT to this\n` +
      `  dashboard http://${config.host}:${config.apiPort}`,
  );
}

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  console.log(`\n${signal} — shutting down`);
  for (const listener of listeners) listener.stop();
  await connection.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
