# PearTube Backend P2P Storage Audit

This document is a repo-backed audit of how PearTube uses the Hypercore stack in the backend:

- Hypercore (append-only logs)
- Corestore (key management + replication multiplexer)
- Hyperbee (KV index / materialized view)
- Autobase (multi-writer coordination)
- Hyperblobs + hypercore-blob-server (byte storage + streaming)
- Hyperswarm (peer discovery + encrypted connections)

Scope:

- Backend runtime: `packages/backend/src/*`
- Mobile/Desktop worker entry: `packages/app/backend/index.mjs`
- RPC schema (for what data crosses the boundary): `packages/spec/spec/hrpc/*`

Non-goals:

- UI/UX details
- Full threat model for the whole app (this is storage/replication focused)

## Architecture At A Glance

The backend maintains three distinct layers of channel/video data:

1) Channel Autobase (authoritative, multi-writer)
2) PublicBee (viewer fast-path, single-writer Hyperbee)
3) Hyperblobs (video bytes + thumbnails, per-device Hypercore)

The public discovery feed should only require (2) + (3) for viewing.

High level map:

```
Corestore(storagePath)
|
|-- Hyperbee(metaDb)           [local-only app state]
|     core name: "peartube-meta" (created in initializeStorage)
|
|-- MultiWriterChannel         [authoritative channel state]
|     Autobase(bootstrapKey=channelKey)
|     view: Hyperbee(core name "view" inside Autobase open callback)
|     security: writer membership + op author verification
|
|-- PublicChannelBee (PublicBee)   [public viewer fast-path]
|     Hyperbee over a dedicated Hypercore
|     key is published and gossiped via public feed
|
|-- Hyperblobs per device
      Hyperblobs over per-device Hypercore
      referenced by blobId + blobsCoreKey in video metadata
```

Entry-point wiring:

- Backend context initialization is `createBackendContext()` in `packages/backend/src/orchestrator.js`.
- The public discovery topic/protocol constants are in `packages/backend/src/types.js`.

## Core Components (Where Things Live)

### Storage Context

Storage initialization happens in `initializeStorage()` in `packages/backend/src/storage.js`.

The storage context (`ctx`) contains:

- `store`: Corestore
- `metaDb`: Hyperbee for local metadata
- `swarm`: Hyperswarm for peer discovery + connection transport
- `blobServer`: hypercore-blob-server for HTTP streaming
- `channels`: in-memory cache of loaded channels

Type reference: `packages/backend/src/types.js` (`StorageContext`).

### Public Feed (Discovery)

Discovery runs via `PublicFeedManager` in `packages/backend/src/public-feed.js`.

- Uses a Hyperswarm join topic derived from `FEED_TOPIC_STRING`.
- Exchanges channel keys over Protomux protocol `PROTOCOL_NAME`.

Constants:

- `FEED_TOPIC_STRING = 'peartube-public-feed-v1'`
- `PROTOCOL_NAME = 'peartube-feed'`

Defined in `packages/backend/src/types.js`.

### MultiWriterChannel (Channel Autobase)

Channel implementation is `MultiWriterChannel` in `packages/backend/src/channel/multi-writer-channel.js`.

- Backed by Autobase (multi-writer)
- Materializes a deterministic Hyperbee view via Autobase `open()` callback
- Stores channel metadata, videos, writer membership, invites, etc.

### PublicChannelBee (PublicBee)

Public viewer index is `PublicChannelBee` in `packages/backend/src/channel/public-channel-bee.js`.

- Hyperbee over a dedicated Hypercore
- Intended to auto-replicate via Corestore replication (`store.replicate(conn)`), without Autobase
- Stores:
  - `meta` (public channel metadata)
  - `videos/<videoId>` (public video metadata)

### Hyperblobs (Video Bytes)

Video bytes are stored in Hyperblobs.

- Upload module description: `packages/backend/src/upload.js`.
- Public link generation + serving is managed by `hypercore-blob-server` in `packages/backend/src/storage.js`.

### CommentsAutobase (Open Participation)

Comments are implemented as a separate Autobase instance per channel:

- `packages/backend/src/channel/comments-autobase.js`

The comments Autobase uses a Hyperbee view (keyed by `comments/<videoId>/<commentId>`).

## Data Models

### Public Feed Entry

Backend feed entries are held in memory by `PublicFeedManager` and returned via `createApi().getPublicFeed()` in `packages/backend/src/api.js`.

Over HRPC, feed entries support a `publicBeeKey` field:

- Encoding is defined in `packages/spec/spec/hrpc/messages.js` under `@peartube/get-public-feed-response`.

Pre-alpha direction (fast discovery, no legacy fallbacks):

- Feed entries must include `publicBeeKey` so viewers can read via PublicBee without loading channel Autobase.

### PublicBee Metadata

PublicBee stores channel metadata at key `meta`:

- `PublicChannelBee.getMetadata()` / `.setMetadata()` in `packages/backend/src/channel/public-channel-bee.js`.

This metadata is written by the channel owner device and read by viewers.

### PublicBee Videos

PublicBee stores video metadata under `videos/<videoId>`:

