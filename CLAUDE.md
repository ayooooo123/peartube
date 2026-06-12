# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PearTube is a decentralized P2P video streaming platform built on Hypercore Protocol with embedded Pear runtime support on desktop. It runs on iOS, Android, and Desktop from a unified codebase.

## Common Commands

```bash
# Install dependencies
npm run install:all

# Mobile development
npm run ios                    # Build + run iOS app
npm run android                # Build + run Android app
npm run bundle:backend         # Bundle mobile BareKit worklet

# Electrobun desktop (main desktop app)
npm run desktop                # Build and run Electrobun desktop app

# Native macOS desktop (experimental)
npm run desktop:native:build   # Full generate + build (sidecar + Xcode)
cd packages/desktop-native && node scripts/build-native-sidecar.mjs  # Rebuild sidecar only
cd packages/desktop-native && xcodebuild -project PearTubeDesktop.xcodeproj -scheme PearTubeDesktop -configuration Debug -derivedDataPath build build  # Rebuild Xcode only
open packages/desktop-native/build/Build/Products/Debug/PearTubeDesktop.app  # Run

# Regenerate HRPC schema (JS + Swift)
cd packages/spec && node schema.cjs
# Then copy generated Swift into the desktop-native app:
cp packages/spec/spec/swift-schema/Sources/Schema.swift packages/desktop-native/Sources/Support/GeneratedSchema.swift
cp packages/spec/spec/swift-hrpc/Sources/HRPC.swift packages/desktop-native/Sources/Support/GeneratedHRPC.swift
# (schema.cjs post-process already drops `import Schema` and wires the actor
# setDelegate/receive pattern — no manual import fixups needed.)
# Then rebuild sidecar: cd packages/desktop-native && node scripts/build-native-sidecar.mjs

# Quality checks
npm run typecheck              # TypeScript validation (runs in packages/platform)
npm run lint                   # ESLint
npm run lint:fix               # Fix linting issues
```

## Architecture

### Monorepo Structure

```
packages/
├── app/              # Unified app (iOS, Android, Electrobun Desktop)
│   ├── app/          # Expo Router screens (tabs/, video/, etc.)
│   ├── backend/      # Mobile BareKit worklet source (index.mjs)
│   ├── components/   # React Native components
│   ├── lib/          # App utilities (VideoPlayerContext, colors, etc.)
│   └── workers/      # Desktop worker (workers/desktop/index.ts)
├── backend/          # P2P backend business logic (orchestrator, storage, swarm, api)
├── core/             # Shared types and utilities
├── desktop-native/   # Native macOS SwiftUI shell (PearTubeDesktop.app)
│   ├── Bridge/       # JS sidecar entry + RPC bridge (native-host-sidecar.mjs)
│   ├── Sources/      # Swift app, services, views, models, support
│   └── scripts/      # Build scripts (sidecar, worklet, addons, prebuilds)
├── host/             # Shared host bootstrap (startHost, sidecar-entry)
├── platform/         # Platform abstraction layer (RPC, detection)
├── spec/             # HRPC schema definitions + Swift/JS codegen
│   ├── schema.cjs    # Single source of truth — generates everything below
│   ├── lib/          # Custom Swift codegen (wire-compatible with JS compact-encoding)
│   ├── spec/hrpc/    # Generated JS HRPC (index.js, messages.js)
│   ├── spec/schema/  # Generated JS schema encodings
│   ├── spec/swift-hrpc/    # Generated Swift HRPC class
│   └── spec/swift-schema/  # Generated Swift struct/codec definitions
└── bare-*/           # Native addon submodules (bare-ffmpeg, bare-tls)
```

### Platform Architecture

**Mobile (iOS/Android):**
- React Native + Expo Router
- BareKit worklet runs P2P backend in native Bare runtime
- HRPC over BareKit IPC (`packages/platform/src/rpc.native.ts`)

