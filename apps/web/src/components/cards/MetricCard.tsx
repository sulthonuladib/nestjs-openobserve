import { Box, Card, Skeleton, Stack, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { CaretDown, CaretUp, Minus } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { colors } from "../../theme";

/**
 * The metric card — the atom the reference dashboard is built out of.
 *
 * ```
 * Requests                    |2xx|4xx|5xx|
 * 3,044
 * 58/min  ▼18% since last period
 * [            chart                      ]
 * Oct 25 5:06 AM            Oct 25 6:07 AM
 * ```
 *
 * Every part is optional because the same shell has to hold a bar chart, a line
 * chart, a list and a "here is your last release" panel. What is *not* optional is
 * a state: a card renders its label immediately, then a skeleton, an error, an
 * empty message or the chart — never nothing, because an empty card is
 * indistinguishable from a broken one.
 */
export interface MetricCardProps {
  /** Small-caps label, top left. */
  label: string;
  /** The big number, already formatted — the card does not know its unit's scale. */
  value: string;
  /** Set smaller and muted next to the value: `ms`, `%`. */
  unit?: string;
  /** Right of the value: `p95 892 ms`, or a "unhandled" count. */
  aside?: ReactNode;
  /** The rate line: `58/min`. */
  rate?: string;
  /** Signed relative change vs the previous equal-length window (0.18 = +18%). */
  delta?: number | null;
  deltaCaption?: string;
  /** Right side of the header: a MUI ToggleButtonGroup, usually `Segmented`. */
  actions?: ReactNode;
  /** Below the chart: axis endpoints, or a note about what the bars mean. */
  footer?: ReactNode;
  chart?: ReactNode;
  chartHeight?: number;
  loading?: boolean;
  error?: unknown;
  empty?: boolean;
  emptyMessage?: string;
}

const labelSx = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: "text.disabled",
} as const;

export function MetricCard({
  label,
  value,
  unit,
  aside,
  rate,
  delta,
  deltaCaption = "since last period",
  actions,
  footer,
  chart,
  chartHeight = 150,
  loading = false,
  error,
  empty = false,
  emptyMessage = "No data in this window.",
}: MetricCardProps) {
  return (
    <Card
      variant="outlined"
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        bgcolor: "background.paper",
        borderColor: "divider",
        borderRadius: "10px",
        boxShadow: "none",
      }}
    >
      <Box sx={{ px: 2, pt: 1.75 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
          <Typography sx={labelSx}>{label}</Typography>
          {actions}
        </Stack>

        {loading ? (
          <Skeleton variant="text" width={96} height={40} sx={{ mt: 0.5 }} />
        ) : error ? (
          <Stack direction="row" spacing={0.75} sx={{ mt: 0.25, alignItems: "baseline" }}>
            <Typography
              sx={{
                fontSize: 28,
                fontWeight: 600,
                lineHeight: 1.15,
                letterSpacing: "-0.02em",
                color: "text.disabled",
              }}
            >
              —
            </Typography>
            <Typography sx={{ fontSize: 11, color: "error.main" }}>unavailable</Typography>
          </Stack>
        ) : (
          <>
            <Stack direction="row" spacing={0.75} sx={{ mt: 0.25, alignItems: "baseline" }}>
              <Typography
                sx={{
                  fontSize: 28,
                  fontWeight: 600,
                  lineHeight: 1.15,
                  letterSpacing: "-0.02em",
                  fontVariantNumeric: "tabular-nums",
                  color: error ? "text.disabled" : "text.primary",
                }}
              >
                {value}
              </Typography>
              {unit && (
                <Typography sx={{ fontSize: 13, color: "text.disabled", pb: 0.25 }}>
                  {unit}
                </Typography>
              )}
              {aside && (
                <Box sx={{ pb: 0.25, fontSize: 12, color: "text.secondary" }}>{aside}</Box>
              )}
            </Stack>

            <Stack direction="row" spacing={0.75} sx={{ mt: 0.25, alignItems: "center" }}>
              {!loading && rate && (
                <Typography
                  sx={{ fontSize: 12, color: "text.secondary", fontVariantNumeric: "tabular-nums" }}
                >
                  {rate}
                </Typography>
              )}
              {!loading && delta !== undefined && (
                <Delta value={delta} caption={deltaCaption} />
              )}
            </Stack>
          </>
        )}
      </Box>

      <Box sx={{ flex: 1, minHeight: chartHeight, mt: 1, position: "relative" }}>
        {loading ? (
          <Skeleton variant="rectangular" height={chartHeight} sx={{ mx: 1, borderRadius: 1.5 }} />
        ) : error ? (
          <CardMessage tone="error">{errorMessage(error)}</CardMessage>
        ) : empty ? (
          <CardMessage>{emptyMessage}</CardMessage>
        ) : (
          <>
            {/* The reference draws one hairline across the plot; Nivo has no
                single-line grid, and a grid of 3 would be noise at 150px. */}
            <Box
              aria-hidden
              sx={{
                position: "absolute",
                insetInline: 0,
                top: "50%",
                borderTop: `1px solid ${colors.grid}`,
                pointerEvents: "none",
              }}
            />
            {chart}
          </>
        )}
      </Box>

      {footer && (
        <Box sx={{ px: 2, pt: 0.75, pb: 1.5, minHeight: 18 }}>
          {loading ? <Skeleton variant="text" width="70%" height={12} /> : footer}
        </Box>
      )}
    </Card>
  );
}

