/**
 * Users — who the traffic belongs to, once the app says so.
 *
 * The identifier is whatever `http.getUserId` (or the RPC/GraphQL equivalent)
 * returned. The collector treats it as an opaque string and never resolves it to
 * a name, so the only grouping available here is the one that needs no
 * instrumenting: in a B2B product identity is a work email, and the domain behind
 * it is the account. "Group by customer" reads the same rows one level up.
 *
 * Non-email identities are not hidden — an `anonymous` bucket and internal ids
 * are real — but they are not accounts either, so they are excluded from the
 * customer rows and counted in the caption instead of being silently dropped.
 * Totals reconcile with the people view either way.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Box,
  InputAdornment,
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
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { api, type UserRow } from "../api";
import { formatCount, formatDuration, formatPercent, formatRelative, windowFor, type TimeRangeId } from "../format";
import { colors, tabular } from "../theme";
import { PageHeader } from "../components/shell/PageHeader";
import { useLiveInterval } from "../components/shell";

export interface UsersProps {
  appId?: string;
  id?: string;
  range?: TimeRangeId;
}

type View = "people" | "customers";

export function Users({ appId, id, range = "1h" }: UsersProps) {
  // `appId` is the shell's scope and is empty under "All applications"; the
  // route param is still a concrete application, so fall back to it.
  const applicationId = appId || id;
  if (!applicationId) {
    return (
      <Stack spacing={3}>
        <PageHeader
          title="Users"
          description="An overview of users interacting with your project."
        />
        <EmptyState
          title="Pick an application first."
          hint="Users are per application, because the identifier means whatever that service says it means. Use the application switcher in the top bar."
        />
      </Stack>
    );
  }
  return <UsersForApplication appId={applicationId} range={range} />;
}

function UsersForApplication({ appId, range }: { appId: string; range: TimeRangeId }) {
  const [view, setView] = useState<View>("people");
  const [search, setSearch] = useState("");

  const refetchInterval = useLiveInterval();
  const users = useQuery({
    queryKey: ["users", appId, range],
    queryFn: () => api.users(appId, windowFor(range)),
    refetchInterval,
  });

  const rows = users.data ?? [];
  const needle = search.trim().toLowerCase();
  const filtered = useMemo(
    () => rows.filter((row) => needle === "" || row.userId.toLowerCase().includes(needle)),
    [rows, needle],
  );

  const customers = useMemo(() => groupByDomain(rows), [rows]);
  const filteredCustomers = useMemo(
    () => customers.rows.filter((row) => needle === "" || row.domain.includes(needle)),
    [customers, needle],
  );

  const totals = rows.reduce(
    (acc, row) => ({ requests: acc.requests + row.requests, errors: acc.errors + row.errors }),
    { requests: 0, errors: 0 },
  );

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Users"
        description="An overview of users interacting with your project."
        actions={
          <ToggleButtonGroup
            exclusive
            size="small"
            value={view}
            onChange={(_event, next: View | null) => {
              if (next) setView(next);
            }}
            aria-label="Group users by"
          >
            <ToggleButton value="people">People</ToggleButton>
            <ToggleButton value="customers">Customers</ToggleButton>
          </ToggleButtonGroup>
        }
      />

      {users.isError && (
        <Alert severity="error">
          Users could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {errorMessage(users.error)}
          </Box>
        </Alert>
      )}

      {users.isLoading && (
        <Paper sx={{ p: 2 }}>
          <Stack spacing={1.25}>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <Skeleton key={index} variant="rounded" height={24} />
            ))}
          </Stack>
        </Paper>
      )}

      {!users.isLoading && rows.length === 0 && !users.isError && (
        <EmptyState
          title="No users found — your agent isn't reporting who your users are."
          hint="Return an identifier from http.getUserId (or the RPC/GraphQL equivalent) in the Observe module options and the next request will carry it. Requests without one still appear under Requests; they just cannot appear here."
        />
      )}

      {rows.length > 0 && (
        <>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", flexWrap: "wrap" }}>
            <TextField
              size="small"
              placeholder="Search users…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              sx={{ width: 280 }}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <MagnifyingGlass size={13} color={colors.faint} />
                    </InputAdornment>
                  ),
                },
              }}
            />
            <Typography sx={{ fontSize: 11, color: "text.disabled", ...tabular }}>
              {formatCount(rows.length)} identities · {formatCount(totals.requests)} requests ·{" "}
              {formatPercent(totals.requests > 0 ? totals.errors / totals.requests : 0, 1)} error rate
            </Typography>
          </Stack>

          <Paper sx={{ overflow: "hidden" }}>
            {view === "people" ? (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>User</TableCell>
                    <TableCell align="right">Requests</TableCell>
                    <TableCell align="right">Error rate</TableCell>
                    <TableCell align="right">Avg duration</TableCell>
                    <TableCell align="right">Last seen</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} sx={{ py: 4, textAlign: "center", color: "text.secondary" }}>
                        No user matches “{search.trim()}”.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filtered.map((row) => <PersonRow key={row.userId} row={row} />)
                  )}
                </TableBody>
              </Table>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Customer</TableCell>
                    <TableCell align="right">People</TableCell>
                    <TableCell align="right">Requests</TableCell>
                    <TableCell align="right">Error rate</TableCell>
                    <TableCell align="right">Avg duration</TableCell>
                    <TableCell align="right">Last seen</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filteredCustomers.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} sx={{ py: 4, textAlign: "center", color: "text.secondary" }}>
                        {search.trim()
                          ? `No customer matches “${search.trim()}”.`
                          : "No email-shaped user ids in this window — there is nothing to group into accounts yet."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredCustomers.map((row) => (
                      <TableRow key={row.domain}>
                        <TableCell sx={{ fontWeight: 500 }}>{row.domain}</TableCell>
                        <TableCell align="right" sx={tabular}>
                          {formatCount(row.people)}
                        </TableCell>
                        <TableCell align="right" sx={tabular}>
                          {formatCount(row.requests)}
                        </TableCell>
                        <TableCell align="right" sx={tabular}>
                          {formatPercent(row.errorRate, 2)}
                        </TableCell>
                        <TableCell align="right" sx={tabular}>
                          {formatDuration(row.avgMs)}
                        </TableCell>
                        <TableCell align="right" sx={{ color: "text.secondary" }}>
                          {formatRelative(row.lastSeen)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </Paper>

          {view === "customers" && (
            <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
              {formatCount(customers.rows.length)} customer accounts ·{" "}
              {formatCount(customers.people)} people grouped ·{" "}
              {formatCount(customers.ungrouped)} identities without an email domain (anonymous,
              internal ids) are counted in the totals above but are not accounts.
            </Typography>
          )}
        </>
      )}
    </Stack>
  );
}

function PersonRow({ row }: { row: UserRow }) {
  const suspicious = row.userId === "anonymous" || !looksLikeEmail(row.userId);
  return (
    <TableRow>
      <TableCell>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography sx={{ fontFamily: "inherit", fontSize: 12.5 }}>
            {row.userId}
          </Typography>
          {suspicious && (
            <Tooltip title="Not an email-shaped id: this identity cannot be grouped into a customer account.">
              <Typography sx={{ fontSize: 10, color: "text.disabled", cursor: "help" }}>
                ungrouped
              </Typography>
            </Tooltip>
          )}
        </Stack>
      </TableCell>
      <TableCell align="right" sx={tabular}>
        {formatCount(row.requests)}
      </TableCell>
      <TableCell
        align="right"
        sx={{ ...tabular, color: row.errorRate > 0.05 ? colors.danger : "text.primary" }}
      >
        {formatPercent(row.errorRate, 2)}
      </TableCell>
      <TableCell align="right" sx={tabular}>
        {formatDuration(row.avgMs)}
      </TableCell>
      <TableCell align="right" sx={{ color: "text.secondary", whiteSpace: "nowrap" }}>
        <Tooltip title={new Date(row.lastSeen).toLocaleString()}>
          <Box component="span">{formatRelative(row.lastSeen)}</Box>
        </Tooltip>
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// The customer heuristic
// ---------------------------------------------------------------------------

interface CustomerRow {
  domain: string;
  people: number;
  requests: number;
  errors: number;
  errorRate: number;
  /** Request-weighted, the same way the operation page averages durations. */
  avgMs: number;
  lastSeen: number;
}

