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
 *
 * **A job is not a request.** `rollup_minute` carries both kinds in the same
 * table, so every request-facing aggregate in this file filters
 * `kind = 'request'` — otherwise a nightly cron inflates request rate, error
 * rate, average duration and p95, and the overview quietly lies. Job numbers
 * live in `Analytics.jobs` and on `/jobs`, and never here. `histKey` keeps a
 * merged histogram from blending the two populations.
 */
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
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

/**
 * Map key for a merged histogram: kind + group.
 *
 * One `operation_row_id` can carry both kinds (an `@Cron()` handler has the same
 * operation row every run), so keying by group alone would fold job durations
 * into a request's p95. `\u0000` cannot appear in a uuid or in either kind.
 */
function histKey(kind: string, group: string): string {
  return `${kind}\u0000${group}`;
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
 * Per-group merged duration histograms: one row per (kind, group, bucket).
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
  const rows = await db.execute<{
    kind: string;
    group_key: string;
    idx: number;
    total: number;
  }>(sql`
    SELECT rm.kind AS kind,
           ${sql.raw(groupColumn)}::text AS group_key,
           u.idx::int AS idx,
           SUM(u.value)::int AS total
      FROM rollup_minute rm,
           LATERAL unnest(rm.duration_hist) WITH ORDINALITY AS u(value, idx)
     WHERE rm.at >= ${range.from} AND rm.at < ${range.to}
       ${applicationId ? sql`AND rm.application_id = ${applicationId}` : sql``}
     GROUP BY 1, 2, 3
  `);

  const merged = new Map<string, number[]>();
  for (const row of rows) {
    const key = histKey(row.kind, row.group_key);
    const existing = merged.get(key) ?? [];
    existing[Number(row.idx) - 1] = Number(row.total);
    merged.set(key, existing);
  }
  return merged;
}

/**
 * Where a hop starts, on the trace's clock.
 *
 * `execution.startedAt` is the **collector's** ingest timestamp, and a trace's
 * hops arrive in whatever order each service's agent flushes — so ordering by it
 * puts a worker that ran after an API call before the call it served. The agent
 * sends its own start time (`calledAt`, the wire's `c`); that is the only value
 * that can order hops causally, and it is advisory because it comes from another
 * machine's clock.
 *
 * So: trust it when it is plausible (within an hour of ingestion — a real clock
 * skew between two boxes is seconds, not hours, while a broken or absent value is
 * wildly off), and fall back to the collector's own clock when it is not. Never
 * throw the hop away: a hop with an unusable timestamp still belongs to the trace.
 */
function hopStartsAt(startedAt: number, calledAt: string | null): number {
  if (!calledAt) return startedAt;
  const parsed = Date.parse(calledAt);
  if (!Number.isFinite(parsed)) return startedAt;
  if (Math.abs(startedAt - parsed) > 3_600_000) return startedAt;
  return parsed;
}

export abstract class Telemetry {
  /**
   * Applications with their window aggregates.
   *
   * Two queries, not N+1 and not one clever one: the scalar aggregates are a
   * plain GROUP BY, and the histograms come from a lateral `unnest` bucketed by
   * index. Postgres cannot nest the aggregate that needs, and doing it in JS
   * keeps the SQL readable — the row count is per-bucket, so it is tiny.
   *
   * `kind = 'request'` is part of the join, not a filter after the fact: the
   * applications list is the "how are my endpoints doing" view, and a job is
   * not an endpoint. `/jobs` answers the job question.
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
            eq(rollupMinute.kind, "request"),
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
        p95DurationMs: percentileFromHistogram(histogramRows.get(histKey("request", row.id)), 0.95),
      };
    });
  }

  /**
   * Operations ranked by volume.
   *
   * `kind` defaults to `request`. A job handler is a different question
   * (throughput, queue wait, retries → `/jobs`), so mixing the two into one
   * "Calls" column would double-count traffic an operator never asked for.
   *
   * `applicationId` is optional: omitted means **the whole project**, which is
   * what the dashboard's "All applications" selector asks for. Every row carries
   * the application it belongs to, because in that view two rows named
   * `POST /orders` from two services are two different things.
   */
  static async operations(
    db: Db,
    range: TimeWindow,
    options: { applicationId?: string; limit?: number; kind?: "request" | "job" } = {},
  ) {
    const kind = options.kind ?? "request";
    const limit = options.limit ?? 100;
    const [rows, histogramRows] = await Promise.all([
      db
        .select({
          operationRowId: rollupMinute.operationRowId,
          kind: rollupMinute.kind,
          applicationId: rollupMinute.applicationId,
          applicationName: application.name,
          serviceId: application.serviceId,
          operationId: operation.operationId,
          method: operation.method,
          customName: operation.customName,
          count: sql<number>`COALESCE(SUM(${rollupMinute.count}), 0)::int`,
          errors: sql<number>`COALESCE(SUM(${rollupMinute.errorCount}), 0)::int`,
          durationSum: sql<number>`COALESCE(SUM(${rollupMinute.durationSum}), 0)::float8`,
        })
        .from(rollupMinute)
        .innerJoin(operation, eq(operation.id, rollupMinute.operationRowId))
        .innerJoin(application, eq(application.id, rollupMinute.applicationId))
        .where(
          and(
            options.applicationId
              ? eq(rollupMinute.applicationId, options.applicationId)
              : undefined,
            eq(rollupMinute.kind, kind),
            gte(rollupMinute.at, range.from),
            lt(rollupMinute.at, range.to),
          ),
        )
        .groupBy(
          rollupMinute.operationRowId,
          rollupMinute.kind,
          rollupMinute.applicationId,
          application.name,
          application.serviceId,
          operation.operationId,
          operation.method,
          operation.customName,
        )
        .orderBy(desc(sql`SUM(${rollupMinute.count})`))
        .limit(limit),
      histogram(db, "operation_row_id", range, options.applicationId),
    ]);

    return rows.map((row) => ({
      ...row,
      applicationName: row.applicationName ?? row.serviceId,
      count: Number(row.count),
      errors: Number(row.errors),
      durationSum: Number(row.durationSum),
      avgDurationMs: Number(row.count) > 0 ? Number(row.durationSum) / Number(row.count) : 0,
      // Keyed by kind: the same operation row can serve both a request handler
      // and a cron, and their durations must not blend into one p95.
      p95DurationMs: percentileFromHistogram(
        histogramRows.get(histKey(row.kind, row.operationRowId)),
        0.95,
      ),
    }));
  }

