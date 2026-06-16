import test from 'brittle'

import { createApi } from '../src/api.js'
import { createCanonicalFeedVideo } from '../src/canonical-feed-contract.js'
import { hashPreviewVideos } from '../src/hash-utils.js'
import { PublicFeed } from '../src/public-feed.js'

const DRIVE_KEY = 'aa'.repeat(32)
const PUBLIC_BEE_KEY = 'bb'.repeat(32)
const BLOBS_CORE_KEY = 'cc'.repeat(32)

function createSourcePreview(overrides = {}) {
  return {
    id: 'yt-demo',
    title: 'Archived title',
    uploadedAt: 1700000000000,
    duration: 620,
    blobId: '0:8:0:1024',
    blobsCoreKey: BLOBS_CORE_KEY,
    mimeType: 'video/mp4',
    availability: 'playable',
    byteAvailability: 'playable',
    hasHeadBlock: true,
    contiguousBlocks: 8,
    readyForPlayback: true,
    sourcePlatform: 'youtube',
    sourcePlatformLabel: 'YouTube',
    sourceUrl: 'https://www.youtube.com/watch?v=yt-demo',
    sourceId: 'yt-demo',
    sourceCreatorName: 'Emergency Awesome',
    sourceCreatorHandle: '@emergencyawesome',
    sourceCreatorUrl: 'https://www.youtube.com/@emergencyawesome',
    sourcePublishedAt: 1699913600000,
    sourceViewCount: 75080,
    sourceLikeCount: 2200,
    sourceCommentCount: 341,
    sourceArchivedAt: 1700000300000,
    sourceRelayId: 'relay-a',
    sourceMetadataJson: '{"platform":"youtube","id":"yt-demo"}',
    ...overrides,
  }
}

test('PublicFeed relay catalog previews preserve normalized source metadata', async (t) => {
  const feed = new PublicFeed({ keyPair: {}, connections: new Set() }, {
    async get() { return null },
    async put() {},
  })

  await feed.submitRelayCatalogEntry({
    driveKey: DRIVE_KEY,
    publicBeeKey: PUBLIC_BEE_KEY,
    channelName: 'Relay archive',
    previewVideos: [createSourcePreview()],
  })

  const [entry] = feed.getFeed()
  t.is(entry.source, 'relay-cache')
  t.is(entry.previewVideos[0].sourcePlatform, 'youtube')
  t.is(entry.previewVideos[0].sourcePlatformLabel, 'YouTube')
  t.is(entry.previewVideos[0].sourceCreatorHandle, '@emergencyawesome')
  t.is(entry.previewVideos[0].sourceViewCount, 75080)
  t.is(entry.previewVideos[0].sourceArchivedAt, 1700000300000)
  t.is(entry.previewVideos[0].sourceMetadataJson, '{"platform":"youtube","id":"yt-demo"}')
})

test('hashPreviewVideos changes when source metadata changes', (t) => {
  const base = hashPreviewVideos([createSourcePreview({ sourceViewCount: 75080 })])
  const changed = hashPreviewVideos([createSourcePreview({ sourceViewCount: 75081 })])

  t.unlike(base, changed)
})

test('canonical feed video preserves source metadata fields', (t) => {
  const video = createCanonicalFeedVideo({
    ...createSourcePreview(),
    channelKey: DRIVE_KEY,
    publicBeeKey: PUBLIC_BEE_KEY,
  })

  t.is(video.sourcePlatform, 'youtube')
  t.is(video.sourceCreatorName, 'Emergency Awesome')
  t.is(video.sourceViewCount, 75080)
  t.is(video.sourceMetadataJson, '{"platform":"youtube","id":"yt-demo"}')
})

test('getPublicFeed returns relay archive source metadata in preview videos', (t) => {
  const api = createApi({
    ctx: {},
    publicFeed: {
      getFeed() {
        return [{
          driveKey: DRIVE_KEY,
          publicBeeKey: PUBLIC_BEE_KEY,
          source: 'relay-cache',
          relayRole: 'cache',
          relayServing: true,
          addedAt: 1,
          previewVideos: [createSourcePreview()],
        }]
      },
      getStats() {
        return { totalEntries: 1, hiddenCount: 0, peerCount: 0 }
      },
    },
  })

  const result = api.getPublicFeed()
  t.is(result.entries[0].previewVideos[0].sourcePlatform, 'youtube')
  t.is(result.entries[0].previewVideos[0].sourceCreatorHandle, '@emergencyawesome')
  t.is(result.entries[0].previewVideos[0].sourceViewCount, 75080)
})
