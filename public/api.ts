/**
 * The API client — Eden, generated from the server's own types.
 *
 * `treaty<ApiApp>()` reads the Elysia app's route map, so a path, a query
 * parameter or a response field that the server does not have is a compile error
 * here. That is the whole point: the dashboard cannot drift from the collector,
 * and renaming a column forces a UI fix instead of a runtime `undefined`.
 *
 * The one place this repo imports server code into the browser bundle is a
 * **type-only** import, erased at build time. Nothing from the server ships — and
 * because it is `import type`, Bun's runtime bundler never tries to resolve it
 * from the release artifact, where only `public/` exists.
 */
import { treaty } from "@elysiajs/eden";
import type { ApiApp } from "../src/server/app";

const client = treaty<ApiApp>(globalThis.location?.origin ?? "http://localhost:4320");

/** Unwraps Eden's `{ data, error }` into a value or a thrown `ApiError`. */
async function unwrap<T>(
  result: Promise<{ data: T | null; error: unknown; status: number }>,
): Promise<T> {
  const { data, error, status } = await result;
  if (error) {
    throw new ApiError(status, describe(error));
  }
  return data as T;
}

function describe(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; value?: unknown };
    if (typeof value.message === "string") return value.message;
    return JSON.stringify(error).slice(0, 500);
  }
  return String(error);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Window {
  from: number;
  to: number;
}

/**
 * The surface the pages use.
 *
 * Everything below is a thin adapter over Eden: it exists so a page says
 * `api.executions(appId, range)` instead of threading `{ query: { from, to } }`
 * through every call site, and so the components do not deal with `{ data }`.
 */
/**
 * Scope helper: `""` is the "All applications" value the shell holds, and the
 * query parameter is optional — so the empty scope is *absent*, not `""`, which
 * the server would otherwise treat as an application id that matches nothing.
 */
function scoped(appId: string): { applicationId?: string } {
  return appId ? { applicationId: appId } : {};
}

/**
 * The surface the pages use.
 *
 * Every telemetry read goes to `/telemetry/…` with an optional `applicationId`,
 * which is what makes the top bar's "All applications" work on every page and
 * not just the overview. Single entities keep their id paths (`executions/:id`,
 * `errors/:id`, `traces/:traceId`, `applications/:id/job`): an id is a scope.
 *
 * `appId: ""` means the whole project. Rows then carry `applicationName`, and the
 * table shows it.
 */
