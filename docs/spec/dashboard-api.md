# Dashboard HTTP API (reverse-engineered)

The API of the **hosted dashboard itself** — what the SPA calls, not the SDK
ingest protocol (that is `docs/spec/ingest-api.md`).

## How this was derived

| Source | What it gives | Path in this repo |
| --- | --- | --- |
| Live demo SPA bundle (Vite, minified), 334 chunks, both builds | every REST call site, every mock handler, DTO field names, enum values | `/tmp/obs/assets/*.js` (scratch) |
| Browser traffic (headless Chromium + CDP, ~90 page loads) | real URLs, query params, response bodies, auth headers, SSE | `/tmp/obs/cap-*/net-*.json` (scratch) |
| MSW handler registry in `start-*.js` (`j.get("*/me/…")`) | the demo's *own* implementation of each endpoint, incl. response defaults | `mock-paths.txt` (scratch) |

**Important:** the demo does **not** talk to a public server. `API_URL` is
`https://demo-api.nestjs.local` and every response comes from a **Mock Service
Worker** bundled into the SPA (`/__demo/ready`, `navigator.serviceWorker`
controller present, `localStorage.accessToken = "demo-access-token"`). So:

- **Endpoint + query-param shapes are real** — they are what the real client
  sends (observed in traffic, and every `fetch` is built by the same client code).
- **Response bodies are the demo dataset** — field names are trustworthy (the UI
  renders them), exact values are not; ignore all dates/counts/ids.
- Anything marked *bundle-only* exists in the client's mock registry but was not
  fired during the crawl (usually a write/mutation, or a branch not reached).

Confidence legend: **T** = confirmed by observed traffic · **B** = inferred from
bundle (mock handler and/or call site) · **U** = unknown / not observable.

## Transport, auth, conventions

| Item | Finding | Conf |
| --- | --- | --- |
| Base URL | `API_URL` module constant; no `/v1` path prefix, no versioning header | T |
| Auth | `Authorization: Bearer <accessToken>` + `Accept: application/json` + `Content-Type: application/json` on every call | T |
| Token storage | `localStorage.accessToken`, `localStorage.refreshToken` (keys literally `accessToken`/`refreshToken`) — **not** cookies | T |
| Refresh | `POST /authentication/refresh-tokens` with `{refreshToken}`; guarded by `navigator.locks.request("whisprr:refresh-tokens", …)` so parallel 401s do one refresh | B |
| 401 handling | on `NotAuthorized` refresh once, retry; second failure → sign-out (SSE stream does the same and then reports `onFatal`) | B |
| Path user scope | everything user-scoped is under `/me/…` — there is no `:orgId`/`:accountId` in any path | T |
| Project addressing | `/me/projects/:projectId/…` takes the **UUID**; `/me/projects/public/:publicId/…` takes the URL slug (`storefront-99063`). The SPA resolves the slug → project on every project page load | T |
| Team addressing | `/me/teams/:publicTeamId/…` (slug, e.g. `platform-81248`) | T |
| Issue addressing | `/me/issues/:publicId` (slug, e.g. `checkout-times-out-on-orders-over-500-43292`) | T |
| Alert addressing | `/me/alert-rules/:publicId` (slug, e.g. `storefront-error-rate-48853`) | T |
| SLO addressing | `/me/projects/:projectId/slos/:publicId` (slug, e.g. `storefront-availability-45151`) | B |
| Time window, charts | single `timeInterval` enum: `1h\|3h\|12h\|1d\|3d\|7d\|30d` — no `from`/`to` on telemetry endpoints | T |
| Time window, logs | explicit `from`/`to` ISO-8601 + `limit` + optional `cursor` + `search` + `level[]` + `applicationId` | T |
| Pagination (lists) | no page numbers: `rowsPerPageCount` (tables), `limit` (feeds), server returns `totalCount`, or cursor pagination (`nextCursor`, `searchedFrom`) for logs | T |
| Retention signalling | responses carry `retentionFloor` (oldest bucket) and `timeRanges`/`lockedTimeRanges`; `GET …/telemetry/retention` returns `{retentionDays, lockedTimeRanges, degraded, paced, upgrade}` → the UI greys out ranges | T |
| Error body | `{"message": "Project not found"}` + HTTP status; client maps status → codes (`BadRequest/Forbidden/NotFound/NotAuthorized`) | B |
| Response casing | camelCase throughout; enums sent lowercase strings (`error_rate`, `p95_latency`, `job_failure_rate`, …) | T |
| SSE | live log tail is `Accept: text/event-stream` over `fetch` (not `EventSource`), client parses the stream itself and falls back to list backfill on gaps | B |

