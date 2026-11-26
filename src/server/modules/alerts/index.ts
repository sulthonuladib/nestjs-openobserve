/**
 * Alerts controller: rules, history, open incidents, and the manual evaluation.
 *
 * Everything is addressed off `/alerts` rather than off an application: an alert
 * rule may watch the whole project (`applicationId` null) or one service, exactly
 * like the telemetry reads. The evaluator itself lives in `service.ts`; this file
 * is validation and the CRUD the page needs.
 *
 * `POST /alerts/evaluate` is not a debug hook to be embarrassed about: it is the
 * same function the timer calls, which makes the whole feature testable without
 * waiting for a clock, and lets an operator force a check after a deploy.
 */
import { Elysia, t } from "elysia";
import { desc, eq } from "drizzle-orm";
import type { Config } from "../../plugins/config";
import { configPlugin } from "../../plugins/config";
import type { Db } from "../../plugins/database";
import { databasePlugin } from "../../plugins/database";
import { authGuard } from "../../plugins/auth";
import { alertRule } from "../../db/schema";
import { DEFAULT_PROJECT_ID } from "../ingest/service";
import {
  ALERT_METRICS,
  alertEvents,
  evaluateRules,
  listRules,
  openIncidents,
  SELECTABLE_WINDOWS,
} from "./service";

const requireUser = { requireUser: true } as const;

/**
 * TypeBox needs a non-empty tuple of schemas, and the metric list is a runtime
 * array — hence the cast. The literal union still runs: an unknown metric is a
 * 422 before a handler sees it.
 */
type LiteralTuple = [ReturnType<typeof t.Literal>, ...ReturnType<typeof t.Literal>[]];
const Metric = t.Union(ALERT_METRICS.map((metric) => t.Literal(metric)) as LiteralTuple);
const Comparator = t.Union([t.Literal("above"), t.Literal("below")]);
const Severity = t.Union([
  t.Literal("low"),
  t.Literal("medium"),
  t.Literal("high"),
  t.Literal("critical"),
]);
const Detection = t.Union([t.Literal("threshold"), t.Literal("anomaly")]);

/** The windows the reference offers, in seconds. */
type NumberTuple = [ReturnType<typeof t.Literal>, ...ReturnType<typeof t.Literal>[]];
const WindowS = t.Union(
  SELECTABLE_WINDOWS.map((seconds) => t.Literal(seconds)) as NumberTuple,
);

const QuietHours = t.Object({
  start: t.String({ pattern: "^\\d{1,2}:\\d{2}$" }),
  end: t.String({ pattern: "^\\d{1,2}:\\d{2}$" }),
  timezone: t.Optional(t.String({ maxLength: 64 })),
});

const Channel = t.Object({
  type: t.Union([
    t.Literal("in-app"),
    t.Literal("webhook"),
    t.Literal("slack"),
    t.Literal("email"),
  ]),
  url: t.Optional(t.String({ maxLength: 512 })),
});

const Scope = t.Object({
  operationId: t.Optional(t.String({ maxLength: 255 })),
  queueName: t.Optional(t.String({ maxLength: 255 })),
  customMetricName: t.Optional(t.String({ maxLength: 255 })),
  logPattern: t.Optional(t.String({ maxLength: 255 })),
  logLevels: t.Optional(t.Array(t.String({ maxLength: 16 }))),
  sloId: t.Optional(t.String()),
});

const RuleBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 120 }),
  description: t.Optional(t.String({ maxLength: 500 })),
  metric: Metric,
  comparator: Comparator,
  threshold: t.Number(),
  windowS: WindowS,
  detection: t.Optional(Detection),
  sigma: t.Optional(t.Number({ minimum: 1, maximum: 10 })),
  severity: t.Optional(Severity),
  applicationId: t.Optional(t.String()),
  scope: t.Optional(Scope),
  channels: t.Optional(t.Array(Channel)),
  quietHours: t.Optional(t.Union([QuietHours, t.Null()])),
  enabled: t.Optional(t.Boolean()),
});

const RulePatch = t.Partial(RuleBody);

