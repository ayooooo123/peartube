import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  createAssetManifestStore,
  decodePublicationManifest,
  encodePublicationManifest,
  verifyCatalogPublicationManifest,
} from '../assets/index.js'
import { decodeApplicationEnvelope, encodeApplicationEnvelope } from '../records/application-envelope.js'
import { PUBLISHER_LIMITS, PUBLISHER_RECORD_TYPES, toHex } from '../publisher/canonical.js'
import { decodeClaimBody } from './claims.js'
import { resolveConsumerMediaEntity } from './resolver.js'
import { createMediaGraphStore } from './store.js'

const PAGE_LIMIT = PUBLISHER_LIMITS.maxApplyBatch
const DEFAULT_MAX_CATALOGS = 64
const DEFAULT_MAX_OPERATIONS = PUBLISHER_LIMITS.maxJournalOperations

function exactHex(value, name) {
  return toHex(value, 32, name)
}

function safeLimit(value, fallback, maximum, name) {
  const next = value ?? fallback
  if (!Number.isSafeInteger(next) || next < 1 || next > maximum) throw new TypeError(`${name} is out of bounds`)
  return next
}

function currentWriter(authorization, operation, capability, now) {
  if (!authorization || !Array.isArray(authorization.writers)) return null
  let signer
  try {
    signer = exactHex(operation.signerKey, 'operation signer')
  } catch {
    return null
  }
  const writer = authorization.writers.find(candidate => candidate?.signerKey === signer)
  if (!writer || !Array.isArray(writer.capabilities) || !writer.capabilities.includes(capability)) return null
  if (writer.revocation) return null
  if (!Number.isSafeInteger(writer.expiresAt) || writer.expiresAt < now) return null
  if (!Number.isSafeInteger(writer.admissionPolicyEpoch) || operation.policyEpoch !== writer.admissionPolicyEpoch) return null
  if (!Number.isSafeInteger(operation.issuerSequence) || operation.issuerSequence < writer.firstAcceptedSequence || operation.issuerSequence > writer.lastAcceptedSequence) return null
  return writer
}

function exactOperationPublisher(operation, publisherId) {
  try {
    return exactHex(operation.issuerIdentityKey, 'operation publisher') === publisherId
  } catch {
    return false
  }
}

function decodeCanonicalApplicationEnvelope(payload) {
  try {
    const envelope = decodeApplicationEnvelope(payload)
    if (!b4a.equals(encodeApplicationEnvelope(envelope), payload)) return null
    return envelope
  } catch {
    return null
  }
}

function proxyStore(getCurrent, methods) {
  return Object.freeze(Object.fromEntries(methods.map(method => [method, (...args) => getCurrent()[method](...args)])))
}

function changeCount(previous, next) {
  let count = 0
  for (const key of previous) if (!next.has(key)) count++
  for (const key of next) if (!previous.has(key)) count++
  return count
}

function revisionFor(keys) {
  return b4a.toString(crypto.hash(b4a.from([...keys].sort().join('\n'))), 'hex')
}

