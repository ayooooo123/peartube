# PearTube Development Guide

PearTube is a decentralized P2P video platform built on the Hypercore stack. The current architecture is centered on a **universal backend**: every client boots or connects to the same backend contract instead of maintaining separate desktop and mobile backend implementations.

## Agent Instructions

Builds, installs, and deploy commands may be run when explicitly requested.

## Current Architecture

```
Client shell
  -> platform runner
  -> @peartube/protocol
  -> @peartube/host
  -> @peartube/backend
  -> Hypercore / Hyperdrive / Hyperbee / Hyperswarm
```

The client shell is platform-specific. The backend logic is not.

| Client | UI shell | Backend runner | RPC |
| --- | --- | --- | --- |
| iOS / Android | Expo + React Native | BareKit worklet | HRPC over BareKit IPC |
| Electrobun desktop | Expo web export | desktop worker | HRPC over worker pipe |
| `desktop-native` | SwiftUI macOS app | bare-native sidecar or embedded BareKit | HRPC over native bridge |

## Monorepo Layout

```
packages/
├── app/                # Expo app for mobile and Electrobun desktop
├── backend/            # Universal P2P backend logic
├── core/               # Shared app components, hooks, stores, and types
├── desktop-native/     # Native macOS SwiftUI client
├── host/               # Universal backend host lifecycle and protocol version
├── platform/           # Platform runners and app-facing RPC facade
├── protocol/           # Shared protocol client, event map, readiness handling
├── spec/               # HRPC schema and code generation
└── bare-*/             # Vendored/native Bare addons used by backend runtimes
```

## Package Responsibilities

`@peartube/backend` owns P2P behavior: storage layout, Corestore/Hyperdrive setup, Hyperbee metadata, Hyperswarm networking, public feed gossip, uploads, seeding, playback URLs, and diagnostics.

`@peartube/host` owns backend lifecycle. It validates startup options, starts the backend runtime, reports host readiness/errors, and defines the shared `PROTOCOL_VERSION`.

`@peartube/protocol` owns the universal client contract. It wraps generated HRPC, normalizes host readiness, surfaces protocol events, and exposes grouped namespaces such as `system`, `feed`, `video`, `transfer`, and `shell`.

`@peartube/platform` owns app-side runner selection. Mobile uses the native runner, Electrobun uses the web runner, and both expose the same app-facing RPC facade.

`@peartube/spec` is the schema source of truth. Update `packages/spec/schema.cjs`, then regenerate schema outputs before relying on new fields from JS or Swift.

`packages/desktop-native` is a native macOS client, not a second backend. Its Swift service uses generated HRPC types, validates the universal protocol version, and displays backend network diagnostics from `getSwarmStatus`.

## Important Files

| File | Purpose |
| --- | --- |
| `packages/host/src/contracts.js` | Shared protocol version and host error codes |
| `packages/host/src/start-host.js` | Universal host startup wrapper |
| `packages/backend/src/runtime.js` | Backend runtime used by native/mobile hosts |
| `packages/backend/src/api.js` | Backend API surface and swarm diagnostics |
| `packages/protocol/src/create-client.js` | Universal protocol client |
| `packages/protocol/src/event-map.js` | Shared protocol event names |
| `packages/platform/src/rpc.shared.ts` | Common app-facing RPC bridge |
| `packages/spec/schema.cjs` | HRPC schema source |
| `packages/desktop-native/Sources/Services/HostBridgeService.swift` | Native macOS host bridge |
| `packages/desktop-native/Bridge/native-rpc.mjs` | Compact native bridge codecs |

## Development Commands

Root scripts:

```bash
npm run install:all
npm run schema
npm run typecheck
npm test
```

Client scripts:

```bash
npm run ios
npm run android
npm run desktop
npm run desktop:build
npm run desktop:native:build
npm run desktop:native:test
```

Schema workflow:

```bash
npm run schema:full
```

`schema:full` regenerates JS schema/HRPC output and copies generated Swift files into `packages/desktop-native/Sources/Support/`.

## Architecture Rules

- Treat `@peartube/backend` as the single backend implementation.
- Add backend-facing capabilities to `packages/spec/schema.cjs` first, then expose them through `@peartube/protocol` and `@peartube/platform`.
- Keep `@peartube/host` as the only place that defines the protocol version.
- Native clients must reject unsupported protocol versions before applying backend data.
- Network empty states should use structured swarm diagnostics, not generic “no content” copy.
- Do not add platform-only backend behavior unless the limitation is truly runtime-specific.

## Hypercore Stack

| Package | Purpose |
| --- | --- |
| `hypercore` | Append-only logs |
| `hyperdrive` | Distributed video and asset storage |
| `hyperbee` | Metadata database |
| `hyperswarm` | P2P discovery and connections |
| `corestore` | Core lifecycle and storage management |
| `hypercore-crypto` | Ed25519 cryptography |
| `hypercore-blob-server` | Local video streaming URLs |

## Troubleshooting

Protocol version mismatch:
Check `packages/host/src/contracts.js`, the native bridge codecs, and generated Swift schema output. All clients should speak the same `PROTOCOL_VERSION`.

Backend ready but feed empty:
Call `getSwarmStatus`. Distinguish DHT bootstrap, zero swarm peers, missing feed channels, and zero feed entries before changing UI behavior.

Native macOS bridge failures:
Check `packages/desktop-native/Sources/Services/HostBridgeService.swift`, sidecar logs, and generated bridge bundles under `packages/desktop-native/Resources/Generated/`.

Schema drift:
Update `packages/spec/schema.cjs`, run `npm run schema:full`, then run the focused protocol/spec tests.

## Storage

Desktop native data is stored under:

```text
~/Library/Application Support/PearTubeDesktopNative/
```

Other clients resolve their storage paths through `@peartube/platform` and the active runner.
