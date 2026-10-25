import {
  Box,
  Button,
  CssBaseline,
  Drawer,
  Skeleton,
  ThemeProvider,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Component, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from "react";
import {
  BrowserRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api, ApiError, auth, type SessionUser } from "./api";
import { NavRail } from "./components/shell/NavRail";
import { Sidebar } from "./components/shell/Sidebar";
import { TopBar } from "./components/shell/TopBar";
import {
  DEFAULT_RANGE,
  isRange,
  ShellProvider,
  useShell,
  type RangeId,
  type ShellApplication,
  type ShellState,
} from "./components/shell/ShellContext";
import { windowFor } from "./format";
import { Application } from "./pages/Application";
import { Invite, Login, Setup } from "./pages/Auth";
import { Errors, Logs } from "./pages/Errors";
import { ExecutionDetail, Executions } from "./pages/Executions";
import { Jobs } from "./pages/Jobs";
import { Link } from "./pages/Link";
import { Metrics } from "./pages/Metrics";
import { Overview } from "./pages/Overview";
import { Operation } from "./pages/Operation";
import { Releases } from "./pages/Releases";
import { Runtime } from "./pages/Runtime";
import { Users } from "./pages/Users";
import { colors, theme } from "./theme";

/**
 * One QueryClient for the whole app. `staleTime` is short because this data is
 * genuinely live, `refetchOnWindowFocus` stays on, since an operator alt-tabbing
 * back wants the current state, not the state from ten minutes ago. Polling is
 * not configured here: pages take it from `useLive()`, so the LIVE toggle in the
 * top bar is the single switch that starts and stops every timer in the tree.
 */
const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

/**
 * Three unauthenticated screens, resolved before any chrome renders:
 *   setup   — only while the instance has no admin (the endpoint 409s after)
 *   invite  — /invite/<token>
 *   login   — everything else without a session
 * The probe is one request; a dashboard that flashes its sidebar before
 * redirecting to sign-in looks broken.
 */
function Gate() {
  const { pathname } = useLocation();
  const status = useQuery({ queryKey: ["auth", "status"], queryFn: auth.status, retry: false });
  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: auth.me,
    enabled: status.data?.setupRequired === false,
    retry: false,
  });

  const refresh = () => {
    void status.refetch();
    void me.refetch();
  };

  if (status.isLoading) return <Booting />;
  if (status.isError) {
    return (
      <Centered>
        <Typography variant="h1" sx={{ mb: 1 }}>
          Collector unreachable
        </Typography>
        <Typography sx={{ color: colors.muted, fontSize: 13, mb: 2 }}>
          {status.error instanceof Error ? status.error.message : "The collector did not answer."}
        </Typography>
        <Typography sx={{ color: colors.faint, fontSize: 12 }}>
          The dashboard could not reach <code>/api/v1/auth/status</code>. Is the server running?
        </Typography>
      </Centered>
    );
  }

  if (status.data?.setupRequired) {
    return (
      <Centered>
        <Setup status={status.data} onDone={refresh} />
      </Centered>
    );
  }

  const inviteToken = inviteTokenFrom(pathname);
  if (inviteToken) {
    return (
      <Centered>
        <Invite token={inviteToken} onDone={refresh} />
      </Centered>
    );
  }

  if (me.isError) {
    // 401 is "sign in"; anything else is a real failure worth showing.
    if (me.error instanceof ApiError && me.error.status === 401) {
      return (
        <Centered>
          <Login onDone={refresh} />
        </Centered>
      );
    }
    return (
      <Centered>
        <Typography variant="h1" sx={{ mb: 1 }}>
          Could not load your session
        </Typography>
        <Typography sx={{ color: colors.muted, fontSize: 13 }}>
          {me.error instanceof Error ? me.error.message : "Unknown error"}
        </Typography>
      </Centered>
    );
  }

  if (me.isLoading || !me.data) return <Booting />;

  return <Shell user={me.data.user} />;
}

/** `/invite/<token>` → token. */
function inviteTokenFrom(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "invite") return undefined;
  return segments[1];
}

function Booting() {
  return (
    <Centered>
      <Skeleton variant="text" width={180} height={30} />
      <Skeleton variant="text" width={260} height={16} />
    </Centered>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ display: "grid", placeItems: "center", minHeight: "100vh", px: 3 }}>
      <Box sx={{ width: "100%", maxWidth: 420 }}>{children}</Box>
    </Box>
  );
}

