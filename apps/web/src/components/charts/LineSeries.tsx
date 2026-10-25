import { Box, Stack, Typography } from "@mui/material";
import { ResponsiveLine } from "@nivo/line";
import type { LineSeries as NivoLineSeries, SliceTooltipProps } from "@nivo/line";
import type { ComponentProps } from "react";
import { formatAxisStamp, formatDuration } from "../../format";
import { colors } from "../../theme";

/**
 * A line chart, shaped like the reference's duration card: no axes, no legend, a
 * 2px line and a faint area under it.
 *
 * Nivo's `theme` prop is a deep-partial, so only the handful of things the
 * reference actually draws are overridden — grid, axis, crosshair, tooltip — and
 * all of them come from the tokens in `theme.ts`, not from hex constants invented
 * in the chart layer.
 */
type NivoTheme = NonNullable<ComponentProps<typeof ResponsiveLine>["theme"]>;

export const nivoTheme: NivoTheme = {
  background: "transparent",
  text: { fill: colors.muted, fontSize: 10 },
  axis: {
    domain: { line: { stroke: colors.grid } },
    ticks: { line: { stroke: colors.grid }, text: { fill: colors.faint, fontSize: 10 } },
    legend: { text: { fill: colors.muted } },
  },
  grid: { line: { stroke: colors.grid, strokeWidth: 1 } },
  crosshair: {
    line: {
      stroke: colors.text,
      strokeWidth: 1,
      strokeOpacity: 0.22,
      strokeDasharray: "3 3",
    },
  },
  tooltip: {
    container: {
      background: colors.surfaceRaised,
      border: `1px solid ${colors.border}`,
      borderRadius: 8,
      boxShadow: "none",
      color: colors.text,
      fontSize: 11,
      padding: "6px 8px",
    },
  },
};

export interface LinePoint {
  /** Epoch ms — the x scale is linear on the window, not on index. */
  x: number;
  /** `null` is a gap: the collector stored no bucket there, which is not zero. */
  y: number | null;
}

export interface LineSeriesDef {
  id: string;
  label: string;
  color: string;
  points: ReadonlyArray<LinePoint>;
}

export interface LineSeriesProps {
  series: ReadonlyArray<LineSeriesDef>;
  height?: number;
  /** Excluded from the tooltip — for a "previous period" ghost, for instance. */
  dim?: ReadonlyArray<string>;
  formatValue?: (value: number) => string;
  formatX?: (x: number) => string;
  yMin?: number;
}

/**
 * Time series for the cards.
 *
 * A single series gets the area fill because that is what the reference draws; a
 * comparison (avg + p95, or period vs period) stays line-only, since two filled
 * areas over each other read as a stacked chart, which they are not.
 */
export function LineSeries({
  series,
  height = 150,
  formatValue = formatDuration,
  formatX = formatAxisStamp,
  yMin = 0,
}: LineSeriesProps) {
  const labels = new Map(series.map((entry) => [entry.id, entry.label]));
  const data: NivoLineSeries[] = series.map((entry) => ({
    id: entry.id,
    data: entry.points.map((point) => ({ x: point.x, y: point.y })),
  }));

  const xs = series.flatMap((entry) => entry.points.map((point) => point.x));
  const xMin = xs.length > 0 ? Math.min(...xs) : 0;
  const xMax = xs.length > 0 ? Math.max(...xs) : 1;

  const SliceTooltip = ({ slice }: SliceTooltipProps<NivoLineSeries>) => (
    <Box>
      <Typography sx={{ fontSize: 10, color: "text.disabled", mb: 0.25 }}>
        {formatX(slice.x)}
      </Typography>
      <Stack spacing={0.25}>
        {slice.points.map((point) => (
          <Stack key={String(point.id)} direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
            <Box
              sx={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                bgcolor: point.color,
                flexShrink: 0,
              }}
            />
            <Typography sx={{ fontSize: 11, color: "text.secondary", flex: 1 }}>
              {labels.get(String(point.id)) ?? String(point.id)}
            </Typography>
            <Typography sx={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
              {point.data.y === null ? "—" : formatValue(Number(point.data.y))}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );

  return (
    <Box sx={{ height, width: "100%" }}>
      <ResponsiveLine<NivoLineSeries>
        data={data}
        theme={nivoTheme}
        margin={{ top: 6, right: 2, bottom: 2, left: 2 }}
        xScale={{ type: "linear", min: xMin, max: xMax }}
        yScale={{ type: "linear", min: yMin, max: "auto" }}
        colors={series.map((entry) => entry.color)}
        curve="monotoneX"
        lineWidth={2}
        enablePoints={false}
        enableArea={series.length === 1}
        areaOpacity={0.14}
        areaBaselineValue={yMin}
        enableGridX={false}
        enableGridY={false}
        axisTop={null}
        axisRight={null}
        axisBottom={null}
        axisLeft={null}
        legends={[]}
        useMesh
        enableSlices="x"
        sliceTooltip={SliceTooltip}
        enableCrosshair
        crosshairType="x"
        animate={false}
        role="img"
        ariaLabel="Time series"
      />
    </Box>
  );
}
