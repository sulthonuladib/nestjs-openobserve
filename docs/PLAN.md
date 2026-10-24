# Self-hosted NestJS Observe — master plan

Status: **draft** · Target SDK: `@nestjs/observe@0.3.17` (`repos/observe@0275d36`) · License: MIT

---

## 1. The idea in one paragraph

`@nestjs/observe` is an auto-instrumenting APM agent for NestJS. It ships
telemetry to a **hosted** backend at `https://observe-api.nestjs.com` over a
small, fully-documented-by-source HTTP protocol. That protocol is the only
coupling: point `OBSERVE_ENDPOINT` at our collector and the SDK is ours. We
build the missing half — the collector, the storage, the query API and the
dashboard — as a **single self-hosted binary image** with no per-event metering
and no plans. The agent stays untouched, MIT, consumed as-is.

The consequence that drives the whole design: **the SDK is the specification**.
`repos/observe/src/agent/telemetry-wire-contract.ts` is a hand-written
declaration of exactly what the hosted API accepts (including
`forbidNonWhitelisted`), and its `*.int-spec.ts` files pin the reply semantics.
We implement to that, not to guesswork.

---

## 2. What the SDK actually sends (the contract we must accept)

Verified from source; full detail in [`spec/ingest-api.md`](spec/ingest-api.md).

### Endpoints

| Method | Path | Body | Notes |
|---|---|---|---|
| `POST` | `/applications/telemetry` | gzip JSON `TELEMETRY_BATCH` | the only hot path |
| `POST` | `/applications/profiles` | gzip | **shelved in SDK 0.3.17** — endpoints unregistered; we stub + version the table for its return |
| `POST` | `/cli-link/sessions` | `{ applicationName, hostname }` | device-code start |
| `POST` | `/cli-link/token` | `{ deviceCode }` | poll → credentials or `authorization_pending` / `slow_down` / `access_denied` / `expired_token` |

### Headers on every ingest request

```
content-type: application/json
content-encoding: gzip
x-api-key: <appKey>
x-api-secret: <appSecret>
x-observe-ingest-modes: reduced, trimmed, paced, errors-only
```

Credentials are **omitted entirely** when unset — a collector that accepts
unauthenticated batches is a supported mode (that is how a local collector
works). Our collector must therefore support `OBSERVE_REQUIRE_AUTH=false`.

### The batch

```jsonc
{
  "serviceId": "string ≤100",          // required
  "serviceVersion": "string ≤50",
  "truncatedSpans": 12,
  "forwardLogs": true,
  "snapshots": [ /* requests & GraphQL/RPC/WS ops */ ],
  "jobs":      [ /* queue + cron jobs */ ],
  "runtime":   { /* one sampled window */ },
  "custom":    [ /* counters, gauges, summaries */ ],
  "logs":      [ /* Nest log lines */ ],
  "objectives":[ /* @Objective() declarations → SLOs */ ]
}
```

Every section caps at **5000 entries** (`MAX_BATCH_ITEMS`), except
`objectives` at 100. A span is `{n,o,t,d,e,c,m,s,so,ch[]}` where `o` and `c` and
`m` are **required** and `ch` nests arbitrarily deep. `st` is deliberately
**not** accepted on a snapshot (the SDK deletes it before encoding; a payload
carrying it is a 400).

### The reply

The SDK reads exactly one thing on a `200`: the JSON body's `degraded` flag.

| We answer | Agent behaviour |
|---|---|
| `200 {}` or `200 {"degraded":false}` | healthy; keeps backing off at zero |
| `200 {"degraded":true, …}` | starts withholding span trees for 5 min (`DEGRADED_TTL_MS`) |
| `401` / `403` | counts a rejection, exponential backoff to 1 probe/hour, drops batches |
| `429` + optional `Retry-After` | pauses sends for that long (default 5 min) |
| `400` | tries to strip offending fields and re-send **once**, then drops |
| anything else | logs `statusText` and drops |

**Because we are removing pricing, we never answer `degraded: true`.** All four
degraded modes (`reduced`, `trimmed`, `paced`, `errors-only`) exist purely to
throttle a metered allowance. Our reply is always `{"degraded":false}`. That
single decision deletes the entire quota subsystem — sampling and retention
become operator configuration, applied server-side, invisibly to the agent.

`400` must stay strict: it is the agent's self-repair trigger. We validate with
the same shape as `TELEMETRY_BATCH` and refuse extra keys, so a drifted encoder
is caught at the edge and repaired by the SDK's own sanitizer.

