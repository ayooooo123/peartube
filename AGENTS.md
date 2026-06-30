# PearTube Development Guide

PearTube is a decentralized P2P video platform built on the Hypercore stack. The current architecture is centered on a **universal backend**: every client boots or connects to the same backend contract instead of maintaining separate desktop and mobile backend implementations.

## Agent Instructions

Builds, installs, and deploy commands may be run when explicitly requested.

## Current Architecture

```
Client shell
  -> platform runner
  -> @peartube/host
  -> @peartube/backend
  -> Hypercore / Hyperdrive / Hyperbee / Hyperswarm
```

The client shell is platform-specific. The backend logic is not.

| Client | UI shell | Backend runner | RPC |
| --- | --- | --- | --- |
| iOS / Android | Expo + React Native | BareKit worklet | HRPC over BareKit IPC |
| Electrobun desktop | Expo web export | desktop worker | HRPC over worker pipe |

## Monorepo Layout

```
packages/
├── app/                # Expo app for mobile and Electrobun desktop
├── backend/            # Universal P2P backend logic
├── core/               # Shared app components, hooks, stores, and types
├── host/               # Backend host lifecycle, protocol version, and the protocol client (event map, readiness handling)
├── platform/           # Platform runners and app-facing RPC facade
├── spec/               # HRPC schema and code generation
└── bare-*/             # Vendored/native Bare addons used by backend runtimes
```

## Package Responsibilities

`@peartube/backend` owns P2P behavior: storage layout, Corestore/Hyperdrive setup, Hyperbee metadata, Hyperswarm networking, public feed gossip, uploads, seeding, playback URLs, and diagnostics.

`@peartube/host` owns backend lifecycle and the universal client contract. It validates startup options, starts the backend runtime, reports host readiness/errors, defines the shared `PROTOCOL_VERSION`, and (via `create-client.js`) wraps generated HRPC, normalizes host readiness, surfaces protocol events, and exposes grouped namespaces such as `system`, `feed`, `video`, `transfer`, and `shell`.

`@peartube/platform` owns app-side runner selection. Mobile uses the native runner, Electrobun uses the web runner, and both expose the same app-facing RPC facade.

`@peartube/spec` is the schema source of truth. Update `packages/spec/schema.cjs`, then regenerate schema outputs before relying on new fields.

## Important Files

| File | Purpose |
| --- | --- |
| `packages/host/src/contracts.js` | Shared protocol version and host error codes |
| `packages/host/src/create-client.js` | Universal protocol client |
| `packages/host/src/event-map.js` | Shared protocol event names |
| `packages/backend/src/runtime.js` | Backend runtime used by app hosts |
| `packages/backend/src/api.js` | Backend API surface and swarm diagnostics |
| `packages/platform/src/rpc.shared.ts` | Common app-facing RPC bridge |
| `packages/spec/schema.cjs` | HRPC schema source |

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
```

Schema workflow:

```bash
npm run schema:full
```

`schema:full` regenerates JS schema/HRPC output.

## Architecture Rules

- Treat `@peartube/backend` as the single backend implementation.
- Add backend-facing capabilities to `packages/spec/schema.cjs` first, then expose them through `@peartube/host` and `@peartube/platform`.
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
Check `packages/host/src/contracts.js`. All clients should speak the same `PROTOCOL_VERSION`.

Backend ready but feed empty:
Call `getSwarmStatus`. Distinguish DHT bootstrap, zero swarm peers, missing feed channels, and zero feed entries before changing UI behavior.

Schema drift:
Update `packages/spec/schema.cjs`, run `npm run schema:full`, then run the focused protocol/spec tests.

## Storage

Clients resolve their storage paths through `@peartube/platform` and the active runner.
