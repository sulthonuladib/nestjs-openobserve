# Ingest API specification — `@nestjs/observe` → collector

Implementation-ready description of the HTTP contract the vendored SDK speaks, so
a self-hosted collector (Bun + ElysiaJS) can accept its telemetry without an SDK
patch. Every claim is cited from the vendored source.

**Scope decision (per `AGENTS.md`): the collector implements none of the
quota machinery.** All degraded-ingest modes (`reduced`, `trimmed`,
`paced`, `errors-only`) are billing concepts. We answer every accepted batch with
`200 {"degraded":false}` and never trim, pace or withhold anything server-side.
The flags are documented in §5.2 only so nobody re-introduces them by accident,
and so an engineer reading the SDK knows why the agent is asking.

## 0. Provenance

| Item | Value |
| --- | --- |
| Package | `@nestjs/observe` |
| Version | **0.3.17** (`repos/observe/package.json:3`) |
| Vendored commit | `84ee3e31d94f15a5eb751c7f84ef762a0365002f` |
| Node floor | `>= 20.19.0` — ESM-only, `require(esm)`-compatible (`repos/observe/package.json`) |
| Wire contract module | `src/agent/telemetry-wire-contract.ts` |
| Transport | Node `http`/`https` from a worker thread, raw gzip (`src/agent/detached-observe-worker.ts`) |

Citation shorthand: paths are relative to `repos/observe/`. **Authority order:**
`telemetry-wire-contract.ts` is the SDK's own copy of what the API accepts, and
the encoders are what it emits. Where they disagree the contract wins, because
that is what a `400` is judged against (`src/agent/telemetry-wire-contract.ts:1-30`).

## 1. Endpoints

| # | Method | Path | Body | Encoding | Caller |
| --- | --- | --- | --- | --- | --- |
| 1 | `POST` | `/applications/telemetry` | telemetry batch (§3) | **gzip**, `application/json` | worker (`src/agent/detached-observe-worker.ts:66`) |
| 2 | `POST` | `/applications/profiles` | profile windows (§3.9) | identity JSON | `ProfileUploader` (`src/profiling/profile-uploader.ts:118`) |
| 3 | `POST` | `/cli-link/sessions` | `{ applicationName, hostname }` | identity JSON | CLI (`src/cli/link.ts:107-110`) |
| 4 | `POST` | `/cli-link/token` | `{ deviceCode }` | identity JSON | CLI poll (`src/cli/link.ts:277-282`) |

- **One base URL** serves all four. `endpoint` is the base without a trailing
  path; `/applications/telemetry` is appended verbatim
  (`src/agent/detached-observe-worker.ts:66`).
- **Default host** `https://observe-api.nestjs.com`
  (`src/agent/observe-agent.worker.ts:43`), overridable by the `endpoint` option,
  else env `OBSERVE_ENDPOINT` (`:47-50`; CLI side `src/cli/observe-cli.ts:61-63`).
- **No GET endpoints, no registration.** The SDK never reads anything back; app,
  project and service are carried in credentials or the payload.
- The hosted collector is special-cased **by hostname** for two decisions
  (suppress unauthenticated sends, wording): `src/agent/observe-agent.worker.ts:578-592`.
  Any other host is self-hosted, which is what we want.
- A trailing slash on `endpoint` yields `…//applications/telemetry` — the worker
  does not normalise it, the CLI does. Tolerate it.
- Profiles are unreachable in 0.3.17 (§3.9); implement the route as a stub only.

## 2. Authentication

### 2.1 Headers on the telemetry POST

| Header | Value | When |
| --- | --- | --- |
| `Content-Type` | `application/json` | always (`src/agent/detached-observe-worker.ts:105`) |
| `Content-Encoding` | `gzip` | always (`:106`) |
| `x-observe-ingest-modes` | `reduced, trimmed, paced, errors-only` | always, credentials or not (`:108-113`; pinned by `src/agent/worker-degraded-reply.spec.ts:272-274`) |
| `x-api-key` | `appKey` | only when **both** credentials are set (`:116-120`) |
| `x-api-secret` | `appSecret` | only when **both** are set — omitted entirely, never empty |
| `Content-Length` | compressed byte length | always (`:339`) |

No `x-request-id`, no trace header, no `User-Agent` set by the agent, and the
agent must never trace its own ingest requests
(`src/agent/collector-transport.int-spec.ts:149-192`).

### 2.2 Credential sourcing

- Options, falling back to `OBSERVE_APP_KEY` / `OBSERVE_APP_SECRET` when absent
  **or still holding the `nest new` placeholders** `YOUR_APP_KEY` /
  `YOUR_APP_SECRET` (`src/observe.module.ts:88-131`).
- Placeholder pair ⟹ nothing is sent, no worker started, one info line
  (`src/agent/observe-agent.worker.ts:91-92,161-180,548-550`;
  `src/agent/scaffold-credentials.int-spec.ts`).
- Missing pair **and** hosted endpoint ⟹ nothing sent, one warning
  (`:586-596,598-605`; `src/agent/missing-credentials.int-spec.ts`).
- Missing pair **and** any other host ⟹ batches sent **without** the credential
  headers and must be accepted (`src/agent/unauthenticated-collector.int-spec.ts:66-80`).
- Credentials are read **once at startup**; fixing them needs a restart
  (`src/agent/detached-observe-worker.ts:568-572`).

### 2.3 Policy

Two defensible policies; **the default must be placeholder mode**, because that
is the only one that works for an `endpoint`-only install:

| Policy | Behaviour | Effect on the agent |
| --- | --- | --- |
| **Placeholder (default)** | accept anything, credentials or not | zero friction; no auth loop |
| **Enforced** | unknown/mismatched pair → `401` | backoff to 1 attempt/hour, one log line — §5.4 |

If enforcing, key the pair to an application. `x-api-secret` is a bearer secret:
it is only safe over TLS, and the SDK merely warns on plain `http://`
(`src/agent/observe-agent.worker.ts:605-641`).

## 3. Wire payload

### 3.1 Batch envelope

Root shape `src/agent/telemetry-wire-contract.ts:295-336`; assembled at
`src/agent/observe-agent.shared-buffer.ts:747-759`.