---

## 3. Scope: full feature parity, minus pricing

### 3.1 Kept — the product

| # | Feature | What the user gets | Primary surfaces |
|---|---|---|---|
| F1 | **Applications / services** | one row per `serviceId`, name, latest release, request rate, error rate, p95, health | onboarding, service detail, switch |
| F2 | **Requests / operations** | every HTTP route, GraphQL op, RPC message, WS event, cron job, queue job as a named operation with throughput, p50/p95/p99, status mix | overview, operations list |
| F3 | **Distributed traces** | waterfall with real overlap from `so`+`d`, span tree, per-span self time, class/method attribution, `observe.collapsed` ×N nodes, cross-service continuation via `x-request-id` | trace list, trace detail |
| F4 | **Errors** | grouping by fingerprint (class + message + top in-app frame), occurrences over time, source context around each frame, affected releases, first/last seen, resolve / ignore / reopen, link to trace | errors list, error detail |
| F5 | **Logs** | correlated log search; each line carries `traceId`/`spanId`/`level`/`context`; jump log→trace and trace→logs | log explorer, trace panel |
| F6 | **Jobs & queues** | queue name, job name, status, `waitDuration` (backlog), `attemptsMade`/`maxAttempts`, duration, failures | jobs page |
| F7 | **Scheduled jobs** | `@Cron` / `@Interval` / `@Timeout` runs as jobs | jobs page |
| F8 | **Runtime metrics** | memory (rss/heap/total/external/arrayBuffers), CPU (user/system/percent), GC (count/duration by kind), event loop (latency/utilisation) as gauges per service instance | profiler / runtime page |
| F9 | **Custom metrics** | counter / gauge (`additive`\|`ratio`\|`peak`) / summary (`q50/q95/q99/count/sum/min/max`), labelled series, series-limit UX | metrics page |
| F10 | **SLOs / objectives** | `@Objective()` declarations ingested, matched to routes, availability + latency budgets, error budget remaining, 7/14/28/30-day windows, "declared in code" badge, hourly restatement | SLO page |
| F11 | **Alerts** | rules on error rate / p95 / throughput / error count, thresholds + windows, channels (webhook, Slack-compatible, email), history, mute | alerts page |
| F12 | **Drop filters** | server-side discard rules on `http.route`, `http.url`, operation, release — applied at ingest before storage | settings |
| F13 | **Releases** | `serviceVersion` timeline, regression detection (error/латency vs previous release), affected-error attribution, deploy markers | releases page |
| F14 | **Custom operation IDs** | honour `a.dop` / `TracerService.setOperationId`, cap of 100 live names per project per 30 days, fall back to route when over | operations |
| F15 | **Source context** | render the captured `linesOfContext` around each stack frame, with the frame highlighted | error detail |
| F16 | **Request capture** | headers/body captured for failed or slow requests, exactly as the SDK redacts them | trace detail |
| F17 | **API keys** | app key/secret pairs per application, issue once (secret shown once), revoke, rotate — and the `/link` device-code flow that makes `npx @nestjs/observe link` work against us | settings, `/link` |
| F18 | **Projects / environments / teams** | a project scopes applications and members; env is a tag dimension | settings |
| F19 | **Retention** | configurable per data class (traces / logs / metrics), enforced by a rollup + prune job; **operator config, not a plan** | settings |
| F20 | **MCP endpoint** | the hosted product documents an MCP integration; expose a read-only MCP server over our query API so agents can query telemetry | `/mcp` |
| F21 | **Auth** | first-run admin bootstrap, sessions, optional OIDC, per-role permissions | login, settings |
| F22 | **Self-observability** | ingest lag, batch size, drops, 400-repair rate, storage size, query latency | `/admin/health` |

### 3.2 Removed — explicitly out of scope

| Surface | Why removed | Consequence |
|---|---|---|
| Pricing / plans / tiers | the point of self-hosting | none |
| Billing, invoices, Stripe, payment method | ditto | none |
| Monthly event allowance / metering / overage | ditto | **the agent's `degraded` reply is always false**; no `OveragePauseReason`, no spike protection, no `notable` trimming |
| Quota / usage banners & upgrade prompts | ditto | — |
| Seat counting | ditto | unlimited members |
| Free-tier pacing (`paced`) and reduced ingest (`reduced`) | ditto | — |
| `trimmed` spans on a "paying" account | ditto | — |
| Trial / expired-account states | ditto | — |