const EMAIL = /^[^\s@]+@([^\s@]+\.[^\s@]{2,})$/;

function looksLikeEmail(id: string): boolean {
  return EMAIL.test(id);
}

/**
 * Group users by the domain of their email-shaped id.
 *
 * Only the part after the `@` matters; subdomains are left alone because
 * `eu.acme.com` and `acme.com` may genuinely be separate tenants, and merging
 * them would be a guess the page cannot show.
 */
function groupByDomain(rows: UserRow[]): {
  rows: CustomerRow[];
  people: number;
  ungrouped: number;
} {
  const map = new Map<string, { row: CustomerRow; weightedMs: number }>();
  let people = 0;
  let ungrouped = 0;

  for (const row of rows) {
    const match = EMAIL.exec(row.userId);
    const domain = match?.[1]?.toLowerCase();
    if (!domain) {
      ungrouped += 1;
      continue;
    }
    people += 1;
    const entry = map.get(domain) ?? {
      row: {
        domain,
        people: 0,
        requests: 0,
        errors: 0,
        errorRate: 0,
        avgMs: 0,
        lastSeen: 0,
      },
      weightedMs: 0,
    };
    entry.row.people += 1;
    entry.row.requests += row.requests;
    entry.row.errors += row.errors;
    entry.row.lastSeen = Math.max(entry.row.lastSeen, row.lastSeen);
    entry.weightedMs += row.avgMs * row.requests;
    map.set(domain, entry);
  }

  const grouped = [...map.values()]
    .map(({ row, weightedMs }) => ({
      ...row,
      errorRate: row.requests > 0 ? row.errors / row.requests : 0,
      avgMs: row.requests > 0 ? weightedMs / row.requests : 0,
    }))
    .sort((a, b) => b.requests - a.requests);

  return { rows: grouped, people, ungrouped };
}

// ---------------------------------------------------------------------------
// Page furniture. The heading is the shell's; the rest is local to this page.
// ---------------------------------------------------------------------------

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
        <Typography sx={{ mt: 0.75, fontSize: 11.5, color: "text.disabled", maxWidth: 560, mx: "auto" }}>
          {hint}
        </Typography>
      )}
    </Box>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
