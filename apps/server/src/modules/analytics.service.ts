/**
 * Read-side analytics: the queries behind charts, jobs, metrics, releases and
 * per-user activity.
 *
 * All of it is derived from data the ingest path already stores — no new
 * collection, no second pipeline. The rules encoded here are the upstream
 * product's, and each one is cited where it is not obvious.
 */
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../plugins/database";
import {
  application,
  errorGroup,
  execution,
  metricPoint,
  metricSeries,
  operation,
  release,
  rollupMinute,
  runtimeSample,
} from "../db/schema";
import { percentileFromHistogram, type TimeWindow } from "./telemetry.service";

/** Bucket sizes offered by the time-range picker, in ms. */
const BUCKETS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000] as const;

/**
 * Picks a bucket so a range yields between ~60 and ~240 points: dense enough for
 * a sparkline to mean something, sparse enough that a 30-day view is not 43,200
 * buckets the browser has to draw.
 */
export function pickBucket(range: TimeWindow): number {
  const span = Math.max(range.to - range.from, 60_000);
  return BUCKETS.find((bucket) => span / bucket <= 240) ?? BUCKETS[BUCKETS.length - 1]!;
}

export interface SeriesPoint {
  t: number;
  requests: number;
  errors: number;
  clientErrors: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

/**
 * Requests/errors/latency over time, from the per-minute rollups.
 *
 * Percentiles are merged from the stored log-scale histograms per bucket — p95
 * over ten minutes is not the average of ten per-minute p95s, and a chart that
 * pretends otherwise is wrong exactly where people look.
 */
export async function timeseries(
  db: Db,
  applicationId: string,
  range: TimeWindow,
  bucketMs = pickBucket(range),
): Promise<{ bucketMs: number; points: SeriesPoint[] }> {
  const scalars = await db
    .select({
      t: sql<number>`((${rollupMinute.at} / ${bucketMs}::bigint) * ${bucketMs}::bigint)::bigint`,
      requests: sql<number>`SUM(${rollupMinute.count})::int`,
      errors: sql<number>`SUM(${rollupMinute.errorCount})::int`,
      clientErrors: sql<number>`SUM(${rollupMinute.clientErrorCount})::int`,
      durationSum: sql<number>`SUM(${rollupMinute.durationSum})::float8`,
    })
    .from(rollupMinute)
    .where(
      and(
        eq(rollupMinute.applicationId, applicationId),
        gte(rollupMinute.at, range.from),
        lt(rollupMinute.at, range.to),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const histograms = await db.execute<{ t: string; idx: number; total: number }>(sql`
    SELECT ((${rollupMinute.at} / ${bucketMs}::bigint) * ${bucketMs}::bigint)::text AS t,
           u.idx::int AS idx,
           SUM(u.value)::int AS total
      FROM ${rollupMinute},
           LATERAL unnest(${rollupMinute.durationHist}) WITH ORDINALITY AS u(value, idx)
     WHERE ${rollupMinute.applicationId} = ${applicationId}
       AND ${rollupMinute.at} >= ${range.from}
       AND ${rollupMinute.at} < ${range.to}
     GROUP BY 1, 2
  `);

  const merged = new Map<number, number[]>();
  for (const row of histograms) {
    const key = Number(row.t);
    const list = merged.get(key) ?? [];
    list[Number(row.idx) - 1] = Number(row.total);
    merged.set(key, list);
  }

  const points: SeriesPoint[] = scalars.map((row) => {
    const t = Number(row.t);
    const requests = Number(row.requests ?? 0);
    const histogram = merged.get(t);
    return {
      t,
      requests,
      errors: Number(row.errors ?? 0),
      clientErrors: Number(row.clientErrors ?? 0),
      avgMs: requests > 0 ? Number(row.durationSum ?? 0) / requests : null,
      p50Ms: percentileFromHistogram(histogram, 0.5),
      p95Ms: percentileFromHistogram(histogram, 0.95),
      p99Ms: percentileFromHistogram(histogram, 0.99),
    };
  });

  return { bucketMs, points };
}

/**
 * Jobs: one row per queue/job pair, with the two numbers that actually reveal a
 * problem — failures and queue wait ("a job that waited four minutes and then ran
 * in 10ms is indistinguishable from a healthy one on duration alone").
 */
export async function jobs(db: Db, applicationId: string, range: TimeWindow) {
  const rows = await db
    .select({
      queue: execution.queue,
      jobName: execution.jobName,
      runs: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) FILTER (WHERE ${execution.jobStatus} = 'failed')::int`,
      avgMs: sql<number>`COALESCE(AVG(${execution.durationMs}), 0)::float8`,
      p95Ms: sql<number>`COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY ${execution.durationMs}), 0)::float8`,
      avgWaitMs: sql<number>`COALESCE(AVG(${execution.waitMs}), 0)::float8`,
      p95WaitMs: sql<number>`COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY ${execution.waitMs}), 0)::float8`,
      retried: sql<number>`count(*) FILTER (WHERE ${execution.attemptsMade} > 0)::int`,
      lastRunAt: sql<number>`MAX(${execution.startedAt})::bigint`,
    })
    .from(execution)
    .where(
      and(
        eq(execution.applicationId, applicationId),
        eq(execution.kind, "job"),
        gte(execution.startedAt, range.from),
        lt(execution.startedAt, range.to),
      ),
    )
    .groupBy(execution.queue, execution.jobName)
    .orderBy(desc(sql`count(*)`))
    .limit(100);

  return rows.map((row) => ({
    ...row,
    runs: Number(row.runs),
    failed: Number(row.failed),
    retried: Number(row.retried),
    failureRate: Number(row.runs) > 0 ? Number(row.failed) / Number(row.runs) : 0,
    avgMs: Number(row.avgMs),
    p95Ms: Number(row.p95Ms),
    avgWaitMs: Number(row.avgWaitMs),
    p95WaitMs: Number(row.p95WaitMs),
    lastRunAt: Number(row.lastRunAt),
  }));
}

/** Custom metric series, newest first, with their label set. */
export async function metrics(db: Db, applicationId: string) {
  return db
    .select({
      id: metricSeries.id,
      name: metricSeries.name,
      type: metricSeries.type,
      kind: metricSeries.kind,
      labels: metricSeries.labels,
      description: metricSeries.description,
      points: sql<number>`count(${metricPoint.at})::int`,
      lastAt: sql<number>`MAX(${metricPoint.at})::bigint`,
    })
    .from(metricSeries)
    .leftJoin(metricPoint, eq(metricPoint.seriesId, metricSeries.id))
    .where(eq(metricSeries.applicationId, applicationId))
    .groupBy(metricSeries.id)
    .orderBy(desc(sql`MAX(${metricPoint.at})`))
    .limit(200);
}

export async function metricPoints(
  db: Db,
  applicationId: string,
  name: string,
  range: TimeWindow,
) {
  return db
    .select({
      seriesId: metricPoint.seriesId,
      labels: metricSeries.labels,
      type: metricSeries.type,
      at: metricPoint.at,
      value: metricPoint.value,
      count: metricPoint.count,
      sum: metricPoint.sum,
      min: metricPoint.min,
      max: metricPoint.max,
      q50: metricPoint.q50,
      q95: metricPoint.q95,
      q99: metricPoint.q99,
    })
    .from(metricPoint)
    .innerJoin(metricSeries, eq(metricSeries.id, metricPoint.seriesId))
    .where(
      and(
        eq(metricSeries.applicationId, applicationId),
        eq(metricSeries.name, name),
        gte(metricPoint.at, range.from),
        lt(metricPoint.at, range.to),
      ),
    )
    .orderBy(metricPoint.at)
    .limit(5000);
}

/** Runtime samples, for the profiler/runtime view. */
export async function runtime(db: Db, applicationId: string, range: TimeWindow) {
  const rows = await db
    .select()
    .from(runtimeSample)
    .where(
      and(
        eq(runtimeSample.applicationId, applicationId),
        gte(runtimeSample.receivedAt, range.from),
        lt(runtimeSample.receivedAt, range.to),
      ),
    )
    .orderBy(runtimeSample.receivedAt)
    .limit(2000);

  return rows.map((row) => ({
    at: row.receivedAt,
    // The wire's short keys, unpacked once here so every consumer does not have
    // to know that `m.hu` is heapUsed.
    rss: row.memory.r ?? null,
    heapUsed: row.memory.hu ?? null,
    heapTotal: row.memory.ht ?? null,
    cpuPercent: row.cpu.p ?? null,
    eventLoopMs: row.eventLoop.l ?? null,
    gcCount: (row.gc as { c?: number }).c ?? null,
    gcMs: (row.gc as { td?: number }).td ?? null,
  }));
}

/**
 * Releases, with the comparison that makes a release page useful.
 *
 * A regression is judged against the *previous* release on the same window
 * length: error rate up, or p95 up by more than 20%. That is the rule the
 * dashboard's "2.9.0 looks like a regression" callout encodes.
 */
export async function releases(db: Db, applicationId: string, range: TimeWindow) {
  const rows = await db
    .select({
      id: release.id,
      version: release.version,
      firstSeen: release.firstSeen,
      lastSeen: release.lastSeen,
      requests: sql<number>`count(${execution.id})::int`,
      errors: sql<number>`count(*) FILTER (WHERE ${execution.errorGroupId} IS NOT NULL)::int`,
      p95Ms: sql<number>`COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY ${execution.durationMs}), 0)::float8`,
    })
    .from(release)
    .leftJoin(
      execution,
      and(
        eq(execution.releaseId, release.id),
        gte(execution.startedAt, range.from),
        lt(execution.startedAt, range.to),
      ),
    )
    .where(eq(release.applicationId, applicationId))
    .groupBy(release.id)
    .orderBy(desc(release.firstSeen))
    .limit(50);

  const enriched = rows.map((row) => ({
    id: row.id,
    version: row.version,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    requests: Number(row.requests),
    errors: Number(row.errors),
    errorRate: Number(row.requests) > 0 ? Number(row.errors) / Number(row.requests) : 0,
    p95Ms: Number(row.p95Ms),
  }));

  return enriched.map((row, index) => {
    const previous = enriched[index + 1];
    if (!previous || previous.requests === 0 || row.requests === 0) {
      return { ...row, regression: null };
    }
    const errorDelta = row.errorRate - previous.errorRate;
    const latencyDelta =
      previous.p95Ms > 0 ? (row.p95Ms - previous.p95Ms) / previous.p95Ms : 0;
    const isRegression = errorDelta > 0.01 || latencyDelta > 0.2;
    return {
      ...row,
      regression: isRegression
        ? {
            againstVersion: previous.version,
            errorRateDelta: errorDelta,
            latencyDelta,
          }
        : null,
    };
  });
}

/**
 * Per-user activity. `u` on the wire is whatever `http.getUserId` returned, so
 * this is the "which customer is hitting us, and how is it going" view.
 */
export async function users(db: Db, applicationId: string, range: TimeWindow) {
  const rows = await db
    .select({
      userId: execution.userId,
      requests: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) FILTER (WHERE ${execution.errorGroupId} IS NOT NULL)::int`,
      avgMs: sql<number>`COALESCE(AVG(${execution.durationMs}), 0)::float8`,
      lastSeen: sql<number>`MAX(${execution.startedAt})::bigint`,
    })
    .from(execution)
    .where(
      and(
        eq(execution.applicationId, applicationId),
        gte(execution.startedAt, range.from),
        lt(execution.startedAt, range.to),
        sql`${execution.userId} IS NOT NULL`,
      ),
    )
    .groupBy(execution.userId)
    .orderBy(desc(sql`count(*)`))
    .limit(200);

  return rows.map((row) => ({
    userId: row.userId ?? "anonymous",
    requests: Number(row.requests),
    errors: Number(row.errors),
    errorRate: Number(row.requests) > 0 ? Number(row.errors) / Number(row.requests) : 0,
    avgMs: Number(row.avgMs),
    lastSeen: Number(row.lastSeen),
  }));
}

