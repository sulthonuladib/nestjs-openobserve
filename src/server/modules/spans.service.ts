/**
 * Span-derived read models: the Services page, the service Map, and the Spans
 * explorer.
 *
 * All three are aggregates over `span`, which the ingest path already writes for
 * every execution. Nothing here is new collection — the hosted product derives
 * the same three views from the same rows, and the reason we can do it without a
 * worker is that they are read-side questions:
 *
 *   * **Services** — which class burns the time? Own time is a span's duration
 *     minus the sum of its direct children's, so a controller that only awaits
 *     its service does not look expensive. Total time is what it and everything
 *     under it took.
 *   * **Map** — who calls whom. Inferred from trace ids: two applications that
 *     appear in one trace, in causal order, are one edge. That is the honest
 *     inference available on the wire (there is no explicit parent-service field).
 *   * **Spans** — which named span is slow or failing, across every service.
 *
 * All three accept an optional `applicationId`: `undefined` is the whole project,
 * which is what the dashboard's "All applications" selector means.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../plugins/database";
import { application, execution, span } from "../db/schema";
import { pickBucket } from "./analytics.service";
import type { TimeWindow } from "./telemetry.service";

/**
 * The application predicate, written against an **alias**.
 *
 * Drizzle renders `execution.application_id` as the fully qualified
 * `"execution"."application_id"`, and these queries alias the table
 * (`FROM execution e`) — Postgres refuses a qualified reference to an aliased
 * table, so the alias has to be spelled out by hand.
 */
const scope = (applicationId?: string, alias = "e") =>
  applicationId ? sql`AND ${sql.raw(`${alias}.application_id`)} = ${applicationId}` : sql``;

export interface ServiceClass {
  applicationId: string;
  applicationName: string;
  serviceId: string;
  className: string;
  calls: number;
  errors: number;
  /** Span duration minus its direct children: where the time is actually spent. */
  ownMs: number;
  /** Span duration including everything nested under it. */
  totalMs: number;
  avgOwnMs: number;
  methods: Array<{
    method: string;
    calls: number;
    errors: number;
    ownMs: number;
    totalMs: number;
    avgOwnMs: number;
  }>;
}

/**
 * Per class: calls, errors, own time, total time, and the method breakdown the
 * expanded row shows.
 *
 * Two queries, not one with a nested aggregate: the method detail is a second
 * GROUP BY of the same scan, and Postgres cannot return both shapes in one
 * relation without a lateral join that would be slower than the round trip.
 */
export async function services(
  db: Db,
  range: TimeWindow,
  applicationId?: string,
): Promise<ServiceClass[]> {
  const classes = await db.execute<{
    application_id: string;
    application_name: string | null;
    service_id: string;
    class_name: string;
    calls: number;
    errors: number;
    own_ms: number;
    total_ms: number;
  }>(sql`
    SELECT e.application_id,
           a.name AS application_name,
           a.service_id,
           s.class_name,
           count(*)::int AS calls,
           count(*) FILTER (WHERE s.error)::int AS errors,
           COALESCE(SUM(GREATEST(s.duration_ms - COALESCE(child.total, 0), 0)), 0)::float8 AS own_ms,
           COALESCE(SUM(s.duration_ms), 0)::float8 AS total_ms
      FROM ${span} s
      INNER JOIN ${execution} e ON e.id = s.execution_id
      INNER JOIN ${application} a ON a.id = e.application_id
      LEFT JOIN LATERAL (
        SELECT SUM(c.duration_ms) AS total
          FROM ${span} c
         WHERE c.parent_id = s.id
      ) child ON TRUE
     WHERE e.started_at >= ${range.from} AND e.started_at < ${range.to}
       ${scope(applicationId)}
     GROUP BY 1, 2, 3, 4
     ORDER BY own_ms DESC
     LIMIT 100
  `);

  const methods = await db.execute<{
    application_id: string;
    class_name: string;
    method: string;
    calls: number;
    errors: number;
    own_ms: number;
    total_ms: number;
  }>(sql`
    SELECT e.application_id,
           s.class_name,
           s.method,
           count(*)::int AS calls,
           count(*) FILTER (WHERE s.error)::int AS errors,
           COALESCE(SUM(GREATEST(s.duration_ms - COALESCE(child.total, 0), 0)), 0)::float8 AS own_ms,
           COALESCE(SUM(s.duration_ms), 0)::float8 AS total_ms
      FROM ${span} s
      INNER JOIN ${execution} e ON e.id = s.execution_id
      LEFT JOIN LATERAL (
        SELECT SUM(c.duration_ms) AS total
          FROM ${span} c
         WHERE c.parent_id = s.id
      ) child ON TRUE
     WHERE e.started_at >= ${range.from} AND e.started_at < ${range.to}
       ${scope(applicationId)}
     GROUP BY 1, 2, 3
     ORDER BY own_ms DESC
  `);

  const byClass = new Map<string, ServiceClass["methods"]>();
  for (const row of methods) {
    const key = `${row.application_id}\u0000${row.class_name}`;
    const list = byClass.get(key) ?? [];
    list.push({
      method: row.method,
      calls: Number(row.calls),
      errors: Number(row.errors),
      ownMs: Number(row.own_ms),
      totalMs: Number(row.total_ms),
      avgOwnMs: Number(row.calls) > 0 ? Number(row.own_ms) / Number(row.calls) : 0,
    });
    byClass.set(key, list);
  }

  return classes.map((row) => ({
    applicationId: row.application_id,
    applicationName: row.application_name ?? row.service_id,
    serviceId: row.service_id,
    className: row.class_name,
    calls: Number(row.calls),
    errors: Number(row.errors),
    ownMs: Number(row.own_ms),
    totalMs: Number(row.total_ms),
    avgOwnMs: Number(row.calls) > 0 ? Number(row.own_ms) / Number(row.calls) : 0,
    methods: byClass.get(`${row.application_id}\u0000${row.class_name}`) ?? [],
  }));
}

