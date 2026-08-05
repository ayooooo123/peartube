import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createMediaGraphApi } from '../src/api/media-graph.js'
import { createAssetManifestStore, createPublicationManifest, createRenditionDescriptor } from '../src/assets/index.js'
import { createEntityReference, createMediaClaim, createMediaGraphStore } from '../src/media-graph/index.js'

const publisherA = crypto.keyPair(Buffer.alloc(32, 1))
const publisherB = crypto.keyPair(Buffer.alloc(32, 2))
const curator = crypto.keyPair(Buffer.alloc(32, 3))

function hex(value) {
  return b4a.toString(b4a.from(value), 'hex')
}

function workRef(id = 'episode-1') {
  return createEntityReference({ entityKind: 'work', namespace: 'youtube-video', normalizedIdentifier: `${id}___________`.slice(0, 11) })
}

function collectionRef(id = 'season-1') {
  return createEntityReference({ entityKind: 'collection', namespace: 'issuer-native', issuerRootKey: curator.publicKey, issuerLocalId: id })
}

function agentRef(id = 'director-1') {
  return createEntityReference({ entityKind: 'agent', namespace: 'issuer-native', issuerRootKey: curator.publicKey, issuerLocalId: id })
}

function rendition(id = 1) {
  return createRenditionDescriptor({
    purpose: 'original',
    format: 'video/mp4',
    core: {
      key: `${id}`.repeat(64).slice(0, 64),
      length: 1,
      treeHash: `${id + 1}`.repeat(64).slice(0, 64),
      byteLength: 32,
    },
  })
}

const FIXED_NOW = 1_700_000_000_000

function evidenceStore(byPublication = new Map()) {
  return {
    set(publicationId, evidence) {
      byPublication.set(publicationId, evidence)
      return this
    },
    getCachedEvidence(publicationId) {
      return byPublication.get(publicationId) || {}
    },
  }
}

function completePeerEvidence(transportKeys, coreLength = 1) {
  return {
    peers: transportKeys.map(transportKey => ({
      transportKey,
      connected: true,
      advertisedRanges: [{ start: 0, end: coreLength }],
      advertisedAt: FIXED_NOW - 10_000,
      challengeStatus: 'passed',
      verifiedAt: FIXED_NOW - 1_000,
    })),
  }
}

async function fixture() {
  const mediaGraphStore = createMediaGraphStore({ trustedSigners: [publisherA.publicKey, publisherB.publicKey, curator.publicKey] })
  const assetManifestStore = createAssetManifestStore({ trustedSigners: [publisherA.publicKey, publisherB.publicKey] })
  const sourcePreferenceStore = new Map()
  const availabilityEvidenceStore = evidenceStore()
  const api = createMediaGraphApi({
    mediaGraphStore,
    assetManifestStore,
    sourcePreferenceStore,
    availabilityEvidenceStore,
    now: () => FIXED_NOW,
    trust: { [hex(publisherA.publicKey)]: 20, [hex(publisherB.publicKey)]: 5, [hex(curator.publicKey)]: 50 },
  })
  return { api, mediaGraphStore, assetManifestStore, sourcePreferenceStore, availabilityEvidenceStore }
}

async function ingestClaim(store, input) {
  const claim = createMediaClaim(input)
  const result = await store.ingestClaim(claim.envelope)
  if (result.status !== 'accepted') throw new Error(`claim not accepted: ${result.status}`)
  return claim
}

