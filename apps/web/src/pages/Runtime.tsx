/**
 * Runtime — the four numbers that say whether the Node process is coping.
 *
 * CPU, heap, event-loop delay and GC. All four come from one heartbeat
 * (`/applications/:id/runtime`), one row per flush, which is why they are drawn
 * as four small charts rather than one big one: they share a clock, not a unit.
 *
 * **This is not a profiler.** The reference's sidebar calls the page PROFILER and
 * its flamegraph came from a sampling profiler; the SDK's profiler is shelved
 * upstream (see `docs/spec/dashboard-features.md` §9.2 and the endpoint's own
 * description), so there is no per-function sample to draw. A heartbeat answers
 * "is this process short of CPU, memory or loop time", not "which function ran".
 *
 * Hovering any chart sets one shared x value: the other three draw a marker at
 * the same instant and the tooltip shows all four readings at once. Nivo 0.99
 * dropped `syncId`, so the sync is a controlled `markers` + shared state — same
 * result, no crosshair that lies about which chart you are on.
 */
import { useQuery } from "@tanstack/react-query";
import { Alert, Box, Paper, Skeleton, Stack, Typography } from "@mui/material";
import { ResponsiveLine, isSliceData } from "@nivo/line";
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { api } from "../api";
import { formatClock, formatDuration, formatRelative, windowFor, type TimeRangeId } from "../format";
import { colors, labelCaps, tabular } from "../theme";
import { PageHeader } from "../components/shell/PageHeader";
import { useLiveInterval } from "../components/shell";

export interface RuntimeProps {
  appId?: string;
  id?: string;
  range?: TimeRangeId;
}

export function Runtime({ appId, id, range = "1h" }: RuntimeProps) {
  // `appId` is the shell's scope and is empty under "All applications"; the
  // route param is still a concrete application, so fall back to it.
  const applicationId = appId || id;
  if (!applicationId) {
    return (
      <Stack spacing={3}>
        <PageHeader
          title="Runtime"
          description="Monitor your application's performance and resource usage."
        />
        <EmptyState
          title="Pick an application first."
          hint="Runtime samples belong to one application, so the charts need a scope. Use the application switcher in the top bar."
        />
      </Stack>
    );
  }
  return <RuntimeForApplication appId={applicationId} range={range} />;
}

