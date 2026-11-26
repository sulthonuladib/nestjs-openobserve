import { Module } from "@nestjs/common";
import { ClientsModule, Transport } from "@nestjs/microservices";
import { ObserveModule } from "./observe";
import { CheckoutController } from "./checkout.controller";

/**
 * The producing half of the pair. `ObserveModule` is first: the instrument
 * hook wraps every provider Nest instantiates, including the `ClientProxy`
 * below, which is how the client learns to stamp packets with the trace id.
 */
@Module({
  imports: [
    ObserveModule.forRoot({
      serviceId: process.env.OBSERVE_SERVICE_ID ?? "checkout-service",
      serviceVersion: process.env.SERVICE_VERSION ?? "1.0.0",
      endpoint: process.env.OBSERVE_ENDPOINT ?? "http://localhost:4320",
      forwardLogs: true,
      runtimeMetrics: true,
    }),
    ClientsModule.register([
      {
        name: "PRICING",
        transport: Transport.TCP,
        options: {
          host: process.env.PRICING_HOST ?? "127.0.0.1",
          port: Number(process.env.PRICING_PORT ?? 3301),
        },
      },
    ]),
  ],
  controllers: [CheckoutController],
})
export class AppModule {}