/**
 * A card without a metric: the same chrome, for "Last release" and "Open errors",
 * whose content is a sentence or a list rather than a number and a chart.
 */
export function ContentCard({
  label,
  actions,
  children,
  loading = false,
  error,
  empty = false,
  emptyMessage = "Nothing here.",
  bodySx,
}: {
  label: string;
  actions?: ReactNode;
  children?: ReactNode;
  loading?: boolean;
  error?: unknown;
  empty?: boolean;
  emptyMessage?: string;
  bodySx?: object;
}) {
  return (
    <Card
      variant="outlined"
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        bgcolor: "background.paper",
        borderColor: "divider",
        borderRadius: "10px",
        boxShadow: "none",
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ px: 2, pt: 1.75, pb: 1, alignItems: "center", justifyContent: "space-between" }}
      >
        <Typography sx={labelSx}>{label}</Typography>
        {actions}
      </Stack>
      <Box sx={{ px: 2, pb: 1.75, flex: 1, ...bodySx }}>
        {loading ? (
          <Stack spacing={1}>
            <Skeleton variant="text" width="65%" />
            <Skeleton variant="text" width="85%" />
            <Skeleton variant="text" width="40%" />
          </Stack>
        ) : error ? (
          <CardMessage tone="error">{errorMessage(error)}</CardMessage>
        ) : empty ? (
          <CardMessage>{emptyMessage}</CardMessage>
        ) : (
          children
        )}
      </Box>
    </Card>
  );
}

/** Header-right segmented control: `AVG | P95`, `2xx | 4xx | 5xx`. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={value}
      aria-label={ariaLabel}
      onChange={(_event, next: T | null) => {
        if (next !== null) onChange(next);
      }}
      sx={{
        gap: 0.25,
        "& .MuiToggleButton-root": {
          border: 0,
          borderRadius: "4px !important",
          px: 0.6,
          py: 0.1,
          minWidth: 0,
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "text.disabled",
          lineHeight: 1.6,
        },
        "& .MuiToggleButton-root.Mui-selected": {
          bgcolor: "action.selected",
          color: "text.primary",
          "&:hover": { bgcolor: "action.selected" },
        },
      }}
    >
      {options.map((option) => (
        <ToggleButton key={option.value} value={option.value} aria-label={option.label}>
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

function Delta({ value, caption }: { value: number | null; caption: string }) {
  const flat = value === null || Math.abs(value) < 0.005;
  const up = (value ?? 0) > 0;
  const color = flat ? "text.disabled" : up ? "success.main" : "error.main";
  const Icon = flat ? Minus : up ? CaretUp : CaretDown;
  const text = value === null ? "—" : `${Math.abs(value * 100).toFixed(0)}%`;
  return (
    <Stack direction="row" spacing={0.25} sx={{ color, alignItems: "center" }}>
      <Icon size={10} weight="fill" />
      <Typography sx={{ fontSize: 11, fontVariantNumeric: "tabular-nums", color: "inherit" }}>
        {text}
      </Typography>
      <Typography sx={{ fontSize: 11, color: "text.disabled" }}>{caption}</Typography>
    </Stack>
  );
}

function CardMessage({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <Box
      sx={{
        height: "100%",
        minHeight: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        px: 2,
        py: 2,
        textAlign: "center",
      }}
    >
      <Typography sx={{ fontSize: 11.5, color: tone === "error" ? "error.main" : "text.disabled" }}>
        {children}
      </Typography>
    </Box>
  );
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Could not load this card. ${message}`;
}
