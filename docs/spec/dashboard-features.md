# Hosted dashboard — feature & UI/UX inventory

Target: **`https://www.observe-demo.nestjs.com/dashboard`** (the public demo of the
hosted product). Derived by reverse-engineering the shipped SPA, not from
documentation prose. Goal: a feature-parity self-hosted clone **minus pricing**.

## Evidence and confidence

| Source | Used for | Where |
| --- | --- | --- |
| SPA bundle, 334 unique chunks (2 builds), incl. the MSW mock registry `start-*.js` | route table, component names, copy, enums, REST surface | `/tmp/obs/assets/` (scratch) |
| Headless-Chromium CDP crawl, ~110 page loads | rendered labels, columns, screenshots, network | `/tmp/obs/cap-{demo,proj,detail,trace}/` (scratch) |
| Rendered `/documentation/*` pages captured as text | semantics, defaults, formulas | `/tmp/obs/deep/text-documentation_*.txt` |
| `repos/observe/README.md` + `repos/observe/src/**` | SDK-side promises (what the server can receive) | this repo |

**The demo has no public backend.** `API_URL = https://demo-api.nestjs.local` is
served entirely by a **Mock Service Worker** inside the page (`/__demo/ready`,
`localStorage.accessToken = "demo-access-token"`, `DEMO_MODE: true`). Consequence:

- UI, routes, columns, filters, copy and endpoint/query shapes are **real**.
- Numbers, ids, dates and entity names are **generated demo data**; do not treat
  them as product constraints.
- Anything the demo's dataset does not exercise is marked **unknown / not observable**.

Confidence tags used below: **[T]** traffic/DOM observed · **[B]** bundle only ·
**[U]** unknown.

---

## 1. Layout shell

| Region | Content | Conf |
| --- | --- | --- |
| Left sidebar (fixed, dark, collapsible) | two modes: **global** and **project** (see below); labels are uppercase mono, 12 px; icons per item; count badges (issues `14`, alerts `1`, notifications `5`) | T |
| Global sidebar | `DASHBOARD` (→ `/dashboard`, "My projects"), `PROJECTS`, `ISSUES` + status sub-nav (`OPEN, IN PROGRESS, BLOCKED, ON HOLD, REVIEW, RESOLVED, VERIFYING, CLOSED`), `ALERTS` + sub-nav (`RULES`, `HISTORY`), `TEAMS`, `TAGS`, `MCP TOKENS`, `SETTINGS`, `NOTIFICATIONS`, `SUPPORT`, `LOG OUT` | T |
| Project sidebar | `PROJECT` header, then `DASHBOARD, APPLICATIONS, ACTIVITY, REQUESTS, PROFILER, JOBS, ERRORS, USERS, SPANS, CUSTOM, SERVICES, MAP, RELEASES, SLOS, LOGS, API KEYS, MEMBERS, SETTINGS`; global tail (`NOTIFICATIONS, SUPPORT, LOG OUT`) stays | T |
| Top bar | global `Search` field (left, with magnifier), project/application context, page actions (primary button right, e.g. `CREATE PROJECT`, `CREATE ALERT`, `CREATE APPLICATION`), `CREATE ▾` menu, notification bell, user menu (`EM` avatar) | T |
| Sticky page action bar | on entity pages: `COPY AGENT PROMPT`, `VIEW LOGS` (float top-right of the content column) | T |
| Page header | `title` + one-line description in plain prose under it (every page has one) | T |
| Footer | `Copyright © 2026 Observe by NestJS`, `Terms of service \| Privacy policy`; in the demo an extra `DEMO DATA / USE IT ON YOUR APP` stamp | T |
| Support drawer | categories: *Billing, plans, and account questions* · *Problems with the Observe platform itself* · *Application code, configuration, or deployment* · *Bugs, incorrect telemetry, or missing data*; plus `Email us at`, `Browse the documentation`, `Email support` (the billing category is pricing to remove) | T |
| Project header widget | project switcher, application selector (`All applications`), live-refresh indicator, and a **release-regression callout** ("2.9.0 looks like a regression … DISMISS / VIEW RELEASES") | T |

---

## 2. Route map

Screenshots: `screenshots/01-project-dashboard.png` … `40-docs-telemetry.png`
(see the end of this section for the full index).

All routes are client-side; **the SPA serves the same shell for every path**.
Path params: `:id` = project **publicId** (`storefront-99063`); `:publicTeamId`
= team slug; `:issueId`/`:alertId` = slugs; `:sloId` = SLO slug.

