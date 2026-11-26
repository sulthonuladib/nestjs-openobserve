/**
 * SLOs — objectives over telemetry, with the error budget and burn rate.
 *
 * "Error budget" here is the reliability sense, not a billing one: a target of
 * 99.9% allows `0.1%` of the window's events to fail. Nothing on this page is
 * metered, capped or tied to a plan — self-hosted means the objective is a
 * promise to yourself, not an entitlement.
 *
 * The page is deliberately a list of cards rather than a table: an SLO is read
 * as three numbers at once (the SLI, what is left of the budget, and how fast it
 * is going), and a table makes the reader assemble those from three columns.
 *
 * Under "All applications" the list is every objective in the project, and each
 * card names the application it measures: the collector evaluates an objective
 * against **its own** application's traffic, so a project-wide card is never a
 * project-wide number.
 *
 * Creating one still needs an application, because the write is addressed by
 * application (`/applications/:id/slos`) — that is the API, not an opinion. So
 * unscoped, the dialog asks which application before it can send anything;
 * scoped, the page's scope is already the answer and the dialog says so.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { Plus } from "@phosphor-icons/react";
import { useState } from "react";
import { api, type SloRow } from "../api";
import { PageHeader } from "../components/shell/PageHeader";
import { useLiveInterval, useShell } from "../components/shell";
import { formatCount } from "../format";
import { colors, fontMono, tabular } from "../theme";

export interface SlosProps {
  appId?: string;
  id?: string;
}

export function Slos({ appId, id }: SlosProps) {
  // The shell's `?app=` is the scope and it is empty under "All applications",
  // which is a view of its own, not a missing one — so there is no gate. The
  // legacy `/applications/:id/slos` path still names a concrete application, so
  // a bookmark of it keeps its scope instead of widening to the project.
  const scope = appId || id || "";
  return <SlosView scope={scope} />;
}

function SlosView({ scope }: { scope: string }) {
  const client = useQueryClient();
  const refetchInterval = useLiveInterval();
  const { apps } = useShell();
  const unscoped = scope === "";
  const scopeName = unscoped
    ? null
    : (apps.find((entry) => entry.id === scope)?.name ?? null);
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const slos = useQuery({
    queryKey: ["slos", scope],
    queryFn: () => api.slos(scope),
    refetchInterval,
  });

  const remove = useMutation({
    // The row's own application, not the page's scope: unscoped there is no
    // scope, and a delete sent to the wrong id would 404 — or worse, if the ids
    // ever lined up, remove somebody else's objective.
    mutationFn: (row: SloRow) => api.deleteSlo(row.applicationId, row.id),
    onSuccess: () => {
      setFailure(null);
      void client.invalidateQueries({ queryKey: ["slos", scope] });
    },
    onError: (error) => setFailure(errorMessage(error)),
  });

  const rows = slos.data?.items ?? [];
  const breached = rows.filter((row) => row.state === "breached").length;
  const atRisk = rows.filter((row) => row.state === "at-risk").length;
  const noData = rows.filter((row) => row.state === "no-data").length;

  return (
    <Stack spacing={3}>
      <PageHeader
        title="SLOs"
        description={
          unscoped
            ? "Every objective in the project, each measured against its own application's traffic. An error budget is the share of events a target lets you fail."
            : `${scopeName ?? "This application"} — objectives measured against the traffic in the window. An error budget is the share of events a target lets you fail.`
        }
        actions={
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Stat label="Objectives" value={String(rows.length)} />
            <Stat
              label="Breached"
              value={String(breached)}
              tone={breached > 0 ? "danger" : "default"}
            />
            {noData > 0 && <Stat label="No data" value={String(noData)} />}
            <Button
              size="small"
              variant="contained"
              startIcon={<Plus size={14} weight="bold" />}
              onClick={() => setCreating(true)}
            >
              New SLO
            </Button>
          </Stack>
        }
      />

      {slos.isError && (
        <Alert severity="error">
          The SLO list could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {errorMessage(slos.error)}
          </Box>
        </Alert>
      )}

      {failure && (
        <Alert severity="warning" onClose={() => setFailure(null)}>
          {failure}
        </Alert>
      )}

      {slos.data && slos.data.retentionDays > 0 && (
        <Alert severity="info">
          Retention is <strong>{slos.data.retentionDays} days</strong>, which is the ceiling on any
          compliance window. A 28-day objective on a shorter store is measured over the days you
          actually keep, and the card says so.
        </Alert>
      )}

      {slos.isLoading && (
        <Stack spacing={2}>
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} variant="rounded" height={150} />
          ))}
        </Stack>
      )}

      {!slos.isLoading && rows.length === 0 && !slos.isError && (
        <Paper sx={{ p: 3 }}>
          <Typography sx={{ fontWeight: 600, mb: 1 }}>No objectives yet.</Typography>
          <Typography sx={{ fontSize: 13, color: "text.secondary", maxWidth: 640 }}>
            Declare one in code with{" "}
            <Box component="code" sx={{ fontFamily: "monospace", color: colors.accentText }}>
              @Objective({"{ availability: 99.9 }"})
            </Box>{" "}
            on a route, or create one here. A failed deployment is not a metric until it has a
            target and a window.
          </Typography>
        </Paper>
      )}

      <Stack spacing={2}>
        {rows.map((row) => (
          <SloCard
            key={row.id}
            row={row}
            // Unscoped, the card says which service it measures: the same
            // `availability 99.9` exists once per application.
            applicationName={unscoped ? row.applicationName : null}
            onDelete={row.source === "dashboard" ? () => remove.mutate(row) : undefined}
          />
        ))}
      </Stack>

      {atRisk > 0 && (
        <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
          {atRisk} objective{atRisk === 1 ? "" : "s"} burning faster than the window can afford —
          see the 6-hour burn rate. A rate of 1× spends the budget exactly on schedule; 14.4× would
          consume a 28-day budget in about two days.
        </Typography>
      )}

      <CreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        // Unscoped there is no application to post to, so the dialog offers the
        // shell's own list instead of sending the reader to another page to pick
        // one and come back.
        applications={unscoped ? apps : []}
        defaultApplicationId={unscoped ? "" : scope}
        lockedApplicationName={unscoped ? null : (scopeName ?? scope)}
        onSubmit={async (targetAppId, input) => {
          await api.createSlo(targetAppId, input);
          setFailure(null);
          setCreating(false);
          // Both keys: the project list, and that application's own list, which
          // is what its page reads after navigating there.
          await client.invalidateQueries({ queryKey: ["slos"] });
        }}
        onFailure={(message) => setFailure(message)}
      />
    </Stack>
  );
}

function SloCard({
  row,
  applicationName,
  onDelete,
}: {
  row: SloRow;
  /** Only under "All applications": scoped, it repeats the page's own scope. */
  applicationName: string | null;
  onDelete?: () => void;
}) {
  const scope = row.operationId === "*" ? "every operation" : row.operationId;
  const sentence =
    row.kind === "latency"
      ? `${percent(row.target)} of requests to ${scope} under ${row.underMs ?? "—"}ms`
      : row.kind === "job"
        ? `${percent(row.target)} of ${scope === "every operation" ? "jobs" : scope} succeed`
        : `${percent(row.target)} of requests to ${scope} succeed`;
  const budget = row.budget;
  const barValue =
    row.state === "no-data" ? 0 : budget.overBudget ? 100 : (budget.remainingFraction ?? 0) * 100;

  return (
    <Paper sx={{ p: 2.5 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap", mb: 0.5 }}>
        {applicationName && (
          <Typography
            sx={{ fontFamily: fontMono, fontSize: 10.5, color: "text.disabled", mr: 0.5 }}
            title={`Objectives on this page are evaluated against ${applicationName}'s own traffic.`}
          >
            {applicationName}
          </Typography>
        )}
        <Typography sx={{ fontWeight: 600, fontSize: 15 }}>
          {row.name ??
            (row.operationId === "*"
              ? `${kindLabel(row.kind)} · whole application`
              : kindLabel(row.kind))}
        </Typography>
        <Chip size="small" variant="outlined" label={kindLabel(row.kind)} />
        {row.source === "code" && (
          <Tooltip title={`Declared by @Objective() on ${row.handler ?? "a handler"}. The code owns it; edit the decorator and deploy.`}>
            <Chip size="small" variant="outlined" label="in code" sx={{ cursor: "help" }} />
          </Tooltip>
        )}
        {row.limitedByRetention && (
          <Tooltip
            title={`The ${row.windowDays}-day window is longer than the ${row.effectiveWindowDays}-day retention, so it is measured over the days that still exist.`}
          >
            <Chip
              size="small"
              variant="outlined"
              label={`clipped to ${row.effectiveWindowDays}d`}
              sx={{ color: colors.warn, borderColor: `${colors.warn}66`, cursor: "help" }}
            />
          </Tooltip>
        )}
        <Box sx={{ ml: "auto", display: "flex", alignItems: "center", gap: 1 }}>
          <StateChip state={row.state} />
          {onDelete && (
            <Button size="small" color="inherit" sx={{ minWidth: 0, px: 0.75, fontSize: 11 }} onClick={onDelete}>
              Delete
            </Button>
          )}
        </Box>
      </Stack>

      <Typography sx={{ fontSize: 12, color: "text.secondary", mb: 2 }}>
        {sentence}, rolling {row.effectiveWindowDays} days
        {row.method ? ` · ${row.method}` : ""}
      </Typography>

      <Box
        sx={{
          display: "grid",
          gap: 2,
          gridTemplateColumns: { xs: "1fr", md: "1.1fr 1.4fr 1fr" },
          alignItems: "center",
        }}
      >
        <Box>
          <Label>Current SLI</Label>
          <Typography sx={{ fontSize: 22, fontWeight: 600, ...tabular }}>
            {row.sli.value === null ? "—" : percent(row.sli.value * 100, 3)}
          </Typography>
          <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
            {row.sli.value === null
              ? "no traffic in this window"
              : `${formatCount(row.sli.good)} of ${formatCount(row.sli.total)} good`}
          </Typography>
        </Box>

        <Box>
          <Label>Error budget</Label>
          <LinearProgress
            variant="determinate"
            value={Math.max(0, Math.min(100, barValue))}
            color={budget.overBudget ? "error" : row.state === "at-risk" ? "warning" : "success"}
            sx={{ height: 6, borderRadius: 3, my: 0.75, bgcolor: colors.surfaceHover }}
          />
          <Typography sx={{ fontSize: 11, color: budget.overBudget ? colors.danger : "text.secondary" }}>
            {row.state === "no-data"
              ? "No budget burned — nothing to measure is not a failure."
              : budget.overBudget
                ? `Over budget by ${formatCount(-budget.remaining)} events`
                : `${percent((budget.remainingFraction ?? 0) * 100)} of ${formatCount(budget.allowedBad)} allowed failures left`}
          </Typography>
        </Box>

        <Box>
          <Label>Burn rate</Label>
          <Stack direction="row" spacing={1.5} sx={{ mt: 0.5 }}>
            {row.burn
              .filter((window) => window.key !== "3d")
              .map((window) => (
                <Box key={window.key}>
                  <Typography sx={{ fontSize: 10, color: "text.disabled" }}>{window.key}</Typography>
                  <Typography
                    sx={{
                      fontSize: 13,
                      fontWeight: 600,
                      ...tabular,
                      color:
                        window.rate === null
                          ? "text.disabled"
                          : window.rate > 1
                            ? colors.danger
                            : "text.primary",
                    }}
                  >
                    {window.rate === null ? "—" : `${window.rate.toFixed(1)}×`}
                  </Typography>
                </Box>
              ))}
          </Stack>
        </Box>
      </Box>
    </Paper>
  );
}

function StateChip({ state }: { state: SloRow["state"] }) {
  const map = {
    ok: { label: "healthy", color: colors.ok },
    "at-risk": { label: "at risk", color: colors.warn },
    breached: { label: "breached", color: colors.danger },
    "no-data": { label: "no data", color: colors.faint },
  } as const;
  const { label, color } = map[state];
  return (
    <Chip
      size="small"
      label={label}
      sx={{ color, borderColor: `${color}66`, bgcolor: `${color}14` }}
      variant="outlined"
    />
  );
}

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
    <Box sx={{ px: 1.5, py: 0.75, border: `1px solid ${colors.border}`, borderRadius: 1.5 }}>
      <Typography sx={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: colors.faint }}>
        {label}
      </Typography>
      <Typography
        sx={{ fontSize: 16, fontWeight: 600, ...tabular, color: tone === "danger" ? colors.danger : colors.text }}
      >
        {value}
      </Typography>
    </Box>
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
      }}
    >
      {children}
    </Typography>
  );
}

