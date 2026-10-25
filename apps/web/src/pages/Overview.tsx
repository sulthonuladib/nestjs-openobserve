import { Box, Button, Card, Skeleton, Stack, Typography } from "@mui/material";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type JobRow, type ReleaseRow, type SeriesPoint } from "../api";
import { ContentCard, MetricCard, Segmented } from "../components/cards/MetricCard";
import { BarSeries } from "../components/charts/BarSeries";
import { LineSeries } from "../components/charts/LineSeries";
import { PageHeader } from "../components/shell/PageHeader";
import { useLive, useShell } from "../components/shell/ShellContext";
import {
  deltaRatio,
  durationParts,
  formatAxisStamp,
  formatCount,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelative,
  previousWindowFor,
  windowFor,
  type TimeRangeId,
} from "../format";
import { colors } from "../theme";

/**
 * The project dashboard.
 *
 * This is the page the reference product sells, so the layout is theirs: four
 * quiet stat tiles, then a two-column grid of metric cards where every card has
 * the same anatomy — small-caps label, one big number, a rate and a delta, a chart
 * bleeding to the card's edges, and the window's endpoints underneath.
 *
 * Data comes from one place per question. Headline totals are summed from
 * `api.applications()` — the server's own window aggregates, not re-derived here —
 * while the charts merge each application's `api.timeseries()` buckets. With
 * "All applications" selected that merge is the project series; with one selected
 * it is that application's series, and the exact same cards are reused by the
 * application page.
 */
