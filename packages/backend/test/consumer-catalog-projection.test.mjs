import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createAssetManifestStore, createPublicationManifest } from '../src/assets/index.js'
import {
  createConsumerCatalogProjection,
  projectAuthenticatedPublisherMediaRecords,
} from '../src/media-graph/catalog-projection.js'
import { createEntityReference, createMediaClaim, createMediaGraphStore } from '../src/media-graph/index.js'
import { createLocalMediaIndex } from '../src/indexing/local-index.js'
import { createMediaGraphApi } from '../src/api/media-graph.js'
import { createModerationPolicyEvaluator } from '../src/moderation/policy.js'

const id = (character) => character.repeat(64)

async function ingestClaim(store, input) {
  const claim = createMediaClaim(input)
  const result = await store.ingestClaim(claim.envelope)
  if (result.status !== 'accepted') throw new Error(`claim not accepted: ${result.status}`)
  return claim
}

function testRendition(seed) {
  return {
    purpose: 'original',
    format: 'video/mp4',
    core: {
      key: b4a.alloc(32, seed),
      length: 1,
      treeHash: b4a.alloc(32, seed + 1),
      byteLength: 32,
    },
  }
}

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

test('moderation filters publisher claims before equivalent metadata and collection resolution', async (t) => {
  const allowedPublisher = crypto.keyPair(b4a.alloc(32, 71))
  const blockedPublisher = crypto.keyPair(b4a.alloc(32, 72))
  const allowedPublisherId = b4a.toString(allowedPublisher.publicKey, 'hex')
  const blockedPublisherId = b4a.toString(blockedPublisher.publicKey, 'hex')
  const mediaGraphStore = createMediaGraphStore({
    trustedSigners: [allowedPublisher.publicKey, blockedPublisher.publicKey],
  })
  const assetManifestStore = createAssetManifestStore({
    trustedSigners: [allowedPublisher.publicKey, blockedPublisher.publicKey],
  })
  const work = createEntityReference({
    entityKind: 'work',
    namespace: 'youtube-video',
    normalizedIdentifier: 'moderated01',
  })
  const equivalentWork = createEntityReference({
    entityKind: 'work',
    namespace: 'youtube-video',
    normalizedIdentifier: 'moderated02',
  })
  const samePublisherAllowedWork = createEntityReference({
    entityKind: 'work',
    namespace: 'youtube-video',
    normalizedIdentifier: 'moderated03',
  })
  const allowedCollection = createEntityReference({
    entityKind: 'collection',
    namespace: 'issuer-native',
    issuerRootKey: allowedPublisher.publicKey,
    issuerLocalId: 'allowed-series',
  })
  const blockedCollection = createEntityReference({
    entityKind: 'collection',
    namespace: 'issuer-native',
    issuerRootKey: blockedPublisher.publicKey,
    issuerLocalId: 'blocked-series',
  })
  const allowedManifest = createPublicationManifest({
    publisherId: allowedPublisher.publicKey,
    sequence: 1,
    title: 'Allowed fallback title',
    renditions: [testRendition(73)],
    keyPair: allowedPublisher,
  })
  const blockedManifest = createPublicationManifest({
    publisherId: blockedPublisher.publicKey,
    sequence: 1,
    title: 'Blocked fallback title',
    renditions: [testRendition(75)],
    keyPair: blockedPublisher,
  })
  const samePublisherAllowedManifest = createPublicationManifest({
    publisherId: blockedPublisher.publicKey,
    sequence: 2,
    title: 'Same-publisher allowed fallback',
    renditions: [testRendition(77)],
    keyPair: blockedPublisher,
  })
  await assetManifestStore.ingestManifest(allowedManifest)
  await assetManifestStore.ingestManifest(blockedManifest)
  await assetManifestStore.ingestManifest(samePublisherAllowedManifest)
  await ingestClaim(mediaGraphStore, {
    claimType: 'EntityMetadataClaim',
    subjectRefs: [work],
    payload: { title: 'Allowed Episode', artwork: 'p2p://allowed-poster', ranking: 1 },
    confidence: 100,
    keyPair: allowedPublisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'EntityMetadataClaim',
    subjectRefs: [equivalentWork],
    payload: {
      title: 'Blocked Episode',
      artwork: 'https://blocked.invalid/poster',
      ranking: 999,
      publicationId: blockedManifest.publicationId,
    },
    confidence: 999,
    keyPair: blockedPublisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'EquivalentEntityClaim',
    subjectRefs: [work, equivalentWork, samePublisherAllowedWork],
    payload: { basis: 'adversarial-equivalent-source-fixture' },
    confidence: 100,
    keyPair: allowedPublisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'EntityMetadataClaim',
    subjectRefs: [allowedCollection],
    payload: { title: 'Allowed Series', artwork: 'p2p://allowed-series-poster', ranking: 1 },
    confidence: 100,
    keyPair: allowedPublisher,
  })
  const blockedCollectionMetadata = await ingestClaim(mediaGraphStore, {
    claimType: 'EntityMetadataClaim',
    subjectRefs: [allowedCollection],
    payload: {
      title: 'Blocked Series Override',
      artwork: 'https://blocked.invalid/series',
      ranking: 999,
      publicationId: blockedManifest.publicationId,
    },
    confidence: 999,
    keyPair: blockedPublisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'CollectionMembershipClaim',
    subjectRefs: [allowedCollection],
    payload: {
      collectionRef: allowedCollection,
      memberRef: work,
      memberRole: 'episode',
      position: { season: 1, episode: 1 },
      insertionId: 'allowed-membership',
    },
    keyPair: allowedPublisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'CollectionStructureClaim',
    subjectRefs: [allowedCollection],
    payload: { collectionRef: allowedCollection, expectedSlots: 1 },
    keyPair: allowedPublisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'CollectionMembershipClaim',
    subjectRefs: [blockedCollection],
    payload: {
      collectionRef: blockedCollection,
      memberRef: equivalentWork,
      memberRole: 'episode',
      position: { season: 9, episode: 9 },
      insertionId: 'blocked-membership',
      publicationId: blockedManifest.publicationId,
    },
    confidence: 999,
    keyPair: blockedPublisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'CollectionStructureClaim',
    subjectRefs: [allowedCollection],
    payload: {
      collectionRef: allowedCollection,
      expectedSlots: 99,
      publicationId: blockedManifest.publicationId,
    },
    confidence: 999,
    keyPair: blockedPublisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'AvailabilityObservation',
    subjectRefs: [work],
    payload: { publicationId: allowedManifest.publicationId, availabilityStatus: 'available' },
    keyPair: allowedPublisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'AvailabilityObservation',
    subjectRefs: [equivalentWork],
    payload: { publicationId: blockedManifest.publicationId, availabilityStatus: 'available' },
    keyPair: blockedPublisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'EntityMetadataClaim',
    subjectRefs: [samePublisherAllowedWork],
    payload: {
      title: 'Same-publisher Allowed Episode',
      artwork: 'p2p://same-publisher-allowed-poster',
      ranking: 2,
      publicationId: samePublisherAllowedManifest.publicationId,
    },
    confidence: 200,
    keyPair: blockedPublisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'CollectionMembershipClaim',
    subjectRefs: [allowedCollection, samePublisherAllowedWork],
    payload: {
      collectionRef: allowedCollection,
      memberRef: samePublisherAllowedWork,
      memberRole: 'episode',
      position: { season: 1, episode: 2 },
      insertionId: 'same-publisher-allowed-membership',
      publicationId: samePublisherAllowedManifest.publicationId,
    },
    keyPair: blockedPublisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'AvailabilityObservation',
    subjectRefs: [samePublisherAllowedWork],
    payload: {
      publicationId: samePublisherAllowedManifest.publicationId,
      availabilityStatus: 'available',
    },
    keyPair: blockedPublisher,
  })

  const moderationPolicy = {
    enabled: true,
    evaluate: record => record.publicationId === blockedManifest.publicationId
      ? { action: 'hidden', reason: 'blocked-publication' }
      : { action: 'visible', reason: 'default' },
  }
  const publisherFilteredRecords = projectAuthenticatedPublisherMediaRecords({
    mediaGraphStore,
    assetManifestStore,
    moderationPolicy: {
      enabled: true,
      evaluate: record => record.publisherId === blockedPublisherId
        ? { action: 'hidden', reason: 'blocked-publisher' }
        : { action: 'visible', reason: 'default' },
    },
  })
  t.alike(
    publisherFilteredRecords.map(record => [record.entityRef, record.title, record.publisherId]),
    [[allowedCollection.entityId, 'Allowed Series', allowedPublisherId]],
    'publisher moderation also excludes its claims before equivalent and collection resolution',
  )
  const artworkWork = []
  const projection = createConsumerCatalogProjection({
    localIndex: createLocalMediaIndex(),
    mediaGraphStore,
    moderationPolicy,
    publisherRecords: ({ moderationPolicy, visibleClaims } = {}) => projectAuthenticatedPublisherMediaRecords({
      mediaGraphStore,
      assetManifestStore,
      moderationPolicy,
      consumerClaims: visibleClaims,
    }),
    onArtwork: record => { artworkWork.push(record.artwork) },
  })

  t.is(projection.rebuild().accepted, 2)
  const items = projection.getCatalog().items
  t.is(items.length, 1, 'equivalent allowed publications remain one local entity')
  t.is(items[0].entityRef, allowedCollection.entityId, 'blocked membership cannot introduce another collection')
  t.is(items[0].title, 'Allowed Series', 'blocked higher-confidence metadata cannot win')
  t.is(items[0].series.expectedEpisodes, 1, 'blocked structure cannot inflate collection completeness')
  t.alike(items[0].series.seasons.map(season => season.episodes.map(episode => episode.episodeNumber)), [[1, 2]])
  t.alike(
    items[0].publications.map(publication => publication.publisherId).sort(),
    [allowedPublisherId, blockedPublisherId].sort(),
    'a different allowed publication from the same publisher survives')
  t.ok(projection.isVisible(work.entityId), 'an admitted series episode is consumer-visible for collection APIs')
  t.absent(projection.isVisible(equivalentWork.entityId), 'the blocked equivalent episode remains hidden')
  t.ok(projection.isVisible(samePublisherAllowedWork.entityId),
    'the same publisher remains visible through its separately allowed publication')
  const api = createMediaGraphApi({
    mediaGraphStore,
    assetManifestStore,
    consumerCatalogProjection: projection,
  })
  const detail = await api.getMediaCollection({
    entityId: allowedCollection.entityId,
    includeClaims: true,
  })
  t.is(detail.entity.title, 'Allowed Series', 'collection detail resolves the same moderated claim set')
  t.absent(detail.claims.some(claim => claim.claimId === blockedCollectionMetadata.claimId),
    'blocked metadata is absent from consumer detail provenance')
  await projection.schedule(allowedCollection.entityId, ['artwork'])
  t.alike(artworkWork, ['p2p://allowed-series-poster'], 'blocked artwork never reaches downstream work')
})