export function createPublisherCatalogProjection(options = {}) {
  const registry = options.catalogRegistry
  if (!registry || typeof registry.listBindings !== 'function') throw new TypeError('catalogRegistry.listBindings is required')
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null
  const maxCatalogs = safeLimit(options.maxCatalogs, DEFAULT_MAX_CATALOGS, DEFAULT_MAX_CATALOGS, 'maxCatalogs')
  const maxOperations = safeLimit(options.maxOperations, DEFAULT_MAX_OPERATIONS, DEFAULT_MAX_OPERATIONS, 'maxOperations')

  let activePublicationRecords = new Map()
  let activeClaimRecords = new Map()
  let graph = createMediaGraphStore({ trustedSigners: [] })
  let manifests = createAssetManifestStore({ trustedSigners: [] })
  let revision = revisionFor(new Set())
  let acceptedKeys = new Set()
  let rebuilding = null
  let rebuildRequested = false
  let closed = false

  const mediaGraphStore = proxyStore(() => graph, [
    'getClaim', 'getClaims', 'getClaimsBySubject', 'getClaimsByIssuer', 'getClaimsByPredicate',
    'getClaimsByExternalRef', 'getClaimsByPublication', 'getClaimsByCollection', 'scanClaims',
    'getQuarantinedClaims', 'ingestClaim',
  ])
  const assetManifestStore = proxyStore(() => manifests, [
    'getManifest', 'getManifestByPublisherSequence', 'getManifestsByRendition',
    'getSupersedingManifests', 'getCurrentPublisherHead', 'getQuarantinedManifests', 'ingestManifest',
    'getRenditionRequirement',
  ])

  async function catalogOperations(catalog, kind, remaining) {
    const output = []
    let cursor = null
    do {
      const limit = Math.min(PAGE_LIMIT, remaining - output.length)
      if (limit < 1) throw new Error('publisher catalog projection exceeds its operation bound')
      const page = await catalog.listProjections(kind, { cursor, limit })
      if (!page || !Array.isArray(page.items) || page.items.length > limit) throw new Error('publisher catalog returned an invalid projection page')
      output.push(...page.items)
      if (page.nextCursor != null && (typeof page.nextCursor !== 'string' || !/^[0-9a-f]{64}$/.test(page.nextCursor))) {
        throw new Error('publisher catalog returned an invalid projection cursor')
      }
      if (page.nextCursor != null && page.nextCursor === cursor) throw new Error('publisher catalog projection cursor did not advance')
      cursor = page.nextCursor ?? null
    } while (cursor !== null)
    return output
  }

  async function performRebuild() {
    if (closed) throw new Error('publisher catalog projection is closed')
    const bindings = await registry.listBindings()
    if (!Array.isArray(bindings) || bindings.length > maxCatalogs) throw new Error('publisher catalog projection exceeds its catalog bound')
    const orderedBindings = [...bindings].sort((left, right) => exactHex(left.publisherId, 'publisherId').localeCompare(exactHex(right.publisherId, 'publisherId')))
    const publicationCandidates = []
    const claimCandidates = []
    let scanned = 0

    for (const binding of orderedBindings) {
      const catalog = binding?.catalog
      if (!catalog || typeof catalog.update !== 'function' || typeof catalog.getAuthorizationState !== 'function' || typeof catalog.listProjections !== 'function') {
        throw new Error('publisher catalog binding is incomplete')
      }
      await catalog.update()
      const authorization = await catalog.getAuthorizationState()
      const publisherId = exactHex(binding.publisherId, 'publisherId')
      const publications = await catalogOperations(catalog, 'publication', maxOperations - scanned)
      scanned += publications.length
      const claims = await catalogOperations(catalog, 'claim', maxOperations - scanned)
      scanned += claims.length
      for (const operation of publications) publicationCandidates.push({ authorization, publisherId, operation })
      for (const operation of claims) claimCandidates.push({ authorization, publisherId, operation })
    }

    const nextPublicationRecords = new Map()
    for (const candidate of publicationCandidates) {
      const { authorization, publisherId, operation } = candidate
      if (operation.recordType !== PUBLISHER_RECORD_TYPES.PUBLICATION || !exactOperationPublisher(operation, publisherId) || !currentWriter(authorization, operation, 'publish', now())) continue
      const payload = operation.body?.payload
      let publicationId
      let manifestId
      try {
        publicationId = exactHex(operation.body.publicationId, 'publicationId')
        manifestId = exactHex(operation.body.manifestId, 'manifestId')
      } catch {
        continue
      }
      let manifest
      try {
        manifest = decodePublicationManifest(payload)
      } catch {
        continue
      }
      if (!await verifyCatalogPublicationManifest(manifest, {
        publisherId,
        publicationId,
        manifestId,
        signer: operation.signerKey,
        payload,
        now: operation.signedAt,
      })) continue
      const key = `${publisherId}:publication:${publicationId}`
      nextPublicationRecords.set(publicationId, { key, publisherId, operation, manifest, payload: b4a.from(payload) })
    }

    const nextClaimRecords = new Map()
    for (const candidate of claimCandidates) {
      const { authorization, publisherId, operation } = candidate
      if (operation.recordType !== PUBLISHER_RECORD_TYPES.CLAIM || !exactOperationPublisher(operation, publisherId) || !currentWriter(authorization, operation, 'claim', now())) continue
      const payload = operation.body?.payload
      const envelope = decodeCanonicalApplicationEnvelope(payload)
      if (!envelope) continue
      let claimId
      let signer
      let body
      try {
        claimId = exactHex(operation.body.claimId, 'claimId')
        signer = exactHex(operation.signerKey, 'operation signer')
        body = decodeClaimBody(envelope.body)
      } catch {
        continue
      }
      if (exactHex(envelope.recordId, 'claim recordId') !== claimId ||
          exactHex(envelope.signer, 'claim signer') !== signer ||
          body.claimType !== operation.body.claimType) continue
      if (body.claimType === 'AvailabilityObservation' &&
          (!body.payload?.publicationId || !nextPublicationRecords.has(body.payload.publicationId))) continue
      const key = `${publisherId}:claim:${claimId}`
      nextClaimRecords.set(claimId, { key, publisherId, operation, envelope, payload: b4a.from(payload) })
    }

    const allowedClaimIds = new Set(nextClaimRecords.keys())
    const allowedSigners = new Set([...nextClaimRecords.values()].map(record => exactHex(record.envelope.signer, 'claim signer')))
    const nextGraph = createMediaGraphStore({
      authorizeSigner: signer => allowedSigners.has(exactHex(signer, 'claim signer')),
      acceptClaim: (_body, context) => allowedClaimIds.has(context.claimId),
      resolvePublisherId: (_body, context) => nextClaimRecords.get(context.claimId)?.publisherId,
    })
    const orderedClaims = [...nextClaimRecords.values()].sort((left, right) => {
      const publisherOrder = left.publisherId.localeCompare(right.publisherId)
      if (publisherOrder) return publisherOrder
      const sequenceOrder = left.operation.issuerSequence - right.operation.issuerSequence
      return sequenceOrder || left.key.localeCompare(right.key)
    })
    for (const record of orderedClaims) {
      const result = await nextGraph.ingestClaim(record.envelope)
      if (result.status !== 'accepted' && result.status !== 'duplicate') nextClaimRecords.delete(exactHex(record.envelope.recordId, 'claimId'))
    }

    const nextManifestStore = createAssetManifestStore({
      verifyManifest: async manifest => {
        const record = nextPublicationRecords.get(manifest?.publicationId)
        if (!record) return false
        let payload
        try { payload = encodePublicationManifest(manifest) } catch { return false }
        return b4a.equals(payload, record.payload)
      },
    })
    for (const record of [...nextPublicationRecords.values()].sort((left, right) => left.key.localeCompare(right.key))) {
      const result = await nextManifestStore.ingestManifest(record.manifest)
      if (result.status !== 'accepted' && result.status !== 'duplicate') nextPublicationRecords.delete(record.manifest.publicationId)
    }

    const nextKeys = new Set([
      ...[...nextPublicationRecords.values()].map(record => record.key),
      ...[...nextClaimRecords.values()].map(record => record.key),
    ])
    const nextRevision = revisionFor(nextKeys)
    const changedCount = changeCount(acceptedKeys, nextKeys)

    activePublicationRecords = nextPublicationRecords
    activeClaimRecords = nextClaimRecords
    graph = nextGraph
    manifests = nextManifestStore
    acceptedKeys = nextKeys
    const didChange = revision !== nextRevision
    revision = nextRevision
    if (didChange && onUpdate) await onUpdate({ revision, changedCount })
    return {
      revision,
      changedCount,
      acceptedPublications: activePublicationRecords.size,
      acceptedClaims: activeClaimRecords.size,
      scannedOperations: scanned,
    }
  }

  function rebuild() {
    rebuildRequested = true
    if (rebuilding) return rebuilding
    rebuilding = (async () => {
      let result
      do {
        rebuildRequested = false
        result = await performRebuild()
      } while (rebuildRequested && !closed)
      return result
    })().finally(() => { rebuilding = null })
    return rebuilding
  }

  return Object.freeze({
    mediaGraphStore,
    assetManifestStore,
    rebuild,
    update: rebuild,
    get revision() { return revision },
    async authorizeRendition({ manifest, renditionId, start = 0, end = null } = {}) {
      await rebuild()
      const record = activePublicationRecords.get(manifest?.publicationId)
      if (!record) return false
      let payload
      try { payload = encodePublicationManifest(manifest) } catch { return false }
      if (!b4a.equals(payload, record.payload)) return false
      const rendition = manifest.body?.renditions?.find(candidate => candidate.renditionId === renditionId)
      if (!rendition || rendition.blocked || rendition.superseded) return false
      const length = Number(rendition.core?.length)
      if (!Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(start) || start < 0 || start >= length) return false
      if (end !== null && (!Number.isSafeInteger(end) || end <= start || end > length)) return false
      const uploadRanges = (manifest.body?.provenance || []).filter(candidate =>
        candidate?.type === 'upload' &&
        candidate.renditionId === renditionId &&
        candidate.coreKey === rendition.core?.key &&
        Number.isSafeInteger(candidate.start) &&
        Number.isSafeInteger(candidate.end) &&
        candidate.start >= 0 &&
        candidate.end > candidate.start
      )
      if (uploadRanges.length > 0 && !uploadRanges.some(candidate =>
        start >= candidate.start && end !== null && end <= candidate.end
      )) return false
      return true
    },
    async close() {
      closed = true
      if (rebuilding) await rebuilding.catch(() => {})
    },
  })
}

