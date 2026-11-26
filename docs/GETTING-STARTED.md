# Getting started

For someone who just cloned this repo and wants a collector running with a real
NestJS app reporting to it. Every command below is the one that was actually run
to verify the product end to end.

Three things you need: **Bun**, **Postgres**, and a NestJS app.

---

## 1. Install

```bash
git clone <this repo> nestjs-openobserve
cd nestjs-openobserve
bun install
```

`repos/observe/` (the vendored SDK, ~2.7 MB) comes along with the checkout. It is
read-only reference material — not a dependency, not built, not shipped. You can
ignore it, and your editor should (`.vscode/settings.json` hides it).

## 2. Postgres

A collector with no database has nowhere to put telemetry, so this is required.

```bash
docker compose up -d          # postgres:17 on localhost:5433
cp .env.example .env          # OBSERVE_DATABASE_URL points at :5433
```

Already have Postgres? Skip the container and set:

```bash
export OBSERVE_DATABASE_URL=postgres://user:pass@host:5432/observe
```

Migrations run at boot. To apply them separately (a release job, say):

```bash
bun run db:migrate
```

## 3. Run it

```bash
bun dev          # collector + dashboard + SPA, all on :4320
```

`bun dev` is `bun --hot src/server/index.ts`. Bun's Fullstack Dev Server compiles
`public/index.tsx` and `public/styles.css` on demand and reloads them in place, so
there is no separate web dev server and no `:5173`: browse
`http://localhost:4320` and you are looking at the app the collector serves in
production.

**One port, no reverse-proxy requirement.** Ingest (`/applications/telemetry`,
`/cli-link/*`), the query API (`/api/v1/*`) and the dashboard are one origin, so
`OBSERVE_ENDPOINT` and the URL in your browser are the same host.

## 4. First-run setup

Open **http://localhost:4320**. There is no account yet, so you get
the setup screen rather than a login:

1. instance name, your email, a password of 10+ characters
2. that creates the **first admin**, the default project, and signs you in
3. **the setup screen is gone for good.** Afterwards `/setup` is not served and
   the endpoint answers `409` — it is not a reset button.

Automating a deployment? Skip the screen entirely:

```bash
OBSERVE_ADMIN_EMAIL=ops@example.com \
OBSERVE_ADMIN_PASSWORD='a long passphrase' \
bun dev
```

The admin is created at boot and `/setup` never appears. Add
`OBSERVE_ADMIN_PASSWORD_RESET=1` once to rotate it.

## 5. Point a NestJS app at it

```bash
cd ~/your-nest-app
bun add @nestjs/observe
```

```ts
// src/observe.ts
import { createObserveModule } from '@nestjs/observe';
export const { ObserveModule, ObserveInstrument } = createObserveModule();
```

```ts
// src/app.module.ts — ObserveModule first in imports
imports: [ObserveModule.forRoot({ serviceId: 'my-service' })]
```

```ts
// src/main.ts
const app = await NestFactory.create(AppModule, { instrument: ObserveInstrument });
app.enableShutdownHooks();   // without this the final flush never happens
```

```bash
OBSERVE_ENDPOINT=http://localhost:4320 bun run start
```

No key pair needed: with `appKey`/`appSecret` unset the SDK sends without
credential headers, and the collector accepts that by default
(`OBSERVE_ALLOW_ANONYMOUS_INGEST=1`). You will see this in the app's log:

```
[ObserveAgentWorker] Observe is connected: http://localhost:4320 accepted this app's first batch.
```

### With a real key pair instead

Keys are scoped to a **project**, and the `link` flow issues them:

```bash
OBSERVE_ENDPOINT=http://localhost:4320 npx @nestjs/observe link
```

It prints a code; type it at `http://localhost:4320/link` (the
verification URL it prints), approve it, and the CLI writes `OBSERVE_APP_KEY` /
`OBSERVE_APP_SECRET` into the app's `.env` and wires `--env-file` into its start
scripts. It should end with the identity it linked to — `Linked to my-app in
Default.` If the names are `undefined`, the collector answered the poll without
the project/application identity; if the app then shows up twice in Overview, the
`serviceId` the CLI wired does not match the one the collector stored (the
derivation is the SDK's own: lower-cased, scoped `@scope/name` reduced to
`name`). Then turn anonymous ingest off:

```bash
OBSERVE_ALLOW_ANONYMOUS_INGEST=0 bun dev
```

## 6. Check it worked

```bash
curl -s localhost:4320/health
# {"ok":true,...,"stats":{"batches":2,"executions":21,...}}
```

Then in the dashboard: the application appears in **Overview** within one flush
interval (5 s by default), its operations are ranked by volume, each row opens a
waterfall, and a thrown exception shows up under **Errors** with the in-app source
frame the agent captured.

There is a script that does the whole loop — traffic, flush, read back:

```bash
./scripts/e2e-nest.sh                    # assumes :3001 and :4320
APP=http://localhost:3001 COLLECTOR=http://localhost:4320 ./scripts/e2e-nest.sh
```

## 7. Run it for real

```bash
docker run -d --name observe \
  -p 4320:4320 \
  -e OBSERVE_DATABASE_URL=postgres://user:pass@db:5432/observe \
  -e OBSERVE_ADMIN_EMAIL=ops@example.com \
  -e OBSERVE_ADMIN_PASSWORD='a long passphrase' \
  ghcr.io/<org>/nestjs-openobserve:latest
```

| You should know | |
|---|---|
| **Ports** | one port, `4320`: ingest, query API and dashboard on the same origin |
| **Backup** | one database: `pg_dump` it. Nothing else holds state |
| **Upgrade** | pull and restart; migrations run at boot; supported from the two previous minor versions |
| **Downgrade** | refused — the server will not start on a schema newer than it understands |
| **Locked out?** | `docker exec observe /app/nestjs-openobserve admin reset-password --email you@example.com` |
| **Disk** | retention is yours to set: `retention.traces`/`logs`/`metrics` days, then `admin prune` |
| **Ingest is public** | unless you set `OBSERVE_ALLOW_ANONYMOUS_INGEST=0` and issue keys — see `docs/SELF-HOSTED.md` |

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `setup required no` on a fresh DB | the `drizzle` schema survived a `public` reset — `DROP SCHEMA public, drizzle CASCADE` |
| Agent logs "Could not reach the collector" | it is pointed at the wrong port or host; the collector listens on `:4320` only |
| Agent logs "Telemetry rejected (401)" | keys are set but wrong/revoked; unset them or re-run `link` |
| Dashboard is empty but `/health` shows batches | you are looking at a different project/app filter; check **Overview** for the `serviceId` |
| `too many clients already` | several dev servers share one Postgres; `docker compose restart postgres` or raise `max_connections` |
