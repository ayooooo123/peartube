# Single-Topic Discovery Design

Date: 2026-03-29
Status: Proposed
Owner: Codex

## Summary

PearTube mobile startup is no longer dominated by backend initialization, but peer discovery is still too slow to be useful at cold start. The current app joins multiple app-level topics during startup and performs eager feed and channel hydration before the first peer is available. That adds DHT churn and local work without improving time-to-first-useful-peer.

This design moves PearTube to a single app-level discovery topic, `peartube-network`, and runs the public feed protocol directly over shared swarm connections using Protomux. The system becomes connection-driven: once a swarm connection exists, the feed protocol opens immediately on that connection and exchanges `HAVE_FEED` state without waiting for a second discovery topic.

The startup sequence is also simplified: restore cached feed state immediately, defer non-essential warming until the first useful peer arrives, and stage feed hydration so the app does not burn startup time on duplicate `loadChannel` and `loadPublicBee` work before discovery succeeds.

## Problem Statement

Observed Android startup traces show:

- Backend readiness now happens in under 2 seconds.
- `dht.bootstrapped` often remains `false` for roughly 5 seconds after backend ready.
- The startup path currently joins `peartube-network` and `peartube-public-feed-v1`.
- `PublicFeedManager.requestFeedsFromPeers()` runs at startup even when there are zero feed channels open.
- The UI repeatedly triggers `getChannelMeta`, `loadPublicBee`, and `loadChannel` for the same cached feed entries before the first peer is available.
- In topic-only mode, cold-start peer discovery is eventually successful, but not fast enough.

The current architecture therefore pays for:

1. Extra app-level discovery work at cold start.
2. A startup-time feed request that is often a no-op.
3. Early channel and feed hydration work that competes with discovery and adds no value before the first connection exists.

## Goals

- Keep discovery topic-based only.
- Do not use configured bootstraps, explicit peer seeds, or relay-only startup shortcuts.
- Reduce time-to-first-useful-peer by minimizing app-level startup work.
- Make the first swarm connection immediately useful for feed exchange.
- Preserve cached feed visibility on cold start.
- Stage network hydration so it follows connection readiness instead of preceding it.
- Use existing Holepunch primitives and keep the startup-critical path lightweight.

## Non-Goals

- Guarantee deterministic first-peer latency in a topic-only network.
- Change Hypercore or Hyperbee discovery keys used for actual replication.
- Replace the existing public feed message format with a request/response RPC stack.
- Preserve mixed-version compatibility with peers that still require `peartube-public-feed-v1`.

## Constraints

- Topic-only discovery is a hard product constraint.
- The Swift desktop app, CLI relay, and mobile runtime will migrate together.
- The public feed protocol should remain lightweight and gossip-oriented.
- Startup should not assume any peer is reachable at cold launch.

## Chosen Approach

### Chosen Architecture

Use a single app-level discovery topic, `peartube-network`, across mobile, desktop, and relay. Remove the separate `peartube-public-feed-v1` discovery join. Continue using Protomux on shared swarm connections, but make the public feed protocol connection-scoped instead of topic-scoped.

The connection model becomes:

1. Join `peartube-network`.
2. Wait for `swarm.connection`.
3. Attach Protomux to that connection.
4. Open the public feed protocol immediately.
5. Exchange `HAVE_FEED` on channel open.
6. Begin staged hydration only after useful network state exists.

### Why This Approach

- It removes one DHT announce and lookup path from cold start.
- It matches how feed exchange already works in practice: over shared encrypted swarm connections.
- It makes "first peer" immediately useful.
- It aligns with the existing `FederatedSearch` pairing pattern already present in the codebase.
- It reduces startup work without changing the replication model for public bees, channels, or blobs.

## Alternatives Considered

### 1. Keep Two Topics but Delay Feed Topic Join

This lowers migration risk but preserves a redundant architecture. It also keeps the product paying for a second app-level discovery surface that should not be necessary once all runtimes share the same multiplexed connection model.

