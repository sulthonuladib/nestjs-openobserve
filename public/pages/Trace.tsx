/**
 * Trace — everything recorded under a single trace id.
 *
 * The collector has stored `trace_id` since the first migration, `/api/v1/traces/:traceId`
 * has always answered with every execution that carried it, and until now there
 * was no surface for it: this is that page. It is the one page in the dashboard
 * that is **not** scoped to an application, because a trace crosses services by
 * definition — and it is therefore also the only place where a request and a job
 * are allowed to sit next to each other. A BullMQ consumer inherits the
 * producer's id, so "did the request's background work finish?" is one trace
 * away, and the `kind` column is what keeps the two from being confused.
 *
 * **Two clocks, drawn separately on purpose.**
 *
 *   * The *Hops* table positions every hop against the trace's own duration. That
 *     is where the gaps live, and a gap between two services (a queue wait, an
 *     uninstrumented hop) is usually the finding rather than noise.
 *   * Each hop's *Waterfall* restarts at zero, on that hop's own duration. A 20 ms
 *     handler inside an 11 s trace is a fraction of a percent of the trace clock —
 *     a single invisible pixel — so nesting spans under the trace clock would
 *     throw away exactly the detail the waterfall exists to show.
 *
 * A trace is also a *set of executions*, not one: every hop links to its own
 * execution page, which is the only place with the failing stack and the whole
 * span detail panel.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
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
  alpha,
} from "@mui/material";
import { CaretDown, CaretRight, Check, Copy } from "@phosphor-icons/react";
import { useMemo, useState, type ReactNode } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { api, ApiError, type TraceHop, type TraceResult } from "../api";
import { Waterfall } from "../components/charts/Waterfall";
import { useLiveInterval } from "../components/shell";
import { PageHeader } from "../components/shell/PageHeader";
import { statusTone } from "../components/ui";
import {
  formatClock,
  formatCount,
  formatDuration,
  formatRelative,
  type TimeRangeId,
} from "../format";
import { colors, labelCaps, tabular } from "../theme";

/**
 * The trace endpoint types its `logs` array as `t.Any()`, because a log line
 * carries an arbitrary `attributes` object that Elysia's schema cannot reconcile.
 * The handful of fields this page reads are named here once, instead of being
 * `any` at every use site.
 */
interface TraceLogRow {
  id: string;
  occurredAt: number;
  level: "fatal" | "error" | "warn" | "log" | "debug" | "verbose" | null;
  context: string | null;
  text: string;
  applicationName: string;
}

export interface TraceProps {
  /** `/traces/:traceId`; the shell reads it from the route. */
  traceId?: string;
  /** Kept so every link out of this page carries the window you arrived with. */
  range?: TimeRangeId;
  /** The shell's router; a bare render falls back to `useNavigate`. */
  navigate?: (to: string) => void;
}

const DESCRIPTION =
  "Everything recorded under a single trace id — every service that touched it, in wall-clock order.";

export function Trace({ traceId, range = "1h", navigate }: TraceProps) {
  const fallback = useNavigate();
  const go = navigate ?? fallback;

  if (!traceId) {
    return (
      <Stack spacing={3}>
        <PageHeader title="Trace" description={DESCRIPTION} />
        <EmptyState
          title="No trace id in the address."
          hint="A trace is addressed by the id the agent stamps on a request. Open one from an execution, an error occurrence or a log line."
        />
      </Stack>
    );
  }

  return <TraceView traceId={traceId} range={range} navigate={go} />;
}

