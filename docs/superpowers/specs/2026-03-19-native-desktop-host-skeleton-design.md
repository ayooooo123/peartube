# PearTube Native Desktop Host Skeleton Design

Date: 2026-03-19
Branch: `codex/native-desktop-host-skeleton`
Status: Draft approved in chat, written for review

## Summary

PearTube should move toward one shared backend host model across desktop and mobile, with a new native macOS shell added in parallel to the existing app. The first milestone is not a full desktop replacement. It is a structural migration that standardizes host bootstrap and protocol boundaries so both mobile and desktop talk to the same backend contract, while a new Swift desktop shell proves the future path with a working browse to detail to play flow.

This design keeps the existing mobile app running, keeps the current Pear desktop path available as fallback, and moves new investment into a platform-neutral host and protocol layer. The long-term desktop direction is native, not Electron.

## Goals

- Standardize backend bootstrap so mobile and desktop launch the same shared host shape.
- Define one shared protocol surface for commands, queries, and events.
- Add a parallel macOS native desktop shell in Swift.
- Deliver a first real native path for browse, detail, and playback.
- Preserve existing app behavior where practical while reducing platform-specific glue.

## Non-Goals

- Replacing the mobile UI stack in this branch.
- Shipping OTA update infrastructure.
- Rebuilding the whole app UI in Cellery.
- Removing the old desktop path in the first milestone.
- Achieving feature parity with every current desktop surface before the host split lands.

## Current State

PearTube already has the right backend seam in [packages/backend/src/backend-entry.js](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/backend-entry.js). `createBackend()` only requires a storage path, a duplex stream, and lifecycle callbacks. That is the durable abstraction.

The problem is that platform bootstrap and transport logic are split in different places:

- Mobile worklet bootstrap and IPC live in [packages/platform/src/rpc.native.ts](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/platform/src/rpc.native.ts).
- Desktop worker bootstrap and Pear pipe handling live in [packages/platform/src/rpc.web.ts](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/platform/src/rpc.web.ts) and [packages/app/pear-src/worker-client.js](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/app/pear-src/worker-client.js).
- Mobile backend bootstrap duplicates backend setup concerns in [packages/app/backend/index.mjs](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/app/backend/index.mjs).
- Shared HRPC handlers already exist, but the shared set currently mixes domain APIs with shell capabilities in [packages/backend/src/hrpc-handlers.js](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/hrpc-handlers.js).

The result is one backend core with multiple platform-specific launch paths and transport assumptions layered around it.

## Recommended Approach

Create a shared host package and a shared protocol package first, then build a new native macOS shell against those layers.

This is the recommended approach because it preserves the current app while moving both platforms toward the same runtime model. It also keeps the native desktop shell thin: the shell owns presentation and playback chrome, while the shared host owns app state, networking, storage, and background work.

## Alternatives Considered

### 1. Keep evolving the existing mobile and Pear desktop adapters

This is the lowest short-term effort, but it preserves the split architecture and leaves PearTube tied to transports and shell assumptions that are already shifting upstream.

### 2. Rewrite the whole app around Cellery now

This is architecturally interesting, but too early for a video app with playback, cast, downloads, and platform-specific media behavior. Cellery is better treated as a future rendering option once the host boundary is stable.

### 3. Replace desktop in place instead of adding a parallel native app

This reduces duplication on paper, but it raises migration risk substantially. A parallel native shell gives us a proving ground without removing the existing fallback until the host split is stable.

## Architecture

The new target architecture is:

`UI shell -> runner -> protocol -> host -> backend/workers`

Where:

- The UI shell owns views, navigation, and local presentation state.
- The runner starts the shared host and exposes a stream transport.
- The protocol defines commands, queries, events, and capability boundaries.
- The host boots the backend and owns lifecycle, storage, networking, and background work.
- The backend and workers continue to own P2P logic, upload, feed, search, playback URL resolution, and replication.

## Package Layout

### `packages/host`

Purpose:

- Single platform-neutral bootstrap for the PearTube host.
- Wrap [packages/backend/src/backend-entry.js](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/backend-entry.js) instead of re-creating backend startup in multiple places.
- Own lifecycle helpers for startup, shutdown, and event forwarding.

Responsibilities:

- Accept `storagePath`, `platform`, `stream`, and lifecycle hooks.
- Boot the backend through `createBackend()`.
- Attach shared handlers.
- Expose a small host launch contract that both mobile and desktop runners can consume.

Host launch contract:

```ts
type StartHostOptions = {
  platform: 'mobile' | 'desktop'
  storagePath: string
  entrypoint: string
  args?: string[]
}

type HostReady = {
  blobServerPort: number | null
  protocolVersion: 1
}

type HostErrorCode =
  | 'HOST_START_FAILED'
  | 'STORAGE_INIT_FAILED'
  | 'PERMISSION_DENIED'
  | 'TRANSPORT_DISCONNECTED'
  | 'PROTOCOL_VERSION_MISMATCH'
  | 'CAPABILITY_UNAVAILABLE'
  | 'OFFLINE_UNAVAILABLE'
  | 'REPLICATION_TIMEOUT'
  | 'PLAYBACK_URL_UNAVAILABLE'
  | 'PLAYER_LOAD_FAILED'

type HostLifecycleEvent =
  | { type: 'host.ready', data: HostReady }
  | { type: 'host.error', code: HostErrorCode, message: string, retryable: boolean }
  | { type: 'transport.closed', reason?: string }

type HostSession = {
  stream: Duplex
  waitUntilReady(): Promise<HostReady>
  terminate(): Promise<void>
  onLifecycle(cb: (event: HostLifecycleEvent) => void): () => void
}

type HostRunner = {
  start(options: StartHostOptions): Promise<HostSession>
}
```

