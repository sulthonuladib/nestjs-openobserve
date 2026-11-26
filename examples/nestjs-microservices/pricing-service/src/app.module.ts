import { Module } from "@nestjs/common";
import { ObserveModule } from "./observe";
import { PricingController } from "./pricing.controller";

/**
 * The consuming half of the pair. `ObserveModule` is first, so the agent is
 * already subscribed when the TCP server starts accepting messages.
 */
@Module({
  imports: [
    ObserveModule.forRoot({
      serviceId: process.env.OBSERVE_SERVICE_ID ?? "pricing-service",
      serviceVersion: process.env.SERVICE_VERSION ?? "1.0.0",
      endpoint: process.env.OBSERVE_ENDPOINT ?? "http://localhost:4320",
      forwardLogs: true,
      runtimeMetrics: true,
    }),
  ],
  controllers: [PricingController],
})
export class AppModule {}