| Key | Type | Bounds | Meaning |
| --- | --- | --- | --- |
| `serviceId` | string | ≤ 100, **required** | Service identity. Cut by the SDK to first-91 + hash, so two long ids stay distinct (`src/observe.module.ts:68-86`) |
| `serviceVersion` | string | ≤ 50 | Release / commit. Absent when `serviceVersion: false` or nothing inferred (`src/observe.module.ts:142-165`) |
| `truncatedSpans` | number | — | Spans/logs the agent withheld, in billed units (§4.5). Absent when 0 |
| `forwardLogs` | boolean | — | Log forwarding on/off for this process; sent on **every** batch, `logs` present or not (`src/agent/observe-agent.shared-buffer.ts:172,751`) |
| `snapshots` | array | ≤ 5000 | Request/operation snapshots (§3.2) |
| `jobs` | array | ≤ 5000 | Job snapshots (§3.4) |
| `runtime` | object | — | One runtime-metrics sample (§3.5) |
| `custom` | array | ≤ 5000 | Custom metric readings (§3.6) |
| `logs` | array | ≤ 5000 | Forwarded log lines (§3.7) |
| `objectives` | array | ≤ 100 | `@Objective` declarations (§3.8) |

`MAX_BATCH_ITEMS = 5000` (`src/agent/telemetry-wire-contract.ts:74`).

**`st` must not be accepted.** `startTimestamp` is mapped by both snapshot
encoders but deliberately absent from the contract; the API's
`forbidNonWhitelisted` pipe refuses it, and `OperationTraceRegistry.endTrace`
deletes it before encoding (`src/agent/telemetry-wire-contract.ts:14-20,132-149`;
`src/encoders/encoders.spec.ts:373-399`). Answer `400` — that is the correct
signal, and the agent's repair path resends without it (§5.3).

Unknown keys anywhere else are equally fatal (`:17-20`;
`src/testing/fake-collector.ts:31-34`). One documented exception: inside `a` the
API "takes the attributes as one object and checks none of its keys"
(`src/agent/telemetry-wire-contract.ts:104-114`).

A batch carrying only `serviceId`, `snapshots: []` and `forwardLogs` is legal and
common — the first batch of a process is usually runtime metrics alone with no
traffic yet (`src/agent/observe-agent.worker.ts:718`,
`src/agent/observe-agent.shared-buffer.ts:747-759`).

### 3.2 Request snapshot — `snapshots[]`

Contract `src/agent/telemetry-wire-contract.ts:132-149`; encoder
`src/encoders/request-snapshot.encoder.ts:6-67`.

| Key | Source | Type | Req | Bounds | Meaning / units |
| --- | --- | --- | --- | --- | --- |
| `ti` | `traceId` | string | **yes** | ≤ 255 | Trace id: UUIDv7, or a propagated `x-request-id` matching `^[A-Za-z0-9._:-]{1,128}$` (`src/utils/uuid-v7.util.ts:18-37`, `src/utils/default-trace-id-generator.util.ts:14`) |
| `op` | `operationId` | string | **yes** | — | Route, message pattern, GraphQL root field, or a `setOperationId` name. A snapshot with no operation id is dropped by the agent and never sent (`src/agent/observe-agent.shared-buffer.ts:237-256`) |
| `p` | `protocol` | string | no | — | `"http"`/`"https"` (transport), `"graphql"`, `"ws"`, or the microservice transport name (`"TCP"`, `"GRPC"`, …) (`src/protocols/http-observe-agent.service.ts:215`, `src/protocols/rpc-observe-agent.service.ts:159-163`, `src/protocols/ws-observe-agent.service.ts:189`, `src/protocols/graphql-observe-agent.service.ts:29,382`) |
| `d` | `duration` | number | no | — | **Milliseconds, fractional** (`src/encoders/encoders.spec.ts:255`) |
| `ct` | `calledAt` | string | no | — | ISO-8601 wall clock at trace start: `new Date().toISOString()` (`src/services/operation-trace.registry.ts:268`) |
| `u` | `userId` | string | no | — | From the `getUserId` hooks |
| `tg` | `tags` | object | no | — | `Record<string, string\|number\|boolean>`, free-form, not key-checked |
| `a` | `attributes` | object | no | — | §3.2.1 |
| `e` | `error` | object | no | — | `{ cls?, message (required), stack?, tags? }` (`src/interfaces/request-snapshot.interface.ts:58-67`) |
| `rq` | `request` | object | no | — | Captured inputs of a failed/slow request, §3.2.2 |
| `t` | `traces` | array | **yes** | — | Trace tree; **`[]` when there are no spans**, never omitted (`src/agent/telemetry-wire-contract.ts:111-130`) |

#### 3.2.1 `a` — protocol attributes

| Key | Type | Meaning |
| --- | --- | --- |
| `m` | string | HTTP method, or the GraphQL operation type |
| `sc` | number | HTTP status code — drives error grading (§6.2) |
| `ou` | string | Original URL; for GraphQL, the sanitized document |
| `dop` | string | The route a `setOperationId` name replaced. **Presence marks the snapshot as renamed** (`src/interfaces/request-snapshot.interface.ts:99-119`) |

#### 3.2.2 `rq` — captured request

`{ headers?: Record<string,string>, body?: string, bodyTruncated?: true }`
(`src/utils/capture-request.util.ts:49-53`). Present only for a failed request or
one slower than `http.capture.slowerThanMs` (`:66-83`). Header values ≤ 512
chars, body ≤ 16 KiB, already redacted. Store as JSON, never interpret.

#### 3.2.3 Annotated example (request-snapshot encoder)

```jsonc
{ "ti": "018f3a6c-1b2c-7d3e-8f40-9a1b2c3d4e5f",  // traceId, UUIDv7
  "op": "GET /orders/:id",                       // operationId (required)
  "p":  "http",                                  // protocol
  "ct": "2026-10-25T06:00:00.123Z",              // calledAt, ISO-8601
  "d":  412.7348,                                // duration, ms (fractional)
  "u":  "user_812",                              // userId
  "tg": { "env": "production" },                 // tags, free-form
  "a":  { "m": "GET",                            // method
          "sc": 200,                             // statusCode
          "ou": "/orders/812?expand=items",      // originalUrl
          "dop": "/orders" },                    // only on a renamed request
  "e":  { "cls": "Error",                        // absent when no error
          "message": "boom",
          "stack": "Error: boom\n    at OrdersService.findOne …",
          "tags": { "retryable": false } },
  "rq": { "headers": { "user-agent": "curl/8", "content-type": "application/json" },
          "body": "{\"expand\":\"items\"}",
          "bodyTruncated": true },               // only when cut at maxBytes
  "t":  [ …spans, §3.3 ] }                       // required; [] when none
```

### 3.3 Trace node — `t[]`, recursive (trace encoder)

Contract `src/agent/telemetry-wire-contract.ts:87-111`; encoder
`src/encoders/trace.encoder.ts:32-93`. Shared by request and job snapshots, so a
span reads identically whichever produced it.

