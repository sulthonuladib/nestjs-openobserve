/**
 * Settings — the instance configuration, split by who can actually change it.
 *
 * The split is the page. `instance_setting` is free-form rows, so anything
 * stored there is editable here and takes effect on the next read. Bootstrap
 * values (public URL, anonymous ingest, trust-proxy, the database URL, the port)
 * come from the environment at boot: a page that could rewrite them would be a
 * remote way to widen ingest auth or forge the IP in the audit trail, so they are
 * shown read-only with the variable that owns them rather than as disabled inputs
 * with no explanation.
 *
 * Retention deserves its own sentence, because it is the place dashboards
 * usually start selling: `retention.traces` is a **storage policy on a machine
 * the operator owns**. `0` keeps everything, which is the correct default for a
 * self-hosted install, and nothing about it is a plan, a quota or a seat count.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { admin, type AuditRow, type InstanceSettings } from "../api";
import { PageHeader } from "../components/shell/PageHeader";
import { formatRelative } from "../format";
import { colors, fontMono, labelCaps } from "../theme";

/** The three registration modes the server actually distinguishes. */
type Registration = "open" | "invite" | "closed";

const REGISTRATION: ReadonlyArray<{ value: Registration; label: string; hint: string }> = [
  {
    value: "open",
    label: "open — anyone can sign up",
    hint: "Anyone who can reach this URL can create an account. Reasonable on a laptop, a bad default behind a public DNS name.",
  },
  {
    value: "invite",
    label: "invite — link only",
    hint: "Only people holding an invite link can create an account. Invites live on the Members page; the role is bound server-side.",
  },
  {
    value: "closed",
    label: "closed — no new accounts",
    hint: "Nobody can sign up. Existing members keep their sessions; the first-run setup page is already unreachable once an admin exists.",
  },
];

export interface SettingsProps {
  /** The shell's signed-in user; `role` gates the page, the server gates the API. */
  user?: { id?: string; email?: string; role?: string } | null;
}

export function Settings({ user }: SettingsProps) {
  if (user?.role !== "admin") return <NeedsAdmin />;
  return <SettingsView />;
}

interface Form {
  name: string;
  registration: Registration;
  /** Held as text: an empty field while typing must not become `0` silently. */
  retention: string;
}

