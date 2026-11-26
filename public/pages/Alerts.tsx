/**
 * Alerts — the rules, what they measure right now, and what fired.
 *
 * This is the only page in the product backed by something running on a clock:
 * the evaluator measures every enabled rule once a minute, inside this process,
 * and writes a row per transition. A page that only listed rules would be a
 * settings screen; what makes it useful is that `rules()` recomputes the current
 * value on read, so the table answers "is it close to firing?" without waiting
 * for the next tick — and `Check now` runs the very same function the timer runs.
 *
 * Three honesty rules shape the layout:
 *
 *   * **No data is not OK.** `current.value === null` prints `—`, never `0`. A
 *     rule that cannot measure (no traffic, a scope that never reported, a log
 *     pattern shorter than three characters) is `no-data`, and the evaluator
 *     neither opens nor closes an incident for it — resolving an incident
 *     because telemetry stopped is exactly backwards.
 *   * **Muted is not resolved.** Quiet hours and a manual mute still record the
 *     firing; they only skip delivery. The incident stays open with a `muted`
 *     badge, and the history shows the row marked instead of hiding it.
 *   * **The unit is part of the value.** `0.05` on a ratio metric is 5%, not
 *     "0.05 requests". Every number on this page is printed through the metric's
 *     unit, and the form converts back (a ratio threshold is typed in percent,
 *     stored as a fraction) so the two never disagree.
 *
 * Email is offered as a channel and is **not delivered**: this build has no SMTP
 * client, so the evaluator writes `skipped: no SMTP client` into the event's
 * delivery record. The page says so beside the picker and in the history rather
 * than letting somebody configure mail and wait for a message that never comes.
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
  FormControlLabel,
  ListSubheader,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { Check, Plus } from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import {
  alerts,
  api,
  type AlertEventRow,
  type AlertIncidentRow,
  type AlertMetricName,
  type AlertRuleInput,
  type AlertRuleRow,
  type AlertSeverity,
} from "../api";
import { ContentCard } from "../components/cards/MetricCard";
import { PageHeader } from "../components/shell/PageHeader";
import { useLiveInterval, useShell } from "../components/shell";
import { formatNumber, formatPercent, formatRelative } from "../format";
import { colors, fontMono, labelCaps, tabular } from "../theme";

export interface AlertsProps {
  /** The shell's scope. It only pre-fills the new rule's application. */
  appId?: string;
}

/**
 * Rules are project-wide, not scoped: a rule may watch every application or one
 * of them, and the top bar's `?app=` is a reading scope, not a rule scope. So the
 * page shows them all, and the shell's scope is offered as the default
 * application when creating one.
 */
export function Alerts({ appId }: AlertsProps) {
  return <AlertsView defaultApplicationId={appId ?? ""} />;
}

/* -------------------------------------------------------------------------
 * The metric vocabulary.
 *
 * The server owns it (`METRIC_UNITS` / `ALERT_METRICS` in
 * `modules/alerts/service.ts`) and is the only runtime copy; this table is the
 * browser's label/unit/scope mirror. It is duplicated rather than fetched
 * because the picker has to render before anyone asks the server anything, and
 * because a new metric that the evaluator cannot measure is a server bug, not a
 * page feature.
 * ---------------------------------------------------------------------- */

type Unit = "ratio" | "ms" | "per_min" | "count" | "minutes" | "percent" | "bad";
type ScopeKey = "operationId" | "queueName" | "customMetricName" | "logPattern" | "sloId";

interface MetricInfo {
  /** What the picker calls it. */
  label: string;
  /** The picker's group heading. */
  group: string;
  unit: Unit;
  /** The one scope key the evaluator honours for this metric, if any. */
  scope?: ScopeKey;
  /** One clause: what the number means. Shown under the picker. */
  hint: string;
}

const METRICS: Record<string, MetricInfo> = {
  "request.error_rate": {
    label: "Error rate",
    group: "Requests",
    unit: "ratio",
    scope: "operationId",
    hint: "Failed requests ÷ all requests in the window. 5% is 0.05.",
  },
  "request.p95": {
    label: "Request p95",
    group: "Requests",
    unit: "ms",
    scope: "operationId",
    hint: "The 95th percentile of request duration, from merged histograms.",
  },
  "request.avg": {
    label: "Request average",
    group: "Requests",
    unit: "ms",
    scope: "operationId",
    hint: "Mean request duration in the window.",
  },
  "request.throughput": {
    label: "Request throughput",
    group: "Requests",
    unit: "per_min",
    scope: "operationId",
    hint: "Requests per minute. Requests only — a cron job is not a request.",
  },
  "job.failure_rate": {
    label: "Job failure rate",
    group: "Jobs",
    unit: "ratio",
    scope: "queueName",
    hint: "Failed runs ÷ runs started in the window.",
  },
  "job.p95_wait": {
    label: "Job p95 queue wait",
    group: "Jobs",
    unit: "ms",
    scope: "queueName",
    hint: "How long the slowest 5% of runs waited before a worker picked them up — the backlog signal.",
  },
  "job.throughput": {
    label: "Job throughput",
    group: "Jobs",
    unit: "per_min",
    scope: "queueName",
    hint: "Job runs started per minute.",
  },
  "absence.requests": {
    label: "Silent requests",
    group: "Silence",
    unit: "minutes",
    hint: "Minutes since the last request. Fires on silence — the only honest way to alert on missing data.",
  },
  "absence.jobs": {
    label: "Silent jobs",
    group: "Silence",
    unit: "minutes",
    hint: "Minutes since the last job run. A queue that stops being consumed looks healthy on every other metric.",
  },
  "error.new": {
    label: "New error groups",
    group: "Errors",
    unit: "count",
    hint: "Error groups first seen inside the window.",
  },
  "error.unhandled": {
    label: "Error occurrences",
    group: "Errors",
    unit: "count",
    hint: "Error groups seen inside the window. Every occurrence counts as unhandled in this build.",
  },
  "log.pattern": {
    label: "Log matches",
    group: "Logs",
    unit: "count",
    scope: "logPattern",
    hint: "Log lines matching a pattern (and optional levels) inside the window.",
  },
  "custom.metric": {
    label: "Custom metric average",
    group: "Custom",
    unit: "count",
    scope: "customMetricName",
    hint: "The mean of the named metric's points in the window.",
  },
  "runtime.event_loop": {
    label: "Event loop lag",
    group: "Runtime",
    unit: "ms",
    hint: "Average event-loop lag from runtime samples.",
  },
  "runtime.cpu": {
    label: "CPU",
    group: "Runtime",
    unit: "percent",
    hint: "Average CPU percentage from runtime samples.",
  },
  "runtime.memory": {
    label: "Heap used",
    group: "Runtime",
    unit: "count",
    hint: "Average heap used, in bytes, from runtime samples.",
  },
  "slo.burn": {
    label: "SLO burn rate",
    group: "SLO",
    unit: "bad",
    scope: "sloId",
    hint: "The objective's burn rate at the window closest to the rule's. 1× spends the budget exactly on schedule.",
  },
};

