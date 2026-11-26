#!/usr/bin/env bash
# Verify the dashboard shell is served for every BrowserRouter path, and that the
# API/health/asset namespaces keep their real 404s.
#
# Reuses a server already answering on the port (a `bun --watch` dev server, say)
# and only starts one when there is none.
#
#   ./scripts/check-spa-fallback.sh [port]
set -euo pipefail
PORT="${1:-4390}"
BASE="http://localhost:$PORT"
cd "$(dirname "$0")/.."

if curl -sf "$BASE/health" >/dev/null; then
  echo "using the server already on $BASE"
else
  OBSERVE_DATABASE_URL="${OBSERVE_DATABASE_URL:-postgres://observe:observe@localhost:5433/observe}" \
  OBSERVE_PORT="$PORT" OBSERVE_RUN_MIGRATIONS=0 \
    bun src/server/index.ts >/tmp/spa-fallback.log 2>&1 &
  SERVER=$!
  trap 'kill $SERVER 2>/dev/null || true' EXIT

  for _ in $(seq 1 40); do
    if curl -sf "$BASE/health" >/dev/null; then break; fi
    sleep 0.25
  done
fi

fail=0
check() {
  local path="$1" want="$2" what="${3:-}"
  local code
  code=$(curl -s -o /tmp/spa-body -w '%{http_code}' "$BASE$path")
  if [ "$code" = "$want" ]; then
    printf 'ok   GET %-34s %s %s\n' "$path" "$code" "$what"
  else
    printf 'FAIL GET %-34s %s (want %s) %s\n' "$path" "$code" "$want" "$what"
    fail=1
  fi
}

# The app shell: a hard navigation or a refresh must boot the dashboard.
check / 200 "shell"
check /link 200 "device-code page"
check /invite/abc 200 "invite page"
check /setup 200 "first-run wizard"
check /login 200 "sign in"
check /applications 200 "applications list"
check /applications/some-id 200 "application detail"
check /applications/some-id/slos 200 "SLO tab"
check /applications/some-id/executions 200 "executions tab"
check /executions/some-id 200 "trace detail"

# A real 404 in each namespace: a misspelled API route must never return HTML.
check /api/v1/nope 404 "api 404"
check /assets/nope.js 404 "asset 404"
check /nonexistent 404 "unknown path"

# The shell is the bundled app, not the raw HTML file.
curl -s "$BASE/" -o /tmp/spa-root
grep -q 'id="root"' /tmp/spa-root && printf 'ok   / contains the root div\n' || { printf 'FAIL / has no root div\n'; fail=1; }
grep -qE '<script[^>]+type="module"' /tmp/spa-root && printf 'ok   / loads a module script\n' || { printf 'FAIL / has no module script\n'; fail=1; }

exit "$fail"
