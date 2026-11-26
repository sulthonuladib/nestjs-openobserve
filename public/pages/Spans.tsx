/**
 * Spans — analytics for the spans an application *names itself*.
 *
 * The collector already stores every span, and `/telemetry/spans` aggregates
 * them by name; this page is the read surface for that aggregate. It is the one
 * place where a span name is a first-class thing rather than a row inside one
 * request's waterfall: "validate-order" is invoked 51 times, its p95 is 10.6 ms,
 * and that is true across every request that ran it.
 *
 * **Two populations, and the page says which one it is showing.** `mode:
 * "manual"` keeps the spans the code created with `tracer.createSpan` — the ones
 * a developer chose to name, which is what the reference calls custom spans.
 * `mode: "all"` adds the auto-instrumented ones (`pg`, `http`, queue calls),
 * where a name like `OrdersController.create` comes from the instrumented class.
 * The toggle is in the header, not hidden in a menu, because "no data" under the
 * default mode is otherwise indistinguishable from a broken agent.
 *
 * **The second card is the finding, not decoration.** Invocations and p95 are
 * both on log axes, so a name invoked five times sits on the same canvas as one
 * invoked 2,700 times without the busy one flattening the rest into the origin.
 * Colour is the failure rate on the reference's 0→5% band: "busy and slow" is a
 * different problem from "busy and failing", and a table sorted by traffic hides
 * the second one. The full rows are below it, sortable, because the chart is for
 * spotting and the table is for reading.
 *
 * Under "All applications" a name can come from any service, so rows carry an
 * Application column — and the same name in two services stays two rows: the
 * aggregate is grouped by (application, name), because "validate-order" in the
 * API and in the worker are two different code paths that happen to share a
 * label. That is why the row key, not the name, is what the table keys on.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { CaretDown, CaretUp } from "@phosphor-icons/react";
import { useMemo, useState, type ReactNode } from "react";
import { api, type SpanAggregateRow, type SpanAnalyticsResult } from "../api";
import { BarSeries } from "../components/charts/BarSeries";
import {
  formatAxisStamp,
  formatClock,
  formatDuration,
  formatNumber,
  formatPercent,
  windowFor,
  type TimeRangeId,
} from "../format";
import { colors, fontMono, labelCaps, tabular } from "../theme";
import { PageHeader } from "../components/shell/PageHeader";
import { useLiveInterval, useShell } from "../components/shell";

export interface SpansProps {
  /** The shell's scope. Empty means the whole project. */
  appId?: string;
  /** The legacy per-application route passes the id here. */
  id?: string;
  range?: TimeRangeId;
  navigate?: (to: string) => void;
  /** The top bar's search. Unused: this page filters its own table locally. */
  search?: string;
}

/** Which spans the page is counting. The wire calls them `origin`. */
type SpanMode = "manual" | "all";

export function Spans({ appId, id, range = "1h" }: SpansProps) {
  // Same rule as every activity page: `?app=` is the scope and empty is "All
  // applications", a real view. The legacy `/applications/:id/spans` path names a
  // concrete application, so a bookmark keeps its scope instead of widening.
  const scope = appId || id || "";
  return <SpansView scope={scope} range={range} />;
}