- `PublicChannelBee.putVideo(videoId, metadata)`
- `PublicChannelBee.listVideos()`

Both in `packages/backend/src/channel/public-channel-bee.js`.

### Video Bytes (Hyperblobs)

Video blobs are identified by a blob pointer of 4 numeric fields (blockOffset, blockLength, byteOffset, byteLength) as described in `packages/backend/src/upload.js`.

Blob server URL generation and swarm-joining for blob cores happens in API functions like `getVideoUrl(...)` in `packages/backend/src/api.js`.

## Replication & Discovery

### Corestore Replication (Base Layer)

Corestore replication is established on each Hyperswarm connection inside storage initialization:

- `packages/backend/src/storage.js` sets up `store.replicate(conn)` in the swarm connection handler.

This is what allows:

- PublicBee cores to replicate automatically
- Hyperblobs cores to replicate automatically

### Autobase Replication (Channel Layer)

Autobase requires explicit replication wiring:

- `MultiWriterChannel.setupPairing()` in `packages/backend/src/channel/multi-writer-channel.js` installs connection handlers that call `this.base.replicate(conn)`.

Additionally, `loadChannel()` in `packages/backend/src/storage.js` includes logic to replicate cached channels on new connections.

### Feed Protocol

Public feed uses Protomux over swarm connections:

- `PublicFeedManager.setupFeedProtocol()` / `createFeedChannel()` / `sendHaveFeed()` / `handleMessage()` in `packages/backend/src/public-feed.js`.

In pre-alpha, the fastest/safest mechanism is:

- Only gossip channels that carry `publicBeeKey`.

## Security Boundaries

### PublicBee

PublicBee is single-writer:

- Writes are allowed only when the core is writable (the owner device). This is enforced by Hypercore/Hyperbee writability and by `PublicChannelBee.setMetadata/putVideo/deleteVideo` throwing if not writable.

See `packages/backend/src/channel/public-channel-bee.js`.

### MultiWriterChannel

Channel Autobase is multi-writer with explicit membership:

- Writers are stored in the channel view ("writers" keyspace), and operations are validated during apply.
- Author verification uses `verifyOpAuthor` from `packages/backend/src/channel/op-signing.js` (referenced by `comments-autobase.js`, and used in the channel apply path).

Primary implementation: `packages/backend/src/channel/multi-writer-channel.js`.

### CommentsAutobase

Comments Autobase is "open participation" (optimistic writes + moderation/ack patterns):

- Implemented in `packages/backend/src/channel/comments-autobase.js`.

## Worker Boundary (Mobile/Desktop)

The app talks to the backend via HRPC.

Handlers are implemented in `packages/app/backend/index.mjs`.

Important RPC methods for discovery:

- `rpc.onGetPublicFeed` (calls `api.getPublicFeed()`)
- `rpc.onListVideos` (calls `api.listVideos(channelKey, publicBeeKey)`)
- `rpc.onGetChannelMeta` (calls `api.getChannelMeta(channelKey, publicBeeKey)`)

HRPC message encodings:

- `@peartube/get-public-feed-response` includes `publicBeeKey`
- `@peartube/list-videos-request` includes `publicBeeKey`
- `@peartube/get-channel-meta-request` includes `publicBeeKey`

See `packages/spec/spec/hrpc/messages.js`.

## Performance Characteristics

### PublicBee

PublicBee is designed for:

- fast reads
- no Autobase replays
- minimal coordination

Replication is best-effort: `PublicChannelBee.waitForSync(...)` uses bounded `core.update({ wait: true, timeout })`.

See `packages/backend/src/channel/public-channel-bee.js`.

### Autobase

Autobase reads are heavier:

- require `base.replicate(conn)` wiring
- can require apply/view materialization

This is why discovery should not depend on Autobase for viewer listing.

## Known Gaps / Audit Notes

### Hyperdrive

In the backend source tree (`packages/backend/src`), there are no `hyperdrive` imports/usages (searched via repo grep).

The current implementation uses:

- Corestore + Autobase + Hyperbee + PublicBee + Hyperblobs

### Strict PublicBee-Only Discovery

If you enforce PublicBee-only discovery (recommended for speed + reduced attack surface), then:

- A channel must be published with a valid `publicBeeKey` to appear in the public feed.
- Viewers never need to load the channel Autobase.

This is the intended direction for a pre-alpha “fast discovery” iteration.

## File Index

- `packages/backend/src/orchestrator.js` (backend init)
- `packages/backend/src/storage.js` (corestore/metaDb/swarm/blobServer + channel load/create)
- `packages/backend/src/api.js` (RPC-facing API surface)
- `packages/backend/src/public-feed.js` (discovery gossip over swarm/protomux)
- `packages/backend/src/channel/multi-writer-channel.js` (Autobase channel)
- `packages/backend/src/channel/public-channel-bee.js` (PublicBee)
- `packages/backend/src/channel/comments-autobase.js` (Comments Autobase)
- `packages/backend/src/upload.js` (upload -> blobs + metadata)
- `packages/app/backend/index.mjs` (HRPC handlers)
- `packages/spec/spec/hrpc/messages.js` (wire schema)
