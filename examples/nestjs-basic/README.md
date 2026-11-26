# nestjs-basic

A minimal NestJS 11 app wired to a self-hosted collector, with a little more
surface than `nest new` so the dashboard has something worth showing.

It is deliberately separate from the root package: it installs
`@nestjs/observe` from npm, exactly as a real application does. Nothing here
imports `repos/`.

## Run it

From this directory:

```bash
npm install

# The collector (from the repository root: `bun dev`) serves the API and the UI.
OBSERVE_ENDPOINT=http://localhost:4320 PORT=3001 npm start
```

You should see `Observe is connected: http://localhost:4320 accepted this app's
first batch.` The application appears under **Applications** in the dashboard at
<http://localhost:4320>.

For a real key pair, run from this directory:

```bash
OBSERVE_ENDPOINT=http://localhost:4320 npx @nestjs/observe link
```

and approve the code at <http://localhost:4320/link>. It writes
`OBSERVE_APP_KEY` / `OBSERVE_APP_SECRET` into `.env`, which the start script
loads. Then set `OBSERVE_ALLOW_ANONYMOUS_INGEST=0` on the collector.

## Routes

| Route | Exercises |
|---|---|
| `GET /orders` | a normal request, a span tree, and a log line on every call |
| `GET /orders/slow/:ms` | slow requests; the cap is 10 minutes so it can also demonstrate shutdown draining |
| `GET /orders/boom/:id` | an unhandled exception → an error group with a fingerprint |
| `POST /orders` | a write path and a log line |

## Logs

`forwardLogs: true` forwards everything written to stdout/stderr, including
Nest's `Logger`. This example logs on every route, so the **Logs** page streams
as you call it. A plain `nest new` app only writes its bootstrap lines: seeing
just those is the app being quiet, not the collector dropping lines.

Logs are batched like every other signal: the agent flushes on its interval
(5 s by default), and the page polls every 10 s. Set a range that covers the
lines — the default is the last hour.

## Shutdown

`main.ts` calls `app.enableShutdownHooks()`, which is required for the agent's
final flush. On Ctrl+C Nest closes the HTTP server **first** and waits for
in-flight requests to finish; only then do shutdown hooks run, including the
agent's. So:

- no requests in flight → shutdown is quick (the final flush is capped at
  `shutdownFlushTimeout`, 2 s by default);
- a request to `/orders/slow/600000` in flight → Ctrl+C waits for that request,
  because that is how Nest closes a server. It is not the observer worker.

Timing it makes the difference obvious:

```bash
PORT=3001 OBSERVE_ENDPOINT=http://localhost:4320 node dist/main.js &
pid=$!
curl -s localhost:3001/orders/slow/10000 &
start=$(date +%s%3N)
kill -INT $pid
wait $pid
echo "exited in $(( $(date +%s%3N) - start ))ms"   # ~10 s, the request, not the agent
```
