# @peartube/engine

Bare-first replacement spine for PearTube's old Autobase/Hyperbee-heavy backend stack.

## Current surface

```js
import { createEngine } from '@peartube/engine'

const owner = await createEngine({ storagePath: './store', name: 'PearTube User' })

const video = await owner.writeVideo({
  title: 'Hello',
  description: 'demo upload',
  bytes: Buffer.from('...'),
  mimeType: 'video/mp4',
  category: 'demo'
})

const videos = await owner.listVideos()
const url = await owner.getVideoUrl(video.id) // local blob-server URL, supports Range
```

Open a replicated/read-only channel by key:

```js
const viewer = await createEngine({ storagePath: './viewer', channelKey: owner.channelKey })
```

See `BOUNDARY.md` for the migration boundary: engine owns storage/network/playback/indexing; UI and hosts consume typed APIs only.

## Migration readiness checklist

Implemented and covered by tests:

- Local writable channel creation backed by one Hyperdrive.
- Profile record creation/validation.
- Video byte + metadata writes with canonical paths.
- Old-stack compatible video metadata aliases (`size`, `uploadedAt`, `description`, `category`, media dimensions).
- Generated upload IDs for new videos.
- Local file import with MIME sniffing.
- Newest-first video listing.
- Video byte reads.
- Video metadata get/update/delete operations.
- Thumbnail byte writes, metadata updates, and thumbnail playback URLs.
- Local blob-server playback URLs with HTTP Range support.
- Remote channel open-by-key and in-process Corestore replication smoke test.
- Hyperswarm discovery/join wrapper around Corestore replication via `startDiscovery(...)`.
- Core engine module avoids static `node:fs/promises` imports so Bare/mobile can load byte-based APIs.

Still required before deleting the old backend:

- Real Hyperswarm two-process smoke demo using `startDiscovery(...)`.
- Mobile host file-picker/import adapter that hands bytes into `writeVideo(...)` without Node `fs`.
- Replace in-memory Corestore replication test with Hyperswarm end-to-end discovery.
- Renderer/backend adapter replacing the old HRPC handlers one by one.
- Migration script/importer for existing old-stack channels, if we need to preserve current user data.
