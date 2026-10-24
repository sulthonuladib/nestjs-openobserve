/**
 * Errors: the inbox and the detail view.
 *
 * Grouping happens at ingest (see `ingest/fingerprint.ts`), so this module is
 * only a read path plus the one workflow that matters — resolving and ignoring.
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
      "/applications/:id/errors",
      async ({ db, params, query }) => ({
        items: await Telemetry.errors(db, params.id, {
          status: query.status,
          limit: query.limit,
        }),
      }),
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({
          status: t.Optional(
            t.Union([t.Literal("open"), t.Literal("resolved"), t.Literal("ignored")]),
          ),
          limit: t.Optional(t.Numeric()),
        }),
        response: { 200: t.Object({ items: t.Array(ErrorModel.group) }) },
        detail: { summary: "Error groups, newest first" },
      },
    )
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
