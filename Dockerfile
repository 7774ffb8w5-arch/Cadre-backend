# Multi-stage build: compile the TypeScript workspace, then run the chosen package as a non-root user.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev

FROM node:20-alpine
RUN apk add --no-cache tini wget && addgroup -S twenty && adduser -S -G twenty twenty
WORKDIR /app
ARG PKG=api
ARG ENTRY=server.js
ENV PKG=${PKG} ENTRY=${ENTRY} NODE_ENV=production NODE_OPTIONS=--max-old-space-size=384
COPY --from=build --chown=twenty:twenty /app/package.json /app/package-lock.json ./
COPY --from=build --chown=twenty:twenty /app/node_modules ./node_modules
COPY --from=build --chown=twenty:twenty /app/packages ./packages
USER twenty
EXPOSE 8080
# the API answers /ready once it can reach Postgres; the scheduler and the bot have no port, so theirs is a process check
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD if [ "$ENTRY" = server.js ]; then wget -qO- http://127.0.0.1:${PORT:-8080}/ready >/dev/null || exit 1; else pgrep -f "packages/${PKG}/dist/${ENTRY}" >/dev/null || exit 1; fi
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "node packages/${PKG}/dist/${ENTRY}"]