function TraceView({
  traceId,
  range,
  navigate,
}: {
  traceId: string;
  range: TimeRangeId;
  navigate: (to: string) => void;
}) {
  const refetchInterval = useLiveInterval();
  const query = useQuery({
    queryKey: ["trace", traceId],
    queryFn: () => api.trace(traceId),
    refetchInterval,
    // A 404 means "this instance never saw that id" — asking again cannot make it
    // true, and a retry only delays the honest message. Real failures keep the
    // client's single retry.
    retry: (attempt, error) =>
      !(error instanceof ApiError && error.status === 404) && attempt < 1,
  });

  if (query.isLoading) return <TraceSkeleton traceId={traceId} />;

  if (query.isError || !query.data) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <Stack spacing={2.5}>
        <PageHeader title={titleFor(traceId)} description={DESCRIPTION} />
        {notFound ? (
          <EmptyState
            title="No trace with that id."
            hint="Trace ids are pruned with the retention policy, and an id from another instance is simply unknown here. Check the id, or open the execution itself — its page names the trace it belongs to."
          />
        ) : (
          <Alert severity="error">
            This trace could not be loaded.{" "}
            <Box component="span" sx={{ color: "text.secondary" }}>
              {errorMessage(query.error) ?? "The collector did not answer."}
            </Box>
          </Alert>
        )}
      </Stack>
    );
  }

  const trace = query.data;
  // The server orders hops by their causal start (`startsAt`), not by collector
  // arrival; the page trusts that order rather than re-sorting, so the table and
  // the timeline cannot disagree.
  const hops = trace.executions;
  const logs = (trace.logs ?? []) as TraceLogRow[];
  const spanTotal = hops.reduce((sum, hop) => sum + hop.spans.length, 0);
  const failed = hops.filter(isFailedHop).length;
  const first = hops[0];

  return (
    <Stack spacing={2.5}>
      <PageHeader
        title={titleFor(traceId)}
        description={DESCRIPTION}
        actions={
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <CopyTraceId id={traceId} />
            {first && (
              // The way back: the executions list of the hop that started it, with
              // the window you were already looking at.
              <Button
                variant="outlined"
                onClick={() =>
                  navigate(
                    `/applications/${first.execution.applicationId}/executions?range=${range}`,
                  )
                }
              >
                Executions
              </Button>
            )}
          </Stack>
        }
      />

      <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
        <Stat label="Trace id" value={traceId} mono />
        <Stat label="Duration" value={formatDuration(trace.durationMs)} />
        <Stat label="Hops" value={String(hops.length)} />
        <Stat label="Services" value={String(trace.applications.length)} />
        <Stat label="Spans" value={formatCount(spanTotal)} />
        <Stat label="Logs" value={formatCount(logs.length)} />
        <Stat label="Started" value={formatClock(trace.startedAt)} hint={formatRelative(trace.startedAt)} />
        {failed > 0 && <Stat label="Failed hops" value={String(failed)} tone="danger" />}
      </Stack>

      <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap", gap: 1 }}>
        <Typography sx={{ ...labelCaps, mr: 0.5 }}>Services</Typography>
        {trace.applications.map((application) => (
          <Chip
            key={application.id}
            clickable
            size="small"
            variant="outlined"
            label={`${application.name} · ${application.serviceId}`}
            title={`Open ${application.name}`}
            onClick={() => navigate(`/applications/${application.id}?range=${range}`)}
          />
        ))}
      </Stack>

      <Panel
        title="Hops"
        meta={
          <Typography sx={{ fontSize: 11, color: "text.disabled", ...tabular }}>
            {hops.length} {hops.length === 1 ? "hop" : "hops"} · by start time
          </Typography>
        }
        caption="Every execution that carried this id, positioned on the trace's own clock. A stretch with no bar is time the trace did not record: a queue wait, a network hop, or a service with no instrumentation. Click a row for that execution's spans, logs and stack."
      >
        <Hops trace={trace} range={range} navigate={navigate} />
      </Panel>

      <Panel
        title="Waterfalls"
        meta={
          <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
            each hop on its own clock
          </Typography>
        }
        caption="A hop's spans are laid out against that hop's duration, not the trace's — offsets restart at zero per hop, so a 20 ms handler inside a long trace stays readable. Bars that overlap ran concurrently, which is why a parent's children can sum to more than the parent."
      >
        <HopWaterfalls hops={hops} range={range} />
      </Panel>

      <Panel
        title="Logs"
        meta={
          <Typography sx={{ fontSize: 11, color: "text.disabled", ...tabular }}>
            {formatCount(logs.length)} {logs.length === 1 ? "line" : "lines"} · by application
          </Typography>
        }
        caption="Correlated by trace id, not by execution: a line written three services away still belongs to the request that caused it. The agent forwards what the app writes to stdout/stderr, batched like every other signal."
      >
        {logs.length === 0 ? (
          <EmptyState
            title="No forwarded logs for this trace."
            hint="Enable forwardLogs: true in ObserveModule.forRoot() and the app's stdout/stderr lines arrive with this id attached."
            inset
          />
        ) : (
          <LogGroups logs={logs} startedAt={trace.startedAt} />
        )}
      </Panel>

      <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
        Follows the LIVE toggle in the top bar. Hop durations come from the agent's own
        clock, so a trace spanning two hosts inherits their skew.
      </Typography>
    </Stack>
  );
}

