# Hosted Observe vs. this self-hosted build

Both run the same `@nestjs/observe` agent and speak the same protocol. The only
thing you change in your application is **where the telemetry goes** — and, if you
want, **whether it needs a key**.

---

## The one-line version

```diff
- # hosted (the default)
+ OBSERVE_ENDPOINT=http://localhost:4319
```

That is the whole migration. The SDK defaults to
`https://observe-api.nestjs.com` (`repos/observe/src/agent/observe-agent.worker.ts:43`)
and reads `OBSERVE_ENDPOINT` before falling back to it. Your instrumentation code —
`createObserveModule()`, `ObserveModule.forRoot()`, `ObserveInstrument`,
`@Objective()`, `TracerService` — does not change at all.

---

## Side by side

| | **Hosted** (`observe.nestjs.com`) | **This build** (`nestjs-openobserve`) |
|---|---|---|
| Agent / SDK | `@nestjs/observe` | **the same package, unmodified** |
| Where to send | `POST https://observe-api.nestjs.com/applications/telemetry` | `POST http://<your-host>:4319/applications/telemetry` |
| How to point at it | default | `OBSERVE_ENDPOINT=…` |
| Credentials | app key + secret per **project**, issued by the dashboard or `link` | same pair, issued by your own dashboard or `link` |
| Without credentials | the hosted collector **rejects** every batch (401) | accepted by default (`OBSERVE_ALLOW_ANONYMOUS_INGEST=1`) — a local collector should not need a key before you have a UI |
| Dashboard | `observe.nestjs.com` | `http://<your-host>:4320` |
| Install | sign up | `docker run` / `docker compose up` / `bun dev` |
| Data | their infrastructure, their retention | your Postgres, your disk, your backups |
| Account | email sign-up, teams, seats | first-run `/setup`, invites. No sign-up, no teams (`docs/SELF-HOSTED.md`) |
| Pricing, plans, overage | plans, monthly event allowance, spend caps | **none.** The collector always answers `{"degraded":false}` |
| Log retention | by plan | `retention.*` in settings, then `admin prune` |
| Upgrades | automatic | `docker pull` + restart; migrations run at boot |
| Support | vendor | yourself, with `admin info` and the audit log |

### What the agent hears back

This is the part people get wrong. The SDK reads exactly one thing from a `200`:
the `degraded` flag.

| Reply | Hosted meaning | Our meaning |
|---|---|---|
| `200 {"degraded":false}` | full ingest | **always** |
| `200 {"degraded":true…}` | over the allowance: span trees withheld | never sent |
| `401` / `403` | bad key: back off to one probe/hour | wrong/revoked key, same behaviour |
| `429` + `Retry-After` | rate/quota cap | rate cap only (yours to configure) |
| `400` | contract violation: strip, retry once | same — this is the SDK's repair path |

Because `degraded` is a billing concept and there is no billing here, the agent is
never told to withhold data. That single decision removes the entire quota
subsystem from the backend and from your mental model.

---

## Migrating hosted → self-hosted

1. **Run the collector.**
   ```bash
   docker compose up -d                 # Postgres
   cp .env.example .env
   bun dev                              # or: docker run … ghcr.io/<org>/nestjs-openobserve
   ```
2. **Claim the instance.** Open `http://localhost:4320`, complete `/setup`. That
   page is then gone for good.
3. **Point one app at it.**
   ```bash
   OBSERVE_ENDPOINT=http://localhost:4319 bun run start
   ```
   Leave `OBSERVE_APP_KEY`/`OBSERVE_APP_SECRET` unset for the first run: the agent
   omits the headers entirely when unconfigured, and the collector accepts it.
4. **Watch it arrive.** `curl -s localhost:4320/health` → `stats.batches`
   increments within one flush (5 s). The application appears in **Overview**.
5. **Issue a real key pair** when you are happy:
   ```bash
   OBSERVE_ENDPOINT=http://localhost:4319 npx @nestjs/observe link
   ```
   Approve the code at `http://localhost:4320/#/link`; the CLI writes
   `OBSERVE_APP_KEY`/`OBSERVE_APP_SECRET` into the app's `.env`. Then turn off
   anonymous ingest:
   ```bash
   OBSERVE_ALLOW_ANONYMOUS_INGEST=0 bun dev
   ```
6. **Keep the old one around for a day.** Both can run at once: unset
   `OBSERVE_ENDPOINT` in one replica to keep sending to the hosted collector while
   another reports here, and compare. When you are satisfied, delete the hosted
   keys.

> Your historical telemetry stays with the hosted product — this collector starts
> from the moment you point at it. There is no import because the hosted API has
> no export.

## Migrating self-hosted → hosted

The reverse is the same one line, plus a key pair from the hosted dashboard:

```bash
OBSERVE_ENDPOINT=https://observe-api.nestjs.com
OBSERVE_APP_KEY=…
OBSERVE_APP_SECRET=…
```

Your data does not travel. If you need it, `pg_dump` before you switch and keep
the dump; nothing in this schema is proprietary.

---

## Feature parity, honestly

`docs/COVERAGE.md` tracks all 74 upstream capabilities. The short version:

| Area | Status |
|---|---|
| Ingest, traces, span trees, waterfall, self time | **at parity** |
| Error grouping, fingerprints, source frames, resolve/ignore | **at parity** (source frames: stored, not yet rendered) |
| Logs, trace correlation | **at parity** for querying; no saved searches |
| Jobs / cron, queue wait, attempts | **endpoints done**, UI pending |
| Runtime and custom metrics | **endpoints done**, UI pending |
| Releases + regression verdict | **endpoints done**, UI pending |
| Per-user activity | **endpoints done**, UI pending |
| First-run setup, invites, RBAC, admin CLI | **at parity or better** (no mail relay required) |
| Time-series charts in the UI | pending — the endpoints exist, the SPA does not draw them yet |
| Alerts (8 metric families, anomaly detection, quiet hours, channels) | not built |
| SLOs (budgets, burn rate) | declarations ingested; budgets/burn-rate pending |
| Issues tracker | not built |
| Service map | not built |
| SSO / SAML | not built (planned M4) |
| MCP server | **not built, by decision** (`PLAN.md` §3.2) |
| CPU profiler | blocked upstream: the SDK's `profiling` option is commented out in 0.3.17 |
| Pricing, plans, seats, metering, invoices | **removed**, not "coming later" |

So: as a **collector** it accepts everything the agent sends, and every page that
reads raw telemetry works. What is genuinely absent is the *decision layer* —
alerts, SLO budgets, the issue tracker — and the charts that make the existing
data pleasant to look at.

---

## Which should you run?

**Use the hosted product** if you want alerts and SLOs today, want SSO, or would
rather not operate a database. Our missing pieces are exactly the ones that page
you at 3am.

**Use this** if the telemetry is the sensitive part — customer paths, query
strings, stack traces with source in them — or if per-event pricing is the reason
you have not instrumented everything. Nothing leaves your network, there is no
meter, and the agent cannot be told to degrade.

Running both for a week costs one environment variable and answers the question
with your own data.
