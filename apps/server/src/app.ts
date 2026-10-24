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
import { Elysia } from "elysia";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./plugins/config";
import type { Db } from "./plugins/database";
import { applicationsModule } from "./modules/applications";
import { errorsModule } from "./modules/errors";
import { executionsModule } from "./modules/executions";
import { healthModule } from "./modules/health";
import { ingestModule } from "./modules/ingest";
import { logsModule } from "./modules/logs";
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
    .group("/api/v1", (api) =>
      api
        .use(applicationsModule(deps))
        .use(executionsModule(deps))
        .use(errorsModule(deps))
        .use(logsModule(deps))
        .use(linkApprovalModule(deps)),
    );

  // The dashboard SPA, when a build is present. Registered last so API routes
  // and the ingest paths always win over the static handler.
  const webRoot = resolveWebRoot();
  if (webRoot) {
    app.use(staticPlugin({ assets: webRoot, prefix: "/" }));
  }

  return app;
}
