# PearTube Architecture

PearTube is a permissionless media CDN organized around one universal backend. Platform shells differ, but clients and relays use the same signed publication, immutable asset, policy, and scoped-network contracts.

```text
Client shell
  -> platform runner
  -> @peartube/host
  -> @peartube/backend
  -> Corestore / Autobase / Hyperbee / Hyperswarm
```

Visual decision record and deletion map: [`docs/p2p-simplification.html`](./docs/p2p-simplification.html).

## Runtime Surfaces

| Surface | UI / process | Backend runtime | Transport |
| --- | --- | --- | --- |
| iOS / Android | Expo + React Native | BareKit worklet | HRPC over BareKit IPC |
| Electrobun desktop | Expo web export in Electrobun | embedded `pear-runtime` worker | HRPC over worker pipe |
| Relay | CLI/container | direct backend runtime | in-process API |

## Package Boundaries

```text
packages/
  app/              Expo mobile app, Electrobun export, mobile bundle, desktop worker
  core/             Shared app components, hooks, stores, and types
  platform/         App-facing runner selection and RPC facade
  host/             Backend lifecycle, host error codes, PROTOCOL_VERSION, universal HRPC client (readiness, errors, events, namespaces)
  backend/          Publisher catalogs, indexes, immutable assets, scoped P2P, policy, playback, archive evidence
  spec/             HRPC schema source and generated JS code
  cli/              Relay, authenticated machine API, ingest jobs, archive UI, Docker support
  bare-*/           Native Bare support packages
```

## Simplified Backend Cutover

- `PublisherCatalog` is the signed source of publication truth.
- `createVerifiedQueryView` is the only production catalog, entity, manifest, visibility, and rendition-authorization projection.
- Static `SourceReader` ingest produces one immutable Hypercore per rendition with truthful block-boundary resume and S3-backed staging.
- `verified-block-engine` owns shared proof, chunk, transfer, timeout, and quarantine behavior for asset and archive paths.
- The scoped network is split into bootstrap, publisher-catalog, feed, content-transfer, and session-lifecycle modules behind the stable facade.
- `/api/v2` is the only machine API. The archive UI calls the same verified service in process and can mint playback capabilities only on a loopback bind.

Legacy channel, PublicBee, Hyperblobs, seed-pin, and publication-v1 code remains only where active clients or deployed stores still require it. Removing that boundary requires a protocol-major migration and a confirmed upgrade window.

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

## Media And Catalog Model

- Publishers own signed namespaces and device-writer authorization. A publisher identity is provenance, not ownership of a movie, episode, or other work.
- Publications bind media claims to immutable rendition descriptors. Static rendition cores use canonical blocks and Hypercore verification.
- Local and remote index services project signed catalog records into bounded, queryable views. Indexers return candidate facts; they do not grant trust or rank globally.
- Clients verify the selected candidate against the current publisher catalog before opening an asset session.
- Media identity uses normalized external coordinates such as TMDB movie or series/season/episode identifiers. Equivalent publications remain separate sources with preserved provenance.

## Storage And Transfer

- Corestore owns core lifecycle and replication.
- Hyperbee stores local metadata and materialized views.
- Autobase projects multi-writer publisher catalog state.
- Hyperswarm and Protomux provide purpose-scoped bootstrap, publisher, index, asset, archive, and archive-discovery sessions.
- Playback and retention operate on exact immutable rendition ranges. There is no HTTP media-origin fallback.
- S3-compatible storage is the only cloud block-offload backend. Offloaded blocks restore into the same verified asset cores used for playback and seeding.

## Generic Client Boundary

The relay exposes an authenticated local `/api/v2` machine surface. Unix-domain sockets are the default. TCP/container use requires configured request authentication.

```text
Client application exact selector
  -> bounded PearTube candidate search
  -> client application ranks available sources
  -> selected opaque candidate reference
  -> PearTube re-verifies current publisher state and availability
  -> route-scoped playback capability
```

Client applications keep private credentials, source URLs, cookies, and acquisition policy outside PearTube. PearTube publishes verified immutable descriptors and non-secret claims, never bearer URLs.

## Participation And Authority

- Watch-only peers consume without offering archival custody.
- Balanced peers seed within explicit device and network budgets.
- Archive-enabled peers may retain ranges, issue pledges, and answer possession challenges.
- Local moderation and followed publisher/index lists decide what work this device performs.
- Relays, indexers, client applications, and archivists gain no publisher or global moderation authority.
- Catalog presence, peer reachability, and archival durability are separate facts. UI and APIs must not turn any one of them into an availability guarantee.

## Generated Artifacts

Tracked generated output:

- `packages/spec/spec/hrpc/*`
- `packages/spec/spec/schema/*`

Use root commands to regenerate:

```bash
npm run schema:full
```

## Build Pipelines

```bash
npm run ios
npm run android
npm run desktop
npm test
```

CI splits coverage across fast tests, mobile builds, Electrobun desktop, relay builds, and release artifact workflows under `.github/workflows/`.

## Runtime Boundaries

- Backend behavior belongs in `@peartube/backend`.
- Host lifecycle, protocol versioning, and client readiness/errors/events belong in `@peartube/host`.
- Platform-specific runner selection belongs in `@peartube/platform`.
- Native clients must reject unsupported protocol versions before using backend data.
- Platform-only backend behavior should be added only when the runtime limitation is real and documented.

Last updated: 2026-08-26.
