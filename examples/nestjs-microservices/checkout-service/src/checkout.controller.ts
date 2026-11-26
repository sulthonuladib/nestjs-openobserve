import { Body, Controller, Get, Inject, Logger, Post } from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { firstValueFrom } from "rxjs";

interface Quote {
  orderId: string;
  total: number;
  discount: number;
}

/**
 * The sending half. `this.pricing.send()` is a `ClientProxy` call, and the SDK
 * puts the current trace id into the packet's metadata before dispatch - which
 * is the microservice equivalent of the `x-request-id` header. The handler in
 * `pricing-service` adopts it, so one trace covers both processes.
 */
@Controller()
export class CheckoutController {
  private readonly logger = new Logger(CheckoutController.name);

  constructor(@Inject("PRICING") private readonly pricing: ClientProxy) {}

  @Get("health")
  health(): { status: string } {
    return { status: "ok" };
  }

  @Post("quote")
  async quote(@Body() body: { total?: number }): Promise<Quote> {
    const orderId = crypto.randomUUID();
    const total = Number(body.total ?? 42);

    const quote = await firstValueFrom(
      this.pricing.send<Quote>({ cmd: "quote" }, { orderId, total }),
    );
    this.logger.log(`quoted ${quote.total} for ${orderId}`);
    return quote;
  }
}