test('media graph API returns resolved local entity summaries with provenance and conflicts', async (t) => {
  const { api, mediaGraphStore } = await fixture()
  const subject = workRef('pilot')
  const weak = await ingestClaim(mediaGraphStore, { claimType: 'EntityMetadataClaim', subjectRefs: [subject], payload: { title: 'Wrong Pilot' }, confidence: 100, keyPair: publisherB })
  const strong = await ingestClaim(mediaGraphStore, { claimType: 'EntityMetadataClaim', subjectRefs: [subject], payload: { title: 'Pilot' }, confidence: 900, keyPair: publisherA })

  const result = await api.getMediaEntity({ entityId: subject.entityId, includeClaims: true, includeConflicts: true })

  t.is(result.success, true)
  t.is(result.entity.entityId, subject.entityId)
  t.is(result.entity.entityKind, 'work')
  t.is(result.entity.title, 'Pilot')
  t.is(result.entity.claimCount, 2)
  t.is(result.entity.conflictCount, 1)
  t.is(result.claims.length, 2)
  t.alike(result.claims.map(row => row.claimId).sort(), [weak.claimId, strong.claimId].sort())
  t.is(result.conflicts[0].claimId, weak.claimId)
})

test('media graph API reports structured missing and stale cursor errors', async (t) => {
  const { api, mediaGraphStore } = await fixture()
  const subject = workRef('pilot')
  await ingestClaim(mediaGraphStore, { claimType: 'EntityMetadataClaim', subjectRefs: [subject], payload: { title: 'Pilot' }, keyPair: publisherA })

  t.alike(await api.getMediaEntity({ entityId: 'missing' }), { success: false, errorCode: 'MEDIA_ENTITY_NOT_FOUND', error: 'Media entity not found' })
  t.alike(await api.getMediaCollectionItems({ collectionEntityId: subject.entityId, cursor: 'stale' }), { success: false, errorCode: 'INVALID_CURSOR', error: 'Invalid media graph cursor', items: [], nextCursor: null })
})

test('media graph API pages collection items and agent contributions from local claims only', async (t) => {
  const { api, mediaGraphStore } = await fixture()
  const collection = collectionRef()
  const first = workRef('episode-1')
  const second = workRef('episode-2')
  const agent = agentRef()
  await ingestClaim(mediaGraphStore, { claimType: 'CollectionMembershipClaim', subjectRefs: [collection], payload: { collectionRef: collection, memberRef: first, memberRole: 'episode', position: { episode: 1 }, insertionId: 'one' }, keyPair: curator })
  await ingestClaim(mediaGraphStore, { claimType: 'CollectionMembershipClaim', subjectRefs: [collection], payload: { collectionRef: collection, memberRef: second, memberRole: 'episode', position: { episode: 2 }, insertionId: 'two' }, keyPair: curator })
  await ingestClaim(mediaGraphStore, { claimType: 'ContributionClaim', subjectRefs: [first], payload: { agentRef: agent, subjectRef: first, role: 'director', creditedName: 'Director' }, keyPair: curator })

  const page = await api.getMediaCollectionItems({ collectionEntityId: collection.entityId, limit: 1, limitProvided: true })
  t.is(page.success, true)
  t.is(page.items.length, 1)
  t.ok(page.nextCursor)
  const next = await api.getMediaCollectionItems({ collectionEntityId: collection.entityId, cursor: page.nextCursor, limit: 1, limitProvided: true })
  t.is(next.items.length, 1)
  t.is(next.nextCursor, null)

  const contributions = await api.getAgentContributions({ agentEntityId: agent.entityId })
  t.is(contributions.success, true)
  t.is(contributions.items[0].role, 'director')
  t.is(contributions.items[0].agentEntityId, agent.entityId)
})