export const api = {
  health: () => unwrap(client.health.get()),

  applications: (w: Window) =>
    unwrap(client.api.v1.applications.get({ query: w })),

  operations: (appId: string, w: Window & { kind?: "request" | "job" }) =>
    unwrap(client.api.v1.telemetry.operations.get({ query: { ...scoped(appId), ...w } })),

  /**
   * One operation: its series, its slowest instances and its error groups.
   *
   * The page it backs is `/applications/:id/operations/:operationRowId`; there
   * was no helper for it, and the Operation page is written against Eden types
   * like every other page rather than fetching by hand.
   */
  operationDetail: (appId: string, operationRowId: string, w: Window) =>
    unwrap(
      client.api.v1
        .applications({ id: appId })
        .operations({ operationRowId })
        .get({ query: w }),
    ),

  executions: (
    appId: string,
    w: Window & { limit?: number; operationRowId?: string; kind?: "request" | "job" },
  ) => unwrap(client.api.v1.telemetry.executions.get({ query: { ...scoped(appId), ...w } })),

  execution: (id: string) => unwrap(client.api.v1.executions({ id }).get()),

  trace: (traceId: string) => unwrap(client.api.v1.traces({ traceId }).get()),

  errors: (appId: string, status?: "open" | "resolved" | "ignored") =>
    unwrap(client.api.v1.telemetry.errors.get({ query: { ...scoped(appId), status } })),

  setErrorStatus: (id: string, status: "open" | "resolved" | "ignored") =>
    unwrap(client.api.v1.errors({ id }).patch({ status })),

  errorDetail: (id: string) => unwrap(client.api.v1.errors({ id }).get()),

  application: (id: string) => unwrap(client.api.v1.applications({ id }).get()),

  /**
   * The chart series. `kind` defaults to `request` on the server — a job is not
   * a request, and only the job pages pass `kind: "job"`.
   */
  timeseries: (
    appId: string,
    w: Window & { bucketMs?: number; kind?: "request" | "job"; operationRowId?: string },
  ) => unwrap(client.api.v1.telemetry.timeseries.get({ query: { ...scoped(appId), ...w } })),

  jobs: (appId: string, w: Window) =>
    unwrap(client.api.v1.telemetry.jobs.get({ query: { ...scoped(appId), ...w } })),

  /**
   * One job: throughput, failures, duration, **queue wait**, attempts and the
   * recent runs with their trace ids.
   *
   * Addressed by application: a handler belongs to one service, and the list row
   * that opens it carries the id. The pair is a query, not a path, because a job
   * name may contain `/`.
   */
  jobDetail: (appId: string, queue: string, name: string, w: Window & { limit?: number }) =>
    unwrap(
      client.api.v1
        .applications({ id: appId })
        .job.get({ query: { ...w, queue, name } }),
    ),

  metrics: (appId: string) =>
    unwrap(client.api.v1.telemetry.metrics.get({ query: scoped(appId) })),

  metricPoints: (appId: string, name: string, w: Window) =>
    unwrap(
      client.api.v1.telemetry
        .metrics({ name })
        .get({ query: { ...scoped(appId), ...w } }),
    ),

  runtime: (appId: string, w: Window) =>
    unwrap(client.api.v1.telemetry.runtime.get({ query: { ...scoped(appId), ...w } })),

  releases: (appId: string, w: Window) =>
    unwrap(client.api.v1.telemetry.releases.get({ query: { ...scoped(appId), ...w } })),

  /** Per class: own time vs total time, calls, errors, method breakdown. */
  services: (appId: string, w: Window) =>
    unwrap(client.api.v1.telemetry.services.get({ query: { ...scoped(appId), ...w } })),

  /** The service graph: applications, and trace continuations as edges. */
  serviceMap: (appId: string, w: Window) =>
    unwrap(client.api.v1.telemetry.map.get({ query: { ...scoped(appId), ...w } })),

  /** Named spans: invocations, failures, avg/p95 duration, and the per-bucket series. */
  spanAnalytics: (appId: string, w: Window & { mode?: "manual" | "all"; limit?: number }) =>
    unwrap(client.api.v1.telemetry.spans.get({ query: { ...scoped(appId), ...w } })),

  users: (appId: string, w: Window) =>
    unwrap(client.api.v1.telemetry.users.get({ query: { ...scoped(appId), ...w } })),

  slos: (appId: string) =>
    unwrap(client.api.v1.telemetry.slos.get({ query: scoped(appId) })),

  createSlo: (
    appId: string,
    input: {
      name?: string;
      kind: "availability" | "latency" | "job";
      target: number;
      underMs?: number;
      windowDays?: 7 | 14 | 28 | 30;
      operationId?: string;
    },
  ) => unwrap(client.api.v1.applications({ id: appId }).slos.post(input)),

  deleteSlo: (appId: string, sloId: string) =>
    unwrap(client.api.v1.applications({ id: appId }).slos({ sloId }).delete()),

  logs: (
    appId: string,
    w: Window & {
      level?: "fatal" | "error" | "warn" | "log" | "debug" | "verbose";
      traceId?: string;
      limit?: number;
    },
  ) => unwrap(client.api.v1.telemetry.logs.get({ query: { ...scoped(appId), ...w } })),

  pendingLinks: () => unwrap(client.api.v1.link.pending.get()),

  approveLink: (userCode: string, serviceId?: string) =>
    unwrap(client.api.v1.link.approve.post({ userCode, serviceId })),

  denyLink: (userCode: string) => unwrap(client.api.v1.link.deny.post({ userCode })),
};

/**
 * Response types, derived from Eden rather than declared.
 *
 * `Awaited<ReturnType<…>>` is how a page names a row type without importing a
 * DTO: the server's schema is the only definition.
 */
type ApplicationsResult = Awaited<ReturnType<typeof api.applications>>;
export type ApplicationSummary = ApplicationsResult[number];

type OperationsResult = Awaited<ReturnType<typeof api.operations>>;
export type RankedOperation = OperationsResult[number];

