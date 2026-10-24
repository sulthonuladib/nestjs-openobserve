/**
 * Runtime configuration. Every value is an environment variable, so a container
 * deployment is a `docker run` with `-e`s — no config file, because a
 * self-hosted server that needs a file to boot cannot be started with the one
 * command the README promises.
 */
import { Elysia } from "elysia";

export interface Config {
  readonly host: string;
  /** Ingest listener. Internet-facing. */
  readonly ingestPort: number;
  /** Dashboard + query API. Usually private. */
  readonly apiPort: number;
  /** Collapse both listeners onto `apiPort`. */
  readonly singlePort: boolean;
  readonly databaseUrl: string;
  readonly databasePoolSize: number;
  /** Migrate at boot. Disable when a release job runs migrations. */
  readonly runMigrations: boolean;
  /** Accept batches with no `x-api-key`/`x-api-secret` at all. */
  readonly allowAnonymousIngest: boolean;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  /** Public origin, used for the `/cli-link` verification URI. */
  readonly publicUrl: string;
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
  const apiPort = int(env.OBSERVE_API_PORT, 4320);
  return {
    host: env.OBSERVE_HOST ?? "0.0.0.0",
    ingestPort: int(env.OBSERVE_INGEST_PORT, 4319),
    apiPort,
    singlePort: bool(env.OBSERVE_SINGLE_PORT, false),
    databaseUrl:
      env.OBSERVE_DATABASE_URL ??
      "postgres://observe:observe@localhost:5432/observe",
    databasePoolSize: int(env.OBSERVE_DATABASE_POOL, 20),
    runMigrations: bool(env.OBSERVE_RUN_MIGRATIONS, true),
    // Default true, matching the SDK: "a collector of your own still receives
    // the batches" with no credentials configured. A deployment exposed to the
    // internet sets this to false.
    allowAnonymousIngest: bool(env.OBSERVE_ALLOW_ANONYMOUS_INGEST, true),
    logLevel: (env.OBSERVE_LOG_LEVEL as Config["logLevel"]) ?? "info",
    publicUrl: env.OBSERVE_PUBLIC_URL ?? `http://localhost:${apiPort}`,
    version: env.OBSERVE_VERSION ?? "0.0.0-dev",
  };
}

/** Elysia plugin: makes `config` available to every handler and module. */
export const configPlugin = (config: Config) =>
  new Elysia({ name: "config" }).decorate("config", config);