| Key | Type | Req | Bounds | Meaning |
| --- | --- | --- | --- | --- |
| `o` | string | **yes** | oneOf `manual`,`auto` | Span origin |
| `c` | string | **yes** | ≤ 255 | Class the method is defined on |
| `m` | string | **yes** | ≤ 255 | Method key |
| `n` | string | no | ≤ 255 | Display name — manual spans and collapsed aggregate nodes only |
| `d` | number | no | — | **Milliseconds**. Collapsed node: the **sum** of the replaced calls, which is what keeps the parent's self time exact |
| `so` | number | no | — | **Milliseconds** from trace-root start: `performance.now() - snapshot.startTimestamp`, fractional (`src/services/operation-trace.registry.ts:695-703`) |
| `s` | string | no | — | Span id, UUIDv7 — the same value a log line's `spanId` carries (`src/services/operation-trace.registry.ts:452,473`) |
| `t` | object | no | — | Tags. Collapsed nodes carry `observe.collapsed: <count>` |
| `e` | object **or boolean** | no | — | `true` = "failed, details not captured". Object form as §3.2 |
| `ch` | array | no | — | Children, same shape, arbitrary depth. **Omitted on leaves**, not `[]` (`src/encoders/encoders.spec.ts:445-467`) |

Reconstruction: hierarchy from `ch`, order from `so`, width from `d`. `spanId`
may be absent on spans reported by older agents
(`src/interfaces/trace-events.interfaces.ts:56-64`) — use it for log correlation,
never as a primary key.

```jsonc
[ { "o": "auto", "c": "OrdersController", "m": "findOne",
    "so": 0.42, "d": 411.9, "s": "018f3a6c-…-aa",     // root span of the tree
    "ch": [
      { "o": "auto", "c": "OrdersService", "m": "findOne",
        "so": 1.9, "d": 300.1, "s": "018f3a6c-…-ab",
        "ch": [
          { "o": "auto", "c": "PgDriver", "m": "query",       // no "ch": leaf
            "so": 2.4, "d": 288.6, "s": "018f3a6c-…-ac",
            "t": { "db.statement": "SELECT … WHERE id = $1" } }
        ] },
      { "o": "auto", "c": "ValidationPipe", "m": "transform",
        "n": "ValidationPipe.transform ×27",              // collapsed aggregate
        "so": 305.0, "d": 40,                             // sum of 27 calls
        "t": { "observe.collapsed": 27 } }                // count rides in tags
    ] } ]
```

### 3.4 Job snapshot — `jobs[]`

Contract `src/agent/telemetry-wire-contract.ts:151-175`; encoder
`src/encoders/job-snapshot.encoder.ts:6-47`.

| Key | Type | Req | Bounds | Meaning |
| --- | --- | --- | --- | --- |
| `i` | string | **yes** | — | Job id. A fresh UUIDv7 per scheduled-handler firing |
| `ti` | string | **yes** | ≤ 255 | Trace id (inherited from the enqueuing request for BullMQ/Bull) |
| `n` | string | no | — | Job name, or `ClassName.methodName` for `@nestjs/schedule` |
| `q` | string | no | — | Queue name; scheduler type (`cron`/`interval`/`timeout`) for scheduled handlers |
| `s` | string | no | — | `"completed"` \| `"failed"` |
| `c` | string | no | — | `calledAt`, ISO-8601 |
| `d` | number | no | — | Processing time, **ms** (worker pickup → end) |
| `ea` | string | no | — | `enqueuedAt`, ISO-8601 |
| `wd` | number | no | — | Queue wait, **ms**, from runnable (any `delay` excluded) |
| `am` | number | no | — | Attempts already made before this run; `0` on the first |
| `ma` | number | no | — | Max attempts configured |
| `tg` | object | no | — | Tags |
| `e` | object | no | — | Error, as §3.2. **Its presence is the only "server error" signal for a job** |
| `t` | array | **yes** | — | Trace tree; `[]` when withheld |

`ea`/`wd`/`am`/`ma` **must be nullable columns**: absent means "not reported",
which is not a genuine zero (`src/encoders/encoders.spec.ts:580-591`).

```jsonc
{ "i":  "job_1024",                                // id
  "ti": "018f3a6c-…",                              // trace of the enqueuing request
  "n":  "send-receipt", "q": "emails",
  "s":  "failed",                                  // completed | failed
  "c":  "2026-10-25T06:00:01.000Z",                // calledAt
  "d":  900.5,                                     // processing, ms
  "ea": "2026-10-25T05:59:58.000Z",                // enqueuedAt
  "wd": 3000,                                      // queue wait, ms
  "am": 0, "ma": 3,                                // attempts made / allowed
  "tg": { "attempt": 1 },
  "e":  { "cls": "Error", "message": "SMTP timeout", "stack": "…" },
  "t":  [ { "o": "auto", "c": "MailService", "m": "send", "so": 0.1, "d": 899 } ] }
```

### 3.5 Runtime metrics — `runtime` (runtime-metrics encoder)

Contract `src/agent/telemetry-wire-contract.ts:177-229`; encoder
`src/encoders/runtime-metrics.encoder.ts:4-143`; values produced at
`src/services/node-runtime-metrics.service.ts:182-278`.

**One object per batch** — the most recent sample; a batch never carries two
(`src/agent/observe-agent.worker.ts:476-500`). Every figure is a measurement
**over the window since the previous sample**, not since process start.

| Key | Sub-key | Unit | Derivation |
| --- | --- | --- | --- |
| `c` | `u` | **ms** CPU user, over the window | `diffCpuUsage.user / 1000` (µs→ms, `node-runtime-metrics.service.ts:236`) |
| `c` | `s` | **ms** CPU system, over the window | `:237` |
| `c` | `p` | **%** of one core | `(user+system)/1000/elapsed*100` (`:238-240`) |
| `m` | `r` | **MB** rss | bytes / 1024² (`:228`) |
| `m` | `ht` | **MB** heapTotal | `:229` |
| `m` | `hu` | **MB** heapUsed | `:230` |
| `m` | `e` | **MB** external | `:231` |
| `m` | `ab` | **MB** arrayBuffers | `:232` |
| `m` | `p` | **%** of `os.totalmem()` | rss-based (`:233`) |
| `g` | `c` | count | GCs in the window |
| `g` | `td` | **ms** | total GC duration in the window (entry `duration`, already ms) |
| `g` | `b` | object | `{ m?, j?, i? }` = minor / major / incremental, each `{ count, duration }` with **duration in ms**. **`null` when nothing was categorised** — the agent carries `null` through, not an omission (`src/encoders/encoders.spec.ts:714-725`) |
| `e` | `l` | **ms** | mean event-loop lag over the window; ns→ms at `node-runtime-metrics.service.ts:223`. An idle process reads ≈10 ms (histogram resolution) |
| `e` | `u` | ratio 0…1 | event-loop utilisation over the window (`:244`) |

