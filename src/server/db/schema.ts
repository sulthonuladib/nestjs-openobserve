/**
 * Drizzle schema — Postgres dialect.
 *
 * Conventions so the product stays queryable at volume:
 *   * `uuid` primary keys, minted by the collector as UUIDv7 — time-ordered, so
 *     B-tree inserts stay append-like instead of scattering page writes;
 *   * every timestamp is `bigint` epoch **milliseconds**; the wire is ms
 *     everywhere and mixing units is the classic telemetry bug;
 *   * `jsonb` for tags/attributes, never `json` — these are filtered and
 *     aggregated, and we want the GIN indexes;
 *   * append-only. Nothing on the ingest path updates a row except counters on
 *     `error_group`, `operation`, `release` and `application`.
 *
 * Partitioning: `execution`, `span`, `log_entry` and `metric_point` are declared
 * plainly here and converted to `PARTITION BY RANGE (started_at)` by
 * `0002_partitions.sql` once the retention job lands (M1). Keeping them plain
 * until then means one less thing that can go wrong in the first release, and
 * Drizzle cannot express partition DDL anyway.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  customType,
  pgTable,
  primaryKey,
  real,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * A `jsonb` column that hands the value to the driver untouched.
 *
 * Drizzle's own `jsonb()` stringifies in `mapToDriverValue`, and Bun SQL then
 * treats that string as a JSON *string* for the JSONB parameter — every object
 * landed double-encoded (`"{}"`), so a GIN index over `span.tags` never matched
 * and `jsonb_array_length` saw a scalar. Returning the value lets Bun serialise
 * it once. `fromDriver` still parses a string, so a row written by the broken
 * version reads back as the object it was meant to be.
 */
function jsonbValue<T>(name: string) {
  return customType<{ data: T; driverData: T }>({
    dataType: () => "jsonb",
    /**
     * The driver binds what it is given: an object or array becomes JSON, a
     * string becomes a JSON string, but a **number or boolean is bound as a SQL
     * scalar** and Postgres refuses it for a `jsonb` column. So a scalar has to
     * be serialised and cast at the write site — see `Auth.setSetting`, which is
     * the one place settings are written. Doing it here would double-encode
     * every object (`"{\"a\":1}"`), which is the trap this helper exists for.
     */
    toDriver: (value) => value,
    fromDriver: (value) => {
      if (typeof value !== "string") return value as T;
      // Bun returns JSONB as text for a raw query but parses it under
      // `unsafe(...).values()`, so a JSON string can arrive either quoted
      // (`"invite"`) or plain (`invite`). Parse when it parses; otherwise the
      // value is already the string it was meant to be.
      try {
        return JSON.parse(value) as T;
      } catch {
        return value as T;
      }
    },
  })(name);
}

