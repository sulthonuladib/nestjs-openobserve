/**
 * Apply pending migrations without booting the server.
 *
 * Deliberately the *same* code path the server uses at boot
 * (`connectDatabase({ runMigrations: true })`) rather than a second migration
 * runner: a release job and a running collector must never disagree about what
 * "current schema" means. It needs no Postgres driver of its own — `Bun.SQL`
 * is built in — which is why this is not `drizzle-kit migrate`.
 *
 *   bun run db:migrate
 */
import { loadConfig } from "../src/server/plugins/config";
import { connectDatabase, MIGRATIONS_DIR } from "../src/server/plugins/database";

const config = loadConfig();
const connection = await connectDatabase({ url: config.databaseUrl, runMigrations: true });
await connection.close();

console.log(`migrations applied from ${MIGRATIONS_DIR}`);
