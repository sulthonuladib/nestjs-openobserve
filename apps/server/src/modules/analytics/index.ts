/**
 * Analytics controller: the endpoints the missing pages need.
 *
 * Everything here is a read over data the ingest path already stores. Paths stay
 * under `/applications/:id/…` so one application's telemetry is one prefix, and
 * a per-operation view hangs off the same shape.
 */
import { Elysia, t } from "elysia";
import type { Config } from "../../plugins/config";
import { configPlugin } from "../../plugins/config";
import type { Db } from "../../plugins/database";
import { databasePlugin } from "../../plugins/database";
import { authGuard } from "../../plugins/auth";
import {
  applicationById,
  jobs,
  metricPoints,
  metrics,
  operationDetail,
  releases,
  runtime,
  timeseries,
  users,
} from "../analytics.service";
import { window } from "../telemetry.service";

const requireUser = { requireUser: true } as const;
const Range = t.Object({
  from: t.Optional(t.Numeric()),
  to: t.Optional(t.Numeric()),
});
const IdParams = t.Object({ id: t.String() });

export const analyticsModule = (deps: { config: Config; db: Db }) =>
  new Elysia({ name: "analytics" })
    .use(configPlugin(deps.config))
    .use(databasePlugin(deps.db))
    .use(authGuard(deps))

    /** One application's own row — the header the other pages render. */
    .get(
      "/applications/:id",
      async ({ db, params, status }) => {
        const app = await applicationById(db, params.id);
        return app ?? status(404, "application not found");
      },
      { ...requireUser, params: IdParams },
    )

    /**
     * The chart series behind every card: requests, errors, client errors, avg
     * and merged p50/p95/p99.
     */
    .get(
      "/applications/:id/timeseries",
      async ({ db, params, query }) => {
        const range = window(query.from, query.to);
        const bucket = query.bucketMs ? Number(query.bucketMs) : undefined;
        const result = await timeseries(db, params.id, range, bucket);
        const totals = result.points.reduce(
          (acc, point) => ({
            requests: acc.requests + point.requests,
            errors: acc.errors + point.errors,
          }),
          { requests: 0, errors: 0 },
        );
        return {
          ...result,
          range,
          summary: {
            requests: totals.requests,
            errors: totals.errors,
            errorRate: totals.requests > 0 ? totals.errors / totals.requests : 0,
          },
        };
      },
      {
        ...requireUser,
        params: IdParams,
        query: t.Composite([Range, t.Object({ bucketMs: t.Optional(t.Numeric()) })]),
        detail: {
          summary: "Time-series for the dashboard cards",
          description:
            "Percentiles are merged from the per-minute histograms, so a p95 over " +
            "an hour is a real p95 and not an average of p95s.",
        },
      },
    )

    .get(
      "/applications/:id/jobs",
      async ({ db, params, query }) =>
        jobs(db, params.id, window(query.from, query.to)),
      {
        ...requireUser,
        params: IdParams,
        query: Range,
        detail: {
          summary: "Queue and cron jobs, grouped by queue + job name",
          description:
            "Includes p95 queue wait: a job that waited four minutes and ran in " +
            "10ms is invisible on duration alone.",
        },
      },
    )

    .get(
      "/applications/:id/metrics",
      async ({ db, params }) => metrics(db, params.id),
      {
        ...requireUser,
        params: IdParams,
        detail: { summary: "Custom metric series, newest first" },
      },
    )

    .get(
      "/applications/:id/metrics/:name",
      async ({ db, params, query }) =>
        metricPoints(db, params.id, decodeURIComponent(params.name), window(query.from, query.to)),
      {
        ...requireUser,
        params: t.Object({ id: t.String(), name: t.String() }),
        query: Range,
        detail: { summary: "Points for one custom metric series" },
      },
    )

    .get(
      "/applications/:id/runtime",
      async ({ db, params, query }) =>
        runtime(db, params.id, window(query.from, query.to)),
      {
        ...requireUser,
        params: IdParams,
        query: Range,
        detail: {
          summary: "Runtime samples (CPU, memory, event loop, GC)",
          description:
            "The keyboard shortcut name is profiler upstream, but the SDK's own " +
            "profiler is shelved: these are the runtime metrics a heartbeat, not a " +
            "CPU flamegraph.",
        },
      },
    )

    .get(
      "/applications/:id/releases",
      async ({ db, params, query }) =>
        releases(db, params.id, window(query.from, query.to)),
      {
        ...requireUser,
        params: IdParams,
        query: Range,
        detail: {
          summary: "Releases with a regression verdict against the previous one",
          description:
            "A regression is error rate up by more than one point, or p95 up by " +
            "more than 20%, against the previous release on the same window.",
        },
      },
    )

    .get(
      "/applications/:id/users",
      async ({ db, params, query }) => users(db, params.id, window(query.from, query.to)),
      {
        ...requireUser,
        params: IdParams,
        query: Range,
        detail: {
          summary: "Per-user activity, from `http.getUserId` on the agent",
        },
      },
    )

    .get(
      "/applications/:id/operations/:operationRowId",
      async ({ db, params, query, status }) => {
        const detail = await operationDetail(
          db,
          params.id,
          params.operationRowId,
          window(query.from, query.to),
        );
        return detail ?? status(404, "operation not found");
      },
      {
        ...requireUser,
        params: t.Object({ id: t.String(), operationRowId: t.String() }),
        query: Range,
        detail: {
          summary: "One operation: its series, slowest instances and error groups",
        },
      },
    );
