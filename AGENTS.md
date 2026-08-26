# PearTube Development Guide

PearTube is a permissionless media CDN and consumer streaming platform built on the Hypercore stack. Every first-party or third-party client boots or connects to the same universal backend and authenticated machine contracts.

## Agent Instructions

Builds, installs, and deploy commands may be run when explicitly requested.

## Current Architecture

```
Client shell
  -> platform runner
  -> @peartube/host
  -> @peartube/backend
  -> Corestore / Autobase / Hyperbee / Hyperswarm
```

The client shell is platform-specific. The backend logic is not.

| Client | UI shell | Backend runner | RPC |
| --- | --- | --- | --- |
| iOS / Android | Expo + React Native | BareKit worklet | HRPC over BareKit IPC |
| Electrobun desktop | Expo web export | desktop worker | HRPC over worker pipe |
| Relay / third-party client | CLI, container, or external application | direct runtime or remote relay | in-process API or authenticated `/api/v2` |

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

`@peartube/backend` owns signed publisher catalogs, local and federated indexes, immutable static assets, exact-range verification, purpose-scoped Hyperswarm networking, participation policy, archival evidence, S3-compatible block offload, playback, and diagnostics.

`@peartube/host` owns backend lifecycle and the universal client contract. It validates startup options, starts the backend runtime, reports host readiness/errors, defines the shared `PROTOCOL_VERSION`, and (via `create-client.js`) wraps generated HRPC, normalizes host readiness, surfaces protocol events, and exposes grouped namespaces.

`@peartube/platform` owns app-side runner selection. Mobile uses the native runner, Electrobun uses the web runner, and both expose the same app-facing RPC facade.


`@peartube/spec` is the schema source of truth. Update `packages/spec/schema.cjs`, then regenerate schema outputs before relying on new fields.

`packages/cli` owns the relay process, authenticated generic machine API, ingest jobs, archive UI, and operator configuration. The machine API must remain client-neutral; no external application is privileged or named in the PearTube contract.

## Important Files

| File | Purpose |
| --- | --- |
| `packages/host/src/contracts.js` | Shared protocol version and host error codes |
| `packages/host/src/create-client.js` | Universal protocol client |
| `packages/host/src/event-map.js` | Shared protocol event names |
| `packages/backend/src/runtime.js` | Universal backend runtime used by apps and relays |
| `packages/backend/src/indexer/local-catalog-index.js` | Durable local projection of verified publisher catalogs |
| `packages/cli/src/companion/server.js` | Authenticated generic machine API transport |
| `packages/cli/src/companion/routes.js` | Bounded search, open, status, policy, and ingest routes |

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
- Keep machine APIs client-neutral. PearTube verifies and serves facts; each client owns its ranking and acquisition policy.
- Treat catalog presence, current reachability, and archival durability as separate facts.
- S3-compatible block storage is the only cloud offload path.

## Hypercore Stack

| Package | Purpose |
| --- | --- |
| `hypercore` | Immutable asset logs and append-only protocol state |
| `autobase` | Multi-writer publisher and personal projections |
| `hyperbee` | Metadata and local/indexed views |
| `hyperswarm` | Purpose-scoped P2P discovery and connections |
| `corestore` | Core lifecycle and storage management |
| `hypercore-crypto` | Ed25519 cryptography |

## Troubleshooting

Protocol version mismatch:
Check `packages/host/src/contracts.js`. All clients should speak the same `PROTOCOL_VERSION`.

Backend ready but catalog empty:
Call `getSwarmStatus`. Distinguish DHT/bootstrap failure, zero scoped peers, no followed publishers/indexes, no verified catalog rows, and no currently reachable asset ranges before changing UI behavior.

Schema drift:
Update `packages/spec/schema.cjs`, run `npm run schema:full`, then run the focused protocol/spec tests.

## Storage

Clients resolve their storage paths through `@peartube/platform` and the active runner.