function SpansView({ scope, range }: { scope: string; range: TimeRangeId }) {
  const refetchInterval = useLiveInterval();
  const { apps } = useShell();
  const unscoped = scope === "";
  const scopeName = unscoped
    ? null
    : (apps.find((entry) => entry.id === scope)?.name ?? scope);

  // `manual` is the default because that is what the page is *for*: the spans
  // your code named. It is a local view setting, not a URL parameter — the URL
  // carries the scope and the window, and a mode that lived there would need a
  // default sentinel to keep a bare `/spans` and `/spans?mode=manual` from
  // becoming two cache entries.
  const [mode, setMode] = useState<SpanMode>("manual");

  const spans = useQuery({
    queryKey: ["span-analytics", scope, range, mode],
    queryFn: () => api.spanAnalytics(scope, { ...windowFor(range), mode, limit: 200 }),
    refetchInterval,
  });

  const data: SpanAnalyticsResult | undefined = spans.data;
  const rows = data?.rows ?? [];

  // The chart's x axis is the **whole window**, not just the buckets that happen
  // to carry a span. The API returns only non-empty buckets, so three quiet
  // hours followed by one busy quarter would draw as two adjacent bars and say
  // the opposite of what happened. Filling the gaps with zeros costs at most 240
  // bars (the server caps its bucket at 240 per window) and makes the shape of
  // the traffic the shape of the chart.
  const chartWindow = useMemo(() => windowFor(range), [range]);
  const series = useMemo(
    () => densifySeries(data?.series ?? [], data?.bucketMs, chartWindow),
    [data?.series, data?.bucketMs, chartWindow],
  );

  const totals = rows.reduce(
    (acc, row) => ({ invocations: acc.invocations + row.invocations, failures: acc.failures + row.failures }),
    { invocations: 0, failures: 0 },
  );
  const applicationCount = new Set(rows.map((row) => row.applicationId)).size;
  // "across 0 applications" is worse than saying nothing: the tiles are empty
  // because there are no rows, which the empty state below explains.
  const across =
    unscoped && applicationCount > 0
      ? `across ${applicationCount} ${applicationCount === 1 ? "application" : "applications"}`
      : undefined;

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Spans"
        description={
          unscoped
            ? "Named spans from every application: invocations, failures and tail latency, grouped by application and name."
            : `${scopeName} — analytics for the spans this service names, grouped by span name.`
        }
        actions={
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
            <Stat label="Spans" value={formatNumber(rows.length)} aside={across} />
            <Stat label="Invocations" value={formatNumber(totals.invocations)} aside={across} />
            <Stat
              label="Failed"
              value={formatNumber(totals.failures)}
              tone={totals.failures > 0 ? "danger" : "default"}
              aside={across}
            />
            {/* The honest toggle. `manual` is what the page means by "spans";
                `all` widens it to the instrumented ones and the caption on the
                chart says so, so the two views cannot be mistaken for each
                other under the same word. */}
            <ToggleButtonGroup
              exclusive
              size="small"
              value={mode}
              onChange={(_event, next: SpanMode | null) => {
                if (next) setMode(next);
              }}
              aria-label="Span population"
            >
              <ToggleButton value="manual">Manual</ToggleButton>
              <ToggleButton value="all">All</ToggleButton>
            </ToggleButtonGroup>
          </Stack>
        }
      />

      {spans.isError && (
        <Alert severity="error">
          Span analytics could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {errorMessage(spans.error)}
          </Box>
        </Alert>
      )}

      {spans.isLoading ? (
        <Stack direction={{ xs: "column", lg: "row" }} spacing={2}>
          <Box sx={{ flex: 1 }}>
            <Panel title="Spans">
              <Skeleton variant="rounded" height={180} />
            </Panel>
          </Box>
          <Box sx={{ flex: 1 }}>
            <Panel title="Latency by span">
              <Skeleton variant="rounded" height={180} />
            </Panel>
          </Box>
        </Stack>
      ) : rows.length === 0 && !spans.isError ? (
        <EmptyState
          mode={mode}
          unscoped={unscoped}
          onShowAll={() => setMode("all")}
        />
      ) : (
        <>
          <Stack direction={{ xs: "column", lg: "row" }} spacing={2}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Panel
                title="Spans"
                meta={
                  <Legend
                    keys={[
                      ["invocations", colors.muted],
                      ["failures", colors.danger],
                    ]}
                  />
                }
                caption={modeCaption(mode)}
              >
                <BarSeries
                  rows={series.map((point) => ({
                    label: formatClock(point.t),
                    invocations: point.invocations,
                    failures: point.failures,
                  }))}
                  indexBy="label"
                  keys={[
                    { id: "invocations", label: "invocations", color: colors.muted },
                    { id: "failures", label: "failures", color: colors.danger },
                  ]}
                  height={170}
                  formatIndex={(value) => String(value)}
                />
                <AxisEnds series={series} bucketMs={data?.bucketMs} />
              </Panel>
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Panel
                title="Latency by span"
                meta={<FailureLegend />}
                caption="p95 against invocations, both on log scales. Colour is the failure rate on a 0–5% band, so the upper-right corner is busy *and* slow and a red dot anywhere is worth opening the row for."
              >
                <Scatter rows={rows} />
              </Panel>
            </Box>
          </Stack>

          <SpanTable rows={rows} showApplication={unscoped} />
        </>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

type SortKey = "name" | "p95Ms" | "failureRate" | "invocations";

/**
 * The full aggregate, sortable.
 *
 * Default order is by invocations, which is the server's order and the reference
 * page's: the question "which of these runs most?" comes first. The other headers
 * are clickable because the other question — "which of these is worst?" — is what
 * sends someone to this page after an incident, and a reader should not have to
 * scan 40 rows to answer it.
 */
function SpanTable({
  rows,
  showApplication,
}: {
  rows: SpanAggregateRow[];
  /** Unscoped lists name the service on every row; scoped ones repeat nothing. */
  showApplication: boolean;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "invocations",
    dir: "desc",
  });
  // The search is local to this table on purpose: it narrows the rows already on
  // screen, and the top bar's `?search=` is a cross-page text filter that this
  // page does not implement server-side. Clearing it must not rewrite the URL.
  const [needle, setNeedle] = useState("");

  const filtered = useMemo(() => {
    const text = needle.trim().toLowerCase();
    if (!text) return rows;
    return rows.filter(
      (row) =>
        row.name.toLowerCase().includes(text) ||
        (showApplication && row.applicationName.toLowerCase().includes(text)),
    );
  }, [rows, needle, showApplication]);

  const sorted = useMemo(() => sortRows(filtered, sort), [filtered, sort]);
  // A shared p95 scale for the avg→p95 rule: with a per-row scale every rule
  // would be the same length and the column would say nothing.
  const p95Ceiling = Math.max(1, ...filtered.map((row) => row.p95Ms));

  const toggle = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === "desc" ? "asc" : "desc" }
        : { key, dir: key === "name" ? "asc" : "desc" },
    );

  return (
    <Paper sx={{ overflow: "hidden" }}>
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ px: 1.5, py: 1.25, alignItems: "center", flexWrap: "wrap" }}
      >
        <TextField
          size="small"
          placeholder="Search span names…"
          value={needle}
          onChange={(event) => setNeedle(event.target.value)}
          sx={{ minWidth: 240 }}
        />
        <Typography sx={{ fontSize: 11, color: "text.disabled", ml: "auto !important" }}>
          {sorted.length} of {rows.length} spans · sorted by{" "}
          {sort.key === "name" ? "name" : SORT_LABELS[sort.key]} {sort.dir === "desc" ? "↓" : "↑"}
        </Typography>
      </Stack>
      {sorted.length === 0 ? (
        <Box sx={{ px: 3, py: 6, textAlign: "center" }}>
          <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
            No span name matches “{needle.trim()}”.
          </Typography>
        </Box>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <SortCell label="Name" active={sort.key === "name"} dir={sort.dir} onClick={() => toggle("name")} />
              {showApplication && <TableCell>Application</TableCell>}
              {/* One column, two numbers, because avg and p95 only mean
                  something together: the gap between them is the tail. */}
              <SortCell
                label="Avg → p95"
                active={sort.key === "p95Ms"}
                dir={sort.dir}
                onClick={() => toggle("p95Ms")}
              />
              <SortCell
                label="Failure rate"
                active={sort.key === "failureRate"}
                dir={sort.dir}
                onClick={() => toggle("failureRate")}
              />
              <SortCell
                label="Invocations"
                align="right"
                active={sort.key === "invocations"}
                dir={sort.dir}
                onClick={() => toggle("invocations")}
              />
            </TableRow>
          </TableHead>
          <TableBody>
            {sorted.map((row) => (
              <TableRow key={`${row.applicationId}:${row.name}`}>
                <TableCell sx={{ fontWeight: 500, whiteSpace: "nowrap" }}>{row.name}</TableCell>
                {showApplication && (
                  <TableCell
                    sx={{ fontFamily: fontMono, fontSize: 11, color: "text.secondary", whiteSpace: "nowrap" }}
                  >
                    {row.applicationName}
                  </TableCell>
                )}
                <TableCell>
                  <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
                    <Box sx={{ ...tabular, fontSize: 11.5, color: "text.secondary", minWidth: 46, textAlign: "right" }}>
                      {formatDuration(row.avgMs)}
                    </Box>
                    <P95Rule avgMs={row.avgMs} p95Ms={row.p95Ms} ceiling={p95Ceiling} />
                    <Box sx={{ ...tabular, fontSize: 11.5, minWidth: 46 }}>
                      {formatDuration(row.p95Ms)}
                    </Box>
                  </Stack>
                </TableCell>
                <TableCell>
                  <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                    <Box
                      sx={{
                        ...tabular,
                        minWidth: 46,
                        fontSize: 12,
                        color: row.failureRate > 0 ? colors.danger : "text.secondary",
                      }}
                    >
                      {formatPercent(row.failureRate, 2)}
                    </Box>
                    <FailureBar rate={row.failureRate} />
                  </Stack>
                </TableCell>
                <TableCell align="right" sx={tabular}>
                  {formatNumber(row.invocations)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Paper>
  );
}

const SORT_LABELS: Record<SortKey, string> = {
  name: "name",
  p95Ms: "p95",
  failureRate: "failure rate",
  invocations: "invocations",
};

function sortRows(
  rows: SpanAggregateRow[],
  sort: { key: SortKey; dir: "asc" | "desc" },
): SpanAggregateRow[] {
  const factor = sort.dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (sort.key === "name") return a.name.localeCompare(b.name) * factor;
    return (a[sort.key] - b[sort.key]) * factor;
  });
}

/** A header cell that says it sorts, and which way it currently does. */
function SortCell({
  label,
  active,
  dir,
  onClick,
  align = "left",
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  align?: "left" | "right";
}) {
  const Icon = dir === "desc" ? CaretDown : CaretUp;
  return (
    <TableCell align={align}>
      <Box
        component="button"
        type="button"
        onClick={onClick}
        aria-label={`Sort by ${label}`}
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0.25,
          p: 0,
          border: 0,
          background: "none",
          color: active ? "text.primary" : "inherit",
          font: "inherit",
          letterSpacing: "inherit",
          textTransform: "inherit",
          cursor: "pointer",
        }}
      >
        {label}
        {active ? <Icon size={10} /> : null}
      </Box>
    </TableCell>
  );
}

