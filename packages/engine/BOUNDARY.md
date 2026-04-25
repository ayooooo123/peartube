# @peartube/engine Boundary

`@peartube/engine` is the production-bound core runtime for the new PearTube architecture. It is intentionally headless and Bare-first.

## Owns

- Corestore lifecycle.
- Identity/channel Hyperdrive creation and opening.
- Canonical PearTube records under drive paths:
  - `/profile.json`
  - `/videos/<videoId>/video.json`
  - `/videos/<videoId>/source.mp4`
  - `/videos/<videoId>/thumbnail`
- Record validation and derived indexed views.
- Blob-server playback URLs for Hyperdrive files.
- Corestore replication plumbing, including Hyperswarm discovery/join wrappers.

## Does not own

- React Native, Expo Router, Pear UI, or desktop-native UI code.
- Player UI state, navigation, route params, or component rendering.
- Transcoding, casting, recommendations, or ML search in the core startup path.
- Old `public-feed` hydration behavior or UI feed-card reconciliation.
- Direct user-account/device-grant complexity beyond one writable drive per identity/channel v0.

## Runtime rule

Hosts are thin adapters:

```text
React Native / Pear / native UI
  -> host adapter
  -> protocol/RPC surface
  -> @peartube/engine
  -> Hyperdrive/Corestore/BlobServer/Hyperswarm
```

The engine must be importable by Bare/mobile without static imports of Node-only modules that are not available at startup. Node-only helpers, such as local filesystem file import, must lazy-load their dependencies or live in host adapters.

## UI rule

UI must not walk raw Hyperdrive or `distributed-drive` views directly.

Bad:

```text
UI -> distributedDrive.list('/') -> render cards
```

Good:

```text
UI -> engine.listVideos()/engine.getVideoUrl()/engine events -> render typed state
```

## distributed-drive rule

`distributed-drive` remains optional until its source-identity issue is solved. The spike proved it can list/read small Hyperdrive metadata records, but default flat entries do not include the source drive key.

Allowed uses:

- discovery/indexing experiments
- small metadata reads
- possible future source-identity-preserving wrapper

Forbidden uses:

- large video byte streaming
- direct UI API
- anything that requires uncapped remote `read()` over large files

## Playback rule

Video playback is always:

```text
engine resolves { driveKey, filename, mimeType }
engine returns hypercore-blob-server URL
player issues HTTP Range requests
Corestore replication fetches sparse Hyperdrive blocks
```

Do not stream video bytes through `distributed-drive` RPC.

## Migration rule

Do not delete old Autobase/public-feed/comment/feed-hydration code until the engine has a host adapter proving this golden path end-to-end:

1. create/open identity channel drive
2. write/import video bytes and metadata
3. announce/discover drive key
4. replicate to second peer
5. list/index video metadata
6. play via local blob-server range URL
7. handle thumbnails
8. expose the flow through protocol/RPC to at least one host
