/**
 * The API client.
 *
 * Types are written by hand here rather than derived from the server, and that
 * is a deliberate trade: the server's Elysia app type is enormous (every plugin,
 * every response schema) and importing it makes the web app's typecheck as slow
 * as the server's. What we do instead is keep this file short and obvious, so a
 * field rename is a one-line fix here. `drizzle-typebox` already guarantees the
 * server's own response models match the database.
 *
 * Every request goes through `request()`, so credentials, error shape and base
 * URL live in exactly one place.
 */

export interface ApplicationSummary {
  id: string;
  serviceId: string;
  name: string;
  lastSeen: number;
  requests: number;
  errorRate: number;
  avgDurationMs: number;
  p95DurationMs: number | null;
}

export interface RankedOperation {
  operationRowId: string;
  kind: "request" | "job";
  operationId: string | null;
  method: string | null;
  customName: string | null;
  count: number;
  errors: number;
  durationSum: number;
  avgDurationMs: number;
  p95DurationMs: number | null;
}

export interface ExecutionListItem {
  id: string;
  kind: "request" | "job";
  protocol: string | null;
  traceId: string;
  startedAt: number;
  durationMs: number | null;
  statusCode: number | null;
  errorGroupId: string | null;
  spanCount: number;
  operationId: string | null;
  method: string | null;
  queue: string | null;
  jobName: string | null;
}

export interface SpanRow {
  id: string;
  executionId: string;
  parentId: string | null;
  spanId: string | null;
  name: string | null;
  origin: "manual" | "auto";
  className: string;
  method: string;
  durationMs: number | null;
  startOffsetMs: number | null;
  error: boolean;
  tags: Record<string, unknown>;
  collapsedCount: number | null;
  depth: number;
  seq: number;
}

export interface LogRow {
  id: string;
  occurredAt: number;
  level: string | null;
  context: string | null;
  text: string;
  traceId: string | null;
  spanId: string | null;
  attributes: Record<string, unknown>;
}

export interface ErrorGroupRow {
  id: string;
  applicationId: string;
  fingerprint: string;
  class: string | null;
  message: string;
  topFrameFile: string | null;
  topFrameLine: number | null;
  status: "open" | "resolved" | "ignored";
  firstSeen: number;
  lastSeen: number;
  occurrences: number;
}

export interface ExecutionDetail {
  execution: ExecutionListItem & {
    applicationId: string;
    tags: Record<string, unknown>;
    request: Record<string, unknown> | null;
    userId: string | null;
    waitMs: number | null;
    attemptsMade: number | null;
    maxAttempts: number | null;
  };
  spans: SpanRow[];
  logs: LogRow[];
  error: ErrorGroupRow | null;
}

export interface Health {
  ok: boolean;
  version: string;
  ingestApi: string;
  sdk: string;
  database: "up" | "down";
  stats: {
    batches: number;
    bytes: number;
    rejected: number;
    refused: number;
    executions: number;
    spans: number;
    lastBatchAt: number | null;
  };
}

export interface Window {
  from: number;
  to: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const BASE = "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
    credentials: "same-origin",
  });
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new ApiError(response.status, text.slice(0, 500));
  }
  return (await response.json()) as T;
}

/**
 * Query string from a plain object. `Object.entries` is used rather than an
 * index signature so callers can pass interfaces (`Window`), which TypeScript
 * refuses to assign to `Record<string, …>`.
 */
function qs(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params) as Array<[string, unknown]>) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export const api = {
  health: () => request<Health>("/health"),

  applications: (w: Window) =>
    request<ApplicationSummary[]>(`/api/v1/applications${qs(w)}`),

  operations: (appId: string, w: Window) =>
    request<RankedOperation[]>(`/api/v1/applications/${appId}/operations${qs(w)}`),

  executions: (
    appId: string,
    w: Window & { limit?: number; operationRowId?: string; kind?: string },
  ) =>
    request<{ items: ExecutionListItem[]; nextCursor: string | null }>(
      `/api/v1/applications/${appId}/executions${qs(w)}`,
    ),

  execution: (id: string) => request<ExecutionDetail>(`/api/v1/executions/${id}`),

  errors: (appId: string, status?: string) =>
    request<{ items: ErrorGroupRow[] }>(
      `/api/v1/applications/${appId}/errors${qs({ status })}`,
    ),

  setErrorStatus: (id: string, status: ErrorGroupRow["status"]) =>
    request<{ ok: boolean }>(`/api/v1/errors/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  logs: (
    appId: string,
    w: Window & { level?: string; traceId?: string; limit?: number },
  ) => request<{ items: LogRow[] }>(`/api/v1/applications/${appId}/logs${qs(w)}`),

  pendingLinks: () =>
    request<{
      items: Array<{
        userCode: string;
        applicationName: string;
        hostname: string | null;
        expiresAt: number;
        createdAt: number;
      }>;
    }>("/api/v1/link/pending"),

  approveLink: (userCode: string, serviceId?: string) =>
    request<{ applicationId: string; userCode: string }>("/api/v1/link/approve", {
      method: "POST",
      body: JSON.stringify({ userCode, serviceId }),
    }),

  denyLink: (userCode: string) =>
    request<{ ok: boolean }>("/api/v1/link/deny", {
      method: "POST",
      body: JSON.stringify({ userCode }),
    }),
};
