/**
 * Releases — each version against the one before it.
 *
 * The question this page answers is not "what shipped" but "did shipping make it
 * worse". The collector judges that server-side (`/applications/:id/releases`):
 * a regression is the error rate up by more than one point, or p95 up by more
 * than 20%, against the previous release on the same window. The page renders
 * that verdict and, in the tooltip, the sentence it stands for —
 *
 *   2.9.0 looks like a regression — since 2.9.0 went out, the error rate moved
 *   from 1.5% to 12.7%.
 *
 * A row click hands the release to the executions list as a filter, because the
 * next move after "this release is bad" is always "show me its requests". The
 * shell may not consume `?release=` yet; the link is still the right link, and
 * it carries the **row's** application id: under "All applications" the list
 * holds every service's versions, and a release only means something inside the
 * application that shipped it.
 *
 * That is also why the verdict column is trustworthy unscoped: the collector
 * compares a release with the previous release of the *same* application, so
 * `1.0.0` of the gateway and `1.0.0` of the worker sit next to each other and are
 * still judged against their own predecessor.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Chip,
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
} from "@mui/material";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { api, type ReleaseRow } from "../api";
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatRelative,
  windowFor,
  type TimeRangeId,
} from "../format";
import { colors, fontMono, labelCaps, tabular } from "../theme";
import { PageHeader } from "../components/shell/PageHeader";
import { useLiveInterval, useShell } from "../components/shell";

export interface ReleasesProps {
  appId?: string;
  id?: string;
  range?: TimeRangeId;
}

export function Releases({ appId, id, range = "1h" }: ReleasesProps) {
  // The shell's `?app=` is the scope and it is empty under "All applications",
  // which is a view of its own, not a missing one — so there is no gate. The
  // legacy `/applications/:id/releases` path still names a concrete application,
  // so a bookmark of it keeps its scope instead of widening to the project.
  const scope = appId || id || "";
  return <ReleasesView scope={scope} range={range} />;
}

function ReleasesView({ scope, range }: { scope: string; range: TimeRangeId }) {
  const navigate = useNavigate();
  const refetchInterval = useLiveInterval();
  const { apps } = useShell();
  const unscoped = scope === "";
  const scopeName = unscoped
    ? null
    : (apps.find((entry) => entry.id === scope)?.name ?? null);

  const releases = useQuery({
    queryKey: ["releases", scope, range],
    queryFn: () => api.releases(scope, windowFor(range)),
    refetchInterval,
  });

  const rows = releases.data ?? [];
  const regressions = rows.filter((row) => row.regression !== null);
  const latest = rows[0];
  const applicationCount = new Set(rows.map((row) => row.applicationId)).size;
  // Addressed by the release's own application, never by the page's scope:
  // unscoped there is no scope, and a version number alone identifies nothing.
  const executionsFor = (applicationId: string, version: string) =>
    `/applications/${applicationId}/executions?release=${encodeURIComponent(version)}&range=${range}`;

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Releases"
        description={
          unscoped
            ? "Every release in the project, each compared with the previous release of its own application."
            : `${scopeName ?? "This application"} — each release compared against the 30 minutes of traffic before and after.`
        }
        actions={
          <Stack direction="row" spacing={1}>
            <Stat label="Releases" value={String(rows.length)} />
            {/* "Latest" is one service's answer; unscoped the useful count is
                how many services these versions belong to. */}
            {unscoped ? (
              <Stat label="Applications" value={String(applicationCount)} />
            ) : (
              <Stat label="Latest" value={latest?.version ?? "—"} />
            )}
            <Stat
              label="Regressions"
              value={String(regressions.length)}
              tone={regressions.length > 0 ? "danger" : "default"}
            />
          </Stack>
        }
      />

      {releases.isError && (
        <Alert severity="error">
          Releases could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {errorMessage(releases.error)}
          </Box>
        </Alert>
      )}

      {releases.isLoading && (
        <Paper sx={{ p: 2 }}>
          <Stack spacing={1.25}>
            {[0, 1, 2, 3, 4].map((index) => (
              <Skeleton key={index} variant="rounded" height={26} />
            ))}
          </Stack>
        </Paper>
      )}

      {!releases.isLoading && rows.length === 0 && !releases.isError && (
        <EmptyState
          title="No releases yet — a release appears the first time an execution reports a version."
          hint="The SDK sends the version it is running on with every batch, so no setup beyond the module registration is needed."
        />
      )}

      {rows.length > 0 && (
        <>
          <Paper sx={{ overflow: "hidden" }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {/* Only under "All applications": scoped to one service the
                      column repeats the page's own scope on every row. */}
                  {unscoped && <TableCell>Application</TableCell>}
                  <TableCell>Version</TableCell>
                  <TableCell>First seen</TableCell>
                  <TableCell align="right">Requests</TableCell>
                  <TableCell align="right">Error rate</TableCell>
                  <TableCell align="right">p95</TableCell>
                  <TableCell>Verdict</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => {
                  const href = executionsFor(row.applicationId, row.version);
                  return (
                    <TableRow
                      key={row.id}
                      hover
                      onClick={() => navigate(href)}
                      sx={{ cursor: "pointer" }}
                    >
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
                      <TableCell sx={{ width: "18%" }}>
                        <RouterLink
                          to={href}
                          onClick={(event) => event.stopPropagation()}
                          style={{ color: "inherit", textDecoration: "none", fontWeight: 600 }}
                        >
                          {row.version}
                        </RouterLink>
                      </TableCell>
                      <TableCell sx={{ color: "text.secondary" }}>
                        <Tooltip title={new Date(row.firstSeen).toLocaleString()}>
                          <Box component="span">{formatRelative(row.firstSeen)}</Box>
                        </Tooltip>
                      </TableCell>
                      <TableCell align="right" sx={tabular}>
                        {formatCount(row.requests)}
                      </TableCell>
                      <TableCell
                        align="right"
                        sx={{
                          ...tabular,
                          color: row.regression ? colors.danger : "text.primary",
                        }}
                      >
                        {formatPercent(row.errorRate, 2)}
                      </TableCell>
                      <TableCell align="right" sx={tabular}>
                        {formatDuration(row.p95Ms)}
                      </TableCell>
                      <TableCell>
                        {row.regression ? (
                          <Tooltip
                            title={regressionCallout(
                              row,
                              // Unscoped, a bare "1.0.0" would sit next to
                              // three other services' 1.0.0 rows.
                              unscoped ? row.applicationName : null,
                            )}
                          >
                            <Chip
                              label={verdictLabel(row)}
                              size="small"
                              sx={{
                                color: colors.danger,
                                borderColor: `${colors.danger}55`,
                                cursor: "help",
                              }}
                              variant="outlined"
                            />
                          </Tooltip>
                        ) : (
                          <Typography sx={{ fontSize: 11, color: "text.disabled" }}>—</Typography>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Paper>
          <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
            Windows compare the traffic either side of a version's first appearance. Rolling deploys
            keep both versions serving during the after-window, so numbers describe what users
            experienced, diluted across versions — a rolled-back and re-deployed version keeps its
            original boundary and is not detected again.
            {unscoped
              ? " Each verdict still compares against the previous release of the same application, never against the row above it in this table."
              : ""}
          </Typography>
        </>
      )}
    </Stack>
  );
}

/**
 * Their callout, built from the verdict.
 *
 * `errorRateDelta` is a difference of ratios between adjacent releases, so the
 * "before" is `after - delta` — no extra request needed. A latency-driven
 * regression carries the p95 percentage instead, and says so.
 */
function regressionCallout(row: ReleaseRow, applicationName: string | null): string {
  const regression = row.regression;
  if (!regression) return "";
  const subject = applicationName ? `${applicationName} ${row.version}` : row.version;
  if (regression.errorRateDelta > 0.01) {
    const before = row.errorRate - regression.errorRateDelta;
    return `${subject} looks like a regression — since ${row.version} went out, the error rate moved from ${formatPercent(before, 1)} to ${formatPercent(row.errorRate, 1)}.`;
  }
  const beforeP95 =
    regression.latencyDelta > -1 ? row.p95Ms / (1 + regression.latencyDelta) : null;
  return `${subject} looks like a regression — since ${row.version} went out, p95 latency moved from ${formatDuration(beforeP95)} to ${formatDuration(row.p95Ms)} (${signedPercent(regression.latencyDelta)}).`;
}

function verdictLabel(row: ReleaseRow): string {
  const regression = row.regression;
  if (!regression) return "Stable";
  return regression.errorRateDelta > 0.01 ? "Regression" : "Slower";
}

function signedPercent(ratio: number): string {
  const value = ratio * 100;
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Page furniture. The heading is the shell's; the rest is local to this page.
// ---------------------------------------------------------------------------

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "danger";
}) {
  return (
    <Box
      sx={{ border: `1px solid ${colors.border}`, borderRadius: 1, px: 1.5, py: 0.75, minWidth: 74 }}
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
