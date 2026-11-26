# Self-hosted NestJS Observe — runtime image.
#
# One Bun app, one build: `bun build --compile` produces the collector binary, and
# `public/` is the dashboard it serves at runtime (Bun's Fullstack server reads
# that directory lazily and caches the bundle in memory). There is no Vite stage,
# no `dist/web`, and no second port.
#
# `repos/` never enters the context (.dockerignore), so the vendored SDK cannot
# end up in a layer.

FROM oven/bun:1.4.3-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run compile

FROM oven/bun:1.4.3-alpine AS runtime
WORKDIR /app

# The one executable, the dashboard it serves, and the migrations — nothing else.
COPY --from=build /app/dist/nestjs-openobserve ./nestjs-openobserve
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/.env.example ./.env.example

LABEL org.opencontainers.image.title="NestJS Observe (self-hosted)" \
      org.opencontainers.image.description="Self-hosted collector and dashboard for the @nestjs/observe SDK. No pricing, no quotas, no metering." \
      org.opencontainers.image.source="https://github.com/${GITHUB_REPOSITORY}" \
      org.opencontainers.image.licenses="MIT"

ENV OBSERVE_WEB_DIR=/app/public \
    OBSERVE_MIGRATIONS_DIR=/app/drizzle \
    OBSERVE_HOST=0.0.0.0 \
    OBSERVE_PORT=4320 \
    OBSERVE_RUN_MIGRATIONS=1 \
    # Bun's fullstack server bundles the dashboard on first request and caches
    # it in memory; `production` turns that bundle into a minified, HMR-free one.
    NODE_ENV=production

# `bun` is the image's unprivileged user; the server owns no files.
USER bun

EXPOSE 4320

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.OBSERVE_PORT??4320)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/app/nestjs-openobserve"]
