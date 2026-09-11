import b4a from 'b4a'

import {
  createPublicationManifest,
  createRenditionDescriptor,
  encodePublicationManifest,
} from '../assets/index.js'
import { classifyLegacyAssetReference } from './asset-core-v2.js'
import { parseBlobRef } from '../blob-ref.js'
import {
  createEntityReference,
  createMediaClaim,
  encodeMediaClaimEnvelope,
} from '../media-graph/index.js'
import {
  PUBLISHER_RECORD_TYPES,
  hashCanonical,
} from '../publisher/canonical.js'

const CHECKPOINT_KEY = 'migration:publication-v1:checkpoint'
const CHECKPOINT_VERSION = 1

function hexDigest(domain, body) {
  return b4a.toString(hashCanonical(domain, body), 'hex')
}

function normalizePublisherId(value) {
  const text = String(value || '')
  return /^[0-9a-f]{64}$/i.test(text) ? text.toLowerCase() : hexDigest('peartube.legacy.publisher.v1', { value: text || 'unknown' })
}

function normalizeVideo(video = {}, index = 0) {
  const legacySourceId = String(video.id || video.videoId || `legacy-${index}`)
  return {
    legacySourceId,
    title: video.title || null,
    deleted: video.deleted === true,
    contentHash: video.contentHash || video.hash || null,
    blobRef: video.blobRef || null,
    thumbnail: video.thumbnail || null,
    source: video.source || 'legacy-channel',
  }
}

export function migratePublicationV1(legacy = {}, options = {}) {
  const publisherId = normalizePublisherId(legacy.ownerPublisherId || legacy.publisherId || legacy.channelKey)
  const videos = (legacy.videos || []).map(normalizeVideo)
  const completed = new Set(options.checkpoint?.completedLegacySourceIds || [])
  const publications = []
  const claims = []
  let processed = 0

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i]
    if (completed.has(video.legacySourceId)) continue
    const basis = { publisherId, legacySourceId: video.legacySourceId, contentHash: video.contentHash, tombstone: video.deleted === true }
    const publicationId = hexDigest('peartube.publication-v1.import.publication-id.v1', basis)
    const publication = {
      publicationId,
      publisherId,
      legacySourceId: video.legacySourceId,
      title: video.title,
      tombstone: video.deleted === true,
      contentHash: video.contentHash,
      blobRef: video.blobRef,
      thumbnail: video.thumbnail,
      entityRef: null,
      agentRef: null,
      provenance: { source: video.source, legacySourceId: video.legacySourceId },
    }
    publications.push(publication)
    claims.push({
      claimId: hexDigest('peartube.publication-v1.import.claim-id.v1', { publicationId, kind: publication.tombstone ? 'legacy-tombstone' : 'legacy-publication' }),
      publicationId,
      kind: publication.tombstone ? 'legacy-tombstone' : 'legacy-publication',
      provenance: publication.provenance,
    })
    completed.add(video.legacySourceId)
    processed++
    if (options.stopAfter && processed >= options.stopAfter) break
  }

  if (options.checkpoint) {
    for (const video of videos) {
      if (!completed.has(video.legacySourceId)) continue
      const basis = { publisherId, legacySourceId: video.legacySourceId, contentHash: video.contentHash, tombstone: video.deleted === true }
      const publicationId = hexDigest('peartube.publication-v1.import.publication-id.v1', basis)
      if (!publications.some(p => p.publicationId === publicationId)) {
        publications.push({ publicationId, publisherId, legacySourceId: video.legacySourceId, title: video.title, tombstone: video.deleted === true, contentHash: video.contentHash, blobRef: video.blobRef, thumbnail: video.thumbnail, entityRef: null, agentRef: null, provenance: { source: video.source, legacySourceId: video.legacySourceId } })
        claims.push({ claimId: hexDigest('peartube.publication-v1.import.claim-id.v1', { publicationId, kind: video.deleted === true ? 'legacy-tombstone' : 'legacy-publication' }), publicationId, kind: video.deleted === true ? 'legacy-tombstone' : 'legacy-publication', provenance: { source: video.source, legacySourceId: video.legacySourceId } })
      }
    }
  }

  return { publisherId, publications, claims, checkpoint: { completedLegacySourceIds: Array.from(completed).sort() } }
}

