import { createObserveModule } from "@nestjs/observe";

/**
 * The instrumentation hook has to exist before any module does, which is why
 * `createObserveModule()` returns both the dynamic module and the function
 * `NestFactory.create()` wants.
 *
 * `sourceContext` is a factory option: worker errors are as worth a source
 * frame as request errors are.
 */
export const { ObserveModule, ObserveInstrument } = createObserveModule({
  sourceContext: { linesOfContext: 4, maxFrames: 3 },
});
