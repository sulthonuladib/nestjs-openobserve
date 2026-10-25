/**
 * The API client — Eden, generated from the server's own types.
 *
 * `treaty<ApiApp>()` reads the Elysia app's route map, so a path, a query
 * parameter or a response field that the server does not have is a compile error
 * here. That is the whole point: the dashboard cannot drift from the collector,
 * and renaming a column forces a UI fix instead of a runtime `undefined`.
 *
 * The one place this repo imports server code into the browser bundle is a
 * **type-only** import, erased at build time. Nothing from the server ships.
 */
import { treaty } from "@elysiajs/eden";
import type { ApiApp } from "@observe/server/app";

const client = treaty<ApiApp>(globalThis.location?.origin ?? "http://localhost:4320");

/** Unwraps Eden's `{ data, error }` into a value or a thrown `ApiError`. */
async function unwrap<T>(
  result: Promise<{ data: T | null; error: unknown; status: number }>,
): Promise<T> {
  const { data, error, status } = await result;
  if (error) {
    throw new ApiError(status, describe(error));
  }
  return data as T;
}

function describe(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; value?: unknown };
    if (typeof value.message === "string") return value.message;
    return JSON.stringify(error).slice(0, 500);
  }
  return String(error);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Window {
  from: number;
  to: number;
}

/**
 * The surface the pages use.
 *
 * Everything below is a thin adapter over Eden: it exists so a page says
 * `api.executions(appId, range)` instead of threading `{ query: { from, to } }`
 * through every call site, and so the components do not deal with `{ data }`.
 */
export const api = {
  health: () => unwrap(client.health.get()),

  applications: (w: Window) =>
    unwrap(client.api.v1.applications.get({ query: w })),

  operations: (appId: string, w: Window) =>
    unwrap(client.api.v1.applications({ id: appId }).operations.get({ query: w })),

  executions: (
    appId: string,
    w: Window & { limit?: number; operationRowId?: string; kind?: "request" | "job" },
  ) => unwrap(client.api.v1.applications({ id: appId }).executions.get({ query: w })),

  execution: (id: string) => unwrap(client.api.v1.executions({ id }).get()),

  trace: (traceId: string) => unwrap(client.api.v1.traces({ traceId }).get()),

  errors: (appId: string, status?: "open" | "resolved" | "ignored") =>
    unwrap(client.api.v1.applications({ id: appId }).errors.get({ query: { status } })),

  setErrorStatus: (id: string, status: "open" | "resolved" | "ignored") =>
    unwrap(client.api.v1.errors({ id }).patch({ status })),

  logs: (
    appId: string,
    w: Window & {
      level?: "fatal" | "error" | "warn" | "log" | "debug" | "verbose";
      traceId?: string;
      limit?: number;
    },
  ) => unwrap(client.api.v1.applications({ id: appId }).logs.get({ query: w })),

  pendingLinks: () => unwrap(client.api.v1.link.pending.get()),

  approveLink: (userCode: string, serviceId?: string) =>
    unwrap(client.api.v1.link.approve.post({ userCode, serviceId })),

  denyLink: (userCode: string) => unwrap(client.api.v1.link.deny.post({ userCode })),
};

/**
 * Response types, derived from Eden rather than declared.
 *
 * `Awaited<ReturnType<…>>` is how a page names a row type without importing a
 * DTO: the server's schema is the only definition.
 */
type ApplicationsResult = Awaited<ReturnType<typeof api.applications>>;
export type ApplicationSummary = ApplicationsResult[number];

type OperationsResult = Awaited<ReturnType<typeof api.operations>>;
export type RankedOperation = OperationsResult[number];

type ExecutionsResult = Awaited<ReturnType<typeof api.executions>>;
export type ExecutionListItem = ExecutionsResult["items"][number];

type ExecutionResult = Awaited<ReturnType<typeof api.execution>>;
export type ExecutionDetail = ExecutionResult;
export type SpanRow = ExecutionResult["spans"][number];
export type LogRow = ExecutionResult["logs"][number];

type ErrorsResult = Awaited<ReturnType<typeof api.errors>>;
export type ErrorGroupRow = ErrorsResult["items"][number];

type HealthResult = Awaited<ReturnType<typeof api.health>>;
export type Health = HealthResult;
