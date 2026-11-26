/**
 * Jobs — the background work of the project: BullMQ consumers and
 * `@nestjs/schedule` handlers, read the same way as requests.
 *
 * Under "All applications" this is every handler in the project; with one
 * application selected it is that service's handlers, and the Application column
 * goes away because the scope already says it. Rows are grouped **application ·
 * queue → job name**, because that is the unit a job has: the name is the
 * handler, the queue is the pool it competes for workers in — and two services
 * that both consume a queue called `render` are two different handlers, not one
 * with twice the traffic. Two numbers get priority here, and they answer
 * different questions:
 *
 *   * `failure rate` — is the handler wrong?
 *   * `p95 queue wait` — is the queue backed up? A job that waited four minutes
 *     and then ran in 10 ms looks healthy on duration alone, so the wait column
 *     is called out in a tooltip rather than left to be discovered.
 *
 * Every row opens `/applications/:id/jobs/:queue/:name` — the job detail page,
 * which charts this handler's own runs, failures, duration and queue wait per
 * bucket. The application in that path comes from the **row**, not from the
 * page: the list is project-wide and a row may belong to any service. The two
 * cards here stay *by queue* because that is the list's unit (a queue is what
 * competes for workers), and the per-bucket timeline belongs to the one job you
 * drilled into.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
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
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, type JobRow } from "../api";
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatRelative,
  windowFor,
  type TimeRangeId,
} from "../format";
import { colors, fontMono, labelCaps, tabular } from "../theme";
import { PageHeader } from "../components/shell/PageHeader";
import { useLiveInterval, useShell } from "../components/shell";

export interface JobsProps {
  /** The shell's scope. Empty means the whole project. */
  appId?: string;
  /** Legacy wiring used `id`; accepted so either route shape works. */
  id?: string;
  range?: TimeRangeId;
  /** The shell's navigator; a row click is a navigation, not a link element. */
  navigate?: (to: string) => void;
}

export function Jobs({ appId, id, range = "1h", navigate }: JobsProps) {
  // The shell's `?app=` is the scope, and it is empty under "All applications" —
  // which is a real view, not a missing one, so there is no gate to render. The
  // legacy `/applications/:id/jobs` path still names a concrete application, so
  // a bookmark of it keeps scoping to that service instead of silently widening
  // to the project.
  const scope = appId || id || "";
  // The shell always passes `navigate`, but the hook keeps the page working on
  // its own — and React wants the call to be unconditional either way.
  const routerNavigate = useNavigate();
  const go = navigate ?? routerNavigate;
  return <JobsView scope={scope} range={range} go={go} />;
}

