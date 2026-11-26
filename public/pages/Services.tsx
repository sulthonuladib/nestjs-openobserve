/**
 * Services — which NestJS classes actually burn the time.
 *
 * The unit is a **class**, not a service: `CheckoutRepository` and
 * `CheckoutService` live in the same application but answer different questions,
 * and merging them by module or by HTTP route would hide the one number this page
 * exists for. Every row is a class the agent instrumented, aggregated over the
 * window:
 *
 *   * **own time** — the span's duration minus the sum of its *direct* children.
 *     A controller that only awaits a service has near-zero own time; the waiting
 *     is not work it did. This is the column that finds the hot code.
 *   * **total time** — the span including everything nested under it, so the same
 *     controller can sit at the top of it while doing nothing of its own.
 *
 * The two columns are read together on purpose, and the caption under the table
 * says so in one sentence: a row with 20% of own time and 40% of total time is
 * waiting on someone else, and following the await is the next click.
 *
 * **Sampling caveat, stated once.** The agent samples spans. Millisecond totals
 * are therefore indicative, while the *shares* and the *ordering* stay valid —
 * sampling thins every class proportionally. Neither column sums to a request's
 * full latency, because only direct children are subtracted (grandchildren are
 * counted again in the child's own total). Copy that flattens that away would
 * promise a precision the data does not have.
 *
 * Under "All applications" rows carry an Application column, and the same class
 * name in two services is two rows: own time in the API and own time in the
 * worker are not a quantity you can add.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Collapse,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { Fragment, useMemo, useState } from "react";
import { api, type ServiceClassRow, type ServiceMethodRow } from "../api";
import { formatCount, formatDuration, formatPercent, windowFor, type TimeRangeId } from "../format";
import { colors, fontMono, labelCaps, tabular } from "../theme";
import { PageHeader } from "../components/shell/PageHeader";
import { useLiveInterval, useShell } from "../components/shell";

export interface ServicesProps {
  appId?: string;
  id?: string;
  range?: TimeRangeId;
  navigate?: (to: string) => void;
  search?: string;
}

/** How the table is ordered. Own time is the default because it is the point. */
type SortMode = "own" | "total" | "class";

export function Services({ appId, id, range = "1h" }: ServicesProps) {
  // `""` is "All applications", a real view rather than a missing scope. The
  // legacy `/applications/:id/services` path names a concrete one, so a bookmark
  // keeps its scope instead of silently widening to the project.
  const scope = appId || id || "";
  return <ServicesView scope={scope} range={range} />;
}

