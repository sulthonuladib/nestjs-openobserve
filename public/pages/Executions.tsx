/**
 * Executions — the spans page — and one execution's trace.
 *
 * The list is the index into a trace, so its columns are chosen for scanning:
 * time, what ran, how it ended, how long, and how big the tree is. Filtering by
 * kind is a server query (it changes which rows exist) *and* a toggle you can
 * flip without losing the window; filtering by operation is a server query too,
 * because the Requests table links here with `operationRowId`.
 *
 * **Project-scoped, with the application as a filter.** The scope arrives as the
 * shell's `appId`: a concrete id, or `""` under "All applications". This page is
 * a raw execution log, not a request metric, so it is the one list where a
 * request and a job run legitimately appear side by side — under a `kind` column
 * and a `kind` toggle, never added together. With "All applications" and
 * `kind=job` you are looking at every service's jobs, which is exactly the
 * question that view is for. Everything that *is* a request metric (throughput,
 * error rate, p95) filters `kind = 'request'` on the server and never reads this
 * table's totals.
 *
 * `?kind=` seeds the toggle: the Requests table on the application page links
 * here with `kind=request`, so clicking a row cannot land you in a list where
 * cron runs are mixed in with the endpoint you clicked. The toggle stays live.
 *
 * Every row also carries a link to its **trace**: one id, every service that
 * handled it. The link sits in its own cell rather than inside the row's click
 * target — a row that opens the execution and an anchor that opens the trace are
 * two different destinations, and an `<a>` nested in a `<button>` is invalid HTML.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Skeleton,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  Typography,
  alpha,
} from "@mui/material";
import { useMemo, useState, type ReactNode } from "react";
import { Link as RouterLink, useNavigate, useSearchParams } from "react-router-dom";
import { api, type ExecutionListItem, type SpanRow } from "../api";
import { Waterfall } from "../components/charts/Waterfall";
import { useLiveInterval } from "../components/shell";
import { PageHeader } from "../components/shell/PageHeader";
import { statusTone } from "../components/ui";
import { formatClock, formatDuration, layoutWaterfall, selfTimeMs } from "../format";
import type { TimeRangeId } from "../format";
import { windowFor } from "../format";
import { colors, tabular } from "../theme";

const KINDS = ["all", "request", "job"] as const;
type KindFilter = (typeof KINDS)[number];

export interface ExecutionsProps {
  /** The shell's scope; `""` means every application. */
  appId?: string;
  /** Legacy `/applications/:id/executions` route param — the same scope. */
  id?: string;
  range?: TimeRangeId;
  /** Set when the Requests table drilled into one handler. */
  operationRowId?: string;
  /** The shell's navigator; a bare render falls back to the router. */
  navigate?: (to: string) => void;
}