export const alertsModule = (deps: { config: Config; db: Db }) =>
  new Elysia({ name: "alerts", prefix: "/alerts" })
    .use(configPlugin(deps.config))
    .use(databasePlugin(deps.db))
    .use(authGuard(deps))

    .get("/rules", ({ db }) => listRules(db).then((items) => ({ items })), {
      ...requireUser,
      detail: {
        summary: "Alert rules with their current value and state",
        description:
          "State is computed on read for display; the event history is written by " +
          "the evaluator, so opening this page never opens or closes an incident.",
      },
    })

    .post(
      "/rules",
      async ({ db, body, status }) => {
        const id = Bun.randomUUIDv7();
        const now = Date.now();
        await db.insert(alertRule).values({
          id,
          projectId: DEFAULT_PROJECT_ID,
          applicationId: body.applicationId ?? null,
          name: body.name,
          description: body.description ?? null,
          metric: String(body.metric),
          comparator: body.comparator,
          threshold: body.threshold,
          windowS: Number(body.windowS),
          detection: body.detection ?? "threshold",
          sigma: body.sigma ?? null,
          severity: body.severity ?? "medium",
          scope: body.scope ?? {},
          channels: body.channels ?? [{ type: "in-app" }],
          quietHours: body.quietHours ?? null,
          enabled: body.enabled ?? true,
          createdAt: now,
          updatedAt: now,
        });
        return status(201, { id });
      },
      { ...requireUser, body: RuleBody, detail: { summary: "Create an alert rule" } },
    )

    .patch(
      "/rules/:id",
      async ({ db, params, body, status }) => {
        const rows = await db
          .select({ id: alertRule.id })
          .from(alertRule)
          .where(eq(alertRule.id, params.id))
          .limit(1);
        if (!rows[0]) return status(404, "no such rule");
        await db
          .update(alertRule)
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.metric !== undefined ? { metric: String(body.metric) } : {}),
            ...(body.comparator !== undefined ? { comparator: body.comparator } : {}),
            ...(body.threshold !== undefined ? { threshold: body.threshold } : {}),
            ...(body.windowS !== undefined ? { windowS: Number(body.windowS) } : {}),
            ...(body.detection !== undefined ? { detection: body.detection } : {}),
            ...(body.sigma !== undefined ? { sigma: body.sigma } : {}),
            ...(body.severity !== undefined ? { severity: body.severity } : {}),
            ...(body.applicationId !== undefined
              ? { applicationId: body.applicationId || null }
              : {}),
            ...(body.scope !== undefined ? { scope: body.scope } : {}),
            ...(body.channels !== undefined ? { channels: body.channels } : {}),
            ...(body.quietHours !== undefined ? { quietHours: body.quietHours } : {}),
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
            updatedAt: Date.now(),
          })
          .where(eq(alertRule.id, params.id));
        return { ok: true };
      },
      {
        ...requireUser,
        params: t.Object({ id: t.String() }),
        body: RulePatch,
        detail: {
          summary: "Edit, enable/pause a rule",
          description:
            "A paused rule keeps its history; it just stops being evaluated, so " +
            "pausing cannot silently resolve an open incident.",
        },
      },
    )

    .delete(
      "/rules/:id",
      async ({ db, params }) => {
        await db.delete(alertRule).where(eq(alertRule.id, params.id));
        return { deleted: true };
      },
      {
        ...requireUser,
        params: t.Object({ id: t.String() }),
        detail: { summary: "Delete a rule and its event history" },
      },
    )

    /** Silence delivery for a while without touching the rule. */
    .post(
      "/rules/:id/mute",
      async ({ db, params, body, status }) => {
        const rows = await db
          .select({ id: alertRule.id })
          .from(alertRule)
          .where(eq(alertRule.id, params.id))
          .limit(1);
        if (!rows[0]) return status(404, "no such rule");
        const minutes = body.minutes;
        await db
          .update(alertRule)
          .set({
            mutedUntil: minutes === null ? null : Date.now() + minutes * 60_000,
            updatedAt: Date.now(),
          })
          .where(eq(alertRule.id, params.id));
        return { mutedUntil: minutes === null ? null : Date.now() + minutes * 60_000 };
      },
      {
        ...requireUser,
        params: t.Object({ id: t.String() }),
        body: t.Object({ minutes: t.Union([t.Number({ minimum: 1, maximum: 43_200 }), t.Null()]) }),
        detail: {
          summary: "Mute a rule for N minutes (null unmutes)",
          description:
            "Muted is not resolved: the event is still recorded, delivery is skipped.",
        },
      },
    )

    .get(
      "/events",
      ({ db, query }) => alertEvents(db, query.limit).then((items) => ({ items })),
      {
        ...requireUser,
        query: t.Object({ limit: t.Optional(t.Numeric()) }),
        detail: {
          summary: "Alert history: one row per transition, newest first",
          description:
            "Each firing and each resolution is its own row, joined to the rule's " +
            "name and metric so history survives a rule edit. `muted` means the " +
            "firing happened during quiet hours and delivery was skipped.",
        },
      },
    )

    .get("/incidents", ({ db }) => openIncidents(db).then((items) => ({ items })), {
      ...requireUser,
      detail: {
        summary: "Open incidents (firing, not resolved)",
        description: "What the sidebar badge and the dashboard card count.",
      },
    })

    .post(
      "/evaluate",
      async ({ db }) => evaluateRules(db),
      {
        ...requireUser,
        detail: {
          summary: "Evaluate every enabled rule now",
          description:
            "The same function the in-process timer calls. Safe to call twice: " +
            "a second evaluation in the same state writes nothing.",
        },
      },
    );
