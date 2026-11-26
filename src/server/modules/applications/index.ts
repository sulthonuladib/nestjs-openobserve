/**
 * Applications controller.
 *
 * One Elysia instance per feature; each file owns its routes, its models live in
 * `model.ts`, and the queries live in `telemetry.service.ts` so they can be
 * reused by cron jobs and MCP tools.
 *
 * Two routes here: the **list** (the switcher and the applications page) and one
 * application's own header row. Everything else about an application is
 * project-scoped telemetry — `/telemetry/operations?applicationId=…` — because
 * "all applications" is a value the selector can hold and a path segment cannot.
 */
import { Elysia, t } from "elysia";
import type { Config } from "../../plugins/config";
import { configPlugin } from "../../plugins/config";
import type { Db } from "../../plugins/database";
import { databasePlugin } from "../../plugins/database";
import { ApplicationModel } from "../../db/models";
import { Telemetry, window } from "../telemetry.service";

export const applicationsModule = (deps: { config: Config; db: Db }) =>
  new Elysia({ name: "applications", prefix: "/applications" })
    .use(configPlugin(deps.config))
    .use(databasePlugin(deps.db))
    .get(
      "/",
      ({ db, query }) => Telemetry.applications(db, window(query.from, query.to)),
      {
        query: t.Object({ from: t.Optional(t.Numeric()), to: t.Optional(t.Numeric()) }),
        response: { 200: t.Array(ApplicationModel.summary) },
        detail: { summary: "List applications with window aggregates" },
      },
    );