function JobsView({
  scope,
  range,
  go,
}: {
  /** `""` for the whole project; an application id otherwise. */
  scope: string;
  range: TimeRangeId;
  go: (to: string) => void;
}) {
  const refetchInterval = useLiveInterval();
  const { apps } = useShell();
  const unscoped = scope === "";
  const scopeName = unscoped
    ? null
    : apps.find((entry) => entry.id === scope)?.name ?? scope;

  const jobs = useQuery({
    queryKey: ["jobs", scope, range],
    queryFn: () => api.jobs(scope, windowFor(range)),
    refetchInterval,
  });

  const rows = jobs.data ?? [];
  const groups = groupByQueue(rows, unscoped);
  const totals = rows.reduce(
    (acc, row) => ({ runs: acc.runs + row.runs, failed: acc.failed + row.failed }),
    { runs: 0, failed: 0 },
  );
  // How many services the tiles above are summing. Under "All applications" a
  // bare "Runs" would read as one service's throughput, which is the number the
  // overview is judged on — so the caption says what the sum covers.
  const applicationCount = new Set(rows.map((row) => row.applicationId)).size;
  const across = unscoped
    ? `across ${applicationCount} ${applicationCount === 1 ? "application" : "applications"}`
    : undefined;
  // `application · queue` ticks are long and rotated, so they hang below the
  // axis; the card's bottom margin grows with the longest of them or the leading
  // characters are clipped off the bottom of the SVG.
  const longestLabel = Math.max(0, ...groups.slice(0, 14).map((group) => group.label.length));
  const axisRoom = unscoped ? Math.min(88, 22 + longestLabel * 3.1) : 34;
  const chartHeight = unscoped ? 210 : 180;

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Jobs"
        description={
          unscoped
            ? "Every queue consumer and scheduler in the project, grouped by application and queue."
            : `${scopeName} — queue consumers and scheduled handlers, grouped by queue and job name.`
        }
        actions={
          <Stack direction="row" spacing={1}>
            <Stat label="Runs" value={formatCount(totals.runs)} aside={across} />
            <Stat
              label="Failed"
              value={formatCount(totals.failed)}
              tone={totals.failed > 0 ? "danger" : "default"}
              aside={across}
            />
            <Stat
              label="Queues"
              value={String(groups.length)}
              aside={across}
              hint="Counted per application: two services consuming a queue of the same name are two queues here, because each is its own pool of workers and its own handler."
            />
          </Stack>
        }
      />

      {jobs.isError && (
        <Alert severity="error">
          The job list could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {errorMessage(jobs.error)}
          </Box>
        </Alert>
      )}

      {jobs.isLoading ? (
        <Stack direction={{ xs: "column", lg: "row" }} spacing={2}>
          <Box sx={{ flex: 1 }}>
            <Panel title="Jobs">
              <Skeleton variant="rounded" height={180} />
            </Panel>
          </Box>
          <Box sx={{ flex: 1 }}>
            <Panel title="Jobs duration">
              <Skeleton variant="rounded" height={180} />
            </Panel>
          </Box>
        </Stack>
      ) : rows.length === 0 && !jobs.isError ? (
        <EmptyState
          title="No jobs yet — the SDK reports BullMQ and @nestjs/schedule handlers automatically."
          hint={
            unscoped
              ? "Nothing to configure: a queue consumer or an @Cron() method that runs anywhere in the project inside the selected window shows up here. An empty project list means no handler ran — not that the scope is wrong."
              : "Nothing to configure: a queue consumer or an @Cron() method that runs inside the selected window shows up here."
          }
        />
      ) : (
        <>
          <Stack direction={{ xs: "column", lg: "row" }} spacing={2}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Panel
                title="Jobs"
                meta={<Legend keys={[["runs", colors.muted], ["failed", colors.danger]]} />}
                caption={
                  unscoped
                    ? "Runs and failed runs per application · queue. Two services consuming a `render` queue are two handlers, so they are two bars; open one for its own per-bucket series, its queue wait and its individual runs."
                    : "Runs and failed runs per queue. Open a job for its own per-bucket series, its queue wait and its individual runs — a job's timeline comes from rollups tagged kind = 'job', so it never mixes in the application's request traffic."
                }
              >
                <Box sx={{ height: chartHeight }}>
                  <ResponsiveBar
                    data={jobBars(groups)}
                    keys={["runs", "failed"]}
                    indexBy="label"
                    margin={{ top: 10, right: 8, bottom: axisRoom, left: 34 }}
                    padding={0.35}
                    colors={[colors.muted, colors.danger]}
                    enableLabel={false}
                    axisBottom={{
                      tickSize: 0,
                      tickPadding: 6,
                      tickRotation: -30,
                    }}
                    axisLeft={{ tickSize: 0, tickPadding: 6, tickValues: 4 }}
                    enableGridY
                    gridYValues={4}
                    theme={chartTheme}
                    animate={false}
                  />
                </Box>
              </Panel>
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Panel
                title="Jobs duration"
                meta={<Legend keys={[["avg", colors.muted], ["p95", colors.accent]]} />}
                caption={
                  unscoped
                    ? "Average run time and the worst job's p95, per application · queue. p95 is a maximum over that queue's jobs, not a blend — the per-job percentiles are on each job's own page."
                    : "Average run time and the worst job's p95, per queue. p95 is a maximum over the queue's jobs, not a blend — the per-job percentiles are on each job's own page."
                }
              >
                <Box sx={{ height: chartHeight }}>
                  <ResponsiveLine
                    data={durationLines(groups)}
                    margin={{ top: 10, right: 12, bottom: axisRoom, left: 40 }}
                    xScale={{ type: "point" }}
                    yScale={{ type: "linear", min: 0, max: "auto" }}
                    curve="monotoneX"
                    colors={[colors.muted, colors.accent]}
                    lineWidth={2}
                    enablePoints={false}
                    enableGridX={false}
                    axisBottom={{
                      tickSize: 0,
                      tickPadding: 6,
                      tickRotation: -30,
                    }}
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
                </Box>
              </Panel>
            </Box>
          </Stack>

          <Paper sx={{ overflow: "hidden" }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {/* Only under "All applications": scoped to one service the
                      column repeats the page's own scope on every row. */}
                  {unscoped && <TableCell>Application</TableCell>}
                  <TableCell>Job</TableCell>
                  <TableCell>Queue</TableCell>
                  <TableCell align="right">Runs</TableCell>
                  <TableCell align="right">Failures</TableCell>
                  <TableCell>Failure rate</TableCell>
                  <TableCell align="right">Avg duration</TableCell>
                  <TableCell align="right">
                    <Tooltip title="p95 queue wait: 95% of runs started within this long of being enqueued. A job that waited four minutes and then ran in 10 ms is invisible on duration alone — this is the backlog signal. Watch it grow before the queue burns through, not after.">
                      <Box component="span" sx={{ borderBottom: `1px dotted ${colors.borderStrong}` }}>
                        p95 wait
                      </Box>
                    </Tooltip>
                  </TableCell>
                  <TableCell align="right">Retries</TableCell>
                  <TableCell align="right">Last run</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {groups.map((group) => (
                  <GroupRows
                    key={group.key}
                    group={group}
                    showApplication={unscoped}
                    range={range}
                    go={go}
                  />
                ))}
              </TableBody>
            </Table>
          </Paper>
        </>
      )}
    </Stack>
  );
}

