import test from 'brittle'
import { createArchivePublisher } from '../src/archive-manager.js'

test('dual-role archive publication keeps archive ownership on catalog and rendition calls', async function (t) {
  const calls = []
  const publisher = createArchivePublisher({
    identityManager: {},
    uploadManager: {},
    api: {},
    runtime: {
      async publishPublisherCatalog (request) {
        calls.push(['catalog', request])
        return { status: 'published' }
      },
      async retainRendition (request) {
        calls.push(['rendition', request])
        return { status: 'retained' }
      }
    },
    fs: {},
    canPublish: retentionClass =>
      retentionClass === 'contribution-cache' || retentionClass === 'archive-pin',
  })

  await publisher.publishCatalog({
    publisherId: 'archive-publisher',
    retentionClass: 'archive-pin'
  })
  await publisher.retainAssets({
    retentionClass: 'archive-pin',
    previewVideos: [{
      immutablePublication: {
        manifest: { publicationId: 'archive-publication' },
        renditionId: 'archive-rendition'
      }
    }]
  })

  t.alike(calls, [
    ['catalog', { publisherId: 'archive-publisher', retentionClass: 'archive-pin' }],
    ['rendition', {
      manifest: { publicationId: 'archive-publication' },
      renditionId: 'archive-rendition',
      retentionClass: 'archive-pin'
    }]
  ])
})