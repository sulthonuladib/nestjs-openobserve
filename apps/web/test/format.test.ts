import { describe, expect, it } from "bun:test";
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatRelative,
  layoutWaterfall,
  selfTimeMs,
  windowFor,
} from "../src/format";

/**
 * The waterfall geometry is the one piece of UI logic that can be silently
 * wrong: a bad layout still renders, it just lies about where the time went.
 */
describe("layoutWaterfall", () => {
  const span = (id: string, parentId: string | null, offset: number | null, duration: number) => ({
    id,
    parentId,
    depth: parentId ? 1 : 0,
    startOffsetMs: offset,
    durationMs: duration,
  });

  it("places overlapping siblings side by side rather than end to end", () => {
    // Two children that each take 50 ms and start together must both sit at the
    // left edge over the same width — that overlap is the whole point of
    // carrying startOffsetMs.
    const spans = [
      span("root", null, 0, 100),
      span("a", "root", 0, 50),
      span("b", "root", 0, 50),
    ];
    const { bars, totalMs } = layoutWaterfall(spans);

    expect(totalMs).toBe(100);
    expect(bars.get("a")!.leftPct).toBe(0);
    expect(bars.get("b")!.leftPct).toBe(0);
    expect(bars.get("a")!.widthPct).toBe(50);
  });

  it("falls back to a sequential layout when the agent sent no offsets", () => {
    const spans = [
      span("root", null, null, 100),
      span("a", "root", null, 30),
      span("b", "root", null, 70),
    ];
    const { bars, totalMs } = layoutWaterfall(spans);

    expect(totalMs).toBe(200);
    expect(bars.get("root")!.leftPct).toBe(0);
    expect(bars.get("a")!.leftPct).toBe(50);
    expect(bars.get("b")!.leftPct).toBe(65);
  });

  it("gives a zero-duration span a visible minimum width", () => {
    const { bars } = layoutWaterfall([span("root", null, 0, 100), span("a", "root", 0, 0)]);
    expect(bars.get("a")!.widthPct).toBeGreaterThan(0);
  });

  it("handles an empty trace without dividing by zero", () => {
    expect(layoutWaterfall([])).toEqual({ bars: new Map(), totalMs: 0 });
  });
});

describe("selfTimeMs", () => {
  it("subtracts direct children only, not grandchildren", () => {
    const spans = [
      { id: "root", parentId: null, durationMs: 100 },
      { id: "a", parentId: "root", durationMs: 40 },
      { id: "a1", parentId: "a", durationMs: 10 },
    ];
    // 100 - 40 = 60. Counting a1 again would double-subtract it.
    expect(selfTimeMs("root", spans)).toBe(60);
    expect(selfTimeMs("a", spans)).toBe(30);
  });

  it("never returns a negative self time", () => {
    const spans = [
      { id: "root", parentId: null, durationMs: 10 },
      { id: "a", parentId: "root", durationMs: 50 },
    ];
    expect(selfTimeMs("root", spans)).toBe(0);
  });
});

describe("formatters", () => {
  it("formats durations across the unit boundary", () => {
    expect(formatDuration(0.4)).toBe("400µs");
    expect(formatDuration(1.5)).toBe("1.5ms");
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(2500)).toBe("2.50s");
    expect(formatDuration(null)).toBe("—");
  });

  it("abbreviates counts", () => {
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1200)).toBe("1.2k");
    expect(formatCount(2_400_000)).toBe("2.4M");
  });

  it("formats relative times", () => {
    const now = 1_000_000_000_000;
    expect(formatRelative(now - 5_000, now)).toBe("5s ago");
    expect(formatRelative(now - 90_000, now)).toBe("2m ago");
    expect(formatRelative(now - 7_200_000, now)).toBe("2h ago");
  });

  it("never reports a ratio as more than 100%", () => {
    expect(formatPercent(0.0123, 2)).toBe("1.23%");
    expect(formatPercent(0)).toBe("0.0%");
  });

  it("derives a window from the range id, defaulting to an hour", () => {
    const now = 1_000_000_000_000;
    expect(windowFor("15m", now)).toEqual({ from: now - 900_000, to: now });
    // An unknown id must not produce an empty or inverted window.
    expect(windowFor("nonsense" as never, now)).toEqual({ from: now - 3_600_000, to: now });
  });
});
