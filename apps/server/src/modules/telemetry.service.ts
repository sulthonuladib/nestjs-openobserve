/**
 * Read-side services.
 *
 * Every function here is decoupled from Elysia on purpose: they take plain
 * arguments and return plain objects, so they can be called from a test, a cron
 * job or an MCP tool without constructing a request context.
 *
 * Aggregates come from `rollup_minute`, never from `execution`. The overview
 * page is the first thing that loads and must stay O(minutes in range), not
 * O(events in range) — that difference is the whole reason the rollup table
 * exists.
 */
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../plugins/database";
import {
  application,
  errorGroup,
  errorOccurrence,
  execution,
  logEntry,
  operation,
  release,
  rollupMinute,
  span,
} from "../db/schema";

export interface TimeWindow {
  readonly from: number;
  readonly to: number;
}

export const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

export function window(from?: number, to?: number): TimeWindow {
  const end = to ?? Date.now();
  return { from: from ?? end - DEFAULT_WINDOW_MS, to: end };
}

/**
 * p95 out of a merged log-scale histogram.
 *
 * Interpolating inside the bucket rather than returning its upper bound keeps
 * the number honest at the low end, where most requests live: a bucket spanning
 * 1–1.26 ms should not report 1.26.
 */
export function percentileFromHistogram(
  histogram: number[] | null | undefined,
  quantile: number,
): number | null {
  if (!histogram?.length) return null;
  const total = histogram.reduce((sum, value) => sum + value, 0);
  if (total === 0) return null;

  const target = total * quantile;
  let seen = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    const count = histogram[index] ?? 0;
    if (seen + count >= target) {
      const upper = 2 ** (index / 3);
      const lower = index === 0 ? 0 : 2 ** ((index - 1) / 3);
      const within = count === 0 ? 0 : (target - seen) / count;
      return lower + (upper - lower) * within;
    }
    seen += count;
  }
  return 2 ** ((histogram.length - 1) / 3);
}

/** Sums per-minute histograms into one, for a merged window. */
export function mergeHistograms(histograms: Array<number[] | null>): number[] {
  const merged: number[] = [];
  for (const histogram of histograms) {
    if (!histogram) continue;
    histogram.forEach((value, index) => {
      merged[index] = (merged[index] ?? 0) + value;
    });
  }
  return merged;
}


/**
 * Per-group merged duration histograms: one row per (group, bucket).
 *
 * `unnest ... WITH ORDINALITY` turns the 25-slot array into rows so Postgres can
 * SUM by bucket; merging in JS afterwards is then trivial and exact, which is
 * what makes p95 over an arbitrary window trustworthy.
 */
async function histogram(
  db: Db,
  groupColumn: "application_id" | "operation_row_id",
  range: TimeWindow,
  applicationId?: string,
): Promise<Map<string, number[]>> {
  const rows = await db.execute<{ group_key: string; idx: number; total: number }>(sql`
    SELECT ${sql.raw(groupColumn)}::text AS group_key,
           u.idx::int AS idx,
           SUM(u.value)::int AS total
      FROM rollup_minute rm,
           LATERAL unnest(rm.duration_hist) WITH ORDINALITY AS u(value, idx)
     WHERE rm.at >= ${range.from} AND rm.at < ${range.to}
       ${applicationId ? sql`AND rm.application_id = ${applicationId}` : sql``}
     GROUP BY 1, 2
  `);

  const merged = new Map<string, number[]>();
  for (const row of rows) {
    const existing = merged.get(row.group_key) ?? [];
    existing[Number(row.idx) - 1] = Number(row.total);
    merged.set(row.group_key, existing);
  }
  return merged;
}

