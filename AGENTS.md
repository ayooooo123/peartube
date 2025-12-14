# PearTube Development Guide

This document provides everything needed to understand and develop the PearTube project - a decentralized P2P video streaming platform built on Pear Runtime and Hypercore Protocol.

## Table of Contents

- [Project Overview](#project-overview)
- [Monorepo Structure](#monorepo-structure)
- [Packages](#packages)
- [App Package (Mobile + Desktop)](#app-package)
- [Backend Package](#backend-package)
- [Platform Package](#platform-package)
- [Hypercore Protocol Stack](#hypercore-protocol-stack)
- [Build System](#build-system)
- [Development Workflow](#development-workflow)
- [Design System](#design-system)
- [Troubleshooting](#troubleshooting)
- [Helpful Links](#helpful-links)

---

## Project Overview

**PearTube** is a decentralized P2P video streaming platform that enables users to create channels, upload videos, and watch content in a serverless, censorship-resistant environment.

**Key Technologies:**
- **Pear Runtime** - Desktop app platform (Electron-based with Bare JS runtime)
- **Hypercore Protocol** - P2P data replication and storage
- **Expo + React Native** - Cross-platform mobile app
- **React 19** - UI framework
- **TypeScript** - Type-safe development

---

## Monorepo Structure

```
peartube/
├── packages/
│   ├── app/              # Main app (Expo mobile + Pear desktop)
│   ├── backend/          # P2P backend logic (Hypercore, Hyperdrive, etc.)
│   ├── core/             # Shared UI components, hooks, types, stores
│   ├── platform/         # Platform abstraction (RPC, detection, storage)
│   └── spec/             # HRPC schema and generated code
├── package.json          # Root scripts
└── pnpm-workspace.yaml   # Workspace configuration
```

### Package Dependencies

```
@peartube/app
  └── @peartube/core
      └── @peartube/platform
          └── @peartube/spec
  └── @peartube/backend (via bundle)
```

---

## Packages

### `@peartube/app` - Main Application

**Location:** `packages/app/`

The unified app package that builds for both mobile (iOS/Android via Expo) and desktop (Pear Runtime).

```
packages/app/
├── app/                        # Expo Router (file-based routing)
│   ├── _layout.tsx             # Root layout + backend init
│   └── (tabs)/                 # Tab navigation
│       ├── index.tsx           # Home
│       ├── subscriptions.tsx   # Subscriptions
│       ├── studio.tsx          # Studio/Upload
│       └── settings.tsx        # Settings
├── backend/
│   └── index.mjs               # P2P backend entry (bundled for mobile)
├── components/
│   ├── VideoPlayerOverlay.tsx  # Global video player overlay
│   ├── video/                  # Video components
│   ├── ui/                     # Gluestack UI components
│   └── desktop/                # Desktop-specific components
├── lib/
│   ├── VideoPlayerContext.tsx  # Global video state
│   ├── PlatformProvider.tsx    # Platform detection
│   └── colors.ts               # Design tokens
├── pear/                       # Built Pear desktop app
├── pear-src/                   # Pear desktop source
│   ├── package.json            # Pear app manifest
│   ├── index.js                # Pear entry point
│   ├── worker-client.js        # Worker IPC client
│   └── workers/core/index.ts   # Pear backend worker
├── Frameworks/                 # iOS XCFrameworks (native addons)
├── backend.bundle.js           # Compiled Bare backend for mobile
├── ios/                        # iOS native project
├── android/                    # Android native project
└── package.json
```

### `@peartube/backend` - P2P Backend

**Location:** `packages/backend/`

Core P2P logic shared between mobile and desktop.

```
packages/backend/
└── src/
    ├── index.js            # Main exports
    ├── orchestrator.js     # Backend orchestration
    ├── storage.js          # Corestore/Hyperdrive management
    ├── swarm.js            # Hyperswarm networking
    ├── public-feed.js      # P2P discovery protocol
    ├── video-stats.js      # Video streaming stats
    ├── seeding.js          # Content seeding
    ├── api.js              # RPC API handlers
    ├── identity.js         # User identity management
    └── upload.js           # Video upload handling
```

### `@peartube/platform` - Platform Abstraction

**Location:** `packages/platform/`

Abstracts platform differences between mobile (Bare Kit) and desktop (Pear).

```
packages/platform/
└── src/
    ├── index.js            # Main exports
    ├── detection.js        # Platform detection
    ├── storage.js          # Platform-specific storage
    ├── rpc.native.ts       # Mobile RPC (Bare Kit IPC)
    └── rpc.web.ts          # Desktop RPC (Pear worker pipe)
```

**Conditional Exports:**
```json
{
  "./rpc": {
    "react-native": "./src/rpc.native.ts",
    "default": "./src/rpc.web.ts"
  }
}
```

### `@peartube/core` - Shared Core

**Location:** `packages/core/`

Shared UI components, hooks, types, and stores.

```
packages/core/
└── src/
    ├── components/         # Shared UI components
    ├── hooks/              # Shared hooks
    ├── types/              # TypeScript types
    ├── utils/              # Utility functions
    └── stores/             # State stores
```

### `@peartube/spec` - HRPC Schema

**Location:** `packages/spec/`

HRPC schema definitions and generated code for RPC communication.

```
packages/spec/
├── schema.cjs              # Schema generator script
└── spec/
    ├── hrpc/
    │   ├── index.js        # HRPC exports
    │   └── messages.js     # Generated message types
    └── schema/
        ├── index.js        # Schema exports
        └── schema.json     # JSON schema
```

---

## App Package

### Key Scripts

```bash
# Mobile Development
npm start              # Start Metro dev server
npm run ios            # Build + run on iOS simulator
npm run android        # Build + run on Android
npm run bundle:backend # Compile Bare backend for mobile

# Desktop Development
npm run pear:dev       # Build + run Pear desktop app
npm run pear:build     # Full Pear build pipeline
npm run pear:stage     # Stage for release
npm run pear:release   # Release to Pear network
```

### Build Pipelines

**Mobile Build:**
```bash
npm run bundle:backend  # bare-pack -> backend.bundle.js
npm run ios             # expo run:ios
```

**Desktop Build (pear:build):**
```bash
npm run pear:export     # expo export --platform web
npm run pear:merge      # Copy web assets to pear/
npm run pear:copy       # Copy pear-src files
npm run pear:install    # npm install in pear/
npm run pear:worker     # Compile worker with SWC
npm run pear:inject     # Inject Pear bar into HTML
```

### Platform-Specific Files

Metro bundler resolves platform-specific extensions:
- `Component.tsx` - Native iOS/Android
- `Component.web.tsx` - Web/Desktop (Pear)
- `Component.ios.tsx` - iOS only
- `Component.android.tsx` - Android only

**Important:** When debugging desktop issues, check for `.web.tsx` versions!

### Pear Configuration

**`pear-src/package.json`:**
```json
{
  "pear": {
    "name": "peartube",
    "type": "desktop",
    "pre": "pear-electron/pre",
    "gui": {
      "width": 1280,
      "height": 800,
      "backgroundColor": "#000000"
    }
  }
}
```

### Worker Architecture

**Desktop (Pear):**
```
React UI <-> Pipe (JSON) <-> Core Worker (pear-src/workers/core/index.ts)
```

**Mobile (Bare Kit):**
```
React Native <-> BareKit.IPC <-> Bare Worklet (backend/index.mjs)
```

---

## Backend Package

### Architecture

The backend orchestrates all P2P functionality:

```typescript
// Main initialization flow
import { createOrchestrator } from '@peartube/backend/orchestrator'

const backend = await createOrchestrator({
  storagePath: '/path/to/storage',
  onReady: (data) => { /* blob server port, etc */ },
  onVideoStats: (stats) => { /* streaming progress */ },
  onError: (err) => { /* handle errors */ }
})
```

### Key Modules

| Module | Purpose |
|--------|---------|
| `orchestrator.js` | Main backend lifecycle management |
| `storage.js` | Corestore, Hyperdrive, Hyperbee setup |
| `swarm.js` | Hyperswarm P2P networking |
| `public-feed.js` | Channel discovery gossip protocol |
| `video-stats.js` | Real-time streaming stats |
| `seeding.js` | Background content seeding |
| `api.js` | RPC request handlers |
| `identity.js` | User keypair management |
| `upload.js` | Video upload + transcoding |

---

## Hypercore Protocol Stack

| Package | Version | Purpose |
|---------|---------|---------|
| `hypercore` | ^10.37.0 | Append-only logs |
| `hyperdrive` | ^13.0.0 | Distributed file storage (videos) |
| `hyperbee` | ^2.26.0 | Key-value metadata database |
| `hyperswarm` | ^4.15.0 | P2P networking and discovery |
| `corestore` | ^7.7.0 | Storage management |
| `hypercore-crypto` | ^3.6.0 | Ed25519 cryptography |
| `hypercore-blob-server` | ^1.12.0 | Video streaming server |

### Data Model

**Per-Channel Hyperdrive:**
```
/videos/{id}.mp4          # Video file
/videos/{id}.json         # Video metadata
/thumbnails/{id}.jpg      # Thumbnail
/channel.json             # Channel metadata
```

### P2P Discovery Protocol

**Topic:** `peartube-public-feed-v1`

**Flow:**
1. Join hardcoded discovery topic via Hyperswarm
2. On peer connect: Exchange known channel keys
3. New channel: Gossip to all connected peers
4. Peers re-gossip to their neighbors

---

## Build System

### Root Scripts

```bash
npm run build           # Build all packages
npm run dev             # Development mode
npm run typecheck       # TypeScript validation
npm run gen:schema      # Regenerate HRPC schema
```

### Package-Specific Scripts

```bash
# In packages/app
npm run bundle:backend  # bare-pack for mobile
npm run pear:dev        # Pear desktop dev

# In packages/spec
npm run gen:schema      # Generate HRPC messages
```

---

## Development Workflow

### Initial Setup

```bash
git clone <repo>
cd peartube
npm install

# Mobile (iOS)
cd packages/app
npm run bundle:backend
npx pod-install
npm run ios

# Desktop (Pear)
npm run pear:dev
```

### Making Changes

**Frontend changes:** Hot reload works automatically

**Backend changes:**
```bash
# Mobile
npm run bundle:backend
npm run ios  # Rebuild required

# Desktop
npm run pear:dev  # Rebuilds worker automatically
```

**Schema changes:**
```bash
cd packages/spec
npm run gen:schema
```

---

## Design System

### Colors

```typescript
const colors = {
  primary: '#9147ff',      // Vibrant purple
  bg: '#0e0e10',           // Almost black
  bgHover: '#1f1f23',      // Card background
  border: '#303035',       // Borders
  text: '#efeff1',         // Primary text
  textMuted: '#7a7a85',    // Secondary text
}
```

### Video Player

The video player uses a global overlay pattern:

```
RootLayout
  └── VideoPlayerProvider (context)
      └── App Content
      └── VideoPlayerOverlay (fixed position, animated)
```

**Key States:**
- `hidden` - No video playing
- `mini` - Mini player at bottom
- `fullscreen` - Full screen portrait
- `landscape` - Landscape fullscreen (mobile only)

**Important Notes:**
- Uses VLC player on mobile for broad codec support
- Animated with react-native-reanimated
- Shared values (`isLandscapeFullscreenShared`) used for smooth transitions

---

## Troubleshooting

### "Cannot find module"

**Cause:** Pear's DependencyStream failing to resolve paths

**Solutions:**
1. Ensure relative paths in HTML (`./_expo/` not `/_expo/`)
2. Remove `type="module"` from script tags
3. Rebuild: `npm run pear:build`

### Worker not responding

**Cause:** Worker crashed or initialization timeout

**Debug:**
1. Check worker console logs
2. Verify worker path in `worker-client.js`
3. Ensure `pear/build/workers/core/index.js` exists

### Desktop changes not working

**Cause:** Editing wrong file - `.web.tsx` version exists

**Solution:**
1. Check for `Component.web.tsx` files
2. Desktop uses web export which loads `.web.tsx` via Metro

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `packages/app/app/_layout.tsx` | Root layout + backend init |
| `packages/app/components/VideoPlayerOverlay.tsx` | Global video player |
| `packages/app/lib/VideoPlayerContext.tsx` | Video player state |
| `packages/app/pear-src/workers/core/index.ts` | Desktop P2P backend |
| `packages/app/backend/index.mjs` | Mobile P2P backend entry |
| `packages/backend/src/orchestrator.js` | Backend orchestration |
| `packages/platform/src/rpc.native.ts` | Mobile RPC |
| `packages/platform/src/rpc.web.ts` | Desktop RPC |
| `packages/spec/spec/hrpc/messages.js` | Generated RPC messages |

---

## Helpful Links

### Pear Runtime & Documentation

| Resource | URL |
|----------|-----|
| **Pear Runtime Docs** | https://docs.pears.com |
| **Pear Runtime GitHub** | https://github.com/holepunchto/pear |

### Bare Runtime

| Resource | URL |
|----------|-----|
| **Bare Runtime** | https://github.com/holepunchto/bare |
| **Bare Kit (React Native)** | https://github.com/holepunchto/bare-kit |
| **Bare Pack (Bundler)** | https://github.com/holepunchto/bare-pack |

### Hypercore Protocol

| Resource | URL |
|----------|-----|
| **Hypercore** | https://github.com/holepunchto/hypercore |
| **Hyperdrive** | https://github.com/holepunchto/hyperdrive |
| **Hyperbee** | https://github.com/holepunchto/hyperbee |
| **Hyperswarm** | https://github.com/holepunchto/hyperswarm |

### Community

| Resource | URL |
|----------|-----|
| **Holepunch Discord** | https://discord.gg/holepunch |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         PearTube                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────┐              ┌──────────────────┐         │
│  │   Desktop App    │              │   Mobile App     │         │
│  │  (Pear Runtime)  │              │ (Expo + Bare Kit)│         │
│  └────────┬─────────┘              └────────┬─────────┘         │
│           │                                  │                   │
│           ▼                                  ▼                   │
│  ┌──────────────────┐              ┌──────────────────┐         │
│  │  @peartube/platform (rpc.web)   │  @peartube/platform (rpc.native)
│  └────────┬─────────┘              └────────┬─────────┘         │
│           │                                  │                   │
│           └──────────────┬───────────────────┘                   │
│                          ▼                                       │
│           ┌──────────────────────────────┐                      │
│           │       @peartube/backend      │                      │
│           │  (orchestrator, storage,     │                      │
│           │   swarm, api, upload, etc)   │                      │
│           └──────────────┬───────────────┘                      │
│                          ▼                                       │
│           ┌──────────────────────────────┐                      │
│           │     Hypercore Protocol       │                      │
│           │  ┌─────────┐ ┌─────────────┐ │                      │
│           │  │Hyperdrive│ │  Hyperbee  │ │                      │
│           │  │ (Files)  │ │ (Metadata) │ │                      │
│           │  └─────────┘ └─────────────┘ │                      │
│           │  ┌─────────────────────────┐ │                      │
│           │  │      Hyperswarm         │ │                      │
│           │  │   (P2P Networking)      │ │                      │
│           │  └─────────────────────────┘ │                      │
│           └──────────────────────────────┘                      │
│                          │                                       │
│                          ▼                                       │
│           ┌──────────────────────────────┐                      │
│           │       Other Peers            │                      │
│           │  (Discovery + Replication)   │                      │
│           └──────────────────────────────┘                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

*Last updated: December 2024*
