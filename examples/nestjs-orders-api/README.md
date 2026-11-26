# nestjs-orders-api

The HTTP half of the orders example. It writes orders to Postgres, enqueues a
BullMQ job for each one, and declares SLOs and custom metrics.

Pair it with [`../nestjs-orders-worker/`](../nestjs-orders-worker/), which
consumes the queue. Both report into the same project.

## Run it

From `examples/` (this starts Postgres on `:5434` and Redis on `:6380`):

```bash
docker compose up -d
```

From this directory:

```bash
npm install
OBSERVE_ENDPOINT=http://localhost:4320 PORT=3100 npm start
```

Then start the worker (second terminal) and generate traffic:

```bash
../seed.sh
```

## Routes

| Route | What it shows in the dashboard |
|---|---|
| `GET /orders` | request span, a `pg` query span, a log line, the list-orders SLO |
| `GET /orders/:id` | a single query |
| `POST /orders` `{ "total": 42 }` | insert, a manual `validate-order` span, a queued BullMQ job, the create counter and summary |
| `POST /orders` `{ "total": 42, "explode": true }` | same, but the worker fails its first attempt → a retry and a job failure |
| `GET /orders/slow/1500` | a slow request; p95 and the latency SLO move |
| `GET /orders/boom/9` | an unhandled TypeError → an error group with captured source frames |
| `GET /orders/handled/9` | a caught error reported with `captureError`, still a 200 |

## Why CommonJS

`package.json` has no `"type": "module"` and `tsconfig` compiles to CommonJS.
That is deliberate: the SDK's source-context reader parses stack frames as
absolute paths and rejects ESM's `file://` form, so only a CommonJS build sends
`e.codeFrames`. With it, **Errors → a group → latest occurrence** shows the
failing lines around `OrdersController.boom`, not just a file and line number.

## What this demonstrates

- **Database spans.** The SDK patches `pg`; every query in `Database.pool`
  becomes a span with its statement. An ORM on top of `pg` would work the same.
- **Queue trace continuity.** `queue.add()` runs inside the request trace, so the
  worker that processes the job continues the same trace id.
- **Code-owned SLOs.** `@Objective()` declarations are sent with the first
  request that reaches the handler, and appear on the SLOs page.
- **Custom metrics.** `orders_created_total` (counter) and
  `orders_create_duration_ms` (summary) appear under Custom.
- **Error source frames.** `sourceContext` is on, so the error drawer can show
  the throw site. `GET /orders/boom/9` is the way to make one.

The worker's cron job also reports `orders_open` as a gauge, so the dashboard has
one point-in-time series alongside the counters.
