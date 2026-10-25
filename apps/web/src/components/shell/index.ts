/**
 * The shell's public surface.
 *
 * Pages import from here (or from the individual modules); the barrel exists so
 * a page can take `PageHeader` and `useLive` without knowing how the shell is
 * split into files.
 */
export { NavRail } from "./NavRail";
export { Sidebar, SIDEBAR_WIDTH } from "./Sidebar";
export { TopBar } from "./TopBar";
export { PageHeader, PageSkeleton, SectionLabel, type PageHeaderProps } from "./PageHeader";
export { AppSwitcher } from "./AppSwitcher";
export { RangePicker } from "./RangePicker";
export { LiveToggle } from "./LiveToggle";
export {
  DEFAULT_RANGE,
  LIVE_INTERVAL_MS,
  RANGES,
  ShellProvider,
  isRange,
  useLive,
  useLiveInterval,
  useShell,
  type RangeId,
  type ShellApplication,
  type ShellState,
  type ShellUser,
} from "./ShellContext";