const CONSUMER_DEFAULT_LIMIT = 20
const CONSUMER_MAX_LIMIT = 50
const CONSUMER_MAX_REJECTIONS = 256

function consumerLimit(value) {
  if (value == null) return CONSUMER_DEFAULT_LIMIT
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONSUMER_MAX_LIMIT) throw new Error('consumer catalog limit must be between 1 and 50')
  return limit
}

function isVisibleDecision(decision) {
  return !decision || decision.action === 'visible' || decision.action === 'allow'
}

function consumerKindRank(kind) {
  if (kind === 'movie') return 0
  if (kind === 'series') return 1
  return 2
}

function getProfileEnabled(profile) {
  if (!profile) return true
  return typeof profile.enabled === 'function' ? profile.enabled() !== false : profile.enabled !== false
}

function claimCollectionId(row) {
  return row?.body?.payload?.collectionRef?.entityId || null
}

function claimMemberId(row) {
  return row?.body?.payload?.memberRef?.entityId || null
}

function claimModerationEntity(row, publicationId = null) {
  const subjectRefs = row?.body?.subjectRefs || []
  const payload = row?.body?.payload || {}
  const relatedRefs = [
    ...subjectRefs,
    payload.collectionRef,
    payload.memberRef,
    payload.subjectRef,
  ].filter(ref => ref?.entityId)
  const workIds = Array.from(new Set(
    relatedRefs.filter(ref => ref.entityKind === 'work').map(ref => ref.entityId)
  ))
  const collectionIds = Array.from(new Set(
    relatedRefs.filter(ref => ref.entityKind === 'collection').map(ref => ref.entityId)
  ))
  const work = workIds[0] || null
  const collection = collectionIds[0] || null
  const entityRef = subjectRefs[0]?.entityId || work || collection || null
  return {
    entityRef,
    entityId: entityRef,
    workId: work,
    workIds,
    collectionId: collection,
    collectionIds,
    publisherId: row?.publisherId || row?.issuer || null,
    publisherRootKey: row?.publisherId || row?.issuer || null,
    publicationId: publicationId || payload.publicationId || null,
  }
}

