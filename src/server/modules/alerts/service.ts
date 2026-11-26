/**
 * Alerts: the rules, the evaluator, and the event history.
 *
 * This is the first thing in the collector that needs a **clock**. Everything
 * else is computed when a page asks; an alert has to fire while nobody is
 * looking, so `evaluateRules` runs on a timer (see `app.ts`) as well as on demand
 * (`POST /api/v1/alerts/evaluate`, which is also how the test suite drives it).
 *
 * The model is deliberately small and honest:
 *
 *   * **A rule is a metric + a window + a comparison.** `metric` names what to
 *     measure (`request.error_rate`, `job.p95_wait`, `absence.requests`, …),
 *     `windowS` how far back to look, `comparator`/`threshold` the judgement.
 *   * **Two detections share that shape.** `threshold` compares the number with
 *     the rule's threshold; `anomaly` compares it with the mean of the previous
 *     six windows, `sigma` standard deviations out. A baseline with fewer than
 *     two windows is not a baseline — the rule stays quiet rather than firing on
 *     its own first measurement.
 *   * **No data is not OK and not Firing.** A metric that cannot be measured
 *     (`null`) never opens an event, and never closes one either: resolving an
 *     incident because telemetry stopped is exactly backwards. Silence is its own
 *     rule kind (`absence.*`), where "minutes since the last event" is the number.
 *   * **Muted is not resolved.** Quiet hours (`quietHours`) or a manual mute
 *     (`mutedUntil`) still records the firing — it just skips delivery — because
 *     an operator who wakes up needs to know what happened overnight.
 *   * **Transitions, not snapshots.** One row per change: `firing` then
 *     `resolved`. The open event is the firing row whose `resolvedAt` is null.
 *
 * Channels are in-app (the event itself) plus webhooks (`{ type: "webhook", url }`,
 * and Slack incoming webhooks are the same thing). Email is not implemented: the
 * build has no SMTP client, so a rule that asks for email gets a delivery record
 * saying why it was skipped instead of a silent no-op.
 */
import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../../plugins/database";
import {
  alertEvent,
  alertRule,
  errorGroup,
  execution,
  logEntry,
  metricPoint,
  metricSeries,
  rollupMinute,
  runtimeSample,
  slo,
} from "../../db/schema";
import { percentileFromHistogram } from "../telemetry.service";
import { slos } from "../analytics.service";

export type AlertMetric =
  | "request.error_rate"
  | "request.p95"
  | "request.avg"
  | "request.throughput"
  | "job.failure_rate"
  | "job.p95_wait"
  | "job.throughput"
  | "absence.requests"
  | "absence.jobs"
  | "error.new"
  | "error.unhandled"
  | "log.pattern"
  | "custom.metric"
  | "runtime.event_loop"
  | "runtime.cpu"
  | "runtime.memory"
  | "slo.burn";

export type Comparator = "above" | "below";
export type Severity = "low" | "medium" | "high" | "critical";
export type Detection = "threshold" | "anomaly";
export type RuleState = "firing" | "ok" | "no-data" | "muted";

/** The units the UI prints. The evaluator never converts; it reports the unit. */
export type AlertUnit = "ratio" | "ms" | "per_min" | "count" | "minutes" | "percent" | "bad";

export interface RuleScope {
  applicationId?: string;
  operationId?: string;
  queueName?: string;
  customMetricName?: string;
  logPattern?: string;
  logLevels?: string[];
  sloId?: string;
}

export interface Measured {
  /** `null` means "cannot be measured" — never treated as 0. */
  value: number | null;
  unit: AlertUnit;
  /** How many observations the value is based on; 0 with a non-null value is a bug. */
  samples: number;
}

export const METRIC_UNITS: Record<AlertMetric, AlertUnit> = {
  "request.error_rate": "ratio",
  "request.p95": "ms",
  "request.avg": "ms",
  "request.throughput": "per_min",
  "job.failure_rate": "ratio",
  "job.p95_wait": "ms",
  "job.throughput": "per_min",
  "absence.requests": "minutes",
  "absence.jobs": "minutes",
  "error.new": "count",
  "error.unhandled": "count",
  "log.pattern": "count",
  "custom.metric": "count",
  "runtime.event_loop": "ms",
  "runtime.cpu": "percent",
  "runtime.memory": "count",
  "slo.burn": "bad",
};

