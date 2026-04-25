# PearTube Drive Engine Spike Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Validate a radically simpler PearTube architecture where each identity/channel is a Hyperdrive, discovered/indexed through distributed-drive, while hypercore-blob-server handles sparse HTTP range playback for video files.

**Architecture:** Build a throwaway spike under `packages/drive-engine-spike/` without touching the production app/backend path. The spike must prove golden path A: peer A creates a channel Hyperdrive and writes a video; peer B discovers/replicates it, indexes metadata, and streams the video through `hypercore-blob-server` using range requests. `distributed-drive` is used for unified drive discovery/list/read of small records, not for video byte streaming.

**Tech Stack:** Corestore, Hyperdrive, Hyperswarm, distributed-drive, hypercore-blob-server, local HTTP/curl validation, Node/Bare-compatible JS.

---

## Design decisions from interview

- Product goal: cross-platform support out of the box.
- Core runtime invariant: Bare-first worker/engine, host adapters thin.
- Core/capabilities split: core handles identity/storage/networking/channel drive/feed/comments/reactions/thumbnails/downloads; heavier capabilities like transcoding/casting/search/recommendations stay optional/lazy.
- Long-term data model: every identity/channel owns its own drive. The app builds validated derived views over drives.
- Comments/reactions live in the author/commenter/reactor drive, targeting another channel/video by key/id.
- v0 avoids multi-device/device-grant complexity. Start with one writable drive per identity/channel; keep schemas forward-compatible with future device grants.
- Video files should live in Hyperdrive long-term if sparse range playback validates.
- `distributed-drive@0.1.1` was inspected and validated locally for list/get/read, but its remote read path buffers requested data into a single RPC response. Therefore it is unsuitable as the large-video byte pump.
- `hypercore-blob-server` supports Hyperdrive filename links and sparse HTTP range serving, so it should serve video files from Hyperdrive by `{ driveKey, filename }`.

---

## Acceptance criteria

The spike is successful only if all of these are true:

1. Peer A creates a Hyperdrive-backed channel drive.
2. Peer A writes:
   - `/profile.json`
   - `/videos/v1/video.json`
   - `/videos/v1/source.mp4`
3. Peer A announces/replicates drive data over Hyperswarm.
4. Peer B discovers or receives Peer A's drive key through the spike's discovery path.
5. Peer B can list/read metadata through the drive/distributed-drive layer.
6. Peer B creates a local `hypercore-blob-server` over its Corestore.
7. Peer B generates a playback URL with:
   ```js
   blobServer.getLink(aliceDriveKey, { filename: '/videos/v1/source.mp4' })
   ```
8. `curl -H 'Range: bytes=0-65535' <url>` returns `206 Partial Content` and the expected byte count.
9. A larger range request does not require full-file download first.
10. Results and limitations are documented in `packages/drive-engine-spike/RESULTS.md`.

---

## Task 1: Create the spike package skeleton

**Objective:** Add an isolated package for validation without touching production code paths.

**Files:**
- Create: `packages/drive-engine-spike/package.json`
- Create: `packages/drive-engine-spike/README.md`
- Create: `packages/drive-engine-spike/src/.gitkeep`

**Implementation notes:**

`package.json` should include scripts:

```json
{
  "name": "@peartube/drive-engine-spike",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/*.test.mjs",
    "demo:peer-a": "node src/peer-a.mjs",
    "demo:peer-b": "node src/peer-b.mjs"
  },
  "dependencies": {
    "b4a": "^1.8.0",
    "corestore": "^7.9.2",
    "distributed-drive": "^0.1.1",
    "hypercore": "^11.28.1",
    "hypercore-blob-server": "^1.12.0",
    "hyperdrive": "^13.3.2",
    "hypercore-crypto": "^3.6.1",
    "hyperswarm": "^4.17.0"
  }
}
```

**Verification:**

Run:

```bash
npm install --prefix packages/drive-engine-spike
npm test --prefix packages/drive-engine-spike
```

Expected: test command runs successfully, even if no tests exist yet or a placeholder test is added.

---

## Task 2: Add record schemas and validation helpers

**Objective:** Define minimal forward-compatible JSON records for channel profile and video metadata.

**Files:**
- Create: `packages/drive-engine-spike/src/schema.mjs`
- Create: `packages/drive-engine-spike/test/schema.test.mjs`

**Required API:**

