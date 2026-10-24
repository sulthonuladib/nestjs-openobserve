/**
 * Runtime configuration. Every value is an environment variable so a
 * container deployment is a `docker run` with a volume and a few `-e`s.
 *
 * Deliberately no config file: a self-hosted server that needs a file to boot
 * cannot be started with one command, and the docs promise one command.
 */

export interface Config {
  readonly host: string;
  /** Ingest listener. Internet-facing. */
  readonly ingestPort: number;
  /** Dashboard + query API. Usually private. */
  readonly apiPort: number;
  /** Collapse both listeners onto `apiPort`. */
  readonly singlePort: boolean;
  readonly dataDir: string;
  readonly databaseUrl: string | undefined;
  /** Accept batches with no `x-api-key`/`x-api-secret` at all. */
  readonly allowAnonymousIngest: boolean;
  readonly logLevel: "debug" | "info" | "warn" | "error";
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

function readVersion(): string {
  return process.env.OBSERVE_VERSION ?? "0.0.0-dev";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    host: env.OBSERVE_HOST ?? "0.0.0.0",
    ingestPort: int(env.OBSERVE_INGEST_PORT, 4319),
    apiPort: int(env.OBSERVE_API_PORT, 4320),
    singlePort: bool(env.OBSERVE_SINGLE_PORT, false),
    dataDir: env.OBSERVE_DATA_DIR ?? "./data",
    databaseUrl: env.OBSERVE_DATABASE_URL || undefined,
    // Default true: the SDK documents "a collector of your own still receives
    // the batches" without credentials, and requiring auth by default would
    // break the five-minute local trial. Deployments exposed to the internet
    // should set this to false.
    allowAnonymousIngest: bool(env.OBSERVE_ALLOW_ANONYMOUS_INGEST, true),
    logLevel: (env.OBSERVE_LOG_LEVEL as Config["logLevel"]) ?? "info",
    version: readVersion(),
  };
}
