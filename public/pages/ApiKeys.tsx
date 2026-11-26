/**
 * API keys — the credentials an agent presents to the ingest endpoint.
 *
 * Three properties of the server shape this page, and each one is stated on it
 * rather than discovered by a reader who assumed the opposite:
 *
 *   * **A pair is project-scoped.** Every application that should report into
 *     this collector uses the same pair; the application is resolved per batch
 *     from the `serviceId` the agent sends. The API answers `scope: "project"`
 *     for exactly this reason, so the sentence is on the header.
 *   * **The secret is shown once.** It is hashed at issue time and there is no
 *     reveal and no recovery, so the create response is rendered as a panel that
 *     the operator dismisses once stored. Rotation is create-then-revoke, not
 *     edit.
 *   * **Revoked is not deleted.** Ingest checks `revoked_at`; a deleted row would
 *     read as "no credentials" (anonymous ingest) instead of "wrong key". So a
 *     revoked key keeps its row, its prefix and the time it was revoked.
 *
 * Nothing here is metered or priced: a key is a door, and this page lists the
 * doors and who may still walk through them.
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
  IconButton,
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
import { Check, Copy, Key, Plus } from "@phosphor-icons/react";
import { useState } from "react";
import { admin, type CredentialRow } from "../api";
import { PageHeader } from "../components/shell/PageHeader";
import { formatCount, formatRelative } from "../format";
import { colors, fontMono, labelCaps, tabular } from "../theme";

export interface ApiKeysProps {
  /** The shell's signed-in user; `role` is the instance role, not a project one. */
  user?: { id?: string; email?: string; role?: string } | null;
}

export function ApiKeys({ user }: ApiKeysProps) {
  // Admins only. The server enforces this independently (every `/admin/*` route
  // resolves `requireAdmin` and answers 403), so this is a courtesy panel, not
  // the access control — which is why the queries below are not even sent.
  if (user?.role !== "admin") return <NeedsAdmin what="API keys" />;
  return <ApiKeysView />;
}