**Desktop (Electrobun — main):**
- Expo web export served by Electrobun
- Bare worker for P2P backend launched through embedded `pear-runtime`
- HRPC over pipe (`packages/platform/src/rpc.web.ts`)

**Desktop (Swift native — experimental):**
- SwiftUI app shell (`packages/desktop-native/`)
- bare-native sidecar process (PearTubeHost.app) runs P2P backend
- HRPC over stdin/stdout pipe between Swift app and JS sidecar
- Swift codegen from shared schema (`spec/schema.cjs` → `GeneratedSchema.swift` + `GeneratedHRPC.swift`)
- Uses `compact-encoding-swift` + custom wire-compatible codegen (NOT `hyperschema-swift` — incompatible format)

### Key Design Patterns

1. **Platform-specific files**: Metro resolves `.web.tsx` for desktop, `.tsx` for mobile. When debugging desktop issues, check for `.web.tsx` variants.

2. **HRPC RPC**: Type-safe RPC via `@peartube/spec`. Schema defined in `packages/spec/schema.cjs`, generates JS (`spec/hrpc/`, `spec/schema/`) and Swift (`spec/swift-hrpc/`, `spec/swift-schema/`) from a single source of truth. The Swift codegen uses a custom wire-compatible generator (`lib/swift-codegen.cjs`) — NOT `hyperschema-swift` (which produces an incompatible binary format).

3. **Hypercore Protocol stack**: Videos stored in Hyperdrive, metadata in Hyperbee, P2P via Hyperswarm. Channels discovered via gossip on topic `peartube-public-feed-v1`.

4. **Video player**: Global overlay pattern with VideoPlayerProvider context. States: hidden, mini, fullscreen, landscape.

### Build Pipelines

**Mobile Backend Bundle:**
```bash
npm run bundle:backend  # bare-pack → backend.bundle.js
```

**Electrobun Desktop Build (desktop:build):**
1. `desktop:export` - Expo web export to `.desktop-export/`
2. `desktop:merge` - Copy to `desktop-build/`
3. `desktop:worker` - SWC compile `workers/desktop/index.ts`

**Native Desktop Build (desktop:native:build):**
1. `ensure:host-sidecar` - Bundle JS sidecar via bare-pack
2. `build:native-sidecar` - Build PearTubeHost.app via bare-build (codesigned)
3. `ensure:host-worklet` - Bundle BareKit worklet
4. `ensure:host-worklet-frameworks` - Link native addon frameworks (deduped by package name)
5. Xcode build → PearTubeDesktop.app

## Key Files

| File | Purpose |
|------|---------|
| `packages/app/app/_layout.tsx` | Root layout + backend initialization |
| `packages/app/components/VideoPlayerOverlay.tsx` | Global video player |
| `packages/app/lib/VideoPlayerContext.tsx` | Video player state |
| `packages/app/workers/desktop/index.ts` | Desktop P2P backend worker (Electrobun) |
| `packages/app/backend/index.mjs` | Mobile P2P backend entry |
| `packages/backend/src/orchestrator.js` | Backend lifecycle management |
| `packages/backend/src/api.js` | RPC request handlers |
| `packages/platform/src/rpc.native.ts` | Mobile RPC (BareKit IPC) |
| `packages/platform/src/rpc.web.ts` | Desktop RPC (Pear pipe) |
| `packages/spec/schema.cjs` | HRPC schema definition (single source of truth for JS + Swift) |
| `packages/spec/lib/swift-codegen.cjs` | Custom Swift codegen (wire-compatible with JS compact-encoding) |
| `packages/desktop-native/Sources/Support/GeneratedSchema.swift` | Generated Swift structs + codecs (do not edit) |
| `packages/desktop-native/Sources/Support/GeneratedHRPC.swift` | Generated Swift HRPC class (do not edit) |
| `packages/desktop-native/Sources/Support/HRPCBridgeAdapter.swift` | RPCDelegate adapter + type conversions + RPCGate |
| `packages/desktop-native/Sources/Services/HostBridgeService.swift` | Main Swift service — orchestrates sidecar, playback, thumbnails |
| `packages/desktop-native/Bridge/native-host-sidecar.mjs` | JS sidecar entry — HRPC handler registration |
| `packages/host/src/start-host.js` | Shared host bootstrap (used by sidecar + embedded BareKit) |

