# Self-hosted NestJS Observe — runtime image.
#
# Two stages only: the build needs the whole workspace, the runtime needs one
# bundled entry point, the SPA and the migrations. `repos/` never enters the
# context (.dockerignore), so the vendored SDK cannot end up in a layer.
#
# Same image serves both listeners: 4319 ingest (internet-facing), 4320
# dashboard. In a single-port deployment set OBSERVE_SINGLE_PORT=1 and expose
# only 4320.

FROM oven/bun:1.4.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY . .
RUN bun run build:web \
 && bun build apps/server/src/index.ts --target=bun --outdir=dist/server

FROM oven/bun:1.4.3-alpine AS runtime
WORKDIR /app

# The bundled server, the built SPA and the generated migrations — nothing else.
COPY --from=build /app/dist/server ./server
COPY --from=build /app/apps/web/dist ./web
COPY --from=build /app/apps/server/drizzle ./drizzle
COPY --from=build /app/.env.example ./.env.example

LABEL org.opencontainers.image.title="NestJS Observe (self-hosted)" \
      org.opencontainers.image.description="Self-hosted collector and dashboard for the @nestjs/observe SDK. No pricing, no quotas, no metering." \
      org.opencontainers.image.source="https://github.com/${GITHUB_REPOSITORY}" \
      org.opencontainers.image.licenses="MIT"

ENV OBSERVE_WEB_DIR=/app/web \
    OBSERVE_MIGRATIONS_DIR=/app/drizzle \
    OBSERVE_HOST=0.0.0.0 \
    OBSERVE_INGEST_PORT=4319 \
    OBSERVE_API_PORT=4320 \
    OBSERVE_RUN_MIGRATIONS=1

# `bun` is the image's unprivileged user; the server owns no files.
USER bun

EXPOSE 4319 4320

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.OBSERVE_API_PORT??4320)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["bun", "/app/server/index.js"]