function claimRelatedEntityIds(row) {
  const payload = row?.body?.payload || {}
  return Array.from(new Set([
    ...(row?.body?.subjectRefs || []).map(ref => ref?.entityId),
    payload.collectionRef?.entityId,
    payload.memberRef?.entityId,
    payload.subjectRef?.entityId,
  ].filter(Boolean)))
}

function publicationLinksByClaim(topologyClaims, availabilityClaims = topologyClaims) {
  const parents = new Map()

  function root(entityId) {
    if (!parents.has(entityId)) parents.set(entityId, entityId)
    let value = entityId
    while (parents.get(value) !== value) value = parents.get(value)
    let current = entityId
    while (parents.get(current) !== current) {
      const next = parents.get(current)
      parents.set(current, value)
      current = next
    }
    return value
  }

  function union(entityIds) {
    if (entityIds.length < 2) return
    const first = root(entityIds[0])
    for (const entityId of entityIds.slice(1)) {
      const next = root(entityId)
      if (next !== first) parents.set(next, first)
    }
  }

  for (const row of topologyClaims) {
    const related = claimRelatedEntityIds(row)
    for (const entityId of related) root(entityId)
    if (
      row.body?.claimType === 'EquivalentEntityClaim' ||
      row.body?.claimType === 'CollectionMembershipClaim'
    ) union(related)
  }

  const byIssuerAndCluster = new Map()
  for (const row of availabilityClaims) {
    if (row.body?.claimType !== 'AvailabilityObservation') continue
    const publicationId = row.body?.payload?.publicationId
    if (!publicationId) continue
    const publisherId = row.publisherId || row.issuer
    for (const entityId of claimRelatedEntityIds(row)) {
      const key = `${publisherId}\0${root(entityId)}`
      const linked = byIssuerAndCluster.get(key) || new Set()
      linked.add(publicationId)
      byIssuerAndCluster.set(key, linked)
    }
  }

  return row => {
    if (row.body?.payload?.publicationId) {
      return new Set([row.body.payload.publicationId])
    }
    const publicationIds = new Set()
    const publisherId = row.publisherId || row.issuer
    for (const entityId of claimRelatedEntityIds(row)) {
      const linked = byIssuerAndCluster.get(`${publisherId}\0${root(entityId)}`)
      for (const publicationId of linked || []) publicationIds.add(publicationId)
    }
    return publicationIds
  }
}