test('media graph API orders publication sources by score and local source preference', async (t) => {
  const { api, mediaGraphStore, assetManifestStore, availabilityEvidenceStore } = await fixture()
  const subject = workRef('pilot')
  const low = createPublicationManifest({ publisherId: publisherB.publicKey, sequence: 1, title: 'Low', renditions: [rendition(3)], keyPair: publisherB })
  const high = createPublicationManifest({ publisherId: publisherA.publicKey, sequence: 1, title: 'High', renditions: [rendition(1)], keyPair: publisherA })
  await assetManifestStore.ingestManifest(low)
  await assetManifestStore.ingestManifest(high)
  await ingestClaim(mediaGraphStore, { claimType: 'AvailabilityObservation', subjectRefs: [subject], payload: { publicationId: low.publicationId, availabilityStatus: 'available' }, confidence: 300, keyPair: publisherB })
  await ingestClaim(mediaGraphStore, { claimType: 'AvailabilityObservation', subjectRefs: [subject], payload: { publicationId: high.publicationId, availabilityStatus: 'available' }, confidence: 300, keyPair: publisherA })

  const claimed = await api.getPublicationSources({ entityId: subject.entityId })
  t.is(claimed.success, true)
  t.is(claimed.items[0].availability.state, 'awaiting-replication', 'nobody has asked a peer yet')
  t.is(claimed.items[0].availabilityState, 'unknown')

  // Playability decides, so the weaker source is the one with less evidence.
  availabilityEvidenceStore.set(low.publicationId, completePeerEvidence(['aa']))
  availabilityEvidenceStore.set(high.publicationId, completePeerEvidence(['cc', 'dd']))

  const scored = await api.getPublicationSources({ entityId: subject.entityId })
  t.is(scored.success, true)
  t.is(scored.items[0].publicationId, high.publicationId)
  t.is(scored.items[0].selected, true)
  t.ok(Array.isArray(scored.items[0].selectionReasonCodes))
  t.ok(Array.isArray(scored.items[1].rejectionReasonCodes))
  t.ok(Array.isArray(scored.items[0].introductionPublisherIds))
  t.ok(Array.isArray(scored.items[0].introductionIndexIds))
  t.ok(Array.isArray(scored.items[0].moderationFeedIds))
  t.ok(Array.isArray(scored.items[0].claimConflictIds))
  t.ok(Array.isArray(scored.items[0].provenanceClaimIds))
  t.is(typeof scored.items[0].scorePeerEvidence, 'number')
  t.is(typeof scored.items[0].scoreStartupReachability, 'number')
  t.is(scored.items[0].eligible, true)
  t.alike(scored.items[1].rejectionReasonCodes, ['LOWER_LOCAL_SCORE'])
  t.is(scored.items[0].availabilityState, 'available')
  t.is(scored.items[0].availability.state, 'healthy')
  t.is(scored.items[0].availability.independentPeerCount, 2)
  t.is(scored.items[0].availability.observedAt, FIXED_NOW)
  t.is(scored.items[0].availability.expiresAt, FIXED_NOW - 1_000 + 60_000)

  const preference = await api.setSourcePreference({ entityId: subject.entityId, publicationId: low.publicationId, preferred: true })
  t.is(preference.success, true)
  const preferred = await api.getPublicationSources({ entityId: subject.entityId })
  t.is(preferred.items[0].publicationId, low.publicationId)
  t.is(preferred.items[0].preferred, true)
})

test('media graph detail and source APIs exclude locally hidden publications without mutating graph truth', async (t) => {
  const { mediaGraphStore, assetManifestStore, sourcePreferenceStore } = await fixture()
  const subject = workRef('mixed')
  const visible = createPublicationManifest({
    publisherId: publisherA.publicKey,
    sequence: 1,
    title: 'Visible source',
    renditions: [rendition(1)],
    keyPair: publisherA,
  })
  const hidden = createPublicationManifest({
    publisherId: publisherB.publicKey,
    sequence: 1,
    title: 'Hidden source',
    renditions: [rendition(3)],
    keyPair: publisherB,
  })
  await assetManifestStore.ingestManifest(visible)
  await assetManifestStore.ingestManifest(hidden)
  await ingestClaim(mediaGraphStore, {
    claimType: 'AvailabilityObservation',
    subjectRefs: [subject],
    payload: { publicationId: visible.publicationId, availabilityStatus: 'available' },
    keyPair: publisherA,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'AvailabilityObservation',
    subjectRefs: [subject],
    payload: { publicationId: hidden.publicationId, availabilityStatus: 'available' },
    keyPair: publisherB,
  })

  const visiblePublications = new Set([visible.publicationId])
  const projection = {
    async update() {},
    isVisible: () => visiblePublications.size > 0,
    isPublicationVisible: publicationId => visiblePublications.has(publicationId),
  }
  const api = createMediaGraphApi({
    mediaGraphStore,
    assetManifestStore,
    sourcePreferenceStore,
    consumerCatalogProjection: projection,
  })

  const detail = await api.getMediaEntity({ entityId: subject.entityId })
  t.is(detail.success, true)
  t.alike(detail.entity.sources.map(source => source.publicationId), [visible.publicationId])
  const sources = await api.getPublicationSources({ entityId: subject.entityId })
  t.alike(sources.items.map(source => source.publicationId), [visible.publicationId])
  t.ok(assetManifestStore.getManifest(hidden.publicationId),
    'local policy filtering leaves authenticated network truth unchanged')
  t.is(mediaGraphStore.getClaimsBySubject(subject.entityId).length, 2)

  visiblePublications.clear()
  t.is((await api.getMediaEntity({ entityId: subject.entityId })).errorCode, 'MEDIA_ENTITY_NOT_VISIBLE')
  t.is((await api.getPublicationSources({ entityId: subject.entityId })).errorCode, 'MEDIA_ENTITY_NOT_VISIBLE')
  t.is(mediaGraphStore.getClaimsBySubject(subject.entityId).length, 2,
    'all-hidden detail state remains an honest local-policy miss without deleting graph records')
})

