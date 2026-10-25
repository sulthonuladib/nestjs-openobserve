#!/usr/bin/env bash
# Wipe every table and let the collector rebuild the schema from scratch.
#
#   ./scripts/reset-db.sh --yes
#   OBSERVE_DATABASE_URL=postgres://… ./scripts/reset-db.sh --yes
#
# Postgres keeps its own migrations journal in the `drizzle` schema, so dropping
# `public` alone leaves the migrator convinced everything is already applied and
# the schema never comes back. Both schemas are dropped here for that reason.
set -euo pipefail

URL="${OBSERVE_DATABASE_URL:-postgres://observe:observe@localhost:5433/observe}"

if [ "${1:-}" != "--yes" ]; then
  cat <<EOF
This DELETES everything in:
  $URL

  users, sessions, invites, projects, applications, API keys,
  all telemetry, settings, audit log.

Re-run with --yes if that is what you want:
  ./scripts/reset-db.sh --yes
EOF
  exit 1
fi

psql "$URL" -v ON_ERROR_STOP=1 --quiet \
  -c 'DROP SCHEMA IF EXISTS public CASCADE' \
  -c 'CREATE SCHEMA public' \
  -c 'DROP SCHEMA IF EXISTS drizzle CASCADE'

echo "wiped $URL"
echo
echo "restart the collector so migrations run again:"
echo "  bun dev"
echo
echo "then open http://localhost:4320 (or http://localhost:5173) and you get /setup."