/** Picker order. Groups are the reader's question, not the evaluator's switch. */
const METRIC_GROUPS = ["Requests", "Jobs", "Silence", "Errors", "Logs", "Custom", "Runtime", "SLO"] as const;

const METRIC_OPTIONS: Array<{ group: string; metrics: string[] }> = METRIC_GROUPS.map((group) => ({
  group,
  metrics: Object.entries(METRICS)
    .filter(([, info]) => info.group === group)
    .map(([metric]) => metric),
}));

function metricInfo(metric: string): MetricInfo {
  return METRICS[metric] ?? { label: metric, group: "Other", unit: "count", hint: "" };
}

/** The windows the server accepts, in seconds. Anything else is a 422. */
const WINDOWS = [300, 600, 900, 1800, 3600, 10800] as const;

function windowLabel(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

function unitSuffix(unit: Unit): string {
  switch (unit) {
    case "ratio":
      return "%";
    case "ms":
      return "ms";
    case "per_min":
      return "per minute";
    case "count":
      return "count";
    case "minutes":
      return "minutes";
    case "percent":
      return "%";
    case "bad":
      return "× budget";
    default:
      return "";
  }
}

/**
 * Print a measured value in its unit.
 *
 * `null` is "cannot be measured", and it renders as `—` everywhere — never as
 * `0`, which would read as "measured, and fine".
 */
function formatUnitValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  switch (unit) {
    case "ratio":
      // 0.05 → 5.0%; a sub-1% rate keeps its digits so 0.4% does not read as 0%.
      return formatPercent(value, Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 3 : 1);
    case "ms":
      return value < 1 ? `${(value * 1000).toFixed(0)}µs` : value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(2)}s`;
    case "per_min":
      return `${value.toFixed(value < 10 ? 1 : 0)}/min`;
    case "count":
      return formatNumber(value);
    case "minutes":
      return `${value.toFixed(value < 10 ? 1 : 0)} min`;
    case "percent":
      return `${value.toFixed(0)}%`;
    case "bad":
      return `${value.toFixed(2)}×`;
    default:
      return String(value);
  }
}

function comparatorSymbol(comparator: string): string {
  return comparator === "below" ? "<" : ">";
}

const SEVERITY_COLOR: Record<string, string> = {
  low: colors.faint,
  medium: colors.muted,
  high: colors.warn,
  critical: colors.danger,
};

const STATE_META: Record<string, { label: string; color: string; hint: string }> = {
  firing: {
    label: "firing",
    color: colors.danger,
    hint: "The metric crossed the threshold and an incident is open below.",
  },
  muted: {
    label: "muted",
    color: colors.warn,
    hint: "Firing, but quiet hours or a manual mute made the evaluator skip delivery. The incident is still open — muted is not resolved.",
  },
  ok: {
    label: "ok",
    color: colors.ok,
    hint: "Measured in this window and below the threshold.",
  },
  "no-data": {
    label: "no data",
    color: colors.faint,
    hint: "Nothing to measure in this window. A metric with no data never opens or closes an incident — not zero, and not OK. Silence is its own metric (`absence.requests` / `absence.jobs`).",
  },
  paused: {
    label: "paused",
    color: colors.faint,
    hint: "The evaluator skips a paused rule and keeps its history. An open incident stays open — pausing does not resolve it.",
  },
};

/** A shape for the rule's JSONB scope; the server types it as `unknown`. */
interface RuleScope {
  operationId?: string;
  queueName?: string;
  customMetricName?: string;
  logPattern?: string;
  logLevels?: string[];
  sloId?: string;
}

interface DeliveryEntry {
  channel: string;
  status: "sent" | "skipped" | "failed" | string;
  reason?: string;
}

/* ---------------------------------------------------------------------- */

function AlertsView({ defaultApplicationId }: { defaultApplicationId: string }) {
  const client = useQueryClient();
  const refetchInterval = useLiveInterval();
  const { apps } = useShell();
  const [failure, setFailure] = useState<string | null>(null);
  const [checked, setChecked] = useState<
    { at: number; summary: Awaited<ReturnType<typeof alerts.evaluate>> } | null
  >(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ rule: AlertRuleRow | null } | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Same keys the sidebar badge reads, so one invalidation refreshes the badge
  // too. The badge is `["alerts", "incidents"]` — the count people see before
  // they open this page must not lag behind what the page says.
  const rulesQuery = useQuery({
    queryKey: ["alerts", "rules"],
    queryFn: alerts.rules,
    refetchInterval,
  });
  const incidentsQuery = useQuery({
    queryKey: ["alerts", "incidents"],
    queryFn: alerts.incidents,
    refetchInterval,
  });
  const eventsQuery = useQuery({
    queryKey: ["alerts", "events"],
    queryFn: () => alerts.events(100),
    refetchInterval,
  });
  // For `slo.burn` the scope is an objective id, and an id is unreadable; the
  // same query also names the objective in the rules table. Unscoped is every
  // objective in the project, which is exactly the set a rule may point at.
  const slosQuery = useQuery({ queryKey: ["slos", ""], queryFn: () => api.slos("") });

  const invalidate = () => void client.invalidateQueries({ queryKey: ["alerts"] });

  const evaluate = useMutation({
    mutationFn: alerts.evaluate,
    onSuccess: (summary) => {
      setChecked({ at: Date.now(), summary });
      setFailure(null);
      invalidate();
    },
    onError: (error) => setFailure(errorMessage(error)),
  });

  const toggle = useMutation({
    mutationFn: ({ rule, enabled }: { rule: AlertRuleRow; enabled: boolean }) =>
      alerts.updateRule(rule.id, { enabled }),
    onSuccess: () => {
      setFailure(null);
      invalidate();
    },
    onError: (error) => setFailure(errorMessage(error)),
  });

  const mute = useMutation({
    mutationFn: ({ rule, minutes }: { rule: AlertRuleRow; minutes: number | null }) =>
      alerts.muteRule(rule.id, minutes),
    onSuccess: () => {
      setFailure(null);
      invalidate();
    },
    onError: (error) => setFailure(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (rule: AlertRuleRow) => alerts.deleteRule(rule.id),
    onSuccess: () => {
      setDeletingId(null);
      setFailure(null);
      invalidate();
    },
    onError: (error) => setFailure(errorMessage(error)),
  });

  const rules = rulesQuery.data?.items ?? [];
  const incidents = incidentsQuery.data?.items ?? [];
  const events = eventsQuery.data?.items ?? [];
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const appName = new Map(apps.map((entry) => [entry.id, entry.name]));
  const sloName = new Map((slosQuery.data?.items ?? []).map((slo) => [slo.id, slo.name ?? slo.operationId]));
  const paused = rules.filter((rule) => !rule.enabled).length;

  // A click from an incident to its rule scrolls the table row into view and
  // tints it for a moment. The highlight clears itself so the table does not
  // look selected a minute later.
  useEffect(() => {
    if (!focusedId) return;
    const timer = setTimeout(() => setFocusedId(null), 2400);
    return () => clearTimeout(timer);
  }, [focusedId]);

  const revealRule = (ruleId: string) => {
    setFocusedId(ruleId);
    requestAnimationFrame(() => {
      document.getElementById(`rule-${ruleId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Alerts"
        description={
          "A rule measures one metric over a window and fires when it crosses a line. The evaluator runs once a minute inside this collector — “Check now” runs the same function immediately."
        }
        actions={
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
            <Stat
              label="Firing"
              value={String(incidents.length)}
              tone={incidents.length > 0 ? "danger" : "default"}
              hint="Open incidents: firing and not resolved. A muted firing is still an open incident."
            />
            <Stat label="Rules" value={String(rules.length)} hint="Every rule in the project, paused ones included." />
            <Stat
              label="Paused"
              value={String(paused)}
              hint="Rules the evaluator skips. They keep their history, and an incident they already opened stays open."
            />
            <Button
              variant="contained"
              startIcon={<Plus size={13} weight="bold" />}
              onClick={() => setDialog({ rule: null })}
            >
              New rule
            </Button>
            <Button
              variant="outlined"
              disabled={evaluate.isPending}
              onClick={() => evaluate.mutate()}
            >
              {evaluate.isPending ? "Checking…" : "Check now"}
            </Button>
          </Stack>
        }
      />

      {failure && (
        <Alert severity="warning" onClose={() => setFailure(null)}>
          {failure}
        </Alert>
      )}

      {/* The check's own summary, not a toast: it says what the evaluator did, so
          "nothing happened" is distinguishable from "the call failed". */}
      {checked && (
        <Alert severity={checked.summary.opened > 0 ? "warning" : "info"} onClose={() => setChecked(null)}>
          Ran at {new Date(checked.at).toLocaleTimeString()} — {checked.summary.evaluated}{" "}
          {checked.summary.evaluated === 1 ? "rule" : "rules"} evaluated,{" "}
          <strong>{checked.summary.opened} opened</strong>,{" "}
          <strong>{checked.summary.resolved} resolved</strong>,{" "}
          <strong>{checked.summary.muted} muted</strong>.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            A rule with no data writes nothing in either direction.
          </Box>
        </Alert>
      )}

      {rulesQuery.isError && (
        <Alert severity="error">
          The rule list could not be loaded.{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {errorMessage(rulesQuery.error)}
          </Box>
        </Alert>
      )}

      {/* 1 — open incidents. The most important thing on the page, so it is
             first and it never hides behind a tab.

             Empty is rendered as its own card rather than through ContentCard's
             `empty` prop: "nothing is firing" is a good outcome and must not
             borrow the neutral grey of "nothing here". */}
      {incidents.length > 0 || incidentsQuery.isLoading || incidentsQuery.isError ? (
        <ContentCard
          label="Open incidents"
          actions={
            incidents.length > 0 ? (
              <Typography sx={{ fontSize: 11, color: "text.disabled", ...tabular }}>
                {incidents.length} open
              </Typography>
            ) : null
          }
          loading={incidentsQuery.isLoading}
          error={incidentsQuery.error}
          bodySx={{ px: 0, pb: incidents.length === 0 ? 1.75 : 0 }}
        >
          <Stack divider={<Box sx={{ borderTop: `1px solid ${colors.border}` }} />}>
            {incidents.map((incident) => (
              <IncidentRow
                key={incident.id}
                incident={incident}
                rule={rulesById.get(incident.ruleId) ?? null}
                applicationName={
                  incident.applicationId ? appName.get(incident.applicationId) ?? null : null
                }
                onReveal={revealRule}
              />
            ))}
          </Stack>
        </ContentCard>
      ) : (
        <Paper sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 2 }}>
          <Check size={18} color={colors.ok} weight="bold" />
          <Box>
            <Typography sx={{ fontSize: 13, fontWeight: 600, color: colors.text }}>
              Nothing is firing.
            </Typography>
            <Typography sx={{ fontSize: 11.5, color: "text.disabled" }}>
              Every enabled rule is below its threshold, muted, or has nothing to measure in its
              window. A quiet page is the normal state — the history below is where the last
              transition is.
            </Typography>
          </Box>
        </Paper>
      )}

      {/* 2 — the rules table. */}
      <Panel
        title="Rules"
        caption={
          rules.length > 0
            ? `${rules.length} rule${rules.length === 1 ? "" : "s"} · ${paused} paused`
            : undefined
        }
        actions={
          <Button size="small" variant="outlined" startIcon={<Plus size={12} />} onClick={() => setDialog({ rule: null })}>
            New rule
          </Button>
        }
      >
        {rulesQuery.isLoading ? (
          <Box sx={{ p: 2 }}>
            <Stack spacing={1}>
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} variant="text" height={28} />
              ))}
            </Stack>
          </Box>
        ) : rules.length === 0 ? (
          <EmptyState
            title="No rules yet."
            hint={
              "Start with New rule. A fresh install seeds two — “Error rate above 5%” and “A job queue stopped being consumed” — which is the shape every team writes first; if they are gone, they were deleted here."
            }
          />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>State</TableCell>
                <TableCell>
                  <Tooltip title="The metric's value in the rule's window, recomputed when this page loads, next to the line it is compared with. An anomaly rule has no fixed line: it compares with the mean of the previous six windows.">
                    <Box component="span" sx={{ borderBottom: `1px dotted ${colors.borderStrong}` }}>
                      Current vs threshold
                    </Box>
                  </Tooltip>
                </TableCell>
                <TableCell>Window</TableCell>
                <TableCell>Severity</TableCell>
                <TableCell>Channels</TableCell>
                <TableCell>Last change</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rules.map((rule) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  applicationName={
                    rule.applicationId ? appName.get(rule.applicationId) ?? null : null
                  }
                  sloName={
                    rule.scope && (rule.scope as RuleScope).sloId
                      ? sloName.get((rule.scope as RuleScope).sloId!) ?? null
                      : null
                  }
                  highlighted={focusedId === rule.id}
                  deleting={deletingId === rule.id}
                  busy={toggle.isPending || mute.isPending || remove.isPending}
                  onToggle={(enabled) => toggle.mutate({ rule, enabled })}
                  onMute={() =>
                    mute.mutate({
                      rule,
                      minutes: rule.mutedUntil && rule.mutedUntil > Date.now() ? null : 60,
                    })
                  }
                  onEdit={() => setDialog({ rule })}
                  onAskDelete={() => setDeletingId(rule.id)}
                  onCancelDelete={() => setDeletingId(null)}
                  onDelete={() => remove.mutate(rule)}
                />
              ))}
            </TableBody>
          </Table>
        )}
        {/* The detection sentence, once, for the whole table: it is the one thing
            about the model a reader cannot infer from the columns. */}
        <Typography sx={{ px: 2, pt: 1.25, pb: 1.5, fontSize: 11, color: "text.disabled" }}>
          <strong>threshold</strong> compares the window's value with the rule's threshold.{" "}
          <strong>anomaly</strong> compares it with the mean of the previous six windows and needs{" "}
          <strong>sigma</strong> standard deviations — with fewer than two baseline windows it stays
          quiet instead of firing on its own first measurement. Email is not delivered in this
          build (no SMTP client): a rule that asks for it records{" "}
          <Box component="span" sx={{ fontFamily: fontMono }}>
            skipped: no SMTP client
          </Box>{" "}
          in its delivery history, and the event is still recorded in-app.
        </Typography>
      </Panel>

      {/* 3 — history: transitions, not snapshots. */}
      <Panel
        title="History"
        caption={events.length > 0 ? `last ${events.length} transitions` : undefined}
      >
        {eventsQuery.isLoading ? (
          <Box sx={{ p: 2 }}>
            <Stack spacing={1}>
              {[0, 1, 2, 3, 4].map((index) => (
                <Skeleton key={index} variant="text" height={26} />
              ))}
            </Stack>
          </Box>
        ) : eventsQuery.isError ? (
          <Box sx={{ p: 2 }}>
            <Alert severity="error">
              The history could not be loaded.{" "}
              <Box component="span" sx={{ color: "text.secondary" }}>
                {errorMessage(eventsQuery.error)}
              </Box>
            </Alert>
          </Box>
        ) : events.length === 0 ? (
          <EmptyState
            title="No transitions yet."
            hint="The evaluator writes one row when a rule starts firing and another when it resolves. A rule that stays quiet — or has no data — writes nothing, so an empty history is not an error."
          />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Time</TableCell>
                <TableCell>Rule</TableCell>
                <TableCell>Transition</TableCell>
                <TableCell align="right">Value</TableCell>
                <TableCell>Delivery</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {events.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      {dialog && (
        <RuleDialog
          // Keyed so reopening starts from the rule's current values instead of
          // the previous edit's leftovers.
          key={dialog.rule?.id ?? "new"}
          rule={dialog.rule}
          applications={apps}
          defaultApplicationId={dialog.rule?.applicationId ?? defaultApplicationId}
          slos={slosQuery.data?.items ?? []}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            setFailure(null);
            invalidate();
          }}
          onFailure={(message) => setFailure(message)}
        />
      )}
    </Stack>
  );
}