export function Overview() {
  const { appId, range } = useShell();
  const { interval } = useLive();
  const window = windowFor(range);
  const previous = previousWindowFor(range);

  const applications = useQuery({
    queryKey: ["applications", range],
    queryFn: () => api.applications(window),
    refetchInterval: interval,
  });

  const scoped = (applications.data ?? []).filter((app) => !appId || app.id === appId);
  const series = useQueries({
    queries: scoped.flatMap((app) => [
      {
        queryKey: ["timeseries", app.id, range, "current"],
        queryFn: () => api.timeseries(app.id, window),
        refetchInterval: interval,
      },
      {
        queryKey: ["timeseries", app.id, range, "previous"],
        queryFn: () => api.timeseries(app.id, previous),
        refetchInterval: interval,
      },
    ]),
  });

  const jobs = useQueries({
    queries: scoped.map((app) => ({
      queryKey: ["jobs", app.id, range],
      queryFn: () => api.jobs(app.id, window),
      refetchInterval: interval,
    })),
  });

  const releases = useQueries({
    queries: scoped.map((app) => ({
      queryKey: ["releases", app.id, range],
      queryFn: () => api.releases(app.id, window),
      refetchInterval: interval,
    })),
  });

  const errors = useQueries({
    queries: scoped.map((app) => ({
      queryKey: ["errors", app.id, "open"],
      queryFn: () => api.errors(app.id, "open"),
      refetchInterval: interval,
    })),
  });

  const currentPoints = mergeSeries(series.filter((_, index) => index % 2 === 0));
  const previousPoints = mergeSeries(series.filter((_, index) => index % 2 === 1));
  const bucketMs = series[0]?.data?.bucketMs ?? 60_000;
  const totals = summarizeSeries(currentPoints);
  const previousTotals = summarizeSeries(previousPoints);

  const chartsLoading = applications.isLoading || series.some((query) => query.isLoading);
  const chartsError = applications.error ?? series.find((query) => query.error)?.error;

  const jobRows = jobs.flatMap((query) => query.data ?? []);
  const jobRuns = jobRows.reduce((sum, row) => sum + row.runs, 0);
  const jobFailed = jobRows.reduce((sum, row) => sum + row.failed, 0);

  const latestRelease = releases
    .flatMap((query, index) =>
      (query.data ?? []).map((release) => ({ release, owner: scoped[index]?.id ?? "" })),
    )
    .sort((a, b) => b.release.firstSeen - a.release.firstSeen)[0];

  const openErrors = errors
    .flatMap((query, index) =>
      (query.data?.items ?? []).map((group) => ({ group, owner: scoped[index]?.id ?? "" })),
    )
    .sort((a, b) => b.group.lastSeen - a.group.lastSeen)
    .slice(0, 5);

  const requestRate = ratePerMinute(totals.requests, window);
  const errorRate = totals.requests > 0 ? totals.errors / totals.requests : 0;
  const previousErrorRate =
    previousTotals.requests > 0 ? previousTotals.errors / previousTotals.requests : 0;

  if (!applications.isLoading && !applications.isError && scoped.length === 0) {
    return (
      <Box>
        <PageHeader
          title="Dashboard"
          description="Here's an overview of your project and its applications."
        />
        <ContentCard
          label="No applications yet"
          empty
          emptyMessage={
            appId
              ? "That application is gone, or it belongs to another project."
              : "Point a NestJS app at this collector — `npx @nestjs/observe link` — and its requests, jobs and errors appear here within a minute."
          }
        >
          {null}
        </ContentCard>
      </Box>
    );
  }

  return (
    <Box>
      <PageHeader
        title="Dashboard"
        description="Here's an overview of your project and its applications."
        actions={
          <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
            {scoped.length === 1 ? scoped[0]?.name : `${scoped.length} applications`}
          </Typography>
        }
      />

      <Box
        sx={{
          display: "grid",
          gap: 1.5,
          gridTemplateColumns: { xs: "1fr 1fr", md: "repeat(4, minmax(0, 1fr))" },
          mb: 2,
        }}
      >
        <StatTile
          label="Applications"
          value={applications.isError ? "—" : String(scoped.length)}
          loading={applications.isLoading}
        />
        <StatTile
          label="Requests"
          value={applications.isError ? "—" : formatCount(scoped.reduce((sum, a) => sum + a.requests, 0))}
          trailing={requestRate}
          loading={applications.isLoading}
        />
        <StatTile
          label="Error rate"
          value={applications.isError ? "—" : formatPercent(errorRate, 2)}
          loading={chartsLoading}
          tone={errorRate > 0.05 ? "bad" : errorRate > 0.01 ? "warn" : "default"}
        />
        <StatTile
          label="p95"
          value={applications.isError ? "—" : formatDuration(scopedP95(scoped))}
          loading={applications.isLoading}
        />
      </Box>

      <Box
        sx={{
          display: "grid",
          gap: 2,
          gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
          alignItems: "stretch",
        }}
      >
        <RequestsCard
          points={currentPoints}
          previousPoints={previousPoints}
          window={window}
          loading={chartsLoading}
          error={chartsError}
        />

        <DurationCard
          points={currentPoints}
          previousPoints={previousPoints}
          bucketMs={bucketMs}
          window={window}
          loading={chartsLoading}
          error={chartsError}
        />

        <MetricCard
          label="Errors"
          value={totals.requests > 0 ? (errorRate * 100).toFixed(2) : "—"}
          unit="%"
          aside={`${formatNumber(totals.errors)} unhandled`}
          rate={requestRate}
          delta={deltaRatio(errorRate, previousErrorRate)}
          loading={chartsLoading}
          error={chartsError}
          empty={currentPoints.length === 0}
          emptyMessage="No traffic in this window, so no error rate to report."
          chart={
            <BarSeries
              rows={currentPoints.map((point) => ({ t: point.t, errors: point.errors }))}
              indexBy="t"
              keys={[{ id: "errors", label: "unhandled", color: colors.danger }]}
              formatIndex={(value) => formatAxisStamp(Number(value))}
            />
          }
          footer={<AxisFooter from={window.from} to={window.to} />}
        />

        <MetricCard
          label="Jobs"
          value={formatNumber(jobRuns)}
          aside={`${formatNumber(jobFailed)} failed`}
          rate={jobRuns > 0 ? `${formatPercent(jobFailed / jobRuns, 1)} failure rate` : undefined}
          loading={jobs.some((query) => query.isLoading)}
          error={jobs.find((query) => query.error)?.error}
          empty={jobRows.length === 0}
          emptyMessage="No job runs. The agent reports BullMQ and @nestjs/schedule handlers automatically."
          chart={
            <BarSeries
              rows={topJobs(jobRows).map((row) => ({
                name: `${row.queue ?? "default"} · ${row.jobName ?? "—"}`,
                completed: Math.max(0, row.runs - row.failed),
                failed: row.failed,
              }))}
              indexBy="name"
              keys={[
                { id: "completed", label: "completed", color: colors.hairline },
                { id: "failed", label: "failed", color: colors.danger },
              ]}
              formatIndex={(value) => String(value)}
              formatValue={(value) => formatNumber(value)}
            />
          }
          footer={
            <Typography sx={{ fontSize: 10, color: "text.disabled" }}>
              {jobRows.length} queue/job pair{jobRows.length === 1 ? "" : "s"}, busiest first
            </Typography>
          }
        />

        <LastReleaseCard
          release={latestRelease}
          loading={releases.some((query) => query.isLoading)}
          error={releases.find((query) => query.error)?.error}
        />
        <OpenErrorsCard
          groups={openErrors}
          loading={errors.some((query) => query.isLoading)}
          error={errors.find((query) => query.error)?.error}
        />
      </Box>
    </Box>
  );
}