test('a hidden relation edge cannot poison publication association for an allowed legacy claim', async (t) => {
  const publisher = crypto.keyPair(b4a.alloc(32, 81))
  const edgeAttacker = crypto.keyPair(b4a.alloc(32, 82))
  const publisherId = b4a.toString(publisher.publicKey, 'hex')
  const attackerId = b4a.toString(edgeAttacker.publicKey, 'hex')
  const mediaGraphStore = createMediaGraphStore({
    trustedSigners: [publisher.publicKey, edgeAttacker.publicKey],
  })
  const assetManifestStore = createAssetManifestStore({ trustedSigners: [publisher.publicKey] })
  const visibleWork = createEntityReference({
    entityKind: 'work',
    namespace: 'youtube-video',
    normalizedIdentifier: 'edgepoison1',
  })
  const blockedWork = createEntityReference({
    entityKind: 'work',
    namespace: 'youtube-video',
    normalizedIdentifier: 'edgepoison2',
  })
  const visibleManifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence: 1,
    title: 'Visible fallback',
    renditions: [testRendition(83)],
    keyPair: publisher,
  })
  const blockedManifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence: 2,
    title: 'Blocked fallback',
    renditions: [testRendition(85)],
    keyPair: publisher,
  })
  await assetManifestStore.ingestManifest(visibleManifest)
  await assetManifestStore.ingestManifest(blockedManifest)
  await ingestClaim(mediaGraphStore, {
    claimType: 'EntityMetadataClaim',
    subjectRefs: [visibleWork],
    payload: { title: 'Allowed source-neutral title' },
    confidence: 100,
    keyPair: publisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'EquivalentEntityClaim',
    subjectRefs: [visibleWork, blockedWork],
    payload: { basis: 'hidden-cluster-poisoning-edge' },
    confidence: 999,
    keyPair: edgeAttacker,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'AvailabilityObservation',
    subjectRefs: [visibleWork],
    payload: { publicationId: visibleManifest.publicationId, availabilityStatus: 'available' },
    keyPair: publisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'AvailabilityObservation',
    subjectRefs: [blockedWork],
    payload: { publicationId: blockedManifest.publicationId, availabilityStatus: 'available' },
    keyPair: publisher,
  })
  const records = projectAuthenticatedPublisherMediaRecords({
    mediaGraphStore,
    assetManifestStore,
    moderationPolicy: {
      enabled: true,
      evaluate: entity => (
        entity.publisherId === attackerId ||
        entity.publicationId === blockedManifest.publicationId
      )
        ? { action: 'hidden', reason: 'local-block' }
        : { action: 'visible', reason: 'default' },
    },
  })

  t.alike(records.map(record => [record.publisherId, record.publicationId, record.title]), [[
    publisherId,
    visibleManifest.publicationId,
    'Allowed source-neutral title',
  ]], 'hidden topology cannot make a blocked publication suppress allowed metadata')
})

