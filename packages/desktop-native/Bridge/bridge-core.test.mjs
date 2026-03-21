import test from 'node:test'
import assert from 'node:assert/strict'

import { buildBrowseSnapshot, formatDuration, pickAccentHex } from './bridge-core.mjs'

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

  const homeVideo = snapshot.sections.home[0]
  assert.equal(homeVideo.channelKey, 'feed-1')
  assert.equal(homeVideo.durationText, '1:35')
  assert.ok(homeVideo.sections.includes('home'))

  const sharedVideo = snapshot.sections.subscriptions.find((video) => video.channelKey === 'feed-2')
  assert.ok(sharedVideo)
  assert.ok(sharedVideo.sections.includes('home'))
  assert.ok(sharedVideo.sections.includes('subscriptions'))
})