export class PublicationV1MigrationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PublicationV1MigrationError'
    this.code = code
  }
}

function initialCheckpoint() {
  return {
    version: CHECKPOINT_VERSION,
    status: 'pending',
    pending: null,
    completed: [],
    quarantined: [],
  }
}

function validateCheckpoint(value) {
  if (value == null) return initialCheckpoint()
  if (!value || value.version !== CHECKPOINT_VERSION ||
      !['pending', 'running', 'complete', 'failed'].includes(value.status) ||
      !Array.isArray(value.completed) || !Array.isArray(value.quarantined)) {
    throw new PublicationV1MigrationError('PUBLICATION_V1_CHECKPOINT_INVALID', 'publication v1 migration checkpoint is invalid')
  }
  return {
    version: CHECKPOINT_VERSION,
    status: value.status,
    pending: value.pending || null,
    completed: value.completed.map(entry => ({ ...entry })),
    quarantined: value.quarantined.map(entry => ({ ...entry })),
  }
}

export function createPublicationV1CheckpointRepository(metaDb, options = {}) {
  if (!metaDb || typeof metaDb.get !== 'function' || typeof metaDb.put !== 'function') {
    throw new TypeError('publication v1 checkpoint repository requires metaDb get/put')
  }
  const key = options.key || CHECKPOINT_KEY
  return Object.freeze({
    async load() {
      return validateCheckpoint((await metaDb.get(key))?.value)
    },
    async save(checkpoint) {
      const normalized = validateCheckpoint(checkpoint)
      await metaDb.put(key, normalized)
      return normalized
    },
  })
}

export function createPublicationV1LegacyRepository({ identityManager, loadChannel } = {}) {
  if (!identityManager || typeof identityManager.getIdentities !== 'function') {
    throw new TypeError('publication v1 legacy repository requires identityManager.getIdentities')
  }
  if (typeof loadChannel !== 'function') {
    throw new TypeError('publication v1 legacy repository requires loadChannel')
  }
  return Object.freeze({
    async list() {
      const sources = []
      const identities = [...identityManager.getIdentities()]
        .sort((left, right) => String(left.driveKey).localeCompare(String(right.driveKey)))
      for (const identity of identities) {
        const sourceKey = String(identity.driveKey || '').toLowerCase()
        if (!/^[0-9a-f]{64}$/.test(sourceKey)) {
          sources.push({
            source: 'legacy-owner-channel',
            sourceKey,
            ownerPublisherId: String(identity.publicKey || ''),
            video: null,
          })
          continue
        }
        const channel = await loadChannel(sourceKey, identity)
        if (!channel || typeof channel.listVideos !== 'function') {
          throw new PublicationV1MigrationError('PUBLICATION_V1_SOURCE_UNAVAILABLE', `legacy channel ${sourceKey} is unavailable`)
        }
        const videos = await channel.listVideos()
        if (!Array.isArray(videos)) {
          throw new PublicationV1MigrationError('PUBLICATION_V1_SOURCE_MALFORMED', `legacy channel ${sourceKey} returned an invalid video list`)
        }
        for (const video of videos) {
          sources.push({
            source: 'legacy-owner-channel',
            sourceKey,
            ownerPublisherId: String(identity.publicKey || ''),
            video: { ...video },
          })
        }
      }
      return sources.sort((left, right) => {
        const sourceOrder = left.sourceKey.localeCompare(right.sourceKey)
        return sourceOrder || String(left.video?.id || '').localeCompare(String(right.video?.id || ''))
      })
    },
  })
}

function sourceIdentity(source) {
  return `${String(source?.sourceKey || '').toLowerCase()}:${String(source?.video?.id || '')}`
}

function malformed(message) {
  throw new PublicationV1MigrationError('PUBLICATION_V1_SOURCE_MALFORMED', message)
}