```js
export function createProfileRecord({ channelKey, name, createdAt })
export function createVideoRecord({ channelKey, id, title, filename, byteLength, mimeType, createdAt })
export function validateProfileRecord(record)
export function validateVideoRecord(record)
export function videoRecordPath(id)
```

**Record shape:**

```js
{
  type: 'peartube.profile',
  schemaVersion: 1,
  channelKey,
  name,
  createdAt
}
```

```js
{
  type: 'peartube.video',
  schemaVersion: 1,
  channelKey,
  id,
  title,
  filename: `/videos/${id}/source.mp4`,
  byteLength,
  mimeType,
  createdAt
}
```

**Tests:**

- Profile validation accepts a valid profile.
- Video validation accepts valid metadata.
- Video validation rejects path traversal filenames.
- `videoRecordPath('v1')` returns `/videos/v1/video.json`.

**Verification:**

Run:

```bash
npm test --prefix packages/drive-engine-spike -- test/schema.test.mjs
```

Expected: all schema tests pass.

---

## Task 3: Create a Hyperdrive channel writer

**Objective:** Write profile/video metadata and a deterministic sample video file into a Hyperdrive.

**Files:**
- Create: `packages/drive-engine-spike/src/channel-drive.mjs`
- Create: `packages/drive-engine-spike/test/channel-drive.test.mjs`

**Required API:**

```js
export async function createChannelDrive({ storagePath, name })
export async function writeSampleVideo({ drive, channelKey, id, title, size })
export async function readJson(drive, filename)
```

**Implementation notes:**

- Use `Corestore(storagePath)` and `Hyperdrive(store)`.
- `await drive.ready()` before writes.
- Derive `channelKey` from `drive.key` as hex.
- Write sample bytes to `/videos/v1/source.mp4`; include a recognizable header string like `PEARTUBE_DRIVE_ENGINE_SPIKE`.
- Write metadata to `/videos/v1/video.json`.

**Tests:**

- Created drive has a key.
- Profile record exists and validates.
- Video record exists and validates.
- Source file can be read back locally and starts with the expected header.

**Verification:**

Run:

```bash
npm test --prefix packages/drive-engine-spike -- test/channel-drive.test.mjs
```

Expected: all tests pass.

---

## Task 4: Validate hypercore-blob-server sparse serving from a local Hyperdrive

**Objective:** Prove `hypercore-blob-server` can serve a Hyperdrive file by filename with HTTP range support.

**Files:**
- Create: `packages/drive-engine-spike/src/blob-playback.mjs`
- Create: `packages/drive-engine-spike/test/blob-playback.test.mjs`

**Required API:**

```js
export async function createBlobPlaybackServer({ store })
export function getHyperdriveFileUrl({ server, driveKey, filename, mimeType })
```

**Tests:**

- Start a blob server on a random local port.
- Generate a URL for `/videos/v1/source.mp4` using the Hyperdrive key.
- Use Node `fetch` with `Range: bytes=0-31`.
- Assert status is `206`.
- Assert `Content-Range` exists.
- Assert body starts with expected sample header.

**Verification:**

Run:

```bash
npm test --prefix packages/drive-engine-spike -- test/blob-playback.test.mjs
```

Expected: `206 Partial Content` test passes.

---

## Task 5: Add two-peer replication harness

**Objective:** Prove Peer B can sparsely stream a file from Peer A's Hyperdrive through its own blob server after Corestore replication.

**Files:**
- Create: `packages/drive-engine-spike/src/two-peer-harness.mjs`
- Create: `packages/drive-engine-spike/test/two-peer-harness.test.mjs`

**Required API:**

```js
export async function createReplicatedPeers({ basePath })
export async function connectPeers(peerA, peerB)
export async function waitForRangeReadable({ url, timeoutMs })
```

**Implementation notes:**

- For deterministic tests, use a direct in-memory duplex stream or local TCP pair first, not public DHT.
- Each peer gets its own Corestore.
- On connection, call `store.replicate(conn)` on both sides.
- Peer A writes the channel Hyperdrive.
- Peer B creates `BlobServer(peerB.store)` and calls `getLink(peerA.drive.key, { filename })`.

**Tests:**

- Peer B can range-fetch Peer A's source file via Peer B's local blob server.
- Peer B does not have to read the full file through distributed-drive.

**Verification:**

Run:

```bash
npm test --prefix packages/drive-engine-spike -- test/two-peer-harness.test.mjs
```

Expected: range fetch succeeds from Peer B local server.

---

## Task 6: Add distributed-drive metadata view validation

**Objective:** Prove distributed-drive can list/read small metadata records across connected peers while video bytes stay on blob-server.

**Files:**
- Create: `packages/drive-engine-spike/src/distributed-view.mjs`
- Create: `packages/drive-engine-spike/test/distributed-view.test.mjs`

**Required API:**

```js
export function createDistributedView(...drives)
export async function listEntries(view, prefix)
export async function readJsonFromView(view, filename)
```

**Implementation notes:**

- Use `distributed-drive` over a direct duplex stream first.
- Register Peer A's Hyperdrive or a namespaced wrapper exposing Peer A drive paths.
- Validate whether plain distributed-drive path merging loses drive identity.
- If collisions occur, document that a namespace wrapper is required.

**Tests:**

- Peer B can list Peer A's `/profile.json` and `/videos/v1/video.json`.
- Peer B can read/validate Peer A's video metadata.
- Test documents whether returned entries include enough source identity. If not, mark as known limitation and use explicit drive-key routing in the spike.

**Verification:**

Run:

```bash
npm test --prefix packages/drive-engine-spike -- test/distributed-view.test.mjs
```

Expected: metadata listing/reading works; any source-identity limitation is captured in assertions or `RESULTS.md`.

---

## Task 7: Add real Hyperswarm demo scripts

**Objective:** Validate the same model over real Hyperswarm connections outside unit tests.

**Files:**
- Create: `packages/drive-engine-spike/src/peer-a.mjs`
- Create: `packages/drive-engine-spike/src/peer-b.mjs`

**Behavior:**

`peer-a.mjs`:
- Creates/writes a sample Hyperdrive.
- Prints channel drive key.
- Joins `drive.discoveryKey` or a deterministic spike topic.
- Replicates store on swarm connections.

`peer-b.mjs`:
- Accepts drive key as CLI arg.
- Joins the drive discovery key.
- Starts local blob server.
- Prints playback URL for `/videos/v1/source.mp4`.
- Optionally performs a built-in range fetch and prints status/headers.

**Verification:**

Terminal 1:

```bash
npm run demo:peer-a --prefix packages/drive-engine-spike
```

Terminal 2:

```bash
npm run demo:peer-b --prefix packages/drive-engine-spike -- <drive-key>
```

Then:

```bash
curl -v -H 'Range: bytes=0-65535' '<printed-url>' -o /tmp/peartube-range.bin
```

Expected:
- HTTP `206`
- `Content-Range` header
- output file is 65536 bytes
- first bytes include sample header

---

## Task 8: Document results and architecture decision

**Objective:** Capture whether the architecture is viable and what the migration path should be.

**Files:**
- Create: `packages/drive-engine-spike/RESULTS.md`
- Modify: this plan if actual findings require an update

**RESULTS.md must include:**

- Dependency versions tested.
- Whether Hyperdrive filename serving through `hypercore-blob-server` works.
- Whether sparse range playback works between two peers.
- Whether distributed-drive preserves enough source identity for PearTube indexing.
- Memory/streaming caveats.
- Recommended production architecture.
- Migration steps from current PearTube backend.

**Verification:**

Run full spike tests:

```bash
npm test --prefix packages/drive-engine-spike
```

Expected: all tests pass and `RESULTS.md` is complete enough for a future implementation agent.

---

## Initial production migration outline if spike passes

1. Add `packages/engine` as the new Bare-first runtime boundary.
2. Add Hyperdrive identity/channel drive creation and write APIs.
3. Add validator/indexer for profile/video/comment/reaction records.
4. Replace feed source with discovered drive keys + validated index.
5. Replace upload path with Hyperdrive file writes.
6. Replace playback path with `hypercore-blob-server.getLink(driveKey, { filename })`.
7. Move comments/reactions to author-drive records.
8. Only then start deleting old public-feed/Autobase/comment/feed-hydration code.
9. Add future device grants/multi-device merge after golden path is stable.

---

## Non-goals for this spike

- No React Native app changes.
- No Pear desktop UI changes.
- No production API rewrites.
- No multi-device grants.
- No comments/reactions implementation yet.
- No transcoding/casting/search/recommendations.
- No attempt to preserve current backend API surface.
