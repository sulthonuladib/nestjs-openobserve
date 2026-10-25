import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ErrorGroupRow } from "../api";
import { Badge, Empty, ErrorState, Skeleton } from "../components/ui";
import { formatCount, formatRelative, windowFor, type TimeRangeId } from "../format";

/**
 * The error inbox.
 *
 * Grouping happened at ingest (fingerprint = class + normalized message + top
 * in-app frame), so this is a list plus one workflow: resolve, ignore, reopen.
 * The actions are optimistic — an operator clicking "resolve" hundreds of times
 * should not wait for a round trip each time.
 */
export function Errors({
  id,
  range,
  navigate,
}: {
  id: string;
  range: TimeRangeId;
  navigate: (to: string) => void;
}) {
  const client = useQueryClient();
  const [status, setStatus] = useState<ErrorGroupRow["status"] | "all">("open");

  const query = useQuery({
    queryKey: ["errors", id, status],
    queryFn: () => api.errors(id, status === "all" ? undefined : status),
    refetchInterval: 15_000,
  });

  const mutate = useMutation({
    mutationFn: ({ errorId, next }: { errorId: string; next: ErrorGroupRow["status"] }) =>
      api.setErrorStatus(errorId, next),
    onSuccess: () => client.invalidateQueries({ queryKey: ["errors", id] }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Errors</h1>
        <div className="flex gap-1 rounded-lg border bg-surface-raised p-1 text-xs">
          {(["open", "resolved", "ignored", "all"] as const).map((entry) => (
            <button
              key={entry}
              onClick={() => setStatus(entry)}
              className={`rounded px-2 py-1 ${
                entry === status ? "bg-surface-hover text-ink" : "text-ink-faint"
              }`}
            >
              {entry}
            </button>
          ))}
        </div>
      </div>

      {query.isError && <ErrorState error={query.error} />}
      {query.isLoading && <Skeleton rows={6} />}
      {!query.isLoading && (query.data?.items.length ?? 0) === 0 && (
        <Empty>No {status === "all" ? "" : status} error groups.</Empty>
      )}

      <ul className="divide-y rounded-lg border bg-surface-raised">
        {(query.data?.items ?? []).map((group) => (
          <li key={group.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{group.message}</div>
                <div className="mt-0.5 truncate font-mono text-xs text-ink-faint">
                  {group.class ?? "Error"}
                  {group.topFrameFile
                    ? ` · ${group.topFrameFile}:${group.topFrameLine}`
                    : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={group.status === "open" ? "bad" : "default"}>{group.status}</Badge>
                <span className="tabular text-xs text-ink-faint">
                  ×{formatCount(group.occurrences)} · {formatRelative(group.lastSeen)}
                </span>
              </div>
            </div>
            <div className="mt-2 flex gap-2 text-xs">
              <button
                className="rounded border px-2 py-0.5 hover:bg-surface-hover"
                onClick={() =>
                  mutate.mutate({
                    errorId: group.id,
                    next: group.status === "resolved" ? "open" : "resolved",
                  })
                }
              >
                {group.status === "resolved" ? "Reopen" : "Resolve"}
              </button>
              <button
                className="rounded border px-2 py-0.5 hover:bg-surface-hover"
                onClick={() =>
                  mutate.mutate({
                    errorId: group.id,
                    next: group.status === "ignored" ? "open" : "ignored",
                  })
                }
              >
                {group.status === "ignored" ? "Un-ignore" : "Ignore"}
              </button>
              <button
                className="rounded border px-2 py-0.5 hover:bg-surface-hover"
                onClick={() => navigate(`/applications/${id}/executions?range=${range}`)}
              >
                See executions
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Log explorer.
 *
 * Full-text search is client-side over the returned page: the server filters by
 * level and trace id, which are the two dimensions that change which rows exist.
 * Substring search over a page is honest and instant; pretend-SQL over the whole
 * table would need a query language nobody asked for yet.
 */
type Level = "fatal" | "error" | "warn" | "log" | "debug" | "verbose";

export function Logs({ id, range }: { id: string; range: TimeRangeId }) {
  const [level, setLevel] = useState<Level | "">("");
  const [search, setSearch] = useState("");
  const window = windowFor(range);

  const query = useQuery({
    queryKey: ["logs", id, range, level],
    queryFn: () => api.logs(id, { ...window, level: level || undefined, limit: 300 }),
    refetchInterval: 10_000,
  });

  const items = (query.data?.items ?? []).filter((log) =>
    search ? log.text.toLowerCase().includes(search.toLowerCase()) : true,
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-lg font-medium">Logs</h1>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter…  ( / )"
          className="w-56 rounded border bg-surface-raised px-2 py-1 text-sm placeholder:text-ink-faint"
        />
        <select
          value={level}
          onChange={(event) => setLevel(event.target.value as Level | "")}
          className="rounded border bg-surface-raised px-2 py-1 text-sm"
        >
          <option value="">all levels</option>
          {(["fatal", "error", "warn", "log", "debug", "verbose"] as const).map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      </div>

      {query.isError && <ErrorState error={query.error} />}
      {query.isLoading && <Skeleton rows={8} />}
      {!query.isLoading && items.length === 0 && (
        <Empty>
          No logs. They only arrive when the app sets <code>forwardLogs: true</code>.
        </Empty>
      )}

      <ul className="divide-y rounded-lg border bg-surface-raised font-mono text-xs">
        {items.map((log) => (
          <li key={log.id} className="flex gap-3 px-4 py-1.5 hover:bg-surface-hover">
            <span className="tabular w-20 shrink-0 text-ink-faint">
              {new Date(log.occurredAt).toLocaleTimeString(undefined, { hour12: false })}
            </span>
            <span className="w-14 shrink-0">
              <Badge tone={log.level === "error" || log.level === "fatal" ? "bad" : "default"}>
                {log.level ?? "log"}
              </Badge>
            </span>
            <span className="w-32 shrink-0 truncate text-ink-muted">{log.context}</span>
            <span className="min-w-0 flex-1 break-words">{log.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
