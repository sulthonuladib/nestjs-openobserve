#!/usr/bin/env bash
# Generate realistic traffic against nestjs-orders-api.
#
#   ./seed.sh                 # 40 rounds against http://localhost:3100
#   BASE=http://localhost:3100 N=200 ./seed.sh
#   GATEWAY_ON=1 ./seed.sh    # create traffic goes through the gateway instead
#
# Produces: normal requests, slow requests (p95 + the latency SLO), unhandled
# errors, handled errors, queue jobs (some that fail their first attempt),
# and list queries against Postgres.
#
# With GATEWAY_ON=1 the creates are sent to nestjs-orders-gateway's
# `POST /checkout`, which calls the API itself - so one trace covers the
# gateway, the API and the worker. The other routes stay on the API: the
# gateway only proxies creates and reads, and the slow/boom/handled endpoints
# are API-only on purpose. Everything behaves exactly as before when the
# gateway is not running, which is why this is off by default.
set -u
BASE="${BASE:-http://localhost:3100}"
N="${N:-40}"
GATEWAY="${GATEWAY:-http://localhost:3200}"
GATEWAY_ON="${GATEWAY_ON:-0}"

CREATE_URL="$BASE/orders"
if [[ "$GATEWAY_ON" == "1" ]]; then
  CREATE_URL="$GATEWAY/checkout"
fi

for i in $(seq 1 "$N"); do
  total=$(( (RANDOM % 500) + 1 ))
  explode=""
  if (( i % 13 == 0 )); then explode=', "explode": true'; fi

  curl -s -o /dev/null -X POST "$CREATE_URL" \
    -H 'content-type: application/json' \
    -H "x-user-id: user-$(( i % 5 ))" \
    -d "{\"total\": ${total}${explode}}"

  if (( i % 7 == 0 )); then curl -s -o /dev/null "$BASE/orders/slow/800"; fi
  if (( i % 11 == 0 )); then curl -s -o /dev/null "$BASE/orders/boom/$i"; fi
  if (( i % 9 == 0 )); then curl -s -o /dev/null "$BASE/orders/handled/$i"; fi
  if (( i % 5 == 0 )); then curl -s -o /dev/null "$BASE/orders?limit=20"; fi
  # The gateway's read path, only when it is part of the run.
  if [[ "$GATEWAY_ON" == "1" ]] && (( i % 8 == 0 )); then
    curl -s -o /dev/null "$GATEWAY/orders?limit=10"
  fi

  sleep 0.2
done

if [[ "$GATEWAY_ON" == "1" ]]; then
  echo "seeded ${N} rounds against ${BASE} (creates via ${GATEWAY})"
else
  echo "seeded ${N} rounds against ${BASE}"
fi
