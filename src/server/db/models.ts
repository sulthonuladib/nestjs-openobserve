/**
 * TypeBox models derived from the Drizzle schema.
 *
 * `drizzle-typebox` builds a TypeBox schema from a table definition, so the
 * database column, the TypeScript type and the wire validation cannot drift —
 * which is the whole reason Elysia's `t` is TypeBox rather than a bolt-on.
 *
 * Two deliberate overrides:
 *   * `bigint(..., { mode: "number" })` columns are declared `t.Number()`. The
 *     default mapping is a BigInt union, and `JSON.stringify` refuses BigInt —
 *     so a response model would typecheck and then fail at runtime.
 *   * secrets are never part of a select schema. `app_credential` is projected
 *     explicitly instead of via `createSelectSchema`.
 */
import { t } from "elysia";
import { createInsertSchema, createSelectSchema } from "drizzle-typebox";
import {
  alertEvent,
  alertRule,
  application,
  cliLinkSession,
  errorGroup,
  errorOccurrence,
  execution,
  logEntry,
  metricSeries,
  operation,
  release,
  retentionPolicy,
  runtimeSample,
  slo,
  span,
} from "../db/schema";

/** Every millisecond column, so the override list stays in one place. */
const asNumber = { createdAt: t.Number(), lastSeen: t.Number() };

export const ApplicationModel = {
  select: createSelectSchema(application, {
    firstSeen: t.Number(),
    lastSeen: t.Number(),
  }),
  // What the dashboard list actually returns: the row plus window aggregates.
  summary: t.Object({
    id: t.String(),
    serviceId: t.String(),
    name: t.String(),
    lastSeen: t.Number(),
    requests: t.Number(),
    errorRate: t.Number(),
    avgDurationMs: t.Number(),
    p95DurationMs: t.Union([t.Number(), t.Null()]),
  }),
} as const;

export const OperationModel = {
  select: createSelectSchema(operation, {
    firstSeen: t.Number(),
    lastSeen: t.Number(),
  }),
  ranked: t.Object({
    operationRowId: t.String(),
    kind: t.Union([t.Literal("request"), t.Literal("job")]),
    /**
     * The application the row belongs to. Always present: in the project-wide
     * view two rows can carry the same operation name, so the id and the name
     * are what make the row addressable.
     */
    applicationId: t.String(),
    applicationName: t.String(),
    serviceId: t.String(),
    operationId: t.Union([t.String(), t.Null()]),
    method: t.Union([t.String(), t.Null()]),
    customName: t.Union([t.String(), t.Null()]),
    count: t.Number(),
    errors: t.Number(),
    durationSum: t.Number(),
    avgDurationMs: t.Number(),
    p95DurationMs: t.Union([t.Number(), t.Null()]),
  }),
} as const;

export const ExecutionModel = {
  select: createSelectSchema(execution, {
    startedAt: t.Number(),
    // Opaque by design: the wire lets the agent send any object here, and the
    // collector stores it verbatim. `t.Any()` keeps Elysia's response inference
    // from trying to reconcile an arbitrary JSON value with a schema.
    error: t.Any(),
    tags: t.Any(),
    request: t.Any(),
  }),
  listItem: t.Object({
    id: t.String(),
    kind: t.Union([t.Literal("request"), t.Literal("job")]),
    /** Which application ran it — the column a project-wide list needs. */
    applicationId: t.String(),
    applicationName: t.String(),
    serviceId: t.String(),
    protocol: t.Union([t.String(), t.Null()]),
    traceId: t.String(),
    startedAt: t.Number(),
    durationMs: t.Union([t.Number(), t.Null()]),
    statusCode: t.Union([t.Number(), t.Null()]),
    errorGroupId: t.Union([t.String(), t.Null()]),
    spanCount: t.Number(),
    operationId: t.Union([t.String(), t.Null()]),
    method: t.Union([t.String(), t.Null()]),
    queue: t.Union([t.String(), t.Null()]),
    jobName: t.Union([t.String(), t.Null()]),
  }),
  page: t.Object({
    items: t.Array(t.Any()),
    nextCursor: t.Union([t.String(), t.Null()]),
  }),
} as const;