Rejected because it improves startup less and leaves long-term complexity in place.

### 2. Use Bootstraps or Explicit Relay Peers

This would improve cold-start reliability but violates the product constraint that discovery remain topic-based only.

Rejected by design constraint.

### 3. Move Public Feed to Protomux RPC

The public feed exchange is state gossip, not request/response business logic. `protomux-rpc` and related router/middleware libraries are better fits for admin or diagnostic methods, not for the first-peer feed path.

Rejected for the hot path, though still viable later for diagnostics.

## Protocol / Library Decisions

### Protomux

Continue to use raw `protomux` for the public feed protocol. Refactor the feed channel setup to follow the same `mux.pair(...)` plus local `createChannel(...)` pattern used by `FederatedSearch`.

This provides:

- clean reuse of a shared swarm connection
- idempotent channel setup on current and future connections
- symmetry across peers without requiring an extra discovery surface

### Protomux-Wakeup

Keep `protomux-wakeup` for per-capability content announcements after peers are connected. It remains useful for fast content propagation and does not conflict with the single-topic discovery model.

### Protomux RPC Libraries

Do not put the public feed on `protomux-rpc`, `protomux-rpc-router`, or related middleware on the startup-critical path. Those libraries may still be useful later for diagnostics, operator commands, or peer introspection.

## Detailed Design

### 1. Discovery Surfaces

#### Current

- `peartube-network` for peer pool building
- `peartube-public-feed-v1` for public feed discovery

#### Proposed

- `peartube-network` only

All app runtimes join only `peartube-network` at startup and retain the discovery handle for the app lifetime.

The following remain unchanged:

- PublicBee discovery keys
- channel discovery keys
- blobs core discovery keys
- wakeup capabilities

Those are replication topics, not app-level peer discovery topics.

### 2. Public Feed Manager

`PublicFeedManager` stops owning app-level discovery. It becomes a connection-scoped protocol manager with three responsibilities:

- restore and persist feed state
- attach the feed protocol to swarm connections
- merge and broadcast feed state

`start()` changes semantics:

- restore cached published and discovered channels
- notify listeners if cached entries exist
- attach protocol handling to existing connections
- do not call `swarm.join(...)`

The manager will no longer join `peartube-public-feed-v1`.

### 3. Feed Protocol Lifecycle

On every `swarm.connection`:

1. Create or retrieve the Protomux instance from the stream.
2. Pair the public feed protocol.
3. Create the local channel if needed.
4. Open it immediately.
5. On channel open, send `HAVE_FEED`.

This means the first usable connection automatically causes feed exchange.

`requestFeedsFromPeers()` remains valid for manual refresh, but it is no longer part of startup sequencing. It will only send on channels that are already open.

### 4. Orchestrator Startup Flow

#### Current

- initialize storage
- start public feed
- request feeds from peers
- begin background warming

#### Proposed

- initialize storage
- restore cached feed state
- mark backend ready
- wait for first peer / first feed channel open
- then begin staged warming

The orchestrator should not call `publicFeed.requestFeedsFromPeers()` during startup anymore. That call often happens before any feed channel exists.

### 5. Startup Gating

Introduce explicit discovery and sync milestones:

- `swarm_ready`
- `first_swarm_peer`
- `first_feed_channel_open`
- `first_feed_sync_received`

These are backend lifecycle markers, not UI states. They let the backend control when expensive work is allowed to start.

### 6. Staged Hydration

Hydration becomes connection-aware.

#### Stage 0: Cold Start, No Peer Yet

- Restore cached feed entries immediately.
- Render cached feed content.
- Do not eagerly warm subscriptions, pins, or seeding channels.
- Avoid broad `loadChannel` and `loadPublicBee` work for the entire feed.

#### Stage 1: First Peer / First Feed Channel

- Exchange `HAVE_FEED`.
- Merge entries and notify listeners immediately.
- Refresh only visible or explicitly requested feed entries.

#### Stage 2: First Useful Sync

