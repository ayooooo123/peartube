FROM node:22-bookworm-slim
# rocksdb-native (Corestore storage) links libatomic.
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY bin ./bin
ENV PEARTUBE_STORAGE=/data
VOLUME /data
EXPOSE 8174 8175
CMD ["node", "bin/relay.js"]