| Route | Nav label | Purpose | View chunk | Conf |
| --- | --- | --- | --- | --- |
| `/dashboard` | DASHBOARD | project list ("My projects") with per-project sparkline summary | `all-projects-view` | T |
| `/dashboard/projects` | PROJECTS | same list, cards/table layout switch | `all-projects-view` | T |
| `/dashboard/projects/create` | — | 2-step create project wizard | `create-project-view` | T |
| `/dashboard/projects/:id` | DASHBOARD (project) | project overview: request/job charts, outliers, releases, issues, API-key CTA | `project-dashboard-view` | T |
| `/dashboard/projects/:id/applications` | APPLICATIONS | applications (Nest services) of the project | `all-applications-view` | T |
| `/dashboard/projects/:id/activity` | ACTIVITY | activity/events feed **[U: rendered empty in demo]** | `project-tab` | T |
| `/dashboard/projects/:id/requests` | REQUESTS | request list + volume/duration charts + operation table | `project-requests-view` | T |
| `/dashboard/projects/:id/requests/details?id=<route>&method=<VERB>` | — | one operation: percentile stats, traffic heatmap, latency distribution, ranked ranges | `project-requests-details-view` | T |
| `/dashboard/projects/:id/requests/:entityId/details` | — | one request instance: metadata, trace id, tabs `Waterfall` / `Headers / Body`, error panel | `project-request-operation-details-view` | T |
| `/dashboard/projects/:id/traces/:traceId` | — | trace waterfall + span tree + span detail | `project-trace-view`, `operation-spans-list` | T |
| `/dashboard/projects/:id/errors` | ERRORS | error groups' list, status workflow, error filters | `project-errors-view` | T |
| `/dashboard/projects/:id/errors/details?error=<msg>&statusCode=<code>` | — | one error group: counts, affected users, occurrences, latest stack, trace link | `project-errors-details-view` | T |
| `/dashboard/projects/:id/errors/:entityId/details` | — | same, entity-addressed variant | `project-errors-details-view` | T |
| `/dashboard/projects/:id/logs` | LOGS | log explorer: level filters, search, live tail SSE, cursor paging | `project-logs-view` | T |
| `/dashboard/projects/:id/jobs` | JOBS | job/queue list (BullMQ + schedule) | `project-jobs-view` | T |
| `/dashboard/projects/:id/jobs/details?queue=<q>&name=<job>` | — | one job: durations, waits, attempts, failures, runs | `project-job-operation-details-view` | T |
| `/dashboard/projects/:id/jobs/:entityId/details` | — | one job run (status, jobId, attemptsMade, failedReason, waterfall) | `project-job-operation-details-view` | T |
| `/dashboard/projects/:id/spans` | SPANS | custom spans (`TracerService.startSpan`) analytics | `project-spans-view` | T |
| `/dashboard/projects/:id/spans/details?span=<name>` | — | one span name: invocations, p95, outcome table | `project-span-details-view` | T |
| `/dashboard/projects/:id/custom` | CUSTOM | custom metric cards (counter/gauge, unit, label, sparkline, lifetime total) | `project-custom-view` | T |
| `/dashboard/projects/:id/custom/details?name=<m>&label=<l>` | — | one custom metric: value/increase over time, min/avg/max per bucket, retention floor | `project-custom-details-view` | T |
| `/dashboard/projects/:id/users` | USERS | per-user table (requests, error rate, worst p95, last seen) + users vs customers grouping | `project-users-view` | T |
| `/dashboard/projects/:id/users/details?userId=<id>` | — | one user: summary, action timeline, endpoint-to-endpoint paths | `project-user-details-view` | T |
| `/dashboard/projects/:id/users/account` | — | customer accounts (users grouped by company), signed-out bucket | `project-customer-account-view` | T |
| `/dashboard/projects/:id/services` | SERVICES | instrumented **classes** by own/total time, expandable methods | `project-services-view` | T |
| `/dashboard/projects/:id/map` | MAP | service map: clients → apps → queues/DB, edges with calls/errors | `project-map-view` | T |
| `/dashboard/projects/:id/releases` | RELEASES | release impact: error rate before→after per operation, verdicts | `project-releases-view` | T |
| `/dashboard/projects/:id/slos` | SLOS | SLO list: SLI type, objective, burn (1h), health chip, declared-in-code marker | `project-slos-view` | T |
| `/dashboard/projects/:id/slos/create` | — | SLO create form | `project-slo-create-view` | T |
| `/dashboard/projects/:id/slos/:sloId` | — | SLO detail: objective sentence, error budget ring, burn-rate chart, linked alerts | `project-slo-details-view` | T |
| `/dashboard/projects/:id/slos/:sloId/edit` | — | SLO edit form | `project-slo-edit-view` | T |
| `/dashboard/projects/:id/profiler` | PROFILER | runtime/profiler: instances, CPU/mem/event-loop, GC, heap, flamegraph entry | `project-profiler-view` | T |
| `/dashboard/projects/:id/keys` | API KEYS | project API keys (appKey/appSecret) + install snippet | `project-api-keys-view` | T |
| `/dashboard/projects/:id/members` | MEMBERS | project ACL: member × access (`admin`/`write`/`read`) | `all-members-view` | T |
| `/dashboard/projects/:id/settings` | SETTINGS | rename/archive/remove project | `project-settings-view` | T |
| `/dashboard/issues` (+ `/open`, `/in-progress`, `/blocked`, `/on-hold`, `/review`, `/resolved`, `/verifying`, `/closed`) | ISSUES | issue tracker list, status tabs | `all-issues-view` | T |
| `/dashboard/issues/create`, `/dashboard/issues/:issueId/edit` | — | issue create/edit (rich text, attachments, assignment, due date) | `create-issue-view`, `edit-issue-view` | T |
| `/dashboard/issues/:id` | — | issue detail: verdict/verification, activity, incident, linked entity | `issue-view` | T |
| `/dashboard/alerts` | ALERTS | alert rules table (name, project, condition, severity, status, actions) | `all-alerts-view` | T |
| `/dashboard/alerts/create`, `/dashboard/alerts/:alertId/edit` | — | alert rule create/edit (details, condition + preview, notifications, quiet hours) | `create-alert-view`, `edit-alert-view` | T |
| `/dashboard/alerts/:alertId` | — | alert rule detail + recent firings | `alert-details-view` | T |
| `/dashboard/alerts/history` | ALERTS › HISTORY | firing timeline (lanes per rule), table with samples/delivery | `alert-history-view`, `alert-events-list` | T |
| `/dashboard/alerting` | — | legacy redirect target; renders nothing (26 nodes) | — | T |
| `/dashboard/teams`, `/dashboard/teams/:publicTeamId`, `/dashboard/teams/:publicTeamId/sso` | TEAMS | teams, members, SSO (OIDC: issuer, client id/secret, domains, enforcement) | `all-teams-view`, `team-sso-view` | T |
| `/dashboard/tags` | TAGS | labels owned by user/team, attachable to applications (max 3) | `all-tags-view` | T |
| `/dashboard/mcp-tokens` | MCP TOKENS | personal MCP tokens (name, expiry, last used) | `mcp-tokens-view` | T |
| `/dashboard/settings` | SETTINGS | account: profile, notification emails, password, 2FA | `settings-view` | T |
| `/dashboard/notifications` | NOTIFICATIONS | notification feed with severity filter + mark-all-read | `notifications-view` | T |
| `/dashboard/link` | — | device-code approval for `npx @nestjs/observe link` | `cli-link-view` | T |
| `/dashboard/platform` | — | internal platform admin (`/admin/stats`); rendered empty for a normal user | `platform-view` | T |
| `/dashboard/legal/terms-of-service`, `/dashboard/legal/privacy-policy` | footer | legal text | `tos-view`, `pp-view` | T |
| `/dashboard/billing` (+ `/usage`, `/invoices`, `/spend-controls`, `/cost-attribution`) | BILLING | **pricing surfaces — to remove**, see §16 | `billing-tab`, `usage-view`, … | T |
| `/documentation` (+ `/overview`, `/applications`, `/sdk`, `/telemetry`, `/traces`, `/mcp`, `/users`, `/profiler`, `/alerts`, `/slos`, `/issues`, `/billing`, `/faq`) | footer/sidebar | product documentation rendered in-app | `documentation-tab` + one chunk per page | T |
| SPA top-level (marketing shell) | — | `/`, `/login`, `/sign-up`, `/forgot-password`, `/reset-password`, `/confirm-email`, `/link` on the **www** origin | `login-view`, `sign-up-view`, … | B |

Not routed / not found in bundle: an explicit "environments" page (see §10), a
"traces" sidebar item (traces are only reached from a request or an error).

---

## 3. Cross-cutting UI mechanics

| Mechanism | Behaviour | Conf |
| --- | --- | --- |
| Time range control | segmented `LIVE · 1H · 24H · 3D · 7D · 30D` + custom picker (calendar, day presets `MM/DD/YYYY`, `OK`, `Pin`); `3H`, `12H` exist in the non-compact variant; `30D` in the compact one | T |
| Live mode | `LIVE` polls; helper text "Charts on this page refresh every minute." | T |
| Range gating | ranges the retention/plan cannot serve are dimmed with "Not enough data to select this range yet" (data) or a plan lock tooltip (pricing) | T |
| Application scope | `All applications` dropdown overrides `applicationId` on every telemetry query; profiler has its own `serviceNode` selector + `AUTO` badge | T |
| Search | per-page text search box (`Search...`) mapped to a `search` query param | T |
| Column filters | numeric filters with operators `>`, `<`, `>=`, `<=`, `=` and a `RESET`/`APPLY` bar (`use-filters`, `numeric-column-filters`); select filters for method, status code, outcome, span type, queue name, level | T |
| Tables | sortable headers (`SORTED DESCENDING` badge), optional collapsed rows with expand toggles (`Collapse`, `Enter`), `rows per page` count, bulk selection with `N selected` action bar | T |
| Charts | custom SVG components (`chart-defs`, `svg-chart.module`, `line-chart-theme`, `simple-line-chart`; Nivo line for some series); stacked area by status class `1/2/3xx`, `4xx`, `5xx`; `AVG`/`P95` toggle; previous-period ghost series with `−18% since last period` deltas; bucket gaps rendered as gaps (not zeros); right-click → `Show release markers`/`Hide release markers` | T |
| Rate/aggregation units | requests `/min`, throughput `/min`, durations `ms` (auto-formatted to `s`), error rate `%`, memory/CPU `%`, SLO burn `×`, absence `min` | T |
| Empty / loading / error states | skeleton blocks with `Loading…`; explicit per-view empty copy (`No requests found.`, `No SLOs yet.`, `No data available`, `No traffic in this window`); inline error + `Could not load … retry in a moment.` | T |
| Pagination | tables: server total `totalCount` + `rowsPerPageCount`; feeds: `limit`; logs: cursor `nextCursor` + `Load older logs` | T |
| Keyboard | **no global shortcut system found** in the bundle (no command palette, no hotkey table); only widget-local keys (date picker `Esc`, `Enter` to expand rows) | T |
| Notifications badge | polling `GET /me/alert-rules/count` (firing/total) + `GET /me/notifications` unread count in the sidebar | T |
| Copy affordances | `Copy trace ID`, `Copy agent prompt` (renders a markdown blob: trace summary, span table with self/total, logs, stack frames, source lines), copyable install snippets | T |

