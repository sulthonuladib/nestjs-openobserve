import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * A very small hash router.
 *
 * TanStack Router is in package.json, but this app has six routes and no nested
 * layouts, so a 60-line router is less machinery than a router library plus its
 * codegen. The contract is the one that matters: **the URL is the state** —
 * time range, filters and the selected execution all live in the query string,
 * so a view can be pasted into a chat.
 */
export interface Route {
  path: string;
  params: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [pathname, search] = raw.split("?");
  const segments = (pathname ?? "/").split("/").filter(Boolean);
  return {
    path: `/${segments.join("/")}`,
    params: segments,
    query: new URLSearchParams(search ?? ""),
  };
}

export function useRoute() {
  const [route, setRoute] = useState<Route>(parse);

  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener("hashchange", onChange);
    if (!window.location.hash) window.location.hash = "#/";
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((to: string) => {
    window.location.hash = `#${to.startsWith("/") ? to : `/${to}`}`;
  }, []);

  return { route, navigate };
}

/** Reads one query parameter, with a default. */
export function useQueryParam(
  route: Route,
  key: string,
  fallback: string,
): [string, (value: string) => void] {
  const value = route.query.get(key) ?? fallback;
  const set = useCallback(
    (next: string) => {
      const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
      if (next === "" || next === fallback) params.delete(key);
      else params.set(key, next);
      const base = route.path;
      const query = params.toString();
      window.location.hash = `#${base}${query ? `?${query}` : ""}`;
    },
    [fallback, key, route.path],
  );
  return [value, set];
}

/** `j`/`k`/`/`/`Escape`, the three shortcuts an operator actually uses. */
export function useKeymap(handlers: {
  onDown?: () => void;
  onUp?: () => void;
  onSearch?: () => void;
  onEscape?: () => void;
}) {
  const stable = useMemo(() => handlers, [handlers.onDown, handlers.onUp, handlers.onSearch, handlers.onEscape]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (event.key === "Escape") {
        stable.onEscape?.();
        return;
      }
      if (typing) return;
      if (event.key === "/") {
        event.preventDefault();
        stable.onSearch?.();
      }
      if (event.key === "j") stable.onDown?.();
      if (event.key === "k") stable.onUp?.();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [stable]);
}
