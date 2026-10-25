/**
 * App composition.
 *
 * Two Elysia instances, one process:
 *   - `ingestApp`: internet-facing, no sessions, no cookies, no CORS.
 *   - `apiApp`:    the dashboard and its query API, private by default.
 *
 * Modules are factories that return named Elysia instances; Elysia deduplicates
 * by name, so a module that also `.use(es) databasePlugin` gets the shared
 * decoration rather than a second pool.
 */
import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { staticPlugin } from "@elysiajs/static";
import { Elysia, t } from "elysia";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./plugins/config";
import type { Db } from "./plugins/database";
import { adminModule } from "./modules/admin";
import { analyticsModule } from "./modules/analytics";
import { applicationsModule } from "./modules/applications";
import { authModule } from "./modules/auth";
import { errorsModule } from "./modules/errors";
import { executionsModule } from "./modules/executions";
import { healthModule } from "./modules/health";
import { ingestModule } from "./modules/ingest";
import { logsModule } from "./modules/logs";
import { authGuard } from "./plugins/auth";
import { cliLinkModule } from "./modules/link";
import { linkApprovalModule } from "./modules/link/approval";

/**
 * Where the built SPA lives.
 *
 * Three layouts exist and all three must work without a flag:
 *   - repo dev:        apps/server/src/app.ts  -> ../../web/dist
 *   - bundled server:  dist/server/index.js    -> ../../web/dist (tarball root)
 *   - container:       /app/server/index.js    -> /app/web  (OBSERVE_WEB_DIR)
 */
function resolveWebRoot(): string | null {
  const candidates = [
    process.env.OBSERVE_WEB_DIR,
    join(import.meta.dir, "..", "..", "web", "dist"),
    join(import.meta.dir, "..", "..", "web"),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ?? null;
}

export interface Deps {
  readonly config: Config;
  readonly db: Db;
}

export function createIngestApp(deps: Deps) {
  return new Elysia({ name: "ingest-app" })
    .use(ingestModule(deps))
    .use(cliLinkModule(deps));
}

export function createApiApp(deps: Deps) {
  const app = new Elysia({ name: "api-app" })
    .use(cors())
    .use(
      openapi({
        path: "/api/docs",
        documentation: {
          info: {
            title: "NestJS Observe (self-hosted)",
            version: deps.config.version,
            description:
              "Self-hosted collector for @nestjs/observe. No pricing, no plans, " +
              "no quotas, no metering: ingestion is never told to degrade.",
          },
        },
      }),
    )
    // `ingestApp` is mounted too, so a single-port deployment (behind one
    // reverse proxy) needs no path rewriting in the agent's `endpoint`.
    .use(ingestModule(deps))
    .use(cliLinkModule(deps))
    .use(healthModule(deps))
    // Public: /health, ingest, cli-link, and the auth endpoints the login page
    // and the invite page call before there is a session.
    .group("/api/v1", (api) => api.use(authModule(deps)))
    // Everything else requires a session. `/setup` lives inside the auth module
    // and gates itself on "no users exist", which is a stronger check than a
    // role.
    .group("/api/v1", (api) =>
      api.use(authGuard(deps)).guard({ requireUser: true }, (guarded) =>
        guarded
          // The SPA's session probe: who am I, and may I administer the instance.
          .get("/me", ({ user }) => ({ user }), {
            requireUser: true,
            response: {
              200: t.Object({
                user: t.Object({
                  id: t.String(),
                  email: t.String(),
                  name: t.Union([t.String(), t.Null()]),
                  role: t.Union([t.Literal("read"), t.Literal("write"), t.Literal("admin")]),
                }),
              }),
            },
          })
          .use(applicationsModule(deps))
          .use(analyticsModule(deps))
          .use(executionsModule(deps))
          .use(errorsModule(deps))
          .use(logsModule(deps))
          .guard({ requireAdmin: true }, (admin) =>
            admin.use(linkApprovalModule(deps)).use(adminModule(deps)),
          ),
      ),
    );

  // The dashboard SPA, when a build is present. Registered last so API routes
  // and the ingest paths always win over the static handler.
  const webRoot = resolveWebRoot();
  if (webRoot) {
    app.use(staticPlugin({ assets: webRoot, prefix: "/" }));

    /**
     * SPA fallback for path-style deep links.
     *
     * The router is hash-based (`#/link`), but the CLI, a runbook or a bookmark
     * may still say `/dashboard/link`. Without this, the static handler answers
     * 404 for any path that is not a real file — which is how the device-code
     * verification URI ends up broken for the one person who needs it. Anything
     * under `/api`, `/health` or `/assets` keeps its real 404: a misspelled API
     * route must not return HTML.
     */
    app.get(
      "*",
      ({ request, set }) => {
        const { pathname } = new URL(request.url);
        if (
          pathname.startsWith("/api") ||
          pathname.startsWith("/health") ||
          pathname.startsWith("/assets")
        ) {
          set.status = 404;
          return { message: "not found" };
        }
        set.headers["content-type"] = "text/html; charset=utf-8";
        if (pathname.startsWith("/dashboard")) {
          // Rewrite to the hash route so the client router lands on the page the
          // path meant, instead of on the overview.
          const page = pathname.replace(/^\/dashboard\/?/, "") || "";
          set.status = 302;
          set.headers.location = `/${page ? `#/${page}` : "#/"}`;
          return null;
        }
        return Bun.file(`${webRoot}/index.html`);
      },
      { detail: { hide: true } },
    );
  }

  return app;
}

/**
 * The types the dashboard's Eden client consumes.
 *
 * `treaty<ApiApp>()` reads this route map, so a path, query parameter or
 * response field the server does not have is a compile error in `apps/web`.
 * Type-only export: the web build erases it, nothing from the server ships.
 */
export type ApiApp = ReturnType<typeof createApiApp>;
export type IngestApp = ReturnType<typeof createIngestApp>;
