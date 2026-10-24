# Tech stack — decisions, versions, layout

Status: **decided** · Supersedes any stack note in `docs/PLAN.md` that conflicts ·
Target SDK: `@nestjs/observe@0.3.17` (MIT, `repos/observe@0275d36`)

**Owner decisions in force:** Postgres is the only store (`OBSERVE_DATABASE_URL`
required), the ORM is **Drizzle** on `Bun.SQL`, and server code follows the
Elysia module/plugin conventions in §7.2. There is no SQLite path.

This document is the *why* behind the stack. The wire contract lives in
[`ingest-api.md`](ingest-api.md); packaging lives in
[`release-pipeline.md`](release-pipeline.md).

---

## 0. Pinned versions

| Component | Pin | Source of truth |
|---|---|---|
| Bun | **1.4.4** (repo runs 1.4.3 locally; `@types/bun` 1.4.4 in `bun.lock`) | `bun --version`, `oven/bun:1.4.4*-*` tags ([Docker Hub](https://hub.docker.com/r/oven/bun/tags)) |
| TypeScript | **7.0.2** (native compiler, platform binaries) | root `peerDependencies: typescript ^7`, `bun.lock` |
| Elysia | **1.4.30** (`^1.4.30`) | [`elysia` package.json](https://github.com/elysiajs/elysia/blob/main/package.json) |
| `@elysiajs/openapi` | 1.4.16 | `bun.lock`; [docs](https://elysiajs.com/plugins/openapi) |
| `@elysiajs/cors` | 1.4.2 | `bun.lock`; [docs](https://elysiajs.com/plugins/cors) |
| `@elysiajs/static` | 1.4.10 | `bun.lock`; [docs](https://elysiajs.com/plugins/static) |
| `@elysiajs/cron` | 1.4.2 (wraps `croner`) | `bun.lock`; [docs](https://elysiajs.com/plugins/cron) |
| TypeBox | 0.34.52 | `bun.lock`; also `drizzle-typebox`'s peer (`>=0.34.8`) |
| **Postgres** | **16+** (15 and 17 in CI) | required; `OBSERVE_DATABASE_URL` |
| **`drizzle-orm`** | **0.45.4** | [npm](https://www.npmjs.com/package/drizzle-orm) |
| **`drizzle-kit`** | **0.31.11** | [npm](https://www.npmjs.com/package/drizzle-kit) |
| **`drizzle-typebox`** | **0.3.3** (peer `drizzle-orm >=0.36`, `@sinclair/typebox >=0.34.8`) | [npm](https://www.npmjs.com/package/drizzle-typebox) |

`bun.lock` already declares the workspace set (`apps/server`, `packages/shared`)
and the five Elysia packages. The Drizzle trio is added by this spec; pin it
exactly on first install (`bunfig.toml [install] exact = true`) and treat the
lockfile as authoritative.

**Elysia 2.0 is in beta** (`next.elysiajs.com`, `@elysia/compress@2.0.0-beta.2`).
We stay on 1.4.x and on the `@elysiajs/*` package names until 2.0 is GA; the
1.4 line is explicitly backward compatible ([migration guide](https://www.mintlify.com/elysiajs/elysia/guides/migration)).

---

## 1. Decision table

| Concern | Chosen | Alternatives | Why (one sentence) | Risk |
|---|---|---|---|---|
| Runtime | Bun 1.4.x | Node 22/24 | One binary ships the runtime, bundler, Postgres driver, argon2, cron and test runner — the entire ops surface of a self-hosted collector. | Bun-only APIs; no LTS-style support contract. |
| HTTP framework | Elysia 1.4.x, **two apps** (`:4319` ingest, `:4320` api+SPA), collapsible via `OBSERVE_SINGLE_PORT=1` | raw `Bun.serve`, Hono, Fastify | Elysia compiles routes to static functions (`aot`/`precompile`) and gives schema→OpenAPI→Eden types from one source. | Framework upgrade churn; 2.0 is a rewrite-ish release. |
| Validation | TypeBox via `elysia`'s `t`; **compiled** `TypeCompiler` on ingest; `drizzle-typebox` for DB-shaped models | Zod/Valibot (Standard Schema), hand-written | One schema dialect feeds validation, OpenAPI and the API response types, so a column rename breaks the UI build. | `drizzle-typebox` trails `drizzle-orm`; pin both. |
| Ingest body handling | `Bun.gunzipSync` on the raw `ArrayBuffer`, explicit | `DecompressionStream`, proxy-side gunzip | The SDK always gzips (`content-encoding: gzip`) and Bun does **not** document transparent request decompression — be explicit, it is 3 lines. | Zstd/brotli client would need a second branch (not in the SDK today). |
| Response compression | none in-process (reverse proxy) or `mapResponse` + `Bun.gzipSync` | `@elysiajs/compression` | There is **no stable Elysia compression plugin** (`@elysiajs/compression` 404s on npm; the successor `@elysia/compress` is 2.0.0-beta only). | Dashboard JSON is large; document a proxy or enable the `mapResponse` gzip for `>1 KiB` bodies. |
| **Store** | **Postgres 16+ only**, `OBSERVE_DATABASE_URL` **required** | — | Telemetry needs concurrent writers, `jsonb`/GIN, native partitions and a backup story on day one; a single-writer embedded DB cannot serve that. | Operators must run a database (compose example + external-URL path documented in §4.8). |
| **ORM** | **Drizzle ORM** (`drizzle-orm/bun-sql`) + **drizzle-kit** (dialect `postgresql`) | Kysely, Prisma, raw SQL | `bun-sql` uses Bun's native driver (no `pg`), `pg-core` models the schema in TypeScript, and `drizzle-kit generate` produces reviewable forward-only SQL. | Drizzle moves fast; migrations are the source of truth, not the DSL. |
| **Schema→API types** | **`drizzle-typebox`** `createSelectSchema` / `createInsertSchema` → Elysia `response` models | hand-written TypeBox, OpenAPI-first | Column names, nullability and JSON types reach the OpenAPI document without a second definition. | Generated schemas can be too wide for public DTOs; use `t.Pick`/`t.Omit` and keep request models hand-written. |
| Schema/migrations | `apps/server/src/db/schema.ts` (`pg-core`) → `drizzle-kit generate` → SQL in `apps/server/migrations/` → `drizzle-orm/bun-sql/migrator` at boot | raw SQL, Prisma migrate | Generated-but-reviewed SQL keeps the DSL and the database in sync while leaving partitions/GIN/`CONCURRENTLY` expressible. | Drizzle's snapshot does not model partitions; the initial migration is hand-amended (§4.5). |
| ID strategy | **UUIDv7, minted in the collector** (`Bun.randomUUIDv7()`), `uuid` PK | `gen_random_uuid()` (v4), bigserial | v7 is time-ordered (B-tree locality, `ORDER BY id` ≈ `ORDER BY time`) and the collector controls the timestamp. | 16-byte keys vs 8-byte bigint; index size ~2× — accepted. |
| Time representation | **`bigint` epoch milliseconds** (`{ mode: 'number' }`) everywhere | `timestamptz`, `timestamp` | One unit across wire, DB, API and UI; no timezone drift, no `Date` serialization ambiguity. | Loses PG's interval/date_trunc ergonomics; bucket with integer division/`to_timestamp(ms/1000.0)`. |
| Auth (dashboard) | Opaque 256-bit session token in an `HttpOnly; Secure; SameSite=Lax` cookie, server-side `session` table | JWT, signed cookies | Server-side sessions give instant revocation and need no signing key rotation; the token is random, so it needs no signature. | One indexed SELECT per request (negligible). |
| Password hashing | `Bun.password` **argon2id** (`m=19456,t=2,p=1`) | bcrypt | Built in, no native module, PHC-encoded output. | Native argon2 memory cost per login; rate-limit login. |
| API-key hashing | `Bun.CryptoHasher("sha256")` over the full secret, constant-time compare | argon2 | API secrets are 32 random bytes, so a slow KDF buys nothing and would add ~50 ms to every ingest request. | A leaked hash is directly usable — but so is the key; store only a prefix for display. |
| Background work | In-process: `@elysiajs/cron` for wall-clock jobs, `setInterval` + batched flushes for drift-prone work | Redis + BullMQ, `Bun.spawn` | The product *observes* BullMQ; it must not require Redis to start. | No cross-process locking — single instance only (document it), or one replica with `pg_advisory_lock` (§4.7). |
| Frontend | React 19 + TanStack Query/Router + Tailwind, bundled by **`bun build ./apps/web/index.html`** | Vite, Next | One bundler for server and SPA, `--asset` embeds the output in the compiled binary, and Bun's dev server gives HMR (`development.hmr`). | Smaller plugin ecosystem than Vite; escape hatch documented (§7.4). |
| Charts | `uplot` (dense time series) + hand-rolled SVG waterfall | Recharts | uPlot is built for 100k-point series on canvas; the waterfall is bespoke anyway. | Two chart idioms in the codebase. |
| Lint/format | `oxlint --type-aware` + `prettier` | ESLint | Same tooling the vendored SDK uses (`.oxlintrc`), so contributions move between the two repos. | — |
| Tests | `bun test` (+ `bun:test` mocks, `--coverage`) against a real Postgres | vitest, jest | Zero config, already in the runtime, and integration tests exercise the actual SQL dialect. | CI needs a Postgres service; test isolation via template databases (§7.5). |
| Build output | `bun build --compile` per platform + `--asset ./public --asset ./apps/server/migrations` | `dist/` + Bun on host | A single file with the SPA *and* the migrations embedded removes both the runtime and the "which migrations folder?" question. | 4 platform builds; no post-release JS patching (rebuild instead). |

---

## 2. Runtime: what Bun gives us (and what it does not)

| Need | API | Note |
|---|---|---|
| HTTP server | `Bun.serve` (Elysia's adapter) | Bun's native server; Elysia exposes its options via `new Elysia({ serve })`. |
| Request body limits | `new Elysia({ serve: { maxRequestBodySize } })` | `ElysiaConfig.serve?: Partial<Serve>` in [`src/types.ts`](https://github.com/elysiajs/elysia/blob/main/src/types.ts); the SDK's biggest batch is ~16 MiB uncompressed, so `8 * 1024 * 1024` compressed covers it with slack. |
| gzip/zstd | `Bun.gzipSync`, `Bun.gunzipSync`, `Bun.zstdCompressSync`, `Bun.zstdDecompressSync` | [runtime/utils](https://bun.com/docs/runtime/utils). |
| **Postgres** | `import { SQL } from "bun"` — tagged-template queries, transactions, pool options | [runtime/sql](https://bun.com/docs/runtime/sql). Never add `pg`/`postgres.js`. |
| **UUIDv7** | `Bun.randomUUIDv7()` — monotonic, sortable, thread-safe counter | [runtime/utils § randomUUIDv7](https://bun.com/docs/runtime/utils#bun-randomuuidv7). |
| Hashing | `Bun.password` (argon2id), `Bun.CryptoHasher`, `Bun.hash` (non-crypto) | [runtime/hashing](https://bun.com/docs/runtime/hashing). |
| Scheduling | `@elysiajs/cron` (**not** `Bun.cron`) | `Bun.cron` exists ([docs](https://bun.com/docs/runtime/cron)), but the lockfile already pins the Elysia plugin; keep one scheduler API. |
| Files | `Bun.file`, `Bun.write` | Embedded assets (SPA + migrations) are reachable via `import.meta.dir` when built with `--asset`. |
| Subprocess | `Bun.spawn` | Only for the optional `pg_dump`-based backup CLI; not on the hot path. |
| Workers | `new Worker(...)` | Optional. The ingest path no longer needs one: `Bun.SQL` is async and Postgres does the concurrency (§4.7). |
| Dev loop | `bun --hot apps/server/src/index.ts` | Bun loads `.env` automatically — no dotenv. |
| Tests | `bun test`, `bunfig.toml [test]` | `preload`, `coverage`, `coverageThreshold` ([docs](https://bun.com/docs/test/configuration)). |

### 2.1 Two apps, one process

```ts
// apps/server/src/index.ts
import { Elysia } from 'elysia'
import { ingest } from './modules/telemetry/index.ts'
import { api } from './modules/api/index.ts'
import { startWorkers } from './modules/worker.ts'

const singlePort = process.env.OBSERVE_SINGLE_PORT === '1'

const serveOptions = {
  maxRequestBodySize: 8 * 1024 * 1024, // SDK caps batches at ~16 MiB uncompressed
  idleTimeout: 35,                     // outlive the agent's 30 s keep-alive
} as const

if (singlePort) {
  // One listener: ingest routes are mounted on the api app. Do NOT listen twice
  // on the same port — SO_REUSEPORT would round-robin connections between two
  // routers and 404 half of them.
  new Elysia({ name: 'all', serve: serveOptions, aot: true, precompile: true })
    .use(api)
    .use(ingest)
    .listen(Number(process.env.OBSERVE_API_PORT ?? 4320))
} else {
  new Elysia({ name: 'ingest', serve: serveOptions, aot: true })
    .use(ingest)                 // no cors, no cookie, no session, no static
    .listen(Number(process.env.OBSERVE_INGEST_PORT ?? 4319))

  new Elysia({ name: 'api', serve: serveOptions, aot: true, precompile: true })
    .use(api)                    // session cookie, openapi, static SPA, /mcp
    .listen(Number(process.env.OBSERVE_API_PORT ?? 4320))
}

startWorkers()
```

Consequences, deliberately:

- The ingest app is mounted **first** and registers *only* `/applications/telemetry`,
  `/applications/profiles`, `/cli-link/*` and `/api/v1/ingest/*`. No `onRequest`
  hook that allocates, no cookie parsing, no CORS preflight handling.
- In `OBSERVE_SINGLE_PORT=1` mode the api app mounts the ingest plugin itself, so
  there is exactly one router and one listener. The api app's global hooks then
  run for ingest too, which is why they must be path-scoped and allocation-free
  (no session lookup on anything under `/applications` or `/cli-link`).
- `aot: true` / `precompile: true` move route codegen to boot
  (`ElysiaConfig.aot`, `precompile`).
- **Decompression bomb guard**: `content-length` ≤ 8 MiB, and the decompressed
  size ≤ 24 MiB (the SDK's own buffer cap is ~16 MiB). A sync
  `Bun.gunzipSync` cannot stop mid-stream, so the guard is: reject on
  `content-length`, gunzip, then reject with `413` if the result exceeds the
  cap. Only if measurement shows real bombs do we switch to a streamed
  `new Response(body).body.pipeThrough(new DecompressionStream("gzip"))` reader
  with a byte counter that aborts early.

### 2.2 Lifecycle map (what runs where)

| Elysia hook | Our use | Cost rule |
|---|---|---|
| `onRequest` | nothing in ingest (it is global and would run for every route) | must stay empty — this is the only hook that fires before routing |
| `onParse` | `application/x-ndjson` (profile upload), `octet-stream` passthrough | ingest uses the raw `request` instead of Elysia's JSON parser, so we control gzip decode order |
| `derive` | nothing in ingest; `session`, `requestId`, `startedAt` in the api app | per-request allocation |
| `beforeHandle` | ingest: API-key lookup (Drizzle query, LRU-cached 60 s) | one indexed SELECT |
| handler | ingest: gunzip → validate → normalize (pure) → enqueue to the batch writer | no I/O beyond one bounded enqueue |
| `onError` | map `SyntaxError`/gzip errors to `500`, contract violations to `400`, `PostgresError` to `503` | see `ingest-api.md` §5 |
| `afterResponse` | counters in `state` (`ingest_batch_ok`, `ingest_bytes`, `ingest_400`) | lock-free increments only |
| `onStop` | flush writer, `sql.close()` | must drain the queue |

### 2.3 Validation and API models

- **Ingest** DTOs are TypeBox schemas mirroring
  `repos/observe/src/agent/telemetry-wire-contract.ts`, compiled once with
  `TypeCompiler.Compile()` and stored in a module-level constant. A drifted
  encoder costs one compiled-function call per batch, not a schema walk.
- **Dashboard responses** come from `drizzle-typebox`:
  `createSelectSchema(executions)` is the row model, then `t.Pick`/`t.Omit`/
  `t.Composite` narrow it into the public DTO. That single definition feeds
  Elysia's `response` validation, `@elysiajs/openapi`, and Eden's client types.
- **Dashboard requests** (query strings, bodies, params) stay hand-written
  TypeBox — they are not table shapes, and deriving them from inserts produces
  fields the API must never accept (`id`, `createdAt`, tenant columns).
- **Standard Schema (Zod/Valibot) is not used.** Elysia 1.4 supports it
  ([validation docs](https://elysiajs.com/essential/validation)), but it adds a
  second schema dialect for zero benefit here and cannot express
  `additionalProperties: false` semantics as cheaply.
- Ingest validation is strict (`additionalProperties: false`, mirroring the
  contract's `forbidNonWhitelisted`), because `400` is the SDK's *repair*
  signal and must mean exactly "out of contract" (`ingest-api.md` §5.3).

---

## 3. Plugins — the complete list

| Package | Where | Why |
|---|---|---|
| `elysia` | both apps | framework; `t`/TypeBox re-exported |
| `@elysiajs/openapi` | api app only | Scalar UI at `/openapi`, spec at `/openapi/json`; `exclude` static/ingest paths |
| `@elysiajs/cors` | api app only | dashboard may be served from a different origin in dev; ingest is same-origin by construction |
| `@elysiajs/static` | api app only | serves the embedded SPA (`assets: join(import.meta.dir, "public")`, `indexHTML: true`) |
| `@elysiajs/cron` | worker module | rollups, partition maintenance, SLO restatement, retention, alerts |
| `@elysiajs/eden` | `apps/web` dev+types | typed client against `typeof apiApp`; type-only import, no runtime cost in the SPA build |
| `@modelcontextprotocol/sdk` | api app (P2) | `/mcp` read-only telemetry tools |

Rejected on purpose: `@elysiajs/swagger` (superseded by `openapi`),
`@elysiajs/compression` (does not exist), `@elysiajs/jwt` (opaque sessions),
`@elysiajs/bearer` (our auth is cookie + API key, both trivial inline),
`@elysiajs/graphql-*` (nothing to serve).

> Note on package names: the docs main branch now shows `@elysia/openapi`,
> `@elysia/static`, `@elysia/eden`. Those exist on npm at the same 1.4.x
> versions as aliases, but the lockfile and the 1.4 docs use `@elysiajs/*`.
> Keep `@elysiajs/*`; the rename lands with 2.0.

---

## 4. Postgres + Drizzle

### 4.1 Facts that bound the design

- Postgres gives **concurrent writers** (MVCC), so ingest and dashboard reads do
  not serialize against each other the way a single-writer engine forces.
- Declarative `PARTITION BY RANGE` makes retention `DROP TABLE`, which is O(1)
  and does not bloat the write path with `DELETE` + vacuum.
- `jsonb` + GIN indexes arbitrary tag maps without a schema migration per tag;
  `jsonb` is TOAST-compressed and supports `@>`, `?`, `jsonb_path_query`.
- `COPY`/multi-row `INSERT … SELECT` from `jsonb_to_recordset` amortizes
  round-trips for bulk spans.
- The cost: **one more service to run**. That is why §4.8 ships a compose file,
  a documented external-URL path, and a backup/restore drill.

### 4.2 Rejected alternatives

| Option | Why rejected | Honest bound |
|---|---|---|
| SQLite / `bun:sqlite` | **Dropped by owner.** Single writer at a time, no concurrent multi-process writes, no `jsonb`/GIN, retention needs `DELETE`+vacuum or table-per-day shims. | fine for ≤ ~500 ev/s single node, which is exactly the ceiling we refuse to design around |
| DuckDB | Analytics engine with **one writer per database**; wrong concurrency model for continuous ingest. | usable later as an offline export/rollup target over Parquet |
| ClickHouse | Column store built for millions of rows/s; adds a cluster to a product whose selling point is "one image + one database". | adopt only when a user sustains ≳ 5k ev/s and Postgres rollups stop keeping up |
| TimescaleDB | Postgres + extension, but the extension is not available on managed Postgres everywhere (RDS yes, others no). | native partitions give 90% of the benefit with zero extension |
| `pg` / `postgres.js` / Prisma | Bun has a native driver; Prisma ships engine binaries that break `--compile`. | — |

### 4.3 Sizing arithmetic (why retention is not optional)

| Assumption | Value |
|---|---|
| 1 request → 1 `execution` row | ~400 B |
| spans per request after collapse | ~40 × 120 B ≈ 4.8 KiB |
| logs per request | 0.5 × 200 B ≈ 100 B |
| **per request** | **≈ 5.3 KiB** |
| 100 req/s | ≈ 45 GB/day |
| 1,000 req/s | ≈ 450 GB/day |
| 7-day span retention at 1,000 req/s | ≈ 3 TB |

Therefore: partition by day, per-data-class retention
(`OBSERVE_RETENTION_TRACES_DAYS` etc.), pre-aggregated `rollup_1m`/`rollup_1h`
written by the ingest writer, and a soft ingest cap
(`OBSERVE_MAX_EVENTS_PER_SEC`) that sheds with `503` + `Retry-After` **only**
when the queue is full — never `429`, never `degraded:true`.

### 4.4 Decision and connection setup

| | Decision |
|---|---|
| Store | Postgres **16+**, required |
| Config | `OBSERVE_DATABASE_URL=postgres://user:pass@host:5432/observe?sslmode=require` — **no default, boot fails with a clear message if unset** |
| Driver | `Bun.SQL` only (`drizzle-orm/bun-sql`); no `pg` |
| Pool | `max: 20`, `idleTimeout: 30 s`, `connectionTimeout: 10 s` (`OBSERVE_DB_POOL_MAX` overrides) |
| Timeouts | every dashboard query wrapped in `SET LOCAL statement_timeout = '15s'`; ingest writes get `'30s'` |
| Extensions | none required (no Timescale, no `pg_partman`, no `pgcrypto` — IDs are minted in app code) |
| Migrations | run at boot behind `pg_advisory_lock(<const>)`; `OBSERVE_MIGRATE=off` for operators who migrate out-of-band |
| SSL | passed through in the URL (`sslmode=require`); `OBSERVE_DB_TLS=skip-verify` for self-signed lab installs |

```ts
// apps/server/src/db/client.ts
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import * as schema from './schema.ts'

export type Db = ReturnType<typeof createDb>

export function createDb(url = process.env.OBSERVE_DATABASE_URL) {
  if (!url) throw new Error('OBSERVE_DATABASE_URL is required (postgres://…)')
  const client = new SQL({
    url,
    max: Number(process.env.OBSERVE_DB_POOL_MAX ?? 20),
    idleTimeout: 30,
    connectionTimeout: 10,
  })
  return { db: drizzle({ client, schema, casing: 'snake_case' }), client }
}
```

### 4.5 Schema (`apps/server/src/db/schema.ts`)

Rules, in order of importance:

1. **`pg-core` only.** No raw `CREATE TABLE` in the DSL-free zone; the schema
   file is the only definition drizzle-kit diffs against.
2. **UUIDv7 primary keys minted by the collector.**
   `uuid('id').primaryKey().$defaultFn(() => Bun.randomUUIDv7())`. Never
   `gen_random_uuid()` (v4, random) and never `bigserial` (leaks volume and
   couples the DB to ID allocation).
3. **`bigint` epoch-ms timestamps** with `{ mode: 'number' }` — one unit
   everywhere, no `timestamptz`/`Date` ambiguity. `Bun.SQL` returns `bigint`
   columns as `number` in this mode; values stay far below 2^53.
4. **`jsonb` for open-ended payloads** (`tags`, `attributes`, captured
   request/response, stack frames) with a **GIN** index on the columns the UI
   filters (`execution.tags`, `log_entry.attributes`). Named accessors only —
   no `jsonb` in `SELECT` projections.
5. **Denormalized columns for anything filtered or charted** (`status_code`,
   `error_group_id`, `release_id`, `operation_id`, `duration_ms`) so the hot
   queries never touch the JSON.
6. **Forward-only, additive.** A new app version must read a schema written by
   the previous one (§1.5 of `release-pipeline.md`).

```ts
import { sql } from 'drizzle-orm'
import {
  bigint, boolean, index, integer, jsonb, pgTable, text, uuid, varchar,
} from 'drizzle-orm/pg-core'

const pk = () => uuid('id').primaryKey().$defaultFn(() => Bun.randomUUIDv7())
const epochMs = (name: string) => bigint(name, { mode: 'number' })

export const applications = pgTable('application', {
  id: pk(),
  projectId: uuid('project_id').notNull(),
  serviceId: varchar('service_id', { length: 100 }).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  firstSeen: epochMs('first_seen').notNull(),
  lastSeen: epochMs('last_seen').notNull(),
}, (t) => [
  index('application_service_idx').on(t.projectId, t.serviceId),
])

export const executions = pgTable('execution', {
  id: pk(),
  applicationId: uuid('application_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  traceId: uuid('trace_id').notNull(),
  operationId: uuid('operation_id'),
  releaseId: uuid('release_id'),
  errorGroupId: uuid('error_group_id'),
  startedAt: epochMs('started_at').notNull(),
  durationMs: integer('duration_ms').notNull(),
  statusCode: integer('status_code'),
  tags: jsonb('tags').$type<Record<string, string | number | boolean>>()
    .notNull().default(sql`'{}'::jsonb`),
}, (t) => [
  index('execution_app_started_idx').on(t.applicationId, t.startedAt),
  index('execution_trace_idx').on(t.traceId),
  index('execution_tags_gin').using('gin', t.tags),
])

export const spans = pgTable('span', {
  id: pk(),
  executionId: uuid('execution_id').notNull().references(() => executions.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id'),
  name: text('name').notNull(),
  startedAt: epochMs('started_at').notNull(),
  durationMs: integer('duration_ms').notNull(),
  isError: boolean('is_error').notNull().default(false),
  tags: jsonb('tags').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
}, (t) => [
  index('span_execution_idx').on(t.executionId),
  index('span_started_brin').using('brin', t.startedAt),
])
```

`bigint` epoch ms + **BRIN** on `started_at` for the append-only tables (cheap,
tiny, perfect for time-ordered inserts); B-trees on the access paths the UI
actually uses (`(application_id, started_at)`, `trace_id`).

**Partitioning.** `execution`, `span`, `execution_log` and `job_run` are
`PARTITION BY RANGE (started_at)` in the initial migration (drizzle-kit cannot
emit the clause, so the generated `CREATE TABLE` is amended once, by review).
A cron creates partitions 2 days ahead and drops expired ones. Consequence:
`ALTER TABLE`/index changes still work (Postgres propagates them to partitions),
but `CREATE INDEX CONCURRENTLY` cannot run inside the migrator's transaction —
index builds on hot tables are a maintenance job, not a migration.

### 4.6 Migrations

| | Decision |
|---|---|
| Tool | `drizzle-kit` (dialect `postgresql`) |
| Config | `apps/server/drizzle.config.ts` → `schema: './src/db/schema.ts'`, `out: './migrations'`, `dialect: 'postgresql'` |
| Generate | `bunx drizzle-kit generate` in the PR; the SQL diff is reviewed like code |
| Apply | `migrate(db, { migrationsFolder })` from `drizzle-orm/bun-sql/migrator`, at boot, under `pg_advisory_lock` |
| Bookkeeping | Drizzle's `__drizzle_migrations` (hash + `created_at`); **plus** `app_meta.schema_version` (monotonic integer) written by the runner, which is what the N-2 boot guard reads |
| Packaging | `--asset ./apps/server/migrations` embeds the folder in the binary; the entrypoint resolves it once and asserts it exists |
| Drift guard | CI runs `drizzle-kit generate` on a clean checkout and fails if it produces a diff ("schema changed without a migration") |

```ts
// apps/server/src/db/migrate.ts
import type { SQL } from 'bun'
import { migrate } from 'drizzle-orm/bun-sql/migrator'

type DrizzleDb = ReturnType<typeof createDb>['db']

export async function runMigrations(db: DrizzleDb, client: SQL, folder: string, appSchema: number) {
  const [meta] = await client`select to_regclass('app_meta') is not null as present`
  if (meta?.present) {
    const [row] = await client`select value::int as version from app_meta where key = 'schema_version'`
    if ((row?.version ?? 0) > appSchema) {
      throw new Error(`database schema ${row.version} is newer than this app (${appSchema}); upgrade the collector`)
    }
  }

  await client`select pg_advisory_lock(6245001)`
  try {
    await migrate(db, { migrationsFolder: folder })
    await client`insert into app_meta (key, value) values ('schema_version', ${appSchema})
      on conflict (key) do update set value = excluded.value`
  } finally {
    await client`select pg_advisory_unlock(6245001)`
  }
}
```

### 4.7 Ingest write path

No writer Worker: `Bun.SQL` is asynchronous and Postgres serializes at the row /
page level, so the ingest route can await its own inserts without stalling the
event loop or the dashboard queries.

```
ingest handler
  gunzip → validate → normalize (pure)
  batchWriter.push(normalized)        // bounded queue, 64 batches
        │
        ▼
  BatchWriter.flush()  (every 50 ms or 2,000 rows)
    BEGIN
      INSERT INTO execution … (multi-row, ON CONFLICT DO NOTHING)
      INSERT INTO span SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(…)
      INSERT INTO execution_log SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(…)
      INSERT INTO rollup_1m … ON CONFLICT (series, bucket) DO UPDATE SET …
    COMMIT
  200 {"degraded":false}              // returned once the batch is enqueued, not after COMMIT
```

- **Ack before commit** keeps ingest p99 low; a crash can lose the last ≤50 ms of
  telemetry, which is acceptable for APM data and documented.
- `ON CONFLICT DO NOTHING` on `(id)` absorbs the SDK's duplicate resend after a
  dead keep-alive socket (`ingest-api.md` §4.2).
- Queue full ⇒ `503` + `Retry-After: 5` (never `429`, never `degraded`), which
  the SDK treats as a dropped batch.
- Multi-replica is **not supported** in v0.x: the batch writer and the cron jobs
  assume one process. If it is ever needed, `pg_advisory_lock` per job name is
  already the mechanism (the migration lock proves the pattern).

### 4.8 Deployment: image + Postgres

The image is **stateless**. All state is in Postgres; there is no `/data`
volume.

```yaml
# docker-compose.yml (ships in the repo and inside every release tarball)
services:
  observe:
    image: ghcr.io/<org>/nestjs-openobserve:v0.2.0   # or @sha256:<digest>
    ports: ["4319:4319", "4320:4320"]
    environment:
      OBSERVE_DATABASE_URL: postgres://observe:${OBSERVE_DB_PASSWORD:?set me}@db:5432/observe
      OBSERVE_PUBLIC_URL: http://localhost:4320
    depends_on:
      db: { condition: service_healthy }
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: observe
      POSTGRES_PASSWORD: ${OBSERVE_DB_PASSWORD:?set me}
      POSTGRES_DB: observe
    volumes:
      - observe-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U observe -d observe"]
      interval: 5s
      timeout: 5s
      retries: 20
    restart: unless-stopped

volumes:
  observe-pgdata:
```

- **External database** (managed PG, RDS, Cloud SQL, existing cluster): drop the
  `db` service and point `OBSERVE_DATABASE_URL` at it. Nothing else changes; the
  collector needs `CREATE`/`ALTER` rights for migrations unless
  `OBSERVE_MIGRATE=off`.
- **Volume**: `observe-pgdata` is the only stateful thing in the compose file.
  Back it up like any Postgres.
- **Backup**: `pg_dump -Fc -d observe -f observe-$(date +%F).dump` (nightly), or
  the provider's PITR. Restore drill: `createdb observe_restore && pg_restore
  --no-owner -d observe_restore observe-*.dump`, then boot the collector against
  it with `OBSERVE_MIGRATE=off`. The repo ships `scripts/backup.sh` and
  `docs/backup-restore.md`; the release checklist (§10 of
  `release-pipeline.md`) runs the drill every release.
- **No `VOLUME` in the Dockerfile** — a stale anonymous volume would silently
  shadow a bind mount and confuse "where is my data?".

---

## 5. Small libraries — worth it or not

| Library | Verdict | Reason |
|---|---|---|
| **`drizzle-orm` + `drizzle-kit`** | **Yes** | Owner decision; the only way to keep a 20-table schema, generated SQL migrations and TypeScript row types in one place while still writing partitions/GIN by hand. |
| **`drizzle-typebox`** | **Yes** | Turns table definitions into Elysia/OpenAPI schemas, so a column rename is a compile error in the UI. |
| `kysely` | No | Its Postgres dialect wants `pg`; Drizzle has a first-party `bun-sql` driver and owns migrations. |
| `zod` / `valibot` | No | TypeBox is already an `elysia` peer and the only dialect that also feeds OpenAPI and `drizzle-typebox`. |
| `pino` / `winston` | No | `console.log(JSON.stringify(row))` + a `LOG_LEVEL` filter is enough; the product's own log pipeline must not depend on one. |
| `dotenv` | No | Bun loads `.env` automatically. |
| `uuid` / `nanoid` | No | `Bun.randomUUIDv7()` and `crypto.getRandomValues()` are global. |
| `date-fns` / `dayjs` | No | Time buckets are SQL; the UI uses `Intl.DateTimeFormat`. |
| `ws` / `ioredis` / `pg` / `better-sqlite3` | No | Bun natives replace all four and the CLAUDE.md rules forbid them. |
| `express` / `fastify` | No | Elysia. |
| `prisma` | No | Engine binaries break `--compile` and it duplicates the Drizzle decision. |
| `@tanstack/react-query`, `@tanstack/react-router` | **Yes** | Caching + URL-state routing are exactly the dashboard's needs and both are tiny at runtime. |
| `uplot` | **Yes** | 40 KB, canvas, built for 100k-point series. |
| `tailwindcss` | **Yes** | Bun's CSS bundler compiles it from an HTML import. |
| `oxlint`, `prettier` | **Yes (dev)** | Zero-config, matches the vendored SDK's tooling. |
| `release-please` | **Yes (CI only)** | See `release-pipeline.md` §2; not a runtime dependency. |
| `@modelcontextprotocol/sdk` | **Later (P2)** | Only when `/mcp` ships. |

---

## 6. Auth

### 6.1 Dashboard users

| Concern | Decision |
|---|---|
| Password storage | `await Bun.password.hash(pw, { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 })` (19 MiB / 2 passes; well under Bun's 64 MiB default so logins stay <100 ms) |
| Session | 32 random bytes → base64url; store `sha256(token)` in `session`, never the token; cookie `__Host-observe_session` (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, 30 d sliding) |
| CSRF | `SameSite=Lax` + `Origin` check on non-GET `/api/v1/*` |
| Roles | `admin` / `member` / `viewer`; enforced by the `requireCredential` macro (§7.2), not per-route boilerplate |
| First run | if `user` is empty, `GET /setup` renders the bootstrap form; `POST /api/v1/setup` succeeds only once (`INSERT … ON CONFLICT DO NOTHING` + row count check) |
| Rate limit | in-memory token bucket per IP+email on `/api/v1/session` (10/min), no dependency |
| OIDC | P2; same `session` table, `session.provider` column reserved |

### 6.2 App keys (ingest)

| Concern | Decision |
|---|---|
| Format | `key = "obs_" + base32(16 bytes)`, `secret = base64url(32 bytes)`; `x-api-key` / `x-api-secret` headers (`ingest-api.md` §2) |
| Storage | `app_credential(key_prefix UNIQUE, key_hash, secret_hash)`; both `sha256`; `key_prefix` = first 8 chars for the UI |
| Lookup | one indexed SELECT by `key_prefix`, then constant-time compare of both hashes; LRU 60 s keyed by prefix |
| Rotation | two active credentials per application allowed; `revoked_at` soft-delete; secret shown once at creation |
| Unauthenticated mode | `OBSERVE_REQUIRE_AUTH=false` (default when bound to loopback) accepts batches with no headers, as the SDK does when credentials are unset |
| Rejections | `401` **only** for a syntactically present but unknown/revoked pair; a missing pair is accepted in unauthenticated mode, otherwise `401` — never `403`, because the agent treats both identically but `401` is semantically right (`ingest-api.md` §5.4) |

### 6.3 Authorization on the query API

`Authorization: Bearer <api-key>` is accepted as an alternative to the session
cookie, scoped to one application (read-only). Keys are the same
`app_credential` rows with `scopes: ["read"]`.

---

## 7. Monorepo and server structure

### 7.1 Layout

```
nestjs-openobserve/
├── package.json                 # workspaces: ["apps/*", "packages/*"]; private: true
├── bun.lock                     # committed
├── bunfig.toml                  # [install] exact, [test] preload/coverage
├── tsconfig.json                # base; paths → @observe/shared
├── docker-compose.yml           # collector + postgres (§4.8)
├── .dockerignore                # excludes repos/, .prompts/, docs/, .github/
├── .gitattributes               # export-ignore repos/, .prompts/, docs/, .github/
├── .github/workflows/           # ci.yml, release.yml, codeql.yml
├── apps/
│   ├── server/
│   │   ├── package.json         # @observe/server
│   │   ├── Dockerfile           # multi-stage, cross-compile, distroless
│   │   ├── drizzle.config.ts    # dialect postgresql, schema src/db/schema.ts
│   │   ├── migrations/          # drizzle-kit output (SQL + meta/_journal.json)
│   │   └── src/
│   │       ├── index.ts             # boot: env → db → migrate → listen → workers
│   │       ├── env.ts               # one TypeBox schema for every OBSERVE_* var
│   │       ├── db/
│   │       │   ├── schema.ts        # pg-core tables (single source)
│   │       │   ├── client.ts        # Bun.SQL + drizzle
│   │       │   └── migrate.ts       # advisory lock + schema_version guard
│   │       ├── plugins/
│   │       │   ├── config.ts        # name: 'plugin.config'  → decorate('config')
│   │       │   ├── db.ts            # name: 'plugin.db'      → decorate('db', 'sql')
│   │       │   ├── auth.ts          # name: 'plugin.auth'    → macro requireCredential
│   │       │   └── metrics.ts       # name: 'plugin.metrics' → state counters
│   │       └── modules/
│   │           ├── telemetry/       # ingest: index.ts · controller.ts · service.ts · model.ts
│   │           ├── applications/    #        index.ts · controller.ts · service.ts · model.ts
│   │           ├── executions/
│   │           ├── traces/
│   │           ├── errors/
│   │           ├── logs/
│   │           ├── jobs/
│   │           ├── metrics/
│   │           ├── slos/
│   │           ├── alerts/
│   │           ├── projects/
│   │           ├── sessions/
│   │           ├── cli-link/        # device-code flow
│   │           ├── health/
│   │           ├── api/index.ts     # mounts every feature module once (api app)
│   │           └── worker.ts        # @elysiajs/cron registrations
│   └── web/
│       ├── package.json         # @observe/web (private)
│       ├── index.html           # Bun HTML entry (React + Tailwind)
│       └── src/ (routes, components, charts, api.ts ← Eden treaty)
├── packages/
│   └── shared/
│       ├── package.json         # @observe/shared
│       └── src/
│           ├── wire.ts          # TypeBox contract types (single source)
│           ├── rows.ts          # DTO types shared by server + web
│           ├── validation.ts    # compiled TypeCompiler instances
│           ├── fixtures/*.json  # frozen SDK payloads for conformance tests
│           └── constants.ts     # ports, header names, limits
├── repos/                       # vendored SDK — never in an artifact
├── public/                      # BUILT web assets (gitignored, embedded via --asset)
├── docs/
└── .prompts/
```

### 7.2 Elysia module structure (the house style)

Every feature is a folder with four files and no cross-module imports except
through services:

| File | Responsibility | Rules |
|---|---|---|
| `index.ts` | the Elysia plugin/module for the feature: `new Elysia({ name: 'module.<feature>', prefix: '/<feature>' })`, `.use(plugins)`, route declarations | only file that touches Elysia; exported and mounted once by `modules/api/index.ts` |
| `controller.ts` | handler bodies (validation → call service → shape response) | thin: no SQL, no business rules; reads only from `ctx` |
| `service.ts` | all logic + Drizzle queries, plain class/function taking `{ db }` | no Elysia types, unit-testable without HTTP |
| `model.ts` | `drizzle-typebox` select/insert schemas + `t.Pick`/`t.Omit` DTOs + request schemas | single source for validation, OpenAPI and Eden |

```ts
// apps/server/src/modules/executions/index.ts
import { Elysia } from 'elysia'
import { dbPlugin } from '../../plugins/db.ts'
import { authPlugin } from '../../plugins/auth.ts'
import { ExecutionParams, ExecutionResponse } from './model.ts'
import { getExecution } from './controller.ts'

export const executions = new Elysia({ name: 'module.executions', prefix: '/executions' })
  .use(dbPlugin)
  .use(authPlugin)
  .get('/:id', getExecution, {
    params: ExecutionParams,
    response: { 200: ExecutionResponse },
    requireCredential: 'read',
    detail: { tags: ['executions'], summary: 'Execution with spans and error' },
  })

// apps/server/src/modules/executions/controller.ts
// `db` comes from the db plugin's decorate; the service is a pure function of it.
export const getExecution = ({ db, params }: { db: DrizzleDb; params: { id: string } }) =>
  ExecutionService.byId(db, params.id)
```

The plugin/scoping vocabulary we standardize on:

| Primitive | Where | Why |
|---|---|---|
| `name` on every plugin | all of `plugins/*` and `modules/*/index.ts` | Elysia dedupes by name+seed; a module mounted from two places must not register routes twice. |
| `decorate` | `plugins/config.ts` (`config`), `plugins/db.ts` (`db`, `sql`) | long-lived singletons created once at boot, shared by every request. |
| `state` | `plugins/metrics.ts` (`{ ingestOk: 0, ingestBytes: 0, ingest4xx: 0, queueDepth: 0 }`) | mutable counters survive across requests and are read by `/health`; never store per-request data here. |
| `derive` | api app: `requestId` (UUIDv7), `startedAt` (epoch ms), `session` (resolved once from the cookie) | request-scoped, typed, and available in the handler and `afterResponse` without re-parsing. |
| `macro` | `plugins/auth.ts` → `requireCredential: 'read' \| 'write' \| 'admin'` | reusable guard that returns `status(401)`/`status(403)` and injects the resolved credential; routes opt in with one line and OpenAPI shows the requirement. |
| `resolve` | inside the macro only | runs after validation, so it can trust `params`/`body`. |
| `onStop` | `plugins/db.ts` | `sql.close()` on SIGTERM, after the writer flush. |

```ts
// apps/server/src/plugins/auth.ts
import { Elysia } from 'elysia'

export const authPlugin = new Elysia({ name: 'plugin.auth' }).macro({
  requireCredential: (scope: 'read' | 'write' | 'admin') => ({
    async resolve({ cookie, headers, status }) {
      const session = await verifySession(cookie['__Host-observe_session']?.value)
      if (session) return { session, credentialScope: session.role }
      const key = headers.authorization?.replace(/^Bearer /, '')
      const cred = key ? await verifyApiKey(key) : null
      if (!cred) return status(401, { error: 'unauthorized' })
      if (!cred.scopes.includes(scope)) return status(403, { error: 'forbidden' })
      return { apiKey: cred, credentialScope: scope }
    },
  }),
})
```

Anti-patterns, explicitly banned: request data in `state`; `decorate` with a
value derived from the request; business logic in a controller; one giant
`app.ts`; importing another module's `service.ts` directly instead of going
through its exported provider.

### 7.3 Manifests

```json
// package.json
{
  "name": "nestjs-openobserve",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "bun --hot apps/server/src/index.ts",
    "dev:web": "bun --hot apps/web/index.html",
    "build": "bun run build:web && bun run build:server",
    "build:web": "bun build apps/web/index.html --outdir public --minify --production",
    "build:server": "bun build apps/server/src/index.ts --target=bun --outdir apps/server/dist --minify",
    "compile": "bun build apps/server/src/index.ts --compile --minify --sourcemap --bytecode --asset ./public --asset ./apps/server/migrations --outfile dist/nestjs-observe",
    "db:generate": "cd apps/server && bunx drizzle-kit generate",
    "db:migrate": "bun run apps/server/src/db/migrate-cli.ts",
    "test": "bun test",
    "typecheck": "bun check",
    "lint": "oxlint --type-aware apps packages",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "@types/bun": "1.4.4",
    "typescript": "^7",
    "drizzle-kit": "0.31.11",
    "oxlint": "^1",
    "prettier": "^3"
  }
}
```

```jsonc
// apps/server/package.json
{
  "name": "@observe/server",
  "private": true,
  "type": "module",
  "dependencies": {
    "elysia": "^1.4.30",
    "@elysiajs/cors": "^1.4.2",
    "@elysiajs/cron": "^1.4.2",
    "@elysiajs/openapi": "^1.4.16",
    "@elysiajs/static": "^1.4.10",
    "drizzle-orm": "0.45.4",
    "drizzle-typebox": "0.3.3",
    "@observe/shared": "workspace:*"
  }
}
```

```jsonc
// apps/web/package.json
{
  "name": "@observe/web",
  "private": true,
  "type": "module",
  "dependencies": {
    "react": "^19",
    "react-dom": "^19",
    "@tanstack/react-query": "^5",
    "@tanstack/react-router": "^1",
    "uplot": "^1",
    "@observe/shared": "workspace:*"
  },
  "devDependencies": {
    "@elysiajs/eden": "^1.4.9",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "tailwindcss": "^4"
  }
}
```

`@elysiajs/eden` is a **type-only** import of `typeof apiApp` in the SPA, so it
never reaches the browser bundle.

```ts
// tsconfig.json (excerpt)
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "module": "Preserve",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "types": ["bun"],
    "paths": { "@observe/shared": ["./packages/shared/src/index.ts"] }
  }
}
```

### 7.4 Frontend bundling (no Vite)

`apps/web/index.html` imports `./src/main.tsx`; `bun build` bundles React,
Tailwind and the router into `./public` with hashed asset names, and
`--asset ./public` embeds that tree so it is reachable at
`join(import.meta.dir, "public")` inside the compiled binary (the same contract
Bun documents for `--asset`
([docs](https://bun.com/docs/bundler/executables#embed-directories))). The api
app serves it with `staticPlugin({ assets: join(import.meta.dir, "public"), prefix: "/", indexHTML: true })`.
Resolve that path **once in the entrypoint** (`apps/server/src/index.ts`) and
pass it into the api app: inside a compiled binary embedded files hang off the
entrypoint's `import.meta.dir`, and a per-module `import.meta.dir` may resolve to
a nested bundle path. Boot asserts `Bun.file(join(assetRoot, "index.html")).exists()`
and exits with `OBSERVE_WEB_DIR is wrong` otherwise. In dev the same variable
defaults to `<repo>/public`, and `bun --hot apps/web/index.html` runs the SPA on
its own port with HMR ([Bun HTML imports](https://bun.com/docs/runtime/html-imports)).

same rule for migrations: `--asset ./apps/server/migrations`, resolved in the
entrypoint as `join(import.meta.dir, 'apps/server/migrations')`, with
`OBSERVE_MIGRATIONS_DIR` as the dev/CLI override.

**Deviation from `PLAN.md` §7** (which said "React + Vite"): keeping one bundler
removes a second toolchain, a second lockfile and a `dist/` copy step, and Bun
supports React/CSS/Tailwind from HTML imports natively. Escape hatch: if a
required plugin (e.g. React Compiler) blocks us, add Vite for `apps/web` only —
the server's `--asset` step does not care who produced the directory.

### 7.5 Test layout

```
apps/server/src/**/*.test.ts          # unit (pure functions, validators, services with a fake Db)
apps/server/test/*.int.test.ts        # real Postgres, app.handle() / fetch against a live app
packages/shared/test/contract.test.ts # fixture → validator conformance
```

`bunfig.toml`:

```toml
[install]
exact = true

[test]
preload = ["./test/setup.ts"]
coverage = true
coverageReporter = ["text", "lcov"]
coveragePathIgnorePatterns = ["**/*.test.ts", "apps/web/**", "packages/shared/fixtures/**"]
coverageThreshold = { lines = 0.70, functions = 0.75 }
```

Isolation for integration tests: `test/setup.ts` connects to
`OBSERVE_TEST_DATABASE_URL`, creates one template database per run
(`CREATE DATABASE observe_tmpl TEMPLATE …` after migrations), and each test file
gets `CREATE DATABASE observe_test_<rand> TEMPLATE observe_tmpl` — cheap, real
Postgres, no cross-test bleed. CI provides `postgres:16-alpine` (§7.1 of
`release-pipeline.md`).

---

## 8. Conformance testing against the vendored wire contract

The rule from `AGENTS.md` is absolute: **no runtime or test import from
`repos/`**. So the contract is *frozen*, not *linked*:

1. `scripts/gen-fixtures.ts` (dev-only, never in an artifact) imports the
   vendored encoders from `repos/observe/src/encoders/*` and the validators from
   `telemetry-wire-contract.ts`, and writes
   `packages/shared/src/fixtures/<encoder>.json` — one real batch body per
   encoder (`request-snapshot`, `trace`, `job-snapshot`, `runtime-metrics`,
   `custom-metrics`, `logs`, `objectives`) plus malformed variants.
2. The same script writes `packages/shared/src/fixtures/CONTRACT.sha256` — the
   SHA-256 of `repos/observe/src/agent/telemetry-wire-contract.ts`.
3. `contract.test.ts` asserts, for every fixture:
   - our compiled TypeBox validator **accepts** it,
   - `normalize()` produces rows whose required columns are non-null,
   - a body with one unknown key, one wrong type and one missing required field
     is **rejected** (because that is what must yield `400`),
   - our `200` body is exactly `{"degraded":false}`.
4. CI runs `bun scripts/gen-fixtures.ts --check` on every PR: if the vendored
   contract hash differs from `CONTRACT.sha256`, the job fails and says "SDK
   subtree changed — regenerate fixtures and review the diff". That is the trip
   wire for a silent wire-format change.
5. A live smoke test (`test/e2e/agent.test.ts`, `bun test --filter e2e`) boots
   the ingest app against a scratch database, points a fixture sender at it, and
   asserts rows land in Postgres. It is excluded from the default `bun test` run
   (tagged) because it binds a port and needs a database.

---

## 9. Data flow

```
┌──────────────┐  POST /applications/telemetry (gzip, x-api-key/-secret)
│ @nestjs/     │  POST /cli-link/sessions|token
│ observe SDK  │─────────────────────────────────────────────┐
└──────────────┘                                             │
                                                             ▼
                                    ┌────────────────────────────────────────┐
                                    │ ingestApp :4319 (Elysia, aot)           │
                                    │  onRequest: —                          │
                                    │  1. size guard (maxRequestBodySize)    │
                                    │  2. gunzip → JSON.parse                 │
                                    │  3. auth: key_prefix → hash compare     │
                                    │  4. validate: compiled TypeBox (strict) │
                                    │  5. normalize (pure, no I/O):           │
                                    │     • snapshot → execution + spans      │
                                    │     • error fingerprint (class+msg+frame)│
                                    │     • log trace/span correlation        │
                                    │     • job/cron → job_run                │
                                    │     • runtime/custom → metric_point     │
                                    │     • minute-bucket rollup counters     │
                                    │  6. batchWriter.push(normalized)       │
                                    │  7. 200 {"degraded":false}              │
                                    └───────────────┬────────────────────────┘
                                                    │ bounded queue (64)
                                                    ▼
                         ┌──────────────────────────────────────────────┐
                         │ BatchWriter (in-process, every 50 ms)        │
                         │  BEGIN                                        │
                         │    INSERT execution (multi-row, ON CONFLICT) │
                         │    INSERT span FROM jsonb_to_recordset($1)   │
                         │    INSERT execution_log FROM jsonb_to_recordset│
                         │    UPSERT rollup_1m                          │
                         │  COMMIT                                       │
                         └───────────────┬──────────────────────────────┘
                                         │ Bun.SQL (native, pooled)
                                         ▼
                    ┌─────────────────────────────────────────┐
                    │  PostgreSQL 16+  (required)              │
                    │  execution / span / execution_log /      │
                    │  job_run / metric_point / error_group /  │
                    │  runtime_sample / rollup_1m / rollup_1h  │
                    │  — daily RANGE partitions; jsonb + GIN   │
                    │  schema owned by Drizzle (schema.ts)     │
                    └───────┬─────────────────────────┬────────┘
                            │ SQL (Drizzle)           │ writes
                            ▼                         ▼
   ┌──────────────────────────────────┐   ┌─────────────────────────────────┐
   │ apiApp :4320 (Elysia modules)    │   │ worker (@elysiajs/cron)         │
   │  session cookie / Bearer api-key │   │  rollup_1m → 1h → 1d            │
   │  /api/v1/*  (Eden-typed)         │   │  SLO restatement (hourly)       │
   │  /openapi, /mcp                  │   │  alert evaluation (30 s)        │
   │  static SPA (embedded assets)    │   │  retention prune / partition    │
   └───────────────┬──────────────────┘   │  create (daily, DROP PARTITION) │
                   │ JSON                  └─────────────────────────────────┘
                   ▼
   ┌──────────────────────────────────┐
   │ SPA (React, TanStack, uPlot)     │
   │ overview · traces · errors ·     │
   │ logs · jobs · metrics · SLOs     │
   └──────────────────────────────────┘
```

---

## 10. Performance budgets (targets, not measurements)

| Path | Budget | Enforced by |
|---|---|---|
| ingest, 5,000-item batch, p99 | < 25 ms to `200` (normalize + enqueue only) | benchmark in `apps/server/test/perf/ingest.bench.ts`, CI warn |
| batch writer throughput | ≥ 50k rows/s sustained on a 4-core + local Postgres | M4 load test |
| dashboard list query p95 | < 150 ms over 7 d of data | `SET LOCAL statement_timeout` + rollups |
| pool pressure | never > 80% of `OBSERVE_DB_POOL_MAX` under the ingest benchmark | `/health` exposes `inUse`/`idle` |
| compiled binary size | < 110 MB (Bun runtime ~90 MB) | release job asserts |
| cold start to listening | < 300 ms excluding migrations | `--bytecode`; measured in release job |
| memory RSS, idle | < 120 MB | soak test |

---

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Postgres is now a hard dependency | install friction; "why can't I just run the binary?" | compose file + one-command quickstart; `OBSERVE_DATABASE_URL` error message links to it; managed-PG path documented (§4.8) |
| `jsonb` + GIN bloat on huge tag maps | index size, slower writes | cap tag cardinality/size in the normalizer (drop oversized values, count them), TOAST handles long values, `pg_repack`/reindex documented |
| Long dashboard queries hold snapshots | bloat, lag | statement timeout + `LIMIT` + rollups for every chart |
| Pool exhaustion under ingest burst | latency spike, dropped batches | bounded queue + `503 Retry-After`; pool metrics in `/health`; ingest and dashboard can use separate pools (`OBSERVE_DB_POOL_*`) |
| Migration lock waits behind a long query | slow boot | `lock_timeout` + clear error; `OBSERVE_MIGRATE=off` for out-of-band migration |
| Drizzle's snapshot does not know about partitions | a later `generate` may try to rewrite a partition parent | initial migration is hand-amended once; CI drift check + review; partition keys never change |
| `CREATE INDEX CONCURRENTLY` cannot run in the migrator transaction | index builds lock writes | index builds on hot tables live in a maintenance job, not migrations |
| Drizzle/`drizzle-typebox` version skew | generated models break | pin all three exactly; upgrade in one PR with `bun test` + OpenAPI diff |
| Single replica only | no HA | documented; `pg_advisory_lock` per cron job is the path to multi-replica later |
| Losing the last ≤50 ms on crash (ack-before-commit) | tiny telemetry gap | documented as a design trade-off; `OBSERVE_INGEST_ACK=after-commit` exists for paranoid installs (costs latency) |
| Postgres 15/17 differences | CI matrix runs 15, 16, 17 | pin `postgres:16-alpine` in compose; CI proves the others |
| Elysia 2.0 breaks plugin APIs | upgrade pain | stay on 1.4.x; Elysia usage confined to `apps/server/src/{plugins,modules}` |
| TypeScript 7 (native) type-checking gaps | false greens | CI also runs `bun build --check` on the entrypoint |
| Bun's HTTP server has no built-in response compression | large dashboard JSON | reverse-proxy gzip documented; optional `mapResponse` gzip for `>1 KiB` |
| `Bun.password` argon2 cost per login | memory spike on concurrent logins | explicit `memoryCost: 19456`; login rate limit |

---

## 12. References

- Elysia: lifecycle <https://elysiajs.com/essential/life-cycle>, validation
  <https://elysiajs.com/essential/validation>, plugins
  <https://elysiajs.com/essential/plugin>, deploy/compile
  <https://elysiajs.com/patterns/deploy>, openapi
  <https://elysiajs.com/plugins/openapi>, static
  <https://elysiajs.com/plugins/static>, cors
  <https://elysiajs.com/plugins/cors>, cron
  <https://elysiajs.com/plugins/cron>, Eden
  <https://elysiajs.com/eden/overview>; config types
  <https://github.com/elysiajs/elysia/blob/main/src/types.ts>
- Bun: executables/`--compile`/`--asset`
  <https://bun.com/docs/bundler/executables>, `Bun.SQL`
  <https://bun.com/docs/runtime/sql>, `Bun.randomUUIDv7`
  <https://bun.com/docs/runtime/utils#bun-randomuuidv7>, hashing
  <https://bun.com/docs/runtime/hashing>, cron <https://bun.com/docs/runtime/cron>,
  workspaces <https://bun.com/docs/pm/workspaces>, lockfile
  <https://bun.com/docs/pm/lockfile>, testing
  <https://bun.com/docs/test/configuration>, Docker
  <https://bun.com/docs/guides/ecosystem/docker>
- Drizzle: Bun SQL driver <https://orm.drizzle.team/docs/connect-bun-sql>,
  PostgreSQL column types
  <https://orm.drizzle.team/docs/column-types/pg>, migrations
  <https://orm.drizzle.team/docs/migrations>, `drizzle-typebox`
  <https://orm.drizzle.team/docs/typebox>
- Postgres: partitioning
  <https://www.postgresql.org/docs/16/ddl-partitioning.html>, `jsonb`/GIN
  <https://www.postgresql.org/docs/16/datatype-json.html>,
  <https://www.postgresql.org/docs/16/gin.html>, backup
  <https://www.postgresql.org/docs/16/backup-dump.html>
- Vendored SDK: `repos/observe/package.json` (0.3.17), `repos/observe/LICENSE`
  (MIT), `repos/observe/src/agent/telemetry-wire-contract.ts`