function sourceProvenance(source, parsedBlob) {
  const video = source.video
  const provenance = {
    source: 'legacy-owner-channel',
    sourceKey: source.sourceKey.toLowerCase(),
    ownerPublisherId: source.ownerPublisherId.toLowerCase(),
    legacySourceId: video.id,
    blobsCoreKey: parsedBlob.blobsCoreKey,
    blobId: parsedBlob.blobId,
  }
  if (typeof video.contentFingerprint === 'string') provenance.contentFingerprint = video.contentFingerprint
  if (typeof video.mimeType === 'string') provenance.mimeType = video.mimeType
  if (Number.isSafeInteger(video.uploadedAt) && video.uploadedAt >= 0) provenance.uploadedAt = video.uploadedAt
  if (typeof video.sourceProvider === 'string') provenance.sourceProvider = video.sourceProvider
  if (typeof video.sourceVideoId === 'string') provenance.sourceVideoId = video.sourceVideoId
  return provenance
}

function validateLegacySource(source) {
  if (!source || source.source !== 'legacy-owner-channel' ||
      typeof source.sourceKey !== 'string' || !/^[0-9a-f]{64}$/i.test(source.sourceKey) ||
      typeof source.ownerPublisherId !== 'string' || !/^[0-9a-f]{64}$/i.test(source.ownerPublisherId) ||
      !source.video || typeof source.video !== 'object') {
    malformed('legacy publication source descriptor is malformed')
  }
  const video = source.video
  if (typeof video.id !== 'string' || video.id.length < 1 || video.id.length > 256) malformed('legacy publication id is malformed')
  if (typeof video.title !== 'string' || video.title.length < 1 || video.title.length > 512) malformed('legacy publication title is malformed')
  if (video.description != null && (typeof video.description !== 'string' || video.description.length > 4096)) {
    malformed('legacy publication description is malformed')
  }
  return video
}

function resolveLegacyFingerprint(video, source, parsedBlob) {
  return typeof video.contentFingerprint === 'string' && /^sha256:[0-9a-f]{64}$/.test(video.contentFingerprint)
    ? video.contentFingerprint.slice(7)
    : hexDigest('peartube.publication-v1.legacy-rendition.v1', {
        sourceKey: source.sourceKey.toLowerCase(),
        legacySourceId: video.id,
        blobsCoreKey: parsedBlob.blobsCoreKey,
        blobId: parsedBlob.blobId,
        byteLength: parsedBlob.blob.byteLength,
      })
}

function normalizeSource(source) {
  const video = validateLegacySource(source)
  const parsedBlob = parseBlobRef(video)
  if (!parsedBlob) malformed('legacy publication blob reference is malformed')
  const fingerprint = resolveLegacyFingerprint(video, source, parsedBlob)
  return {
    source: {
      source: 'legacy-owner-channel',
      sourceKey: source.sourceKey.toLowerCase(),
      ownerPublisherId: String(source.ownerPublisherId || ''),
      video: { ...video },
    },
    parsedBlob,
    fingerprint,
    provenance: sourceProvenance(source, parsedBlob),
    disposition: classifyLegacyAssetReference({
      key: parsedBlob.blobsCoreKey,
      start: parsedBlob.blob.blockOffset,
      end: parsedBlob.blob.blockOffset + parsedBlob.blob.blockLength,
      sourcePath: video.sourcePath,
      localFilePath: video.localFilePath,
    }),
  }
}

function writerFor(authorization, deviceKeyPair, now) {
  const signerKey = b4a.toString(deviceKeyPair.publicKey, 'hex')
  return authorization?.writers?.find(candidate =>
    candidate.signerKey === signerKey &&
    candidate.revocation == null &&
    candidate.expiresAt >= now &&
    candidate.capabilities?.includes('publish') &&
    candidate.capabilities?.includes('claim')
  ) || null
}

