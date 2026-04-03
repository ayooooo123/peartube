import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildBrowseSnapshot,
  buildChannelWorkspaceVideos,
  buildIdentityMutationSnapshot,
  buildSearchResults,
  formatDuration,
  mergeVideoMetadata,
  pickAccentHex,
} from './bridge-core.mjs'

test('formatDuration renders human-readable playback lengths', () => {
  assert.equal(formatDuration(0), 'Live')
  assert.equal(formatDuration(65), '1:05')
  assert.equal(formatDuration(3723), '1:02:03')
})

test('pickAccentHex is deterministic for a given seed', () => {
  assert.equal(pickAccentHex('alpha'), pickAccentHex('alpha'))
  assert.notEqual(pickAccentHex('alpha'), pickAccentHex('beta'))
})

test('mergeVideoMetadata fills sparse public feed rows with richer metadata', () => {
  const merged = mergeVideoMetadata(
    {
      id: 'video-1',
      title: 'Public feed title',
      description: null,
      duration: null,
      path: null,
      blobId: null,
      blobsCoreKey: null,
      mimeType: null,
    },
    {
      title: 'Stored metadata title',
      description: 'Stored metadata description',
      duration: 142,
      path: '/videos/video-1.mkv',
      blobId: '0:128:0:4096',
      blobsCoreKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      mimeType: 'video/x-matroska',
    }
  )

  assert.equal(merged.title, 'Public feed title')
  assert.equal(merged.description, 'Stored metadata description')
  assert.equal(merged.duration, 142)
  assert.equal(merged.path, '/videos/video-1.mkv')
  assert.equal(merged.blobId, '0:128:0:4096')
  assert.equal(merged.blobsCoreKey, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
  assert.equal(merged.mimeType, 'video/x-matroska')
})

test('mergeVideoMetadata replaces empty-string playback fields with richer metadata', () => {
  const merged = mergeVideoMetadata(
    {
      id: 'video-empty',
      title: 'Existing title',
      blobId: '',
      blobsCoreKey: '   ',
      mimeType: '',
      path: '',
      thumbnail: '',
    },
    {
      blobId: '0:128:0:4096',
      blobsCoreKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      mimeType: 'video/mp4',
      path: '/videos/video-empty.json',
      thumbnail: 'http://127.0.0.1/thumb.jpg',
    }
  )

  assert.equal(merged.blobId, '0:128:0:4096')
  assert.equal(merged.blobsCoreKey, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
  assert.equal(merged.mimeType, 'video/mp4')
  assert.equal(merged.path, '/videos/video-empty.json')
  assert.equal(merged.thumbnail, 'http://127.0.0.1/thumb.jpg')
})

test('buildBrowseSnapshot groups feed, subscriptions, and library content', async () => {
  const snapshot = await buildBrowseSnapshot({
    feedEntries: [
      { channelKey: 'feed-1', publicBeeKey: 'bee-1', channelName: 'Feed One' },
      { channelKey: 'feed-2', publicBeeKey: 'bee-2', channelName: 'Feed Two' },
    ],
    subscriptions: [
      { channelKey: 'feed-2', channelName: 'Feed Two' },
      { channelKey: 'sub-1', channelName: 'Subscribed' },
    ],
    identities: [
      { driveKey: 'own-1', name: 'Own Channel' },
    ],
    async fetchChannelData(source) {
      return {
        channelMeta: {
          name: source.channelName || source.name || `Meta ${source.channelKey}`,
          description: `Description for ${source.channelKey}`,
        },
        videos: [
          {
            id: `${source.channelKey}-video-1`,
            title: `Video 1 for ${source.channelKey}`,
            description: `Video summary for ${source.channelKey}`,
            duration: 95,
            path: `/videos/${source.channelKey}-video-1.mp4`,
            blobId: `0:10:0:${source.channelKey.length}`,
            blobsCoreKey: `${source.channelKey}`.padEnd(64, '0').slice(0, 64),
            mimeType: 'video/mp4',
          },
          {
            id: `${source.channelKey}-video-2`,
            title: `Video 2 for ${source.channelKey}`,
            duration: 180,
          },
        ],
      }
    },
  })

  assert.equal(snapshot.sections.home.length, 4)
  assert.equal(snapshot.sections.subscriptions.length, 4)
  assert.equal(snapshot.sections.library.length, 2)
  assert.equal(snapshot.sections.studio.length, 2)
  assert.equal(snapshot.sections.diagnostics.length, 0)
  assert.deepEqual(snapshot.state.identityChannelKeys, ['own-1'])
  assert.deepEqual(snapshot.state.subscriptionChannelKeys, ['feed-2', 'sub-1'])
  assert.equal(snapshot.state.activeIdentityName, null)
  assert.equal(snapshot.state.activeChannelPublished, false)

  const homeVideo = snapshot.sections.home[0]
  assert.equal(homeVideo.channelKey, 'feed-1')
  assert.equal(homeVideo.durationText, '1:35')
  assert.ok(homeVideo.sections.includes('home'))
  assert.equal(homeVideo.path, '/videos/feed-1-video-1.mp4')
  assert.equal(homeVideo.blobId, '0:10:0:6')
  assert.equal(homeVideo.blobsCoreKey, 'feed-1'.padEnd(64, '0'))
  assert.equal(homeVideo.mimeType, 'video/mp4')

  const sharedVideo = snapshot.sections.subscriptions.find((video) => video.channelKey === 'feed-2')
  assert.ok(sharedVideo)
  assert.ok(sharedVideo.sections.includes('home'))
  assert.ok(sharedVideo.sections.includes('subscriptions'))
})

test('buildBrowseSnapshot falls back to subscriptions and identities when feed is empty', async () => {
  const snapshot = await buildBrowseSnapshot({
    feedEntries: [],
    subscriptions: [
      { channelKey: 'sub-1', channelName: 'Subscribed' },
    ],
    identities: [
      { driveKey: 'own-1', name: 'Own Channel' },
    ],
    async fetchChannelData(source) {
      return {
        channelMeta: {
          name: source.channelName || source.name || `Meta ${source.channelKey}`,
        },
        videos: [
          {
            id: `${source.channelKey}-video-1`,
            title: `Video 1 for ${source.channelKey}`,
            duration: 95,
          },
        ],
      }
    },
  })

  assert.equal(snapshot.sections.home.length, 2)
  assert.deepEqual(
    snapshot.sections.home.map((video) => video.channelKey),
    ['sub-1', 'own-1']
  )
  assert.deepEqual(snapshot.state.identityChannelKeys, ['own-1'])
  assert.deepEqual(snapshot.state.subscriptionChannelKeys, ['sub-1'])
})

test('buildBrowseSnapshot fetches channel data concurrently during bootstrap shaping', async () => {
  let activeFetches = 0
  let maxConcurrentFetches = 0

  const start = Date.now()
  const snapshot = await buildBrowseSnapshot({
    feedEntries: [],
    subscriptions: [
      { channelKey: 'sub-1', channelName: 'Subscribed One' },
      { channelKey: 'sub-2', channelName: 'Subscribed Two' },
    ],
    identities: [
      { driveKey: 'own-1', name: 'Own Channel' },
    ],
    async fetchChannelData(source) {
      activeFetches += 1
      maxConcurrentFetches = Math.max(maxConcurrentFetches, activeFetches)
      await new Promise((resolve) => setTimeout(resolve, 50))
      activeFetches -= 1

      return {
        channelMeta: {
          name: source.channelName || source.name || `Meta ${source.channelKey}`,
        },
        videos: [
          {
            id: `${source.channelKey}-video-1`,
            title: `Video 1 for ${source.channelKey}`,
            duration: 95,
          },
        ],
      }
    },
  })
  const elapsed = Date.now() - start

  assert.equal(snapshot.sections.home.length, 3)
  assert.equal(snapshot.sections.subscriptions.length, 2)
  assert.ok(maxConcurrentFetches >= 3)
  assert.ok(elapsed < 140, `expected concurrent snapshot shaping, took ${elapsed}ms`)
})

test('buildIdentityMutationSnapshot preserves existing feed sections while activating the new identity', () => {
  const previousSnapshot = {
    generatedAt: 1000,
    sections: {
      home: [{
        id: 'feed-1:video-1',
        backendVideoID: 'video-1',
        channelKey: 'feed-1',
        publicBeeKey: 'bee-1',
        title: 'Existing feed video',
        channelName: 'Feed One',
        durationText: '1:35',
        summary: 'Existing summary',
        tags: ['home'],
        accentHex: '#FF7A59',
        sections: ['home'],
        thumbnailURL: null,
        path: '/videos/feed-1-video-1.mp4',
        blobId: '0:10:0:4096',
        blobsCoreKey: 'feed-1'.padEnd(64, '0'),
        mimeType: 'video/mp4',
        width: 1080,
        height: 1920,
      }],
      subscriptions: [],
      library: [],
      studio: [],
      diagnostics: [],
    },
    stats: {
      homeCount: 1,
      subscriptionCount: 0,
      libraryCount: 0,
      channelCount: 1,
    },
    state: {
      subscriptionChannelKeys: ['sub-1'],
      identityChannelKeys: [],
      activeIdentityName: null,
      activeIdentityChannelKey: null,
      activeChannelPublished: false,
    },
  }

  const snapshot = buildIdentityMutationSnapshot({
    previousSnapshot,
    identities: [
      {
        channelKey: 'own-1',
        name: 'Own Channel',
        isActive: true,
      },
    ],
    activeChannelPublished: false,
  })

  assert.equal(snapshot.sections.home.length, 1)
  assert.equal(snapshot.sections.home[0].id, 'feed-1:video-1')
  assert.deepEqual(snapshot.state.subscriptionChannelKeys, ['sub-1'])
  assert.deepEqual(snapshot.state.identityChannelKeys, ['own-1'])
  assert.equal(snapshot.state.activeIdentityName, 'Own Channel')
  assert.equal(snapshot.state.activeIdentityChannelKey, 'own-1')
  assert.equal(snapshot.state.activeChannelPublished, false)
  assert.equal(snapshot.stats.homeCount, 1)
  assert.equal(snapshot.stats.channelCount, 3)
})

test('buildSearchResults shapes global search hits into native videos', async () => {
  const results = await buildSearchResults({
    results: [
      {
        id: 'video-1',
        score: 0.98,
        metadata: {
          channelKey: 'channel-search',
          publicBeeKey: 'bee-search',
          title: 'Search Hit',
          description: 'A strong semantic match',
          duration: 142,
          thumbnail: 'https://example.com/search-hit.jpg',
          category: 'music',
          path: '/videos/video-1.mp4',
          blobId: '0:128:0:4096',
          blobsCoreKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          mimeType: 'video/mp4',
          width: 1080,
          height: 1920,
        },
      },
    ],
    async fetchChannelData(source) {
      return {
        channelMeta: {
          name: `Channel ${source.channelKey}`,
        },
      }
    },
  })

  assert.equal(results.length, 1)
  assert.deepEqual(results[0], {
    id: 'channel-search:video-1',
    backendVideoID: 'video-1',
    channelKey: 'channel-search',
    publicBeeKey: 'bee-search',
    title: 'Search Hit',
    channelName: 'Channel channel-search',
    durationText: '2:22',
    summary: 'A strong semantic match',
    tags: ['search', 'music'],
    accentHex: pickAccentHex('channel-search'),
    sections: ['home'],
    thumbnailURL: 'https://example.com/search-hit.jpg',
    path: '/videos/video-1.mp4',
    blobId: '0:128:0:4096',
    blobsCoreKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    mimeType: 'video/mp4',
    width: 1080,
    height: 1920,
  })
})

test('buildChannelWorkspaceVideos shapes raw channel videos into native bridge records', () => {
  const videos = buildChannelWorkspaceVideos({
    channelKey: 'channel-owner',
    publicBeeKey: null,
    channelMeta: {
      name: 'Owner Channel',
      description: 'Owner profile description',
    },
    videos: [
      {
        id: 'video-1',
        title: 'Workspace Video',
        description: 'Studio-safe summary',
        duration: 142,
        thumbnail: 'https://example.com/workspace.jpg',
        category: 'music',
        path: '/videos/video-1.mp4',
        blobId: '0:128:0:4096',
        blobsCoreKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        mimeType: 'video/mp4',
        width: 1080,
        height: 1920,
      },
    ],
    sourceKind: 'identity',
    sections: ['studio', 'library'],
  })

  assert.deepEqual(videos, [
    {
      id: 'channel-owner:video-1',
      backendVideoID: 'video-1',
      channelKey: 'channel-owner',
      publicBeeKey: null,
      title: 'Workspace Video',
      channelName: 'Owner Channel',
      durationText: '2:22',
      summary: 'Studio-safe summary',
      tags: ['studio', 'identity', 'music'],
      accentHex: pickAccentHex('channel-owner'),
      sections: ['studio', 'library'],
      thumbnailURL: 'https://example.com/workspace.jpg',
      path: '/videos/video-1.mp4',
      blobId: '0:128:0:4096',
      blobsCoreKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      mimeType: 'video/mp4',
      width: 1080,
      height: 1920,
    },
  ])
})