  /**
   * Executions in a window, keyset paginated on `(startedAt, id)`.
   *
   * Keyset rather than OFFSET: new rows arrive while the user pages, and an
   * offset cursor silently repeats or skips them. No `applicationId` means the
   * whole project — and then each row names its application, because an
   * execution list without that column is unreadable across services.
   */
  static async executions(
    db: Db,
    range: TimeWindow,
    options: {
      applicationId?: string;
      limit?: number;
      cursor?: string;
      operationRowId?: string;
      kind?: "request" | "job";
    } = {},
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
        applicationId: execution.applicationId,
        applicationName: application.name,
        serviceId: application.serviceId,
        operationId: operation.operationId,
        method: operation.method,
        queue: execution.queue,
        jobName: execution.jobName,
      })
      .from(execution)
      .innerJoin(application, eq(application.id, execution.applicationId))
      .leftJoin(operation, eq(operation.id, execution.operationRowId))
      .where(
        and(
          options.applicationId
            ? eq(execution.applicationId, options.applicationId)
            : undefined,
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

    return {
      items: rows.map((row) => ({
        ...row,
        applicationName: row.applicationName ?? row.serviceId,
      })),
      nextCursor: rows.at(-1)?.id ?? null,
    };
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

    // The execution carries `operationRowId`; the waterfall header wants the
    // operation's own name and method, so it is joined here rather than in the
    // browser.
    const operationRow = row.operationRowId
      ? (
          await db
            .select()
            .from(operation)
            .where(eq(operation.id, row.operationRowId))
            .limit(1)
        )[0] ?? null
      : null;

    const error = row.errorGroupId
      ? (
          await db
            .select()
            .from(errorGroup)
            .where(eq(errorGroup.id, row.errorGroupId))
            .limit(1)
        )[0] ?? null
      : null;

    return { execution: row, operation: operationRow, spans, logs, error };
  }

  /**
   * Every execution sharing a trace id — the cross-service trace.
   *
   * This is the distributed-tracing surface: one id, every hop that carried it,
   * in wall-clock order, each with its own span tree. Three joins and one extra
   * query, not N+1:
   *
   *   * `application` — a waterfall that says "svc #2" is useless; the point of a
   *     trace is *which service* made the call,
   *   * `operation` — the handler name, so a row reads `POST /orders` and not a uuid,
   *   * `span` — one query for all of them, grouped in JS. The rows are per span,
   *     not per trace, so a 40-span trace costs 40 rows and one round trip.
   *
   * Jobs are included where they share the id (a BullMQ consumer inherits the
   * producer's trace): that is the whole reason a "did the request's background
   * work finish?" question is answerable. They are labelled with `kind` so the
   * viewer can never mistake one for an inbound request.
   */
  static async trace(db: Db, traceId: string) {
    const rows = await db
      .select({
        execution,
        applicationName: application.name,
        serviceId: application.serviceId,
        operationId: operation.operationId,
        method: operation.method,
        customName: operation.customName,
        protocol: operation.protocol,
      })
      .from(execution)
      .innerJoin(application, eq(application.id, execution.applicationId))
      .leftJoin(operation, eq(operation.id, execution.operationRowId))
      .where(eq(execution.traceId, traceId))
      .orderBy(execution.startedAt);
    if (rows.length === 0) return null;

    const spans = await db
      .select()
      .from(span)
      .where(
        inArray(
          span.executionId,
          rows.map((row) => row.execution.id),
        ),
      )
      .orderBy(span.executionId, span.depth, span.seq);

    const spansByExecution = new Map<string, typeof spans>();
    for (const row of spans) {
      const list = spansByExecution.get(row.executionId) ?? [];
      list.push(row);
      spansByExecution.set(row.executionId, list);
    }

    const logs = await db
      .select()
      .from(logEntry)
      .where(eq(logEntry.traceId, traceId))
      .orderBy(logEntry.occurredAt)
      .limit(1000);

    // The trace's own clock starts at its first hop and ends at its last — not at
    // the sum of the durations, which would double-count the overlap between a
    // parent and a child that ran inside it.
    const hops = rows
      .map((row) => ({
        execution: row.execution,
        applicationName: row.applicationName ?? row.serviceId,
        serviceId: row.serviceId,
        operation:
          row.operationId === null
            ? null
            : {
                operationId: row.operationId,
                method: row.method,
                customName: row.customName,
                protocol: row.protocol,
              },
        spans: spansByExecution.get(row.execution.id) ?? [],
        /**
         * The hop's start on the trace's clock, which is **not**
         * `execution.startedAt`: that is the collector's ingest time, and batches
         * from different services arrive in whatever order their flush timers
         * fire. In this repo's own dev data a worker hop lands before the API hop
         * it demonstrably ran after. The agent's own timestamp (`calledAt`) is
         * what makes gateway → api → worker read as gateway → api → worker.
         */
        startsAt: hopStartsAt(Number(row.execution.startedAt), row.execution.calledAt),
      }))
      // Stable on `id` so two hops that start in the same millisecond do not
      // swap places between polls.
      .sort((a, b) => a.startsAt - b.startsAt || a.execution.id.localeCompare(b.execution.id));

    const startsAt = hops.map((hop) => hop.startsAt);
    const endsAt = hops.map((hop) => hop.startsAt + Number(hop.execution.durationMs ?? 0));
    const first = Math.min(...startsAt);
    const last = Math.max(...endsAt);

    const applications = new Map<string, { id: string; name: string; serviceId: string }>();
    for (const row of rows) {
      applications.set(row.execution.applicationId, {
        id: row.execution.applicationId,
        name: row.applicationName ?? row.serviceId,
        serviceId: row.serviceId,
      });
    }

    return {
      traceId,
      startedAt: first,
      durationMs: Number.isFinite(last - first) ? last - first : null,
      applications: [...applications.values()],
      executions: hops,
      // The application each log line came from, so the viewer can group them
      // without a second lookup table of its own.
      logs: logs.map((entry) => ({
        ...entry,
        applicationName:
          applications.get(entry.applicationId)?.name ?? entry.applicationId,
      })),
    };
  }

  /**
   * Error groups, newest first.
   *
   * Optional `applicationId` = the whole project. The row keeps its
   * `applicationId` (it is a column) and gains the application's name, which is
   * the difference between an error inbox and a list of columns called `post`.
   */
  static async errors(
    db: Db,
    options: {
      applicationId?: string;
      status?: "open" | "resolved" | "ignored";
      limit?: number;
    } = {},
  ) {
    const rows = await db
      .select({ errorGroup, applicationName: application.name, serviceId: application.serviceId })
      .from(errorGroup)
      .innerJoin(application, eq(application.id, errorGroup.applicationId))
      .where(
        and(
          options.applicationId
            ? eq(errorGroup.applicationId, options.applicationId)
            : undefined,
          options.status ? eq(errorGroup.status, options.status) : undefined,
        ),
      )
      .orderBy(desc(errorGroup.lastSeen))
      .limit(Math.min(options.limit ?? 50, 200));

    return rows.map((row) => ({
      ...row.errorGroup,
      applicationName: row.applicationName ?? row.serviceId,
    }));
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

  /**
   * Log lines, newest first. Optional `applicationId` = the whole project, with
   * each line naming the application that wrote it: a merged log stream without
   * that column is noise.
   */
  static async logs(
    db: Db,
    range: TimeWindow,
    options: {
      applicationId?: string;
      level?: string;
      traceId?: string;
      limit?: number;
    } = {},
  ) {
    const rows = await db
      .select({ logEntry, applicationName: application.name, serviceId: application.serviceId })
      .from(logEntry)
      .innerJoin(application, eq(application.id, logEntry.applicationId))
      .where(
        and(
          options.applicationId
            ? eq(logEntry.applicationId, options.applicationId)
            : undefined,
          gte(logEntry.occurredAt, range.from),
          lt(logEntry.occurredAt, range.to),
          options.level ? sql`${logEntry.level} = ${options.level}` : undefined,
          options.traceId ? eq(logEntry.traceId, options.traceId) : undefined,
        ),
      )
      .orderBy(desc(logEntry.occurredAt))
      .limit(Math.min(options.limit ?? 100, 500));

    return rows.map((row) => ({
      ...row.logEntry,
      applicationName: row.applicationName ?? row.serviceId,
    }));
  }

  static async releases(db: Db, applicationId: string) {
    return db
      .select()
      .from(release)
      .where(eq(release.applicationId, applicationId))
      .orderBy(desc(release.lastSeen));
  }
}
