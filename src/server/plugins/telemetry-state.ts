/**
 * Ingest counters, as Elysia `state`.
 *
 * `state` rather than `decorate` because this is mutable per-instance data, and
 * Elysia's state is the documented place for that (decorators are for
 * request-dependent values). It is served by `/api/v1/health` and will back the
 * self-observability page, so it has to survive the request that produced it.
 *
 * Not persisted, deliberately: these describe *this process*, and a restart
 * resetting them is the truthful behaviour.
 */
import { Elysia } from "elysia";

export interface IngestStats {
  batches: number;
  bytes: number;
  rejected: number;
  refused: number;
  executions: number;
  spans: number;
  lastBatchAt: number | null;
}

const initialStats: IngestStats = {
  batches: 0,
  bytes: 0,
  rejected: 0,
  refused: 0,
  executions: 0,
  spans: 0,
  lastBatchAt: null,
};

export const telemetryState = new Elysia({ name: "telemetry-state" }).state({
  stats: initialStats,
});
