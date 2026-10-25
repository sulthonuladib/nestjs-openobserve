import { Box, Stack, Typography } from "@mui/material";
import { ResponsiveBar } from "@nivo/bar";
import type { BarDatum, BarTooltipProps } from "@nivo/bar";
import { nivoTheme } from "./LineSeries";

/**
 * A bar chart, shaped like the reference's requests card: thin bars that sit on
 * the baseline, stacked by status class, no axes, no labels, no legend.
 *
 * Stacking is deliberate. A day of traffic as three groups per bucket is
 * unreadable at 150px tall; as one bar whose top slice turns red it is a glance.
 */
export interface BarSeriesKey {
  id: string;
  label: string;
  color: string;
}

export interface BarSeriesProps {
  /** Rows of `{ [indexBy]: label, [keyId]: number }`. Missing keys count as 0. */
  rows: ReadonlyArray<Record<string, string | number>>;
  indexBy: string;
  keys: ReadonlyArray<BarSeriesKey>;
  height?: number;
  /** Label for a bucket — a timestamp for time buckets, a queue name otherwise. */
  formatIndex: (value: number | string) => string;
  formatValue?: (value: number) => string;
}

export function BarSeries({
  rows,
  indexBy,
  keys,
  height = 150,
  formatIndex,
  formatValue = (value) => String(Math.round(value)),
}: BarSeriesProps) {
  /**
   * Nivo's own tooltip knows one bar (the segment under the cursor); the card
   * wants the whole bucket — "17:04 · 2xx 240 · 4xx 4 · 5xx 0" — so the row is
   * read out of `data` instead of off the hovered segment.
   */
  const renderTooltip = (props: BarTooltipProps<BarDatum>) => (
    <Box>
      <Typography sx={{ fontSize: 10, color: "text.disabled", mb: 0.25 }}>
        {formatIndex(props.indexValue)}
      </Typography>
      <Stack spacing={0.25}>
        {keys.map((key) => (
          <Stack key={key.id} direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
            <Box
              sx={{ width: 6, height: 6, borderRadius: "1px", bgcolor: key.color, flexShrink: 0 }}
            />
            <Typography sx={{ fontSize: 11, color: "text.secondary", flex: 1 }}>
              {key.label}
            </Typography>
            <Typography sx={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
              {formatValue(Number(props.data[key.id] ?? 0))}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );

  return (
    <Box sx={{ height, width: "100%" }}>
      <ResponsiveBar<BarDatum>
        data={rows}
        indexBy={indexBy}
        keys={keys.map((key) => key.id)}
        theme={nivoTheme}
        margin={{ top: 2, right: 0, bottom: 0, left: 0 }}
        padding={0.4}
        innerPadding={0}
        groupMode="stacked"
        colors={keys.map((key) => key.color)}
        borderWidth={0}
        borderRadius={1}
        enableLabel={false}
        enableGridX={false}
        enableGridY={false}
        axisTop={null}
        axisRight={null}
        axisBottom={null}
        axisLeft={null}
        legends={[]}
        tooltip={renderTooltip}
        animate={false}
        role="img"
        ariaLabel="Time buckets"
      />
    </Box>
  );
}