function createMigrationPlan({ normalized, binding, writer, sequence, signedAt, deviceKeyPair }) {
  const publisherId = b4a.from(binding.publisherId)
  const { video } = normalized.source
  const { blob } = normalized.parsedBlob
  const rendition = createRenditionDescriptor({
    purpose: 'original',
    format: typeof video.mimeType === 'string' && video.mimeType ? video.mimeType : 'application/octet-stream',
    core: {
      key: normalized.parsedBlob.blobsCoreKey,
      length: blob.blockOffset + blob.blockLength,
      treeHash: normalized.fingerprint,
      byteLength: blob.byteLength,
    },
  })
  const manifest = createPublicationManifest({
    publisherId,
    sequence,
    title: video.title,
    description: video.description || null,
    renditions: [rendition],
    provenance: [{
      type: 'legacy-publication-v1',
      ...normalized.provenance,
      renditionId: rendition.renditionId,
      start: blob.blockOffset,
      end: blob.blockOffset + blob.blockLength,
    }],
    keyPair: deviceKeyPair,
    signedAt,
  })
  const subject = createEntityReference({
    entityKind: 'publication',
    namespace: 'issuer-native',
    issuerRootKey: publisherId,
    issuerLocalId: sourceIdentity(normalized.source),
  })
  const claim = createMediaClaim({
    claimType: 'EntityMetadataClaim',
    subjectRefs: [subject],
    payload: {
      title: video.title,
      description: video.description || null,
      publicationId: manifest.publicationId,
      provenance: normalized.provenance,
    },
    confidence: 1000,
    issuerSequence: sequence + 1,
    policyEpoch: writer.admissionPolicyEpoch,
    keyPair: deviceKeyPair,
    signedAt,
  })
  return {
    publicationId: manifest.publicationId,
    claimIds: [claim.claimId],
    candidates: [{
      recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
      sequence,
      body: {
        publicationId: b4a.from(manifest.publicationId, 'hex'),
        manifestId: b4a.from(manifest.body.manifestId, 'hex'),
        payload: encodePublicationManifest(manifest),
      },
    }, {
      recordType: PUBLISHER_RECORD_TYPES.CLAIM,
      sequence: sequence + 1,
      body: {
        claimId: b4a.from(claim.claimId, 'hex'),
        claimType: claim.body.claimType,
        payload: encodeMediaClaimEnvelope(claim.envelope),
      },
    }],
  }
}

async function projectionsExist(catalog, plan) {
  if (typeof catalog.getProjection !== 'function') return false
  if (!await catalog.getProjection('publication', b4a.from(plan.publicationId, 'hex'))) return false
  for (const claimId of plan.claimIds) {
    if (!await catalog.getProjection('claim', b4a.from(claimId, 'hex'))) return false
  }
  return true
}

function summary(checkpoint) {
  return {
    status: checkpoint.status,
    importedPublications: checkpoint.completed.length,
    importedClaims: checkpoint.completed.reduce((count, entry) => count + entry.claimIds.length, 0),
    quarantined: checkpoint.quarantined.length,
  }
}

function catalogUnavailable(error) {
  return error?.code === 'PUBLISHER_CATALOG_UNAVAILABLE' ||
    /PUBLISHER_CATALOG_UNAVAILABLE/.test(error?.message || '')
}

