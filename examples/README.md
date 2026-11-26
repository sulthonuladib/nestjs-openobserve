# Examples

Small NestJS apps wired to this collector. They are **not** part of the root
package's build or test run: each has its own `package.json` and installs
`@nestjs/observe` from npm, the same way a customer's application does. Nothing
here imports `repos/`.

| Example                                            | What it exercises                                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`nestjs-basic/`](nestjs-basic/)                   | the minimum wiring, HTTP traces, errors, logs                                                       |
| [`nestjs-orders-gateway/`](nestjs-orders-gateway/) | an instrumented HTTP call to another service: the trace id crosses the hop without application code |
| [`nestjs-orders-api/`](nestjs-orders-api/)         | Postgres query spans, a BullMQ producer, `@Objective()` SLOs, custom metrics, request capture       |
| [`nestjs-orders-worker/`](nestjs-orders-worker/)   | BullMQ consumer with retries, cron and interval jobs, gauges, worker runtime metrics                |
| [`nestjs-microservices/`](nestjs-microservices/)   | a trace id crossing a `@nestjs/microservices` TCP hop through packet metadata                       |

```text
                    ┌────────────────────────────┐
  seed.sh ─────────▶│ nestjs-orders-gateway :3200│  (GATEWAY_ON=1)
                    │  POST /checkout            │
                    └───────────┬────────────────┘
                                │ HTTP, x-request-id copied by the SDK
                                ▼
                    ┌────────────────────────┐
                    │ nestjs-orders-api :3100│──▶ Postgres :5434
                    │  ObserveModule         │
                    └───────────┬────────────┘
                                │ BullMQ job (trace id inherited)
                                ▼
                    ┌────────────────────────┐
                    │ nestjs-orders-worker   │──▶ Postgres :5434
                    │  consumer + cron       │
                    └───────────┬────────────┘
                                │ gzip batches
                                ▼
                    ┌────────────────────────┐
                    │ collector + dashboard  │  http://localhost:4320
                    │  ObserveModule         │
                    └────────────────────────┘
```

## Quick start

1. Start the collector from the repository root:

   ```bash
   cd ../ && bun dev
   ```

2. Start Postgres and Redis for the apps (ports `5434` and `6380`):

   ```bash
   docker compose up -d
   ```

