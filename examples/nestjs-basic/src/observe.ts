import { createObserveModule } from "@nestjs/observe";

/**
 * The instrumentation hook has to exist before any module does, which is why
 * `createObserveModule()` returns both the dynamic module and the function
 * `NestFactory.create()` wants.
 */
export const { ObserveModule, ObserveInstrument } = createObserveModule();