function RuntimeForApplication({ appId, range }: { appId: string; range: TimeRangeId }) {
  const refetchInterval = useLiveInterval();
  const samples = useQuery({
    queryKey: ["runtime", appId, range],
    queryFn: () => api.runtime(appId, windowFor(range)),
    refetchInterval,
  });

  // The shared hover: one x label, read by all four charts.
  const [hover, setHover] = useState<string | null>(null);

  const rows = samples.data ?? [];
  const labels = rows.map((row) => timeLabel(row.at, range));
  const byLabel = new Map(labels.map((label, index) => [label, rows[index]]));
  const hovered = hover ? byLabel.get(hover) : undefined;
  const last = rows.at(-1);

  const cpu: Line[] = [
    {
      id: "CPU",
      color: colors.accent,
      data: rows.map((row) => ({ x: timeLabel(row.at, range), y: row.cpuPercent })),
    },
  ];
  const heap: Line[] = [
    {
      id: "Heap used",
      color: colors.accent,
      data: rows.map((row) => ({ x: timeLabel(row.at, range), y: toMb(row.heapUsed) })),
    },
    {
      id: "Heap total",
      color: colors.muted,
      data: rows.map((row) => ({ x: timeLabel(row.at, range), y: toMb(row.heapTotal) })),
    },
  ];
  const loop: Line[] = [
    {
      id: "Event loop delay",
      color: colors.warn,
      data: rows.map((row) => ({ x: timeLabel(row.at, range), y: row.eventLoopMs })),
    },
  ];
  const gc: Line[] = [
    {
      id: "GC ms",
      color: colors.accent,
      data: rows.map((row) => ({ x: timeLabel(row.at, range), y: row.gcMs })),
    },
    {
      id: "GC count",
      color: colors.muted,
      data: rows.map((row) => ({ x: timeLabel(row.at, range), y: row.gcCount })),
    },
  ];

  const tooltip = (
    <SyncedTooltip
      at={hovered?.at ?? null}
      cpuPercent={hovered?.cpuPercent ?? null}
      heapUsed={hovered?.heapUsed ?? null}
      heapTotal={hovered?.heapTotal ?? null}
      eventLoopMs={hovered?.eventLoopMs ?? null}
      gcCount={hovered?.gcCount ?? null}
      gcMs={hovered?.gcMs ?? null}
    />
  );

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Runtime"
        description="Monitor your application's performance and resource usage."
        actions={
          <Stack direction="row" spacing={1}>
            <Stat label="Samples" value={String(rows.length)} />
            <Stat
              label="CPU"
              value={last?.cpuPercent === null || last?.cpuPercent === undefined ? "—" : `${last.cpuPercent.toFixed(0)}%`}
            />
            <Stat
              label="Heap"
              value={last?.heapUsed === null || last?.heapUsed === undefined ? "—" : `${toMb(last.heapUsed)?.toFixed(0) ?? "—"} MB`}
            />
            <Stat
              label="Last sample"
              value={last ? formatRelative(last.at) : "—"}
            />
          </Stack>
        }
      />

      <Alert severity="info" sx={{ alignItems: "flex-start" }}>
        This is the runtime <strong>heartbeat</strong>, not a CPU flamegraph. The SDK's sampling
        profiler is shelved upstream, so what an application reports is CPU, memory, event-loop and
        GC — enough to see a process run out of headroom, not enough to name the function that used
        it.
      </Alert>

      {samples.isError && (
        <Alert severity="error">
          Runtime samples could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {errorMessage(samples.error)}
          </Box>
        </Alert>
      )}

      {samples.isLoading && (
        <Box
          sx={{
            display: "grid",
            gap: 2,
            gridTemplateColumns: { xs: "1fr", lg: "repeat(2, 1fr)", xl: "repeat(4, 1fr)" },
          }}
        >
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} variant="rounded" height={196} />
          ))}
        </Box>
      )}

      {!samples.isLoading && rows.length === 0 && !samples.isError && (
        <EmptyState
          title="No runtime samples yet — the SDK sends a heartbeat while the app runs."
          hint="Start the application with the Observe module registered and the first sample lands within a flush interval."
        />
      )}

      {rows.length > 0 && (
        <Box
          sx={{
            display: "grid",
            gap: 2,
            gridTemplateColumns: { xs: "1fr", lg: "repeat(2, 1fr)", xl: "repeat(4, 1fr)" },
          }}
        >
          <ChartCard
            title="CPU utilization"
            meta={<Legend keys={[["CPU %", colors.accent]]} />}
            lines={cpu}
            yMax={100}
            format={(value) => `${value.toFixed(0)}%`}
            hover={hover}
            onHover={setHover}
            tooltip={tooltip}
          />
          <ChartCard
            title="Memory"
            meta={
              <Legend
                keys={[
                  ["Heap used", colors.accent],
                  ["Heap total", colors.muted],
                ]}
              />
            }
            lines={heap}
            format={(value) => `${value.toFixed(0)} MB`}
            hover={hover}
            onHover={setHover}
            tooltip={tooltip}
          />
          <ChartCard
            title="Event loop delay"
            meta={<Legend keys={[["Delay", colors.warn]]} />}
            lines={loop}
            format={(value) => `${value.toFixed(1)} ms`}
            hover={hover}
            onHover={setHover}
            tooltip={tooltip}
          />
          <ChartCard
            title="GC count / duration"
            meta={
              <Legend
                keys={[
                  ["ms", colors.accent],
                  ["count", colors.muted],
                ]}
              />
            }
            lines={gc}
            format={(value) => value.toFixed(0)}
            hover={hover}
            onHover={setHover}
            tooltip={tooltip}
          />
        </Box>
      )}
    </Stack>
  );
}

interface Line {
  id: string;
  color: string;
  data: Array<{ x: string; y: number | null }>;
}

/**
 * One chart in the grid.
 *
 * The four charts share `hover` rather than a Nivo `syncId` (gone in 0.99): the
 * hovered chart emits its x label, every chart draws a marker at that label, and
 * every chart's tooltip renders the same all-four panel.
 */