/** Every metric the evaluator can measure, for the UI's picker and validation. */
export const ALERT_METRICS = Object.keys(METRIC_UNITS) as AlertMetric[];

/**
 * The window length used for the anomaly baseline, and how many of them.
 *
 * Six is upstream's default shape in spirit: enough to see a weekly rhythm's
 * shoulder, few enough that one bad minute does not become the baseline.
 */
const BASELINE_WINDOWS = 6;

const WINDOW_CHOICES = [300, 600, 900, 1800, 3600, 10800] as const;

export function isWindowChoice(seconds: number): boolean {
  return (WINDOW_CHOICES as readonly number[]).includes(seconds);
}

/**
 * Measure one rule's metric over one window.
 *
 * Every query is scoped by the rule's application (when it has one) and by the
 * scope keys the metric understands. `samples === 0` with a non-null `value` never
 * happens: a metric with no observations returns `null`.
 */
async function measure(
  db: Db,
  rule: { metric: string; applicationId: string | null; scope: Record<string, unknown> },
  from: number,
  to: number,
): Promise<Measured> {
  const metric = rule.metric as AlertMetric;
  const unit = METRIC_UNITS[metric] ?? "count";
  const scope = (rule.scope ?? {}) as RuleScope;
  const applicationId = rule.applicationId ?? undefined;
  const minutes = Math.max((to - from) / 60_000, 1 / 60);

  switch (metric) {
    case "request.error_rate":
    case "request.avg":
    case "request.throughput": {
      const [row] = await db.execute<{ count: number; errors: number; duration: number }>(sql`
        SELECT COALESCE(SUM(rm.count), 0)::int AS count,
               COALESCE(SUM(rm.error_count), 0)::int AS errors,
               COALESCE(SUM(rm.duration_sum), 0)::float8 AS duration
          FROM rollup_minute rm
          INNER JOIN operation o ON o.id = rm.operation_row_id
         WHERE rm.kind = 'request' AND rm.at >= ${from} AND rm.at < ${to}
           ${applicationId ? sql`AND rm.application_id = ${applicationId}` : sql``}
           ${scope.operationId ? sql`AND o.operation_id = ${scope.operationId}` : sql``}
      `);
      const count = Number(row?.count ?? 0);
      if (count === 0) return { value: null, unit, samples: 0 };
      if (metric === "request.error_rate") {
        return { value: Number(row!.errors) / count, unit, samples: count };
      }
      if (metric === "request.avg") {
        return { value: Number(row!.duration) / count, unit, samples: count };
      }
      return { value: count / minutes, unit, samples: count };
    }

    case "request.p95": {
      // The same merged-histogram rule the charts use: p95 over a window is not
      // the average of per-minute p95s. Summing by bucket slot is what makes it
      // a real percentile.
      const rows = await db.execute<{ idx: number; total: number }>(sql`
        SELECT u.idx::int AS idx, SUM(u.value)::int AS total
          FROM rollup_minute rm,
               LATERAL unnest(rm.duration_hist) WITH ORDINALITY AS u(value, idx)
          INNER JOIN operation o ON o.id = rm.operation_row_id
         WHERE rm.kind = 'request' AND rm.at >= ${from} AND rm.at < ${to}
           ${applicationId ? sql`AND rm.application_id = ${applicationId}` : sql``}
           ${scope.operationId ? sql`AND o.operation_id = ${scope.operationId}` : sql``}
         GROUP BY 1
      `);
      if (rows.length === 0) return { value: null, unit, samples: 0 };
      const histogram: number[] = [];
      for (const row of rows) histogram[Number(row.idx) - 1] = Number(row.total);
      const samples = histogram.reduce((sum, value) => sum + (value ?? 0), 0);
      if (samples === 0) return { value: null, unit, samples: 0 };
      return { value: percentileFromHistogram(histogram, 0.95), unit, samples };
    }

    case "job.failure_rate":
    case "job.throughput":
    case "job.p95_wait": {
      const [row] = await db.execute<{ runs: number; failed: number; p95: number }>(sql`
        SELECT count(*)::int AS runs,
               count(*) FILTER (WHERE e.job_status = 'failed')::int AS failed,
               COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY e.wait_ms), 0)::float8 AS p95
          FROM execution e
         WHERE e.kind = 'job' AND e.started_at >= ${from} AND e.started_at < ${to}
           ${applicationId ? sql`AND e.application_id = ${applicationId}` : sql``}
           ${scope.queueName ? sql`AND e.queue = ${scope.queueName}` : sql``}
      `);
      const runs = Number(row?.runs ?? 0);
      if (runs === 0) return { value: null, unit, samples: 0 };
      if (metric === "job.failure_rate") {
        return { value: Number(row!.failed) / runs, unit, samples: runs };
      }
      if (metric === "job.p95_wait") {
        return { value: Number(row!.p95), unit, samples: runs };
      }
      return { value: runs / minutes, unit, samples: runs };
    }

    case "absence.requests":
    case "absence.jobs": {
      const kind = metric === "absence.jobs" ? "job" : "request";
      // "Has this scope *ever* reported?" decides between a real silence and a
      // scope that was never pointed at the collector. The latter must not fire.
      const [ever] = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n
          FROM execution e
         WHERE e.kind = ${kind}
           ${applicationId ? sql`AND e.application_id = ${applicationId}` : sql``}
      `);
      if (Number(ever?.n ?? 0) === 0) return { value: null, unit, samples: 0 };
      const [last] = await db.execute<{ at: number | null }>(sql`
        SELECT MAX(e.started_at)::bigint AS at
          FROM execution e
         WHERE e.kind = ${kind}
           ${applicationId ? sql`AND e.application_id = ${applicationId}` : sql``}
      `);
      const lastAt = Number(last?.at ?? 0);
      if (!lastAt) return { value: null, unit, samples: 0 };
      return { value: Math.max(0, (to - lastAt) / 60_000), unit, samples: 1 };
    }

    case "error.new": {
      const [row] = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n
          FROM error_group g
         WHERE g.first_seen >= ${from} AND g.first_seen < ${to}
           ${applicationId ? sql`AND g.application_id = ${applicationId}` : sql``}
      `);
      return { value: Number(row?.n ?? 0), unit, samples: 1 };
    }

    case "error.unhandled": {
      // Every occurrence is unhandled in this build: the `expected` state exists
      // upstream and is not implemented, so pretending to filter it would lie.
      const [row] = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n
          FROM error_group g
         WHERE g.last_seen >= ${from} AND g.last_seen < ${to}
           ${applicationId ? sql`AND g.application_id = ${applicationId}` : sql``}
      `);
      return { value: Number(row?.n ?? 0), unit, samples: 1 };
    }

    case "log.pattern": {
      const pattern = (scope.logPattern ?? "").trim();
      // Upstream's floor: a one-character pattern matches everything and is an
      // alert that always fires, which is worse than no alert.
      if (pattern.length < 3) return { value: null, unit, samples: 0 };
      const levels = (scope.logLevels ?? []).filter(
        (level): level is string => typeof level === "string",
      );
      const [row] = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n
          FROM log_entry l
         WHERE l.occurred_at >= ${from} AND l.occurred_at < ${to}
           AND l.text ILIKE ${`%${pattern}%`}
           ${applicationId ? sql`AND l.application_id = ${applicationId}` : sql``}
           ${levels.length > 0 ? sql`AND l.level = ANY(${levels})` : sql``}
      `);
      return { value: Number(row?.n ?? 0), unit, samples: 1 };
    }

    case "custom.metric": {
      const name = (scope.customMetricName ?? "").trim();
      if (!name) return { value: null, unit, samples: 0 };
      const [row] = await db.execute<{ avg: number | null; n: number }>(sql`
        SELECT AVG(p.value)::float8 AS avg, count(*)::int AS n
          FROM metric_point p
          INNER JOIN metric_series s ON s.id = p.series_id
         WHERE s.name = ${name} AND p.at >= ${from} AND p.at < ${to}
           ${applicationId ? sql`AND s.application_id = ${applicationId}` : sql``}
      `);
      const samples = Number(row?.n ?? 0);
      if (samples === 0) return { value: null, unit, samples: 0 };
      return { value: Number(row!.avg), unit, samples };
    }

    case "runtime.event_loop":
    case "runtime.cpu":
    case "runtime.memory": {
      const column =
        metric === "runtime.event_loop"
          ? sql`(r.event_loop ->> 'l')::float8`
          : metric === "runtime.cpu"
            ? sql`(r.cpu ->> 'p')::float8`
            : sql`(r.memory ->> 'hu')::float8`;
      const [row] = await db.execute<{ avg: number | null; n: number }>(sql`
        SELECT AVG(${column})::float8 AS avg, count(*)::int AS n
          FROM runtime_sample r
         WHERE r.received_at >= ${from} AND r.received_at < ${to}
           ${applicationId ? sql`AND r.application_id = ${applicationId}` : sql``}
      `);
      const samples = Number(row?.n ?? 0);
      if (samples === 0) return { value: null, unit, samples: 0 };
      return { value: Number(row!.avg), unit, samples };
    }

    case "slo.burn": {
      const sloId = scope.sloId;
      if (!sloId) return { value: null, unit, samples: 0 };
      const rows = await db.select().from(slo).where(eq(slo.id, sloId)).limit(1);
      const objective = rows[0];
      if (!objective) return { value: null, unit, samples: 0 };
      // The burn windows are the ones SLO evaluation already computes; pick the
      // one closest to the rule's window rather than inventing a fifth.
      const evaluations = await slos(db, objective.applicationId);
      const evaluation = evaluations.find((entry) => entry.id === sloId);
      if (!evaluation) return { value: null, unit, samples: 0 };
      const wanted = (to - from) / 1000;
      const burn = [...evaluation.burn].sort(
        (a, b) => Math.abs(a.hours * 3600 - wanted) - Math.abs(b.hours * 3600 - wanted),
      )[0];
      if (!burn || burn.rate === null) return { value: null, unit, samples: 0 };
      return { value: burn.rate, unit, samples: burn.total };
    }

    default:
      return { value: null, unit, samples: 0 };
  }
}

