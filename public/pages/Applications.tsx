/**
 * Applications — every service that has reported to this project.
 *
 * There is no registration step to show here: ingest auto-creates an
 * application the first time a batch carries a new `serviceId`, and the CLI link
 * flow creates one when it approves a code. So this page is the answer to
 * "what is actually reporting?", which is also why the number can look
 * surprising the first time a smoke batch lands: the count is rows in
 * `application`, not apps someone manually added.
 *
 * The columns are the ones this collector can answer honestly from
 * `rollup_minute` — requests, error rate, p95 and last-seen. CPU and memory are
 * per-instance runtime samples, not per-application aggregates, so they are not
 * invented here; the Runtime page shows them once an application is opened.
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
  Tooltip,
  Typography,
} from "@mui/material";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { PageHeader } from "../components/shell/PageHeader";
import { useLiveInterval } from "../components/shell";
import { formatCount, formatDuration, formatPercent, formatRelative, windowFor } from "../format";
import { colors, tabular } from "../theme";

export interface ApplicationsProps {
  range?: Parameters<typeof windowFor>[0];
  /** The shell's router: it keeps the range/search you already set. */
  navigate?: (to: string) => void;
}

export function Applications({ range = "1h", navigate: shellNavigate }: ApplicationsProps) {
  const router = useNavigate();
  const navigate = shellNavigate ?? router;
  const refetchInterval = useLiveInterval();
  const applications = useQuery({
    queryKey: ["applications", range],
    queryFn: () => api.applications(windowFor(range)),
    refetchInterval,
  });

  const rows = applications.data ?? [];

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Applications"
        description="Every service reporting to this project, with its traffic in the selected range."
        actions={
          <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
            {rows.length} application{rows.length === 1 ? "" : "s"}
          </Typography>
        }
      />

      {applications.isError && (
        <Alert severity="error">
          The application list could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {applications.error instanceof Error ? applications.error.message : String(applications.error)}
          </Box>
        </Alert>
      )}

      {applications.isLoading && <Skeleton variant="rounded" height={240} />}

      {!applications.isLoading && rows.length === 0 && !applications.isError && (
        <Paper sx={{ p: 3 }}>
          <Typography sx={{ fontWeight: 600, mb: 1 }}>Nothing is reporting yet.</Typography>
          <Typography sx={{ fontSize: 13, color: "text.secondary", maxWidth: 640 }}>
            Start a NestJS app with the SDK pointed at this collector. An application appears on the
            first accepted batch — no registration step. To issue a key pair, run{" "}
            <Box component="code" sx={{ fontFamily: "monospace", color: colors.accentText }}>
              npx @nestjs/observe link
            </Box>{" "}
            and approve the code at <strong>/link</strong>.
          </Typography>
        </Paper>
      )}

      {rows.length > 0 && (
        <Paper sx={{ overflow: "hidden" }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Application</TableCell>
                <TableCell align="right">Requests</TableCell>
                <TableCell align="right">Error rate</TableCell>
                <TableCell align="right">p95</TableCell>
                <TableCell>Last seen</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.id}
                  hover
                  sx={{ cursor: "pointer" }}
                  onClick={() => navigate(`/applications/${row.id}`)}
                >
                  <TableCell>
                    <Box sx={{ fontWeight: 600 }}>{row.name}</Box>
                    {row.name !== row.serviceId && (
                      <Box sx={{ fontSize: 11, color: "text.disabled" }}>{row.serviceId}</Box>
                    )}
                  </TableCell>
                  <TableCell align="right" sx={tabular}>
                    {formatCount(row.requests)}
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{
                      ...tabular,
                      color: row.errorRate > 0.01 ? colors.danger : "text.primary",
                    }}
                  >
                    {formatPercent(row.errorRate, 2)}
                  </TableCell>
                  <TableCell align="right" sx={tabular}>
                    {formatDuration(row.p95DurationMs)}
                  </TableCell>
                  <TableCell sx={{ color: "text.secondary" }}>
                    <Tooltip title={new Date(row.lastSeen).toLocaleString()}>
                      <Box component="span">{formatRelative(row.lastSeen)}</Box>
                    </Tooltip>
                  </TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      onClick={(event) => {
                        event.stopPropagation();
                        navigate(`/applications/${row.id}`);
                      }}
                    >
                      Open
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}

      {rows.length > 0 && (
        <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
          One row per `serviceId` the SDK reports. A zero-request row is an application that has
          reported before but not in this range — it is not deleted, because its history and
          objectives still exist.
        </Typography>
      )}
    </Stack>
  );
}