function ChartCard({
  title,
  meta,
  lines,
  format,
  yMax,
  hover,
  onHover,
  tooltip,
}: {
  title: string;
  meta?: ReactNode;
  lines: Line[];
  format: (value: number) => string;
  yMax?: number;
  hover: string | null;
  onHover: (label: string | null) => void;
  tooltip: ReactNode;
}) {
  const marker = hover
    ? [
        {
          axis: "x" as const,
          value: hover,
          lineStyle: {
            stroke: colors.borderStrong,
            strokeWidth: 1,
            strokeDasharray: "3 3",
          } as CSSProperties,
        },
      ]
    : undefined;

  return (
    <Paper sx={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <Stack
        direction="row"
        sx={{
          px: 1.75,
          py: 1.1,
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{title}</Typography>
        {meta}
      </Stack>
      <Box sx={{ height: 180, px: 0.5, pt: 1 }}>
        <ResponsiveLine
          data={lines}
          margin={{ top: 8, right: 14, bottom: 26, left: 46 }}
          xScale={{ type: "point" }}
          yScale={{ type: "linear", min: 0, max: yMax ?? "auto" }}
          curve="monotoneX"
          colors={(line) => line.color}
          lineWidth={1.6}
          enablePoints={false}
          enableGridX={false}
          axisBottom={{ tickSize: 0, tickPadding: 6, tickValues: 4 }}
          axisLeft={{
            tickSize: 0,
            tickPadding: 4,
            tickValues: 4,
            format: (value) => format(Number(value)),
          }}
          markers={marker}
          enableSlices="x"
          sliceTooltip={() => tooltip}
          onMouseMove={(datum) => {
            if (isSliceData(datum)) onHover(String(datum.id));
          }}
          onMouseLeave={() => onHover(null)}
          theme={chartTheme}
          animate={false}
          enableCrosshair
          crosshairType="x"
        />
      </Box>
    </Paper>
  );
}

/** The one tooltip: the same four numbers, whichever chart the cursor is over. */
function SyncedTooltip({
  at,
  cpuPercent,
  heapUsed,
  heapTotal,
  eventLoopMs,
  gcCount,
  gcMs,
}: {
  at: number | null;
  cpuPercent: number | null;
  heapUsed: number | null;
  heapTotal: number | null;
  eventLoopMs: number | null;
  gcCount: number | null;
  gcMs: number | null;
}) {
  if (at === null) return null;
  return (
    <Paper sx={{ px: 1.25, py: 1, minWidth: 196, backgroundColor: colors.surfaceRaised }}>
      <Typography sx={{ ...labelCaps, color: "text.secondary" }}>
        {formatClock(at)}
      </Typography>
      <Stack spacing={0.25} sx={{ mt: 0.5 }}>
        <TooltipRow label="CPU" value={cpuPercent === null ? "—" : `${cpuPercent.toFixed(1)}%`} />
        <TooltipRow
          label="Heap"
          value={
            heapUsed === null
              ? "—"
              : `${toMb(heapUsed)?.toFixed(0) ?? "—"} / ${heapTotal === null ? "—" : `${toMb(heapTotal)?.toFixed(0) ?? "—"} MB`}`
          }
        />
        <TooltipRow
          label="Loop delay"
          value={eventLoopMs === null ? "—" : formatDuration(eventLoopMs)}
        />
        <TooltipRow
          label="GC"
          value={`${gcCount === null ? "—" : gcCount.toFixed(0)} runs · ${gcMs === null ? "—" : formatDuration(gcMs)}`}
        />
      </Stack>
    </Paper>
  );
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between" }}>
      <Typography sx={{ fontSize: 10.5, color: "text.disabled" }}>{label}</Typography>
      <Typography sx={{ fontSize: 10.5, color: "text.primary", ...tabular }}>{value}</Typography>
    </Stack>
  );
}

/** Bytes → MB, or null. Absent memory is a gap in the chart, not a zero. */
function toMb(bytes: number | null): number | null {
  if (bytes === null || !Number.isFinite(bytes)) return null;
  return bytes / (1024 * 1024);
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

function Legend({ keys }: { keys: Array<[string, string]> }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      {keys.map(([label, color]) => (
        <Stack key={label} direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
          <Box sx={{ width: 5, height: 5, borderRadius: "50%", backgroundColor: color }} />
          <Typography sx={{ ...labelCaps, fontSize: 9.5 }}>{label}</Typography>
        </Stack>
      ))}
    </Stack>
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
  tooltip: { container: { background: "transparent", boxShadow: "none", padding: 0 } },
} as const;
