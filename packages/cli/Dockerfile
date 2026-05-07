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
ARG YT_DLP_VERSION=2026.03.17
ARG DENO_VERSION=v2.5.6
ARG FFMPEG_VERSION=release
ARG BGUTIL_POT_PROVIDER_VERSION=0.8.1
ARG RUST_VERSION=1.91.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gcc libatomic1 libc6-dev libssl-dev pkg-config python3 tar xz-utils zlib1g \
  && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
    amd64) YT_DLP_ASSET=yt-dlp_linux ;; \
    arm64) YT_DLP_ASSET=yt-dlp_linux_aarch64 ;; \
    *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/${YT_DLP_ASSET}" \
    -o /usr/local/bin/yt-dlp \
  && chmod 755 /usr/local/bin/yt-dlp \
  && /usr/local/bin/yt-dlp --version

RUN case "${TARGETARCH}" in \
    amd64) RUSTUP_ARCH=x86_64-unknown-linux-gnu ;; \
    arm64) RUSTUP_ARCH=aarch64-unknown-linux-gnu ;; \
    *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && curl -fsSL "https://static.rust-lang.org/rustup/archive/1.28.2/${RUSTUP_ARCH}/rustup-init" \
    -o /tmp/rustup-init \
  && chmod 755 /tmp/rustup-init \
  && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}" \
  && rm -f /tmp/rustup-init

ENV PATH="/root/.cargo/bin:/usr/local/bin:/usr/bin:${PATH}"

RUN cargo install bgutil-ytdlp-pot-provider --version "${BGUTIL_POT_PROVIDER_VERSION}" --locked \
  && cp /root/.cargo/bin/bgutil-pot /usr/local/bin/bgutil-pot \
  && chmod 755 /usr/local/bin/bgutil-pot \
  && /usr/local/bin/bgutil-pot --version

RUN mkdir -p /usr/local/share/yt-dlp-plugins \
  && curl -fsSL "https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/download/v${BGUTIL_POT_PROVIDER_VERSION}/bgutil-ytdlp-pot-provider-rs.zip" \
    -o /tmp/bgutil-ytdlp-pot-provider-rs.zip \
  && python3 -m zipfile -e /tmp/bgutil-ytdlp-pot-provider-rs.zip /usr/local/share/yt-dlp-plugins \
  && rm -f /tmp/bgutil-ytdlp-pot-provider-rs.zip \
  && /usr/local/bin/yt-dlp --plugin-dirs /usr/local/share/yt-dlp-plugins --extractor-args "youtube:player_client=mweb;youtubepot-bgutilcli:cli_path=/usr/local/bin/bgutil-pot" --version

RUN case "${TARGETARCH}" in \
    amd64) DENO_ASSET=deno-x86_64-unknown-linux-gnu.zip ;; \
    arm64) DENO_ASSET=deno-aarch64-unknown-linux-gnu.zip ;; \
    *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && curl -fsSL "https://github.com/denoland/deno/releases/download/${DENO_VERSION}/${DENO_ASSET}" \
    -o /tmp/deno.zip \
  && python3 -m zipfile -e /tmp/deno.zip /usr/local/bin \
  && rm -f /tmp/deno.zip \
  && chmod 755 /usr/local/bin/deno \
  && /usr/local/bin/deno --version

RUN case "${TARGETARCH}" in \
    amd64) FFMPEG_ASSET=ffmpeg-${FFMPEG_VERSION}-amd64-static.tar.xz ;; \
    arm64) FFMPEG_ASSET=ffmpeg-${FFMPEG_VERSION}-arm64-static.tar.xz ;; \
    *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && curl -fsSL "https://johnvansickle.com/ffmpeg/releases/${FFMPEG_ASSET}" \
    -o /tmp/ffmpeg.tar.xz \
  && mkdir -p /tmp/ffmpeg \
  && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg --strip-components=1 \
  && cp /tmp/ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
  && cp /tmp/ffmpeg/ffprobe /usr/local/bin/ffprobe \
  && rm -rf /tmp/ffmpeg /tmp/ffmpeg.tar.xz \
  && chmod 755 /usr/local/bin/ffmpeg /usr/local/bin/ffprobe \
  && /usr/local/bin/ffmpeg -version

