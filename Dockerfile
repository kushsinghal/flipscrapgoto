# Build stage: install with the committed bun.lock and build the Nitro server bundle.
FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .
ENV NITRO_PRESET=node-server
RUN bun run build

# Runtime stage: Node runs the built server; Chromium is installed for FETCH_MODE=browser.
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=10000 \
    FETCH_MODE=http \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output
COPY scripts ./scripts
RUN ./node_modules/.bin/playwright-core install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /ms-playwright
USER node
EXPOSE 10000
CMD ["node", "scripts/start.mjs"]
