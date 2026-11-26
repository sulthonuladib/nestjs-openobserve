import { Controller, Logger } from "@nestjs/common";
import { MessagePattern, Payload } from "@nestjs/microservices";
import { TracerService } from "@nestjs/observe";

interface QuoteRequest {
  orderId: string;
  total: number;
}

interface Quote {
  orderId: string;
  total: number;
  discount: number;
}

/**
 * A TCP message handler. Nothing here reads a trace id: the id arrives with the
 * packet (`x-request-id` in the packet metadata) and the SDK adopts it as the
 * trace id of this handler's execution, which is what puts the HTTP request in
 * the caller and this handler in the same trace.
 */
@Controller()
export class PricingController {
  private readonly logger = new Logger(PricingController.name);

  constructor(private readonly tracer: TracerService) {}

  @MessagePattern({ cmd: "quote" })
  async quote(@Payload() data: QuoteRequest): Promise<Quote> {
    this.logger.log(`quote for ${data.orderId} (total ${data.total})`);

    return this.tracer.createSpan("apply-discount", async (span) => {
      const discount = data.total >= 100 ? 0.1 : 0;
      span.setTag("pricing.discount", discount);
      // Simulated pricing work, so the span has a visible duration.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const quote = {
        orderId: data.orderId,
        total: Math.round(data.total * (1 - discount)),
        discount,
      };
      span.setTag("pricing.total", quote.total);
      return quote;
    }) as Promise<Quote>;
  }
}
