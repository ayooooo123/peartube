import test from 'brittle'

import {
  CANONICAL_FEED_CHANNEL_FIELDS,
  CANONICAL_FEED_CONTRACT_VERSION,
  CANONICAL_FEED_ENTRY_FIELDS,
  CANONICAL_FEED_VIDEO_FIELDS,
  createCanonicalFeedEnvelope,
  createCanonicalFeedVideo,
} from '../src/canonical-feed-contract.js'
import {
  normalizeCanonicalFeedVideo,
  normalizeCanonicalFeedVideoFromLocalUpload,
  normalizeCanonicalFeedVideoFromPreviewHydration,
  normalizeCanonicalFeedVideoFromPublicFeed,
} from '../src/canonical-feed.js'

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
    'creatorName',
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
    'hasHeadBlock',
    'contiguousBlocks',
    'readyForPlayback',
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

test('normalizeCanonicalFeedVideo preserves mixed raw inputs and channel fallback precedence', (t) => {
  const video = normalizeCanonicalFeedVideo({
    id: 7,
    title: null,
    name: 'Mixed input title',
    description: 'Raw description',
    uploadedAt: '123',
    duration: '456',
    thumbnailUrl: 'http://localhost/thumbs/raw.jpg',
    blobId: 'video-blob',
    blobsCoreKey: '22'.repeat(32),
    mimeType: 'video/mp4',
    availability: 'unknown',
    byteAvailability: 'playable',
    playbackSupport: 'blocked',
    channel: {
      channelKey: 'raw-channel',
      driveKey: 'raw-drive',
      name: 'Raw channel',
      description: 'Raw channel description',
      avatar: '/raw-avatar.png',
      icon: '/raw-icon.png',
      thumbnail: '/raw-thumbnail.png',
      videoCount: '11',
      lastSeen: '789',
      manifestUpdatedAt: '987',
    },
    channelName: 'Ignored scalar channel name',
    channelAvatar: '/ignored-avatar.png',
    channelIcon: '/ignored-icon.png',
    publicBeeKey: '44'.repeat(32),
  }, {
    source: 'preview-hydration',
    channel: {
      channelKey: 'option-channel',
      driveKey: 'option-drive',
      name: 'Option channel',
      avatar: '/option-avatar.png',
      icon: '/option-icon.png',
    },
    channelMeta: {
      channelKey: 'meta-channel',
      driveKey: 'meta-drive',
      name: 'Meta channel',
      avatar: '/meta-avatar.png',
      icon: '/meta-icon.png',
    },
    channelKey: 'option-channel',
    driveKey: 'option-drive',
    publicBeeKey: '55'.repeat(32),
  })

  t.is(video.id, '7')
  t.is(video.title, 'Mixed input title')
  t.is(video.channelKey, 'raw-channel')
  t.is(video.driveKey, 'raw-drive')
  t.is(video.channel?.name, 'Raw channel')
  t.is(video.channel?.avatar, '/raw-avatar.png')
  t.is(video.channel?.icon, '/raw-icon.png')
  t.is(video.channel?.thumbnail, '/raw-thumbnail.png')
  t.is(video.channel?.videoCount, 11)
  t.is(video.channel?.lastSeen, 789)
  t.is(video.channel?.manifestUpdatedAt, 987)
  t.is(video.availability, 'unknown')
  t.is(video.byteAvailability, 'playable')
  t.is(video.publicBeeKey, '44'.repeat(32))
})

test('normalizeCanonicalFeedVideoFromLocalUpload keeps local upload channel metadata intact', (t) => {
  const video = normalizeCanonicalFeedVideoFromLocalUpload({
    id: 100,
    title: 'Local upload',
    uploadedAt: 9,
    availability: 'playable',
    byteAvailability: 'playable',
    blobId: 'local-blob',
    blobsCoreKey: '88'.repeat(32),
    mimeType: 'video/mp4',
    channelKey: 'local-channel',
    driveKey: 'local-channel',
  }, {
    channelKey: 'local-channel',
    driveKey: 'local-channel',
    name: 'Local channel',
    avatar: '/local-avatar.png',
    icon: '/local-icon.png',
  })

  t.is(video.id, '100')
  t.is(video.channelKey, 'local-channel')
  t.is(video.channel?.name, 'Local channel')
  t.is(video.channel?.avatar, '/local-avatar.png')
  t.is(video.channel?.icon, '/local-icon.png')
  t.is(video.blobId, 'local-blob')
})

test('normalizeCanonicalFeedVideoFromPublicFeed falls back to feed channel metadata before channelMeta snapshots', (t) => {
  const video = normalizeCanonicalFeedVideoFromPublicFeed({
    id: 'preview-1',
    title: 'Preview',
    uploadedAt: 1,
    blobId: 'preview-blob',
    blobsCoreKey: '11'.repeat(32),
    mimeType: 'video/mp4',
    availability: 'playable',
    byteAvailability: 'playable',
    channelName: 'Ignored video channel',
    channelAvatar: '/ignored-video-avatar.png',
    channelIcon: '/ignored-video-icon.png',
  }, {
    channelKey: 'feed-channel',
    driveKey: 'feed-drive',
    publicBeeKey: '66'.repeat(32),
    channel: {
      channelKey: 'feed-channel',
      driveKey: 'feed-drive',
      name: 'Feed channel',
      avatar: '/feed-avatar.png',
      icon: '/feed-icon.png',
      videoCount: 2,
    },
    channelMeta: {
      name: 'Meta channel',
      avatar: '/meta-avatar.png',
      icon: '/meta-icon.png',
      videoCount: 11,
    },
  })

  t.is(video.channelKey, 'feed-channel')
  t.is(video.driveKey, 'feed-drive')
  t.is(video.channel?.name, 'Feed channel')
  t.is(video.channel?.avatar, '/feed-avatar.png')
  t.is(video.channel?.icon, '/feed-icon.png')
  t.is(video.channel?.videoCount, 2)
  t.is(video.publicBeeKey, '66'.repeat(32))
  t.is(video.blobId, 'preview-blob')
})

test('normalizeCanonicalFeedVideoFromPublicFeed preserves source creator separate from serving channel', (t) => {
  const video = normalizeCanonicalFeedVideoFromPublicFeed({
    id: 'archived-video',
    title: 'Archived source video',
    uploadedAt: 123,
    creatorName: 'Original Creator',
    channelName: 'Channel',
  }, {
    channelKey: 'relay-archive',
    channel: { name: 'Channel' },
  })

  t.is(video.creatorName, 'Original Creator')
  t.is(video.channel?.name, 'Channel')
})

test('normalizeCanonicalFeedVideoFromPreviewHydration preserves distinct availability and byte availability after restart', (t) => {
  const video = normalizeCanonicalFeedVideoFromPreviewHydration({
    id: 'restored-1',
    title: 'Restored preview',
    uploadedAt: 42,
    availability: 'unknown',
    byteAvailability: 'playable',
    blobId: 'restored-blob',
    blobsCoreKey: '77'.repeat(32),
    mimeType: 'video/mp4',
  }, {
    channelKey: 'restored-channel',
    driveKey: 'restored-channel',
    channel: {
      channelKey: 'restored-channel',
      driveKey: 'restored-channel',
      name: 'Restored channel',
      avatar: '/restored-avatar.png',
      icon: '/restored-icon.png',
    },
  })

  t.is(video.availability, 'unknown')
  t.is(video.byteAvailability, 'playable')
  t.is(video.channel?.avatar, '/restored-avatar.png')
  t.is(video.channel?.icon, '/restored-icon.png')
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