## Endpoint inventory

### Session, account, notifications

| Method | Path | Query / body | Response | Conf |
| --- | --- | --- | --- | --- |
| GET | `/me` | — | `{id,email,firstName,lastName,key,avatarUrl,tfaEnabled,isPasswordSet,githubLogin,hasActiveSubscription,subscription}` | T |
| GET | `/me/details` | — | account detail record | B |
| GET | `/me/search` | `q` U | global search results | B |
| GET | `/me/notifications` | `limit` | `{notifications[],info,success,error,unread}` | T |
| PATCH | `/me/notifications/:id/mark-as-read` | — | `{…}` | B |
| PATCH | `/me/notifications/mark-all-as-read` | — | `{…}` | B |
| GET | `/me/digest-settings` | — | `{weeklyDigest,newErrorEmails}` | T |
| PATCH | `/me/digest-settings` | `{weeklyDigest?,newErrorEmails?}` | updated record | B |
| GET | `/me/mcp-tokens` | — | `[{id,name,createdAt,expiresAt,lastUsedAt}]` | T |
| POST | `/me/mcp-tokens` | `{name,expiresInDays?}` | token + `token: "omcp_…"` (shown once) | B |
| DELETE | `/me/mcp-tokens/:id` | — | `{…}` | B |
| POST | `/authentication/2fa/generate` | — | PNG QR image (`Content-Type: image/png`) | T |
| POST | `/authentication/sign-in` | `{email,password}` | access/refresh tokens | B |
| POST | `/authentication/refresh-tokens` | `{refreshToken}` | access/refresh tokens | B |
| GET | `/admin/stats` | — | platform admin counters (internal, `/dashboard/platform`) | B |

### Projects, applications, members, keys, tags, teams

| Method | Path | Query / body | Response | Conf |
| --- | --- | --- | --- | --- |
| GET | `/me/projects` | — | `[{id,publicId,name,avatar,archived,teamId,teamPublicId,createdById,createdAt,applicationsCount,teamMembersCount,isOwner,team,subscription}]` | T |
| GET | `/me/projects/:projectId` | — | project record | T |
| GET | `/me/projects/public/:publicId` | — | `{project,access}` (`access: admin\|write\|read`) | T |
| GET | `/me/projects/:projectId/applications` | — | `[{id,publicId,displayName,name,archived,projectId,createdAt,forwardLogs,tags}]` | T |
| GET | `/me/projects/:projectId/members` | — | `[{id,firstName,lastName,email,githubLogin,gitlabLogin,bitbucketLogin,avatarUrl,updatedAt,access}]` | T |
| GET | `/me/projects/:projectId/api-keys` | — | `[{id,name,createdAt,expiresAt,lastUsedAt,createdById,projectId,applicationId}]` | T |
| POST | `/me/projects/:projectId/api-keys` | `{name,applicationId,expiresAt?}` | `{apiKey:"obs_pk_…",apiSecret:"obs_sk_…"}` (secret once) | B |
| POST | `/me/projects/credentials/validate` | credentials | validation result (SDK/CLI path) | B |
| GET | `/me/projects/telemetry-summary` | — | `{<projectId>: {id, data:[{bucket,avgDuration,requestsPerSecond,errorRate,requestCount,errorCount,unhandledErrorCount}]}}` | T |
| GET | `/me/projects/:projectId/telemetry-summary` | — | same, single project | T |
| GET | `/me/teams` | — | `[{id,publicId,name,archived,createdById,createdAt,isOwner,membersCount,users}]` | T |
| GET | `/me/teams/:publicTeamId` | — | team record | T |
| GET | `/me/teams/:publicTeamId/members` | — | `[{id,entityId,firstName,…,pending}]` | T |
| GET | `/me/teams/:publicTeamId/tags` | — | tag list | T |
| GET | `/me/tags` | — | `[{id,label,createdAt,isOwner,isTeamOwner,team}]` | T |

Team/project member and tag mutations (add/remove/patch, SSO config) are
**bundle-only** (B): `/me/*` catch-all handlers exist in the mock; the concrete
paths are `POST/PATCH/DELETE` on the same collection URLs.

### Telemetry: project dashboard

