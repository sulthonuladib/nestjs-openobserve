/**
 * Members — who can open this instance, and who has been invited.
 *
 * Roles are the server's vocabulary, not a product tier: `read` can look,
 * `write` can also use the collector (issue keys, resolve errors), `admin` can
 * administer the instance. There is no fourth role and nothing is metered — an
 * install with fifty people costs the same as one with two.
 *
 * Two honesty notes the page carries, because both are surprising:
 *
 *   * **The server refuses the last demotion.** `assertNotLastAdmin` answers 409
 *     when an admin tries to demote or remove the only remaining admin — that is
 *     a lockout, not a policy. The page shows that message where the role was
 *     changed instead of leaving a control that silently did nothing.
 *   * **Invites are links, not emails.** This build has no SMTP, so the issued
 *     `/invite/<token>` URL *is* the delivery. The token is stored hashed, which
 *     means the URL can be shown once, at issue time, and never reconstructed —
 *     an existing invite can be revoked but not re-shared.
 *
 * Single use, seven days. The role is bound server-side, so a leaked link grants
 * exactly the role chosen here and nothing more.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  MenuItem,
  Paper,
  Select,
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
import { Check, Copy } from "@phosphor-icons/react";
import { useState } from "react";
import { admin, type InviteRow, type MemberRow } from "../api";
import { PageHeader } from "../components/shell/PageHeader";
import { formatCount, formatRelative } from "../format";
import { colors, fontMono, labelCaps, tabular } from "../theme";

type Role = "read" | "write" | "admin";

const ROLES: ReadonlyArray<{ value: Role; label: string; hint: string }> = [
  { value: "read", label: "read", hint: "Can see telemetry, keys and settings. Cannot change anything." },
  { value: "write", label: "write", hint: "Read, plus resolving errors and issuing ingest keys for their own use." },
  { value: "admin", label: "admin", hint: "Everything, including this page: members, invites, instance settings." },
];

export interface MembersProps {
  /** The shell's signed-in user — used to mark "you" and to gate the page. */
  user?: { id?: string; email?: string; role?: string } | null;
}

export function Members({ user }: MembersProps) {
  // The final say is the server's `requireAdmin`; this panel only avoids drawing
  // three tables that would each answer 403.
  if (user?.role !== "admin") return <NeedsAdmin what="Members" />;
  return <MembersView currentUserId={user.id} />;
}

