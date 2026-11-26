/**
 * JobDetail — one queue + job name, over the selected window.
 *
 * The reference's `/dashboard/projects/:id/jobs/details?queue=…&name=…`, and the
 * page the Jobs list drills into. It is an **operation** page, not a run page:
 * every run of one handler (one BullMQ consumer, or one `@nestjs/schedule`
 * method) aggregated, with the newest runs listed underneath.
 *
 * It stays application-addressed (`/applications/:id/jobs/:queue/:name`) even
 * though the list it is opened from is project-wide: a handler belongs to exactly
 * one service, and the row that links here carries that service's id. The app
 * name is read back from the shell's application list for the header, and the
 * back link points at the **project** jobs page filtered to this application —
 * the place the sidebar's Jobs entry lands — rather than at the old per-app list.
 *
 * Three numbers, three different questions, and the reason they sit side by side:
 *
 *   * `runs` / `failed` — is the handler being called, and is it wrong?
 *   * duration          — is the work slow?
 *   * queue wait        — is the queue backed up? A run that waited four minutes
 *                         and then executed in 10 ms is *healthy* on duration and
 *                         terrible in practice, which is why wait gets its own
 *                         full-width chart instead of a column nobody reads.
 *
 * Two vocabulary rules hold here. `series.requests` and `series.errors` are the
 * shared request-shaped rollup fields — this page calls them **Runs** and
 * **Failed**, because a job is not a request and a job's failure is not an error
 * rate on somebody's HTTP endpoint. And a job's failure opens no error group, so
 * the run row is the only place its message can appear: it is printed inline
 * under the failed run rather than linked to a detail page that does not exist.
 *
 * What the page refuses to fake is in the UI as well as in this comment:
 *
 *   * cron handlers have no queue — no wait, no attempts — so those read
 *     "not reported" instead of `0 ms`;
 *   * a run's error payload is real for failures recorded since ingest started
 *     persisting it, and older rows are honestly empty;
 *   * "slower than p95" stays quiet below the reference's 20-run baseline rather
 *     than calling three runs' noise a tail.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import { ResponsiveBar } from "@nivo/bar";
import { ResponsiveLine } from "@nivo/line";
import { CaretLeft } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import { api, ApiError } from "../api";
import {
  formatClock,
  formatCount,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelative,
  windowFor,
  type TimeRangeId,
} from "../format";
import { colors, fontMono, labelCaps, tabular } from "../theme";
import { PageHeader } from "../components/shell/PageHeader";
import { useLiveInterval, useShell } from "../components/shell";

/**
 * How many runs to fetch. The endpoint caps at 200; 100 is enough to scroll a
 * while and to make "which runs are slow" answerable by eye, without turning a
 * detail page into an export.
 */
const RUN_LIMIT = 100;

/**
 * The reference widens the "is this call slow?" baseline rather than judging on
 * two or three runs; below 20 comparable runs it does not render a verdict at
 * all. We keep the same floor, because with three runs the p95 *is* one of them.
 */
const SLOW_VERDICT_MIN_RUNS = 20;

export interface JobDetailProps {
  /** The shell's scope. Empty under "All applications", so `id` is the fallback. */
  appId?: string;
  id?: string;
  range?: TimeRangeId;
  /** The shell's navigator. Kept for parity; this page's links are real `<a>`s. */
  navigate?: (to: string) => void;
  queue?: string;
  /** The handler's name. Slashes are allowed in it — see `api.jobDetail`. */
  name?: string;
}

export function JobDetail({ appId, id, range = "1h", queue, name }: JobDetailProps) {
  const applicationId = appId || id;
  // The job payload is addressed by application but does not repeat its name, so
  // the header reads it from the shell's application list — already fetched for
  // the top-bar switcher, so naming the service costs no request.
  const { apps } = useShell();
  const appName = applicationId
    ? apps.find((entry) => entry.id === applicationId)?.name ?? applicationId
    : "";
  if (!applicationId || !queue || !name) {
    return (
      <Stack spacing={3}>
        <PageHeader
          title="Job"
          description="One queue and one job name: throughput, failures, duration and queue wait."
        />
        <EmptyState
          title="No job selected."
          hint="This page needs an application, a queue and a job name. Open it from a row in the Jobs list."
        />
      </Stack>
    );
  }
  return (
    <JobForApplication
      appId={applicationId}
      appName={appName}
      queue={queue}
      name={name}
      range={range}
    />
  );
}