test('a moderation block on a non-first equivalent subject hides the whole relation edge', async (t) => {
  const publisher = crypto.keyPair(b4a.alloc(32, 87))
  const publisherId = b4a.toString(publisher.publicKey, 'hex')
  const mediaGraphStore = createMediaGraphStore({ trustedSigners: [publisher.publicKey] })
  const assetManifestStore = createAssetManifestStore({ trustedSigners: [publisher.publicKey] })
  const visibleWork = createEntityReference({
    entityKind: 'work',
    namespace: 'youtube-video',
    normalizedIdentifier: 'multipub001',
  })
  const blockedWork = createEntityReference({
    entityKind: 'work',
    namespace: 'youtube-video',
    normalizedIdentifier: 'multipub002',
  })
  const visibleManifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence: 1,
    title: 'Visible fallback',
    renditions: [testRendition(89)],
    keyPair: publisher,
  })
  const blockedManifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence: 2,
    title: 'Blocked fallback',
    renditions: [testRendition(91)],
    keyPair: publisher,
  })
  await assetManifestStore.ingestManifest(visibleManifest)
  await assetManifestStore.ingestManifest(blockedManifest)
  await ingestClaim(mediaGraphStore, {
    claimType: 'EntityMetadataClaim',
    subjectRefs: [visibleWork],
    payload: { title: 'Non-poisoned source-neutral title' },
    confidence: 100,
    keyPair: publisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'EquivalentEntityClaim',
    subjectRefs: [visibleWork, blockedWork],
    payload: { basis: 'blocked-non-first-subject' },
    confidence: 999,
    keyPair: publisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'AvailabilityObservation',
    subjectRefs: [visibleWork],
    payload: { publicationId: visibleManifest.publicationId, availabilityStatus: 'available' },
    keyPair: publisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'AvailabilityObservation',
    subjectRefs: [blockedWork],
    payload: { publicationId: blockedManifest.publicationId, availabilityStatus: 'available' },
    keyPair: publisher,
  })
  const evaluate = createModerationPolicyEvaluator({
    localBlocks: [
      { targetType: 'work', targetId: blockedWork.entityId, action: 'hide' },
      { targetType: 'publication', targetId: blockedManifest.publicationId, action: 'hide' },
    ],
  })
  const records = projectAuthenticatedPublisherMediaRecords({
    mediaGraphStore,
    assetManifestStore,
    moderationPolicy: { enabled: true, evaluate },
  })

  t.alike(records.map(record => [record.publisherId, record.publicationId, record.title]), [[
    publisherId,
    visibleManifest.publicationId,
    'Non-poisoned source-neutral title',
  ]], 'a hidden non-first subject cannot keep an equivalence edge in consumer topology')
})

