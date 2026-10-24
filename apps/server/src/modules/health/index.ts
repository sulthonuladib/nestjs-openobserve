/**
 * Health and liveness.
 *
 * Deliberately reports the three versions separately (`PLAN.md` §9): the app,
 * the ingest API and the SDK range the ingest API implements. An operator
 * upgrading a fleet needs to know which of the three moved.
 */
import { Elysia, t } from "elysia";
import { sql } from "drizzle-orm";
import type { Config } from "../../plugins/config";
import { configPlugin } from "../../plugins/config";
import type { Db } from "../../plugins/database";
import { databasePlugin } from "../../plugins/database";
import { telemetryState } from "../../plugins/telemetry-state";
import { IngestModel } from "../ingest/model";

export const healthModule = (deps: { config: Config; db: Db }) =>
  new Elysia({ name: "health" })
    .use(configPlugin(deps.config))
    .use(databasePlugin(deps.db))
    .use(telemetryState)
    .get(
      "/health",
      async ({ db, config, store }) => {
        let database: "up" | "down" = "up";
        try {
          await db.execute(sql`SELECT 1`);
        } catch {
          database = "down";
        }
        return {
          ok: database === "up",
          version: config.version,
          ingestApi: "v1",
          sdk: ">=0.3.17 <0.4.0",
          database,
          stats: store.stats,
        };
      },
      {
        response: { 200: IngestModel.health },
        detail: { summary: "Liveness, versions and ingest counters" },
      },
    );
