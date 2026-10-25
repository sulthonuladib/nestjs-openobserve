#!/usr/bin/env bash
# Generate traffic against the demo Nest app, then read it back through the
# collector's query API. Used as the end-to-end check that a real @nestjs/observe
# agent works against a self-hosted collector.
set -euo pipefail

APP="${APP:-http://localhost:3001}"
COLLECTOR="${COLLECTOR:-http://localhost:4320}"
COOKIE="${COOKIE:-/tmp/obs-cookies.txt}"
ROUNDS="${ROUNDS:-3}"

echo "== traffic against $APP"
for i in $(seq 1 "$ROUNDS"); do
  curl -s -o /dev/null "$APP/"
  curl -s -o /dev/null "$APP/orders"
  curl -s -o /dev/null "$APP/orders/1"
  # 404: ordinary control flow, sampled in as a request and not a bug.
  curl -s -o /dev/null "$APP/orders/999"
  # a slow success
  curl -s -o /dev/null "$APP/orders/slow/120"
  # an unhandled TypeError: this is what must become one error group
  curl -s -o /dev/null "$APP/orders/boom/1"
  curl -s -o /dev/null -X POST "$APP/orders" \
    -H 'content-type: application/json' -d "{\"total\":$((i * 10))}"
done

echo "== waiting for a flush (the agent batches every 5s)"
sleep 8

echo
echo "== applications"
curl -s -b "$COOKIE" "$COLLECTOR/api/v1/applications" | head -c 600; echo

APP_ID=$(curl -s -b "$COOKIE" "$COLLECTOR/api/v1/applications" \
  | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "${APP_ID:-}" ]; then
  echo "no application — is the Nest app sending to $COLLECTOR?" >&2
  exit 1
fi

echo
echo "== operations"
curl -s -b "$COOKIE" "$COLLECTOR/api/v1/applications/$APP_ID/operations" \
  | tr '}' '}\n' | head -12

echo
echo "== executions (latest 5)"
curl -s -b "$COOKIE" "$COLLECTOR/api/v1/applications/$APP_ID/executions?limit=5" \
  | tr '}' '}\n' | head -8

echo
echo "== error groups"
curl -s -b "$COOKIE" "$COLLECTOR/api/v1/applications/$APP_ID/errors" \
  | tr '}' '}\n' | head -6