Inside `b` the inner keys are the only runtime-metric keys **not** shortened:
`count`/`duration` stay long, while `m`/`j`/`i` abbreviate the GC kinds
(`src/agent/telemetry-wire-contract.ts:168-175`).

**Zero is a measurement.** An idle process legitimately reports
`{"c":{"u":0,"s":0,"p":0}}`; never read `0` as missing, and never make the
columns non-nullable in a way that turns "not reported" into `0`
(`src/encoders/encoders.spec.ts:727-739`).

```jsonc
{ "c": { "u": 812, "s": 41, "p": 3.7 },                    // ms, ms, % of a core
  "m": { "r": 148.2, "ht": 64.0, "hu": 41.3,
         "e": 2.1, "ab": 0.4, "p": 1.8 },                  // MB ×5, % of total RAM
  "g": { "c": 12, "td": 33.4,                              // count, ms
         "b": { "m": { "count": 9, "duration": 8.2 },      // minor GCs, ms
                "j": { "count": 2, "duration": 22.1 },     // major
                "i": { "count": 1, "duration": 3.1 } } },  // incremental
  "e": { "l": 10.3, "u": 0.12 } }                          // ms lag, 0..1 utilisation
// "g": { "c": 0, "td": 0, "b": null }  is what a quiet window looks like.
```

### 3.6 Custom metrics — `custom[]` (custom-metrics encoder)

Contract `src/agent/telemetry-wire-contract.ts:231-247`; encoder
`src/encoders/custom-metrics.encoder.ts:76-171`; semantics
`src/custom-metrics/{counter,gauge,summary}.ts`.

| Key | Type | Req | Bounds | Meaning |
| --- | --- | --- | --- | --- |
| `n` | string | **yes** | ≤ 100 | Metric name; longer is cut to head + hash so two long names never collide |
| `t` | string | **yes** | oneOf `counter`,`gauge`,`summary` | Series kind — part of the identity |
| `v` | object | no | ≤ 1000 keys, key ≤ 255 | `labelSeries → number` |
| `tg` | object | no | — | `Record<string,string>` tags |
| `d` | string | no | ≤ 255 | Description |
| `l` | string[] | no | ≤ 1000, item ≤ 255 | Declared label **names** (the keys inside a series key) |
| `lu` | number | no | — | Last updated, **epoch ms** |
| `k` | string | no | oneOf `additive`,`ratio`,`peak` | **Gauge only.** Merge across instances: sum / average / max. Losing it turns a peak into a sum (`src/custom-metrics/gauge.ts:7-13`) |
| `iv` | object | no | as `v` | **Counter only.** Increase since the last successful flush |
| `q50`,`q95`,`q99` | object | no | as `v` | **Summary only.** Quantiles per label over the window |
| `ct` | object | no | as `v` | **Summary only.** Observation count per label |
| `sm` | object | no | as `v` | **Summary only.** Sum of observations per label |
| `mx` | object | no | as `v` | **Summary only.** Max observation per label |

**Series key.** The key of `v`/`iv`/`q*`/`ct`/`sm`/`mx` is
`JSON.stringify` of the label object with **keys sorted**, so `{route,method}` and
`{method,route}` are one series (`src/custom-metrics/counter.ts:13-19`).
Unlabelled metrics use the literal key `"default"`
(`src/custom-metrics/counter.ts:4`, `src/custom-metrics/gauge.ts:5`). Keys are
≤ 255 chars; the agent refuses a longer combination at the source rather than
letting it poison the batch (`src/custom-metrics/counter.ts:40,52-90`).

**Counter: `v` vs `iv` — the one field a dashboard gets wrong.**
`v` is cumulative for the life of the process; `iv` is the increase since the
previous **written** flush. Summing `v` across reports double counts, and a
process restart resets it to zero, so a difference-on-read undercounts. `iv` is
the additive quantity: sum it over a window for the true total. `markFlushed()`
is called only once the batch is actually handed to the wire, so a failed flush
rolls its increase into the next one instead of losing it
(`src/interfaces/custom-metric.interface.ts:72-82`,
`src/custom-metrics/counter.ts:144-170`,
`src/agent/observe-agent.shared-buffer.ts:730-739`).
**Never send `iv` for a gauge** — a gauge reading is absolute
(`src/encoders/encoders.spec.ts:135-145`).

**Summary: computed in-process, per flush window.** Raw observations never leave
the agent; quantiles are read off a bounded reservoir (2048 per label, exact
count/sum/max tracked beside it), and the window resets on flush
(`src/custom-metrics/summary.ts:13-25,86-140,234`). Consequences for us:

- `q50/q95/q99` merge only approximately across instances — average them, and say
  so if the UI claims an exact percentile.
- `ct`, `sm`, `mx` merge **exactly**, so a mean (`sm/ct`) and a worst case hold
  across any number of reporters. Prefer those for any aggregate.
- The metric's headline `value` is the median again and is deliberately **not**
  on the wire; derive it from `q50`
  (`src/encoders/custom-metrics.encoder.ts:94-106`).
- An empty window sends **no** distribution keys at all — do not invent a zero
  row (`src/encoders/custom-metrics.encoder.ts:141-153`,
  `src/encoders/encoders.spec.ts:102-116`).

**Bounds the collector must enforce.** Each map: finite numbers only, ≤ 1000 keys,
key ≤ 255 chars — otherwise refuse the batch
(`src/agent/telemetry-wire-contract.ts:226-229`). The agent also caps series at
1000 per counter/gauge in process (`MAX_SERIES_PER_METRIC`,
`src/custom-metrics/counter.ts:33`). Within one batch the agent dedupes by
`(n, t)` and merges (`src/agent/observe-agent.shared-buffer.ts:586-600`).

