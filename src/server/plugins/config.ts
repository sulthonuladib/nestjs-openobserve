/**
 * Runtime configuration. Every value is an environment variable, so a container
 * deployment is a `docker run` with `-e`s — no config file, because a
 * self-hosted server that needs a file to boot cannot be started with the one
 * command the README promises.
 *
 * There is exactly **one** HTTP port. Ingest, the query API and the dashboard
 * are one origin: the agent's `endpoint` and the dashboard URL are the same
 * host, so there is no second port to explain, firewall or get wrong.
 */
import { Elysia } from "elysia";

export interface Config {
  readonly host: string;
  /** The only port: ingest, API, dashboard and SPA. */
  readonly port: number;
  readonly databaseUrl: string;
  readonly databasePoolSize: number;
  /** Migrate at boot. Disable when a release job runs migrations. */
  readonly runMigrations: boolean;
  /** Accept batches with no `x-api-key`/`x-api-secret` at all. */
  readonly allowAnonymousIngest: boolean;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  /** Public origin: invite links, the CLI-link verification URI, webhooks. */
  readonly publicUrl: string;
  /**
   * How often the in-process alert evaluator runs. `0` disables it — the manual
   * `POST /alerts/evaluate` still works, which is what the test suite uses and
   * what an operator runs after a deploy.
   */
  readonly alertsIntervalMs: number;
  readonly version: string;
}

function int(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const port = int(env.OBSERVE_PORT, 4320);
  return {
    host: env.OBSERVE_HOST ?? "0.0.0.0",
    port,
    databaseUrl:
      env.OBSERVE_DATABASE_URL ?? "postgres://observe:observe@localhost:5432/observe",
    databasePoolSize: int(env.OBSERVE_DATABASE_POOL, 20),
    runMigrations: bool(env.OBSERVE_RUN_MIGRATIONS, true),
    // Default true, matching the SDK: "a collector of your own still receives
    // the batches" with no credentials configured. A deployment exposed to the
    // internet sets this to false.
    allowAnonymousIngest: bool(env.OBSERVE_ALLOW_ANONYMOUS_INGEST, true),
    logLevel: (env.OBSERVE_LOG_LEVEL as Config["logLevel"]) ?? "info",
    publicUrl: env.OBSERVE_PUBLIC_URL ?? `http://localhost:${port}`,
    // One minute: the finest window a rule can have is five minutes, so a
    // tighter loop would only re-measure the same data.
    alertsIntervalMs: env.OBSERVE_ALERTS === "off" ? 0 : int(env.OBSERVE_ALERTS_INTERVAL_MS, 60_000),
    version: env.OBSERVE_VERSION ?? "0.0.0-dev",
  };
}

/** Elysia plugin: makes `config` available to every handler and module. */
export const configPlugin = (config: Config) =>
  new Elysia({ name: "config" }).decorate("config", config);
