# npm installs the dependencies in a throwaway stage; the relay image carries the Bare runtime and no Node.
FROM docker.io/library/node:22-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY worklet/crypto ./worklet/crypto
# Keep only what Bare loads on this platform: the `bare` binary moves out of its npm package, native add-ons keep only
# their linux-<arch> prebuilds, and the `.node` builds for Node go.
RUN npm ci --omit=dev --no-audit --no-fund \
  && PLATFORM=$(basename node_modules/bare-runtime-linux-* | sed 's/^bare-runtime-//') \
  && mv node_modules/bare-runtime-$PLATFORM/bin/bare /bare && chmod +x /bare \
  && rm -rf node_modules/bare-runtime-$PLATFORM node_modules/.bin \
  && find node_modules -type d -name prebuilds -prune -exec sh -c 'for d in "$1"/*; do [ "$(basename "$d")" = "$2" ] || rm -rf "$d"; done' _ {} "$PLATFORM" \; \
  && find node_modules -path '*/prebuilds/*' -name '*.node' -delete \
  && ln -sfn bare-events node_modules/events && ln -sfn bare-dgram node_modules/dgram && ln -sfn bare-os node_modules/os && ln -sfn bare-net node_modules/net && ln -sfn peartube-crypto node_modules/crypto && ln -sfn bare-buffer node_modules/buffer

# The lightest base that runs these binaries: `bare` and the add-ons need only glibc, libm, libstdc++ and libgcc_s,
# which distroless/cc carries with CA certificates and nothing else (no shell, no package manager).
FROM gcr.io/distroless/cc-debian12
COPY --from=deps /bare /usr/local/bin/bare
WORKDIR /app
COPY package.json ./
COPY worklet/crypto ./worklet/crypto
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY bin ./bin
COPY web/assets ./web/assets
# Load every native add-on the relay uses, so a dependency update that needs a library this base lacks (as
# rocksdb-native 3.18 needed libatomic) fails the build instead of the relay's first start.
RUN ["/usr/local/bin/bare", "-e", "import('bare-process/global').then(() => import('./src/index.js')).then(() => import('./src/lan.js')).then(() => import('./src/private-overlay.js')).then(() => console.log('native add-ons load'), err => { console.error(err); Bare.exitCode = 1 })"]
ENV PEARTUBE_STORAGE=/data UV_THREADPOOL_SIZE=16
VOLUME /data
EXPOSE 8174 8175
# Bare is PID 1 and gets SIGTERM itself on `docker stop`; run with `--restart unless-stopped` to come back after a crash.
ENTRYPOINT ["/usr/local/bin/bare", "bin/relay.js"]
