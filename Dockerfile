# message-cp's HTTP server. Built from this checkout; nothing is published to a registry.
# docker-compose.yml runs it behind Caddy for HTTPS; see "Running with Docker" in the reference, site/src/server.html.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilt binaries for linux-x64 and linux-arm64, so its install script is not needed.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
# The database lives in /data, owned by the image's non-root node user, so openDb can create it there.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
ENV MESSAGE_CP_DB=/data/db.sqlite
VOLUME /data
USER node
EXPOSE 8787
# MESSAGE_CP_HTTP_TOKEN is read at run time; serve refuses to start without it.
CMD ["node", "dist/cli.js", "serve", "--host", "0.0.0.0", "--port", "8787"]