/**
 * The avg→p95 rule: a hairline with a dot at avg and the end at p95, on a scale
 * shared by the whole table. It answers "is this span consistently slow or does
 * it have a tail?" at a glance — two spans with the same average and different
 * p95 are not the same problem.
 */
function P95Rule({ avgMs, p95Ms, ceiling }: { avgMs: number; p95Ms: number; ceiling: number }) {
  const width = 52;
  const end = Math.max(2, Math.min(100, (p95Ms / ceiling) * 100));
  const dot = Math.max(0, Math.min(end, (avgMs / ceiling) * 100));
  return (
    <Box
      sx={{
        position: "relative",
        width,
        height: 8,
        flexShrink: 0,
        "&::before": {
          content: '""',
          position: "absolute",
          left: 0,
          right: 0,
          top: 3,
          height: 1,
          backgroundColor: colors.borderStrong,
        },
      }}
    >
      <Box
        sx={{
          position: "absolute",
          left: 0,
          top: 3,
          height: 1,
          width: `${end}%`,
          backgroundColor: colors.muted,
        }}
      />
      <Box
        sx={{
          position: "absolute",
          left: `calc(${dot}% - 2px)`,
          top: 1,
          width: 5,
          height: 5,
          borderRadius: "50%",
          backgroundColor: colors.text,
        }}
      />
    </Box>
  );
}

