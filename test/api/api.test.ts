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
import { createApiApp } from "../../apps/server/src/app";
import { loadConfig } from "../../apps/server/src/plugins/config";
import { connectDatabase } from "../../apps/server/src/plugins/database";
import { sampleBatch } from "../../packages/shared/src/fixtures";

const databaseUrl =
  process.env.OBSERVE_DATABASE_URL ??
  "postgres://observe:observe@localhost:5433/observe";

const connection = await connectDatabase({ url: databaseUrl, runMigrations: true });
const config = loadConfig({
  OBSERVE_DATABASE_URL: databaseUrl,
  OBSERVE_SINGLE_PORT: "1",
  OBSERVE_ALLOW_ANONYMOUS_INGEST: "1",
});

const app = createApiApp({ config, db: connection.db });

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

const TRUNCATE = `TRUNCATE project, application, release, operation, execution,
  span, error_group, error_occurrence, log_entry, runtime_sample, metric_series,
  metric_point, rollup_minute, slo, app_credential, cli_link_session CASCADE`;

beforeEach(async () => {
  const sql = new SQL({ url: databaseUrl });
  await sql.unsafe(TRUNCATE);
  await sql.close();
});

afterAll(async () => {
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
      await app.handle(new Request("http://localhost/api/v1/applications"))
    ).json() as Array<{ id: string; name: string; requests: number; p95DurationMs: number | null }>;

    expect(applications).toHaveLength(1);
    expect(applications[0]!.name).toBe("orders-api");
    expect(applications[0]!.requests).toBe((batch.snapshots?.length ?? 0) + (batch.jobs?.length ?? 0));
    // p95 comes from the merged histogram, so it must be a real number.
    expect(typeof applications[0]!.p95DurationMs).toBe("number");

    const appId = applications[0]!.id;
    const executions = await (
      await app.handle(
        new Request(`http://localhost/api/v1/applications/${appId}/executions?limit=10`),
      )
    ).json() as { items: Array<{ id: string }>; nextCursor: string | null };

    expect(executions.items).toHaveLength(3);
    expect(executions.nextCursor).not.toBeNull();

    const detail = await (
      await app.handle(
        new Request(`http://localhost/api/v1/executions/${executions.items[0]!.id}`),
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
      await app.handle(new Request("http://localhost/api/v1/applications"))
    ).json() as Array<{ id: string }>;
    const appId = applications[0]!.id;

    await app.handle(batchRequest(batch));

    const errors = await (
      await app.handle(new Request(`http://localhost/api/v1/applications/${appId}/errors`))
    ).json() as { items: Array<{ id: string; occurrences: number }> };

    // Fingerprinting is the product feature: the same bug twice is one row.
    expect(errors.items).toHaveLength(1);
    expect(errors.items[0]!.occurrences).toBe(2);

    const patched = await app.handle(
      new Request(`http://localhost/api/v1/errors/${errors.items[0]!.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "resolved" }),
      }),
    );
    expect(patched.status).toBe(200);
  });

  it("ranks operations by volume", async () => {
    const batch = sampleBatch();
    await app.handle(batchRequest(batch));

    const applications = await (
      await app.handle(new Request("http://localhost/api/v1/applications"))
    ).json() as Array<{ id: string }>;

    const operations = await (
      await app.handle(
        new Request(`http://localhost/api/v1/applications/${applications[0]!.id}/operations`),
      )
    ).json() as Array<{ operationId: string | null; count: number; p95DurationMs: number | null }>;

    expect(operations.length).toBeGreaterThan(0);
    const counts = operations.map((operation) => operation.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it("answers 404 for an execution that does not exist", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/v1/executions/00000000-0000-7000-8000-000000000000"),
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
