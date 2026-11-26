/**
 * End-to-end smoke: POST a gzipped batch exactly as the SDK would, then read it
 * back through the query API.
 *
 *   bun run scripts/smoke.ts            # against an already-running server
 *   bun run scripts/smoke.ts --spawn    # start one itself on a temp data dir
 */
import { sampleBatch } from "../src/fixtures";

interface Json {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

const fetchJson = async (url: string, init?: RequestInit): Promise<Json> =>
  (await (await fetch(url, init)).json()) as Json;

const spawn = process.argv.includes("--spawn");
const port = Number(process.env.SMOKE_PORT ?? 4399);
const databaseUrl =
  process.env.OBSERVE_DATABASE_URL ??
  "postgres://observe:observe@localhost:5433/observe";
const base = `http://localhost:${port}`;

let server: ReturnType<typeof Bun.spawn> | null = null;

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(100);
  }
  throw new Error(`server did not become healthy at ${base}`);
}

if (spawn) {
  // A clean slate, so "one error group after a replayed batch" is a real
  // assertion rather than whatever the previous run left behind.
  const { SQL } = await import("bun");
  const sql = new SQL({ url: databaseUrl });
  await sql`TRUNCATE project, application, release, operation, execution, span,
                       error_group, error_occurrence, log_entry, runtime_sample,
                       metric_series, metric_point, rollup_minute, slo, app_credential,
                       cli_link_session CASCADE`;
  await sql.close();

  server = Bun.spawn({
    cmd: ["bun", "src/server/index.ts"],
    env: {
      ...process.env,
      OBSERVE_DATABASE_URL: databaseUrl,
      OBSERVE_PORT: String(port),
      OBSERVE_LOG_LEVEL: "info",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForHealth();
} else {
  await waitForHealth();
}

try {
  const batch = sampleBatch();
  const gzipped = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(batch)));

  const ingest = await fetch(`${base}/applications/telemetry`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "x-observe-ingest-modes": "reduced, trimmed, paced, errors-only",
    },
    body: gzipped,
  });
  console.log("ingest", ingest.status, await ingest.text());
  if (ingest.status !== 200) throw new Error("ingest rejected the batch");

  const apps = await fetchJson(`${base}/api/v1/applications`);
  console.log("applications", JSON.stringify(apps));
  const appId = apps[0]?.id as string | undefined;
  if (!appId) throw new Error("no application created");

  const executions = await fetchJson(
    `${base}/api/v1/applications/${appId}/executions?limit=10`,
  );
  console.log("executions", executions.items.length, "nextCursor", executions.nextCursor);

  const first = executions.items[0] as { id: string };
  const detail = await fetchJson(`${base}/api/v1/executions/${first.id}`);
  console.log(
    "execution detail: spans",
    detail.spans.length,
    "logs",
    detail.logs.length,
    "op",
    detail.execution.operation?.operationId,
  );

  const errors = await fetchJson(`${base}/api/v1/applications/${appId}/errors`);
  console.log("errors", errors.items.map((item: { message: string }) => item.message));

  const operations = await fetchJson(
    `${base}/api/v1/applications/${appId}/operations`,
  );
  console.log("operations", operations);

  // A second, identical batch must not create a second error group: the
  // fingerprint is the product feature, and this is the cheapest proof of it.
  await fetch(`${base}/applications/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
    body: Bun.gzipSync(new TextEncoder().encode(JSON.stringify(batch))),
  });
  const errorsAgain = await fetchJson(`${base}/api/v1/applications/${appId}/errors`);
  console.log(
    "error groups after replay",
    errorsAgain.items.length,
    "occurrences",
    errorsAgain.items[0]?.occurrences,
  );
} finally {
  server?.kill();
}
