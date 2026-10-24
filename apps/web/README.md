# Dashboard

The self-hosted UI. React 19 + Vite + Tailwind v4 + TanStack Query, built to
`dist/` and served by the collector's `@elysiajs/static` plugin.

```bash
bun run dev     # :5173, proxies /api and /health to :4320
bun run build   # dist/
bun run typecheck
```

## Structure

```
src/
  api.ts            the HTTP client — the one place types are declared
  format.ts         pure formatters + waterfall geometry (tested)
  router.ts         a 60-line hash router; the URL is the state
  components/ui.tsx Card, Stat, Table, Badge, Skeleton, ErrorState, Empty
  pages/            Overview, Application, Executions + ExecutionDetail,
                    Errors + Logs, Link
```

## Decisions

- **The URL is the state.** Time range, filters and selection are query
  parameters, so any view can be pasted into a chat or a runbook.
- **Hash routing, not TanStack Router.** Six flat routes; a router library plus
  its codegen is more machinery than the app. `@tanstack/react-router` stays in
  `package.json` for the nested-layout work in M2.
- **Hand-written API types, not Eden.** Importing the server's Elysia app type
  makes the web typecheck as slow as the server's and couples the bundle graph to
  the collector. `api.ts` is deliberately small, and `drizzle-typebox` already
  keeps the server's response models equal to its schema.
- **No chart library yet.** The overview is tables and numbers because that is
  what the data supports today; uPlot lands with the time-series charts in M2.

## Not built yet

- Time-series charts (p50/p95/p99 over time) — needs a rollup-series endpoint
- Jobs, runtime metrics, custom metrics, SLOs, releases and alerts pages
- SSO and team management
- The waterfall's zoom/brush interaction and the "compare typical" view

## Server gaps

- `POST /api/v1/link/approve` is not authenticated yet. Before a multi-user
  install, gate `/api/v1/link/*` behind dashboard session middleware: the entire
  security property of a device-code flow is that a human who can see the
  terminal approves it.
