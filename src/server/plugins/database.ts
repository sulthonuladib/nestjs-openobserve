/**
 * Database plugin.
 *
 * Postgres is the only supported store: this workload is append-heavy time
 * series that must be aggregated over arbitrary windows, and the operator
 * already has a Postgres. There is no embedded fallback — owning a second
 * engine, its backup story and its single-writer ceiling buys nothing here.
 *
 * `drizzle-orm/bun-sql` talks to `Bun.SQL`, so there is no `pg` dependency and
 * one fewer thing in the image.
 */
import { Elysia } from "elysia";
import { SQL } from "bun";
import { drizzle, type BunSQLDatabase } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import * as schema from "../db/schema";

/**
 * Where the generated SQL lives.
 *
 * `OBSERVE_MIGRATIONS_DIR` first (the container and the tarball set it), then the
 * directory next to the executable — which is where a `bun build --compile`
 * release puts `drizzle/` — then the repo layout used by `bun dev`.
 */
function resolveMigrationsDir(): string {
  if (process.env.OBSERVE_MIGRATIONS_DIR) return process.env.OBSERVE_MIGRATIONS_DIR;
  const candidates = [
    join(dirname(process.execPath), "drizzle"),
    join(import.meta.dir, "..", "..", "..", "drizzle"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[1]!;
}

export const MIGRATIONS_DIR = resolveMigrationsDir();

export type Db = BunSQLDatabase<typeof schema>;
/** The handle a helper may take: the pool, or a transaction on it. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export interface Connection {
  readonly db: Db;
  readonly sql: SQL;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  readonly url: string;
  readonly runMigrations: boolean;
  readonly maxConnections?: number;
}

/**
 * One pool per URL per process, reused across `bun --hot` reloads.
 *
 * `bun dev` runs `bun --hot`, which re-evaluates this module on every file save
 * but keeps the process alive. Without this cache each reload opened a *new*
 * 20-connection pool and left the previous one open — after a couple of hours of
 * editing, Postgres answered `sorry, too many clients already` and the dashboard
 * went dark for no reason the operator could see. Keyed on the URL and pool size
 * so a config change (or a test pointing at another database) still gets its own.
 *
 * `globalThis`, not a module variable: the module is exactly what gets replaced.
 */
const POOLS = Symbol.for("nestjs-openobserve.database.pools");

type PoolCache = Map<string, Connection>;

function poolCache(): PoolCache {
  const holder = globalThis as { [POOLS]?: PoolCache };
  holder[POOLS] ??= new Map();
  return holder[POOLS];
}

export async function connectDatabase(options: DatabaseOptions): Promise<Connection> {
  const key = `${options.url}|${options.maxConnections ?? 20}`;
  const cached = poolCache().get(key);
  // Migrations are a boot step, not a per-reload step: the schema is already
  // there on the second load, and re-running them would serialize every reload
  // behind the migrator's advisory lock.
  if (cached) return cached;

  const sql = new SQL({
    url: options.url,
    max: options.maxConnections ?? 20,
    // Fail fast on a wedged connection instead of queueing ingest behind it.
    idleTimeout: 30,
    connectionTimeout: 10,
  });

  const db = drizzle(sql, { schema });
  if (options.runMigrations) {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  }

  const connection: Connection = {
    db,
    sql,
    close: async () => {
      // Dropping the cache entry matters as much as closing the sockets: a
      // closed pool that stays cached is a pool every later request fails on.
      if (poolCache().get(key) === connection) poolCache().delete(key);
      await sql.close();
    },
  };
  poolCache().set(key, connection);
  return connection;
}

/**
 * Elysia plugin. Named, so Elysia deduplicates it: a module that needs the
 * database imports this and gets the same decoration, not a second pool.
 */
export const databasePlugin = (db: Db) =>
  new Elysia({ name: "db" }).decorate("db", db);

export { schema };