```jsonc
[ { "n": "orders.placed", "t": "counter",                 // cumulative count
    "v":  { "default": 1487 },                            // process lifetime
    "iv": { "default": 12 },                              // since last flush — SUM THIS
    "d":  "Orders placed", "lu": 1761372000123,           // epoch ms
    "tg": { "team": "checkout" } },

  { "n": "queue.depth", "t": "gauge",                     // current value
    "l":  ["queue"],                                      // label NAMES
    "v":  { "{\"queue\":\"emails\"}": 42 },               // sorted-key JSON series key
    "k":  "peak",                                         // merge by max, not sum
    "lu": 1761372000123 },

  { "n": "checkout.duration", "t": "summary",             // distribution
    "l":  ["route"],
    "q50": { "{\"route\":\"/pay\"}": 88 },                // ms, approximate on merge
    "q95": { "{\"route\":\"/pay\"}": 210 },
    "q99": { "{\"route\":\"/pay\"}": 340 },
    "ct":  { "{\"route\":\"/pay\"}": 96 },                // exact, mergeable
    "sm":  { "{\"route\":\"/pay\"}": 9216 },              // exact; mean = sm/ct = 96
    "mx":  { "{\"route\":\"/pay\"}": 401 },               // exact, mergeable
    "lu": 1761372000123 } ]
```

### 3.7 Logs — `logs[]`

Contract `src/agent/telemetry-wire-contract.ts:249-258`; producer
`src/services/stdout-forwarder.service.ts:216-278`.

| Key | Type | Req | Bounds | Meaning |
| --- | --- | --- | --- | --- |
| `timestamp` | number | **yes** | — | **Epoch ms**, taken at the write |
| `text` | string | **yes** | ≤ 4 KiB (agent truncates, suffix `... [truncated by observe]`) | Redacted message |
| `traceId` | string | no | ≤ 255 | Trace the line was written inside, when resolvable |
| `spanId` | string | no | ≤ 255 | Span it was written inside; only ever set together with `traceId` |
| `level` | string | no | oneOf `fatal`,`error`,`warn`,`log`,`debug`,`verbose` | Lowercased Nest level; absent for unparsed raw stdout |
| `context` | string | no | ≤ 255 | Nest logger context (usually the class name), redacted |
| `attributes` | object | no | — | Structured fields beyond the modelled ones |

Only present when the application sets `forwardLogs: true`
(`src/interfaces/observe-options.interface.ts:433-438`) — and `forwardLogs` on the
batch says so regardless, so do not infer it from `logs` being present.
Entries are **not ordered by `timestamp`**: backlog lines are appended after
newer ones and every entry carries its own clock
(`src/agent/observe-agent.shared-buffer.ts:651-667`). Index and sort on
`timestamp`, never on arrival order.

```jsonc
[ { "timestamp": 1761372000456,                  // epoch ms, required
    "level": "error",                            // one of six; absent when unparsed
    "context": "OrdersService",                  // ≤255, redacted
    "text": "receipt failed: SMTP timeout",      // required, redacted, ≤4KB
    "traceId": "018f3a6c-…",                     // correlation handles
    "spanId":  "018f3a6c-…-ab",
    "attributes": { "queue": "emails" } } ]
```

### 3.8 Objectives — `objectives[]`

Contract `src/agent/telemetry-wire-contract.ts:260-293`; producer
`src/objectives/objectives.registry.ts:208-257`.

```jsonc
{ "handler": "OrdersController.create",   // ≤255, required — "Class.method"
  "operationId": "/orders",               // ≤255, required — the route actually served
  "method": "POST",                       // ≤10, optional (absent for @All / non-HTTP)
  "objectives": [                         // required, max 10 per handler
    { "availability": 99.9,               // percentage; 90…99.999
      "latency": { "underMs": 300, "target": 99 },  // both required if latency present
      "windowDays": 28,                   // oneOf 7, 14, 28, 30
      "name": "Checkout" } ] }            // ≤120, optional
```

Root array ≤ 100. Key on `(application, handler, operationId, method)` and
**upsert**: the agent restates each route's objectives hourly, so a delete in our
UI is undone by the next deployment that still declares them
(`src/objectives/objectives.registry.ts:26-32`). Declarations are not telemetry —
they ride even a withheld batch (`src/agent/observe-agent.shared-buffer.ts:299-314`).

### 3.9 Profile upload — `POST /applications/profiles` (shelved)

Compiled and unit-tested but **unreachable** in 0.3.17: `ObserveOptions.profiling`
is commented out and the start call is commented out with it
(`src/interfaces/observe-options.interface.ts:277-326`,
`src/agent/observe-agent.worker.ts:190-195,236-238`). Document for forward
compatibility; implement as a stub that accepts and stores nothing.

Headers: `Content-Type: application/json` and the credential pair — **no gzip**
(`src/profiling/profile-uploader.ts:106-114`). Body, one window per request:

```jsonc
{ "serviceNode": "host-7f3a:1",            // hostname:pid — one process, not a service
  "sampleRateHz": 99,                      // the rate actually used, not the nominal one
  "windows": [ { "start": "2026-08-25T00:06:00.000Z",
                 "stacks": [ { "frames": ["fn", "caller", "…"],
                               "samples": 42,
                               "spanId":  "018f3a6c-…",   // optional
                               "traceId": "018f3a6c-…" } ] } ] }
```

(`src/profiling/profile-uploader.ts:118-131`,
`src/profiling/cpu-profiler.service.ts:40-43`,
`src/profiling/fold-profile.util.ts` `FoldedStack`). Uploads are serialised and
capped at 2 pending windows. `403 {"code":"ENTITLEMENT_REQUIRED"}` means "not
entitled" and the agent **discards** the window; any other `401`/`403` means bad
credentials and is retried (`src/profiling/profile-uploader.ts:133-173,200-207`).

### 3.10 One full batch, annotated

```jsonc
{
  "serviceId": "orders-api",                 // ≤100, required
  "serviceVersion": "a1b2c3d",               // ≤50, absent when unknown
  "forwardLogs": true,                       // every batch, on or off
  "truncatedSpans": 431,                     // withheld units (§4.5); absent when 0
  "snapshots": [ …§3.2.3 ],
  "jobs":      [ …§3.4 ],
  "runtime":   { …§3.5 },
  "custom":    [ …§3.6 ],
  "logs":      [ …§3.7 ],
  "objectives": [ …§3.8 ]
}
```

## 4. Batching and transport

### 4.1 Client-side limits (what to expect)

| Limit | Value | Source |
| --- | --- | --- |
| One batch (JSON) | 16 MiB − 8 | `src/agent/observe-agent.shared-buffer.ts:39,716-719` |
| Snapshots per batch | `min(maxTracesPerBatch, 5000)`, default 1000 | `:40,490-495` |
| Jobs per batch | same cap | `:329-337` |
| Log entries per batch | 250 | `:57` |
| Single log entry | 4 KiB | `:58` |
| Log backlog held back | 2000 | `:74` |
| Objectives per batch | 100 | `:123` |
| Flush interval | 5000 ms default, clamped to ≥ 1000 | `src/agent/observe-agent.worker.ts:37,50,204-226` |
| Runtime sample interval | 60 000 ms default, clamped to ≥ 30 000 | `:35-36` |
| Shutdown flush budget | 2000 ms | `:64` |

