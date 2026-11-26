/**
 * Errors and logs.
 *
 * Both pages are MUI like the rest of the shell (the hosted product uses MUI +
 * Emotion, so the vocabulary — Paper, Tabs, Chip, Drawer — is the same one an
 * operator already knows from the reference).
 *
 * The error detail drawer is new: the collector has always stored the stack and
 * the agent-captured `codeFrames`, and the endpoint returns them — this is the
 * first surface that renders the failing source, which is the one thing a stack
 * trace alone cannot show.
 *
 * **Both pages are project-scoped, with the application as a filter.** The scope
 * arrives as the shell's `appId`: a concrete id, or `""` under "All
 * applications". An inbox that refuses to render until you pick one of six
 * services answers "is anything on fire right now?" with a menu, so the
 * unscoped view is the default shape and the application column is what keeps it
 * readable. The old `/applications/:id/errors` addresses still pass a route
 * `id`, which the shell redirects — accept it as the same scope.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  IconButton,
  MenuItem,
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
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { X } from "@phosphor-icons/react";
import { useState } from "react";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import {
  api,
  type ErrorDetail,
  type ErrorGroupRow,
  type ErrorOccurrence,
} from "../api";
import { useLiveInterval } from "../components/shell";
import { PageHeader } from "../components/shell/PageHeader";
import { useShell } from "../components/shell/ShellContext";
import { formatCount, formatRelative, windowFor, type TimeRangeId } from "../format";
import { colors, tabular } from "../theme";

type StatusFilter = ErrorGroupRow["status"] | "all";

const STATUSES: StatusFilter[] = ["open", "resolved", "ignored", "all"];

export interface ErrorsProps {
  /** The shell's scope; `""` means every application. */
  appId?: string;
  /** Legacy `/applications/:id/errors` route param — the same scope. */
  id?: string;
  range?: TimeRangeId;
  /** Accepted for the shell's contract; every way out of this page is an anchor. */
  navigate?: (to: string) => void;
}