// A publisher claims cover art as role-tagged entries because a consumer holds
// no metadata-provider credentials of its own. The catalog carries one display
// locator, so the claim has to be reduced to one, and it has to reach the wire:
// a catalog that syncs completely and renders blank is the failure this guards.
test('claimed cover art reduces to one display locator and reaches the catalog wire', async (t) => {
  const publisher = crypto.keyPair()
  const work = createEntityReference({ entityKind: 'work', namespace: 'tmdb', normalizedIdentifier: 'movie:603' })
  const mediaGraphStore = createMediaGraphStore({ trustedSigners: [publisher.publicKey] })
  const assetManifestStore = createAssetManifestStore({ trustedSigners: [publisher.publicKey] })
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence: 1,
    title: 'Illustrated',
    renditions: [testRendition(11)],
    keyPair: publisher,
  })
  await assetManifestStore.ingestManifest(manifest)
  await ingestClaim(mediaGraphStore, {
    claimType: 'EntityMetadataClaim',
    subjectRefs: [work],
    payload: {
      title: 'Illustrated',
      publicationId: manifest.publicationId,
      // Deliberately out of preference order: a backdrop must not stand in for
      // a poster just because the publisher listed it first, and an origin must
      // not win over a blob that replicates on this swarm.
      artwork: [
        { role: 'backdrop', remoteUrl: 'https://image.example/backdrop.jpg' },
        { role: 'poster', remoteUrl: 'https://image.example/poster.jpg' },
        { role: 'poster', blobId: '3:1:0:512', blobsCoreKey: 'b'.repeat(64), mimeType: 'image/jpeg' },
      ],
    },
    confidence: 100,
    keyPair: publisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'AvailabilityObservation',
    subjectRefs: [work],
    payload: { publicationId: manifest.publicationId, availabilityStatus: 'available' },
    confidence: 100,
    keyPair: publisher,
  })

  const records = projectAuthenticatedPublisherMediaRecords({
    mediaGraphStore,
    assetManifestStore,
  })
  t.is(records.length, 1, 'the illustrated work projects one record')
  t.is(records[0].artwork, `blob:${'b'.repeat(64)}@3:1:0:512`,
    'the swarm blob wins over any origin the claim names')
  t.is(records[0].artworkMimeType, 'image/jpeg', 'the decoder is told what the blob holds')

  const projection = createConsumerCatalogProjection({
    localIndex: createLocalMediaIndex(),
    bootstrapManager: { listLocators: () => [] },
    indexFeedManager: { getRecords: () => [] },
    publisherRecords: () => records,
  })
  t.is(projection.rebuild().accepted, 1, 'a record carrying cover art stays admissible')

  const api = createMediaGraphApi({ consumerCatalogProjection: projection })
  const page = await api.getMediaCatalog({})
  t.is(page.items[0].posterBlobsCoreKey, 'b'.repeat(64), 'the consumer is told which core holds the cover')
  t.is(page.items[0].posterBlobId, '3:1:0:512', 'the consumer is told which blob to replicate')
  t.is(page.items[0].posterMimeType, 'image/jpeg')
  t.alike(
    page.items[0].sources[0].mediaCoordinates,
    { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '603' },
    'the versioned catalog source carries stable provider coordinates',
  )
  t.absent(page.items[0].posterUrl, 'no origin is handed to a consumer that has a blob')
})