function ServicesView({ scope, range }: { scope: string; range: TimeRangeId }) {
  const refetchInterval = useLiveInterval();
  const { apps } = useShell();
  const unscoped = scope === "";
  const scopeName = unscoped
    ? null
    : (apps.find((entry) => entry.id === scope)?.name ?? scope);

  const [sort, setSort] = useState<SortMode>("own");
  // Expanded classes are keyed by (application, class), not by class name: under
  // "All applications" two services can both have a `ProductsService`, and
  // expanding one must not open the other.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const services = useQuery({
    queryKey: ["services", scope, range],
    queryFn: () => api.services(scope, windowFor(range)),
    refetchInterval,
  });

  const rows = useMemo(() => services.data ?? [], [services.data]);
  const ordered = useMemo(() => sortClasses(rows, sort), [rows, sort]);

  // Every share on this page is a share of *these* rows. The server returns the
  // top 100 classes by own time, so "38%" means 38% of the own time listed here —
  // the caption says "listed" rather than claiming a whole-window percentage.
  const listedOwn = rows.reduce((sum, row) => sum + row.ownMs, 0);
  const listedTotal = rows.reduce((sum, row) => sum + row.totalMs, 0);
  const listedCalls = rows.reduce((sum, row) => sum + row.calls, 0);
  const listedErrors = rows.reduce((sum, row) => sum + row.errors, 0);
  const maxShare = listedOwn > 0 ? Math.max(...rows.map((row) => row.ownMs / listedOwn)) : 0;
  const applicationCount = new Set(rows.map((row) => row.applicationId)).size;
  const across =
    unscoped && applicationCount > 0
      ? `across ${applicationCount} ${applicationCount === 1 ? "application" : "applications"}`
      : undefined;

  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Services"
        description={
          unscoped
            ? "Which classes in the project burn the time. Own time subtracts nested calls; total time includes everything awaited below."
            : `${scopeName} — which of this service's classes burn the time, with own time separated from total time.`
        }
        actions={
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
            <Stat label="Own time" value={formatDuration(listedOwn)} aside={across} />
            <Stat
              label="Errors"
              value={formatCount(listedErrors)}
              tone={listedErrors > 0 ? "danger" : "default"}
              aside={across}
            />
            {/* Sorting is a control, not hidden state: the two questions this
                page answers ("where is the time?" / "what is slowest end to
                end?") are two of these three options. */}
            <ToggleButtonGroup
              exclusive
              size="small"
              value={sort}
              onChange={(_event, next: SortMode | null) => {
                if (next) setSort(next);
              }}
              aria-label="Sort classes"
            >
              <ToggleButton value="class">Class</ToggleButton>
              <ToggleButton value="own">Own time</ToggleButton>
              <ToggleButton value="total">Total time</ToggleButton>
            </ToggleButtonGroup>
          </Stack>
        }
      />

      {services.isError && (
        <Alert severity="error">
          The class breakdown could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {errorMessage(services.error)}
          </Box>
        </Alert>
      )}

      {services.isLoading ? (
        <Paper sx={{ p: 2 }}>
          <Skeleton variant="rounded" height={220} />
        </Paper>
      ) : rows.length === 0 && !services.isError ? (
        <EmptyState scoped={!unscoped} />
      ) : (
        <Paper sx={{ overflow: "hidden" }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Class</TableCell>
                {unscoped && <TableCell>Application</TableCell>}
                <TableCell sx={{ minWidth: 210 }}>
                  <Tooltip title="Span duration minus the sum of its direct children: time this class actually spent in its own code. The bar is relative to the largest class on this page, not to 100% of the window.">
                    <Box component="span" sx={{ borderBottom: `1px dotted ${colors.borderStrong}` }}>
                      Own time
                    </Box>
                  </Tooltip>
                </TableCell>
                <TableCell align="right">
                  <Tooltip title="Own time divided by calls — the average cost of one invocation of this class, with its nested calls removed.">
                    <Box component="span" sx={{ borderBottom: `1px dotted ${colors.borderStrong}` }}>
                      Avg own / call
                    </Box>
                  </Tooltip>
                </TableCell>
                <TableCell align="right">
                  <Tooltip title="Everything this class and everything nested under it took. A controller can top this column while spending no time of its own — that gap is the await.">
                    <Box component="span" sx={{ borderBottom: `1px dotted ${colors.borderStrong}` }}>
                      Total time
                    </Box>
                  </Tooltip>
                </TableCell>
                <TableCell align="right">Calls</TableCell>
                <TableCell align="right">Errors</TableCell>
                <TableCell align="right">Methods</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {ordered.map((row) => {
                const key = `${row.applicationId}\u0000${row.className}`;
                const open = expanded.has(key);
                const share = listedOwn > 0 ? row.ownMs / listedOwn : 0;
                return (
                  <Fragment key={key}>
                    <TableRow
                      hover
                      onClick={() => toggle(key)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggle(key);
                        }
                      }}
                      tabIndex={0}
                      aria-expanded={open}
                      sx={{
                        cursor: "pointer",
                        "&:focus-visible": {
                          outline: `1px solid ${colors.accent}`,
                          outlineOffset: -1,
                        },
                      }}
                    >
                      <TableCell>
                        <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
                          {/* The caret is how the row says "there is more inside"
                              without a second, smaller click target. */}
                          <Box sx={{ display: "flex", color: "text.disabled", mt: "1px" }}>
                            {open ? <CaretDown size={11} /> : <CaretRight size={11} />}
                          </Box>
                          <Typography sx={{ fontSize: 12.5, fontWeight: 500 }}>
                            {row.className}
                          </Typography>
                        </Stack>
                      </TableCell>
                      {unscoped && (
                        <TableCell
                          sx={{
                            fontFamily: fontMono,
                            fontSize: 11,
                            color: "text.secondary",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {row.applicationName}
                        </TableCell>
                      )}
                      <TableCell>
                        <Stack spacing={0.5}>
                          <Stack direction="row" spacing={0.75} sx={{ alignItems: "baseline" }}>
                            <Box sx={{ ...tabular, fontSize: 12.5, fontWeight: 600 }}>
                              {formatDuration(row.ownMs)}
                            </Box>
                            <Typography sx={{ fontSize: 10, color: "text.disabled", ...tabular }}>
                              · {formatPercent(share, share < 0.1 ? 1 : 0)}
                            </Typography>
                          </Stack>
                          <ShareBar share={share} maxShare={maxShare} />
                        </Stack>
                      </TableCell>
                      <TableCell align="right" sx={{ ...tabular, color: "text.secondary" }}>
                        {formatDuration(row.avgOwnMs)}
                      </TableCell>
                      <TableCell align="right" sx={tabular}>
                        {formatDuration(row.totalMs)}
                      </TableCell>
                      <TableCell align="right" sx={tabular}>
                        {formatCount(row.calls)}
                      </TableCell>
                      <TableCell
                        align="right"
                        sx={{ ...tabular, color: row.errors > 0 ? colors.danger : "text.secondary" }}
                      >
                        {formatCount(row.errors)}
                      </TableCell>
                      <TableCell align="right" sx={{ ...tabular, color: "text.secondary" }}>
                        {row.methods.length}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell colSpan={unscoped ? 8 : 7} sx={{ p: 0, borderBottom: 0 }}>
                        <Collapse in={open} timeout="auto" unmountOnExit>
                          <Box
                            sx={{
                              backgroundColor: "rgba(255,255,255,0.015)",
                              borderTop: `1px solid ${colors.border}`,
                              borderBottom: `1px solid ${colors.border}`,
                              px: 2,
                              py: 1,
                            }}
                          >
                            <MethodTable methods={row.methods} classTotalOwnMs={row.ownMs} />
                          </Box>
                        </Collapse>
                      </TableCell>
                    </TableRow>
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>

          {/* The reference's caption, kept because the distinction is the whole
              page and it is not obvious from two headings. */}
          <Typography
            sx={{
              px: 2,
              py: 1.5,
              borderTop: `1px solid ${colors.border}`,
              fontSize: 11,
              color: "text.disabled",
              lineHeight: 1.6,
            }}
          >
            Own time is time spent in a class&apos;s own code with nested calls subtracted — where
            the time is actually going. Total time includes everything awaited further down, so a
            controller can top it while doing no work of its own. Shares are of the {rows.length}{" "}
            classes listed, not of the whole window; under span sampling the milliseconds are
            indicative while the shares and ordering stay valid, and neither column sums to a
            request&apos;s full latency.
            {listedTotal > 0 ? (
              <>
                {" "}
                Summed over the listed classes: {formatDuration(listedTotal)} total,{" "}
                {formatCount(listedCalls)} calls.
              </>
            ) : null}
          </Typography>
        </Paper>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// The expanded row: one class's methods, same vocabulary as the class row
// ---------------------------------------------------------------------------

function MethodTable({
  methods,
  classTotalOwnMs,
}: {
  methods: ServiceMethodRow[];
  /** The class's own time, which the method shares are measured against. */
  classTotalOwnMs: number;
}) {
  if (methods.length === 0) {
    return (
      <Typography sx={{ px: 1, py: 1, fontSize: 11.5, color: "text.disabled" }}>
        No method rows for this class in the window — the agent reported class-level
        spans only.
      </Typography>
    );
  }
  const maxShare =
    classTotalOwnMs > 0 ? Math.max(...methods.map((method) => method.ownMs / classTotalOwnMs)) : 0;

  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell sx={{ pl: 4 }}>Method</TableCell>
          <TableCell>Own time</TableCell>
          <TableCell align="right">Avg own / call</TableCell>
          <TableCell align="right">Total time</TableCell>
          <TableCell align="right">Calls</TableCell>
          <TableCell align="right">Errors</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {methods.map((method) => {
          const share = classTotalOwnMs > 0 ? method.ownMs / classTotalOwnMs : 0;
          return (
            <TableRow key={method.method}>
              <TableCell
                sx={{ pl: 4, fontFamily: fontMono, fontSize: 11.5, color: "text.secondary" }}
              >
                {method.method}
              </TableCell>
              <TableCell>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: "baseline" }}>
                  <Box sx={{ ...tabular, fontSize: 12 }}>{formatDuration(method.ownMs)}</Box>
                  <Typography sx={{ fontSize: 10, color: "text.disabled", ...tabular }}>
                    · {formatPercent(share, share < 0.1 ? 1 : 0)} of class
                  </Typography>
                  <Box sx={{ width: 44 }}>
                    <ShareBar share={share} maxShare={maxShare} height={3} />
                  </Box>
                </Stack>
              </TableCell>
              <TableCell align="right" sx={{ ...tabular, color: "text.secondary" }}>
                {formatDuration(method.avgOwnMs)}
              </TableCell>
              <TableCell align="right" sx={tabular}>
                {formatDuration(method.totalMs)}
              </TableCell>
              <TableCell align="right" sx={tabular}>
                {formatCount(method.calls)}
              </TableCell>
              <TableCell
                align="right"
                sx={{ ...tabular, color: method.errors > 0 ? colors.danger : "text.secondary" }}
              >
                {formatCount(method.errors)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Data shaping
// ---------------------------------------------------------------------------

function sortClasses(rows: ServiceClassRow[], sort: SortMode): ServiceClassRow[] {
  return [...rows].sort((a, b) => {
    if (sort === "class") {
      // Class name first, then application: under "All applications" the same
      // class name can legitimately appear twice and the tie must be stable.
      const byName = a.className.localeCompare(b.className);
      return byName !== 0 ? byName : a.applicationName.localeCompare(b.applicationName);
    }
    if (sort === "total") return b.totalMs - a.totalMs;
    return b.ownMs - a.ownMs;
  });
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

/**
 * The own-time bar. Its length is relative to the largest class in the list, not
 * to 100% — a page whose top class holds 38% would otherwise draw every bar at a
 * third of the track and look empty.
 */
function ShareBar({
  share,
  maxShare,
  height = 4,
}: {
  share: number;
  maxShare: number;
  height?: number;
}) {
  const filled = maxShare > 0 ? Math.min(share / maxShare, 1) : 0;
  return (
    <Box
      sx={{
        width: "100%",
        maxWidth: 180,
        height,
        borderRadius: 1,
        bgcolor: "rgba(255,255,255,0.07)",
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          width: `${filled * 100}%`,
          height: "100%",
          backgroundColor: colors.accent,
        }}
      />
    </Box>
  );
}

function Stat({
  label,
  value,
  aside,
  tone = "default",
}: {
  label: string;
  value: string;
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

function EmptyState({ scoped }: { scoped: boolean }) {
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
        No instrumented classes in this window.
      </Typography>
      <Typography sx={{ mt: 0.75, fontSize: 11.5, color: "text.disabled", maxWidth: 540, mx: "auto" }}>
        This table is built from span rows, so it fills in as soon as an
        instrumented call runs{scoped ? " in this service" : " anywhere in the project"} inside the
        selected window — a controller, a service or a repository the agent patched.
      </Typography>
    </Box>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
