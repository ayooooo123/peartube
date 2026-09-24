# PearTube

A decentralized CDN and debrid provider built on the Holepunch stack.

Relays share one open tracker, an [Autobee](https://github.com/holepunchto/autobee) multi-writer Hyperbee. A relay that has a file posts an entry for it. Any relay can search the tracker and stream any listed file over HTTP Range. Blocks come from whichever peers have them, and the reading relay keeps them and seeds them from then on.

No one grants write access. Each entry is filed under its writer's key, so a relay can only add or remove its own entries. Every relay builds its own view of the tracker by running the same `apply` over everyone's writes; it never adopts a view another peer built.

## Run a relay

```sh
npm install
PEARTUBE_TRACKER=<tracker key> npm start
```

Leave `PEARTUBE_TRACKER` unset to found a new tracker. The relay prints its key.

Open `http://<relay>:8174/` to see acquisitions.

| Variable | Default | Meaning |
|---|---|---|
| `PEARTUBE_TRACKER` | none (found new) | Tracker key to join |
| `PEARTUBE_STORAGE` | `./peartube-data` | Data directory |
| `PEARTUBE_API_PORT` | `8174` | UI and API port |
| `PEARTUBE_STREAM_HOST` | `127.0.0.1` | Host put in stream URLs; set to a LAN address to serve other machines |
| `PEARTUBE_STREAM_PORT` | `8175` | Stream port |
| `PEARTUBE_DHT_PORT` | random | Fixed UDP port, for a port forward |
| `PEARTUBE_RELAY_THROUGH` | none | Comma-separated blind relay keys |
| `PEARTUBE_LAN_HOST` | off | This machine's LAN IPv4; turns on mDNS discovery of relays on the local network |
| `PEARTUBE_LAN_PORT` | `49799` | UDP port of the LAN DHT |

Docker: `docker build -t peartube-relay .` then mount `/data`.

### Reachability

HyperDHT cannot holepunch between two randomized NATs (it aborts the holepunch). Relays on the same network can still find each other: set `PEARTUBE_LAN_HOST` on each, and they discover one another over mDNS and connect directly on `PEARTUBE_LAN_PORT`, with no internet path or port forward. This works across subnets when the router reflects mDNS and routes UDP between them. For relays on different networks, forward a UDP port and set `PEARTUBE_DHT_PORT`, or use a blind relay via `PEARTUBE_RELAY_THROUGH`.

## UI and API

One port serves the acquisitions page at `/` and the `/v1` API. There is no auth for now: run the relay on a trusted network only. Anyone who can reach it can queue a download of any URL.

| Route | Does |
|---|---|
| `GET /` | Acquisitions page |
| `GET /v1/search?id=imdb:tt0944947:s01e02` | Tracker entries for an id, each with a `streamUrl` |
| `POST /v1/acquire` `{id, title, source: {url, headers}}` | Fetch a source, store it, announce it |
| `GET /v1/jobs`, `GET /v1/jobs/:jobId`, `DELETE /v1/jobs/:jobId` | Acquire jobs (sources are never returned) |
| `GET /v1/status` | Tracker, writer and blobs keys, stored bytes, peers |

Job status: `queued` → `running` (fetching; `bytes` of `total`) → `announcing` (stored, being published to the tracker) → `done`; or `failed` / `cancelled`. A job is `done` only once its announce is on disk; after a restart, `announcing` jobs re-announce without re-fetching.

Ids look like `imdb:tt0111161` for movies and `imdb:tt0944947:s01e02` for episodes.

## Privacy rule

Replication serves any stored core a peer can name, so the Corestore holds only public data: the tracker and the blobs. Acquire jobs, with their source URLs and headers, live in `jobs.json` in the data directory and are never replicated.

## History

The previous platform (apps, channels, HRPC, transcoding, custody proofs) is tagged `archive/v0.3.0-platform`. Restore anything with `git checkout archive/v0.3.0-platform -- <path>`.
