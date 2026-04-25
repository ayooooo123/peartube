# PearTube Drive Engine Spike Results

Date: 2026-04-24

## Verdict

The core architecture is viable enough to continue.

Validated model:

```text
Hyperdrive = identity/channel filesystem source of truth
hypercore-blob-server = sparse HTTP playback from Hyperdrive files
distributed-drive = useful for small metadata discovery/list/read, not video bytes
engine validator/indexer = required trusted state layer above raw drive views
```

The most important validation passed: a reader peer can range-serve a writer peer's Hyperdrive file through the reader's own `hypercore-blob-server` while the underlying Corestores are replicating.

## Dependency versions tested

From `packages/drive-engine-spike/package.json`:

- `corestore`: `^7.9.2`
- `hyperdrive`: `^13.3.2`
- `hypercore`: `^11.28.1`
- `hypercore-blob-server`: `^1.12.0`
- `distributed-drive`: `^0.1.1`
- `hyperswarm`: `^4.17.0`
- `hypercore-crypto`: `^3.6.1`
- `b4a`: `^1.8.0`

## Tests implemented

Run:

```bash
npm test --prefix packages/drive-engine-spike
```

Current result:

```text
# tests 11
# pass 11
# fail 0
```

Coverage:

- Profile/video record schema validation.
- Path traversal rejection for video filenames.
- Hyperdrive channel writer creates `/profile.json`, `/videos/v1/video.json`, `/videos/v1/source.mp4`.
- Local `hypercore-blob-server` serves a Hyperdrive file by filename with `206 Partial Content`.
- Two-peer Corestore replication allows Peer B's blob server to range-serve Peer A's Hyperdrive video file.
- `distributed-drive` can list/read remote Hyperdrive metadata records.
- `distributed-drive` entries do not expose source drive identity by default.

## Key findings

### 1. Hyperdrive filename playback works

This works:

```js
blobServer.getLink(driveKey, {
  filename: '/videos/v1/source.mp4',
  type: 'video/mp4'
})
```

A normal HTTP Range request returns `206 Partial Content` and the expected bytes.

### 2. Sparse remote playback through replicated Corestore works

The spike creates:

```text
Peer A Corestore + Hyperdrive + source.mp4
Peer B Corestore + BlobServer
Peer A store.replicate(true) <-> Peer B store.replicate(false)
Peer B BlobServer URL for Peer A drive key + filename
```

Peer B successfully range-fetches:

```text
bytes=0-63
bytes=1048576-1048639
```

from Peer A's file through Peer B's local blob server.

This is the decisive proof for the proposed video path.

### 3. distributed-drive is fine for metadata, not video bytes

`distributed-drive@0.1.1` can list/read remote Hyperdrive metadata in the spike:

```text
/profile.json
/videos/v1/video.json
/videos/v1/source.mp4 entry metadata
```

But source inspection showed remote `read()`/`createReadStream()` buffers requested data into a single RPC response. It should not be used as the video byte streaming layer.

Use it for:

- profile records
- video metadata records
- comments/reactions records
- moderation records
- subscriptions/follows records
- small thumbnails if desired
- discovery/indexing experiments

Do not use it for:

- `source.mp4` playback
- large file streaming
- uncapped full-file reads

### 4. distributed-drive loses source identity in flat views

The spike test confirms returned entries have keys like:

```text
/profile.json
/videos/v1/video.json
```

but no `driveKey` or `peer` field by default.

For PearTube, a production engine probably needs one of:

1. A namespaced wrapper exposing each channel as `/<driveKey>/...`.
2. A custom registry/indexer that tracks `{ driveKey, path, entry }` outside distributed-drive.
3. A fork/patch of distributed-drive to preserve source identity in list responses.

Do not let UI consume raw distributed-drive entries directly.

### 5. Test temp storage should avoid `/tmp`

The environment's `/tmp` is a tmpfs and hit quota during the spike. Package tests now set:

```bash
TMPDIR=$PWD/.tmp
```

inside the package test script.

## Recommended production architecture

```text
packages/engine
  Core Bare-first runtime
  Owns Corestore, Hyperdrive registry, Hyperswarm, BlobServer
  Validates records from drives
  Indexes trusted views
  Exposes typed APIs/events to hosts

packages/host
  BareKit/Pear/native/headless launch adapters

packages/protocol
  Typed RPC/event schema between host UI and engine

packages/app / packages/desktop-native
  UI only; no raw distributed-drive walking
```

Data model:

```text
<channel-drive>/profile.json
<channel-drive>/videos/<videoId>/video.json
<channel-drive>/videos/<videoId>/source.mp4
<channel-drive>/videos/<videoId>/thumbnail.jpg
<commenter-drive>/comments/<targetChannelKey>/<targetVideoId>/<commentId>.json
<reactor-drive>/reactions/<targetChannelKey>/<targetVideoId>/<reactionId>.json
<creator-drive>/moderation/...
```

Playback path:

```text
engine resolves video record -> { driveKey, filename, mimeType }
engine returns BlobServer URL
player issues HTTP Range requests
BlobServer sparsely fetches Hyperdrive file blocks through Corestore replication
```

## Migration recommendation

Do not rewrite production yet. Next steps:

1. Promote spike concepts into a new `packages/engine` with strict package boundaries.
2. Build a headless engine API for golden path A:
   - create identity/channel drive
   - write video file + metadata
   - announce/discover drive key
   - get feed/indexed videos
   - get playback URL
3. Add tests equivalent to the spike inside `packages/engine`.
4. Wire one desktop/headless host to the engine before touching mobile UI.
5. Only after golden path works end-to-end, replace current upload/playback/feed paths.
6. Delay multi-device grants until one-drive-per-identity v0 is stable.

## Open questions

- Should production use `distributed-drive` directly, a wrapper, or a small custom drive registry preserving source identity?
- How should public drive key announcements work: public swarm topic, signed announcements, or both?
- Should thumbnails be ordinary Hyperdrive files or generated/cache-only files?
- How should offline mirroring policy work per drive/video?
- Does the full Hyperdrive + BlobServer stack bundle and start cleanly inside BareKit on Android/iOS?

## Bottom line

The rearchitecture is no longer just a nice idea. The hard playback primitive works:

```text
remote Hyperdrive file -> replicated Corestore -> local hypercore-blob-server -> HTTP range playback
```

That is strong enough to justify building a real `packages/engine` prototype next.
