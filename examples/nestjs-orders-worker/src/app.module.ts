import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ScheduleModule } from "@nestjs/schedule";
import { ObserveModule } from "./observe.js";
import { Database } from "./db.js";
import { OrdersProcessor } from "./orders.processor.js";
import { QueueMetrics } from "./queue-metrics.js";

/**
 * `ObserveModule` first: global modules shut down in reverse import order, so
 * importing it before `BullModule` is what lets a job still running at shutdown
 * be reported. The README's "import it first" is this line.
 */
@Module({
  imports: [
    ObserveModule.forRoot({
      serviceId: process.env.OBSERVE_SERVICE_ID ?? "orders-worker",
      serviceVersion: process.env.SERVICE_VERSION ?? "1.0.0",
      endpoint: process.env.OBSERVE_ENDPOINT ?? "http://localhost:4320",
      forwardLogs: true,
      runtimeMetrics: true,
    }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? "127.0.0.1",
        port: Number(process.env.REDIS_PORT ?? 6380),
      },
    }),
    BullModule.registerQueue({ name: "orders" }),
    ScheduleModule.forRoot(),
  ],
  providers: [Database, OrdersProcessor, QueueMetrics],
})
export class AppModule {}
