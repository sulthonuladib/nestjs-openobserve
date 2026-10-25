#!/usr/bin/env bash
# Snapshot the upstream product documentation into docs/upstream/observe-docs/.
#
# Why: the written documentation is the only source for *semantics* — how an
# alert evaluates, what an error budget actually computes, what the issue
# workflow means. The UI bundle tells you which fields exist; this tells you
# what they are for. Committed so agents and contributors read the same text,
# and so a change upstream is a reviewable diff.
#
# Re-run when the upstream docs change:
#   ./scripts/sync-upstream-docs.sh && git diff --stat docs/upstream
set -euo pipefail

OUT="docs/upstream/observe-docs"
BASE="https://www.observe.nestjs.com/llms"
mkdir -p "$OUT"

PAGES=(
  overview applications sdk telemetry traces mcp users
  profiler alerts slos issues billing faq
)

echo "== index"
curl -fsS --retry 3 -m 30 "https://www.observe.nestjs.com/llms.txt" -o "$OUT/llms.txt"

echo "== full"
curl -fsS --retry 3 -m 60 "https://www.observe.nestjs.com/llms-full.txt" -o "$OUT/llms-full.txt"

for page in "${PAGES[@]}"; do
  printf '== %s\n' "$page"
  curl -fsS --retry 3 -m 30 "$BASE/$page.md" -o "$OUT/$page.md"
done

echo "== nestjs observability chapter"
curl -fsS --retry 3 -m 30 \
  "https://docs.nestjs.com/observability/overview.md" \
  -o "$OUT/nestjs-observability-overview.md" || echo "  (not available as markdown; skipping)"

{
  echo "# Upstream documentation snapshot"
  echo
  echo "Fetched $(date -u +%Y-%m-%dT%H:%M:%SZ) by \`scripts/sync-upstream-docs.sh\`."
  echo
  echo "Source: <https://www.observe.nestjs.com/llms.txt> (the product's own"
  echo "machine-readable documentation index) and the NestJS observability chapter."
  echo
  echo "**Read-only reference material.** This is somebody else's prose, kept for"
  echo "the semantics it describes — alert evaluation, error budgets, the issue"
  echo "workflow, the MCP surface. Do not edit it; re-run the sync script instead."
  echo
  echo "| File | What it covers |"
  echo "|---|---|"
  echo "| \`llms-full.txt\` | every page in one file (the one to grep) |"
  echo "| \`overview.md\` | teams, projects, applications, first project |"
  echo "| \`applications.md\` | projects, applications, API keys, teams, access control |"
  echo "| \`sdk.md\` | instrumentation options |"
  echo "| \`telemetry.md\` | requests, errors, jobs, traces, logs, dashboard |"
  echo "| \`traces.md\` | waterfall, self time, error source frames, agent hand-off |"
  echo "| \`mcp.md\` | the MCP server surface |"
  echo "| \`users.md\` | per-user activity, grouped actions |"
  echo "| \`profiler.md\` | CPU, memory, event loop, GC per process |"
  echo "| \`alerts.md\` | thresholds, channels, history |"
  echo "| \`slos.md\` | objectives, error budgets |"
  echo "| \`issues.md\` | the issue workflow |"
  echo "| \`billing.md\` | plans, usage, cost, spend controls — **removed by us** |"
  echo "| \`faq.md\` | setup, retention, privacy, OTel comparison |"
} > "$OUT/README.md"

echo
echo "wrote $(find "$OUT" -type f | wc -l) files to $OUT"
du -sh "$OUT"