---

## 4. Dashboard (`/dashboard/projects/:id`)

> Header: *"Here's an overview of your project and its applications."* Release
> regression banner appears above when `telemetry/regressions` flags a version.

| Element | Data shown | Metric / aggregation | Default range | Conf |
| --- | --- | --- | --- | --- |
| Requests chart | total + stacked by status class (`1/2/3xx`, `4xx`, `5xx`) | count and rate (`50/min`), delta vs previous period, in-flight annotation (`≈0.2 IN FLIGHT, 0.3 AT 05:10`) | 1H | T |
| Duration chart | `AVG` / `P95` line | ms, with qualitative tag line (`STEADY NEAR 203 MS`, `LONG TAIL, P95 ×4 THE AVG`) | 1H | T |
| Jobs chart | `Completed` / `Failed` | counts + failure delta | 1H | T |
| Jobs duration chart | `AVG` / `P95` | ms | 1H | T |
| Performance outliers | top slow operations | P95 vs a per-route budget, "2.2× budget", method chip + route/GraphQL text | 1H | T |
| Where the time goes | per-class own time (`OWN TIME`, `of own time`) | class table snippet, click → Services | 1H | T |
| Recent/relational cards | Requests `3,044` `50/min`, error rate, job failures, `Last release`, `First event`, `Collection stopped` / `Traffic has stopped` / `Requests are down` states | counters + health banners | 1H | T |
| Issues card | open issues with `in progress` / `not started` | count + list | — | T |
| API key CTA | `Add API key` / `Issue an API key`, `COUNT` of keys | install nudge when no key | — | T |
| Releases card | latest release, `deployed …` | version, deploy time | — | T |

Components: `requests-chart-card`, `requests-duration-chart-card`,
`jobs-chart-card`, `jobs-duration-chart-card`, `errors-chart-card`,
`anomaly-spotlight`, `customer-health`, `chart-sync-context` (hover sync between
charts), `summary` helpers `summarize-telemetry-buckets`, `derive-request-window-stats`.

---

## 5. Requests, services, spans

### 5.1 Requests list (`…/requests`) [T]

Charts: requests (stacked by class) + duration (`AVG`/`P95`), both with
previous-period deltas. Table columns:

| Column | Meaning | Conf |
| --- | --- | --- |
| `OPERATION ID` | route template (`/checkout/:orderId/pay`) or GraphQL operation | T |
| `METHOD` | HTTP verb chip | T |
| `DURATION` | `AVG` and `P95` per operation | T |
| `FAILURE RATE` | % failed, colour-banded, min-level aware | T |
| `COUNT` | requests in window | T |

Row click → operation detail. Filters: method select, search. Sortable on every
numeric column.

### 5.2 Operation detail (`…/requests/details?id=&method=`) [T]

| Block | Content | Conf |
| --- | --- | --- |
| Summary cards | `Operation ID`, `Method`, `Avg. Duration` (1007.24 ms), `95th Percentile`, `Count`, `Errors` split `68 (4xx) / 12 (5xx)` | T |
| Instance drill-down | the `COUNT` cell expands into a request-instance list; each instance links to `/requests/:entityId/details` | T |
| Traffic | weekly-rhythm heatmap ("Sensitive to host pressure", `· elevated = top quartile`, `Under host pressure`), 7-day x hour grid, "No calls in the last seven days." fallback | T |
| Duration distribution | percentile/ranked-range chips (`rankedFrom`, `durationDistribution`) with "not drawn"/`not replayed` states | T |
| Series | requests + duration series with previous-period comparison | T |
| Table | same columns as list but scoped to the operation (also a per-application breakdown) | T |

### 5.3 Request instance (`…/requests/:entityId/details`) [T]

Observed: `screenshots/04-request-instance-waterfall.png`,
`04a-request-instance-flame-tab.png`, `04b-request-instance-compare-typical.png`,
`04c-request-instance-span-selected.png`. `entityId` is
`encodeURIComponent(requestId)`. Reached from a request row, from an operation's
instance list, or via **`Open trace →`** on an error occurrence.

| Block | Content | Conf |
| --- | --- | --- |
| Page description | *"The request that failed, and the error it raised."* (the `/traces/:traceId` variant says *"Everything recorded under a single trace id."*) | T |
| Error panel (only when the request failed) | `Error` chip, exception class + message (`BadRequestException Validation failed: …`), *"thrown in ProductsController.findAll"*, then stack frames — an in-app frame is `THROWN AT <Class.method>` + `async` tag + `file:line:col` + **numbered source listing (10 lines) with the throwing line highlighted**; further frames collapse to `1 more frame in your code` and `4 frames in dependencies and Node internals`; every frame has a `SOURCE` toggle | T |
| Details | `Trace ID` (chip → trace view), `Operation` (`GET /products`), `Duration` (`96.41 ms`), `Status code` (`422`), `Error` (class + message), `User` (`anonymous`), `Protocol` (`HTTP`), `Application` (`api-gateway`), `Called at` (ISO + relative), `Tags`, `Request headers` (`5 captured ›`), `Request body` (`Not captured ›`) | T |
| Compared to other calls | `405 calls · the last hour` + `TYPICAL` badge, AVG `46.07 ms` / P95 `126 ms` band, this call plotted as `96.41 ms THIS CALL` | T |
| Waterfall | see §5.4 — rendered inline on this page, with `REPLAY` | T |
| Logs | `6 lines · 1 error`, level filter chips `VERBOSE DEBUG LOG WARN ERROR`, rows `+offset ms · LEVEL · context · span · message` | T |
| Spans table | `NAME / SELF % / SELF / TOTAL`, per-span `N LOGS` counts | T |
| Sticky actions | `COPY AGENT PROMPT`, `VIEW LOGS` | T |
| Capture states | `Not captured`, `N captured`, `bodyTruncated` flag on the body panel | T |

### 5.4 Trace view (`…/traces/:traceId`) [T]

> Header: *"Everything recorded under a single trace id."*

Observed on `screenshots/04-request-instance-waterfall.png`
(`/dashboard/projects/:publicId/requests/:entityId/details`, entityId =
`encodeURIComponent(requestId)`; the same waterfall component renders
`/traces/:traceId`).

