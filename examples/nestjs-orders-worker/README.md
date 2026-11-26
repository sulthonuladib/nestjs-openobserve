# nestjs-orders-worker

The queue half of the orders example: a BullMQ consumer, two scheduled handlers
and two custom gauges. It has no HTTP port.

Pair it with [`../nestjs-orders-api/`](../nestjs-orders-api/), which produces the
jobs and shares the database.

## Run it

Start the API first (or let this create the table). From this directory:

```bash
npm install
OBSERVE_ENDPOINT=http://localhost:4320 npm start
```

Then generate traffic against the API:

```bash
../seed.sh
```

## What it demonstrates

- **BullMQ jobs.** `@Processor("orders")` runs are reported with queue wait,
  attempt number and outcome. A job added inside a request inherits the
  request's trace id, so its spans join the same trace.
- **Retries and failures.** `POST /orders` with `{ "explode": true }` fails the
  first attempt; BullMQ retries and the retry succeeds. Both attempts appear,
  with the failure reason on the first.
- **Cron / interval jobs.** `@Cron` every 30 s and `@Interval` every minute are
  jobs too — same Jobs page, same duration chart, silence detectable.
- **Custom gauges.** `orders_queue_depth` (additive) and `orders_open` (peak)
  show up under Custom.
- **Worker runtime.** `runtimeMetrics` reports CPU, heap, GC and event-loop
  delay for this process as its own application (`orders-worker`).

## Why `init()` and not `listen()`

A worker has no HTTP server to bind. `NestFactory.create` + `app.init()` starts
every provider — the BullMQ worker, the schedule registry, the Observe agent —
without opening a port. `enableShutdownHooks()` is still required, or the final
batch is lost when the process stops.
