import test from 'brittle'

import {
  CANONICAL_FEED_CHANNEL_FIELDS,
  CANONICAL_FEED_CONTRACT_VERSION,
  CANONICAL_FEED_ENTRY_FIELDS,
  CANONICAL_FEED_VIDEO_FIELDS,
  createCanonicalFeedEntry,
  createCanonicalFeedEnvelope,
  createCanonicalFeedVideo,
} from '../src/canonical-feed-contract.js'

test('canonical feed contract exposes the canonical surface fields', (t) => {
  t.is(CANONICAL_FEED_CONTRACT_VERSION, 1)
  t.alike(CANONICAL_FEED_CHANNEL_FIELDS, [
    'channelKey',
    'driveKey',
    'name',
    'description',
    'avatar',
    'icon',
    'thumbnail',
    'videoCount',
    'lastSeen',
    'manifestUpdatedAt',
  ])
  t.alike(CANONICAL_FEED_VIDEO_FIELDS, [
    'id',
    'path',
    'title',
    'description',
    'uploadedAt',
    'duration',
    'thumbnail',
    'thumbnailUrl',
    'thumbnailBlobId',
    'thumbnailBlobsCoreKey',
    'thumbnailMimeType',
    'blobId',
    'blobsCoreKey',
    'mimeType',
    'availability',
    'byteAvailability',
    'channelKey',
    'driveKey',
    'publicBeeKey',
    'channel',
  ])
  t.alike(CANONICAL_FEED_ENTRY_FIELDS, [
    'channelKey',
    'driveKey',
    'publicBeeKey',
    'source',
    'relayRole',
    'relayServing',
    'peerCount',
    'videoCount',
    'lastSeen',
    'manifestUpdatedAt',
    'previewVideosHash',
    'channel',
    'previewVideos',
  ])
})

test('createCanonicalFeedVideo preserves titles, icons, and blob references', (t) => {
  const video = createCanonicalFeedVideo({
    id: 'video-1',
    path: '/videos/demo.mp4',
    title: 'Canonical title',
    description: 'Canonical description',
    uploadedAt: 123,
    duration: 456,
    thumbnail: '/thumbs/demo.jpg',
    thumbnailUrl: 'http://localhost/thumbs/demo.jpg',
    thumbnailBlobId: 'thumb-blob',
    thumbnailBlobsCoreKey: '11'.repeat(32),
    thumbnailMimeType: 'image/jpeg',
    blobId: 'video-blob',
    blobsCoreKey: '22'.repeat(32),
    mimeType: 'video/mp4',
    availability: 'playable',
    byteAvailability: 'playable',
    channelKey: '33'.repeat(32),
    publicBeeKey: '44'.repeat(32),
    channel: {
      channelKey: '33'.repeat(32),
      driveKey: '33'.repeat(32),
      name: 'Channel name',
      description: 'Channel description',
      avatar: '/avatars/channel.jpg',
      icon: '/icons/channel.png',
      thumbnail: '/thumbnails/channel.jpg',
      videoCount: 12,
      lastSeen: 789,
      manifestUpdatedAt: 987,
    },
  })

  t.is(video.title, 'Canonical title')
  t.is(video.channel?.avatar, '/avatars/channel.jpg')
  t.is(video.channel?.icon, '/icons/channel.png')
  t.is(video.blobId, 'video-blob')
  t.is(video.blobsCoreKey, '22'.repeat(32))
  t.is(video.publicBeeKey, '44'.repeat(32))
})

test('createCanonicalFeedEnvelope normalizes nested entries and videos', (t) => {
  const envelope = createCanonicalFeedEnvelope({
    savedAt: 1234,
    identityDriveKey: '55'.repeat(32),
    entries: [{
      channelKey: '66'.repeat(32),
      source: 'peer',
      channel: { name: 'Channel', avatar: '/avatar.jpg', icon: '/icon.png' },
      previewVideos: [{ id: 'preview-1', title: 'Preview', uploadedAt: 1, channelKey: '66'.repeat(32) }],
    }],
    videos: [{ id: 'video-2', title: 'Video', uploadedAt: 2, channelKey: '66'.repeat(32) }],
    channelMetaByKey: {
      ['66'.repeat(32)]: { name: 'Channel', avatar: '/avatar.jpg', icon: '/icon.png' },
    },
  })

  t.is(envelope.version, 1)
  t.is(envelope.savedAt, 1234)
  t.is(envelope.identityDriveKey, '55'.repeat(32))
  t.is(envelope.entries[0].previewVideos[0].title, 'Preview')
  t.is(envelope.videos[0].title, 'Video')
  t.is(envelope.channelMetaByKey['66'.repeat(32)].icon, '/icon.png')
})
