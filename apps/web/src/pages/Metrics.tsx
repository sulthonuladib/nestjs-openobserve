/**
 * Custom metrics — the counters, gauges and summaries an application reports
 * itself, because no auto-instrumentation could know about them.
 *
 * Two readings, one page:
 *
 *   * the **grid** is the inventory: name, type, the label set that makes this
 *     series distinct, how many points landed and when it was last read;
 *   * picking one draws it. A counter/gauge is a single line — a reading over
 *     time. A summary is three, because the agent computed quantiles in-process
 *     and sent q50/q95/q99 as finished numbers; drawing one line for a summary
 *     would throw away the only reason to report one.
 *
 * Label sets are kept apart on purpose: `jobs.processed{queue=email}` and
 * `jobs.processed{queue=payments}` are two series, not one averaged mess.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Chip,
  Paper,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import { ResponsiveLine } from "@nivo/line";
import { useState } from "react";
import type { ReactNode } from "react";
import { api, type MetricRow } from "../api";
import { formatCount, formatRelative, windowFor, type TimeRangeId } from "../format";
import { chartColors, colors, labelCaps, tabular } from "../theme";
import { PageHeader } from "../components/shell/PageHeader";
import { useLiveInterval } from "../components/shell";

export interface MetricsProps {
  appId?: string;
  id?: string;
  range?: TimeRangeId;
}

export function Metrics({ appId, id, range = "1h" }: MetricsProps) {
  // `appId` is the shell's scope and is empty under "All applications"; the
  // route param is still a concrete application, so fall back to it.
  const applicationId = appId || id;
  if (!applicationId) {
    return (
      <Stack spacing={3}>
        <PageHeader
          title="Custom metrics"
          description="Gauges, counters, and other custom telemetry data."
        />
        <EmptyState
          title="Pick an application first."
          hint="Custom metrics belong to one application, so the list needs a scope. Use the application switcher in the top bar."
        />
      </Stack>
    );
  }
  return <MetricsForApplication appId={applicationId} range={range} />;
}

function MetricsForApplication({ appId, range }: { appId: string; range: TimeRangeId }) {
  const refetchInterval = useLiveInterval();
  const series = useQuery({
    queryKey: ["metrics", appId],
    queryFn: () => api.metrics(appId),
    refetchInterval,
  });

  const rows = series.data ?? [];
  // Clicking a card selects its **name**: the chart then draws every label set
  // reported under that name, which is what the endpoint returns for one name.
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selected = rows.find((row) => row.name === selectedName) ?? rows[0];
  const name = selected?.name;

  const points = useQuery({
    queryKey: ["metric-points", appId, name, range],
    // No selection means no series — an empty result rather than a request for
    // a name that does not exist.
    queryFn: () => (name ? api.metricPoints(appId, name, windowFor(range)) : []),
    enabled: Boolean(name),
    refetchInterval,
  });

  const lines = buildLines(points.data ?? [], range);

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Custom metrics"
        description="Gauges, counters, and other custom telemetry data."
        actions={
          <Stack direction="row" spacing={1}>
            <Stat label="Series" value={String(rows.length)} />
            <Stat
              label="Points"
              value={formatCount(rows.reduce((sum, row) => sum + row.points, 0))}
            />
          </Stack>
        }
      />

      {series.isError && (
        <Alert severity="error">
          The metric list could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {errorMessage(series.error)}
          </Box>
        </Alert>
      )}

      {series.isLoading && (
        <Box
          sx={{
            display: "grid",
            gap: 2,
            gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", lg: "repeat(4, 1fr)" },
          }}
        >
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} variant="rounded" height={118} />
          ))}
        </Box>
      )}

      {!series.isLoading && rows.length === 0 && !series.isError && (
        <EmptyState
          title="No custom metrics found."
          hint="Anything the SDK reports with Counter, Gauge or Summary shows up here, grouped by name and label set — orders processed, cache hit ratio, queue depth, that kind of thing."
        />
      )}

      {rows.length > 0 && (
        <>
          <Box
            sx={{
              display: "grid",
              gap: 2,
              gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", lg: "repeat(4, 1fr)" },
            }}
          >
            {rows.map((row) => (
              <MetricCard
                key={row.id}
                row={row}
                selected={row.name === name}
                onSelect={() => setSelectedName(row.name)}
              />
            ))}
          </Box>

          <Panel
            title={name ? `Value over time · ${name}` : "Value over time"}
            meta={
              selected ? (
                <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
                  <Legend keys={lines.slice(0, 4).map((line) => [line.id, line.color] as [string, string])} />
                  <TypeChip type={selected.type} />
                  <Typography sx={{ fontSize: 11, color: "text.disabled", ...tabular }}>
                    {formatCount(selected.points)} points
                  </Typography>
                </Stack>
              ) : null
            }
            caption={
              selected?.type === "summary"
                ? "q50 / q95 / q99 as the agent computed them per flush window. Quantiles from different instances are averaged, so a merged q95 estimates rather than derives the true percentile — count, sum and max merge exactly."
                : "Each dot is one reading; a bucket with no reading is a gap, not a zero. Counters are cumulative, gauges are point-in-time."
            }
          >
            {points.isError && (
              <Alert severity="error">
                The series could not be drawn.{" "}
                <Box component="span" sx={{ color: "text.secondary" }}>
                  {errorMessage(points.error)}
                </Box>
              </Alert>
            )}
            {points.isLoading && <Skeleton variant="rounded" height={220} />}
            {!points.isLoading && !points.isError && (points.data?.length ?? 0) === 0 && (
              <EmptyState
                title="No points in this window."
                hint="The series exists but reported nothing in the selected range. Widen the range in the top bar."
              />
            )}
            {!points.isLoading && (points.data?.length ?? 0) > 0 && (
              <Box sx={{ height: 230 }}>
                <ResponsiveLine
                  data={lines}
                  margin={{ top: 12, right: 18, bottom: 34, left: 52 }}
                  xScale={{ type: "point" }}
                  yScale={{ type: "linear", min: "auto", max: "auto" }}
                  curve="monotoneX"
                  colors={(line) => line.color}
                  lineWidth={2}
                  enablePoints={false}
                  enableGridX={false}
                  axisBottom={{ tickSize: 0, tickPadding: 6, tickValues: 6 }}
                  axisLeft={{
                    tickSize: 0,
                    tickPadding: 6,
                    tickValues: 5,
                    format: (value) => formatValue(Number(value)),
                  }}
                  theme={chartTheme}
                  animate={false}
                  enableSlices="x"
                />
              </Box>
            )}
          </Panel>
        </>
      )}
    </Stack>
  );
}

/** One card in the inventory grid: what the series is, and whether it is alive. */
function MetricCard({
  row,
  selected,
  onSelect,
}: {
  row: MetricRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const labels = Object.entries(row.labels ?? {});
  return (
    <Paper
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      sx={{
        p: 2,
        display: "flex",
        flexDirection: "column",
        gap: 1,
        cursor: "pointer",
        borderColor: selected ? `${colors.accent}66` : colors.border,
        backgroundColor: selected ? colors.surfaceRaised : colors.surface,
        "&:hover": { borderColor: selected ? `${colors.accent}88` : colors.borderStrong },
        "&:focus-visible": { outline: `1px solid ${colors.accent}`, outlineOffset: 1 },
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "flex-start", justifyContent: "space-between" }}
      >
        <Typography
          sx={{ fontSize: 13, fontWeight: 600, wordBreak: "break-word", lineHeight: 1.35 }}
          title={row.description ?? undefined}
        >
          {row.name}
        </Typography>
        <TypeChip type={row.type} />
      </Stack>

      {labels.length > 0 ? (
        <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap", gap: 0.5 }}>
          {labels.slice(0, 4).map(([key, value]) => (
            <Chip key={key} label={`${key}=${value}`} size="small" variant="outlined" />
          ))}
          {labels.length > 4 && (
            <Typography sx={{ fontSize: 10, color: "text.disabled", alignSelf: "center" }}>
              +{labels.length - 4}
            </Typography>
          )}
        </Stack>
      ) : (
        <Typography sx={{ fontSize: 10.5, color: "text.disabled" }}>no labels</Typography>
      )}

      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "baseline", justifyContent: "space-between", mt: "auto" }}
      >
        <Typography sx={{ fontSize: 11, color: "text.secondary", ...tabular }}>
          {formatCount(row.points)} points{row.kind ? ` · ${row.kind}` : ""}
        </Typography>
        <Typography sx={{ fontSize: 10.5, color: "text.disabled", ...tabular }}>
          {row.lastAt > 0 ? formatRelative(row.lastAt) : "never read"}
        </Typography>
      </Stack>
    </Paper>
  );
}