test('collection detail and membership omit hidden linked episodes before paging', async (t) => {
  const { mediaGraphStore, assetManifestStore, sourcePreferenceStore } = await fixture()
  const collection = collectionRef('moderated-season')
  const visibleEpisode = workRef('visible-ep')
  const hiddenEpisode = workRef('hidden-ep')
  const visibleManifest = createPublicationManifest({
    publisherId: publisherA.publicKey,
    sequence: 1,
    title: 'Visible episode',
    renditions: [rendition(1)],
    keyPair: publisherA,
  })
  const hiddenManifest = createPublicationManifest({
    publisherId: publisherB.publicKey,
    sequence: 1,
    title: 'Hidden episode',
    renditions: [rendition(3)],
    keyPair: publisherB,
  })
  await assetManifestStore.ingestManifest(visibleManifest)
  await assetManifestStore.ingestManifest(hiddenManifest)
  await ingestClaim(mediaGraphStore, {
    claimType: 'EntityMetadataClaim',
    subjectRefs: [collection],
    payload: { title: 'Moderated season' },
    keyPair: curator,
  })
  const visibleMembership = await ingestClaim(mediaGraphStore, {
    claimType: 'CollectionMembershipClaim',
    subjectRefs: [collection],
    payload: {
      collectionRef: collection,
      memberRef: visibleEpisode,
      memberRole: 'episode',
      position: { episode: 1 },
      insertionId: 'visible',
    },
    keyPair: curator,
  })
  const hiddenMembership = await ingestClaim(mediaGraphStore, {
    claimType: 'CollectionMembershipClaim',
    subjectRefs: [collection],
    payload: {
      collectionRef: collection,
      memberRef: hiddenEpisode,
      memberRole: 'episode',
      position: { episode: 2 },
      insertionId: 'hidden',
    },
    keyPair: curator,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'AvailabilityObservation',
    subjectRefs: [visibleEpisode],
    payload: { publicationId: visibleManifest.publicationId, availabilityStatus: 'available' },
    keyPair: publisherA,
  })
  await ingestClaim(mediaGraphStore, {
    claimType: 'AvailabilityObservation',
    subjectRefs: [hiddenEpisode],
    payload: { publicationId: hiddenManifest.publicationId, availabilityStatus: 'available' },
    keyPair: publisherB,
  })

  const visibleMembers = new Set([visibleEpisode.entityId])
  const visiblePublications = new Set([visibleManifest.publicationId])
  let collectionVisible = true
  const projection = {
    async update() {},
    isVisible: entityId => (
      (entityId === collection.entityId && collectionVisible) ||
      visibleMembers.has(entityId)
    ),
    isPublicationVisible: publicationId => visiblePublications.has(publicationId),
  }
  const api = createMediaGraphApi({
    mediaGraphStore,
    assetManifestStore,
    sourcePreferenceStore,
    consumerCatalogProjection: projection,
  })

  const items = await api.getMediaCollectionItems({
    collectionEntityId: collection.entityId,
    limit: 1,
    limitProvided: true,
  })
  t.alike(items.items.map(item => item.entityId), [visibleEpisode.entityId])
  t.is(items.nextCursor, null, 'visibility filtering occurs before paging')

  const detail = await api.getMediaCollection({
    entityId: collection.entityId,
    includeClaims: true,
  })
  t.is(detail.success, true)
  t.ok(detail.claims.some(claim => claim.claimId === visibleMembership.claimId))
  t.absent(detail.claims.some(claim => claim.claimId === hiddenMembership.claimId),
    'hidden membership is absent from collection detail')
  t.is(detail.entity.claimCount, 2, 'detail counts collection metadata plus the visible membership only')

  visibleMembers.clear()
  visiblePublications.clear()
  const empty = await api.getMediaCollectionItems({ collectionEntityId: collection.entityId })
  t.alike(empty, { success: true, items: [], nextCursor: null },
    'all-hidden collection members are an honest local-policy empty state')
  t.is(mediaGraphStore.getClaimsByCollection(collection.entityId).length, 2,
    'local visibility filtering does not mutate authenticated graph truth')

  visibleMembers.add(visibleEpisode.entityId)
  visiblePublications.add(visibleManifest.publicationId)
  collectionVisible = false
  t.alike(await api.getMediaCollectionItems({ collectionEntityId: collection.entityId }), {
    success: false,
    errorCode: 'MEDIA_ENTITY_NOT_VISIBLE',
    error: 'Media collection is not visible under this device policy',
    items: [],
    nextCursor: null,
  }, 'a hidden collection root cannot enumerate otherwise visible members')
})