export abstract class Telemetry {
  /**
   * Applications with their window aggregates.
   *
   * Two queries, not N+1 and not one clever one: the scalar aggregates are a
   * plain GROUP BY, and the histograms come from a lateral `unnest` bucketed by
   * index. Postgres cannot nest the aggregate that needs, and doing it in JS
   * keeps the SQL readable — the row count is per-bucket, so it is tiny.
   */
  static async applications(db: Db, range: TimeWindow) {
    const [rows, histogramRows] = await Promise.all([
      db
        .select({
          id: application.id,
          serviceId: application.serviceId,
          name: application.name,
          lastSeen: application.lastSeen,
          requests: sql<number>`COALESCE(SUM(${rollupMinute.count}), 0)::int`,
          errors: sql<number>`COALESCE(SUM(${rollupMinute.errorCount}), 0)::int`,
          durationSum: sql<number>`COALESCE(SUM(${rollupMinute.durationSum}), 0)::float8`,
        })
        .from(application)
        .leftJoin(
          rollupMinute,
          and(
            eq(rollupMinute.applicationId, application.id),
            gte(rollupMinute.at, range.from),
            lt(rollupMinute.at, range.to),
          ),
        )
        .groupBy(application.id)
        .orderBy(desc(application.lastSeen)),
      histogram(db, "application_id", range),
    ]);

    return rows.map((row) => {
      const requests = Number(row.requests ?? 0);
      return {
        id: row.id,
        serviceId: row.serviceId,
        name: row.name ?? row.serviceId,
        lastSeen: row.lastSeen,
        requests,
        errorRate: requests > 0 ? Number(row.errors ?? 0) / requests : 0,
        avgDurationMs: requests > 0 ? Number(row.durationSum ?? 0) / requests : 0,
        p95DurationMs: percentileFromHistogram(histogramRows.get(row.id), 0.95),
      };
    });
  }

  static async operations(db: Db, applicationId: string, range: TimeWindow, limit = 100) {
    const [rows, histogramRows] = await Promise.all([
      db
        .select({
          operationRowId: rollupMinute.operationRowId,
          kind: rollupMinute.kind,
          operationId: operation.operationId,
          method: operation.method,
          customName: operation.customName,
          count: sql<number>`COALESCE(SUM(${rollupMinute.count}), 0)::int`,
          errors: sql<number>`COALESCE(SUM(${rollupMinute.errorCount}), 0)::int`,
          durationSum: sql<number>`COALESCE(SUM(${rollupMinute.durationSum}), 0)::float8`,
        })
        .from(rollupMinute)
        .innerJoin(operation, eq(operation.id, rollupMinute.operationRowId))
        .where(
          and(
            eq(rollupMinute.applicationId, applicationId),
            gte(rollupMinute.at, range.from),
            lt(rollupMinute.at, range.to),
          ),
        )
        .groupBy(
          rollupMinute.operationRowId,
          rollupMinute.kind,
          operation.operationId,
          operation.method,
          operation.customName,
        )
        .orderBy(desc(sql`SUM(${rollupMinute.count})`))
        .limit(limit),
      histogram(db, "operation_row_id", range, applicationId),
    ]);

    return rows.map((row) => ({
      ...row,
      count: Number(row.count),
      errors: Number(row.errors),
      durationSum: Number(row.durationSum),
      avgDurationMs: Number(row.count) > 0 ? Number(row.durationSum) / Number(row.count) : 0,
      p95DurationMs: percentileFromHistogram(histogramRows.get(row.operationRowId), 0.95),
    }));
  }