/** A queue's job rows, introduced by the queue itself — the grouping the page promises. */
function GroupRows({
  group,
  showApplication,
  range,
  go,
}: {
  group: QueueGroup;
  /** Unscoped lists name the service in the group heading too. */
  showApplication: boolean;
  range: TimeRangeId;
  go: (to: string) => void;
}) {
  const columns = showApplication ? 10 : 9;

  return (
    <>
      <TableRow sx={{ "& td": { backgroundColor: colors.surfaceRaised } }}>
        <TableCell colSpan={columns} sx={{ py: 0.75 }}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
            {showApplication && group.applicationName && (
              <>
                <Typography
                  sx={{ fontFamily: fontMono, fontSize: 11, color: "text.disabled" }}
                >
                  {group.applicationName}
                </Typography>
                <Typography sx={{ fontSize: 11, color: "text.disabled" }}>·</Typography>
              </>
            )}
            <Typography sx={{ ...labelCaps, color: "text.secondary" }}>{group.queue}</Typography>
            <Typography sx={{ fontSize: 11, color: "text.disabled", ...tabular }}>
              {formatCount(group.runs)} runs
            </Typography>
            {group.failed > 0 && (
              <Typography sx={{ fontSize: 11, color: colors.danger, ...tabular }}>
                {formatCount(group.failed)} failed
              </Typography>
            )}
            <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
              {group.rows.length} {group.rows.length === 1 ? "job" : "jobs"}
            </Typography>
          </Stack>
        </TableCell>
      </TableRow>
      {group.rows.map((row) => {
        // A job the agent reported without a queue or a name has no page to open
        // (the detail route needs both), so that row stays inert rather than
        // linking somewhere that 404s.
        //
        // The application in the path is the row's own, not the page's scope: a
        // project-wide list holds rows from every service, and the detail page is
        // addressed by (application, queue, name).
        const href =
          row.queue && row.jobName
            ? jobHref(row.applicationId, row.queue, row.jobName, range)
            : null;
        return (
          <TableRow
            key={`${row.applicationId}:${group.queue}:${row.jobName ?? "unnamed"}`}
            // The whole row is the target, not one cell: the reference's list
            // behaves that way, and a nine-column table with a single small link
            // in it is a guessing game. Enter navigates, Space scrolls.
            hover
            tabIndex={href ? 0 : undefined}
            onClick={() => {
              if (href) go(href);
            }}
            onKeyDown={(event) => {
              if (href && event.key === "Enter") go(href);
            }}
            sx={
              href
                ? {
                    cursor: "pointer",
                    "&:focus-visible": {
                      outline: `1px solid ${colors.accent}`,
                      outlineOffset: -1,
                    },
                  }
                : undefined
            }
          >
            {showApplication && (
              <TableCell
                sx={{
                  fontFamily: fontMono,
                  fontSize: 11,
                  color: "text.secondary",
                  whiteSpace: "nowrap",
                }}
              >
                {row.applicationName}
              </TableCell>
            )}
            <TableCell sx={{ fontFamily: "inherit", fontWeight: 500 }}>
              {row.jobName ?? "(unnamed job)"}
            </TableCell>
            <TableCell sx={{ color: "text.secondary", fontSize: 11.5 }}>
              {row.queue ?? "—"}
            </TableCell>
            <TableCell align="right" sx={tabular}>
              {formatCount(row.runs)}
            </TableCell>
            <TableCell
              align="right"
              sx={{ ...tabular, color: row.failed > 0 ? colors.danger : "text.secondary" }}
            >
              {formatCount(row.failed)}
            </TableCell>
            <TableCell>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Box sx={{ ...tabular, minWidth: 48, fontSize: 12 }}>
                  {formatPercent(row.failureRate, 2)}
                </Box>
                <Box
                  sx={{
                    width: 56,
                    height: 4,
                    borderRadius: 1,
                    bgcolor: "rgba(255,255,255,0.07)",
                    overflow: "hidden",
                  }}
                >
                  <Box
                    sx={{
                      width: `${Math.min(row.failureRate, 1) * 100}%`,
                      height: "100%",
                      bgcolor: row.failureRate > 0 ? colors.danger : "transparent",
                    }}
                  />
                </Box>
              </Stack>
            </TableCell>
            <TableCell align="right" sx={tabular}>
              {formatDuration(row.avgMs)}
            </TableCell>
            <TableCell align="right">
              <Tooltip
                title={
                  row.p95WaitMs > 0
                    ? `95% of this job's runs started within ${formatDuration(row.p95WaitMs)} of being enqueued. Average wait was ${formatDuration(row.avgWaitMs)}. Open the job to chart that wait over time.`
                    : "No queue wait recorded: the run was picked up immediately, the agent does not report enqueuedAt, or the handler is a @nestjs/schedule method and is not queued at all."
                }
              >
                <Box
                  component="span"
                  sx={{
                    ...tabular,
                    borderBottom: `1px dotted ${colors.borderStrong}`,
                    cursor: "help",
                  }}
                >
                  {formatDuration(row.p95WaitMs)}
                </Box>
              </Tooltip>
            </TableCell>
            <TableCell align="right" sx={{ ...tabular, color: "text.secondary" }}>
              {formatCount(row.retried)}
            </TableCell>
            {/* The aggregate row has no trace id of its own, so the run-level
                trace links live one click in, on the job's run list. */}
            <TableCell align="right" sx={{ color: "text.secondary", whiteSpace: "nowrap" }}>
              {row.lastRunAt > 0 ? formatRelative(row.lastRunAt) : "—"}
            </TableCell>
          </TableRow>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Data shaping
// ---------------------------------------------------------------------------

/**
 * A row's destination. The segments are encoded because a job name may contain a
 * slash — the API keys a handler `<queue>/<name>`, and the page reads both back
 * out of the route params to ask for exactly that pair.
 *
 * `?range=` travels with the link for the same reason it does in
 * `Application.tsx`: the window is part of what you are looking at, and a link
 * that drops it lands the reader in a different hour.
 */
function jobHref(appId: string, queue: string, jobName: string, range: TimeRangeId): string {
  const encodedQueue = encodeURIComponent(queue);
  const encodedName = encodeURIComponent(jobName);
  return `/applications/${appId}/jobs/${encodedQueue}/${encodedName}?range=${range}`;
}

interface QueueGroup {
  /** Key that keeps two services' same-named queues apart; also React's key. */
  key: string;
  /** The chart's x label: the queue alone when scoped, `app · queue` otherwise. */
  label: string;
  queue: string;
  /** The service that runs it — null when the page is already scoped to it. */
  applicationName: string | null;
  rows: JobRow[];
  runs: number;
  failed: number;
  avgMs: number;
  p95Ms: number;
}

function groupByQueue(rows: JobRow[], unscoped: boolean): QueueGroup[] {
  const map = new Map<string, QueueGroup>();
  for (const row of rows) {
    const queue = row.queue ?? "(no queue)";
    // Under "All applications" the application is part of the grouping key: two
    // services consuming a `render` queue are two handlers competing in two
    // different worker pools, and one merged bar would invent a third.
    const key = unscoped ? `${row.applicationId}:${queue}` : queue;
    const existing = map.get(key) ?? {
      key,
      label: unscoped ? `${row.applicationName} · ${queue}` : queue,
      queue,
      applicationName: unscoped ? row.applicationName : null,
      rows: [],
      runs: 0,
      failed: 0,
      avgMs: 0,
      p95Ms: 0,
    };
    existing.rows.push(row);
    existing.runs += row.runs;
    existing.failed += row.failed;
    existing.avgMs += row.avgMs * row.runs;
    // The queue's p95 is the worst of its jobs: a queue-level percentile cannot
    // be re-derived from per-job percentiles, and under-reporting the tail is
    // the wrong direction to be wrong in.
    existing.p95Ms = Math.max(existing.p95Ms, row.p95Ms);
    map.set(key, existing);
  }
  return [...map.values()]
    .map((group) => ({ ...group, avgMs: group.runs > 0 ? group.avgMs / group.runs : 0 }))
    .sort((a, b) => b.runs - a.runs);
}

function jobBars(groups: QueueGroup[]): Array<{ label: string; runs: number; failed: number }> {
  return groups.slice(0, 14).map((group) => ({
    label: group.label,
    runs: group.runs,
    failed: group.failed,
  }));
}

function durationLines(
  groups: QueueGroup[],
): Array<{ id: string; color: string; data: Array<{ x: string; y: number }> }> {
  const sliced = groups.slice(0, 14);
  return [
    {
      id: "avg",
      color: colors.muted,
      data: sliced.map((group) => ({ x: group.label, y: Math.round(group.avgMs * 100) / 100 })),
    },
    {
      id: "p95",
      color: colors.accent,
      data: sliced.map((group) => ({ x: group.label, y: Math.round(group.p95Ms * 100) / 100 })),
    },
  ];
}

// ---------------------------------------------------------------------------
// Page furniture. The heading is the shell's; the rest is local to this page.
// ---------------------------------------------------------------------------

function Panel({
  title,
  meta,
  caption,
  children,
}: {
  title: string;
  meta?: ReactNode;
  caption?: string;
  children: ReactNode;
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
      <Box sx={{ p: 1.5, flex: 1 }}>{children}</Box>
      {caption && (
        <Typography sx={{ px: 2, pb: 1.5, fontSize: 11, color: "text.disabled" }}>
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
  /** What the number covers — a project-wide sum must say so. */
  aside?: string;
  tone?: "default" | "danger";
  hint?: string;
}) {
  const body = (
    <Box
      sx={{
        border: `1px solid ${colors.border}`,
        borderRadius: 1,
        px: 1.5,
        py: 0.75,
        minWidth: 74,
        ...(hint ? { cursor: "help" } : {}),
      }}
    >
      <Typography sx={labelCaps}>{label}</Typography>
      <Typography
        sx={{ ...tabular, fontSize: 16, fontWeight: 600, color: tone === "danger" ? colors.danger : "text.primary" }}
      >
        {value}
      </Typography>
      {aside && (
        <Typography sx={{ fontSize: 10, color: "text.disabled", ...tabular }}>{aside}</Typography>
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
        py: 6,
        textAlign: "center",
      }}
    >
      <Typography sx={{ fontSize: 13, color: "text.secondary" }}>{title}</Typography>
      {hint && (
        <Typography sx={{ mt: 0.75, fontSize: 11.5, color: "text.disabled" }}>{hint}</Typography>
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