Deleting these also deletes a surprising amount of *ingest* complexity the SDK
expects the backend to have (`isNotableSnapshot`, `isServerErrorSnapshot`,
`countTraceNodes` mirrors, the 5-minute degraded TTL handshake). We implement
`{"degraded":false}` and move on.

### 3.3 Feature parity matrix (build order)

Legend: **P0** must ship in v0.1 · **P1** v0.2 · **P2** v0.3+ · — removed

| Feature | v0.1 | v0.2 | v0.3 |
|---|---|---|---|
| F1 applications | P0 | | |
| F2 operations | P0 | | |
| F3 traces + waterfall | P0 | | |
| F4 errors + grouping | P0 | resolve/ignore P1 | |
| F5 logs | | P0 | |
| F6/F7 jobs | | P0 | |
| F8 runtime metrics | | P0 | |
| F9 custom metrics | | P0 | |
| F13 releases | | P0 | |
| F17 API keys + `/link` | P0 | | |
| F21 auth | P0 | OIDC P2 | |
| F12 drop filters | | P1 | |
| F10 SLOs | | P1 | |
| F11 alerts | | P1 | |
| F19 retention | P0 (fixed default) | P1 (config) | |
| F14 custom op IDs | | P0 | |
| F15/F16 source ctx + capture | P0 (render) | | |
| F18 projects/envs | P0 (single project) | multi P1 | |
| F20 MCP | | | P2 |
| F22 self-observability | P0 (`/health`) | P1 | |
| Pricing & billing | — | — | — |

---

## 4. Architecture

```
                    ┌─────────────────────────── one Bun process ───────────────────────────┐
 SDK agent          │                                                                      │
 (untouched)        │  ┌────────────┐   ┌──────────────┐   ┌─────────────┐   ┌───────────┐  │
   │ gzip POST      │  │  ingest    │──▶│  normalizer  │──▶│   writer    │──▶│  storage  │  │
   ├───────────────▶│  │  route     │   │  (decode,    │   │  (batched,  │   │ Postgres  │  │
   │ x-api-key      │  │  auth,     │   │   fp errors, │   │   COPY into │   │ Postgres  │  │
   │                │  │  validate, │   │   collapse,  │   │   staging,  │   │           │  │
   │                │  │  drop-filt │   │   rollup ctr)│   │   flush)    │   │           │  │
   │                │  └────────────┘   └──────────────┘   └─────────────┘   └───────────┘  │
   │                │        │                  ▲                  ▲               │        │
   │                │        │ 400 on malformed │      ┌───────────┴──┐   ┌────────┴──────┐ │
   │                │        └──────────────────┘      │ rollup/cron  │   │ query API     │ │
   │                │                                  │ (SLO, alerts,│   │ (Elysia, Eden │ │
   │                │                                  │  retention)  │   │  client types)│ │
   │                │                                  └──────────────┘   └───────┬───────┘ │
   │                │                                                             │         │
   │                │      ┌──────────────────────────────────────────────────────┘         │
   │                │      ▼                                                                │
   │                │  ┌─────────┐   SPA (static assets, embedded in the binary)             │
   └────────────────┘  │  web    │                                                        │
                       └─────────┘                                                        │
                    └──────────────────────────────────────────────────────────────────────┘
```

Single process, two Elysia app instances sharing one runtime. Each feature is a
module (`apps/server/src/modules/<feature>/`: `index.ts` controller, `service.ts`
logic, `model.ts` schemas) built as a **named Elysia plugin**, with `config`,
`db` and `state` injected as plugins from `apps/server/src/plugins/` — so Elysia
deduplicates them and no handler reaches for a global:

- **`ingestApp`** — mounted before anything else, no session middleware, no
  cookies, no CORS work, gzip decode only. Its whole job is "accept bytes
  fast". Runs on its own port (default `:4319`) so it can be exposed
  separately from the dashboard (`:4320`).
- **`apiApp`** — the dashboard JSON API + static SPA + `/mcp`.
- **`workerApp`** — in-process: timer-driven rollups, SLO evaluation, alert
  evaluation, retention pruning. `Bun.cron` where a wall-clock schedule is
  natural, `setInterval` where it is not.

Why two ports: ingest is internet-facing, the dashboard usually is not. Splitting
them means "expose the dashboard only on the VPN" is a deployment fact, not a
proxy config. They can also be collapsed onto one port (`OBSERVE_SINGLE_PORT=1`).

