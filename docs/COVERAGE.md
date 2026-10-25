# Feature coverage

What the upstream product does, and what we have. This exists because "we read
the SDK" and "we covered the product" are different claims, and only the second
one is worth making.

## How we know

| Evidence | What it gives | Where |
|---|---|---|
| Vendored SDK source (`repos/observe`, v0.3.17, MIT) | the wire contract: exactly what a collector must accept, and what the agent does with each reply | `docs/spec/ingest-api.md` |
| `llms-full.txt` — the product's own machine-readable docs, **2,223 lines**, 13 chapters | the *semantics*: what an alert evaluates, how an error budget is computed, what each issue state means | `docs/upstream/observe-docs/` |
| Dashboard JS bundle — 334 named chunks + the full REST surface | every route, page, component and endpoint the hosted app has | `docs/spec/dashboard-features.md`, `dashboard-api.md` |
| 48 screenshots of the authenticated app | layout, density, vocabulary, empty/loaded states | `docs/spec/screenshots/` |
| CDP traffic capture (~90 page loads) | real query params, response shapes, auth headers | `dashboard-api.md` §Transport |

The demo is mocked (`demo-api.nestjs.local` + a bundled service worker), so
response *values* are fake but *shapes and vocabulary* are real. The docs cover
the semantics the mock cannot show.

## Status key

**Built** — works, tested · **Partial** — the path works, the surface is thin ·
**Spec'd** — designed in `PLAN.md`/`docs/spec`, no code · **Missing** — not
designed yet · **Removed** — deliberately out of scope (pricing only)

---

## Access, identity, tenancy

| Upstream capability | Status | Notes |
|---|---|---|
| Email + password sign-up / sign-in | **Built** | `POST /api/v1/auth/{setup,login,logout}`, argon2id, email enumeration not distinguishable |
| Session tokens, revocation | **Built** | opaque 256-bit cookie, sha256 stored, 30-day expiry, "log out everywhere" on password reset |
| First-run admin bootstrap | **Built** | `/setup` self-locks; `OBSERVE_ADMIN_EMAIL`/`PASSWORD` for IaC. Both tested |
| Teams (a collection of users) | **Removed** | a tenant layer for a product with one tenant — see `SELF-HOSTED.md` §1 |
| Project ↔ team ownership | **Removed** | follows from the above; `project.teamId` kept nullable for a future multi-tenant mode |
| Project members with access levels **Read / Write / Admin** | Partial | schema + macros in place; no members UI or project-scoped enforcement yet |
| Issue author retains control regardless of role | Missing | rule, not a table; blocked on issues |
| SSO / SAML enforcement per verified domain | Missing | M4 |
| Invitations (single-use, 7 days, role bound server-side) | **Built** | API + CLI; no SMTP needed |
| Tags (labels on applications) | Missing | |
| Per-user 2FA | Missing | hosted app has it; not in the docs' access table |
| Notification inbox | Missing | `notifications` route exists upstream |
| Audit log | **Built** | `audit_log`, written by setup/login/invite/role/settings changes; API + `admin` CLI |
| Admin CLI | **Built** | `admin {info,create-user,reset-password,list-users,invite,set-setting,migrate,prune}` |
| Billing / plans / seats / spend caps / cost attribution | **Removed** | see `PLAN.md` §3.2 |

### Correction found while reading the docs

Upstream access levels are **Read, Write, Admin** — and the billing rows are the
only ones gated at Admin that we drop. Our schema invented
`owner/admin/member/viewer`; it will be changed to `read|write|admin` so a
permission check reads the same as the docs table, and "creator only" (delete
project, edit own issue) is a separate rule rather than a role.

---

## Telemetry and the dashboard

