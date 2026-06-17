// Deterministic synthetic feed data shaped like PearTube's real discover feed,
// so the workloads exercise the same field accesses, regex tests and shapes the
// app hits on every feed update. Seeded so all engines see identical input.

import { makeRng } from './harness.mjs'

const HEX = '0123456789abcdef'

function hexKey(rng, len = 64) {
  let s = ''
  for (let i = 0; i < len; i++) s += HEX[(rng() * 16) | 0]
  return s
}

function makePreviewVideo(rng, i) {
  const hasBlob = rng() > 0.25
  const ready = rng() > 0.4
  return {
    id: `vid-${(rng() * 1e9) | 0}`,
    title: `Video ${i} ${hexKey(rng, 8)}`,
    uploadedAt: 1_700_000_000_000 + ((rng() * 1e9) | 0),
    duration: (rng() * 3600) | 0,
    thumbnail: rng() > 0.5 ? `thumb:${hexKey(rng, 16)}` : null,
    blobId: hasBlob ? `${(rng() * 1e6) | 0}` : null,
    blobsCoreKey: hasBlob ? hexKey(rng, 64) : null,
    mimeType: 'video/mp4',
    availability: ready ? 'playable' : 'partial',
    byteAvailability: ready ? 'playable' : 'pending',
    readyForPlayback: ready && rng() > 0.5,
    hasHeadBlock: ready,
    contiguousBlocks: ready ? (rng() * 5000) | 0 : 0,
    sourcePlatform: rng() > 0.6 ? 'youtube' : null,
    sourceCreatorName: rng() > 0.6 ? `creator-${(rng() * 1000) | 0}` : null,
    sourceViewCount: (rng() * 1e7) | 0,
    sourcePublishedAt: 1_600_000_000_000 + ((rng() * 1e9) | 0),
    sourceMetadataJson: rng() > 0.7 ? JSON.stringify({ tags: ['a', 'b', hexKey(rng, 6)] }) : null,
  }
}

export function makeFeed({ entries = 200, previewsPerEntry = 8, seed = 0xc0ffee } = {}) {
  const rng = makeRng(seed)
  const feed = new Array(entries)
  for (let e = 0; e < entries; e++) {
    const previewVideos = new Array(previewsPerEntry)
    for (let p = 0; p < previewsPerEntry; p++) previewVideos[p] = makePreviewVideo(rng, p)
    const driveKey = hexKey(rng, 64)
    feed[e] = {
      driveKey,
      channelKey: driveKey,
      publicBeeKey: rng() > 0.15 ? hexKey(rng, 64) : null,
      channelName: `channel ${e} ${hexKey(rng, 6)}`,
      source: rng() > 0.85 ? 'local' : 'gossip',
      peerCount: (rng() * 12) | 0,
      videoCount: previewsPerEntry,
      manifestUpdatedAt: 1_700_000_000_000 + ((rng() * 1e9) | 0),
      version: (rng() * 50) | 0,
      previewVideos,
    }
  }
  return feed
}

export { hexKey }