/**
 * Failure rate on the reference's 0→5% band.
 *
 * A percentage-of-100 bar would leave every honest row as an empty track: 0.33%
 * is a real failure rate and 2px on a 56px bar. Five percent is where the
 * reference draws the end of the scale, and a bar that reaches it means "5% or
 * worse" rather than "100%".
 */
function FailureBar({ rate }: { rate: number }) {
  const filled = Math.min(rate / 0.05, 1);
  return (
    <Box
      sx={{
        width: 56,
        height: 4,
        borderRadius: 1,
        bgcolor: "rgba(255,255,255,0.07)",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      <Box
        sx={{
          width: `${filled * 100}%`,
          height: "100%",
          bgcolor: rate > 0 ? colors.danger : "transparent",
        }}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// The latency scatter — plain SVG, because @nivo/scatterplot is not a dependency
// and this is forty lines of arithmetic, not a library's worth of behaviour.
// ---------------------------------------------------------------------------

function Scatter({ rows }: { rows: SpanAggregateRow[] }) {
  const width = 640;
  const height = 240;
  const pad = { top: 12, right: 14, bottom: 30, left: 46 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  // A point needs a positive invocation count to sit on a log axis, and a
  // positive p95 to have a height at all. Rows without one are still in the
  // table below — dropping them from a log chart is not dropping them from the
  // page.
  const usable = rows.filter((row) => row.invocations > 0 && row.p95Ms > 0);
  if (usable.length === 0) {
    return (
      <Box sx={{ height: 200, display: "grid", placeItems: "center" }}>
        <Typography sx={{ fontSize: 12, color: "text.disabled" }}>
          No span in this window has both invocations and a p95 duration to plot.
        </Typography>
      </Box>
    );
  }

  const maxInvocations = Math.max(10, ...usable.map((row) => row.invocations));
  const maxP95 = Math.max(10, ...usable.map((row) => row.p95Ms));
  // Log domains anchored at 1 invocation and 0.1 ms: a span that ran once must
  // still be a point, and log10(0) has no answer.
  const xLogMax = Math.log10(maxInvocations);
  const yLogMin = Math.log10(0.1);
  const yLogMax = Math.log10(maxP95);
  const x = (value: number) =>
    pad.left + (Math.log10(Math.max(value, 1)) / xLogMax) * innerW;
  const y = (value: number) =>
    pad.top + innerH - ((Math.log10(Math.max(value, 0.1)) - yLogMin) / (yLogMax - yLogMin)) * innerH;

  const xTicks = powersOfTen(maxInvocations).filter((tick) => tick >= 1);
  const yTicks = powersOfTen(maxP95).filter((tick) => tick >= 0.1);

  const busiest = usable.reduce((a, b) => (b.invocations > a.invocations ? b : a));
  const slowest = usable.reduce((a, b) => (b.p95Ms > a.p95Ms ? b : a));

  return (
    <Box sx={{ width: "100%" }}>
      <Box component="svg" viewBox={`0 0 ${width} ${height}`} sx={{ width: "100%", height: "auto", display: "block" }}>
        {/* Horizontal rules at each decade, so "10 ms" is a line to read a dot
            against rather than a label to eyeball. */}
        {yTicks.map((tick) => (
          <line
            key={`grid-${tick}`}
            x1={pad.left}
            x2={pad.left + innerW}
            y1={y(tick)}
            y2={y(tick)}
            stroke={colors.grid}
            strokeWidth={1}
          />
        ))}
        {yTicks.map((tick) => (
          <text
            key={`ytick-${tick}`}
            x={pad.left - 8}
            y={y(tick) + 3}
            textAnchor="end"
            fontSize={9}
            fill={colors.faint}
          >
            {durationTick(tick)}
          </text>
        ))}
        {xTicks.map((tick) => (
          <text
            key={`xtick-${tick}`}
            x={x(tick)}
            y={pad.top + innerH + 14}
            textAnchor="middle"
            fontSize={9}
            fill={colors.faint}
          >
            {formatCountTick(tick)}
          </text>
        ))}
        <text
          x={pad.left + innerW}
          y={height - 4}
          textAnchor="end"
          fontSize={9}
          fill={colors.faint}
          letterSpacing="0.06em"
        >
          P95 AGAINST INVOCATIONS · LOG SCALES
        </text>

        {usable.map((row) => (
          <circle
            key={`${row.applicationId}:${row.name}`}
            cx={x(row.invocations)}
            cy={y(row.p95Ms)}
            r={row === busiest || row === slowest ? 5.5 : 4}
            fill={failureColor(row.failureRate)}
            // The hover text is the row's whole story; a scatter without it is a
            // picture of dots, not an answer.
            style={{ cursor: "help" }}
          >
            <title>
              {`${row.name}${row.applicationName ? ` · ${row.applicationName}` : ""}\n` +
                `${formatNumber(row.invocations)} invocations · p95 ${formatDuration(row.p95Ms)} · avg ${formatDuration(row.avgMs)}\n` +
                `${formatPercent(row.failureRate, 2)} failed · max ${formatDuration(row.maxMs)}`}
            </title>
          </circle>
        ))}

        {/* The two callouts the reference draws, and for the same reason: they
            are the two shapes an operator looks for first. One span can be both,
            so it gets one label rather than two on top of each other. */}
        <Callout
          row={busiest}
          label={busiest === slowest ? "busiest · slowest" : "busiest"}
          x={x(busiest.invocations)}
          y={y(busiest.p95Ms)}
          width={innerW + pad.left}
        />
        {slowest !== busiest && (
          <Callout
            row={slowest}
            label="slowest"
            x={x(slowest.invocations)}
            y={y(slowest.p95Ms)}
            width={innerW + pad.left}
          />
        )}
      </Box>
    </Box>
  );
}

function Callout({
  row,
  label,
  x,
  y,
  width,
}: {
  row: SpanAggregateRow;
  label: string;
  x: number;
  y: number;
  width: number;
}) {
  // Labels sit to the right of their dot unless that would leave the canvas;
  // then they flip left. dy above the dot, and down when the dot is near the top.
  const right = x < width - 150;
  const above = y > 28;
  return (
    <text
      x={right ? x + 9 : x - 9}
      y={above ? y - 7 : y + 15}
      textAnchor={right ? "start" : "end"}
      fontSize={9.5}
      fill={colors.muted}
      style={{ pointerEvents: "none" }}
    >
      {`${label}: ${row.name}`}
    </text>
  );
}

/**
 * The API returns only buckets that carry a span; the chart needs every bucket
 * in the window so an empty hour is an empty hour.
 *
 * Bucket starts are aligned to `bucketMs` (`floor(from / bucket) * bucket`) — the
 * same arithmetic the server groups by — so a filled bucket lands on exactly the
 * timestamp the server would have returned.
 */
function densifySeries(
  series: Array<{ t: number; invocations: number; failures: number }>,
  bucketMs: number | undefined,
  window: { from: number; to: number },
): Array<{ t: number; invocations: number; failures: number }> {
  // Nothing to lay out without a bucket size, and an empty response stays empty:
  // the page renders its empty state rather than a wall of zero-height bars.
  if (!bucketMs || series.length === 0) return series;
  const byBucket = new Map(series.map((point) => [point.t, point]));
  const start = Math.floor(window.from / bucketMs) * bucketMs;
  const dense: Array<{ t: number; invocations: number; failures: number }> = [];
  for (let t = start; t < window.to; t += bucketMs) {
    dense.push(byBucket.get(t) ?? { t, invocations: 0, failures: 0 });
  }
  return dense;
}

/** 0% is grey, 5%+ is the danger colour, and the blend between them is linear. */
function failureColor(rate: number): string {
  return mixHex(colors.muted, colors.danger, Math.min(rate / 0.05, 1));
}

function mixHex(from: string, to: string, t: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  const channel = (index: 0 | 1 | 2) => Math.round(a[index] + (b[index] - a[index]) * t);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

function parseHex(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((char) => char + char)
          .join("")
      : value;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** Decades from 1 to the maximum, so the axis has ticks whatever the scale is. */
function powersOfTen(max: number): number[] {
  const ticks: number[] = [];
  for (let exponent = -1; exponent <= 6; exponent += 1) {
    const value = 10 ** exponent;
    if (value > max * 1.2) break;
    ticks.push(value);
  }
  return ticks.length > 0 ? ticks : [1];
}

function durationTick(ms: number): string {
  if (ms < 1) return `${Math.round(ms * 1000)}µs`;
  if (ms < 1000) return `${ms} ms`;
  return `${ms / 1000} s`;
}

function formatCountTick(value: number): string {
  if (value < 1000) return String(value);
  return `${value / 1000}k`;
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

function modeCaption(mode: SpanMode): string {
  return mode === "manual"
    ? "Invocations and failures per bucket for spans created with tracer.createSpan. Spans are not in the per-minute rollup, so these counts come from the span rows themselves — an empty chart with traffic elsewhere means no custom span, not a broken agent."
    : "Invocations and failures per bucket with the auto-instrumented spans included — pg, http and queue calls, named after the class and method the agent patched. Same source, wider population.";
}

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

/** The chart's two axis endpoints — the reference prints them under the card. */
function AxisEnds({
  series,
  bucketMs,
}: {
  series: Array<{ t: number }>;
  bucketMs?: number;
}) {
  const first = series[0]?.t;
  const last = series[series.length - 1]?.t;
  if (first === undefined || last === undefined) {
    return (
      <Typography sx={{ mt: 1, fontSize: 10.5, color: "text.disabled" }}>
        No bucket in this window carries a span.
      </Typography>
    );
  }
  return (
    <Stack direction="row" sx={{ mt: 1, justifyContent: "space-between" }}>
      <Typography sx={{ fontSize: 10.5, color: "text.disabled" }}>
        {formatAxisStamp(first)}
      </Typography>
      <Typography sx={{ fontSize: 10.5, color: "text.disabled" }}>
        {formatAxisStamp(last)}
        {bucketMs ? ` · ${formatBucket(bucketMs)} buckets` : ""}
      </Typography>
    </Stack>
  );
}

function formatBucket(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function Stat({
  label,
  value,
  aside,
  tone = "default",
}: {
  label: string;
  value: string;
  /** What the number covers — a project-wide sum must say so. */
  aside?: string;
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
        <Typography sx={{ fontSize: 10, color: "text.disabled", ...tabular }}>{aside}</Typography>
      )}
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

/** The scatter's key: the same 0→5% ramp the dots use. */
function FailureLegend() {
  return (
    <Tooltip title="Colour is the share of invocations that failed. The ramp runs from 0% (grey) to 5% and beyond (red): the honest failure rates in this table are fractions of a percent, and a bar scaled to 100% would show none of them.">
      <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", cursor: "help" }}>
        <Typography sx={{ ...labelCaps, color: "text.secondary" }}>Failure rate</Typography>
        <Typography sx={{ fontSize: 10, color: "text.disabled" }}>0%</Typography>
        <Box
          sx={{
            width: 56,
            height: 4,
            borderRadius: 1,
            background: `linear-gradient(90deg, ${colors.muted}, ${colors.danger})`,
          }}
        />
        <Typography sx={{ fontSize: 10, color: "text.disabled" }}>5%+</Typography>
      </Stack>
    </Tooltip>
  );
}

function EmptyState({
  mode,
  unscoped,
  onShowAll,
}: {
  mode: SpanMode;
  unscoped: boolean;
  onShowAll: () => void;
}) {
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
      <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
        {mode === "manual"
          ? "No custom spans in this window."
          : "No spans in this window — neither manual nor auto-instrumented."}
      </Typography>
      <Typography sx={{ mt: 0.75, fontSize: 11.5, color: "text.disabled", maxWidth: 520, mx: "auto" }}>
        {mode === "manual" ? (
          <>
            Spans appear here once code creates one:{" "}
            <Box component="code" sx={{ fontFamily: fontMono, color: "text.secondary" }}>
              const span = tracer.createSpan(&quot;validate-order&quot;)
            </Box>{" "}
            — the auto-instrumented spans (pg, http, queue calls) are a different
            population and are hidden under this filter.
          </>
        ) : (
          <>
            The agent reports spans with every instrumented execution, so an empty
            list under “All” means nothing was recorded{unscoped ? " anywhere in the project" : ""} in
            the selected window rather than a filter hiding it.
          </>
        )}
      </Typography>
      {mode === "manual" && (
        <Button variant="outlined" sx={{ mt: 2 }} onClick={onShowAll}>
          Show auto-instrumented spans
        </Button>
      )}
    </Box>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
