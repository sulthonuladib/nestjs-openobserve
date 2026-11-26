import { Body, Controller, Get, Logger, NotFoundException, Param, Post } from "@nestjs/common";

/**
 * Enough surface to exercise the collector: a normal route, a slow one, one
 * that throws, and log lines on every call so `forwardLogs` has something to
 * stream.
 */
@Controller("orders")
export class OrdersController {
  private readonly logger = new Logger("OrdersController");
  private readonly orders = new Map<string, { id: string; total: number }>([
    ["1", { id: "1", total: 42 }],
    ["2", { id: "2", total: 17 }],
  ]);

  @Get()
  list(): { items: Array<{ id: string; total: number }> } {
    const items = [...this.orders.values()];
    this.logger.log(`listed ${items.length} orders`);
    return { items };
  }

  @Get("slow/:ms")
  async slow(@Param("ms") ms: string): Promise<{ waitedMs: number }> {
    const wait = Math.min(Number(ms) || 0, 600_000);
    this.logger.log(`waiting ${wait}ms`);
    await new Promise((resolve) => setTimeout(resolve, wait));
    return { waitedMs: wait };
  }

  @Get("boom/:id")
  boom(@Param("id") id: string): never {
    this.logger.warn(`no order ${id}`);
    throw new NotFoundException(`order ${id} not found`);
  }

  @Post()
  create(@Body() body: { total: number }): { id: string; total: number } {
    const id = String(this.orders.size + 1);
    const order = { id, total: body.total };
    this.orders.set(id, order);
    this.logger.log(`created order ${id}`);
    return order;
  }
}
