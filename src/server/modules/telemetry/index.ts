/**
 * Telemetry reads, scoped to the **project** with an optional application filter.
 *
 * This family exists because the dashboard's application selector has a value
 * that means "no filter" — "All applications" — and the application-addressed
 * routes (`/applications/:id/jobs`) cannot express it: the path made one
 * application mandatory, so every page except the overview had to refuse to
 * render until you picked one. The hosted product answers the same question the
 * same way (`/telemetry/jobs?applicationId=…`, the parameter optional), and so
 * does this: `?applicationId=` narrows, leaving it out aggregates.
 *
 * When a scope is omitted, **every row names its application**. That is not
 * decoration: in a project-wide list two handlers called `POST /orders` from two
 * services are two different things, and a merged log stream without the column
 * is noise.
 *
 * Single entities keep their path routes — `/executions/:id`, `/errors/:id`,
 * `/traces/:traceId`, `/applications/:id/job` — because an id *is* a scope.
 */
import { Elysia, t } from "elysia";
import type { Config } from "../../plugins/config";
import { configPlugin } from "../../plugins/config";
import type { Db } from "../../plugins/database";
import { databasePlugin } from "../../plugins/database";
import { authGuard } from "../../plugins/auth";
import {
  ErrorModel,
  ExecutionModel,
  JobModel,
  LogModel,
  OperationModel,
} from "../../db/models";
import { Telemetry, window } from "../telemetry.service";
import { serviceMap, services, spanAnalytics } from "../spans.service";
import {
  jobs,
  metricPoints,
  metrics,
  releases,
  retentionDays,
  runtime,
  slos,
  timeseries,
  users,
} from "../analytics.service";

const requireUser = { requireUser: true } as const;

/** The window every list accepts; absent means "the last hour". */
const Range = t.Object({
  from: t.Optional(t.Numeric()),
  to: t.Optional(t.Numeric()),
});

/**
 * The scope. `applicationId` is a single id today (the switcher is single-select,
 * like the hosted product's); a comma list would be a guess at a UI that does not
 * exist yet.
 */
const Scope = t.Object({
  applicationId: t.Optional(t.String({ maxLength: 64 })),
});

const Kind = t.Optional(t.Union([t.Literal("request"), t.Literal("job")]));

const scopeOf = (applicationId: string | undefined) =>
  applicationId && applicationId.length > 0 ? applicationId : undefined;

