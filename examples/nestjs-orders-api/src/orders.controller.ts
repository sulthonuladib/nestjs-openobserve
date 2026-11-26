import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Objective, TracerService } from "@nestjs/observe";
import type { Queue } from "bullmq";
import { Database } from "./db";

interface OrderRow {
  id: string;
  total: string;
  status: string;
  created_at: Date;
}

/**
 * The surface this example is about:
 *
 *   * Postgres queries → `pg` spans (nested under the request span);
 *   * a BullMQ `add()` → a job whose trace id is the request's, so the worker
 *     that picks it up continues this trace;
 *   * `@Objective()` → availability and latency SLOs owned by the code;
 *   * custom metrics → a counter and a gauge in the Custom page;
 *   * an unhandled throw → an error group with agent-captured source;
 *   * a caught error → `TracerService.captureError` without a 500.
 */
@Controller("orders")
export class OrdersController {
  private readonly logger = new Logger(OrdersController.name);

  constructor(
    private readonly db: Database,
    private readonly tracer: TracerService,
    @InjectQueue("orders") private readonly queue: Queue,
  ) {}

  @Get()
  @Objective({
    availability: 99.9,
    latency: { underMs: 250, target: 99 },
    windowDays: 28,
    name: "List orders",
  })
  async list(@Query("limit") limit = "20"): Promise<{ items: OrderRow[] }> {
    const { rows } = await this.db.pool.query<OrderRow>(
      `SELECT id, total, status, created_at
         FROM orders
        ORDER BY created_at DESC
        LIMIT $1`,
      [Math.min(Number(limit) || 20, 100)],
    );
    this.logger.log(`listed ${rows.length} orders`);
    return { items: rows };
  }

  @Get(":id")
  async findOne(@Param("id") id: string): Promise<OrderRow> {
    const { rows } = await this.db.pool.query<OrderRow>(
      `SELECT id, total, status, created_at FROM orders WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new BadRequestException(`order ${id} not found`);
    return row;
  }

  @Post()
  @Objective({ availability: 99.5, windowDays: 14, name: "Create order" })
  async create(
    @Body() body: { total?: number; explode?: boolean },
  ): Promise<{ id: string; total: number; status: string }> {
    const startedAt = performance.now();
    const total = Number(body.total ?? 42);

    // A manual span, to show up in the waterfall between the request span and
    // the `pg` span below. `setTag` is how it carries its own attributes.
    await this.tracer.createSpan("validate-order", async (span) => {
      span.setTag("order.total", total);
      if (!Number.isFinite(total) || total <= 0) {
        throw new BadRequestException("total must be a positive number");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const id = crypto.randomUUID();
    await this.db.pool.query(
      `INSERT INTO orders (id, total, status) VALUES ($1, $2, 'pending')`,
      [id, total],
    );

    // Added inside the traced request, so the worker inherits this trace id.
    // `explode` asks the worker to fail its first attempt: the job then shows
    // attempts, a failure, and a retry in the Jobs page.
    await this.queue.add(
      "process-order",
      { orderId: id, explode: Boolean(body.explode) },
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );

    // The same call returns the same series; no field to hold is needed.
    this.tracer
      .counter("orders_created_total", {
        description: "Orders created, by route",
        labels: ["route"],
      })
      .increment({ route: "POST /orders" });
    this.tracer
      .summary("orders_create_duration_ms", {
        description: "Time spent creating an order, in milliseconds",
        sampleSize: 500,
      })
      .observe(performance.now() - startedAt);
    this.logger.log(`created order ${id} (total ${total})`);
    return { id, total, status: "pending" };
  }

  /** A slow endpoint: p95 and the latency SLO both move when this is called. */
  @Get("slow/:ms")
  async slow(@Param("ms") ms: string): Promise<{ waitedMs: number }> {
    const wait = Math.min(Math.max(Number(ms) || 50, 0), 5_000);
    this.logger.log(`waiting ${wait}ms`);
    await new Promise((resolve) => setTimeout(resolve, wait));
    return { waitedMs: wait };
  }

  /** An unhandled failure: becomes an error group with captured source frames. */
  @Get("boom/:id")
  boom(@Param("id") id: string): never {
    this.logger.warn(`about to fail for order ${id}`);
    const order = undefined as unknown as { total: number };
    return order.total as never;
  }

  /** A handled failure: reported with `captureError`, still a 200 to the caller. */
  @Get("handled/:id")
  async handled(@Param("id") id: string): Promise<{ ok: boolean }> {
    try {
      throw new Error(`handled failure for order ${id}`);
    } catch (error) {
      await this.tracer.captureError(error as Error, { route: "GET /orders/handled" });
      return { ok: false };
    }
  }
}