function publisherIdHex(value) {
  if (!value) return null
  if (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
  if (b4a.isBuffer(value) || value instanceof Uint8Array) {
    if (value.byteLength !== 32) return null
    return b4a.toString(value, 'hex')
  }
  return null
}
function processBindingPage(page, selectedId) {
  const pageErrors = page?.errors || []
  if (Array.isArray(pageErrors) && pageErrors.length > 0) {
    const first = pageErrors[0]
    const err = new Error(first?.error || 'PUBLISHER_WRITABLE_DISCOVERY_INCOMPLETE')
    err.code = first?.error || 'PUBLISHER_WRITABLE_DISCOVERY_INCOMPLETE'
    err.errors = pageErrors
    throw err
  }
  let currentId = selectedId
  for (const item of page?.items || []) {
    const idHex = publisherIdHex(item?.publisherId)
    if (!idHex) {
      throw new PublicationV1MigrationError('PUBLISHER_WRITABLE_DISCOVERY_INCOMPLETE', 'writable mapping has an invalid publisher id')
    }
    if (currentId !== null && currentId !== idHex) return { ambiguous: true, selectedId: null }
    currentId = idHex
  }
  return { ambiguous: false, selectedId: currentId }
}


/**
 * Resolve a legacy source onto a local writable catalog as a canonical lease.
 *
 * Returns `{ binding, release }` or `null`. Callers must release on every path.
 * Known owner keys use acquireWritableBinding. Sole-writer fallback pages every
 * persisted writable mapping (not the warm getWritableBindings snapshot) and
 * acquires at most one ID; page errors fail closed; >1 ID is ambiguous null.
 *
 * derivePublisherId is injected: importing it here would run back through the
 * publisher barrel, which re-exports this module.
 */
export function createLegacyCatalogResolver({ catalogRegistry, derivePublisherId } = {}) {
  if (!catalogRegistry) throw new TypeError('legacy catalog resolver requires catalogRegistry')
  if (typeof derivePublisherId !== 'function') {
    throw new TypeError('legacy catalog resolver requires derivePublisherId')
  }
  if (typeof catalogRegistry.acquireWritableBinding !== 'function') {
    throw new TypeError('legacy catalog resolver requires catalogRegistry.acquireWritableBinding')
  }

  async function findSoleWritablePublisherId() {
    if (typeof catalogRegistry.listBindingPage !== 'function') {
      throw new TypeError('legacy catalog resolver requires catalogRegistry.listBindingPage')
    }
    let selectedId = null
    let cursor = null
    do {
      const page = await catalogRegistry.listBindingPage({
        cursor,
        limit: 16,
        writableOnly: true,
      })
      try {
        const result = processBindingPage(page, selectedId)
        if (result.ambiguous) return null
        selectedId = result.selectedId
      } finally {
        await page?.release?.()
      }
      cursor = page?.nextCursor || null
    } while (cursor)
    return selectedId === null ? null : b4a.from(selectedId, 'hex')
  }

  return async function resolveCatalog(source) {
    const ownerPublisherId = String(source?.ownerPublisherId || '')
    if (/^[0-9a-f]{64}$/i.test(ownerPublisherId)) {
      try {
        const publisherId = derivePublisherId(b4a.from(ownerPublisherId.toLowerCase(), 'hex'))
        return await catalogRegistry.acquireWritableBinding(publisherId)
      } catch (error) {
        if (error?.code === 'PUBLISHER_CATALOG_NOT_WRITABLE') return null
        if (!catalogUnavailable(error)) throw error
      }
    }

    try {
      const soleId = await findSoleWritablePublisherId()
      if (!soleId) return null
      return await catalogRegistry.acquireWritableBinding(soleId)
    } catch (error) {
      if (catalogUnavailable(error) || error?.code === 'PUBLISHER_CATALOG_NOT_WRITABLE') return null
      throw error
    }
  }
}

export function createPublicationV1StartupLifecycle({ migrate, startDiscovery } = {}) {
  if (typeof migrate !== 'function') throw new TypeError('publication v1 startup lifecycle requires migrate')
  if (typeof startDiscovery !== 'function') throw new TypeError('publication v1 startup lifecycle requires startDiscovery')
  let inFlight = null
  let completed = null
  let discoveryStarted = false

  const complete = () => {
    if (completed) return Promise.resolve(completed)
    if (inFlight) return inFlight
    inFlight = (async () => {
      const result = await migrate()
      if (result?.status !== 'complete') return result
      if (!discoveryStarted) {
        await startDiscovery()
        discoveryStarted = true
      }
      completed = result
      return result
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  return Object.freeze({
    initialize: complete,
    complete,
    get ready() { return completed !== null },
  })
}

function validateStartupMigrationOptions(options) {
  const {
    sourceRepository,
    checkpointRepository,
    resolveCatalog,
    deviceKeyPair,
  } = options
  if (!sourceRepository || typeof sourceRepository.list !== 'function') throw new TypeError('publication v1 migration requires sourceRepository.list')
  if (!checkpointRepository || typeof checkpointRepository.load !== 'function' || typeof checkpointRepository.save !== 'function') {
    throw new TypeError('publication v1 migration requires checkpointRepository load/save')
  }
  if (typeof resolveCatalog !== 'function') throw new TypeError('publication v1 migration requires resolveCatalog')
  if (!deviceKeyPair?.publicKey || !deviceKeyPair?.secretKey) throw new TypeError('publication v1 migration requires deviceKeyPair')
}

async function prepareMigrationSource(source, checkpoint, checkpointRepository) {
  const sourceKey = sourceIdentity(source)
  let normalized
  try {
    normalized = normalizeSource(source)
  } catch (error) {
    const quarantine = {
      sourceKey,
      code: error?.code || 'PUBLICATION_V1_SOURCE_MALFORMED',
      message: error?.message || 'legacy publication is malformed',
    }
    const quarantined = checkpoint.quarantined.filter(entry => entry.sourceKey !== sourceKey)
    quarantined.push(quarantine)
    await checkpointRepository.save({ ...checkpoint, status: 'failed', quarantined })
    throw error
  }
  if (normalized.disposition) {
    const quarantine = {
      sourceKey,
      code: normalized.disposition === 'reingest-required'
        ? 'PUBLICATION_V1_REINGEST_REQUIRED'
        : 'PUBLICATION_V1_QUARANTINED',
      disposition: normalized.disposition,
      message: normalized.disposition === 'reingest-required'
        ? 'legacy publication source bytes must be re-ingested'
        : 'legacy publication cannot be verified as a static asset',
    }
    const quarantined = checkpoint.quarantined.filter(entry => entry.sourceKey !== sourceKey)
    quarantined.push(quarantine)
    const updated = await checkpointRepository.save({
      ...checkpoint,
      status: 'running',
      pending: null,
      quarantined,
    })
    return { quarantined: true, checkpoint: updated }
  }
  return { quarantined: false, normalized, sourceKey }
}

function validateCatalogWriter(catalog, writer, deviceKeyPair) {
  if (!catalog?.writable || typeof catalog.getAuthorizationState !== 'function' ||
      typeof catalog.createLocalOperation !== 'function' ||
      typeof catalog.appendBatchAndConfirm !== 'function') {
    return false
  }
  if (!writer || !catalog.localSignerKey || !b4a.equals(catalog.localSignerKey, deviceKeyPair.publicKey)) {
    return false
  }
  return true
}

function resolveWriterSequence(checkpoint, sourceKey, writer, currentTime) {
  const pending = checkpoint.pending?.sourceKey === sourceKey ? checkpoint.pending : null
  const sequence = pending?.sequence ?? writer.lastAcceptedSequence + 1
  const signedAt = pending?.signedAt ?? currentTime
  if (!Number.isSafeInteger(sequence) || sequence < writer.firstAcceptedSequence ||
      !Number.isSafeInteger(signedAt) || signedAt < 0) {
    throw new PublicationV1MigrationError('PUBLICATION_V1_WRITER_UNAVAILABLE', 'publisher writer sequence is unavailable')
  }
  return { pending, sequence, signedAt }
}

async function commitMigrationPlan(catalog, plan, writer, signedAt, afterCatalogCommit, sourceKey, verifiedQueryView, binding) {
  let committed = await projectionsExist(catalog, plan)
  if (!committed) {
    const operations = []
    for (const candidate of plan.candidates) {
      operations.push(await catalog.createLocalOperation({
        ...candidate,
        policyEpoch: writer.admissionPolicyEpoch,
        signedAt,
      }))
    }
    const receipts = await catalog.appendBatchAndConfirm(operations)
    committed = Array.isArray(receipts) && receipts.length === operations.length &&
      receipts.every(receipt => receipt?.accepted === true)
    if (!committed) {
      await catalog.update?.()
      committed = await projectionsExist(catalog, plan)
    }
    if (!committed) {
      throw new PublicationV1MigrationError('PUBLICATION_V1_CATALOG_REJECTED', 'publisher catalog rejected legacy publication migration')
    }
    await afterCatalogCommit?.({ sourceKey, publicationId: plan.publicationId, claimIds: plan.claimIds.slice() })
  }
  if (verifiedQueryView?.refresh) {
    const refreshed = await verifiedQueryView.refresh({
      publisherIds: [b4a.toString(binding.publisherId, 'hex')],
    })
    if (refreshed?.failed !== 0 || refreshed?.indexed !== 1) {
      throw new PublicationV1MigrationError(
        'PUBLICATION_V1_QUERY_REFRESH_FAILED',
        'verified query view rejected the migrated publication'
      )
    }
  }
}

export async function runPublicationV1StartupMigration(options = {}) {
  validateStartupMigrationOptions(options)
  const {
    sourceRepository,
    checkpointRepository,
    resolveCatalog,
    deviceKeyPair,
    verifiedQueryView,
    afterCatalogCommit,
  } = options
  const now = typeof options.now === 'function' ? options.now : () => Date.now()

  let checkpoint = await checkpointRepository.load()
  const sources = await sourceRepository.list()
  const completed = new Map(checkpoint.completed.map(entry => [entry.sourceKey, entry]))
  if (sources.length === 0) {
    checkpoint = await checkpointRepository.save({ ...checkpoint, status: 'complete', pending: null })
    return summary(checkpoint)
  }

  checkpoint = await checkpointRepository.save({ ...checkpoint, status: 'running' })
  for (const source of sources) {
    const sourceKey = sourceIdentity(source)
    if (completed.has(sourceKey)) continue

    const prep = await prepareMigrationSource(source, checkpoint, checkpointRepository)
    if (prep.quarantined) {
      checkpoint = prep.checkpoint
      continue
    }
    const { normalized } = prep

    const lease = await resolveCatalog(normalized.source)
    if (!lease?.binding) {
      await lease?.release?.()
      checkpoint = await checkpointRepository.save({ ...checkpoint, status: 'pending' })
      return summary(checkpoint)
    }
    try {
      const binding = lease.binding
      const catalog = binding.catalog
      const currentTime = now()
      const authorization = await catalog.getAuthorizationState()
      const writer = writerFor(authorization, deviceKeyPair, currentTime)
      if (!validateCatalogWriter(catalog, writer, deviceKeyPair)) {
        checkpoint = await checkpointRepository.save({ ...checkpoint, status: 'pending' })
        return summary(checkpoint)
      }

      const { pending, sequence, signedAt } = resolveWriterSequence(checkpoint, sourceKey, writer, currentTime)
      if (!pending) {
        checkpoint = await checkpointRepository.save({
          ...checkpoint,
          pending: {
            sourceKey,
            publisherId: b4a.toString(binding.publisherId, 'hex'),
            sequence,
            signedAt,
          },
        })
      }
      const plan = createMigrationPlan({ normalized, binding, writer, sequence, signedAt, deviceKeyPair })
      try {
        await commitMigrationPlan(catalog, plan, writer, signedAt, afterCatalogCommit, sourceKey, verifiedQueryView, binding)
      } catch (err) {
        if (err?.code === 'PUBLICATION_V1_CATALOG_REJECTED') {
          checkpoint = await checkpointRepository.save({ ...checkpoint, status: 'failed' })
        }
        throw err
      }
      const entry = { sourceKey, publicationId: plan.publicationId, claimIds: plan.claimIds.slice() }
      checkpoint = await checkpointRepository.save({
        ...checkpoint,
        status: 'running',
        pending: null,
        completed: [...checkpoint.completed.filter(value => value.sourceKey !== sourceKey), entry]
          .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey)),
      })
      completed.set(sourceKey, entry)
    } finally {
      await lease.release?.()
    }
  }

  checkpoint = await checkpointRepository.save({ ...checkpoint, status: 'complete', pending: null })
  return summary(checkpoint)
}
