import { Module } from "@nestjs/common";
import { ObserveModule } from "./observe.js";
import { OrdersController } from "./orders.controller.js";

/**
 * `ObserveModule` is imported first on purpose: global modules shut down in
 * reverse import order, and jobs that finish after the agent has stopped are
 * never sent.
 */
@Module({
  imports: [
    ObserveModule.forRoot({
      serviceId: process.env.OBSERVE_SERVICE_ID ?? "nestjs-basic",
      endpoint: process.env.OBSERVE_ENDPOINT ?? "http://localhost:4320",
      forwardLogs: true,
      runtimeMetrics: true,
      // Uncomment once you have run `npx @nestjs/observe link` (or set both in
      // the environment). Without them the collector accepts the batch only if
      // OBSERVE_ALLOW_ANONYMOUS_INGEST=1, which is the local default.
      // appKey: process.env.OBSERVE_APP_KEY,
      // appSecret: process.env.OBSERVE_APP_SECRET,
    }),
  ],
  controllers: [OrdersController],
})
export class AppModule {}