test('media graph API never auto-selects an unverified or unavailable playback source', async (t) => {
  const { api, mediaGraphStore } = await fixture()
  const subject = workRef('untrusted-only')
  await ingestClaim(mediaGraphStore, {
    claimType: 'AvailabilityObservation',
    subjectRefs: [subject],
    payload: { publicationId: 'missing-signed-manifest', availabilityStatus: 'available' },
    confidence: 900,
    keyPair: publisherA,
  })

  const sources = await api.getPublicationSources({ entityId: subject.entityId })
  t.is(sources.success, true)
  t.is(sources.items.length, 1)
  t.is(sources.items[0].selected, false)
  t.ok(sources.items[0].rejectionReasonCodes.includes('UNAUTHORIZED_PUBLICATION'))

  const entity = await api.getMediaEntity({ entityId: subject.entityId })
  t.is(entity.success, true)
  t.is(entity.entity.sources[0].selected, false)
  t.ok(entity.entity.sources[0].rejectionReasonCodes.includes('UNAUTHORIZED_PUBLICATION'))
})

test('media graph API reports the latency penalty as a schema-safe uint magnitude', async t => {
  const api = createMediaGraphApi({
    mediaGraphStore: {
      getClaimsBySubject: () => [{
        claimId: 'claim-1',
        issuer: 'publisher-1',
        revoked: false,
        body: {
          claimType: 'AvailabilityObservation',
          confidence: 10,
          payload: {
            publicationId: 'publication-1',
            availabilityStatus: 'available',
            moderationPenalty: 2
          }
        }
      }]
    },
    assetManifestStore: {
      getManifest: () => ({
        publicationId: 'publication-1',
        body: {
          publisherId: 'publisher-1',
          manifestId: 'manifest-1',
          renditions: [{ renditionId: 'rendition-1' }]
        }
      }),
      getRenditionRequirement: () => ({
        publicationId: 'publication-1',
        renditionId: 'rendition-1',
        requiredRanges: [{ start: 0, end: 4 }]
      })
    },
    availabilityEvidenceStore: {
      getCachedEvidence: () => ({
        peers: ['aa', 'bb'].map(transportKey => ({
          transportKey,
          connected: true,
          advertisedRanges: [{ start: 0, end: 4 }],
          advertisedAt: FIXED_NOW - 10_000,
          challengeStatus: 'passed',
          verifiedAt: FIXED_NOW - 1_000,
          latencyMs: 900
        }))
      })
    },
    now: () => FIXED_NOW,
    sourcePreferenceStore: new Map()
  })

  const result = await api.getPublicationSources({ entityId: 'entity-1' })
  t.is(result.success, true)
  t.is(result.items[0].scoreStartupLatency, 900, 'a negative penalty crosses the wire as a positive magnitude')
  for (const field of [
    'scoreLocalCompleteness',
    'scoreStartupReachability',
    'scorePeerEvidence',
    'scoreFormatSupport',
    'scoreStartupLatency',
    'scoreUserOverride'
  ]) t.ok(Number.isSafeInteger(result.items[0][field]) && result.items[0][field] >= 0, `${field} is a safe uint`)
})

