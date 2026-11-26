/**
 * The sidebar's one-selected-row rule.
 *
 * This is a regression test for a real bug: prefix matching highlighted
 * Applications, Requests and Jobs at the same time on `/applications/:id/jobs`.
 */
import { describe, expect, it } from "bun:test";
import { isActive } from "../../public/components/shell/active";

describe("sidebar active row", () => {
  const app = "/applications/01a17218-4252-7358-9937-ca3208482ceb";

  it("selects exactly one application-scoped row", () => {
    expect(isActive(`${app}/jobs`, `${app}/jobs`)).toBe(true);
    expect(isActive(`${app}/jobs`, app)).toBe(false);
    expect(isActive(app, `${app}/jobs`)).toBe(false);
    expect(isActive("/applications", `${app}/jobs`)).toBe(false);
  });

  it("selects the application row only on its own page", () => {
    expect(isActive(app, app)).toBe(true);
    expect(isActive("/applications", "/applications")).toBe(true);
  });

  it("does not let a list page own its children", () => {
    // `/applications` is a page of its own now, not a section header.
    expect(isActive("/applications", app)).toBe(false);
    expect(isActive(`${app}/releases`, `${app}/slos`)).toBe(false);
  });

  it("keeps the dashboard root exact", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/", app)).toBe(false);
  });
});
