/**
 * The ingest wire contract, restated.
 *
 * This is a *port*, not an import: `repos/observe` is vendored read-only
 * reference material and must never be a runtime dependency (see AGENTS.md).
 * The port is kept honest by `test/conformance/wire-contract.test.ts`, which
 * imports the SDK's own `TELEMETRY_BATCH` and asserts this declaration is
 * structurally identical to it — so a subtree bump that changes the contract
 * fails CI instead of silently rejecting batches in production.
 *
 * Source of truth: repos/observe/src/agent/telemetry-wire-contract.ts
 * SDK version: @nestjs/observe 0.3.17
 *
 * Two rules carried over verbatim from the SDK contract:
 *   - `st` (startTimestamp) is deliberately absent. The SDK deletes it before
 *     encoding and the hosted collector validates with `forbidNonWhitelisted`,
 *     so a payload carrying it is a 400.
 *   - Sections cap at MAX_BATCH_ITEMS entries; `objectives` at 100.
 */

export type FieldType = "string" | "number" | "boolean" | "object";

export interface FieldSpec {
  readonly type: FieldType;
  readonly alsoAccepts?: readonly FieldType[];
  readonly required?: boolean;
  readonly fallback?: unknown;
  readonly array?: boolean;
  readonly shape?: Shape;
  readonly recursive?: boolean;
  readonly maxLength?: number;
  readonly oneOf?: readonly (string | number)[];
  readonly maxItems?: number;
}

export type Shape = Readonly<Record<string, FieldSpec>>;

/** Most entries the collector accepts in one section of a batch. */
export const MAX_BATCH_ITEMS = 5000;

export const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "log",
  "debug",
  "verbose",
] as const;

export const PROTOCOLS = ["http", "rpc", "grpc", "graphql", "ws"] as const;

/** One span, nesting through `ch` to whatever depth the operation produced. */
const TRACE_NODE: Shape = {
  n: { type: "string", maxLength: 255 },
  o: { type: "string", required: true, oneOf: ["manual", "auto"] },
  t: { type: "object" },
  d: { type: "number" },
  e: { type: "object", alsoAccepts: ["boolean"] },
  c: { type: "string", required: true, maxLength: 255 },
  m: { type: "string", required: true, maxLength: 255 },
  s: { type: "string" },
  so: { type: "number" },
  ch: { type: "object", array: true, recursive: true },
};

const REQUEST_ATTRIBUTES: Shape = {
  m: { type: "string" },
  sc: { type: "number" },
  ou: { type: "string" },
  dop: { type: "string" },
};

const TRACES: FieldSpec = {
  type: "object",
  array: true,
  required: true,
  fallback: [],
  shape: TRACE_NODE,
};

/** No `st`: see the module header. */
const REQUEST_SNAPSHOT: Shape = {
  ct: { type: "string" },
  ti: { type: "string", required: true, maxLength: 255 },
  d: { type: "number" },
  p: { type: "string" },
  op: { type: "string", required: true },
  u: { type: "string" },
  tg: { type: "object" },
  e: { type: "object" },
  rq: { type: "object" },
  a: { type: "object", shape: REQUEST_ATTRIBUTES },
  t: TRACES,
};

const JOB_SNAPSHOT: Shape = {
  i: { type: "string", required: true },
  ti: { type: "string", required: true, maxLength: 255 },
  n: { type: "string" },
  q: { type: "string" },
  s: { type: "string" },
  c: { type: "string" },
  d: { type: "number" },
  ea: { type: "string" },
  wd: { type: "number" },
  am: { type: "number" },
  ma: { type: "number" },
  tg: { type: "object" },
  e: { type: "object" },
  t: TRACES,
};

const GC_COLLECTIONS: Shape = {
  count: { type: "number" },
  duration: { type: "number" },
};

