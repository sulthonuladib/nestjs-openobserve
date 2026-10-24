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
import { join } from "node:path";
import * as schema from "../db/schema";

/**
 * Where the generated SQL lives. Overridable because the container copies it to
 * `/app/drizzle` while the bundle runs from `/app/server` — the fallback is the
 * repo layout, `apps/server/drizzle`.
 */
export const MIGRATIONS_DIR =
  process.env.OBSERVE_MIGRATIONS_DIR ?? join(import.meta.dir, "..", "..", "drizzle");

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

export async function connectDatabase(options: DatabaseOptions): Promise<Connection> {
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

  return { db, sql, close: async () => sql.close() };
}

/**
 * Elysia plugin. Named, so Elysia deduplicates it: a module that needs the
 * database imports this and gets the same decoration, not a second pool.
 */
export const databasePlugin = (db: Db) =>
  new Elysia({ name: "db" }).decorate("db", db);

export { schema };