export interface ServiceMapNode {
  applicationId: string;
  applicationName: string;
  serviceId: string;
  requests: number;
  jobs: number;
  errors: number;
}

export interface ServiceMapEdge {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  /** How many traces carried this hop. */
  traces: number;
}

/**
 * The service graph: nodes are applications, edges are trace continuations.
 *
 * The edge rule is the honest one available on the wire. There is no
 * parent-service field on a span, so "A called B" is inferred from a trace that
 * contains both, ordered by each application's earliest hop in that trace. The
 * ordering uses the agent's own `calledAt` (falling back to the collector's
 * ingest clock) because ingest order is *arrival* order, not causal order — see
 * `hopStartsAt` in `telemetry.service.ts`.
 *
 * `lag()` over an ordered window makes this one pass over the window's traces
 * instead of an O(n²) self-join on `trace_id`.
 */
export async function serviceMap(
  db: Db,
  range: TimeWindow,
  applicationId?: string,
): Promise<{ nodes: ServiceMapNode[]; edges: ServiceMapEdge[] }> {
  const nodes = await db
    .select({
      applicationId: application.id,
      applicationName: application.name,
      serviceId: application.serviceId,
      requests: sql<number>`count(*) FILTER (WHERE ${execution.kind} = 'request')::int`,
      jobs: sql<number>`count(*) FILTER (WHERE ${execution.kind} = 'job')::int`,
      errors: sql<number>`count(*) FILTER (WHERE ${execution.errorGroupId} IS NOT NULL)::int`,
    })
    .from(application)
    .leftJoin(
      execution,
      and(
        eq(execution.applicationId, application.id),
        gte(execution.startedAt, range.from),
        sql`${execution.startedAt} < ${range.to}`,
      ),
    )
    .where(applicationId ? eq(application.id, applicationId) : undefined)
    .groupBy(application.id, application.name, application.serviceId);

  const edges = await db.execute<{
    from_app: string;
    to_app: string;
    traces: number;
  }>(sql`
    WITH hops AS (
      SELECT e.trace_id,
             e.application_id,
             min(COALESCE(
               NULLIF(e.called_at, ''),
               to_char(to_timestamp(e.started_at / 1000.0) AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             )) AS at
        FROM ${execution} e
       WHERE e.started_at >= ${range.from} AND e.started_at < ${range.to}
       GROUP BY 1, 2
    ), ordered AS (
      SELECT trace_id,
             application_id,
             lag(application_id) OVER (PARTITION BY trace_id ORDER BY at, application_id) AS from_app
        FROM hops
    )
    SELECT from_app,
           application_id AS to_app,
           count(*)::int AS traces
      FROM ordered
     WHERE from_app IS NOT NULL AND from_app <> application_id
     GROUP BY 1, 2
     ORDER BY 3 DESC
     LIMIT 500
  `);

  const names = new Map(nodes.map((node) => [node.applicationId, node.applicationName ?? node.serviceId]));
  const nodesOut = nodes.map((node) => ({
    ...node,
    applicationName: node.applicationName ?? node.serviceId,
    requests: Number(node.requests),
    jobs: Number(node.jobs),
    errors: Number(node.errors),
  }));

  const scoped = applicationId
    ? edges.filter((edge) => edge.from_app === applicationId || edge.to_app === applicationId)
    : edges;

  return {
    nodes: nodesOut,
    edges: scoped.map((edge) => ({
      from: edge.from_app,
      to: edge.to_app,
      fromName: names.get(edge.from_app) ?? edge.from_app,
      toName: names.get(edge.to_app) ?? edge.to_app,
      traces: Number(edge.traces),
    })),
  };
}

