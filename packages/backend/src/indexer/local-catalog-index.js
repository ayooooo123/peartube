import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { decodePublicationManifest, encodePublicationManifest } from '../assets/index.js'
import { requiredRangesForRendition } from '../assets/availability.js'
import { isArtworkRendition, normalizeAssetCoreRefV2 } from '../assets/rendition.js'
import { decodeClaimBody } from '../media-graph/claims.js'
import { resolveMediaEntity } from '../media-graph/resolver.js'
import { decodeApplicationEnvelope } from '../records/application-envelope.js'
import { PUBLISHER_LIMITS, PUBLISHER_RECORD_TYPES, decodePublisherCatalogFrame, decodePublisherOperationBody } from '../publisher/index.js'
import { createCatalogIngestor } from './catalog-ingestor.js'
import { mapIndexQueryResult } from './query-dispatcher.js'
import {
  MAX_INDEX_QUERY_CURSOR_BYTES,
  MAX_INDEX_QUERY_DEADLINE_MS,
  MAX_INDEX_QUERY_RESULTS,
  normalizeIndexQuerySelectors,
} from './query-codec.js'
import { createIndexerStore } from './store.js'

const VERIFIED_QUERY_CORE_NAME = 'peartube-local-catalog-index-v3'
const CURSOR_BYTES = 32
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{43}$/
const HEX_32 = /^[0-9a-f]{64}$/

const MAX_VERIFIED_PUBLISHERS = 256
const AGGREGATE_LIMIT = Object.freeze({
  maxRetainedBytes: PUBLISHER_LIMITS.maxSnapshotBytes * MAX_VERIFIED_PUBLISHERS,
  maxRows: PUBLISHER_LIMITS.maxJournalOperations * MAX_VERIFIED_PUBLISHERS,
})
const PUBLISHER_LIMIT = Object.freeze({
  maxRetainedBytes: PUBLISHER_LIMITS.maxSnapshotBytes,
  maxRows: PUBLISHER_LIMITS.maxJournalOperations,
})
const VERIFIED_QUERY_LIMITS = Object.freeze({
  global: AGGREGATE_LIMIT,
  shard: AGGREGATE_LIMIT,
  publisher: PUBLISHER_LIMIT,
  trustClasses: Object.freeze({ untrusted: PUBLISHER_LIMIT }),
})

function fail(message, code = 'VERIFIED_QUERY_REJECTED') {
  const error = new Error(message)
  error.code = code
  throw error
}

function publisherId(value, name = 'publisherId') {
  const text = b4a.isBuffer(value) || value instanceof Uint8Array
    ? b4a.toString(b4a.from(value), 'hex')
    : value
  if (typeof text !== 'string' || !HEX_32.test(text)) throw new TypeError(`${name} must be a lowercase 32-byte hexadecimal identifier`)
  return text
}

function boundedText(value, name, maximum = MAX_INDEX_QUERY_CURSOR_BYTES) {
  if (typeof value !== 'string' || value.length === 0 || b4a.byteLength(value) > maximum) {
    throw new TypeError(`${name} must be bounded text`)
  }
  return value
}

