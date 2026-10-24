#!/usr/bin/env bash
# Exercises the device-code link flow the way `npx @nestjs/observe link` does:
# start -> approve in the dashboard -> poll once for a key pair -> poll again and
# get a refusal, because the secret exists exactly once.
set -euo pipefail

BASE="${BASE:-http://localhost:4320}"

echo "== start"
START=$(curl -fsS -X POST "$BASE/cli-link/sessions" \
  -H 'content-type: application/json' \
  -d '{"applicationName":"orders-api","hostname":"'"$(hostname)"'"}')
echo "$START"

UCODE=$(printf '%s' "$START" | sed -n 's/.*"userCode":"\([^"]*\)".*/\1/p')
DCODE=$(printf '%s' "$START" | sed -n 's/.*"deviceCode":"\([^"]*\)".*/\1/p')

echo "== pending (deviceCode must be absent)"
curl -fsS "$BASE/api/v1/link/pending"; echo

echo "== poll before approval (expect authorization_pending)"
curl -s -X POST "$BASE/cli-link/token" -H 'content-type: application/json' \
  -d "{\"deviceCode\":\"$DCODE\"}"; echo

echo "== approve $UCODE"
curl -fsS -X POST "$BASE/api/v1/link/approve" -H 'content-type: application/json' \
  -d "{\"userCode\":\"$UCODE\"}"; echo

echo "== poll after approval (expect appKey + appSecret)"
CREDS=$(curl -fsS -X POST "$BASE/cli-link/token" -H 'content-type: application/json' \
  -d "{\"deviceCode\":\"$DCODE\"}")
echo "$CREDS"

echo "== poll again (expect expired_token: single use)"
curl -s -X POST "$BASE/cli-link/token" -H 'content-type: application/json' \
  -d "{\"deviceCode\":\"$DCODE\"}"; echo

echo "== ingest with the minted pair (expect degraded:false)"
KEY=$(printf '%s' "$CREDS" | sed -n 's/.*"appKey":"\([^"]*\)".*/\1/p')
SECRET=$(printf '%s' "$CREDS" | sed -n 's/.*"appSecret":"\([^"]*\)".*/\1/p')
bun -e "
const { sampleBatch } = await import('./packages/shared/src/fixtures.ts');
const body = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(sampleBatch())));
const res = await fetch('$BASE/applications/telemetry', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'content-encoding': 'gzip',
    'x-api-key': '$KEY',
    'x-api-secret': '$SECRET',
    'x-observe-ingest-modes': 'reduced, trimmed, paced, errors-only',
  },
  body,
});
console.log(res.status, await res.text());
"
