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
  }),
  listItem: t.Object({
    id: t.String(),
    kind: t.Union([t.Literal("request"), t.Literal("job")]),
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
  }),
} as const;

export const ErrorModel = {
  group: createSelectSchema(errorGroup, {
    firstSeen: t.Number(),
    lastSeen: t.Number(),
  }),
  occurrence: createSelectSchema(errorOccurrence, { occurredAt: t.Number() }),
  statusBody: t.Object({
    status: t.Union([t.Literal("open"), t.Literal("resolved"), t.Literal("ignored")]),
  }),
} as const;

export const LogModel = {
  select: createSelectSchema(logEntry, { occurredAt: t.Number() }),
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
  select: createSelectSchema(runtimeSample, { receivedAt: t.Number() }),
} as const;

export const MetricModel = {
  series: createSelectSchema(metricSeries),
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
    mutedUntil: t.Union([t.Number(), t.Null()]),
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