function JobForApplication({
  appId,
  appName,
  queue,
  name,
  range,
}: {
  appId: string;
  /** The service that owns this handler; `appId` when the shell has no name yet. */
  appName: string;
  queue: string;
  name: string;
  range: TimeRangeId;
}) {
  const refetchInterval = useLiveInterval();
  const detail = useQuery({
    queryKey: ["job-detail", appId, queue, name, range],
    queryFn: () => api.jobDetail(appId, queue, name, { ...windowFor(range), limit: RUN_LIMIT }),
    refetchInterval,
    // A 404 means "this handler has never run here", which is a fact rather than
    // a flake: retrying only delays the honest answer by a second.
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 404) && failureCount < 1,
  });

  const data = detail.data;
  const missing = detail.error instanceof ApiError && detail.error.status === 404;

  return (
    <Stack spacing={2.5}>
      <PageHeader
        title={
          <Box component="span" sx={{ display: "inline-flex", flexDirection: "column", gap: 0.25 }}>
            {/* The service first, the handler under it: a queue name alone does
                not say whose queue it is, and two services can share one. */}
            <Box
              component="span"
              sx={{ fontFamily: fontMono, fontSize: 11.5, fontWeight: 500, color: colors.faint }}
            >
              {appName}
            </Box>
            <Box component="span" sx={{ display: "inline-flex", alignItems: "baseline", gap: 1 }}>
              <Box component="span" sx={{ color: colors.muted, fontWeight: 500 }}>
                {queue}
              </Box>
              <Box component="span" sx={{ color: colors.faint, fontWeight: 400 }}>
                ·
              </Box>
              <Box component="span" sx={{ fontFamily: fontMono, letterSpacing: "-0.01em" }}>
                {name}
              </Box>
            </Box>
          </Box>
        }
        description="Background work of one handler: how often it runs, how often it fails, how long it takes, and how long each run sat in the queue before a worker picked it up."
        actions={
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Chip label={range} size="small" variant="outlined" />
            <Button
              size="small"
              variant="outlined"
              component={RouterLink}
              to={jobsHref(appId, range)}
              startIcon={<CaretLeft size={11} weight="bold" />}
            >
              Jobs
            </Button>
          </Stack>
        }
      />

      {detail.isError && !missing && (
        <Alert severity="error">
          This job could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {errorMessage(detail.error)}
          </Box>
        </Alert>
      )}

      {missing && (
        <MissingJob appId={appId} appName={appName} queue={queue} name={name} range={range} />
      )}

      {detail.isLoading && (
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <Skeleton key={index} variant="rounded" width={104} height={54} />
            ))}
          </Stack>
          <Box
            sx={{
              display: "grid",
              gap: 2,
              gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" },
            }}
          >
            <Skeleton variant="rounded" height={248} />
            <Skeleton variant="rounded" height={248} />
          </Box>
          <Skeleton variant="rounded" height={236} />
          <Skeleton variant="rounded" height={300} />
        </Stack>
      )}

      {data && <JobBody data={data} range={range} />}
    </Stack>
  );
}

