#!/usr/bin/env bash
# Prove, against a live instance, the two things this dashboard must not get
# wrong:
#
#   1. a job is not a request — request counts, series and operation rankings
#      must match the `kind = 'request'` rollups, and the jobs must still show
#      up under /jobs and /job;
#   2. a trace id spans services — /traces/:traceId must return every hop that
#      carried it, with its spans and its logs.
#
# It needs the dev stack: a collector on :4320 and the dev Postgres (README
# `docker compose up`). It creates a throwaway admin to get a session cookie and
# deletes it (and its sessions) afterwards, so it can be re-run.
#
#   bash scripts/parity-check.sh
set -eu
cd "$(dirname "$0")/.."

DATABASE_URL="${OBSERVE_DATABASE_URL:-}"
if [ -z "$DATABASE_URL" ] && [ -f .env ]; then
  DATABASE_URL="$(grep -E '^OBSERVE_DATABASE_URL=' .env | cut -d= -f2-)"
fi
DATABASE_URL="${DATABASE_URL:-postgres://observe:observe@localhost:5433/observe}"

API="${OBSERVE_API_URL:-http://localhost:4320}"
EMAIL="parity-check@local.test"
PASSWORD='parity-check-1A!'

psql "$DATABASE_URL" -q -c \
  "DELETE FROM session WHERE user_id IN (SELECT id FROM app_user WHERE email = '$EMAIL');
   DELETE FROM app_user WHERE email = '$EMAIL';" >/dev/null

printf '%s\n' "$PASSWORD" | bun src/server/index.ts admin create-user \
  --email "$EMAIL" --role admin --password-stdin >/dev/null

TRACE_ID="$(psql "$DATABASE_URL" -Atc \
  "SELECT trace_id FROM execution GROUP BY 1 HAVING count(*) > 1
    ORDER BY max(started_at) DESC LIMIT 1")"

CHECK="$(mktemp --suffix=.ts)"
trap 'rm -f "$CHECK"' EXIT
cat > "$CHECK" <<'EOF'
const base = process.env.API!;
const jar: { cookie?: string } = {};

async function call(path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(jar.cookie ? { cookie: jar.cookie } : {}),
  };
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) jar.cookie = setCookie.split(";")[0];
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text is the payload */
  }
  return { status: response.status, body };
}

const login = await call("/api/v1/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: process.env.EMAIL, password: process.env.PASSWORD }),
});
if (login.status !== 200) {
  console.error("login failed", login.status, login.body);
  process.exit(1);
}

const all = { from: 0, to: Date.now() };
const apps = (await call(`/api/v1/applications?from=0&to=${all.to}`)).body as Array<{
  id: string;
  name: string;
  requests: number;
  errorRate: number;
  p95DurationMs: number | null;
}>;

console.log("applications (whole history):");
for (const row of apps) {
  console.log(
    `  ${row.name.padEnd(18)} requests=${String(row.requests).padStart(6)}` +
      ` err=${(row.errorRate * 100).toFixed(2)}% p95=${row.p95DurationMs?.toFixed(1) ?? "-"}ms`,
  );
}

const withRequests = apps.find((row) => row.requests > 0);
if (!withRequests) {
  console.error("no application has request telemetry — seed the examples first");
  process.exit(1);
}

const requests = (await call(`/api/v1/telemetry/timeseries?applicationId=${withRequests.id}&from=0&to=${all.to}`))
  .body as { kind: string; summary: { requests: number; errors: number } };
console.log(
  `\ntimeseries (${withRequests.name}) kind=${requests.kind} requests=${requests.summary.requests}`,
);
if (requests.kind !== "request") throw new Error("the default series is not requests");

const operations = (await call(
  `/api/v1/telemetry/operations?applicationId=${withRequests.id}&from=0&to=${all.to}`,
)).body as Array<{ kind: string; count: number }>;
const operationKinds = [...new Set(operations.map((row) => row.kind))];
const operationSum = operations.reduce((sum, row) => sum + row.count, 0);
console.log(`operations kinds=${operationKinds.join(",")} sum=${operationSum}`);
if (operationKinds.some((kind) => kind !== "request")) {
  throw new Error("a job leaked into the request operations ranking");
}
if (operationSum !== requests.summary.requests) {
  throw new Error("operations disagree with the request series");
}