/* ---------------------------------------------------------------------- */

function IncidentRow({
  incident,
  rule,
  applicationName,
  onReveal,
}: {
  incident: AlertIncidentRow;
  /** The rule itself, for the threshold and unit the incident row does not carry. */
  rule: AlertRuleRow | null;
  applicationName: string | null;
  onReveal: (ruleId: string) => void;
}) {
  const unit = rule?.current.unit ?? metricInfo(incident.metric).unit;
  const severity = incident.severity ?? rule?.severity ?? "medium";
  const color = SEVERITY_COLOR[severity] ?? colors.muted;
  const elapsed = incident.startedAt ? Date.now() - incident.startedAt : null;

  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{ px: 2, py: 1.25, alignItems: "center", flexWrap: "wrap" }}
    >
      <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", minWidth: 82 }}>
        <Box sx={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: color }} />
        <Typography sx={{ ...labelCaps, color }}>{severity}</Typography>
      </Stack>

      <Box sx={{ minWidth: 0, flex: "1 1 260px" }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{incident.ruleName}</Typography>
          {incident.muted && (
            <Tooltip title="Recorded with muted: true and delivery skipped. Quiet hours or a manual mute silenced it — the incident is still open, because muted is not resolved.">
              <Chip
                size="small"
                variant="outlined"
                label="muted"
                sx={{ color: colors.warn, borderColor: `${colors.warn}66`, bgcolor: `${colors.warn}14`, cursor: "help" }}
              />
            </Tooltip>
          )}
          {rule && !rule.enabled && (
            <Chip size="small" variant="outlined" label="paused rule" sx={{ color: colors.faint }} />
          )}
        </Stack>
        <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
          {applicationName ? `${applicationName} · ` : ""}
          {metricInfo(incident.metric).label}
          {rule
            ? ` · ${comparatorSymbol(rule.comparator)} ${formatUnitValue(rule.threshold, rule.current.unit)} over ${windowLabel(rule.windowS)}`
            : ""}
        </Typography>
      </Box>

      <Box sx={{ textAlign: "right", minWidth: 96 }}>
        <Typography sx={{ fontSize: 16, fontWeight: 600, ...tabular }}>
          {formatUnitValue(incident.value, unit)}
        </Typography>
        <Tooltip
          title={
            elapsed === null
              ? "No start time recorded."
              : `Started ${new Date(incident.startedAt).toLocaleString()} — firing for ${Math.round(elapsed / 60000)} minutes.`
          }
        >
          <Typography sx={{ fontSize: 10.5, color: "text.disabled", ...tabular, cursor: "help" }}>
            firing {elapsed === null ? "—" : elapsedLabel(elapsed)}
          </Typography>
        </Tooltip>
      </Box>

      <Button size="small" color="inherit" onClick={() => onReveal(incident.ruleId)}>
        Rule
      </Button>
    </Stack>
  );
}