export function Executions({ appId, id, range = "1h", operationRowId, navigate }: ExecutionsProps) {
  const fallback = useNavigate();
  const go = navigate ?? fallback;
  const refetchInterval = useLiveInterval();
  const [params] = useSearchParams();
  const initialKind = params.get("kind");
  const [kind, setKind] = useState<KindFilter>(
    initialKind === "request" || initialKind === "job" ? initialKind : "all",
  );

  const scope = appId || id || "";
  const all = scope === "";
  const window = windowFor(range);

  const query = useQuery({
    queryKey: ["executions", scope, range, operationRowId, kind],
    queryFn: () =>
      api.executions(scope, {
        ...window,
        limit: 50,
        operationRowId,
        kind: kind === "all" ? undefined : kind,
      }),
    refetchInterval,
  });

  const items = query.data?.items ?? [];
  // Counted over the rows on screen, and counted *separately*: a request count
  // that included cron runs would be wrong in the same direction as the
  // dashboard, which is the one page people trust most.
  const requests = items.filter((item) => item.kind === "request").length;
  const jobs = items.length - requests;

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Executions"
        description={
          all
            ? "Raw execution log, newest first, across every application: one row per request and per job run. The toggle filters the list — the two kinds are never added into one number."
            : "Raw execution log, newest first: one row per request and per job run. The toggle filters the list — the two kinds are never added into one number."
        }
        actions={
          <Tabs
            value={kind}
            onChange={(_event, next: KindFilter) => setKind(next)}
            textColor="inherit"
            sx={{ minHeight: 32, "& .MuiTab-root": { py: 0.5, minHeight: 32, fontSize: 12 } }}
          >
            {KINDS.map((entry) => (
              <Tab key={entry} value={entry} label={entry} />
            ))}
          </Tabs>
        }
      />

      {query.data && (
        <Typography sx={{ mt: -2, fontSize: 11.5, color: "text.disabled" }}>
          {items.length} executions in the last {range} · {requests} requests · {jobs} jobs
          {all ? " · every application" : ""}
        </Typography>
      )}

      {query.isError && (
        <Alert severity="error">
          The execution list could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {errorMessage(query.error)}
          </Box>
        </Alert>
      )}

      {query.isLoading && <Skeleton variant="rounded" height={280} />}

      {!query.isLoading && items.length === 0 && !query.isError && (
        <EmptyState
          title="No executions in this window for these filters."
          hint={
            kind === "job"
              ? "Jobs only appear here when the agent reports a BullMQ handler — a queue that never ran in this window has nothing to show."
              : "Widen the range in the top bar, or switch the toggle: jobs and requests are stored side by side but listed apart."
          }
        />
      )}

      {items.length > 0 && (
        <Paper sx={{ overflow: "hidden" }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 96 }}>Time</TableCell>
                {/* Under a single application the column would repeat the scope
                    on every row; only the merged log needs it. */}
                {all && <TableCell sx={{ width: 150 }}>Application</TableCell>}
                <TableCell sx={{ width: 76 }}>Kind</TableCell>
                <TableCell>Operation</TableCell>
                <TableCell sx={{ width: 96 }}>Status</TableCell>
                <TableCell align="right" sx={{ width: 90 }}>
                  Duration
                </TableCell>
                <TableCell align="right" sx={{ width: 64 }}>
                  Spans
                </TableCell>
                <TableCell sx={{ width: 132 }}>Trace</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((item) => {
                const href = `/executions/${item.id}?range=${range}`;
                return (
                  <TableRow
                    key={item.id}
                    hover
                    tabIndex={0}
                    onClick={() => go(href)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") go(href);
                    }}
                    sx={{
                      cursor: "pointer",
                      "&:focus-visible": {
                        outline: `1px solid ${colors.accent}`,
                        outlineOffset: -1,
                      },
                    }}
                  >
                    <TableCell
                      sx={{ color: "text.secondary", ...tabular, fontSize: 11, whiteSpace: "nowrap" }}
                    >
                      {formatClock(item.startedAt)}
                    </TableCell>
                    {all && (
                      <TableCell
                        sx={{ color: "text.secondary", fontSize: 12, whiteSpace: "nowrap" }}
                        title={item.applicationId}
                      >
                        {item.applicationName}
                      </TableCell>
                    )}
                    <TableCell
                      sx={{
                        fontFamily: "monospace",
                        fontSize: 11,
                        color: item.kind === "job" ? colors.warn : "text.disabled",
                      }}
                    >
                      {item.kind}
                    </TableCell>
                    <TableCell sx={{ maxWidth: 420 }}>
                      <Typography
                        sx={{ fontFamily: "monospace", fontSize: 11.5 }}
                        noWrap
                        title={operationLabel(item)}
                      >
                        {item.method ? (
                          <Box component="span" sx={{ color: "text.disabled" }}>
                            {item.method}{" "}
                          </Box>
                        ) : null}
                        {operationLabel(item)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
                        {item.errorGroupId && (
                          <CodeChip label="error" color={colors.danger} />
                        )}
                        {item.statusCode !== null && (
                          <CodeChip
                            label={String(item.statusCode)}
                            color={toneColor(statusTone(item.statusCode))}
                          />
                        )}
                        {item.statusCode === null && !item.errorGroupId && (
                          <Typography sx={{ fontSize: 11, color: "text.disabled" }}>—</Typography>
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell align="right" sx={{ ...tabular, fontSize: 11.5 }}>
                      {formatDuration(item.durationMs)}
                    </TableCell>
                    <TableCell align="right" sx={{ ...tabular, fontSize: 11.5, color: "text.disabled" }}>
                      {item.spanCount}
                    </TableCell>
                    {/* The anchor is a destination of its own, so the row's
                        click handler must not also fire. */}
                    <TableCell
                      sx={{ whiteSpace: "nowrap" }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <RouterLink
                        to={traceHref(item.traceId, range)}
                        title={`Open trace ${item.traceId} — every service that handled it`}
                        style={{
                          color: colors.faint,
                          textDecoration: "none",
                          fontFamily: "monospace",
                          fontSize: 11,
                        }}
                      >
                        {shortTraceId(item.traceId)}
                      </RouterLink>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Paper>
      )}
    </Stack>
  );
}

/**
 * The trace waterfall for one execution.
 *
 * Bars are positioned from `startOffsetMs` + `durationMs` against the execution's
 * own clock, which is what lets concurrent siblings overlap instead of stacking.
 * The tree renders as an indented list so the structure survives on a narrow
 * screen; clicking a span opens its detail strip underneath, because the two
 * facts a waterfall cannot draw — origin and self time — are what tell you
 * whether the time is in this handler or in its children.
 *
 * This page is one *hop*. The trace id in the header is a link to `/traces/:traceId`,
 * which is where the other services are — and the reason the id is shown at all.
 */
export function ExecutionDetail({ id, range = "1h" }: { id?: string; range?: TimeRangeId }) {
  const query = useQuery({
    queryKey: ["execution", id],
    queryFn: () => api.execution(id!),
    enabled: Boolean(id),
  });

  const spans = query.data?.spans ?? [];
  const { totalMs } = useMemo(() => layoutWaterfall(spans), [spans]);
  const [openSpan, setOpenSpan] = useState<string | null>(null);

  if (!id) {
    return (
      <Stack spacing={3}>
        <PageHeader dense title="Execution" description="One execution and its span tree." />
        <EmptyState
          title="No execution id in the address."
          hint="An execution is addressed by the id on its row in the spans list, an error occurrence, or a trace hop."
        />
      </Stack>
    );
  }
  if (query.isError) {
    return (
      <Alert severity="error">
        This execution could not be loaded.{" "}
        <Box component="span" sx={{ color: "text.secondary" }}>
          {errorMessage(query.error)}
        </Box>
      </Alert>
    );
  }
  if (query.isLoading) return <Skeleton variant="rounded" height={320} />;
  if (!query.data) return <EmptyState title="No such execution." />;

  const { execution, operation, logs, error } = query.data;
  const selected = openSpan ? (spans.find((span) => span.id === openSpan) ?? null) : null;

  return (
    <Stack spacing={2.5}>
      <PageHeader
        dense
        title={
          <Box component="span" sx={{ fontFamily: "monospace", fontSize: 19 }}>
            {executionTitle(execution, operation)}
          </Box>
        }
        description={
          <>
            trace{" "}
            <RouterLink
              to={traceHref(execution.traceId, range)}
              title="Every service that carried this trace id"
              style={{ color: colors.accentText, fontFamily: "monospace", textDecoration: "none" }}
            >
              {execution.traceId}
            </RouterLink>{" "}
            · {new Date(execution.startedAt).toISOString()} · {spans.length} spans ·{" "}
            {formatDuration(totalMs)} total
          </>
        }
        actions={
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Button
              size="small"
              variant="outlined"
              component={RouterLink}
              to={traceHref(execution.traceId, range)}
            >
              view full trace
            </Button>
            {execution.statusCode !== null && (
              <CodeChip
                label={String(execution.statusCode)}
                color={toneColor(statusTone(execution.statusCode))}
              />
            )}
            <Chip size="small" variant="outlined" label={execution.kind} />
          </Stack>
        }
      />

      {error && (
        <Paper
          sx={{
            p: 1.75,
            border: `1px solid ${alpha(colors.danger, 0.4)}`,
            bgcolor: alpha(colors.danger, 0.08),
          }}
        >
          <Typography sx={{ fontSize: 13, fontWeight: 600, color: colors.danger }}>
            {error.class ?? "Error"}: {error.message}
          </Typography>
          {error.topFrameFile && (
            <Typography sx={{ mt: 0.5, fontFamily: "monospace", fontSize: 11, color: "text.secondary" }}>
              {error.topFrameFile}:{error.topFrameLine}
            </Typography>
          )}
          <Typography sx={{ mt: 0.5, fontSize: 11, color: "text.disabled" }}>
            seen {error.occurrences} times · first {new Date(error.firstSeen).toLocaleString()}
          </Typography>
        </Paper>
      )}

      <Paper sx={{ overflow: "hidden" }}>
        <Stack
          direction="row"
          sx={{
            alignItems: "center",
            justifyContent: "space-between",
            px: 2,
            py: 1.25,
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          <Typography sx={{ fontSize: 13, fontWeight: 600 }}>Waterfall</Typography>
          <Typography sx={{ ...tabular, fontSize: 11, color: "text.disabled" }}>
            0 — {formatDuration(totalMs)}
          </Typography>
        </Stack>
        <Waterfall
          spans={spans}
          totalMs={totalMs}
          selectedId={openSpan}
          onSelect={(spanId) => setOpenSpan(openSpan === spanId ? null : spanId)}
        />
        {selected && <SpanDetail span={selected} spans={spans} />}
      </Paper>

      <Paper sx={{ overflow: "hidden" }}>
        <Typography
          sx={{ px: 2, py: 1.25, fontSize: 13, fontWeight: 600, borderBottom: `1px solid ${colors.border}` }}
        >
          Logs for this trace
        </Typography>
        {logs.length === 0 ? (
          <Typography sx={{ px: 2, py: 3, textAlign: "center", fontSize: 12, color: "text.disabled" }}>
            No forwarded logs. Enable <code>forwardLogs: true</code> in{" "}
            <code>ObserveModule.forRoot()</code> to correlate them.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 96 }}>Time</TableCell>
                <TableCell sx={{ width: 84 }}>Level</TableCell>
                <TableCell sx={{ width: 140 }}>Context</TableCell>
                <TableCell>Message</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={log.id} hover>
                  <TableCell sx={{ ...tabular, fontSize: 11, color: "text.disabled" }}>
                    {formatClock(log.occurredAt)}
                  </TableCell>
                  <TableCell>
                    <CodeChip
                      label={log.level ?? "log"}
                      color={
                        log.level === "error" || log.level === "fatal"
                          ? colors.danger
                          : colors.muted
                      }
                    />
                  </TableCell>
                  <TableCell
                    sx={{ fontSize: 11.5, color: "text.secondary", whiteSpace: "nowrap" }}
                  >
                    {log.context ?? ""}
                  </TableCell>
                  <TableCell
                    sx={{ fontFamily: "monospace", fontSize: 11.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                  >
                    {log.text}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>
    </Stack>
  );
}

/** The strip under the waterfall: the facts about the span you clicked. */
function SpanDetail({ span, spans }: { span: SpanRow; spans: SpanRow[] }) {
  const self = selfTimeMs(span.id, spans);
  const tags = span.tags as Record<string, unknown> | null;
  return (
    <Box
      sx={{
        px: 2,
        py: 1.5,
        borderTop: `1px solid ${colors.border}`,
        bgcolor: colors.page,
      }}
    >
      <Box
        component="dl"
        sx={{
          display: "grid",
          gridTemplateColumns: "7.5rem 1fr",
          columnGap: 1.5,
          rowGap: 0.75,
          m: 0,
          fontSize: 11.5,
        }}
      >
        <Term>class.method</Term>
        <Detail mono>
          {span.className}.{span.method}
        </Detail>
        <Term>origin</Term>
        <Detail>{span.origin}</Detail>
        <Term>start offset</Term>
        <Detail mono>{formatDuration(span.startOffsetMs)}</Detail>
        <Term>self time</Term>
        <Detail mono>{formatDuration(self)}</Detail>
        {tags && Object.keys(tags).length > 0 && (
          <>
            <Term>tags</Term>
            <Detail mono>{JSON.stringify(tags)}</Detail>
          </>
        )}
      </Box>
    </Box>
  );
}

function Term({ children }: { children: ReactNode }) {
  return (
    <Box component="dt" sx={{ color: "text.disabled" }}>
      {children}
    </Box>
  );
}

function Detail({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return (
    <Box component="dd" sx={{ m: 0, fontFamily: mono ? "monospace" : undefined }}>
      {children}
    </Box>
  );
}

/** A tinted, monospace badge for a status code, a level or the word `error`. */
function CodeChip({ label, color }: { label: string; color: string }) {
  return (
    <Chip
      size="small"
      label={label}
      sx={{
        height: 19,
        fontFamily: "monospace",
        fontSize: 10.5,
        color,
        border: `1px solid ${alpha(color, 0.35)}`,
        bgcolor: alpha(color, 0.12),
        "& .MuiChip-label": { px: 0.75 },
      }}
    />
  );
}

/** The name a row is recognised by: an endpoint, a queue handler, or the trace. */
function operationLabel(item: ExecutionListItem): string {
  if (item.operationId) return item.operationId;
  if (item.queue && item.jobName) return `${item.queue} · ${item.jobName}`;
  return item.queue ?? item.jobName ?? item.traceId;
}

function executionTitle(
  execution: { queue: string | null; jobName: string | null; traceId: string },
  operation: { method: string | null; operationId: string } | null | undefined,
): string {
  const name =
    operation?.operationId ??
    (execution.queue && execution.jobName
      ? `${execution.queue} · ${execution.jobName}`
      : (execution.jobName ?? execution.queue ?? execution.traceId));
  return `${operation?.method ? `${operation.method} ` : ""}${name}`;
}

function toneColor(tone: ReturnType<typeof statusTone>): string {
  return tone === "bad"
    ? colors.danger
    : tone === "warn"
      ? colors.warn
      : tone === "ok"
        ? colors.ok
        : colors.faint;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `/traces/:traceId`, with the window carried along so the shell keeps the range. */
function traceHref(traceId: string, range: TimeRangeId): string {
  return `/traces/${traceId}?range=${range}`;
}

/** Twelve characters is enough to recognise an id you just saw in a header. */
function shortTraceId(traceId: string): string {
  return traceId.length > 12 ? `${traceId.slice(0, 12)}…` : traceId;
}

function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <Box
      sx={{
        border: `1px dashed ${colors.borderStrong}`,
        borderRadius: 1,
        px: 3,
        py: 5,
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

export type { ExecutionListItem };