| Upstream capability | Status | Notes |
|---|---|---|
| Requests: rate, error rate, p50/p95/p99, status mix | Built | `rollup_minute` + merged histogram |
| Request details: per-operation, per-instance, slowest | Partial | list + detail; no compare-to-typical |
| Trace waterfall, self time, overlap from `startOffsetMs` | Built | `layoutWaterfall`, tested |
| Nested span tree, class/method attribution | Built | flattened with `parentId`/`depth`/`seq` |
| `observe.collapsed` ×N nodes | Built | stored as `collapsedCount`, rendered |
| Cross-service trace continuation (`x-request-id`) | Built | `/traces/:traceId` returns every execution |
| Errors: fingerprint grouping, occurrences, first/last seen | Built | |
| Error **source frames** (`e.codeFrames`) | **Partial** | schema + types fixed today; not rendered yet. Field is `codeFrames` on the error object, *not* `sourceContext` |
| Error status: open / resolved / ignored | Built | `PATCH /errors/:id` |
| Expected-error filters (mark as expected, not a bug) | Spec'd | feeds alerts' "unhandled only" rule |
| Logs: explorer, level/context filter, trace correlation | Partial | list + filter; no search index, no saved queries |
| Jobs: status, duration, attempts, `waitDuration` (backlog) | Partial | stored and listed; no job detail page, no p95 queue-wait chart |
| Cron / `@nestjs/schedule` jobs | Built | same path as queue jobs |
| Runtime metrics: CPU, memory, GC, event loop | Partial | stored; no profiler page |
| Custom metrics: counter / gauge (additive\|ratio\|peak) / summary | Partial | stored; no explorer page |
| Users: per-user activity, actions grouped, customer accounts | Missing | needs `u` (userId) rollups + grouping heuristics |
| Services / service map (treemap of dependencies) | Missing | derived from outbound-HTTP spans |
| Spans explorer (search by class/method) | Missing | endpoint exists upstream (`/telemetry/spans`) |
| Releases: timeline, affected errors | Partial | `release` table + ingest; no page |
| Regressions: "2.9.0 looks like a regression" | Missing | needs release-vs-previous comparison + the notify callout |
| Profiler (CPU flamegraph per process, span-tagged) | **Blocked** | `ObserveOptions.profiling` is commented out in the SDK and the collector's `/profiles` endpoints are unregistered: no data will ever arrive. We accept-and-drop and reserve the table |
| Sampling (per-project, on top of the agent's) | Spec'd | |
| Drop filters (server-side discard rules) | Spec'd | `drop_filter` table; not evaluated |
| Retention per data class | Partial | `retention_policy` table; no prune job |
| Custom operation-ID cap (100 live names / 30 days) | Missing | cardinality guard, not billing |

---

## Alerts — 8 metric families, two detection modes

Status: **Spec'd, not built.** `alert_rule`/`alert_event` exist; no evaluator.

| Upstream capability | Status |
|---|---|
| Request metrics: error rate, p95, avg, throughput | Missing |
| Job metrics: failure rate, throughput, p95 **queue wait** | Missing |
| **Absence**: telemetry silence, job silence (2 min → 7 days) | Missing |
| Logs: substring pattern (case-insensitive, ≥3 chars, level/context scoped) | Missing |
| Errors: new fingerprints only — **unhandled only** (5xx, or no-status entrypoints); ignored/expected never count | Missing |
| Runtime: event-loop delay, CPU, memory | Missing |
| Custom metric rules | Missing |
| SLO burn-rate rules (threshold = multiple of sustainable burn) | Missing |
| Fixed threshold **and** anomaly detection (σ sensitivity, default 3.5) | Missing |
| Evaluation window: 5/10/15/30/60/180 min | Missing |
| Severity: Low/Medium/High/Critical | Missing |
| Channels: email, Slack webhook, generic webhook, create issue, in-app | Missing |
| Quiet hours: recurring windows, timezone-aware, "muted ≠ OK" | Missing |
| History: OK → Firing → Resolved, per-channel delivery status | Missing |
| Built-in "new error" digest (≤6/project/day, throttled) | Missing |

Two details worth carrying into the design: **a scope that has never reported
anything never fires** ("not yet integrated" ≠ "down"), and **muted is a state of
its own** — a firing rule stays firing through a quiet window.

---

## SLOs

Status: **Partial** — `@Objective()` declarations are ingested into `slo`; no
budget computation, no page.

| Upstream capability | Status |
|---|---|
| SLI kinds: availability, latency-under-threshold, **job success** | Partial (first two) |
| Windows 7 / 14 / 28 / 30 days | Built (stored) |
| Declared in code (`@Objective`), owned by code, restated hourly | Built (ingest + upsert) |
| "No traffic isn't failure" | Missing (evaluation rule) |
| Error budget remaining, burn rate | Missing |
| Burn-rate alert policies: fast 1 h / 14.4×, slow 6 h / 6×, trickle 3 d / 1× | Missing |
| Retention is the ceiling on achievable window | Missing (must be enforced) |

---

## Issues — the work tracker over telemetry

Status: **Missing entirely.** This is the largest untouched surface: the hosted
app's biggest nav section.

| Upstream capability | Status |
|---|---|
| States: open, in-progress, blocked, on-hold, review, verifying, resolved, closed | Missing |
| Severity, assignee, due date, attachments | Missing |
| Comments (+ delete own, admin deletes any) | Missing |
| Links to traces / error groups / alerts; incident view | Missing |
| Auto-create from an alert ("create issue" channel) | Missing |
| Author-only editing rights regardless of role | Missing |

---

## MCP server

Status: **Missing.** `docs/spec` documents the *dashboard's* API, not the MCP
surface; upstream has a dedicated chapter.

Needs: tool catalog (query telemetry, issues, alerts), token issuing
(`mcp-tokens` page exists upstream), and auth scoped to a project.

---

## Things the docs settled that we had guessed

| Question | Answer |
|---|---|
| Is `degraded` the only quota signal? | Yes, and it is entirely billing. We answer `false` forever — confirmed. |
| Do API keys identify an application or a project? | **A project.** "API keys are scoped to a project: any application whose telemetry should land in that project's dashboard uses the same key." Our `app_credential.application_id` is wrong and will move to the project. |
| Source frames: `sourceContext` or `codeFrames`? | `codeFrames` on the error object; `sourceContext` is only the SDK *option* name. |
| Roles? | Read / Write / Admin, with "creator only" as a rule, not a role. |
| Alert evaluation windows? | 5/10/15/30/60/180 min; silence rules use a tolerance instead. |
| Are job failures error groups? | **No.** "A failed job doesn't open an error group." Our ingest currently does create one — a real bug. |

---

## Score

Of 74 documented capabilities: **21 built, 13 partial, 13 spec'd, 22 missing,
1 blocked upstream (profiler), 6 removed (pricing + SaaS tenancy).**

The plan's M1 (auth, teams, RBAC) and M3 (SLOs, alerts, issues) are the bulk of
the gap. Nothing is *unknown* any more — the remaining work is implementation,
not discovery.