function RuleRow({
  rule,
  applicationName,
  sloName,
  highlighted,
  deleting,
  busy,
  onToggle,
  onMute,
  onEdit,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  rule: AlertRuleRow;
  applicationName: string | null;
  sloName: string | null;
  highlighted: boolean;
  deleting: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onMute: () => void;
  onEdit: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const info = metricInfo(rule.metric);
  const scope = scopeSummary(rule, sloName);
  const muted = rule.mutedUntil !== null && rule.mutedUntil > Date.now();
  const state = rule.enabled ? rule.state : "paused";
  const severityColor = SEVERITY_COLOR[rule.severity] ?? colors.muted;

  return (
    <TableRow id={`rule-${rule.id}`} sx={highlighted ? { backgroundColor: colors.accentSoft } : undefined}>
      <TableCell sx={{ maxWidth: 340 }}>
        <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{rule.name}</Typography>
        <Typography sx={{ fontSize: 10.5, color: "text.disabled" }}>
          {info.label}
          {scope ? ` · ${scope}` : ""}
          {applicationName ? ` · ${applicationName}` : " · all applications"}
          {rule.detection === "anomaly" ? ` · anomaly at ${rule.sigma ?? 3.5}σ` : ""}
        </Typography>
      </TableCell>

      <TableCell>
        <StateChip state={state} />
        {muted && (
          <Typography sx={{ mt: 0.5, fontSize: 10, color: colors.warn, whiteSpace: "nowrap" }}>
            muted until{" "}
            {rule.mutedUntil
              ? new Date(rule.mutedUntil).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "—"}
          </Typography>
        )}
      </TableCell>

      <TableCell>
        <Stack direction="row" spacing={0.5} sx={{ alignItems: "baseline", ...tabular }}>
          <Typography
            sx={{
              fontSize: 13,
              fontWeight: 600,
              color: rule.current.value === null ? "text.disabled" : "text.primary",
            }}
          >
            {formatUnitValue(rule.current.value, rule.current.unit)}
          </Typography>
          {rule.detection === "anomaly" ? (
            <Tooltip title="Anomaly rules compare with the mean of the previous six windows, so there is no fixed number to cross. The threshold on the rule still names which side is bad.">
              <Typography sx={{ fontSize: 10.5, color: "text.disabled", cursor: "help" }}>
                vs 6-window mean
              </Typography>
            </Tooltip>
          ) : (
            <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
              {comparatorSymbol(rule.comparator)} {formatUnitValue(rule.threshold, rule.current.unit)}
            </Typography>
          )}
        </Stack>
        <Typography
          sx={{ fontSize: 10, color: "text.disabled", ...tabular }}
          title="How many observations the value is based on. Zero samples with a value never happens; no samples means no data."
        >
          {rule.current.value === null
            ? "nothing measured in this window"
            : `${formatNumber(rule.current.samples)} samples`}
        </Typography>
      </TableCell>

      <TableCell sx={{ ...tabular, fontSize: 12 }}>{windowLabel(rule.windowS)}</TableCell>

      <TableCell>
        <Stack direction="row" spacing={0.6} sx={{ alignItems: "center" }}>
          <Box sx={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: severityColor }} />
          <Typography sx={{ ...labelCaps, color: severityColor }}>{rule.severity}</Typography>
        </Stack>
      </TableCell>

      <TableCell sx={{ maxWidth: 220 }}>
        <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>{channelsSummary(rule.channels)}</Typography>
        {quietHoursLabel(rule.quietHours) && (
          <Typography sx={{ fontSize: 10, color: "text.disabled" }}>
            quiet {quietHoursLabel(rule.quietHours)}
          </Typography>
        )}
      </TableCell>

      <TableCell>
        <Tooltip title={new Date(rule.updatedAt).toLocaleString()}>
          <Typography sx={{ fontSize: 11.5, color: "text.secondary", cursor: "help" }}>
            {formatRelative(rule.updatedAt)}
          </Typography>
        </Tooltip>
      </TableCell>

      <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
        <Stack
          direction="row"
          spacing={0.25}
          sx={{ alignItems: "center", justifyContent: "flex-end", flexWrap: "nowrap" }}
        >
          {/* The switch stays put while a delete is being confirmed: the whole
              row must not lose its layout because one button was pressed. */}
          <Tooltip
            title={
              rule.enabled
                ? "Pause: the evaluator skips this rule. Its history stays and an open incident stays open — pausing does not resolve it."
                : "Resume: the rule is evaluated again on the next tick, and on Check now."
            }
          >
            <Switch
              size="small"
              checked={rule.enabled}
              disabled={busy}
              onChange={(event) => onToggle(event.target.checked)}
              slotProps={{ input: { "aria-label": `${rule.enabled ? "Pause" : "Resume"} ${rule.name}` } }}
            />
          </Tooltip>
          {deleting ? (
            <>
              <Tooltip title="The rule and its event history are removed; an open incident disappears with it. Pause instead if you want to keep the history.">
                <Typography sx={{ ml: 0.5, fontSize: 10.5, color: colors.danger, cursor: "help" }}>
                  Delete?
                </Typography>
              </Tooltip>
              <Button size="small" color="error" disabled={busy} onClick={onDelete} sx={{ minWidth: 0, px: 0.75 }}>
                Yes
              </Button>
              <Button size="small" color="inherit" onClick={onCancelDelete} sx={{ minWidth: 0, px: 0.75 }}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                size="small"
                color="inherit"
                onClick={onMute}
                disabled={busy}
                sx={{ minWidth: 0, px: 0.75, whiteSpace: "nowrap" }}
              >
                {muted ? "Unmute" : "Mute 1h"}
              </Button>
              <Button size="small" color="inherit" onClick={onEdit} sx={{ minWidth: 0, px: 0.75, whiteSpace: "nowrap" }}>
                Edit
              </Button>
              <Button size="small" color="inherit" onClick={onAskDelete} sx={{ minWidth: 0, px: 0.75, whiteSpace: "nowrap" }}>
                Delete
              </Button>
            </>
          )}
        </Stack>
      </TableCell>
    </TableRow>
  );
}

