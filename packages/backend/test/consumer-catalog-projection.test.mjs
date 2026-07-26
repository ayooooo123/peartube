import test from 'brittle'

import { createConsumerCatalogProjection } from '../src/media-graph/catalog-projection.js'
import { createLocalMediaIndex } from '../src/indexing/local-index.js'
import { createMediaGraphApi } from '../src/api/media-graph.js'

const id = (character) => character.repeat(64)

test('one consumer projection deduplicates bounded publisher and index introductions, with movies and series first', (t) => {
  const authenticated = [
    { directPublisher: true, kind: 'movie', entityRef: 'work:alpha', publicationId: id('1'), publisherId: id('a'), title: 'Authenticated Alpha' },
    { directPublisher: true, kind: 'movie', entityRef: 'work:alpha', publicationId: id('2'), publisherId: id('b'), title: 'Authenticated alternate' },
    { directPublisher: true, kind: 'series', entityRef: 'work:beta', publicationId: id('3'), publisherId: id('a'), title: 'Authenticated Beta', collectionId: 'series:beta' },
    { directPublisher: true, kind: 'creator-video', entityRef: 'work:later', publicationId: id('4'), publisherId: id('a'), title: 'Authenticated later' },
  ]
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
    publisherRecords: () => authenticated,
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
    ] }, publisherRecords: () => authenticated,
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
    publisherRecords: () => [
      { directPublisher: true, kind: 'movie', entityRef: 'work:accepted', publicationId: id('1'), publisherId: id('a'), title: 'Authenticated' },
      { directPublisher: true, kind: 'movie', entityRef: 'work:over-budget', publicationId: id('3'), publisherId: id('a'), title: 'Authenticated over budget' },
    ],
  })

  const result = projection.rebuild()
  t.is(result.accepted, 1)
  t.is(result.rejected, 1)
  t.is(result.rejectionCodes.CONSUMER_CANDIDATE_BUDGET_EXCEEDED, 1)
  t.alike(projection.getCatalog().items.map(item => item.entityRef), ['work:accepted'])
})

test('consumer visibility and downstream scheduling commit only after bounded local-index admission', async (t) => {
  const publisherId = id('a')
  const acceptedPublicationId = id('1')
  const rejectedPublicationId = id('2')
  const scheduled = []
  const projection = createConsumerCatalogProjection({
    localIndex: createLocalMediaIndex({
      maxRecordsPerPublisher: 1,
      maxRecordsPerPublisherPerWindow: 1,
    }),
    publisherRecords: () => [
      {
        directPublisher: true,
        kind: 'movie',
        entityRef: 'work:accepted',
        publicationId: acceptedPublicationId,
        publisherId,
        title: 'Accepted',
      },
      {
        directPublisher: true,
        kind: 'movie',
        entityRef: 'work:quota-rejected',
        publicationId: rejectedPublicationId,
        publisherId,
        title: 'Quota rejected',
      },
    ],
    onPlaybackPreparation: record => { scheduled.push(record.entityRef) },
  })

  const first = projection.rebuild()
  t.is(first.accepted, 1)
  t.is(first.rejected, 1)
  t.alike(projection.getCatalog().items.map(item => item.entityRef), ['work:accepted'])
  t.ok(projection.isVisible('work:accepted'))
  t.ok(projection.isPublicationVisible(acceptedPublicationId))
  t.absent(projection.isVisible('work:quota-rejected'))
  t.absent(projection.isPublicationVisible(rejectedPublicationId))
  t.alike(
    await projection.schedule('work:quota-rejected', ['playback']),
    { scheduled: false, errorCode: 'CONSUMER_CANDIDATE_NOT_VISIBLE' },
  )
  t.alike(await projection.schedule('work:accepted', ['playback']), {
    scheduled: true,
    operations: ['playback'],
  })
  t.alike(scheduled, ['work:accepted'])

  t.alike(projection.rebuild(), first, 'an identical rebuild remains idempotent')
  t.absent(projection.isVisible('work:quota-rejected'))
  t.alike(projection.getCatalog().items.map(item => item.entityRef), ['work:accepted'])
})

