import test from 'brittle'

import { buildCatalogChannels } from '../src/archive-console.js'

test('catalog view uses bounded local publisher inventory and completed archive previews', async (t) => {
  const channelKey = 'a'.repeat(64)
  const projected = await buildCatalogChannels({
    channels: [{
      channelKey,
      publisherId: 'b'.repeat(64),
      source: 'publisher-catalog',
      previewVideos: [{ id: 'existing', availability: 'playable', blobId: '0:4', blobsCoreKey: 'c'.repeat(64) }]
    }],
    store: {
      async getCompletedVideoPreviewsByChannel () {
        return new Map([[channelKey, [
          { id: 'archived', availability: 'playable', blobId: '4:4', blobsCoreKey: 'd'.repeat(64) },
          { id: 'existing', availability: 'playable', title: 'newer projection', blobId: '0:4', blobsCoreKey: 'c'.repeat(64) }
        ]]])
      }
    }
  })

  t.is(projected.length, 1)
  t.is(projected[0].publisherId, 'b'.repeat(64))
  t.alike(projected[0].previewVideos.map((video) => video.id).sort(), ['archived', 'existing'])
  t.is(projected[0].previewVideos.find((video) => video.id === 'existing').title, 'newer projection')
})

test('catalog view does not invent global inventory when no publisher channels are present', async (t) => {
  const projected = await buildCatalogChannels({
    channels: [],
    store: { async getCompletedVideoPreviewsByChannel () { return new Map() } }
  })
  t.alike(projected, [])
})