function MembersView({ currentUserId }: { currentUserId?: string }) {
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("write");
  /** The one response that carries the token: the link is the delivery. */
  const [issued, setIssued] = useState<IssuedInvite | null>(null);

  const users = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => admin.users(),
    staleTime: 30_000,
  });

  const invites = useQuery({
    queryKey: ["admin", "invites"],
    queryFn: () => admin.invites(),
    staleTime: 30_000,
  });

  const changeRole = useMutation({
    mutationFn: (input: { id: string; role: Role; email: string }) =>
      admin.setRole(input.id, input.role),
    onSuccess: () => client.invalidateQueries({ queryKey: ["admin", "users"] }),
  });

  const invite = useMutation({
    mutationFn: (input: { email: string; role: Role }) => admin.invite(input.email, input.role),
    onSuccess: (result, input) => {
      setIssued({ ...result, email: input.email.trim().toLowerCase(), role: input.role });
      setEmail("");
      void client.invalidateQueries({ queryKey: ["admin", "invites"] });
    },
  });

  const revokeInvite = useMutation({
    mutationFn: (id: string) => admin.revokeInvite(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ["admin", "invites"] }),
  });

  const members = users.data?.items ?? [];
  const adminCount = members.filter((member) => member.role === "admin").length;
  // "Pending" is the only state an operator acts on: accepted invites are a
  // person, and an expired one is dead weight the server also treats as absent.
  const pending = (invites.data?.items ?? []).filter(isOutstanding);
  const emailInvalid = email.trim().length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const canInvite = email.trim().length > 0 && !emailInvalid && !invite.isPending;

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Members"
        description="People with an account on this instance. Roles are instance-wide: read, write, admin."
        actions={
          <Stack direction="row" spacing={1}>
            <Stat label="Members" value={formatCount(members.length)} />
            <Stat label="Admins" value={formatCount(adminCount)} />
            <Stat
              label="Pending invites"
              value={formatCount(pending.length)}
              hint="Issued, not yet accepted, not yet expired. Expired and accepted invites are hidden — neither can be used again."
            />
          </Stack>
        }
      />

      <Box>
        <SectionTitle>Accounts</SectionTitle>
        {changeRole.isError && (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            Role not changed — {errorMessage(changeRole.error)}
            {changeRole.variables ? ` (${changeRole.variables.email})` : ""}
          </Alert>
        )}
        {users.isError ? (
          <Alert severity="error">
            The member list could not be loaded.{" "}
            <Box component="span" sx={{ color: "text.secondary" }}>
              {errorMessage(users.error)}
            </Box>
          </Alert>
        ) : users.isLoading ? (
          <Skeleton variant="rounded" height={180} />
        ) : (
          <Paper sx={{ overflow: "hidden" }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Email</TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>Role</TableCell>
                  <TableCell>Added</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {members.map((member) => (
                  <MemberRowView
                    key={member.id}
                    member={member}
                    isSelf={member.id === currentUserId}
                    pending={changeRole.isPending && changeRole.variables?.id === member.id}
                    onChange={(next) =>
                      changeRole.mutate({ id: member.id, role: next, email: member.email })
                    }
                  />
                ))}
              </TableBody>
            </Table>
          </Paper>
        )}
      </Box>

      <Box>
        <SectionTitle>Invites</SectionTitle>
        <Typography sx={{ fontSize: 11.5, color: "text.disabled", mb: 1.5, maxWidth: 720 }}>
          Single use, seven days, role bound server-side. There is no SMTP in this
          build, so the generated link is the delivery — copy it and send it
          yourself. The server stores only a hash of the token, so a link is
          visible once, when it is issued.
        </Typography>

        {invite.isError && (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            The invite was not issued. {errorMessage(invite.error)}
          </Alert>
        )}

        {issued && <IssuedPanel issued={issued} onDismiss={() => setIssued(null)} />}

        <Paper sx={{ p: 1.5, mb: 2 }}>
          {/* One line of fields, one line of explanation: a helper under either
              field would push the button out of alignment with the inputs. */}
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: "flex-start" }}>
            <TextField
              size="small"
              label="Email"
              type="email"
              placeholder="colleague@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              error={emailInvalid}
              sx={{ flex: 1, minWidth: 220 }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canInvite) {
                  invite.mutate({ email: email.trim(), role: inviteRole });
                }
              }}
            />
            <TextField
              size="small"
              select
              label="Role"
              value={inviteRole}
              onChange={(event) => setInviteRole(event.target.value as Role)}
              sx={{ minWidth: 240 }}
            >
              {ROLES.map((entry) => (
                <MenuItem key={entry.value} value={entry.value}>
                  {entry.label}
                </MenuItem>
              ))}
            </TextField>
            <Button
              variant="contained"
              disabled={!canInvite}
              onClick={() => invite.mutate({ email: email.trim(), role: inviteRole })}
              sx={{ flexShrink: 0, height: 32 }}
            >
              {invite.isPending ? "Issuing…" : "Issue invite"}
            </Button>
          </Stack>
          <Typography
            sx={{
              mt: 1,
              fontSize: 11,
              color: emailInvalid ? colors.danger : "text.disabled",
            }}
          >
            {emailInvalid
              ? "That does not look like an email address."
              : `The invite grants ${inviteRole}: ${ROLES.find((entry) => entry.value === inviteRole)?.hint ?? ""}`}
          </Typography>
        </Paper>

        {invites.isError ? (
          <Alert severity="error">
            Outstanding invites could not be loaded.{" "}
            <Box component="span" sx={{ color: "text.secondary" }}>
              {errorMessage(invites.error)}
            </Box>
          </Alert>
        ) : invites.isLoading ? (
          <Skeleton variant="rounded" height={120} />
        ) : pending.length === 0 ? (
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
              No outstanding invites.
            </Typography>
            <Typography sx={{ mt: 0.5, fontSize: 11.5, color: "text.disabled" }}>
              Everyone who can reach this instance already has an account.
            </Typography>
          </Box>
        ) : (
          <Paper sx={{ overflow: "hidden" }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Email</TableCell>
                  <TableCell>Role</TableCell>
                  <TableCell>Issued</TableCell>
                  <TableCell>Expires</TableCell>
                  <TableCell align="right" />
                </TableRow>
              </TableHead>
              <TableBody>
                {pending.map((row) => (
                  <TableRow key={row.id} hover>
                    <TableCell>{row.email}</TableCell>
                    <TableCell sx={{ color: "text.secondary", fontSize: 11.5 }}>{row.role}</TableCell>
                    <TableCell sx={{ color: "text.secondary", whiteSpace: "nowrap" }}>
                      <Tooltip title={new Date(row.createdAt).toLocaleString()}>
                        <Box component="span">{formatRelative(row.createdAt)}</Box>
                      </Tooltip>
                    </TableCell>
                    <TableCell sx={{ color: "text.secondary", whiteSpace: "nowrap" }}>
                      <Tooltip title={new Date(row.expiresAt).toLocaleString()}>
                        <Box component="span">{untilLabel(row.expiresAt)}</Box>
                      </Tooltip>
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        color="inherit"
                        sx={{ minWidth: 0, px: 0.75, fontSize: 11 }}
                        disabled={revokeInvite.isPending && revokeInvite.variables === row.id}
                        onClick={() => revokeInvite.mutate(row.id)}
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        )}
        {revokeInvite.isError && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            The invite was not revoked. {errorMessage(revokeInvite.error)}
          </Alert>
        )}
      </Box>
    </Stack>
  );
}

function MemberRowView({
  member,
  isSelf,
  pending,
  onChange,
}: {
  member: MemberRow;
  isSelf: boolean;
  pending: boolean;
  onChange: (role: Role) => void;
}) {
  return (
    <TableRow hover sx={isSelf ? { "& td": { backgroundColor: `${colors.accentSoft}` } } : undefined}>
      <TableCell>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Tooltip
            title={
              member.lastLoginAt === null
                ? "Has never signed in on this instance."
                : `Last signed in ${new Date(member.lastLoginAt).toLocaleString()}.`
            }
          >
            <Box component="span">{member.email}</Box>
          </Tooltip>
          {isSelf && (
            <Chip
              size="small"
              label="you"
              variant="outlined"
              sx={{ height: 18, fontSize: 10, color: colors.accentText, borderColor: `${colors.accent}55` }}
            />
          )}
        </Stack>
      </TableCell>
      <TableCell sx={{ color: member.name ? "text.secondary" : "text.disabled" }}>
        {member.name ?? "—"}
      </TableCell>
      <TableCell>
        {/* Deliberately not disabled for the last admin: the server is the one
            that knows the count, and its 409 is shown above this table. A
            control that disappears teaches nothing. */}
        <Select
          size="small"
          variant="standard"
          disableUnderline
          value={member.role as Role}
          disabled={pending}
          onChange={(event) => onChange(event.target.value as Role)}
          sx={{
            fontSize: 11.5,
            minWidth: 92,
            color: member.role === "admin" ? colors.accentText : "text.primary",
            // A standard Select in a table row draws an underline that reads as
            // an editable text field; the chevron is the only affordance it needs.
            "&:before, &:after, &:hover:before": { display: "none" },
            "& .MuiSelect-select": { py: 0.25, pr: "24px !important" },
          }}
          slotProps={{ input: { "aria-label": `Role for ${member.email}` } }}
        >
          {ROLES.map((entry) => (
            <MenuItem key={entry.value} value={entry.value}>
              {entry.label}
            </MenuItem>
          ))}
        </Select>
      </TableCell>
      <TableCell sx={{ color: "text.secondary", whiteSpace: "nowrap" }}>
        <Tooltip title={new Date(member.createdAt).toLocaleString()}>
          <Box component="span">{formatRelative(member.createdAt)}</Box>
        </Tooltip>
      </TableCell>
    </TableRow>
  );
}

interface IssuedInvite {
  token: string;
  url: string;
  expiresAt: number;
  email: string;
  role: Role;
}

/** The link, once — with the two facts a person sending it needs. */
function IssuedPanel({ issued, onDismiss }: { issued: IssuedInvite; onDismiss: () => void }) {
  return (
    <Paper
      sx={{
        border: `1px solid ${colors.accent}55`,
        bgcolor: colors.accentSoft,
        p: 2,
        mb: 2,
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1.5 }}>
        <Typography sx={{ ...labelCaps, color: colors.accentText }}>
          Invite ready to send
        </Typography>
        <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
          {issued.email} · {issued.role}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Button size="small" color="inherit" onClick={onDismiss} sx={{ minWidth: 0, px: 0.75, fontSize: 11 }}>
          Dismiss
        </Button>
      </Stack>

      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
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
          {issued.url}
        </Box>
        <CopyLink url={issued.url} />
      </Stack>

      <Typography sx={{ mt: 1.5, fontSize: 11.5, color: "text.secondary" }}>
        Single use, expires {new Date(issued.expiresAt).toLocaleString()} — seven
        days. No email is sent from this instance, so delivering this link is a
        manual step. It cannot be shown again: the token is stored hashed, and
        re-issuing is the only way to get a fresh URL.
      </Typography>
    </Paper>
  );
}

/** Clipboard, quietly: a refused copy is not a page error, the URL is selectable. */
function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip title={copied ? "Copied" : "Copy invite link"}>
      <IconButton
        size="small"
        aria-label="Copy invite link"
        onClick={() => {
          void copyText(url).then((ok) => {
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

/** An invite is outstanding until it is accepted or its seven days run out. */
function isOutstanding(row: InviteRow): boolean {
  return row.acceptedAt === null && row.expiresAt > Date.now();
}

/**
 * A countdown, not `formatRelative`.
 *
 * That helper reads a timestamp in the past and answers "just now" for anything
 * in the future, which for an invite would print "expires in just now" for six
 * of its seven days. An expiry is a deadline, so it is phrased as one.
 */
function untilLabel(timestamp: number): string {
  const delta = timestamp - Date.now();
  if (delta <= 0) return "expired";
  const hours = Math.round(delta / 3_600_000);
  if (hours < 48) return `in ${Math.max(1, hours)}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function SectionTitle({ children }: { children: string }) {
  return (
    <Typography sx={{ ...labelCaps, mb: 1.25, mt: 0.5, display: "block" }}>{children}</Typography>
  );
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
