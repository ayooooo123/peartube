# PearTube

A decentralized P2P video streaming platform built on Hypercore Protocol. Runs on iOS, Android, and macOS from a unified codebase.

## Features

- **Decentralized** -- No central servers, pure P2P architecture
- **Self-sovereign** -- Creators own their channels via cryptographic keypairs
- **Cross-platform** -- iOS, Android, macOS (Electrobun + experimental native SwiftUI) from shared code
- **Scalable** -- Popular content automatically gets more seeders
- **Efficient** -- Sparse replication, only download chunks you watch
- **Censorship-resistant** -- No single point of control

## Architecture

```
packages/
├── app/                # Unified app (iOS, Android, Electrobun Desktop)
│   ├── app/            # Expo Router screens
│   ├── backend/        # Mobile BareKit worklet
│   ├── components/     # React Native components
│   └── workers/        # Desktop worker (workers/desktop/index.ts)
├── backend/            # P2P backend (storage, API, swarm, orchestrator)
├── desktop-native/     # Experimental native macOS app (SwiftUI + bare-native sidecar)
│   ├── Bridge/         # JS sidecar entry (HRPC over stdin/stdout)
│   ├── Sources/        # Swift app, services, views
│   └── scripts/        # Build tooling (sidecar, addons, prebuilds)
├── host/               # Shared host bootstrap for desktop backends
├── platform/           # Platform abstraction layer (RPC)
├── spec/               # HRPC schema -- single source of truth for JS + Swift
│   ├── schema.cjs      # Schema definition + codegen
│   └── lib/            # Custom Swift codegen (wire-compatible compact-encoding)
└── bare-*/             # Native addon submodules (bare-mpv, bare-ffmpeg, bare-tls)
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Mobile UI | React Native + Expo Router |
| Desktop UI (Electrobun) | Expo web export + Electrobun |
| Desktop UI (native) | SwiftUI (macOS 14+, experimental) |
| Mobile P2P runtime | BareKit worklet |
| Desktop P2P runtime | bare-native sidecar (PearTubeHost.app) |
| RPC | HRPC -- typed binary RPC over compact-encoding |
| Networking | Hyperswarm (P2P discovery + connections) |
| Video storage | Hyperdrive (distributed filesystem) |
| Metadata | Hyperbee (key-value database) |
| Video playback | AVPlayer, bare-mpv (libmpv), react-native-video |

## Generated RPC surfaces

`packages/spec/schema.cjs` is the source of truth for HRPC. Running `npm run schema` regenerates JS/Swift HRPC output and the tracked app-facing adapter at `packages/spec/spec/hrpc/app-rpc-adapter.mjs`.

The generated app adapter exports:

- `APP_RPC_METADATA`: schema command metadata, app namespaces, platform-only commands, and runtime-only methods.
- `APP_RPC_METHODS`: deterministic namespace → method maps for app client code.
- `createGeneratedAppRpcClient()`: an additive facade builder for future migration away from handwritten RPC declarations.

Platform-only lifecycle/event commands and runtime-only bridge methods are documented in the metadata so drift tests can distinguish intentional exclusions from missing app methods.

Run adapter/drift tests with:

```bash
npm test --prefix packages/spec
```

## Quick Start

### Prerequisites

- Node.js 18+
- For iOS: Xcode 15+, CocoaPods
- For Android: Android Studio, JDK 17
- For Electrobun Desktop: Electrobun CLI
- For Native Desktop (experimental): Xcode 15+, git submodules initialized

### Setup

```bash
# Install all dependencies
npm run install:all

# Initialize submodules (bare-mpv, bare-ffmpeg)
git submodule update --init --recursive
```

### Run

```bash
# iOS
npm run ios

# Android
npm run android

# Electrobun desktop (main)
npm run desktop

# Native macOS desktop (experimental)
npm run desktop:native:build
open packages/desktop-native/build/Build/Products/Debug/PearTubeDesktop.app
```

### Relay container

Run the packaged relay container from the root compose file:

```bash
docker compose -f docker-compose.relay.yml up -d
docker compose -f docker-compose.relay.yml exec relay /peartube-relay status --json
```

The compose uses `ghcr.io/ayooooo123/peartube-relay:latest`, persists relay storage in `peartube-relay-data`, and exposes the archive WebUI at `http://127.0.0.1:8174`.

