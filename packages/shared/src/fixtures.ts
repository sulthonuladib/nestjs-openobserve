/**
 * A batch shaped exactly like the one the SDK's encoders produce.
 *
 * Used by the smoke script and by the conformance tests. Kept as a plain object
 * (not a fixture file) so a field rename shows up as a type error rather than a
 * stale JSON blob.
 */
import type { TelemetryBatch } from "./wire";

const base = Date.now();

export function sampleBatch(overrides: Partial<TelemetryBatch> = {}): TelemetryBatch {
  return {
    serviceId: "orders-api",
    serviceVersion: "1.4.2",
    truncatedSpans: 0,
    forwardLogs: true,
    snapshots: [
      {
        ct: new Date(base).toISOString(),
        ti: "0192f3b4-7c8d-7e9f-a1b2-c3d4e5f60718",
        d: 42.7,
        p: "http",
        op: "POST /orders",
        u: "user_42",
        tg: { environment: "production" },
        a: { m: "POST", sc: 201, ou: "/orders" },
        t: [
          {
            n: "OrdersController.create",
            o: "auto",
            c: "OrdersController",
            m: "create",
            s: "span-1",
            d: 41.2,
            so: 0,
            ch: [
              {
                n: "OrdersService.create",
                o: "auto",
                c: "OrdersService",
                m: "create",
                s: "span-2",
                d: 30.1,
                so: 1.4,
                ch: [
                  {
                    n: 'INSERT INTO "orders"',
                    o: "auto",
                    c: "PgDriver",
                    m: "query",
                    s: "span-3",
                    d: 12.9,
                    so: 1.5,
                  },
                  {
                    // A collapsed group: the SDK's spanCollapse produces these.
                    n: "ValidationPipe.transform \u00d727",
                    o: "auto",
                    c: "ValidationPipe",
                    m: "transform",
                    s: "span-4",
                    d: 8.4,
                    so: 15.1,
                    t: { "observe.collapsed": 27 },
                  },
                ],
              },
              {
                n: "OutgoingHttp",
                o: "auto",
                c: "HttpService",
                m: "request",
                s: "span-5",
                d: 9.3,
                so: 32.0,
                e: true,
              },
            ],
          },
        ],
      },
      {
        ct: new Date(base + 1000).toISOString(),
        ti: "0192f3b4-7c8d-7e9f-a1b2-c3d4e5f60719",
        d: 812.4,
        p: "http",
        op: "GET /orders/:id",
        a: { m: "GET", sc: 500, ou: "/orders/9f8e7d" },
        e: {
          cls: "TypeError",
          message: "Cannot read properties of undefined (reading 'total')",
          stack: [
            "TypeError: Cannot read properties of undefined (reading 'total')",
            "    at OrdersService.computeTotal (/app/dist/orders/orders.service.js:84:21)",
            "    at OrdersController.findOne (/app/dist/orders/orders.controller.js:31:18)",
            "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
          ].join("\n"),
        },
        t: [
          {
            n: "OrdersController.findOne",
            o: "auto",
            c: "OrdersController",
            m: "findOne",
            d: 811.0,
            so: 0,
            e: {
              cls: "TypeError",
              message: "Cannot read properties of undefined (reading 'total')",
            },
          },
        ],
      },
    ],
    jobs: [
      {
        i: "job-4471",
        ti: "0192f3b4-7c8d-7e9f-a1b2-c3d4e5f60720",
        n: "send-invoice",
        q: "invoices",
        s: "completed",
        c: new Date(base + 2000).toISOString(),
        d: 120.5,
        ea: new Date(base - 4000).toISOString(),
        wd: 3400,
        am: 1,
        ma: 3,
        tg: { environment: "production" },
        t: [
          {
            n: "InvoiceProcessor.handle",
            o: "auto",
            c: "InvoiceProcessor",
            m: "handle",
            d: 120.0,
            so: 0,
          },
        ],
      },
    ],
    runtime: {
      c: { u: 1_240_000, s: 380_000, p: 4.2 },
      m: {
        r: 248_512_512,
        ht: 92_274_688,
        hu: 61_874_176,
        e: 8_912_896,
        ab: 21_233_664,
        p: 74.1,
      },
      g: {
        c: 41,
        td: 188.4,
        b: {
          m: { count: 3, duration: 12.1 },
          j: { count: 2, duration: 44.9 },
          i: { count: 36, duration: 131.4 },
        },
      },
      e: { l: 12.4, u: 0.031 },
    },
    custom: [
      {
        n: "cart_checkout_total",
        t: "counter",
        d: "Checkouts completed",
        v: { default: 812 },
        tg: { environment: "production" },
      },
      {
        n: "invoice_generation_duration_ms",
        t: "summary",
        v: { default: 1 },
        l: ["default"],
        iv: { default: 5 },
        q50: { default: 118 },
        q95: { default: 240 },
        q99: { default: 301 },
        ct: { default: 812 },
        sm: { default: 97_120 },
        mx: { default: 512 },
      },
    ],
    logs: [
      {
        timestamp: base,
        level: "error",
        context: "OrdersService",
        text: "Cannot read properties of undefined (reading 'total')",
        traceId: "0192f3b4-7c8d-7e9f-a1b2-c3d4e5f60719",
        spanId: "span-6",
        attributes: { environment: "production" },
      },
      {
        timestamp: base + 1500,
        level: "log",
        context: "InvoiceProcessor",
        text: "invoice 4471 sent",
        traceId: "0192f3b4-7c8d-7e9f-a1b2-c3d4e5f60720",
      },
    ],
    objectives: [
      {
        handler: "OrdersController.create",
        operationId: "POST /orders",
        method: "POST",
        objectives: [
          { availability: 99.9, windowDays: 28, name: "Checkout availability" },
          { latency: { underMs: 300, target: 99 }, windowDays: 28 },
        ],
      },
    ],
    ...overrides,
  };
}
