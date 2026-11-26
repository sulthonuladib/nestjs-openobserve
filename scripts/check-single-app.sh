#!/usr/bin/env bash
# The single-app smoke: one process, one port, React on /, API on /api, real
# 404s for unknown API paths, and deep links still landing on the bundled shell.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-4391}"

OBSERVE_PORT="$PORT" OBSERVE_DATABASE_URL="${OBSERVE_DATABASE_URL:-postgres://observe:observe@localhost:5433/observe_test}" \
  bun src/server/index.ts >/tmp/single-app.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/health" >/dev/null; then break; fi
  sleep 0.25
done

check() { printf '%-34s %s\n' "$1" "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT$2")"; }

check "GET /health" /health
check "GET /api/v1/auth/status" /api/v1/auth/status
check "GET /  (React shell)" /
check "GET /link  (deep link)" /link
check "GET /api/v1/nope  (real 404)" /api/v1/nope

printf '\nroot HTML contains #root? '
curl -s "http://localhost:$PORT/" | grep -c 'id="root"' || true
printf 'root HTML contains a module script? '
curl -s "http://localhost:$PORT/" | grep -c 'type="module"' || true
printf 'ingest accepts a batch? '
bun -e "
const body = Bun.gzipSync(new TextEncoder().encode(JSON.stringify({
  serviceId: 'single-app-smoke',
  snapshots: [{ ti: 'trace-1', op: 'GET /', t: [{ o: 'auto', c: 'A', m: 'b', d: 1 }], a: { m: 'GET', sc: 200 } }],
})));
const res = await fetch('http://localhost:$PORT/applications/telemetry', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
  body,
});
console.log(res.status, await res.text());
"