A payload over the buffer size throws and the **whole batch is lost**, so a
well-behaved client stays under ~16 MiB uncompressed.

### 4.2 Compression and framing

- Body is **gzip JSON**, `Content-Encoding: gzip` on every request — compressed on
  the worker thread with `zlib.gzip` (`src/agent/detached-observe-worker.ts:105-106,262-271`).
  **The collector must gunzip.** A body read as text is garbage.
- `Content-Length` is the **compressed** size, set explicitly (`:339`). No chunked
  transfer, no multipart, no two batches per request.
- One POST = one batch = one JSON document.

### 4.3 Connection handling — what the collector must replicate

| Behaviour | Why | Source |
| --- | --- | --- |
| Honour HTTP/1.1 keep-alive; do not close an idle socket sooner than 30 s | the agent keeps sockets for `KEEP_ALIVE_IDLE_MS = 30_000`, deliberately longer than the default flush, and closes 1 s before any server-sent `Keep-Alive: timeout=` rather than being raced | `src/agent/detached-observe-worker.ts:288,296-299`; `src/agent/worker-keep-alive.spec.ts:130-149` |
| Tolerate a **duplicate batch** | a reused socket killed before the reply makes the worker re-send the same bytes once on a fresh socket (`ECONNRESET`/`EPIPE`) | `:500-520`; `src/agent/worker-keep-alive.spec.ts:151-178` |
| Read the request body before answering | the agent reads every reply to the end whatever the status, and an unread body keeps the socket busy | `:325-331` |
| Answer within 15 s | `REQUEST_TIMEOUT_MS = 15_000` with no socket activity abandons the send, drops the batch, releases the lock | `:311,364-373` |
| Do not redirect | `3xx` is neither followed nor `ok` → generic failure, batch dropped | `:349` |
| Answer `2xx` only for success | `ok` is `status >= 200 && status < 300` | `:349` |
| Accept an empty `{}` or no body at all | both read as "keep every span" | `src/agent/worker-degraded-reply.spec.ts:140-141` |

### 4.4 Retry behaviour (client side, for expectation setting)

There is **no client queue**: the shared slot holds exactly one batch and is
cleared in `finally` on every path, so a failed send loses that batch
(`src/agent/detached-observe-worker.ts:718-723`;
"dropping telemetry is recoverable, taking the host process down with it is not",
`src/agent/observe-agent.shared-buffer.ts:70-73`). The only retries are the
keep-alive re-send (`:500-520`), the `400` repair re-send (`:527-585`), and the
pauses on `401/403`/`429` (§5.4–5.5).

### 4.5 `truncatedSpans` — accept it, expect zero

The field exists so a collector can meter what the agent withheld rather than
what arrived. In our deployment the agent never withholds (we always answer
`degraded:false`), so it is normally absent. Store it and add it to any event
count: withheld units are one per request/job not sent, one more for the error it
carried, one per trace node, one per log record
(`src/agent/degraded-ingest.protocol.ts:222-249`,
`src/agent/observe-agent.shared-buffer.ts:163,454-461`).

## 5. Response contract

### 5.1 Status matrix

| Status | Body the agent reads | Agent reaction | Our collector |
| --- | --- | --- | --- |
| `200`/`2xx` | optional JSON, §5.2 | success; resets credential backoff; posts `observe:degraded=<verdict>` | **`200 {"degraded":false}` — the only success we send** |
| `400` | any | sanitize the batch to the contract and re-send **once**; report `Error:` if nothing was repairable or the retry fails | **only** for genuine contract violations (§5.3) |
| `401` | any | credential rejection: log once, back off doubling from `flushInterval` to 1 h | only under an enforced policy |
| `403` | any | identical to `401` (`src/agent/detached-observe-worker.ts:551`) | unused for ingest |
| `429` | JSON `{code,reason,used,included,plan}` + `Retry-After` | pause `Retry-After` (capped 1 h) else 5 min; log once per pause | never — we have no quotas |
| `5xx` / other | any text | `Error: Failed to send data. …`, batch dropped | use for genuine server faults |
| transport failure | — | `Error: Could not reach the collector at <url> (<code>)`, batch dropped | — |

`Retry-After` is parsed as **delta-seconds only**; an HTTP-date counts as absent
(`src/agent/detached-observe-worker.ts:203-219`;
`src/agent/worker-auth-backoff.spec.ts:196-231`). Body parsing never turns an
accepted batch into a reported failure (`:630-690`).

### 5.2 Degradation flags — recognised by the SDK, never sent by us

All five modes are quota/billing concepts
(`src/agent/degraded-ingest.protocol.ts:44-83`), which this project does not have
(`AGENTS.md`: no pricing, billing, plans, quotas). We answer
**`{"degraded":false}`** on every accepted batch and never trim or withhold
anything server-side.

Kept here so an engineer can read the agent's behaviour without re-deriving it,
and so nobody reintroduces the machinery:

| Body the SDK would parse | Verdict it would reach |
| --- | --- |
| `{}` / no body / `{"degraded":false}` | `false` → `full` (accept everything) |
| `{"degraded":true}` | `reduced` |
| `{"degraded":true,"trimmed":true}` | `trimmed` |
| `{"degraded":true,"paced":true}` | `paced` |
| `{"degraded":true,"errorsOnly":true[,"reason":"spike"\|"budget"]}` | `errors-only[:reason]` |
| `trimmed`/`paced`/`errorsOnly` **without** `degraded:true` | ignored → `full` |
| both `trimmed` and `paced` | `trimmed` wins |
| `errorsOnly` beside both | `errorsOnly` wins |
| any other `reason` (or non-string) | dropped; still `errors-only` |

Pinned by `src/agent/worker-degraded-reply.spec.ts:118-238`. The modes are also
announced upward in `x-observe-ingest-modes`
(`src/agent/degraded-ingest.protocol.ts:44-63`), which we
read and ignore. Our answer must stay `degraded:false`: a `degraded:true` would
make the agent withhold traces for 5 minutes
(`DEGRADED_TTL_MS`, `src/agent/degraded-ingest.protocol.ts:85`) with nothing on
our side discarding them — we would silently lose data we are entitled to.

### 5.3 What `400` means (and must not mean)

On `400` the worker re-parses its own batch, strips keys the contract does not
declare, removes optional fields of the wrong type, sends a missing `t` as `[]`,
and drops entries whose **required** field is unusable — then re-sends once
(`src/agent/detached-observe-worker.ts:527-585`; the sanitizer itself at
`src/agent/telemetry-wire-contract.ts:543-772`).

