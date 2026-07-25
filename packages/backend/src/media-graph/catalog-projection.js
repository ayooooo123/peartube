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
