FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g bare@1.28.1

WORKDIR /app

COPY packages/bare-ffmpeg ./packages/bare-ffmpeg
COPY packages/backend ./packages/backend
COPY packages/cli ./packages/cli

RUN npm install --prefix packages/backend --omit=dev --ignore-scripts \
  && npm install --prefix packages/cli --omit=dev --ignore-scripts

RUN mkdir -p /var/lib/peartube-relay

ENV PEARTUBE_MODE=public
ENV PEARTUBE_POLICY=discovery
ENV PEARTUBE_STORAGE_PATH=/var/lib/peartube-relay
ENV PEARTUBE_STORAGE_MAX_BYTES=107374182400
ENV PEARTUBE_LOG_LEVEL=info

VOLUME ["/var/lib/peartube-relay"]

ENTRYPOINT ["bare", "/app/packages/cli/bare-bin.js", "run"]