function EventRow({ event }: { event: AlertEventRow }) {
  const unit = eventPayloadUnit(event) ?? metricInfo(event.metric).unit;
  const delivery = deliveryEntries(event.payload);
  const resolved = event.state === "resolved";
  const transitionColor = resolved ? colors.ok : event.muted ? colors.warn : colors.danger;

  return (
    <TableRow>
      <TableCell sx={{ whiteSpace: "nowrap" }}>
        <Tooltip title={new Date(event.startedAt).toLocaleString()}>
          <Typography sx={{ fontSize: 11.5, color: "text.secondary", cursor: "help" }}>
            {formatRelative(event.startedAt)}
          </Typography>
        </Tooltip>
      </TableCell>
      <TableCell>
        <Typography sx={{ fontSize: 12 }}>{event.ruleName}</Typography>
        <Typography sx={{ fontSize: 10, color: "text.disabled" }}>{metricInfo(event.metric).label}</Typography>
      </TableCell>
      <TableCell>
        <Stack direction="row" spacing={0.6} sx={{ alignItems: "center" }}>
          <Box sx={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: transitionColor }} />
          <Typography sx={{ ...labelCaps, color: transitionColor }}>{event.state}</Typography>
          {event.muted && (
            <Tooltip title="This firing happened during quiet hours or a manual mute: delivery was skipped and the incident was still recorded. Muted is not resolved.">
              <Chip
                size="small"
                variant="outlined"
                label="muted"
                sx={{ color: colors.warn, borderColor: `${colors.warn}66`, cursor: "help" }}
              />
            </Tooltip>
          )}
        </Stack>
      </TableCell>
      <TableCell align="right" sx={{ ...tabular, fontSize: 12 }}>
        {formatUnitValue(event.value, unit)}
      </TableCell>
      <TableCell sx={{ maxWidth: 360 }}>
        <DeliverySummary entries={delivery} muted={event.muted} resolved={resolved} />
      </TableCell>
    </TableRow>
  );
}

function DeliverySummary({
  entries,
  muted,
  resolved,
}: {
  entries: DeliveryEntry[];
  muted: boolean;
  resolved: boolean;
}) {
  if (muted) {
    return (
      <Typography sx={{ fontSize: 11, color: colors.warn }}>
        none — muted, delivery skipped
      </Typography>
    );
  }
  if (entries.length === 0) {
    return (
      <Typography sx={{ fontSize: 11, color: "text.disabled" }}>
        {resolved ? "— (a resolution notifies nobody)" : "— (no delivery recorded)"}
      </Typography>
    );
  }
  return (
    <Stack spacing={0.25}>
      {entries.map((entry, index) => (
        <Typography
          key={`${entry.channel}-${index}`}
          sx={{
            fontSize: 11,
            color:
              entry.status === "failed"
                ? colors.danger
                : entry.status === "skipped"
                  ? colors.warn
                  : "text.secondary",
          }}
        >
          {entry.channel} · {entry.status}
          {entry.reason ? ` — ${entry.reason}` : ""}
        </Typography>
      ))}
    </Stack>
  );
}

/* ---------------------------------------------------------------------- */