| Element | Detail | Conf |
| --- | --- | --- |
| Waterfall container | header `Waterfall`, `REPLAY` button + `· 96.4ms`, `COMPARE WITH A TYPICAL REQUEST`, tabs `WATERFALL` / `FLAME`, `▶ PLAY`, toggle `CRITICAL PATH`, toggle `GAPS`, hint *"Highlights the spans that decided the duration — values switch to own time"* | T |
| Root row | `Request` with total duration and a `0ms … 96.4ms` ruler (5 ticks); column header `DURATION` | T |
| Span rows | indent per depth, name (`ProductsController.findAll`), kind chip (`error`, `span`, `span error`, and DB kind like `redis.get`), `N LOGS` badge, duration (`96.4 ms`), percentage of trace (`100.0%`); failed spans coloured red | T |
| Bar geometry | `left = start offset %`, `width = duration % ` of the request clock, per-bar `title="<label> — <ms> ms"`; comment: *"Bars are positioned on the request's clock … overlapping bars ran concurrently — which is also why a parent's children can sum to more than the parent itself. Move across the tracks to scrub the clock; click to hold an instant."* | T |
| Spans table (`operation-spans-list`) | `NAME`, `SELF %`, `SELF`, `TOTAL`, sortable (`SORTED DESCENDING`), expandable child rows; *"Child spans overlap in time, so this span's own share cannot be separated out. Shown as 0."* | T |
| Per-span logs | each span row shows `N LOGS`; expanding reveals log lines with level chips | T |
| Actions | `Open full trace`, `Copy trace ID`, `Copy agent prompt`, `VIEW LOGS` (sticky), anchor navigation `#execution-<spanId>` | T |
| Errors in trace | failing span is red-tinted and its message is the `trace-error-card` content | T |

`FLAME`, `GAPS` and `CRITICAL PATH` are present as tabs/toggles; the demo's
rendered content for `FLAME`/`GAPS` looked identical to `WATERFALL` in our
captures, so their exact rendering is **unknown** [U].

### 5.5 Spans (`…/spans`) and services (`…/services`) [T]

- Spans page: *"Analytics for the custom spans your code creates."* Charts
  (invocations, latency by span, failure-rate bubble) + table `Name`, `Spans`
  (invocations), `Duration`, `Failure Rate`; empty: `No custom spans found.`
- Span detail: `Name`, `Invocations`, `Errors`, `Failure rate`, `Avg. Duration`,
  `95th Percentile`; executions table `TRACE ID · OUTCOME · START OFFSET ·
  DURATION · CALLED AT`; comment *"The same span name recorded in the window"*.
- Services: *"Which of your NestJS classes actually burn the time."* Table
  `CLASS · OWN TIME · AVG OWN / CALL · TOTAL TIME · CALLS · ERRORS · METHODS`;
  `Own time` = *"time spent in a class's own code with nested calls subtracted"*,
  `Total time` = wall time incl. nested; expandable row → `METHOD` level table
  (`Method`, `Calls`, `Errors`, `Own time`, `Total time`); empty: *"Only
  instrumented classes appear here"*, *"No method-level data in this window."*

---

## 6. Errors [T]

Screenshots: `screenshots/05-errors-list.png`, `06-error-detail.png`.

### 6.1 Error list (`…/errors`)

> *"Analytics and insights on errors within your project."*

| Element | Detail | Conf |
| --- | --- | --- |
| Chart | error rate series, legend `Unhandled` / `Intrinsic` — *"Errors that inherit from the IntrinsicError class"*, *"Errors that typically represent an internal server error"*; "Intrinsic errors are counted separately" | T |
| Table columns | `Message`, `Status`, `Count`, `Last seen`, `First seen`, `Actions`, plus `Fingerprint` (shown in row/expanded detail), `Pattern`, `Attribute`, `Introduced in`, `Resolved at`, `Rule active` | T |
| Status model | `open`, `resolved`, `ignored`, `expected` (`error-group.enums`), chips colour-mapped: open→error, resolved→success, ignored/expected→neutral | T |
| Row actions | `Resolve`, `Reopen`, `Ignore`, `Select status`, `Create issue`, `View issue` | T |
| Error filters | `Edit filters` / `View filters` / `Save filters` — project-level rules (`/error-filters`, `Add rule`, `Remove rule`, `Show them`, `Cancel`) with fingerprint/pattern matching | T |
| Search | `Search...` + `status` filter | T |

Grouping model as presented: one row = one **fingerprint** (message + stack
shape), with counts, first/last seen, status, and a linked issue. The SDK side
owns the fingerprint computation (`repos/observe`), the UI only consumes it.

### 6.2 Error detail (`…/errors/details?error=&statusCode=`) [T]

| Block | Content |
| --- | --- |
| Summary | status code chip (`422`), message, `Count`, `Users affected` (4), `Last occurrence` (relative) |
| Series | `Errors` chart split `Intrinsic` / `Unhandled` with ×ratio vs previous; `STEADY, ≈5.6/MIN` tag |
| Latest occurrence | `POST /checkout/89199/pay`, version `1.13.0`, application `CHECKOUT-SERVICE`, `A FEW SECONDS AGO`, `OPEN TRACE →` |
| Stack / source | exception type (`TypeError`), message, `thrown in CheckoutController.pay`, `THROWN AT` / `SOURCE` frames with `file:line`, numbered source listing with the throwing line highlighted, collapsed groups (`1 more frame in your code`, `N frames in dependencies and Node internals`) — same renderer as §5.3 | T |
| Occurrences table | `Errors` list scoped to the fingerprint: `User`, `Trace ID`, `Protocol`, `Called at`, `Duration`, `Count`; empty: `No occurrences in this window.` |
| Affected users | list, `No users affected.` fallback |

---

## 7. Logs [T]

Screenshot: `screenshots/07-logs-explorer.png`.

> *"Everything your services logged, correlated to the traces they ran in."*

| Control | Detail | Conf |
| --- | --- | --- |
| Window | `From` / `To` date-time + `Search covers the last N days.` / `— the limit of this project's retention window` | T |
| Level filter | multi-select `Filter by level` (`Trace/Debug/Info/Warn/Error/Fatal` levels appear as lowercase `level` values) | T |
| Search | free-text; *"Clear the search to page back through the full retention window."* | T |
| Live tail | `Live tail` toggle → `Connecting…`, `Reconnecting…`, `Streaming`, `Tail failed`, `The live tail stopped: …`, `AbortError`/`TimeoutError` surfaced; gap notice + backfill `Showing from …` | T |
| Paging | `Load older logs` / `Loading older logs…`, cursor based (`nextCursor`) | T |
| Empty/error | `Logs could not be loaded.`, `The log stream could not be opened.`, plan-gated: *"Your team's plan does not include logs ingestion — your services' log lines are not being collected."* (pricing) | T |
| Row | timestamp, level chip, `context` (logger name), message, expandable structured `attributes` (JSON viewer in `log-row`), `traceId`/`spanId` links | T |

Within a request/trace: logs are attached per span section — the trace view has a
`Logs` block (`## Logs from this trace` in the copied agent prompt), and
`GET …/telemetry/traces/:traceId/logs` backs it.

---

## 8. Jobs / queues / cron [T]

Screenshots: `screenshots/08-jobs-list.png`, `09-job-detail.png`.

> *"View and analyze jobs processed by your applications."*

| Element | Detail | Conf |
| --- | --- | --- |
| Charts | jobs count (`Completed` / `Failed`) + jobs duration (`AVG` / `P95`), previous-period deltas | T |
| Table | `Name` (job name), `Queue` (`Queue name`), `Duration`, `Invocations`, `Failure rate`; filter `Filter by queue name`; `All queues` option | T |
| Detail (`jobs/details?queue=&name=`) | `Name`, `Queue Name`, `Duration` `AVG`/`P95`, `95th Percentile wait`, `Avg. wait`, `Max wait`, `Invocations`, `Failed Count`, `Failure Rate`, `Last call`; series + runs table | T |
| Job run | `status`, `queueName`, `jobId`, `attemptsMade` (`Attempt`), `failedReason` (`Fail`), `enqueuedAt`, `waitDuration`, `duration`, `traceId`, tags, `Waterfall` tab | T |
| Cron/interval jobs | the same model: `@nestjs/schedule` jobs appear as job operations (no separate cron page exists) | B |

---

## 9. Runtime, custom metrics, profiler

### 9.1 Custom metrics (`…/custom`) [T]

> *"Gauges, counters, and other custom telemetry data."*

