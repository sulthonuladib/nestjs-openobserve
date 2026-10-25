/**
 * Executions and traces: the waterfall's data source.
 */
import { Elysia, t } from "elysia";
import type { Config } from "../../plugins/config";
import { configPlugin } from "../../plugins/config";
import type { Db } from "../../plugins/database";
import { databasePlugin } from "../../plugins/database";
import { ErrorModel, ExecutionModel, OperationModel, SpanModel } from "../../db/models";
import { Telemetry, window } from "../telemetry.service";

export const executionsModule = (deps: { config: Config; db: Db }) =>
  new Elysia({ name: "executions" })
    .use(configPlugin(deps.config))
    .use(databasePlugin(deps.db))
    .get(
      "/applications/:id/executions",
      ({ db, params, query }) =>
        Telemetry.executions(db, params.id, window(query.from, query.to), {
          limit: query.limit,
          operationRowId: query.operationRowId,
          kind: query.kind,
        }),
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({
          from: t.Optional(t.Numeric()),
          to: t.Optional(t.Numeric()),
          limit: t.Optional(t.Numeric()),
          operationRowId: t.Optional(t.String()),
          kind: t.Optional(t.Union([t.Literal("request"), t.Literal("job")])),
        }),
        response: {
          200: t.Object({
            items: t.Array(ExecutionModel.listItem),
            nextCursor: t.Union([t.String(), t.Null()]),
          }),
        },
        detail: { summary: "Executions in a window, keyset paginated" },
      },
    )
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
          200: t.Object({
            executions: t.Array(ExecutionModel.select),
            logs: t.Array(t.Any()),
          }),
          404: t.String(),
        },
        detail: {
          summary: "Every execution sharing a trace id (cross-service waterfall)",
        },
      },
    );