### Why Bun + Elysia specifically

- `Bun.serve`'s HTTP parser is the fastest mainstream JS one, and ingest is a
  pure "read body, gunzip, parse JSON, insert rows" loop — per-request overhead
  is the whole cost.
- `Bun.gunzipSync` on the hot path, `Bun.password` (argon2id) for secrets with no
  native dependency, `Bun.SQL` for Postgres with no `pg` in the image, `bun test`
  for the whole suite, `bun build --compile` for the tar.gz artifact.
- Elysia's design goal is compile-time route flattening; with the **AoT
  compiler** the hot ingest route becomes a static function. It also gives us
  Eden for end-to-end typed UI→API calls from the same TS types.

Full rationale, alternatives and risks: [`spec/tech-stack.md`](spec/tech-stack.md).

---

## 5. Storage model

**Postgres only**, modelled and migrated with **Drizzle**
(`drizzle-orm/bun-sql` → `Bun.SQL`, no `pg` dependency). `OBSERVE_DATABASE_URL`
is required; there is no embedded fallback.

The reasoning, in one line each:

- This is append-heavy time series aggregated over arbitrary windows. Postgres
  does that natively — `jsonb` + GIN for tags, `unnest … WITH ORDINALITY` for
  histogram merges, native partitions for retention.
- An embedded database would mean owning a second engine, its backup story and
  its single-writer ceiling, to save the operator a container they already run.
- One dialect means one set of queries to test, and `drizzle-typebox` can derive
  the API's response models from the same column definitions that create the
  tables.

Conventions: `uuid` primary keys minted by the collector as **UUIDv7** (sorted by
time, so B-tree inserts stay append-like); every timestamp is `bigint` epoch
**milliseconds**; `jsonb` — never `json` — for anything filtered or aggregated.

Time-series tables are **append-only**. `execution`, `span`, `log_entry` and
`metric_point` convert to `PARTITION BY RANGE (started_at)` in M1; retention then
becomes `DROP` the oldest partition, which is O(1) and never touches the write
path with a `DELETE`.

### Core tables

```
project            id, name, slug, settings(json), created_at
user               id, email, password_hash(argon2id), role, created_at
session            id, user_id, expires_at
application        id, project_id, service_id, name, first_seen, last_seen
app_credential     id, application_id, key_prefix, key_hash, secret_hash,
                   label, created_at, last_used_at, revoked_at
release            id, application_id, version, first_seen, last_seen, commit_sha
operation          id, application_id, kind(http|graphql|rpc|ws|job|cron),
                   operation_id, method, first_seen, last_seen, custom_name
execution          id, application_id, release_id, operation_id, kind,
                   trace_id, started_at, duration_ms, status_code, user_id,
                   error_id, protocol, tags(json), request(json?), is_root
span               id, execution_id, parent_id, name, class, method, origin,
                   duration_ms, start_offset_ms, error(bool), tags(json),
                   collapsed_count
error_group        id, application_id, fingerprint, class, message,
                   top_frame_file, top_frame_line, first_seen, last_seen,
                   occurrences, status(open|resolved|ignored)
error_occurrence   id, error_group_id, execution_id, release_id, occurred_at,
                   stack, source_context(json)
log_entry          id, application_id, occurred_at, level, context, text,
                   trace_id, span_id, attributes(json)
job_run            id, application_id, release_id, queue, name, status,
                   trace_id, started_at, duration_ms, wait_ms,
                   attempts_made, max_attempts, error_id
runtime_sample     id, application_id, released_at, cpu(json), memory(json),
                   gc(json), event_loop(json)
metric_series      id, application_id, name, type, kind, labels_hash, labels(json)
metric_point       series_id, at, value, plus summary columns
slo                id, application_id, operation_id, name, kind, target,
                   window_days, source(code|dashboard), declared_by, updated_at
alert_rule         id, project_id, application_id, metric, comparator,
                   threshold, window_s, channels(json), enabled, muted_until
alert_event        id, rule_id, state, started_at, resolved_at, value, payload
drop_filter        id, project_id, field, matcher, pattern, enabled
retention_policy   id, project_id, data_class, days
```

### Indexing rules that matter