The implementation can vary by platform, but the shell should only depend on this interface.

### `packages/protocol`

Purpose:

- Define a transport-neutral API contract between shells and the host.

Responsibilities:

- Wrap the generated HRPC schema with app-facing client and event helpers.
- Split domain operations from shell capabilities.
- Standardize event names and payloads across desktop and mobile.

Key boundary:

- Domain operations stay in the shared host contract.
- Shell capabilities become explicit adapters rather than leaking into the domain layer by default.

Initial protocol capability groups:

- `system`: status, storage stats, swarm status
- `identity`: create, get, list, recover, activate
- `feed`: public feed, refresh, publish, unpublish
- `channel`: join, subscribe, unsubscribe, metadata, devices
- `video`: list, detail, thumbnail, playback URL, metadata update, delete, prefetch
- `watch`: watch logging and recommendation reads
- `transfer`: upload and download
- `search`: channel search, global search, vector indexing
- `shell`: file picking, cast, player-specific adapters, and other edge capabilities

Initial shared event names:

- `host.ready`
- `host.error`
- `upload.progress`
- `download.progress`
- `feed.updated`
- `video.stats`
- `cast.deviceFound`
- `cast.deviceLost`
- `cast.playbackState`
- `cast.timeUpdate`
- `transport.closed`

### `packages/desktop-native`

Purpose:

- New Swift macOS app target.

Responsibilities:

- Native windows, navigation, browse lists, detail screens, settings shell, and playback UI.
- Start the shared host through an Apple-native bridge.
- Use `AVPlayer` for the first playback path.
- Subscribe to shared protocol events and send commands through the shared protocol client.

Desktop runner decision:

- The macOS shell will launch the host out of process relative to the Swift UI.
- The host process will run Bare code and expose a framed duplex byte stream.
- The first implementation will launch a bundled host sidecar with `Process` and connect it with paired `Pipe` streams.
- The Swift shell will not host backend state in process.
- The Apple bridge is responsible for process lifecycle and byte transport only.
- `packages/protocol` sits above that transport and hides bridge details from the rest of the shell.

### Existing app packages

Purpose:

- Keep mobile and current desktop working during the migration.

Responsibilities:

- Mobile keeps its current UI for now but starts depending on `packages/host` and `packages/protocol`.
- The old Pear desktop path becomes transitional and should stop accumulating new product logic once the native shell exists.

## Data Flow

### Browse to Detail to Play

1. The macOS native shell starts.
2. The shell launches the shared host through the desktop runner.
3. The host boots the backend and registers the shared protocol surface.
4. The shell requests identities, feed data, subscriptions, search results, and channel or video details through the protocol.
5. The user selects a video.
6. The host resolves metadata and a playback URL.
7. The shell passes the URL to `AVPlayer`.
8. The shell reports playback state and watch events back through the protocol.
9. The host persists watch state and emits relevant events to clients.

### State Ownership

Shell-owned state:

- Window state
- Navigation state
- Selection state
- Player chrome and local playback presentation

Host-owned state:

- Identity state
- Feed and channel data
- Search results
- Upload and download jobs
- Playback URL resolution
- Watch logging
- Replication and swarm state
- Storage and background workers

## Capability Model

The current shared HRPC surface includes both app-domain operations and shell-specific capabilities. That should be split conceptually, even if the physical HRPC schema changes happen incrementally.

Domain capabilities:

- identity
- feed
- subscriptions
- channel
- video metadata
- playback URL resolution
- watch events
- uploads
- downloads
- search
- storage stats
- swarm status

Shell capabilities:

- file picking
- notifications
- player backend selection
- window controls
- share sheets
- orientation
- cast discovery and routing

Phase 1 does not need to fully redesign the schema. It does need to establish that shell capabilities are adapters at the edge, not the center of the architecture.

## Native Desktop Direction

The macOS app will be a native Swift shell. The first pass should use a simple Apple-native playback path with `AVPlayer`, fed by host-resolved local blob or HTTP URLs.

The native desktop host will run out of process and communicate with the shell over a duplex stream exposed through the Apple bridge layer. The initial bridge will be a child `Process` plus paired `Pipe` streams so the implementation plan has a concrete transport target. That transport can be replaced later without changing the shell-facing runner contract.

This branch is intentionally desktop-first:

- It proves the native shell direction quickly.
- It forces the host and protocol split early.
- It lets mobile benefit from the backend standardization without blocking on a mobile UI rewrite.

## Error Handling

The host layer should centralize startup, shutdown, and fatal-error reporting so desktop and mobile stop inventing separate lifecycle behavior.