type ExecutionsResult = Awaited<ReturnType<typeof api.executions>>;
export type ExecutionListItem = ExecutionsResult["items"][number];

type ExecutionResult = Awaited<ReturnType<typeof api.execution>>;
export type ExecutionDetail = ExecutionResult;
export type SpanRow = ExecutionResult["spans"][number];
export type LogRow = ExecutionResult["logs"][number];

type ErrorsResult = Awaited<ReturnType<typeof api.errors>>;
export type ErrorGroupRow = ErrorsResult[number];

/** A log line from the explorer (`/telemetry/logs`), with its application. */
type LogsResult = Awaited<ReturnType<typeof api.logs>>;
export type LogListItem = LogsResult[number];

type ErrorDetailResult = Awaited<ReturnType<typeof api.errorDetail>>;
export type ErrorOccurrence = ErrorDetailResult["occurrences"][number];
export type ErrorDetail = ErrorDetailResult;

type HealthResult = Awaited<ReturnType<typeof api.health>>;
export type Health = HealthResult;

type SeriesResult = Awaited<ReturnType<typeof api.timeseries>>;
export type SeriesPoint = SeriesResult["points"][number];

type JobsResult = Awaited<ReturnType<typeof api.jobs>>;
export type JobRow = JobsResult[number];

/** The job detail page's payload: the aggregates plus its recent runs. */
export type JobDetail = Awaited<ReturnType<typeof api.jobDetail>>;
export type JobRun = JobDetail["recent"][number];

/** A cross-service trace: every hop that carried the id, plus its logs. */
export type TraceResult = Awaited<ReturnType<typeof api.trace>>;
export type TraceHop = TraceResult["executions"][number];
export type TraceLog = TraceResult["logs"][number];

type ReleasesResult = Awaited<ReturnType<typeof api.releases>>;
export type ReleaseRow = ReleasesResult[number];

type ServicesResult = Awaited<ReturnType<typeof api.services>>;
export type ServiceClassRow = ServicesResult[number];
export type ServiceMethodRow = ServiceClassRow["methods"][number];

export type ServiceMapResult = Awaited<ReturnType<typeof api.serviceMap>>;
export type ServiceMapNode = ServiceMapResult["nodes"][number];
export type ServiceMapEdge = ServiceMapResult["edges"][number];

export type SpanAnalyticsResult = Awaited<ReturnType<typeof api.spanAnalytics>>;
export type SpanAggregateRow = SpanAnalyticsResult["rows"][number];

type UsersResult = Awaited<ReturnType<typeof api.users>>;
export type UserRow = UsersResult[number];

type SlosResult = Awaited<ReturnType<typeof api.slos>>;
export type SloRow = SlosResult["items"][number];
export type SloKind = SloRow["kind"];
export type SloState = SloRow["state"];

type MetricsResult = Awaited<ReturnType<typeof api.metrics>>;
export type MetricRow = MetricsResult[number];

/**
 * Auth surface. Kept in the same Eden client so a change to the setup payload or
 * the invite response is a compile error here too.
 */
export const auth = {
  status: () => unwrap(client.api.v1.auth.status.get()),

  setup: (input: {
    email: string;
    password: string;
    name?: string;
    instanceName?: string;
  }) => unwrap(client.api.v1.auth.setup.post(input)),

  login: (input: { email: string; password: string }) =>
    unwrap(client.api.v1.auth.login.post(input)),

  logout: () => unwrap(client.api.v1.auth.logout.post()),

  me: () => unwrap(client.api.v1.me.get()),

  describeInvite: (token: string) =>
    unwrap(client.api.v1.auth.invite({ token }).get()),

  acceptInvite: (token: string, input: { password: string; name?: string }) =>
    unwrap(client.api.v1.auth.invite({ token }).post(input)),
};

export type AuthStatus = Awaited<ReturnType<typeof auth.status>>;
export type SessionUser = Awaited<ReturnType<typeof auth.me>>["user"];

/**
 * Instance administration: keys, members, invites, settings, audit.
 *
 * Kept beside `auth` because it is the same kind of surface — everything here is
 * admin-only, and the server enforces that (`requireAdmin`), not the page. A
 * non-admin who reaches one of these pages gets a 403 it can render, which is
 * the honest answer rather than a hidden button.
 */
