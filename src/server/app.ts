/**
 * App composition.
 *
 * One Elysia instance for everything: ingest, the query API and the dashboard
 * SPA, on one origin. Modules are factories that return named instances;
 * Elysia deduplicates by name, so a module that also `.use(databasePlugin)` gets
 * the shared decoration rather than a second pool.
 *
 * The dashboard is **not** a separate build. `await staticPlugin({ prefix: "/" })`
 * hands `public/` to Bun's Fullstack Dev Server: `public/index.html` is served at
 * `/`, its `index.tsx` and `styles.css` are compiled by Bun itself (React JSX,
 * Tailwind v4 via `bun-plugin-tailwind`) with HMR in `bun --hot`. There is no
 * Vite, no second port and no `dist/web`.
 */
import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { staticPlugin } from "@elysiajs/static";
import { Elysia, t } from "elysia";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./plugins/config";
import type { Db } from "./plugins/database";
import { adminModule } from "./modules/admin";
import { alertsModule } from "./modules/alerts";
import { credentialsModule } from "./modules/admin/credentials";
import { analyticsModule } from "./modules/analytics";
import { applicationsModule } from "./modules/applications";
import { authModule } from "./modules/auth";
import { errorsModule } from "./modules/errors";
import { executionsModule } from "./modules/executions";
import { healthModule } from "./modules/health";
import { ingestModule } from "./modules/ingest";
import { telemetryModule } from "./modules/telemetry";
import { authGuard } from "./plugins/auth";
import { cliLinkModule } from "./modules/link";
import { linkApprovalModule } from "./modules/link/approval";

/**
 * Where the dashboard lives.
 *
 * `public/` is the source in development and the shipped asset directory in
 * production (Bun's fullstack server reads it at runtime, so a compiled binary
 * must have it next to it). The candidates are tried in order:
 *
 *   - `OBSERVE_WEB_DIR`  the container and the tarball set this explicitly
 *   - `./public`         run from the repo root, or the extracted release dir
 *   - `<repo>/public`    `bun --hot src/server/index.ts` from anywhere
 *   - `<binary>/public`  a `bun build --compile` binary and its neighbouring dir
 */