| Element | Detail |
| --- | --- |
| Cards | metric `name`, type badge (`COUNTER`, `GAUGE`), current value / `this window` / `lifetime` total, unit (`ratio`), label set (`eu-west-1`), `latest reading · 5 min ago`, sparkline |
| Detail | `Value over time` vs `Increase over time` toggle, `Min / avg / max` per bucket (*"Per bucket min / avg / max"*), `Current value`, `Increase`, `Last updated`, `Description`, `Lifetime total`, retention floor line |
| Gauge semantics | *"Gauges report a reading at each point in time. Each dot is one reading; buckets with no reading are gaps, not zeroes."* |
| Empty | `No custom metrics found.` |

### 9.2 Runtime / profiler (`…/profiler`) [T]

> *"Monitor your application's performance and resource usage."*

| Block | Detail |
| --- | --- |
| Instance selector | per application and per instance (`api-gateway-0`, `-1` …), `AUTO` badge when auto-picked, `acrossNodes` aggregate |
| Instance cards | `CPU %`, `MEMORY %`, `EVENT LOOP LAG ms` per instance |
| Runtime section | *"THE FOUR NUMBERS THAT SAY WHETHER THE PROCESS IS COPING"*: `CPU utilization`, `Memory utilization`, `Event loop delay`, `Event loop lag`; categories `Runtime`, `Memory`, `GC count`, `GC duration` (`Major`/`Minor`, `Incremental`), `Heap Used`, `Heap Total`, `RSS`, `Instances` |
| Charts | CPU/memory by category, GC duration/count by category, heap growth (`Heap growth tracks …`) |
| Flamegraph | `what ran here?` entry: `profiles/flamegraph`, `profiles/functions` (self/total), `profiles/coverage` (profiled vs unprofiled); snapshot list from `profiler-snapshots` |
| Empty | `No data available` |

`resource-signals` provides the alert-side helpers (CPU ≥85% warn / ≥95% critical,
memory ≥85/95, event-loop lag ≥50 ms & utilization ≥0.7, error rate ≥5%/20%).

### 9.3 Releases / regressions (`…/releases`) [T]

> *"Each release compared against the 30 minutes of traffic before and after."*

- `Release impact` chart: `ERROR RATE BEFORE → AFTER, PER OPERATION` — "Ring
  before the release, dot after. Red moved the wrong way; the first row is every
  request together", rows like `GET /products/:slug 2.3% → 14%`.
- Table: `Verdict`, `First seen`, `VERSION`, `· regression` markers, `format-regression`.
- Project-level banner + `regressions/changes?version=&windowMinutes=` powers the
  "looks like a regression" callout.

---

## 10. Services, applications, environments

Screenshots: `screenshots/22-applications.png`, `14-services-classes.png`,
`15-service-map.png`.

| Concept | What identifies it | Where | Conf |
| --- | --- | --- | --- |
| **Project** | `id` (UUID) + `publicId` slug + `name` + `avatar` index; owns applications, telemetry, keys, SLOs, issues | switcher, `/dashboard/projects` | T |
| **Application** | `id`, `publicId`, `displayName`, `name`, `archived`, `forwardLogs`, `tags` (max 3); created per Nest service | `…/applications` | T |
| **Service** (SDK) | `serviceId` sent by the SDK → shown as *"The service's real name"* in the link flow and as `applicationName` on every record | link flow, telemetry | T |
| **Team** | `id`, `publicId`, `name`, `membersCount`, `users`, SSO config; projects belong to a team | `/dashboard/teams` | T |
| **Tag** | `id`, `label` (3–32 chars), owner = user or team; ≤3 per application | `/dashboard/tags` | T |
| **Environment** | **no first-class environment page/resource**; environment is expressed only via free-form `tags` on the application plus `serviceVersion` on records | — | T |

Applications table: `NAME · ACTIVITY · LAST SEEN · CPU · MEMORY · REQ/S · ERROR
RATE · TAGS · ACTIONS`; *"Each application represents a separate Nest service."*;
create dialog validates: ≤25 chars, no special characters, ≤3 tags.
Stale `lastSeen` styling (`lastSeenStale`).

Service map (`…/map`): *"How your applications, queues and databases talk to each
other"*; node kinds `Clients`, `Application`, `Queue`, `Database`,
`External service`, edges annotated `Calls`, `Connection`, `Error rate`,
`Incoming traffic`, legend with bands `01`–`06`; node click shows
`Close details`, `Called by`, `Where the time goes`, `View its requests`,
`View jobs`. Note: *"Inferred from executions that share a trace id, measured on
the most recent requests rather than the whole window."*

---

## 11. SLOs [T]

Screenshots: `screenshots/17-slos-list.png`, `18-slo-detail.png`.

> *"Objectives over existing telemetry — with a promise, error budget, and burn rate."*

| Element | Detail |
| --- | --- |
| SLI kinds | `availability`, `latency`, `job_success` with prose definitions: availability = *"a request is good unless it ended in an unhandled error; handled errors count as good by default"*; latency = *"ratio of fast requests, not a p95 reading — one slow outlier costs one event"*; job_success = *"a job run is good when it completes without failing"* |
| Objectives | presets `99, 99.5, 99.9, 99.95, 99.99`; compliance windows `7, 14, 28, 30` days (default 28, burn threshold 1; guard 99.999) |
| List columns | `Name`, objective/burn (`Burn (1h)`), health chip (`Healthy`, `Firing`, `Over budget`, `No traffic`), `Delete` |
| Health | `firingAlertCount > 0 → firing`; `budgetRemaining < 0 → over-budget`; `sli === null → no-traffic`; else healthy; budget text `45% left` / `2.1× over budget` / `no traffic` |
| Detail | objective sentence (`99.9% of requests under 300ms, rolling 28 days`), error-budget ring, `Burn rate against paging thresholds` chart with `target %` legend, `SLI · rolling N days`, `Burn-rate alerts` section (`Create burn-rate alert`), `View plans` (pricing) |
| Code-declared SLOs | `declaredIn`/`declaredVersion` → *"This SLO is declared in code, with <tag>. Remove the decorator to retire it."* |
| Create form | `SLO details` (`Name`, `Description` — *"Why this objective exists and who cares when it is missed"*, `SLI`, `Objective`, `Compliance window`, scope `Route`/`Job` template, `Handled errors count as good`) |
| Delete | warns that burn-rate alert rules go with it, past firings stay in history |

---

## 12. Alerts [T]

Screenshots: `screenshots/29-alerts-list.png`, `30-alert-create.png`,
`31-alert-history.png`, `32-alert-detail.png`.

> *"Get told when your telemetry crosses a threshold you care about."*