## Dependencies

This project uses the Holepunch stack:
- **hypercore** - Append-only logs
- **hyperdrive** - Distributed file storage for videos
- **hyperbee** - Key-value metadata database
- **hyperswarm** - P2P networking and discovery
- **corestore** - Storage management

Mobile uses **react-native-bare-kit** for running native P2P code. Main desktop uses **Electrobun + embedded `pear-runtime`**; the Swift native shell (SwiftUI + bare-native sidecar) is experimental. Do not add new `pear run` / `global.Pear.run` paths — upstream Pear CLI is removing `pear run`; see `docs/pear-runtime-evolution-readiness.md` for the current boundary.

Native addon submodules:
- **bare-ffmpeg** - FFmpeg decode engine (fork at `ayooooo123/bare-ffmpeg`, git submodule)
- **bare-tls** - TLS support

## Troubleshooting

**iOS Pod Install Fails:**
```bash
cd packages/app/ios && rm -rf Pods Podfile.lock && pod install --repo-update
```

**Desktop changes not working:** Check for `.web.tsx` file variants that override the base component.

**Backend not connecting:** Ensure `packages/app/backend.bundle.js` exists. Rebuild with `npm run bundle:backend`.

**Desktop "No handler registered" errors:** Rebuild and relaunch the Electrobun desktop app (`npm run desktop:build && npm run desktop`). Shared HRPC handlers are wired through `packages/backend/src/backend-entry.js`.

**"Cannot find module" in desktop builds:** Ensure relative paths in HTML (`./_expo/` not `/_expo/`) and verify `packages/app/src/bun/index.ts` resolves the compiled worker under `desktop-build/build/workers/`. Rebuild with `npm run desktop:build`.

**Desktop worker "does not provide an export named 'X'" (e.g. `createUniversalHrpcSurface` from `./universal-core.js`):** The launched `.app` is running a **stale copy** of `@peartube/backend`. The worker (`workers/core/index.mjs`) imports backend source from `Contents/Resources/app/node_modules/@peartube/backend/`, which `desktop:ecopy` only refreshes when you launch via `npm run desktop:start`. Launching the `.app` directly (Finder/`open`/Spotlight) runs whatever was last copied, so a source file that gained a new export after the last copy will be missing it on disk while its importer expects it. Fix: recopy + relaunch with `cd packages/app && npm run desktop:start` (or a full `npm run desktop:dev`). The source `packages/backend/src/universal-core.js` already exports it — this is purely a stale-artifact mismatch, not a code bug.

**Native Desktop "Unsupported native bridge command: N":** The sidecar binary is stale. Rebuild: `cd packages/desktop-native && node scripts/build-native-sidecar.mjs`.

**Native Desktop crashes on video load (doesNotRecognizeSelector in RPC.request):** The `RPCGate` serializes bare-rpc-swift calls because `RPC` is not thread-safe. If you removed or weakened the gate, restore `maxConcurrent: 1`.

**Native Desktop "No stats returned":** The sidecar handler response shape doesn't match the HRPC schema. Check that nested fields are wrapped correctly (e.g., `{ stats: { ... } }` not flat).

**Native Desktop CompactEncoding.DecodingError:** Wire format mismatch between JS and Swift codecs. Ensure `lib/swift-codegen.cjs` is used (NOT `hyperschema-swift`). The `FrameCodec` must use varint length prefix (not uint32). Regenerate with `node schema.cjs`.

**Duplicate addon linking during build:** Normal — `bare-pack` traces the full dependency graph. The `ensure-host-sidecar-frameworks.mjs` script deduplicates by package name.
