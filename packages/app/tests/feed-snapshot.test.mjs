import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createFeedSnapshot,
  getSnapshotChannelKeys,
  restoreFeedSnapshot,
} from '../lib/feed-snapshot.js'

test('createFeedSnapshot stores only safe renderable feed card fields', () => {
  const snapshot = createFeedSnapshot({
    now: 1000,
    identityDriveKey: 'local-channel',
    channelMeta: {
      remote: { name: 'Remote channel' },
    },
    videos: [
      {
        id: 'remote-playable',
        title: 'Remote playable',
        channelKey: 'remote',
        uploadedAt: 20,
        availability: 'playable',
        blobId: 'blob-a',
        blobsCoreKey: 'core-a',
        url: 'http://do-not-store.example/video.mp4',
      },
      {
        id: 'remote-unknown',
        channelKey: 'remote',
        uploadedAt: 30,
        availability: 'unknown',
      },
      {
        id: 'local-draft',
        title: 'Local draft',
        channelKey: 'local-channel',
        uploadedAt: 10,
        availability: 'unknown',
        channel: { name: 'Me' },
      },
    ],
  })

  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.savedAt, 1000)
  assert.deepEqual(snapshot.videos.map((video) => ({
    id: video.id,
    channelKey: video.channelKey,
    availability: video.availability,
    channelName: video.channel?.name,
    hasUrl: Object.hasOwn(video, 'url'),
  })), [
    {
      id: 'remote-playable',
      channelKey: 'remote',
      availability: 'playable',
      channelName: 'Remote channel',
      hasUrl: false,
    },
    {
      id: 'local-draft',
      channelKey: 'local-channel',
      availability: 'playable',
      channelName: 'Me',
      hasUrl: false,
    },
  ])
})

test('createFeedSnapshot refuses to restore direct blob cards without byte proof', () => {
  const snapshot = createFeedSnapshot({
    now: 1000,
    videos: [
      {
        id: 'metadata-only',
        title: 'Metadata only',
        channelKey: 'remote',
        uploadedAt: 20,
        availability: 'playable',
        byteAvailability: 'playable',
        blobId: '0:1:0:32',
        blobsCoreKey: 'aa'.repeat(32),
      },
      {
        id: 'ready',
        title: 'Ready',
        channelKey: 'remote',
        uploadedAt: 10,
        availability: 'playable',
        byteAvailability: 'playable',
        blobId: '0:1:0:32',
        blobsCoreKey: 'bb'.repeat(32),
        hasHeadBlock: true,
        contiguousBlocks: 1,
        readyForPlayback: true,
      },
    ],
  })

  assert.deepEqual(snapshot.videos.map((video) => ({
    id: video.id,
    hasHeadBlock: video.hasHeadBlock,
    contiguousBlocks: video.contiguousBlocks,
    readyForPlayback: video.readyForPlayback,
  })), [{
    id: 'ready',
    hasHeadBlock: true,
    contiguousBlocks: 1,
    readyForPlayback: true,
  }])
})

test('restoreFeedSnapshot rejects stale or unsupported snapshots', () => {
  assert.deepEqual(restoreFeedSnapshot(null), [])
  assert.deepEqual(restoreFeedSnapshot({ version: 999, savedAt: 1000, videos: [] }, { now: 1000 }), [])
  assert.deepEqual(restoreFeedSnapshot({ version: 1, savedAt: 1000, videos: [{ id: 'old' }] }, {
    now: 1000 + 100,
    maxAgeMs: 99,
  }), [])
})

test('restoreFeedSnapshot dedupes and marks restored cards as snapshot sourced', () => {
  const restored = restoreFeedSnapshot({
    version: 1,
    savedAt: 1000,
    videos: [
      { id: 'a', channelKey: 'remote', uploadedAt: 20, availability: 'playable' },
      { id: 'a', channelKey: 'remote', uploadedAt: 10, availability: 'playable' },
      { id: 'b', driveKey: 'remote-b', uploadedAt: 5, availability: 'playable', __feedSource: 'hydrated' },
    ],
  }, { now: 1200 })

  assert.deepEqual(restored.map((video) => ({
    id: video.id,
    channelKey: video.channelKey,
    driveKey: video.driveKey,
    source: video.__feedSource,
  })), [
    { id: 'a', channelKey: 'remote', driveKey: undefined, source: 'snapshot' },
    { id: 'b', channelKey: undefined, driveKey: 'remote-b', source: 'snapshot' },
  ])
})

test('getSnapshotChannelKeys returns unique channel keys for restored cards', () => {
  assert.deepEqual(getSnapshotChannelKeys([
    { id: 'a', channelKey: 'remote-a' },
    { id: 'b', driveKey: 'remote-b' },
    { id: 'c', channelKey: 'remote-a' },
    { id: 'd' },
  ]), ['remote-a', 'remote-b'])
})

test('createFeedSnapshot stores relay archive source metadata fields', () => {
  const snapshot = createFeedSnapshot({
    now: 1000,
    videos: [{
      id: 'archived',
      title: 'Archived video',
      channelKey: 'relay-channel',
      uploadedAt: 20,
      availability: 'playable',
      byteAvailability: 'playable',
      blobId: '0:1:0:32',
      blobsCoreKey: 'aa'.repeat(32),
      hasHeadBlock: true,
      contiguousBlocks: 1,
      readyForPlayback: true,
      sourcePlatform: 'youtube',
      sourcePlatformLabel: 'YouTube',
      sourceUrl: 'https://www.youtube.com/watch?v=archived',
      sourceId: 'archived',
      sourceCreatorName: 'Emergency Awesome',
      sourceCreatorHandle: '@emergencyawesome',
      sourceCreatorUrl: 'https://www.youtube.com/@emergencyawesome',
      sourcePublishedAt: 900,
      sourceViewCount: 75080,
      sourceLikeCount: 2200,
      sourceCommentCount: 341,
      sourceArchivedAt: 950,
      sourceRelayId: 'relay-a',
      sourceMetadataJson: '{"platform":"youtube"}',
      sourcePrivateToken: 'do-not-store',
    }],
  })

  assert.deepEqual(snapshot.videos.map((video) => ({
    id: video.id,
    sourcePlatform: video.sourcePlatform,
    sourceCreatorHandle: video.sourceCreatorHandle,
    sourceViewCount: video.sourceViewCount,
    sourceMetadataJson: video.sourceMetadataJson,
    hasPrivateToken: Object.hasOwn(video, 'sourcePrivateToken'),
  })), [{
    id: 'archived',
    sourcePlatform: 'youtube',
    sourceCreatorHandle: '@emergencyawesome',
    sourceViewCount: 75080,
    sourceMetadataJson: '{"platform":"youtube"}',
    hasPrivateToken: false,
  }])
})