- Refresh `PublicBee` state for visible feed entries.
- Warm subscribed and pinned channels in the background.

#### Stage 3: Deferred Background Work

- Resume broader warm-up work after the network has already proven useful.

This shifts startup from "hydrate everything before any peer exists" to "hydrate what matters after the network can help."

### 7. Cached Feed Hydration Follow-Up

The first implementation pass should prioritize real peer discovery speed. After that lands, cached feed hydration should be tightened further by persisting a richer feed snapshot and reducing duplicate refresh work.

Follow-up work should include:

- persist feed entry snapshots with display metadata
- dedupe in-flight `loadPublicBee` and `getChannelMeta` work
- hydrate only visible feed entries first
- avoid repeated full-feed refresh loops during mount/remount

This is intentionally second after the single-topic migration.

## Failure Handling

### No Peer Found

If no peer is found, the app remains in cached-feed mode. No retry storm or secondary discovery topic is used.

### Peer Connected but Feed Channel Not Yet Open

The feed protocol is paired and opened on the connection immediately. The connection itself is the trigger; no startup-time one-shot request is required.

### Connection Drops

The feed channel is cleaned up and the system waits for the next peer. Cached feed content remains available.

### Duplicate Feed State

`HAVE_FEED` merges remain idempotent. Restored cache plus live feed sync should not create duplicate entries.

## Compatibility and Migration

This is a coordinated migration across:

- Expo / BareKit mobile
- Swift native desktop app
- CLI relay

No mixed-version compatibility window is required. Peers are expected to migrate together.

Migration steps:

1. Move all runtimes to join `peartube-network` only.
2. Remove feed-topic joins from all runtimes.
3. Keep feed exchange protocol over Protomux on shared connections.
4. Remove startup-time feed request assumptions based on the old topic model.

## API and Code Impact

Expected code changes include:

- remove app-level use of `FEED_TOPIC_STRING`
- refactor `PublicFeedManager.start()` to stop joining the feed topic
- update connection handling to use `mux.pair(...)` style setup
- remove orchestrator startup call to `requestFeedsFromPeers()`
- gate background channel warming behind first useful peer state
- update swarm status diagnostics to report the single discovery topology
- migrate the Swift desktop app and CLI relay to the same topology

## Testing Strategy

### Unit / Integration

- verify `PublicFeedManager` no longer joins a separate feed topic
- verify a new swarm connection opens a feed channel and sends `HAVE_FEED`
- verify existing connections present before `start()` also receive a feed channel
- verify `requestFeedsFromPeers()` sends only on open channels
- verify feed state persists and restores correctly without the old topic

### Multi-Peer Tests

- two-peer mobile/relay or relay/desktop startup with a shared `peartube-network`
- first swarm connection triggers feed sync without `peartube-public-feed-v1`
- staged warming does not begin before first useful peer state

### Regression Checks

- startup logs show only one app-level discovery topic join
- no startup-time `Sent HAVE_FEED to 0 peers` path in orchestrator initialization
- reduced duplicate `loadChannel` and `loadPublicBee` churn before first peer

## Risks

- Topic-only cold-start latency remains non-deterministic because no bootstrap peers are allowed.
- A coordinated migration means old peers on the old topology will not be discovered.
- If staged warming is gated too aggressively, some useful background sync may happen later than before.

These risks are acceptable under the current product constraints and are lower than continuing to pay for redundant startup work.

## Success Criteria

The migration is successful when:

- mobile cold start joins only `peartube-network`
- the first swarm connection automatically opens the feed protocol
- feed sync does not depend on a second discovery topic
- early startup no longer warms broad channel sets before the first peer exists
- time-to-first-useful-peer is improved relative to the current two-topic design

## Open Follow-Up

After this migration lands, the next design and implementation pass should focus on cached feed hydration quality:

- richer persisted feed snapshots
- visible-first metadata hydration
- deduped `PublicBee` loading
- fewer repeated mount-time backend requests