| Method | Path | Query | Response | Conf |
| --- | --- | --- | --- | --- |
| GET | `/me/projects/:projectId/telemetry/dashboard` | `timeInterval` | `{requests,requestsPreviousSeries,jobs,jobsPreviousSeries,slowRoutes,highThroughputRoutes,requestsSummary,jobsSummary,timeRanges,retentionFloor}` | T |
| GET | `/me/projects/:projectId/telemetry/retention` | — | `{retentionDays,lockedTimeRanges,degraded,paced,upgrade}` | T |

### Telemetry: requests

| Method | Path | Query | Response | Conf |
| --- | --- | --- | --- | --- |
| GET | `/me/projects/:projectId/telemetry/requests` | `timeInterval`, `applicationId`, `rowsPerPageCount`, `sortBy`, `search` | `{requests,previousSeries,tableData,summary,timeRanges,retentionFloor,totalCount}` | T |
| GET | `/me/projects/:projectId/telemetry/requests/details` | `timeInterval`, `applicationId`, `method`, `operationId`, `rowsPerPageCount` | + `rankedFrom`, `durationDistribution` | T |
| GET | `/me/projects/:projectId/telemetry/requests/:entityId/details` | — | `{id,traceId,protocol,originalUrl,method,statusCode,duration,tags,traces,error,capturedRequest,userId,serviceVersion,timestamp,applicationName}` | T |

`entityId` observed format: `req-<applicationIndex>-<n>-<epochMs>-<k>` (demo
generator); treat as opaque string. The UI builds it as
`/dashboard/projects/:publicId/requests/${encodeURIComponent(requestId)}/details`.

The sibling detail endpoints are addressed the same way the UI addresses them
(the UI route carries the selector in the query string, and the same keys are
forwarded to the API): `errors/details` → `error` + `statusCode`,
`jobs/details` → `queue` + `name`, `spans/details` → `span`,
`users/details` → `userId`, `customs/details` → `name` + `label`. Their exact
server-side parameter names beyond those are **bundle-only** (B).

### Telemetry: traces and spans

| Method | Path | Query | Response | Conf |
| --- | --- | --- | --- | --- |
| GET | `/me/projects/:projectId/telemetry/traces/:traceId` | — | trace with full span tree (spans, timings, kinds, errors) | B |
| GET | `/me/projects/:projectId/telemetry/traces/:traceId/logs` | — | log lines correlated to the trace | B |
| GET | `/me/projects/:projectId/telemetry/spans` | `timeInterval`, `spanType`, `search` | `{spanWindow,tableData,summary,timeRanges,retentionFloor,spanTypes}` | T |
| GET | `/me/projects/:projectId/telemetry/spans/details` | `timeInterval`, `spanType`, `search` | span aggregate detail | B |
| GET | `/me/projects/:projectId/telemetry/spans/:entityId/details` | — | single-span executions (`{…summary,p95Duration,invocations,errors,…}`) | B |
| GET | `/me/projects/:projectId/telemetry/classes` | `timeInterval`, `sortBy=selfDuration`, `limit`, `search` | `{classes,total}` | T |
| GET | `/me/projects/:projectId/telemetry/classes/:className/methods` | `timeInterval` | method-level own/total time | B |
| GET | `/me/projects/:projectId/telemetry/service-map` | `timeInterval` | `{nodes,edges}` | T |

### Telemetry: errors

| Method | Path | Query | Response | Conf |
| --- | --- | --- | --- | --- |
| GET | `/me/projects/:projectId/telemetry/errors` | `timeInterval`, `status`, `search` | `{tableData,summary,timeRanges,retentionFloor,requests}` | T |
| GET | `/me/projects/:projectId/telemetry/errors/details` | `timeInterval` | error aggregate detail | B |
| GET | `/me/projects/:projectId/telemetry/errors/:entityId/details` | — | one error group: occurrences, stack, trace, release | B |
| GET | `/me/projects/:projectId/telemetry/errors/affected-users` | `timeInterval` | affected user list | B |
| GET | `/me/projects/:projectId/telemetry/error-groups` | — | error groups (fingerprint-keyed) | B |
| PATCH | `/me/projects/:projectId/telemetry/error-groups/:fingerprint/status` | `{status}` | `open\|resolved\|ignored\|expected` | B |
| POST | `/me/projects/:projectId/telemetry/error-groups/:fingerprint/issue` | `{…}` | creates an issue from a group | B |
| GET | `/me/projects/:projectId/error-filters` | — | project-level ignore/hide rules | B |
| PUT | `/me/projects/:projectId/error-filters` | rule set | updated rule set | B |

### Telemetry: logs

