import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Pool } from "pg";

/**
 * The worker shares the API's database. The SDK patches `pg`, so the
 * `SELECT`/`UPDATE` below become spans under the job's trace.
 */
@Injectable()
export class Database implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Database.name);

  readonly pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://orders:orders@localhost:5434/orders",
    max: 10,
  });

  async onModuleInit(): Promise<void> {
    // The API owns the schema; this makes the worker startable first during a
    // demo without a crash loop.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id text PRIMARY KEY,
        total numeric NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    this.logger.log("orders table ready");
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
