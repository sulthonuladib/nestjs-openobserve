#!/usr/bin/env bash
# Close every background session this repo's agent runs left behind.
#
# Only sessions in the `nestjs-openobserve` project are touched, and only the
# ones the orchestrator/agents created (babysit, probe, verify, smoke, build…).
# The user's own panes are never in that set: they are named `nestjs-openobserve`,
# `bun dev`, `bun dev:web`, and the orchestrator's own session is skipped by id.
set -uo pipefail

SELF="${KERO_SESSION:-}"
KEEP_NAMES="nestjs-openobserve|bun dev|bun dev:web|fish"

kero ls | awk 'NR>1' | while read -r line; do
  id=$(printf '%s' "$line" | awk '{print $1}' | sed 's/^›//')
  [ -z "$id" ] && continue
  project=$(printf '%s' "$line" | awk '{print $2}')
  name=$(printf '%s' "$line" | cut -c18-60 | sed 's/ *$//')

  [ "$project" = "nestjs-openobserve" ] || continue
  [ "$id" = "$SELF" ] && continue
  printf '%s' "$name" | grep -qiE "$KEEP_NAMES" && continue

  printf 'closing %-10s %s\n' "$id" "$name"
  kero close "$id" >/dev/null 2>&1 || true
done

# Leftover probe scripts from subagents, and any process still running one.
rm -f probe*.tmp.ts probe*.txt 2>/dev/null || true
for pid in $(pgrep -f 'probe[0-9]*\.tmp\.ts' 2>/dev/null || true); do
  kill "$pid" 2>/dev/null || true
done

echo "remaining in this project:"
kero ls | awk 'NR>1 && $2=="nestjs-openobserve" {print "  " $1, $3}'
