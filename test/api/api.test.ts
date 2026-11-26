/**
 * API-level tests.
 *
 * These call `app.handle(new Request(...))` rather than binding a port: Elysia's
 * handler runs with the full lifecycle (validation, decorators, error mapping)
 * without a socket, so the suite is fast and needs no orchestration. A real
 * Postgres is required — the queries are the thing under test, and a fake would
 * only test the fake.
 *
 * Run with a database:  OBSERVE_DATABASE_URL=postgres://… bun test test/api
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { createApiApp } from "../../src/server/app";
import { loadConfig } from "../../src/server/plugins/config";
import { connectDatabase } from "../../src/server/plugins/database";
import { sampleBatch } from "../../src/fixtures";

/**
 * A database of its own. These tests TRUNCATE every table in `beforeEach`, so
 * pointing them at the dev database deletes the operator's admin account and
 * telemetry — which is exactly what happened once.
 *
 *   createdb -h 127.0.0.1 -p 5433 -U observe observe_test
 */
const databaseUrl =
  process.env.OBSERVE_TEST_DATABASE_URL ??
  "postgres://observe:observe@localhost:5433/observe_test";

/*
 * Bun loads `.env`, so `OBSERVE_DATABASE_URL` is the dev database in every test
 * run. This suite TRUNCATEs every table in `beforeEach`; falling back to the dev
 * URL once replaced an operator's admin account and telemetry with fixtures.
 *
 * Two defences: the test URL is the only one read (no `OBSERVE_DATABASE_URL`
 * fallback), and the database name must say `_test`. A typo now fails before the
 * first connection instead of after the first TRUNCATE.
 */
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
if (!databaseName.endsWith("_test")) {
  throw new Error(
    `refusing to run the API suite against "${databaseName}": it truncates every table. ` +
      "Set OBSERVE_TEST_DATABASE_URL to a database whose name ends in _test.",
  );
}

// Small pools on purpose: this suite runs next to a dev server and a Postgres
// that other projects share, and a 20-connection pool per test file is how you
// discover `max_connections`.
const connection = await connectDatabase({
  url: databaseUrl,
  runMigrations: true,
  maxConnections: 4,
});
const maintenance = new SQL({ url: databaseUrl, max: 1 });
const config = loadConfig({
  OBSERVE_DATABASE_URL: databaseUrl,
  OBSERVE_ALLOW_ANONYMOUS_INGEST: "1",
});

const app = await createApiApp({ config, db: connection.db });

/**
 * Every non-auth route now requires a session, so the suite bootstraps an admin
 * the same way a fresh install does — through `/auth/setup` — and keeps the
 * cookie. That means the auth path is exercised by every test rather than mocked.
 */
let sessionCookie = "";

async function setupInstance(): Promise<void> {
  const response = await app.handle(
    new Request("http://localhost/api/v1/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.test",
        password: "correct horse battery",
        name: "Admin",
        instanceName: "Test",
      }),
    }),
  );
  if (response.status !== 201) {
    throw new Error(`setup failed: ${response.status} ${await response.text()}`);
  }
  const cookie = response.headers.get("set-cookie") ?? "";
  sessionCookie = cookie.split(";")[0] ?? "";
}

/** Authenticated request: the default for everything except the auth tests. */
function authed(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: { ...init.headers, cookie: sessionCookie },
  });
}

function batchRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  const compressed = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(body)));
  return new Request("http://localhost/applications/telemetry", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip",
      ...headers,
    },
    body: compressed,
  });
}

/**
 * Every table, so `beforeEach` starts from a clean instance — including
 * `app_user`, without which the second test's setup is a 409.
 */
const TRUNCATE = `TRUNCATE
  audit_log, invite, instance_setting,
  session, team_member, project_member, team,
  app_credential, cli_link_session, application, project, app_user,
  release, operation, error_group, error_occurrence, execution, span,
  log_entry, runtime_sample, metric_series, metric_point, rollup_minute,
  slo, alert_rule, alert_event, drop_filter, retention_policy
  CASCADE`;

beforeEach(async () => {
  await maintenance.unsafe(TRUNCATE);
  await setupInstance();
});

afterAll(async () => {
  await maintenance.close();
  await connection.close();
});

