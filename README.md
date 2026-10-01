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
| `GET /v1/entries` | Every tracker entry, same shape as search |
| `POST /v1/acquire` `{id, title, source: {url, headers}}` | Fetch a source, store it, announce it |
| `GET /v1/jobs`, `GET /v1/jobs/:jobId`, `DELETE /v1/jobs/:jobId` | Acquire jobs (sources are never returned) |
| `GET /v1/status` | Tracker, writer and blobs keys, stored bytes, peers |

Job status: `queued` → `running` (fetching; `bytes` of `total`) → `announcing` (stored, being published to the tracker) → `done`; or `failed` / `cancelled`. A job is `done` only once its announce is on disk; after a restart, `announcing` jobs re-announce without re-fetching.

Ids look like `imdb:tt0111161` for movies and `imdb:tt0944947:s01e02` for episodes.

## Privacy rule

Replication serves any stored core a peer can name, so the Corestore holds only public data: the tracker and the blobs. Acquire jobs, with their source URLs and headers, live in `jobs.json` in the data directory and are never replicated.

## Android app

`android/` is a small client for one relay: it lists every tracker entry, grouped by title, and plays a tapped one from its `streamUrl` with libVLC, which handles the DivX/Xvid AVIs that Android's own decoders cannot. Set the relay URL from the menu; the default is `http://10.0.40.100:8174`. The phone must reach the relay's API and stream ports, so set `PEARTUBE_STREAM_HOST` to an address the phone can reach. The build makes one APK per ABI (`arm64-v8a`, `armeabi-v7a`, `x86_64`).

```sh
cd android && ./gradlew assembleRelease
```

Release signing reads `peartube.keystore`, `peartube.keystorePassword`, `peartube.keyAlias` and `peartube.keyPassword` from `~/.gradle/gradle.properties`. The app version comes from the root `package.json`.

## Mobile app

`mobile/` is a Dioxus app for Android, iOS and macOS that is a peer itself, not a client of one relay. It runs the same core as a relay (`src/index.js`) inside a Bare worklet from [bare-kit](https://github.com/holepunchto/bare-kit): it joins a tracker, lists its entries grouped by title, and plays a tapped one from the worklet's own blob server on `127.0.0.1`, pulling blocks from whichever peers have them and seeding them afterwards. It only reads: it never publishes or acquires. On Android it plays everything (AVI, MKV, MP4, and the AC-3, E-AC-3, TrueHD and DTS audio the webview cannot decode) through the libVLC bundled in the APK, in the page under the title. On macOS it does the same through the libVLC inside VLC.app, so install [VLC](https://www.videolan.org/vlc/). On iOS its webview plays MP4 and WebM.

On first launch it asks for a tracker key (a relay's `GET /v1/status` shows it), and optionally blind relay keys, a DHT bootstrap list for a private network, and a LAN address. The LAN address is this device's IPv4 (macOS so far): with it, the app finds relays on the local network that run with `PEARTUBE_LAN_HOST` over mDNS, which works where the public DHT cannot connect two randomized NATs. macOS asks once whether the app may accept incoming connections; allow it, or LAN peers cannot connect. Settings live in the app's data directory. Each tracker's Corestore holds only what peers can serve again, so it lives outside backups: `Library/Caches` on iOS and macOS, the no-backup files directory on Android.

Build needs Rust, [dx 0.7.10](https://github.com/DioxusLabs/dioxus/releases/tag/v0.7.10), `npm install` at the repo root, and the Android SDK + NDK or Xcode:

```sh
sh mobile/setup.sh     # once: fetch the bare-kit v2.5.5 prebuilds (420 MB download, cached)
npm run app            # macOS: build and run the desktop app from source
cd mobile && dx build --android --target aarch64-linux-android   # APK under target/dx/PearTube/debug/android
sh mobile/release.sh   # signed arm64 release APK in mobile/target/release-apk
sh mobile/ios.sh       # iOS simulator build, installed and launched on the booted simulator
npm run test:mobile    # E2E on macOS: the worklet joins a testnet relay, streams exact bytes, and sees later publishes and removals live
```

`mobile/build.rs` packs `mobile/worker.js` with bare-pack for the target and links the native addons it needs (sodium, udx, rocksdb, …) with bare-link. dx puts the Android libraries in the APK; `mobile/ios.sh` embeds BareKit and the addon frameworks, which dx leaves out, and re-signs the app.

CI (`.github/workflows/android-app.yml`) builds the arm64 debug APK on every push that touches the app or the core. Download it from the run's `PearTube-debug-arm64` artifact. Releases carry the signed APK from `mobile/release.sh`, which signs with the same key as `android/` (see above). Android will not install it over the debug APK, which has another key: uninstall the debug app first.

## History

The previous platform (apps, channels, HRPC, transcoding, custody proofs) is tagged `archive/v0.3.0-platform`. Restore anything with `git checkout archive/v0.3.0-platform -- <path>`.
