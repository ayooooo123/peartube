# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PearTube is a decentralized P2P video streaming platform built on Pear Runtime and Hypercore Protocol. It runs on iOS, Android, and Desktop from a unified codebase.

## Common Commands

```bash
# Install dependencies
npm run install:all

# Mobile development
npm run ios                    # Build + run iOS app
npm run android                # Build + run Android app
npm run bundle:backend         # Bundle mobile BareKit worklet

# Desktop development (Pear)
npm run pear                   # Build and run Pear desktop app
npm run pear:build             # Build Pear desktop only
cd packages/app/pear && pear run --dev .  # Run without rebuilding

# Quality checks
npm run typecheck              # TypeScript validation (runs in packages/platform)
npm run lint                   # ESLint
npm run lint:fix               # Fix linting issues

# Regenerate HRPC schema
cd packages/spec && node schema.cjs
```

## Architecture

### Monorepo Structure

```
packages/
├── app/              # Unified app (iOS, Android, Pear Desktop)
│   ├── app/          # Expo Router screens (tabs/, video/, etc.)
│   ├── backend/      # Mobile BareKit worklet source (index.mjs)
│   ├── components/   # React Native components
│   ├── lib/          # App utilities (VideoPlayerContext, colors, etc.)
│   ├── pear-src/     # Desktop Pear source files
│   └── pear/         # Built Pear output (generated)
├── backend/          # P2P backend business logic (orchestrator, storage, swarm, api)
├── core/             # Shared types and utilities
├── platform/         # Platform abstraction layer (RPC, detection)
├── spec/             # HRPC schema definitions (schema.cjs generates spec/hrpc/)
└── bare-*/           # Native addon packages (bare-mpv, bare-fcast, bare-tls, bare-ffmpeg)
```

### Platform Architecture

**Mobile (iOS/Android):**
- React Native + Expo Router
- BareKit worklet runs P2P backend in native Bare runtime
- HRPC over BareKit IPC (`packages/platform/src/rpc.native.ts`)

**Desktop (Pear):**
- Expo web export served by pear-electron
- pear-run worker for P2P backend
- HRPC over pipe (`packages/platform/src/rpc.web.ts`)

### Key Design Patterns

1. **Platform-specific files**: Metro resolves `.web.tsx` for desktop, `.tsx` for mobile. When debugging desktop issues, check for `.web.tsx` variants.

2. **HRPC RPC**: Type-safe RPC via `@peartube/spec`. Schema defined in `packages/spec/schema.cjs`, generates `spec/hrpc/` and `spec/schema/`.

3. **Hypercore Protocol stack**: Videos stored in Hyperdrive, metadata in Hyperbee, P2P via Hyperswarm. Channels discovered via gossip on topic `peartube-public-feed-v1`.

4. **Video player**: Global overlay pattern with VideoPlayerProvider context. States: hidden, mini, fullscreen, landscape.

### Build Pipelines

**Mobile Backend Bundle:**
```bash
npm run bundle:backend  # bare-pack → backend.bundle.js
```

**Pear Desktop Build (pear:build):**
1. `pear:export` - Expo web export to `.pear-build/`
2. `pear:merge` - Copy to `pear/`
3. `pear:copy` - Copy pear-src files
4. `pear:install` - npm install in pear/
5. `pear:worker` - SWC compile worker
6. `pear:inject` - Inject Pear bar into HTML

## Key Files

| File | Purpose |
|------|---------|
| `packages/app/app/_layout.tsx` | Root layout + backend initialization |
| `packages/app/components/VideoPlayerOverlay.tsx` | Global video player |
| `packages/app/lib/VideoPlayerContext.tsx` | Video player state |
| `packages/app/pear-src/workers/core/index.ts` | Desktop P2P backend worker |
| `packages/app/backend/index.mjs` | Mobile P2P backend entry |
| `packages/backend/src/orchestrator.js` | Backend lifecycle management |
| `packages/backend/src/api.js` | RPC request handlers |
| `packages/platform/src/rpc.native.ts` | Mobile RPC (BareKit IPC) |
| `packages/platform/src/rpc.web.ts` | Desktop RPC (Pear pipe) |
| `packages/spec/schema.cjs` | HRPC schema definition |

## Dependencies

This project uses the Holepunch stack:
- **hypercore** - Append-only logs
- **hyperdrive** - Distributed file storage for videos
- **hyperbee** - Key-value metadata database
- **hyperswarm** - P2P networking and discovery
- **corestore** - Storage management

Mobile uses **react-native-bare-kit** for running native P2P code. Desktop uses **Pear Runtime** (pear-electron + pear-run).

## Troubleshooting

**iOS Pod Install Fails:**
```bash
cd packages/app/ios && rm -rf Pods Podfile.lock && pod install --repo-update
```

**Desktop changes not working:** Check for `.web.tsx` file variants that override the base component.

**Backend not connecting:** Ensure `packages/app/backend.bundle.js` exists. Rebuild with `npm run bundle:backend`.

**"Cannot find module" in Pear:** Ensure relative paths in HTML (`./_expo/` not `/_expo/`). Rebuild with `npm run pear:build`.