export const telemetryModule = (deps: { config: Config; db: Db }) =>
  new Elysia({ name: "telemetry", prefix: "/telemetry" })
    .use(configPlugin(deps.config))
    .use(databasePlugin(deps.db))
    .use(authGuard(deps))

    /**
     * The chart series behind every card, for the scope.
     *
     * `kind` defaults to `request`: a job is not a request, and only the job
     * pages ask for `kind=job`.
     */
    .get(
      "/timeseries",
      async ({ db, query }) => {
        const range = window(query.from, query.to);
        const kind = query.kind ?? "request";
        const result = await timeseries(db, range, {
          applicationId: scopeOf(query.applicationId),
          bucketMs: query.bucketMs ? Number(query.bucketMs) : undefined,
          kind,
          operationRowId: query.operationRowId,
        });
        const totals = result.points.reduce(
          (acc, point) => ({
            requests: acc.requests + point.requests,
            errors: acc.errors + point.errors,
            clientErrors: acc.clientErrors + point.clientErrors,
          }),
          { requests: 0, errors: 0, clientErrors: 0 },
        );
        return {
          ...result,
          kind,
          range,
          applicationId: scopeOf(query.applicationId) ?? null,
          summary: {
            requests: totals.requests,
            errors: totals.errors,
            clientErrors: totals.clientErrors,
            errorRate: totals.requests > 0 ? totals.errors / totals.requests : 0,
          },
        };
      },
      {
        ...requireUser,
        query: t.Composite([
          Range,
          Scope,
          t.Object({
            bucketMs: t.Optional(t.Numeric()),
            kind: Kind,
            operationRowId: t.Optional(t.String()),
          }),
        ]),
        detail: {
          summary: "Time-series for the dashboard cards, for one application or all",
          description:
            "Percentiles are merged from the per-minute histograms, so a p95 over " +
            "an hour is a real p95 and not an average of p95s. Omitting " +
            "`applicationId` sums every application in the project.",
        },
      },
    )

    .get(
      "/operations",
      ({ db, query }) =>
        Telemetry.operations(db, window(query.from, query.to), {
          applicationId: scopeOf(query.applicationId),
          limit: query.limit,
          kind: query.kind,
        }),
      {
        ...requireUser,
        query: t.Composite([
          Range,
          Scope,
          t.Object({ limit: t.Optional(t.Numeric()), kind: Kind }),
        ]),
        response: { 200: t.Array(OperationModel.ranked) },
        detail: {
          summary: "Operations ranked by volume, across applications or for one",
        },
      },
    )

    .get(
      "/executions",
      ({ db, query }) =>
        Telemetry.executions(db, window(query.from, query.to), {
          applicationId: scopeOf(query.applicationId),
          limit: query.limit,
          operationRowId: query.operationRowId,
          kind: query.kind,
        }),
      {
        ...requireUser,
        query: t.Composite([
          Range,
          Scope,
          t.Object({
            limit: t.Optional(t.Numeric()),
            operationRowId: t.Optional(t.String()),
            kind: Kind,
          }),
        ]),
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
      "/errors",
      ({ db, query }) =>
        Telemetry.errors(db, {
          applicationId: scopeOf(query.applicationId),
          status: query.status,
          limit: query.limit,
        }),
      {
        ...requireUser,
        query: t.Composite([
          Scope,
          t.Object({
            status: t.Optional(
              t.Union([t.Literal("open"), t.Literal("resolved"), t.Literal("ignored")]),
            ),
            limit: t.Optional(t.Numeric()),
          }),
        ]),
        response: { 200: t.Array(ErrorModel.list) },
        detail: {
          summary: "Error groups, newest first, across applications or for one",
        },
      },
    )

    .get(
      "/logs",
      ({ db, query }) =>
        Telemetry.logs(db, window(query.from, query.to), {
          applicationId: scopeOf(query.applicationId),
          level: query.level,
          traceId: query.traceId,
          limit: query.limit,
        }),
      {
        ...requireUser,
        query: t.Composite([
          Range,
          Scope,
          t.Object({
            level: t.Optional(
              t.Union([
                t.Literal("fatal"),
                t.Literal("error"),
                t.Literal("warn"),
                t.Literal("log"),
                t.Literal("debug"),
                t.Literal("verbose"),
              ]),
            ),
            traceId: t.Optional(t.String()),
            limit: t.Optional(t.Numeric()),
          }),
        ]),
        response: { 200: t.Array(LogModel.list) },
        detail: { summary: "Log lines, newest first, with the application that wrote them" },
      },
    )

    .get(
      "/jobs",
      ({ db, query }) =>
        jobs(db, window(query.from, query.to), scopeOf(query.applicationId)),
      {
        ...requireUser,
        query: t.Composite([Range, Scope]),
        response: { 200: t.Array(JobModel.row) },
        detail: {
          summary: "Queue and cron jobs grouped by application + queue + job name",
          description:
            "Includes p95 queue wait: a job that waited four minutes and ran in " +
            "10ms is invisible on duration alone. Grouped by application too — two " +
            "services can run a queue with the same name.",
        },
      },
    )

    .get(
      "/spans",
      ({ db, query }) =>
        spanAnalytics(db, window(query.from, query.to), {
          applicationId: scopeOf(query.applicationId),
          mode: query.mode,
          limit: query.limit,
        }),
      {
        ...requireUser,
        query: t.Composite([
          Range,
          Scope,
          t.Object({
            mode: t.Optional(t.Union([t.Literal("manual"), t.Literal("all")])),
            limit: t.Optional(t.Numeric()),
          }),
        ]),
        detail: {
          summary: "Named spans: invocations, failures, avg and p95 duration",
          description:
            "`mode=manual` (the default) keeps the spans an application created " +
            "with `tracer.createSpan`, which is what the reference page means by " +
            "custom spans; `mode=all` includes the auto-instrumented ones. " +
            "Invocations and failures per bucket come from the spans themselves — " +
            "spans are not in the per-minute rollup.",
        },
      },
    )

    .get(
      "/services",
      ({ db, query }) =>
        services(db, window(query.from, query.to), scopeOf(query.applicationId)),
      {
        ...requireUser,
        query: t.Composite([Range, Scope]),
        detail: {
          summary: "Per-class own time vs total time, with the method breakdown",
          description:
            "Own time subtracts the direct children's durations: a controller that " +
            "only awaits its service does not look expensive. Total time includes " +
            "everything nested under it.",
        },
      },
    )

    .get(
      "/map",
      ({ db, query }) =>
        serviceMap(db, window(query.from, query.to), scopeOf(query.applicationId)),
      {
        ...requireUser,
        query: t.Composite([Range, Scope]),
        detail: {
          summary: "Service graph: applications and the trace continuations between them",
          description:
            "An edge is two applications that appear in one trace, in causal order. " +
            "There is no parent-service field on the wire, so this is the honest " +
            "inference available: the trace id *is* the causal link.",
        },
      },
    )

    .get(
      "/metrics",
      ({ db, query }) => metrics(db, scopeOf(query.applicationId)),
      {
        ...requireUser,
        query: Scope,
        detail: { summary: "Custom metric series, newest first" },
      },
    )

    .get(
      "/metrics/:name",
      ({ db, params, query }) =>
        metricPoints(
          db,
          decodeURIComponent(params.name),
          window(query.from, query.to),
          scopeOf(query.applicationId),
        ),
      {
        ...requireUser,
        params: t.Object({ name: t.String() }),
        query: t.Composite([Range, Scope]),
        detail: { summary: "Points for one custom metric series" },
      },
    )

    .get(
      "/releases",
      ({ db, query }) =>
        releases(db, window(query.from, query.to), scopeOf(query.applicationId)),
      {
        ...requireUser,
        query: t.Composite([Range, Scope]),
        detail: {
          summary: "Releases with a regression verdict against the previous one",
          description:
            "A regression is error rate up by more than one point, or p95 up by " +
            "more than 20%, against the previous release **of the same " +
            "application** — never across services.",
        },
      },
    )

    .get(
      "/users",
      ({ db, query }) =>
        users(db, window(query.from, query.to), scopeOf(query.applicationId)),
      {
        ...requireUser,
        query: t.Composite([Range, Scope]),
        detail: {
          summary: "Per-user activity, aggregated across the scope",
          description:
            "A user is a person, not a per-service fact: rows aggregate every " +
            "application in scope, and `applicationName` is null when the user " +
            "appears in more than one.",
        },
      },
    )

    .get(
      "/slos",
      async ({ db, query }) => ({
        items: await slos(db, scopeOf(query.applicationId)),
        retentionDays: await retentionDays(db),
      }),
      {
        ...requireUser,
        query: Scope,
        detail: {
          summary: "Objectives with their SLI, error budget and burn rate",
          description:
            "Each objective is measured against its own application's traffic, " +
            "even in the project-wide view. A window with no traffic reads as " +
            "no-data, never as 100% or 0%.",
        },
      },
    )

    .get(
      "/runtime",
      ({ db, query, status }) => {
        // Deliberately not aggregated: an averaged heap chart across services is
        // a number with no meaning. The hosted profiler index is per application
        // for the same reason.
        const applicationId = scopeOf(query.applicationId);
        if (!applicationId) return status(400, "runtime needs an applicationId");
        return runtime(db, applicationId, window(query.from, query.to));
      },
      {
        ...requireUser,
        query: t.Composite([Range, Scope]),
        detail: {
          summary: "Runtime samples (CPU, memory, event loop, GC) for one application",
          description:
            "Requires `applicationId`: CPU and heap are per-process facts, and " +
            "averaging them across services would invent a host that does not exist.",
        },
      },
    );