const RUNTIME_METRICS: Shape = {
  c: {
    type: "object",
    shape: {
      u: { type: "number" },
      s: { type: "number" },
      p: { type: "number" },
    },
  },
  m: {
    type: "object",
    shape: {
      r: { type: "number" },
      ht: { type: "number" },
      hu: { type: "number" },
      e: { type: "number" },
      ab: { type: "number" },
      p: { type: "number" },
    },
  },
  g: {
    type: "object",
    shape: {
      c: { type: "number" },
      td: { type: "number" },
      b: {
        type: "object",
        shape: {
          m: { type: "object", shape: GC_COLLECTIONS },
          j: { type: "object", shape: GC_COLLECTIONS },
          i: { type: "object", shape: GC_COLLECTIONS },
        },
      },
    },
  },
  e: {
    type: "object",
    shape: {
      l: { type: "number" },
      u: { type: "number" },
    },
  },
};

const CUSTOM_METRIC: Shape = {
  n: { type: "string", required: true, maxLength: 100 },
  t: { type: "string", required: true, oneOf: ["counter", "gauge", "summary"] },
  v: { type: "object" },
  tg: { type: "object" },
  d: { type: "string", maxLength: 255 },
  l: { type: "string", array: true, maxLength: 255, maxItems: 1000 },
  lu: { type: "number" },
  k: { type: "string", oneOf: ["additive", "ratio", "peak"] },
  iv: { type: "object" },
  q50: { type: "object" },
  q95: { type: "object" },
  q99: { type: "object" },
  ct: { type: "object" },
  sm: { type: "object" },
  mx: { type: "object" },
};

const LOG_ENTRY: Shape = {
  timestamp: { type: "number", required: true },
  text: { type: "string", required: true },
  traceId: { type: "string", maxLength: 255 },
  spanId: { type: "string", maxLength: 255 },
  level: { type: "string", oneOf: LOG_LEVELS },
  context: { type: "string", maxLength: 255 },
  attributes: { type: "object" },
};

const DECLARED_OBJECTIVE: Shape = {
  availability: { type: "number" },
  latency: {
    type: "object",
    shape: {
      underMs: { type: "number", required: true },
      target: { type: "number", required: true },
    },
  },
  windowDays: { type: "number", oneOf: [7, 14, 28, 30] },
  name: { type: "string", maxLength: 120 },
};

const OBJECTIVE_DECLARATION: Shape = {
  handler: { type: "string", required: true, maxLength: 255 },
  operationId: { type: "string", required: true, maxLength: 255 },
  method: { type: "string", maxLength: 10 },
  objectives: {
    type: "object",
    array: true,
    required: true,
    maxItems: 10,
    shape: DECLARED_OBJECTIVE,
  },
};

/** The batch body the agent POSTs to the collector. */
export const TELEMETRY_BATCH: Shape = {
  serviceId: { type: "string", required: true, maxLength: 100 },
  serviceVersion: { type: "string", maxLength: 50 },
  truncatedSpans: { type: "number" },
  forwardLogs: { type: "boolean" },
  snapshots: {
    type: "object",
    array: true,
    maxItems: MAX_BATCH_ITEMS,
    shape: REQUEST_SNAPSHOT,
  },
  jobs: {
    type: "object",
    array: true,
    maxItems: MAX_BATCH_ITEMS,
    shape: JOB_SNAPSHOT,
  },
  runtime: { type: "object", shape: RUNTIME_METRICS },
  custom: {
    type: "object",
    array: true,
    maxItems: MAX_BATCH_ITEMS,
    shape: CUSTOM_METRIC,
  },
  logs: {
    type: "object",
    array: true,
    maxItems: MAX_BATCH_ITEMS,
    shape: LOG_ENTRY,
  },
  objectives: {
    type: "object",
    array: true,
    maxItems: 100,
    shape: OBJECTIVE_DECLARATION,
  },
};

/** Sections whose entries are individually expendable on a 400. */
export const SECTION_SHAPES = {
  snapshots: REQUEST_SNAPSHOT,
  jobs: JOB_SNAPSHOT,
  custom: CUSTOM_METRIC,
  logs: LOG_ENTRY,
  runtime: RUNTIME_METRICS,
} as const;