- `execution (application_id, started_at)` clustered — every chart is a range scan.
- `span (execution_id)` — waterfall join.
- `execution (trace_id)` — cross-service trace lookup and log correlation.
- `error_group (application_id, status, last_seen)` — error list default sort.
- `error_occurrence (error_group_id, occurred_at)` — occurrences chart.
- `log_entry (application_id, occurred_at)` + a `tags` GIN/JSON index.
- `metric_point (series_id, at)`.
- Pre-aggregated counters in `rollup_*` per minute/hour, written by the
  normalizer (not scanned at query time) — this is what keeps the overview page
  O(minutes) instead of O(events).

---

## 6. Query API design

Shape: `/api/v1/*`, JSON, session-cookie or `Authorization: Bearer <api-key>`.
Typed on the Elysia side and consumed via **Eden** from the SPA, so a field
rename breaks the UI build.

```
POST   /api/v1/session                 login
DELETE /api/v1/session                 logout
GET    /api/v1/me

GET    /api/v1/applications?since=     list w/ sparkline aggregates
GET    /api/v1/applications/:id
GET    /api/v1/applications/:id/stats?from&to&interval
GET    /api/v1/applications/:id/operations?kind&from&to&sort
GET    /api/v1/applications/:id/executions?from&to&op&status&minDuration&cursor
GET    /api/v1/executions/:id          + spans (tree) + logs + error
GET    /api/v1/traces/:traceId         every execution across services

GET    /api/v1/applications/:id/errors?status&sort
GET    /api/v1/errors/:id              + occurrences series + releases + samples
PATCH  /api/v1/errors/:id              {status}

GET    /api/v1/applications/:id/logs?query&from&to&level&cursor
GET    /api/v1/applications/:id/jobs?queue&status
GET    /api/v1/applications/:id/runtime?metric&from&to&interval
GET    /api/v1/applications/:id/metrics
GET    /api/v1/applications/:id/metrics/:name/series?labels&from&to
GET    /api/v1/applications/:id/slos
GET    /api/v1/applications/:id/releases
GET    /api/v1/projects/:id/alerts,  /drop-filters, /credentials, /retention
GET    /api/v1/health                  liveness + ingest counters
```

Cross-cutting rules: `from`/`to` are epoch ms and mandatory on range endpoints;
`interval` is derived from the range unless given; every list is cursor
paginated (`cursor`,`limit ≤ 200`); every aggregate returns
`{series:[{t, v}], summary:{p50,p95,p99,count,errorRate}}` so charts and headers
share one payload.

Ingest API (separate surface, versioned independently — see §9):
`/applications/telemetry`, `/applications/profiles`, `/cli-link/*`. We keep the
hosted paths verbatim so an agent pointed at us needs no `path` rewrite, and we
additionally serve `/api/v1/ingest/telemetry` as a stable alias we control.

---

## 7. UI plan

Derived from the demo (`docs/spec/dashboard-features.md`) — same information
architecture, our own implementation.

```
/dashboard                 overview: traffic, errors, p95, slowest ops, recent errors
/dashboard/applications    service list
/dashboard/applications/:s overview | requests | traces | errors | logs | jobs
                           metrics | slos | releases | settings
/dashboard/errors          cross-service error inbox
/dashboard/traces          search
/dashboard/logs            explorer
/dashboard/alerts
/dashboard/link/:code      device-code approval page (what `npx @nestjs/observe link` opens)
/dashboard/settings        keys, retention, members, drop filters
```

Components we must build well, because they carry the product:

1. **Waterfall** — virtualised, `so`-positioned bars with overlap, collapse
   badge, click-to-zoom, self-time overlay, error tint.
2. **Time-series chart** — stacked/overlaid, brush-to-zoom that re-queries,
   p50/p95/p99 bands, deploy markers on the x-axis.
3. **Table** — server-side sort/filter, sticky header, column chooser, URL state.
4. **Trace-correlated log viewer** — highlight-by-`traceId`, inline expansion.

Stack: React + Vite + TypeScript, TanStack Query + Router, Tailwind, Recharts
(or uPlot for the waterfall-adjacent dense charts), Eden for the client. Built
into `apps/web/dist`, copied into the server's asset dir, embedded in the
compiled binary.

---

## 8. Milestones

