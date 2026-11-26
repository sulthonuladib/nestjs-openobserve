/**
 * Operation — one route or job template, over time.
 *
 * The page the request list drills into: summary numbers, the series behind them,
 * the slowest instances that make up the tail, and the error groups the operation
 * opened. It is deliberately the same shape as the application page, scoped down
 * — an operator learns one layout and reads ten thousand operations with it.
 *
 * Honest note on `series`: the endpoint currently returns the application's
 * request series for the window rather than one filtered to this operation (see
 * `analytics.service.ts#operationDetail`, which calls the app-wide
 * `timeseries`). The card says so instead of pretending the line is this route's.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
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
import { ResponsiveLine } from "@nivo/line";
import { Link as RouterLink } from "react-router-dom";
import type { ReactNode } from "react";
import { api } from "../api";
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

export interface OperationProps {
  appId?: string;
  id?: string;
  operationRowId?: string;
  range?: TimeRangeId;
}

export function Operation({ appId, id, operationRowId, range = "1h" }: OperationProps) {
  // `appId` is the shell's scope and is empty under "All applications"; the
  // route param is still a concrete application, so fall back to it.
  const applicationId = appId || id;
  if (!applicationId || !operationRowId) {
    return (
      <Stack spacing={3}>
        <PageHeader
          title="Operation"
          description="One operation: its traffic, its slowest instances and its error groups."
        />
        <EmptyState
          title="No operation selected."
          hint="Open this page from a row in the Requests table — it needs an application and an operation id."
        />
      </Stack>
    );
  }
  return (
    <OperationForApplication
      appId={applicationId}
      operationRowId={operationRowId}
      range={range}
    />
  );
}

function OperationForApplication({
  appId,
  operationRowId,
  range,
}: {
  appId: string;
  operationRowId: string;
  range: TimeRangeId;
}) {
  const refetchInterval = useLiveInterval();
  const detail = useQuery({
    queryKey: ["operation-detail", appId, operationRowId, range],
    queryFn: () => api.operationDetail(appId, operationRowId, windowFor(range)),
    refetchInterval,
  });

  const operation = detail.data?.operation;
  const kind = detail.data?.kind ?? "request";
  const points = detail.data?.series.points ?? [];
  const slowest = detail.data?.slowest ?? [];
  const errors = detail.data?.errors ?? [];

  // A cron handler's page must not call its runs "requests": the server already
  // answers with the operation's own kind, so the copy follows it.
  const countNoun = kind === "job" ? "Runs" : "Requests";
  const countKey = kind === "job" ? "runs" : "requests";

  const totals = points.reduce(
    (acc, point) => ({
      requests: acc.requests + point.requests,
      errors: acc.errors + point.errors,
      weightedMs: acc.weightedMs + (point.avgMs ?? 0) * point.requests,
      p95: Math.max(acc.p95, point.p95Ms ?? 0),
    }),
    { requests: 0, errors: 0, weightedMs: 0, p95: 0 },
  );

  const label =
    operation?.customName ?? operation?.operationId ?? "Operation";

  const lines: Line[] = [
    {
      id: countKey,
      color: colors.accent,
      data: points.map((point) => ({ x: timeLabel(point.t, range), y: point.requests })),
    },
    {
      id: "errors",
      color: colors.danger,
      data: points.map((point) => ({ x: timeLabel(point.t, range), y: point.errors })),
    },
  ];

  return (
    <Stack spacing={3}>
      <PageHeader
        title={label}
        description={
          operation
            ? "The traffic this operation saw in the selected window, and the calls that hurt."
            : "One operation: its traffic, its slowest instances and its error groups."
        }
        actions={
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            {operation?.method && (
              <Chip
                label={operation.method}
                size="small"
                sx={{ color: colors.accentText, borderColor: `${colors.accent}55` }}
                variant="outlined"
              />
            )}
            {operation?.protocol && (
              <Chip label={operation.protocol} size="small" variant="outlined" />
            )}
          </Stack>
        }
      />

      {detail.isError && (
        <Alert severity="error">
          This operation could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {errorMessage(detail.error)}
          </Box>
        </Alert>
      )}

      {detail.isLoading && (
        <Stack spacing={2}>
          <Skeleton variant="rounded" height={72} />
          <Skeleton variant="rounded" height={220} />
        </Stack>
      )}

      {detail.data && (
        <>
          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
            <Stat label="Operation id" value={operation?.operationId ?? "—"} mono />
            <Stat label={countNoun} value={formatCount(totals.requests)} />
            <Stat
              label="Errors"
              value={formatCount(totals.errors)}
              tone={totals.errors > 0 ? "danger" : "default"}
            />
            <Stat
              label="Error rate"
              value={formatPercent(totals.requests > 0 ? totals.errors / totals.requests : 0, 2)}
            />
            <Stat
              label="Avg"
              value={formatDuration(totals.requests > 0 ? totals.weightedMs / totals.requests : null)}
            />
            <Stat label="p95 (worst bucket)" value={formatDuration(totals.p95)} />
            <Stat label="Last seen" value={operation ? formatRelative(operation.lastSeen) : "—"} />
          </Stack>

          <Panel
            title={countNoun}
            meta={<Legend keys={[[countKey, colors.accent], ["errors", colors.danger]]} />}
            caption={
              kind === "job"
                ? "Runs and failures of this handler, from its own per-minute rollup. Queue wait and retries are on the Jobs page."
                : "Requests and failures of this endpoint, merged from its own per-minute histograms so the percentiles below are the operation's, not the application's."
            }
          >
            {points.length === 0 ? (
              <EmptyState
                title="No traffic in this window."
                hint="Widen the range in the top bar, or check that the application is still reporting."
              />
            ) : (
              <Box sx={{ height: 220 }}>
                <ResponsiveLine
                  data={lines}
                  margin={{ top: 12, right: 18, bottom: 30, left: 44 }}
                  xScale={{ type: "point" }}
                  yScale={{ type: "linear", min: 0, max: "auto" }}
                  curve="monotoneX"
                  colors={(line) => line.color}
                  lineWidth={1.8}
                  enablePoints={false}
                  enableGridX={false}
                  axisBottom={{ tickSize: 0, tickPadding: 6, tickValues: 6 }}
                  axisLeft={{ tickSize: 0, tickPadding: 6, tickValues: 5 }}
                  theme={chartTheme}
                  animate={false}
                  enableSlices="x"
                />
              </Box>
            )}
          </Panel>

          <Panel
            title="Slowest instances"
            meta={
              <Typography sx={{ fontSize: 11, color: "text.disabled", ...tabular }}>
                {formatCount(slowest.length)} shown
              </Typography>
            }
            caption="The tail, not the average: these are the calls a p95 is made of. Open one for its waterfall and the stack that was running."
          >
            {slowest.length === 0 ? (
              <EmptyState title="No calls in this window." />
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Duration</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Called at</TableCell>
                    <TableCell>Trace</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {slowest.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell sx={{ ...tabular, fontWeight: 500 }}>
                        {formatDuration(row.durationMs)}
                      </TableCell>
                      <TableCell>
                        <StatusChip code={row.statusCode} errorGroupId={row.errorGroupId} />
                      </TableCell>
                      <TableCell sx={{ color: "text.secondary", whiteSpace: "nowrap" }}>
                        <Tooltip title={new Date(row.startedAt).toLocaleString()}>
                          <Box component="span">{formatRelative(row.startedAt)}</Box>
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        <RouterLink
                          to={`/executions/${row.id}?range=${range}`}
                          style={{ color: colors.accentText, textDecoration: "none", fontSize: 11.5 }}
                          title={row.traceId}
                        >
                          {shortId(row.traceId)}
                        </RouterLink>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>

          <Panel
            title="Error groups"
            meta={
              <Typography sx={{ fontSize: 11, color: "text.disabled", ...tabular }}>
                {formatCount(errors.length)} groups
              </Typography>
            }
            caption="Groups the collector fingerprinted from these calls: class, normalised stack shape. A spike of a thousand is one row here, and one bug."
          >
            {errors.length === 0 ? (
              <EmptyState
                title="No error groups for this operation in this window."
                hint="Handled 4xx exceptions still count as errors on the request itself; a group appears when the failure was unhandled."
              />
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Message</TableCell>
                    <TableCell>Class</TableCell>
                    <TableCell align="right">Occurrences</TableCell>
                    <TableCell align="right">Last seen</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {errors.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell sx={{ maxWidth: 420 }}>
                        <Typography sx={{ fontSize: 12.5 }} noWrap title={row.message}>
                          {row.message}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ color: "text.secondary", fontSize: 11.5 }}>
                        {row.class ?? "Error"}
                      </TableCell>
                      <TableCell align="right" sx={tabular}>
                        {formatCount(row.occurrences)}
                      </TableCell>
                      <TableCell align="right" sx={{ color: "text.secondary", whiteSpace: "nowrap" }}>
                        {formatRelative(row.lastSeen)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>
        </>
      )}
    </Stack>
  );
}

function StatusChip({ code, errorGroupId }: { code: number | null; errorGroupId: string | null }) {
  if (errorGroupId) {
    return (
      <Chip label="error" size="small" variant="outlined" sx={{ color: colors.danger, borderColor: `${colors.danger}55` }} />
    );
  }
  if (code === null) {
    return <Typography sx={{ fontSize: 11, color: "text.disabled" }}>—</Typography>;
  }
  const color = code >= 500 ? colors.danger : code >= 400 ? colors.warn : colors.ok;
  return (
    <Chip label={String(code)} size="small" variant="outlined" sx={{ color, borderColor: `${color}55` }} />
  );
}

interface Line {
  id: string;
  color: string;
  data: Array<{ x: string; y: number | null }>;
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
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
    <Paper sx={{ overflow: "hidden" }}>
      <Stack
        direction="row"
        sx={{
          px: 2,
          py: 1.25,
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{title}</Typography>
        {meta}
      </Stack>
      <Box sx={{ p: title === "Requests" ? 1.5 : 0 }}>{children}</Box>
      {caption && (
        <Typography sx={{ px: 2, pb: 1.5, pt: title === "Requests" ? 0 : 1.5, fontSize: 11, color: "text.disabled" }}>
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
  mono,
}: {
  label: string;
  value: string;
  tone?: "default" | "danger";
  mono?: boolean;
}) {
  return (
    <Box
      sx={{
        border: `1px solid ${colors.border}`,
        borderRadius: 1,
        px: 1.5,
        py: 0.75,
        minWidth: 88,
        maxWidth: mono ? 340 : undefined,
      }}
    >
      <Typography sx={labelCaps}>{label}</Typography>
      <Typography
        noWrap
        title={value}
        sx={{
          ...tabular,
          fontFamily: mono ? "inherit" : undefined,
          fontSize: mono ? 12.5 : 16,
          fontWeight: 600,
          color: tone === "danger" ? colors.danger : "text.primary",
        }}
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
        py: 5,
        m: 1.5,
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
