#!/usr/bin/env bash
# Quick traffic burst against the demo app, then read the result back.
set -euo pipefail
APP="${APP:-http://localhost:3001}"

for _ in 1 2; do
  curl -s -o /dev/null "$APP/orders/boom/nope"
  curl -s -o /dev/null "$APP/orders/slow/90"
  curl -s -o /dev/null "$APP/orders"
done
echo "traffic sent"
sleep 9
curl -s -b /tmp/obs-cookies.txt "${COLLECTOR:-http://localhost:4320}/api/v1/applications"
echo