function ApiKeysView() {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  /** The create response, held in memory only — it is the one copy that exists. */
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [confirming, setConfirming] = useState<CredentialRow | null>(null);

  const credentials = useQuery({
    queryKey: ["admin", "credentials"],
    queryFn: () => admin.credentials(),
    staleTime: 15_000,
  });

  const invalidate = () => client.invalidateQueries({ queryKey: ["admin", "credentials"] });

  const create = useMutation({
    mutationFn: (value: string) => admin.createCredential(value.trim() || undefined),
    onSuccess: (result) => {
      setMinted(result);
      setLabel("");
      setOpen(false);
      void invalidate();
    },
  });

  const revoke = useMutation({
    // Revoke, never delete: the row has to stay visible so "was this key killed
    // or was it never created" has an answer.
    mutationFn: (id: string) => admin.revokeCredential(id),
    onSuccess: () => {
      setConfirming(null);
      void invalidate();
    },
  });

  const rows = credentials.data?.items ?? [];
  const live = rows.filter((row) => row.revokedAt === null).length;
  const revoked = rows.length - live;
  // The newest *used* key is the one an operator is usually looking for — "is
  // anything still reporting with these" is the question that brings them here.
  const lastUsed = rows.reduce<number | null>(
    (newest, row) =>
      row.lastUsedAt !== null && (newest === null || row.lastUsedAt > newest) ? row.lastUsedAt : newest,
    null,
  );

  return (
    <Stack spacing={3}>
      <PageHeader
        title="API keys"
        description="Any application whose telemetry should land here can use the same key pair — the application is resolved from the batch, not from the key."
        actions={
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Stat label="Live" value={formatCount(live)} />
            <Stat label="Revoked" value={formatCount(revoked)} />
            <Stat
              label="Last used"
              value={lastUsed === null ? "never" : formatRelative(lastUsed)}
              hint={
                lastUsed === null
                  ? "No key has authenticated a batch yet. A key created but never used is a credential waiting for its first deploy."
                  : `The most recent successful authentication was ${new Date(lastUsed).toLocaleString()}.`
              }
            />
            <Button variant="contained" startIcon={<Plus size={13} />} onClick={() => setOpen(true)}>
              Create key
            </Button>
          </Stack>
        }
      />

      {/* The one-time pair. It stays until dismissed because a refresh loses it
          for good — the secret is hashed server-side and cannot be re-read. */}
      {minted && <MintedPanel minted={minted} onDismiss={() => setMinted(null)} />}

      {create.isError && (
        <Alert severity="error">The key was not created. {errorMessage(create.error)}</Alert>
      )}
      {revoke.isError && (
        <Alert severity="error">The key was not revoked. {errorMessage(revoke.error)}</Alert>
      )}

      {credentials.isError ? (
        <Alert severity="error">
          The key list could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {errorMessage(credentials.error)}
          </Box>
        </Alert>
      ) : credentials.isLoading ? (
        <Skeleton variant="rounded" height={200} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No keys yet — the CLI link flow (npx @nestjs/observe link) creates one too."
          hint="Both paths write the same app_credential row and ingest resolves them identically. A key is only needed when an agent must authenticate without a terminal; anonymous ingest is a separate server-wide setting."
        />
      ) : (
        <Paper sx={{ overflow: "hidden" }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Label</TableCell>
                <TableCell>Key prefix</TableCell>
                <TableCell>Created</TableCell>
                <TableCell>Last used</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => {
                const liveRow = row.revokedAt === null;
                return (
                  <TableRow
                    key={row.id}
                    hover
                    sx={liveRow ? undefined : { opacity: 0.7 }}
                  >
                    <TableCell sx={{ fontWeight: 500 }}>
                      {row.label ?? "(unlabelled)"}
                    </TableCell>
                    <TableCell>
                      <Typography
                        component="code"
                        sx={{ fontFamily: fontMono, fontSize: 11.5, color: "text.secondary" }}
                      >
                        {row.keyPrefix}…
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ color: "text.secondary", whiteSpace: "nowrap" }}>
                      <Tooltip title={new Date(row.createdAt).toLocaleString()}>
                        <Box component="span">{formatRelative(row.createdAt)}</Box>
                      </Tooltip>
                    </TableCell>
                    <TableCell sx={{ color: "text.secondary", whiteSpace: "nowrap" }}>
                      {row.lastUsedAt === null ? (
                        <Box component="span" sx={{ color: "text.disabled" }}>
                          never
                        </Box>
                      ) : (
                        <Tooltip title={new Date(row.lastUsedAt).toLocaleString()}>
                          <Box component="span">{formatRelative(row.lastUsedAt)}</Box>
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell>
                      {liveRow ? (
                        <Chip
                          size="small"
                          variant="outlined"
                          label="active"
                          sx={{
                            color: colors.ok,
                            borderColor: `${colors.ok}66`,
                            bgcolor: `${colors.ok}14`,
                          }}
                        />
                      ) : (
                        <Tooltip
                          title={`Revoked ${new Date(row.revokedAt ?? 0).toLocaleString()}. A revoked pair gets a 401, not anonymous ingest — the key is kept so a replay is a rejection rather than a silent unauthenticated write.`}
                        >
                          <Chip
                            size="small"
                            variant="outlined"
                            label={`revoked ${formatRelative(row.revokedAt ?? 0)}`}
                            sx={{
                              color: colors.danger,
                              borderColor: `${colors.danger}66`,
                              bgcolor: `${colors.danger}14`,
                              cursor: "help",
                            }}
                          />
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      {liveRow && (
                        <Button
                          size="small"
                          color="inherit"
                          sx={{ minWidth: 0, px: 0.75, fontSize: 11 }}
                          onClick={() => setConfirming(row)}
                        >
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Paper>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle sx={{ fontSize: 15 }}>Create an ingest key</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 12, color: "text.secondary", mb: 2 }}>
            The label is only for this table — it is not sent to the agent and does
            not scope the key. The pair works for every application reporting here.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Label"
            placeholder="production-cutover"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !create.isPending) create.mutate(label);
            }}
            helperText="Optional. Left blank, the server labels it “Dashboard”."
          />
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={create.isPending}
            onClick={() => create.mutate(label)}
          >
            {create.isPending ? "Creating…" : "Create key"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* A revoke breaks a running deployment on its next batch, so it asks once. */}
      <Dialog open={confirming !== null} onClose={() => setConfirming(null)} fullWidth maxWidth="xs">
        <DialogTitle sx={{ fontSize: 15 }}>Revoke this key?</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
            <Box component="span" sx={{ fontFamily: fontMono, color: "text.primary" }}>
              {confirming?.keyPrefix}…
            </Box>{" "}
            stops authenticating immediately: every agent still configured with it
            gets a 401 on its next batch. The row stays visible as revoked, and the
            secret cannot be recovered — rotation means creating a new key and
            deploying it before revoking the old one.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={() => setConfirming(null)}>
            Keep it
          </Button>
          <Button
            variant="contained"
            color="error"
            disabled={revoke.isPending}
            onClick={() => {
              if (confirming) revoke.mutate(confirming.id);
            }}
          >
            {revoke.isPending ? "Revoking…" : "Revoke"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

/** What the create endpoint returns — the only shape that ever carries a secret. */
interface MintedKey {
  id: string;
  appKey: string;
  appSecret: string;
  keyPrefix: string;
}

/**
 * The pair, once. Deliberately loud: this is the only moment the secret exists
 * outside the agent's configuration, and there is no "show it again" to add.
 */
function MintedPanel({ minted, onDismiss }: { minted: MintedKey; onDismiss: () => void }) {
  return (
    <Paper
      sx={{
        border: `1px solid ${colors.accent}55`,
        bgcolor: colors.accentSoft,
        p: 2,
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1.5 }}>
        <Key size={14} color={colors.accentText} />
        <Typography sx={{ ...labelCaps, color: colors.accentText }}>
          Copy both values now
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Button size="small" color="inherit" onClick={onDismiss} sx={{ minWidth: 0, px: 0.75, fontSize: 11 }}>
          I have stored it
        </Button>
      </Stack>

      <Stack spacing={1}>
        <SecretRow label="appKey" value={minted.appKey} />
        <SecretRow label="appSecret" value={minted.appSecret} />
      </Stack>

      <Typography sx={{ mt: 1.5, fontSize: 11.5, color: "text.secondary" }}>
        The secret is hashed when this request returns and is never shown again —
        this panel disappears on reload and there is no way to reveal or recover
        it. Lost it? Create another pair and revoke this one.
      </Typography>
    </Paper>
  );
}

function SecretRow({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Typography sx={{ ...labelCaps, width: 78, flexShrink: 0 }}>{label}</Typography>
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          px: 1,
          py: 0.5,
          border: `1px solid ${colors.border}`,
          borderRadius: 1,
          bgcolor: colors.surface,
          fontFamily: fontMono,
          fontSize: 12,
          overflowX: "auto",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </Box>
      <CopyButton value={value} label={label} />
    </Stack>
  );
}

/**
 * Copy, with the checked state living for a moment only.
 *
 * A browser that refuses clipboard access (or a plain-http origin) is not a page
 * error: the value is still visible and selectable in the field beside it, so the
 * failure is silent on purpose.
 */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip title={copied ? "Copied" : `Copy ${label}`}>
      <IconButton
        size="small"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void copyText(value).then((ok) => {
            if (!ok) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check size={14} color={colors.ok} /> : <Copy size={14} />}
      </IconButton>
    </Tooltip>
  );
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const body = (
    <Box sx={{ px: 1.5, py: 0.75, border: `1px solid ${colors.border}`, borderRadius: 1.5, minWidth: 72 }}>
      <Typography sx={labelCaps}>{label}</Typography>
      <Typography sx={{ fontSize: 15, fontWeight: 600, ...tabular }}>{value}</Typography>
    </Box>
  );
  return hint ? (
    <Tooltip title={hint}>
      <Box>{body}</Box>
    </Tooltip>
  ) : (
    body
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
        <Typography sx={{ mt: 0.75, fontSize: 11.5, color: "text.disabled", maxWidth: 620, mx: "auto" }}>
          {hint}
        </Typography>
      )}
    </Box>
  );
}

function NeedsAdmin({ what }: { what: string }) {
  return (
    <Stack spacing={2}>
      <PageHeader title={what} description="Instance administration." />
      <Alert severity="info">
        {what} is visible to instance administrators only. Your account does not
        have the admin role, and the server refuses these reads with a 403 — ask an
        administrator for the role rather than for a screenshot.
      </Alert>
    </Stack>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