// Claims written before swarm-native covers name an origin. Those still have to
// resolve, or upgrading the publisher would blank every catalog it already published.
test('a cover claimed as an origin still reaches the consumer as a url', async (t) => {
  const publisher = crypto.keyPair(b4a.alloc(32, 91))
  const work = createEntityReference({ entityKind: 'work', namespace: 'issuer-native', issuerRootKey: publisher.publicKey, issuerLocalId: 'legacy-art' })
  const mediaGraphStore = createMediaGraphStore({ trustedSigners: [publisher.publicKey] })
  const assetManifestStore = createAssetManifestStore({ trustedSigners: [publisher.publicKey] })
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence: 1,
    title: 'Legacy art',
    renditions: [testRendition(31)],
    keyPair: publisher,
  })
  await assetManifestStore.ingestManifest(manifest)
  await ingestClaim(mediaGraphStore, {
    claimType: 'EntityMetadataClaim',
    subjectRefs: [work],
    payload: {
      title: 'Legacy art',
      publicationId: manifest.publicationId,
      artwork: [{ role: 'poster', remoteUrl: 'https://image.example/legacy.jpg' }],
    },
    confidence: 100,
    keyPair: publisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'AvailabilityObservation',
    subjectRefs: [work],
    payload: { publicationId: manifest.publicationId, availabilityStatus: 'available' },
    confidence: 100,
    keyPair: publisher,
  })

  const projection = createConsumerCatalogProjection({
    localIndex: createLocalMediaIndex(),
    bootstrapManager: { listLocators: () => [] },
    indexFeedManager: { getRecords: () => [] },
    publisherRecords: () => projectAuthenticatedPublisherMediaRecords({ mediaGraphStore, assetManifestStore }),
  })
  projection.rebuild()

  const api = createMediaGraphApi({ consumerCatalogProjection: projection })
  const page = await api.getMediaCatalog({})
  t.is(page.items[0].posterUrl, 'https://image.example/legacy.jpg', 'an origin-only cover is still offered')
  t.absent(page.items[0].posterBlobId, 'nothing invents a blob that was never published')
})