RUN mkdir -p /runtime-libs \
  && case "${TARGETARCH}" in \
    amd64) archTriplet=x86_64-linux-gnu; loader=ld-linux-x86-64.so.2; loaderDir=/lib64 ;; \
    arm64) archTriplet=aarch64-linux-gnu; loader=ld-linux-aarch64.so.1; loaderDir=/lib ;; \
    *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && cp /usr/lib/${archTriplet}/libatomic.so.1 /runtime-libs/libatomic.so.1 \
  && cp /lib/${archTriplet}/libz.so.1 /runtime-libs/libz.so.1 \
  && cp /lib/${archTriplet}/libc.so.6 /runtime-libs/libc.so.6 \
  && cp /lib/${archTriplet}/${loader} /runtime-libs/${loader} \
  && test -e /runtime-libs/ld-linux-x86-64.so.2 || cp /runtime-libs/${loader} /runtime-libs/ld-linux-x86-64.so.2 \
  && test -e /runtime-libs/ld-linux-aarch64.so.1 || cp /runtime-libs/${loader} /runtime-libs/ld-linux-aarch64.so.1 \
  && printf '%s' "${loaderDir}" > /runtime-libs/loader-dir \
  && chmod 755 /runtime-libs/libatomic.so.1 /runtime-libs/libz.so.1 /runtime-libs/libc.so.6 /runtime-libs/ld-linux-x86-64.so.2 /runtime-libs/ld-linux-aarch64.so.1

FROM gcr.io/distroless/cc-debian12

ENV PEARTUBE_MODE=public
ENV PEARTUBE_POLICY=discovery
ENV PEARTUBE_STORAGE_PATH=/var/lib/peartube-relay
ENV PEARTUBE_STORAGE_MAX_BYTES=107374182400
ENV PEARTUBE_LOG_LEVEL=info
ENV PEARTUBE_ARCHIVE_YT_DLP_PATH=/usr/local/bin/yt-dlp
ENV PEARTUBE_ARCHIVE_FFMPEG_PATH=/usr/local/bin/ffmpeg
ENV PEARTUBE_ARCHIVE_JS_RUNTIME=deno:/usr/local/bin/deno
ENV PEARTUBE_ARCHIVE_YT_DLP_EXTRA_ARGS="--plugin-dirs /usr/local/share/yt-dlp-plugins --extractor-args youtube:player_client=mweb;youtubepot-bgutilcli:cli_path=/usr/local/bin/bgutil-pot"
ENV PATH="/usr/local/bin:/usr/bin:${PATH}"

WORKDIR /var/lib/peartube-relay

COPY --from=artifact /peartube-relay /peartube-relay
COPY --from=runtime-libs /runtime-libs/libatomic.so.1 /lib/libatomic.so.1
COPY --from=runtime-libs /runtime-libs/libz.so.1 /lib/libz.so.1
COPY --from=runtime-libs /runtime-libs/libc.so.6 /lib/libc.so.6
COPY --from=runtime-libs /runtime-libs/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2
COPY --from=runtime-libs /runtime-libs/ld-linux-aarch64.so.1 /lib/ld-linux-aarch64.so.1
COPY --from=runtime-libs /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp
COPY --from=runtime-libs /usr/local/bin/bgutil-pot /usr/local/bin/bgutil-pot
COPY --from=runtime-libs /usr/local/share/yt-dlp-plugins /usr/local/share/yt-dlp-plugins
COPY --from=runtime-libs /usr/local/bin/deno /usr/local/bin/deno
COPY --from=runtime-libs /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=runtime-libs /usr/local/bin/ffprobe /usr/local/bin/ffprobe

VOLUME ["/var/lib/peartube-relay"]

ENTRYPOINT ["/peartube-relay"]
