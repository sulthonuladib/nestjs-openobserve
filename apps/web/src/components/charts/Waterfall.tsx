import { Box, Chip, Stack, Typography, alpha } from "@mui/material";
import type { SpanRow } from "../../api";
import { formatDuration, layoutWaterfall, orderSpanTree } from "../../format";
import { colors } from "../../theme";

/**
 * The trace waterfall.
 *
 * Nivo draws series, not trees, so this is hand-rolled SVG — and it has to be
 * SVG rather than absolutely positioned divs because a bar's x is a percentage of
 * the *request's own clock*: two spans that ran concurrently must overlap, and a
 * `viewBox="0 0 100 14"` puts `leftPct`/`widthPct` straight into `x`/`width` with
 * no unit conversion to get wrong.
 *
 * Hover is a controlled prop on purpose: the reference highlights the row that
 * matches the bar you are pointing at (and vice versa), which is what makes a
 * 40-row trace readable. The page owns `hoveredId`; this component only reports.
 */
export interface WaterfallProps {
  spans: ReadonlyArray<SpanRow>;
  /** The trace's own duration. Bars are a fraction of this, not of the window. */
  totalMs: number;
  hoveredId?: string | null;
  onHover?: (id: string | null) => void;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}

const LABEL_COLUMN = "minmax(0, 20rem)";
const DURATION_COLUMN = "4.5rem";

export function Waterfall({
  spans,
  totalMs,
  hoveredId = null,
  onHover,
  selectedId = null,
  onSelect,
}: WaterfallProps) {
  const { bars, totalMs: clockMs } = layoutWaterfall([...spans]);
  const ordered = orderSpanTree(spans);
  const fail = colors.danger;
  const normal = alpha(colors.text, 0.42);
  const selectedTint = colors.accentSoft;
  const hoverTint = alpha(colors.text, 0.045);
  const trackTint = alpha(colors.text, 0.05);

  if (spans.length === 0) {
    return (
      <Typography sx={{ fontSize: 12, color: "text.disabled", px: 2, py: 3 }}>
        No spans recorded for this execution. The agent reports them only when
        instrumentation is enabled on the app.
      </Typography>
    );
  }

  return (
    <Box>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: `${LABEL_COLUMN} 1fr ${DURATION_COLUMN}`,
          gap: 1.5,
          alignItems: "center",
          px: 1.5,
          py: 0.75,
        }}
      >
        <Typography sx={{ fontSize: 9, letterSpacing: "0.09em", color: "text.disabled" }}>
          SPAN
        </Typography>
        <Ruler totalMs={clockMs > 0 ? clockMs : totalMs} />
        <Typography
          sx={{
            fontSize: 9,
            letterSpacing: "0.09em",
            color: "text.disabled",
            textAlign: "right",
          }}
        >
          DURATION
        </Typography>
      </Box>

      <Box role="tree" aria-label="Trace waterfall">
        {ordered.map((span) => {
          const bar = bars.get(span.id);
          const active = hoveredId === span.id;
          const selected = selectedId === span.id;
          const name = span.name ?? `${span.className}.${span.method}`;
          return (
            <Box
              key={span.id}
              role="treeitem"
              aria-selected={selected}
              tabIndex={0}
              onMouseEnter={() => onHover?.(span.id)}
              onMouseLeave={() => onHover?.(null)}
              onFocus={() => onHover?.(span.id)}
              onBlur={() => onHover?.(null)}
              onClick={() => onSelect?.(span.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect?.(span.id);
                }
              }}
              sx={{
                display: "grid",
                gridTemplateColumns: `${LABEL_COLUMN} 1fr ${DURATION_COLUMN}`,
                gap: 1.5,
                alignItems: "center",
                px: 1.5,
                py: 0.5,
                cursor: onSelect ? "pointer" : "default",
                borderTop: `1px solid ${colors.border}`,
                bgcolor: selected ? selectedTint : active ? hoverTint : "transparent",
                "&:focus-visible": {
                  outline: `1px solid ${colors.accent}`,
                  outlineOffset: -1,
                },
              }}
            >
              <Stack
                direction="row"
                spacing={0.75}
                sx={{ minWidth: 0, pl: `${span.depth * 12}px`, alignItems: "center" }}
              >
                <Box
                  sx={{
                    width: 4,
                    height: 4,
                    borderRadius: "50%",
                    flexShrink: 0,
                    bgcolor: span.error
                      ? fail
                      : span.origin === "manual"
                        ? colors.accent
                        : colors.faint,
                  }}
                />
                <Typography
                  sx={{
                    fontFamily: "monospace",
                    fontSize: 11,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: span.error ? fail : "text.primary",
                  }}
                  title={name}
                >
                  {name}
                </Typography>
                {span.error && (
                  <Chip
                    label="error"
                    size="small"
                    sx={{
                      height: 15,
                      fontSize: 9,
                      color: fail,
                      bgcolor: alpha(fail, 0.14),
                      "& .MuiChip-label": { px: 0.6 },
                    }}
                  />
                )}
                {span.collapsedCount !== null && span.collapsedCount > 1 && (
                  <Chip
                    label={`×${span.collapsedCount}`}
                    size="small"
                    sx={{
                      height: 15,
                      fontSize: 9,
                      color: "text.secondary",
                      bgcolor: trackTint,
                      "& .MuiChip-label": { px: 0.6 },
                    }}
                  />
                )}
              </Stack>

              <Box
                sx={{
                  height: 14,
                  width: "100%",
                  borderRadius: "3px",
                  bgcolor: trackTint,
                  overflow: "hidden",
                }}
                title={
                  bar
                    ? `${name} — ${formatDuration(span.durationMs)} at +${formatDuration(
                        span.startOffsetMs,
                      )}`
                    : name
                }
              >
                {bar && (
                  <Box
                    component="svg"
                    viewBox="0 0 100 14"
                    preserveAspectRatio="none"
                    sx={{ display: "block", width: "100%", height: 14 }}
                  >
                    <rect
                      x={bar.leftPct}
                      y={4}
                      width={bar.widthPct}
                      height={6}
                      rx={0.6}
                      fill={span.error ? fail : normal}
                      opacity={active || selected ? 1 : 0.9}
                    />
                  </Box>
                )}
              </Box>

              <Typography
                sx={{
                  fontSize: 11,
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                  color: span.error ? fail : "text.secondary",
                }}
              >
                {formatDuration(span.durationMs)}
              </Typography>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

/** Five ticks across the request clock: `0ms … 96.4ms`. */
function Ruler({ totalMs }: { totalMs: number }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <Box sx={{ position: "relative", height: 12 }}>
      {ticks.map((tick) => (
        <Typography
          key={tick}
          sx={{
            position: "absolute",
            top: 0,
            left: `${tick * 100}%`,
            transform:
              tick === 0 ? "translateX(0)" : tick === 1 ? "translateX(-100%)" : "translateX(-50%)",
            fontSize: 9,
            color: colors.faint,
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {formatDuration(totalMs * tick)}
        </Typography>
      ))}
    </Box>
  );
}