function JobBody({ data, range }: { data: JobDetailData; range: TimeRangeId }) {
  const points = data.series.points;
  const waitPoints = data.waitSeries.points;
  const runs = data.recent as Run[];

  // `runs === 0` is a 200 on a job that exists: it simply did not run in this
  // window. That is a different sentence from "unknown job", and it gets its own
  // state instead of three empty charts.
  const emptyWindow = data.runs === 0;

  // Cron handlers (`@nestjs/schedule`) are not queued, so the agent sends no
  // `waitDuration` and no attempt counts for them. Zero would be a lie; "—" plus
  // a caption is the truth.
  const waitSamples = waitPoints.reduce((total, point) => total + point.samples, 0);
  const waitKnown = waitSamples > 0;
  const attemptsKnown = data.maxAttempts !== null || runs.some((run) => run.attemptsMade !== null);
  // "Slower than p95" only means something with a tail to be slower than.
  const verdicts = data.runs >= SLOW_VERDICT_MIN_RUNS && data.p95Ms > 0;
  // The rollup's log-scale histogram tops out around 256 ms (slot 24 of
  // `2 ** (index / 3)`), so a slow handler's buckets all pile into the ceiling.
  // The chart then cannot show a tail longer than that, and must say so rather
  // than let the line disagree with the exact p95 in the stat row above.
  const saturated = points.some((point) => (point.p95Ms ?? 0) >= 250);

  const bars = points.map((point) => ({
    bucket: timeLabel(point.t, range),
    runs: point.requests,
    failed: point.errors,
  }));

  const durationLines: Line[] = [
    {
      id: "avg",
      color: colors.muted,
      data: points.map((point) => ({ x: timeLabel(point.t, range), y: point.avgMs })),
    },
    {
      id: "p95",
      color: colors.accent,
      data: points.map((point) => ({ x: timeLabel(point.t, range), y: point.p95Ms })),
    },
  ];

  const waitLines: Line[] = [
    {
      id: "avg",
      color: colors.muted,
      data: waitPoints.map((point) => ({ x: timeLabel(point.t, range), y: point.avgMs })),
    },
    {
      id: "p95",
      color: colors.accent,
      data: waitPoints.map((point) => ({ x: timeLabel(point.t, range), y: point.p95Ms })),
    },
  ];

  return (
    <>
      <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
        <Stat
          label="Runs"
          value={formatCount(data.runs)}
          aside={`${formatCount(data.completed)} completed`}
        />
        <Stat
          label="Failed"
          value={formatCount(data.failed)}
          tone={data.failed > 0 ? "danger" : "default"}
          aside={formatPercent(data.failureRate, 2)}
        />
        <Stat
          label="p95 duration"
          value={formatDuration(data.p95Ms)}
          aside={`avg ${formatDuration(data.avgMs)}`}
        />
        <Stat
          label="p95 queue wait"
          value={waitKnown ? formatDuration(data.p95WaitMs) : "—"}
          aside={
            waitKnown
              ? `avg ${formatDuration(data.avgWaitMs)} · max ${formatDuration(data.maxWaitMs)}`
              : "not reported"
          }
          hint={
            waitKnown
              ? "Queue wait is enqueue → first attempt, delay excluded. 95% of this job's runs started within this long of being enqueued. Duration alone cannot see a backlog: a run that waited four minutes and then took 10 ms looks perfect above."
              : "This job reports no queue wait. @nestjs/schedule handlers are not queued, so there is nothing to wait for — only BullMQ jobs report enqueuedAt."
          }
        />
        <Stat
          label="Retried"
          value={attemptsKnown ? formatCount(data.retried) : "—"}
          aside={
            !attemptsKnown
              ? "no attempt data"
              : data.maxAttempts !== null
                ? `max ${data.maxAttempts} attempts`
                : `${formatCount(data.totalAttempts)} attempts`
          }
          hint={
            attemptsKnown
              ? "Runs that needed more than one attempt (attemptsMade > 0). A handler that succeeds on its third try every time is a retry storm, not a healthy job: it is doing three times the work and hiding it behind a green status."
              : "The agent reported no attempt counts for these runs, so retries cannot be counted."
          }
        />
        <Stat
          label="Last run"
          value={data.lastRunAt > 0 ? formatRelative(data.lastRunAt) : "—"}
          aside={data.lastRunAt > 0 ? formatClock(data.lastRunAt) : undefined}
          hint={
            data.lastRunAt > 0
              ? `Last run started ${new Date(data.lastRunAt).toLocaleString()}. When the window is empty this is the most recent run outside it, which is the quickest answer to "is it still running at all?".`
              : undefined
          }
        />
      </Stack>

      {emptyWindow ? (
        <Panel
          title="Runs"
          caption="Runs and failures per bucket come from this handler's own per-minute rollup (kind = 'job'), not from the application's request numbers."
        >
          <EmptyState
            title="This job did not run in the selected window."
            hint={
              data.lastRunAt > 0
                ? `It exists — its last run was ${formatRelative(data.lastRunAt)}. Widen the range in the top bar, or check that its queue worker or scheduler is still up.`
                : "The handler is known to the collector but has no runs at all yet."
            }
          />
        </Panel>
      ) : (
        <>
          <Box
            sx={{
              display: "grid",
              gap: 2,
              gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" },
            }}
          >
            <Panel
              title="Runs"
              meta={
                <Legend
                  keys={[
                    ["Runs", colors.muted],
                    ["Failed", colors.danger],
                  ]}
                />
              }
              caption="Runs and failed runs per bucket. Failures are counted once per run, at the status the agent reported — a run retried three times and then failed is one failed run here, and one row under Runs."
            >
              {bars.length === 0 ? (
                <EmptyState title="No per-minute rollup for this handler in the window." />
              ) : (
                <Box sx={{ height: 190 }}>
                  <ResponsiveBar
                    data={bars}
                    keys={["runs", "failed"]}
                    indexBy="bucket"
                    margin={{ top: 10, right: 8, bottom: 40, left: 36 }}
                    padding={0.35}
                    colors={[colors.muted, colors.danger]}
                    enableLabel={false}
                    axisBottom={{
                      tickSize: 0,
                      tickPadding: 6,
                      tickRotation: -28,
                      tickValues: 6,
                    }}
                    axisLeft={{ tickSize: 0, tickPadding: 6, tickValues: 4 }}
                    enableGridY
                    gridYValues={4}
                    theme={chartTheme}
                    animate={false}
                  />
                </Box>
              )}
            </Panel>

            <Panel
              title="Duration"
              meta={
                <Legend
                  keys={[
                    ["avg", colors.muted],
                    ["p95", colors.accent],
                  ]}
                />
              }
              caption={
                saturated
                  ? "Processing time inside the handler, queue wait excluded. The p95 line is merged from the per-minute log-scale histograms, which top out near 256 ms: a bucket whose tail is longer than that is drawn at the ceiling, so read the exact p95 in the stat row for the window's real tail."
                  : "Processing time inside the handler, queue wait excluded. Percentiles are merged from the per-minute duration histograms, so a p95 over an hour is a real p95 and not an average of p95s."
              }
            >
              {points.length === 0 ? (
                <EmptyState title="No duration samples in the window." />
              ) : (
                <Box sx={{ height: 190 }}>
                  <LineChart lines={durationLines} />
                </Box>
              )}
            </Panel>
          </Box>

          <Panel
            title="Queue wait"
            meta={
              <Legend
                keys={[
                  ["avg", colors.muted],
                  ["p95", colors.accent],
                ]}
              />
            }
            caption={
              waitKnown
                ? "Time between enqueue and the first attempt, delay excluded — the backlog signal. Duration cannot see this: a run that waited four minutes and then took 10 ms is the same shape on the chart above as a healthy one. A bucket's p95 is percentile_cont over the runs in that bucket, so a bucket with a single run plots that run as its own p95; read the average line for shape and the p95 for the tail."
                : "This job reported no queue wait in the window. That is expected for @nestjs/schedule handlers — nothing enqueued them — and means the agent sent no waitDuration for these runs."
            }
          >
            {waitPoints.length === 0 ? (
              <EmptyState
                title={
                  waitKnown
                    ? "No queue wait in the window."
                    : "Queue wait is not reported for this job."
                }
                hint={
                  waitKnown
                    ? undefined
                    : "Wait is measured per run from the agent's enqueuedAt/waitDuration. A handler that is not queued has no backlog to watch — check Runs and Duration above instead."
                }
              />
            ) : (
              <Box sx={{ height: 200 }}>
                <LineChart lines={waitLines} />
              </Box>
            )}
          </Panel>

          <RunsTable
            data={data}
            runs={runs}
            range={range}
            waitKnown={waitKnown}
            p95Ms={verdicts ? data.p95Ms : null}
          />
        </>
      )}
    </>
  );
}