/**
 * The shell: rail, sidebar, top bar, and a content column that owns the scroll.
 *
 * It resolves the URL into one context object (`ShellState`) that every page
 * reads through `useShell()`/`useLive()`:
 *   `?range=` — the window, default `1h`
 *   `?app=`   — the application filter, absent means all applications
 *   `?search=` — the text search
 * Wall-clock time is *not* in the URL; a range is relative, and a link that says
 * "the last hour" should still mean the last hour tomorrow.
 */
function Shell({ user }: { user: SessionUser }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { pathname, search: locationSearch } = useLocation();
  const queryClient = useQueryClient();

  const storedRange = params.get("range");
  const range: RangeId = isRange(storedRange) ? storedRange : DEFAULT_RANGE;
  const appFilter = params.get("app") ?? "";
  const search = params.get("search") ?? "";

  const [live, setLiveState] = useState<boolean>(() => readFlag("observe.shell.live", true));
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const stored = readFlag("observe.shell.sidebar", null);
    if (stored === null) return window.innerWidth < 900;
    return stored;
  });

  const interval: number | false = live ? 10_000 : false;

  useEffect(() => {
    writeFlag("observe.shell.live", live);
  }, [live]);
  useEffect(() => {
    writeFlag("observe.shell.sidebar", collapsed);
  }, [collapsed]);

  const setLive = (next: boolean) => setLiveState(next);

  const updateParams = (mutate: (next: URLSearchParams) => void) => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        mutate(next);
        return next;
      },
      // Ranges and searches are view settings, not destinations: they replace
      // the current history entry instead of stacking one per click.
      { replace: true },
    );
  };

  const setRange = (value: RangeId) =>
    updateParams((next) => {
      // The default range is the absence of a parameter, so a bare URL and a
      // `/dashboard?range=1h` never mean two different cache entries.
      if (value === DEFAULT_RANGE) next.delete("range");
      else next.set("range", value);
    });

  const apps = useQuery({
    queryKey: ["applications", "switcher"],
    queryFn: () => api.applications(windowFor("24h")),
    staleTime: 30_000,
    refetchInterval: interval,
  });

  const pendingLinks = useQuery({
    queryKey: ["link", "pending"],
    queryFn: api.pendingLinks,
    enabled: user.role === "admin",
    retry: false,
    refetchInterval: interval,
  });

  const applications = useMemo<ShellApplication[]>(
    () => (apps.data ?? []).map((entry) => ({ id: entry.id, name: entry.name, serviceId: entry.serviceId })),
    [apps.data],
  );

  // `:id` wins over `?app=`: being on a page for one application is a stronger
  // statement than a filter that outlived it.
  const segments = pathname.split("/").filter(Boolean);
  const routeAppId = segments[0] === "applications" ? (segments[1] ?? "") : "";
  const appId = routeAppId || appFilter;
  const navAppId = routeAppId || appFilter || applications[0]?.id || "";

  const setAppId = (next: string) => {
    if (routeAppId) {
      // Switching applications while on an application page moves the page, and
      // keeps the tab: /applications/a/errors → /applications/b/errors.
      const rest = segments.slice(2).join("/");
      const query = new URLSearchParams(locationSearch);
      query.delete("app");
      if (next) query.set("app", next);
      const suffix = query.toString();
      const target = next ? `/applications/${next}${rest ? `/${rest}` : ""}` : "/";
      navigate(`${target}${suffix ? `?${suffix}` : ""}`, { replace: true });
      return;
    }
    updateParams((params) => {
      if (next) params.set("app", next);
      else params.delete("app");
    });
  };

  const setSearch = (next: string) =>
    updateParams((params) => {
      if (next) params.set("search", next);
      else params.delete("search");
    });

  const state: ShellState = {
    appId,
    navAppId,
    apps: applications,
    appsLoading: apps.isLoading,
    range,
    setRange,
    setAppId,
    search,
    setSearch,
    live,
    setLive,
    interval,
    collapsed,
    toggleCollapsed: () => setCollapsed((value) => !value),
    navigate: (to: string) => navigate(to),
    refresh: () => {
      void queryClient.invalidateQueries();
    },
    notifications: pendingLinks.data?.items.length ?? 0,
    user,
  };

  const narrow = useMediaQuery(theme.breakpoints.down("md"));

  // `Esc` closes the sidebar when it is a drawer. The search field owns its own
  // Escape handling in the top bar.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && narrow && !collapsed) setCollapsed(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapsed, narrow]);

  return (
    <ShellProvider value={state}>
      <Box sx={{ display: "flex", height: "100vh", overflow: "hidden" }}>
        <NavRail />

        {narrow ? (
          <Drawer
            open={!collapsed}
            onClose={() => setCollapsed(true)}
            variant="temporary"
            ModalProps={{ keepMounted: true }}
            slotProps={{
              paper: { sx: { width: 256, backgroundColor: colors.page, backgroundImage: "none" } },
            }}
          >
            <Sidebar onNavigate={() => setCollapsed(true)} />
          </Drawer>
        ) : collapsed ? null : (
          <Sidebar />
        )}

        <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <TopBar />
          <Box
            component="main"
            id="content"
            sx={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              px: { xs: 2, md: 3 },
              pb: 6,
            }}
          >
            <PageBoundary key={pathname}>
              <Box className="route-in">
                <Routes>
                  <Route path="/" element={<Page page={Overview} />} />
                  <Route path="/applications/:id" element={<Page page={Application} />} />
                  <Route
                    path="/applications/:id/executions"
                    element={<Page page={Executions} />}
                  />
                  <Route path="/executions/:id" element={<Page page={ExecutionDetail} />} />
                  <Route path="/applications/:id/errors" element={<Page page={Errors} />} />
                  <Route path="/applications/:id/logs" element={<Page page={Logs} />} />
                  <Route path="/applications/:id/jobs" element={<Page page={Jobs} />} />
                  <Route path="/applications/:id/metrics" element={<Page page={Metrics} />} />
                  <Route path="/applications/:id/releases" element={<Page page={Releases} />} />
                  <Route path="/applications/:id/users" element={<Page page={Users} />} />
                  <Route path="/applications/:id/runtime" element={<Page page={Runtime} />} />
                  <Route
                    path="/applications/:id/operations/:operationRowId"
                    element={<Page page={Operation} />}
                  />
                  <Route path="/link" element={<Page page={Link} />} />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </Box>
            </PageBoundary>

            <Box
              component="footer"
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 2,
                flexWrap: "wrap",
                mt: 5,
                pt: 2,
                borderTop: `1px solid ${colors.border}`,
                color: colors.faint,
                fontSize: 11,
              }}
            >
              <span>© {new Date().getFullYear()} NestJS Observe — self-hosted</span>
              <Box component="span" sx={{ color: colors.faint }}>
                No pricing, no plans, no quotas
              </Box>
            </Box>
          </Box>
        </Box>
      </Box>
    </ShellProvider>
  );
}