| Element | Detail |
| --- | --- |
| List columns | `Name`, `Project`, `Condition`, `Severity`, `Status` (enabled/paused), `Last fired` (`Never`), `Window`, `Channels`, `Scope`, actions `Edit`, `Pause`/`Enable`, `Delete` |
| Create form §1 `Alert details` | `Name` (*"becomes the subject line of the email and the title of any issue it opens"*), `Severity` (`Low/Medium/High/Critical`), `Project`, `Application` (`All applications`) |
| §2 `Condition` | `Metric` ∈ {error rate, P95 latency, average latency, throughput, job failure rate, job throughput, event loop delay, CPU usage, memory usage, custom metric, SLO burn rate, application heartbeat, job heartbeat, log pattern, job wait P95, new error groups}; `Detection` ∈ {`Fixed threshold`, `Anomaly detection`}; `Threshold` + `Above`/`Below`; `Evaluation window` ∈ {5,10,15,30,60,180,360,720,1440,4320 min}; scope `Route` + `Any method`, `Queue`, `Log pattern`, `Custom metric`; anomaly mode uses sensitivity in sigma (default 3.5, min 1) and is rejected for queue-wait; `Preview` block: `WOULD NOT HAVE FIRED` / `would have matched N lines`, *"FIRES ABOVE 500%"* |
| §3 `Notifications` | channels `In-app`, `Email` (comma-separated), `Webhook` (*"secret signs the request so you can verify it came from us"*), `Slack` (incoming webhook, channel baked into URL), `Create an issue` (*"opens an issue the first time the rule fires … further firings do not open duplicates until it resolves"*); at least one required |
| §4 `Quiet hours` | `Mute on a schedule`, weekdays + start/end (`Mon, Tue, Wed, Thu, Fri 22:00 → 06:00 next day`), `Add window`, `Weeknights`, `Weekends`; *"the rule still evaluates, but it neither notifies nor resolves … a rule that was already firing stays firing"* |
| History | firing timeline (lane per rule, `Firing`, `Resolved`, `now` line, `still firing, X so far` / `resolved after X`), table `Project · Outcome · Severity · Timeline · Samples · Observed · Delivery` (`pending`/`delivered`/`failed`), `sampleLogLines` preview |
| States | rule `ok|firing|resolved`; event delivery `pending|delivered|failed`; channels `email|webhook|issue|in_app|slack` |

Absence/heartbeat semantics (from `/documentation/alerts`, captured text): fires
on **silence**, not on a threshold crossing — *"nothing was read at all"*; a scope
that never reported anything does not fire; the firing history shows how long the
gap ran and when data was last seen; the same signal drives the application-card
silence badge.

---

## 13. Issues (tracker) [T]

Screenshots: `screenshots/27-issues-list.png`, `28-issue-detail.png`.

> *"Create and manage issues for your projects."* A Jira-lite layer over errors and
> telemetry, with a verification workflow.

| Element | Detail |
| --- | --- |
| List columns | `Title`, `Status`, `Severity` (`Low/Medium/High/Critical`), `Assignee`, `Project`, `Due date`, `Last updated` |
| Filters | status tabs (`open, in-progress, blocked, on-hold, review, resolved, verifying, closed`), `Project`, `Severity`, `Assignee`, `Unassigned`, `Assigned to me`, `Active` vs archived |
| Detail | `Status` (`Closed`, `Reopened`, `Verifying`, `Confirmed`, `No verdict`, `Outcome`), `Severity`, `Assignee`, `Reporter`, `Fixed in`, `Due date`, `Operation`, `Activity`, `Timeline`, `Watching N`, `Project:`, rich text body, `attachments`, `Edit issue`, `Add`, `Cancel`, `Confirm`, `Copied` |
| Verification | `verification.watchFromAt`, per-metric `checks[]` (`error_rate`, `p95_latency` … with `operationId`, `method`, `queueName`, `customMetricName`, `windowMinutes`, 12-bucket `baseline`); UI shows `Timeline:` verdicts (`Verifying`, `Confirmed`, `No verdict`) |
| Incident block | `subject`, `startedAt`, `endedAt`, `introducedIn`, `impact`, `fix`, `timeline` |
| Link to telemetry | `linkedEntityType`, `linkedEntityId`, `linkedTraceId` → "View issue"/"View trace" cross-links |
| Issue key | `WHI-100` style per project |

---

## 14. Users, accounts, tenants [T]

- `…/users` — *"An overview of users interacting with your project."* Table
  `User · Count (requests) · Error rate · Worst p95 · Last seen`; charts
  `Latency by user`, `Failure rate` bubble. Empty: `No users found.`
- `…/users/account` — *"The same people, grouped into the customer accounts they
  belong to."* Rows `People · Requests · Error rate · Failure Rate · Last
  interaction`; anonymous/signed-out bucket explained ("Counted as one 'person'").
- `…/users/details?userId=` — *"Everything a single user did in this project."*
  Summary (`avgDuration`, `p95Duration`, errors), action `Timeline` (grouping
  window "Calls closer together than this count as one action", 30 s default),
  `Paths` — *"Endpoint-to-endpoint paths for this user"* with method/path nodes and
  failure counts (`· N failed`), replay/graph toggles (`not drawn`, `not replayed`).
- `/me/telemetry/tenants` — tenant grouping exists in the API (`tenants`,
  `tenants/:tenant/users`) but **no dedicated tenants page route was found** [B].
- If the SDK never sends user identity: *"Your agent isn't reporting who your users are"*
  banner.

---

## 15. Settings, account, team, keys, onboarding

### 15.1 Account settings (`/dashboard/settings`) [T]

| Block | Fields / copy |
| --- | --- |
| Basic information | `First name`, `Last name`, `Email` (*"associated with your account. This cannot be changed"*), `GitHub/GitLab/Bitbucket username` (link by signing in with that provider) |
| Notifications | `Weekly digest` (*"A Monday morning summary of every project you work on…"*), `New error emails` (*"An email when one of your projects reports an error it has never seen before. At most a few a day per project."*) — independent of alert emails |
| Password | `Current password`, `New password` (≥10 chars), `Confirm new password` |
| 2FA | `Two-factor authentication` toggle, `QR code`, `Enter the code from your authenticator app.`, `Must be 6 digits`, `Enabled/Disabled`, `Save changes` |

### 15.2 Project API keys (`…/keys`) [T]

> Install flow embedded in the page: `## 1. Install the SDK`, `## 3. Make exactly
> these three edits`, *"Keep `serviceId` exactly `…`"*.

| Column | Detail |
| --- | --- |
| List | `Name`, `Application`, `Status`, `Created`, `Expires` (`No expiry` / `Expires at`), `Last used`, `Created by`, `Actions` (`Add key`, remove) |
| Create dialog | `Add API key`: `Name`, `Application` (`Select application…`), `Expires at`, `Select user...`, `Cancel`/`Confirm`; returns `apiKey` (`obs_pk_…`) + `apiSecret` (`obs_sk_…`) once, with `Close` |
| Snippet | `OBSERVE_APP_KEY` / `OBSERVE_APP_SECRET` + `ObserveModule.forRoot({ appKey, appSecret, serviceId })` (`setup-snippets`) |
| Empty | `No API keys found.` |

### 15.3 Members / teams / tags / MCP [T]

| Page | Detail |
| --- | --- |
| `…/members` (project) | `Member`, `E-mail`, `Access` (`admin`/`write`/`read`), `Last updated`, `Actions` (toggle edit, remove); `Add project member` dialog (`Member`, `Select access level...`, validation "Access level is required"); bulk remove (`Remove N`) |
| `/dashboard/teams` | `My teams` with `Ownership` filter (`Owned by me`, `Shared with me`, `Owned or shared`), `Status` (`Active`/`Archived`), columns `Name`, `Members`, `Created at`, `Single sign-on`, actions `Archive`, `View members`, `Add team` |
| Team detail | members table (`Member`, `E-mail`, `Access`, `Date added`), `Add member`, `Remove` |
| SSO (`…/sso`) | `Single sign-on`, `Enabled`, `Enforced`, `Behaviour` (`Turned off`/`Not enforced`), `Issuer URL`, `Client ID`, `Client secret` (`Secret is set`/`Not configured`), `Redirect URI`, `Display name`, `Domains` + `Add domain`/`Remove domain`, `Setup progress`, `Verify`, `Checking…` |
| `/dashboard/tags` | `My tags`, `Ownership`, `Status`, columns `Tag`, `Label`, `Team`, `Created at`; validations 3–32 chars, `Team is required`, `Label is required`; `You need to create a team first.` |
| `/dashboard/mcp-tokens` | *"Personal tokens for MCP clients to read your telemetry, issues, and alerts."*, *"A token acts as you, with your exact project permissions… the few that write can create a project, application or API key, and resolve an issue — never delete or change one."*; columns `NAME · STATUS · LAST USED · EXPIRES · CREATED · ACTIONS`; create dialog `Name` (3–100), `Expires` (`Never`), one-time `Copy your token` (`omcp_…`), `Revoke` |
| `/dashboard/notifications` | `My notifications`, severity filter `All/Info/Success/Error`, `mark-all-as-read`, relative dates, empty `No notifications` |

### 15.4 Onboarding / `link` [T]

| Flow | Steps |
| --- | --- |
| Create project (`/dashboard/projects/create`) | *"Group your applications into projects to manage them more effectively."* — 2 steps (`Back`/`Next`), `Project name`, team/`Select team..`, `Create project`, `You're all set` |
| Create application | dialog `Application name` (≤25 chars, no special chars), `Tags` (`You can add up to 3 tags`), `Create application` |
| Setup guide | first-run guided tour (`Let's go`, `Skip guide`, steps stored under `OBSERVE_SETUP_INVITATION_DISMISSED`), shows a mini fake trace (`OrdersController.list`, `OrdersService.findAll`) |
| CLI link (`/dashboard/link`) | *"Connect a project on your machine to Observe."* → `Type the code from your terminal` (*"`npx @nestjs/observe link` printed it"*), `CONTINUE`, `Codes expire 15 minutes after they are printed.` Then: `Link a project` → choose/create `Project name` (`New project…`) → choose/create `Application name` (`New application…`, *"The service's real name"*) → `Approve and send key` / `Deny` → *"Linked"*, *"<project> has its key. The CLI wrote it to .env"*, errors `No pending link with this code`, `Too many wrong codes. Wait a few minutes`, `Could not approve the link.`, `Could not deny the link.` |
| Sign-up / login (www origin) | `login-view`, `sign-up-view`, `forgot-password-view`, `reset-password-view`, `confirm-email-view`, `post-registration-view`, OAuth (GitHub/GitLab/Bitbucket) + 2FA + SSO (`sso/lookup`, `sso/exchange`), `vendor-login-box` [B] |