Archive a video from the container without opening the browser:

```bash
docker compose -f docker-compose.relay.yml exec relay \
  /peartube-relay archive --url https://youtu.be/... --channel-name "Anonymous Archive" --run-now
```

Archived source URLs stay in the local relay job input store. Public job/status output only includes imported metadata, generated video IDs, and channel keys.

### Relay archive mode (YouTube)

Beyond the on-demand archive command, a relay can be configured to continuously poll YouTube channels/playlists and publish new uploads into PearTube channels it owns. `yt-dlp` is bundled in the relay Docker image; for a local install ensure `yt-dlp` is on `PATH`.

Add an `archive` block to the relay config (or set `PEARTUBE_ARCHIVE_*` env vars):

```yaml
archive:
  enabled: true
  poll: 3600              # seconds between polls
  maxItems: 50            # newest videos considered per poll
  maxRetries: 3           # give up on a video after N consecutive failures
  budgetReservePercent: 5 # stop archiving when within N% of storage.maxBytes
  format: "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b"
  tmpPath: /var/lib/peartube-relay/archive-tmp
  sources:
    - url: https://www.youtube.com/@somechannel
      label: Some Channel
    - url: https://www.youtube.com/playlist?list=PLxxxxxxxxxxx
```

Each source maps to a separate PearTube channel whose keypair is deterministic from the relay's persistent identity and the source URL — restarts reopen the same channel, and each archived channel is announced to the public feed and pinned in the relay's cache.

## Development

### Mobile

```bash
npm run ios              # Run iOS app
npm run android          # Run Android app
npm start                # Start Expo dev server
npm run bundle:backend   # Bundle mobile backend worklet
```

### Electrobun Desktop

```bash
npm run desktop          # Build and run Electrobun desktop app
```

### Native macOS Desktop (experimental)

```bash
cd packages/desktop-native

# Full build (sidecar + addons + Xcode)
npm run build

# Rebuild just the JS sidecar (after changing Bridge/*.mjs)
node scripts/build-native-sidecar.mjs

# Rebuild just the Swift app (after changing Sources/*.swift)
xcodebuild -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop \
  -configuration Debug -derivedDataPath build build

# Run
open build/Build/Products/Debug/PearTubeDesktop.app
```

### HRPC Schema Changes

The HRPC schema is defined once in `packages/spec/schema.cjs` and generates both JS and Swift code:

```bash
cd packages/spec && node schema.cjs

# Copy generated Swift into the desktop-native app
cp spec/swift-schema/Sources/Schema.swift \
   ../desktop-native/Sources/Support/GeneratedSchema.swift
cp spec/swift-hrpc/Sources/HRPC.swift \
   ../desktop-native/Sources/Support/GeneratedHRPC.swift

# Then rebuild the sidecar + Xcode app
```

### Quality

```bash
npm run typecheck        # TypeScript checks
npm run lint             # ESLint
npm run lint:fix         # Fix linting issues
```

## How It Works

### Platform Architecture

| Platform | UI | P2P Backend | RPC Transport |
|----------|-----|-------------|---------------|
| iOS/Android | React Native | BareKit worklet | HRPC over BareKit IPC |
| Electrobun Desktop | Expo web export | Electrobun worker | HRPC over pipe |
| Native macOS (experimental) | SwiftUI | bare-native sidecar | HRPC over stdin/stdout |

All platforms share:
- The same backend business logic (`@peartube/backend`)
- The same HRPC schema (`@peartube/spec`)
- The same Hypercore Protocol stack

### Video Storage & Streaming
- Each channel has a **Hyperdrive** for storing video files
- Videos stored as MP4/MKV/WebM with thumbnail images
- **Sparse replication** -- only download chunks you watch
- **Streaming playback** -- bare-mpv configured for progressive streaming from peers

### P2P Networking
- **Hyperswarm** manages peer connections via a distributed hash table
- Channels discovered via a shared public feed topic
- Multiple peers can serve the same video simultaneously

### Identity
- Self-sovereign Ed25519 keypairs
- Channels tied to Hyperdrive keys
- Multi-device pairing via invite codes
- Data stored locally (`~/Library/Application Support/PearTubeDesktopNative/` on macOS)

## License

Apache-2.0
