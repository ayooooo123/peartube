# PearTube Development Guide

PearTube is a decentralized CDN and debrid provider on the Holepunch stack. The core is deliberately small: the Holepunch modules do the heavy work, and PearTube glues them together. Keep it under 1,000 lines.

## Agent Instructions

Builds, installs, and deploy commands may be run when explicitly requested.

## Layout

|File|Purpose|
|---|---|
|`src/index.js`|`createNode`: Corestore, Autobee tracker + `apply`, Hyperblobs, blob server, Hyperswarm, `search` / `put` / `append` / `publish` / `remove`, and `setLan` to swap LAN discovery without restarting the node|
|`src/acquire.js`|Private job queue: fetch a source, `put` it, save the announce, `append` it durably. Stored in `jobs.json`, never in the Corestore|
|`src/http.js`|One port: the UI at `/` and the `/v1` API (no auth for now)|
|`src/ui.js`|The acquisitions page, one HTML string|
|`src/lan.js`|Optional LAN discovery: `@p2plabs/hyperdht-mdns` with an adapter that dials each peer's advertised address, not the mDNS reflector, and starts its mDNS browse over every 10 s, so an answer missed on Wi-Fi is asked for again instead of waiting for another host's query. `bin/relay.js` passes it to `createNode` as a factory. For the app, `lanAddress` picks the device's Wi-Fi or Ethernet IPv4 and `interfaceAdapter` keeps mDNS on that interface|
|`bin/relay.js`|Relay process, configured by env|
|`mobile/`|Dioxus app for Android, iOS and macOS (not part of the core line budget). It runs the core itself as a peer, in a Bare worklet (bare-kit), and plays stream URLs with the Rust player from [peartube-media](https://github.com/ayooooo123/peartube-media): OxideAV, ported software decoders and platform video decoders. Full VLC-format compatibility remains in development; require per-format playback evidence before claiming support|
|`mobile/worker.js`|The worklet: newline-delimited JSON over `BareKit.IPC` to `createNode`. LAN discovery follows the device's address: checked on start, on resume and every 10 s, and stopped in the background. Its state goes out as `lan` in `start` and `status`, and the list shows it under the peer count. `mobile/build.rs` packs it with bare-pack (`mobile/imports.json` maps Node builtins to `bare-*`) and links its native addons with bare-link|
|`mobile/src/player.rs`|The play screen's `VideoPlayer`: opens peartube-media's `Player` on the stream URL, keeps its native picture over a slot in the page, and draws the controls (play/pause, seek, audio and subtitle tracks) in the page. Suspends and resumes with the app|
|`mobile/src/apple_view.rs`|macOS and iOS: a native view inside the webview, kept over the slot, that peartube-media's `AppleBackend` draws into (AVSampleBufferDisplayLayer + audio renderer)|
|`mobile/src/android_player.rs`, `mobile/android/MainActivity.kt`|Android: MainActivity keeps two SurfaceViews (video, subtitles above it) over the slot and hands their surfaces to `AndroidBackend` through JNI (MediaCodec onto the surface, AAudio). They stay in the one activity because the worklet suspends whenever that activity pauses. MainActivity also holds the Wi-Fi multicast lock LAN discovery needs while the app is in front (permission in `Dioxus.toml` `[android.raw]`)|
|`mobile/sync-player.py`|Pins the app to a peartube-media commit: the `player`/`codecs` git rev and a copy of its `[patch.crates-io]` OxideAV pins (Cargo applies patches only from the top-level manifest)|
|`mobile/release.sh`|Builds the signed arm64 release APK with the release key named in `~/.gradle/gradle.properties`|
|`mobile/bare-kit.sh`|Builds bare-kit with QuickJS (libqjs) instead of V8 for Android and macOS, from pinned sources plus `mobile/patches/`, into `mobile/vendor`, cached by its inputs: libbare-kit.so is 3.9 MB instead of 65.5 MB. `mobile/setup.sh` runs it and adds bare-kit's V8 prebuild for iOS|
|`.github/workflows/android-app.yml`|CI: builds the Dioxus app's arm64 debug APK on pushes that touch `mobile/` or the core, and keeps it as the run's artifact|
|`test/network.test.js`|Relays on a local HyperDHT testnet, including adversarial peers|
|`test/lan.test.js`|LAN adapter in isolation: the advertised address wins, a lost mDNS answer is asked for again, and discovery errors are reported, not fatal|
|`test/mobile.e2e.js`|The app's worklet, driven from Rust, joins a relay on a testnet, streams exact bytes, plays the entry through the app's player (every frame and audio sample equal to FFmpeg's decode), sees a later publish and removal without reopening, and still lists the tracker when a peer announces a malformed title. A second run finds the relay over LAN discovery alone, with no DHT reachable. Needs ffmpeg. Writes `mobile/target/e2e/result.json` and `lan-result.json`|

## Rules

- The Corestore holds only public data (tracker + blobs). Replication serves any stored core a peer can name. Secrets, source URLs and headers stay in private files.
- `apply` is the only gate on the tracker. It must stay deterministic: no clock, no randomness, no I/O. A writer may only add or remove entries under its own writer key.
- Keep Autobee `fastForward: false`. Fast-forward adopts a peer's built view without running `apply`, which lets a forging peer plant entries under other writers' keys (covered by a test).
- A tracker write counts only once it is in the local oplog; an unsynced joiner's optimistic write lives in memory until first sync.
- Connect peers with `tracker.replicate(conn)`, not `store.replicate(conn)`; only the former attaches Autobee's wakeup protocol.
- Give Autobee a namespaced store, and have a new tracker's founder append once before relying on others' optimistic writes.
- Pin `autobee` exactly; it is experimental.
- Autobee emits `'update'` only on an interrupt. To hear about view changes, pass `onchange` to `createNode`, which runs from Autobee's `update` handler.
- Don't add a machine API field without updating every client in the same change. MediaStorm is the proof client.
- Prefer deleting code to adding it. Old platform code is at tag `archive/v0.3.0-platform`.
- `src/index.js` also runs under Bare, in the mobile worklet: no Node-only imports there. Map `node:` builtins to `bare-*` in `package.json` `imports`.
- The Android and macOS worklet runs on QuickJS: no `Intl`, and guard V8-only APIs such as `Error.captureStackTrace`. Keep `mobile/patches/libqjs-function-source.patch` until libqjs ends its CommonJS wrapper on a new line; without it the worklet dies loading bonjour-service, which `test/mobile.e2e.js` catches.
- Keep `mobile/patches/libqjs-deferred-release.patch`. QuickJS frees an object as soon as its last reference goes, but addons built for V8 release a reference and then touch memory that object owned (jstl's `js_persistent_t::reset()`). Without the patch, udx-native's DNS lookup crashes the worklet whenever HyperDHT resolves a bootstrap host by name. `test/mobile.e2e.js` names its bootstrap nodes `localhost:<port>` to catch it.
- Keep `Dioxus.toml` `[application] android_min_sdk_version` at `[android] min_sdk`: dx links the native code at the former, and the QuickJS bare-kit calls `timespec_get`, new in API 29.

## Testing

- Never write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
- If you must test a system in isolation, first write down all the ways it could fail, then write the code.

## Commands

```bash
npm install
npm test
npm start

# Mobile app (cargo, dx 0.7.10, Android SDK + NDK or Xcode)
sh mobile/setup.sh          # once: bare-kit on QuickJS into mobile/vendor (cmake 4+, ninja, node 22.21+/24.9+), for Android if the NDK is found and macOS on a Mac
sh mobile/setup.sh darwin   # the same with Xcode alone, no Android SDK
npm run app                 # macOS desktop app from source
npm run test:mobile         # E2E through the worklet on macOS
cd mobile && dx build --android --target aarch64-linux-android
sh mobile/release.sh        # signed arm64 release APK in mobile/target/release-apk (needs JDK 17: Android lint fails on 25)
python3 mobile/sync-player.py  # after pushing peartube-media: pin the app to its HEAD
sh mobile/ios.sh            # simulator build, installed on the booted simulator
```

## Troubleshooting

No peers: check both NATs. HyperDHT aborts with `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS` when both sides are randomized; forward a UDP port (`PEARTUBE_DHT_PORT`) or use `PEARTUBE_RELAY_THROUGH`.

Slow first connection on a local testnet: every peer is on 127.0.0.1, which HyperDHT will not holepunch, so two peers connect only once one of them passes dht-rpc's NAT check and reports itself open. That check can take minutes after a failed first try; a fresh testnet usually connects in about 25 seconds, which is why the E2E tests wait up to 60–120 seconds.