| Method | Path | Query | Response | Conf |
| --- | --- | --- | --- | --- |
| GET | `/me/projects/:projectId/telemetry/logs` | `from`,`to`,`limit`,`cursor`,`search`,`level`(repeatable),`applicationId` | `{rows,nextCursor,searchedFrom,retentionFloor}` | T |
| GET | `/me/projects/:projectId/telemetry/logs/tail` | `applicationId`,`level`,`search` | SSE stream (`text/event-stream`), rows as events | B |

Log row shape (T): `{id,traceId,spanId,level,context,message,attributes,timestamp,applicationName}`.

### Telemetry: jobs

| Method | Path | Query | Response | Conf |
| --- | --- | --- | --- | --- |
| GET | `/me/projects/:projectId/telemetry/jobs` | `timeInterval`, `queueName`, `search` | `{jobs,previousSeries,tableData,summary,timeRanges,retentionFloor}` | T |
| GET | `/me/projects/:projectId/telemetry/jobs/details` | `timeInterval`, `operationId`, `queueName` | job aggregate detail | B |
| GET | `/me/projects/:projectId/telemetry/jobs/:entityId/details` | — | single run: `status,queueName,jobId,attemptsMade,failedReason,enqueuedAt,waitDuration,duration,traceId,tags` | B |

### Telemetry: users / tenants / custom metrics / regressions / profiler

| Method | Path | Query | Response | Conf |
| --- | --- | --- | --- | --- |
| GET | `/me/projects/:projectId/telemetry/users` | `timeInterval`,`sortBy`,`search` | `{aggregatedUsers,tableData,summary,timeRanges,retentionFloor}` | T |
| GET | `/me/projects/:projectId/telemetry/users/details` | `timeInterval`,`userId` | one user's summary + operation list | B |
| GET | `/me/projects/:projectId/telemetry/users/activity` | `userId`,`from`,`to` | activity timeline / paths | B |
| GET | `/me/projects/:projectId/telemetry/tenants` | `timeInterval`,`sortBy` | `{tenants,totals}` | T |
| GET | `/me/projects/:projectId/telemetry/tenants/:tenant/users` | `timeInterval` | users in tenant | B |
| GET | `/me/projects/:projectId/telemetry/customs` | `timeInterval`,`search` | `{tableData,timeRanges,retentionFloor}` | T |
| GET | `/me/projects/:projectId/telemetry/customs/details` | `timeInterval`,`metric` | one metric series | B |
| GET | `/me/projects/:projectId/telemetry/customs/details/batch` | `timeInterval`, `metrics` = **JSON array of `{name,label}`** (URL-encoded) | `{metrics}` | T |
| GET | `/me/projects/:projectId/telemetry/regressions` | `timeInterval` | `{releases,windowMinutes,timeRanges,retentionFloor}` | T |
| GET | `/me/projects/:projectId/telemetry/regressions/changes` | `version`,`windowMinutes` | `{version,firstSeenAt,windowMinutes,before,after,status,changes}` | T |
| GET | `/me/projects/:projectId/telemetry/profiler` | `timeInterval`,`serviceNode` | `{timeRanges,retentionFloor,autoSelectedApplicationName,serviceNodes,acrossNodes,cpuMemoryPercentages,memoryByCategory,cpuByCategory,gcDurationByCategory,gcCountByCategory,eventLoop,summary}` | T |
| GET | `/me/projects/:projectId/profiler-snapshots` | — | `{<applicationId>: …}` snapshot index | T |
| GET | `/me/projects/:projectId/profiles/flamegraph` | `snapshotId` | flamegraph tree | B |
| GET | `/me/projects/:projectId/profiles/functions` | `snapshotId` | flat function list (self/total) | B |
| GET | `/me/projects/:projectId/profiles/coverage` | `snapshotId` | profiled/unprofiled coverage | B |

### SLOs

| Method | Path | Query | Response | Conf |
| --- | --- | --- | --- | --- |
| GET | `/me/projects/:projectId/slos` | — | `[{id,publicId,name,description,projectId,applicationId,applicationName,sli,objective,status,declaredIn,declaredVersion,createdAt,updatedAt}]` | T |
| GET | `/me/projects/:projectId/slos/:publicId` | — | SLO + `status{sli,budgetRemaining,burnRate1h,firingAlertCount}` | B |
| GET | `/me/projects/:projectId/slos/:publicId/timeseries` | `timeInterval` | `{…, buckets:[{bucket,sli}], budgetSeries:[{bucket,budgetRemaining}]}` | B |
| POST/PATCH/DELETE | `/me/projects/:projectId/slos[/:publicId]` | SLO form | CRUD | B |

