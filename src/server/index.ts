/**
 * Entry point.
 *
 * One process, one port:
 *
 *   POST /applications/telemetry   the SDK's ingest, same host as the dashboard
 *   /api/v1/*                      the query API
 *   /                              the built dashboard SPA
 *
 * That is deliberate. A split ingest/dashboard listener made the one thing an
 * operator has to configure — "what URL do I put in OBSERVE_ENDPOINT?" — into two
 * things, and every deployment ended up with a firewall rule on the wrong port.
 * One origin also means the device-code link, the invite links and webhooks are
 * all built from `OBSERVE_PUBLIC_URL` and nothing else.
 */
import { createApiApp, type Deps } from "./app";
import { runAdminCli } from "./cli";
import { bootstrapAdmin } from "./modules/auth/service";
import { loadConfig } from "./plugins/config";
import { connectDatabase } from "./plugins/database";
import { Ingest } from "./modules/ingest/service";
import { evaluateRules, seedDefaultRules } from "./modules/alerts/service";

/** The wire allows 5000 entries per section; a batch can be tens of megabytes. */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

// `nestjs-openobserve admin …` is the same binary with a different argv: no
// second artifact to ship, and the operator's muscle memory works on any host.
if (process.argv[2] === "admin") {
  process.exit(await runAdminCli(process.argv.slice(3)));
}

const config = loadConfig();
const connection = await connectDatabase({
  url: config.databaseUrl,
  runMigrations: config.runMigrations,
  maxConnections: config.databasePoolSize,
});

// IaC path: create (or rotate) the instance admin from the environment so
// /setup never appears in a container deployment.
await bootstrapAdmin(connection.db, config);

// Two rules a fresh install always ends up writing (error rate, and a queue that
// stopped being consumed). Inert until there is traffic: a metric with no data
// never fires, so seeding them cannot page anyone on day one. Idempotent — it
// only writes when the rules table is empty.
await seedDefaultRules(connection.db, await Ingest.ensureDefaultProject(connection.db));

const deps: Deps = { config, db: connection.db };
const app = await createApiApp(deps);

app.listen({
  hostname: config.host,
  port: config.port,
  maxRequestBodySize: MAX_REQUEST_BYTES,
});

console.log(`nestjs-openobserve ${config.version} on http://${config.host}:${config.port}`);
console.log(`  dashboard  ${config.publicUrl}`);
console.log(`  ingest     OBSERVE_ENDPOINT=${config.publicUrl.replace(/\/$/, "")}`);

/**
 * The alert evaluator's clock.
 *
 * Alerts are the one feature that cannot be computed on read: something has to
 * notice at 03:00. This interval is it, and `POST /api/v1/alerts/evaluate` runs
 * the same function for a human who wants a check now.
 *
 * The handle is kept on `globalThis` because `bun --hot` re-evaluates this module
 * on every save while the process lives: without clearing the previous timer,
 * each edit would stack another evaluator — the same leak the database pool had.
 * `unref()` keeps the timer from holding the process open on its own.
 */
const ALERT_TIMER = Symbol.for("nestjs-openobserve.alerts.timer");
type Timer = ReturnType<typeof setInterval>;
const timers = globalThis as { [ALERT_TIMER]?: Timer };

if (timers[ALERT_TIMER]) clearInterval(timers[ALERT_TIMER]);
if (config.alertsIntervalMs > 0) {
  const timer = setInterval(() => {
    void evaluateRules(connection.db).catch((error) => {
      console.error("alerts: evaluation failed", error);
    });
  }, config.alertsIntervalMs);
  timer.unref?.();
  timers[ALERT_TIMER] = timer;
  console.log(`  alerts     every ${Math.round(config.alertsIntervalMs / 1000)}s`);
} else {
  delete timers[ALERT_TIMER];
  console.log("  alerts     evaluator off (OBSERVE_ALERTS=off) — POST /api/v1/alerts/evaluate still works");
}

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  console.log(`\n${signal} — shutting down`);
  if (timers[ALERT_TIMER]) clearInterval(timers[ALERT_TIMER]);
  app.stop();
  await connection.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
