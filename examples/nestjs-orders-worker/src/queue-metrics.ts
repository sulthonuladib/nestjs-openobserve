import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { TracerService } from "@nestjs/observe";
import { Cron, CronExpression, Interval } from "@nestjs/schedule";
import type { Queue } from "bullmq";
import { Database } from "./db.js";

/**
 * Background work that is not a queue consumer:
 *
 *   * `@Cron` and `@Interval` handlers are reported as jobs too, so they show up
 *     under Jobs with a duration and an outcome;
 *   * the gauges give the Custom page a point-in-time series — queue depth and
 *     orders still pending — next to the API's counters.
 */
@Injectable()
export class QueueMetrics {
  private readonly logger = new Logger(QueueMetrics.name);
  constructor(
    @InjectQueue("orders") private readonly queue: Queue,
    private readonly db: Database,
    private readonly tracer: TracerService,
  ) {}

  /** Every 30 seconds: the backlog signal. */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async reportQueueDepth(): Promise<void> {
    const counts = await this.queue.getJobCounts("wait", "active", "delayed");
    const depth = (counts.wait ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
    this.tracer
      .gauge("orders_queue_depth", {
        kind: "additive",
        description: "Jobs waiting, active or delayed in the orders queue",
      })
      .setValue(depth);
    this.logger.log(
      `queue depth ${depth} (${counts.wait ?? 0} waiting, ${counts.active ?? 0} active)`,
    );
  }

  /** Every minute: a database-backed gauge, which also produces a `pg` span. */
  @Interval(60_000)
  async reportOpenOrders(): Promise<void> {
    const { rows } = await this.db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM orders WHERE status = 'pending'`,
    );
    const open = Number(rows[0]?.n ?? 0);
    this.tracer
      .gauge("orders_open", {
        kind: "peak",
        description: "Orders still waiting to be processed",
      })
      .setValue(open);
    this.logger.log(`open orders ${open}`);
  }
}