// Everything a viewer reads before pressing play has to arrive with the catalog
// entry. A consumer holds no metadata-provider credentials, so a year, plot,
// runtime, or genre the publisher keeps to itself is one nobody ever sees.
test('what a viewer reads before pressing play travels with the entry', async (t) => {
  const publisher = crypto.keyPair(b4a.alloc(32, 93))
  const work = createEntityReference({ entityKind: 'work', namespace: 'issuer-native', issuerRootKey: publisher.publicKey, issuerLocalId: 'described' })
  const mediaGraphStore = createMediaGraphStore({ trustedSigners: [publisher.publicKey] })
  const assetManifestStore = createAssetManifestStore({ trustedSigners: [publisher.publicKey] })
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence: 1,
    title: 'Described',
    renditions: [testRendition(41)],
    keyPair: publisher,
  })
  await assetManifestStore.ingestManifest(manifest)
  await ingestClaim(mediaGraphStore, {
    claimType: 'EntityMetadataClaim',
    subjectRefs: [work],
    payload: {
      title: 'Described',
      publicationId: manifest.publicationId,
      releaseYear: 2005,
      runtimeMinutes: 119,
      overview: 'Two friends crash weddings.',
      genres: ['Comedy', 'Romance'],
    },
    confidence: 100,
    keyPair: publisher,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'AvailabilityObservation',
    subjectRefs: [work],
    payload: { publicationId: manifest.publicationId, availabilityStatus: 'available' },
    confidence: 100,
    keyPair: publisher,
  })

  const projection = createConsumerCatalogProjection({
    localIndex: createLocalMediaIndex(),
    bootstrapManager: { listLocators: () => [] },
    indexFeedManager: { getRecords: () => [] },
    publisherRecords: () => projectAuthenticatedPublisherMediaRecords({ mediaGraphStore, assetManifestStore }),
  })
  t.is(projection.rebuild().accepted, 1, 'a described record stays admissible')

  const api = createMediaGraphApi({ consumerCatalogProjection: projection })
  const [item] = (await api.getMediaCatalog({})).items
  t.is(item.releaseYear, 2005)
  t.is(item.runtimeMinutes, 119)
  t.is(item.overview, 'Two friends crash weddings.')
  t.alike(item.genres, ['Comedy', 'Romance'])
})
