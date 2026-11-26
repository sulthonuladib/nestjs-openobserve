import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { ObserveInstrument } from "./observe.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // The instrumentation hook Nest runs at bootstrap. Without it the module
    // loads but nothing is instrumented: no spans, no per-method attribution.
    instrument: ObserveInstrument,
  });
  // Required for the agent's final flush on SIGTERM. Without it Node ends the
  // process immediately and the last batch is lost.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