/**
 * The operation page's numbers: one operation, over time, with its slowest
 * instances and its error groups.
 */
export async function operationDetail(
  db: Db,
  applicationId: string,
  operationRowId: string,
  range: TimeWindow,
) {
  const rows = await db
    .select()
    .from(operation)
    .where(and(eq(operation.id, operationRowId), eq(operation.applicationId, applicationId)))
    .limit(1);
  const found = rows[0];
  if (!found) return null;

  const series = await timeseries(db, applicationId, range);

  const slowest = await db
    .select({
      id: execution.id,
      traceId: execution.traceId,
      startedAt: execution.startedAt,
      durationMs: execution.durationMs,
      statusCode: execution.statusCode,
      errorGroupId: execution.errorGroupId,
    })
    .from(execution)
    .where(
      and(
        eq(execution.applicationId, applicationId),
        eq(execution.operationRowId, operationRowId),
        gte(execution.startedAt, range.from),
        lt(execution.startedAt, range.to),
      ),
    )
    .orderBy(desc(execution.durationMs))
    .limit(10);

  const errors = await db
    .select({
      id: errorGroup.id,
      message: errorGroup.message,
      class: errorGroup.class,
      occurrences: errorGroup.occurrences,
      lastSeen: errorGroup.lastSeen,
    })
    .from(errorGroup)
    .innerJoin(execution, eq(execution.errorGroupId, errorGroup.id))
    .where(
      and(
        eq(execution.operationRowId, operationRowId),
        gte(execution.startedAt, range.from),
        lt(execution.startedAt, range.to),
      ),
    )
    .groupBy(errorGroup.id)
    .orderBy(desc(errorGroup.lastSeen))
    .limit(20);

  return { operation: found, series, slowest, errors };
}

/** Applications, for the switcher and for the service list. */
export async function applicationById(db: Db, id: string) {
  const rows = await db.select().from(application).where(eq(application.id, id)).limit(1);
  return rows[0] ?? null;
}
