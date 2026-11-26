# Feature coverage

What the upstream product does, and what we have. This exists because "we read
the SDK" and "we covered the product" are different claims, and only the second
one is worth making.

**Snapshot:** 2025-10-25 23:00, taken by reading the code, not the docs. Much of
`public/` was being written while this was audited (`Overview`, `Application`,
`Operation`, `Executions` at 22:44; `JobDetail` at 22:54; `Jobs` and `Errors` at
22:55; `Trace` at 22:58), so **two rows below describe surfaces that appeared
mid-audit**: the job detail page and the trace page, both of which are graded
`Partial — No test` rather than on whether they exist. Every row names the file
it was verified against; where a line moved by a few lines since, the route path
is still the thing to search for.

The previous revision of this file was inflated: routes without a page were
marked Built, pages without tests were marked Built, and the whole of
"cross-service traces", "nested span tree" and `observe.collapsed` were claimed
on the strength of a column name. This revision grades the path a user actually
takes, and says which test proves it.

## How we know

| Evidence | What it gives | Where |
| --- | --- | --- |
| The code, read route by route | what exists: `src/server/app.ts` + `src/server/modules/*/index.ts`, `public/App.tsx` + `public/pages/*` | this repo |
| `test/` — **four files**, 1,361 lines | what is actually covered: `api.test.ts` (1,085), `wire-contract.test.ts` (121), `format.test.ts` (120), `sidebar-active.test.ts` (35) | `test/` |
| Vendored SDK source (`repos/observe`, 0.3.17, MIT) | the wire contract and, decisively, what the agent *cannot* send (job payloads, profiles, per-instance runtime) | `docs/spec/ingest-api.md` |
| `llms-full.txt` — the product's own machine-readable docs, 2,223 lines | the semantics: what queue wait means, when an error is "expected", what a burn rate is | `docs/upstream/observe-docs/` |
| Dashboard bundle inventory + 48 screenshots | every route, column and chart the hosted app has | `docs/spec/dashboard-features.md`, `dashboard-api.md`, `screenshots/` |

The demo is mocked (`demo-api.nestjs.local` + a service worker), so response
*values* are fake but *shapes and vocabulary* are real.

## Status key

- **Built** — a user can do it via our UI or API, and a test in `test/` exercises
  the path that does the work. The Notes name the test. A test of the API counts
  when the page is only a renderer of that payload; the Notes say so.
- **Partial** — the path works but the surface is thin, *or* it works and nothing
  tests it. The note starts with `Thin —` (a drill-down or control is missing) or
  `No test —` (the path exists, coverage is zero).
- **Spec'd** — designed in `docs/`, no code.
- **Missing** — upstream has it, we have nothing (or a table with no reader).
- **Removed** — deliberately out of scope: pricing, billing, plans, quotas,
  seats, metering, teams, MCP. `AGENTS.md` forbids adding these; they are never
  proposed below as work.

Every `Partial` in this document is a real path. "Partial because untested" is
not the same as "half-built" — the Score separates the two.

---

## Collector and the wire

