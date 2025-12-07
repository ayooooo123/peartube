# PearTube Architecture

## Overview

PearTube is a decentralized P2P video platform that runs on iOS, Android, and Desktop from a single codebase. It leverages the Hypercore Protocol for distributed storage and networking.

## Design Principles

1. **Unified Codebase**: One app serves mobile and desktop
2. **Platform Abstraction**: Backend logic is platform-agnostic
3. **Type-Safe RPC**: HRPC schema generates typed clients/servers
4. **Self-Sovereign Identity**: Users control their own keys
5. **Sparse Replication**: Only download what you watch

## Monorepo Structure

```
peartube/
├── packages/
│   ├── app/              # Unified app package
│   │   ├── app/          # Expo Router screens
│   │   │   ├── (tabs)/   # Tab screens
│   │   │   │   ├── index.tsx      # Mobile home
│   │   │   │   ├── index.web.tsx  # Desktop home
│   │   │   │   └── ...
│   │   │   └── _layout.tsx        # Root layout
│   │   ├── components/   # React components
│   │   ├── lib/          # App utilities
│   │   ├── backend/      # Mobile BareKit worklet source
│   │   │   └── index.mjs
│   │   ├── pear-src/     # Desktop Pear source
│   │   │   ├── index.js           # pear-electron entry
│   │   │   ├── package.json       # Pear manifest
│   │   │   ├── worker-client.js   # HRPC bridge
│   │   │   └── workers/core/      # Desktop backend worker
│   │   └── pear/         # Built Pear output (generated)
│   │
│   ├── backend/          # Backend business logic
│   │   └── src/
│   │       ├── PearTubeBackend.ts
│   │       ├── VideoManager.ts
│   │       ├── ChannelManager.ts
│   │       └── ...
│   │
│   ├── backend-core/     # P2P primitives
│   │   └── src/
│   │       ├── CoreManager.ts     # Hypercore/Hyperdrive
│   │       ├── SwarmManager.ts    # Hyperswarm
│   │       ├── BlobServer.ts      # HTTP blob serving
│   │       └── ...
│   │
│   ├── core/             # Shared types
│   │   └── src/
│   │       ├── types/
│   │       └── constants/
│   │
│   ├── platform/         # Platform abstraction
│   │   └── src/
│   │       ├── platform.ts        # Detection utilities
│   │       ├── BareKitPlatform.ts # Mobile platform
│   │       └── PearPlatform.ts    # Desktop platform
│   │
│   ├── rpc/              # RPC layer
│   │   └── src/
│   │       ├── createRpcClient.ts
│   │       └── createRpcServer.ts
│   │
│   ├── spec/             # HRPC schema
│   │   ├── schema.proto  # Protocol definition
│   │   └── index.js      # Generated HRPC client
│   │
│   └── ui/               # Shared UI components
│
└── package.json          # Root package with scripts
```

## Platform Architecture

### Mobile (iOS/Android)

```
┌─────────────────────────────────────────┐
│         React Native App                │
│   (Expo Router + NativeWind)            │
└──────────────────┬──────────────────────┘
                   │ HRPC
┌──────────────────▼──────────────────────┐
│         BareKit Worklet                 │
│   (runs in native Bare runtime)         │
├─────────────────────────────────────────┤
│  @peartube/backend                      │
│  @peartube/backend-core                 │
│  hyperswarm, hyperdrive, etc.           │
└─────────────────────────────────────────┘
```

- **BareKit**: Native runtime that runs JavaScript with access to native addons
- **Worklet**: Bundled JavaScript that runs P2P networking
- **HRPC**: Type-safe RPC between React Native and worklet

### Desktop (Pear)

```
┌─────────────────────────────────────────┐
│      Expo Web Export (React)            │
│   (served by pear-electron)             │
└──────────────────┬──────────────────────┘
                   │ HRPC via pear-run
┌──────────────────▼──────────────────────┐
│         Pear Worker                     │
│   (runs via pear-run)                   │
├─────────────────────────────────────────┤
│  @peartube/backend                      │
│  @peartube/backend-core                 │
│  hyperswarm, hyperdrive, etc.           │
└─────────────────────────────────────────┘
```

- **pear-electron**: Hosts the web UI
- **pear-run**: Spawns worker process
- **worker-client.js**: Bridges UI to worker via HRPC

## RPC Communication

### HRPC Schema (packages/spec/schema.proto)

```protobuf
service PearTube {
  // Requests (call/response)
  rpc getVideos (GetVideosRequest) returns (GetVideosResponse);
  rpc uploadVideo (UploadVideoRequest) returns (UploadVideoResponse);

  // Events (server → client)
  rpc eventReady (EventReady) returns (Empty);
  rpc eventUploadProgress (UploadProgress) returns (Empty);
}
```

### Client Usage

```typescript
// React component
const { rpc } = usePlatform();

// Call backend
const videos = await rpc.getVideos({ limit: 20 });

// Listen for events
rpc.onEventUploadProgress((data) => {
  console.log('Upload:', data.progress, '%');
});
```

## Data Layer

### Per-Channel Storage

1. **Hyperdrive** - Video files
   ```
   /videos/{videoId}/
     ├── manifest.m3u8
     ├── 720p/
     │   ├── playlist.m3u8
     │   └── segment_*.ts
     └── thumbnail.jpg
   ```

2. **Hyperbee** - Metadata
   ```
   /videos/{videoId}/metadata
   /channel/info
   ```

### Video Streaming

- Videos served via local HTTP blob server
- BlobServer runs on localhost with dynamic port
- Player fetches HLS segments via HTTP

## Build System

### Mobile Backend Bundle

```bash
npm run bundle:backend
# Uses bare-pack to bundle backend/index.mjs
# Output: backend.bundle.js (loaded by BareKit)
```

### Pear Desktop Build

```bash
npm run pear:build
# 1. expo export --platform web → .pear-build/
# 2. rsync to pear/ (preserving package.json)
# 3. npm install in pear/
# 4. SWC compile worker
# 5. Inject Pear bar into HTML
```

## Key Design Decisions

### Why Unified App?

- **Shared code**: Same React components, same backend logic
- **Platform variants**: `.web.tsx` files for desktop-specific UI
- **Single source of truth**: One package to maintain

### Why HRPC?

- **Type safety**: Schema generates typed clients
- **Binary efficient**: Compact wire format
- **Streaming**: Supports events and subscriptions

### Why BareKit + Pear?

- **BareKit**: Only way to run native Hypercore on mobile
- **Pear**: First-class desktop runtime from Holepunch
- **Same stack**: Both use Bare/Node.js compatible APIs

## Future Considerations

1. **Android**: Currently iOS-focused, Android support pending
2. **Live Streaming**: Real-time video via Hyperswarm
3. **Offline Mode**: Full local caching
4. **Federation**: Bridge to ActivityPub
