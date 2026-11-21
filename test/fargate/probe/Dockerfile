# glibc base: the Holepunch native add-ons (rocksdb-native, udx-native, sodium-native) ship
# linux-x64 and linux-arm64 prebuilds for glibc, not musl.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && node -e 'require("corestore"); require("hyperdht"); require("hyperswarm")'
COPY probe.mjs dht-probe.mjs relayed-peer.mjs ./
CMD ["node", "probe.mjs"]
