# PearTube Engine Prototype Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Promote the validated drive-engine spike into a real `@peartube/engine` package that can become the Bare-first core runtime for all platforms.

**Architecture:** Start with a headless engine package. Reuse the validated primitives from `packages/drive-engine-spike`: Hyperdrive identity/channel filesystem, `hypercore-blob-server` playback URLs, schema validation, and Corestore replication. Do not wire production app/backend yet. Keep APIs small and typed-by-shape: create/open local identity drive, write video file, index local/remote drive records, return playback URLs.

**Tech Stack:** Node/Bare-compatible ESM JavaScript, Corestore, Hyperdrive, hypercore-blob-server, Node test runner.

---

## Acceptance criteria

- `packages/engine` exists as an isolated package.
- `npm test --prefix packages/engine` passes.
- Engine can create a local channel drive with `/profile.json`.
- Engine can write a video file and `/videos/<id>/video.json`.
- Engine can open a remote drive by key and return a blob-server playback URL for a remote Hyperdrive filename.
- Engine tests prove the golden path with two Corestores replicating in-memory.
- No React Native/Expo/Pear UI code imports the engine yet.

---

## Task 1: Create engine package skeleton

**Files:**
- Create: `packages/engine/package.json`
- Create: `packages/engine/README.md`
- Create: `packages/engine/src/index.mjs`
- Create: `packages/engine/test/smoke.test.mjs`
- Create: `packages/engine/.gitignore`

**Requirements:**

`package.json` should include:

```json
{
  "name": "@peartube/engine",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.mjs",
  "exports": { ".": "./src/index.mjs" },
  "scripts": {
    "test": "mkdir -p .tmp && TMPDIR=$PWD/.tmp node --test test/*.test.mjs"
  },
  "dependencies": {
    "b4a": "^1.8.0",
    "corestore": "^7.9.2",
    "hypercore": "^11.28.1",
    "hypercore-blob-server": "^1.12.0",
    "hyperdrive": "^13.3.2"
  }
}
```

**Verification:**

```bash
npm install --prefix packages/engine
npm test --prefix packages/engine
```

---

## Task 2: Add record schema helpers

**Files:**
- Create: `packages/engine/src/schema.mjs`
- Create: `packages/engine/test/schema.test.mjs`

**API:**

```js
createProfileRecord({ channelKey, name, createdAt })
createVideoRecord({ channelKey, id, title, filename, byteLength, mimeType, createdAt })
validateProfileRecord(record)
validateVideoRecord(record)
videoRecordPath(id)
videoSourcePath(id)
```

This can be ported from the spike, but keep it package-local until contracts settle.

---

## Task 3: Add Engine lifecycle and channel creation

**Files:**
- Create: `packages/engine/src/engine.mjs`
- Test: `packages/engine/test/engine-lifecycle.test.mjs`
- Modify: `packages/engine/src/index.mjs`

**API:**

```js
const engine = await createEngine({ storagePath, name })
engine.channelKey
engine.drive
engine.store
await engine.close()
```

On create, write `/profile.json` if missing.

---

## Task 4: Add video write API

**Files:**
- Modify: `packages/engine/src/engine.mjs`
- Test: `packages/engine/test/video-write.test.mjs`

**API:**

```js
await engine.writeVideo({ id, title, bytes, mimeType })
```

Writes:

```text
/videos/<id>/source.mp4
/videos/<id>/video.json
```

---

## Task 5: Add playback URL API

**Files:**
- Modify: `packages/engine/src/engine.mjs`
- Test: `packages/engine/test/playback-url.test.mjs`

**API:**

```js
await engine.startBlobServer()
engine.getPlaybackUrl({ driveKey, filename, mimeType })
```

Must return a URL accepted by HTTP Range requests.

---

## Task 6: Add two-peer golden-path test

**Files:**
- Test: `packages/engine/test/two-peer-golden-path.test.mjs`
- Optional create: `packages/engine/test/helpers/replication.mjs`

Test:

- Engine A writes a video.
- Engine B opens Engine A drive by key using B's Corestore.
- A/B stores replicate in-memory.
- Engine B blob server returns `206` for A's video filename.

---

## Task 7: Document engine boundary

**Files:**
- Create: `packages/engine/BOUNDARY.md`

Must state:

- Engine owns Hyperdrive/Corestore/BlobServer/indexing.
- UI never walks raw distributed-drive.
- `distributed-drive` remains optional until source-identity issue is solved.
- Video playback path is BlobServer by `{ driveKey, filename }`.
