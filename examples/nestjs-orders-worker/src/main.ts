import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { ObserveInstrument } from "./observe.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  app.enableShutdownHooks();

  // No `listen()`: this process has no HTTP port. `init()` starts the BullMQ
  // workers and the schedule registrations, which is all a worker needs.
  await app.init();
  new Logger("bootstrap").log("orders-worker ready (no HTTP listener)");
}

await bootstrap();