export function Errors({ appId, id, range = "1h" }: ErrorsProps) {
  const client = useQueryClient();
  const refetchInterval = useLiveInterval();
  const [status, setStatus] = useState<StatusFilter>("open");
  // The row, not just its id: under "All applications" the drawer has to say
  // which application raised the error, and `errorDetail` returns the group
  // without the application join. The row we clicked already has the name.
  const [selected, setSelected] = useState<ErrorGroupRow | null>(null);

  const scope = appId || id || "";
  const all = scope === "";
  const { apps } = useShell();
  const appName = all ? null : (apps.find((entry) => entry.id === scope)?.name ?? scope);

  const query = useQuery({
    queryKey: ["errors", scope, status],
    queryFn: () => api.errors(scope, status === "all" ? undefined : status),
    refetchInterval,
  });

  const mutate = useMutation({
    mutationFn: ({ errorId, next }: { errorId: string; next: ErrorGroupRow["status"] }) =>
      api.setErrorStatus(errorId, next),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["errors"] });
      void client.invalidateQueries({ queryKey: ["error"] });
    },
  });

  const rows = query.data ?? [];
  // Every number on this page is a sum over `rows` — the rows the table is
  // actually showing. A count fetched separately (or summed per application)
  // would be a second opinion about the same list, and the two would disagree
  // the moment the status tab or the scope changes.
  const occurrences = rows.reduce((total, group) => total + group.occurrences, 0);

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Errors"
        description={
          all
            ? "Groups are fingerprinted at ingest: class, normalized message and the top in-app frame. One row per defect per application, across every application in the project."
            : "Groups are fingerprinted at ingest: class, normalized message and the top in-app frame. One row per defect, not per occurrence."
        }
        actions={
          <Tabs
            value={status}
            onChange={(_event, next: StatusFilter) => setStatus(next)}
            textColor="inherit"
            sx={{ minHeight: 32, "& .MuiTab-root": { py: 0.5, minHeight: 32, fontSize: 12 } }}
          >
            {STATUSES.map((entry) => (
              <Tab key={entry} value={entry} label={entry} />
            ))}
          </Tabs>
        }
      />

      {query.data && (
        <Typography sx={{ mt: -2, fontSize: 11.5, color: "text.disabled" }}>
          {formatCount(rows.length)} {rows.length === 1 ? "group" : "groups"} ·{" "}
          {formatCount(occurrences)} occurrences{" "}
          {all ? "· every application" : `· ${appName ?? "this application"}`}
        </Typography>
      )}

      {query.isError && (
        <Alert severity="error">
          The error list could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {errorMessage(query.error)}
          </Box>
        </Alert>
      )}

      {query.isLoading && <Skeleton variant="rounded" height={280} />}

      {!query.isLoading && rows.length === 0 && !query.isError && (
        <Paper sx={{ p: 3 }}>
          <Typography sx={{ fontWeight: 600, mb: 1 }}>
            No {status === "all" ? "" : `${status} `}error groups
            {all ? " anywhere in the project" : appName ? ` from ${appName}` : ""}.
          </Typography>
          <Typography sx={{ fontSize: 13, color: "text.secondary", maxWidth: 680 }}>
            An unhandled error becomes a group the first time{" "}
            {all ? "any application" : "the application"} reports one. Resolved and ignored groups
            stay here — switch the tab to find them.
          </Typography>
        </Paper>
      )}

      {rows.length > 0 && (
        <Paper sx={{ overflow: "hidden" }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Error</TableCell>
                {/* Under a single application the column would repeat the
                    title six times over; only the merged inbox needs it. */}
                {all && <TableCell>Application</TableCell>}
                <TableCell>Status</TableCell>
                <TableCell align="right">Occurrences</TableCell>
                <TableCell>Last seen</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((group) => (
                <TableRow
                  key={group.id}
                  hover
                  sx={{ cursor: "pointer" }}
                  onClick={() => setSelected(group)}
                >
                  <TableCell sx={{ maxWidth: 520 }}>
                    <Typography sx={{ fontSize: 13, fontWeight: 600 }} noWrap>
                      {group.message}
                    </Typography>
                    <Typography
                      sx={{ fontSize: 11, color: "text.disabled", fontFamily: "monospace" }}
                      noWrap
                    >
                      {group.class ?? "Error"}
                      {group.topFrameFile
                        ? ` · ${group.topFrameFile}:${group.topFrameLine ?? "?"}`
                        : ""}
                    </Typography>
                  </TableCell>
                  {all && (
                    <TableCell sx={{ whiteSpace: "nowrap" }}>
                      <Typography
                        sx={{ fontSize: 12, color: "text.secondary" }}
                        noWrap
                        title={group.applicationId}
                      >
                        {group.applicationName}
                      </Typography>
                    </TableCell>
                  )}
                  <TableCell>
                    <StatusChip status={group.status} />
                  </TableCell>
                  <TableCell align="right" sx={tabular}>
                    {formatCount(group.occurrences)}
                  </TableCell>
                  <TableCell sx={{ color: "text.secondary" }}>
                    <Tooltip title={new Date(group.lastSeen).toLocaleString()}>
                      <Box component="span">{formatRelative(group.lastSeen)}</Box>
                    </Tooltip>
                  </TableCell>
                  <TableCell align="right" onClick={(event) => event.stopPropagation()}>
                    <Button
                      size="small"
                      onClick={() =>
                        mutate.mutate({
                          errorId: group.id,
                          next: group.status === "resolved" ? "open" : "resolved",
                        })
                      }
                    >
                      {group.status === "resolved" ? "Reopen" : "Resolve"}
                    </Button>
                    <Button
                      size="small"
                      color="inherit"
                      onClick={() =>
                        mutate.mutate({
                          errorId: group.id,
                          next: group.status === "ignored" ? "open" : "ignored",
                        })
                      }
                    >
                      {group.status === "ignored" ? "Un-ignore" : "Ignore"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}

      <ErrorDrawer
        selected={selected}
        application={all ? (selected?.applicationName ?? null) : null}
        range={range}
        onClose={() => setSelected(null)}
        onStatus={(errorId, next) => mutate.mutate({ errorId, next })}
      />
    </Stack>
  );
}

function ErrorDrawer({
  selected,
  application,
  range,
  onClose,
  onStatus,
}: {
  selected: ErrorGroupRow | null;
  /** Set only under "All applications": which inbox row this group came from. */
  application: string | null;
  range: TimeRangeId;
  onClose: () => void;
  onStatus: (id: string, status: ErrorGroupRow["status"]) => void;
}) {
  const id = selected?.id ?? null;
  // A group id is a scope of its own, so the detail read is not filtered by
  // application — one click from the merged inbox and one from a single app
  // land on the same drawer.
  const detail = useQuery({
    queryKey: ["error", id],
    queryFn: () => api.errorDetail(id!),
    enabled: id !== null,
  });

  return (
    <Drawer
      anchor="right"
      open={id !== null}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            width: { xs: "100%", md: 760 },
            maxWidth: "100%",
            bgcolor: colors.surface,
            backgroundImage: "none",
          },
        },
      }}
    >
      <Box sx={{ p: 2.5 }}>
        <Stack direction="row" sx={{ alignItems: "flex-start", gap: 1 }}>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography sx={{ fontSize: 16, fontWeight: 600 }}>
              {detail.data?.group.message ?? "Loading…"}
            </Typography>
            <Typography sx={{ mt: 0.5, fontSize: 11, color: "text.disabled", fontFamily: "monospace" }}>
              {detail.data
                ? `${detail.data.group.class ?? "Error"}${
                    detail.data.group.topFrameFile
                      ? ` · ${detail.data.group.topFrameFile}:${detail.data.group.topFrameLine ?? "?"}`
                      : ""
                  }`
                : ""}
            </Typography>
          </Box>
          <IconButton size="small" onClick={onClose} aria-label="Close">
            <X size={16} />
          </IconButton>
        </Stack>

        {detail.isLoading && <Skeleton variant="rounded" height={220} sx={{ mt: 2 }} />}
        {detail.isError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {errorMessage(detail.error)}
          </Alert>
        )}

        {detail.data && (
          <ErrorBody
            detail={detail.data}
            application={application}
            range={range}
            onStatus={(next) => onStatus(detail.data.group.id, next)}
          />
        )}
      </Box>
    </Drawer>
  );
}

