/**
 * Which sidebar row is the current page.
 *
 * Exact match only. Prefix matching looked helpful — "Requests" and "Jobs" both
 * live under `/applications/:id` — but it lit every ancestor at once: on
 * `/applications/:id/jobs`, Applications (`/applications`), Requests
 * (`/applications/:id`) and Jobs all matched, so three rows looked selected.
 * One page, one selected row.
 */
export function isActive(to: string, pathname: string): boolean {
  return pathname === to;
}