// Every application's jobs live on /jobs, whatever its request count is.
for (const app of apps) {
  const rows = (await call(`/api/v1/telemetry/jobs?applicationId=${app.id}&from=0&to=${all.to}`))
    .body as Array<{ queue: string; jobName: string; runs: number; failed: number; p95WaitMs: number }>;
  if (rows.length === 0) continue;
  console.log(`\njobs (${app.name}): ${rows.length} queue/name pairs`);
  for (const row of rows.slice(0, 5)) {
    console.log(
      `  ${row.queue}/${row.jobName}: runs=${row.runs} failed=${row.failed} p95wait=${row.p95WaitMs.toFixed(0)}ms`,
    );
  }
  const detail = (await call(
    `/api/v1/applications/${app.id}/job?queue=${encodeURIComponent(rows[0]!.queue)}` +
      `&name=${encodeURIComponent(rows[0]!.jobName)}&from=0&to=${all.to}`,
  )).body as {
    runs: number;
    failed: number;
    retried: number;
    p95WaitMs: number;
    series: { points: unknown[] };
    waitSeries: { points: unknown[] };
    recent: Array<{ traceId: string }>;
  };
  console.log(
    `  detail: runs=${detail.runs} failed=${detail.failed} retried=${detail.retried}` +
      ` p95wait=${detail.p95WaitMs.toFixed(0)}ms` +
      ` series=${detail.series.points.length} waitSeries=${detail.waitSeries.points.length}` +
      ` recent=${detail.recent.length}`,
  );
  if (detail.series.points.length === 0) throw new Error("job detail has no series");
  if (detail.runs > 0 && detail.recent.length === 0) throw new Error("job detail has no runs");
}

// ---------------------------------------------------------------------------
// The project scope: "All applications" is not a dashboard-only idea. Every
// list must aggregate, and every row must name its application.
// ---------------------------------------------------------------------------
const projectOps = (await call(`/api/v1/telemetry/operations?from=0&to=${all.to}`))
  .body as Array<{ kind: string; count: number; applicationId: string; applicationName: string }>;
const appsInOps = new Set(projectOps.map((row) => row.applicationName));
console.log(`\nproject operations: ${projectOps.length} rows across ${appsInOps.size} applications`);
if (projectOps.some((row) => row.kind !== "request")) {
  throw new Error("a job leaked into the project request ranking");
}
if (appsInOps.size < 2) {
  throw new Error("the project request ranking only has one application — seed more");
}
const perAppSum = apps.reduce((sum, row) => sum + row.requests, 0);
const projectSum = projectOps.reduce((sum, row) => sum + row.count, 0);
console.log(`  sum of calls=${projectSum} vs sum of per-application requests=${perAppSum}`);
if (projectSum !== perAppSum) throw new Error("project operations disagree with the per-app totals");

const projectJobs = (await call(`/api/v1/telemetry/jobs?from=0&to=${all.to}`)).body as Array<{
  queue: string;
  jobName: string;
  applicationName: string;
  runs: number;
}>;
const jobsWithoutApp = projectJobs.filter((row) => !row.applicationName);
console.log(`project jobs: ${projectJobs.length} rows, ${jobsWithoutApp.length} without an applicationName`);
if (projectJobs.length === 0) throw new Error("no jobs in the project view");
if (jobsWithoutApp.length > 0) throw new Error("a project job row does not name its application");

const projectErrors = (await call(`/api/v1/telemetry/errors`)).body as Array<{
  id: string;
  applicationName: string;
}>;
console.log(
  `project errors: ${projectErrors.length} rows, all named=${projectErrors.every((row) => Boolean(row.applicationName))}`,
);
if (!Array.isArray(projectErrors)) throw new Error("the error list is not an array");

const projectLogs = (await call(`/api/v1/telemetry/logs?from=0&to=${all.to}`)).body as Array<{
  applicationName: string;
  text: string;
}>;
console.log(
  `project logs: ${projectLogs.length} rows across ${new Set(projectLogs.map((row) => row.applicationName)).size} applications`,
);
if (projectLogs.length === 0) throw new Error("no logs in the project view");
if (projectLogs.some((row) => !row.applicationName)) throw new Error("a project log row is unnamed");

const runtimeNoApp = await call(`/api/v1/telemetry/runtime?from=0&to=${all.to}`);
console.log(`runtime without an applicationId: ${runtimeNoApp.status} (per-process, so 400 is correct)`);
if (runtimeNoApp.status !== 400) throw new Error("runtime answered without an applicationId");

