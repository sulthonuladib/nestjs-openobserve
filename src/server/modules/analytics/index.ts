/**
 * Analytics controller: the entity routes that hang off one application.
 *
 * Everything a *list* needs is project-scoped and lives in `/telemetry/…` (it
 * has to answer "all applications" as well as one). What remains here is
 * addressed by an id:
 *
 *   `/applications/:id`                          one application's header row
 *   `/applications/:id/operations/:operationRowId`  one operation's own page
 *   `/applications/:id/job?queue=&name=`         one job handler's own page
 *   `/applications/:id/slos` (POST)              create/replace an objective
 *   `/applications/:id/slos/:sloId` (DELETE)     delete a dashboard-owned one
 *
 * All of it is a read over data the ingest path already stores.
 */
import { Elysia, t } from "elysia";
import type { Config } from "../../plugins/config";
import { configPlugin } from "../../plugins/config";
import type { Db } from "../../plugins/database";
import { databasePlugin } from "../../plugins/database";
import { JobModel } from "../../db/models";
import { authGuard } from "../../plugins/auth";
import {
  applicationById,
  createSlo,
  deleteSlo,
  jobDetail,
  operationDetail,
} from "../analytics.service";
import { window } from "../telemetry.service";

const requireUser = { requireUser: true } as const;
const Range = t.Object({
  from: t.Optional(t.Numeric()),
  to: t.Optional(t.Numeric()),
});
const IdParams = t.Object({ id: t.String() });

/** Targets match the wire's own range: 90–99.999% over 7/14/28/30 days. */
const SloBody = t.Object({
  name: t.Optional(t.String({ maxLength: 120 })),
  kind: t.Union([t.Literal("availability"), t.Literal("latency"), t.Literal("job")]),
  target: t.Number({ minimum: 90, maximum: 99.999 }),
  underMs: t.Optional(t.Number({ minimum: 1, maximum: 600_000 })),
  windowDays: t.Optional(
    t.Union([t.Literal(7), t.Literal(14), t.Literal(28), t.Literal(30)]),
  ),
  /** Omit, or `*`, to watch the whole application. */
  operationId: t.Optional(t.String({ maxLength: 255 })),
});

export const analyticsModule = (deps: { config: Config; db: Db }) =>
  new Elysia({ name: "analytics" })
    .use(configPlugin(deps.config))
    .use(databasePlugin(deps.db))
    .use(authGuard(deps))

    /** One application's own row — the header the other pages render. */
    .get(
      "/applications/:id",
      async ({ db, params, status }) => {
        const app = await applicationById(db, params.id);
        return app ?? status(404, "application not found");
      },
      { ...requireUser, params: IdParams },
    )

    /**
     * One operation: its series, its slowest instances and its error groups.
     *
     * The series is the operation's own (`kind` and `operationRowId` come from
     * the operation row), not the application's traffic under a handler's name.
     */
    .get(
      "/applications/:id/operations/:operationRowId",
      async ({ db, params, query, status }) => {
        const detail = await operationDetail(
          db,
          params.id,
          params.operationRowId,
          window(query.from, query.to),
        );
        return detail ?? status(404, "operation not found");
      },
      {
        ...requireUser,
        params: t.Object({ id: t.String(), operationRowId: t.String() }),
        query: Range,
        detail: {
          summary: "One operation: its series, slowest instances and error groups",
        },
      },
    )

    /**
     * One job: throughput, failure rate, duration, queue wait, attempts and its
     * recent runs. `/telemetry/jobs` is the list; this is the page you open from
     * it.
     *
     * The pair travels in the query string, not the path: upstream keys a job's
     * handler `<queue>/<name>`, so a name can itself contain a slash, and a
     * two-param nested path is the shape Eden's typed client cannot express.
     */
    .get(
      "/applications/:id/job",
      async ({ db, params, query, status }) => {
        const detail = await jobDetail(
          db,
          params.id,
          query.queue,
          query.name,
          window(query.from, query.to),
          { limit: query.limit },
        );
        return detail ?? status(404, "no job with that queue and name");
      },
      {
        ...requireUser,
        params: IdParams,
        query: t.Composite([
          Range,
          t.Object({
            queue: t.String({ maxLength: 255 }),
            name: t.String({ maxLength: 255 }),
            limit: t.Optional(t.Numeric()),
          }),
        ]),
        response: { 200: JobModel.detail, 404: t.String() },
        detail: {
          summary: "One job: throughput, failures, duration, queue wait and recent runs",
          description:
            "Queue wait and attempt counts are the numbers that matter here: a job " +
            "that waited four minutes and ran in 10ms is invisible on duration " +
            "alone, and a handler that succeeds on its third attempt is a retry " +
            "storm, not a healthy job. A failed job opens no error group, so its " +
            "failure payload comes from the run itself.",
        },
      },
    )

    .post(
      "/applications/:id/slos",
      async ({ db, params, body, status }) => {
        if (body.kind === "latency" && body.underMs === undefined) {
          return status(400, "a latency SLO needs underMs");
        }
        const result = await createSlo(db, params.id, body);
        if (result.kind === "code-owned") {
          return status(
            409,
            "this objective is declared in code — change the @Objective() and deploy",
          );
        }
        return status(result.kind === "created" ? 201 : 200, { id: result.id });
      },
      {
        ...requireUser,
        params: IdParams,
        body: SloBody,
        detail: {
          summary: "Create or update a dashboard-owned SLO",
          description:
            "Code-declared objectives are refused: the next deploy would overwrite " +
            "the edit. Use one of the three SLI kinds upstream documents — " +
            "availability, latency-under-threshold, job success.",
        },
      },
    )

    .delete(
      "/applications/:id/slos/:sloId",
      async ({ db, params, status }) => {
        const result = await deleteSlo(db, params.id, params.sloId);
        if (result === "not-found") return status(404, "no such SLO");
        if (result === "code-owned") {
          return status(409, "this objective is declared in code — delete the @Objective()");
        }
        return { deleted: true };
      },
      {
        ...requireUser,
        params: t.Object({ id: t.String(), sloId: t.String() }),
        detail: { summary: "Delete a dashboard-owned SLO" },
      },
    );