/** Signed stats for one window, already merged across applications. */
export interface SeriesTotals {
  requests: number;
  errors: number;
  clientErrors: number;
  avgMs: number | null;
  p95Ms: number | null;
}

/**
 * One series out of several applications' series.
 *
 * Requests and error counts are additive. The average is re-weighted by request
 * count, since averaging averages is how a quiet application with one slow call
 * ends up "slower" than a busy one. p95 is the **maximum across applications**:
 * a true project-wide p95 would need the merged histograms server-side, and the
 * max is the honest bound until that endpoint exists.
 */
export function mergeSeries(
  results: ReadonlyArray<{ data?: { points: SeriesPoint[] } | undefined }>,
): SeriesPoint[] {
  const buckets = new Map<number, { requests: number; errors: number; clientErrors: number; durationSum: number; p95: number | null; p50: number | null; p99: number | null }>();

  for (const result of results) {
    for (const point of result.data?.points ?? []) {
      const bucket = buckets.get(point.t) ?? {
        requests: 0,
        errors: 0,
        clientErrors: 0,
        durationSum: 0,
        p95: null,
        p50: null,
        p99: null,
      };
      bucket.requests += point.requests;
      bucket.errors += point.errors;
      bucket.clientErrors += point.clientErrors;
      bucket.durationSum += (point.avgMs ?? 0) * point.requests;
      bucket.p95 = maxOf(bucket.p95, point.p95Ms);
      bucket.p50 = maxOf(bucket.p50, point.p50Ms);
      bucket.p99 = maxOf(bucket.p99, point.p99Ms);
      buckets.set(point.t, bucket);
    }
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, bucket]) => ({
      t,
      requests: bucket.requests,
      errors: bucket.errors,
      clientErrors: bucket.clientErrors,
      avgMs: bucket.requests > 0 ? bucket.durationSum / bucket.requests : null,
      p95Ms: bucket.p95,
      p50Ms: bucket.p50,
      p99Ms: bucket.p99,
    }));
}

export function summarizeSeries(points: ReadonlyArray<SeriesPoint>): SeriesTotals {
  let requests = 0;
  let errors = 0;
  let clientErrors = 0;
  let durationSum = 0;
  let p95: number | null = null;
  for (const point of points) {
    requests += point.requests;
    errors += point.errors;
    clientErrors += point.clientErrors;
    durationSum += (point.avgMs ?? 0) * point.requests;
    p95 = maxOf(p95, point.p95Ms);
  }
  return {
    requests,
    errors,
    clientErrors,
    avgMs: requests > 0 ? durationSum / requests : null,
    p95Ms: p95,
  };
}

type StatusMode = "all" | "2xx" | "4xx" | "5xx";

/**
 * Requests, stacked by status class.
 *
 * The toggle is a filter rather than a legend: at 150px tall, three stacked
 * classes in one 6px-wide bar is a colour mush, and "just the 5xx" is the question
 * someone actually asks. `All` still draws the full stack.
 */
