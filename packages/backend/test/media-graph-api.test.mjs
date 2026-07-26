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

async function fixture() {
  const mediaGraphStore = createMediaGraphStore({ trustedSigners: [publisherA.publicKey, publisherB.publicKey, curator.publicKey] })
  const assetManifestStore = createAssetManifestStore({ trustedSigners: [publisherA.publicKey, publisherB.publicKey] })
  const sourcePreferenceStore = new Map()
  const api = createMediaGraphApi({
    mediaGraphStore,
    assetManifestStore,
    sourcePreferenceStore,
    trust: { [hex(publisherA.publicKey)]: 20, [hex(publisherB.publicKey)]: 5, [hex(curator.publicKey)]: 50 },
  })
  return { api, mediaGraphStore, assetManifestStore, sourcePreferenceStore }
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
  const { api, mediaGraphStore, assetManifestStore } = await fixture()
  const subject = workRef('pilot')
  const low = createPublicationManifest({ publisherId: publisherB.publicKey, sequence: 1, title: 'Low', renditions: [rendition(3)], keyPair: publisherB })
  const high = createPublicationManifest({ publisherId: publisherA.publicKey, sequence: 1, title: 'High', renditions: [rendition(1)], keyPair: publisherA })
  await assetManifestStore.ingestManifest(low)
  await assetManifestStore.ingestManifest(high)
  await ingestClaim(mediaGraphStore, { claimType: 'AvailabilityObservation', subjectRefs: [subject], payload: { publicationId: low.publicationId, availabilityStatus: 'available' }, confidence: 300, keyPair: publisherB })
  await ingestClaim(mediaGraphStore, { claimType: 'AvailabilityObservation', subjectRefs: [subject], payload: { publicationId: high.publicationId, availabilityStatus: 'available' }, confidence: 300, keyPair: publisherA })

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
  t.is(typeof scored.items[0].scorePublisherTrust, 'number')
  t.is(typeof scored.items[0].scoreAvailability, 'number')
  t.is(scored.items[0].availabilityState, 'available')

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

test('media graph API translates signed diagnostic components to schema-safe uints', async t => {
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
      })
    },
    sourcePreferenceStore: new Map()
  })

  const result = await api.getPublicationSources({ entityId: 'entity-1' })
  t.is(result.success, true)
  t.is(result.items[0].scoreModerationPenalty, 40)
  for (const field of [
    'scoreMetadataConfidence',
    'scorePublisherTrust',
    'scoreAvailability',
    'scoreFormatSupport',
    'scoreModerationPenalty'
  ]) t.ok(Number.isSafeInteger(result.items[0][field]) && result.items[0][field] >= 0)
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
