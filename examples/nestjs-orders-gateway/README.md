# nestjs-orders-gateway

The front door of the orders example. It owns no data: `POST /checkout` prices
the cart, then calls [`../nestjs-orders-api/`](../nestjs-orders-api/), which
writes the order and queues a job for
[`../nestjs-orders-worker/`](../nestjs-orders-worker/).

What it demonstrates: **one trace id across three processes.** The gateway's
incoming request, the API's request, and the worker's job all report the same
`trace_id`, without any application code copying it around. The hop into the API
is an ordinary instrumented HTTP call; the hop into the worker is a BullMQ job.

## Run it

From `examples/` (this starts Postgres on `:5434` and Redis on `:6380`):

```bash
docker compose up -d
```

Then the API and the worker (two terminals, from their own directories), and
finally this app:

```bash
npm install
OBSERVE_ENDPOINT=http://localhost:4320 PORT=3200 npm start
```

## Routes

| Route | What it does |
|---|---|
| `POST /checkout` `{ "total": 42 }` | `price-cart` span, then `POST {ORDERS_API}/orders` |
| `POST /checkout` `{ "total": 42, "explode": true }` | same, and the worker fails its first attempt |
| `GET /orders?limit=20` | proxied read, one `pg` span in the API |
| `GET /orders/:id` | proxied read of one order |
| `GET /health` | liveness, no outbound call, no trace |

## Which outbound client, and why

`HttpService` is `@nestjs/axios`, and axios rides on `node:http`, which is a
client the SDK subscribes to through diagnostic channels: the call becomes an
`http POST localhost:3100` span under the request span, and the SDK writes the
current trace id into `x-request-id` before the headers go out. The API's
default trace-id generator reads that header, so it continues the same trace
instead of minting a new one.

Three details worth knowing when you point your own app at another service:

- **Node 22.12+** is required for the header half on `node:http` (the channel
  that publishes a request before its headers are sent only exists from there).
  Older runtimes still get the span, just not the id - and a trace that splits
  without saying so is worse than one that does not exist.
- **Global `fetch` is covered too in 0.3.17.** The SDK also subscribes to
  undici's `undici:request:*` channels, so `fetch()` gets an `http` span and the
  same `x-request-id`. Measured, not assumed: a temporary `fetch()` route in
  this app produced `http POST localhost:3100` and the API and worker joined the
  same trace id. This example keeps `HttpService` because it is the client the
  rest of the orders example already has; what it proves is the mechanism, not
  the client. Nothing in `gateway.controller.ts` sets a trace header.
- **Anything that is neither** - a raw TLS socket, a message broker without an
  SDK integration - needs `x-request-id` (or the packet metadata, for
  `@nestjs/microservices` 12.0.4+) carried by hand.

## Why CommonJS

Same reason as `nestjs-orders-api`: the SDK's source-context reader parses stack
frames as absolute paths and rejects ESM's `file://` form, so only a CommonJS
build sends `e.codeFrames` for an unhandled error.

## What to look at in the dashboard

| Page | What to expect |
|---|---|
| **Applications** | `orders-gateway`, `orders-api`, `orders-worker` |
| **Traces** | one trace with three executions: the gateway request, the API request, the worker job |
| **Requests** | `POST /checkout` with a nested `price-cart` span and the outbound `POST localhost:3100` span |
| **Logs** | the gateway's lines interleaved with the API's, one trace id apart |
