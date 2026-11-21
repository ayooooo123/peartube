# Stock blind-relay-service on a glibc Node base (its native add-ons ship glibc prebuilds).
# The only additions are `timeout` for the task deadline and `tee` so the probe can read the key.
FROM node:22-bookworm-slim
WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund blind-relay-service@2.2.2 \
 && node -e 'require("corestore"); require("hyperdht"); require("blind-relay")' \
 && mkdir -p /data /shared
CMD ["sh", "-c", "set -- --storage /data --port 49737; if [ -n \"$SCRAPER_PUB\" ]; then set -- \"$@\" --scraper-public-key \"$SCRAPER_PUB\"; fi; if [ -n \"$SCRAPER_SECRET\" ]; then set -- \"$@\" --scraper-secret \"$SCRAPER_SECRET\"; fi; timeout \"${BR_TIMEOUT_SEC:-3600}\" node /app/node_modules/blind-relay-service/bin.mjs \"$@\" 2>&1 | tee /shared/relay.log"]