const pk = () => uuid("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7());
const ms = (name: string) => bigint(name, { mode: "number" });

// ---------------------------------------------------------------------------
// Tenancy and access
// ---------------------------------------------------------------------------

export const project = pgTable("project", {
  id: pk(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  teamId: uuid("team_id").references(() => team.id, { onDelete: "set null" }),
  settings: jsonbValue<Record<string, unknown>>("settings").notNull().default({}),
  createdAt: ms("created_at").notNull(),
});

export const user = pgTable("app_user", {
  id: pk(),
  email: text("email").notNull().unique(),
  name: text("name"),
  /** argon2id, via `Bun.password`. Null until the first-run admin sets one. */
  passwordHash: text("password_hash"),
  /**
   * Instance-wide role. Project and team roles are per membership: an operator
   * can be an admin of the instance and a viewer of somebody else's project.
   */
  /** Instance role. The first user to bootstrap the server becomes `admin`. */
  role: text("role", { enum: ["read", "write", "admin"] })
    .notNull()
    .default("write"),
  createdAt: ms("created_at").notNull(),
  lastLoginAt: ms("last_login_at"),
});

export const session = pgTable(
  "session",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** SHA-256 of the cookie value: a session token is not stored in clear. */
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    expiresAt: ms("expires_at").notNull(),
    createdAt: ms("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("session_token").on(table.tokenHash),
    index("session_expires").on(table.expiresAt),
  ],
);

/** A team groups projects and people. Every install has at least one. */
export const team = pgTable(
  "team",
  {
    id: pk(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    createdAt: ms("created_at").notNull(),
  },
  (table) => [uniqueIndex("team_slug").on(table.slug)],
);

/**
 * Roles, narrowest to widest:
 *   viewer  read only
 *   member  read + resolve/ignore errors, acknowledge alerts
 *   admin   + manage applications, api keys, alert rules, members
 *   owner   + delete the project, transfer ownership
 */
export const teamMember = pgTable(
  "team_member",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Read / Write / Admin — the upstream model, verbatim. */
    role: text("role", { enum: ["read", "write", "admin"] }).notNull(),
    createdAt: ms("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.userId] })],
);

export const projectMember = pgTable(
  "project_member",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Read / Write / Admin. "Creator only" rules are separate checks, not roles. */
    role: text("role", { enum: ["read", "write", "admin"] }).notNull(),
    createdAt: ms("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.userId] })],
);

export const application = pgTable(
  "application",
  {
    id: pk(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** The SDK's `serviceId`; the wire caps it at 100 characters. */
    serviceId: text("service_id").notNull(),
    name: text("name"),
    firstSeen: ms("first_seen").notNull(),
    lastSeen: ms("last_seen").notNull(),
  },
  (table) => [
    uniqueIndex("application_service").on(table.projectId, table.serviceId),
    index("application_last_seen").on(table.lastSeen),
  ],
);

export const appCredential = pgTable(
  "app_credential",
  {
    id: pk(),
    /**
     * Scoped to a **project**, not an application — the upstream documentation is
     * explicit: "any application whose telemetry should land in that project's
     * dashboard uses the same key". The application is resolved per batch from
     * the `serviceId` the agent sends.
     */
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /**
     * The full `appKey` is not a secret in the SDK's model (it identifies the
     * application); the secret is. We still look the key up by prefix and
     * compare a hash, so a database leak grants nothing.
     */
    keyPrefix: text("key_prefix").notNull().unique(),
    keyHash: text("key_hash").notNull(),
    secretHash: text("secret_hash").notNull(),
    label: text("label"),
    createdAt: ms("created_at").notNull(),
    lastUsedAt: ms("last_used_at"),
    revokedAt: ms("revoked_at"),
  },
  (table) => [index("app_credential_key").on(table.keyPrefix)],
);

// ---------------------------------------------------------------------------
// CLI link (device-code flow)
// ---------------------------------------------------------------------------

export const cliLinkSession = pgTable(
  "cli_link_session",
  {
    id: pk(),
    deviceCode: text("device_code").notNull(),
    userCode: text("user_code").notNull(),
    applicationName: text("application_name").notNull(),
    hostname: text("hostname"),
    projectId: uuid("project_id").references(() => project.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").references(() => application.id, {
      onDelete: "cascade",
    }),
    status: text("status", { enum: ["pending", "approved", "denied", "claimed"] })
      .notNull()
      .default("pending"),
    intervalS: integer("interval_s").notNull().default(5),
    expiresAt: ms("expires_at").notNull(),
    createdAt: ms("created_at").notNull(),
    approvedAt: ms("approved_at"),
  },
  (table) => [
    uniqueIndex("cli_link_device_code").on(table.deviceCode),
    uniqueIndex("cli_link_user_code").on(table.userCode),
    index("cli_link_status").on(table.status),
  ],
);

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export const release = pgTable(
  "release",
  {
    id: pk(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    firstSeen: ms("first_seen").notNull(),
    lastSeen: ms("last_seen").notNull(),
  },
  (table) => [
    uniqueIndex("release_version").on(table.applicationId, table.version),
    index("release_seen").on(table.applicationId, table.lastSeen),
  ],
);

export const operation = pgTable(
  "operation",
  {
    id: pk(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "cascade" }),
    /** `http` | `graphql` | `rpc` | `grpc` | `ws` | `job`. */
    protocol: text("protocol").notNull(),
    operationId: text("operation_id").notNull(),
    method: text("method"),
    /** Set when the app renamed it via `TracerService.setOperationId`. */
    customName: text("custom_name"),
    firstSeen: ms("first_seen").notNull(),
    lastSeen: ms("last_seen").notNull(),
  },
  (table) => [
    uniqueIndex("operation_identity").on(
      table.applicationId,
      table.protocol,
      table.operationId,
    ),
    index("operation_seen").on(table.applicationId, table.lastSeen),
  ],
);

export const errorGroup = pgTable(
  "error_group",
  {
    id: pk(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "cascade" }),
    /** sha256 of class + normalized message + top in-app frame. */
    fingerprint: text("fingerprint").notNull(),
    class: text("class"),
    message: text("message").notNull(),
    topFrameFile: text("top_frame_file"),
    topFrameLine: integer("top_frame_line"),
    status: text("status", { enum: ["open", "resolved", "ignored"] })
      .notNull()
      .default("open"),
    firstSeen: ms("first_seen").notNull(),
    lastSeen: ms("last_seen").notNull(),
    occurrences: integer("occurrences").notNull().default(0),
  },
  (table) => [
    uniqueIndex("error_group_fingerprint").on(table.applicationId, table.fingerprint),
    index("error_group_list").on(table.applicationId, table.status, table.lastSeen),
  ],
);

export const execution = pgTable(
  "execution",
  {
    id: pk(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "cascade" }),
    releaseId: uuid("release_id").references(() => release.id, { onDelete: "set null" }),
    operationRowId: uuid("operation_row_id").references(() => operation.id, {
      onDelete: "set null",
    }),
    kind: text("kind", { enum: ["request", "job"] }).notNull(),
    protocol: text("protocol"),
    traceId: text("trace_id").notNull(),
    /** Collector-minted: the client clock is advisory only. */
    startedAt: ms("started_at").notNull(),
    /** The wire's `ct`, kept verbatim for display. */
    calledAt: text("called_at"),
    durationMs: doublePrecision("duration_ms"),
    statusCode: integer("status_code"),
    userId: text("user_id"),
    /**
     * Present when the operation failed. `errorGroupId` is set only for
     * requests: a failed job does not open an error group (see
     * `docs/upstream/observe-docs/alerts.md`), so a job keeps its error payload
     * here and nowhere else.
     */
    error: jsonbValue<{
      cls?: string;
      message: string;
      stack?: string;
      tags?: Record<string, string | number | boolean>;
      codeFrames?: Array<{ file: string; line: number; firstLine: number; lines: string[] }>;
    }>("error"),
    errorGroupId: uuid("error_group_id").references(() => errorGroup.id, {
      onDelete: "set null",
    }),
    queue: text("queue"),
    jobName: text("job_name"),
    jobStatus: text("job_status", { enum: ["completed", "failed"] }),
    waitMs: doublePrecision("wait_ms"),
    attemptsMade: integer("attempts_made"),
    maxAttempts: integer("max_attempts"),
    enqueuedAt: text("enqueued_at"),
    tags: jsonbValue<Record<string, string | number | boolean>>("tags").notNull().default({}),
    /** Present only when the SDK's `http.capture` decided the request warrants it. */
    request: jsonbValue<Record<string, unknown>>("request"),
    spanCount: integer("span_count").notNull().default(0),
  },
  (table) => [
    index("execution_time").on(table.applicationId, table.startedAt.desc()),
    index("execution_trace").on(table.traceId),
    index("execution_operation").on(
      table.applicationId,
      table.operationRowId,
      table.startedAt.desc(),
    ),
    index("execution_errors").on(table.errorGroupId),
    index("execution_tags").using("gin", table.tags),
  ],
);

export const span = pgTable(
  "span",
  {
    id: pk(),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => execution.id, { onDelete: "cascade" }),
    /** Self-reference: the waterfall tree, flattened. */
    parentId: uuid("parent_id"),
    /** The wire's `s`, when the agent sent one. Not unique across executions. */
    spanId: text("span_id"),
    name: text("name"),
    origin: text("origin", { enum: ["manual", "auto"] }).notNull(),
    className: text("class_name").notNull(),
    method: text("method").notNull(),
    durationMs: doublePrecision("duration_ms"),
    startOffsetMs: doublePrecision("start_offset_ms"),
    error: boolean("error").notNull().default(false),
    tags: jsonbValue<Record<string, unknown>>("tags").notNull().default({}),
    /** `observe.collapsed`: how many sibling calls this node stands for. */
    collapsedCount: integer("collapsed_count"),
    depth: integer("depth").notNull().default(0),
    seq: integer("seq").notNull().default(0),
  },
  (table) => [
    index("span_execution").on(table.executionId, table.depth, table.seq),
    index("span_class").on(table.className, table.method),
    // "which class spends the time" is a first-class question in this product.
    index("span_name").on(table.name),
  ],
);

export const errorOccurrence = pgTable(
  "error_occurrence",
  {
    id: pk(),
    errorGroupId: uuid("error_group_id")
      .notNull()
      .references(() => errorGroup.id, { onDelete: "cascade" }),
    executionId: uuid("execution_id").references(() => execution.id, {
      onDelete: "set null",
    }),
    releaseId: uuid("release_id").references(() => release.id, { onDelete: "set null" }),
    occurredAt: ms("occurred_at").notNull(),
    stack: text("stack"),
    /**
     * Source around each in-app stack frame, read by the agent from its own
     * process (`createObserveModule({ sourceContext })`). The wire field is
     * `e.codeFrames`, and the frame shape is fixed by the SDK:
     *   { file, line, firstLine, lines[] }
     * It is the only way to show the failing code, because the collector cannot
     * read the customer's filesystem — and it is already redacted by the agent.
     */
    codeFrames: jsonbValue<Array<{ file: string; line: number; firstLine: number; lines: string[] }>>("code_frames"),
  },
  (table) => [
    index("error_occurrence_group").on(table.errorGroupId, table.occurredAt.desc()),
  ],
);

export const logEntry = pgTable(
  "log_entry",
  {
    id: pk(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "cascade" }),
    occurredAt: ms("occurred_at").notNull(),
    level: text("level", {
      enum: ["fatal", "error", "warn", "log", "debug", "verbose"],
    }),
    context: text("context"),
    text: text("text").notNull(),
    traceId: text("trace_id"),
    spanId: text("span_id"),
    attributes: jsonbValue<Record<string, unknown>>("attributes").notNull().default({}),
  },
  (table) => [
    index("log_time").on(table.applicationId, table.occurredAt.desc()),
    index("log_trace").on(table.traceId),
    index("log_level").on(table.applicationId, table.level, table.occurredAt.desc()),
  ],
);

export const runtimeSample = pgTable(
  "runtime_sample",
  {
    id: pk(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "cascade" }),
    receivedAt: ms("received_at").notNull(),
    /** `c`: {u: user µs, s: system µs, p: percent}. */
    cpu: jsonbValue<Record<string, number>>("cpu").notNull().default({}),
    /** `m`: {r: rss, ht: heapTotal, hu: heapUsed, e: external, ab: arrayBuffers, p}. */
    memory: jsonbValue<Record<string, number>>("memory").notNull().default({}),
    /** `g`: {c: count, td: total duration, b: {m, j, i}}. */
    gc: jsonbValue<Record<string, unknown>>("gc").notNull().default({}),
    /** `e`: {l: loop latency, u: utilisation}. */
    eventLoop: jsonbValue<Record<string, number>>("event_loop").notNull().default({}),
  },
  (table) => [index("runtime_time").on(table.applicationId, table.receivedAt.desc())],
);