test('a rejected metadata update schedules only the exact retained local-index row', async t => {
  const publisherId = id('a')
  const publicationId = id('1')
  let now = 10
  let metadataVersion = 1
  const scheduled = []
  const projection = createConsumerCatalogProjection({
    localIndex: createLocalMediaIndex({
      now: () => now,
      budgetWindowMs: 100,
      maxRecordsPerPublisherPerWindow: 1,
    }),
    now: () => now,
    publisherRecords: () => [{
      directPublisher: true,
      kind: 'movie',
      entityRef: 'work:retained',
      publicationId,
      publisherId,
      title: `Retained v${metadataVersion}`,
      artwork: `artwork:v${metadataVersion}`,
      catalogBlockHint: metadataVersion,
      rootTransitionProofDigest: metadataVersion === 1 ? id('c') : id('d'),
      model: `catalog-metadata/v${metadataVersion}`,
      indexId: `catalog-index/v${metadataVersion}`,
      playable: true,
    }],
    onPlaybackPreparation: record => { scheduled.push(record) },
  })

  t.alike(projection.rebuild(), {
    accepted: 1,
    rejected: 0,
    rejectionCodes: {},
  })
  metadataVersion = 2
  now = 20
  t.alike(projection.rebuild(), {
    accepted: 0,
    rejected: 1,
    rejectionCodes: {},
    nextRetryAt: 110,
  }, 'the metadata v2 row is rejected after v1 consumed the publisher window')
  t.alike(projection.rebuild(), {
    accepted: 0,
    rejected: 1,
    rejectionCodes: {},
    nextRetryAt: 110,
  }, 'unchanged input remains idempotent before the admission window resets')
  t.is(projection.getCatalog().items[0].title, 'Retained v1', 'the catalog retains admitted metadata v1')

  t.alike(await projection.schedule('work:retained', ['playback']), {
    scheduled: true,
    operations: ['playback'],
  })
  t.is(scheduled.length, 1)
  t.is(scheduled[0].title, 'Retained v1', 'downstream work receives retained metadata v1')
  t.is(scheduled[0].artwork, 'artwork:v1', 'no field from rejected metadata v2 reaches downstream work')
  t.is(scheduled[0].catalogBlockHint, 1, 'the retained row version reaches downstream work')
  t.is(scheduled[0].rootTransitionProofDigest, id('c'), 'the retained authenticated digest reaches downstream work')
  t.is(scheduled[0].model, 'catalog-metadata/v1', 'the retained payload is exact')

  now = 110
  t.alike(projection.rebuild(), {
    accepted: 1,
    rejected: 0,
    rejectionCodes: {},
  }, 'unchanged metadata v2 is retried when its admission outcome expires')
  t.is(projection.getCatalog().items[0].title, 'Retained v2')
  scheduled.length = 0
  await projection.schedule('work:retained', ['playback'])
  t.is(scheduled[0].rootTransitionProofDigest, id('d'), 'the newly admitted v2 row reaches downstream work')
})

test('an authenticated direct publisher candidate is projected without an index introduction', (t) => {
  const projection = createConsumerCatalogProjection({
    localIndex: createLocalMediaIndex(),
    bootstrapManager: { listLocators: () => [] },
    indexFeedManager: { getRecords: () => [] },
    publisherRecords: () => [{
      directPublisher: true,
      kind: 'movie',
      entityRef: 'work:direct',
      publicationId: id('1'),
      publisherId: id('a'),
      title: 'Direct publisher movie',
    }],
  })
  t.is(projection.rebuild().accepted, 1)
  t.alike(projection.getCatalog().items.map(item => item.entityRef), ['work:direct'])
})

test('media graph API exposes the same one local consumer projection without a manual source parameter', async (t) => {
  const projection = createConsumerCatalogProjection({
    localIndex: createLocalMediaIndex(),
    bootstrapManager: { listLocators: () => [{ publisherId: id('a') }] },
    indexFeedManager: { getRecords: () => [{ kind: 'movie', entityRef: 'work:api', publicationId: id('1'), publisherId: id('a'), title: 'API movie' }] },
    publisherRecords: () => [{ directPublisher: true, kind: 'movie', entityRef: 'work:api', publicationId: id('1'), publisherId: id('a'), title: 'Authenticated API movie' }],
  })
  const api = createMediaGraphApi({ consumerCatalogProjection: projection })

  const page = await api.getMediaCatalog({ limit: 1 })
  t.is(page.success, true)
  t.alike(page.items.map(item => item.entityId), ['work:api'])
  t.is(page.items[0].entityKind, 'movie')
  t.absent(Object.hasOwn(page, 'sourceId'))
})

test('repeated consumer reads do not re-ingest or consume local projection quotas', async (t) => {
  const projection = createConsumerCatalogProjection({
    localIndex: createLocalMediaIndex({ maxRecordsPerPublisherPerWindow: 1 }),
    bootstrapManager: { listLocators: () => [{ publisherId: id('a') }] },
    indexFeedManager: { getRecords: () => [{ kind: 'movie', entityRef: 'work:stable', publicationId: id('1'), publisherId: id('a'), title: 'Stable' }] },
    publisherRecords: () => [{ directPublisher: true, kind: 'movie', entityRef: 'work:stable', publicationId: id('1'), publisherId: id('a'), title: 'Authenticated stable' }],
  })
  const api = createMediaGraphApi({ consumerCatalogProjection: projection })
  t.alike((await api.getMediaCatalog()).items.map(item => item.entityId), ['work:stable'])
  t.alike((await api.getMediaCatalog()).items.map(item => item.entityId), ['work:stable'])
})

test('a changed candidate does not re-consume the unchanged publisher window budget', (t) => {
  let records = [
    { directPublisher: true, kind: 'movie', entityRef: 'work:a', publicationId: id('1'), publisherId: id('a'), title: 'A' },
    { directPublisher: true, kind: 'movie', entityRef: 'work:b', publicationId: id('2'), publisherId: id('b'), title: 'B' },
  ]
  const projection = createConsumerCatalogProjection({
    localIndex: createLocalMediaIndex({ maxRecordsPerPublisherPerWindow: 1 }),
    publisherRecords: () => records,
  })
  t.is(projection.rebuild().accepted, 2)
  records = [...records, { directPublisher: true, kind: 'movie', entityRef: 'work:c', publicationId: id('3'), publisherId: id('b'), title: 'C' }]
  projection.rebuild()
  // The new b record is rejected by the remaining publisher window budget;
  // unchanged a/b records remain visible and were not charged again.
  t.alike(projection.getCatalog().items.map(item => item.entityRef), ['work:a', 'work:b'])
})