---

## 16. Pricing surfaces to REMOVE

Screenshots of the surfaces being removed: `screenshots/90-pricing-billing-REMOVE.png`,
`91-pricing-usage-REMOVE.png`, `92-pricing-spend-controls-REMOVE.png`,
`93-pricing-invoices-REMOVE.png`, `94-pricing-cost-attribution-REMOVE.png`.

Everything below exists only to sell the hosted product. A self-hosted clone must
delete these routes, components, entitlements and API endpoints.

| Surface | Where | Remove |
| --- | --- | --- |
| `BILLING` sidebar group | global sidebar | entire group |
| `/dashboard/billing` + `billing-tab` | plan card, `Manage plan`, `Go to Portal`, `Upcoming invoice`, `Start trial`, `Deactivate subscription`, `Payment failed`, `Pending payment`, `Select a plan…`, `Current`, `- billed` | route + view |
| `/dashboard/billing/usage` (`usage-view`) | `Observability events`, `% of the included volume`, `Overage`, `Forecast`, `Weighted`, `Chart scale`, `Spans are …`, `Quota alerts`, `Save thresholds`, `Monthly trend`, `By project`, `See what's using it` | route + view |
| `/dashboard/billing/invoices` (`invoices-view`) | `Invoices`, `PAYMENTS_HISTORY_KEY`, `View your payment history and download invoices.` | route + view |
| `/dashboard/billing/spend-controls` (`spend-controls-view`) | `Spend controls`, `Set an overage budget`, `Monthly overage budget`, `Spike protection`, `Keep full traces`, `Trace trimming`, `Span sampling`, `Rate cap`, `Overage is paused now`, `Collection is stopped now`, `Rejecting ingest — HTTP 429` | route + view |
| `/dashboard/billing/cost-attribution` (`cost-attribution-view`) | `Top drivers`, `Attributed`/`Unattributed`, `pricing`, `Allowance`, `of the bill`, `Drop filter`, `Spend` | route + view |
| `annual-switch-card` | `Switch to annual billing`, `Charged today`, `Account credit applied` | component |
| `upgrade-feedback.interface` | reason survey (`Lower price`, `Approval at work`, `A missing feature`, `A plan between Free and Pro`) | component + endpoints |
| `plan-catalog`, `subscription-plan.enum`, `get-plan-name`, `get-current-plan`, `get-subscription`, `get-usage-state`, `use-pacing-summary`, `usage-pacing` | plan definitions (Free/Pro/Scale/Enterprise/Business/Developer/Team), seats, `maxApplications`, `overagePricePerMillion`, `ssoSupport` | modules |
| Entitlement gating | `project-plan` (`Your team's plan sets this - the team owner can upgrade it.`), `entitlement-error`, `team-plan-lacks-feature`, `upgrade-to-use`, plan-locked time ranges in `time-range-button-group`, `View plans` on the SLO page | all checks |
| Plan-gated feature notices | *"Your team's plan does not include logs ingestion"*, SLO page *"Available on the <plan> plan"*, profiling/SLO/logs entitlement flags, `retentionDays` upsell in `telemetry/retention.upgrade` | notices (keep the features) |
| Waterfall pacing | *"Waterfalls paused until 00:00 UTC"*, `Paused — click to refresh every minute while you watch`, `events left this month`, `saved by pausing today`, `free pauses waterfalls so the month lasts` | component (`params-bar`) |
| `keep-full-traces-dialog` | overage budget / `Resume full collection` / `Raise the overage budget` gate on trace retention | dialog (keep a plain retention setting) |
| Support drawer *"Billing, plans, and account questions"* category | support drawer | one row |
| Server endpoints | see `dashboard-api.md` §Commercial endpoints (subscription, usage, spend-controls, cost-attribution, annual switch, upgrade feedback, `/prices`) | routes + tables |
| Model fields | `subscription{plan,entitlements,…}`, `applicationCount` quotas, `seats`, `retentionDays` tied to plan, `degraded`/`paced` flags | DB columns |

---

## 17. Look and feel