export function RequestsCard({
  points,
  previousPoints,
  window,
  loading,
  error,
}: {
  points: ReadonlyArray<SeriesPoint>;
  previousPoints: ReadonlyArray<SeriesPoint>;
  window: { from: number; to: number };
  loading?: boolean;
  error?: unknown;
}) {
  const [mode, setMode] = useState<StatusMode>("all");
  const totals = summarizeSeries(points);
  const previousTotals = summarizeSeries(previousPoints);

  const keys = statusKeys(mode);
  return (
    <MetricCard
      label="Requests"
      value={formatNumber(totals.requests)}
      rate={ratePerMinute(totals.requests, window)}
      delta={deltaRatio(totals.requests, previousTotals.requests)}
      loading={loading}
      error={error}
      empty={points.length === 0}
      emptyMessage="No requests in this window. Any HTTP call your Nest app serves shows up here."
      actions={
        <Segmented<StatusMode>
          value={mode}
          onChange={setMode}
          ariaLabel="Status class"
          options={[
            { value: "all", label: "All" },
            { value: "2xx", label: "2xx" },
            { value: "4xx", label: "4xx" },
            { value: "5xx", label: "5xx" },
          ]}
        />
      }
      chart={
        <BarSeries
          rows={points.map((point) => ({
            t: point.t,
            ok: Math.max(0, point.requests - point.errors - point.clientErrors),
            client: point.clientErrors,
            server: point.errors,
          }))}
          indexBy="t"
          keys={keys}
          formatIndex={(value) => formatAxisStamp(Number(value))}
          formatValue={(value) => formatNumber(value)}
        />
      }
      footer={<AxisFooter from={window.from} to={window.to} />}
    />
  );
}

type DurationMode = "avg" | "p95";

/**
 * Duration, AVG or P95.
 *
 * The p95 comes from the server's merged log-scale histograms, so the line is a
 * real percentile of the window's buckets — not an average of per-minute p95s,
 * which is the mistake that makes a long tail look flat.
 */
export function DurationCard({
  points,
  previousPoints,
  bucketMs = 60_000,
  window,
  loading,
  error,
}: {
  points: ReadonlyArray<SeriesPoint>;
  previousPoints: ReadonlyArray<SeriesPoint>;
  bucketMs?: number;
  window: { from: number; to: number };
  loading?: boolean;
  error?: unknown;
}) {
  const [mode, setMode] = useState<DurationMode>("avg");
  const totals = summarizeSeries(points);
  const previousTotals = summarizeSeries(previousPoints);
  const selected = mode === "avg" ? totals.avgMs : totals.p95Ms;
  const previousSelected = mode === "avg" ? previousTotals.avgMs : previousTotals.p95Ms;
  const { value, unit } = durationParts(selected);
  // A window with no durations has no delta: `0` here would read as "−100%".
  const delta =
    selected === null || previousSelected === null ? null : deltaRatio(selected, previousSelected);

  return (
    <MetricCard
      label="Duration"
      value={value}
      unit={unit}
      aside={
        <Typography component="span" sx={{ fontSize: 12, color: "text.disabled" }}>
          p95 {formatDuration(totals.p95Ms)}
        </Typography>
      }
      delta={delta}
      loading={loading}
      error={error}
      empty={points.length === 0}
      emptyMessage="No durations recorded in this window."
      actions={
        <Segmented<DurationMode>
          value={mode}
          onChange={setMode}
          ariaLabel="Duration metric"
          options={[
            { value: "avg", label: "Avg" },
            { value: "p95", label: "p95" },
          ]}
        />
      }
      chart={
        <LineSeries
          series={[
            {
              id: mode,
              label: mode === "avg" ? "average" : "p95",
              color: colors.accent,
              points: bucketPoints(
                points,
                window,
                (point) => (mode === "avg" ? point.avgMs : point.p95Ms),
                bucketMs,
              ),
            },
          ]}
          formatValue={formatDuration}
        />
      }
      footer={<AxisFooter from={window.from} to={window.to} />}
    />
  );
}