function SettingsView() {
  const client = useQueryClient();
  /** Edits live here until saved; `null` means "not yet initialised from the server". */
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState(false);

  const settings = useQuery({
    queryKey: ["admin", "settings"],
    queryFn: () => admin.settings(),
    staleTime: 60_000,
  });

  const audit = useQuery({
    queryKey: ["admin", "audit", 50],
    queryFn: () => admin.audit(50),
    staleTime: 30_000,
  });

  // The baseline the form is compared against: what the server currently says,
  // not what it said when the page opened, so a refetch cannot make an untouched
  // form look dirty.
  const data = settings.data;
  const baseline = data ? baselineFrom(data) : null;

  // Initialise once and then leave the operator's edits alone — a background
  // refetch must not overwrite a half-typed retention value.
  useEffect(() => {
    if (baseline && form === null) setForm(baseline);
  }, [baseline, form]);

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => admin.saveSettings(patch),
    onSuccess: () => {
      setSaved(true);
      void client.invalidateQueries({ queryKey: ["admin", "settings"] });
      void client.invalidateQueries({ queryKey: ["admin", "audit", 50] });
    },
    onError: () => setSaved(false),
  });

  const days = form ? Number(form.retention) : 0;
  const daysValid = form !== null && form.retention.trim() !== "" && Number.isInteger(days) && days >= 0;
  const nameValid = form !== null && form.name.trim().length > 0 && form.name.trim().length <= 80;

  const patch: Record<string, unknown> = {};
  if (form && baseline) {
    if (form.name.trim() !== baseline.name) patch.instanceName = form.name.trim();
    if (form.registration !== baseline.registration) patch.registration = form.registration;
    if (form.retention !== baseline.retention) patch["retention.traces"] = days;
  }
  const dirty = Object.keys(patch).length > 0;
  const canSave = dirty && daysValid && nameValid && !save.isPending;

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Settings"
        description="What this instance calls itself, who can join, and how much trace history it keeps. Bootstrap values from the environment are shown below, read-only."
        actions={
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Typography sx={{ fontSize: 11, color: dirty ? colors.warn : "text.disabled" }}>
              {!dirty
                ? "No unsaved changes"
                : `${Object.keys(patch).length} unsaved ${Object.keys(patch).length === 1 ? "change" : "changes"}`}
            </Typography>
            <Button
              variant="contained"
              disabled={!canSave}
              onClick={() => {
                if (!canSave) return;
                setSaved(false);
                save.mutate(patch);
              }}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </Stack>
        }
      />

      {save.isError && (
        <Alert severity="error">
          Nothing was saved. {errorMessage(save.error)}
        </Alert>
      )}
      {save.isSuccess && saved && !dirty && (
        <Alert severity="success" onClose={() => setSaved(false)}>
          Saved. Nothing else needed — these values are read from
          <Box component="span" sx={{ fontFamily: fontMono, fontSize: 11.5 }}> instance_setting </Box>
          on the next request.
        </Alert>
      )}

      {settings.isError ? (
        <Alert severity="error">
          The settings could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {errorMessage(settings.error)}
          </Box>
        </Alert>
      ) : settings.isLoading || !data || !form || !baseline ? (
        <Skeleton variant="rounded" height={240} />
      ) : (
        <Stack direction={{ xs: "column", lg: "row" }} spacing={2}>
          {/* 1. Editable — stored in `instance_setting`. */}
          <Paper sx={{ p: 2, flex: "1 1 420px", minWidth: 0 }}>
            <SectionLabel>Stored on this instance</SectionLabel>
            <Typography sx={{ mt: 0.5, mb: 2, fontSize: 11.5, color: "text.disabled" }}>
              Free-form rows in <Code>instance_setting</Code>: saved immediately and
              read on every request, no restart and no migration.
            </Typography>

            <Stack spacing={2}>
              <TextField
                size="small"
                label="Instance name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                error={!nameValid}
                helperText={
                  nameValid
                    ? "Shown on the sign-in page and returned by the auth status endpoint."
                    : "Required, up to 80 characters."
                }
                slotProps={{ htmlInput: { maxLength: 120 } }}
              />

              <TextField
                size="small"
                select
                label="Registration"
                value={form.registration}
                onChange={(event) =>
                  setForm({ ...form, registration: event.target.value as Registration })
                }
                helperText={
                  REGISTRATION.find((entry) => entry.value === form.registration)?.hint ?? " "
                }
              >
                {REGISTRATION.map((entry) => (
                  <MenuItem key={entry.value} value={entry.value}>
                    {entry.label}
                  </MenuItem>
                ))}
              </TextField>

              <Box>
                <TextField
                  size="small"
                  label="Trace retention (days)"
                  value={form.retention}
                  onChange={(event) => setForm({ ...form, retention: event.target.value })}
                  error={!daysValid}
                  helperText={
                    daysValid ? (days === 0 ? "0 — keep everything" : `${days} ${days === 1 ? "day" : "days"}`) : "A whole number, 0 or more"
                  }
                  slotProps={{ htmlInput: { inputMode: "numeric" } }}
                  sx={{ width: 240 }}
                />
                <Typography sx={{ mt: 1, fontSize: 11, color: "text.disabled", maxWidth: 470 }}>
                  {daysValid && days > 0
                    ? `Traces older than ${days} ${days === 1 ? "day" : "days"} become prunable. Nothing is deleted on a timer — the collector prunes when you run `
                    : "Nothing is prunable while this is 0, so the instance keeps every trace. "}
                  <Code>nestjs-openobserve admin prune</Code>
                  {daysValid && days > 0
                    ? ", so an install nobody prunes keeps its disk until you say otherwise."
                    : ""}
                </Typography>
                <Typography sx={{ mt: 0.75, fontSize: 11, color: "text.disabled", maxWidth: 470 }}>
                  Retention is a storage policy on a machine you own: not a plan, a
                  quota or a seat count. Nothing in this product is metered — only how
                  much of your own disk it fills is at stake.
                </Typography>
                {baseline.retention === "0" && (
                  <Typography sx={{ mt: 0.75, fontSize: 11, color: "text.disabled" }}>
                    No <Code>retention.traces</Code> row exists yet, so the effective
                    value is 0: keep everything. Saving writes the row.
                  </Typography>
                )}
              </Box>
            </Stack>
          </Paper>

          {/* 2. From the environment — shown with the variable that owns it. */}
          <Paper sx={{ p: 2, flex: "1 1 320px", minWidth: 0 }}>
            <SectionLabel>From the environment</SectionLabel>
            <Typography sx={{ mt: 0.5, mb: 2, fontSize: 11.5, color: "text.disabled" }}>
              Read once at boot. Changing any of these means editing the container's
              environment and restarting — not a form, deliberately.
            </Typography>

            <Stack spacing={1.75}>
              <ReadOnlyRow
                label="Public URL"
                value={data.effective.publicUrl}
                variable="OBSERVE_PUBLIC_URL"
                why="Invite links and the session cookie's secure flag are built from it before any request arrives, so a page that could change it could mint links pointing somewhere else."
              />
              <ReadOnlyRow
                label="Anonymous ingest"
                value={data.effective.anonymousIngest ? "allowed" : "refused"}
                tone={data.effective.anonymousIngest ? "warn" : "ok"}
                variable="OBSERVE_ALLOW_ANONYMOUS_INGEST"
                why="Whether the collector accepts a batch that presents no key pair. A browser toggle for this would be a one-click way to widen ingest auth, so it stays a restart-level decision."
              />
              <ReadOnlyRow
                label="Trust proxy"
                value={data.effective.trustProxy ? "X-Forwarded-For believed" : "direct connection only"}
                variable="OBSERVE_TRUST_PROXY"
                why="Decides the client IP recorded in the audit trail. If this page could set it, anyone who could load the page could choose who the log blames."
              />
              <ReadOnlyRow
                label="Registration (effective)"
                value={data.effective.registration}
                variable="instance_setting"
                tone={data.effective.registration === "open" ? "warn" : undefined}
                why="The value actually in force right now — the stored setting when there is one, otherwise the server's default of invite."
              />
            </Stack>

            <Typography sx={{ mt: 2, fontSize: 11, color: "text.disabled" }}>
              The database URL, the listen port and the migration flag are also
              environment-only; the API does not expose them to the dashboard at all.
            </Typography>
          </Paper>
        </Stack>
      )}

      {/* 3. Audit — the answer to "who changed that", which a self-hoster asks. */}
      <Box>
        <SectionLabel>Audit trail</SectionLabel>
        <Typography sx={{ mt: 0.5, mb: 1.25, fontSize: 11.5, color: "text.disabled" }}>
          The last 50 administrative actions, newest first. Append-only, written by
          the server on every change above — plus key and invite changes.
        </Typography>
        {audit.isError ? (
          <Alert severity="error">
            The audit trail could not be loaded.{" "}
            <Box component="span" sx={{ color: "text.secondary" }}>
              {errorMessage(audit.error)}
            </Box>
          </Alert>
        ) : audit.isLoading ? (
          <Skeleton variant="rounded" height={160} />
        ) : (audit.data?.items.length ?? 0) === 0 ? (
          <Box
            sx={{
              border: `1px dashed ${colors.borderStrong}`,
              borderRadius: 1,
              px: 3,
              py: 4,
              textAlign: "center",
            }}
          >
            <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
              Nothing recorded yet.
            </Typography>
            <Typography sx={{ mt: 0.5, fontSize: 11.5, color: "text.disabled" }}>
              Saving a setting, minting a key, changing a role or issuing an invite
              writes the first row.
            </Typography>
          </Box>
        ) : (
          <Paper sx={{ overflow: "hidden" }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>When</TableCell>
                  <TableCell>Actor</TableCell>
                  <TableCell>Action</TableCell>
                  <TableCell>Target</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(audit.data?.items ?? []).map((row) => (
                  <AuditRowView key={row.id} row={row} />
                ))}
              </TableBody>
            </Table>
          </Paper>
        )}
      </Box>
    </Stack>
  );
}