test('claim provenance lookup returns typed local claim summaries', async (t) => {
  const { api, mediaGraphStore } = await fixture()
  const subject = workRef('pilot')
  const claim = await ingestClaim(mediaGraphStore, { claimType: 'EntityMetadataClaim', subjectRefs: [subject], payload: { title: 'Pilot' }, confidence: 777, keyPair: publisherA })

  const result = await api.getClaimProvenance({ claimId: claim.claimId })
  t.is(result.success, true)
  t.is(result.claim.claimId, claim.claimId)
  t.is(result.claim.claimType, 'EntityMetadataClaim')
  t.is(result.claim.confidence, 777)
})

const POSTER_CORE_KEY = 'ab'.repeat(32)
const POSTER_BLOB_ID = '5:1:120:4096'

function posterRendition() {
  return createRenditionDescriptor({
    purpose: 'poster',
    format: 'image/jpeg',
    core: { key: POSTER_CORE_KEY, length: 9, treeHash: 'cd'.repeat(32), byteLength: 4096 },
  })
}

/**
 * One publication whose manifest carries the cover as a signed `poster`
 * rendition plus the artwork provenance entry that records its hyperblobs id.
 * Every collaborator that would touch the network is stubbed: `retain` stands in
 * for the authorized asset transfer and `local` for what the corestore holds.
 */
async function artworkFixture({ poster = true, local = false, localAfterRetain = false, artworkTransferTimeoutMs = 0 } = {}) {
  const mediaGraphStore = createMediaGraphStore({ trustedSigners: [publisherA.publicKey] })
  const assetManifestStore = createAssetManifestStore({ trustedSigners: [publisherA.publicKey] })
  const cover = posterRendition()
  const manifest = createPublicationManifest({
    publisherId: publisherA.publicKey,
    sequence: 1,
    title: 'Cover',
    renditions: poster ? [rendition(1), cover] : [rendition(1)],
    provenance: poster
      ? [{
        type: 'artwork',
        role: 'poster',
        videoId: 'cover-1',
        blobId: POSTER_BLOB_ID,
        coreKey: cover.core.key,
        renditionId: cover.renditionId,
        start: 5,
        end: 6,
      }]
      : [],
    keyPair: publisherA,
  })
  await assetManifestStore.ingestManifest(manifest)
  const subject = workRef('cover')
  await ingestClaim(mediaGraphStore, {
    claimType: 'AvailabilityObservation',
    subjectRefs: [subject],
    payload: { publicationId: manifest.publicationId, availabilityStatus: 'available' },
    confidence: 300,
    keyPair: publisherA,
  })

  const retained = []
  let bytesLocal = local
  const closedSessions = []
  const api = createMediaGraphApi({
    mediaGraphStore,
    assetManifestStore,
    sourcePreferenceStore: new Map(),
    now: () => FIXED_NOW,
    artworkTransferTimeoutMs,
    scopedNetwork: {
      async retainAuthorizedRendition(request) {
        retained.push(request)
        if (localAfterRetain) bytesLocal = true
        return { status: 'retained', renditionId: request.renditionId }
      },
    },
    store: {
      get({ key }) {
        const coreKey = b4a.toString(key, 'hex')
        return {
          async ready() {},
          async has(start, end) {
            return coreKey === POSTER_CORE_KEY && start === 5 && end === 6 && bytesLocal
          },
          async close() { closedSessions.push(coreKey) },
        }
      },
    },
    blobServer: {
      port: 49_001,
      getLink(key, opts) {
        return `http://127.0.0.1:49001/?key=${b4a.toString(key, 'hex')}&blob=${opts.blob.blockOffset}:${opts.blob.blockLength}:${opts.blob.byteOffset}:${opts.blob.byteLength}&type=${opts.type}&token=tok`
      },
    },
  })
  return { api, cover, manifest, subject, retained, closedSessions }
}