function LastReleaseCard({
  release,
  loading,
  error,
}: {
  release: { release: ReleaseRow; owner: string } | undefined;
  loading?: boolean;
  error?: unknown;
}) {
  const { navigate, range } = useShell();
  const regression = release?.release.regression ?? null;

  return (
    <ContentCard
      label="Last release"
      loading={loading}
      error={error}
      empty={!release}
      emptyMessage="No release reported yet. The agent stamps `version` from your package.json on every request."
      actions={
        release ? (
          <Button
            size="small"
            variant="outlined"
            onClick={() => navigate(withRange(`/applications/${release.owner}/releases`, range))}
          >
            View releases
          </Button>
        ) : undefined
      }
    >
      {release && (
        <Box>
          <Stack direction="row" spacing={1} sx={{ mb: 0.5, alignItems: "baseline" }}>
            <Typography sx={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em" }}>
              {release.release.version}
            </Typography>
            <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
              deployed {formatRelative(release.release.firstSeen)}
            </Typography>
          </Stack>
          <Typography
            sx={{
              fontSize: 12,
              color: regression ? "error.main" : "text.secondary",
              mb: 0.75,
            }}
          >
            {regression
              ? `Looks like a regression since ${regression.againstVersion}: p95 ${
                  regression.latencyDelta >= 0 ? "+" : ""
                }${(regression.latencyDelta * 100).toFixed(0)}%, error rate ${
                  regression.errorRateDelta >= 0 ? "+" : ""
                }${(regression.errorRateDelta * 100).toFixed(1)} points.`
              : "No regression against the previous release on the same window."}
          </Typography>
          <Stack direction="row" spacing={2}>
            <MiniStat label="Error rate" value={formatPercent(release.release.errorRate, 2)} />
            <MiniStat label="p95" value={formatDuration(release.release.p95Ms)} />
            <MiniStat label="Requests" value={formatCount(release.release.requests)} />
          </Stack>
        </Box>
      )}
    </ContentCard>
  );
}

function OpenErrorsCard({
  groups,
  loading,
  error,
}: {
  groups: ReadonlyArray<{
    group: { id: string; message: string; class: string | null; occurrences: number; lastSeen: number };
    owner: string;
  }>;
  loading?: boolean;
  error?: unknown;
}) {
  const { navigate, range } = useShell();
  const openErrorsPath = (owner: string) => withRange(`/applications/${owner}/errors`, range);
  return (
    <ContentCard
      label="Open errors"
      loading={loading}
      error={error}
      empty={groups.length === 0}
      emptyMessage="No open error groups. A quiet error page is the good outcome."
    >
      <Stack spacing={0.25} sx={{ mt: -0.5 }}>
        {groups.map(({ group, owner }) => (
          <Box
            key={group.id}
            role="button"
            tabIndex={0}
            onClick={() => navigate(openErrorsPath(owner))}
            onKeyDown={(event) => {
              if (event.key === "Enter") navigate(openErrorsPath(owner));
            }}
            sx={{
              px: 1,
              mx: -1,
              py: 0.6,
              borderRadius: 1,
              cursor: "pointer",
              "&:hover": { bgcolor: colors.surfaceHover },
            }}
          >
            <Stack direction="row" spacing={1} sx={{ alignItems: "baseline", justifyContent: "space-between" }}>
              <Typography
                sx={{
                  fontSize: 12,
                  color: "text.primary",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={group.message}
              >
                {group.message}
              </Typography>
              <Typography
                sx={{ fontSize: 10, color: "text.disabled", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}
              >
                ×{formatCount(group.occurrences)}
              </Typography>
            </Stack>
            <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
              <Typography sx={{ fontSize: 10, color: "error.main" }}>
                {group.class ?? "Error"}
              </Typography>
              <Typography sx={{ fontSize: 10, color: "text.disabled" }}>
                {formatRelative(group.lastSeen)}
              </Typography>
            </Stack>
          </Box>
        ))}
      </Stack>
    </ContentCard>
  );
}

function StatTile({
  label,
  value,
  trailing,
  tone = "default",
  loading = false,
}: {
  label: string;
  value: string;
  trailing?: string;
  tone?: "default" | "bad" | "warn";
  loading?: boolean;
}) {
  const color =
    tone === "bad" ? "error.main" : tone === "warn" ? "warning.main" : "text.primary";
  return (
    <Card variant="outlined" sx={{ px: 1.75, py: 1.25 }}>
      <Typography
        sx={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.09em",
          textTransform: "uppercase",
          color: "text.disabled",
        }}
      >
        {label}
      </Typography>
      {loading ? (
        <Skeleton variant="text" width={56} height={28} />
      ) : (
        <Stack direction="row" spacing={0.75} sx={{ alignItems: "baseline" }}>
          <Typography
            sx={{
              fontSize: 21,
              fontWeight: 600,
              letterSpacing: "-0.015em",
              color,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {value}
          </Typography>
          {trailing && (
            <Typography sx={{ fontSize: 11, color: "text.disabled" }}>{trailing}</Typography>
          )}
        </Stack>
      )}
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography
        sx={{
          fontSize: 9,
          letterSpacing: "0.09em",
          textTransform: "uppercase",
          color: "text.disabled",
        }}
      >
        {label}
      </Typography>
      <Typography sx={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{value}</Typography>
    </Box>
  );
}

/** The card footers' `Oct 25 5:06 AM … Oct 25 6:07 AM`. */
function AxisFooter({ from, to }: { from: number; to: number }) {
  return (
    <Stack direction="row" sx={{ justifyContent: "space-between" }}>
      <Typography sx={{ fontSize: 10, color: "text.disabled" }}>{formatAxisStamp(from)}</Typography>
      <Typography sx={{ fontSize: 10, color: "text.disabled" }}>{formatAxisStamp(to)}</Typography>
    </Stack>
  );
}

function statusKeys(mode: StatusMode) {
  const all = [
    { id: "ok", label: "2xx", color: colors.hairline },
    { id: "client", label: "4xx", color: colors.warn },
    { id: "server", label: "5xx", color: colors.danger },
  ];
  if (mode === "all") return all;
  if (mode === "2xx") return all.filter((key) => key.id === "ok");
  if (mode === "4xx") return all.filter((key) => key.id === "client");
  return all.filter((key) => key.id === "server");
}

/**
 * Points on a bucket clock, with `null` where the collector stored nothing.
 *
 * A missing bucket is not zero requests: it is a minute the app was not running,
 * or was not reporting. Drawing it as zero invents an outage-shaped cliff.
 */
export function bucketPoints(
  points: ReadonlyArray<SeriesPoint>,
  window: { from: number; to: number },
  pick: (point: SeriesPoint) => number | null,
  bucketMs = 60_000,
): Array<{ x: number; y: number | null }> {
  const byBucket = new Map(points.map((point) => [point.t, point]));
  const step = bucketMs > 0 ? bucketMs : 60_000;
  const aligned: Array<{ x: number; y: number | null }> = [];
  for (let t = Math.floor(window.from / step) * step; t <= window.to; t += step) {
    const point = byBucket.get(t);
    aligned.push({ x: t, y: point ? pick(point) : null });
  }
  return aligned;
}

/** The shell's router replaces the query string, so the window travels with the link. */
function withRange(path: string, range: TimeRangeId): string {
  return `${path}${path.includes("?") ? "&" : "?"}range=${range}`;
}

function ratePerMinute(total: number, window: { from: number; to: number }): string {
  const minutes = Math.max((window.to - window.from) / 60_000, 1 / 60);
  const rate = total / minutes;
  return `${rate >= 10 ? rate.toFixed(0) : rate.toFixed(1)}/min`;
}

function topJobs(rows: ReadonlyArray<JobRow>): JobRow[] {
  return [...rows].sort((a, b) => b.runs - a.runs).slice(0, 8);
}

function scopedP95(apps: ReadonlyArray<{ p95DurationMs: number | null }>): number | null {
  let p95: number | null = null;
  for (const app of apps) p95 = maxOf(p95, app.p95DurationMs);
  return p95;
}

function maxOf(current: number | null, next: number | null): number | null {
  if (next === null) return current;
  if (current === null) return next;
  return Math.max(current, next);
}