function visibleClaimsForConsumer(claims, moderationPolicy) {
  const evaluation = typeof moderationPolicy?.beginEvaluation === 'function'
    ? moderationPolicy.beginEvaluation()
    : moderationPolicy
  const enabled = getProfileEnabled(evaluation)
  if (!enabled || typeof evaluation?.evaluate !== 'function') return claims.slice()
  const baseVisibleClaims = claims.filter(row => {
    const base = claimModerationEntity(row)
    return isVisibleDecision(evaluation.evaluate(base))
  })
  const linkedPublicationIds = publicationLinksByClaim(baseVisibleClaims, claims)
  return baseVisibleClaims.filter(row => {
    if (row.body?.payload?.publicationId) return true
    for (const publicationId of linkedPublicationIds(row)) {
      if (!isVisibleDecision(evaluation.evaluate(claimModerationEntity(row, publicationId)))) return false
    }
    return true
  })
}

function claimStoreView(store, claims) {
  const allowed = new Set(claims.map(row => row.claimId))
  return {
    getClaims() {
      return claims.slice()
    },
    getClaimsBySubject(entityId) {
      return store.getClaimsBySubject(entityId).filter(row => allowed.has(row.claimId))
    },
  }
}

/**
 * Project only authenticated publisher catalog state into consumer records.
 * Collections remain graph entities; "series" is strictly a local presentation.
 */
// A publisher may claim several artwork roles; the catalog record carries one
// display locator, and moderation is applied to that locator. Preferring the
// poster keeps a shelf uniform, and a plain string stays supported because
// older claims carry the locator directly.
//
// A blob in the publisher's own core wins over any origin the claim names: it
// replicates on the same swarm as the content, so it works offline and does not
// tell a third party who is browsing what. The locator is the canonical blob
// ref string, which parseBlobRef already understands.
function artworkEntry(artwork) {
  if (typeof artwork === 'string') return artwork ? { locator: artwork, mimeType: null } : null
  if (!Array.isArray(artwork)) return null
  const roles = ['poster', 'thumbnail', 'still', 'backdrop']
  for (const preferBlob of [true, false]) {
    for (const role of roles) {
      for (const entry of artwork) {
        if (entry?.role !== role) continue
        const mimeType = typeof entry.mimeType === 'string' && entry.mimeType ? entry.mimeType : null
        const blobId = typeof entry.blobId === 'string' ? entry.blobId.trim() : ''
        const blobsCoreKey = typeof entry.blobsCoreKey === 'string' ? entry.blobsCoreKey.trim() : ''
        if (blobId && blobsCoreKey) return { locator: `blob:${blobsCoreKey}@${blobId}`, mimeType }
        if (preferBlob) continue
        const remoteUrl = typeof entry.remoteUrl === 'string' ? entry.remoteUrl.trim() : ''
        if (remoteUrl) return { locator: remoteUrl, mimeType }
      }
    }
  }
  return null
}

function artworkLocator(artwork) {
  return artworkEntry(artwork)?.locator ?? null
}

function artworkMimeType(artwork) {
  return artworkEntry(artwork)?.mimeType ?? null
}

// What a viewer reads before pressing play travels on the same claim as the
// title, because a consumer holds no metadata-provider credentials and cannot
// look any of it up.
function describedMedia(metadata) {
  const out = {}
  const year = Number(metadata?.releaseYear)
  if (Number.isSafeInteger(year) && year > 0) out.releaseYear = year
  const runtime = Number(metadata?.runtimeMinutes)
  if (Number.isSafeInteger(runtime) && runtime > 0) out.runtimeMinutes = runtime
  if (typeof metadata?.overview === 'string' && metadata.overview) out.overview = metadata.overview
  if (Array.isArray(metadata?.genres)) {
    const genres = metadata.genres.filter(genre => typeof genre === 'string' && genre)
    if (genres.length > 0) out.genres = genres
  }
  return out
}

