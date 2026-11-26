/**
 * Ingest models.
 *
 * The wire contract itself lives in `src/wire.ts` (a hand-written port of
 * the SDK's `telemetry-wire-contract.ts`, kept honest by a conformance test).
 * This module is the HTTP-facing half: the reply and the credential header
 * shape.
 *
 * Reply contract, from the SDK's detached worker:
 *   we always answer `{ degraded: false }`.
 *
 * Every other value of `degraded` exists so the agent withholds span trees from
 * an account that is over a metered allowance. There are no allowances here, so
 * telling the agent otherwise would make it drop data we intend to keep — and do
 * it silently, for five minutes at a time.
 */
import { t } from "elysia";

export const IngestModel = {
  /** Read only for its `degraded` flag; kept typed so the shape stays honest. */
  reply: t.Object({
    degraded: t.Boolean(),
  }),

  error: t.Object({
    message: t.String(),
    problems: t.Optional(
      t.Array(t.Object({ path: t.String(), message: t.String() })),
    ),
  }),

  health: t.Object({
    ok: t.Boolean(),
    version: t.String(),
    ingestApi: t.String(),
    sdk: t.String(),
    database: t.Union([t.Literal("up"), t.Literal("down")]),
    stats: t.Object({
      batches: t.Number(),
      bytes: t.Number(),
      rejected: t.Number(),
      refused: t.Number(),
      executions: t.Number(),
      spans: t.Number(),
      lastBatchAt: t.Union([t.Number(), t.Null()]),
    }),
  }),
} as const;

/** The success body. A constant so no code path can accidentally vary it. */
export const ACCEPTED = { degraded: false } as const;