export const SpanModel = {
  select: createSelectSchema(span, {
    durationMs: t.Union([t.Number(), t.Null()]),
    startOffsetMs: t.Union([t.Number(), t.Null()]),
    collapsedCount: t.Union([t.Number(), t.Null()]),
    tags: t.Any(),
  }),
} as const;

/**
 * One hop in a trace: the execution, the application that ran it, the handler,
 * and its span tree. Nested rather than flattened so the waterfall row and its
 * spans cannot drift apart in the type.
 */
const traceHop = t.Object({
  execution: ExecutionModel.select,
  applicationName: t.String(),
  serviceId: t.String(),
  operation: t.Union([
    t.Object({
      operationId: t.String(),
      method: t.Union([t.String(), t.Null()]),
      customName: t.Union([t.String(), t.Null()]),
      // Nullable only because the join is a LEFT JOIN: an execution whose
      // operation row was pruned still belongs to the trace.
      protocol: t.Union([t.String(), t.Null()]),
    }),
    t.Null(),
  ]),
  spans: t.Array(SpanModel.select),
  /**
   * The hop's start on the trace's clock (the agent's own timestamp when it is
   * usable, else the collector's ingest time) — see `hopStartsAt`.
   */
  startsAt: t.Number(),
});

/** One point of a chart series; shared by the request and job charts. */
const seriesPoint = t.Object({
  t: t.Number(),
  requests: t.Number(),
  errors: t.Number(),
  clientErrors: t.Number(),
  avgMs: t.Union([t.Number(), t.Null()]),
  p50Ms: t.Union([t.Number(), t.Null()]),
  p95Ms: t.Union([t.Number(), t.Null()]),
  p99Ms: t.Union([t.Number(), t.Null()]),
});

export const JobModel = {
  /** One row of `/telemetry/jobs`: a handler, in one application. */
  row: t.Object({
    applicationId: t.String(),
    applicationName: t.String(),
    serviceId: t.String(),
    queue: t.Union([t.String(), t.Null()]),
    jobName: t.Union([t.String(), t.Null()]),
    runs: t.Number(),
    failed: t.Number(),
    retried: t.Number(),
    failureRate: t.Number(),
    avgMs: t.Number(),
    p95Ms: t.Number(),
    avgWaitMs: t.Number(),
    p95WaitMs: t.Number(),
    lastRunAt: t.Number(),
  }),
  /**
   * One run. `error` is the whole failure payload the agent sent (class, message,
   * stack, code frames): a failed job opens no error group, so this row is the
   * only place that context exists.
   */
  run: t.Object({
    id: t.String(),
    traceId: t.String(),
    startedAt: t.Number(),
    durationMs: t.Union([t.Number(), t.Null()]),
    waitMs: t.Union([t.Number(), t.Null()]),
    enqueuedAt: t.Union([t.String(), t.Null()]),
    attemptsMade: t.Union([t.Number(), t.Null()]),
    maxAttempts: t.Union([t.Number(), t.Null()]),
    jobStatus: t.Union([t.Literal("completed"), t.Literal("failed"), t.Null()]),
    error: t.Any(),
    spanCount: t.Number(),
  }),
  detail: t.Object({
    queue: t.String(),
    jobName: t.String(),
    operationRowId: t.String(),
    runs: t.Number(),
    completed: t.Number(),
    failed: t.Number(),
    retried: t.Number(),
    totalAttempts: t.Number(),
    failureRate: t.Number(),
    retriesPerRun: t.Number(),
    avgMs: t.Number(),
    p50Ms: t.Number(),
    p95Ms: t.Number(),
    maxMs: t.Number(),
    avgWaitMs: t.Number(),
    p95WaitMs: t.Number(),
    maxWaitMs: t.Number(),
    maxAttempts: t.Union([t.Number(), t.Null()]),
    firstRunAt: t.Number(),
    lastRunAt: t.Number(),
    series: t.Object({ bucketMs: t.Number(), points: t.Array(seriesPoint) }),
    /**
     * Queue wait per bucket, derived from the runs themselves: the rollup has
     * duration histograms but no wait column, and wait is the number that shows a
     * backlog growing while duration still looks healthy.
     */
    waitSeries: t.Object({
      bucketMs: t.Number(),
      points: t.Array(
        t.Object({
          t: t.Number(),
          avgMs: t.Union([t.Number(), t.Null()]),
          p95Ms: t.Union([t.Number(), t.Null()]),
          samples: t.Number(),
        }),
      ),
    }),
    recent: t.Array(t.Any()),
  }),
} as const;