function ErrorBody({
  detail,
  application,
  range,
  onStatus,
}: {
  detail: ErrorDetail;
  application: string | null;
  range: TimeRangeId;
  onStatus: (status: ErrorGroupRow["status"]) => void;
}) {
  const group = detail.group;
  const latest = detail.occurrences[0];
  const stack = latest?.stack ?? null;

  return (
    <Stack spacing={2.5} sx={{ mt: 2.5 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <StatusChip status={group.status} />
        {application && (
          // The detail read has no application join; the row that opened the
          // drawer is where the name comes from.
          <Chip
            size="small"
            variant="outlined"
            label={application}
            title={group.applicationId}
          />
        )}
        <Chip size="small" variant="outlined" label={`${formatCount(group.occurrences)} occurrences`} />
        <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
          first seen {formatRelative(group.firstSeen)} · last seen {formatRelative(group.lastSeen)}
        </Typography>
        <Box sx={{ ml: "auto", display: "flex", gap: 1 }}>
          <Button
            size="small"
            variant={group.status === "resolved" ? "outlined" : "contained"}
            onClick={() => onStatus(group.status === "resolved" ? "open" : "resolved")}
          >
            {group.status === "resolved" ? "Reopen" : "Resolve"}
          </Button>
          <Button
            size="small"
            color="inherit"
            variant="outlined"
            onClick={() => onStatus(group.status === "ignored" ? "open" : "ignored")}
          >
            {group.status === "ignored" ? "Un-ignore" : "Ignore"}
          </Button>
        </Box>
      </Stack>

      <Divider />

      <Box>
        <Label>Latest occurrence</Label>
        <Typography sx={{ fontSize: 11, color: "text.disabled", mb: 1.5 }}>
          {latest ? new Date(latest.occurredAt).toLocaleString() : "none recorded"}
        </Typography>

        {latest?.codeFrames && latest.codeFrames.length > 0 ? (
          <Stack spacing={1.5}>
            {latest.codeFrames.map((frame) => (
              <CodeFrame key={`${frame.file}:${frame.firstLine}`} frame={frame} />
            ))}
          </Stack>
        ) : (
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 1.5,
              borderRadius: 1,
              bgcolor: colors.page,
              border: `1px solid ${colors.border}`,
              fontSize: 11.5,
              lineHeight: 1.6,
              overflow: "auto",
              color: colors.muted,
            }}
          >
            {stack ?? "No stack captured for this occurrence."}
          </Box>
        )}
      </Box>

      {detail.occurrences.length > 1 && (
        <Box>
          <Label>Recent occurrences</Label>
          <Stack divider={<Divider flexItem />} sx={{ mt: 1 }}>
            {detail.occurrences.slice(0, 10).map((occurrence) => (
              <Stack
                key={occurrence.id}
                direction="row"
                spacing={2}
                sx={{ py: 0.75, alignItems: "center" }}
              >
                <Typography sx={{ fontSize: 11, color: "text.secondary", ...tabular }}>
                  {new Date(occurrence.occurredAt).toLocaleString()}
                </Typography>
                {occurrence.executionId ? (
                  // The occurrence row carries an `executionId`, not a trace id: an
                  // error is raised inside one execution, while the trace id lives
                  // on it. Linking the execution is therefore the honest hop — its
                  // page links on to the full trace — and it costs no extra request.
                  <RouterLink
                    to={executionHref(occurrence.executionId, range)}
                    title={`Open execution ${occurrence.executionId}`}
                    style={{
                      color: colors.accentText,
                      textDecoration: "none",
                      fontSize: 11,
                      fontFamily: "monospace",
                    }}
                  >
                    {occurrence.executionId}
                  </RouterLink>
                ) : null}
              </Stack>
            ))}
          </Stack>
        </Box>
      )}
    </Stack>
  );
}

