/**
 * Read-side analytics: the queries behind charts, jobs, metrics, releases and
 * per-user activity.
 *
 * All of it is derived from data the ingest path already stores — no new
 * collection, no second pipeline. The rules encoded here are the upstream
 * product's, and each one is cited where it is not obvious.
 */
import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../plugins/database";
import {
  application,
  errorGroup,
  execution,
  instanceSetting,
  metricPoint,
  metricSeries,
  operation,
  release,
  rollupMinute,
  runtimeSample,
  slo,
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
 *
 * `kind` defaults to `request` **on purpose**: `rollup_minute` interleaves the
 * two kinds, and a chart labelled "Requests" that counts nightly cron runs is a
 * wrong number, not a rounding error. The job detail page asks for `kind: 'job'`
 * explicitly and labels the axis with the job's own vocabulary.
 *
 * `operationRowId` narrows the series to one operation — without it the
 * operation page drew the whole application's traffic under one handler's name.
 * `applicationId` narrows it to one application; omitted means the whole project,
 * which is the dashboard's "All applications" view (the sums and the merged
 * histograms are exactly the same operation either way).
 */
export async function timeseries(
  db: Db,
  range: TimeWindow,
  options: {
    applicationId?: string;
    bucketMs?: number;
    kind?: "request" | "job";
    operationRowId?: string;
  } = {},
): Promise<{ bucketMs: number; points: SeriesPoint[] }> {
  const kind = options.kind ?? "request";
  const bucketMs = options.bucketMs ?? pickBucket(range);
  const operationRowId = options.operationRowId;
  const applicationId = options.applicationId;

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
        applicationId ? eq(rollupMinute.applicationId, applicationId) : undefined,
        eq(rollupMinute.kind, kind),
        gte(rollupMinute.at, range.from),
        lt(rollupMinute.at, range.to),
        operationRowId ? eq(rollupMinute.operationRowId, operationRowId) : undefined,
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
     WHERE ${rollupMinute.kind} = ${kind}
       AND ${rollupMinute.at} >= ${range.from}
       AND ${rollupMinute.at} < ${range.to}
       ${applicationId ? sql`AND ${rollupMinute.applicationId} = ${applicationId}` : sql``}
       ${operationRowId ? sql`AND ${rollupMinute.operationRowId} = ${operationRowId}` : sql``}
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
export async function jobs(db: Db, range: TimeWindow, applicationId?: string) {
  const rows = await db
    .select({
      applicationId: execution.applicationId,
      applicationName: application.name,
      serviceId: application.serviceId,
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
    .innerJoin(application, eq(application.id, execution.applicationId))
    .where(
      and(
        applicationId ? eq(execution.applicationId, applicationId) : undefined,
        eq(execution.kind, "job"),
        gte(execution.startedAt, range.from),
        lt(execution.startedAt, range.to),
      ),
    )
    // Grouped by application too: two services can run a queue with the same
    // name, and folding them into one row would invent a handler that does not
    // exist. `/job` is addressed by (application, queue, name) for the same
    // reason.
    .groupBy(
      execution.applicationId,
      application.name,
      application.serviceId,
      execution.queue,
      execution.jobName,
    )
    .orderBy(desc(sql`count(*)`))
    .limit(100);

  return rows.map((row) => ({
    ...row,
    applicationName: row.applicationName ?? row.serviceId,
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
export async function metrics(db: Db, applicationId?: string) {
  return db
    .select({
      id: metricSeries.id,
      applicationId: metricSeries.applicationId,
      applicationName: application.name,
      serviceId: application.serviceId,
      name: metricSeries.name,
      type: metricSeries.type,
      kind: metricSeries.kind,
      labels: metricSeries.labels,
      description: metricSeries.description,
      points: sql<number>`count(${metricPoint.at})::int`,
      lastAt: sql<number>`MAX(${metricPoint.at})::bigint`,
    })
    .from(metricSeries)
    .innerJoin(application, eq(application.id, metricSeries.applicationId))
    .leftJoin(metricPoint, eq(metricPoint.seriesId, metricSeries.id))
    .where(applicationId ? eq(metricSeries.applicationId, applicationId) : undefined)
    .groupBy(metricSeries.id, application.name, application.serviceId)
    .orderBy(desc(sql`MAX(${metricPoint.at})`))
    .limit(200);
}

export async function metricPoints(
  db: Db,
  name: string,
  range: TimeWindow,
  applicationId?: string,
) {
  return db
    .select({
      seriesId: metricPoint.seriesId,
      applicationId: metricSeries.applicationId,
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
        applicationId ? eq(metricSeries.applicationId, applicationId) : undefined,
        eq(metricSeries.name, name),
        gte(metricPoint.at, range.from),
        lt(metricPoint.at, range.to),
      ),
    )
    .orderBy(metricPoint.at)
    .limit(5000);
}

/**
 * Runtime samples, for the profiler/runtime view.
 *
 * Deliberately **one application at a time**: a CPU or heap chart averaged across
 * services is a number with no meaning, and the hosted product's profiler index
 * is a per-application map for the same reason. The page asks for an application
 * instead of pretending a project-wide heartbeat exists.
 */
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
export async function releases(db: Db, range: TimeWindow, applicationId?: string) {
  const rows = await db
    .select({
      id: release.id,
      applicationId: release.applicationId,
      applicationName: application.name,
      serviceId: application.serviceId,
      version: release.version,
      firstSeen: release.firstSeen,
      lastSeen: release.lastSeen,
      requests: sql<number>`count(${execution.id})::int`,
      errors: sql<number>`count(*) FILTER (WHERE ${execution.errorGroupId} IS NOT NULL)::int`,
      p95Ms: sql<number>`COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY ${execution.durationMs}), 0)::float8`,
    })
    .from(release)
    .innerJoin(application, eq(application.id, release.applicationId))
    .leftJoin(
      execution,
      and(
        eq(execution.releaseId, release.id),
        eq(execution.kind, "request"),
        gte(execution.startedAt, range.from),
        lt(execution.startedAt, range.to),
      ),
    )
    .where(applicationId ? eq(release.applicationId, applicationId) : undefined)
    .groupBy(release.id, application.name, application.serviceId)
    .orderBy(desc(release.firstSeen))
    .limit(50);

  const enriched = rows.map((row) => ({
    id: row.id,
    applicationId: row.applicationId,
    applicationName: row.applicationName ?? row.serviceId,
    version: row.version,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    requests: Number(row.requests),
    errors: Number(row.errors),
    errorRate: Number(row.requests) > 0 ? Number(row.errors) / Number(row.requests) : 0,
    p95Ms: Number(row.p95Ms),
  }));

  /**
   * The regression verdict compares a release with the **previous release of the
   * same application**: 2.9.0 of the gateway is not a regression against 2.9.0 of
   * the worker, and in the project view the two rows sit next to each other.
   */
  return enriched.map((row) => {
    const previous = enriched.find(
      (candidate) =>
        candidate.applicationId === row.applicationId &&
        candidate.firstSeen < row.firstSeen,
    );
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
 *
 * Aggregated by user **across** the scope, because a user is a person, not a
 * per-service fact: the hosted product lists one row per user with an
 * application column, and that is the useful question ("is this customer having
 * a bad time anywhere?"). `applicationName` is null when the user appears in
 * more than one application.
 */
export async function users(db: Db, range: TimeWindow, applicationId?: string) {
  const rows = await db
    .select({
      userId: execution.userId,
      applicationName: sql<string | null>`
        CASE WHEN count(DISTINCT ${execution.applicationId}) = 1
             THEN min(${application.name}) ELSE NULL END`,
      requests: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) FILTER (WHERE ${execution.errorGroupId} IS NOT NULL)::int`,
      avgMs: sql<number>`COALESCE(AVG(${execution.durationMs}), 0)::float8`,
      lastSeen: sql<number>`MAX(${execution.startedAt})::bigint`,
    })
    .from(execution)
    .innerJoin(application, eq(application.id, execution.applicationId))
    .where(
      and(
        applicationId ? eq(execution.applicationId, applicationId) : undefined,
        // `http.getUserId` only ever runs on an inbound request, so a job here
        // would only ever be a null-user row padding the count.
        eq(execution.kind, "request"),
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
    applicationName: row.applicationName,
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
async function operationKind(
  db: Db,
  applicationId: string,
  operationRowId: string,
): Promise<"request" | "job"> {
  const rows = await db
    .select({ kind: rollupMinute.kind })
    .from(rollupMinute)
    .where(
      and(
        eq(rollupMinute.applicationId, applicationId),
        eq(rollupMinute.operationRowId, operationRowId),
      ),
    )
    .limit(1);
  return rows[0]?.kind ?? "request";
}

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

  // The operation's own kind drives every sub-query below: a cron handler has an
  // operation row of its own, and its series must count job runs, not requests.
  const kind = await operationKind(db, applicationId, operationRowId);

  const series = await timeseries(db, range, { applicationId, kind, operationRowId });

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
        eq(execution.kind, kind),
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
        eq(execution.kind, kind),
        gte(execution.startedAt, range.from),
        lt(execution.startedAt, range.to),
      ),
    )
    .groupBy(errorGroup.id)
    .orderBy(desc(errorGroup.lastSeen))
    .limit(20);

  return { operation: found, kind, series, slowest, errors };
}

/**
 * One job: everything `/jobs` can only hint at.
 *
 * The list answers "is this queue healthy?"; this answers "what happened to
 * *this* handler, in which run, after how many attempts, and how long did it sit
 * in the queue first". The numbers are deliberately different from the requests
 * page — a job has no status code and no caller, but it does have a wait and an
 * attempt count, and those are where the failures hide:
 *
 *   * **queue wait** (`waitMs`, `enqueuedAt` → `startedAt`) — a job that waited
 *     four minutes and then ran in 10 ms is indistinguishable from a healthy one
 *     on duration alone,
 *   * **attempts** (`attemptsMade` / `maxAttempts`) — a handler that succeeds on
 *     its third try is not a healthy handler, it is a retry storm,
 *   * **failure** — a failed job never opens an error group (upstream's own rule),
 *     so the message lives on the execution and is surfaced from there.
 *
 * The chart reuses `timeseries` with `kind: 'job'`, scoped to the job's own
 * operation row. Ingest keys a job's operation as `<queue>/<name>`, which is what
 * makes one queue+name pair chartable without a new aggregate table.
 */
export async function jobDetail(
  db: Db,
  applicationId: string,
  queue: string,
  jobName: string,
  range: TimeWindow,
  options: { limit?: number } = {},
) {
  // The operation row is the identity of the handler. If it does not exist the
  // job has never run under this application, which is a 404 rather than an
  // empty page — an empty page implies "it ran and did nothing".
  const operationRows = await db
    .select({ id: operation.id, firstSeen: operation.firstSeen, lastSeen: operation.lastSeen })
    .from(operation)
    .where(
      and(
        eq(operation.applicationId, applicationId),
        eq(operation.protocol, "job"),
        eq(operation.operationId, `${queue}/${jobName}`),
      ),
    )
    .limit(1);
  const operationRow = operationRows[0];
  if (!operationRow) return null;

  const inWindow = and(
    eq(execution.applicationId, applicationId),
    eq(execution.kind, "job"),
    eq(execution.queue, queue),
    eq(execution.jobName, jobName),
    gte(execution.startedAt, range.from),
    lt(execution.startedAt, range.to),
  );

  const [stats] = await db
    .select({
      runs: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) FILTER (WHERE ${execution.jobStatus} = 'failed')::int`,
      retried: sql<number>`count(*) FILTER (WHERE ${execution.attemptsMade} > 0)::int`,
      totalAttempts: sql<number>`COALESCE(SUM(${execution.attemptsMade}), 0)::int`,
      maxAttemptsSeen: sql<number | null>`MAX(${execution.maxAttempts})::int`,
      avgMs: sql<number>`COALESCE(AVG(${execution.durationMs}), 0)::float8`,
      p50Ms: sql<number>`COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${execution.durationMs}), 0)::float8`,
      p95Ms: sql<number>`COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY ${execution.durationMs}), 0)::float8`,
      maxMs: sql<number>`COALESCE(MAX(${execution.durationMs}), 0)::float8`,
      avgWaitMs: sql<number>`COALESCE(AVG(${execution.waitMs}), 0)::float8`,
      p95WaitMs: sql<number>`COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY ${execution.waitMs}), 0)::float8`,
      maxWaitMs: sql<number>`COALESCE(MAX(${execution.waitMs}), 0)::float8`,
      firstRunAt: sql<number | null>`MIN(${execution.startedAt})::bigint`,
      lastRunAt: sql<number | null>`MAX(${execution.startedAt})::bigint`,
    })
    .from(execution)
    .where(inWindow);

  const recent = await db
    .select({
      id: execution.id,
      traceId: execution.traceId,
      startedAt: execution.startedAt,
      durationMs: execution.durationMs,
      waitMs: execution.waitMs,
      enqueuedAt: execution.enqueuedAt,
      attemptsMade: execution.attemptsMade,
      maxAttempts: execution.maxAttempts,
      jobStatus: execution.jobStatus,
      error: execution.error,
      spanCount: execution.spanCount,
    })
    .from(execution)
    .where(inWindow)
    .orderBy(desc(execution.startedAt))
    .limit(Math.min(options.limit ?? 50, 200));

  const series = await timeseries(db, range, {
    applicationId,
    kind: "job",
    operationRowId: operationRow.id,
  });

  // Queue wait is the one number the rollup cannot answer: `rollup_minute` has
  // duration histograms but no wait column, so this is a per-bucket aggregate
  // over the runs themselves. It stays one indexed read — a single job handler
  // has tens or hundreds of runs in a window, not millions.
  const waitRows = await db.execute<{
    t: string;
    avg_ms: number | null;
    p95_ms: number | null;
    samples: number;
  }>(sql`
    SELECT ((${execution.startedAt} / ${series.bucketMs}::bigint) * ${series.bucketMs}::bigint)::text AS t,
           AVG(${execution.waitMs})::float8 AS avg_ms,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY ${execution.waitMs})::float8 AS p95_ms,
           count(${execution.waitMs})::int AS samples
      FROM ${execution}
     WHERE ${execution.applicationId} = ${applicationId}
       AND ${execution.kind} = 'job'
       AND ${execution.queue} = ${queue}
       AND ${execution.jobName} = ${jobName}
       AND ${execution.startedAt} >= ${range.from}
       AND ${execution.startedAt} < ${range.to}
       AND ${execution.waitMs} IS NOT NULL
     GROUP BY 1
     ORDER BY 1
  `);

  const runs = Number(stats?.runs ?? 0);
  const failed = Number(stats?.failed ?? 0);
  const retried = Number(stats?.retried ?? 0);
  const totalAttempts = Number(stats?.totalAttempts ?? 0);

  return {
    queue,
    jobName,
    operationRowId: operationRow.id,
    runs,
    completed: runs - failed,
    failed,
    retried,
    totalAttempts,
    failureRate: runs > 0 ? failed / runs : 0,
    /** Extra attempts beyond the first, over runs that needed any. */
    retriesPerRun: retried > 0 ? totalAttempts / runs : 0,
    avgMs: Number(stats?.avgMs ?? 0),
    p50Ms: Number(stats?.p50Ms ?? 0),
    p95Ms: Number(stats?.p95Ms ?? 0),
    maxMs: Number(stats?.maxMs ?? 0),
    avgWaitMs: Number(stats?.avgWaitMs ?? 0),
    p95WaitMs: Number(stats?.p95WaitMs ?? 0),
    maxWaitMs: Number(stats?.maxWaitMs ?? 0),
    maxAttempts: stats?.maxAttemptsSeen === null ? null : Number(stats?.maxAttemptsSeen ?? 0),
    firstRunAt: stats?.firstRunAt === null ? operationRow.firstSeen : Number(stats?.firstRunAt),
    lastRunAt: stats?.lastRunAt === null ? operationRow.lastSeen : Number(stats?.lastRunAt),
    series,
    /** Per-bucket queue wait, from the runs. A bucket with no waits is absent. */
    waitSeries: {
      bucketMs: series.bucketMs,
      points: waitRows.map((row) => ({
        t: Number(row.t),
        avgMs: row.avg_ms === null ? null : Number(row.avg_ms),
        p95Ms: row.p95_ms === null ? null : Number(row.p95_ms),
        samples: Number(row.samples),
      })),
    },
    recent,
  };
}

/** Applications, for the switcher and for the service list. */
export async function applicationById(db: Db, id: string) {
  const rows = await db.select().from(application).where(eq(application.id, id)).limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// SLOs — objectives, error budget, burn rate
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * `*` is "the whole application". The SDK's `@Objective()` always names an
 * operation (the handler it sits on), so this sentinel is only reachable from a
 * dashboard-created SLO.
 */
export const SLO_APP_WIDE = "*";

/**
 * The burn-rate windows the hosted detail page shows, plus the 3-day one its
 * alert policies start from. A burn rate of 1 is "spending the budget exactly
 * on schedule"; 14.4 means a 28-day budget would be gone in about two days.
 */
export const SLO_BURN_WINDOWS = [
  { key: "1h", hours: 1, ms: 3_600_000 },
  { key: "6h", hours: 6, ms: 6 * 3_600_000 },
  { key: "24h", hours: 24, ms: 24 * 3_600_000 },
  { key: "3d", hours: 72, ms: 3 * DAY_MS },
] as const;

export type SloKind = "availability" | "latency" | "job";
export type SloState = "ok" | "at-risk" | "breached" | "no-data";

export interface SloBurn {
  key: string;
  hours: number;
  /** `null` when the sub-window had no measurable events. */
  rate: number | null;
  bad: number;
  total: number;
}

export interface SloEvaluation {
  id: string;
  /** The application the objective is declared on — and the one it measures. */
  applicationId: string;
  applicationName: string;
  name: string | null;
  kind: SloKind;
  target: number;
  underMs: number | null;
  windowDays: number;
  /** Clipped to the retention ceiling when the window outlives it. */
  effectiveWindowDays: number;
  limitedByRetention: boolean;
  source: "code" | "dashboard";
  handler: string | null;
  operationId: string;
  method: string | null;
  releaseId: string | null;
  updatedAt: number;
  sli: {
    good: number;
    total: number;
    bad: number;
    /** `null` for a window with no traffic — not 0, and not 100%. */
    value: number | null;
  };
  budget: {
    allowedBad: number;
    remaining: number;
    /** Fraction of the budget left; negative when over budget, never clamped. */
    remainingFraction: number | null;
    overBudget: boolean;
  };
  burn: SloBurn[];
  state: SloState;
}

/**
 * How long telemetry survives. `0` (the default) is "keep forever", which is
 * the honest ceiling for any compliance window.
 */
export async function retentionDays(db: Db): Promise<number> {
  const row = (
    await db
      .select({ value: instanceSetting.value })
      .from(instanceSetting)
      .where(eq(instanceSetting.key, "retention.traces"))
      .limit(1)
  )[0];
  const value = Number(row?.value);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * The good-event rule for one SLO, as SQL over `execution`.
 *
 * These mirror ingest's `isServerError`:
 *   * availability — a response below 500, or no response and no captured error;
 *   * latency      — a measured duration at or under the threshold;
 *   * job          — not marked failed and no captured error.
 *
 * A client error is good on purpose: a 4xx is an answer the caller can use.
 */
function goodCondition(kind: SloKind, underMs: number | null) {
  if (kind === "latency") {
    return sql`${execution.durationMs} <= ${underMs ?? 0}`;
  }
  if (kind === "job") {
    return sql`(${execution.jobStatus} = 'completed' OR (${execution.jobStatus} IS NULL AND ${execution.error} IS NULL))`;
  }
  return sql`((${execution.statusCode} IS NOT NULL AND ${execution.statusCode} < 500)
    OR (${execution.statusCode} IS NULL AND ${execution.errorGroupId} IS NULL))`;
}

/**
 * Evaluates every SLO for an application, or every SLO in the project when no
 * application is given.
 *
 * One query per SLO rather than one clever query for all of them: a latency SLO
 * has its own threshold, so the aggregate has to be a `FILTER` per objective,
 * and a self-hosted install has a handful, not a thousand. The window is always
 * closed against the retention ceiling — a 28-day objective on a 7-day store
 * would otherwise report 100% from three weeks of missing data.
 *
 * Each objective is evaluated against **its own** application's executions, not
 * against the caller's scope: an SLO is declared on one handler of one service,
 * and a project-wide view must not mix two services' traffic into one verdict.
 */
export async function slos(
  db: Db,
  applicationId?: string,
  now = Date.now(),
): Promise<SloEvaluation[]> {
  const rows = await db
    .select({
      slo,
      applicationName: application.name,
      serviceId: application.serviceId,
    })
    .from(slo)
    .innerJoin(application, eq(application.id, slo.applicationId))
    .where(applicationId ? eq(slo.applicationId, applicationId) : undefined)
    .orderBy(slo.updatedAt, slo.operationId);

  const retention = await retentionDays(db);

  return Promise.all(
    rows.map(async (entry) => {
      const row = entry.slo;
      const kind = row.kind as SloKind;
      const limitedByRetention = retention > 0 && retention < row.windowDays;
      const effectiveWindowDays = limitedByRetention ? retention : row.windowDays;
      const underMs = row.underMs === null ? null : Number(row.underMs);
      const good = goodCondition(kind, underMs);
      const measurable =
        kind === "latency" ? sql`${execution.durationMs} IS NOT NULL` : sql`TRUE`;

      const windows = [
        { key: "window", ms: effectiveWindowDays * DAY_MS },
        ...SLO_BURN_WINDOWS,
      ];
      const fields = windows.flatMap((window) => {
        const from = now - window.ms;
        return [
          sql`COUNT(*) FILTER (WHERE ${execution.startedAt} >= ${from} AND ${measurable})::int AS ${sql.identifier(`total_${window.key}`)}`,
          sql`COUNT(*) FILTER (WHERE ${execution.startedAt} >= ${from} AND ${measurable} AND (${good}))::int AS ${sql.identifier(`good_${window.key}`)}`,
        ];
      });

      const scope =
        row.operationId === SLO_APP_WIDE
          ? sql``
          : sql`AND ${operation.operationId} = ${row.operationId}`;
      const [counts] = await db.execute<Record<string, number>>(sql`
        SELECT ${sql.join(fields, sql`, `)}
          FROM ${execution}
          INNER JOIN ${operation} ON ${operation.id} = ${execution.operationRowId}
         WHERE ${execution.applicationId} = ${row.applicationId}
           AND ${execution.startedAt} >= ${now - windows[0]!.ms}
           AND ${execution.kind} = ${kind === "job" ? "job" : "request"}
           ${scope}
      `);

      const total = Number(counts?.total_window ?? 0);
      const goodCount = Number(counts?.good_window ?? 0);
      const bad = total - goodCount;
      const value = total > 0 ? goodCount / total : null;

      // The error budget is a *reliability* budget: `1 - target` of the events
      // in the window are allowed to fail. It is not money and has nothing to
      // do with the hosted product's plans.
      const allowedBad = total * (1 - row.target / 100);
      const remaining = allowedBad - bad;
      const remainingFraction = allowedBad > 0 ? remaining / allowedBad : null;

      const burn = SLO_BURN_WINDOWS.map((window) => {
        const windowTotal = Number(counts?.[`total_${window.key}`] ?? 0);
        const windowGood = Number(counts?.[`good_${window.key}`] ?? 0);
        const windowBad = windowTotal - windowGood;
        const allowedFraction = 1 - row.target / 100;
        return {
          key: window.key,
          hours: window.hours,
          total: windowTotal,
          bad: windowBad,
          rate:
            windowTotal > 0 && allowedFraction > 0
              ? windowBad / windowTotal / allowedFraction
              : null,
        };
      });

      const sixHour = burn.find((window) => window.key === "6h")?.rate ?? null;
      const overBudget = remaining < 0;
      const state: SloState =
        total === 0
          ? "no-data"
          : overBudget || (value !== null && value * 100 < row.target)
            ? "breached"
            : (remainingFraction !== null && remainingFraction < 0.25) ||
                (sixHour !== null && sixHour > 1)
              ? "at-risk"
              : "ok";

      return {
        id: row.id,
        applicationId: row.applicationId,
        applicationName: entry.applicationName ?? entry.serviceId,
        name: row.name,
        kind,
        target: row.target,
        underMs,
        windowDays: row.windowDays,
        effectiveWindowDays,
        limitedByRetention,
        source: row.source,
        handler: row.handler,
        operationId: row.operationId,
        method: row.method,
        releaseId: row.releaseId,
        updatedAt: row.updatedAt,
        sli: { good: goodCount, total, bad, value },
        budget: { allowedBad, remaining, remainingFraction, overBudget },
        burn,
        state,
      };
    }),
  );
}

export interface CreateSloInput {
  name?: string;
  kind: SloKind;
  target: number;
  underMs?: number;
  windowDays?: number;
  operationId?: string;
}

/**
 * Creates or updates a dashboard-owned SLO.
 *
 * A code-owned objective wins: the decorator is the source of truth and the next
 * deploy would overwrite the dashboard's edit anyway, so the API refuses rather
 * than pretending it took.
 */
export async function createSlo(
  db: Db,
  applicationId: string,
  input: CreateSloInput,
  now = Date.now(),
): Promise<{ kind: "created" | "updated"; id: string } | { kind: "code-owned" }> {
  const operationId = (input.operationId?.trim() || SLO_APP_WIDE).slice(0, 255);
  const underMs = input.kind === "latency" ? (input.underMs ?? null) : null;
  const windowDays = input.windowDays ?? 28;

  const existing = (
    await db
      .select({ id: slo.id, source: slo.source })
      .from(slo)
      .where(
        and(
          eq(slo.applicationId, applicationId),
          eq(slo.operationId, operationId),
          eq(slo.kind, input.kind),
          underMs === null ? isNull(slo.underMs) : eq(slo.underMs, underMs),
        ),
      )
      .limit(1)
  )[0];

  if (existing) {
    if (existing.source === "code") return { kind: "code-owned" };
    await db
      .update(slo)
      .set({
        name: input.name ?? null,
        target: input.target,
        windowDays,
        updatedAt: now,
      })
      .where(eq(slo.id, existing.id));
    return { kind: "updated", id: existing.id };
  }

  const id = Bun.randomUUIDv7();
  await db.insert(slo).values({
    id,
    applicationId,
    operationId,
    method: null,
    name: input.name ?? null,
    kind: input.kind,
    target: input.target,
    underMs,
    windowDays,
    source: "dashboard",
    handler: null,
    releaseId: null,
    updatedAt: now,
  });
  return { kind: "created", id };
}

/** Deletes a dashboard SLO. A code-declared objective is owned by the deploy. */
export async function deleteSlo(
  db: Db,
  applicationId: string,
  id: string,
): Promise<"deleted" | "not-found" | "code-owned"> {
  const row = (
    await db
      .select({ source: slo.source })
      .from(slo)
      .where(and(eq(slo.id, id), eq(slo.applicationId, applicationId)))
      .limit(1)
  )[0];
  if (!row) return "not-found";
  if (row.source === "code") return "code-owned";
  await db.delete(slo).where(eq(slo.id, id));
  return "deleted";
}
