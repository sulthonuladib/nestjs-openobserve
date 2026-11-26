import { createObserveModule } from "@nestjs/observe";

/**
 * The instrumentation hook has to exist before any module does, which is why
 * `createObserveModule()` returns both the dynamic module and the function
 * `NestFactory.create()` wants.
 *
 * `sourceContext` is a factory option, not a `forRoot` one: it decides what the
 * registry attaches to an error at capture time. Four lines either side of each
 * in-app frame is enough to show the throw site.
 */
export const { ObserveModule, ObserveInstrument } = createObserveModule({
  sourceContext: { linesOfContext: 4, maxFrames: 3 },
});
