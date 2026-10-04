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
|`src/lan.js`|Optional LAN discovery: `@p2plabs/hyperdht-mdns` with an adapter that dials each peer's advertised address, not the mDNS reflector. `bin/relay.js` passes it to `createNode` as a factory. For the app, `lanAddress` picks the device's Wi-Fi or Ethernet IPv4 and `interfaceAdapter` keeps mDNS on that interface|
|`bin/relay.js`|Relay process, configured by env|
|`android/`|Android client (not part of the core line budget): lists `/v1/entries` from one relay, plays `streamUrl` with libVLC. Kotlin, no AppCompat|
|`mobile/`|Dioxus app for Android, iOS and macOS (not part of the core line budget). It runs the core itself as a peer, in a Bare worklet (bare-kit), and plays stream URLs through libVLC on Android and macOS, in the webview on iOS|
|`mobile/worker.js`|The worklet: newline-delimited JSON over `BareKit.IPC` to `createNode`. LAN discovery follows the device's address: checked on start, on resume and every 10 s, and stopped in the background. `mobile/build.rs` packs it with bare-pack (`mobile/imports.json` maps Node builtins to `bare-*`) and links its native addons with bare-link|
|`mobile/src/vlc.rs`|macOS player: loads libVLC from VLC.app with dlopen and draws the video in a native view that `main.rs` keeps over a slot in the page|
|`mobile/android/MainActivity.kt`|Android player: dx's MainActivity plus libVLC (`libvlc-all`, pinned in `Dioxus.toml`) in a native view kept over a slot in the page, as on macOS. `mobile/src/android_vlc.rs` opens, places and closes it through JNI. It stays in the one activity because the worklet suspends whenever that activity pauses. It also holds the Wi-Fi multicast lock LAN discovery needs while the app is in front (permission in `Dioxus.toml` `[android.raw]`)|
|`mobile/release.sh`|Builds the signed arm64 release APK with `android/`'s release key from `~/.gradle/gradle.properties`|
|`.github/workflows/android-app.yml`|CI: builds the Dioxus app's arm64 debug APK on pushes that touch `mobile/` or the core, and keeps it as the run's artifact|
|`test/network.test.js`|Relays on a local HyperDHT testnet, including adversarial peers|
|`test/lan.test.js`|LAN adapter and error handling in isolation|
|`test/mobile.e2e.js`|The app's worklet, driven from Rust, joins a relay on a testnet, streams exact bytes, sees a later publish and removal without reopening, and still lists the tracker when a peer announces a malformed title. A second run finds the relay over LAN discovery alone, with no DHT reachable. Writes `mobile/target/e2e/result.json` and `lan-result.json`|

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
sh mobile/setup.sh          # once: bare-kit prebuilds into mobile/vendor
npm run app                 # macOS desktop app from source; needs VLC.app to play
npm run test:mobile         # E2E through the worklet on macOS
cd mobile && dx build --android --target aarch64-linux-android
sh mobile/release.sh        # signed arm64 release APK in mobile/target/release-apk
sh mobile/ios.sh            # simulator build, installed on the booted simulator
```

## Troubleshooting

No peers: check both NATs. HyperDHT aborts with `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS` when both sides are randomized; forward a UDP port (`PEARTUBE_DHT_PORT`) or use `PEARTUBE_RELAY_THROUGH`.

Slow first connection on a local testnet: every peer is on 127.0.0.1, which HyperDHT will not holepunch, so two peers connect only once one of them passes dht-rpc's NAT check and reports itself open. That check can take minutes after a failed first try; a fresh testnet usually connects in about 25 seconds, which is why the E2E tests wait up to 60–120 seconds.
