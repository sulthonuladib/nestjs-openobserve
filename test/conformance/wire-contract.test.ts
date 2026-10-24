/**
 * The one test that matters most: our restated wire contract must be identical
 * to the SDK's own.
 *
 * `packages/shared/src/wire.ts` is a hand-written port — `repos/` is reference
 * material and must never become a runtime dependency. The risk of a port is
 * drift: the SDK bumps its contract, our copy does not, and production starts
 * answering 400 to batches the agent considers valid. This test removes that
 * risk by importing the vendored declaration **in tests only** and asserting a
 * structural match, so a `git subtree pull` that changes the contract fails CI
 * with a diff instead of failing on a customer's deploy.
 *
 * The import is deliberately the only place in the repo that reaches into
 * `repos/`.
 */
import { describe, expect, it } from "bun:test";
import {
  MAX_BATCH_ITEMS,
  SECTION_SHAPES,
  TELEMETRY_BATCH,
  validateBatch,
  type FieldSpec,
  type Shape,
} from "@observe/shared";
import {
  MAX_BATCH_ITEMS as SDK_MAX_BATCH_ITEMS,
  TELEMETRY_BATCH as SDK_BATCH,
  validateTelemetryPayload,
} from "../../repos/observe/src/agent/telemetry-wire-contract";
import { sampleBatch } from "../../packages/shared/src/fixtures";

/**
 * Compares only what a collector has to agree with: key names, types, required,
 * array-ness, bounds and the enumerated values. The SDK's extra bookkeeping
 * (`fallback`, `recursive`, its sanitizer notes) is not part of the wire.
 */
function normalize(shape: Shape): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(shape)) {
    out[key] = {
      type: spec.type,
      alsoAccepts: spec.alsoAccepts ? [...spec.alsoAccepts].sort() : undefined,
      required: spec.required ?? false,
      array: spec.array ?? false,
      maxLength: spec.maxLength,
      maxItems: spec.maxItems,
      oneOf: spec.oneOf ? [...spec.oneOf].sort() : undefined,
      shape: spec.shape ? normalize(spec.shape) : undefined,
    } satisfies Partial<FieldSpec>;
  }
  return out;
}

describe("wire contract", () => {
  it("accepts the same batch item cap as the SDK", () => {
    expect(MAX_BATCH_ITEMS).toBe(SDK_MAX_BATCH_ITEMS);
  });

  it("declares exactly the same sections and fields as the SDK", () => {
    expect(normalize(TELEMETRY_BATCH)).toEqual(normalize(SDK_BATCH as Shape));
  });

  it("refuses `st`, the field the SDK deletes before encoding", () => {
    // The SDK's own note at the top of telemetry-wire-contract.ts: `st` is
    // absent on purpose and a payload carrying it is a 400. If this ever
    // passes, either the contract changed or our port drifted.
    const batch = sampleBatch() as Record<string, unknown>;
    (batch.snapshots as Array<Record<string, unknown>>)[0]!.st = Date.now();
    expect(validateBatch(batch, { forbidUnknown: true }).length).toBeGreaterThan(0);
  });

  it("agrees with the SDK validator on a realistic batch", () => {
    const batch = sampleBatch();
    expect(validateTelemetryPayload(batch, { forbidUnknown: true })).toEqual([]);
    expect(validateBatch(batch, { forbidUnknown: true })).toEqual([]);
  });

  it("agrees with the SDK validator on malformed batches", () => {
    const cases: unknown[] = [
      {},
      { serviceId: "x" }, // snapshots missing `t` is fine; serviceId alone is enough
      { serviceId: 42 },
      { serviceId: "x", snapshots: [{ ti: "a", op: "GET /", t: [{ o: "auto" }] }] },
      { serviceId: "x", snapshots: [{ ti: "a", op: "GET /", t: [{ o: "nope", c: "C", m: "m" }] }] },
      { serviceId: "x", logs: [{ timestamp: "now", text: "hi" }] },
      { serviceId: "x", objectives: [{ handler: "h", operationId: "o", objectives: [{ windowDays: 9 }] }] },
      { serviceId: "x".repeat(101) },
      { serviceId: "x", surprise: true },
    ];

    for (const candidate of cases) {
      const sdk = validateTelemetryPayload(candidate, { forbidUnknown: true }).length > 0;
      const ours = validateBatch(candidate, { forbidUnknown: true }).length > 0;
      expect({ candidate, agrees: ours === sdk }).toEqual({ candidate, agrees: true });
    }
  });

  it("covers every expendable section in SECTION_SHAPES", () => {
    // The SDK repairs a 400 by judging entries one at a time; a section it can
    // repair must be one we can name, or the repair path has nothing to match.
    expect(Object.keys(SECTION_SHAPES).sort()).toEqual([
      "custom",
      "jobs",
      "logs",
      "runtime",
      "snapshots",
    ]);
  });

  it("caps objectives at 100 declarations per batch", () => {
    const declaration = {
      handler: "H",
      operationId: "GET /",
      objectives: [{ availability: 99.9 }],
    };
    const batch = {
      serviceId: "x",
      objectives: Array.from({ length: 101 }, () => declaration),
    };
    expect(validateBatch(batch).some((p) => p.path.startsWith("objectives"))).toBe(true);
  });
});