describe("ingest", () => {
  it("accepts a realistic gzipped batch and answers degraded:false", async () => {
    const response = await app.handle(batchRequest(sampleBatch()));
    expect(response.status).toBe(200);
    // The single most important invariant in the product: every degraded flag in
    // the SDK is a billing concept, and answering true makes the agent drop data.
    expect(await response.json()).toEqual({ degraded: false });
  });

  it("refuses a batch that violates the contract with a 400 and dotted paths", async () => {
    const batch = sampleBatch() as unknown as Record<string, unknown>;
    (batch.snapshots as Array<Record<string, unknown>>)[0]!.op = undefined;
    const response = await app.handle(batchRequest(batch));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { problems?: Array<{ path: string }> };
    expect(body.problems?.some((problem) => problem.path.includes("op"))).toBe(true);
  });

  it("refuses unknown keys, the way the hosted API's forbidNonWhitelisted does", async () => {
    const batch = { ...sampleBatch(), surprise: true };
    const response = await app.handle(batchRequest(batch));
    expect(response.status).toBe(400);
  });

  it("refuses a body it cannot gunzip with a 400, not a 500", async () => {
    const response = await app.handle(
      new Request("http://localhost/applications/telemetry", {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: "not gzip at all",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("reports unsupported content-encoding as 415", async () => {
    const response = await app.handle(
      new Request("http://localhost/applications/telemetry", {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "br" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(415);
  });

  it("rejects unknown credentials with 401", async () => {
    const response = await app.handle(
      batchRequest(sampleBatch(), {
        "x-api-key": "obs_nope",
        "x-api-secret": "nope",
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe("query api", () => {
  it("round-trips an ingested batch into applications, executions and errors", async () => {
    const batch = sampleBatch();
    await app.handle(batchRequest(batch));

    const applications = await (
      await app.handle(authed("http://localhost/api/v1/applications"))
    ).json() as Array<{ id: string; name: string; requests: number; p95DurationMs: number | null }>;

    expect(applications).toHaveLength(1);
    expect(applications[0]!.name).toBe("orders-api");
    // A job is not a request: the fixture carries one job, and it must not be
    // counted in the applications list's request total.
    expect(applications[0]!.requests).toBe(batch.snapshots?.length ?? 0);
    // p95 comes from the merged histogram, so it must be a real number, and it
    // must be the requests' p95 — jobs are merged only into their own kind.
    expect(typeof applications[0]!.p95DurationMs).toBe("number");

    const appId = applications[0]!.id;
    const executions = await (
      await app.handle(
        authed(`http://localhost/api/v1/telemetry/executions?applicationId=${appId}&limit=10`),
      )
    ).json() as { items: Array<{ id: string }>; nextCursor: string | null };

    expect(executions.items).toHaveLength(3);
    expect(executions.nextCursor).not.toBeNull();

    const detail = await (
      await app.handle(
        authed(`http://localhost/api/v1/executions/${executions.items[0]!.id}`),
      )
    ).json() as { spans: unknown[]; logs: unknown[] };

    // The detail endpoint returns the flattened span tree and correlated logs.
    expect(Array.isArray(detail.spans)).toBe(true);
    expect(Array.isArray(detail.logs)).toBe(true);
  });

  it("keeps one error group across a replayed batch, incrementing occurrences", async () => {
    const batch = sampleBatch();
    await app.handle(batchRequest(batch));

    const applications = await (
      await app.handle(authed("http://localhost/api/v1/applications"))
    ).json() as Array<{ id: string }>;
    const appId = applications[0]!.id;

    await app.handle(batchRequest(batch));

    const errors = await (
      await app.handle(authed(`http://localhost/api/v1/telemetry/errors?applicationId=${appId}`))
    ).json() as Array<{ id: string; occurrences: number }>;

    // Fingerprinting is the product feature: the same bug twice is one row.
    expect(errors).toHaveLength(1);
    expect(errors[0]!.occurrences).toBe(2);

    const patched = await app.handle(
      authed(`http://localhost/api/v1/errors/${errors[0]!.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "resolved" }),
      }),
    );
    expect(patched.status).toBe(200);
  });

  it("stores the agent's code frames for an error and returns them on detail", async () => {
    const batch = {
      serviceId: "orders-api",
      snapshots: [
        {
          ti: crypto.randomUUID(),
          d: 12,
          p: "http",
          op: "GET /orders/boom",
          a: { m: "GET", sc: 500 },
          e: {
            cls: "TypeError",
            message: "boom",
            stack: "TypeError: boom\n    at OrdersController.boom (/app/orders.controller.js:10:2)",
            codeFrames: [
              { file: "/app/orders.controller.js", line: 10, firstLine: 8, lines: ["a", "b", "c", "d", "e"] },
              // Not the SDK's shape, and empty: dropped by the normalizer
              // instead of failing the batch.
              { file: 42, line: 1, firstLine: 1, lines: [] },
            ],
          },
          t: [],
        },
      ],
    };
    await app.handle(batchRequest(batch));

    const applications = (await (
      await app.handle(authed("http://localhost/api/v1/applications"))
    ).json()) as Array<{ id: string }>;
    const errors = (await (
      await app.handle(authed(`http://localhost/api/v1/telemetry/errors?applicationId=${applications[0]!.id}`))
    ).json()) as Array<{ id: string }>;

    const detail = (await (
      await app.handle(authed(`http://localhost/api/v1/errors/${errors[0]!.id}`))
    ).json()) as {
      occurrences: Array<{ codeFrames: unknown }>;
    };
    expect(detail.occurrences[0]!.codeFrames).toEqual([
      { file: "/app/orders.controller.js", line: 10, firstLine: 8, lines: ["a", "b", "c", "d", "e"] },
    ]);
  });

  it("stores custom metric label dimensions and summary statistics", async () => {
    // The wire's `v` map is keyed by the SDK's serialised label object, and a
    // summary has no `v` at all: its payload is q*/ct/sm/mx. Both used to be
    // mishandled at ingest (labels stored as the raw key, summaries dropped).
    const batch = {
      serviceId: "orders-api",
      custom: [
        {
          n: "orders_created_total",
          t: "counter",
          l: ["route"],
          v: { '{"route":"POST /orders"}': 3 },
        },
        {
          n: "orders_create_duration_ms",
          t: "summary",
          l: ["route"],
          q50: { '{"route":"POST /orders"}': 12 },
          q95: { '{"route":"POST /orders"}': 18 },
          q99: { '{"route":"POST /orders"}': 20 },
          ct: { '{"route":"POST /orders"}': 4 },
          sm: { '{"route":"POST /orders"}': 48 },
          mx: { '{"route":"POST /orders"}': 21 },
        },
      ],
    };
    await app.handle(batchRequest(batch));

    const applications = (await (
      await app.handle(authed("http://localhost/api/v1/applications"))
    ).json()) as Array<{ id: string }>;
    const appId = applications[0]!.id;

    const series = (await (
      await app.handle(authed(`http://localhost/api/v1/telemetry/metrics?applicationId=${appId}`))
    ).json()) as Array<{ name: string; type: string; labels: Record<string, string> }>;

    const counter = series.find((row) => row.name === "orders_created_total");
    const summary = series.find((row) => row.name === "orders_create_duration_ms");
    expect(counter?.labels).toEqual({ route: "POST /orders" });
    expect(summary?.type).toBe("summary");

    const to = Date.now();
    const points = (await (
      await app.handle(
        authed(
          `http://localhost/api/v1/telemetry/metrics/orders_create_duration_ms?applicationId=${appId}&from=${to - 60_000}&to=${to + 60_000}`,
        ),
      )
    ).json()) as Array<{ count: number | null; sum: number | null; q50: number | null }>;
    expect(points[0]).toMatchObject({ count: 4, sum: 48, q50: 12 });
  });

  it("ranks operations by volume", async () => {
    const batch = sampleBatch();
    await app.handle(batchRequest(batch));

    const applications = await (
      await app.handle(authed("http://localhost/api/v1/applications"))
    ).json() as Array<{ id: string }>;

    const operations = await (
      await app.handle(
        authed(`http://localhost/api/v1/telemetry/operations?applicationId=${applications[0]!.id}`),
      )
    ).json() as Array<{ operationId: string | null; count: number; p95DurationMs: number | null }>;

    expect(operations.length).toBeGreaterThan(0);
    const counts = operations.map((operation) => operation.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  /**
   * The rule the whole jobs/requests split exists for: `rollup_minute` carries
   * both kinds, and every request-facing aggregate has to filter `kind`. Without
   * this test a nightly cron silently inflates request rate, error rate and p95
   * on the overview — the numbers an operator trusts most.
   */
  it("counts a job as a job, never as a request", async () => {
    const batch = sampleBatch();
    expect(batch.jobs?.length).toBe(1);
    expect(batch.snapshots?.length).toBe(2);
    await app.handle(batchRequest(batch));

    const applications = await (
      await app.handle(authed("http://localhost/api/v1/applications"))
    ).json() as Array<{ id: string; requests: number }>;
    const appId = applications[0]!.id;
    expect(applications[0]!.requests).toBe(2);

    // The default series is requests, and it says so.
    const requests = await (
      await app.handle(authed(`http://localhost/api/v1/telemetry/timeseries?applicationId=${appId}`))
    ).json() as { kind: string; summary: { requests: number } };
    expect(requests.kind).toBe("request");
    expect(requests.summary.requests).toBe(2);

    // The same endpoint, asked for jobs, answers with the job and only the job.
    const jobRuns = await (
      await app.handle(
        authed(`http://localhost/api/v1/telemetry/timeseries?applicationId=${appId}&kind=job`),
      )
    ).json() as { kind: string; summary: { requests: number } };
    expect(jobRuns.kind).toBe("job");
    expect(jobRuns.summary.requests).toBe(1);

    // Operations are requests by default; the job's handler is a separate kind.
    const operations = await (
      await app.handle(authed(`http://localhost/api/v1/telemetry/operations?applicationId=${appId}`))
    ).json() as Array<{ kind: string; count: number }>;
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every((operation) => operation.kind === "request")).toBe(true);
    expect(operations.reduce((sum, operation) => sum + operation.count, 0)).toBe(2);

    const jobOperations = await (
      await app.handle(
        authed(`http://localhost/api/v1/telemetry/operations?applicationId=${appId}&kind=job`),
      )
    ).json() as Array<{ kind: string; count: number }>;
    expect(jobOperations.length).toBe(1);
    expect(jobOperations[0]!.kind).toBe("job");
    expect(jobOperations[0]!.count).toBe(1);

    // …and the job is still fully visible where jobs belong.
    const jobs = await (
      await app.handle(authed(`http://localhost/api/v1/telemetry/jobs?applicationId=${appId}`))
    ).json() as Array<{ queue: string | null; jobName: string | null; runs: number }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.queue).toBe("invoices");
    expect(jobs[0]!.jobName).toBe("send-invoice");
    expect(jobs[0]!.runs).toBe(1);

    // Executions are the raw log of both kinds, so the kind filter is honoured
    // there too rather than assumed.
    const jobExecutions = await (
      await app.handle(
        authed(`http://localhost/api/v1/telemetry/executions?applicationId=${appId}&kind=job`),
      )
    ).json() as { items: Array<{ kind: string }> };
    expect(jobExecutions.items).toHaveLength(1);
    expect(jobExecutions.items[0]!.kind).toBe("job");
  });

  /**
   * The distributed-tracing contract: one id, every hop, each with its own spans,
   * its application and its handler. The dashboard's trace page is built straight
   * off this shape, so a regression here is a blank page there.
   */
  it("returns every service that shared a trace id, with spans and logs", async () => {
    const traceId = "0192f3b4-7c8d-7e9f-a1b2-0000000000ff";
    const gateway = sampleBatch({ serviceId: "orders-gateway" });
    gateway.snapshots![0] = { ...gateway.snapshots![0]!, ti: traceId };
    const worker = sampleBatch({ serviceId: "orders-worker" });
    worker.jobs![0] = { ...worker.jobs![0]!, ti: traceId };
    worker.logs![0] = { ...worker.logs![0]!, traceId };

    expect((await app.handle(batchRequest(gateway))).status).toBe(200);
    expect((await app.handle(batchRequest(worker))).status).toBe(200);

    const response = await app.handle(authed(`http://localhost/api/v1/traces/${traceId}`));
    expect(response.status).toBe(200);
    const trace = (await response.json()) as {
      traceId: string;
      startedAt: number;
      durationMs: number | null;
      applications: Array<{ name: string; serviceId: string }>;
      executions: Array<{
        execution: { kind: string; traceId: string; startedAt: number };
        applicationName: string;
        serviceId: string;
        operation: { operationId: string } | null;
        spans: unknown[];
      }>;
      logs: Array<{ traceId: string; applicationName: string }>;
    };

    expect(trace.traceId).toBe(traceId);
    // The hops are named, not `svc #2`: the point of a trace is which service
    // made the call, so both applications must appear.
    expect(trace.applications.map((entry) => entry.serviceId).sort()).toEqual([
      "orders-gateway",
      "orders-worker",
    ]);
    expect(trace.executions).toHaveLength(2);
    expect(trace.executions.map((hop) => hop.execution.kind).sort()).toEqual(["job", "request"]);
    for (const hop of trace.executions) {
      expect(hop.execution.traceId).toBe(traceId);
      expect(hop.applicationName).toBeTruthy();
      expect(hop.operation?.operationId).toBeTruthy();
      expect(hop.spans.length).toBeGreaterThan(0);
    }
    // The trace's clock starts at its first hop, not at the sum of durations.
    expect(trace.startedAt).toBeLessThanOrEqual(
      Math.min(...trace.executions.map((hop) => hop.execution.startedAt)),
    );
    expect(typeof trace.durationMs).toBe("number");

    // Logs are correlated by trace id, and say which application wrote them.
    expect(trace.logs.length).toBeGreaterThan(0);
    expect(trace.logs.every((entry) => entry.traceId === traceId)).toBe(true);
    expect(trace.logs[0]!.applicationName).toBe("orders-worker");
  });

  it("aggregates every list across applications when no scope is given", async () => {
    // The top bar's "All applications" is a *value*, not a missing filter: every
    // list has to aggregate and name the application each row belongs to.
    const gateway = sampleBatch({ serviceId: "orders-gateway" });
    const api = sampleBatch({ serviceId: "orders-api" });
    expect((await app.handle(batchRequest(gateway))).status).toBe(200);
    expect((await app.handle(batchRequest(api))).status).toBe(200);

    const operations = (await (
      await app.handle(authed("http://localhost/api/v1/telemetry/operations?from=0"))
    ).json()) as Array<{
      kind: string;
      count: number;
      applicationId: string;
      applicationName: string;
      serviceId: string;
    }>;
    const services = new Set(operations.map((row) => row.serviceId));
    expect(services).toEqual(new Set(["orders-api", "orders-gateway"]));
    expect(operations.some((row) => row.kind !== "request")).toBe(false);
    expect(operations.every((row) => Boolean(row.applicationName))).toBe(true);

    const applications = (await (
      await app.handle(authed("http://localhost/api/v1/applications?from=0"))
    ).json()) as Array<{ requests: number }>;
    expect(operations.reduce((sum, row) => sum + row.count, 0)).toBe(
      applications.reduce((sum, row) => sum + row.requests, 0),
    );

    // Jobs and errors carry the application name too; a merged stream without it
    // is a list of columns nobody can act on.
    const jobs = (await (
      await app.handle(authed("http://localhost/api/v1/telemetry/jobs?from=0"))
    ).json()) as Array<{ applicationName: string }>;
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((row) => Boolean(row.applicationName))).toBe(true);

    const errors = (await (
      await app.handle(authed("http://localhost/api/v1/telemetry/errors"))
    ).json()) as Array<{ applicationName: string }>;
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((row) => Boolean(row.applicationName))).toBe(true);

    // Runtime is per-process on purpose: an averaged heap chart across services
    // would invent a host that does not exist.
    const runtime = await app.handle(
      authed("http://localhost/api/v1/telemetry/runtime?from=0"),
    );
    expect(runtime.status).toBe(400);
  });

  /**
   * The three span-derived views. They share one source (`span`) and one rule —
   * own time is never more than total time, an edge is a trace continuation, and
   * `mode=manual` means the spans the application created itself.
   */
  it("derives services, the service map and span analytics from spans", async () => {
    const traceId = "0192f3b4-7c8d-7e9f-a1b2-0000000000dd";
    const gateway = sampleBatch({ serviceId: "orders-gateway" });
    gateway.snapshots![0] = {
      ...gateway.snapshots![0]!,
      ti: traceId,
      ct: new Date(Date.now() - 3_000).toISOString(),
      // A span the application made itself: the Spans page's `mode=manual`.
      t: [
        {
          n: "load-cart",
          o: "manual",
          c: "CartService",
          m: "load",
          d: 12,
          so: 0,
        },
      ],
    };
    const api = sampleBatch({ serviceId: "orders-api" });
    api.snapshots![0] = {
      ...api.snapshots![0]!,
      ti: traceId,
      ct: new Date(Date.now() - 2_000).toISOString(),
    };

    expect((await app.handle(batchRequest(gateway))).status).toBe(200);
    expect((await app.handle(batchRequest(api))).status).toBe(200);

    const services = (await (
      await app.handle(authed("http://localhost/api/v1/telemetry/services?from=0"))
    ).json()) as Array<{
      applicationName: string;
      className: string;
      calls: number;
      ownMs: number;
      totalMs: number;
      methods: Array<{ method: string; ownMs: number }>;
    }>;
    expect(services.length).toBeGreaterThan(0);
    const cart = services.find((row) => row.className === "CartService");
    expect(cart).toBeDefined();
    expect(cart!.applicationName).toBe("orders-gateway");
    expect(cart!.methods.map((method) => method.method)).toContain("load");
    // Own time is the span's own work; total time includes everything nested, so
    // own can never exceed it (a parent is always at least its children's sum).
    for (const row of services) expect(row.ownMs).toBeLessThanOrEqual(row.totalMs + 1);

    const map = (await (
      await app.handle(authed("http://localhost/api/v1/telemetry/map?from=0"))
    ).json()) as {
      nodes: Array<{ serviceId: string }>;
      edges: Array<{ fromName: string; toName: string; traces: number }>;
    };
    expect(map.nodes.map((node) => node.serviceId).sort()).toEqual(["orders-api", "orders-gateway"]);
    // The fixtures share three trace ids across their snapshots and their job, so
    // the same pair of applications appears in three traces — one edge, three
    // traces, pointing gateway → api because the gateway's `calledAt` is earlier.
    const edge = map.edges.find(
      (candidate) => candidate.fromName === "orders-gateway" && candidate.toName === "orders-api",
    );
    expect(edge).toBeDefined();
    expect(edge!.traces).toBeGreaterThanOrEqual(1);
    expect(map.edges.every((candidate) => candidate.fromName !== candidate.toName)).toBe(true);

    const manual = (await (
      await app.handle(authed("http://localhost/api/v1/telemetry/spans?from=0"))
    ).json()) as {
      series: Array<{ invocations: number }>;
      rows: Array<{ name: string; origin: string; invocations: number }>;
    };
    expect(manual.rows.length).toBeGreaterThan(0);
    expect(manual.rows.every((row) => row.origin === "manual")).toBe(true);
    expect(manual.rows.some((row) => row.name === "load-cart")).toBe(true);
    expect(manual.series.length).toBeGreaterThan(0);

    const all = (await (
      await app.handle(authed("http://localhost/api/v1/telemetry/spans?from=0&mode=all"))
    ).json()) as { rows: Array<{ origin: string }> };
    expect(all.rows.length).toBeGreaterThan(manual.rows.length);
    expect(new Set(all.rows.map((row) => row.origin))).toEqual(new Set(["auto", "manual"]));
  });

  it("answers 404 for a trace id nothing reported", async () => {
    const response = await app.handle(
      authed("http://localhost/api/v1/traces/0192f3b4-7c8d-7e9f-a1b2-0000000000ee"),
    );
    expect(response.status).toBe(404);
  });

  /**
   * The job detail page's payload. The job/request split is asserted above; this
   * asserts the job's own vocabulary — runs, failures, **queue wait**, attempts —
   * and that an unknown handler is a 404 rather than an empty page.
   */
  it("serves one job's throughput, queue wait and runs", async () => {
    const batch = sampleBatch();
    await app.handle(batchRequest(batch));

    const applications = await (
      await app.handle(authed("http://localhost/api/v1/applications"))
    ).json() as Array<{ id: string }>;
    const appId = applications[0]!.id;

    const detail = await app.handle(
      authed(
        `http://localhost/api/v1/applications/${appId}/job?queue=invoices&name=send-invoice`,
      ),
    );
    expect(detail.status).toBe(200);
    const job = (await detail.json()) as {
      queue: string;
      jobName: string;
      runs: number;
      completed: number;
      failed: number;
      failureRate: number;
      p95WaitMs: number;
      maxWaitMs: number;
      series: { bucketMs: number; points: unknown[] };
      waitSeries: { bucketMs: number; points: Array<{ avgMs: number | null }> };
      recent: Array<{ id: string; traceId: string; jobStatus: string; waitMs: number | null }>;
    };

    expect(job.queue).toBe("invoices");
    expect(job.jobName).toBe("send-invoice");
    expect(job.runs).toBe(1);
    expect(job.completed).toBe(1);
    expect(job.failed).toBe(0);
    expect(job.failureRate).toBe(0);
    // The fixture's job waited 3400ms in the queue; that number is the reason the
    // page exists, so it must survive the round trip.
    expect(job.p95WaitMs).toBeCloseTo(3400, 0);
    expect(job.maxWaitMs).toBeCloseTo(3400, 0);
    expect(job.series.points.length).toBeGreaterThan(0);
    expect(job.waitSeries.points.length).toBeGreaterThan(0);
    expect(job.waitSeries.points[0]!.avgMs).toBeCloseTo(3400, 0);
    expect(job.recent).toHaveLength(1);
    expect(job.recent[0]!.jobStatus).toBe("completed");
    expect(job.recent[0]!.traceId).toBe(batch.jobs![0]!.ti);

    const missing = await app.handle(
      authed(`http://localhost/api/v1/applications/${appId}/job?queue=invoices&name=nope`),
    );
    expect(missing.status).toBe(404);
  });

  it("answers 404 for an execution that does not exist", async () => {
    const response = await app.handle(
      authed("http://localhost/api/v1/executions/00000000-0000-7000-8000-000000000000"),
    );
    expect(response.status).toBe(404);
  });

  it("reports health with the three versions", async () => {
    const health = await (
      await app.handle(new Request("http://localhost/health"))
    ).json() as Record<string, unknown>;
    expect(health.ok).toBe(true);
    expect(health.ingestApi).toBe("v1");
    expect(String(health.sdk)).toContain("0.3.17");
  });
});

describe("auth", () => {
  it("refuses a second setup — the wizard must not be a reset button", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/v1/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "other@example.test",
          password: "another good passphrase",
        }),
      }),
    );
    expect(response.status).toBe(409);
  });

  it("reports setup as done and registration as invite-only", async () => {
    const status = (await (
      await app.handle(new Request("http://localhost/api/v1/auth/status"))
    ).json()) as { setupRequired: boolean; registration: string; instanceName: string };
    expect(status.setupRequired).toBe(false);
    expect(status.registration).toBe("invite");
    expect(status.instanceName).toBe("Test");
  });

  it("rejects a wrong password without revealing whether the account exists", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@example.test", password: "wrong password" }),
      }),
    );
    expect(response.status).toBe(401);

    const unknown = await app.handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.test", password: "whatever goes" }),
      }),
    );
    expect(unknown.status).toBe(401);
    expect(await unknown.text()).toBe(await response.text());
  });

  it("refuses a quoted-length password at setup", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/v1/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "x@example.test", password: "short" }),
      }),
    );
    // Either the schema (minLength 10) or the policy rejects it; both are 400.
    expect([400, 422]).toContain(response.status);
  });

  it("requires a session for the query API", async () => {
    const response = await app.handle(new Request("http://localhost/api/v1/applications"));
    expect(response.status).toBe(401);
  });

  it("does not require a session for ingest", async () => {
    const response = await app.handle(batchRequest(sampleBatch()));
    expect(response.status).toBe(200);
  });

  it("issues an invite whose role is bound server-side, and accepts it once", async () => {
    const invite = (await (
      await app.handle(
        authed("http://localhost/api/v1/admin/invites", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "teammate@example.test", role: "read" }),
        }),
      )
    ).json()) as { token: string; url: string; expiresAt: number };

    expect(invite.token).toBeTruthy();
    expect(invite.url).toContain("/invite/");

    // What the invite page shows before you accept.
    const described = (await (
      await app.handle(new Request(`http://localhost/api/v1/auth/invite/${invite.token}`))
    ).json()) as { email: string; role: string };
    expect(described.email).toBe("teammate@example.test");
    expect(described.role).toBe("read");

    // Accepting binds the role from the invite, not from the request.
    const accepted = await app.handle(
      new Request(`http://localhost/api/v1/auth/invite/${invite.token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "teammate good passphrase", name: "Teammate" }),
      }),
    );
    expect(accepted.status).toBe(201);
    const payload = (await accepted.json()) as { user: { role: string; email: string } };
    expect(payload.user.role).toBe("read");

    // Single use.
    const again = await app.handle(
      new Request(`http://localhost/api/v1/auth/invite/${invite.token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "another good passphrase" }),
      }),
    );
    expect(again.status).toBe(400);
  });

  it("forbids the query API to a read-only user", async () => {
    // A `read` user may read; the point of the role is that it cannot write.
    const invite = (await (
      await app.handle(
        authed("http://localhost/api/v1/admin/invites", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "reader@example.test", role: "read" }),
        }),
      )
    ).json()) as { token: string };

    const accepted = await app.handle(
      new Request(`http://localhost/api/v1/auth/invite/${invite.token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "reader good passphrase" }),
      }),
    );
    const readerCookie = (accepted.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const asReader = new Request("http://localhost/api/v1/admin/users", {
      headers: { cookie: readerCookie },
    });
    // Instance administration is admin-only regardless of project membership.
    expect((await app.handle(asReader)).status).toBe(403);
  });
});

/**
 * `npx @nestjs/observe link` against us.
 *
 * The CLI does two things with the token reply that are easy to get subtly
 * wrong: it prints `applicationName`/`projectName` (`undefined in undefined`
 * when we omit them) and it derives the `serviceId` it wires into the app from
 * `applicationName` (`serviceIdFor`). The collector stores the same derivation,
 * so the first batch after a link must land on the application that was just
 * approved — not create a second one.
 */
describe("cli link", () => {
  async function startLink(applicationName: string) {
    const response = await app.handle(
      new Request("http://localhost/cli-link/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ applicationName, hostname: "kamils-mbp" }),
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      expiresIn: number;
      interval: number;
    };
  }

  async function approve(userCode: string): Promise<{ applicationId: string }> {
    const response = await app.handle(
      authed("http://localhost/api/v1/link/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode }),
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { applicationId: string };
  }

  async function poll(deviceCode: string): Promise<{
    status: number;
    body: {
      appKey?: string;
      appSecret?: string;
      projectId?: string;
      projectName?: string;
      applicationId?: string;
      applicationName?: string;
      error?: string;
    };
  }> {
    const response = await app.handle(
      new Request("http://localhost/cli-link/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      }),
    );
    return { status: response.status, body: (await response.json()) as never };
  }

  async function applicationCount(): Promise<number> {
    const rows = (await maintenance.unsafe(
      "SELECT count(*)::int AS n FROM application",
    )) as Array<{ n: number }>;
    return rows[0]!.n;
  }

  it("answers the identity the CLI prints, at a path-style verification URI", async () => {
    const started = await startLink("nestjs-testing");
    expect(started.verificationUri).toBe("http://localhost:4320/link");
    expect(started.verificationUri).not.toContain("#");

    expect((await poll(started.deviceCode)).body.error).toBe("authorization_pending");
    const approved = await approve(started.userCode);

    const issued = await poll(started.deviceCode);
    expect(issued.status).toBe(200);
    expect(issued.body.appKey).toStartWith("obs_");
    expect(issued.body.appSecret).toBeTruthy();
    // The exact strings the CLI interpolates into "Linked to X in Y".
    expect(issued.body.applicationName).toBe("nestjs-testing");
    expect(issued.body.projectName).toBe("Default");
    expect(issued.body.applicationId).toBe(approved.applicationId);
  });

  it("stores the SDK's slug, so a scoped package maps to one application", async () => {
    // `serviceIdFor("@acme/Orders")` is "orders"; the CLI writes that into the
    // app, so a row stored as "@acme/Orders" would be a phantom.
    const started = await startLink("@acme/Orders");
    await approve(started.userCode);
    const issued = await poll(started.deviceCode);

    expect(issued.body.applicationName).toBe("@acme/Orders");
    const rows = (await maintenance.unsafe(
      "SELECT id, service_id, name FROM application",
    )) as Array<{ id: string; service_id: string; name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.service_id).toBe("orders");
    expect(rows[0]!.name).toBe("@acme/Orders");

    // The first batch sends the slug the CLI derived: same application, no duplicate.
    const batch = { ...sampleBatch(), serviceId: "orders" };
    expect((await app.handle(batchRequest(batch))).status).toBe(200);
    expect(await applicationCount()).toBe(1);
  });

  it("re-linking the same app gets a new key for the same application", async () => {
    const first = await startLink("nestjs-testing");
    const firstApproval = await approve(first.userCode);
    const firstIssue = await poll(first.deviceCode);

    const second = await startLink("nestjs-testing");
    const secondApproval = await approve(second.userCode);
    const secondIssue = await poll(second.deviceCode);

    expect(secondApproval.applicationId).toBe(firstApproval.applicationId);
    expect(secondIssue.body.applicationId).toBe(firstApproval.applicationId);
    expect(secondIssue.body.appKey).not.toBe(firstIssue.body.appKey);
    expect(await applicationCount()).toBe(1);
  });
});

/**
 * SLOs: the objective is the promise, the error budget is what is left of it.
 *
 * "Budget" is reliability, not billing — `1 - target` of the events may fail.
 * These tests pin the three rules that are easy to get wrong: no traffic is
 * `no-data` (not 100% and not 0%), burn rate is relative to that allowance, and
 * a window longer than retention is clipped rather than counted as healthy.
 */
describe("slos", () => {
  const started = () => Date.now();

  function request(
    op: string,
    status: number,
    durationMs: number,
    error?: Record<string, unknown>,
  ) {
    return {
      ct: new Date(started()).toISOString(),
      ti: crypto.randomUUID(),
      d: durationMs,
      p: "http",
      op,
      a: { m: "GET", sc: status },
      t: [],
      ...(error ? { e: error } : {}),
    };
  }

  function job(status: "completed" | "failed", error?: Record<string, unknown>) {
    return {
      i: crypto.randomUUID(),
      ti: crypto.randomUUID(),
      n: "send-invoice",
      q: "billing",
      s: status,
      d: 12.5,
      t: [],
      ...(error ? { e: error } : {}),
    };
  }

  async function ingest(body: Record<string, unknown>): Promise<string> {
    const response = await app.handle(batchRequest({ serviceId: "orders-api", ...body }));
    expect(response.status).toBe(200);
    const applications = (await (
      await app.handle(authed("http://localhost/api/v1/applications"))
    ).json()) as Array<{ id: string }>;
    return applications[0]!.id;
  }

  async function list(appId: string) {
    return (await (
      await app.handle(authed(`http://localhost/api/v1/telemetry/slos?applicationId=${appId}`))
    ).json()) as {
      items: Array<{
        id: string;
        kind: string;
        source: string;
        target: number;
        windowDays: number;
        effectiveWindowDays: number;
        limitedByRetention: boolean;
        state: string;
        sli: { good: number; total: number; value: number | null };
        budget: { allowedBad: number; remaining: number; overBudget: boolean };
        burn: Array<{ key: string; rate: number | null }>;
      }>;
      retentionDays: number;
    };
  }

  it("spends the error budget and breaches when the target is missed", async () => {
    const appId = await ingest({
      snapshots: [
        ...Array.from({ length: 9 }, () => request("GET /orders", 200, 40)),
        request("GET /orders", 500, 90, { cls: "Error", message: "boom", stack: "Error: boom" }),
      ],
      objectives: [
        {
          handler: "OrdersController.findAll",
          operationId: "GET /orders",
          method: "GET",
          objectives: [{ availability: 99.9, windowDays: 28 }],
        },
      ],
    });

    const { items } = await list(appId);
    expect(items).toHaveLength(1);
    const [slo] = items;
    expect(slo!.kind).toBe("availability");
    expect(slo!.source).toBe("code");
    expect(slo!.sli).toMatchObject({ good: 9, total: 10 });
    expect(slo!.sli.value).toBeCloseTo(0.9, 6);
    // 99.9% allows 0.01 of 10 events; one failure is already over budget.
    expect(slo!.budget.allowedBad).toBeCloseTo(0.01, 6);
    expect(slo!.budget.overBudget).toBe(true);
    expect(slo!.state).toBe("breached");
    // (0.1 error rate) / (0.001 allowance) = 100× over the sustainable pace.
    expect(slo!.burn.find((window) => window.key === "1h")!.rate).toBeCloseTo(100, 6);
  });

  it("reads a window with no traffic as no-data, not 100% or 0%", async () => {
    const appId = await ingest({
      snapshots: [request("GET /health", 200, 5)],
      objectives: [
        {
          handler: "HealthController.check",
          operationId: "GET /never-called",
          objectives: [{ availability: 99.9, windowDays: 28 }],
        },
      ],
    });

    const { items } = await list(appId);
    expect(items).toHaveLength(1);
    expect(items[0]!.sli.total).toBe(0);
    expect(items[0]!.sli.value).toBeNull();
    expect(items[0]!.state).toBe("no-data");
    expect(items[0]!.burn.every((window) => window.rate === null)).toBe(true);
  });

  it("measures latency as the fraction of requests under the threshold", async () => {
    const appId = await ingest({
      snapshots: [
        request("GET /orders", 200, 100),
        request("GET /orders", 200, 500),
      ],
      objectives: [
        {
          handler: "OrdersController.findAll",
          operationId: "GET /orders",
          objectives: [{ latency: { underMs: 300, target: 90 }, windowDays: 7 }],
        },
      ],
    });

    const [slo] = (await list(appId)).items;
    expect(slo!.kind).toBe("latency");
    expect(slo!.sli).toMatchObject({ good: 1, total: 2 });
    expect(slo!.sli.value).toBeCloseTo(0.5, 6);
    expect(slo!.state).toBe("breached");
    // 50% bad against a 10% allowance is a 5× burn.
    expect(slo!.burn.find((window) => window.key === "1h")!.rate).toBeCloseTo(5, 6);
  });

  it("supports a dashboard-created job-success SLO, and deletes it", async () => {
    const appId = await ingest({
      jobs: [
        job("completed"),
        job("failed", { cls: "Error", message: "no invoice", stack: "Error: no invoice" }),
      ],
    });

    const created = await app.handle(
      authed(`http://localhost/api/v1/applications/${appId}/slos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "job", target: 90, windowDays: 7, operationId: "*" }),
      }),
    );
    expect(created.status).toBe(201);

    const [slo] = (await list(appId)).items;
    expect(slo!.source).toBe("dashboard");
    expect(slo!.sli).toMatchObject({ good: 1, total: 2 });
    expect(slo!.state).toBe("breached");

    const deleted = await app.handle(
      authed(`http://localhost/api/v1/applications/${appId}/slos/${slo!.id}`, {
        method: "DELETE",
      }),
    );
    expect(deleted.status).toBe(200);
    expect((await list(appId)).items).toHaveLength(0);
  });

  it("refuses to let the dashboard overwrite or delete a code objective", async () => {
    const appId = await ingest({
      snapshots: [request("GET /orders", 200, 40)],
      objectives: [
        {
          handler: "OrdersController.findAll",
          operationId: "GET /orders",
          objectives: [{ availability: 99.9 }],
        },
      ],
    });

    const overwrite = await app.handle(
      authed(`http://localhost/api/v1/applications/${appId}/slos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "availability", target: 99, operationId: "GET /orders" }),
      }),
    );
    expect(overwrite.status).toBe(409);

    const [slo] = (await list(appId)).items;
    const deleted = await app.handle(
      authed(`http://localhost/api/v1/applications/${appId}/slos/${slo!.id}`, {
        method: "DELETE",
      }),
    );
    expect(deleted.status).toBe(409);
  });

  it("clips a compliance window to the retention ceiling", async () => {
    await maintenance.unsafe(
      `INSERT INTO instance_setting (key, value, updated_at)
       VALUES ('retention.traces', '7'::jsonb, ${Date.now()})`,
    );
    const appId = await ingest({
      snapshots: [request("GET /orders", 200, 40)],
      objectives: [
        {
          handler: "OrdersController.findAll",
          operationId: "GET /orders",
          objectives: [{ availability: 99.9, windowDays: 28 }],
        },
      ],
    });

    const { items, retentionDays } = await list(appId);
    expect(retentionDays).toBe(7);
    expect(items[0]!.windowDays).toBe(28);
    expect(items[0]!.effectiveWindowDays).toBe(7);
    expect(items[0]!.limitedByRetention).toBe(true);
  });
});