export function projectAuthenticatedPublisherMediaRecords({
  mediaGraphStore,
  assetManifestStore,
  moderationPolicy = null,
  consumerClaims = null,
} = {}) {
  if (!mediaGraphStore?.getClaims || !assetManifestStore?.getManifest) return []
  const authenticatedClaims = mediaGraphStore.getClaims().filter(row => !row.revoked)
  const claims = Array.isArray(consumerClaims)
    ? consumerClaims
    : visibleClaimsForConsumer(authenticatedClaims, moderationPolicy)
  const resolverStore = claimStoreView(mediaGraphStore, claims)
  const memberships = claims.filter(row =>
    row.body?.claimType === 'CollectionMembershipClaim' &&
    row.body?.payload?.memberRole === 'episode' &&
    claimCollectionId(row) &&
    claimMemberId(row)
  )
  const structures = claims.filter(row => row.body?.claimType === 'CollectionStructureClaim')
  const records = []
  for (const availability of claims) {
    if (availability.body?.claimType !== 'AvailabilityObservation') continue
    const publicationId = availability.body?.payload?.publicationId
    const manifest = assetManifestStore.getManifest(publicationId)
    if (!manifest?.body?.publisherId) continue
    for (const subject of availability.body.subjectRefs || []) {
      const memberOf = memberships.filter(row => claimMemberId(row) === subject.entityId)
      const work = resolveConsumerMediaEntity(resolverStore, subject.entityId, { entityKind: 'work' })
      if (memberOf.length === 0) {
        records.push({
          directPublisher: true,
          kind: 'movie',
          entityRef: subject.entityId,
          publicationId: manifest.publicationId,
          publisherId: manifest.body.publisherId,
          title: work.metadata.title || manifest.body.title || null,
          artwork: artworkLocator(work.metadata.artwork),
          artworkMimeType: artworkMimeType(work.metadata.artwork),
          ranking: Number.isFinite(work.metadata.ranking) ? work.metadata.ranking : null,
          ...describedMedia(work.metadata),
          playable: true,
        })
        continue
      }
      for (const membership of memberOf) {
        const collectionId = claimCollectionId(membership)
        const collection = resolveConsumerMediaEntity(resolverStore, collectionId, { entityKind: 'collection' })
        const expectedEpisodeCount = structures
          .filter(row => claimCollectionId(row) === collectionId)
          .reduce((maximum, row) => Math.max(maximum, Number(row.body.payload.expectedSlots || 0)), 0)
        records.push({
          directPublisher: true,
          kind: 'series',
          entityRef: collectionId,
          collectionId,
          publicationId: manifest.publicationId,
          publisherId: manifest.body.publisherId,
          title: collection.metadata.title || work.metadata.title || manifest.body.title || null,
          artwork: artworkLocator(collection.metadata.artwork) || artworkLocator(work.metadata.artwork),
          artworkMimeType: artworkMimeType(collection.metadata.artwork) || artworkMimeType(work.metadata.artwork),
          ranking: Number.isFinite(collection.metadata.ranking)
            ? collection.metadata.ranking
            : (Number.isFinite(work.metadata.ranking) ? work.metadata.ranking : null),
          playable: true,
          expectedEpisodeCount,
          seriesEpisode: {
            entityRef: subject.entityId,
            title: work.metadata.title || manifest.body.title || null,
            seasonNumber: Number(membership.body.payload.position?.season || 0),
            episodeNumber: Number(membership.body.payload.position?.episode || 0),
            publicationId: manifest.publicationId,
            publisherId: manifest.body.publisherId,
          },
        })
      }
    }
  }
  return records.sort((left, right) => (
    consumerKindRank(left.kind) - consumerKindRank(right.kind) ||
    String(left.entityRef).localeCompare(String(right.entityRef)) ||
    Number(left.seriesEpisode?.seasonNumber || 0) - Number(right.seriesEpisode?.seasonNumber || 0) ||
    Number(left.seriesEpisode?.episodeNumber || 0) - Number(right.seriesEpisode?.episodeNumber || 0) ||
    String(left.publisherId).localeCompare(String(right.publisherId)) ||
    String(left.publicationId).localeCompare(String(right.publicationId))
  ))
}

/**
 * A local view over the existing bounded index. It owns no feed and performs no
 * network or asset work: sources feed it only after their normal authentication
 * and ingestion checks have completed.
 */