| Aspect | Finding | Conf |
| --- | --- | --- |
| Framework | React SPA built with **Vite** (hashed chunk per component, per-route lazy `import()`), single `index.html` shell with `#root`; per-origin builds (www vs demo) share code | T |
| Component library | **MUI (Material UI) + Emotion** (`MuiButton-root`, `MuiTooltip-arrow`, `TiltButtonGroup` → `ToggleButtonGroup`, `DialogContent`, `FormControlLabel`, `SwitchBase`, `InputAdornment`, `Skeleton`), plus **CSS Modules per component** (`*.module.css` in the chunk graph) and a small amount of utility classes | T |
| Charts | **hand-built SVG** components (`svg-chart.module`, `chart-defs`, `line-chart-theme`, `simple-line-chart`, `landscape-points`, `gap-for-missing-bucket`, `tail-band-layer`, `drawable-line-series`) + **Nivo** line for some series. No Recharts/ECharts/D3 dependency | T |
| Data layer | **TanStack Query** (`QueryClient`, `queryKey:[…,'telemetry',params]`, `staleTime`, `getNextPageParam` → `nextCursor`), manual `fetch` wrapper (no axios) | T |
| Forms | **Formik + Yup** (`slo-form.schema`, `general-project-settings-form.schema`, `assignment-form.schema`, `throw-if-form-invalid`) | T |
| Dates | `dayjs` (+ `date-fns` in places), explicit `UTC` labels in pickers | T |
| Typography | **Manrope Variable** for UI, **Geist Mono Variable** for numbers/ids/nav labels, self-hosted woff2 (Fontsource); labels are uppercase + letter-spaced, tables are tabular figures | T |
| Theme | dark only; page background near-black navy (`#151924` from `manifest.background_color`), panels one step lighter with 1 px light border and `inset 0 1px 0 rgba(255,255,255,.05)` highlight, shadows `0 10px 28px rgba(0,0,0,.45)`; brand accent pink `#e91e63` (`theme-color`), gradient logo `logo-small-gradient.svg`; semantic CSS vars (`--info-color`, error/warn/success) consumed via `color-mix()`; subtle full-page noise texture (inline SVG `feTurbulence`, opacity .025) | T |
| Status colours | status-code chips map families (`Success`, `Redirect`, `Client error`, `Server error`, `I'm a Teapot`…), severity `Low/Medium/High/Critical`, alert state `ok/firing/resolved`, issue severity colours | T |
| Density & spacing | 12 px mono labels, 13–14 px table text, 8 px grid, page container max-width with 24–32 px padding, sticky table headers, rows ~40 px | B |
| Motion | chart reveal animations (`use-chart-reveal`), accordion collapse, `prefers-reduced-motion` guards; GSAP only on the marketing site | T |
| Empty states | every list/chart has a sentence-case line + optional CTA; skeletons (not spinners) while loading | T |
| Responsiveness | `use-is-mobile`, `desktopOnly` columns, `.hidden-xs` time-range buttons, collapsible sidebar | T |
| Accessibility hooks | `aria-label`, `aria-expanded`, `aria-selected`, `aria-current`, `role="row"/"button"`, focus traps in dialogs | T |
| Keyboard | no global shortcuts/command palette (see §3) | T |

---

## 18. Demo-only and unknown

| Item | Status |
| --- | --- |
| Backend | **not reachable** — MSW in the browser; `demo-api.nestjs.local` does not resolve publicly. Response *shapes* are trustworthy, *values* are generated. |
| `DEMO DATA / USE IT ON YOUR APP` stamp, `demo-link` chunk | demo-only UI, drop it |
| Waterfall "paused until 00:00 UTC" pacing | demo shows the free-plan pacing; treat as pricing behaviour |
| `/dashboard/platform` (`/admin/stats`) | internal staff console; renders empty for the demo user; scope unknown [U] |
| `/dashboard/alerting` | dead route (renders only the shell) — stale link [T] |
| `…/activity` project tab | route exists, empty in demo [U] |
| Environments | no first-class concept; only tags + `serviceVersion` [T] |
| Traces list | no standalone traces page; traces are reachable from requests and errors [T] |
| Alert history retention, log retention defaults | plan-driven in demo; server-side values unknown [U] |
| Websockets | none observed — live behaviour is polling (60 s) + one SSE stream for the log tail [T] |

---

## 19. Screenshot index

All captures are headless Chromium (1512 px wide, full-page, device scale 1),
demo dataset. Files live in `docs/spec/screenshots/`.

| File | Route | Shows |
| --- | --- | --- |
| `01-project-dashboard.png` | `/dashboard/projects/storefront-99063` | project overview: regression banner, requests/duration/jobs charts, outliers, time goes |
| `02-requests-list.png` | `…/requests` | requests charts + operation table |
| `03-request-operation-detail.png` | `…/requests/details?id=/checkout/:orderId/pay&method=POST` | per-operation stats, errors split, instance list |
| `04-request-instance-waterfall.png` | `…/requests/:entityId/details` | error panel + source listing, details, typical-call band, waterfall, per-span logs, spans table |
| `04a-request-instance-flame-tab.png` | same | `FLAME` tab selected |
| `04b-request-instance-compare-typical.png` | same | `COMPARE WITH A TYPICAL REQUEST` state |
| `04c-request-instance-span-selected.png` | same | span row selected (held instant) |
| `05-errors-list.png` | `…/errors` | error groups table, status workflow, filters |
| `06-error-detail.png` | `…/errors/details?error=…&statusCode=422` | one error group: summary, series, latest occurrence, affected users |
| `07-logs-explorer.png` | `…/logs` | level filters, search, live tail, rows |
| `08-jobs-list.png` | `…/jobs` | jobs charts + queue table |
| `09-job-detail.png` | `…/jobs/details?queue=settlement&name=…` | durations/waits/attempts/failures |
| `10-spans-list.png` | `…/spans` | custom span analytics |
| `11-span-detail.png` | `…/spans/details?span=postgres.query` | invocations, p95, execution table |
| `12-custom-metrics.png` | `…/custom` | metric cards (counter/gauge, unit, label, lifetime) |
| `13-custom-metric-detail.png` | `…/custom/details?name=orders.placed&label=eu-west-1` | value/increase over time, min/avg/max |
| `14-services-classes.png` | `…/services` | class own/total time table + method expansion |
| `15-service-map.png` | `…/map` | clients → apps → queues/DB graph |
| `16-releases.png` | `…/releases` | release impact before→after per operation |
| `17-slos-list.png` | `…/slos` | SLO list with burn/health |
| `18-slo-detail.png` | `…/slos/get-products-latency-40347` | objective, budget ring, burn-rate chart |
| `19-profiler.png` | `…/profiler` | instances, CPU/mem/event loop, runtime section |
| `20-users.png` | `…/users` | user table + latency-by-user chart |
| `21-user-detail.png` | `…/users/details?userId=…` | summary, timeline, endpoint paths |
| `22-applications.png` | `…/applications` | application cards/table (CPU, memory, req/s, tags) |
| `23-api-keys.png` | `…/keys` | keys table + install snippet |
| `24-project-members.png` | `…/members` | project ACL |
| `25-project-settings.png` | `…/settings` | rename/archive/remove |
| `26-my-projects.png` | `/dashboard` | "My projects" list |
| `27-issues-list.png` | `/dashboard/issues` | issue tracker list |
| `28-issue-detail.png` | `/dashboard/issues/:slug` | issue detail, verification, activity |
| `29-alerts-list.png` | `/dashboard/alerts` | alert rules table |
| `30-alert-create.png` | `/dashboard/alerts/create` | full rule form (details/condition/preview/notifications/quiet hours) |
| `31-alert-history.png` | `/dashboard/alerts/history` | firing lanes + events table |
| `32-alert-detail.png` | `/dashboard/alerts/:slug` | one rule + recent firings |
| `33-teams.png` | `/dashboard/teams` | teams list |
| `34-team-sso.png` | `/dashboard/teams/:id/sso` | SSO configuration |
| `35-tags.png` | `/dashboard/tags` | tags |
| `36-mcp-tokens.png` | `/dashboard/mcp-tokens` | MCP personal tokens |
| `37-account-settings.png` | `/dashboard/settings` | profile, digest emails, password, 2FA |
| `38-notifications.png` | `/dashboard/notifications` | notification feed |
| `39-link-page.png` | `/dashboard/link` | device-code link flow |
| `40-docs-telemetry.png` | `/documentation/telemetry` | in-app documentation renderer |
| `90-pricing-billing-REMOVE.png` | `/dashboard/billing` | **remove**: plan card, portal |
| `91-pricing-usage-REMOVE.png` | `/dashboard/billing/usage` | **remove**: events quota/overage/forecast |
| `92-pricing-spend-controls-REMOVE.png` | `/dashboard/billing/spend-controls` | **remove**: overage budget, sampling, rate caps |
| `93-pricing-invoices-REMOVE.png` | `/dashboard/billing/invoices` | **remove**: invoices |
| `94-pricing-cost-attribution-REMOVE.png` | `/dashboard/billing/cost-attribution` | **remove**: cost drivers |