/**
 * The credential lifecycle. The pair minted by the dashboard is the pair ingest
 * authenticates: the key's first 8 characters are the lookup index, the key
 * itself is a SHA-256 hex, and the secret is argon2id — so testing the round trip
 * is the only way to know the two code paths agree.
 */
describe("api keys", () => {
  it("mints a pair that ingest accepts, and revoking it stops ingest", async () => {
    const created = await app.handle(
      authed("http://localhost/api/v1/admin/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "CI runner" }),
      }),
    );
    expect(created.status).toBe(200);
    const key = (await created.json()) as {
      id: string;
      appKey: string;
      appSecret: string;
      keyPrefix: string;
    };
    expect(key.appKey.startsWith("obs_")).toBe(true);
    expect(key.keyPrefix).toBe(key.appKey.slice(0, 8));

    // A batch carrying that pair authenticates, and lands under the default project.
    const accepted = await app.handle(
      batchRequest(sampleBatch({ serviceId: "ci-orders" }), {
        "x-api-key": key.appKey,
        "x-api-secret": key.appSecret,
      }),
    );
    expect(accepted.status).toBe(200);
    const applications = (await (
      await app.handle(authed("http://localhost/api/v1/applications"))
    ).json()) as Array<{ serviceId: string }>;
    expect(applications.map((row) => row.serviceId)).toContain("ci-orders");

    const listed = (await (
      await app.handle(authed("http://localhost/api/v1/admin/credentials"))
    ).json()) as {
      items: Array<{ id: string; keyPrefix: string; label: string | null; revokedAt: number | null }>;
      scope: string;
    };
    expect(listed.scope).toBe("project");
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.label).toBe("CI runner");
    // The list never carries a secret: there is nothing to leak in a screenshot.
    expect(JSON.stringify(listed)).not.toContain(key.appSecret);

    const revoked = await app.handle(
      authed(`http://localhost/api/v1/admin/credentials/${key.id}`, { method: "DELETE" }),
    );
    expect(revoked.status).toBe(200);

    const rejected = await app.handle(
      batchRequest(sampleBatch(), {
        "x-api-key": key.appKey,
        "x-api-secret": key.appSecret,
      }),
    );
    expect(rejected.status).toBe(401);

    // The row stays (a replay must be *rejected*, not read as anonymous ingest).
    const after = (await (
      await app.handle(authed("http://localhost/api/v1/admin/credentials"))
    ).json()) as { items: Array<{ revokedAt: number | null }> };
    expect(after.items).toHaveLength(1);
    expect(after.items[0]!.revokedAt).not.toBeNull();

    const missing = await app.handle(
      authed("http://localhost/api/v1/admin/credentials/00000000-0000-7000-8000-000000000000", {
        method: "DELETE",
      }),
    );
    expect(missing.status).toBe(404);
  });

  it("keeps credentials away from a non-admin", async () => {
    const invited = await app.handle(
      authed("http://localhost/api/v1/admin/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "reader-keys@example.test", role: "read" }),
      }),
    );
    const { token } = (await invited.json()) as { token: string };
    const accepted = await app.handle(
      new Request(`http://localhost/api/v1/auth/invite/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "correct horse battery" }),
      }),
    );
    const readerCookie = (accepted.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const denied = await app.handle(
      new Request("http://localhost/api/v1/admin/credentials", {
        headers: { cookie: readerCookie },
      }),
    );
    expect(denied.status).toBe(403);
  });
});

/**
 * Alerts: the evaluator, its transitions, and the rules that must stay quiet.
 *
 * The clock is the only nondeterminism in the feature, so every test drives
 * `POST /alerts/evaluate` explicitly — the same function the in-process timer
 * calls — and never waits for a minute to pass.
 */
describe("alerts", () => {
  async function ingestBatch(overrides: Parameters<typeof sampleBatch>[0] = {}) {
    const applications = await (
      await app.handle(authed("http://localhost/api/v1/applications"))
    ).json() as Array<{ id: string }>;
    const appId = applications[0]?.id;
    expect((await app.handle(batchRequest(sampleBatch(overrides)))).status).toBe(200);
    if (appId) return appId;
    const refreshed = (await (
      await app.handle(authed("http://localhost/api/v1/applications"))
    ).json()) as Array<{ id: string }>;
    return refreshed[0]!.id;
  }

  async function createRule(body: Record<string, unknown>) {
    const response = await app.handle(
      authed("http://localhost/api/v1/alerts/rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  async function evaluate() {
    return (await (
      await app.handle(authed("http://localhost/api/v1/alerts/evaluate", { method: "POST" }))
    ).json()) as {
      evaluated: number;
      opened: number;
      resolved: number;
      muted: number;
      results: Array<{
        ruleId: string;
        transition: string;
        state: string;
        delivery: Array<{ channel: string; status: string; reason?: string }>;
      }>;
    };
  }

  async function incidents() {
    return (await (
      await app.handle(authed("http://localhost/api/v1/alerts/incidents"))
    ).json()) as { items: Array<{ id: string; ruleName: string; value: number | null; muted: boolean }> };
  }

  async function events() {
    return (await (
      await app.handle(authed("http://localhost/api/v1/alerts/events"))
    ).json()) as { items: Array<{ id: string; state: string; value: number | null; muted: boolean }> };
  }

  it("opens one incident when a rule's threshold is crossed, and stays idempotent", async () => {
    // The fixture is two requests, one of them failed: 50% error rate.
    const appId = await ingestBatch();
    await createRule({
      name: "Errors above 5%",
      metric: "request.error_rate",
      comparator: "above",
      threshold: 0.05,
      windowS: 3600,
      severity: "high",
      applicationId: appId,
    });

    const first = await evaluate();
    expect(first.opened).toBe(1);
    const firing = await incidents();
    expect(firing.items).toHaveLength(1);
    expect(firing.items[0]!.ruleName).toBe("Errors above 5%");
    expect(firing.items[0]!.value).toBeCloseTo(0.5, 2);

    // The same state again writes nothing: an alert that re-notifies every
    // minute is an alert people mute.
    const second = await evaluate();
    expect(second.opened).toBe(0);
    expect((await incidents()).items).toHaveLength(1);
    expect((await events()).items).toHaveLength(1);
  });

  it("resolves the incident when the rule's threshold moves past the value", async () => {
    const appId = await ingestBatch();
    const ruleId = await createRule({
      name: "Errors above 5% (one-shot)",
      metric: "request.error_rate",
      comparator: "above",
      threshold: 0.05,
      windowS: 3600,
      applicationId: appId,
    });
    await evaluate();
    expect((await incidents()).items).toHaveLength(1);

    // What an operator does when they decide 50% is expected for this endpoint.
    const patched = await app.handle(
      authed(`http://localhost/api/v1/alerts/rules/${ruleId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threshold: 0.99 }),
      }),
    );
    expect(patched.status).toBe(200);

    const after = await evaluate();
    expect(after.resolved).toBe(1);
    expect((await incidents()).items).toHaveLength(0);
    // History keeps both transitions: firing, then resolved.
    const history = await events();
    expect(history.items.filter((event) => event.state === "firing")).toHaveLength(1);
    expect(history.items.filter((event) => event.state === "resolved")).toHaveLength(1);
  });

  it("never fires a metric with no data, and never resolves on it either", async () => {
    // A custom metric that no application ever reported: the rule is valid, the
    // measurement is impossible, and impossible is not zero.
    await ingestBatch();
    await createRule({
      name: "Checkout latency budget",
      metric: "custom.metric",
      comparator: "above",
      threshold: 1000,
      windowS: 3600,
      severity: "medium",
      scope: { customMetricName: "never_reported_metric" },
    });
    const summary = await evaluate();
    expect(summary.opened).toBe(0);
    expect(summary.results[0]!.state).toBe("no-data");

    const rules = (await (
      await app.handle(authed("http://localhost/api/v1/alerts/rules"))
    ).json()) as { items: Array<{ state: string; current: { value: number | null } }> };
    expect(rules.items[0]!.state).toBe("no-data");
    expect(rules.items[0]!.current.value).toBeNull();
  });

  it("records a quiet-hours firing as muted, without skipping the history", async () => {
    const appId = await ingestBatch();
    await createRule({
      name: "Errors during quiet hours",
      metric: "request.error_rate",
      comparator: "above",
      threshold: 0.05,
      windowS: 3600,
      applicationId: appId,
      // 00:00 → 00:00 is rejected as a no-op window; 00:00 → 23:59 covers "now"
      // in every timezone, which is what makes this deterministic.
      quietHours: { start: "00:00", end: "23:59", timezone: "UTC" },
    });
    const summary = await evaluate();
    expect(summary.muted).toBe(1);
    expect(summary.opened).toBe(0);
    const history = await events();
    expect(history.items).toHaveLength(1);
    expect(history.items[0]!.muted).toBe(true);
    // Muted is not resolved: the incident is still open.
    expect((await incidents()).items).toHaveLength(1);
  });

  it("records a failed webhook delivery instead of losing the event", async () => {
    const appId = await ingestBatch();
    await createRule({
      name: "Errors with a dead webhook",
      metric: "request.error_rate",
      comparator: "above",
      threshold: 0.05,
      windowS: 3600,
      applicationId: appId,
      channels: [{ type: "webhook", url: "http://127.0.0.1:1/hook" }],
    });
    const summary = await evaluate();
    expect(summary.opened).toBe(1);
    expect(summary.results[0]!.delivery[0]!.status).toBe("failed");
    // The event exists regardless: delivery is not the record of truth.
    expect((await incidents()).items).toHaveLength(1);
  });

  it("rejects a metric it cannot evaluate", async () => {
    const response = await app.handle(
      authed("http://localhost/api/v1/alerts/rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Nonsense",
          metric: "request.vibes",
          comparator: "above",
          threshold: 1,
          windowS: 300,
        }),
      }),
    );
    expect(response.status).toBe(422);
  });

  it("mutes a rule without disabling it", async () => {
    await ingestBatch();
    const ruleId = await createRule({
      name: "Errors, muted by hand",
      metric: "request.error_rate",
      comparator: "above",
      threshold: 0.05,
      windowS: 3600,
    });
    const muted = await app.handle(
      authed(`http://localhost/api/v1/alerts/rules/${ruleId}/mute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ minutes: 60 }),
      }),
    );
    expect(muted.status).toBe(200);
    const rules = (await (
      await app.handle(authed("http://localhost/api/v1/alerts/rules"))
    ).json()) as { items: Array<{ state: string; quiet: boolean; enabled: boolean }> };
    expect(rules.items[0]!.enabled).toBe(true);
    expect(rules.items[0]!.quiet).toBe(true);
    expect(rules.items[0]!.state).toBe("muted");
  });
});

/**
 * Instance settings: the values live in a jsonb column, and a *number* or a
 * boolean there is the case that used to 500 — Bun binds a scalar as a SQL
 * scalar, which Postgres refuses for jsonb, so the writer serialises and casts.
 * The dashboard's Settings page saves `retention.traces` this way.
 */
describe("instance settings", () => {
  it("round-trips numbers, booleans and strings through the jsonb column", async () => {
    const patch = await app.handle(
      authed("http://localhost/api/v1/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instanceName: "Acme Observe",
          "retention.traces": 7,
          "probe.enabled": true,
        }),
      }),
    );
    expect(patch.status).toBe(200);

    const settings = (await (
      await app.handle(authed("http://localhost/api/v1/admin/settings"))
    ).json()) as {
      settings: Record<string, unknown>;
      effective: { instanceName: string };
    };
    expect(settings.settings["retention.traces"]).toBe(7);
    expect(settings.settings["probe.enabled"]).toBe(true);
    expect(settings.settings.instanceName).toBe("Acme Observe");
    expect(settings.effective.instanceName).toBe("Acme Observe");

    // The retention reader is the consumer that matters: it must see a number,
    // not the string "7", or every compliance window silently stops clipping.
    const slos = (await (
      await app.handle(authed("http://localhost/api/v1/telemetry/slos"))
    ).json()) as { retentionDays: number };
    expect(slos.retentionDays).toBe(7);
  });
});
