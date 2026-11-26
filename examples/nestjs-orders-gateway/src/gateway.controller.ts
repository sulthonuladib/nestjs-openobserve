import {
  BadGatewayException,
  Body,
  Controller,
  Get,
  Headers,
  Logger,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { TracerService } from "@nestjs/observe";
import { firstValueFrom } from "rxjs";

interface Order {
  id: string;
  total: number | string;
  status: string;
}

/**
 * The front door. Every route here is a proxy into `nestjs-orders-api`, which is
 * the point of the example: the trace has to survive the hop.
 *
 * `HttpService` is `@nestjs/axios`, and axios uses `node:http` - one of the two
 * clients the SDK subscribes to. So the outbound call gets its own span under
 * the incoming request, and the SDK copies the current trace id into
 * `x-request-id` on the way out. The API adopts that id as its own, the BullMQ
 * job the API enqueues inherits it, and the worker finishes the same trace.
 *
 * Nothing in this file sets that header. If it were set here, the example would
 * prove nothing.
 */
@Controller()
export class GatewayController {
  private readonly logger = new Logger(GatewayController.name);

  constructor(
    private readonly http: HttpService,
    private readonly tracer: TracerService,
  ) {}

  /** Liveness only: no outbound call, so a probe does not create traces. */
  @Get("health")
  health(): { status: string; ordersApi: string } {
    return { status: "ok", ordersApi: this.http.axiosRef.defaults.baseURL ?? "" };
  }

  /** The one route the brief is about: request in, API call out, job queued. */
  @Post("checkout")
  async checkout(
    @Body() body: { total?: number; explode?: boolean },
    @Headers("x-user-id") userId?: string,
  ): Promise<Order> {
    // A gateway-local span (shipping is priced before the API is asked to
    // accept the order). It sits between the request span and the outbound
    // `POST localhost:3100` span in the waterfall.
    const total = (await this.tracer.createSpan("price-cart", (span) => {
      const value = Number(body.total ?? 42);
      span.setTag("cart.total", value);
      const shipping = value >= 100 ? 0 : 5;
      span.setTag("cart.shipping", shipping);
      return value + shipping;
    })) as number;

    const order = await this.call<Order>("post", "/orders", { ...body, total }, userId);
    this.logger.log(`checkout accepted for order ${order.id}`);
    return order;
  }

  /** A read through the same hop, so the proxy path is exercised too. */
  @Get("orders")
  list(
    @Query("limit") limit = "20",
    @Headers("x-user-id") userId?: string,
  ): Promise<{ items: Order[] }> {
    return this.call<{ items: Order[] }>(
      "get",
      `/orders?limit=${encodeURIComponent(limit)}`,
      undefined,
      userId,
    );
  }

  @Get("orders/:id")
  findOne(
    @Param("id") id: string,
    @Headers("x-user-id") userId?: string,
  ): Promise<Order> {
    return this.call<Order>("get", `/orders/${encodeURIComponent(id)}`, undefined, userId);
  }

  /**
   * One place that reaches the API, so nothing here can quietly bypass the
   * instrumented client - and so an upstream failure becomes a 502 with the
   * API's own answer attached instead of an unhandled axios rejection.
   *
   * The `x-user-id` header is the caller's, forwarded verbatim: the API groups
   * its Users page by it.
   */
  private async call<T>(
    method: "get" | "post",
    path: string,
    body: unknown,
    userId?: string,
  ): Promise<T> {
    try {
      const response = await firstValueFrom(
        this.http.request<T>({
          method,
          url: path,
          data: body,
          headers: userId ? { "x-user-id": userId } : undefined,
        }),
      );
      return response.data;
    } catch (error) {
      const upstream = (error as { response?: { status?: number; data?: unknown } }).response;
      if (upstream) {
        this.logger.warn(`orders-api answered ${upstream.status} for ${method.toUpperCase()} ${path}`);
        throw new BadGatewayException({
          message: `orders-api answered ${upstream.status}`,
          upstream: upstream.data,
        });
      }
      this.logger.error(`orders-api unreachable: ${(error as Error).message}`);
      throw new BadGatewayException(`orders-api unreachable: ${(error as Error).message}`);
    }
  }
}