Requirements:

- Runner startup failures surface a single structured startup error to the shell.
- Host-ready state is explicit and emitted once.
- Transport disconnects are surfaced as lifecycle events, not hidden logs.
- Host shutdown should be idempotent.
- Capability failures should return typed errors where possible.
- Playback resolution failures should be distinct from player failures.
- Storage initialization failures should stop startup before the shell enters a connected state.
- Permission failures should surface a stable code and a shell-actionable reason.
- Protocol version mismatch should fail fast at handshake time.
- Retryable transport failures should be marked retryable and non-destructive.
- Offline or replication-lag states should be distinguishable from hard failures.
- Shell reconnect behavior should be explicit: reconnect on transport loss, do not silently retry after fatal startup failure.

The native shell should be able to show:

- host start failure
- storage unavailable
- permission denied
- protocol version mismatch
- disconnected or degraded backend state
- offline or waiting-for-replication state
- missing playback URL
- player load failure

without needing to understand backend internals.

Typed error codes for the initial protocol surface:

- `HOST_START_FAILED`
- `STORAGE_INIT_FAILED`
- `PERMISSION_DENIED`
- `TRANSPORT_DISCONNECTED`
- `PROTOCOL_VERSION_MISMATCH`
- `CAPABILITY_UNAVAILABLE`
- `OFFLINE_UNAVAILABLE`
- `REPLICATION_TIMEOUT`
- `PLAYBACK_URL_UNAVAILABLE`
- `PLAYER_LOAD_FAILED`

## Testing and Verification Strategy

This branch is a skeleton-first migration, so verification focuses on structure first and behavior second.

Structural verification:

- `packages/host` can boot the backend using a supplied duplex stream.
- Mobile and desktop adapters compile against the same host-launch interface.
- Protocol wrappers can be used without direct dependency on Pear-specific globals.

Behavior verification for the first native slice:

- The macOS app can launch and connect to the host.
- Browse lists load through the shared protocol.
- Video detail data loads through the shared protocol.
- A selected video can resolve a playback URL and play through `AVPlayer`.

Because this repository restricts build and install commands to explicit requests, implementation-phase build and test commands should be run deliberately once the plan is approved.

## Migration Phases For This Plan

### Phase 0: Branch and spec

- Create a dedicated worktree and branch.
- Write and review this design.
- Convert the design into an implementation plan before code changes begin.

### Phase 1: Shared host and protocol skeleton

- Add `packages/host`.
- Add `packages/protocol`.
- Refactor existing platform code to depend on these new layers.
- Preserve current behavior as much as possible.

Success criteria:

- Mobile and desktop can target the same host-launch contract.
- The backend is no longer bootstrapped in multiple incompatible ways.

### Phase 2: Desktop runner parity

- Add a desktop runner abstraction that mirrors the mobile host-launch API.
- Move desktop-specific transport setup behind that runner.

Success criteria:

- Desktop and mobile use the same host bootstrap API.
- Pear-specific wiring is pushed to the edge.

### Phase 3: Native macOS shell

- Add `packages/desktop-native`.
- Implement browse, detail, and play.
- Use `AVPlayer` for initial playback.

Success criteria:

- The native macOS app launches.
- Browse to detail to play works against the shared host.

## First Files to Change

The migration should start by extracting and wrapping existing seams rather than building new UI immediately.

Priority order:

1. [packages/backend/src/backend-entry.js](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/backend-entry.js)
2. [packages/platform/src/rpc.native.ts](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/platform/src/rpc.native.ts)
3. [packages/platform/src/rpc.web.ts](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/platform/src/rpc.web.ts)
4. [packages/app/pear-src/worker-client.js](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/app/pear-src/worker-client.js)
5. [packages/app/backend/index.mjs](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/app/backend/index.mjs)
6. [packages/backend/src/hrpc-handlers.js](/Users/jd/.config/superpowers/worktrees/peartube/codex-native-desktop-host-skeleton/packages/backend/src/hrpc-handlers.js)

That order keeps the branch aligned with the real goal: one backend model, then one runner model, then a native shell on top.

## Risks

- The current HRPC schema mixes domain and shell behaviors, so boundary cleanup may expose more coupling than expected.
- The native shell will need a stable Apple-side bridge to the shared host before UI work can move quickly.
- Video playback may surface assumptions in the current app that were implicitly handled by the web or Pear environment.
- Keeping the old desktop path as fallback reduces delivery risk but increases temporary duplication.

## Explicitly Deferred

The following work is intentionally out of scope for the first implementation plan and should be covered by a follow-on spec after the skeleton lands:

- settings parity
- subscriptions parity beyond what browse requires
- studio and upload UI in the native shell
- downloads management UI
- diagnostics and advanced tooling surfaces
- retirement of the old desktop path

## Recommendation

Proceed with a desktop-first skeleton migration on `codex/native-desktop-host-skeleton`, centered on `packages/host` and `packages/protocol`, with a parallel Swift macOS shell as the first new client.

This gives PearTube the backend standardization it needs immediately, while creating a credible path away from Electron without forcing a full UI rewrite on every platform at once.