function CodeFrame({
  frame,
}: {
  frame: NonNullable<ErrorOccurrence["codeFrames"]>[number];
}) {
  return (
    <Box
      sx={{
        borderRadius: 1,
        border: `1px solid ${colors.border}`,
        bgcolor: colors.page,
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          px: 1.5,
          py: 0.75,
          borderBottom: `1px solid ${colors.border}`,
          fontSize: 11,
          color: colors.muted,
          fontFamily: "monospace",
        }}
      >
        {frame.file}:{frame.line}
      </Box>
      <Box component="pre" sx={{ m: 0, py: 1, fontSize: 11.5, lineHeight: 1.55, overflow: "auto" }}>
        {frame.lines.map((line, index) => {
          const number = frame.firstLine + index;
          const hit = number === frame.line;
          return (
            <Box
              key={number}
              component="div"
              sx={{
                display: "flex",
                gap: 1.5,
                px: 1.5,
                bgcolor: hit ? colors.accentSoft : "transparent",
                color: hit ? colors.accentText : colors.muted,
              }}
            >
              <Box component="span" sx={{ width: 34, textAlign: "right", color: colors.faint }}>
                {number}
              </Box>
              <Box component="span" sx={{ whiteSpace: "pre-wrap" }}>
                {line}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function StatusChip({ status }: { status: ErrorGroupRow["status"] }) {
  const color =
    status === "open" ? colors.danger : status === "resolved" ? colors.ok : colors.faint;
  return (
    <Chip
      size="small"
      label={status}
      variant="outlined"
      sx={{ color, borderColor: `${color}66`, bgcolor: `${color}14` }}
    />
  );
}

function Label({ children }: { children: string }) {
  return (
    <Typography
      sx={{
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: "0.09em",
        textTransform: "uppercase",
        color: colors.faint,
        mb: 0.75,
      }}
    >
      {children}
    </Typography>
  );
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

type Level = "fatal" | "error" | "warn" | "log" | "debug" | "verbose";

const LEVEL_COLOR: Record<Level, string> = {
  fatal: colors.danger,
  error: colors.danger,
  warn: colors.warn,
  log: colors.muted,
  debug: colors.faint,
  verbose: colors.faint,
};

/**
 * The log explorer.
 *
 * The server filters by level and trace id; substring search is over the page,
 * which is honest about what a list without a search index can promise. Rows
 * carry their `traceId`, so every line that belongs to a request links to that
 * trace — the correlation is by trace id and not by execution on purpose, because
 * a line written three services away still belongs to the request that caused it.
 * A line without one (bootstrap output, `Logger.debug` outside a request) shows a
 * dash rather than a dead link.
 *
 * Unscoped, this is **one stream merged across every application**, newest first:
 * the question `console` output is usually asked to answer ("who complained just
 * before the error?") is a question about the timeline, not about one service, so
 * the merge is the point and the Application column is what keeps it attributable.
 */
export interface LogsProps {
  /** The shell's scope; `""` means every application. */
  appId?: string;
  /** Legacy `/applications/:id/logs` route param — the same scope. */
  id?: string;
  range?: TimeRangeId;
  /** `?traceId=` — the shell passes it, so another page can hand over one request's lines. */
  traceId?: string;
}

export function Logs({ appId, id, range = "1h", traceId: propTraceId }: LogsProps) {
  const [level, setLevel] = useState<Level | "">("");
  const [search, setSearch] = useState("");
  const refetchInterval = useLiveInterval();
  const { apps } = useShell();
  const [params, setParams] = useSearchParams();

  const scope = appId || id || "";
  const all = scope === "";
  const appName = all ? null : (apps.find((entry) => entry.id === scope)?.name ?? scope);
  const window = windowFor(range);

  // `?traceId=` is how another page hands you the lines for one request: a trace
  // hop or an error occurrence link here with the id already set. It lives in the
  // URL (not in state) so the link is shareable and the back button undoes it,
  // which is why clearing it edits the address instead of a `useState`. The shell
  // passes it as a prop; reading the query directly keeps a bare render working.
  const traceId = propTraceId ?? params.get("traceId") ?? "";
  const clearTrace = () => {
    const next = new URLSearchParams(params);
    next.delete("traceId");
    setParams(next, { replace: true });
  };

  const query = useQuery({
    queryKey: ["logs", scope, range, level, traceId],
    queryFn: () =>
      api.logs(scope, {
        ...window,
        ...(level ? { level } : {}),
        ...(traceId ? { traceId } : {}),
        limit: 300,
      }),
    refetchInterval,
  });

  const items = (query.data ?? []).filter((log) =>
    search ? log.text.toLowerCase().includes(search.toLowerCase()) : true,
  );
  // Counted from the rows on screen, not from the window: "from 6 applications"
  // has to mean six applications wrote a line you can see.
  const senders = new Set(items.map((log) => log.applicationId)).size;

  return (
    <Stack spacing={2.5}>
      <PageHeader
        title="Logs"
        description={
          all
            ? "Every application's stdout and stderr, merged newest first. The agent sends what each app writes, batched like every other signal."
            : `Lines forwarded by ${appName}. The agent sends what the app writes to stdout/stderr, batched like every other signal.`
        }
        actions={
          <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
            {items.length} {items.length === 1 ? "line" : "lines"}
            {all && items.length > 0
              ? ` from ${senders} ${senders === 1 ? "application" : "applications"}`
              : ""}{" "}
            · last {range}
          </Typography>
        }
      />

      <Stack direction="row" spacing={1.5} sx={{ flexWrap: "wrap" }}>
        <TextField
          size="small"
          placeholder="Filter text…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          sx={{ minWidth: 240 }}
        />
        <TextField
          select
          size="small"
          label="Level"
          value={level}
          onChange={(event) => setLevel(event.target.value as Level | "")}
          sx={{ minWidth: 150 }}
        >
          <MenuItem value="">all levels</MenuItem>
          {(["fatal", "error", "warn", "log", "debug", "verbose"] as const).map((entry) => (
            <MenuItem key={entry} value={entry}>
              {entry}
            </MenuItem>
          ))}
        </TextField>
        {/* The trace filter always comes from the URL, never from these
            controls; it shows up as a chip so a narrowed stream is never
            mistaken for a quiet one. */}
        {traceId && (
          <Chip
            size="small"
            variant="outlined"
            label={`trace ${shortId(traceId)}`}
            title={traceId}
            onDelete={clearTrace}
            sx={{
              height: 30,
              fontFamily: "monospace",
              fontSize: 11,
              // A trace id is an id, not a section label: the theme's uppercase
              // chips would make `01a1…` read as a different string.
              textTransform: "none",
            }}
          />
        )}
      </Stack>

      {query.isError && (
        <Alert severity="error">
          The log list could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {errorMessage(query.error)}
          </Box>
        </Alert>
      )}

      {query.isLoading && <Skeleton variant="rounded" height={320} />}

      {!query.isLoading && items.length === 0 && !query.isError && (
        <Paper sx={{ p: 3 }}>
          <Typography sx={{ fontWeight: 600, mb: 1 }}>
            {traceId
              ? `No log lines for trace ${shortId(traceId)} in the last ${range}.`
              : all
                ? `No log lines from any application in the last ${range}.`
                : `No log lines from ${appName} in the last ${range}.`}
          </Typography>
          <Typography sx={{ fontSize: 13, color: "text.secondary", maxWidth: 700 }}>
            The agent only sends what the app writes to stdout/stderr. A stock Nest app writes its
            bootstrap and then nothing per request — add a <code>Logger</code> call or a logging
            middleware if you expected more.{" "}
            {all
              ? "This view is the merged stream across every application, so an empty one means nothing was forwarded anywhere in the window."
              : "Widen the range in the top bar to look further back."}
          </Typography>
        </Paper>
      )}

      {items.length > 0 && (
        <Paper sx={{ overflow: "hidden" }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 110 }}>Time</TableCell>
                {/* A merged stream without this column is noise: two lines that
                    read identically came from two different services. */}
                {all && <TableCell sx={{ width: 150 }}>Application</TableCell>}
                <TableCell sx={{ width: 90 }}>Level</TableCell>
                <TableCell sx={{ width: 150 }}>Context</TableCell>
                <TableCell sx={{ width: 124 }}>Trace</TableCell>
                <TableCell>Message</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((log) => (
                <TableRow key={log.id} hover>
                  <TableCell sx={{ color: "text.secondary", ...tabular, fontSize: 11 }}>
                    {new Date(log.occurredAt).toLocaleTimeString(undefined, { hour12: false })}
                  </TableCell>
                  {all && (
                    <TableCell
                      sx={{ color: "text.secondary", fontSize: 12, whiteSpace: "nowrap" }}
                      title={log.applicationId}
                    >
                      {log.applicationName}
                    </TableCell>
                  )}
                  <TableCell>
                    <Chip
                      size="small"
                      label={log.level ?? "log"}
                      variant="outlined"
                      sx={{
                        height: 20,
                        fontSize: 10,
                        color: LEVEL_COLOR[(log.level ?? "log") as Level],
                        borderColor: `${LEVEL_COLOR[(log.level ?? "log") as Level]}55`,
                      }}
                    />
                  </TableCell>
                  <TableCell
                    sx={{ color: "text.secondary", fontSize: 12, whiteSpace: "nowrap" }}
                  >
                    {log.context ?? ""}
                  </TableCell>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>
                    {log.traceId ? (
                      <RouterLink
                        to={traceHref(log.traceId, range)}
                        title={`Open trace ${log.traceId} — every service that handled that request`}
                        style={{
                          color: colors.accentText,
                          textDecoration: "none",
                          fontFamily: "monospace",
                          fontSize: 11,
                        }}
                      >
                        {shortId(log.traceId)}
                      </RouterLink>
                    ) : (
                      <Typography sx={{ fontSize: 11, color: "text.disabled" }}>—</Typography>
                    )}
                  </TableCell>
                  <TableCell
                    sx={{
                      fontFamily: "monospace",
                      fontSize: 11.5,
                      color: log.level === "error" || log.level === "fatal" ? colors.danger : "text.primary",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {log.text}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}

      <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
        The agent flushes on its interval; this page follows the LIVE toggle in the top bar.{" "}
        {all ? "Lines are merged across applications, newest first." : ""}
      </Typography>
    </Stack>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `/traces/:traceId`, carrying the window so the shell keeps its range. */
function traceHref(traceId: string, range: TimeRangeId): string {
  return `/traces/${traceId}?range=${range}`;
}

function executionHref(executionId: string, range: TimeRangeId): string {
  return `/executions/${executionId}?range=${range}`;
}

/** Twelve characters distinguishes an id you just read in a header. */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}