function AuditRowView({ row }: { row: AuditRow }) {
  const detail = row.detail === null ? null : JSON.stringify(row.detail);
  return (
    <TableRow hover>
      <TableCell sx={{ color: "text.secondary", whiteSpace: "nowrap" }}>
        <Tooltip title={new Date(row.at).toLocaleString()}>
          <Box component="span">{formatRelative(row.at)}</Box>
        </Tooltip>
      </TableCell>
      <TableCell sx={{ color: "text.secondary", fontSize: 11.5 }}>
        {row.actorEmail ?? (
          <Box component="span" sx={{ color: "text.disabled" }}>
            system
          </Box>
        )}
      </TableCell>
      <TableCell>
        {/* The detail is free-form per action, so it is a tooltip rather than a
            column that would be empty for half the rows. */}
        <Tooltip title={detail === null ? "No detail recorded" : detail.slice(0, 400)}>
          <Box component="code" sx={{ fontFamily: fontMono, fontSize: 11.5, cursor: "help" }}>
            {row.action}
          </Box>
        </Tooltip>
      </TableCell>
      <TableCell
        sx={{
          color: "text.disabled",
          fontFamily: row.target ? fontMono : "inherit",
          fontSize: 11,
          maxWidth: 260,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.target ?? "—"}
      </TableCell>
    </TableRow>
  );
}

/** A value the page can show but not set, with the variable that owns it. */
function ReadOnlyRow({
  label,
  value,
  variable,
  why,
  tone,
}: {
  label: string;
  value: string;
  variable: string;
  why: string;
  tone?: "ok" | "warn";
}) {
  const color = tone === "warn" ? colors.warn : tone === "ok" ? colors.ok : colors.text;
  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
        <Typography sx={{ ...labelCaps, fontSize: 10 }}>{label}</Typography>
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontFamily: fontMono, fontSize: 10.5, color: "text.disabled" }}>
          {variable}
        </Typography>
      </Stack>
      <Typography
        sx={{ fontFamily: fontMono, fontSize: 12, color, mt: 0.25, wordBreak: "break-all" }}
      >
        {value}
      </Typography>
      <Typography sx={{ mt: 0.25, fontSize: 11, color: "text.disabled", lineHeight: 1.5 }}>
        {why}
      </Typography>
    </Box>
  );
}