interface RuleForm {
  name: string;
  description: string;
  metric: string;
  comparator: "above" | "below";
  threshold: string;
  windowS: string;
  detection: "threshold" | "anomaly";
  sigma: string;
  severity: AlertSeverity;
  applicationId: string;
  operationId: string;
  queueName: string;
  customMetricName: string;
  logPattern: string;
  logLevels: string[];
  channelType: "in-app" | "webhook" | "slack" | "email";
  webhookUrl: string;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  quietTimezone: string;
  sloId: string;
}

const LOG_LEVELS = ["fatal", "error", "warn", "log", "debug", "verbose"] as const;

function initialForm(rule: AlertRuleRow | null, applicationId: string): RuleForm {
  const scope = (rule?.scope ?? {}) as RuleScope;
  const channels = Array.isArray(rule?.channels) ? (rule?.channels as Array<{ type?: string; url?: string }>) : [];
  const channel = channels[0];
  const quiet = (rule?.quietHours ?? null) as { start?: string; end?: string; timezone?: string } | null;
  const info = metricInfo(rule?.metric ?? "request.error_rate");
  return {
    name: rule?.name ?? "",
    description: rule?.description ?? "",
    metric: rule?.metric ?? "request.error_rate",
    comparator: (rule?.comparator as "above" | "below") ?? "above",
    // Ratio thresholds are typed in percent and stored as a fraction: 0.05 is
    // 5%, and asking an operator to type 0.05 is how thresholds get mistyped by
    // a factor of a hundred.
    threshold:
      rule === null
        ? info.unit === "ratio"
          ? "5"
          : info.unit === "minutes"
            ? "15"
            : "1"
        : String(info.unit === "ratio" ? Number((rule.threshold * 100).toFixed(4)) : rule.threshold),
    windowS: String(rule?.windowS ?? 300),
    detection: (rule?.detection as "threshold" | "anomaly") ?? "threshold",
    sigma: String(rule?.sigma ?? 3.5),
    severity: rule?.severity ?? "high",
    applicationId: rule?.applicationId ?? applicationId,
    operationId: scope.operationId ?? "",
    queueName: scope.queueName ?? "",
    customMetricName: scope.customMetricName ?? "",
    logPattern: scope.logPattern ?? "",
    logLevels: scope.logLevels ?? [],
    channelType:
      channel !== undefined &&
      (channel.type === "webhook" || channel.type === "slack" || channel.type === "email")
        ? channel.type
        : "in-app",
    webhookUrl: channel?.url ?? "",
    quietEnabled: quiet !== null,
    quietStart: quiet?.start ?? "22:00",
    quietEnd: quiet?.end ?? "07:00",
    quietTimezone: quiet?.timezone ?? "",
    sloId: scope.sloId ?? "",
  };
}