So `400` is a **repair signal**, not a drop signal. Answering `400` for anything
recoverable (bad gzip, a transient DB error, overload) makes the agent re-send the
same bytes and then lose the batch with a misleading `Error:` line. Note the
sanitizer *strips* rather than truncates: a collector stricter than the contract
silently loses fields instead of getting them fixed.

### 5.4 `401`/`403` backoff (exact)

```
authRejections += 1
authBackoffMs = authBackoffMs == 0 ? min(flushInterval, 1h)
                                   : min(authBackoffMs * 2, 1h)
pausedUntil   = now + (min(Retry-After, 1h) ?? authBackoffMs)
```

(`src/agent/detached-observe-worker.ts:551-585`.) First rejection pauses one
flush interval, then 2×, 4×, … capped at an hour. The first is logged in full;
every **720th** after it is counted and logged once
(`AUTH_REJECTION_REPORT_EVERY = 720`, `:142,568-580`). A later `2xx` resets the
backoff to 0 (`:626`). During a pause the main thread keeps overwriting the one
shared batch, so data is lost by replacement, not queued (`:145-163`).

Hosted-collector trick worth knowing if we ever enforce: after the first `401`,
answer later batches from the same credentials with `429
{"code":"CREDENTIALS_REJECTED"}` + `Retry-After: 3600`, so agents that pause only
on `429` stop too (`src/utils/ingest-refusal.util.ts:26-41`;
`src/agent/credentials-rejected-429.int-spec.ts:24-33`).

### 5.5 What the collector must not do

- Must not answer `401` for "not provisioned yet" — that parks the agent for an
  hour. Accept and store.
- Must not answer `204`-and-`Location` or any `3xx` expecting a follow.
- Must not require a `Content-Type` on the request beyond what is sent, or
  require a `User-Agent`.
- Must not treat a missing credential pair as an error under placeholder mode.
- Must not close idle sockets under 30 s without a `Keep-Alive: timeout` hint.

## 6. Data model implications

### 6.1 Tables

| Table | Fed by | Natural keys / dedupe | Notes |
| --- | --- | --- | --- |
| `applications` | `x-api-key` | `(app_key, secret_hash)` | credential → application; one app per pair |
| `services` | `serviceId` | `(application_id, service_id)` | auto-created on first batch |
| `service_releases` | `serviceVersion` | `(service_id, version)` | nullable; empty ≠ a release named `""` |
| `requests` | `snapshots[]` | `(application_id, trace_id)` | `t` stored separately; keep `truncated_spans` on the batch row |
| `spans` | `snapshots[].t` | `(request_id, node_seq)` | flatten `ch` with `parent_seq`, `depth`, `sibling_index` |
| `errors` | snapshot/job/span `e` + error-level logs | `fingerprint` per application | §6.2 |
| `jobs` | `jobs[]` | `(application_id, queue_name, job_id)` | `ea/wd/am/ma` **nullable** |
| `logs` | `logs[]` | `(service_id, ts, seq)` | ordered by `timestamp`, not arrival |
| `runtime_samples` | `runtime` | `(service_id, ts)` | one row per batch carrying one |
| `custom_metric_series` | `custom[]` | `(service_id, metric_name, type, label_series)` | series key = sorted-key JSON |
| `custom_metric_points` | `iv`/`v`/summary maps | `(series_id, ts)` | store both cumulative `v` and additive `iv`; `ct/sm/mx` alongside `q*` |
| `objectives` | `objectives[]` | `(service_id, handler, operation_id, method)` | upsert; restated hourly |
| `objective_windows` | derived from `requests` | `(objective_id, window_start)` | SLO evaluation |
| `profiles` | `/applications/profiles` | `(service_node, window_start)` | shelved; schema only |
| `ingest_batches` (audit) | request meta | `(received_at)` | `request_id`, `forward_logs`, `truncated_spans`, byte size — the only record of a rejected batch |

### 6.2 Error grading and fingerprinting

The agent sends **no fingerprint**; the collector derives one from
`(cls, normalized(message), top in-app stack frame)` scoped to the application.

Keep the agent's own grading rule, because the dashboard's "server errors" and the
SDK's notion must agree:

```
isServerError(execution) =
  execution.a.sc is a number ? execution.a.sc >= 500     // status decides ALONE
                             : Boolean(execution.e)      // jobs / non-HTTP transports
```

(`src/agent/degraded-ingest.protocol.ts:189-221`.) The status code wins where
present and the error object is not consulted beside it, deliberately: an expected
`401` carries an error exactly like a `500` does, and on a typical public service
`401`/`429` are most of the daily error count.

### 6.3 Event accounting

One event per request, job, span node, error and log record; objectives and
database/outbound-HTTP spans are not billed (`repos/observe/README.md`,
§What it records without any code). Trace volume is counted in **nodes, children
included**, not roots — one auto-instrumented request routinely carries 80-odd
children, so a root count is off by two orders of magnitude
(`src/agent/degraded-ingest.protocol.ts:222-249`).

### 6.4 Indexes and queries the dashboard implies

| Query | Index |
| --- | --- |
| time-range scan of requests for a service | `requests (service_id, started_at DESC)` — append-only, partition by time |
| per-route charts / latency | `requests (service_id, operation_id, started_at DESC)` |
| waterfall by trace id | `requests (trace_id)` unique; `spans (request_id, start_offset, depth)` |
| per-class/method cost | `spans (service_id, class_name, method_key, started_at)` |
| error list + grouping | `errors (service_id, fingerprint, last_seen DESC)`, `errors (service_id, last_seen DESC)` |
| error → trace | `errors (trace_id)` |
| logs for a trace | `logs (trace_id, timestamp)` |
| log browsing | `logs (service_id, level, timestamp DESC)`; optional FTS on `text` |
| job throughput / latency / backlog | `jobs (service_id, queue_name, status, started_at DESC)`, `jobs (service_id, enqueued_at)` for `wd` |
| runtime gauges | `runtime_samples (service_id, ts DESC)` |
| metric time series | `custom_metric_points (series_id, ts DESC)` |
| latest value per series | `custom_metric_series (service_id, metric_name)` with `last_value`, `last_updated` |
| SLO burn-down | `objective_windows (objective_id, window_start DESC)` |

High-cardinality guards. `operationId` is user-controlled via `setOperationId`;
the hosted product caps custom names at 100 per project per 30 days and groups the
rest under the replaced route (`dop`)
(`repos/observe/README.md` §Custom request operation IDs). Custom-metric series
are capped at 1000 per metric by the agent, but a collector must still bound the
distinct-label table it writes (`src/custom-metrics/counter.ts:33`). `span_id` is
**not** unique across agents — never make it a primary key
(`src/interfaces/trace-events.interfaces.ts:56-64`).