export const TraceModel = {
  hop: traceHop,
  response: t.Object({
    traceId: t.String(),
    startedAt: t.Number(),
    durationMs: t.Union([t.Number(), t.Null()]),
    applications: t.Array(
      t.Object({ id: t.String(), name: t.String(), serviceId: t.String() }),
    ),
    executions: t.Array(traceHop),
    logs: t.Array(t.Any()),
  }),
} as const;

export const ErrorModel = {
  group: createSelectSchema(errorGroup, {
    firstSeen: t.Number(),
    lastSeen: t.Number(),
  }),
  /** The group plus the application that produced it. */
  list: t.Composite([
    createSelectSchema(errorGroup, { firstSeen: t.Number(), lastSeen: t.Number() }),
    t.Object({ applicationName: t.String() }),
  ]),
  occurrence: createSelectSchema(errorOccurrence, {
    occurredAt: t.Number(),
    codeFrames: t.Union([
      t.Array(
        t.Object({
          file: t.String(),
          line: t.Number(),
          firstLine: t.Number(),
          lines: t.Array(t.String()),
        }),
      ),
      t.Null(),
    ]),
  }),
  statusBody: t.Object({
    status: t.Union([t.Literal("open"), t.Literal("resolved"), t.Literal("ignored")]),
  }),
} as const;

export const LogModel = {
  select: createSelectSchema(logEntry, { occurredAt: t.Number(), attributes: t.Any() }),
  /** A log line plus the application that wrote it. */
  list: t.Composite([
    createSelectSchema(logEntry, { occurredAt: t.Number(), attributes: t.Any() }),
    t.Object({ applicationName: t.String() }),
  ]),
  query: t.Object({
    from: t.Optional(t.Numeric()),
    to: t.Optional(t.Numeric()),
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
    cursor: t.Optional(t.String()),
    limit: t.Optional(t.Numeric()),
  }),
} as const;

export const ReleaseModel = {
  select: createSelectSchema(release, { firstSeen: t.Number(), lastSeen: t.Number() }),
} as const;

export const RuntimeModel = {
  select: createSelectSchema(runtimeSample, {
    receivedAt: t.Number(),
    cpu: t.Any(),
    memory: t.Any(),
    gc: t.Any(),
    eventLoop: t.Any(),
  }),
} as const;

export const MetricModel = {
  series: createSelectSchema(metricSeries, { labels: t.Any() }),
} as const;

export const SloModel = {
  select: createSelectSchema(slo, {
    updatedAt: t.Number(),
    underMs: t.Union([t.Number(), t.Null()]),
  }),
} as const;

export const AlertModel = {
  rule: createSelectSchema(alertRule, {
    createdAt: t.Number(),
    updatedAt: t.Number(),
    mutedUntil: t.Union([t.Number(), t.Null()]),
    sigma: t.Union([t.Number(), t.Null()]),
    // Free-form by design: the scope keys and the channel list grow without a
    // migration, so the response model must not pretend to enumerate them.
    channels: t.Any(),
    scope: t.Any(),
    quietHours: t.Any(),
  }),
  event: createSelectSchema(alertEvent, {
    startedAt: t.Number(),
    resolvedAt: t.Union([t.Number(), t.Null()]),
    severity: t.Union([
      t.Literal("low"),
      t.Literal("medium"),
      t.Literal("high"),
      t.Literal("critical"),
      t.Null(),
    ]),
    payload: t.Any(),
  }),
} as const;

export const RetentionModel = {
  select: createSelectSchema(retentionPolicy),
} as const;

export const CliLinkModel = {
  select: createSelectSchema(cliLinkSession, {
    createdAt: t.Number(),
    expiresAt: t.Number(),
    approvedAt: t.Union([t.Number(), t.Null()]),
  }),
} as const;

/**
 * Insert schemas are what conformance tests assert against: a fixture that the
 * database accepts must also satisfy the wire contract, and vice versa.
 */
export const InsertSchemas = {
  application: createInsertSchema(application),
  execution: createInsertSchema(execution),
  span: createInsertSchema(span),
  logEntry: createInsertSchema(logEntry),
  errorGroup: createInsertSchema(errorGroup),
} as const;

export { asNumber };