  /**
   * Executions in a window, keyset paginated on `(startedAt, id)`.
   *
   * Keyset rather than OFFSET: new rows arrive while the user pages, and an
   * offset cursor silently repeats or skips them.
   */
  static async executions(
    db: Db,
    applicationId: string,
    range: TimeWindow,
    options: { limit?: number; cursor?: string; operationRowId?: string; kind?: "request" | "job" } = {},
  ) {
    const limit = Math.min(options.limit ?? 50, 200);
    const rows = await db
      .select({
        id: execution.id,
        kind: execution.kind,
        protocol: execution.protocol,
        traceId: execution.traceId,
        startedAt: execution.startedAt,
        durationMs: execution.durationMs,
        statusCode: execution.statusCode,
        errorGroupId: execution.errorGroupId,
        spanCount: execution.spanCount,
        operationId: operation.operationId,
        method: operation.method,
        queue: execution.queue,
        jobName: execution.jobName,
      })
      .from(execution)
      .leftJoin(operation, eq(operation.id, execution.operationRowId))
      .where(
        and(
          eq(execution.applicationId, applicationId),
          gte(execution.startedAt, range.from),
          lt(execution.startedAt, range.to),
          options.operationRowId
            ? eq(execution.operationRowId, options.operationRowId)
            : undefined,
          options.kind ? eq(execution.kind, options.kind) : undefined,
        ),
      )
      .orderBy(desc(execution.startedAt), desc(execution.id))
      .limit(limit);

    return { items: rows, nextCursor: rows.at(-1)?.id ?? null };
  }

  static async executionDetail(db: Db, executionId: string) {
    const rows = await db
      .select()
      .from(execution)
      .where(eq(execution.id, executionId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;

    const spans = await db
      .select()
      .from(span)
      .where(eq(span.executionId, executionId))
      .orderBy(span.depth, span.seq);

    // Logs are correlated by trace id, not by execution: that is what makes a
    // log line written three services away show up under the request.
    const logs = await db
      .select()
      .from(logEntry)
      .where(eq(logEntry.traceId, row.traceId))
      .orderBy(logEntry.occurredAt)
      .limit(500);

    const error = row.errorGroupId
      ? (
          await db
            .select()
            .from(errorGroup)
            .where(eq(errorGroup.id, row.errorGroupId))
            .limit(1)
        )[0] ?? null
      : null;

    return { execution: row, spans, logs, error };
  }

  /** Every execution sharing a trace id — the cross-service waterfall. */
  static async trace(db: Db, traceId: string) {
    const executions = await db
      .select()
      .from(execution)
      .where(eq(execution.traceId, traceId))
      .orderBy(execution.startedAt);
    if (executions.length === 0) return null;

    const logs = await db
      .select()
      .from(logEntry)
      .where(eq(logEntry.traceId, traceId))
      .orderBy(logEntry.occurredAt)
      .limit(1000);

    return { executions, logs };
  }

  static async errors(
    db: Db,
    applicationId: string,
    options: { status?: "open" | "resolved" | "ignored"; limit?: number } = {},
  ) {
    return db
      .select()
      .from(errorGroup)
      .where(
        and(
          eq(errorGroup.applicationId, applicationId),
          options.status ? eq(errorGroup.status, options.status) : undefined,
        ),
      )
      .orderBy(desc(errorGroup.lastSeen))
      .limit(Math.min(options.limit ?? 50, 200));
  }

  static async errorDetail(db: Db, errorId: string) {
    const group = (
      await db.select().from(errorGroup).where(eq(errorGroup.id, errorId)).limit(1)
    )[0];
    if (!group) return null;

    const occurrences = await db
      .select()
      .from(errorOccurrence)
      .where(eq(errorOccurrence.errorGroupId, errorId))
      .orderBy(desc(errorOccurrence.occurredAt))
      .limit(50);

    return { group, occurrences };
  }

  static async logs(
    db: Db,
    applicationId: string,
    range: TimeWindow,
    options: { level?: string; traceId?: string; limit?: number } = {},
  ) {
    return db
      .select()
      .from(logEntry)
      .where(
        and(
          eq(logEntry.applicationId, applicationId),
          gte(logEntry.occurredAt, range.from),
          lt(logEntry.occurredAt, range.to),
          options.level ? sql`${logEntry.level} = ${options.level}` : undefined,
          options.traceId ? eq(logEntry.traceId, options.traceId) : undefined,
        ),
      )
      .orderBy(desc(logEntry.occurredAt))
      .limit(Math.min(options.limit ?? 100, 500));
  }

  static async releases(db: Db, applicationId: string) {
    return db
      .select()
      .from(release)
      .where(eq(release.applicationId, applicationId))
      .orderBy(desc(release.lastSeen));
  }
}
