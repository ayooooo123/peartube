# PearTube Architecture

PearTube is organized around a universal backend. Platform shells differ, but they all talk to the same host/protocol/backend contract.

```text
Client shell
  -> platform runner
  -> @peartube/host
  -> @peartube/backend
  -> Corestore / Autobase / Hyperbee / Hyperblobs / Hyperswarm
```

## Runtime Surfaces

| Surface | UI / process | Backend runtime | Transport |
| --- | --- | --- | --- |
| iOS / Android | Expo + React Native | BareKit worklet | HRPC over BareKit IPC |
| Electrobun desktop | Expo web export in Electrobun | embedded `pear-runtime` worker | HRPC over worker pipe |
| Native macOS | SwiftUI | bare-native sidecar or embedded BareKit | HRPC over native bridge |
| Relay | CLI/container | direct backend runtime | in-process API |

## Package Boundaries

```text
packages/
  app/              Expo mobile app, Electrobun export, mobile bundle, desktop worker
  core/             Shared app components, hooks, stores, and types
  platform/         App-facing runner selection and RPC facade
  host/             Backend lifecycle, host error codes, PROTOCOL_VERSION, universal HRPC client (readiness, errors, events, namespaces)
  backend/          P2P storage, discovery, API surface, playback, relay logic
  spec/             HRPC schema source and generated JS/Swift code
  desktop-native/   SwiftUI native macOS client and bridge
  cli/              Relay CLI, standalone build, Docker artifact support
  bare-*/           Native Bare support packages
```

## Startup Flow

### Mobile

```text
React Native UI
  -> packages/platform/src/rpc.native.ts
  -> packages/app/backend.bundle.js
  -> @peartube/host/start-host
  -> @peartube/backend/backend-entry
```

The mobile source entrypoint is `packages/app/backend/index.mjs`. The bundle is regenerated with:

```bash
npm run bundle:backend
```

### Electrobun Desktop

```text
Electrobun view
  -> packages/platform/src/rpc.web.ts
  -> packages/app/workers/desktop/index.ts
  -> packed worker bundle
  -> @peartube/backend/backend-entry
```

`npm run desktop:build` exports the Expo web app, compiles the worker, and packs a Bare worker bundle with offloaded native addons.

### Native macOS

```text
SwiftUI app
  -> HostBridgeService.swift
  -> Bridge/native-rpc.mjs codecs
  -> Bridge/native-host-sidecar.mjs or embedded BareKit worklet
  -> @peartube/backend/backend-entry
```

Native macOS validates the host protocol version before applying backend data.

## Protocol Contract

- `packages/spec/schema.cjs` is the schema source of truth.
- `packages/spec/spec/hrpc/app-rpc-adapter.mjs` contains generated app RPC metadata and namespace maps.
- `packages/host/src/contracts.js` owns `PROTOCOL_VERSION`.
- `packages/host/src/create-client.js` validates readiness, normalizes host errors, emits protocol events, and exposes method namespaces.
- `packages/platform/src/rpc.shared.ts` provides the common app-facing bridge.

After schema changes:

```bash
npm run schema:full
npm test --prefix packages/spec
```

## Backend Storage Model

The current backend implementation uses:

- Corestore for core lifecycle and replication;
- Hyperbee for local metadata and materialized views;
- Autobase for multi-writer channel state;
- PublicBee for fast public viewer reads;
- Hyperblobs and `hypercore-blob-server` for video/thumbnail byte storage and local playback URLs;
- Hyperswarm plus Protomux for discovery and peer connections.

The current source tree does not use Hyperdrive as the primary video storage path. Historical docs may still mention Hyperdrive; prefer this architecture doc and `docs/p2p-backend-audit.md` when reasoning about current storage code.

## Discovery And Empty States

Public discovery is anchored around the shared public feed topic and feed entries that carry enough channel/video references for fast viewer reads. UI empty states should inspect structured diagnostics from `system.getSwarmStatus()` before deciding whether the user has no content, no DHT/bootstrap path, no feed peers, no loaded channels, or no feed entries.

## Generated Artifacts

Tracked generated output:

- `packages/spec/spec/hrpc/*`
- `packages/spec/spec/schema/*`
- `packages/spec/spec/swift-*/*`

Regenerated local/native output:

- `packages/desktop-native/Sources/Support/GeneratedSchema.swift`
- `packages/desktop-native/Sources/Support/GeneratedHRPC.swift`
- `packages/desktop-native/Resources/Generated/*`
- `packages/desktop-native/Resources/Runtime/*`

Use root commands instead of manual copying:

```bash
npm run schema:full
npm run generate --prefix packages/desktop-native
```

## Build Pipelines

```bash
npm run ios
npm run android
npm run desktop
npm run desktop:native:build
npm test
```

CI splits coverage across fast tests, mobile builds, Electrobun desktop, native desktop, relay builds, and release artifact workflows under `.github/workflows/`.

## Runtime Boundaries

- Backend behavior belongs in `@peartube/backend`.
- Host lifecycle, protocol versioning, and client readiness/errors/events belong in `@peartube/host`.
- Platform-specific runner selection belongs in `@peartube/platform`.
- Native clients must reject unsupported protocol versions before using backend data.
- Platform-only backend behavior should be added only when the runtime limitation is real and documented.

Last updated: 2026-06-26.
