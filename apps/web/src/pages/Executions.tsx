import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, type ExecutionListItem, type SpanRow } from "../api";
import { Badge, Empty, ErrorState, Skeleton, statusTone } from "../components/ui";
import { formatClock, formatDuration, layoutWaterfall, selfTimeMs } from "../format";
import type { TimeRangeId } from "../format";
import { windowFor } from "../format";

/**
 * Executions list.
 *
 * The list is the index into a trace, so its columns are chosen for scanning:
 * time, what ran, how it ended, how long, and how big the tree is. Filtering by
 * kind is client-side because the server already returns the window; filtering by
 * operation is a server query because it changes which rows exist.
 */
export function Executions({
  id,
  range,
  operationRowId,
  navigate,
}: {
  id: string;
  range: TimeRangeId;
  operationRowId?: string;
  navigate: (to: string) => void;
}) {
  const [kind, setKind] = useState<"all" | "request" | "job">("all");
  const [selected, setSelected] = useState(0);
  const window = windowFor(range);

  const query = useQuery({
    queryKey: ["executions", id, range, operationRowId, kind],
    queryFn: () =>
      api.executions(id, {
        ...window,
        limit: 50,
        operationRowId,
        kind: kind === "all" ? undefined : kind,
      }),
    refetchInterval: 10_000,
  });

  const items = query.data?.items ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Executions</h1>
        <div className="flex gap-1 rounded-lg border bg-surface-raised p-1 text-xs">
          {(["all", "request", "job"] as const).map((entry) => (
            <button
              key={entry}
              onClick={() => setKind(entry)}
              className={`rounded px-2 py-1 ${
                entry === kind ? "bg-surface-hover text-ink" : "text-ink-faint"
              }`}
            >
              {entry}
            </button>
          ))}
        </div>
      </div>

      {query.isError && <ErrorState error={query.error} />}
      {query.isLoading && <Skeleton rows={8} />}
      {!query.isLoading && items.length === 0 && (
        <Empty>No executions in this window for these filters.</Empty>
      )}

      <ul className="divide-y rounded-lg border bg-surface-raised">
        {items.map((item, index) => (
          <li key={item.id}>
            <button
              onClick={() => {
                setSelected(index);
                navigate(`/executions/${item.id}?range=${range}`);
              }}
              onFocus={() => setSelected(index)}
              className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-surface-hover ${
                index === selected ? "bg-surface-hover" : ""
              }`}
            >
              <span className="tabular w-20 shrink-0 text-xs text-ink-faint">
                {formatClock(item.startedAt)}
              </span>
              <span className="w-14 shrink-0 font-mono text-xs text-ink-muted">
                {item.method ?? item.kind}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {item.operationId ?? item.queue ?? item.jobName ?? item.traceId}
              </span>
              {item.errorGroupId && <Badge tone="bad">error</Badge>}
              {item.statusCode !== null && (
                <Badge tone={statusTone(item.statusCode)}>{item.statusCode}</Badge>
              )}
              <span className="tabular w-16 shrink-0 text-right text-xs text-ink-muted">
                {formatDuration(item.durationMs)}
              </span>
              <span className="tabular w-10 shrink-0 text-right text-xs text-ink-faint">
                {item.spanCount}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The trace waterfall.
 *
 * Bars are positioned from `startOffsetMs` + `durationMs` against the trace's own
 * clock, which is what lets concurrent siblings overlap instead of stacking. The
 * tree is rendered as an indented list so the structure survives on a narrow
 * screen, with the bar drawn in a fixed-width column.
 */
export function ExecutionDetail({ id }: { id: string }) {
  const query = useQuery({
    queryKey: ["execution", id],
    queryFn: () => api.execution(id),
  });

  const spans = query.data?.spans ?? [];
  const { bars, totalMs } = useMemo(() => layoutWaterfall(spans), [spans]);
  const [openSpan, setOpenSpan] = useState<string | null>(null);

  if (query.isError) return <ErrorState error={query.error} />;
  if (query.isLoading) return <Skeleton rows={10} />;
  if (!query.data) return <Empty>No such execution.</Empty>;

  const { execution, logs, error } = query.data;
  const ordered = orderTree(spans);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="font-mono text-lg">
            {execution.method ? `${execution.method} ` : ""}
            {execution.operationId ?? execution.jobName ?? execution.traceId}
          </h1>
          <p className="text-xs text-ink-faint">
            trace <span className="font-mono">{execution.traceId}</span> ·{" "}
            {new Date(execution.startedAt).toISOString()} · {spans.length} spans ·{" "}
            {formatDuration(totalMs)} total
          </p>
        </div>
        <div className="flex items-center gap-2">
          {execution.statusCode !== null && (
            <Badge tone={statusTone(execution.statusCode)}>{execution.statusCode}</Badge>
          )}
          <Badge>{execution.kind}</Badge>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 p-4">
          <div className="font-medium text-danger">
            {error.class ?? "Error"}: {error.message}
          </div>
          {error.topFrameFile && (
            <div className="mt-1 font-mono text-xs text-ink-muted">
              {error.topFrameFile}:{error.topFrameLine}
            </div>
          )}
          <div className="mt-1 text-xs text-ink-faint">
            seen {error.occurrences} times · first {new Date(error.firstSeen).toLocaleString()}
          </div>
        </div>
      )}

      <section className="rounded-lg border bg-surface-raised">
        <header className="flex items-center justify-between border-b px-4 py-2.5 text-sm font-medium">
          <span>Waterfall</span>
          <span className="tabular text-xs text-ink-faint">
            0 — {formatDuration(totalMs)}
          </span>
        </header>
        <ul className="divide-y">
          {ordered.map((span) => {
            const bar = bars.get(span.id);
            const self = selfTimeMs(span.id, spans);
            const open = openSpan === span.id;
            return (
              <li key={span.id}>
                <button
                  onClick={() => setOpenSpan(open ? null : span.id)}
                  className="grid w-full grid-cols-[minmax(0,22rem)_1fr_5rem] items-center gap-3 px-3 py-1.5 text-left text-xs hover:bg-surface-hover"
                >
                  <span
                    className="flex min-w-0 items-center gap-2"
                    style={{ paddingLeft: `${span.depth * 12}px` }}
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        span.error ? "bg-danger" : span.origin === "manual" ? "bg-accent" : "bg-ink-faint"
                      }`}
                    />
                    <span className="truncate font-mono">
                      {span.name ?? `${span.className}.${span.method}`}
                    </span>
                    {span.collapsedCount ? (
                      <Badge tone="warn">×{span.collapsedCount}</Badge>
                    ) : null}
                  </span>
                  <span className="relative h-3 w-full rounded bg-surface">
                    {bar && (
                      <span
                        className={`absolute inset-y-0 rounded ${
                          span.error ? "bg-danger/70" : "bg-accent/70"
                        }`}
                        style={{ left: `${bar.leftPct}%`, width: `${bar.widthPct}%` }}
                        title={`${formatDuration(span.durationMs)} at +${formatDuration(
                          span.startOffsetMs,
                        )}`}
                      />
                    )}
                  </span>
                  <span className="tabular text-right text-ink-muted">
                    {formatDuration(span.durationMs)}
                  </span>
                </button>
                {open && (
                  <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 border-t bg-surface px-4 py-2 text-xs">
                    <dt className="text-ink-faint">class.method</dt>
                    <dd className="font-mono">
                      {span.className}.{span.method}
                    </dd>
                    <dt className="text-ink-faint">origin</dt>
                    <dd>{span.origin}</dd>
                    <dt className="text-ink-faint">start offset</dt>
                    <dd className="tabular">{formatDuration(span.startOffsetMs)}</dd>
                    <dt className="text-ink-faint">self time</dt>
                    <dd className="tabular">{formatDuration(self)}</dd>
                    {Object.keys(span.tags).length > 0 && (
                      <>
                        <dt className="text-ink-faint">tags</dt>
                        <dd className="font-mono break-all">
                          {JSON.stringify(span.tags)}
                        </dd>
                      </>
                    )}
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="rounded-lg border bg-surface-raised">
        <header className="border-b px-4 py-2.5 text-sm font-medium">
          Logs for this trace
        </header>
        {logs.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-ink-faint">
            No forwarded logs. Enable <code>forwardLogs: true</code> in{" "}
            <code>ObserveModule.forRoot()</code> to correlate them.
          </div>
        ) : (
          <ul className="divide-y font-mono text-xs">
            {logs.map((log) => (
              <li key={log.id} className="flex gap-3 px-4 py-1.5">
                <span className="tabular w-20 shrink-0 text-ink-faint">
                  {formatClock(log.occurredAt)}
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
        )}
      </section>
    </div>
  );
}

/** Depth-first order, so parents precede their children with their own `seq`. */
function orderTree(spans: SpanRow[]): SpanRow[] {
  const byParent = new Map<string | null, SpanRow[]>();
  for (const span of spans) {
    const key = span.parentId;
    const list = byParent.get(key) ?? [];
    list.push(span);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.seq - b.seq);

  const ordered: SpanRow[] = [];
  const walk = (parentId: string | null) => {
    for (const child of byParent.get(parentId) ?? []) {
      ordered.push(child);
      walk(child.id);
    }
  };
  walk(null);
  // Orphans (a child whose parent was dropped by the agent's repair path) still
  // deserve to render.
  for (const span of spans) {
    if (!ordered.includes(span)) ordered.push(span);
  }
  return ordered;
}

export type { ExecutionListItem };
