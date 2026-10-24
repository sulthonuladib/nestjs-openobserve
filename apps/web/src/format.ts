/**
 * Formatting helpers, kept pure and separate so they are testable without a DOM.
 */

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatRelative(timestamp: number, now = Date.now()): string {
  const delta = now - timestamp;
  if (delta < 0) return "just now";
  const seconds = Math.round(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export const TIME_RANGES = [
  { id: "15m", label: "15m", ms: 15 * 60 * 1000 },
  { id: "1h", label: "1h", ms: 60 * 60 * 1000 },
  { id: "6h", label: "6h", ms: 6 * 60 * 60 * 1000 },
  { id: "24h", label: "24h", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

export type TimeRangeId = (typeof TIME_RANGES)[number]["id"];

export function windowFor(range: TimeRangeId, now = Date.now()): { from: number; to: number } {
  const found = TIME_RANGES.find((entry) => entry.id === range) ?? TIME_RANGES[1];
  return { from: now - found.ms, to: now };
}

/**
 * Waterfall geometry.
 *
 * Spans carry `startOffsetMs` relative to the trace root and their own
 * `durationMs`, which is what makes real overlap drawable: two siblings that ran
 * concurrently must overlap rather than stack end to end. Agents older than the
 * field send none, so a fallback lays the tree out sequentially — visibly
 * different, and honest about what is unknown.
 */
export interface WaterfallBar {
  id: string;
  leftPct: number;
  widthPct: number;
  depth: number;
}

export function layoutWaterfall(
  spans: Array<{
    id: string;
    depth: number;
    durationMs: number | null;
    startOffsetMs: number | null;
    parentId: string | null;
  }>,
): { bars: Map<string, WaterfallBar>; totalMs: number } {
  const bars = new Map<string, WaterfallBar>();
  if (spans.length === 0) return { bars, totalMs: 0 };

  const hasOffsets = spans.some((span) => span.startOffsetMs !== null);
  let sequential = 0;
  let maxEnd = 0;

  for (const span of spans) {
    const duration = span.durationMs ?? 0;
    const start = hasOffsets ? (span.startOffsetMs ?? 0) : sequential;
    if (!hasOffsets) sequential += duration;
    maxEnd = Math.max(maxEnd, start + duration);
  }

  const totalMs = maxEnd > 0 ? maxEnd : 1;
  sequential = 0;

  for (const span of spans) {
    const duration = span.durationMs ?? 0;
    const start = hasOffsets ? (span.startOffsetMs ?? 0) : sequential;
    if (!hasOffsets) sequential += duration;
    bars.set(span.id, {
      id: span.id,
      leftPct: (start / totalMs) * 100,
      // A zero-duration span still has to be visible; 0.4% is ~1px on a 250px bar.
      widthPct: Math.max((duration / totalMs) * 100, 0.4),
      depth: span.depth,
    });
  }

  return { bars, totalMs };
}

/** Self time: a span's duration minus its direct children's. */
export function selfTimeMs(
  spanId: string,
  spans: Array<{ id: string; parentId: string | null; durationMs: number | null }>,
): number | null {
  const span = spans.find((entry) => entry.id === spanId);
  if (!span || span.durationMs === null) return null;
  const children = spans.filter((entry) => entry.parentId === spanId);
  const childTime = children.reduce((sum, child) => sum + (child.durationMs ?? 0), 0);
  return Math.max(0, span.durationMs - childTime);
}
