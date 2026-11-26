# nestjs-microservices

Two small apps that talk over **TCP**, to show how a trace id crosses a
`@nestjs/microservices` hop.

| App | Role | Port |
|---|---|---|
| [`checkout-service/`](checkout-service/) | HTTP app; sends `{ cmd: "quote" }` to pricing | `3302` |
| [`pricing-service/`](pricing-service/) | TCP microservice; answers the quote | `3301` (TCP) |

```text
  curl ──▶ checkout-service :3302 ──TCP packet──▶ pricing-service :3301
            POST /quote            x-request-id    @MessagePattern({cmd:"quote"})
                 │                  in metadata          │
                 └────────────── one trace_id ──────────┘
```

## Run it

```bash
# terminal 1 - the consumer
cd pricing-service && npm install && OBSERVE_ENDPOINT=http://localhost:4320 npm start

# terminal 2 - the caller
cd checkout-service && npm install && OBSERVE_ENDPOINT=http://localhost:4320 npm start

# terminal 3 - one request
curl -s -X POST http://localhost:3302/quote -H 'content-type: application/json' -d '{"total": 120}'
# {"orderId":"...","total":108,"discount":0.1}
```

Then open the trace for that request (`POST /quote`) in the dashboard: two
applications, one `trace_id`.

## The propagation channel

`ClientProxy` packets carry a `metadata` bag, and `@nestjs/microservices` 12.0.4+
lets the client see a packet before it is dispatched (`setOnDispatchHook`). The
SDK installs that hook on every provider it instruments, so `send()` stamps the
packet with the current trace id under **`x-request-id`** - the same name an
HTTP hop uses, not a separate one.

On the receiving side the handler's context exposes `getMetadata()`, which is
where the SDK's default trace-id generator looks when the "request" is not an
HTTP request. That is the whole mechanism: no code in either controller reads or
writes the id.

Two consequences worth knowing:

- **`@nestjs/microservices` 12.0.4+ is required.** Earlier versions have no
  packet-metadata hook, the SDK's propagation is a no-op there, and the two
  applications get two unrelated traces. `package.json` in both apps pins `^12`,
  which is also why these two examples use Nest 12 while the orders example
  stays on Nest 11.
- **Only `send()`/`emit()` through an instrumented `ClientProxy` are covered.**
  Other transports are covered the same way as long as they carry packet
  metadata; a transport with no metadata needs the id passed in the payload by
  hand.

## What to look at

| Page | What to expect |
|---|---|
| **Applications** | `checkout-service` and `pricing-service` |
| **Traces** | one trace: the `POST /quote` request, then the `quote` TCP message |
| **Requests** | `POST /quote` with the outbound RPC span under it; the handler with its `apply-discount` span |
