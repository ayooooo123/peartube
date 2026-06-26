import assert from 'node:assert/strict'
import test from 'node:test'

import { getFeedPreviewVideos } from '../lib/feed-hydration.js'

test('getFeedPreviewVideos preserves canonical preview metadata after a restart-style restoration', () => {
  const videos = getFeedPreviewVideos([
    {
      driveKey: 'remote-channel',
      publicBeeKey: 'bb'.repeat(32),
      peerCount: 0,
      previewVideos: [{
        id: 'preview-video',
        title: 'Canonical preview title',
        uploadedAt: 42,
        byteAvailability: 'playable',
        availability: 'unknown',
        blobId: '0:1:0:32',
        blobsCoreKey: 'cc'.repeat(32),
        mimeType: 'video/mp4',
        hasHeadBlock: true,
        contiguousBlocks: 1,
        readyForPlayback: true,
      }],
    },
  ], {
    'remote-channel': {
      name: 'Remote channel',
      avatar: '/avatars/remote.png',
      icon: '/icons/remote.png',
    },
  }, 'local-channel', 10)

  assert.equal(videos.length, 1)
  assert.deepEqual({
    id: videos[0].id,
    title: videos[0].title,
    byteAvailability: videos[0].byteAvailability,
    blobId: videos[0].blobId,
    blobsCoreKey: videos[0].blobsCoreKey,
    mimeType: videos[0].mimeType,
    hasHeadBlock: videos[0].hasHeadBlock,
    contiguousBlocks: videos[0].contiguousBlocks,
    readyForPlayback: videos[0].readyForPlayback,
    channelKey: videos[0].channelKey,
    driveKey: videos[0].driveKey,
    publicBeeKey: videos[0].publicBeeKey,
    channel: videos[0].channel,
  }, {
    id: 'preview-video',
    title: 'Canonical preview title',
    byteAvailability: 'playable',
    blobId: '0:1:0:32',
    blobsCoreKey: 'cc'.repeat(32),
    mimeType: 'video/mp4',
    hasHeadBlock: true,
    contiguousBlocks: 1,
    readyForPlayback: true,
    channelKey: 'remote-channel',
    driveKey: 'remote-channel',
    publicBeeKey: 'bb'.repeat(32),
    channel: {
      name: 'Remote channel',
      avatar: '/avatars/remote.png',
      icon: '/icons/remote.png',
    },
  })
})
