import test from 'node:test'
import assert from 'node:assert/strict'
import { entriesFromRelayCatalog, normalizeRelayCatalogUrl } from '../lib/simple-relay-catalog.ts'

test('normalizeRelayCatalogUrl accepts only http(s) URLs', () => {
  assert.equal(normalizeRelayCatalogUrl(' http://relay.example/catalog.json '), 'http://relay.example/catalog.json')
  assert.equal(normalizeRelayCatalogUrl('https://relay.example/catalog.json'), 'https://relay.example/catalog.json')
  assert.equal(normalizeRelayCatalogUrl('file:///tmp/catalog.json'), null)
  assert.equal(normalizeRelayCatalogUrl(''), null)
})

test('entriesFromRelayCatalog maps relay channels to feed entries with previews', () => {
  const entries = entriesFromRelayCatalog({
    channels: {
      abc: {
        channelKey: 'channel-a',
        publicBeeKey: 'bee-a',
        channelName: 'Relay Archive',
        mirroredAt: 123,
        videos: [{
          id: 'video-a',
          title: 'Video A',
          availability: 'playable',
          blobId: '0:8:0:1024',
          blobsCoreKey: 'aa'.repeat(32),
        }],
      },
    },
  })

  assert.deepEqual(entries.map((entry) => ({
    channelKey: entry.channelKey,
    publicBeeKey: entry.publicBeeKey,
    source: entry.source,
    relayServing: entry.relayServing,
    videos: entry.previewVideos.map((video) => video.id),
  })), [{
    channelKey: 'channel-a',
    publicBeeKey: 'bee-a',
    source: 'relay-cache',
    relayServing: true,
    videos: ['video-a'],
  }])
})