export type TelemetrySection = keyof typeof SECTION_SHAPES;

export interface ValidateOptions {
  readonly forbidUnknown?: boolean;
}

export interface ValidationProblem {
  /** Dotted path with array indices: `snapshots[0].a.sc`. */
  readonly path: string;
  readonly message: string;
}

/**
 * Checks a batch body and returns one problem per failure, empty when the
 * payload is acceptable. Mirrors `validateTelemetryPayload` in the SDK.
 */
export function validateBatch(
  payload: unknown,
  options: ValidateOptions = {},
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  checkShape(payload, TELEMETRY_BATCH, "", options, problems);
  return problems;
}

function checkShape(
  value: unknown,
  shape: Shape,
  path: string,
  options: ValidateOptions,
  problems: ValidationProblem[],
): void {
  if (!isPlainObject(value)) {
    problems.push({ path: path || "payload", message: "expected an object" });
    return;
  }
  for (const [key, spec] of Object.entries(shape)) {
    const present = value[key] !== undefined && value[key] !== null;
    if (!present) {
      if (spec.required) {
        problems.push({ path: join(path, key), message: "required" });
      }
      continue;
    }
    checkField(value[key], spec, join(path, key), options, problems);
  }
  if (options.forbidUnknown) {
    for (const key of Object.keys(value)) {
      if (!(key in shape)) {
        problems.push({
          path: join(path, key),
          message: "not declared by the contract",
        });
      }
    }
  }
}

function checkField(
  value: unknown,
  spec: FieldSpec,
  path: string,
  options: ValidateOptions,
  problems: ValidationProblem[],
): void {
  if (spec.array) {
    if (!Array.isArray(value)) {
      problems.push({ path, message: "expected an array" });
      return;
    }
    if (spec.maxItems !== undefined && value.length > spec.maxItems) {
      problems.push({ path, message: `more than ${spec.maxItems} items` });
    }
    value.forEach((item, index) =>
      checkScalarOrShape(item, spec, `${path}[${index}]`, options, problems),
    );
    return;
  }
  checkScalarOrShape(value, spec, path, options, problems);
}

function checkScalarOrShape(
  value: unknown,
  spec: FieldSpec,
  path: string,
  options: ValidateOptions,
  problems: ValidationProblem[],
): void {
  const shape = spec.recursive ? spec.shape : spec.shape;
  if (shape) {
    if (spec.recursive) {
      // A nested span: validate against the node shape itself.
      checkShape(value, shape, path, options, problems);
      return;
    }
    checkShape(value, shape, path, options, problems);
    return;
  }
  const accepted: FieldType[] = [spec.type, ...(spec.alsoAccepts ?? [])];
  if (!accepted.some((type) => matchesType(value, type))) {
    problems.push({
      path,
      message: `expected ${accepted.length > 1 ? accepted.join(" or ") : accepted[0]}`,
    });
    return;
  }
  if (spec.oneOf && !spec.oneOf.includes(value as string | number)) {
    problems.push({
      path,
      message: `one of ${spec.oneOf.join(", ")}`,
    });
  }
  if (spec.maxLength !== undefined && typeof value === "string") {
    if (countCharacters(value) > spec.maxLength) {
      problems.push({
        path,
        message: `longer than ${spec.maxLength} characters`,
      });
    }
  }
}

