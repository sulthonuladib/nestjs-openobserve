import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { TracerService } from "@nestjs/observe";
import type { Job } from "bullmq";
import { Database } from "./db.js";

interface OrderJob {
  orderId: string;
  explode?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The queue consumer. Every run is a job in the dashboard, with queue wait,
 * attempt number and outcome.
 *
 * A job added from a traced request inherits that trace id, so the spans below
 * land in the same trace as the `POST /orders` that queued it — open the trace
 * in Traces and the worker's `load-order` span is there, after the request.
 */
@Processor("orders")
export class OrdersProcessor extends WorkerHost {
  private readonly logger = new Logger(OrdersProcessor.name);
  constructor(
    private readonly db: Database,
    private readonly tracer: TracerService,
  ) {
    super();
  }

  async process(job: Job<OrderJob>): Promise<void> {
    const startedAt = performance.now();
    this.logger.log(
      `processing ${job.id} (${job.name}) attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1}`,
    );

    await this.tracer.createSpan("load-order", async (span) => {
      span.setTag("order.id", job.data.orderId);
      const { rows } = await this.db.pool.query<{ id: string }>(
        `SELECT id FROM orders WHERE id = $1`,
        [job.data.orderId],
      );
      if (!rows[0]) throw new Error(`order ${job.data.orderId} is gone`);
    });

    // Simulated work: enough for the duration chart to have a shape.
    await sleep(200 + Math.floor(Math.random() * 500));

    if (job.data.explode && job.attemptsMade === 0) {
      // BullMQ retries this run (attempts: 3 in the producer). The Jobs page
      // shows the failed attempt, then the successful retry on the same name.
      throw new Error("planted failure: the first attempt always fails");
    }

    await this.db.pool.query(`UPDATE orders SET status = 'processed' WHERE id = $1`, [
      job.data.orderId,
    ]);

    this.tracer
      .counter("orders_processed_total", {
        description: "Order jobs processed, by queue",
        labels: ["queue"],
      })
      .increment({ queue: "orders" });
    this.tracer
      .summary("orders_processing_duration_ms", {
        description: "Time spent processing one order job, in milliseconds",
        sampleSize: 500,
      })
      .observe(performance.now() - startedAt);
    this.logger.log(`processed ${job.data.orderId}`);
  }
}