test('entity artwork resolves the manifest poster rendition to a loopback URL once the authorized transfer lands', async (t) => {
  const { api, cover, manifest, subject, retained, closedSessions } = await artworkFixture({ localAfterRetain: true })

  const result = await api.getEntityArtwork({ entityId: subject.entityId })
  t.is(result.success, true)
  t.is(result.exists, true)
  t.absent(result.errorCode)
  t.ok(result.url.startsWith('http://127.0.0.1:49001/'), 'artwork is served from loopback, never an origin')
  t.ok(result.url.includes('/__peartube_thumbnail__.jpg'), 'the buffered blob-server path serves it')
  t.ok(result.url.includes('pt_thumbnail=1'), 'the response is buffered so native image loaders accept it')
  t.ok(result.url.includes(`blob=${POSTER_BLOB_ID}`), 'the published hyperblobs id is used verbatim')
  t.ok(result.url.includes(`key=${POSTER_CORE_KEY}`), 'bytes are read from the rendition core the manifest signed')
  t.ok(result.url.includes('type=image%2Fjpeg') || result.url.includes('type=image/jpeg'), 'the declared encoding is carried')

  t.alike(retained, [{
    manifest,
    renditionId: cover.renditionId,
    start: 5,
    end: 6,
    entityRef: subject.entityId,
    publicationId: manifest.publicationId,
  }], 'exactly the poster rendition range is retained over the authorized asset path')
  t.alike(closedSessions, [POSTER_CORE_KEY], 'the locality probe leaves no open core session')
})

test('entity artwork reports a retryable miss instead of failing when a manifest carries no poster', async (t) => {
  const { api, subject, retained } = await artworkFixture({ poster: false })

  const result = await api.getEntityArtwork({ entityId: subject.entityId })
  t.alike(result, { success: true, exists: false }, 'no poster is an absent cover, not an error')
  t.alike(retained, [], 'nothing is retained when there is no poster rendition to fetch')
})

test('entity artwork reports a retryable miss while the poster bytes are still in flight', async (t) => {
  const { api, cover, subject, retained } = await artworkFixture({ localAfterRetain: false })

  const result = await api.getEntityArtwork({ entityId: subject.entityId })
  t.alike(result, { success: true, exists: false }, 'unreplicated bytes are retryable, never a thrown RPC')
  t.is(retained.length, 1, 'the transfer was requested so a later call can succeed')
  t.is(retained[0].renditionId, cover.renditionId)

  const byPublication = await api.getEntityArtwork({ publicationId: retained[0].publicationId })
  t.alike(byPublication, { success: true, exists: false }, 'the publication-keyed lookup answers the same way')

  t.alike(
    await api.getEntityArtwork({}),
    { success: false, errorCode: 'INVALID_ARTWORK_REQUEST', error: 'entityId or publicationId is required', exists: false },
    'a request naming neither key is rejected outright'
  )
})

