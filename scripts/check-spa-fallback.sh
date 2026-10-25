#!/usr/bin/env bash
# Verify the SPA fallback without touching a running dev server.
set -euo pipefail
PORT="${1:-4390}"
cd "$(dirname "$0")/.."

OBSERVE_DATABASE_URL="${OBSERVE_DATABASE_URL:-postgres://observe:observe@localhost:5433/observe}" \
OBSERVE_SINGLE_PORT=1 OBSERVE_API_PORT="$PORT" OBSERVE_RUN_MIGRATIONS=0 \
  bun apps/server/src/index.ts >/tmp/spa-fallback.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf "http://localhost:$PORT/health" >/dev/null; then break; fi
  sleep 0.25
done

printf 'GET /dashboard/link  -> '
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "http://localhost:$PORT/dashboard/link"
printf 'GET /nonexistent     -> '
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:$PORT/nonexistent"
printf 'GET /api/v1/nope     -> '
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:$PORT/api/v1/nope"
printf 'GET /                -> '
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:$PORT/"
