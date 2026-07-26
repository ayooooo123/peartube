import test from 'brittle'

import { createConsumerCatalogProjection } from '../src/media-graph/catalog-projection.js'
import { createLocalMediaIndex } from '../src/indexing/local-index.js'
import { createMediaGraphApi } from '../src/api/media-graph.js'

const id = (character) => character.repeat(64)

test('one consumer projection deduplicates bounded publisher and index introductions, with movies and series first', (t) => {
  const index = createLocalMediaIndex()
  const projection = createConsumerCatalogProjection({
    localIndex: index,
    bootstrapManager: {
      listLocators: () => [{ publisherId: id('a') }, { publisherId: id('b') }],
    },
    indexFeedManager: {
      getRecords: () => [
        { kind: 'movie', entityRef: 'work:alpha', publicationId: id('1'), publisherId: id('a'), title: 'Alpha' },
        { kind: 'movie', entityRef: 'work:alpha', publicationId: id('2'), publisherId: id('b'), title: 'Alpha alternate' },
        { kind: 'series', entityRef: 'work:beta', publicationId: id('3'), publisherId: id('a'), title: 'Beta', collectionId: 'series:beta' },
        { kind: 'creator-video', entityRef: 'work:later', publicationId: id('4'), publisherId: id('a'), title: 'Later' },
      ],
    },
  })

  const rebuilt = projection.rebuild()
  t.is(rebuilt.accepted, 4)
  t.is(rebuilt.rejected, 0)
  const first = projection.getCatalog({ limit: 1 })
  t.is(first.items.length, 1)
  t.is(first.items[0].entityRef, 'work:alpha')
  t.is(first.items[0].publications.length, 2)
  t.is(first.nextCursor, 'work:alpha')
  const second = projection.getCatalog({ cursor: first.nextCursor, limit: 2 })
  t.alike(second.items.map(item => item.entityRef), ['work:beta', 'work:later'])
  t.is(second.nextCursor, null)
  t.alike(projection.getIntroducedPublishers(), [id('a'), id('b')])

  const reverse = createConsumerCatalogProjection({
    localIndex: createLocalMediaIndex(),
    bootstrapManager: { listLocators: () => [{ publisherId: id('b') }, { publisherId: id('a') }] },
    indexFeedManager: { getRecords: () => [
      { kind: 'creator-video', entityRef: 'work:later', publicationId: id('4'), publisherId: id('a'), title: 'Later' },
      { kind: 'series', entityRef: 'work:beta', publicationId: id('3'), publisherId: id('a'), title: 'Beta', collectionId: 'series:beta' },
      { kind: 'movie', entityRef: 'work:alpha', publicationId: id('2'), publisherId: id('b'), title: 'Alpha alternate' },
      { kind: 'movie', entityRef: 'work:alpha', publicationId: id('1'), publisherId: id('a'), title: 'Alpha' },
    ] },
  })
  reverse.rebuild()
  t.alike(reverse.getCatalog().items, projection.getCatalog().items, 'cursor ordering and conflicting metadata are deterministic')
})

test('consumer projection stays bounded and ignores index references to publishers without a received introduction', (t) => {
  const index = createLocalMediaIndex()
  const projection = createConsumerCatalogProjection({
    localIndex: index,
    maxCandidates: 1,
    bootstrapManager: { listLocators: () => [{ publisherId: id('a') }] },
    indexFeedManager: {
      getRecords: () => [
        { kind: 'movie', entityRef: 'work:accepted', publicationId: id('1'), publisherId: id('a'), title: 'Accepted' },
        { kind: 'movie', entityRef: 'work:unintroduced', publicationId: id('2'), publisherId: id('b'), title: 'Unintroduced' },
        { kind: 'movie', entityRef: 'work:over-budget', publicationId: id('3'), publisherId: id('a'), title: 'Over budget' },
      ],
    },
  })

  const result = projection.rebuild()
  t.is(result.accepted, 1)
  t.is(result.rejected, 2)
  t.is(result.rejectionCodes.PUBLISHER_NOT_INTRODUCED, 1)
  t.is(result.rejectionCodes.CONSUMER_CANDIDATE_BUDGET_EXCEEDED, 1)
  t.alike(projection.getCatalog().items.map(item => item.entityRef), ['work:accepted'])
})

test('media graph API exposes the same one local consumer projection without a manual source parameter', async (t) => {
  const projection = createConsumerCatalogProjection({
    localIndex: createLocalMediaIndex(),
    bootstrapManager: { listLocators: () => [{ publisherId: id('a') }] },
    indexFeedManager: { getRecords: () => [{ kind: 'movie', entityRef: 'work:api', publicationId: id('1'), publisherId: id('a'), title: 'API movie' }] },
  })
  const api = createMediaGraphApi({ consumerCatalogProjection: projection })

  const page = await api.getMediaCatalog({ limit: 1 })
  t.is(page.success, true)
  t.alike(page.items.map(item => item.entityId), ['work:api'])
  t.is(page.items[0].entityKind, 'movie')
  t.absent(Object.hasOwn(page, 'sourceId'))
})
