FROM busybox:1.36.1 AS artifact

ARG TARGETARCH

WORKDIR /dist

COPY packages/cli/dist/docker/ /dist/

RUN case "${TARGETARCH}" in \
    amd64) cp /dist/linux-amd64/peartube-relay /peartube-relay ;; \
    arm64) cp /dist/linux-arm64/peartube-relay /peartube-relay ;; \
    *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && chmod 755 /peartube-relay

FROM debian:12-slim AS runtime-libs

ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends libatomic1 \
  && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
    amd64) cp /usr/lib/x86_64-linux-gnu/libatomic.so.1 /libatomic.so.1 ;; \
    arm64) cp /usr/lib/aarch64-linux-gnu/libatomic.so.1 /libatomic.so.1 ;; \
    *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && chmod 755 /libatomic.so.1

FROM gcr.io/distroless/cc-debian12

ENV PEARTUBE_MODE=public
ENV PEARTUBE_POLICY=discovery
ENV PEARTUBE_STORAGE_PATH=/var/lib/peartube-relay
ENV PEARTUBE_STORAGE_MAX_BYTES=107374182400
ENV PEARTUBE_LOG_LEVEL=info

WORKDIR /var/lib/peartube-relay

COPY --from=artifact /peartube-relay /peartube-relay
COPY --from=runtime-libs /libatomic.so.1 /lib/libatomic.so.1

VOLUME ["/var/lib/peartube-relay"]

ENTRYPOINT ["/peartube-relay"]
