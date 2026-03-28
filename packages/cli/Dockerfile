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

RUN mkdir -p /etc/peartube-relay /var/lib/peartube-relay

COPY packages/cli/config.example.yml /etc/peartube-relay/config.yml

VOLUME ["/etc/peartube-relay", "/var/lib/peartube-relay"]

ENTRYPOINT ["bare", "/app/packages/cli/bare-bin.js", "run", "--config", "/etc/peartube-relay/config.yml"]