function matchesType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isPlainObject(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

/**
 * Counts characters the way the collector does: an astral code point or a
 * variation selector is not a character of its own.
 */
function countCharacters(value: string): number {
  return [...value].length;
}

// ---------------------------------------------------------------------------
// Decoded shapes, for the normalizer. These are what a validated batch means.
// ---------------------------------------------------------------------------

/**
 * Source around an in-app stack frame, captured by the agent.
 *
 * The wire name is `codeFrames` on the error object, not `sourceContext` (that
 * is the SDK *option* name). `firstLine` is the 1-based line `lines[0]`
 * corresponds to, and `line` is the 1-based line to highlight.
 */
export interface CodeFrame {
  file: string;
  line: number;
  firstLine: number;
  lines: string[];
}

export interface EncodedSpanError {
  cls?: string;
  message?: string;
  stack?: string;
  tags?: Record<string, string | number | boolean>;
  codeFrames?: CodeFrame[];
}

export interface EncodedSpan {
  n?: string;
  o: "manual" | "auto";
  t?: Record<string, string | number | boolean>;
  d?: number;
  e?: EncodedSpanError | boolean;
  c: string;
  m: string;
  s?: string;
  so?: number;
  ch?: EncodedSpan[];
}

export interface EncodedAttributes {
  m?: string;
  sc?: number;
  ou?: string;
  dop?: string;
}

export interface EncodedRequestSnapshot {
  ct?: string;
  ti: string;
  d?: number;
  p?: string;
  op: string;
  u?: string;
  tg?: Record<string, string | number | boolean>;
  e?: EncodedSpanError;
  rq?: Record<string, unknown>;
  a?: EncodedAttributes;
  t: EncodedSpan[];
}

export interface EncodedJobSnapshot {
  i: string;
  ti: string;
  n?: string;
  q?: string;
  s?: "completed" | "failed";
  c?: string;
  d?: number;
  ea?: string;
  wd?: number;
  am?: number;
  ma?: number;
  tg?: Record<string, string | number | boolean>;
  e?: EncodedSpanError;
  t: EncodedSpan[];
}

export interface EncodedRuntimeSample {
  c?: { u?: number; s?: number; p?: number };
  m?: { r?: number; ht?: number; hu?: number; e?: number; ab?: number; p?: number };
  g?: {
    c?: number;
    td?: number;
    b?: Record<"m" | "j" | "i", { count?: number; duration?: number }>;
  };
  e?: { l?: number; u?: number };
}

export interface EncodedCustomMetric {
  n: string;
  t: "counter" | "gauge" | "summary";
  v?: Record<string, number>;
  tg?: Record<string, string | number | boolean>;
  d?: string;
  l?: string[];
  lu?: number;
  k?: "additive" | "ratio" | "peak";
  iv?: Record<string, number>;
  q50?: Record<string, number>;
  q95?: Record<string, number>;
  q99?: Record<string, number>;
  ct?: Record<string, number>;
  sm?: Record<string, number>;
  mx?: Record<string, number>;
}

export interface EncodedLogEntry {
  timestamp: number;
  text: string;
  traceId?: string;
  spanId?: string;
  level?: (typeof LOG_LEVELS)[number];
  context?: string;
  attributes?: Record<string, unknown>;
}

export interface EncodedObjectiveDeclaration {
  handler: string;
  operationId: string;
  method?: string;
  objectives: Array<{
    availability?: number;
    latency?: { underMs: number; target: number };
    windowDays?: 7 | 14 | 28 | 30;
    name?: string;
  }>;
}

export interface TelemetryBatch {
  serviceId: string;
  serviceVersion?: string;
  truncatedSpans?: number;
  forwardLogs?: boolean;
  snapshots?: EncodedRequestSnapshot[];
  jobs?: EncodedJobSnapshot[];
  runtime?: EncodedRuntimeSample;
  custom?: EncodedCustomMetric[];
  logs?: EncodedLogEntry[];
  objectives?: EncodedObjectiveDeclaration[];
}

// ---------------------------------------------------------------------------
// The reply. Every field of `degraded` is a billing concept; we always answer
// `{ degraded: false }` and keep the type so the shape stays documented.
// ---------------------------------------------------------------------------

export interface TelemetryReply {
  degraded: boolean;
  trimmed?: boolean;
  paced?: boolean;
  errorsOnly?: boolean;
  reason?: "spike" | "budget";
}
