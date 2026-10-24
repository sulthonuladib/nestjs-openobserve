# AGENTS.md

Guidance for coding agents working in this repository.

## What this project is

A **self-hosted** implementation of the NestJS Observe backend: a collector that
speaks the `@nestjs/observe` SDK's ingest protocol, plus a dashboard with the
same features as the hosted product — minus pricing/billing.

Server: **Bun + ElysiaJS** on **Postgres**, modelled and migrated with
**Drizzle** (+ `drizzle-typebox` for API models). UI: SPA served by the same
binary. Feature modules live in `apps/server/src/modules/<feature>/`
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
apps/server/      Bun + ElysiaJS collector + query API (Postgres/Drizzle)
apps/web/         Dashboard SPA
packages/         Shared schema, types, generated API client
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
- `bun test`, `bun run typecheck`, `bun run lint` must pass before a PR.