export const metricSeries = pgTable(
  "metric_series",
  {
    id: pk(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type", { enum: ["counter", "gauge", "summary"] }).notNull(),
    /** Gauges only: how a value reported by several instances combines. */
    kind: text("kind", { enum: ["additive", "ratio", "peak"] }),
    labelsHash: text("labels_hash").notNull(),
    labels: jsonbValue<Record<string, string>>("labels").notNull().default({}),
    description: text("description"),
  },
  (table) => [
    uniqueIndex("metric_series_identity").on(
      table.applicationId,
      table.name,
      table.labelsHash,
    ),
    index("metric_series_labels").using("gin", table.labels),
  ],
);

export const metricPoint = pgTable(
  "metric_point",
  {
    seriesId: uuid("series_id")
      .notNull()
      .references(() => metricSeries.id, { onDelete: "cascade" }),
    at: ms("at").notNull(),
    value: real("value"),
    // Summary-only columns: the agent computes quantiles in-process over each
    // flush window, so raw observations never reach the collector.
    count: real("count"),
    sum: real("sum"),
    min: real("min"),
    max: real("max"),
    q50: real("q50"),
    q95: real("q95"),
    q99: real("q99"),
  },
  (table) => [
    primaryKey({ columns: [table.seriesId, table.at] }),
    index("metric_point_at").on(table.at.desc()),
  ],
);

/**
 * Per-minute pre-aggregation. The dashboard reads this, not `execution`, so an
 * overview page is O(minutes in range) rather than O(events).
 *
 * Percentiles come from a fixed log-scale histogram rather than per-minute
 * columns: p95 over a merged window cannot be derived from per-minute p95s, and
 * a dashboard that pretends otherwise is lying about the number people look at.
 */
export const rollupMinute = pgTable(
  "rollup_minute",
  {
    applicationId: uuid("application_id").notNull(),
    at: ms("at").notNull(),
    operationRowId: uuid("operation_row_id").notNull(),
    kind: text("kind", { enum: ["request", "job"] }).notNull(),
    count: integer("count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    clientErrorCount: integer("client_error_count").notNull().default(0),
    durationSum: doublePrecision("duration_sum").notNull().default(0),
    /**
     * 25 log-scale slots, 1 ms → ~8 s. `integer[]` rather than jsonb so the
     * per-minute merge is one `unnest(a, b)` instead of application-side JSON
     * arithmetic on a row we would have to lock and read first.
     */
    durationHist: integer("duration_hist").array().notNull().default(sql`'{}'::integer[]`),
  },
  (table) => [
    primaryKey({
      columns: [table.applicationId, table.at, table.operationRowId, table.kind],
    }),
    index("rollup_minute_time").on(table.applicationId, table.at.desc()),
  ],
);

// ---------------------------------------------------------------------------
// SLOs, alerts, filters, retention
// ---------------------------------------------------------------------------

export const slo = pgTable(
  "slo",
  {
    id: pk(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "cascade" }),
    operationId: text("operation_id").notNull(),
    method: text("method"),
    name: text("name"),
    kind: text("kind", { enum: ["availability", "latency", "job"] }).notNull(),
    target: doublePrecision("target").notNull(),
    /** Latency SLOs only: the threshold the target applies to. */
    underMs: doublePrecision("under_ms"),
    windowDays: integer("window_days").notNull().default(28),
    /** `code` for `@Objective()`; `dashboard` for one created in the UI. */
    source: text("source", { enum: ["code", "dashboard"] })
      .notNull()
      .default("code"),
    handler: text("handler"),
    releaseId: uuid("release_id").references(() => release.id, { onDelete: "set null" }),
    updatedAt: ms("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("slo_identity").on(
      table.applicationId,
      table.operationId,
      table.kind,
      table.underMs,
    ),
  ],
);

export const alertRule = pgTable(
  "alert_rule",
  {
    id: pk(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").references(() => application.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    description: text("description"),
    /** `request.error_rate`, `job.p95_wait`, `absence.requests`, `slo.burn`, … */
    metric: text("metric").notNull(),
    /** `above` | `below`. */
    comparator: text("comparator").notNull(),
    threshold: doublePrecision("threshold").notNull(),
    windowS: integer("window_s").notNull(),
    /**
     * `threshold` compares against `threshold`; `anomaly` compares against the
     * mean of the previous windows, `sigma` standard deviations out. The same
     * rule can be judged either way — that is the difference between "error rate
     * above 5%" and "error rate unusual for this hour".
     */
    detection: text("detection", { enum: ["threshold", "anomaly"] })
      .notNull()
      .default("threshold"),
    sigma: real("sigma"),
    severity: text("severity", { enum: ["low", "medium", "high", "critical"] })
      .notNull()
      .default("medium"),
    /**
     * What the rule looks at beyond the application: `operationId`, `method`,
     * `queueName`, `customMetricName`, `logPattern`, `logLevels`, `sloId`. Kept in
     * one JSONB column so a new scope does not need a migration; the evaluator
     * reads the keys it knows and ignores the rest.
     */
    scope: jsonbValue<Record<string, unknown>>("scope").notNull().default({}),
    channels: jsonbValue<Array<Record<string, unknown>>>("channels").notNull().default([]),
    /** `{ start: "22:00", end: "07:00", timezone: "Europe/Berlin" }`. */
    quietHours: jsonbValue<Record<string, unknown>>("quiet_hours"),
    enabled: boolean("enabled").notNull().default(true),
    mutedUntil: ms("muted_until"),
    createdAt: ms("created_at").notNull(),
    updatedAt: ms("updated_at").notNull().default(0),
  },
  (table) => [index("alert_rule_list").on(table.projectId, table.enabled, table.name)],
);

export const alertEvent = pgTable(
  "alert_event",
  {
    id: pk(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => alertRule.id, { onDelete: "cascade" }),
    /**
     * `firing` and `resolved` are transitions: one row per transition, so the
     * history reads OK → Firing → Resolved. `muted` records a firing that quiet
     * hours suppressed **without** making it "OK" — upstream is explicit that
     * muted is not resolved.
     */
    state: text("state", { enum: ["firing", "resolved"] }).notNull(),
    severity: text("severity", { enum: ["low", "medium", "high", "critical"] }),
    startedAt: ms("started_at").notNull(),
    resolvedAt: ms("resolved_at"),
    /** The measured value at the transition — what fired, in the rule's unit. */
    value: doublePrecision("value"),
    /** The rule's fingerprint at the time, plus per-channel delivery results. */
    payload: jsonbValue<unknown>("payload"),
    muted: boolean("muted").notNull().default(false),
  },
  (table) => [index("alert_event_rule").on(table.ruleId, table.startedAt.desc())],
);

export const dropFilter = pgTable("drop_filter", {
  id: pk(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  /** `http.route` | `http.url` | `operation` | `release` | `service`. */
  field: text("field").notNull(),
  /** `equals` | `prefix` | `contains` | `regex`. */
  matcher: text("matcher").notNull(),
  pattern: text("pattern").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: ms("created_at").notNull(),
});

/**
 * One row per setting. A new option is a row, not a migration — self-hosted
 * products accrete switches, and a migration per checkbox is a maintenance tax
 * nobody pays.
 *
 * Precedence: environment variable (bootstrap values only) > this table > code
 * default. See `docs/SELF-HOSTED.md` §4.
 */
export const instanceSetting = pgTable("instance_setting", {
  key: text("key").primaryKey(),
  value: jsonbValue<unknown>("value").notNull(),
  updatedAt: ms("updated_at").notNull(),
  updatedBy: uuid("updated_by").references(() => user.id, { onDelete: "set null" }),
});

/**
 * An invite is a single-use URL that carries no privilege: the role is bound
 * here, server-side. Valid for seven days.
 */
export const invite = pgTable(
  "invite",
  {
    id: pk(),
    /** SHA-256 of the token in the URL, never the token itself. */
    tokenHash: text("token_hash").notNull(),
    email: text("email").notNull(),
    /** Instance role granted on acceptance. */
    role: text("role", { enum: ["read", "write", "admin"] }).notNull().default("write"),
    invitedBy: uuid("invited_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: ms("created_at").notNull(),
    expiresAt: ms("expires_at").notNull(),
    acceptedAt: ms("accepted_at"),
    acceptedBy: uuid("accepted_by").references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [
    uniqueIndex("invite_token").on(table.tokenHash),
    index("invite_email").on(table.email),
  ],
);

/**
 * Append-only audit trail. A self-hoster asks "who deleted that key", and the
 * answer has to exist without a log aggregator.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: pk(),
    at: ms("at").notNull(),
    actorId: uuid("actor_id").references(() => user.id, { onDelete: "set null" }),
    actorEmail: text("actor_email"),
    action: text("action").notNull(),
    target: text("target"),
    detail: jsonbValue<unknown>("detail"),
    ip: text("ip"),
  },
  (table) => [index("audit_log_at").on(table.at.desc())],
);

/**
 * Retention is operator configuration, not a plan. `days = 0` keeps forever,
 * which is the correct default for a self-hosted install: the operator owns the
 * disk, so the operator decides.
 */
export const retentionPolicy = pgTable(
  "retention_policy",
  {
    id: pk(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    dataClass: text("data_class", {
      enum: ["traces", "logs", "metrics", "errors", "runtime"],
    }).notNull(),
    days: integer("days").notNull(),
  },
  (table) => [uniqueIndex("retention_class").on(table.projectId, table.dataClass)],
);

export const schemaMigration = pgTable("schema_migration", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  appliedAt: ms("applied_at").notNull(),
  // Drizzle's own migrator owns `drizzle.__drizzle_migrations`; this table is
  // our public statement of the schema version, for `/health` and for the
  // "refuse to start on a newer schema" guard.
});