function CreateDialog({
  open,
  onClose,
  applications,
  defaultApplicationId,
  lockedApplicationName,
  onSubmit,
  onFailure,
}: {
  open: boolean;
  onClose: () => void;
  /** The shell's applications: offered as a target when the page is unscoped. */
  applications: ReadonlyArray<{ id: string; name: string }>;
  defaultApplicationId: string;
  /** Set when the page's scope already decides the target; null unscoped. */
  lockedApplicationName: string | null;
  onSubmit: (applicationId: string, input: Parameters<typeof api.createSlo>[1]) => Promise<void>;
  onFailure: (message: string) => void;
}) {
  const [applicationId, setApplicationId] = useState(defaultApplicationId);
  const [kind, setKind] = useState<"availability" | "latency" | "job">("availability");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("99.9");
  const [underMs, setUnderMs] = useState("300");
  const [windowDays, setWindowDays] = useState<"7" | "14" | "28" | "30">("28");
  const [operationId, setOperationId] = useState("");
  const [busy, setBusy] = useState(false);

  // A locked target is the page's own scope; unscoped it is whatever the select
  // holds, and an empty select cannot post (the write needs an application).
  const targetApplicationId = lockedApplicationName ? defaultApplicationId : applicationId;
  const canSubmit = targetApplicationId !== "";

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onSubmit(targetApplicationId, {
        ...(name.trim() ? { name: name.trim() } : {}),
        kind,
        target: Number(target),
        ...(kind === "latency" ? { underMs: Number(underMs) } : {}),
        windowDays: Number(windowDays) as 7 | 14 | 28 | 30,
        ...(operationId.trim() ? { operationId: operationId.trim() } : {}),
      });
      setName("");
    } catch (error) {
      onFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>New objective</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {lockedApplicationName ? (
            <TextField
              label="Application"
              size="small"
              value={lockedApplicationName}
              slotProps={{ input: { readOnly: true } }}
              helperText="Objectives are addressed by application; this one is the page's scope."
            />
          ) : (
            <TextField
              select
              required
              label="Application"
              size="small"
              value={applicationId}
              onChange={(event) => setApplicationId(event.target.value)}
              helperText={
                applications.length === 0
                  ? "No application has reported yet, and an objective needs traffic to measure."
                  : "Each objective is measured against its own application's traffic."
              }
            >
              {applications.map((entry) => (
                <MenuItem key={entry.id} value={entry.id}>
                  {entry.name}
                </MenuItem>
              ))}
            </TextField>
          )}
          <TextField
            label="Name (optional)"
            size="small"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Checkout availability"
          />
          <TextField
            select
            label="SLI"
            size="small"
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <MenuItem value="availability">Availability — a request below 500</MenuItem>
            <MenuItem value="latency">Latency — a request under a threshold</MenuItem>
            <MenuItem value="job">Job success — a run that completed</MenuItem>
          </TextField>
          <Stack direction="row" spacing={2}>
            <TextField
              label="Target %"
              size="small"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              sx={{ flex: 1 }}
            />
            <TextField
              select
              label="Window"
              size="small"
              value={windowDays}
              onChange={(event) => setWindowDays(event.target.value as typeof windowDays)}
              sx={{ flex: 1 }}
            >
              {["7", "14", "28", "30"].map((days) => (
                <MenuItem key={days} value={days}>
                  {days} days
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          {kind === "latency" && (
            <TextField
              label="Under (ms)"
              size="small"
              value={underMs}
              onChange={(event) => setUnderMs(event.target.value)}
            />
          )}
          <TextField
            label="Operation (optional)"
            size="small"
            value={operationId}
            onChange={(event) => setOperationId(event.target.value)}
            placeholder="GET /orders — leave empty for the whole application"
            helperText="Matches the operation id the SDK sends, exactly."
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={busy || !canSubmit}>
          {busy ? "Saving…" : "Create"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function kindLabel(kind: SloRow["kind"]): string {
  return kind === "availability" ? "Availability" : kind === "latency" ? "Latency" : "Job success";
}

/** `99.9` → `99.9%` without trailing zeros (`99.900`). */
function percent(value: number, digits = 2): string {
  return `${Number(value.toFixed(digits))}%`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
