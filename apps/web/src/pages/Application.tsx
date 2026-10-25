import {
  Box,
  Chip,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { CaretDown, CaretUp } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { api, type RankedOperation } from "../api";
import { ContentCard } from "../components/cards/MetricCard";
import { PageHeader } from "../components/shell/PageHeader";
import { useLive, useShell } from "../components/shell/ShellContext";
import {
  formatCount,
  formatDuration,
  formatPercent,
  previousWindowFor,
  windowFor,
  type TimeRangeId,
} from "../format";
import { colors } from "../theme";
import { DurationCard, RequestsCard, mergeSeries } from "./Overview";

/**
 * One application.
 *
 * The operations table is the centre of gravity — it answers "what is this
 * service doing, and what is slow" — and the two cards above it are the project
 * dashboard's Requests and Duration cards scoped to this application, because the
 * reference repeats exactly those two on every per-application screen.
 *
 * Sorting is client-side. The server already returns every operation it has for
 * the window (capped at its own limit), so a round trip per header click would buy
 * nothing but latency.
 */
type SortKey = "count" | "errors" | "p95";

export function Application({
  appId: propAppId,
  range: propRange,
}: {
  appId?: string;
  range?: TimeRangeId;
} = {}) {
  const shell = useShell();
  const { interval } = useLive();
  // Three sources, in order of authority: the shell may pass the id, the route
  // carries it at `/applications/:id`, and the app switcher's `?app=` is the
  // fallback that "All applications" leaves empty.
  const params = useParams<{ id?: string }>();
  const appId = propAppId ?? params.id ?? shell.appId;
  const range = propRange ?? shell.range;
  const window = windowFor(range);
  const previous = previousWindowFor(range);

  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "count", desc: true });

  const enabled = Boolean(appId);
  const applications = useQuery({
    queryKey: ["applications", range],
    queryFn: () => api.applications(window),
    refetchInterval: interval,
  });
  const application = applications.data?.find((entry) => entry.id === appId);

  const operations = useQuery({
    queryKey: ["operations", appId, range],
    queryFn: () => api.operations(appId, window),
    enabled,
    refetchInterval: interval,
  });

  const current = useQuery({
    queryKey: ["timeseries", appId, range, "current"],
    queryFn: () => api.timeseries(appId, window),
    enabled,
    refetchInterval: interval,
  });
  const before = useQuery({
    queryKey: ["timeseries", appId, range, "previous"],
    queryFn: () => api.timeseries(appId, previous),
    enabled,
    refetchInterval: interval,
  });

  if (!appId) {
    return (
      <Box>
        <PageHeader
          title="Application"
          description="Operations ranked by volume, with the slowest and busiest endpoints called out."
        />
        <ContentCard
          label="No application selected"
          empty
          emptyMessage="Pick an application in the top bar. This page is one service's traffic: its operations, its latency and its throughput."
        >
          {null}
        </ContentCard>
      </Box>
    );
  }

  const rows = operations.data ?? [];
  const ordered = sortOperations(rows, sort);
  const bucketMs = current.data?.bucketMs ?? 60_000;
  const points = mergeSeries([current]);
  const previousPoints = mergeSeries([before]);

  return (
    <Box>
      <PageHeader
        title={application?.name ?? "Application"}
        description={
          application
            ? `${application.serviceId} — operations in this window, ranked by volume.`
            : "Operations in this window, ranked by volume."
        }
      />

      <Box
        sx={{
          display: "grid",
          gap: 2,
          gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
          mb: 2,
        }}
      >
        <RequestsCard
          points={points}
          previousPoints={previousPoints}
          window={window}
          loading={current.isLoading}
          error={current.error}
        />
        <DurationCard
          points={points}
          previousPoints={previousPoints}
          bucketMs={bucketMs}
          window={window}
          loading={current.isLoading}
          error={current.error}
        />
      </Box>

      <ContentCard
        label="Operations"
        loading={operations.isLoading}
        error={operations.error}
        empty={!operations.isLoading && rows.length === 0}
        emptyMessage="No operations in this window. Serve a request from this application and its routes appear here."
        bodySx={{ px: 0, pb: 0 }}
        actions={
          <Typography sx={{ fontSize: 10, color: "text.disabled" }}>
            sorted by {sort.key === "p95" ? "p95" : sort.key} {sort.desc ? "descending" : "ascending"}
          </Typography>
        }
      >
        <TableContainer sx={{ maxHeight: 520 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <HeaderCell>Operation</HeaderCell>
                <HeaderCell width={72}>Kind</HeaderCell>
                <HeaderCell
                  align="right"
                  sortKey="count"
                  sort={sort}
                  onSort={setSort}
                >
                  Calls
                </HeaderCell>
                <HeaderCell
                  align="right"
                  sortKey="errors"
                  sort={sort}
                  onSort={setSort}
                >
                  Errors
                </HeaderCell>
                <HeaderCell align="right">Avg</HeaderCell>
                <HeaderCell align="right" sortKey="p95" sort={sort} onSort={setSort}>
                  p95
                </HeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {ordered.map((operation) => (
                <TableRow
                  key={`${operation.operationRowId}-${operation.kind}`}
                  hover
                  tabIndex={0}
                  onClick={() =>
                    shell.navigate(
                      withRange(
                        `/applications/${appId}/executions?operationRowId=${operation.operationRowId}`,
                        range,
                      ),
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter")
                      shell.navigate(
                        withRange(
                          `/applications/${appId}/executions?operationRowId=${operation.operationRowId}`,
                          range,
                        ),
                      );
                  }}
                  sx={{ cursor: "pointer" }}
                >
                  <TableCell>
                    <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
                      <MethodChip method={operation.method} kind={operation.kind} />
                      <Typography
                        sx={{
                          fontFamily: "monospace",
                          fontSize: 11.5,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {operation.customName ?? operation.operationId ?? "—"}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Typography sx={{ fontSize: 10, color: "text.disabled" }}>
                      {operation.kind}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Numeric>{formatCount(operation.count)}</Numeric>
                  </TableCell>
                  <TableCell align="right">
                    <Numeric tone={operation.errors > 0 ? "bad" : "muted"}>
                      {formatCount(operation.errors)}
                    </Numeric>
                  </TableCell>
                  <TableCell align="right">
                    <Numeric tone="muted">{formatDuration(operation.avgDurationMs)}</Numeric>
                  </TableCell>
                  <TableCell align="right">
                    <Numeric>{formatDuration(operation.p95DurationMs)}</Numeric>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </ContentCard>

      <Box
        sx={{
          display: "grid",
          gap: 2,
          gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
          mt: 2,
        }}
      >
        <ContentCard
          label="Performance outliers"
          loading={operations.isLoading}
          empty={!operations.isLoading && rows.length === 0}
          emptyMessage="Nothing ranked yet."
          actions={<Typography sx={{ fontSize: 10, color: "text.disabled" }}>p95</Typography>}
        >
          <OperationList
            rows={topBy(rows, (row) => row.p95DurationMs ?? 0)}
            value={(row) => formatDuration(row.p95DurationMs)}
            share={rows.reduce((sum, row) => sum + row.count, 0)}
          />
        </ContentCard>

        <ContentCard
          label="High throughput"
          loading={operations.isLoading}
          empty={!operations.isLoading && rows.length === 0}
          emptyMessage="Nothing ranked yet."
          actions={<Typography sx={{ fontSize: 10, color: "text.disabled" }}>calls</Typography>}
        >
          <OperationList
            rows={topBy(rows, (row) => row.count)}
            value={(row) => formatCount(row.count)}
            share={rows.reduce((sum, row) => sum + row.count, 0)}
          />
        </ContentCard>
      </Box>
    </Box>
  );
}

function OperationList({
  rows,
  value,
  share,
}: {
  rows: ReadonlyArray<RankedOperation>;
  value: (row: RankedOperation) => string;
  share: number;
}) {
  return (
    <Stack spacing={0.25} sx={{ mt: -0.5 }}>
      {rows.map((row) => (
        <Stack
          key={`${row.operationRowId}-${row.kind}`}
          direction="row"
          spacing={1}
          sx={{ py: 0.6, alignItems: "center" }}
        >
          <MethodChip method={row.method} kind={row.kind} />
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography
              sx={{
                fontFamily: "monospace",
                fontSize: 11.5,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={row.customName ?? row.operationId ?? undefined}
            >
              {row.customName ?? row.operationId ?? "—"}
            </Typography>
            <Typography sx={{ fontSize: 10, color: "text.disabled" }}>
              {formatPercent(share > 0 ? row.count / share : 0, 0)} of calls
            </Typography>
          </Box>
          <Typography sx={{ fontSize: 11.5, fontVariantNumeric: "tabular-nums" }}>
            {value(row)}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

function MethodChip({ method, kind }: { method: string | null; kind: "request" | "job" }) {
  const label = method ?? (kind === "job" ? "JOB" : "—");
  const tint =
    label === "GET"
      ? colors.ok
      : label === "POST"
        ? colors.warn
        : label === "DELETE"
          ? colors.danger
          : colors.muted;
  return (
    <Chip
      label={label}
      size="small"
      sx={{
        height: 17,
        minWidth: 34,
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: "0.04em",
        color: tint,
        bgcolor: `${tint}22`,
        "& .MuiChip-label": { px: 0.6 },
      }}
    />
  );
}

function HeaderCell({
  children,
  align = "left",
  width,
  sortKey,
  sort,
  onSort,
}: {
  children: ReactNode;
  align?: "left" | "right";
  width?: number;
  sortKey?: SortKey;
  sort?: { key: SortKey; desc: boolean };
  onSort?: (next: { key: SortKey; desc: boolean }) => void;
}) {
  const active = sortKey !== undefined && sort?.key === sortKey;
  return (
    <TableCell
      align={align}
      sx={{
        width,
        bgcolor: colors.surface,
        borderBottom: `1px solid ${colors.border}`,
        py: 0.75,
        cursor: sortKey ? "pointer" : "default",
        userSelect: "none",
      }}
      onClick={() => {
        if (!sortKey || !sort || !onSort) return;
        onSort({ key: sortKey, desc: active ? !sort.desc : true });
      }}
      aria-sort={active ? (sort?.desc ? "descending" : "ascending") : "none"}
    >
      <Stack
        direction="row"
        spacing={0.4}
        sx={{
          alignItems: "center",
          justifyContent: align === "right" ? "flex-end" : "flex-start",
        }}
      >
        <Typography
          sx={{
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: "0.09em",
            textTransform: "uppercase",
            color: active ? "text.secondary" : "text.disabled",
          }}
        >
          {children}
        </Typography>
        {active &&
          (sort?.desc ? (
            <CaretDown size={9} weight="fill" color={colors.muted} />
          ) : (
            <CaretUp size={9} weight="fill" color={colors.muted} />
          ))}
      </Stack>
    </TableCell>
  );
}

function Numeric({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "muted" | "bad";
}) {
  return (
    <Typography
      component="span"
      sx={{
        fontSize: 11.5,
        fontVariantNumeric: "tabular-nums",
        color: tone === "bad" ? "error.main" : tone === "muted" ? "text.disabled" : "text.primary",
      }}
    >
      {children}
    </Typography>
  );
}

/** The shell's router replaces the query string, so the window travels with the link. */
function withRange(path: string, range: TimeRangeId): string {
  return `${path}${path.includes("?") ? "&" : "?"}range=${range}`;
}

function sortOperations(
  rows: ReadonlyArray<RankedOperation>,
  sort: { key: SortKey; desc: boolean },
): RankedOperation[] {
  const pick = (row: RankedOperation): number =>
    sort.key === "count" ? row.count : sort.key === "errors" ? row.errors : (row.p95DurationMs ?? 0);
  return [...rows].sort((a, b) => (sort.desc ? pick(b) - pick(a) : pick(a) - pick(b)));
}

function topBy(
  rows: ReadonlyArray<RankedOperation>,
  score: (row: RankedOperation) => number,
): RankedOperation[] {
  return [...rows]
    .filter((row) => score(row) > 0)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 5);
}