function resolveWebRoot(): string | null {
  const candidates = [
    process.env.OBSERVE_WEB_DIR,
    join(process.cwd(), "public"),
    join(import.meta.dir, "..", "..", "public"),
    join(dirname(process.execPath), "public"),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ?? null;
}

export interface Deps {
  readonly config: Config;
  readonly db: Db;
}

/** The HTML entrypoint Bun's fullstack server turns into routes. */
type HtmlEntry = Awaited<ReturnType<typeof importHtmlEntry>>;
async function importHtmlEntry(webRoot: string) {
  // A dynamic specifier on purpose: `public/` is read from disk at runtime, not
  // embedded at build time. That is what lets one compiled binary ship next to
  // an unpacked `public/` directory.
  const module = (await import(join(webRoot, "index.html"))) as { default: unknown };
  return module.default;
}

/**
 * Async because Bun's Fullstack Dev Server is installed by *awaiting* the static
 * plugin: that call is what wires the HTML/TSX/CSS bundler and the HMR hooks, so
 * it cannot happen after `listen()`.
 */
export async function createApiApp(deps: Deps) {
  const webRoot = resolveWebRoot();

  const app = new Elysia({ name: "api-app" })
    .use(cors())
    .use(
      openapi({
        path: "/api/docs",
        documentation: {
          info: {
            title: "NestJS OpenObserve (self-hosted)",
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
          .use(alertsModule(deps))
          .use(telemetryModule(deps))
          .use(analyticsModule(deps))
          .use(executionsModule(deps))
          .use(errorsModule(deps))
          .guard({ requireAdmin: true }, (admin) =>
            admin
              .use(linkApprovalModule(deps))
              .use(credentialsModule(deps))
              .use(adminModule(deps)),
          ),
      ),
    );

  // The dashboard, when `public/` is present. Registered after the API routes so
  // the ingest paths and `/api` always win over the static handler.
  if (webRoot) {
    // `await` here is the whole Bun Fullstack Dev Server switch: it installs the
    // HTML/TSX/CSS pipeline and the HMR hooks. The plugin serves the plain files
    // in `public/` (`/styles.css`, images, fonts); the HTML shell goes through
    // Bun's route table below, because that is the only place a bundled
    // `HTMLBundle` can be served from.
    app.use(
      await staticPlugin({
        assets: webRoot,
        prefix: "/",
        // The dashboard's source lives in `public/` (it has to: Bun bundles it
        // from the shipped artifact), but it is not a static asset. Only the
        // files the browser actually asks for may be served.
        ignorePatterns: [".DS_Store", ".git", ".env", /\.(ts|tsx)$/],
      }),
    );

    // Importing the HTML entrypoint is what makes Bun bundle `index.tsx` and
    // `styles.css` and rewrite their `<script>`/`<link>` tags into content-hashed
    // routes (with HMR in `bun --hot`).
    const entry: HtmlEntry = await importHtmlEntry(webRoot);

    /**
     * Bun's route table, which is consulted before Elysia's `fetch`.
     *
     * Two reasons this is not left to the static plugin's own HTML import:
     *
     *   1. Elysia's Bun adapter drops its static-route table as soon as an app
     *      registers a macro, and `authGuard` is one. `config.serve.routes` is
     *      merged into `Bun.serve` regardless, so it is the one place the
     *      HTMLBundle reliably reaches Bun's fullstack bundler.
     *   2. A bundled `HTMLBundle` can only be a *route value*: returning it from
     *      a handler is an error, so the SPA fallback cannot live in Elysia.
     *
     * The API and ingest paths are forwarded to Elysia explicitly; everything
     * that is not the dashboard shell falls through to `app.fetch`, where the
     * static files and real 404s live. Exact paths win over wildcards in Bun's
     * router, which is what lets `/applications/telemetry` (ingest, POST) and
     * `/applications/:id` (dashboard, GET) share a prefix.
     */
    const forward = (request: Request) => app.fetch(request);
    const serve = (app.config.serve ??= {});
    serve.routes = {
      // The SDK's paths, verbatim — a browser-style catch-all must never
      // swallow a telemetry batch.
      "/health": forward,
      "/applications/telemetry": forward,
      "/applications/profiles": forward,
      "/cli-link/*": forward,
      "/api/*": forward,
      // A misspelled asset is a 404, not the SPA. Same for /api and /health,
      // which never reach this table because they are forwarded above.
      "/assets/*": () => new Response("not found", { status: 404 }),
      // The dashboard shell for every path the `BrowserRouter` router owns, so a
      // hard navigation or a refresh lands on the page it names. `/setup` and
      // `/login` are state-driven screens rather than routes; they still need the
      // shell to boot.
      //
      // Per-method maps rather than bare bundles: Elysia merges its own route
      // table into this one first, and a bare value is spread away on a key it
      // already owns (`/` exists for the CORS preflight). `{ GET: entry }` merges
      // into that map, so the HTML route survives.
      "/": { GET: entry },
      "/link": { GET: entry },
      "/login": { GET: entry },
      "/setup": { GET: entry },
      "/invite/*": { GET: entry },
      // Exact paths are separate from their wildcards: `/applications` is a page
      // of its own, and `*/` does not match the parent. A missing line here is a
      // 404 on refresh while client-side navigation still works — the most
      // confusing way to break a route.
      "/applications": { GET: entry },
      "/applications/*": { GET: entry },
      "/executions/*": { GET: entry },
      // A trace spans applications, so its page is not under `/applications/*`.
      "/traces/*": { GET: entry },
      // The project-scoped activity pages. Each one is a real page at a real path
      // (the shell's router owns them), so a refresh has to reach the shell.
      "/requests": { GET: entry },
      "/executions": { GET: entry },
      "/spans": { GET: entry },
      "/services": { GET: entry },
      "/map": { GET: entry },
      "/api-keys": { GET: entry },
      "/members": { GET: entry },
      "/settings": { GET: entry },
      "/errors": { GET: entry },
      "/alerts": { GET: entry },
      "/logs": { GET: entry },
      "/jobs": { GET: entry },
      "/metrics": { GET: entry },
      "/releases": { GET: entry },
      "/slos": { GET: entry },
      "/users": { GET: entry },
      "/runtime": { GET: entry },
    } as never;
  }

  return app;
}

/**
 * The types the dashboard's Eden client consumes.
 *
 * `treaty<ApiApp>()` reads this route map, so a path, query parameter or
 * response field the server does not have is a compile error in `public/`.
 * Type-only export: the web bundle erases it, nothing from the server ships.
 */
export type ApiApp = Awaited<ReturnType<typeof createApiApp>>;