function Code({ children }: { children: string }) {
  return (
    <Box component="code" sx={{ fontFamily: fontMono, fontSize: 11.5, color: "text.secondary" }}>
      {children}
    </Box>
  );
}

/**
 * What the form shows when nothing has been edited.
 *
 * `instanceName` falls back to the effective value (the server's own default) and
 * retention to `"0"` — an absent row means keep-forever, which is how
 * `retentionDays()` reads it server-side. Showing `30` here would invent a policy
 * the collector does not have.
 */
function baselineFrom(data: InstanceSettings): Form {
  const stored = data.settings;
  const name =
    typeof stored.instanceName === "string" && stored.instanceName.trim() !== ""
      ? stored.instanceName
      : data.effective.instanceName;

  const registration =
    stored.registration === "open" || stored.registration === "invite" || stored.registration === "closed"
      ? stored.registration
      : data.effective.registration;

  const rawRetention = stored["retention.traces"];
  const retention = typeof rawRetention === "number" && Number.isFinite(rawRetention)
    ? String(Math.max(0, Math.floor(rawRetention)))
    : typeof rawRetention === "string" && rawRetention.trim() !== "" && Number.isFinite(Number(rawRetention))
      ? String(Math.max(0, Math.floor(Number(rawRetention))))
      : "0";

  return { name, registration, retention };
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Typography sx={{ ...labelCaps, display: "block", mb: 0.25 }} component="h2">
      {children}
    </Typography>
  );
}

function NeedsAdmin() {
  return (
    <Stack spacing={2}>
      <PageHeader title="Settings" description="Instance administration." />
      <Alert severity="info">
        Instance settings are visible to administrators only. Your account does not
        have the admin role, and the server refuses these reads with a 403 — ask an
        administrator for the role rather than for a screenshot.
      </Alert>
    </Stack>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