## 7. Compatibility risks

| # | Risk | Evidence | What we do |
| --- | --- | --- | --- |
| 1 | **Single-letter keys are an undocumented private agreement.** No published schema; the contract file exists only because "the encoders and the API agree on nothing but single-letter key names" | `src/agent/telemetry-wire-contract.ts:1-30` | Pin 0.3.17, keep a conformance suite generated from the contract, re-read it on every bump |
| 2 | **Strictness refuses whole batches.** `forbidNonWhitelisted`; agents 0.2.1–0.3.9 deleted `t` instead of sending `[]` and lost every ordinary batch while degraded | `:14-30,111-130`; `src/testing/fake-collector.ts:31-34` | Be liberal: store or ignore unknown keys; `400` only for the known-fatal cases. Reject `st`, because the agent repairs it |
| 3 | **No app/service provisioning API.** "The app is taken from the key"; keys are issued by the hosted dashboard, and `link` is a device-code flow against the same base URL | `src/agent/detached-observe-worker.ts:568-572`; `src/cli/link.ts:107-141,266-326` | Implement `/cli-link/sessions` + `/cli-link/token` (RFC 8628 shape: `authorization_pending`, `slow_down` +5 s, `access_denied`, `expired_token`) or publish an offline key UI and document that `npx @nestjs/observe link` will not work against us. Services are implied by `serviceId` — auto-create |
| 4 | **Degradation is server-side for older agents.** Agents ≤ 0.3.11 send no `x-observe-ingest-modes` and read any `degraded:true` as a spent allowance; ≤ 0.3.12 do not know `errors-only` | `src/agent/degraded-ingest.protocol.ts:44-63` | Always answer `{"degraded":false}` and implement no trimming at all (§5.2) |
| 5 | **`st` must never be echoed or required.** The encoders still map it; only `endTrace` keeps it off the wire | `src/encoders/encoders.spec.ts:373-399` | Reject with `400` (the agent repairs), never require it |
| 6 | **`so` is optional.** Older agents send no start offset and the span clock is then unknown | `src/interfaces/trace-events.interfaces.ts:56-64` | Waterfall degrades to nesting + relative width; no self-time from missing offsets |
| 7 | **`serviceVersion` is inferred and unstable** (env → CI var → `git rev-parse` → platform revision) | `src/observe.module.ts:142-165`; `src/utils/infer-service-version.util.ts` | `NULL` for unknown; never `UNIQUE(service, version)` with `''` |
| 8 | **Profiles are shelved but compiled** and will start being called if the option is restored | `src/interfaces/observe-options.interface.ts:277-326`; `src/agent/observe-agent.worker.ts:190-195` | Stub route + schema; no UI |
| 9 | **Batches may duplicate or straddle flush windows.** Nothing is idempotency-keyed by the SDK | `src/agent/detached-observe-worker.ts:500-520` | Dedupe on natural keys: `snapshots.ti`, `(i, am)` for jobs, `(timestamp, traceId, text-hash)` for logs, `lu` per metric series |
| 10 | **`x-api-secret` crosses the wire in clear over `http://`** — the SDK only warns | `src/agent/observe-agent.worker.ts:605-641` | TLS by default; document the loopback exception |
| 11 | **Scaffold credentials are silently suppressed**, so a fresh `nest new --observe` project sends nothing anywhere | `src/agent/observe-agent.worker.ts:91-92,161-180` | Docs must tell users to set both env vars; we cannot auto-enrol a scaffolded project |
| 12 | **Missing credentials against a non-hosted endpoint are sent unauthenticated** | `:586-596` | Placeholder mode by default (§2.3) |
| 13 | **`runtime.g.b` may be `null`; every runtime number may be `0`** | `src/encoders/encoders.spec.ts:714-739` | Nullable columns; `0` is a measurement |
| 14 | **`a`, `tg`, `rq`, `e`, log `attributes` are pass-through objects** the API does not key-check | `src/agent/telemetry-wire-contract.ts:104-114` | JSONB columns; do not validate their inner keys |
| 15 | **Durations are fractional ms**, from `performance.now()` | `src/services/operation-trace.registry.ts:695-703`; `src/encoders/encoders.spec.ts:255` | `double precision`, not integer ms |
| 16 | **Counter `v` is cumulative across restarts**, `iv` is the additive one | `src/interfaces/custom-metric.interface.ts:72-82` | Chart from `iv`; keep `v` only for the last-value display |
| 17 | **Summary quantiles do not merge exactly**; `ct/sm/mx` do | `src/custom-metrics/summary.ts:13-25`; `src/encoders/custom-metrics.encoder.ts:94-106` | Aggregate `ct/sm/mx`; label `q*` aggregates as estimates |

## 8. Conformance checklist

Test against the **real SDK** (`repos/observe` is a subtree; `npm run test:int`
there boots real Nest apps), never against a hand-written fake.

1. Gzipped §3.10 batch → `200 {"degraded":false}`; the agent logs
   `Observe is connected: <endpoint> accepted this app's first batch.`
2. Same with **no** credential headers → accepted (placeholder mode).
3. Unknown key pair under an enforced policy → `401`; the agent logs once and
   backs off `flushInterval, 2×, 4×, … 1 h`.
4. First `401`, then `429 {"code":"CREDENTIALS_REJECTED"}` + `Retry-After: 3600`
   → no further requests for an hour (only if enforcing).
5. `429` + `Retry-After: 60` → the agent pauses 60 s and says so (only if we ever
   rate-limit).
6. A batch carrying `st` → `400`; the agent re-sends once, sanitized, without it.
7. A batch with an undeclared key → `400`; exactly one re-send; the second
   answer decides success.
8. Hold the answer open > 15 s → the agent abandons the batch, reports a timeout,
   and keeps sending later batches.
9. Two batches 4.5 s apart over one connection → one TCP connection.
10. Kill the kept-alive socket before answering → the agent re-sends the same
    batch once; we must not double-count it.
11. Runtime-only first batch (`serviceId`, `snapshots: []`, `forwardLogs`) →
    accepted and stored.
12. `POST /applications/profiles` with §3.9 → `200` (stub); `403
    {"code":"ENTITLEMENT_REQUIRED"}` → window discarded, no retry.
13. `POST /cli-link/sessions` → `201 { deviceCode, userCode, verificationUri,
    expiresIn, interval }`; `POST /cli-link/token` → `400
    {"error":"authorization_pending"}` then `200 { appKey, appSecret,
    projectName, applicationName }`.