/** The newest runs, one row per run, failures expanded in place. */
function RunsTable({
  data,
  runs,
  range,
  waitKnown,
  p95Ms,
}: {
  data: JobDetailData;
  runs: Run[];
  range: TimeRangeId;
  waitKnown: boolean;
  /** The job's p95 duration, or null when the window is too small for a verdict. */
  p95Ms: number | null;
}) {
  return (
    <Panel
      title="Runs"
      flush
      meta={
        <Typography sx={{ fontSize: 11, color: "text.disabled", ...tabular }}>
          {formatNumber(data.runs)} in window · newest {formatNumber(runs.length)}
        </Typography>
      }
      caption="One row per run, newest first. A job failure opens no error group, so a failed run's message is shown here and nowhere else in the product."
    >
      {runs.length === 0 ? (
        <EmptyState title="No individual runs stored for this window." />
      ) : (
        <Box sx={{ maxHeight: 560, overflowY: "auto" }}>
          <Table size="small">
            <TableHead
              sx={{ position: "sticky", top: 0, zIndex: 2, backgroundColor: colors.surface }}
            >
              <TableRow>
                <TableCell>Started</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Duration</TableCell>
                <TableCell align="right">Queue wait</TableCell>
                <TableCell align="right">Attempts</TableCell>
                <TableCell align="right">Spans</TableCell>
                <TableCell>Run</TableCell>
                <TableCell>Trace</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {runs.map((run) => (
                <RunRows
                  key={run.id}
                  run={run}
                  range={range}
                  waitKnown={waitKnown}
                  runsInWindow={data.runs}
                  p95Ms={p95Ms}
                />
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
    </Panel>
  );
}

function RunRows({
  run,
  range,
  waitKnown,
  runsInWindow,
  p95Ms,
}: {
  run: Run;
  range: TimeRangeId;
  waitKnown: boolean;
  runsInWindow: number;
  p95Ms: number | null;
}) {
  const failed = run.jobStatus === "failed";
  // A failed run is already the story; the tail marker is for successes that hid
  // behind a healthy-looking average.
  const slow =
    p95Ms !== null && !failed && run.durationMs !== null && run.durationMs > p95Ms;

  return (
    <>
      <TableRow hover>
        <TableCell sx={{ whiteSpace: "nowrap", verticalAlign: "top" }}>
          <Tooltip title={new Date(run.startedAt).toLocaleString()}>
            <Box component="span" sx={{ display: "block", fontSize: 12 }}>
              {formatRelative(run.startedAt)}
            </Box>
          </Tooltip>
          {/* The collector's clock, not the agent's `calledAt` string: it is the
              one that lines up with the buckets in the charts above. */}
          <Typography sx={{ fontSize: 10.5, color: "text.disabled", ...tabular }}>
            {formatClock(run.startedAt)}
          </Typography>
        </TableCell>

        <TableCell sx={{ verticalAlign: "top" }}>
          <StatusPill status={run.jobStatus} />
        </TableCell>

        <TableCell align="right" sx={{ whiteSpace: "nowrap", verticalAlign: "top" }}>
          <Stack
            direction="row"
            spacing={0.75}
            sx={{ alignItems: "center", justifyContent: "flex-end" }}
          >
            <Box component="span" sx={{ ...tabular, fontSize: 12.5 }}>
              {formatDuration(run.durationMs)}
            </Box>
            {slow && (
              <Tooltip
                title={`Slower than 95% of this job's ${formatNumber(runsInWindow)} runs in the window (p95 ${formatDuration(p95Ms)}).`}
              >
                <Box
                  component="span"
                  sx={{
                    fontSize: 9.5,
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: colors.warn,
                    border: `1px solid ${colors.warn}55`,
                    borderRadius: 0.75,
                    px: 0.4,
                    cursor: "help",
                  }}
                >
                  p95
                </Box>
              </Tooltip>
            )}
          </Stack>
        </TableCell>

        <TableCell align="right" sx={{ whiteSpace: "nowrap", verticalAlign: "top" }}>
          <WaitCell waitMs={run.waitMs} waitKnown={waitKnown} />
        </TableCell>

        <TableCell align="right" sx={{ whiteSpace: "nowrap", verticalAlign: "top" }}>
          <AttemptsCell attemptsMade={run.attemptsMade} maxAttempts={run.maxAttempts} />
        </TableCell>

        <TableCell align="right" sx={{ color: "text.secondary", ...tabular, verticalAlign: "top" }}>
          {formatCount(run.spanCount)}
        </TableCell>

        <TableCell sx={{ verticalAlign: "top" }}>
          <RouterLink
            to={withRange(`/executions/${run.id}`, range)}
            style={{ color: colors.accentText, textDecoration: "none", fontSize: 11.5 }}
            title="Open this run: its spans and logs"
          >
            {shortId(run.id)}
          </RouterLink>
        </TableCell>

        <TableCell sx={{ verticalAlign: "top" }}>
          <RouterLink
            to={withRange(`/traces/${run.traceId}`, range)}
            style={{ color: colors.accentText, textDecoration: "none", fontSize: 11.5 }}
            title="Every service this run's trace touched"
          >
            {shortId(run.traceId)}
          </RouterLink>
        </TableCell>
      </TableRow>

      {failed && (
        <TableRow>
          <TableCell colSpan={8} sx={{ py: 0, borderBottom: `1px solid ${colors.border}` }}>
            <FailureLine error={run.error} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * The failure payload, inline. This is the only place a job's failure reason
 * exists in the product: unlike a request, a job failure never opens an error
 * group, so there is no page to link to.
 */
function FailureLine({ error }: { error: Run["error"] }) {
  if (!error) {
    return (
      <Box sx={{ pl: 2, py: 0.75, borderLeft: `2px solid ${colors.danger}44` }}>
        <Typography sx={{ fontSize: 11.5, color: "text.disabled" }}>
          This run failed without a stored error. Failures recorded before the
          collector persisted job error payloads only carry the status and the
          span tree.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ pl: 2, py: 0.75, borderLeft: `2px solid ${colors.danger}` }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "baseline", flexWrap: "wrap" }}>
        {error.cls && (
          <Box
            component="code"
            sx={{
              fontFamily: fontMono,
              fontSize: 10.5,
              color: colors.danger,
              backgroundColor: "rgba(255, 77, 94, 0.12)",
              borderRadius: 0.75,
              px: 0.6,
              py: 0.1,
            }}
          >
            {error.cls}
          </Box>
        )}
        <Typography sx={{ fontSize: 12, color: "text.primary", wordBreak: "break-word" }}>
          {error.message}
        </Typography>
      </Stack>
      {error.stack && (
        <Typography
          component="pre"
          sx={{
            mt: 0.5,
            mb: 0,
            fontFamily: fontMono,
            fontSize: 10.5,
            lineHeight: 1.45,
            color: "text.disabled",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 96,
            overflow: "hidden",
          }}
        >
          {firstStackFrames(error.stack)}
        </Typography>
      )}
    </Box>
  );
}

/** Attempts read as progress, not as a raw counter: `2/3`, never `1/3 → 2nd`. */
function AttemptsCell({
  attemptsMade,
  maxAttempts,
}: {
  attemptsMade: number | null;
  maxAttempts: number | null;
}) {
  // `attemptsMade` is the SDK's "attempts before this run", so the first try
  // reports 0. Printing `0/3` would read as "no attempts"; humans count the try
  // they are looking at, so the cell shows attempt 1 of 3 and the tooltip says
  // what the agent actually reported.
  if (attemptsMade === null) {
    return (
      <Tooltip title="The agent reported no attempt count for this run — cron handlers are not queued and have no retry budget.">
        <Box component="span" sx={{ fontSize: 11, color: "text.disabled" }}>
          unknown
        </Box>
      </Tooltip>
    );
  }

  const attempt = attemptsMade + 1;
  return (
    <Tooltip
      title={
        maxAttempts === null
          ? `Attempt ${attempt}. The agent reported no retry budget.`
          : `Attempt ${attempt} of ${maxAttempts} (the agent reported ${attemptsMade} attempt${attemptsMade === 1 ? "" : "s"} made before this run).`
      }
    >
      <Box component="span" sx={{ ...tabular, fontSize: 12.5, cursor: "help" }}>
        {attemptsMade > 0 ? (
          <Box component="span" sx={{ color: colors.warn }}>
            {attempt}
          </Box>
        ) : (
          attempt
        )}
        {maxAttempts !== null && (
          <Box component="span" sx={{ color: "text.disabled" }}>
            /{maxAttempts}
          </Box>
        )}
      </Box>
    </Tooltip>
  );
}

/** `5.01 s`, or `unknown` — a missing wait is not a zero-second wait. */
function WaitCell({ waitMs, waitKnown }: { waitMs: number | null; waitKnown: boolean }) {
  if (waitMs === null) {
    return (
      <Tooltip
        title={
          waitKnown
            ? "This run reported no queue wait, while others of the same job did."
            : "No queue wait was reported for this job: @nestjs/schedule handlers are not enqueued, so there is nothing to wait for."
        }
      >
        <Box component="span" sx={{ fontSize: 11, color: "text.disabled" }}>
          unknown
        </Box>
      </Tooltip>
    );
  }
  return (
    <Box component="span" sx={{ ...tabular, fontSize: 12.5 }}>
      {formatDuration(waitMs)}
    </Box>
  );
}

function StatusPill({ status }: { status: Run["jobStatus"] }) {
  if (!status) {
    return (
      <Typography sx={{ fontSize: 11, color: "text.disabled" }}>unknown</Typography>
    );
  }
  const failed = status === "failed";
  const color = failed ? colors.danger : colors.ok;
  return (
    <Stack direction="row" spacing={0.6} sx={{ alignItems: "center", color }}>
      <Box sx={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: color }} />
      <Typography
        sx={{ fontSize: 11.5, fontWeight: 600, letterSpacing: "0.01em", color: "inherit" }}
      >
        {failed ? "Failed" : "Completed"}
      </Typography>
    </Stack>
  );
}

function LineChart({ lines }: { lines: Line[] }) {
  return (
    <ResponsiveLine
      data={lines}
      margin={{ top: 10, right: 14, bottom: 40, left: 46 }}
      xScale={{ type: "point" }}
      yScale={{ type: "linear", min: 0, max: "auto" }}
      curve="monotoneX"
      colors={(line) => line.color}
      lineWidth={1.8}
      enablePoints={false}
      enableGridX={false}
      axisBottom={{ tickSize: 0, tickPadding: 6, tickRotation: -28, tickValues: 6 }}
      axisLeft={{
        tickSize: 0,
        tickPadding: 6,
        tickValues: 4,
        format: (value) => formatDuration(Number(value)),
      }}
      theme={chartTheme}
      animate={false}
      enableSlices="x"
    />
  );
}

/**
 * The 404 state. It is its own panel because "this handler has never run here" is
 * a different answer from every other failure, and an empty chart would suggest
 * the opposite: that it ran and did nothing.
 */
function MissingJob({
  appId,
  appName,
  queue,
  name,
  range,
}: {
  appId: string;
  appName: string;
  queue: string;
  name: string;
  range: TimeRangeId;
}) {
  return (
    <Panel title="Unknown job">
      <EmptyState
        title={`There is no job “${queue} · ${name}” in ${appName}.`}
        hint="A job is keyed <queue>/<name> from what the agent reports, so a name that never ran under this application is a 404 rather than an empty page. Check the spelling against the Jobs list — a renamed handler is a new job."
      />
      <Stack direction="row" spacing={1} sx={{ justifyContent: "center", pb: 2 }}>
        <Button
          size="small"
          variant="outlined"
          component={RouterLink}
          to={jobsHref(appId, range)}
          startIcon={<CaretLeft size={11} weight="bold" />}
        >
          Back to jobs
        </Button>
      </Stack>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * One run, as `recent[]` comes back. The server models that array as `Any` (the
 * error payload is the SDK's, not ours), so the page spells out the shape it
 * actually reads instead of threading `any` through the table.
 */
interface Run {
  id: string;
  traceId: string;
  startedAt: number;
  durationMs: number | null;
  waitMs: number | null;
  enqueuedAt: string | null;
  attemptsMade: number | null;
  maxAttempts: number | null;
  jobStatus: "completed" | "failed" | null;
  error: {
    cls?: string;
    message: string;
    stack?: string;
    tags?: Record<string, string | number | boolean>;
    codeFrames?: unknown;
  } | null;
  spanCount: number;
}

type JobDetailData = NonNullable<Awaited<ReturnType<typeof api.jobDetail>>>;

interface Line {
  id: string;
  color: string;
  data: Array<{ x: string; y: number | null }>;
}

// ---------------------------------------------------------------------------
// Links and labels
// ---------------------------------------------------------------------------

/** Same pattern as `Application.tsx`: view settings travel with the link. */
function withRange(path: string, range: TimeRangeId): string {
  return `${path}${path.includes("?") ? "&" : "?"}range=${range}`;
}

function jobsHref(appId: string, range: TimeRangeId): string {
  // The project jobs page, filtered to this handler's application. The list is
  // project-scoped now, so that is where the sidebar's Jobs entry lands — the
  // back link has to go to the same place or "back" means two different pages.
  return withRange(`/jobs?app=${encodeURIComponent(appId)}`, range);
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 10)}…` : id;
}

/** The first few frames: enough to recognise the bug, not a wall of text. */
function firstStackFrames(stack: string): string {
  return stack.split("\n").slice(0, 4).join("\n");
}

function timeLabel(at: number, range: TimeRangeId): string {
  const date = new Date(at);
  if (range === "3d" || range === "7d" || range === "30d") {
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------------------
// Page furniture. The heading is the shell's; the rest is local to this page and
// deliberately the same set `Jobs.tsx` and `Operation.tsx` carry, so the job
// pages read as one family.
// ---------------------------------------------------------------------------

function Panel({
  title,
  meta,
  caption,
  children,
  flush = false,
}: {
  title: string;
  meta?: ReactNode;
  caption?: string;
  children: ReactNode;
  /** Tables draw their own edges: no padding around them. */
  flush?: boolean;
}) {
  return (
    <Paper sx={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Stack
        direction="row"
        sx={{
          px: 2,
          py: 1.25,
          borderBottom: `1px solid ${colors.border}`,
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{title}</Typography>
        {meta}
      </Stack>
      <Box sx={{ p: flush ? 0 : 1.5, flex: 1 }}>{children}</Box>
      {caption && (
        <Typography
          sx={{ px: 2, pb: 1.5, pt: flush ? 1.25 : 0, fontSize: 11, color: "text.disabled" }}
        >
          {caption}
        </Typography>
      )}
    </Paper>
  );
}

function Stat({
  label,
  value,
  aside,
  tone = "default",
  hint,
}: {
  label: string;
  value: string;
  aside?: string;
  tone?: "default" | "danger";
  /** Why the number matters — the queue-wait stat is unreadable without it. */
  hint?: string;
}) {
  const body = (
    <Box
      sx={{
        border: `1px solid ${colors.border}`,
        borderRadius: 1,
        px: 1.5,
        py: 0.75,
        minWidth: 104,
        ...(hint ? { cursor: "help" } : {}),
      }}
    >
      <Typography sx={{ ...labelCaps, ...(hint ? { borderBottom: `1px dotted ${colors.borderStrong}`, display: "inline-block" } : {}) }}>
        {label}
      </Typography>
      <Typography
        sx={{
          ...tabular,
          fontSize: 16,
          fontWeight: 600,
          color: tone === "danger" ? colors.danger : "text.primary",
        }}
      >
        {value}
      </Typography>
      {aside && (
        <Typography sx={{ fontSize: 10.5, color: "text.disabled", ...tabular }}>{aside}</Typography>
      )}
    </Box>
  );
  return hint ? (
    <Tooltip title={hint}>
      <Box>{body}</Box>
    </Tooltip>
  ) : (
    body
  );
}

function Legend({ keys }: { keys: Array<[string, string]> }) {
  return (
    <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
      {keys.map(([label, color]) => (
        <Stack key={label} direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
          <Box sx={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: color }} />
          <Typography sx={{ ...labelCaps, color: "text.secondary" }}>{label}</Typography>
        </Stack>
      ))}
    </Stack>
  );
}

function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <Box
      sx={{
        border: `1px dashed ${colors.borderStrong}`,
        borderRadius: 1,
        px: 3,
        py: 5,
        m: 1.5,
        textAlign: "center",
      }}
    >
      <Typography sx={{ fontSize: 13, color: "text.secondary" }}>{title}</Typography>
      {hint && (
        <Typography sx={{ mt: 0.75, fontSize: 11.5, color: "text.disabled", maxWidth: 620, mx: "auto" }}>
          {hint}
        </Typography>
      )}
    </Box>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Nivo reads a theme, not MUI: keep the two in step by hand, once. */
const chartTheme = {
  background: "transparent",
  text: { fontSize: 10, fill: colors.faint },
  axis: {
    domain: { line: { stroke: colors.border, strokeWidth: 1 } },
    ticks: {
      line: { stroke: colors.border, strokeWidth: 1 },
      text: { fontSize: 10, fill: colors.faint },
    },
  },
  grid: { line: { stroke: colors.grid, strokeWidth: 1 } },
  crosshair: { line: { stroke: colors.borderStrong, strokeWidth: 1 } },
  legends: { text: { fontSize: 10, fill: colors.muted } },
  tooltip: {
    container: {
      background: colors.surfaceRaised,
      border: `1px solid ${colors.borderStrong}`,
      borderRadius: 8,
      color: colors.text,
      fontSize: 11,
      padding: "6px 9px",
      boxShadow: "none",
    },
  },
} as const;
