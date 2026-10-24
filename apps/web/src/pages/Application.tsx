import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Badge, ErrorState, Skeleton, statusTone, Table } from "../components/ui";
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatRelative,
  windowFor,
  type TimeRangeId,
} from "../format";

/**
 * One application: operations ranked by volume, then the executions behind them.
 *
 * This is the page people actually live on. `p95` comes from the server's merged
 * histogram, so it describes the whole window rather than the average of
 * averages.
 */
export function Application({
  id,
  range,
  navigate,
}: {
  id: string;
  range: TimeRangeId;
  navigate: (to: string) => void;
}) {
  const window = windowFor(range);
  const operations = useQuery({
    queryKey: ["operations", id, range],
    queryFn: () => api.operations(id, window),
    refetchInterval: 15_000,
  });
  const executions = useQuery({
    queryKey: ["executions", id, range],
    queryFn: () => api.executions(id, { ...window, limit: 25 }),
    refetchInterval: 10_000,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Operations</h1>
        <span className="text-xs text-ink-faint">
          {formatRelative(window.from, window.to)} window
        </span>
      </div>

      {operations.isError && <ErrorState error={operations.error} />}

      <Table
        empty={!operations.isLoading && (operations.data?.length ?? 0) === 0}
        head={
          <tr className="border-b">
            <th className="px-4 py-2 font-medium">Operation</th>
            <th className="px-4 py-2 font-medium">Kind</th>
            <th className="px-4 py-2 text-right font-medium">Calls</th>
            <th className="px-4 py-2 text-right font-medium">Errors</th>
            <th className="px-4 py-2 text-right font-medium">Avg</th>
            <th className="px-4 py-2 text-right font-medium">p95</th>
          </tr>
        }
      >
        {operations.isLoading && (
          <tr>
            <td colSpan={6}>
              <Skeleton rows={6} />
            </td>
          </tr>
        )}
        {(operations.data ?? []).map((operation) => (
          <tr
            key={`${operation.operationRowId}-${operation.kind}`}
            tabIndex={0}
            onClick={() =>
              navigate(
                `/applications/${id}/executions?range=${range}&operationRowId=${operation.operationRowId}`,
              )
            }
            onKeyDown={(event) => {
              if (event.key === "Enter")
                navigate(
                  `/applications/${id}/executions?range=${range}&operationRowId=${operation.operationRowId}`,
                );
            }}
            className="cursor-pointer border-b last:border-0 hover:bg-surface-hover"
          >
            <td className="px-4 py-2">
              <span className="font-mono text-xs text-ink-muted">
                {operation.method ?? ""}
              </span>{" "}
              {operation.customName ?? operation.operationId ?? "—"}
            </td>
            <td className="px-4 py-2">
              <Badge tone={operation.kind === "job" ? "default" : "ok"}>{operation.kind}</Badge>
            </td>
            <td className="tabular px-4 py-2 text-right">{formatCount(operation.count)}</td>
            <td className="tabular px-4 py-2 text-right">
              <span className={operation.errors > 0 ? "text-danger" : "text-ink-faint"}>
                {formatCount(operation.errors)}
              </span>
            </td>
            <td className="tabular px-4 py-2 text-right">
              {formatDuration(operation.avgDurationMs)}
            </td>
            <td className="tabular px-4 py-2 text-right">
              {formatDuration(operation.p95DurationMs)}
            </td>
          </tr>
        ))}
      </Table>

      <h2 className="pt-2 text-sm font-medium text-ink-muted">Recent executions</h2>
      {executions.isError && <ErrorState error={executions.error} />}
      <Table
        empty={!executions.isLoading && (executions.data?.items.length ?? 0) === 0}
        head={
          <tr className="border-b">
            <th className="px-4 py-2 font-medium">Started</th>
            <th className="px-4 py-2 font-medium">Operation</th>
            <th className="px-4 py-2 text-right font-medium">Status</th>
            <th className="px-4 py-2 text-right font-medium">Duration</th>
            <th className="px-4 py-2 text-right font-medium">Spans</th>
          </tr>
        }
      >
        {executions.isLoading && (
          <tr>
            <td colSpan={5}>
              <Skeleton />
            </td>
          </tr>
        )}
        {(executions.data?.items ?? []).map((execution) => (
          <tr
            key={execution.id}
            tabIndex={0}
            onClick={() => navigate(`/executions/${execution.id}?range=${range}`)}
            onKeyDown={(event) => {
              if (event.key === "Enter") navigate(`/executions/${execution.id}?range=${range}`);
            }}
            className="cursor-pointer border-b last:border-0 hover:bg-surface-hover"
          >
            <td className="tabular px-4 py-2 text-ink-muted">
              {new Date(execution.startedAt).toLocaleTimeString(undefined, { hour12: false })}
            </td>
            <td className="px-4 py-2 font-mono text-xs">
              {execution.operationId ?? execution.jobName ?? "—"}
            </td>
            <td className="px-4 py-2 text-right">
              {execution.statusCode !== null ? (
                <Badge tone={statusTone(execution.statusCode)}>{execution.statusCode}</Badge>
              ) : execution.errorGroupId ? (
                <Badge tone="bad">failed</Badge>
              ) : (
                <Badge tone="ok">ok</Badge>
              )}
            </td>
            <td className="tabular px-4 py-2 text-right">
              {formatDuration(execution.durationMs)}
            </td>
            <td className="tabular px-4 py-2 text-right text-ink-faint">
              {formatPercent(execution.spanCount > 0 ? 1 : 0, 0).replace("100%", String(execution.spanCount))}
            </td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
