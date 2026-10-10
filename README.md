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

## Mobile app

`mobile/` is a Dioxus app for Android, iOS and macOS that is a peer itself, not a client of one relay. It runs the same core as a relay (`src/index.js`) inside a Bare worklet from [bare-kit](https://github.com/holepunchto/bare-kit): it joins a tracker, lists its entries grouped by title, and plays a tapped one from the worklet's own blob server on `127.0.0.1`, pulling blocks from whichever peers have them and seeding them afterwards. It only reads: it never publishes or acquires. Playback uses the Rust player from [peartube-media](https://github.com/ayooooo123/peartube-media), in a native view over the page under the title: platform video decoders (MediaCodec, VideoToolbox) where supported, software decoders otherwise. Full VLC-format compatibility is still in development; decoder registration does not establish correct playback for every file. The mobile E2E covers H.264 video and FLAC audio, comparing decoded frames and samples with FFmpeg. The player buffers before starting and pauses its clock during source stalls.

On first launch it asks for a tracker key (a relay's `GET /v1/status` shows it), and optionally blind relay keys, a DHT bootstrap list for a private network, and whether to find relays on this network. With that on, the app finds relays on the local network that run with `PEARTUBE_LAN_HOST` over mDNS, which works where the public DHT cannot connect two randomized NATs. It uses the device's Wi-Fi or Ethernet address and follows it from network to network. A line under the peer count shows what it is doing: the address it uses, or why it has none. Android drops Wi-Fi multicast unless an app holds a multicast lock, so the app holds one while it is open. macOS asks once whether the app may accept incoming connections; allow it, or LAN peers cannot connect. On iOS, mDNS sockets need Apple's multicast networking entitlement, which the app does not have yet, so it finds nothing there. Settings live in the app's data directory. Each tracker's Corestore holds only what peers can serve again, so it lives outside backups: `Library/Caches` on iOS and macOS, the no-backup files directory on Android.

MIDI playback needs your own SoundFont 2 (`.sf2`, up to 256 MiB). In Settings,
choose a bank with the system document picker. The app copies it into private
storage, outside the replicated Corestore; no bank is bundled or shared.
Choosing or removing a bank takes effect immediately in Settings and applies
to subsequently opened MIDI files. Cancelling or rejecting an import preserves
the previous copy. These actions are independent of the network settings' Save
button.

Text subtitles use runtime platform fonts and fonts attached to the media, not
bundled font files. Select a subtitle track below the picture. ASS/SSA rendering
supports shaping, bidirectional text and style overrides; its libass reference
checks establish bounded pixel agreement, not byte-identical rendering.

Version 0.4.7 integrates the producer-keyed native player lifecycle and fixes
MP4 opening through the worklet's HTTP read-ahead source. Android close and
surface replacement retain the views until native retirement is confirmed;
forced activity destruction reports pending cleanup rather than claiming it
finished. The release keeps the existing `com.peartube.app` package and signing
identity so an in-place upgrade preserves settings and private media data.
Physical-device checks cover hardware H.264, paused backward seek/resume,
background/surface recreation, repeated close/reopen and EOS. These are scoped
lifecycle checks, not full codec compatibility or A/V timing certification.

Version 0.4.8 preserves surround dialogue on Android speakers by explicitly
mixing multichannel PCM to stereo, including the center channel in both outputs.
Mono and stereo stay unchanged. Channel layouts survive decoder output and
audio reopen/trim paths; bounded partial writes preserve sample timing.

Build needs Rust, [dx 0.7.10](https://github.com/DioxusLabs/dioxus/releases/tag/v0.7.10), `npm install` at the repo root, the Android SDK + NDK or Xcode, and for `mobile/setup.sh` cmake 4+, ninja and Node 22.21+ or 24.9+:

```sh
sh mobile/setup.sh     # once: build bare-kit on QuickJS (cached) for Android if the NDK is found and macOS on a Mac, plus bare-kit's iOS prebuild on a Mac
sh mobile/setup.sh darwin   # the same with Xcode alone, no Android SDK
npm run app            # macOS: build and run the desktop app from source
cd mobile && dx build --android --target aarch64-linux-android   # APK under target/dx/PearTube/debug/android
sh mobile/release.sh   # signed arm64 release APK in mobile/target/release-apk
sh mobile/ios.sh       # iOS simulator build, installed and launched on the booted simulator
npm run test:mobile    # E2E on macOS: the worklet finds a relay over a testnet DHT, then over LAN discovery alone; streams exact bytes and sees later publishes and removals live
```

For Android, set `ANDROID_NDK_HOME` to the installed NDK and use JDK 17 for
Gradle. On macOS, `export JAVA_HOME=$(/usr/libexec/java_home -v 17)` selects it;
the current Android Gradle plugin's `jlink` stage fails with JDK 27.

`mobile/build.rs` packs `mobile/worker.js` with bare-pack for the target and links the native addons it needs (sodium, udx, rocksdb, …) with bare-link. dx puts the Android libraries in the APK; `mobile/ios.sh` embeds BareKit and the addon frameworks, which dx leaves out, and re-signs the app.

The Android app link explicitly uses 16 KiB ELF load alignment, including with
NDK r27's 4 KiB default. This is separate from `release.sh`'s APK zip alignment:
both the app library and every packaged native addon must support 16 KiB pages.

On Android and macOS the worklet runs on QuickJS, not V8: `mobile/bare-kit.sh` builds bare-kit with [libqjs](https://github.com/holepunchto/libqjs), Holepunch's QuickJS backend for the same engine ABI, so bare and the addons are unchanged. That makes `libbare-kit.so` 3.9 MB instead of 65.5 MB, and the APK 16.7 MB smaller. iOS still uses bare-kit's V8 prebuild.

CI (`.github/workflows/android-app.yml`) builds the arm64 debug APK on every push that touches the app or the core. Download it from the run's `PearTube-debug-arm64` artifact. Releases carry the signed APK from `mobile/release.sh`, which reads `peartube.keystore`, `peartube.keystorePassword`, `peartube.keyAlias` and `peartube.keyPassword` from `~/.gradle/gradle.properties`. Android will not install it over the debug APK, which has another key: uninstall the debug app first.

## History

The previous platform (apps, channels, HRPC, transcoding, custody proofs) is tagged `archive/v0.3.0-platform`. Restore anything with `git checkout archive/v0.3.0-platform -- <path>`.