export const admin = {
  credentials: () => unwrap(client.api.v1.admin.credentials.get()),

  /** The only call whose response carries a secret. Show it once, then forget it. */
  createCredential: (label?: string) =>
    unwrap(client.api.v1.admin.credentials.post({ label })),

  revokeCredential: (id: string) =>
    unwrap(client.api.v1.admin.credentials({ id }).delete()),

  users: () => unwrap(client.api.v1.admin.users.get()),

  setRole: (id: string, role: "read" | "write" | "admin") =>
    unwrap(client.api.v1.admin.users({ id }).patch({ role })),

  invites: () => unwrap(client.api.v1.admin.invites.get()),

  invite: (email: string, role: "read" | "write" | "admin") =>
    unwrap(client.api.v1.admin.invites.post({ email, role })),

  revokeInvite: (id: string) => unwrap(client.api.v1.admin.invites({ id }).delete()),

  settings: () => unwrap(client.api.v1.admin.settings.get()),

  saveSettings: (patch: Record<string, unknown>) =>
    unwrap(client.api.v1.admin.settings.patch(patch)),

  audit: (limit?: number) => unwrap(client.api.v1.admin.audit.get({ query: { limit } })),
};

export type CredentialRow = Awaited<ReturnType<typeof admin.credentials>>["items"][number];
export type MemberRow = Awaited<ReturnType<typeof admin.users>>["items"][number];
export type InviteRow = Awaited<ReturnType<typeof admin.invites>>["items"][number];
export type InstanceSettings = Awaited<ReturnType<typeof admin.settings>>;
export type AuditRow = Awaited<ReturnType<typeof admin.audit>>["items"][number];

/**
 * Alerts. A rule is a metric + a window + a comparison; the events are the
 * transitions the evaluator wrote (it runs once a minute, in-process).
 */
export const alerts = {
  rules: () => unwrap(client.api.v1.alerts.rules.get()),

  createRule: (input: AlertRuleInput) =>
    unwrap(client.api.v1.alerts.rules.post(input)),

  updateRule: (id: string, input: Partial<AlertRuleInput>) =>
    unwrap(client.api.v1.alerts.rules({ id }).patch(input)),

  deleteRule: (id: string) => unwrap(client.api.v1.alerts.rules({ id }).delete()),

  /** `null` unmutes; a number silences delivery for that many minutes. */
  muteRule: (id: string, minutes: number | null) =>
    unwrap(client.api.v1.alerts.rules({ id }).mute.post({ minutes })),

  events: (limit?: number) =>
    unwrap(client.api.v1.alerts.events.get({ query: { limit } })),

  incidents: () => unwrap(client.api.v1.alerts.incidents.get()),

  /** The same function the timer calls — useful after a deploy. */
  evaluate: () => unwrap(client.api.v1.alerts.evaluate.post()),
};

type AlertsResult = Awaited<ReturnType<typeof alerts.rules>>;
export type AlertRuleRow = AlertsResult["items"][number];
export type AlertMetricName = AlertRuleRow["metric"];
export type AlertSeverity = AlertRuleRow["severity"];

type AlertEventsResult = Awaited<ReturnType<typeof alerts.events>>;
export type AlertEventRow = AlertEventsResult["items"][number];

type AlertIncidentsResult = Awaited<ReturnType<typeof alerts.incidents>>;
export type AlertIncidentRow = AlertIncidentsResult["items"][number];

/** What a rule needs on the wire; the page builds this, never a raw shape. */
export interface AlertRuleInput {
  name: string;
  description?: string;
  metric: AlertMetricName;
  comparator: "above" | "below";
  threshold: number;
  windowS: 300 | 600 | 900 | 1800 | 3600 | 10800;
  detection?: "threshold" | "anomaly";
  sigma?: number;
  severity?: AlertSeverity;
  applicationId?: string;
  scope?: {
    operationId?: string;
    queueName?: string;
    customMetricName?: string;
    logPattern?: string;
    logLevels?: string[];
    sloId?: string;
  };
  channels?: Array<{ type: "in-app" | "webhook" | "slack" | "email"; url?: string }>;
  quietHours?: { start: string; end: string; timezone?: string } | null;
  enabled?: boolean;
}