export function createConsumerCatalogProjection(options = {}) {
  const localIndex = options.localIndex
  if (
    !localIndex ||
    typeof localIndex.replaceRecords !== 'function' ||
    typeof localIndex.search !== 'function' ||
    typeof localIndex.records !== 'function'
  ) {
    throw new TypeError('localIndex with replaceRecords, search, and records is required')
  }
  const bootstrapManager = options.bootstrapManager || null
  const indexFeedManager = options.indexFeedManager || null
  const mediaGraphStore = options.mediaGraphStore || null
  const moderationPolicy = options.moderationPolicy || null
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const maxCandidates = safeLimit(options.maxCandidates, 4096, 10_000, 'maxCandidates')
  let rejectedCandidates = []
  let introducedPublisherIds = []
  let lastInputFingerprint = null
  let lastNextRetryAt = null
  let lastRebuild = { accepted: 0, rejected: 0, rejectionCodes: {} }
  let acceptedCandidates = new Map()
  let visibleEntityRefs = new Set()
  let visiblePublicationIds = new Set()
  let visibleClaimIds = null
  const downstream = {
    artwork: options.onArtwork,
    topic: options.onTopicJoin,
    playback: options.onPlaybackPreparation,
    cache: options.onCache,
    seed: options.onSeed,
    archive: options.onArchive,
  }

  function availablePublishers() {
    if (!bootstrapManager || typeof bootstrapManager.listLocators !== 'function') return null
    return new Set(bootstrapManager.listLocators().map(locator => String(locator?.publisherId || '').toLowerCase()).filter(Boolean))
  }

  function reject(record, reason, rejectionCodes, rejectionCode = reason) {
    if (rejectedCandidates.length < CONSUMER_MAX_REJECTIONS) {
      rejectedCandidates.push({ entityRef: record.entityRef, reason })
    }
    rejectionCodes[rejectionCode] = (rejectionCodes[rejectionCode] || 0) + 1
  }

  function resolvedRecord(record, resolverStore) {
    if (!mediaGraphStore || typeof mediaGraphStore.getClaimsBySubject !== 'function') return record
    if (mediaGraphStore.getClaimsBySubject(record.entityRef).length === 0) return record
    const resolved = resolveConsumerMediaEntity(
      resolverStore,
      record.entityRef,
      { entityKind: record.kind },
    )
    return {
      ...record,
      title: resolved.metadata.title || record.title,
      artwork: artworkLocator(resolved.metadata.artwork) || record.artwork,
      artworkMimeType: artworkMimeType(resolved.metadata.artwork) || record.artworkMimeType || null,
      ranking: Number.isFinite(resolved.metadata.ranking) ? resolved.metadata.ranking : record.ranking,
      // Resolution can merge claims from several publishers; whichever one
      // described the title wins over a record that carries nothing.
      ...describedMedia(record),
      ...describedMedia(resolved.metadata),
      entityKind: resolved.entityKind,
    }
  }

  return Object.freeze({
    rebuild() {
      const indexCandidates = indexFeedManager?.getRecords?.() || []
      const moderationEvaluation = typeof moderationPolicy?.beginEvaluation === 'function'
        ? moderationPolicy.beginEvaluation()
        : moderationPolicy
      const visibleClaims = mediaGraphStore?.getClaims
        ? visibleClaimsForConsumer(
            mediaGraphStore.getClaims().filter(row => !row.revoked),
            moderationEvaluation,
          )
        : null
      const resolverStore = visibleClaims
        ? claimStoreView(mediaGraphStore, visibleClaims)
        : mediaGraphStore
      // Catalog claims are the only display authority. Curator records are
      // bounded discovery/deduplication hints and are never returned as titles,
      // kinds, creators, or playable state.
      const publisherRecords = (typeof options.publisherRecords === 'function'
        ? options.publisherRecords({ moderationPolicy: moderationEvaluation, visibleClaims }) || []
        : [])
        .filter(record => record?.directPublisher === true)
      const authenticated = new Map()
      for (const record of publisherRecords) {
        authenticated.set(`${String(record.publisherId).toLowerCase()}\0${String(record.publicationId)}`, record)
      }
      const records = [...publisherRecords]
      for (const hint of indexCandidates) {
        const authoritative = authenticated.get(`${String(hint?.publisherId).toLowerCase()}\0${String(hint?.publicationId)}`)
        if (authoritative) records.push(authoritative)
      }
      const accepted = []
      const acceptedKeys = new Set()
      const consideredKeys = new Set()
      const rejectionCodes = {}
      const publishers = availablePublishers()
      rejectedCandidates = []
      introducedPublisherIds = publishers ? Array.from(publishers).sort() : []
      for (const record of records) {
        const publisherId = String(record?.publisherId || '').toLowerCase()
        if (record?.directPublisher !== true) { reject(record, 'PUBLISHER_RECORD_UNAUTHENTICATED', rejectionCodes); continue }
        const candidateKey = `${publisherId}\0${String(record.publicationId)}`
        if (acceptedKeys.has(candidateKey) || consideredKeys.has(candidateKey)) continue
        consideredKeys.add(candidateKey)
        const enabled = getProfileEnabled(moderationEvaluation)
        const decision = enabled && typeof moderationEvaluation?.evaluate === 'function'
          ? moderationEvaluation.evaluate(record)
          : { action: 'visible', reason: enabled ? 'default' : 'disabled' }
        if (!isVisibleDecision(decision)) {
          const code = `LOCAL_MODERATION_${String(decision.action || 'BLOCKED').toUpperCase()}`
          reject(record, decision.reason || code, rejectionCodes, code)
          continue
        }
        if (accepted.length >= maxCandidates) {
          reject(record, 'CONSUMER_CANDIDATE_BUDGET_EXCEEDED', rejectionCodes)
          continue
        }
        accepted.push(resolvedRecord(record, resolverStore))
        acceptedKeys.add(candidateKey)
      }
      accepted.sort((left, right) => (
        String(left.entityRef).localeCompare(String(right.entityRef)) ||
        String(left.publisherId).localeCompare(String(right.publisherId)) ||
        String(left.publicationId).localeCompare(String(right.publicationId)) ||
        String(left.sourceId || '').localeCompare(String(right.sourceId || ''))
      ))
      const fingerprint = JSON.stringify({
        accepted,
        rejected: rejectedCandidates,
        introducedPublisherIds,
        visibleClaimIds: visibleClaims?.map(row => row.claimId).sort() || null,
      })
      const currentTime = Number(now())
      if (
        fingerprint === lastInputFingerprint &&
        (
          lastNextRetryAt == null ||
          !Number.isFinite(currentTime) ||
          currentTime < lastNextRetryAt
        )
      ) {
        return { ...lastRebuild, rejectionCodes: { ...lastRebuild.rejectionCodes } }
      }
      const indexed = localIndex.replaceRecords(accepted)
      const admitted = Array.isArray(indexed.admittedRecords)
        ? indexed.admittedRecords
        : (typeof localIndex.records === 'function' ? localIndex.records() : [])
      acceptedCandidates = new Map(admitted.map(record => [record.entityRef, record]))
      visibleEntityRefs = new Set(admitted.flatMap(record => [
        String(record.entityRef),
        ...(record.seriesEpisode?.entityRef ? [String(record.seriesEpisode.entityRef)] : []),
      ]))
      visiblePublicationIds = new Set(admitted.map(record => String(record.publicationId)))
      visibleClaimIds = visibleClaims == null
        ? null
        : new Set(visibleClaims.map(row => row.claimId))
      lastInputFingerprint = fingerprint
      const retryTimes = (indexed.results || [])
        .map(result => Number(result?.resetAt))
        .filter(resetAt => Number.isSafeInteger(resetAt) && resetAt >= 0)
      lastNextRetryAt = retryTimes.length > 0 ? Math.min(...retryTimes) : null
      lastRebuild = {
        accepted: indexed.accepted + indexed.duplicates,
        rejected: rejectedCandidates.length + indexed.rejected,
        rejectionCodes,
        ...(lastNextRetryAt == null ? {} : { nextRetryAt: lastNextRetryAt }),
      }
      return { ...lastRebuild, rejectionCodes: { ...lastRebuild.rejectionCodes } }
    },
    update() { return this.rebuild() },
    getCatalog(request = {}) {
      const limit = consumerLimit(request.limit)
      const rows = localIndex.search('').slice().sort((left, right) => {
        const kind = consumerKindRank(left.entityKind) - consumerKindRank(right.entityKind)
        return kind || left.entityRef.localeCompare(right.entityRef)
      })
      let offset = 0
      if (request.cursor != null) {
        const index = rows.findIndex(row => row.entityRef === request.cursor)
        if (index < 0) return { success: false, errorCode: 'INVALID_CURSOR', items: [], nextCursor: null }
        offset = index + 1
      }
      const items = rows.slice(offset, offset + limit)
      return {
        success: true,
        items,
        nextCursor: offset + limit < rows.length ? items.at(-1).entityRef : null,
      }
    },
    getRejectedCandidates() { return rejectedCandidates.slice() },
    isVisible(entityRef) { return visibleEntityRefs.has(String(entityRef)) },
    isPublicationVisible(publicationId) {
      const value = b4a.isBuffer(publicationId) || publicationId instanceof Uint8Array
        ? b4a.toString(b4a.from(publicationId), 'hex')
        : String(publicationId)
      return visiblePublicationIds.has(value)
    },
    isClaimVisible(claimId) {
      return visibleClaimIds == null || visibleClaimIds.has(String(claimId))
    },
    getIntroducedPublishers() { return introducedPublisherIds.slice() },
    getCuratorSubscriptions() {
      return Array.from(moderationPolicy?.curatorSubscriptions || []).map(String).sort()
    },
    async schedule(entityRef, operations = []) {
      const record = acceptedCandidates.get(String(entityRef))
      if (!record) return { scheduled: false, errorCode: 'CONSUMER_CANDIDATE_NOT_VISIBLE' }
      const names = Array.from(new Set(operations)).filter(name => Object.hasOwn(downstream, name))
      for (const name of names) await downstream[name]?.(record)
      return { scheduled: true, operations: names }
    },
  })
}