/** A skeleton in the page's own shape: title, stat strip, two panels. Never a blank screen. */
function TraceSkeleton({ traceId }: { traceId: string }) {
  return (
    <Stack spacing={2.5}>
      <PageHeader title={titleFor(traceId)} description={DESCRIPTION} />
      <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <Skeleton key={index} variant="rounded" width={112} height={56} />
        ))}
      </Stack>
      <Skeleton variant="rounded" height={196} />
      <Skeleton variant="rounded" height={260} />
    </Stack>
  );
}

/**
 * The hops, on the trace clock.
 *
 * The bar column is the point of the table: `left` is the hop's offset from the
 * trace start and `width` its share of the trace's duration, so two jobs that
 * waited five seconds for a worker are visibly far from the request that enqueued
 * them instead of being two identical 600 ms bars in a list.
 */
function Hops({
  trace,
  range,
  navigate,
}: {
  trace: TraceResult;
  range: TimeRangeId;
  navigate: (to: string) => void;
}) {
  const bars = useMemo(() => hopBars(trace), [trace]);
  const clockMs = trace.durationMs ?? 0;

  return (
    <Box sx={{ overflowX: "auto" }}>
      <Table size="small" sx={{ minWidth: 960 }}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: 74 }}>Start</TableCell>
            <TableCell sx={{ width: 186 }}>Application</TableCell>
            <TableCell>Operation</TableCell>
            <TableCell sx={{ width: 76 }}>Kind</TableCell>
            <TableCell sx={{ width: 82 }}>Status</TableCell>
            <TableCell sx={{ width: 214 }}>
              <Ruler totalMs={clockMs} />
            </TableCell>
            <TableCell align="right" sx={{ width: 82 }}>
              Duration
            </TableCell>
            <TableCell align="right" sx={{ width: 60 }}>
              Spans
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {trace.executions.map((hop) => {
            const { execution } = hop;
            const bar = bars.get(execution.id);
            const path = executionPath(hop, range);
            return (
              <TableRow
                key={execution.id}
                hover
                sx={{ cursor: "pointer" }}
                onClick={() => navigate(path)}
              >
                <TableCell
                  sx={{ ...tabular, fontSize: 11.5, color: "text.secondary", whiteSpace: "nowrap" }}
                >
                  <Tooltip title={new Date(hop.startsAt).toLocaleString()}>
                    <Box component="span">
                      {offsetLabel(hop.startsAt - trace.startedAt)}
                    </Box>
                  </Tooltip>
                </TableCell>

                <TableCell>
                  <Typography sx={{ fontSize: 12.5, fontWeight: 600 }} noWrap>
                    {hop.applicationName}
                  </Typography>
                  <Typography
                    sx={{ fontSize: 10.5, color: "text.disabled", fontFamily: "monospace" }}
                    noWrap
                    title={hop.serviceId}
                  >
                    {hop.serviceId}
                  </Typography>
                </TableCell>

                <TableCell sx={{ maxWidth: 320 }}>
                  <RouterLink
                    to={path}
                    // The row navigates too; without this the click would be handled
                    // twice and the router would see two pushes of the same route.
                    onClick={(event) => event.stopPropagation()}
                    title="Open this execution"
                    style={{
                      color: colors.text,
                      textDecoration: "none",
                      fontFamily: "monospace",
                      fontSize: 12.5,
                    }}
                  >
                    {hopLabel(hop)}
                  </RouterLink>
                  <Typography sx={{ fontSize: 10.5, color: "text.disabled" }} noWrap>
                    {hopSubtitle(hop)}
                  </Typography>
                </TableCell>

                <TableCell>
                  <KindChip kind={execution.kind} />
                </TableCell>

                <TableCell>
                  <HopStatus hop={hop} />
                </TableCell>

                <TableCell>
                  <Box
                    sx={{
                      position: "relative",
                      height: 14,
                      borderRadius: "3px",
                      bgcolor: alpha(colors.text, 0.05),
                      overflow: "hidden",
                    }}
                  >
                    {bar && (
                      // SVG for the same reason `Waterfall` uses it: percentages go
                      // straight into `x`/`width` in a 100-unit viewBox.
                      <Box
                        component="svg"
                        viewBox="0 0 100 14"
                        preserveAspectRatio="none"
                        sx={{ display: "block", width: "100%", height: 14 }}
                      >
                        <rect
                          x={bar.left}
                          y={4}
                          width={bar.width}
                          height={6}
                          rx={0.6}
                          fill={
                            isFailedHop(hop)
                              ? colors.danger
                              : execution.kind === "job"
                                ? colors.accentText
                                : alpha(colors.text, 0.42)
                          }
                        />
                      </Box>
                    )}
                  </Box>
                </TableCell>

                <TableCell align="right" sx={{ ...tabular, fontSize: 12 }}>
                  {formatDuration(execution.durationMs)}
                </TableCell>

                <TableCell align="right" sx={{ ...tabular, fontSize: 11.5, color: "text.secondary" }}>
                  {hop.spans.length}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Box>
  );
}

/**
 * One waterfall per hop, collapsible from its header.
 *
 * Expanded by default: a trace has a handful of hops, and the reason to open this
 * page is to see the tree. Collapsing exists for the pathological case — a trace
 * a queue worker retried thirty times — where thirty span trees on one page is a
 * scroll bar, not information.
 */
function HopWaterfalls({ hops, range }: { hops: TraceHop[]; range: TimeRangeId }) {
  // Span ids are uuids, so one hover slot serves every hop without ambiguity.
  const [hovered, setHovered] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <Box>
      {hops.map((hop) => {
        const { execution } = hop;
        const open = collapsed[execution.id] !== true;
        const totalMs = execution.durationMs ?? 0;
        return (
          <Box
            key={execution.id}
            sx={{ borderTop: `1px solid ${colors.border}`, "&:first-of-type": { borderTop: "none" } }}
          >
            <Stack
              direction="row"
              spacing={1}
              onClick={() => setCollapsed((previous) => ({ ...previous, [execution.id]: open }))}
              sx={{ px: 1.75, py: 1, alignItems: "center", cursor: "pointer" }}
            >
              <Box sx={{ display: "flex", color: "text.disabled" }}>
                {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
              </Box>
              <Typography sx={{ fontSize: 12.5, fontWeight: 600 }} noWrap>
                {hop.applicationName}
              </Typography>
              <KindChip kind={execution.kind} />
              <Typography
                sx={{ fontFamily: "monospace", fontSize: 11.5, color: "text.secondary" }}
                noWrap
                title={hopLabel(hop)}
              >
                {hopLabel(hop)}
              </Typography>
              <Typography
                sx={{ ml: "auto", fontSize: 11, color: "text.disabled", ...tabular, whiteSpace: "nowrap" }}
              >
                0 — {formatDuration(totalMs)}
              </Typography>
              <RouterLink
                to={executionPath(hop, range)}
                onClick={(event) => event.stopPropagation()}
                style={{
                  color: colors.accentText,
                  textDecoration: "none",
                  fontSize: 11,
                  whiteSpace: "nowrap",
                }}
              >
                open execution
              </RouterLink>
            </Stack>
            {open && (
              <Waterfall
                spans={hop.spans}
                totalMs={totalMs}
                hoveredId={hovered}
                onHover={setHovered}
              />
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/** How many lines of one application to print before summarising the rest. */
const LOG_ROWS_PER_APPLICATION = 100;

/**
 * Correlated logs, grouped by the application that wrote them.
 *
 * Grouping is by application rather than by hop on purpose: two hops of the same
 * app interleave in time, and a log line knows which app wrote it but not which
 * hop it belongs to — the agent correlates to the trace id. Pretending otherwise
 * would mean inventing attribution the wire does not carry.
 */
function LogGroups({ logs, startedAt }: { logs: TraceLogRow[]; startedAt: number }) {
  const groups = useMemo(() => groupLogs(logs), [logs]);

  return (
    <Box>
      {groups.map(([application, rows]) => (
        <Box
          key={application}
          sx={{ borderTop: `1px solid ${colors.border}`, "&:first-of-type": { borderTop: "none" } }}
        >
          <Stack
            direction="row"
            spacing={1}
            sx={{ px: 1.75, py: 0.75, alignItems: "baseline", bgcolor: alpha(colors.text, 0.02) }}
          >
            <Typography sx={{ ...labelCaps, color: "text.secondary" }}>{application}</Typography>
            <Typography sx={{ fontSize: 10.5, color: "text.disabled", ...tabular }}>
              {formatCount(rows.length)} {rows.length === 1 ? "line" : "lines"}
            </Typography>
          </Stack>
          {rows.slice(0, LOG_ROWS_PER_APPLICATION).map((log) => (
            <LogLine key={log.id} log={log} startedAt={startedAt} />
          ))}
          {rows.length > LOG_ROWS_PER_APPLICATION && (
            <Typography sx={{ px: 1.75, py: 0.75, fontSize: 11, color: "text.disabled" }}>
              {formatCount(rows.length - LOG_ROWS_PER_APPLICATION)} more lines from this
              application — the endpoint returns the trace's first 1000.
            </Typography>
          )}
        </Box>
      ))}
    </Box>
  );
}

function LogLine({ log, startedAt }: { log: TraceLogRow; startedAt: number }) {
  const level = log.level ?? "log";
  const color = LEVEL_COLOR[level] ?? colors.muted;
  const failed = level === "error" || level === "fatal";

  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: "72px 62px 124px minmax(0, 1fr)",
        gap: 1,
        px: 1.75,
        py: 0.5,
        alignItems: "baseline",
        borderTop: `1px solid ${colors.border}`,
      }}
    >
      <Tooltip
        title={`${new Date(log.occurredAt).toLocaleString()} · ${offsetLabel(
          log.occurredAt - startedAt,
        )} from the trace start`}
      >
        <Typography sx={{ fontSize: 11, color: "text.disabled", ...tabular }}>
          {formatClock(log.occurredAt)}
        </Typography>
      </Tooltip>
      <Chip
        size="small"
        label={level}
        variant="outlined"
        sx={{
          height: 18,
          fontSize: 9.5,
          justifySelf: "start",
          color,
          borderColor: `${color}55`,
        }}
      />
      <Typography
        sx={{
          fontSize: 11,
          color: "text.secondary",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={log.context ?? ""}
      >
        {log.context ?? ""}
      </Typography>
      <Typography
        sx={{
          fontFamily: "monospace",
          fontSize: 11.5,
          color: failed ? colors.danger : "text.primary",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {log.text}
      </Typography>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Row content
// ---------------------------------------------------------------------------

/** `POST /orders`, or a job's operation id when the handler has no custom name. */
function hopLabel(hop: TraceHop): string {
  const operation = hop.operation;
  if (operation) {
    const name = operation.customName ?? operation.operationId;
    return operation.method ? `${operation.method} ${name}` : name;
  }
  // An execution whose operation row was pruned still belongs to the trace; the
  // job fields are the fallback name it has left.
  return hop.execution.jobName ?? hop.execution.queue ?? hop.execution.traceId;
}

/** The second line under an operation: what kind of call it was, in its own vocabulary. */
function hopSubtitle(hop: TraceHop): string {
  const { execution } = hop;
  if (execution.kind === "job") {
    const parts = [execution.queue ?? "queue"];
    if (execution.waitMs !== null) parts.push(`waited ${formatDuration(execution.waitMs)}`);
    if (execution.attemptsMade !== null && execution.maxAttempts !== null) {
      parts.push(`attempt ${execution.attemptsMade}/${execution.maxAttempts}`);
    }
    return parts.join(" · ");
  }
  const parts = [(execution.protocol ?? "http").toUpperCase()];
  if (execution.userId) parts.push(`user ${shortId(execution.userId)}`);
  // `calledAt` is deliberately not printed: the START column already says when,
  // and an ISO stamp under every row is noise in a table that is scanned.
  return parts.join(" · ");
}

function KindChip({ kind }: { kind: "request" | "job" }) {
  // A job is tinted with the accent, not just labelled: this is the one page where
  // a background run and an inbound request share a list, and mistaking one for
  // the other changes what the row means.
  return (
    <Chip
      size="small"
      label={kind}
      variant="outlined"
      sx={
        kind === "job"
          ? { color: colors.accentText, borderColor: `${colors.accent}66`, bgcolor: colors.accentSoft }
          : { color: "text.secondary", borderColor: colors.borderStrong }
      }
    />
  );
}

/**
 * The hop's outcome: an HTTP status, a job status, or nothing recorded.
 *
 * A hop that opened an error group is red whatever its status code says — a
 * `201` whose background job then threw is not a success from the trace's point of
 * view, and the tooltip carries the message that was captured.
 */
function HopStatus({ hop }: { hop: TraceHop }) {
  const { statusCode, jobStatus, errorGroupId, error } = hop.execution;
  const message = capturedError(error);
  const toneColor =
    errorGroupId !== null
      ? colors.danger
      : statusCode !== null
        ? toneToColor(statusTone(statusCode))
        : jobStatus === "failed"
          ? colors.danger
          : jobStatus === "completed"
            ? colors.ok
            : colors.faint;
  const label = statusCode !== null ? String(statusCode) : (jobStatus ?? "—");

  return (
    <Tooltip title={message ?? ""}>
      <Chip
        size="small"
        variant="outlined"
        label={label}
        sx={{ color: toneColor, borderColor: `${toneColor}55` }}
      />
    </Tooltip>
  );
}

function toneToColor(tone: ReturnType<typeof statusTone>): string {
  if (tone === "ok") return colors.ok;
  if (tone === "warn") return colors.warn;
  if (tone === "bad") return colors.danger;
  return colors.faint;
}

// ---------------------------------------------------------------------------
// Geometry and small helpers
// ---------------------------------------------------------------------------

interface Bar {
  left: number;
  width: number;
}

/**
 * One bar per hop, as percentages of the trace clock.
 *
 * Deliberately not `layoutWaterfall`: that lays out a *span tree* and derives its
 * own origin from the first span, while these bars must share the trace's origin
 * so the gaps between hops stay visible.
 */
function hopBars(trace: TraceResult): Map<string, Bar> {
  const clockMs = trace.durationMs && trace.durationMs > 0 ? trace.durationMs : 1;
  const bars = new Map<string, Bar>();
  for (const hop of trace.executions) {
    const offset = Math.max(0, hop.startsAt - trace.startedAt);
    const duration = hop.execution.durationMs ?? 0;
    bars.set(hop.execution.id, {
      left: Math.min(100, (offset / clockMs) * 100),
      // A sub-millisecond hop still has to be visible; 0.5% is about a pixel.
      width: Math.max((duration / clockMs) * 100, 0.5),
    });
  }
  return bars;
}

/** Three ticks are all a 200px column can carry: start, middle, end. */
function Ruler({ totalMs }: { totalMs: number }) {
  const ticks = [0, 0.5, 1];
  return (
    <Box sx={{ position: "relative", height: 12, width: "100%" }}>
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
            letterSpacing: "0.06em",
            color: colors.faint,
            fontVariantNumeric: "tabular-nums",
            textTransform: "none",
            whiteSpace: "nowrap",
          }}
        >
          {formatDuration(totalMs * tick)}
        </Typography>
      ))}
    </Box>
  );
}

function CopyTraceId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip title={copied ? "Copied" : "Copy trace id"}>
      <IconButton
        size="small"
        aria-label="Copy trace id"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(id)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {
              // A browser that refuses clipboard access is not a page error; the
              // id is still visible and selectable in the stat above.
            });
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </IconButton>
    </Tooltip>
  );
}

function executionPath(hop: TraceHop, range: TimeRangeId): string {
  return `/executions/${hop.execution.id}?range=${range}`;
}

function isFailedHop(hop: TraceHop): boolean {
  const { execution } = hop;
  return (
    execution.errorGroupId !== null ||
    execution.jobStatus === "failed" ||
    (execution.statusCode ?? 0) >= 500
  );
}

/** `+6.01s` — the offset from the trace start, which is what a hop row is scanned for. */
function offsetLabel(offsetMs: number): string {
  return offsetMs <= 0 ? "+0" : `+${formatDuration(offsetMs)}`;
}

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}

/** The captured error blob is opaque on the wire; print whatever it carries. */
function capturedError(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const value = error as { class?: unknown; message?: unknown };
    if (typeof value.message === "string") {
      return typeof value.class === "string" ? `${value.class}: ${value.message}` : value.message;
    }
    return JSON.stringify(error).slice(0, 300);
  }
  return String(error);
}

function groupLogs(logs: TraceLogRow[]): Array<[string, TraceLogRow[]]> {
  const groups = new Map<string, TraceLogRow[]>();
  for (const log of logs) {
    const key = log.applicationName || "(unknown application)";
    const rows = groups.get(key) ?? [];
    rows.push(log);
    groups.set(key, rows);
  }
  return [...groups.entries()];
}

/** The same level colours as the Logs page, so a line reads the same in both places. */
const LEVEL_COLOR: Record<NonNullable<TraceLogRow["level"]>, string> = {
  fatal: colors.danger,
  error: colors.danger,
  warn: colors.warn,
  log: colors.muted,
  debug: colors.faint,
  verbose: colors.faint,
};

function titleFor(traceId: string): ReactNode {
  return (
    <Box
      component="span"
      sx={{ display: "inline-flex", alignItems: "baseline", gap: 1.25, minWidth: 0 }}
    >
      <Box component="span">Trace</Box>
      <Box
        component="span"
        title={traceId}
        sx={{
          fontFamily: "monospace",
          fontSize: 19,
          letterSpacing: 0,
          color: colors.muted,
          overflowWrap: "anywhere",
        }}
      >
        {shortId(traceId)}
      </Box>
    </Box>
  );
}

function errorMessage(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Page furniture. The heading is the shell's; the rest is local to this page.
// ---------------------------------------------------------------------------

function Panel({
  title,
  meta,
  caption,
  padded = false,
  children,
}: {
  title: string;
  meta?: ReactNode;
  caption?: string;
  padded?: boolean;
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
      <Box sx={{ p: padded ? 1.5 : 0 }}>{children}</Box>
      {caption && (
        <Typography
          sx={{
            px: 2,
            py: 1.25,
            borderTop: `1px solid ${colors.border}`,
            fontSize: 11,
            color: "text.disabled",
          }}
        >
          {caption}
        </Typography>
      )}
    </Paper>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = "default",
  mono = false,
}: {
  label: string;
  value: string;
  hint?: string;
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
        minWidth: 96,
        maxWidth: mono ? 340 : undefined,
      }}
    >
      <Typography sx={labelCaps}>{label}</Typography>
      <Typography
        noWrap
        title={value}
        sx={{
          ...tabular,
          fontFamily: mono ? "monospace" : "inherit",
          fontSize: mono ? 12 : 16,
          fontWeight: 600,
          color: tone === "danger" ? colors.danger : "text.primary",
        }}
      >
        {value}
      </Typography>
      {hint && (
        <Typography sx={{ fontSize: 10.5, color: "text.disabled" }}>{hint}</Typography>
      )}
    </Box>
  );
}

function EmptyState({
  title,
  hint,
  inset = false,
}: {
  title: string;
  hint?: string;
  inset?: boolean;
}) {
  return (
    <Box
      sx={{
        border: `1px dashed ${colors.borderStrong}`,
        borderRadius: 1,
        px: 3,
        py: 5,
        m: inset ? 1.5 : 0,
        textAlign: "center",
      }}
    >
      <Typography sx={{ fontSize: 13, color: "text.secondary" }}>{title}</Typography>
      {hint && (
        <Typography sx={{ mt: 0.75, fontSize: 11.5, color: "text.disabled", maxWidth: 640, mx: "auto" }}>
          {hint}
        </Typography>
      )}
    </Box>
  );
}