test('the same entity carries the same cover and synopsis whether it is fetched as a catalog row or on its own page', async (t) => {
  const { api, mediaGraphStore } = await fixture()
  const subject = workRef('described')
  await ingestClaim(mediaGraphStore, {
    claimType: 'EntityMetadataClaim',
    subjectRefs: [subject],
    payload: {
      title: 'Described',
      releaseYear: 1999,
      runtimeMinutes: 136,
      overview: 'A synopsis a consumer cannot look up anywhere else.',
      genres: ['Action', 'Sci-Fi'],
      artwork: [
        { role: 'backdrop', remoteUrl: 'https://image.example/backdrop.jpg' },
        { role: 'poster', blobId: '3:1:0:512', blobsCoreKey: 'b'.repeat(64), mimeType: 'image/jpeg' },
      ],
    },
    confidence: 900,
    keyPair: publisherA,
  })

  const expected = {
    posterBlobId: '3:1:0:512',
    posterBlobsCoreKey: 'b'.repeat(64),
    posterMimeType: 'image/jpeg',
    releaseYear: 1999,
    runtimeMinutes: 136,
    overview: 'A synopsis a consumer cannot look up anywhere else.',
    genres: ['Action', 'Sci-Fi'],
  }
  const pick = summary => Object.fromEntries(Object.keys(expected).map(key => [key, summary[key]]))

  const detail = await api.getMediaEntity({ entityId: subject.entityId })
  t.is(detail.success, true)
  t.alike(pick(detail.entity), expected, 'the detail page knows the title has publisher artwork to ask for')

  const catalog = await api.getMediaCatalog({})
  t.is(catalog.success, true)
  const row = catalog.items.find(item => item.entityId === subject.entityId)
  t.ok(row, 'the entity appears in the catalog')
  t.alike(pick(row), pick(detail.entity), 'both fetch paths agree, so art never appears on a shelf and vanish on the page')

  t.absent(row.posterUrl, 'a swarm blob is never downgraded to an origin URL')
})

// A category the publisher never claimed has to stay missing on the way out.
// Rendering an unclaimed runtime as 0, or an unclaimed synopsis as '', is the
// consumer inventing a fact about someone else's publication.
test('a title the publisher never described carries no categories on either fetch path', async (t) => {
  const { api, mediaGraphStore } = await fixture()
  const subject = workRef('undescribed')
  await ingestClaim(mediaGraphStore, {
    claimType: 'EntityMetadataClaim',
    subjectRefs: [subject],
    payload: { title: 'Undescribed' },
    confidence: 900,
    keyPair: publisherA,
  })

  const detail = await api.getMediaEntity({ entityId: subject.entityId })
  t.is(detail.success, true)
  const row = (await api.getMediaCatalog({})).items.find(item => item.entityId === subject.entityId)
  t.ok(row, 'the entity still appears; only its categories do not')

  for (const summary of [detail.entity, row]) {
    for (const field of ['releaseYear', 'runtimeMinutes', 'overview', 'genres']) {
      t.absent(field in summary, `${field} is absent, never a zero or an empty string`)
    }
  }
})

// The ingest path bounds a description before the publisher signs it. Claims
// arriving from other publishers never went through that, so the read paths
// have to apply the same bounds rather than trust whatever was signed.
test('categories that overstep the ingest bounds are clamped on the way out', async (t) => {
  const { api, mediaGraphStore } = await fixture()
  const subject = workRef('overdescribed')
  await ingestClaim(mediaGraphStore, {
    claimType: 'EntityMetadataClaim',
    subjectRefs: [subject],
    payload: {
      title: 'Overdescribed',
      releaseYear: 1200,
      runtimeMinutes: 1_000_000,
      genres: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'x'.repeat(65), ''],
    },
    confidence: 900,
    keyPair: publisherA,
  })

  const detail = await api.getMediaEntity({ entityId: subject.entityId })
  const row = (await api.getMediaCatalog({})).items.find(item => item.entityId === subject.entityId)
  for (const summary of [detail.entity, row]) {
    t.alike(summary.genres, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], 'no more genres than ingest would have signed, and no oversized name')
    t.absent('releaseYear' in summary, 'a year before the ingest window is refused rather than relayed')
    t.absent('runtimeMinutes' in summary, 'a runtime past the ingest bound is refused rather than relayed')
  }
})
