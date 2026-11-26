import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ObserveInstrument } from "./observe";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // The instrumentation hook Nest runs at bootstrap. Without it the module
    // loads but no controller, interceptor or queue consumer is instrumented.
    instrument: ObserveInstrument,
  });
  // Required for the agent's final flush on SIGINT/SIGTERM.
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3100));
}

void bootstrap();
