import test from 'node:test'
import assert from 'node:assert/strict'

import { buildBrowseSnapshot, buildSearchResults, formatDuration, pickAccentHex } from './bridge-core.mjs'

test('formatDuration renders human-readable playback lengths', () => {
  assert.equal(formatDuration(0), 'Live')
  assert.equal(formatDuration(65), '1:05')
  assert.equal(formatDuration(3723), '1:02:03')
})

test('pickAccentHex is deterministic for a given seed', () => {
  assert.equal(pickAccentHex('alpha'), pickAccentHex('alpha'))
  assert.notEqual(pickAccentHex('alpha'), pickAccentHex('beta'))
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
  })
})
