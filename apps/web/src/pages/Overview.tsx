import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Empty, ErrorState, Skeleton, Stat, Table } from "../components/ui";
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatRelative,
  TIME_RANGES,
  windowFor,
  type TimeRangeId,
} from "../format";
import type { Route } from "../router";

export function Overview({ route, navigate }: { route: Route; navigate: (to: string) => void }) {
  const range = (route.query.get("range") as TimeRangeId) ?? "1h";
  const [selected, setSelected] = useState(0);
  const window = windowFor(range);
  const applications = useQuery({
    queryKey: ["applications", range],
    queryFn: () => api.applications(window),
    // The collector is live; a 10s refetch is fast enough to feel real and slow
    // enough that a dashboard tab is not a load generator.
    refetchInterval: 10_000,
  });

  const apps = applications.data ?? [];
  const app = apps[Math.min(selected, apps.length - 1)];
  const errors = useQuery({
    queryKey: ["errors", app?.id],
    queryFn: () => api.errors(app!.id, "open"),
    enabled: Boolean(app),
    refetchInterval: 10_000,
  });

  const totalRequests = apps.reduce((sum, entry) => sum + entry.requests, 0);
  const errorRate =
    totalRequests > 0
      ? apps.reduce((sum, entry) => sum + entry.requests * entry.errorRate, 0) / totalRequests
      : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Overview</h1>
        <RangePicker range={range} navigate={navigate} route={route} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Applications" value={apps.length} />
        <Stat label="Requests" value={formatCount(totalRequests)} />
        <Stat
          label="Error rate"
          value={formatPercent(errorRate, 2)}
          tone={errorRate > 0.05 ? "bad" : errorRate > 0.01 ? "warn" : "good"}
        />
        <Stat
          label="Databases"
          value={apps.length > 0 ? "reporting" : "idle"}
          tone={apps.length > 0 ? "good" : "default"}
        />
      </div>

      <Table
        empty={!applications.isLoading && apps.length === 0}
        head={
          <tr className="border-b">
            <th className="px-4 py-2 font-medium">Application</th>
            <th className="px-4 py-2 text-right font-medium">Requests</th>
            <th className="px-4 py-2 text-right font-medium">Error rate</th>
            <th className="px-4 py-2 text-right font-medium">Avg</th>
            <th className="px-4 py-2 text-right font-medium">p95</th>
            <th className="px-4 py-2 text-right font-medium">Last seen</th>
          </tr>
        }
      >
        {applications.isLoading && (
          <tr>
            <td colSpan={6}>
              <Skeleton />
            </td>
          </tr>
        )}
        {apps.map((entry, index) => (
          <tr
            key={entry.id}
            tabIndex={0}
            onClick={() => {
              setSelected(index);
              navigate(`/applications/${entry.id}?range=${range}`);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") navigate(`/applications/${entry.id}?range=${range}`);
            }}
            className={`cursor-pointer border-b last:border-0 hover:bg-surface-hover ${
              index === selected ? "bg-surface-hover" : ""
            }`}
          >
            <td className="px-4 py-2">
              <div className="font-medium">{entry.name}</div>
              <div className="text-xs text-ink-faint">{entry.serviceId}</div>
            </td>
            <td className="tabular px-4 py-2 text-right">{formatCount(entry.requests)}</td>
            <td className="tabular px-4 py-2 text-right">
              <span
                className={
                  entry.errorRate > 0.05
                    ? "text-danger"
                    : entry.errorRate > 0.01
                      ? "text-warn"
                      : "text-ink-muted"
                }
              >
                {formatPercent(entry.errorRate, 2)}
              </span>
            </td>
            <td className="tabular px-4 py-2 text-right">{formatDuration(entry.avgDurationMs)}</td>
            <td className="tabular px-4 py-2 text-right">{formatDuration(entry.p95DurationMs)}</td>
            <td className="px-4 py-2 text-right text-ink-faint">
              {formatRelative(entry.lastSeen)}
            </td>
          </tr>
        ))}
      </Table>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border bg-surface-raised">
          <header className="border-b px-4 py-2.5 text-sm font-medium">
            Open errors {app ? `— ${app.name}` : ""}
          </header>
          {errors.isError ? (
            <div className="p-4">
              <ErrorState error={errors.error} />
            </div>
          ) : errors.isLoading ? (
            <Skeleton rows={4} />
          ) : (errors.data?.items.length ?? 0) === 0 ? (
            <Empty>No open error groups. A quiet error page is the good outcome.</Empty>
          ) : (
            <ul className="divide-y">
              {errors.data!.items.slice(0, 5).map((group) => (
                <li key={group.id} className="px-4 py-2.5">
                  <button
                    className="w-full text-left"
                    onClick={() =>
                      navigate(`/applications/${group.applicationId}/errors?range=${range}`)
                    }
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm">{group.message}</span>
                      <span className="tabular shrink-0 text-xs text-ink-faint">
                        ×{formatCount(group.occurrences)}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-ink-faint">
                      {group.class ?? "Error"}
                      {group.topFrameFile ? ` · ${group.topFrameFile}:${group.topFrameLine}` : ""}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function RangePicker({
  range,
  navigate,
  route,
}: {
  range: TimeRangeId;
  navigate: (to: string) => void;
  route: Route;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border bg-surface-raised p-1">
      {TIME_RANGES.map((entry) => (
        <button
          key={entry.id}
          onClick={() => navigate(`${route.path}?range=${entry.id}`)}
          className={`rounded px-2 py-1 text-xs ${
            entry.id === range ? "bg-surface-hover text-ink" : "text-ink-faint hover:text-ink"
          }`}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
