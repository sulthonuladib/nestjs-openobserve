# nestjs-openobserve

A self-hosted backend for the [`@nestjs/observe`](https://github.com/nestjs/observe)
SDK: the collector, the storage and the dashboard that the hosted product runs,
minus pricing.

Point the agent at it and it reports:

```bash
OBSERVE_ENDPOINT=http://localhost:4319     # instead of observe-api.nestjs.com
```

No npm package. No plans, no seats, no event metering, no overage pauses — the
collector **always** answers `{"degraded":false}`, so the agent never withholds
data. You run it because you want your telemetry on your own disk, not because a
tier allows it.

---

## Quick start

```bash
docker compose up -d          # Postgres on :5433
cp .env.example .env
bun install
bun dev                       # ingest :4319, dashboard :4320
```

Open **http://localhost:4320**. With no admin yet you get the setup screen:
instance name, your email, a password. That creates the first admin and then
locks itself — `/setup` is never served again.

Then, in a NestJS app:

```bash
bun add @nestjs/observe
OBSERVE_ENDPOINT=http://localhost:4319 bun run start
```

No key pair is required by a local collector. A real one comes from the
device-code flow:

```bash
OBSERVE_ENDPOINT=http://localhost:4319 npx @nestjs/observe link
```

It prints a code, you approve it at `http://localhost:4320/#/link`, and it
writes `OBSERVE_APP_KEY` / `OBSERVE_APP_SECRET` into the app's `.env`.

Single-port deployment (one reverse proxy in front):

```bash
OBSERVE_SINGLE_PORT=1 bun dev   # everything on :4320
```

Seven copy-pasteable steps, clone to a reporting app:
**[`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md)**.

## What it is

| Component | Path | What it does |
|---|---|---|
| Collector | `apps/server/src/modules/ingest/` | Accepts the SDK's gzip telemetry batches, validates them against the wire contract, writes one transaction per batch |
| Query API | `apps/server/src/modules/*/` | Dashboard API, typed end-to-end from the Postgres schema via `drizzle-typebox` |
| Storage | `apps/server/src/db/` | Postgres + Drizzle, append-only tables, per-minute rollups |
| Shared contract | `packages/shared/src/wire.ts` | The wire contract, ported from the vendored SDK and kept equal to it by a test |
| Vendored SDK | `repos/observe/` | `@nestjs/observe` as a **git subtree** — read-only reference for agents and humans, never built, never shipped |

## Documentation

- **[`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md)** — clone to running collector to a reporting app, in seven steps
- **[`docs/SELF-HOSTED.md`](docs/SELF-HOSTED.md)** — identity, setup wizard, invites, CLI, ops
- **[`docs/COVERAGE.md`](docs/COVERAGE.md)** — every upstream capability, and where we are against it
- **[`docs/PLAN.md`](docs/PLAN.md)** — scope, architecture, data model, milestones
- **[`docs/spec/ingest-api.md`](docs/spec/ingest-api.md)** — the wire contract, cited from SDK source
- **[`docs/spec/dashboard-features.md`](docs/spec/dashboard-features.md)** — the hosted dashboard's pages, charts and workflows, reverse-engineered
- **[`docs/spec/dashboard-api.md`](docs/spec/dashboard-api.md)** — its REST surface
- **[`docs/spec/tech-stack.md`](docs/spec/tech-stack.md)** — stack decisions and the reasons
- **[`docs/spec/release-pipeline.md`](docs/spec/release-pipeline.md)** — versioning, image/tarball artifacts, CI

## Development

```bash
bun install
bun run typecheck      # every workspace package, then the root
bun test               # unit + conformance
bun test test/conformance   # just the SDK wire-contract equality checks
bun run scripts/smoke.ts --spawn   # ingest a realistic batch, read it back
```

`bun run dev` needs a Postgres: `docker compose up -d` starts one on `:5433`
(`:5432` is the conventional port, but a dev machine usually has one already).

### Migrations

```bash
bun run db:generate    # apps/server/drizzle/*.sql from src/db/schema.ts
bun run db:migrate     # apply
```

Forward-only, reviewed before merge. The server applies pending migrations at
boot unless `OBSERVE_RUN_MIGRATIONS=0`.

### The vendored SDK

```bash
git subtree pull --prefix=repos/observe https://github.com/nestjs/observe.git master --squash
```

`repos/` is excluded from the Docker build context, from `git archive` and from
every release artifact, and CI fails if any of it leaks into one. `test/conformance/`
imports the vendored contract on purpose — that is what makes a stale port fail
the build instead of rejecting a customer's batches.

## Configuration

See [`.env.example`](.env.example). Only `OBSERVE_DATABASE_URL` is required.

| Variable | Default | Purpose |
|---|---|---|
| `OBSERVE_DATABASE_URL` | `postgres://observe:observe@localhost:5432/observe` | Postgres 15+ |
| `OBSERVE_DATABASE_POOL` | `20` | connection pool size |
| `OBSERVE_INGEST_PORT` | `4319` | collector listener (internet-facing) |
| `OBSERVE_API_PORT` | `4320` | dashboard + query API |
| `OBSERVE_SINGLE_PORT` | `0` | serve both on `OBSERVE_API_PORT` |
| `OBSERVE_RUN_MIGRATIONS` | `1` | migrate at boot |
| `OBSERVE_ALLOW_ANONYMOUS_INGEST` | `1` | accept batches with no key pair (local dev) |
| `OBSERVE_PUBLIC_URL` | `http://localhost:4320` | origin used by `/cli-link` |

## Compatibility

| | |
|---|---|
| SDK | `@nestjs/observe >=0.3.17 <0.4.0`, vendored at `0275d36` |
| Ingest API | `v1` — the hosted collector's paths, unchanged |
| Postgres | 15, 16, 17 |

A batch the vendored contract accepts is never answered `400`; a batch is never
answered `degraded: true`. Those two invariants are tested, not promised.

## Licence

MIT. `@nestjs/observe` is MIT, © Kamil Mysliwiec — see [`NOTICE`](NOTICE).