3. Install and start the API, then the worker, in two terminals:

   ```bash
   cd nestjs-orders-api && npm install && OBSERVE_ENDPOINT=http://localhost:4320 npm start
   cd nestjs-orders-worker && npm install && OBSERVE_ENDPOINT=http://localhost:4320 npm start
   ```

   The gateway is optional; start it in a third terminal when you want the
   three-service trace (see [Cross-service trace](#cross-service-trace)):

   ```bash
   cd nestjs-orders-gateway && npm install && OBSERVE_ENDPOINT=http://localhost:4320 npm start
   ```

4. Generate traffic:

   ```bash
   ./seed.sh
   ```

Open <http://localhost:4320> and look at:

| Page                  | What to expect                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Applications**      | `orders-gateway` when it is running, `orders-api` and `orders-worker`, all reporting                                                                                                      |
| **Requests / Traces** | request span → manual `validate-order` → `pg` query span; the queued job's trace continues in the worker. Through the gateway: one trace with a request in each of the three applications |
| **Jobs**              | `process-order` runs with queue wait and attempts, one planted failure + retry, plus the 30 s cron and 1 min interval                                                                     |
| **Errors**            | the `GET /orders/boom/:id` TypeError, with source frames in the detail drawer                                                                                                             |
| **Custom**            | `orders_created_total`, `orders_create_duration_ms`, `orders_processed_total`, `orders_queue_depth`, `orders_open`                                                                        |
| **SLOs**              | _List orders_ (99.9% availability, 99% under 250 ms) and _Create order_ (99.5%, 14 days)                                                                                                  |
| **Logs**              | every line the two processes write, grouped by application                                                                                                                                |

## Cross-service trace

Three applications, two hops, one `trace_id`. No application code copies an id
around: the SDK writes it on the wire and reads it back.

```bash
# from examples/, with the collector (bun dev at the repo root),
# Postgres/Redis (docker compose up -d), orders-api and orders-worker running
docker compose up -d
cd nestjs-orders-gateway && npm install && OBSERVE_ENDPOINT=http://localhost:4320 npm start
```

One request by hand:

```bash
curl -s -X POST http://localhost:3200/checkout \
  -H 'content-type: application/json' -H 'x-user-id: user-7' \
  -d '{"total": 120}'
# {"id":"8bbc4909-...","total":120,"status":"pending"}
```

Or the same traffic `seed.sh` sends, with the creates routed through the
gateway (everything else stays API-direct, so the gateway is optional):

```bash
GATEWAY_ON=1 ./seed.sh
```

Expected shape when `GET /api/v1/traces/<traceId>` answers (or the trace page
opens):

| Application      | Execution                  | Spans under it                                                                                                                        |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `orders-gateway` | `POST /checkout` (201)     | `GatewayController.checkout` → manual `price-cart`, `GatewayController.call` → `HttpService.request` → **`http POST localhost:3100`** |
| `orders-api`     | `POST /orders` (201)       | `OrdersController.create` → manual `validate-order`, `Queue.add`, `pg INSERT orders`                                                  |
| `orders-worker`  | job `orders/process-order` | `OrdersProcessor.process` → manual `load-order` → `pg SELECT`/`pg UPDATE`                                                             |

The outbound span is the proof of the hop: an `http` span named
`POST localhost:3100` under the gateway's request span, and a second execution
in a different application carrying the same `trace_id`.

How each hop keeps the id:

- **HTTP.** The SDK subscribes to `node:http`'s client diagnostics channel, so
  every outbound `node:http` request gets a span and the current id in
  `x-request-id` - unless the caller already set that header. `orders-api`'s
  default trace-id generator adopts an inbound `x-request-id` instead of
  minting one. Neither app mentions the header in its code.
- **BullMQ.** `queue.add()` runs inside the request's async context, and the
  queue is patched, so the job carries the id; the worker continues it.
- **The collector** groups executions by `trace_id` alone, which is why one
  trace can list three applications.

Check it in the database:

```sql
SELECT trace_id, application_id, kind, operation_row_id IS NOT NULL AS has_op
  FROM execution WHERE started_at > (extract(epoch FROM now())-600)*1000
  ORDER BY started_at DESC LIMIT 20;
```

One recent `trace_id` must appear three times, once per application, with the
gateway/API rows as `request` and the worker row as `job`.

### Which outbound clients are covered

On this SDK version both of Node's own clients are covered, with no patch and
no application code: `node:http`/`node:https` (axios, got, most SDKs) through the
`http.client.*` diagnostics channels, and undici - which the global `fetch` runs
on - through `undici:request:*`. Either way you get an `http` span and the
current id in `x-request-id`.

The exact caveats, measured rather than assumed:

- **`node:http` needs Node 22.12+** for the header half (the channel that
  publishes a request before its headers are sent exists from that version).
  Older runtimes get the span but not the id, so a "cross-service trace" there
  is three separate traces that look connected in the UI.
- **`fetch` is instrumented too on 0.3.17.** A temporary `fetch()` route in the
  gateway produced `http POST localhost:3100` and `orders-api` + `orders-worker`
  joined the same `trace_id`, so the common "`fetch` is not instrumented"
  advice does not hold for this version. The gateway still uses `HttpService`:
  one client in an example is easier to follow, and `node:http` is what most
  NestJS apps already reach for. The thing under test is that the header and the
  span come from the SDK - neither controller mentions either.
- **Anything that is neither client** (a raw TLS socket, a broker without an
  SDK integration) needs the id carried by hand: `x-request-id` for HTTP,
  packet metadata for `@nestjs/microservices` 12.0.4+.

## Microservice (TCP) hop

Same idea, a different wire. Two tiny apps, no database and no queue:

```bash
# terminal 1 - the consumer
cd nestjs-microservices/pricing-service && npm install && OBSERVE_ENDPOINT=http://localhost:4320 npm start

# terminal 2 - the caller
cd nestjs-microservices/checkout-service && npm install && OBSERVE_ENDPOINT=http://localhost:4320 npm start

# terminal 3
curl -s -X POST http://localhost:3302/quote \
  -H 'content-type: application/json' -d '{"total": 120}'
# {"orderId":"...","total":108,"discount":0.1}
```

One `trace_id` then covers `POST /quote` in `checkout-service` and the
`{"cmd":"quote"}` message in `pricing-service` - two applications, one trace.

**The channel is the packet's `metadata`.** A `ClientProxy` dispatch carries a
metadata bag, and `@nestjs/microservices` 12.0.4+ exposes it before the packet
leaves (`setOnDispatchHook`). The SDK installs that hook on the client it
instruments and writes the current trace id as `x-request-id` - the same name an
HTTP hop uses. The receiving side's default trace-id generator reads it back
from the handler context's `getMetadata()`, so the handler joins the caller's
trace. Neither controller mentions it.

That is also the version floor: with `@nestjs/microservices` below 12.0.4 the
SDK's propagation is a no-op and the two applications report two unrelated
traces. The pair is on Nest 12 for exactly that reason, while the orders example
stays on Nest 11.

## Notes

- `nestjs-orders-api`, `nestjs-orders-gateway` and the microservice pair are
  **CommonJS** on purpose. The SDK's source-context reader rejects ESM
  `file://` stack paths in 0.3.17, so a CommonJS build is what makes the error
  drawer's `codeFrames` (the failing source lines) appear.
  `nestjs-orders-worker` and `nestjs-basic` are ESM.
- `ObserveModule` is the **first** import in every root module. In the orders
  example it must come before `BullModule`, or a job still running at shutdown
  is never reported.
- `main.ts` calls `app.enableShutdownHooks()`; the worker calls `app.init()`
  instead of `listen()` because it has no port, and `pricing-service` connects
  a TCP microservice and then calls `init()` for the same reason.
- The collector accepts unauthenticated batches while
  `OBSERVE_ALLOW_ANONYMOUS_INGEST=1` (the default). For a real key pair, run
  `npx @nestjs/observe link` in either app and turn the flag off.
