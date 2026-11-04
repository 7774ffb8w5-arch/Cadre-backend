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
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "node packages/${PKG}/dist/${ENTRY}"]