function Legend({ keys }: { keys: Array<[string, string]> }) {
  if (keys.length === 0) return null;
  return (
    <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", flexWrap: "wrap" }}>
      {keys.map(([label, color]) => (
        <Stack key={label} direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
          <Box sx={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: color }} />
          <Typography sx={{ ...labelCaps, color: "text.secondary", maxWidth: 130 }} noWrap>
            {label}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

function TypeChip({ type }: { type: MetricRow["type"] }) {
  const color =
    type === "counter" ? colors.accentText : type === "gauge" ? colors.ok : colors.warn;
  return (
    <Chip
      label={type}
      size="small"
      variant="outlined"
      sx={{ color, borderColor: `${color}55`, flexShrink: 0 }}
    />
  );
}

// ---------------------------------------------------------------------------
// Data shaping
// ---------------------------------------------------------------------------

interface Line {
  id: string;
  color: string;
  data: Array<{ x: string; y: number | null }>;
}

type MetricPointRow = Awaited<ReturnType<typeof api.metricPoints>>[number];

/**
 * One line per label set — and three per summary label set.
 *
 * A summary carries `q50/q95/q99` per point instead of `value`; drawing its
 * `value` (which the agent never sends) would be a flat line at nothing.
 */
function buildLines(points: MetricPointRow[], range: TimeRangeId): Line[] {
  const groups = new Map<string, MetricPointRow[]>();
  for (const point of points) {
    const key = point.seriesId;
    const list = groups.get(key) ?? [];
    list.push(point);
    groups.set(key, list);
  }

  const lines: Line[] = [];
  let index = 0;
  for (const [, list] of groups) {
    const first = list[0];
    if (!first) continue;
    const key = labelKey(first.labels);
    const type = first.type ?? "counter";

    if (type === "summary") {
      for (const [quantile, pick] of [
        ["q50", (point: MetricPointRow) => point.q50],
        ["q95", (point: MetricPointRow) => point.q95],
        ["q99", (point: MetricPointRow) => point.q99],
      ] as const) {
        lines.push({
          id: `${key} ${quantile}`,
          color: quantile === "q50" ? colors.muted : quantile === "q95" ? colors.accent : colors.warn,
          data: list.map((point) => ({ x: timeLabel(point.at, range), y: pick(point) })),
        });
        index += 1;
      }
    } else {
      lines.push({
        id: key,
        color: chartColors.series[index % chartColors.series.length] ?? colors.accent,
        data: list.map((point) => ({ x: timeLabel(point.at, range), y: point.value })),
      });
      index += 1;
    }
  }

  // Nine lines is already a hairball; past that the chart stops being a chart.
  return lines.slice(0, 9);
}

function labelKey(labels: Record<string, string> | undefined): string {
  const entries = Object.entries(labels ?? {});
  if (entries.length === 0) return "default";
  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
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

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1000) return formatCount(value);
  return value.toFixed(Math.abs(value) < 1 ? 3 : 1);
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
          borderBottom: `1px solid ${colors.border}`,
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{title}</Typography>
        {meta}
      </Stack>
      <Box sx={{ p: 1.5 }}>{children}</Box>
      {caption && (
        <Typography sx={{ px: 2, pb: 1.5, fontSize: 11, color: "text.disabled" }}>
          {caption}
        </Typography>
      )}
    </Paper>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Box
      sx={{ border: `1px solid ${colors.border}`, borderRadius: 1, px: 1.5, py: 0.75, minWidth: 74 }}
    >
      <Typography sx={labelCaps}>{label}</Typography>
      <Typography sx={{ ...tabular, fontSize: 16, fontWeight: 600 }}>{value}</Typography>
    </Box>
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
