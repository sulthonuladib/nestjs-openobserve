/**
 * Jobs — the background work of one application: BullMQ consumers and
 * `@nestjs/schedule` handlers, read the same way as requests.
 *
 * Grouped **queue → job name**, because that is the unit a job has: the name is
 * the handler, the queue is the pool it competes for workers in. Two numbers get
 * priority here, and they answer different questions:
 *
 *   * `failure rate` — is the handler wrong?
 *   * `p95 queue wait` — is the queue backed up? A job that waited four minutes
 *     and then ran in 10 ms looks healthy on duration alone, so the wait column
 *     is called out in a tooltip rather than left to be discovered.
 *
 * The two cards are the reference's two job cards. They cannot be timelines:
 * `timeseries` is per kind-less rollup (`/applications/:id/timeseries` has no
 * request/job split), and inventing an endpoint from the UI is not something
 * this dashboard does. So they are honest breakdowns *by queue* — the shape you
 * can actually derive from `/jobs` rows — and both cards say so in their caption.
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
import { api, type JobRow } from "../api";
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatRelative,
  windowFor,
  type TimeRangeId,
} from "../format";
import { colors, labelCaps, tabular } from "../theme";
import { PageHeader } from "../components/shell/PageHeader";
import { useLiveInterval } from "../components/shell";

export interface JobsProps {
  /** The application under view. The shell passes `appId`. */
  appId?: string;
  /** Legacy wiring used `id`; accepted so either route shape works. */
  id?: string;
  range?: TimeRangeId;
}

export function Jobs({ appId, id, range = "1h" }: JobsProps) {
  // `appId` is the shell's scope and is empty under "All applications"; the
  // route param is still a concrete application, so fall back to it.
  const applicationId = appId || id;
  if (!applicationId) {
    return (
      <Stack spacing={3}>
        <PageHeader
          title="Jobs"
          description="View and analyze jobs processed by your applications."
        />
        <EmptyState
          title="Pick an application first."
          hint="Jobs belong to one application, so the queue list needs a scope. Use the application switcher in the top bar."
        />
      </Stack>
    );
  }
  return <JobsForApplication appId={applicationId} range={range} />;
}

function JobsForApplication({ appId, range }: { appId: string; range: TimeRangeId }) {
  const refetchInterval = useLiveInterval();
  const jobs = useQuery({
    queryKey: ["jobs", appId, range],
    queryFn: () => api.jobs(appId, windowFor(range)),
    refetchInterval,
  });

  const rows = jobs.data ?? [];
  const groups = groupByQueue(rows);
  const totals = rows.reduce(
    (acc, row) => ({ runs: acc.runs + row.runs, failed: acc.failed + row.failed }),
    { runs: 0, failed: 0 },
  );

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Jobs"
        description="View and analyze jobs processed by your applications."
        actions={
          <Stack direction="row" spacing={1}>
            <Stat label="Runs" value={formatCount(totals.runs)} />
            <Stat
              label="Failed"
              value={formatCount(totals.failed)}
              tone={totals.failed > 0 ? "danger" : "default"}
            />
            <Stat
              label="Queues"
              value={String(groups.length)}
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
          hint="Nothing to configure: a queue consumer or an @Cron() method that runs inside the selected window shows up here."
        />
      ) : (
        <>
          <Stack direction={{ xs: "column", lg: "row" }} spacing={2}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Panel
                title="Jobs"
                meta={<Legend keys={[["runs", colors.muted], ["failed", colors.danger]]} />}
                caption="Runs and failures per queue. Per-bucket job series would need a request/job split the rollup does not carry."
              >
                <Box sx={{ height: 180 }}>
                  <ResponsiveBar
                    data={jobBars(groups)}
                    keys={["runs", "failed"]}
                    indexBy="queue"
                    margin={{ top: 10, right: 8, bottom: 34, left: 34 }}
                    padding={0.35}
                    colors={[colors.muted, colors.danger]}
                    enableLabel={false}
                    axisBottom={{
                      tickSize: 0,
                      tickPadding: 6,
                      tickRotation: -28,
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
                caption="Average run time and the worst job's p95, per queue. p95 is a maximum over the queue's jobs, not a blend."
              >
                <Box sx={{ height: 180 }}>
                  <ResponsiveLine
                    data={durationLines(groups)}
                    margin={{ top: 10, right: 12, bottom: 34, left: 40 }}
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
                      tickRotation: -28,
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
                  <GroupRows key={group.queue} group={group} />
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
function GroupRows({ group }: { group: QueueGroup }) {
  return (
    <>
      <TableRow sx={{ "& td": { backgroundColor: colors.surfaceRaised } }}>
        <TableCell colSpan={9} sx={{ py: 0.75 }}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
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
      {group.rows.map((row) => (
        <TableRow key={`${group.queue}:${row.jobName ?? "unnamed"}`}>
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
                  ? `95% of this job's runs started within ${formatDuration(row.p95WaitMs)} of being enqueued. Average wait was ${formatDuration(row.avgWaitMs)}.`
                  : "No queue wait recorded: the run was picked up immediately, or the agent does not report enqueuedAt."
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
          <TableCell align="right" sx={{ color: "text.secondary", whiteSpace: "nowrap" }}>
            {row.lastRunAt > 0 ? formatRelative(row.lastRunAt) : "—"}
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Data shaping
// ---------------------------------------------------------------------------

interface QueueGroup {
  queue: string;
  rows: JobRow[];
  runs: number;
  failed: number;
  avgMs: number;
  p95Ms: number;
}

function groupByQueue(rows: JobRow[]): QueueGroup[] {
  const map = new Map<string, QueueGroup>();
  for (const row of rows) {
    const queue = row.queue ?? "(no queue)";
    const existing = map.get(queue) ?? {
      queue,
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
    map.set(queue, existing);
  }
  return [...map.values()]
    .map((group) => ({ ...group, avgMs: group.runs > 0 ? group.avgMs / group.runs : 0 }))
    .sort((a, b) => b.runs - a.runs);
}

function jobBars(groups: QueueGroup[]): Array<{ queue: string; runs: number; failed: number }> {
  return groups.slice(0, 14).map((group) => ({
    queue: group.queue,
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
      data: sliced.map((group) => ({ x: group.queue, y: Math.round(group.avgMs * 100) / 100 })),
    },
    {
      id: "p95",
      color: colors.accent,
      data: sliced.map((group) => ({ x: group.queue, y: Math.round(group.p95Ms * 100) / 100 })),
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
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "danger";
}) {
  return (
    <Box
      sx={{
        border: `1px solid ${colors.border}`,
        borderRadius: 1,
        px: 1.5,
        py: 0.75,
        minWidth: 74,
      }}
    >
      <Typography sx={labelCaps}>{label}</Typography>
      <Typography
        sx={{ ...tabular, fontSize: 16, fontWeight: 600, color: tone === "danger" ? colors.danger : "text.primary" }}
      >
        {value}
      </Typography>
    </Box>
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
