import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { ObserveModule } from "./observe";
import { GatewayController } from "./gateway.controller";

/**
 * `ObserveModule` is imported **first** on purpose: global modules shut down in
 * reverse import order, so an `HttpModule` registered before it would still be
 * draining requests after the agent stopped, and those spans would never be
 * sent.
 *
 * `HttpModule` is `@nestjs/axios`, and axios rides on `node:http` - which is
 * the client the SDK instruments. That is the whole reason this example does
 * not reach for the global `fetch`; see the README for what that costs.
 */
@Module({
  imports: [
    ObserveModule.forRoot({
      serviceId: process.env.OBSERVE_SERVICE_ID ?? "orders-gateway",
      serviceVersion: process.env.SERVICE_VERSION ?? "1.0.0",
      endpoint: process.env.OBSERVE_ENDPOINT ?? "http://localhost:4320",
      forwardLogs: true,
      runtimeMetrics: true,
      http: {
        // Whatever identifies the caller in your app. Forwarded to orders-api,
        // which uses the same header, so the Users page groups one caller
        // across both services.
        getUserId: (req) => (req.headers["x-user-id"] as string | undefined) ?? "anonymous",
        // Keep headers and the body for failures, and for anything slower than
        // half a second, so the trace can explain what the request carried.
        capture: { body: true, slowerThanMs: 500 },
      },
      // appKey/appSecret are read from OBSERVE_APP_KEY/OBSERVE_APP_SECRET when
      // unset. Without them the collector accepts the batch only while
      // OBSERVE_ALLOW_ANONYMOUS_INGEST=1 (the local default).
    }),
    HttpModule.register({
      baseURL: process.env.ORDERS_API ?? "http://localhost:3100",
      // A front door that hangs is worse than one that fails: the timeout
      // turns an unresponsive API into a 502 the caller can see.
      timeout: 5_000,
    }),
  ],
  controllers: [GatewayController],
})
export class AppModule {}