function cursorToken(bytes) {
  return b4a.toString(bytes, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function isVisibleDecision(decision) {
  if (decision === undefined || decision === null || decision === true) return true
  if (decision === false) return false
  return decision.action === 'visible' || decision.action === 'allow'
}

function findManifestRendition(manifest, renditionId = null) {
  return manifest?.body?.renditions?.find(candidate => (
    candidate &&
    candidate.blocked !== true &&
    candidate.superseded !== true &&
    typeof candidate.renditionId === 'string' &&
    candidate.renditionId.length > 0 &&
    (renditionId === null ? !isArtworkRendition(candidate) : candidate.renditionId === renditionId)
  )) || null
}

function renditionRequirement(manifest, renditionId = null) {
  const rendition = findManifestRendition(manifest, renditionId)
  if (!rendition) return null
  let core
  try { core = normalizeAssetCoreRefV2(rendition.core) } catch { return null }
  return Object.freeze({
    publicationId: manifest.publicationId,
    renditionId: rendition.renditionId,
    coreKey: core.key,
    coreLength: core.length,
    requiredRanges: Object.freeze(requiredRangesForRendition(rendition)),
  })
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
  const workIds = [...new Set(relatedRefs.filter(ref => ref.entityKind === 'work').map(ref => ref.entityId))]
  const collectionIds = [...new Set(relatedRefs.filter(ref => ref.entityKind === 'collection').map(ref => ref.entityId))]
  const entityRef = subjectRefs[0]?.entityId || workIds[0] || collectionIds[0] || null
  return {
    entityRef,
    entityId: entityRef,
    workId: workIds[0] || null,
    workIds,
    collectionId: collectionIds[0] || null,
    collectionIds,
    publisherId: row?.publisherId || row?.issuer || null,
    publisherRootKey: row?.publisherId || row?.issuer || null,
    publicationId: publicationId || payload.publicationId || null,
  }
}

function publicationModerationEntity(publication) {
  return {
    entityRef: publication.workEntityId,
    entityId: publication.workEntityId,
    workId: publication.workEntityId,
    workIds: [publication.workEntityId],
    publisherId: publication.publisherId,
    publisherRootKey: publication.publisherId,
    publicationId: publication.publicationId,
  }
}

function queryModerationEntity(result) {
  if (result?.type === 'publication') return { ...result, ...publicationModerationEntity(result) }
  if (result?.type === 'rendition') {
    return {
      ...result,
      publisherRootKey: result.publisherId,
      renditionId: result.renditionId,
      publicationId: result.publicationId,
    }
  }
  if (result?.type === 'title-token') {
    return { ...result, entityRef: result.targetId, entityId: result.targetId, workId: result.targetId, workIds: [result.targetId] }
  }
  return { ...result, publisherRootKey: result?.publisherId || null, entityRef: result?.entityId || null }
}

function claimRelatedEntityIds(row) {
  const payload = row?.body?.payload || {}
  return [...new Set([
    ...(row?.body?.subjectRefs || []).map(ref => ref?.entityId),
    payload.collectionRef?.entityId,
    payload.memberRef?.entityId,
    payload.subjectRef?.entityId,
  ].filter(Boolean))]
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
    if (row.body?.claimType === 'EquivalentEntityClaim' ||
        row.body?.claimType === 'CollectionMembershipClaim') union(related)
  }
  const byIssuerAndCluster = new Map()
  for (const row of availabilityClaims) {
    if (row.body?.claimType !== 'AvailabilityObservation') continue
    const publicationId = row.body?.payload?.publicationId
    if (!publicationId) continue
    const publisher = row.publisherId || row.issuer
    for (const entityId of claimRelatedEntityIds(row)) {
      const key = `${publisher}\0${root(entityId)}`
      const linked = byIssuerAndCluster.get(key) || new Set()
      linked.add(publicationId)
      byIssuerAndCluster.set(key, linked)
    }
  }
  return row => {
    if (row.body?.payload?.publicationId) return new Set([row.body.payload.publicationId])
    const publicationIds = new Set()
    const publisher = row.publisherId || row.issuer
    for (const entityId of claimRelatedEntityIds(row)) {
      for (const linked of byIssuerAndCluster.get(`${publisher}\0${root(entityId)}`) || []) publicationIds.add(linked)
    }
    return publicationIds
  }
}

function decodeVerifiedClaims(sourceRecords) {
  const claims = []
  for (const source of sourceRecords) {
    if (source.recordType !== PUBLISHER_RECORD_TYPES.CLAIM) continue
    const frame = decodePublisherCatalogFrame(source.canonicalEnvelope)
    const operation = decodePublisherOperationBody(frame.recordType, frame.canonicalBody)
    const envelope = decodeApplicationEnvelope(operation.payload)
    const body = decodeClaimBody(envelope.body)
    const claimId = publisherId(envelope.recordId, 'claimId')
    const issuer = publisherId(envelope.signer, 'claim issuer')
    claims.push({
      claimId,
      envelope,
      body,
      issuer,
      publisherId: publisherId(source.publisherId),
      subjects: body.subjectRefs.map(ref => ref.entityId).sort(),
      revoked: false,
    })
  }
  claims.sort((left, right) => (
    left.issuer.localeCompare(right.issuer) ||
    left.body.issuerSequence - right.body.issuerSequence ||
    left.claimId.localeCompare(right.claimId)
  ))
  const byId = new Map(claims.map(row => [row.claimId, row]))
  for (const row of claims) {
    if (row.body.claimType !== 'RetractionClaim') continue
    for (const targetClaimId of row.body.payload.targetClaimIds) {
      const target = byId.get(targetClaimId)
      if (target?.issuer === row.issuer) target.revoked = true
    }
  }
  claims.sort((left, right) => left.claimId.localeCompare(right.claimId))
  return claims
}

function claimStore(claims) {
  return {
    getClaims() {
      return claims.slice()
    },
    getClaimsBySubject(entityId) {
      return claims.filter(row => row.subjects.includes(entityId))
    },
  }
}

function sourceRecordByReference(snapshot, publication) {
  return snapshot.sourceRecords.find(source =>
    source.publisherId === publication.publisherId &&
    source.recordId === publication.sourceRecordRef
  ) || null
}

function manifestFromSnapshot(snapshot, publication) {
  const source = sourceRecordByReference(snapshot, publication)
  if (!source || source.recordType !== PUBLISHER_RECORD_TYPES.PUBLICATION) return null
  const frame = decodePublisherCatalogFrame(source.canonicalEnvelope)
  const body = decodePublisherOperationBody(frame.recordType, frame.canonicalBody)
  const manifest = decodePublicationManifest(body.payload)
  if (manifest.publicationId !== publication.publicationId || manifest.body?.manifestId !== publication.manifestId) {
    fail('verified publication projection does not match its canonical manifest')
  }
  return manifest
}

export async function createVerifiedQueryView({
  store,
  catalogRegistry,
  moderationPolicy = null,
  onError = null,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  maxCursors = MAX_INDEX_QUERY_RESULTS,
  cursorLifetimeMs = MAX_INDEX_QUERY_DEADLINE_MS,
} = {}) {
  if (!store || typeof store.get !== 'function') throw new TypeError('verified query view requires Corestore')
  if (!catalogRegistry || typeof catalogRegistry.listBindings !== 'function') {
    throw new TypeError('verified query view requires catalogRegistry.listBindings')
  }
  if (moderationPolicy !== null && typeof moderationPolicy !== 'object' && typeof moderationPolicy !== 'function') {
    throw new TypeError('verified query view moderationPolicy must be an object or function')
  }
  if (onError !== null && typeof onError !== 'function') throw new TypeError('verified query view onError must be a function')
  if (typeof now !== 'function' || typeof randomBytes !== 'function') throw new TypeError('verified query view adapters are invalid')
  if (!Number.isSafeInteger(maxCursors) || maxCursors < 1 || maxCursors > MAX_INDEX_QUERY_RESULTS) {
    throw new TypeError('verified query cursor limit is invalid')
  }
  if (!Number.isSafeInteger(cursorLifetimeMs) || cursorLifetimeMs < 1 || cursorLifetimeMs > MAX_INDEX_QUERY_DEADLINE_MS) {
    throw new TypeError('verified query cursor lifetime is invalid')
  }

  const index = await createIndexerStore({
    store,
    limits: VERIFIED_QUERY_LIMITS,
    name: VERIFIED_QUERY_CORE_NAME,
  })
  const ingestor = createCatalogIngestor({ index, now })
  const cursors = new Map()
  let closed = false
  let refreshing = Promise.resolve({ indexed: 0, failed: 0 })

  function assertOpen() {
    if (closed) fail('verified query view is closed', 'VERIFIED_QUERY_CLOSED')
  }

  function currentTime() {
    const value = Number(now())
    if (!Number.isSafeInteger(value) || value < 0) fail('verified query clock is invalid')
    return value
  }

  function pruneCursors(time = currentTime()) {
    for (const [token, record] of cursors) if (record.expiresAt <= time) cursors.delete(token)
  }

  async function moderationRevision(moderation) {
    const source = moderationPolicy?.revision
    const value = typeof source === 'function'
      ? await source.call(moderationPolicy, { moderation })
      : source ?? '0'
    const revision = String(value)
    boundedText(revision, 'moderation revision')
    return revision
  }

  function visibilityEvaluator(moderation = 'effective') {
    boundedText(moderation, 'moderation mode', 64)
    const evaluation = typeof moderationPolicy?.beginEvaluation === 'function'
      ? moderationPolicy.beginEvaluation({ moderation })
      : moderationPolicy
    const hook = typeof evaluation === 'function'
      ? evaluation
      : evaluation?.isVisible || evaluation?.evaluate
    if (typeof hook !== 'function') return async () => true
    return async record => isVisibleDecision(await hook.call(evaluation, record, { moderation }))
  }

  async function visible(record, moderation = 'effective') {
    return visibilityEvaluator(moderation)(record)
  }

  async function catalogSnapshot() {
    return index.snapshotCatalogRows({
      maxSourceRecords: AGGREGATE_LIMIT.maxRows,
      maxPublicationRows: AGGREGATE_LIMIT.maxRows,
    })
  }

  async function visibleClaims(snapshot, evaluator) {
    const claims = decodeVerifiedClaims(snapshot.sourceRecords).filter(row => !row.revoked)
    const baseVisible = []
    for (const row of claims) {
      if (await evaluator(claimModerationEntity(row))) baseVisible.push(row)
    }
    const linkedPublications = publicationLinksByClaim(baseVisible, claims)
    const output = []
    for (const row of baseVisible) {
      if (row.body?.payload?.publicationId) {
        output.push(row)
        continue
      }
      let allowed = true
      for (const publicationId of linkedPublications(row)) {
        if (!await evaluator(claimModerationEntity(row, publicationId))) {
          allowed = false
          break
        }
      }
      if (allowed) output.push(row)
    }
    return output
  }

  async function visiblePublications(snapshot, evaluator) {
    const publications = []
    for (const row of snapshot.publicationRows) {
      const publication = mapIndexQueryResult(row)
      if (await evaluator(publicationModerationEntity(publication))) publications.push(publication)
    }
    return publications
  }

  function queryFingerprint(selectors, moderation) {
    return b4a.toString(crypto.hash(b4a.from(JSON.stringify({ selectors, moderation }))), 'hex')
  }

  function issueCursor(fingerprint, sourceRevision, moderationRevisionValue, continuation) {
    let serialized
    try { serialized = JSON.stringify(continuation) } catch { /* The bounded error below rejects it. */ }
    if (!serialized || b4a.byteLength(serialized) > MAX_INDEX_QUERY_CURSOR_BYTES) {
      fail('verified query continuation exceeds its bound', 'VERIFIED_QUERY_OVERLOADED')
    }
    pruneCursors()
    if (cursors.size >= maxCursors) fail('verified query cursor capacity is exhausted', 'VERIFIED_QUERY_OVERLOADED')
    for (let attempt = 0; attempt < 4; attempt++) {
      const bytes = b4a.from(randomBytes(CURSOR_BYTES))
      if (bytes.byteLength !== CURSOR_BYTES) fail('verified query cursor entropy is invalid')
      const token = cursorToken(bytes)
      if (cursors.has(token)) continue
      cursors.set(token, {
        fingerprint,
        sourceRevision,
        moderationRevision: moderationRevisionValue,
        continuation: JSON.parse(serialized),
        expiresAt: currentTime() + cursorLifetimeMs,
      })
      return token
    }
    fail('verified query cursor allocation failed', 'VERIFIED_QUERY_OVERLOADED')
  }

  function resolveCursor(token, fingerprint, moderationRevisionValue) {
    if (token === null) return null
    pruneCursors()
    if (typeof token !== 'string' || !CURSOR_PATTERN.test(token)) fail('verified query cursor is invalid', 'INVALID_CURSOR')
    const record = cursors.get(token)
    if (!record || record.fingerprint !== fingerprint) fail('verified query cursor is invalid', 'INVALID_CURSOR')
    if (record.moderationRevision !== moderationRevisionValue) fail('verified query cursor is stale', 'STALE_CURSOR')
    return record
  }

  async function bindingsByPublisher(requested = null) {
    const bindings = await catalogRegistry.listBindings()
    if (!Array.isArray(bindings)) throw new TypeError('catalogRegistry.listBindings() must return an array')
    if (bindings.length > MAX_VERIFIED_PUBLISHERS) fail('publisher binding list exceeds its bound')
    const normalized = []
    for (const binding of bindings) {
      let id
      try { id = publisherId(binding?.publisherId) } catch { continue }
      if (requested && !requested.has(id)) continue
      normalized.push({ binding, publisherId: id })
    }
    normalized.sort((left, right) => left.publisherId.localeCompare(right.publisherId))
    return normalized
  }

  async function ingestBinding(binding, id, signal, repairReason = null) {
    const descriptor = await binding?.catalog?.getNamespaceDescriptor?.() || binding?.namespaceDescriptor
    if (!descriptor || !binding?.catalog) throw new Error(`publisher ${id} has no verified catalog binding`)
    const input = { publisherId: id, descriptor, catalog: binding.catalog, ...(signal ? { signal } : {}) }
    return repairReason === null
      ? ingestor.ingest(input)
      : ingestor.repairPublisher({ ...input, reason: repairReason })
  }

  async function performRefresh({ publisherIds = undefined, signal = undefined } = {}) {
    if (signal?.aborted) throw signal.reason || new Error('verified query refresh aborted')
    let requested = null
    if (publisherIds !== undefined) {
      if (!Array.isArray(publisherIds) || publisherIds.length > PUBLISHER_LIMITS.maxJournalOperations) {
        throw new TypeError('publisherIds must be a bounded array')
      }
      requested = new Set(publisherIds.map(value => publisherId(value)))
    }
    const bindings = await bindingsByPublisher(requested)
    let indexed = 0
    let failed = 0
    for (const item of bindings) {
      if (signal?.aborted) throw signal.reason || new Error('verified query refresh aborted')
      try {
        await ingestBinding(item.binding, item.publisherId, signal)
        indexed++
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error
        failed++
        try { onError?.(error, { publisherId: item.publisherId }) } catch { /* Error reporting must not stop other publishers. */ }
      }
    }
    return Object.freeze({ indexed, failed })
  }

  async function publicationRow(publicationIdValue, moderation = 'effective', evaluator = visibilityEvaluator(moderation)) {
    const id = publisherId(publicationIdValue, 'publicationId')
    const rows = await index.findPublicationRows({ publicationId: id })
    for (const row of rows) {
      const result = mapIndexQueryResult(row)
      if (await evaluator(publicationModerationEntity(result))) return Object.freeze(result)
    }
    return null
  }

  async function manifestForPublication(publication, moderation = 'effective', evaluator = visibilityEvaluator(moderation)) {
    if (!publication || !await evaluator(publicationModerationEntity(publication))) return null
    const source = await index.getSourceRecord({
      publisherId: publication.publisherId,
      sourceRecordRef: publication.sourceRecordRef,
    })
    if (!source || source.recordType !== PUBLISHER_RECORD_TYPES.PUBLICATION) return null
    const frame = decodePublisherCatalogFrame(source.canonicalEnvelope)
    const body = decodePublisherOperationBody(frame.recordType, frame.canonicalBody)
    const manifest = decodePublicationManifest(body.payload)
    if (manifest.publicationId !== publication.publicationId || manifest.body?.manifestId !== publication.manifestId) {
      fail('verified publication projection does not match its canonical manifest')
    }
    return manifest
  }

  async function entityFromSnapshot(snapshot, claims, publications, entityId, entityKind = null) {
    const store = claimStore(claims)
    const directClaims = store.getClaimsBySubject(entityId)
    const entityPublications = publications
      .filter(publication => publication.workEntityId === entityId)
      .sort((left, right) => left.publicationId.localeCompare(right.publicationId))
    if (directClaims.length === 0 && entityPublications.length === 0) return null
    const resolved = directClaims.length > 0
      ? resolveMediaEntity(store, entityId)
      : {
          localClusterId: null,
          globalClusterId: null,
          members: [entityId],
          metadata: {},
          claims: [],
          conflicts: [],
        }
    const projectedPublications = entityPublications.map(publication => {
      const manifest = manifestFromSnapshot(snapshot, publication)
      if (!manifest) fail('verified publication source record is missing')
      const metadataClaim = directClaims.find(row => (
        row.issuer === publication.publisherId &&
        row.body?.claimType === 'EntityMetadataClaim' &&
        row.body?.payload?.publicationId === publication.publicationId &&
        typeof row.body.payload.sourceFileName === 'string'
      ))
      return Object.freeze({
        ...publication,
        manifest,
        sourceFileName: metadataClaim?.body?.payload?.sourceFileName || null
      })
    })
    const firstManifest = projectedPublications[0]?.manifest
    const metadata = {
      ...resolved.metadata,
      ...(resolved.metadata?.title ? {} : { title: firstManifest?.body?.title || null }),
      ...(resolved.metadata?.overview ? {} : { overview: firstManifest?.body?.description || null }),
    }
    const inferredKind = entityKind ||
      directClaims.flatMap(row => row.body?.subjectRefs || []).find(ref => ref.entityId === entityId)?.entityKind ||
      (entityPublications.length > 0 ? 'work' : 'unknown')
    return Object.freeze({
      entityKind: inferredKind,
      entityId,
      resolved: Object.freeze({ ...resolved, metadata: Object.freeze(metadata) }),
      publications: Object.freeze(projectedPublications),
    })
  }

  const resource = {
    refresh(input = {}) {
      assertOpen()
      const next = refreshing.then(() => performRefresh(input), () => performRefresh(input))
      refreshing = next.catch(() => ({ indexed: 0, failed: 1 }))
      return next
    },
    async repairPublisher({ publisherId: publisherIdValue, reason, signal = undefined } = {}) {
      assertOpen()
      const id = publisherId(publisherIdValue)
      const bindings = await bindingsByPublisher(new Set([id]))
      if (bindings.length !== 1) fail(`publisher ${id} has no unique verified catalog binding`)
      return ingestBinding(bindings[0].binding, id, signal, reason)
    },
    async query({ selectors, limit = 20, cursor = null, sourceRevision: requestedSourceRevision = null, moderation = 'effective', signal = undefined } = {}) {
      assertOpen()
      const normalizedSelectors = normalizeIndexQuerySelectors(selectors)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INDEX_QUERY_RESULTS) {
        throw new TypeError('verified query limit is outside its bound')
      }
      boundedText(moderation, 'moderation mode', 64)
      const revision = await moderationRevision(moderation)
      const fingerprint = queryFingerprint(normalizedSelectors, moderation)
      const stored = resolveCursor(cursor, fingerprint, revision)
      if (stored && requestedSourceRevision !== null && requestedSourceRevision !== stored.sourceRevision) {
        fail('verified query cursor is stale', 'STALE_CURSOR')
      }
      let continuation = stored?.continuation
      let sourceRevision = stored?.sourceRevision ?? requestedSourceRevision ?? undefined
      const evaluator = visibilityEvaluator(moderation)
      const results = []
      while (results.length < limit) {
        let page
        try {
          page = await index.queryIndexPage({
            selectors: normalizedSelectors,
            limit: 1,
            continuation,
            sourceRevision,
            signal,
          })
        } catch (error) {
          if (error?.code === 'INDEX_QUERY_STALE_REVISION') fail('verified query cursor is stale', 'STALE_CURSOR')
          throw error
        }
        sourceRevision = page.sourceRevision
        continuation = page.continuation
        if (page.results.length === 1) {
          const result = mapIndexQueryResult(page.results[0])
          if (await evaluator(queryModerationEntity(result))) results.push(Object.freeze(result))
        }
        if (continuation === null) break
      }
      return Object.freeze({
        results: Object.freeze(results),
        nextCursor: continuation === null ? null : issueCursor(fingerprint, sourceRevision, revision, continuation),
        sourceRevision,
      })
    },
    async getEntity({ entityKind = null, entityId, moderation = 'effective' } = {}) {
      assertOpen()
      boundedText(entityId, 'entityId', 512)
      if (entityKind !== null) boundedText(entityKind, 'entityKind', 64)
      const evaluator = visibilityEvaluator(moderation)
      const snapshot = await catalogSnapshot()
      const claims = await visibleClaims(snapshot, evaluator)
      const publications = await visiblePublications(snapshot, evaluator)
      const entity = await entityFromSnapshot(snapshot, claims, publications, entityId, entityKind)
      if (!entity) return null
      const sources = []
      if (entityKind !== null) {
        for (const row of await index.findEntityRows({ entityKind, entityId })) {
          const result = mapIndexQueryResult(row)
          if (await evaluator(queryModerationEntity(result))) sources.push(Object.freeze(result))
        }
      }
      return Object.freeze({ ...entity, sources: Object.freeze(sources) })
    },
    async listEntities({ moderation = 'effective' } = {}) {
      assertOpen()
      const evaluator = visibilityEvaluator(moderation)
      const snapshot = await catalogSnapshot()
      const claims = await visibleClaims(snapshot, evaluator)
      const publications = await visiblePublications(snapshot, evaluator)
      const entityIds = [...new Set(publications.map(publication => publication.workEntityId))].sort()
      const entities = []
      for (const entityId of entityIds) {
        const entity = await entityFromSnapshot(snapshot, claims, publications, entityId, 'work')
        if (!entity) continue
        // The signed external references a work carries. They are what names an
        // episode - `tmdb` plus `show:<id>:s<season>:e<episode>` - so a catalog
        // reader can say which episode a release is without guessing from a
        // title. Read here rather than left to the caller: the index is the only
        // place that holds them, and a consumer of `listEntities` has no way to
        // reach it.
        const externalRefs = []
        for (const row of await index.findEntityRows({ entityKind: 'work', entityId })) {
          const result = mapIndexQueryResult(row)
          if (result?.type !== 'external-ref') continue
          if (!(await evaluator(queryModerationEntity(result)))) continue
          externalRefs.push(Object.freeze({ namespace: result.namespace, identifier: result.identifier }))
        }
        entities.push(Object.freeze({ ...entity, externalRefs: Object.freeze(externalRefs) }))
      }
      return Object.freeze(entities)
    },
    async getClaims({ moderation = 'effective' } = {}) {
      assertOpen()
      const snapshot = await catalogSnapshot()
      return Object.freeze(await visibleClaims(snapshot, visibilityEvaluator(moderation)))
    },
    async getRendition({ publicationId, renditionId = null, moderation = 'effective' } = {}) {
      assertOpen()
      const evaluator = visibilityEvaluator(moderation)
      const publication = await publicationRow(publicationId, moderation, evaluator)
      const manifest = await manifestForPublication(publication, moderation, evaluator)
      if (!manifest) return null
      const rendition = findManifestRendition(manifest, renditionId)
      const requirement = renditionRequirement(manifest, renditionId)
      return rendition && requirement
        ? Object.freeze({ publication, manifest, rendition, requirement })
        : null
    },
    async getPublication({ publicationId, moderation = 'effective' } = {}) {
      assertOpen()
      return publicationRow(publicationId, moderation)
    },
    async getManifest({ publicationId, moderation = 'effective' } = {}) {
      assertOpen()
      const evaluator = visibilityEvaluator(moderation)
      const publication = await publicationRow(publicationId, moderation, evaluator)
      return manifestForPublication(publication, moderation, evaluator)
    },
    async authorizeRendition({
      publicationId: publicationIdValue = null,
      manifest: suppliedManifest = null,
      renditionId,
      start = 0,
      end = null,
      operation = 'read',
    } = {}) {
      assertOpen()
      let publication
      try {
        publication = await publicationRow(publicationIdValue || suppliedManifest?.publicationId)
      } catch {
        return false
      }
      const manifest = await manifestForPublication(publication)
      if (!manifest) return false
      if (suppliedManifest) {
        let supplied
        let canonical
        try {
          supplied = encodePublicationManifest(suppliedManifest)
          canonical = encodePublicationManifest(manifest)
        } catch {
          return false
        }
        if (!b4a.equals(supplied, canonical)) return false
      }
      const rendition = findManifestRendition(manifest, renditionId)
      if (!rendition) return false
      const length = Number(rendition.core?.length)
      if (!Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(start) || start < 0 || start >= length) return false
      if (end !== null && (!Number.isSafeInteger(end) || end <= start || end > length)) return false
      boundedText(operation, 'rendition operation', 64)
      const indexed = await index.findRenditionRows({ renditionId })
      if (!indexed.some(row =>
        row.publisherId === publication.publisherId &&
        row.sourceRecordRef === publication.sourceRecordRef &&
        row.assetId === rendition.core?.assetId
      )) return false
      const authorizedRanges = (manifest.body?.provenance || []).filter(candidate =>
        (candidate?.type === 'upload' || candidate?.type === 'artwork') &&
        candidate.renditionId === renditionId &&
        candidate.coreKey === rendition.core?.key &&
        Number.isSafeInteger(candidate.start) &&
        Number.isSafeInteger(candidate.end) &&
        candidate.start >= 0 &&
        candidate.end > candidate.start
      )
      if (authorizedRanges.length > 0 && !authorizedRanges.some(candidate =>
        start >= candidate.start && end !== null && end <= candidate.end
      )) return false
      const record = {
        ...publicationModerationEntity(publication),
        renditionId,
        assetId: rendition.core?.assetId,
        operation,
        start,
        end,
      }
      if (!await visible(record)) return false
      const authorize = moderationPolicy?.authorizeRendition
      return typeof authorize !== 'function' || isVisibleDecision(await authorize.call(moderationPolicy, record))
    },
    async isVisible(input = {}) {
      assertOpen()
      return visible(input)
    },
    sourceState({ publisherId: publisherIdValue } = {}) {
      assertOpen()
      return index.getPublisherSourceCursor({ publisherId: publisherId(publisherIdValue) })
    },
    evictPublisher({ publisherId: publisherIdValue, reason } = {}) {
      assertOpen()
      return index.evictPublisherSlice({ publisherId: publisherId(publisherIdValue), reason })
    },
    async close() {
      if (closed) return false
      closed = true
      await refreshing.catch(() => {})
      cursors.clear()
      await index.close()
      return true
    },
  }
  return Object.freeze(resource)
}
