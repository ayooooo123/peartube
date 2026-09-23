# PearTube

A decentralized CDN and debrid provider built on the Holepunch stack.

Relays share one open tracker, an [Autobee](https://github.com/holepunchto/autobee) multi-writer Hyperbee. A relay that has a file posts an entry for it. Any relay can search the tracker and stream any listed file over HTTP Range. Blocks come from whichever peers have them, and the reading relay keeps them and seeds them from then on.

No one grants write access. Each entry is filed under its writer's key, so a relay can only add or remove its own entries.

## Run a relay

```sh
npm install
PEARTUBE_SECRET=change-me-to-16-chars PEARTUBE_TRACKER=<tracker key> npm start
```

Leave `PEARTUBE_TRACKER` unset to found a new tracker. The relay prints its key.

| Variable | Default | Meaning |
|---|---|---|
| `PEARTUBE_SECRET` | required | Bearer secret for the API; also derives the stream token |
| `PEARTUBE_TRACKER` | none (found new) | Tracker key to join |
| `PEARTUBE_STORAGE` | `./peartube-data` | Data directory |
| `PEARTUBE_API_PORT` | `8174` | API port |
| `PEARTUBE_STREAM_HOST` | `127.0.0.1` | Host put in stream URLs; set to a LAN address to serve other machines |
| `PEARTUBE_STREAM_PORT` | `8175` | Stream port |
| `PEARTUBE_DHT_PORT` | random | Fixed UDP port, for a port forward |
| `PEARTUBE_RELAY_THROUGH` | none | Comma-separated blind relay keys |

Docker: `docker build -t peartube-relay .` then mount `/data`.

### Reachability

HyperDHT cannot holepunch between two randomized NATs (`HOLEPUNCH_DOUBLE_RANDOMIZED_NATS`). If your relay's NAT is randomized, forward a UDP port and set `PEARTUBE_DHT_PORT`, or use a blind relay via `PEARTUBE_RELAY_THROUGH`.

## API

All routes need `Authorization: Bearer <PEARTUBE_SECRET>`.

| Route | Does |
|---|---|
| `GET /v1/search?id=imdb:tt0944947:s01e02` | Tracker entries for an id, each with a `streamUrl` |
| `POST /v1/acquire` `{id, title, source: {url, headers}}` | Fetch a source, store it, announce it |
| `GET /v1/jobs`, `GET /v1/jobs/:jobId`, `DELETE /v1/jobs/:jobId` | Acquire jobs (sources are never returned) |
| `GET /v1/status` | Tracker, writer and blobs keys, stored bytes, peers |

Ids look like `imdb:tt0111161` for movies and `imdb:tt0944947:s01e02` for episodes.

## Privacy rule

Replication serves any stored core a peer can name, so the Corestore holds only public data: the tracker and the blobs. Acquire jobs, with their source URLs and headers, live in `jobs.json` in the data directory and are never replicated.

## History

The previous platform (apps, channels, HRPC, transcoding, custody proofs) is tagged `archive/v0.3.0-platform`. Restore anything with `git checkout archive/v0.3.0-platform -- <path>`.
