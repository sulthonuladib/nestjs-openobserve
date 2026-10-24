import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api";
import { ErrorState, Skeleton } from "./components/ui";
import { useQueryParam, useRoute } from "./router";
import type { TimeRangeId } from "./format";
import { Application } from "./pages/Application";
import { Errors, Logs } from "./pages/Errors";
import { ExecutionDetail, Executions } from "./pages/Executions";
import { Link } from "./pages/Link";
import { Overview } from "./pages/Overview";

/**
 * Shell plus routing.
 *
 * Routes are declared in one switch rather than a route table: six pages, no
 * nested layouts, and the params arrive as an array. The sidebar is the only
 * chrome; everything below is the page's own business.
 */
export function App() {
  const { route, navigate } = useRoute();
  const [range, setRange] = useQueryParam(route, "range", "1h");
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 });

  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("observe.theme") as "dark" | "light") ?? "dark",
  );
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("observe.theme", theme);
  }, [theme]);

  // `/applications/:id/<tab>` keeps the selected app while switching tabs, which
  // is the navigation people actually do.
  const [section, id, tab] = route.params;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-surface-raised">
        <div className="border-b px-4 py-3">
          <a href="#/" className="text-sm font-semibold">
            NestJS <span className="text-accent">Observe</span>
          </a>
          <div className="mt-0.5 text-[11px] text-ink-faint">self-hosted</div>
        </div>

        <nav className="flex-1 p-2 text-sm">
          <NavItem active={route.path === "/"} onClick={() => navigate("/")}>
            Overview
          </NavItem>
          <NavItem
            active={section === "applications" && !tab}
            onClick={() => navigate("/#")}
          >
            Applications
          </NavItem>
          {id && section === "applications" && (
            <div className="mt-1 space-y-0.5 border-l pl-3">
              <NavItem onClick={() => navigate(`/applications/${id}?range=${range}`)} active={!tab}>
                Operations
              </NavItem>
              <NavItem
                onClick={() => navigate(`/applications/${id}/executions?range=${range}`)}
                active={tab === "executions"}
              >
                Executions
              </NavItem>
              <NavItem
                onClick={() => navigate(`/applications/${id}/errors?range=${range}`)}
                active={tab === "errors"}
              >
                Errors
              </NavItem>
              <NavItem
                onClick={() => navigate(`/applications/${id}/logs?range=${range}`)}
                active={tab === "logs"}
              >
                Logs
              </NavItem>
            </div>
          )}
          <div className="mt-3 border-t pt-3">
            <NavItem active={route.path === "/link"} onClick={() => navigate("/link")}>
              Link an app
            </NavItem>
          </div>
        </nav>

        <div className="space-y-1 border-t px-4 py-3 text-[11px] text-ink-faint">
          <div className="flex items-center justify-between">
            <span>database</span>
            <span className={health.data?.database === "up" ? "text-ok" : "text-danger"}>
              {health.data?.database ?? "…"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>ingest</span>
            <span>{health.data?.ingestApi ?? "…"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>batches</span>
            <span className="tabular">{health.data?.stats.batches ?? 0}</span>
          </div>
          <button
            className="mt-1 w-full rounded border py-1 hover:bg-surface-hover"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "Light" : "Dark"} theme
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-6">
        {health.isError && (
          <div className="mb-4">
            <ErrorState error={health.error} />
          </div>
        )}
        <Body
          route={route}
          range={range as TimeRangeId}
          navigate={navigate}
          onRange={setRange}
        />
      </main>
    </div>
  );
}

function Body({
  route,
  range,
  navigate,
}: {
  route: ReturnType<typeof useRoute>["route"];
  range: TimeRangeId;
  navigate: (to: string) => void;
  onRange: (value: string) => void;
}) {
  const [section, first, second] = route.params;
  const operationRowId = route.query.get("operationRowId") ?? undefined;

  if (!section) return <Overview route={route} navigate={navigate} />;
  if (section === "link") return <Link />;

  if (section === "executions") {
    return <ExecutionDetail id={first ?? ""} />;
  }

  if (section === "applications" && first) {
    if (second === "executions")
      return (
        <Executions
          id={first}
          range={range}
          operationRowId={operationRowId}
          navigate={navigate}
        />
      );
    if (second === "errors")
      return <Errors id={first} range={range} navigate={navigate} />;
    if (second === "logs") return <Logs id={first} range={range} />;
    return <Application id={first} range={range} navigate={navigate} />;
  }

  return (
    <div className="space-y-3">
      <h1 className="text-lg font-medium">Not found</h1>
      <p className="text-sm text-ink-muted">
        No route at <code className="font-mono">{route.path}</code>.
      </p>
      <button
        className="rounded border px-3 py-1.5 text-sm hover:bg-surface-hover"
        onClick={() => navigate("/")}
      >
        Back to overview
      </button>
    </div>
  );
}

function NavItem({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`block w-full rounded px-2 py-1.5 text-left ${
        active ? "bg-surface-hover text-ink" : "text-ink-muted hover:bg-surface-hover"
      }`}
    >
      {children}
    </button>
  );
}

export { Skeleton };