### Alerts

| Method | Path | Query / body | Response | Conf |
| --- | --- | --- | --- | --- |
| GET | `/me/alert-rules` | — | `[{id,publicId,name,projectId,projectPublicId,projectName,applicationId,applicationName,metric,detectionMode,comparison,threshold,windowMinutes,operationId,method,customMetricName,customMetricLabel,sloId,queueName,logPattern,logLevels,logContext,severity,enabled,…}]` | T |
| GET | `/me/alert-rules/count` | — | `{firing,total}` (sidebar badge) | T |
| GET | `/me/alert-rules/:publicId` | — | single rule | T |
| PATCH | `/me/alert-rules/:publicId` | partial rule / `{enabled}` | updated rule | B |
| GET | `/me/alert-events` | `since`, `limit`, `ruleId`, `projectId`? | `[{id,ruleId,ruleName,projectId,projectPublicId,projectName,applicationName,metric,detectionMode,comparison,threshold,observedValue,severity,operationId,method,customMetricName,customMetricLabel,queueName,logPattern,lastSeenAt,sampleLogLines,state,startedAt,…}]` | T |
| DELETE | `/me/alert-rules/:publicId` | — | confirmation | B |

### Issues

| Method | Path | Query / body | Response | Conf |
| --- | --- | --- | --- | --- |
| GET | `/me/issues` | `projectId`, `limit`, status via path in UI | `{data,count}` | T |
| GET | `/me/issues/count` | — | `{count}` per status bucket (sidebar badge `14`) | B |
| GET | `/me/issues/:publicId` | — | `{id,issueKey,publicId,title,archived,severity,description,status,activityRecords,assignedTo,submittedBy,applicationId,projectId,project,attachments,dueDate,createdAt,updatedAt,fixedInVersion,resolvedAt,verification,linkedEntityType,linkedEntityId,linkedTraceId,…}` | T |
| GET | `/me/issues/:publicId/incident` | — | `{subject,startedAt,endedAt,introducedIn,impact,fix,timeline}` | T |
| POST | `/me/issues` | issue form | created issue | B |
| PATCH | `/me/issues/:publicId` | partial issue | updated issue | B |
| DELETE | `/me/issues/:publicId` | — | — | B |

### Commercial endpoints (present in the API, to be removed from the clone)

`GET /prices`, `GET /me/subscription`, `GET /me/subscription/details`,
`GET /me/subscription/session`, `GET /me/subscription/portal`,
`GET /me/subscriptions/portal`, `GET /me/subscription/payments-history`,
`GET /me/usage`, `GET /me/usage/history?months=`, `GET /me/usage/timeseries`,
`GET /me/spend-controls` (+ 10 `PUT/POST /me/spend-controls/…`),
`GET /me/projects/:projectId/usage/cost-attribution?limit=`,
`GET|POST /me/annual-switch`, `/me/annual-switch/preview`, `/me/annual-switch/dismissal`,
`GET|POST /me/upgrade-feedback`, `/me/upgrade-feedback/impression`, `/me/upgrade-feedback/dismissal`.
All marked T except the `/prices` and `upgrade-feedback` POSTs (B). See
`dashboard-features.md` §Pricing surfaces.

## Things the client does that a server must support

| Behaviour | Detail | Conf |
| --- | --- | --- |
| Slug → project resolution | every project page first calls `/me/projects/public/:slug`, then uses the returned UUID for all telemetry calls | T |
| 404 on wrong slug shape | passing a UUID to `/me/projects/public/:uuid` returns `404 {message:"Project not found"}` | T |
| Polling cadence | dashboard charts re-poll (~60 s); the `params-bar` says "Charts on this page refresh every minute" | T |
| Retention-aware ranges | `timeRanges`/`lockedTimeRanges` + `retentionFloor` decide which of `1h/3h/12h/24h/3d/7d/30d` are clickable; disabled ranges are dimmed with tooltip "Not enough data to select this range yet" | T |
| Previous-period series | most telemetry responses return `previousSeries` alongside the current series to render the `−18% since last period` deltas | T |
| Application scoping | `applicationId` is an optional query param on every telemetry endpoint (the `All applications` selector) | T |
| Live log tail | SSE over `fetch` + `Authorization` header; on disconnect the client reconnects with backoff and backfills missed windows through the list endpoint | B |
