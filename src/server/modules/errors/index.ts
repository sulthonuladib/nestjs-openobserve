/**
 * Errors: the detail view and the one workflow that matters.
 *
 * Grouping happens at ingest (see `ingest/fingerprint.ts`). The *list* is
 * project-scoped and lives at `/telemetry/errors` — it has to answer "all
 * applications" as well as one — so this module keeps only the entity paths,
 * where the id is the whole scope.
 */
import { Elysia, t } from "elysia";
import { eq } from "drizzle-orm";
import type { Config } from "../../plugins/config";
import { configPlugin } from "../../plugins/config";
import type { Db } from "../../plugins/database";
import { databasePlugin } from "../../plugins/database";
import { errorGroup } from "../../db/schema";
import { ErrorModel } from "../../db/models";
import { Telemetry } from "../telemetry.service";

export const errorsModule = (deps: { config: Config; db: Db }) =>
  new Elysia({ name: "errors" })
    .use(configPlugin(deps.config))
    .use(databasePlugin(deps.db))
    .get(
      "/errors/:id",
      async ({ db, params, status }) => {
        const detail = await Telemetry.errorDetail(db, params.id);
        if (!detail) return status(404, "error group not found");
        return detail;
      },
      {
        params: t.Object({ id: t.String() }),
        response: {
          200: t.Object({
            group: ErrorModel.group,
            occurrences: t.Array(ErrorModel.occurrence),
          }),
          404: t.String(),
        },
        detail: { summary: "One error group with recent occurrences" },
      },
    )
    .patch(
      "/errors/:id",
      async ({ db, params, body }) => {
        await db
          .update(errorGroup)
          .set({ status: body.status })
          .where(eq(errorGroup.id, params.id));
        return { ok: true };
      },
      {
        params: t.Object({ id: t.String() }),
        body: ErrorModel.statusBody,
        detail: { summary: "Resolve, ignore or reopen an error group" },
      },
    );
