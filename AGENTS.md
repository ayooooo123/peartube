# PearTube Development Guide

This document provides everything needed to understand and develop the PearTube project - a decentralized P2P video streaming platform built on Pear Runtime and Hypercore Protocol.

## Table of Contents

- [Project Overview](#project-overview)
- [Monorepo Structure](#monorepo-structure)
- [Desktop App](#desktop-app)
- [Mobile App](#mobile-app)
- [Shared Packages](#shared-packages)
- [Hypercore Protocol Stack](#hypercore-protocol-stack)
- [Worker Architecture](#worker-architecture)
- [P2P Discovery Protocol](#p2p-discovery-protocol)
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
├── apps/
│   ├── desktop/          # Pear Runtime desktop app
│   └── mobile/           # Expo/React Native mobile app
├── packages/
│   ├── shared/           # Shared types and constants
│   └── ui/               # Cross-platform UI components
├── pnpm-workspace.yaml   # Workspace configuration
├── package.json          # Root scripts
└── .npmrc                # Critical: hoisting config for Pear
```

### Package Manager Setup

- **Root + Mobile**: Use `pnpm` with hoisted node_modules
- **Desktop**: Uses separate `npm install` for Pear's Bare module resolver

**Critical `.npmrc` settings:**
```ini
shamefully-hoist=true
node-linker=hoisted
public-hoist-pattern[]=*
```

> **Why?** Pear's Bare runtime cannot resolve pnpm symlinks. All dependencies must be hoisted to root node_modules.

---

## Desktop App

**Location:** `apps/desktop/`

**Framework:** Pear Runtime with pear-electron bridge

### Directory Structure

```
apps/desktop/
├── src/
│   ├── App.tsx                 # Main React component
│   ├── index.tsx               # React entry point
│   ├── worker-client.js        # Worker IPC client (no ES imports!)
│   ├── pages/                  # Page components
│   ├── components/             # UI components
│   └── lib/
│       ├── rpc.ts              # RPC client interface
│       └── theme.ts            # Design tokens
├── workers/
│   └── core/
│       ├── index.ts            # P2P backend (TypeScript)
│       └── public-feed.ts      # P2P discovery protocol
├── scripts/
│   └── inject-pear-bar.js      # Post-build HTML injection
├── build/
│   └── workers/core/           # Compiled workers (SWC output)
├── index.html                  # Entry point (from Expo web export)
└── package.json
```

### Key Scripts

```bash
npm run dev        # Build + run with pear
npm run build      # Full build pipeline
npm run preview    # Run without rebuilding
npm run typecheck  # TypeScript validation
```

### Pear Configuration

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
    },
    "stage": {
      "ignore": [".git", "src", "workers", "scripts", "build/src"]
    }
  }
}
```

### Worker Communication

The desktop app uses a **newline-delimited JSON protocol** for renderer-worker IPC:

```
Frontend (React) ←→ Pipe (JSON + newline) ←→ Core Worker (Bare runtime)
```

**Message Format:**
```typescript
// Request
{ id: "1", command: "LIST_VIDEOS", data: { channelKey: "..." } }

// Response
{ id: "1", success: true, data: [...] }
```

### Important: worker-client.js

This file **must not use ES module imports** - Pear's DependencyStream cannot resolve them:

```javascript
// WRONG - will break pear
import path from 'path'

// CORRECT - use globals
const config = Pear.config
this.pipe = Pear.worker.run(workerPath, [])
```

---

## Mobile App

**Location:** `apps/mobile/`

**Framework:** Expo 54 + React Native 0.81 with Bare Kit for P2P

### Directory Structure

```
apps/mobile/
├── app/                        # Expo Router (file-based routing)
│   ├── _layout.tsx             # Root layout + backend init
│   └── (tabs)/                 # Tab navigation
│       ├── index.tsx           # Home
│       ├── subscriptions.tsx
│       ├── studio.tsx
│       └── settings.tsx
├── backend/
│   └── index.mjs               # P2P backend source
├── components/
│   ├── video/                  # Video player components
│   ├── ui/                     # Gluestack UI components
│   └── desktop/                # Desktop-specific (web export)
├── lib/
│   ├── VideoPlayerContext.tsx  # Global video state
│   ├── PlatformProvider.tsx    # Platform detection
│   └── colors.ts               # Design tokens
├── Frameworks/                 # iOS XCFrameworks (native addons)
├── backend.bundle.js           # Compiled Bare backend
├── ios/                        # iOS native project
├── android/                    # Android native project
└── package.json
```

### Platform-Specific Files (.web.tsx)

Metro bundler automatically resolves platform-specific extensions:
- `Component.tsx` - Native iOS/Android
- `Component.web.tsx` - Web/Desktop (used by Pear desktop)
- `Component.ios.tsx` - iOS only
- `Component.android.tsx` - Android only

**Important files with web-specific versions:**
```
app/(tabs)/index.tsx          # Mobile home screen
app/(tabs)/index.web.tsx      # Desktop home screen (different implementation!)

components/video/VideoCard.tsx      # Mobile video card
components/video/VideoCard.web.tsx  # Desktop video card with hover effects

components/desktop/             # Desktop-only components
  DesktopLayout.web.tsx
  DesktopHeader.web.tsx
  DesktopSidebar.web.tsx
```

> **Warning:** When debugging desktop issues, always check for `.web.tsx` versions! Changes to `index.tsx` won't affect desktop if `index.web.tsx` exists.

### Key Scripts

```bash
pnpm start           # Start Metro dev server
pnpm ios             # Build + run on iOS
pnpm android         # Build + run on Android
pnpm web:export      # Export for desktop (Expo web)
pnpm bundle:backend  # Compile Bare backend
```

### Backend Architecture

The mobile backend runs in a **Bare worklet thread** separate from React Native:

```
React Native JS Thread ←→ BareKit.IPC ←→ Bare Worklet Thread
```

**Bundle Command:**
```bash
bare-pack --target ios --target android --linked --out backend.bundle.js backend/index.mjs
```

### Native Modules (iOS)

Pre-built XCFrameworks in `Frameworks/` directory:
- sodium-native
- rocksdb-native
- udx-native
- And others...

Build with: `./scripts/build-addons.sh`

---

## Shared Packages

### `packages/shared/`

Shared types and constants between desktop and mobile.

**Key Types:**
```typescript
interface Identity {
  publicKey: string
  driveKey: string
  name: string
  secretKey?: string
}

interface Video {
  id: string
  title: string
  path: string
  size: number
  channelKey: string
  duration?: number
}

interface Channel {
  driveKey: string
  name: string
  description?: string
  avatar?: string
}
```

**RPC Commands:**
```typescript
export const RPC = {
  GET_STATUS: 1,
  CREATE_IDENTITY: 2,
  GET_IDENTITIES: 3,
  LIST_VIDEOS: 5,
  GET_VIDEO_URL: 6,
  SUBSCRIBE_CHANNEL: 7,
  UPLOAD_VIDEO: 10,
  // ...
}

export const PUBLIC_FEED_TOPIC = 'peartube-public-feed-v1'
```

### `packages/ui/`

Cross-platform UI components with conditional exports:

```typescript
// Exports React components for web, React Native for mobile
export { Button } from './web/Button'     // Desktop
export { Button } from './native/Button'  // Mobile
```

---

## Hypercore Protocol Stack

| Package | Version | Purpose |
|---------|---------|---------|
| `hypercore` | ^10.37.0 | Append-only logs |
| `hyperdrive` | ^13.0.0 | Distributed file storage (videos) |
| `hyperbee` | ^2.26.0 | Key-value metadata database |
| `hyperswarm` | ^4.15.0 | P2P networking and discovery |
| `corestore` | ^6.18.0 | Storage management |
| `hypercore-crypto` | ^3.6.0 | Ed25519 cryptography |
| `hypercore-blob-server` | ^1.12.0 | HLS video streaming |

### Data Model

**Per-Channel Hyperdrive:**
```
/channel.json           # Channel metadata
/videos/{id}/
  ├── manifest.m3u8     # HLS manifest
  ├── segment-0.ts      # Video segments
  ├── segment-1.ts
  └── metadata.json     # Video metadata
```

**Per-Channel Hyperbee:**
```
/channel/info           # Channel details
/videos/{id}/metadata   # Video metadata index
```

---

## Worker Architecture

### Desktop Worker (`workers/core/index.ts`)

**Responsibilities:**
- Initialize Hyperswarm P2P networking
- Manage Hyperdrive channels (create, subscribe, sync)
- Handle RPC calls from frontend
- Stream video via HLS blob server
- Manage user identities and keypairs
- Track video download progress

**Key Components:**
```typescript
const swarm = new Hyperswarm()
const store = new Corestore(storagePath)
const blobServer = new BlobServer(store)
const publicFeed = new PublicFeedManager(swarm)
```

### Mobile Backend (`backend/index.mjs`)

Same responsibilities but uses:
- `bare-rpc` instead of newline-delimited JSON
- `BareKit.IPC` for thread communication
- XCFrameworks for native modules

---

## P2P Discovery Protocol

### Public Feed Manager

Gossip protocol using Protomux over Hyperswarm for channel discovery.

**Topic:** `peartube-public-feed-v1` (hardcoded)

**Flow:**
1. Join hardcoded discovery topic
2. On peer connect: Exchange `HAVE_FEED` (list of known channels)
3. New channel added: Send `SUBMIT_CHANNEL` to all peers
4. Peers re-gossip to their neighbors

**Messages:**
```typescript
{ type: 'HAVE_FEED', keys: ['key1', 'key2', ...] }
{ type: 'SUBMIT_CHANNEL', key: 'newChannelKey' }
```

---

## Build System

### Desktop Build Pipeline

```bash
# 1. Compile TypeScript workers with SWC
npx swc workers/core/*.ts -d build/workers/core/

# 2. Build Expo web export from mobile
cd ../mobile && expo export --platform web

# 3. Copy web assets to desktop
cp -r ../mobile/dist/* .

# 4. Inject Pear bar into HTML
node scripts/inject-pear-bar.js .

# 5. Run with Pear
pear run --dev .
```

### Mobile Build Pipeline

```bash
# Development
expo start          # Metro dev server

# iOS Build
expo run:ios        # Build + deploy

# Bundle backend (required before native build)
bare-pack --target ios --target android --linked --out backend.bundle.js backend/index.mjs
```

---

## Development Workflow

### Initial Setup

```bash
# Clone and install root dependencies
git clone <repo>
cd peartube
pnpm install

# Install desktop dependencies (uses npm, not pnpm)
cd apps/desktop
npm install --legacy-peer-deps

# Install iOS pods (if developing mobile)
cd ../mobile
pod install
```

### Running Apps

```bash
# Desktop
cd apps/desktop
npm run dev

# Mobile iOS
cd apps/mobile
pnpm ios

# Mobile Android
pnpm android
```

### Making Changes

**Desktop worker changes:**
```bash
npm run build:worker  # Recompile TypeScript
npm run preview       # Run without full rebuild
```

**Mobile backend changes:**
```bash
pnpm bundle:backend   # Recompile Bare bundle
pnpm ios              # Rebuild native app
```

**Shared package changes:**
- Changes reflect immediately (symlinked)

---

## Design System

### Colors

```typescript
const colors = {
  primary: '#9147ff',      // Vibrant purple
  background: '#0e0e10',   // Almost black
  card: '#1f1f23',         // Card background
  border: '#303035',       // Borders
  text: '#efeff1',         // Primary text
  textMuted: '#7a7a85',    // Secondary text
}
```

### Spacing

```typescript
const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
}
```

### Typography

```typescript
const fontSize = {
  xs: 11,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 18,
  xxl: 24,
  xxxl: 32,
}
```

---

## Troubleshooting

### "Cannot find module '/'"

**Cause:** Pear's DependencyStream failing to resolve paths

**Solutions:**
1. Delete stale `build/src/` folder
2. Ensure `/_expo/` paths are converted to `./_expo/` in HTML
3. Remove `type="module"` from script tags
4. Rebuild: `npm run build`

### "ADDON_NOT_FOUND" (iOS)

**Cause:** Native modules not linked

**Solution:**
```bash
cd apps/mobile
./scripts/build-addons.sh
npm run bundle:backend
pod install
```

### Pear module resolution fails

**Cause:** pnpm symlinks incompatible with Bare

**Solution:** Use npm for desktop, ensure `.npmrc` has:
```ini
shamefully-hoist=true
node-linker=hoisted
```

### Worker not responding

**Cause:** Worker crashed or initialization timeout

**Debug:**
1. Check worker console logs
2. Verify worker path in `worker-client.js`
3. Ensure `build/workers/core/index.js` exists

### React Error #130 (Element type undefined)

**Cause:** Platform-specific file exports don't match

**Example:** `VideoCard.web.tsx` exports `VideoCardDesktop` but `index.ts` imports `VideoCard`

**Solution:**
1. Check if there's a `.web.tsx` version of the component
2. Ensure exported function/component names match between platform versions
3. Ensure `VideoCardProps` interface is exported if imported elsewhere

### Desktop changes not working

**Cause:** Editing wrong file - `.web.tsx` version exists

**Solution:**
1. Check for `app/(tabs)/index.web.tsx` - this is used on desktop, not `index.tsx`
2. Check for `Component.web.tsx` files that override the base component
3. Desktop uses the web export, which loads `.web.tsx` files via Metro bundler

### Desktop UI overlapping/z-index issues

**Cause:** Fixed position elements with conflicting z-index

**Solution:**
Use these z-index values:
- Sidebar: 50
- Header: 100
- Modal overlays: 1000+

---

## Worker IPC Architecture

### Worker Communication

**Client side (`lib/worker-client.js`):**
```javascript
// Uses IPC API (preferred) or falls back to Pear.worker.run (deprecated)
function runWorker(path, args) {
  if (typeof Pear[Pear.constructor.IPC]?.run === 'function') {
    return Pear[Pear.constructor.IPC].run(path, args)
  }
  return Pear.worker.run(path, args)
}
this.pipe = runWorker(workerPath, [])
```

**Worker side (`workers/core/index.ts`):**
```javascript
import pipe from 'pear-pipe'
const ipcPipe = pipe()
```

Communication uses newline-delimited JSON (qvac pattern).

---

## Helpful Links

### Pear Runtime & Documentation

| Resource | URL |
|----------|-----|
| **Pear Runtime Docs** | https://docs.pears.com |
| **Pear Runtime GitHub** | https://github.com/holepunchto/pear |
| **Pear Desktop App Guide** | https://docs.pears.com/guides/making-a-pear-desktop-app |
| **Pear Terminal App Guide** | https://docs.pears.com/guides/making-a-pear-terminal-app |

### Bare Runtime

| Resource | URL |
|----------|-----|
| **Bare Runtime** | https://github.com/holepunchto/bare |
| **Bare Kit (React Native)** | https://github.com/holepunchto/bare-kit |
| **Bare Pack (Bundler)** | https://github.com/holepunchto/bare-pack |
| **Bare RPC** | https://github.com/holepunchto/bare-rpc |

### Hypercore Protocol

| Resource | URL |
|----------|-----|
| **Hypercore Protocol Org** | https://github.com/holepunchto |
| **Hypercore** | https://github.com/holepunchto/hypercore |
| **Hyperdrive** | https://github.com/holepunchto/hyperdrive |
| **Hyperbee** | https://github.com/holepunchto/hyperbee |
| **Hyperswarm** | https://github.com/holepunchto/hyperswarm |
| **Corestore** | https://github.com/holepunchto/corestore |
| **Autobase** | https://github.com/holepunchto/autobase |

### Video & Streaming

| Resource | URL |
|----------|-----|
| **Hypercore Blob Server** | https://github.com/holepunchto/hypercore-blob-server |
| **Hypervision (Video Example)** | https://github.com/mafintosh/hypervision |

### Sample Apps & Examples

| Resource | URL |
|----------|-----|
| **Keet (P2P Chat App)** | https://keet.io |
| **Pear Examples** | https://github.com/holepunchto/pear-examples |
| **Bare Examples** | https://github.com/holepunchto/bare-examples |
| **Hyperswarm Examples** | https://github.com/holepunchto/hyperswarm#examples |

### Utilities & Tools

| Resource | URL |
|----------|-----|
| **Protomux** | https://github.com/holepunchto/protomux |
| **Secret Stream** | https://github.com/holepunchto/secret-stream |
| **Compact Encoding** | https://github.com/holepunchto/compact-encoding |
| **B4A (Buffer Utils)** | https://github.com/holepunchto/b4a |
| **Pear Electron** | https://github.com/holepunchto/pear-electron |
| **Pear Bridge** | https://github.com/holepunchto/pear-bridge |

### Reference Apps (Pear v2 Compliant)

| Resource | URL | Description |
|----------|-----|-------------|
| **Pearl Notes** | https://github.com/sayf-t/pearl-notes | React + Pear notes app with P2P sync - excellent reference |
| **Keet** | https://keet.io | Production P2P chat/video app by Holepunch |

### Community & Support

| Resource | URL |
|----------|-----|
| **Holepunch Discord** | https://discord.gg/holepunch |
| **Hypercore Protocol Discord** | https://chat.hypercore-protocol.org |

---

## Reference: Pearl Notes Architecture

Pearl Notes (https://github.com/sayf-t/pearl-notes) is a Pear v2 compliant React app that demonstrates clean patterns for integrating React with Pear. Key learnings:

### Architecture Pattern

```
React UI → window.Pearl (Core API) → Pear Backend Modules
```

**Key Files:**
- `index.js` - Pear main process (Bridge + Runtime setup)
- `ui.js` - UI initialization, exposes `window.Pearl`
- `src/core/pearlCore.js` - Core API facade (exposed to React)
- `src/pear-end/vault/hyperdriveClient.js` - Hyperdrive/Hyperswarm setup

### Build System (esbuild instead of Expo)

```json
{
  "scripts": {
    "build:ui": "node scripts/build-ui.mjs",
    "watch:ui": "node scripts/build-ui.mjs --watch",
    "dev": "pear run --dev .",
    "predev": "npm run build:ui"
  }
}
```

Uses esbuild to bundle React, avoiding Metro/Expo complexity for desktop-only apps.

### Core API Pattern

```javascript
// src/core/pearlCore.js - Facade pattern
import { ensureVaultConfig } from '../pear-end/vault/vaultConfig.js'
import { listNotes, getNote, saveNote, deleteNote } from '../pear-end/notes/notesStore.js'

export async function initializeCore() {
  await ensureVaultConfig()
  startBackgroundSync()
}

// Exposed to UI via window.Pearl
export { listNotes, getNote, saveNote, deleteNote, getVaultStatus, ... }
```

### Hyperdrive Client Pattern

```javascript
// src/pear-end/vault/hyperdriveClient.js
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'

const storagePath = global.Pear?.config?.storage || process.env.STORAGE || '.'
const store = new Corestore(storagePath)
const swarm = new Hyperswarm()

let drive = null
let driveKey = null

export async function ensureDrive(key) {
  if (!drive || key !== driveKey) {
    drive = key ? new Hyperdrive(store, Buffer.from(key, 'hex')) : new Hyperdrive(store)
    await drive.ready()
    driveKey = drive.key.toString('hex')

    // Join swarm for replication
    swarm.on('connection', conn => store.replicate(conn))
    swarm.join(drive.discoveryKey)
  }
  return drive
}

export function getPeerCount() { return swarm.connections.size }
export function getCurrentDriveKey() { return driveKey }
```

### Key Differences from PearTube

| Aspect | Pearl Notes | PearTube |
|--------|-------------|----------|
| Build | esbuild (simple) | Expo web export (complex) |
| UI-Backend | `window.Pearl` global | Worker IPC (pipe) |
| React | Direct in renderer | Expo/Metro bundled |
| Complexity | Single app | Monorepo (mobile + desktop) |

### Lessons for PearTube

1. **Simpler build**: Consider esbuild for desktop-only builds instead of Expo web export
2. **Global API**: `window.Pearl` pattern is cleaner than IPC for simple cases
3. **No workers**: Pearl Notes runs Hypercore in renderer process directly
4. **CSS Modules**: Uses `.module.css` for scoped styling

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `apps/desktop/workers/core/index.ts` | Main P2P backend logic |
| `apps/desktop/workers/core/public-feed.ts` | Gossip discovery protocol |
| `apps/desktop/src/worker-client.js` | Renderer-worker IPC |
| `apps/desktop/scripts/inject-pear-bar.js` | Post-build HTML processing |
| `apps/mobile/backend/index.mjs` | Mobile P2P backend |
| `apps/mobile/app/_layout.tsx` | Root layout + initialization |
| `apps/mobile/components/desktop/DesktopLayout.web.tsx` | Desktop web layout |
| `packages/shared/src/types/index.ts` | Domain types |
| `packages/shared/src/constants/index.ts` | RPC commands |

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
│  │   Core Worker    │              │  Bare Backend    │         │
│  │   (Bare JS)      │              │  (Bare Worklet)  │         │
│  └────────┬─────────┘              └────────┬─────────┘         │
│           │                                  │                   │
│           └──────────────┬───────────────────┘                   │
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