| Upstream capability | Status | Notes |
| --- | --- | --- |
| gzip `POST /applications/telemetry` at the SDK's own paths | **Built** | `ingest/index.ts:73`; `api.test.ts › "accepts a realistic gzipped batch…"` |
| Strict batch validation, `400` with dotted paths (the agent's self-repair trigger) | **Built** | `ingest/index.ts` + `src/wire.ts`; `api.test.ts › "refuses a batch that violates the contract…"`, `"…unknown keys…"`, `"…cannot gunzip…"` (415 test too) |
| `{"degraded": false}` forever — no billing handshake | **Built** | `ingest/model.ts` `ACCEPTED`; asserted by the same accept test; `PLAN.md` §2 |
| Our port equals the vendored contract | **Built** | `test/conformance/wire-contract.test.ts` (all 6 tests, incl. the `MAX_BATCH_ITEMS` and `st`-rejection cases) |
| Ingest credentials: `x-api-key`/`x-api-secret`, anonymous mode, 401, last-used stamp | **Built** | `ingest/service.ts:134-160`; `api.test.ts › "rejects unknown credentials…"`, `"does not require a session for ingest"` |
| `POST /applications/profiles` (profiles) | **Partial** | Thin — registers and answers `ACCEPTED`, stores nothing (`ingest/index.ts:152`); SDK 0.3.17 never calls it. No test |
| `POST /cli-link/{sessions,token}` + approval | **Built** | `link/index.ts`, `link/approval.ts`; `api.test.ts` `describe("cli link")` |

---

## Access, identity, tenancy

| Upstream capability | Status | Notes |
| --- | --- | --- |
| First-run admin bootstrap (`/setup` self-locks after) | **Built** | `auth/index.ts:76`; `api.test.ts › "refuses a second setup…"`, `"reports setup as done…"`; `OBSERVE_ADMIN_EMAIL` path in `auth/service.ts` |
| Email + password sign-in, argon2id, email enumeration not distinguishable | **Built** | `auth/index.ts:112`; `api.test.ts › "rejects a wrong password…"`, `"refuses a quoted-length password…"` |
| Session cookie lifecycle, revocation, "log out everywhere" | **Partial** | No test — `POST /auth/logout` (`auth/index.ts:125`) deletes the session row; no revocation UI, no coverage |
| Invitations: single-use, 7 days, role bound server-side | **Built** | `admin/index.ts:104`; `api.test.ts › "issues an invite whose role is bound server-side…"` |
| Instance roles **read / write / admin** | **Partial** | Thin — `plugins/auth.ts:35-50` has only `requireUser`/`requireAdmin`; a `read` user can `PATCH /errors/:id` and `POST /slos` (`errors/index.ts:60`, `analytics/index.ts:278`). Test only asserts the admin gate (`"forbids the query API to a read-only user"` — whose body checks `/admin/users`, not a write) |
| Project members with Read/Write/Admin access | **Missing** | `projectMember` (`schema.ts:153`) is declared and **never read** by any query |
| Teams (collection of users) | **Removed** | `PLAN.md` §3.2; not a capability of a single-tenant install |
| Project ↔ team ownership | **Removed** | follows from the above |
| Multiple projects: create, rename, archive, switch | **Spec'd** | One project per install by design; the scoping plan (URL/API shape, switcher slot, migration of every query, member enforcement, trigger to build) is `PLAN.md` §7.1. `project`/`project_member` exist and every scoped table carries `project_id` |
| Project settings page | **Partial** | `/settings` is instance-level (registration, name, retention, env-only values) because there is one project; per-project settings land with `PLAN.md` §7.1 |
| Application tags (≤3 labels, attachable) | **Missing** | `application` has no tags column (`schema.ts:169-186`) |
| Environments as a dimension | **Missing** | upstream expresses env via tags + `serviceVersion`; we have neither a tag UI nor an env filter |
| 2FA (TOTP) | **Missing** | no `tfa` column, no enrolment flow |
| SSO / OIDC per verified domain | **Spec'd** | `docs/SELF-HOSTED.md:22,121` (issuer, client id/secret, allowed domains, auto-provision) |
| Notification inbox + unread badge | **Missing** | no table, no route; `notifications` is an upstream route only |
| Weekly digest / new-error emails | **Missing** | no SMTP client anywhere in `src/` |
| Password reset by email, email verification | **Missing** | CLI reset only (`cli.ts`); the login page tells the user to ask an admin (`public/pages/Auth.tsx:144`) |
| Audit log | **Partial** | Written by setup/login/invite/role/settings/key actions and read at `admin/index.ts:157`; rendered at the bottom of `/settings` (last 50). Still no dedicated page or filter, and no test asserts a row is written |
| Admin CLI (`info`, `create-user`, `reset-password`, `list-users`, `invite`, `set-setting`, `migrate`, `prune`) | **Partial** | No test — `src/server/cli.ts`; used in `README`/`GETTING-STARTED` |
| API-key management: list, create, revoke, rotate, secret shown once | **Built** | `modules/admin/credentials.ts` (`GET/POST /admin/credentials`, `DELETE /admin/credentials/:id`); revoke keeps the row so a replay gets 401 instead of falling through to anonymous ingest; the secret is returned exactly once. `api.test.ts › "mints a pair that ingest accepts, and revokes it stops ingest"` + `"keeps credentials away from a non-admin"`. Page: `/api-keys` |
| `npx @nestjs/observe link` end to end, reply carries the identity the CLI prints | **Built** | `api.test.ts › "answers the identity the CLI prints, at a path-style verification URI"` |
| `serviceIdFor` slug identity (`@acme/Orders` → `orders`) | **Built** | `ingest/service.ts` port; `api.test.ts › "stores the SDK's slug…"` |
| Re-linking an app or a teammate linking it | **Built** | `api.test.ts › "re-linking the same app gets a new key for the same application"` |
| Instance settings (registration mode, instance name, public URL, anonymous ingest) | **Built** | `GET/PATCH /admin/settings`; editable vs environment-only is separated on `/settings`, and the audit trail is on the same page. `api.test.ts › "round-trips numbers, booleans and strings through the jsonb column"` — numbers and booleans used to 500 (jsonb binds scalars as SQL scalars), `Auth.setSetting` now serialises and casts |
| Billing / plans / seats / spend caps / cost attribution | **Removed** | `PLAN.md` §3.2 |

---

## Telemetry and dashboard

### Requests, traces and spans

| Upstream capability | Status | Notes |
| --- | --- | --- |
| Applications list with window aggregates (requests, error rate, p95, last seen) | **Built** | `applications/index.ts:21`; `api.test.ts › "round-trips an ingested batch…"` (asserts jobs excluded from the request count); `public/pages/Applications.tsx` |
| Project/application overview: traffic, duration, error, jobs, last release cards | **Partial** | No test — `public/pages/Overview.tsx` assembles five tested endpoints; nothing exercises the page |
| Overview extras: performance outliers, "where the time goes" by class, open-issues card, API-key CTA | **Missing** | none of the four has data or a component |
| Previous-period comparison (ghost series, `−18% since last period`) | **Partial** | No test — deltas are computed client-side by `deltaRatio` (`public/format.ts`); no ghost series, no test |
| Requests analytics by operation: avg, p95, failure rate, count, kind filter | **Built** | `applications/index.ts:30` + `/timeseries`; `api.test.ts › "ranks operations by volume"`, `"…kind=job…"` |
| Operation detail: series, slowest instances, error groups | **Partial** | No test — `analytics/index.ts:325` (`/operations/:operationRowId`, now kind-aware incl. job operations); `public/pages/Operation.tsx` |
| Traffic heatmap (7-day × hour, host-pressure overlay) | **Missing** | no component, no endpoint |
| Duration distribution / ranked ranges | **Missing** | upstream draws percentile chips from a distribution endpoint we do not have |
| "Is this call actually slow?" baseline verdict | **Missing** | needs a per-operation baseline query; nothing computes it |
| Execution list: keyset cursor, kind filter, operation filter | **Built** | `executions/index.ts:17`; `api.test.ts › "round-trips…"` (asserts `nextCursor`) |
| Execution detail: span tree, correlated logs, error card | **Built** | `executions/index.ts:43`; `api.test.ts › "round-trips…"` asserts `spans`/`logs`; `public/pages/Executions.tsx` |
| Waterfall geometry: overlap from `startOffsetMs`, min bar width, empty trace | **Built** | `layoutWaterfall` (`public/format.ts:142`); `test/web/format.test.ts` (4 tests) |
| Self time: direct children only, never negative | **Built** | `selfTimeMs` (`public/format.ts:210`); `test/web/format.test.ts` (2 tests) |
| Class/method attribution per span | **Partial** | No test — stored (`span.class_name`/`method`, `schema.ts:396-397`) and rendered (`Executions.tsx` span row + detail); no test touches it |
| Span tree order: depth, sibling `seq`, orphan handling | **Partial** | Thin — `orderTree` is a local helper in `Executions.tsx` (rebuilt in the browser); untested, and there is no server-side ordering guarantee |
| Spans table under the waterfall: `Name / Self % / Self / Total`, sorted by self | **Missing** | we show self time only inside one span's expandable row; the ranked table is what makes a trace answerable (`llms-full.txt:1270-1280`) |
| `observe.collapsed` ×N nodes | **Partial** | No test — read at ingest (`ingest/service.ts:372-386`), stored as `collapsed_count`, rendered as a `×N` badge (`Executions.tsx`, `Waterfall.tsx:168`); zero coverage |
| Waterfall extras: `FLAME` / `GAPS` / `CRITICAL PATH` / `REPLAY`, per-span `N LOGS`, query/URL rows | **Missing** | none implemented |
| Cross-service trace continuation (`x-request-id`) and a trace page | **Built** | `api.test.ts › "returns every service that shared a trace id…"` covers the payload the page renders: two applications, one trace, named hops with their spans, correlated logs, causal order. UI is `/traces/:traceId` (`public/pages/Trace.tsx`): service chips, a hops table with per-hop bars, one waterfall per hop, logs grouped by application. The page itself has no DOM test |
| Project-wide scope: every list aggregates across applications, with the application as an optional filter ("All applications") | **Built** | Every read is `/api/v1/telemetry/…?applicationId=` with the parameter optional (`modules/telemetry/index.ts`), rows carry `applicationName`, and job/error/log/metric/release/SLO/user lists are the same payload scoped or unscoped. Tests: `api.test.ts › "aggregates every list across applications…"` and `› "counts a job as a job…"`. UI: `/requests`, `/jobs`, `/errors`, `/logs`, `/users`, `/metrics`, `/releases`, `/slos`, `/executions`, with the old `/applications/:id/*` URLs redirecting to `?app=`. Runtime stays per-application on purpose (per-process facts) |
| Trace ↔ execution navigation, "Open full trace", anchor links | **Partial** | No test — execution/error/job-run rows link to `/traces/:traceId?range=` (`Executions.tsx:355`, `Errors.tsx:682`, `JobDetail.tsx:619`) and the trace page copies its id (`Trace.tsx:783-800`); no per-span anchor (`#execution-<spanId>`), no back-link from the trace page to the hop it came from |

### Errors and logs

| Upstream capability | Status | Notes |
| --- | --- | --- |
| Error grouping by fingerprint, occurrences, first/last seen | **Built** | `errors/index.ts:22`; `api.test.ts › "keeps one error group across a replayed batch…"`; fingerprinting in `ingest/fingerprint.ts` |
| Error source frames (`e.codeFrames`) stored and rendered | **Built** | `api.test.ts › "stores the agent's code frames…"`; `schema.ts:433`; `public/pages/Errors.tsx` drawer. SDK 0.3.17 reads source with `realpathSync`/`readFileSync` and requires the frame to resolve inside the process cwd (`repos/observe/src/utils/source-context.util.ts:226-246`), so `file://` frames and frames outside cwd silently produce none — upstream limitation |
| Source renderer: in-app vs dependency frames, throwing line marked, collapsed groups | **Partial** | Thin — frames are rendered as received (`Errors.tsx:329-385`); no app/dependency split, no "thrown at" marker, no collapse counts |
| Error status: open / resolved / ignored / **expected** | **Partial** | Thin — three of four states (`schema.ts:308` enum); `expected` is absent, and `PATCH /errors/:id` has no test |
| Error trend chart, `Unhandled` vs `Intrinsic` split | **Missing** | no series endpoint for a group, no intrinsic-error concept |
| Error filters (project-level ignore/hide rules) | **Missing** | no table; upstream has `/error-filters` |
| Affected users per error group | **Missing** | `error_occurrence` has no `user_id`; it would need the join to `execution.user_id` and a query |
| Logs list with level filter | **Partial** | No test — `logs/index.ts:21`; the Logs view lives in `public/pages/Errors.tsx:487+`; endpoint untested |
| Log search (substring, level/context scoped) | **Partial** | Thin — client-side substring over the loaded page only (`Errors.tsx:512`); no index, no cursor, no paging, no saved searches |
| Live tail (SSE) with reconnect/backfill states | **Missing** | nothing streams; every page polls |
| Log ↔ trace correlation (log→trace, trace→logs, span scope) | **Partial** | Thin — the execution page renders the trace's logs and the API filters by `traceId` (`logs/index.ts`); the logs page shows no trace link and there is no span-scoped log slice |

### Jobs

| Upstream capability | Status | Notes |
| --- | --- | --- |
| Jobs list grouped by queue + name: runs, failures, failure rate, avg, p95 wait, retries, last run | **Partial** | No test — `analytics/index.ts:127` (`/jobs`) and `public/pages/Jobs.tsx`; endpoint and page both uncovered |
| Job detail: duration avg/p95, wait p95/avg/max, invocations, failed, failure rate, last call, series, queue-wait series, recent runs | **Built** | `api.test.ts › "serves one job's throughput, queue wait and runs"` (runs, failures, p95 **queue wait**, the rollup series and the run-derived wait series, the 404 rule). Page: `/applications/:id/jobs/:queue/:name` (`public/pages/JobDetail.tsx`); per-run failure payloads are stored by `writeJob` (`ingest/service.ts`). Still missing vs the reference: `jobId`, BullMQ `failedReason` (not on the wire), previous-period deltas, page numbers |
| Job run detail: `jobId`, `failedReason`, attempts, enqueuedAt, tags, waterfall | **Partial** | Thin — the run's own error payload is now stored (`jobErrorPayload`, `ingest/service.ts:706-716`) and rendered in the runs table (`JobDetail.tsx:653+`); but `jobId` (`i`) is persisted nowhere, and BullMQ's `failedReason` is **not on the wire**. The waterfall is the execution page (`/executions/:id`) |
| `@nestjs/schedule` cron/interval jobs | **Partial** | No test — same `kind: 'job'` path (`ingest/service.ts:196-201` → `writeJob`); no test ingests a cron-shaped batch, and the UI does not distinguish cron from queue work |

### Runtime, custom metrics, releases, users, services

| Upstream capability | Status | Notes |
| --- | --- | --- |
| Runtime charts: CPU, memory, event loop delay, GC count/duration | **Partial** | No test — `analytics/index.ts:211` (`/runtime`, `analytics.service.ts:240`), `public/pages/Runtime.tsx`; four charts, no utilization %, no spike click-through |
| Per-instance (service node) selection and comparison | **Missing** | the wire carries no instance id (`RUNTIME_METRICS` = `c/m/g/e` only, `telemetry-wire-contract.ts:177-210`) and `runtime_sample` has no column for one (`schema.ts:467-486`); upstream's `serviceNode` exists only in the shelved profiler uploader |
| Profiler: CPU flamegraph, function list, coverage, snapshots | **Missing** | **blocked upstream** — `ObserveOptions.profiling` is commented out in 0.3.17 and no profile can arrive; we reserve the endpoint (`ingest/index.ts:152`) and version the table. Not our work to unblock |
| Custom metrics: counter / gauge (`additive\|ratio\|peak`) / summary, labelled series | **Built** | `api.test.ts › "stores custom metric label dimensions and summary statistics"`; `metrics`/`metricPoints` in `analytics.service.ts`; `public/pages/Metrics.tsx` |
| Custom metric detail: value vs increase over time, min/avg/max per bucket, lifetime total, retention floor | **Partial** | Thin — one page with a series picker, quantile lines for summaries, no route per metric, no bucket min/avg/max, no lifetime total (`Metrics.tsx`) |
| "Under host pressure" card on an operation | **Missing** | needs the event-loop/CPU quartile split; nothing computes it |
| Releases: version timeline, per-release error rate/p95, regression verdict | **Partial** | No test — `analytics/index.ts:229` (`/releases`, `analytics.service.ts:275`); `Releases.tsx` verdict (error rate +1 pt, p95 +20%); endpoint uncovered |
| Release impact: before → after per operation, affected-error attribution | **Missing** | the reference's `regressions/changes` shape; we only have a per-release verdict |
| Deploy markers on charts | **Missing** | no marker data in any series response |
| Users overview: requests, error rate, avg, last seen | **Partial** | No test — `analytics/index.ts:246` (`/users`), `Users.tsx`; endpoint and page uncovered |
| Customer accounts (users grouped by domain) | **Partial** | Thin — client-side email-domain heuristic (`Users.tsx`), not an upstream tenant grouping; untested |
| User detail: actions grouped in time, replay, endpoint paths | **Missing** | no route, no endpoint |
| Services: per-class own vs total time, method expansion | **Built** | `spans.service.ts › services` (`GET /telemetry/services`), own time = span duration minus direct children; `api.test.ts › "derives services, the service map and span analytics…"` asserts own ≤ total and the method breakdown. Page: `/services` |
| Service map (clients → apps → queues/DB, inferred from trace ids) | **Partial** | `GET /telemetry/map` + `/map` page: nodes are applications, edges are trace continuations in causal order (one `lag()` pass). Tested for two apps in one trace. Thin: no queue/DB nodes, no per-edge latency |
| Spans explorer: custom-span analytics by span name | **Built** | `GET /telemetry/spans?mode=manual|all` (`spans.service.ts › spanAnalytics`) + `/spans` page: invocations, failures, avg/p95, per-bucket series, p95-vs-invocations scatter. Tested (`api.test.ts`, the span-derived test) |
| Custom operation IDs (`a.dop` / `TracerService.setOperationId`) | **Partial** | No test — read at ingest (`ingest/service.ts:648`) and kept as `operation.customName`; untested, and the UI shows it only on the application page |
| Custom operation-ID cap (100 live names / 30 days) | **Missing** | cardinality guard, not billing — no dedupe or cap anywhere |
| Request capture: headers/body for failed or slow requests | **Partial** | Thin — stored from `snapshot.rq` (`ingest/service.ts:668`) and returned on the execution; **no UI renders it**, no test |
| Retention per data class, enforced by a scheduled job | **Partial** | Thin — one `retention.traces` setting plus `admin prune` (`cli.ts:265`); `retention_policy` (`schema.ts:720`) is unused; no scheduler, no per-class config |
| Sampling (server-side, per application) | **Missing** | not designed in `docs/` either; only a risk row in `PLAN.md` §11 |
| Drop filters (server-side discard at ingest) | **Spec'd** | `drop_filter` table + model (`schema.ts:642`, `models.ts`), never read; `PLAN.md` F12 |
| Self-observability: versions, DB liveness, ingest counters | **Built** | `health/index.ts:23`; `api.test.ts › "reports health with the three versions"` |
| Ingest lag, drops, 400-repair rate, storage size, query latency | **Missing** | `/health` exposes batch counters only (`plugins/telemetry-state.ts`) |

---

## Alerts — 8 metric families, two detection modes

Status: **not built.** `alert_rule`/`alert_event` exist (`schema.ts:607,626`) and
are exported as models, and both are now read and written by
`src/server/modules/alerts/`.

Status: **the evaluator and the rule lifecycle are built and tested; the page is
new.** This is the only feature in the collector with a clock — alerts have to
fire while nobody is looking — so `index.ts` runs `evaluateRules` on an interval
(default 60 s, `OBSERVE_ALERTS=off` disables it) and
`POST /api/v1/alerts/evaluate` runs the same function on demand. Tests:
`api.test.ts › describe("alerts")`, seven of them.

| Upstream capability | Status | Notes |
| --- | --- | --- |
| Rule CRUD, enable/pause, per-project scoping | **Built** | `/api/v1/alerts/rules` (`alerts/index.ts`); pause keeps history; two default rules seeded at boot (`service.ts › seedDefaultRules`) |
| Request metrics: error rate, p95, avg, throughput | **Built** | `measure()` over `rollup_minute`; p95 merges the histograms (a real percentile, not an average of p95s) |
| Job metrics: failure rate, throughput, p95 queue wait | **Built** | over `execution` where `kind='job'`; queue can be scoped by `queueName` |
| Absence: telemetry silence, job silence | **Built** | minutes since the last run; a scope that **never** reported returns `null`, so a new service does not page anyone (`no-data` is not `0`) |
| Logs: substring pattern (≥3 chars, level/context scoped) | **Built** | `log.pattern` + `logLevels`; a shorter pattern is refused because it would match everything |
| Errors: new fingerprints only, unhandled only | **Partial** | `error.new` is exact; "unhandled only" is every occurrence, because the `expected` state is still absent |
| Runtime: event loop delay, CPU, memory | **Built** | `runtime.event_loop`, `runtime.cpu`, `runtime.memory` |
| Custom metric rules | **Built** | `custom.metric` + `customMetricName`, averaged over the window |
| SLO burn-rate rules | **Built** | `slo.burn` + `sloId`; the rule's window picks the nearest burn window (1h/6h/24h/3d) |
| Fixed threshold **and** anomaly detection (σ) | **Built** | `detection: "threshold" \| "anomaly"`; anomaly compares with the mean of the previous six windows and refuses to fire with fewer than two (`insufficient baseline`) |
| Evaluation windows 5/10/15/30/60/180 min, severity Low→Critical | **Built** | `windowS` is validated against exactly those six values; `severity` is low/medium/high/critical |
| Channels: in-app, email, webhook, Slack, create-issue | **Partial** | in-app (the event) and webhook/Slack (JSON POST, 5 s timeout, result recorded per channel) are real. **Email is not delivered** — there is no SMTP client, so the delivery record says "skipped: no SMTP client". `create-issue` depends on issues |
| Quiet hours: recurring, timezone-aware, "muted ≠ OK" | **Built** | `quietHours {start,end,timezone}` incl. windows that wrap midnight, plus a manual mute; a muted firing is still recorded (`muted: true`) and the incident stays open |
| History: OK → Firing → Resolved, per-channel delivery status, samples | **Built** | one `alert_event` row per transition with the value, `payload.delivery[]`, `payload.samples` |
| Built-in "new error" digest, throttled per project | **Missing** | not implemented; a rule on `error.new` covers the same need today |

---

## SLOs

Status: the evaluation half is **done and tested**; the presentation half is one
page and no detail view. "Budget" here is reliability, not billing: `1 - target`
of the window's events may fail. Upstream sells SLOs on Scale/Enterprise; that
gate is commercial, so a self-hosted install gets them ungated — no plan, seat,
quota or usage check stands between an `@Objective()` and this page.

| Upstream capability | Status | Notes |
| --- | --- | --- |
| SLI kinds: availability, latency-under-threshold, job success | **Built** | `api.test.ts › "spends the error budget…"`, `"measures latency as the fraction of requests under the threshold"`, `"supports a dashboard-created job-success SLO…"` |
| Objectives 99…99.99, windows 7/14/28/30 days | **Built** | `SloBody` (`analytics/index.ts`); same tests |
| Error budget remaining | **Built** | `api.test.ts › "spends the error budget and breaches…"` (allowed bad, remaining, over-budget) |
| Burn rates 1 h / 6 h / 24 h / 3 d | **Built** | `SLO_BURN_WINDOWS` (`analytics.service.ts:620`); the same test asserts 100× and 5× exactly |
| "No traffic isn't failure" | **Built** | `api.test.ts › "reads a window with no traffic as no-data…"` |
| Retention is the ceiling on the achievable window (clip + flag) | **Built** | `api.test.ts › "clips a compliance window to the retention ceiling"` |
| Declared in code is owned by code (dashboard cannot overwrite or delete) | **Built** | `api.test.ts › "refuses to let the dashboard overwrite or delete a code objective"` |
| `@Objective()` ingestion, upsert on deploy, restated hourly | **Partial** | Thin — ingested and upserted (`ingest/service.ts:235-237, 896-966`), conformance caps 100 declarations; there is **no hourly restatement job** and no test of the ingest side |
| SLO page: list with SLI sentence, budget, 1 h burn, health state, retention clip chip | **Partial** | No test — `public/pages/Slos.tsx` renders all of it from the tested payload |
| SLO detail: error-budget ring, burn chart against paging thresholds, linked alerts | **Missing** | no `/slos/:sloId` route; burn is a number in the list row, not a chart |
| Burn-rate alert policies (fast 14.4×, slow 6×, trickle 1×) | **Missing** | rides on the alert evaluator |

---

## Issues — the work tracker over telemetry

Status: **Missing entirely, and not designed.** No `issue` table, no route, no
component; the sidebar has no Issues entry. This is the hosted app's largest nav
section and the one surface where "missing" is not a drill-down.

| Upstream capability | Status | Notes |
| --- | --- | --- |
| States: open, in-progress, blocked, on-hold, review, verifying, resolved, closed | **Missing** | |
| Severity, assignee, due date, attachments, issue key (`WHI-100`) | **Missing** | |
| Comments (delete own, admin deletes any) | **Missing** | |
| Links to traces / error groups / alerts; incident block | **Missing** | |
| Fix verification (per-metric checks, `Verifying` / `Confirmed` / `No verdict`) | **Missing** | |
| Auto-create from an alert ("create issue" channel) | **Missing** | depends on alerts |

---

## MCP server

| Upstream capability | Status | Notes |
| --- | --- | --- |
| MCP server + tool surface | **Removed** | out of scope by decision: the dashboard and the JSON API are the interface, and a second protocol is a second auth model (`PLAN.md` §3.2) |
| Personal MCP tokens (`omcp_…`) | **Removed** | follows from the above |

---

## Shell and cross-cutting mechanics

| Upstream capability | Status | Notes |
| --- | --- | --- |
| App shell: sidebar + icon rail, application switcher, page headers, empty/loading/error states | **Partial** | No test — `public/App.tsx`, `components/shell/*`; only the active-row helper is tested (`test/web/sidebar-active.test.ts`) |
| Time-range chips (1 h → 30 d) in the URL | **Partial** | No test — `RangePicker` + `?range=` (`ShellContext.tsx`, `format.ts`); `windowFor` is tested, the control is not |
| `LIVE` polling toggle (10 s) | **Partial** | No test — `LiveToggle.tsx` + `useLiveInterval`; nothing asserts it stops polling |
| Global search | **Partial** | Thin — the field writes `?search=` (`TopBar.tsx`, `ShellContext.tsx:65`); **no page reads it** (grep), so it filters nothing |
| Table mechanics: server sort, numeric/column filters, bulk select, column chooser | **Missing** | pages sort/render client-side where at all |
| Copy affordances: trace id, agent prompt, install snippet | **Partial** | Thin — a copy-trace-id button exists on the trace page (`Trace.tsx:783-800`, the only `navigator.clipboard` use in `public/`); no copy agent prompt, no install snippet |
| In-app documentation (`/documentation/*`) | **Missing** | docs live in `docs/` and `docs/upstream/` |

---

## Known stale

Places where `docs/` no longer matches the code. Nothing here is edited by this
audit (owned elsewhere), but a reader of those files will be misled:

- **`docs/HOSTED-VS-SELF-HOSTED.md` §Feature parity** says "74 upstream
  capabilities", "source frames: stored, not yet rendered", "endpoints done, UI
  pending" for jobs/runtime/releases/users and "Time-series charts in the UI:
  pending — the SPA does not draw them". All five are wrong now: the pages exist,
  the source frames render in the error drawer, and the count in this file is
  larger and graded differently.
- **`PLAN.md` §5** describes `job_run` as its own table with `error_id`; the code
  stores jobs in `execution` (`kind='job'`) with the job columns inline
  (`schema.ts:357-364`). There is no `job_run` table.
- **`PLAN.md` §8 (M3)** says "the SLO half of M3 is done … what remains is the
  alert evaluator" — still accurate — but the milestone table itself is now
  interleaved with a prose paragraph inside the markdown table (a formatting
  break at the `| **M4` row).
- **`PLAN.md` §7** (`apps/web`, Vite, TanStack Router, Tailwind, Eden) does not
  describe the shipped SPA: `public/` is Bun's fullstack entry, `App.tsx` uses
  `react-router-dom`, and most pages are MUI. The Eden client claim in
  `src/server/app.ts` (`ApiApp`) is real; the build is not Vite.
- **`docs/spec/dashboard-api.md`** documents the *hosted* API; it is a reference,
  not ours. Our paths are `/api/v1/*` and diverge by design. Fine, but the
  `jobs/details` → `queue`+`name` mapping in it is what the new `/job` endpoint
  implements via query string, not path.
- **`docs/spec/dashboard-features.md` §8** lists `jobId` and `failedReason` as run
  fields. The 0.3.17 wire has no `failedReason`, and our ingest does not persist
  `i` (job id) or the `e` payload — do not build a column for either without
  fixing ingest first.
- The **`expected`** error state appears in `docs/spec/dashboard-features.md:265`;
  the code has three states only (`schema.ts:308`).

---

## Things the docs settled that we had guessed

| Question | Answer |
| --- | --- |
| Is `degraded` the only quota signal? | Yes, and it is entirely billing. We answer `false` forever — confirmed. |
| Do API keys identify an application or a project? | **A project.** `app_credential.project_id` (`schema.ts:188`) is already right; the application is resolved per batch from `serviceId`. |
| Source frames: `sourceContext` or `codeFrames`? | `codeFrames` on the error object; `sourceContext` is only the SDK option name. |
| Roles? | Read / Write / Admin, with "creator only" as a rule, not a role. **Our enum matches; our enforcement does not** (only admin is checked). |
| Alert evaluation windows? | 5/10/15/30/60/180 min; silence rules use a tolerance instead. |
| Are job failures error groups? | **No.** "A failed job doesn't open an error group." Our ingest honours that — and, as a side effect, loses the failure payload (see Jobs). |
| Is a trace its own page upstream? | **No.** Traces are reached from a request or an error; there is no standalone traces list. Our `/traces/:traceId` endpoint is the port; the page is ours to design. |
| Does the SDK send the job id / failure reason / profile? | Job id yes (`i`), failure reason no, profile no. See §2 of the job-detail reference. |

---

## So what is actually left?

The rows above are not a pricing table. **Nothing under Missing is a premium
feature** — the hosted product sells the same dashboard we are building, and the
only rows removed on purpose are the five billing/tenancy/MCP ones. "Missing"
means "upstream has it and we have not written it yet".

| Block | Shape of the gap |
| --- | --- |
| **Alerts** (14 rows) | the whole evaluator plus its channels and history; the tables are already there, empty |
| **Issues** (6 rows) | nothing exists at all, including the schema |
| **Decision-layer leftovers** | SLO detail view and burn-rate policies, error trend/intrinsic split, error filters |
| **Investigation drill-downs** | spans table by self time, user timeline, release impact per operation — and the two pages that landed mid-audit (trace, job detail) are untested |
| **Attribution** | services (class own/total time), service map, spans explorer — all three need new aggregates, not new pages |
| **Access gaps** | project members/ACL, application tags, 2FA, SSO, inbox, password reset by email, API-key management |
| **Untested paths** | 23 of the Partials are working code with zero coverage: trace, job detail, jobs, logs, runtime, releases, users, operation detail, the SLO page, shell controls, audit log, CLI |

Two rows are not implementation work at all: **profiler** is blocked upstream (no
profile can arrive from SDK 0.3.17), and **sampling** is neither built nor
specified. **Drop filters** and **SSO** are specified only.

Suggested order, matching `PLAN.md` §8: finish the surfaces that already have
data and no page (trace, job detail, spans-by-self-time), then the telemetry
tests that would make this document shorter, then M3 — alerts and issues. Issues
depends on alerts for its auto-create channel; alerts depends on nothing but the
`alert_rule`/`alert_event` tables that already exist.

---

## Score

Counted from the rows above (see the per-section table for the arithmetic).
`Partial` is split, because the two halves mean different work:

| Built | Partial (thin) | Partial (untested) | Spec'd | Missing | Removed |
| --- | --- | --- | --- | --- | --- |
| 47 | 19 | 20 | 3 | 38 | 5 |

| Section | Rows | Built | Partial (thin) | Partial (no test) | Spec'd | Missing | Removed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Collector and the wire | 7 | 6 | 1 | 0 | 0 | 0 | 0 |
| Access, identity, tenancy | 25 | 8 | 3 | 3 | 2 | 6 | 3 |
| — Requests, traces, spans | 21 | 8 | 1 | 6 | 0 | 6 | 0 |
| — Errors and logs | 11 | 2 | 4 | 1 | 0 | 4 | 0 |
| — Jobs | 4 | 1 | 1 | 2 | 0 | 0 | 0 |
| — Runtime, custom, releases, users, services | 23 | 4 | 5 | 4 | 1 | 9 | 0 |
| Alerts | 15 | 11 | 2 | 0 | 0 | 2 | 0 |
| SLOs | 11 | 7 | 1 | 1 | 0 | 2 | 0 |
| Issues | 6 | 0 | 0 | 0 | 0 | 6 | 0 |
| MCP | 2 | 0 | 0 | 0 | 0 | 0 | 2 |
| Shell and cross-cutting | 7 | 0 | 2 | 3 | 0 | 2 | 0 |
| **Total** | **132** | **47** | **19** | **20** | **3** | **38** | **5** |

One reading: **the collector, the telemetry read path and the alerting
evaluator are real; issues are the last untouched decision layer.** 66
capabilities work (47 Built + 19 Partial with the feature present but thin),
against 38 missing — and the missing ones are
concentrated in two blocks that were never started (alerts 15, issues 6), one
upstream-blocked area (profiler), and the attribution views that need new
aggregates rather than new pages. The largest single remaining block is
**Alerts (15 rows)**, then the **access gaps (9 missing + 2 thin)**, then
**Services / Map / Spans attribution (3 rows, each a new aggregate)**.

The number that should worry a maintainer more than "56 missing" is **23 working
paths with no test at all** — 18 of them UI surfaces: ten whole pages (overview,
operation, trace, logs, jobs list, job detail, runtime, releases, users, SLOs),
four shell/navigation controls, and four chart or row behaviours a user reads as
fact. Four test files for ~12,000 lines of SPA is the real coverage story; this
document is gradeable at all only because the API suite is honest about the
queries it does cover.
