import { createContext, useContext } from "react";

/**
 * The shell's shared state.
 *
 * Two things live here and nowhere else:
 *
 *  - **the URL-derived context** (`appId`, `range`, `search`), because the URL is
 *    the source of truth and a page must never keep its own copy of it;
 *  - **`live`**, because "poll or do not poll" is a property of the session, not
 *    of a page: turn it off and every query in the app stops, turn it on and they
 *    all resume on the same 10s beat.
 *
 * The reference polls every minute; ten seconds is what makes the collector feel
 * live without turning an open dashboard tab into a load generator.
 */
export const LIVE_INTERVAL_MS = 10_000;

/** The five ranges the reference offers as chips. */
export const RANGES = [
  { id: "1h", label: "1H", ms: 60 * 60 * 1000 },
  { id: "24h", label: "24H", ms: 24 * 60 * 60 * 1000 },
  { id: "3d", label: "3D", ms: 3 * 24 * 60 * 60 * 1000 },
  { id: "7d", label: "7D", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "30D", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

export type RangeId = (typeof RANGES)[number]["id"];

export const DEFAULT_RANGE: RangeId = "1h";

export function isRange(value: string | null | undefined): value is RangeId {
  return RANGES.some((entry) => entry.id === value);
}

/** The smallest shape the shell needs from an application, for the switcher. */
export interface ShellApplication {
  id: string;
  name: string;
  serviceId?: string;
}

export interface ShellUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

export interface ShellState {
  /** Selected application scope; `""` means every application. */
  appId: string;
  /** A concrete application for navigation links; `""` when none exist yet. */
  navAppId: string;
  /** Known applications, for the top-bar switcher. */
  apps: ShellApplication[];
  /** True while the application list is still loading. */
  appsLoading: boolean;

  range: RangeId;
  setRange: (next: RangeId) => void;
  /** `""` clears the filter. */
  setAppId: (next: string) => void;

  /** Text search, mirrored into `?search=`. */
  search: string;
  setSearch: (next: string) => void;

  /** Polling on/off, and the value to hand TanStack Query. */
  live: boolean;
  setLive: (next: boolean) => void;
  interval: number | false;

  /** Sidebar visibility (the icon rail is always visible). */
  collapsed: boolean;
  toggleCollapsed: () => void;

  navigate: (to: string) => void;
  refresh: () => void;

  /** Pending CLI link approvals — the closest thing to a notification we have. */
  notifications: number;

  user: ShellUser;
}

const ShellContext = createContext<ShellState | null>(null);

export const ShellProvider = ShellContext.Provider;

export function useShell(): ShellState {
  const value = useContext(ShellContext);
  if (!value) {
    throw new Error("useShell() must be called inside the dashboard shell");
  }
  return value;
}

/**
 * Live polling, for pages.
 *
 * ```tsx
 * const { live, interval } = useLive();
 * useQuery({ queryKey: [...], queryFn, refetchInterval: interval });
 * ```
 *
 * `interval` is `10_000` when live is on and `false` when it is off, which is
 * exactly what TanStack Query wants — no page needs to know the number.
 */
export function useLive(): { live: boolean; interval: number | false; setLive: (next: boolean) => void } {
  const { live, interval, setLive } = useShell();
  return { live, interval, setLive };
}

/** Shorthand for the common case: just the `refetchInterval` value. */
export function useLiveInterval(): number | false {
  return useShell().interval;
}
