/**
 * Executions and traces: the waterfall's data source.
 *
 * Two entity routes, both addressed by an id that *is* the scope:
 *
 *   `/executions/:id`  one execution with its span tree
 *   `/traces/:traceId`  every execution that carried the id, across services
 *
 * The executions *list* is project-scoped (`/telemetry/executions`) because it
 * also has to answer for every application at once.
 */
import { Elysia, t } from "elysia";
import type { Config } from "../../plugins/config";
import { configPlugin } from "../../plugins/config";
import type { Db } from "../../plugins/database";
import { databasePlugin } from "../../plugins/database";
import { ErrorModel, ExecutionModel, OperationModel, SpanModel, TraceModel } from "../../db/models";
import { Telemetry } from "../telemetry.service";

export const executionsModule = (deps: { config: Config; db: Db }) =>
  new Elysia({ name: "executions" })
    .use(configPlugin(deps.config))
    .use(databasePlugin(deps.db))
    .get(
      "/executions/:id",
      async ({ db, params, status }) => {
        const detail = await Telemetry.executionDetail(db, params.id);
        if (!detail) return status(404, "execution not found");
        return detail;
      },
      {
        params: t.Object({ id: t.String() }),
        response: {
          200: t.Object({
            execution: ExecutionModel.select,
            operation: t.Union([OperationModel.select, t.Null()]),
            spans: t.Array(SpanModel.select),
            logs: t.Array(t.Any()),
            error: t.Union([ErrorModel.group, t.Null()]),
          }),
          404: t.String(),
        },
        detail: {
          summary: "One execution with its span tree, correlated logs and error",
        },
      },
    )
    .get(
      "/traces/:traceId",
      async ({ db, params, status }) => {
        const trace = await Telemetry.trace(db, params.traceId);
        if (!trace) return status(404, "trace not found");
        return trace;
      },
      {
        params: t.Object({ traceId: t.String() }),
        response: {
          200: TraceModel.response,
          404: t.String(),
        },
        detail: {
          summary: "Every execution sharing a trace id (cross-service trace)",
          description:
            "One id, every hop that carried it, in causal order, each with its " +
            "application, handler and span tree — plus the logs correlated by the " +
            "same id. Jobs appear where they inherited the id, labelled by kind: a " +
            "trace is the only place request and job telemetry are allowed to meet.",
        },
      },
    );
