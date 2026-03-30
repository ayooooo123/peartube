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

FROM gcr.io/distroless/cc-debian12

ENV PEARTUBE_MODE=public
ENV PEARTUBE_POLICY=discovery
ENV PEARTUBE_STORAGE_PATH=/var/lib/peartube-relay
ENV PEARTUBE_STORAGE_MAX_BYTES=107374182400
ENV PEARTUBE_LOG_LEVEL=info

WORKDIR /var/lib/peartube-relay

COPY --from=artifact /peartube-relay /peartube-relay

VOLUME ["/var/lib/peartube-relay"]

ENTRYPOINT ["/peartube-relay"]
