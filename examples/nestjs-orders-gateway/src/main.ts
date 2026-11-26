import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ObserveInstrument } from "./observe";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // The instrumentation hook Nest runs at bootstrap. Without it the module
    // loads but no controller is instrumented and the outbound call has no
    // parent span to hang under.
    instrument: ObserveInstrument,
  });
  // Required for the agent's final flush on SIGINT/SIGTERM.
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3200));
}

void bootstrap();