// Span-derived read models: Services, Map, Spans.
const serviceRows = (await call(`/api/v1/telemetry/services?from=0&to=${all.to}`)).body as Array<{
  className: string;
  applicationName: string;
  calls: number;
  ownMs: number;
  totalMs: number;
  methods: Array<{ method: string }>;
}>;
console.log(
  `services: ${serviceRows.length} classes, first=${serviceRows[0]?.className} ` +
    `own=${serviceRows[0]?.ownMs.toFixed(0)}ms total=${serviceRows[0]?.totalMs.toFixed(0)}ms ` +
    `methods=${serviceRows[0]?.methods.length}`,
);
if (serviceRows.length === 0) throw new Error("no classes in the services view");
if (serviceRows.some((row) => row.ownMs > row.totalMs + 1)) {
  throw new Error("own time is greater than total time — the child subtraction is wrong");
}

const map = (await call(`/api/v1/telemetry/map?from=0&to=${all.to}`)).body as {
  nodes: Array<{ applicationName: string; requests: number; jobs: number }>;
  edges: Array<{ fromName: string; toName: string; traces: number }>;
};
console.log(
  `map: ${map.nodes.length} nodes, ${map.edges.length} edges — ` +
    map.edges.slice(0, 4).map((edge) => `${edge.fromName}→${edge.toName}(${edge.traces})`).join(", "),
);
if (map.nodes.length === 0) throw new Error("the map has no nodes");
if (map.edges.length === 0) throw new Error("the map has no edges — seed cross-service traffic");

const spansManual = (await call(`/api/v1/telemetry/spans?from=0&to=${all.to}`)).body as {
  series: Array<{ t: number; invocations: number }>;
  rows: Array<{ name: string; origin: string; invocations: number; p95Ms: number }>;
};
console.log(
  `spans (manual): ${spansManual.rows.length} names, ${spansManual.series.length} buckets, ` +
    `first=${spansManual.rows[0]?.name} invocations=${spansManual.rows[0]?.invocations}`,
);
if (spansManual.rows.some((row) => row.origin !== "manual")) {
  throw new Error("mode=manual returned an auto span");
}

const spansAll = (await call(`/api/v1/telemetry/spans?mode=all&from=0&to=${all.to}`))
  .body as { rows: Array<{ origin: string }> };
console.log(`spans (all): ${spansAll.rows.length} names across origins=${[...new Set(spansAll.rows.map((row) => row.origin))].join(",")}`);
if (spansAll.rows.length < spansManual.rows.length) {
  throw new Error("mode=all returned fewer spans than mode=manual");
}

const traceId = process.env.TRACE_ID;
if (!traceId) {
  console.log("\nno multi-hop trace in the database — skipping the trace check");
} else {
  const trace = await call(`/api/v1/traces/${traceId}`);
  const body = trace.body as {
    applications: Array<{ name: string }>;
    executions: Array<{ execution: { kind: string }; applicationName: string; spans: unknown[] }>;
    logs: unknown[];
    durationMs: number | null;
  };
  console.log(`\ntrace ${traceId} (${trace.status})`);
  console.log(`  applications: ${body.applications.map((row) => row.name).join(" → ")}`);
  for (const hop of body.executions) {
    console.log(
      `  ${hop.execution.kind.padEnd(7)} ${hop.applicationName.padEnd(18)} spans=${hop.spans.length}`,
    );
  }
  console.log(`  logs=${body.logs.length} duration=${body.durationMs}ms`);
  if (trace.status !== 200) throw new Error("the trace did not resolve");
  if (body.executions.length < 2) throw new Error("the trace has a single hop");
  if (body.executions.some((hop) => hop.spans.length === 0)) {
    throw new Error("a hop has no spans");
  }
}

console.log("\nparity check passed");
EOF

API="$API" EMAIL="$EMAIL" PASSWORD="$PASSWORD" TRACE_ID="$TRACE_ID" bun "$CHECK"

psql "$DATABASE_URL" -q -c \
  "DELETE FROM session WHERE user_id IN (SELECT id FROM app_user WHERE email = '$EMAIL');
   DELETE FROM app_user WHERE email = '$EMAIL';" >/dev/null
echo "removed throwaway operator $EMAIL"
