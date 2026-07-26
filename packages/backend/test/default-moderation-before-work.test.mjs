import test from 'brittle'

import { createConsumerCatalogProjection } from '../src/media-graph/catalog-projection.js'
import { createLocalMediaIndex } from '../src/indexing/local-index.js'

const id = (character) => character.repeat(64)

test('default moderation blocks a candidate before artwork, topic, playback, cache, seed, or archive work', async (t) => {
  const work = []
  const projection = createConsumerCatalogProjection({
    localIndex: createLocalMediaIndex(),
    bootstrapManager: { listLocators: () => [{ publisherId: id('a') }, { publisherId: id('b') }] },
    indexFeedManager: {
      getRecords: () => [
        { kind: 'movie', entityRef: 'work:blocked', publicationId: id('1'), publisherId: id('a'), title: 'Blocked', artwork: 'https://blocked.invalid/poster' },
        { kind: 'movie', entityRef: 'work:visible', publicationId: id('2'), publisherId: id('b'), title: 'Visible' },
      ],
    },
    moderationPolicy: {
      enabled: true,
      evaluate: record => record.entityRef === 'work:blocked'
        ? { action: 'hidden', reason: 'local-block' }
        : { action: 'visible', reason: 'default' },
    },
    onArtwork: record => work.push(['artwork', record.entityRef]),
    onTopicJoin: record => work.push(['topic', record.entityRef]),
    onPlaybackPreparation: record => work.push(['playback', record.entityRef]),
    onCache: record => work.push(['cache', record.entityRef]),
    onSeed: record => work.push(['seed', record.entityRef]),
    onArchive: record => work.push(['archive', record.entityRef]),
  })

  const result = projection.rebuild()
  t.is(result.accepted, 1)
  t.is(result.rejectionCodes.LOCAL_MODERATION_HIDDEN, 1)
  t.alike(work, [], 'catalog projection never schedules downstream work')
  t.alike(projection.getCatalog().items.map(item => item.entityRef), ['work:visible'])
  t.alike(projection.getRejectedCandidates(), [{ entityRef: 'work:blocked', reason: 'local-block' }])
  t.alike(await projection.schedule('work:blocked', ['artwork', 'topic', 'playback', 'cache', 'seed', 'archive']), {
    scheduled: false,
    errorCode: 'CONSUMER_CANDIDATE_NOT_VISIBLE',
  })
  t.alike(work, [], 'blocked candidates cannot be scheduled after projection either')
  t.alike(await projection.schedule('work:visible', ['artwork', 'topic', 'playback', 'cache', 'seed', 'archive']), {
    scheduled: true,
    operations: ['artwork', 'topic', 'playback', 'cache', 'seed', 'archive'],
  })
  t.alike(work.map(([operation, entityRef]) => [operation, entityRef]), [
    ['artwork', 'work:visible'], ['topic', 'work:visible'], ['playback', 'work:visible'],
    ['cache', 'work:visible'], ['seed', 'work:visible'], ['archive', 'work:visible'],
  ])
})