/** Local minutes-of-day for a quiet-hours window, honouring its timezone. */
function minutesOfDay(now: number, timezone: string | undefined): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone || "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(now));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function parseClock(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Is `now` inside the rule's quiet hours?
 *
 * A window that wraps midnight (`22:00` → `07:00`) is the normal case, not an
 * edge case, so the comparison is "after start **or** before end" when start > end.
 */
export function inQuietHours(
  quietHours: Record<string, unknown> | null,
  now: number,
): boolean {
  if (!quietHours) return false;
  const start = parseClock(quietHours.start);
  const end = parseClock(quietHours.end);
  if (start === null || end === null || start === end) return false;
  const timezone = typeof quietHours.timezone === "string" ? quietHours.timezone : undefined;
  let minute: number;
  try {
    minute = minutesOfDay(now, timezone);
  } catch {
    minute = minutesOfDay(now, undefined);
  }
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

interface Baseline {
  mean: number;
  deviation: number;
  samples: number;
}

/**
 * The previous `BASELINE_WINDOWS` windows, measured the same way, for anomaly
 * detection. Windows with no data are skipped: a quiet night is not a zero.
 */
async function baseline(
  db: Db,
  rule: { metric: string; applicationId: string | null; scope: Record<string, unknown> },
  from: number,
  windowMs: number,
): Promise<Baseline> {
  const values: number[] = [];
  for (let index = 1; index <= BASELINE_WINDOWS; index += 1) {
    const end = from - (index - 1) * windowMs;
    const start = end - windowMs;
    const measured = await measure(db, rule, start, end);
    if (measured.value !== null) values.push(measured.value);
  }
  if (values.length === 0) return { mean: 0, deviation: 0, samples: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(values.length, 1);
  return { mean, deviation: Math.sqrt(variance), samples: values.length };
}

function compares(value: number, comparator: string, threshold: number): boolean {
  return comparator === "below" ? value < threshold : value > threshold;
}

export interface RuleStateView {
  id: string;
  name: string;
  description: string | null;
  applicationId: string | null;
  metric: string;
  comparator: string;
  threshold: number;
  windowS: number;
  detection: Detection;
  sigma: number | null;
  severity: Severity;
  scope: unknown;
  channels: unknown;
  quietHours: unknown;
  enabled: boolean;
  mutedUntil: number | null;
  createdAt: number;
  updatedAt: number;
  /** Computed on read for display; the *events* are written by the evaluator. */
  state: RuleState;
  current: Measured;
  quiet: boolean;
  /** The open firing event, if there is one. */
  openEventId: string | null;
  lastEvaluatedAt: number | null;
}

/**
 * Rules with their current state, for the page.
 *
 * This measures every rule (it is a handful), but writes nothing: reading a page
 * must not open or close an incident. The clock does that.
 */
export async function listRules(
  db: Db,
  now = Date.now(),
): Promise<RuleStateView[]> {
  const rules = await db.select().from(alertRule).orderBy(alertRule.name);
  const openEvents = await db
    .select({ id: alertEvent.id, ruleId: alertEvent.ruleId })
    .from(alertEvent)
    .where(isNull(alertEvent.resolvedAt));

  return Promise.all(
    rules.map(async (rule) => {
      const windowMs = rule.windowS * 1000;
      const current = await measure(db, rule, now - windowMs, now);
      const quiet =
        inQuietHours((rule.quietHours ?? null) as Record<string, unknown> | null, now) ||
        (rule.mutedUntil !== null && rule.mutedUntil > now);
      const firing =
        current.value !== null && compares(current.value, rule.comparator, rule.threshold);
      const state: RuleState = firing
        ? quiet
          ? "muted"
          : "firing"
        : current.value === null
          ? "no-data"
          : "ok";
      return {
        id: rule.id,
        name: rule.name,
        description: rule.description,
        applicationId: rule.applicationId,
        metric: rule.metric,
        comparator: rule.comparator,
        threshold: rule.threshold,
        windowS: rule.windowS,
        detection: rule.detection as Detection,
        sigma: rule.sigma,
        severity: rule.severity as Severity,
        scope: rule.scope,
        channels: rule.channels,
        quietHours: rule.quietHours,
        enabled: rule.enabled,
        mutedUntil: rule.mutedUntil,
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
        state,
        current,
        quiet,
        openEventId: openEvents.find((event) => event.ruleId === rule.id)?.id ?? null,
        lastEvaluatedAt: null,
      } satisfies RuleStateView;
    }),
  );
}

export interface EvaluationSummary {
  evaluated: number;
  opened: number;
  resolved: number;
  muted: number;
  skipped: number;
  /** Per-rule outcome, so a caller (and the test suite) can see why. */
  results: Array<{
    ruleId: string;
    name: string;
    value: number | null;
    state: RuleState;
    transition: "opened" | "resolved" | "none";
    delivery: Array<{ channel: string; status: "sent" | "skipped" | "failed"; reason?: string }>;
  }>;
}

interface WebhookChannel {
  type: "webhook" | "slack" | "email" | "in-app";
  url?: string;
}

/**
 * Deliver one firing to its channels. In-app is the event row itself; a webhook
 * gets a small JSON POST with a short timeout. Email is recorded as skipped with
 * the reason, because this build has no SMTP client and a rule that silently
 * drops its notification is worse than one that says why.
 */
async function deliver(
  rule: typeof alertRule.$inferSelect,
  event: { id: string; startedAt: number; value: number | null },
): Promise<Array<{ channel: string; status: "sent" | "skipped" | "failed"; reason?: string }>> {
  const channels = (rule.channels ?? []) as unknown as WebhookChannel[];
  const results: Array<{ channel: string; status: "sent" | "skipped" | "failed"; reason?: string }> =
    [];
  for (const channel of channels) {
    const type = channel?.type ?? "in-app";
    if (type === "in-app") {
      results.push({ channel: "in-app", status: "sent" });
      continue;
    }
    if (type === "email") {
      results.push({
        channel: "email",
        status: "skipped",
        reason: "no SMTP client in this build — the event is still recorded in-app",
      });
      continue;
    }
    if (!channel.url) {
      results.push({ channel: type, status: "skipped", reason: "no url" });
      continue;
    }
    try {
      const response = await fetch(channel.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rule: { id: rule.id, name: rule.name, severity: rule.severity, metric: rule.metric },
          event,
          text: `[${rule.severity}] ${rule.name} — ${rule.metric} ${rule.comparator} ${rule.threshold}`,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      results.push({
        channel: type,
        status: response.ok ? "sent" : "failed",
        ...(response.ok ? {} : { reason: `HTTP ${response.status}` }),
      });
    } catch (error) {
      results.push({
        channel: type,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/**
 * Evaluate every enabled rule and write the transitions.
 *
 * Called by the in-process cron once a minute and by `POST /alerts/evaluate`.
 * Idempotent: two evaluations in the same state write nothing, which is what
 * makes it safe to call from both.
 */
export async function evaluateRules(db: Db, now = Date.now()): Promise<EvaluationSummary> {
  const rules = (await db.select().from(alertRule).where(eq(alertRule.enabled, true))).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  const summary: EvaluationSummary = {
    evaluated: rules.length,
    opened: 0,
    resolved: 0,
    muted: 0,
    skipped: 0,
    results: [],
  };

  for (const rule of rules) {
    const windowMs = rule.windowS * 1000;
    const current = await measure(db, rule, now - windowMs, now);

    let firing = false;
    let reason: string | null = null;
    if (current.value === null) {
      // No data: no transition in either direction. Silence is `absence.*`.
      reason = "no data";
    } else if (rule.detection === "anomaly") {
      const baselineStats = await baseline(db, rule, now - windowMs, windowMs);
      const sigma = rule.sigma ?? 3.5;
      if (baselineStats.samples < 2 || baselineStats.deviation === 0) {
        reason = "insufficient baseline";
      } else {
        const deviation = Math.abs(current.value - baselineStats.mean);
        firing =
          deviation > sigma * baselineStats.deviation &&
          compares(current.value, rule.comparator, baselineStats.mean);
        reason = firing ? `anomaly (mean ${baselineStats.mean.toFixed(2)})` : null;
      }
    } else {
      firing = compares(current.value, rule.comparator, rule.threshold);
    }

    const openRows = await db
      .select()
      .from(alertEvent)
      .where(and(eq(alertEvent.ruleId, rule.id), isNull(alertEvent.resolvedAt)))
      .orderBy(desc(alertEvent.startedAt))
      .limit(1);
    const open = openRows[0];

    if (!firing) {
      if (open && current.value !== null) {
        await db
          .update(alertEvent)
          .set({ resolvedAt: now })
          .where(eq(alertEvent.id, open.id));
        await db.insert(alertEvent).values({
          id: Bun.randomUUIDv7(),
          ruleId: rule.id,
          state: "resolved",
          severity: rule.severity as Severity,
          startedAt: now,
          resolvedAt: now,
          value: current.value,
          payload: { closedEventId: open.id, reason: "back to normal" },
        });
        summary.resolved += 1;
        summary.results.push({
          ruleId: rule.id,
          name: rule.name,
          value: current.value,
          state: "ok",
          transition: "resolved",
          delivery: [],
        });
      } else {
        summary.results.push({
          ruleId: rule.id,
          name: rule.name,
          value: current.value,
          state: current.value === null ? "no-data" : "ok",
          transition: "none",
          delivery: [],
        });
      }
      continue;
    }

    if (open) {
      // Already firing: update the value, but do not re-notify every minute.
      await db.update(alertEvent).set({ value: current.value }).where(eq(alertEvent.id, open.id));
      summary.results.push({
        ruleId: rule.id,
        name: rule.name,
        value: current.value,
        state: "firing",
        transition: "none",
        delivery: [],
      });
      continue;
    }

    const quiet =
      inQuietHours((rule.quietHours ?? null) as Record<string, unknown> | null, now) ||
      (rule.mutedUntil !== null && rule.mutedUntil > now);
    const eventId = Bun.randomUUIDv7();
    const delivery = quiet ? [] : await deliver(rule, { id: eventId, startedAt: now, value: current.value });
    await db.insert(alertEvent).values({
      id: eventId,
      ruleId: rule.id,
      state: "firing",
      severity: rule.severity as Severity,
      startedAt: now,
      value: current.value,
      muted: quiet,
      payload: { reason, delivery, unit: current.unit, samples: current.samples },
    });
    if (quiet) summary.muted += 1;
    else summary.opened += 1;
    summary.results.push({
      ruleId: rule.id,
      name: rule.name,
      value: current.value,
      state: quiet ? "muted" : "firing",
      transition: "opened",
      delivery,
    });
  }

  return summary;
}

/** Event history, newest first, with the rule's name attached. */
export async function alertEvents(db: Db, limit = 100) {
  const rows = await db
    .select({
      event: alertEvent,
      ruleName: alertRule.name,
      metric: alertRule.metric,
      applicationId: alertRule.applicationId,
    })
    .from(alertEvent)
    .innerJoin(alertRule, eq(alertRule.id, alertEvent.ruleId))
    .orderBy(desc(alertEvent.startedAt))
    .limit(Math.min(limit, 500));
  return rows.map((row) => ({
    ...row.event,
    ruleName: row.ruleName,
    metric: row.metric,
    applicationId: row.applicationId,
  }));
}

/** Open incidents — the dashboard card and the sidebar badge. */
export async function openIncidents(db: Db) {
  const rows = await db
    .select({
      event: alertEvent,
      ruleName: alertRule.name,
      metric: alertRule.metric,
      severity: alertRule.severity,
      applicationId: alertRule.applicationId,
    })
    .from(alertEvent)
    .innerJoin(alertRule, eq(alertRule.id, alertEvent.ruleId))
    .where(and(eq(alertEvent.state, "firing"), isNull(alertEvent.resolvedAt)))
    .orderBy(desc(alertEvent.startedAt))
    .limit(50);
  return rows.map((row) => ({
    ...row.event,
    ruleName: row.ruleName,
    metric: row.metric,
    severity: row.severity,
    applicationId: row.applicationId,
  }));
}

/**
 * Seed the two rules a fresh install actually needs, once.
 *
 * They are the pair every team writes first — the error rate that is worth
 * waking up for, and the queue that stops being consumed — and they are inert
 * until there is traffic, because a metric with no data never fires.
 */
export async function seedDefaultRules(db: Db, projectId: string, now = Date.now()) {
  const existing = await db.select({ id: alertRule.id }).from(alertRule).limit(1);
  if (existing.length > 0) return 0;
  const rules = [
    {
      id: Bun.randomUUIDv7(),
      projectId,
      name: "Error rate above 5%",
      description: "More than one request in twenty failed over the last 5 minutes.",
      metric: "request.error_rate",
      comparator: "above",
      threshold: 0.05,
      windowS: 300,
      severity: "high" as const,
      channels: [{ type: "in-app" }],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: Bun.randomUUIDv7(),
      projectId,
      name: "A job queue stopped being consumed",
      description: "No job run in 15 minutes on a scope that has run jobs before.",
      metric: "absence.jobs",
      comparator: "above",
      threshold: 15,
      windowS: 300,
      severity: "critical" as const,
      channels: [{ type: "in-app" }],
      createdAt: now,
      updatedAt: now,
    },
  ];
  await db.insert(alertRule).values(rules);
  return rules.length;
}

export const SELECTABLE_WINDOWS = WINDOW_CHOICES;
