import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ObserveModule } from "./observe";
import { Database } from "./db";
import { OrdersController } from "./orders.controller";

/**
 * `ObserveModule` is imported **first** on purpose: global modules shut down in
 * reverse import order, so a `BullModule` registered before it would still be
 * running jobs after the agent stopped, and those runs would never be sent.
 */
@Module({
  imports: [
    ObserveModule.forRoot({
      serviceId: process.env.OBSERVE_SERVICE_ID ?? "orders-api",
      serviceVersion: process.env.SERVICE_VERSION ?? "1.0.0",
      endpoint: process.env.OBSERVE_ENDPOINT ?? "http://localhost:4320",
      forwardLogs: true,
      runtimeMetrics: true,
      http: {
        // Whatever identifies the caller in your app. The Users page groups by it.
        getUserId: (req) => (req.headers["x-user-id"] as string | undefined) ?? "anonymous",
        // Keep headers and the body for failures, and for anything slower than
        // half a second, so the trace can explain what the request carried.
        capture: { body: true, slowerThanMs: 500 },
      },
      // appKey/appSecret are read from OBSERVE_APP_KEY/OBSERVE_APP_SECRET when
      // unset. Without them the collector accepts the batch only while
      // OBSERVE_ALLOW_ANONYMOUS_INGEST=1 (the local default).
    }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? "127.0.0.1",
        port: Number(process.env.REDIS_PORT ?? 6380),
      },
    }),
    BullModule.registerQueue({ name: "orders" }),
  ],
  controllers: [OrdersController],
  providers: [Database],
})
export class AppModule {}