| Milestone | Content | Exit criteria |
|---|---|---|
| **M0 — skeleton** | monorepo, Elysia ingest route accepting gzip batches, strict validation against `TELEMETRY_BATCH`, `{degraded:false}` reply, Postgres/Drizzle write of `execution`+`span`, `/health` | a real Nest app with the vendored SDK, `OBSERVE_ENDPOINT=http://localhost:4319`, produces rows we can `SELECT` |
| **M1 — v0.1 "useful"** | auth, applications, operations, executions, traces, errors (grouping + source context), API keys, `/cli-link` device flow, minimal UI (overview, trace waterfall, error list) | `npx @nestjs/observe link` works against us; demo-scale data navigable |
| **M2 — v0.2 "complete telemetry"** | logs, jobs, runtime metrics, custom metrics, releases, retention config, custom op IDs, Postgres adapter | parity with the hosted dashboard's daily-driver pages |
| **M3 — v0.3 "SLOs & alerts"** | objectives ingestion + budgets, alerts + channels, drop filters, multi-project/envs, MCP | `@Objective()` declarations round-trip; an alert fires on a planted error |
| **M4 — hardening** | rollups, load test (5k ev/s), backup/restore, upgrades N-2, SBOM, docs site | 24h soak, restore drill passes |

---

## 9. Compatibility policy (non-negotiable)

Three separate versions, bumped independently:

1. **App version** — SemVer, `0.y.z` until the dashboard is feature-complete.
2. **Ingest API version** — pinned to the SDK version range we implement
   (`@nestjs/observe >=0.3.17 <0.4.0`). Documented in `/health`, checked by a
   conformance test that validates our DTOs with the *vendored*
   `validateTelemetryPayload`.
3. **Schema version** — integer in `_migration`; the app refuses to start on a
   schema newer than it knows, and support for migrating from N-2.

Compatibility invariants: never 400 a batch the vendored contract accepts;
never return `degraded: true`; keep the four `/cli-link` + `/applications`
paths; treat unknown span tags as opaque. See
[`spec/release-pipeline.md`](spec/release-pipeline.md) §Versioning.

---

## 10. Packaging & release (summary)

**No npm package.** Two artifacts, both from GitHub Releases:

1. **Container image** — `ghcr.io/<org>/nestjs-observe:{vX.Y.Z, vX.Y, vX, latest, sha-<short>}`,
   `linux/amd64` + `linux/arm64`, distroless-ish runtime, SBOM + provenance.
2. **`tar.gz` per platform** — `nestjs-observe-vX.Y.Z-linux-x64.tar.gz` etc.,
   containing a `bun build --compile` binary + `LICENSE` + `README` +
   `docker-compose.yml` + `install.sh`, plus `SHA256SUMS` and `cosign`/gh
   attestations.

`repos/` is excluded from the Docker context (`.dockerignore`), from
`git archive` (`.gitattributes export-ignore`), and from the raw build dir by an
allowlist — with a CI assertion that fails the release if the SDK source or a
`.ts` file from `repos/` appears in any artifact.

Details, versioning rules, workflow YAML and the upgrade policy:
[`spec/release-pipeline.md`](spec/release-pipeline.md).

---

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| SDK wire format changes without a version bump | silent 400s, data loss | conformance test imports the vendored contract; CI fails when a subtree bump changes it |
| Hosted dashboard has features we cannot see (no public API) | parity gaps | REA-derived inventory, explicitly flagged `unknown`; ship on our own IA where unknown |
| Ingest write amplification at volume (80+ spans/request) | Postgres under pressure | bulk `values([...])` inserts, pre-aggregated rollups, per-app sampling as config, partition + `COPY` path in M1, load test in M4 |
| Span volume (80+ children/request) | storage blow-up | server-side `spanCollapse`-aware storage, per-app sampling as config, day partitions + rollups |
| Removal of quota logic surprises the agent | degraded handshake misread | always `degraded:false`; recorded in the conformance test |
| License/attribution | — | SDK is MIT: keep its copyright notice in `NOTICE`, never re-license SDK code |

---

## 12. Open questions

1. Multi-tenancy: single project per install (simple) vs many (matches hosted)?
   Proposal: schema supports many, UI defaults to one until M3.
2. Do we implement `errors-only`/`paced` at all? Proposal: no — but keep the
   *shape* behind a flag so a future "operator pause" feature can reuse it.
3. Auth default: local users only, or OIDC-first? Proposal: local first-run
   bootstrap, OIDC in M4.
4. Do we accept unauthenticated ingest by default? Proposal: yes when bound to
   localhost/private network and no credentials are configured, which is what
   the SDK's "collector of your own" path assumes.
5. Profiling (`repos/observe/src/profiling/`) is shelved in the SDK; we reserve
   the endpoint and table but do not build the flamegraph UI until the SDK
   un-shelves it.
