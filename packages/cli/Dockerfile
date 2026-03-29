FROM node:22-bookworm-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY packages/bare-ffmpeg ./packages/bare-ffmpeg
COPY packages/backend ./packages/backend
COPY packages/cli ./packages/cli

RUN npm install --prefix packages/backend --omit=dev --ignore-scripts \
  && npm install --prefix packages/cli --ignore-scripts

ARG TARGETARCH

RUN case "${TARGETARCH}" in \
    amd64) export RELAY_STANDALONE_HOST=linux-x64 ;; \
    arm64) export RELAY_STANDALONE_HOST=linux-arm64 ;; \
    *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && npm run build:standalone --prefix packages/cli \
  && install -Dm755 "packages/cli/dist/standalone/${RELAY_STANDALONE_HOST}/peartube-relay" /out/peartube-relay

FROM gcr.io/distroless/base-debian12

ENV PEARTUBE_MODE=public
ENV PEARTUBE_POLICY=discovery
ENV PEARTUBE_STORAGE_PATH=/var/lib/peartube-relay
ENV PEARTUBE_STORAGE_MAX_BYTES=107374182400
ENV PEARTUBE_LOG_LEVEL=info

WORKDIR /var/lib/peartube-relay

COPY --from=builder /out/peartube-relay /peartube-relay

VOLUME ["/var/lib/peartube-relay"]

ENTRYPOINT ["/peartube-relay"]