function RuleDialog({
  rule,
  applications,
  defaultApplicationId,
  slos,
  onClose,
  onSaved,
  onFailure,
}: {
  rule: AlertRuleRow | null;
  applications: ReadonlyArray<{ id: string; name: string }>;
  defaultApplicationId: string;
  slos: ReadonlyArray<{ id: string; name?: string | null; operationId?: string | null }>;
  onClose: () => void;
  onSaved: () => void;
  onFailure: (message: string) => void;
}) {
  const [form, setForm] = useState<RuleForm>(() => initialForm(rule, defaultApplicationId));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const info = metricInfo(form.metric);

  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    const invalid = validate(form);
    if (invalid) {
      setProblem(invalid);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const input = toRuleInput(form);
      if (rule) await alerts.updateRule(rule.id, input);
      else await alerts.createRule(input);
      onSaved();
    } catch (error) {
      onFailure(errorMessage(error));
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{rule ? "Edit rule" : "New rule"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {problem && <Alert severity="warning">{problem}</Alert>}

          <TextField
            label="Name"
            size="small"
            required
            value={form.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="Error rate above 5%"
            helperText="What a woken-up operator reads first. Say the condition, not the team."
          />

          <TextField
            select
            label="Metric"
            size="small"
            value={form.metric}
            onChange={(event) => set("metric", event.target.value)}
            helperText={info.hint}
          >
            {METRIC_OPTIONS.map((group) => [
              <ListSubheader key={group.group}>{group.group}</ListSubheader>,
              ...group.metrics.map((metric) => (
                <MenuItem key={metric} value={metric}>
                  {METRICS[metric]?.label ?? metric}
                </MenuItem>
              )),
            ])}
          </TextField>

          <Stack direction="row" spacing={2}>
            <TextField
              select
              label="Comparison"
              size="small"
              value={form.comparator}
              onChange={(event) => set("comparator", event.target.value as "above" | "below")}
              sx={{ flex: 1 }}
            >
              <MenuItem value="above">Above the line</MenuItem>
              <MenuItem value="below">Below the line</MenuItem>
            </TextField>
            <TextField
              label={`Threshold (${unitSuffix(info.unit)})`}
              size="small"
              value={form.threshold}
              onChange={(event) => set("threshold", event.target.value)}
              sx={{ flex: 1 }}
              helperText={info.unit === "ratio" ? "Typed in percent: 5 means 5%." : undefined}
            />
            <TextField
              select
              label="Window"
              size="small"
              value={form.windowS}
              onChange={(event) => set("windowS", event.target.value)}
              sx={{ flex: 1 }}
            >
              {WINDOWS.map((seconds) => (
                <MenuItem key={seconds} value={String(seconds)}>
                  {windowLabel(seconds)}
                </MenuItem>
              ))}
            </TextField>
          </Stack>

          <Stack direction="row" spacing={2}>
            <TextField
              select
              label="Detection"
              size="small"
              value={form.detection}
              onChange={(event) => set("detection", event.target.value as "threshold" | "anomaly")}
              sx={{ flex: 1 }}
              helperText={
                form.detection === "anomaly"
                  ? "Compared with the mean of the previous six windows, not a fixed number."
                  : "Compared with the threshold above."
              }
            >
              <MenuItem value="threshold">Fixed threshold</MenuItem>
              <MenuItem value="anomaly">Anomaly vs the last six windows</MenuItem>
            </TextField>
            {form.detection === "anomaly" && (
              <TextField
                label="Sigma"
                size="small"
                value={form.sigma}
                onChange={(event) => set("sigma", event.target.value)}
                sx={{ flex: 1 }}
                helperText="Standard deviations from the baseline mean. 3.5 is a sane start."
              />
            )}
            <TextField
              select
              label="Severity"
              size="small"
              value={form.severity}
              onChange={(event) => set("severity", event.target.value as AlertSeverity)}
              sx={{ flex: 1 }}
            >
              <MenuItem value="low">Low</MenuItem>
              <MenuItem value="medium">Medium</MenuItem>
              <MenuItem value="high">High</MenuItem>
              <MenuItem value="critical">Critical</MenuItem>
            </TextField>
          </Stack>

          {/* Only the scope keys the chosen metric understands: a queue name on
              an error-rate rule would be stored and silently ignored, which is
              worse than not offering it. */}
          {info.scope === "operationId" && (
            <TextField
              label="Operation id (optional)"
              size="small"
              value={form.operationId}
              onChange={(event) => set("operationId", event.target.value)}
              placeholder="GET /orders"
              helperText="Matches the operation id the SDK reports, exactly. Empty means every operation."
            />
          )}
          {info.scope === "queueName" && (
            <TextField
              label="Queue (optional)"
              size="small"
              value={form.queueName}
              onChange={(event) => set("queueName", event.target.value)}
              placeholder="orders"
              helperText="Empty means every queue in scope."
            />
          )}
          {info.scope === "customMetricName" && (
            <TextField
              label="Metric name"
              size="small"
              required
              value={form.customMetricName}
              onChange={(event) => set("customMetricName", event.target.value)}
              placeholder="orders.backlog"
              helperText="Without a name this metric cannot be measured at all — the rule stays no-data."
            />
          )}
          {info.scope === "logPattern" && (
            <>
              <TextField
                label="Log pattern"
                size="small"
                required
                value={form.logPattern}
                onChange={(event) => set("logPattern", event.target.value)}
                placeholder="payment declined"
                helperText="Case-insensitive substring. At least three characters: a shorter one matches everything and is an alert that always fires."
              />
              <Box>
                <Typography sx={{ ...labelCaps, mb: 0.5 }}>Levels (optional)</Typography>
                <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap", gap: 0.5 }}>
                  {LOG_LEVELS.map((level) => {
                    const selected = form.logLevels.includes(level);
                    return (
                      <Chip
                        key={level}
                        size="small"
                        label={level}
                        variant="outlined"
                        onClick={() =>
                          set(
                            "logLevels",
                            selected
                              ? form.logLevels.filter((entry) => entry !== level)
                              : [...form.logLevels, level],
                          )
                        }
                        sx={
                          selected
                            ? { color: colors.text, borderColor: colors.borderStrong, bgcolor: colors.surfaceHover }
                            : undefined
                        }
                      />
                    );
                  })}
                </Stack>
                <Typography sx={{ mt: 0.5, fontSize: 10.5, color: "text.disabled" }}>
                  None selected means every level.
                </Typography>
              </Box>
            </>
          )}
          {info.scope === "sloId" && (
            <TextField
              select
              label="Objective"
              size="small"
              required
              value={form.sloId}
              onChange={(event) => set("sloId", event.target.value)}
              helperText="The burn rate of the objective's window closest to this rule's window."
            >
              {slos.length === 0 ? (
                <MenuItem value="" disabled>
                  No objectives in this project yet
                </MenuItem>
              ) : (
                slos.map((slo) => (
                  <MenuItem key={slo.id} value={slo.id}>
                    {slo.name ?? slo.operationId ?? slo.id}
                  </MenuItem>
                ))
              )}
            </TextField>
          )}

          <TextField
            select
            label="Application"
            size="small"
            value={form.applicationId}
            onChange={(event) => set("applicationId", event.target.value)}
            helperText="An alert is project-wide by default; pick one service only if the number belongs to it."
          >
            <MenuItem value="">All applications</MenuItem>
            {applications.map((entry) => (
              <MenuItem key={entry.id} value={entry.id}>
                {entry.name}
              </MenuItem>
            ))}
          </TextField>

          <Stack direction="row" spacing={2}>
            <TextField
              select
              label="Channel"
              size="small"
              value={form.channelType}
              onChange={(event) => set("channelType", event.target.value as RuleForm["channelType"])}
              sx={{ flex: 1 }}
              helperText={
                form.channelType === "email"
                  ? "Not delivered in this build: no SMTP client. The event records “skipped: no SMTP client” and is still in-app."
                  : form.channelType === "in-app"
                    ? "In-app is the event itself — it is what the sidebar badge and this page count."
                    : "A JSON POST when the rule opens, with a 5s timeout. Slack incoming webhooks take the same shape."
              }
            >
              <MenuItem value="in-app">In-app only</MenuItem>
              <MenuItem value="webhook">Webhook</MenuItem>
              <MenuItem value="slack">Slack incoming webhook</MenuItem>
              <MenuItem value="email">Email (not delivered in this build)</MenuItem>
            </TextField>
            {(form.channelType === "webhook" || form.channelType === "slack") && (
              <TextField
                label="Webhook URL"
                size="small"
                required
                value={form.webhookUrl}
                onChange={(event) => set("webhookUrl", event.target.value)}
                placeholder="https://hooks.slack.com/services/…"
                sx={{ flex: 2 }}
                helperText="POSTed once when the rule opens, with a 5s timeout. A failure is recorded, not retried."
              />
            )}
          </Stack>

          <Box>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={form.quietEnabled}
                  onChange={(event) => set("quietEnabled", event.target.checked)}
                />
              }
              label={<Typography sx={{ fontSize: 12 }}>Quiet hours</Typography>}
            />
            <Typography sx={{ fontSize: 10.5, color: "text.disabled", ml: 0.25 }}>
              During quiet hours the rule still evaluates and the firing is still recorded with{" "}
              <Box component="span" sx={{ fontFamily: fontMono }}>
                muted: true
              </Box>
              ; only delivery is skipped. Muted is not resolved.
            </Typography>
            {form.quietEnabled && (
              <Stack direction="row" spacing={2} sx={{ mt: 1.5 }}>
                <TextField
                  label="From"
                  size="small"
                  value={form.quietStart}
                  onChange={(event) => set("quietStart", event.target.value)}
                  placeholder="22:00"
                  sx={{ flex: 1 }}
                />
                <TextField
                  label="To"
                  size="small"
                  value={form.quietEnd}
                  onChange={(event) => set("quietEnd", event.target.value)}
                  placeholder="07:00"
                  sx={{ flex: 1 }}
                />
                <TextField
                  label="Timezone (optional)"
                  size="small"
                  value={form.quietTimezone}
                  onChange={(event) => set("quietTimezone", event.target.value)}
                  placeholder="UTC"
                  sx={{ flex: 1.2 }}
                  helperText="An IANA name; UTC when empty."
                />
              </Stack>
            )}
          </Box>

          <TextField
            label="Description (optional)"
            size="small"
            value={form.description}
            onChange={(event) => set("description", event.target.value)}
            helperText="Why this rule exists — the sentence that stops somebody deleting it."
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={busy}>
          {busy ? "Saving…" : rule ? "Save" : "Create rule"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** Client-side checks, so a 422 is the exception rather than the feedback loop. */
function validate(form: RuleForm): string | null {
  const info = metricInfo(form.metric);
  if (!form.name.trim()) return "A rule needs a name.";
  if (form.name.trim().length > 120) return "The name is limited to 120 characters.";
  const threshold = Number(form.threshold);
  if (!Number.isFinite(threshold)) return "The threshold must be a number.";
  if (info.unit === "ratio" && (threshold < 0 || threshold > 100))
    return "A ratio threshold is typed in percent, so it is between 0 and 100.";
  if (info.unit === "percent" && (threshold < 0 || threshold > 100))
    return "A percentage threshold is between 0 and 100.";
  if (form.detection === "anomaly") {
    const sigma = Number(form.sigma);
    if (!Number.isFinite(sigma) || sigma < 1 || sigma > 10) return "Sigma is between 1 and 10.";
  }
  if (info.scope === "customMetricName" && !form.customMetricName.trim())
    return "This metric measures a named custom metric; enter its name.";
  if (info.scope === "sloId" && !form.sloId) return "This metric measures an objective; pick one.";
  if (info.scope === "logPattern" && form.logPattern.trim().length < 3)
    return "A log pattern needs at least three characters — anything shorter matches every line and would always fire.";
  if (
    (form.channelType === "webhook" || form.channelType === "slack") &&
    !form.webhookUrl.trim()
  )
    return "A webhook channel needs a URL.";
  if (form.quietEnabled) {
    if (!/^\d{1,2}:\d{2}$/.test(form.quietStart.trim()) || !/^\d{1,2}:\d{2}$/.test(form.quietEnd.trim()))
      return "Quiet hours use HH:MM, e.g. 22:00 and 07:00.";
  }
  return null;
}

function toRuleInput(form: RuleForm): AlertRuleInput {
  const info = metricInfo(form.metric);
  const numeric = Number(form.threshold);
  const scope: NonNullable<AlertRuleInput["scope"]> = {};
  if (info.scope === "operationId" && form.operationId.trim()) scope.operationId = form.operationId.trim();
  if (info.scope === "queueName" && form.queueName.trim()) scope.queueName = form.queueName.trim();
  if (info.scope === "customMetricName" && form.customMetricName.trim())
    scope.customMetricName = form.customMetricName.trim();
  if (info.scope === "logPattern") {
    scope.logPattern = form.logPattern.trim();
    if (form.logLevels.length > 0) scope.logLevels = form.logLevels;
  }
  if (info.scope === "sloId" && form.sloId) scope.sloId = form.sloId;

  return {
    name: form.name.trim(),
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    metric: form.metric as AlertMetricName,
    comparator: form.comparator,
    threshold: info.unit === "ratio" ? numeric / 100 : numeric,
    windowS: Number(form.windowS) as AlertRuleInput["windowS"],
    detection: form.detection,
    ...(form.detection === "anomaly" ? { sigma: Number(form.sigma) } : {}),
    severity: form.severity,
    ...(form.applicationId ? { applicationId: form.applicationId } : {}),
    ...(Object.keys(scope).length > 0 ? { scope } : {}),
    channels: [
      {
        type: form.channelType,
        ...(form.channelType === "webhook" || form.channelType === "slack"
          ? { url: form.webhookUrl.trim() }
          : {}),
      },
    ],
    quietHours: form.quietEnabled
      ? {
          start: form.quietStart.trim(),
          end: form.quietEnd.trim(),
          ...(form.quietTimezone.trim() ? { timezone: form.quietTimezone.trim() } : {}),
        }
      : null,
  };
}

/* ---------------------------------------------------------------------- */

function StateChip({ state }: { state: string }) {
  const meta = STATE_META[state] ?? STATE_META["no-data"]!;
  return (
    <Tooltip title={meta.hint}>
      <Chip
        size="small"
        variant="outlined"
        label={meta.label}
        sx={{
          color: meta.color,
          borderColor: `${meta.color}66`,
          bgcolor: `${meta.color}14`,
          cursor: "help",
        }}
      />
    </Tooltip>
  );
}

/** The one thing on the page that is not a table: a small number over its label. */
function Stat({
  label,
  value,
  tone = "default",
  hint,
}: {
  label: string;
  value: string;
  tone?: "default" | "danger";
  hint?: string;
}) {
  const body = (
    <Box
      sx={{
        border: `1px solid ${colors.border}`,
        borderRadius: 1,
        px: 1.5,
        py: 0.75,
        minWidth: 74,
        ...(hint ? { cursor: "help" } : {}),
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

/** A full-bleed card: the tables want the whole width, not a padded body. */
function Panel({
  title,
  caption,
  actions,
  children,
}: {
  title: string;
  caption?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Paper sx={{ overflow: "hidden" }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ px: 2, pt: 1.75, pb: 1.25, alignItems: "center", flexWrap: "wrap" }}
      >
        <Typography sx={labelCaps}>{title}</Typography>
        {caption && (
          <Typography sx={{ fontSize: 11, color: "text.disabled", ...tabular }}>{caption}</Typography>
        )}
        <Box sx={{ ml: "auto" }}>{actions}</Box>
      </Stack>
      {children}
    </Paper>
  );
}

function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <Box
      sx={{
        border: `1px dashed ${colors.borderStrong}`,
        borderRadius: 1,
        m: 2,
        px: 3,
        py: 5,
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

/** `42m`, `3.2h` — for "how long has this been firing", not for a duration chart. */
function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  return `${Math.round(hours / 24)}d`;
}

function scopeSummary(rule: AlertRuleRow, sloName: string | null): string {
  const scope = (rule.scope ?? {}) as RuleScope;
  const bits: string[] = [];
  if (scope.operationId) bits.push(scope.operationId);
  if (scope.queueName) bits.push(`queue ${scope.queueName}`);
  if (scope.customMetricName) bits.push(`metric ${scope.customMetricName}`);
  if (scope.logPattern)
    bits.push(
      `log ~ “${scope.logPattern}”${scope.logLevels && scope.logLevels.length > 0 ? ` (${scope.logLevels.join(", ")})` : ""}`,
    );
  if (scope.sloId) bits.push(`SLO ${sloName ?? `${scope.sloId.slice(0, 8)}…`}`);
  return bits.join(" · ");
}

function channelsSummary(channels: unknown): string {
  const list = Array.isArray(channels) ? (channels as Array<{ type?: string; url?: string }>) : [];
  if (list.length === 0) return "in-app";
  return list
    .map((channel) => {
      if (channel.type === "email") return "email (not delivered)";
      if (channel.type === "webhook" || channel.type === "slack")
        return channel.url ? `${channel.type} → ${hostOf(channel.url)}` : `${channel.type} (no url)`;
      return "in-app";
    })
    .join(" · ");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function quietHoursLabel(quietHours: unknown): string | null {
  const value = quietHours as { start?: string; end?: string; timezone?: string } | null;
  if (!value || typeof value.start !== "string" || typeof value.end !== "string") return null;
  return `${value.start}–${value.end}${value.timezone ? ` ${value.timezone}` : ""}`;
}

/**
 * The unit an event was written with. The evaluator stores it in the payload, so
 * history keeps printing the right unit even after the rule's metric is edited.
 */
function eventPayloadUnit(event: AlertEventRow): string | null {
  const payload = event.payload as { unit?: unknown } | null;
  return typeof payload?.unit === "string" ? payload.unit : null;
}

function deliveryEntries(payload: unknown): DeliveryEntry[] {
  const value = payload as { delivery?: unknown } | null;
  if (!Array.isArray(value?.delivery)) return [];
  return value.delivery.filter(
    (entry): entry is DeliveryEntry =>
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as DeliveryEntry).channel === "string" &&
      typeof (entry as DeliveryEntry).status === "string",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
