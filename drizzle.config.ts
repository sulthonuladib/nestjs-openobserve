import { defineConfig } from "drizzle-kit";

/**
 * Migrations are generated from `src/db/schema.ts`, committed, and applied
 * forward-only by the server at boot:
 *
 *   bun run db:generate   # schema.ts -> ./drizzle
 *   bun run db:migrate    # apply against OBSERVE_DATABASE_URL
 *
 * There is no `db:push` in the release path. A self-hosted server must be able
 * to say exactly which schema version it is on, and an operator must be able to
 * read the diff before running it.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.OBSERVE_DATABASE_URL ?? "postgres://observe:observe@localhost:5432/observe",
  },
  strict: true,
  verbose: true,
});
