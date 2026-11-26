# AGENTS.md

Guidance for coding agents working in this repository.

## What this project is

A **self-hosted** implementation of the NestJS Observe backend: a collector that
speaks the `@nestjs/observe` SDK's ingest protocol, plus a dashboard with the
same features as the hosted product — minus pricing/billing.

Server: **Bun + ElysiaJS** on **Postgres**, modelled and migrated with
**Drizzle** (+ `drizzle-typebox` for API models). UI: SPA served by the same
binary. Feature modules live in `src/server/modules/<feature>/`
(`index.ts` controller, `service.ts`, `model.ts`), injected as named Elysia
plugins; `plugins/` holds config, the database and shared state.
Ship as a **Docker image** and **tar.gz release artifacts**. We do **not**
publish an npm package.

## Vendored repositories

This project vendors external repositories under `repos/` as **git subtrees**
(`git subtree add --squash`, never submodules).

- `repos/observe/` — the `@nestjs/observe` SDK (MIT, `nestjs/observe`,
  `master`). Home of the wire contract we must stay compatible with:
  `repos/observe/src/agent/telemetry-wire-contract.ts`.
- Treat `repos/` as **read-only reference material**. Do not edit it.
- Do not import from `repos/` in application code. The **one** exception is
  `test/conformance/`, which imports the SDK's `telemetry-wire-contract.ts` to
  assert our port equals it — that test is what makes a subtree bump fail the
  build instead of rejecting a customer's batches. Keep it the only importer.
- `repos/` is excluded from the Docker build context (`.dockerignore`) and from
  release artifacts (`.gitattributes export-ignore` + release workflow
  allowlist). A CI check fails the build if `repos/` leaks into an artifact.
- When unsure how a field is encoded, how the agent batches, retries, or reacts
  to a status code: read the SDK source and its `*.int-spec.ts` tests rather
  than guessing or searching the web.

Updating a vendored repo:

```bash
git subtree pull --prefix=repos/observe https://github.com/nestjs/observe.git master --squash
```

Record the SDK version you target in `docs/spec/ingest-api.md` when you bump it.

## Layout

```
src/server/       Bun + ElysiaJS collector + query API (Postgres/Drizzle)
src/wire.ts       The SDK wire contract port; src/fixtures.ts sample batches
public/           the dashboard: index.html + index.tsx (Bun's frontend entry)
                  + App.tsx, api.ts, pages/, components/, styles.css
drizzle/          Forward-only migrations
test/             api, conformance (imports repos/), web
repos/            Vendored SDK source (reference only, never shipped)
docs/spec/        Specifications derived from the SDK and the hosted product
```

## Rules

- **Never** add pricing, billing, plans, quotas, seats, invoicing or upgrade
  surfaces. Removed by design; see `docs/PLAN.md`.
- **Never** answer `degraded: true` from the collector. Every degraded mode in
  the SDK is a billing concept; the flag makes the agent drop data silently.
- Postgres/SQLite schema changes ship as forward-only migrations.
- Any new ingest field must be covered by a conformance test against the
  vendored wire contract.
- Conventional Commits. One logical change per commit.
- `bun run test`, `bun run typecheck` must pass before a PR. (`bun test` with no
  argument walks `repos/` and runs the SDK's own suites, which need Redis/MySQL;
  the `test` script names `test/` for that reason.)
- **A job is not a request.** `rollup_minute` and `execution` carry both kinds in
  the same tables, so every request-facing aggregate filters `kind = 'request'`:
  the applications list, the timeseries, the operations ranking, releases, users
  and merged histograms. Jobs have their own numbers (runs, failures, duration,
  **queue wait**, attempts) on `/jobs` and `/job`. A cron included in the request
  count makes throughput, error rate and p95 wrong in the same direction, and the
  overview is the page people trust most.

## Gotchas

- **`bun --hot` and the database pool.** `bun dev` re-evaluates the server module
  on every save but keeps the process; a pool created per load leaks one
  20-connection pool per edit until Postgres answers `sorry, too many clients`.
  `connectDatabase` caches the pool on `globalThis`, keyed by URL + size. Keep it
  that way, and if you add another long-lived handle (Redis, a worker), cache it
  the same way.
- **JSONB:** use `jsonbValue<T>()` from `src/server/db/schema.ts`, never Drizzle's
  `jsonb()` — the latter stringifies and Bun re-quotes it, double-encoding every
  value.
- **Source frames:** the SDK only captures them for CommonJS stacks; ESM
  `file://` frames are rejected upstream. `examples/nestjs-orders-api` is
  CommonJS on purpose. The vendored contract's field is `codeFrames`.
- **`fetch` is not instrumented.** The SDK patches `http`/`https`; an example app
  that calls another service with global `fetch`/undici produces no outbound span
  and does not propagate `x-request-id`. Use `@nestjs/axios`/`http.request`.
- **Eden cannot type a two-param nested path.** `/jobs` (list) plus
  `/jobs/:queue/:name` is not expressible in the typed client, and a job name can
  contain `/` anyway, so the job detail endpoint takes `?queue=&name=`. The page's
  own URL stays `/applications/:id/jobs/:queue/:name`.
- **No background worker exists** in the collector process; retention is
  `admin prune`, SLOs are computed on read. Alerts will need a worker.