/**
 * The shell owns the URL, so it — not each page — decides what a page is told.
 *
 * A page declares the slice it needs (`{ appId, range }` for most of them, `{ id }`
 * for an execution) and ignores the rest; the boundary is deliberately untyped
 * because the pages are written separately and a page's own prop type must not
 * force a change in the shell's route table.
 */
function Page({ page }: { page: unknown }) {
  const shell = useShell();
  const params = useParams();
  const location = useLocation();
  const query = new URLSearchParams(location.search);

  const props = {
    appId: shell.appId,
    id: params.id ?? shell.appId,
    range: shell.range,
    navigate: shell.navigate,
    search: shell.search,
    operationRowId: params.operationRowId ?? query.get("operationRowId") ?? undefined,
    user: shell.user,
    // Pages written against the pre-MUI hash router read `route`; it costs four
    // lines to keep them working and it goes away with the last of them.
    route: {
      path: location.pathname,
      params: location.pathname.split("/").filter(Boolean),
      query,
    },
  };

  const Component = page as React.ComponentType<Record<string, unknown>>;
  return <Component {...props} />;
}

function NotFound() {
  return (
    <Box sx={{ pt: 6, pb: 4 }}>
      <Typography variant="h1" sx={{ mb: 1 }}>
        Not found
      </Typography>
      <Typography sx={{ color: colors.muted, fontSize: 13, mb: 3 }}>
        There is no page at this address.
      </Typography>
      <Button variant="outlined" onClick={() => window.location.assign("/")}>
        Back to the dashboard
      </Button>
    </Box>
  );
}

/** A crashed page shows what broke, not a white rectangle. */
class PageBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("page crashed", error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <Box sx={{ pt: 4 }}>
        <Typography variant="h2" sx={{ mb: 1 }}>
          This page failed to render
        </Typography>
        <Typography
          component="pre"
          sx={{
            color: colors.danger,
            fontSize: 11,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            mb: 2,
          }}
        >
          {this.state.error.message}
        </Typography>
        <Button variant="outlined" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </Box>
    );
  }
}

function readFlag(key: string, fallback: boolean): boolean;
function readFlag(key: string, fallback: null): boolean | null;
function readFlag(key: string, fallback: boolean | null): boolean | null {
  try {
    const value = localStorage.getItem(key);
    if (value === null) return fallback;
    return value === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // A browser in private mode with storage disabled is not a reason to break
    // the shell; the toggle just will not persist.
  }
}