export interface SpanRowAggregate {
  applicationId: string;
  applicationName: string;
  name: string;
  origin: "manual" | "auto";
  invocations: number;
  failures: number;
  failureRate: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  spanCount: number;
}

/**
 * Named spans, ranked by invocations — the demo's Spans page.
 *
 * `mode: "manual"` keeps only the spans an application created itself
 * (`tracer.createSpan`), which is what "analytics for the custom spans your code
 * creates" means; `mode: "all"` includes the auto-instrumented ones, which is
 * where `postgres_query`-shaped names come from.
 */
export async function spanAnalytics(
  db: Db,
  range: TimeWindow,
  options: {
    applicationId?: string;
    mode?: "manual" | "all";
    limit?: number;
  } = {},
): Promise<{ bucketMs: number; series: Array<{ t: number; invocations: number; failures: number }>; rows: SpanRowAggregate[] }> {
  const mode = options.mode ?? "manual";
  const limit = Math.min(options.limit ?? 100, 200);
  const bucketMs = pickBucket(range);

  const rows = await db.execute<{
    application_id: string;
    application_name: string | null;
    service_id: string;
    name: string;
    origin: "manual" | "auto";
    invocations: number;
    failures: number;
    avg_ms: number;
    p95_ms: number;
    max_ms: number;
  }>(sql`
    SELECT e.application_id,
           a.name AS application_name,
           a.service_id,
           COALESCE(NULLIF(s.name, ''), s.class_name || '.' || s.method) AS name,
           s.origin,
           count(*)::int AS invocations,
           count(*) FILTER (WHERE s.error)::int AS failures,
           COALESCE(AVG(s.duration_ms), 0)::float8 AS avg_ms,
           COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY s.duration_ms), 0)::float8 AS p95_ms,
           COALESCE(MAX(s.duration_ms), 0)::float8 AS max_ms
      FROM ${span} s
      INNER JOIN ${execution} e ON e.id = s.execution_id
      INNER JOIN ${application} a ON a.id = e.application_id
     WHERE e.started_at >= ${range.from} AND e.started_at < ${range.to}
       ${mode === "manual" ? sql`AND s.origin = 'manual'` : sql``}
       ${scope(options.applicationId)}
     GROUP BY 1, 2, 3, 4, 5
     ORDER BY invocations DESC
     LIMIT ${limit}
  `);

  const seriesRows = await db.execute<{ t: string; invocations: number; failures: number }>(sql`
    SELECT ((${execution.startedAt} / ${bucketMs}::bigint) * ${bucketMs}::bigint)::text AS t,
           count(*)::int AS invocations,
           count(*) FILTER (WHERE ${span.error})::int AS failures
      FROM ${span}
      INNER JOIN ${execution} ON ${execution.id} = ${span.executionId}
     WHERE ${execution.startedAt} >= ${range.from} AND ${execution.startedAt} < ${range.to}
       ${mode === "manual" ? sql`AND ${span.origin} = 'manual'` : sql``}
       ${scope(options.applicationId)}
     GROUP BY 1
     ORDER BY 1
  `);

  return {
    bucketMs,
    series: seriesRows.map((row) => ({
      t: Number(row.t),
      invocations: Number(row.invocations),
      failures: Number(row.failures),
    })),
    rows: rows.map((row) => ({
      applicationId: row.application_id,
      applicationName: row.application_name ?? row.service_id,
      name: row.name,
      origin: row.origin,
      invocations: Number(row.invocations),
      failures: Number(row.failures),
      failureRate: Number(row.invocations) > 0 ? Number(row.failures) / Number(row.invocations) : 0,
      avgMs: Number(row.avg_ms),
      p95Ms: Number(row.p95_ms),
      maxMs: Number(row.max_ms),
      spanCount: Number(row.invocations),
    })),
  };
}
