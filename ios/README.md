# PearTube for iOS

A native SwiftUI app for iOS 17 and later. It embeds the same QuickJS/Bare P2P worklet as Android and macOS, and links the shared Rust player with its UIKit `AppleBackend`. It is not a relay-only client or a web view.

This is a development target, not a published iOS release. Compilation does not establish feature or codec compatibility; use the verification below and retain its evidence. Android and macOS release artifacts are unchanged.

The iPhone/iPad app is a **cast sender, library, and local player only**. It pairs with and controls dedicated TV receivers; it has no receive-cast screen or incoming-cast playback mode. Receiver functionality belongs to the Android TV app and standalone `PearTubeReceiver`. The shared worklet retains receiver commands for those dedicated clients, not as a mobile-app feature.

The only local playback page is the fullscreen player, in portrait or landscape. Tap the picture to reveal its controls. A single elapsed/total time readout lives inside those controls and disappears with them; there is no separate persistent clock. The overlaid Info button opens a resizable sheet for video details, formats, and episodes; audio, subtitles, and casting are also available from overlay controls. There is no inline player or fullscreen-exit toggle: Back closes playback and returns directly to the library. Nearby TV receivers appear automatically in the Cast chooser; opening the chooser or returning to the foreground refreshes Bonjour discovery without discarding saved pairings.

## Build

On an Apple Silicon Mac, install Xcode with an iOS simulator runtime, XcodeGen, Node 22.21+/24.9+, CMake 4+, Ninja, and Rust with `aarch64-apple-ios` and `aarch64-apple-ios-sim`. The repository's npm dependencies must already be installed. FFmpeg is required for E2E media fixtures.

From the repository root:

```sh
node ios/project.mjs
xcrun simctl list devices available
xcodebuild -project ios/PearTube.xcodeproj -scheme PearTube \
  -destination 'platform=iOS Simulator,id=<simulator-UDID>' \
  -derivedDataPath ios/build/simulator build
```

The preparation phase builds BareKit on QuickJS, packs `worklet/worker.js` for the selected platform, links its native addons, and builds `ios/native` as a Rust static library. The first build downloads pinned native sources. Device and simulator products are separate under `ios/build/`.

`node ios/project.mjs` regenerates the Xcode project from the repository's `package.json` version. Do not put long-lived signing preferences into generated project files. `sync-player.py` includes the iOS manifest when updating the shared player and codec pins.

## Free sideloading

No paid Apple Developer membership, JIT entitlement, multicast entitlement, app extension, or jailbreak is required by this app. A free Apple ID still needs Apple's signing/provisioning process. **Developer Mode and a USB connection alone do not provide a signing profile.**

### From this Mac with Xcode

1. Generate the project, then open `ios/PearTube.xcodeproj`.
2. In Xcode Settings → Accounts, sign in yourself with your free Apple ID if needed.
3. Run the installer below with your free Personal Team's ID and connected iPhone's UDID. Xcode can register the app/device and obtain its development profile using the account already configured on this Mac. Answer account, keychain, trust, and device prompts yourself.
4. If automatic provisioning asks for account access or cannot find the team, select the **PearTube** target → **Signing & Capabilities** → **Automatically manage signing** → your **Personal Team** in Xcode, then run again:

   ```sh
   sh ios/install.sh <Personal-Team-ID> <iPhone-UDID>
   ```

The script requests automatic development provisioning from Apple but never collects Apple ID credentials. It installs and launches the signed app through `devicectl`. If Xcode requires authentication, sign in through Xcode's own UI rather than putting passwords in commands or chat.

An iPhone already paired with this Mac can also be targeted over its trusted local-network development connection; `devicectl` reports this as `transportType: localNetwork`. The same installer can use that connection without a cable. This development pairing is separate from Finder Wi-Fi syncing and AltServer discovery, and does not configure AltStore or automatic refresh. Keep the phone unlocked for interactive UI verification; a successful wireless install does not by itself prove that XCTest automation can initialize.

The bundle identifier is **`com.peartube.app.dev`**, so this development app installs beside an existing `com.peartube.app` installation instead of replacing its data.

### Install an IPA with AltStore Classic or SideStore

```sh
sh ios/package.sh
```

This writes **`ios/build/PearTube-<package-version>-ios-arm64.ipa`**. It is unsigned at the app level; a sideloading tool must sign it with your own account before a physical iPhone can launch it. Embedded native frameworks are included. No simulator binaries belong in the IPA.

To export an existing signed iPhone build without rebuilding it, pass its `.app` path:

```sh
sh ios/package.sh ios/build/physical-e2e/Build/Products/Debug-iphoneos/PearTube.app
```

