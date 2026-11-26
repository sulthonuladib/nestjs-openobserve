import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Transport } from "@nestjs/microservices";
import { AppModule } from "./app.module";
import { ObserveInstrument } from "./observe";

async function bootstrap(): Promise<void> {
  // A hybrid application without the HTTP half: `NestFactory.create()` (not
  // `createMicroservice()`) is what gives the instrumentation hook the bootstrap
  // it needs. Then the TCP server is attached below.
  const app = await NestFactory.create(AppModule, { instrument: ObserveInstrument });
  app.enableShutdownHooks();

  app.connectMicroservice({
    transport: Transport.TCP,
    options: { host: "127.0.0.1", port: Number(process.env.PORT ?? 3301) },
  });

  await app.startAllMicroservices();
  // No `listen()`: this process serves the TCP transport only. `init()` starts
  // everything else (and is what `listen()` would have done for us).
  await app.init();
  new Logger("bootstrap").log("pricing-service ready on tcp://127.0.0.1:3301");
}

void bootstrap();