This verifies the source product, copies it, and removes only the staged app's provisioning profile and app-level signature. The installed app and original build are untouched. The resulting IPA still needs AltStore/SideStore signing; exporting a Debug product does not make it a Release build.

For a straightforward Mac setup, follow [AltStore Classic's official macOS installation guide](https://faq.altstore.io/altstore-classic/how-to-install-altstore-macos), then use **My Apps → +** to select the IPA in Files. AltStore Classic is the worldwide free-account route; AltStore PAL is not the same distribution system. SideStore can also import the IPA once you have completed its own account/pairing setup.

Free-account apps expire after **seven days** and need refreshing. Apple's limit is **three active sideloaded apps**, including the sideloading companion when applicable. Keep AltStore/SideStore refreshed too. See [AltStore's refresh and active-app guidance](https://faq.altstore.io/altstore-classic/your-altstore). The app never stores your Apple ID password.

## Networking, storage, and lifecycle

- Apple Bonjour APIs register/browse exactly `_hyperdht-mdns._udp` and `_peartube-cast._tcp`; the iOS bundle replaces raw-socket Bonjour with `ios/bonjour.cjs` and a native host bridge exposing the worklet's Bonjour interface. This avoids the restricted raw multicast entitlement; the normal **Local Network** permission is still required on an iPhone. [Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy) explains the distinction.
- Swift settings, history, SoundFont, and cast credentials live in private Application Support files. Tracker stores are separate and excluded from backup. The Corestore contains only the public tracker/channel/blob data.
- The app exposes the shared loopback `/v1`, SSE, Stremio, and playlist API. Its actual address is shown in worker diagnostics; it falls back to an ephemeral port if the preferred port is busy.
- iOS controls background execution. Foreground/resume behavior must be verified on-device; this app does not promise unlimited background seeding. A TV receiver is a P2P node, so it can continue independently after handoff.
- Simulator networking shares this Mac's interfaces and ports. The current shared LAN implementation selects its listening port automatically; do not assume fixed sender or relay ports, kill unrelated apps, or change router rules to make tests pass.

## Repeatable verification

```sh
node ios/e2e.mjs --simulator <simulator-UDID>
node ios/e2e.mjs --simulator <simulator-UDID> --lan
node ios/e2e.mjs --device <iPhone-UDID> --team <Personal-Team-ID> --lan
```

The driver creates a real local HyperDHT relay, publishes an H.264/FLAC/SubRip fixture and canonical series entries, starts a uniquely named portable TV receiver, and runs XCTest UI interactions against the actual app. Public-DHT fixtures bind on the Mac's reachable Wi-Fi/Ethernet IPv4, not simulator loopback. It records relay route counters, native-state snapshots, redacted XCTest summaries/logs, selected screenshots, and receiver byte-hash evidence under `ios/build/e2e/`. A test-bundle or UI failure is a failure, not proof of parity. Local testnet connection establishment can take up to a few minutes.

The UI scenarios check fullscreen-only playback in portrait and landscape, the playback clock hiding and reappearing with the controls, opening and dismissing the overlaid Info sheet without leaving playback, a single Back returning to the library, nearby TV discovery without entering an address, and return from casting into the fullscreen player. The cast scenario opens a real `/v1/events` client inside the native test runner while saving network settings, so it also works on a physical iPhone's loopback interface. Node replacement must close that old SSE connection and return to a usable library; attached Cast and event streams must not leave the serialized restart waiting indefinitely.

Test data is isolated with `-peartube-storage <basename>`. Only `-peartube-e2e` enables `Documents/e2e-state.json`; production launches do not continually write it. Snapshots redact pairing credentials and stream/pairing URLs. Relay/receiver stores, the source pairing fixture, raw XCTest bundles, and unfiltered attachments stay in a private OS temporary directory outside the evidence tree. Xcode temporarily copies the fixture into the UI-test bundle; normal cleanup deletes the generated simulator and physical-device UI-test runner products as well as the private temporary directory, leaving the actual app product and IPA untouched. Only explicitly named safe screenshots and proof records are exported; raw recordings and screenshots of pairing-code entry are not evidence artifacts. If a run is forcibly killed, remove its own private temporary directory and generated UI-test runner products before rerunning.

A physical iPhone is additionally required to verify Local Network authorization, discovery of a real peer/TV, six-character/QR pairing, cast handoff and return, camera QR scanning, background/resume, orientation, and player output. If a system or authentication window appears, stop automation and ask the user to answer it. Never mark these device-only checks passed from simulator results.

Feature acceptance also covers source/URI subscription persistence and discovery, filters and series/format choices, watch history/resume, native pause/seek/audio/subtitle controls, cache operations and per-route diagnostics, private routing with actual private peers, and validated SoundFont import/removal. Keep feature-by-feature evidence; the current UI suite alone is not a blanket certification of every feature or codec.
