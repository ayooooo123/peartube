import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  decodePublicationManifest,
  verifyCatalogPublicationManifest,
} from '../assets/index.js'
import {
  createEntityReference,
  decodeClaimBody,
  normalizeExternalIdentifier,
  verifyMediaClaim,
} from '../media-graph/index.js'
import {
  PUBLISHER_CATALOG_LEGACY_COMPATIBILITY,
  PUBLISHER_LIMITS,
  PUBLISHER_RECORD_TYPES,
  decodePublisherCatalogFrame,
  decodePublisherNamespaceDescriptor,
  decodePublisherOperationBody,
  getPublisherAuthorizationState,
  encodePublisherCatalogFrame,
  encodePublisherNamespaceDescriptor,
  verifyPublisherNamespaceDescriptor,
} from '../publisher/index.js'
import {
  decodeApplicationEnvelope,
  encodeApplicationEnvelope,
} from '../records/application-envelope.js'
import {
  encodeUnsignedSignedEnvelope,
  signedRecordSignaturePreimage,
} from '../records/index.js'
import {
  COLLECTIONS,
  INDEX_KEY_FIELDS,
  INDEX_SCHEMA_LIMITS,
  measureEncodedIndexerRow,
} from './schema.js'

const PROJECTION_PREFIX = 'projection/'
const PROJECTION_RANGE = Object.freeze({
  gte: PROJECTION_PREFIX,
  lt: 'projection0',
})
const PROJECTION_KEY = /^projection\/(publication|claim)\/([0-9a-f]{64})$/
const MAX_INGEST_ROWS = PUBLISHER_LIMITS.maxJournalOperations
const MAX_INGEST_BYTES = PUBLISHER_LIMITS.maxSnapshotBytes
const HEX_32 = /^[0-9a-f]{64}$/
const MAX_PROJECTIONS = PUBLISHER_LIMITS.maxJournalOperations
const MAX_RENDITIONS = PUBLISHER_LIMITS.maxApplyBatch
const MAX_DERIVED_ROWS_PER_SOURCE = PUBLISHER_LIMITS.maxApplyBatch * 5
const AVAILABILITY_STATES = new Set(['available', 'unavailable', 'unknown'])
const REPAIR_REASONS = new Set([
  'source-fork-changed',
  'source-history-unavailable',
  'source-identity-changed',
])
const AUTOMATIC_REPAIR = Symbol('automatic repair')

function invalid(message) {
  throw new Error(`Invalid catalog ingestion: ${message}`)
}

function validateSignal(signal) {
  if (signal === undefined) return
  if (!signal || typeof signal !== 'object' ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function') {
    throw new TypeError('signal must be an AbortSignal')
  }
}

function throwIfAborted(signal) {
  if (!signal) return
  if (typeof signal.throwIfAborted === 'function') {
    signal.throwIfAborted()
  } else if (signal.aborted) {
    const error = new Error('catalog ingestion aborted')
    error.name = 'AbortError'
    throw signal.reason ?? error
  }
}

function exactHex(value, name) {
  if (typeof value === 'string') {
    if (!HEX_32.test(value)) invalid(`${name} must be canonical lowercase 64-hex`)
    return value
  }
  if (!(b4a.isBuffer(value) || value instanceof Uint8Array) || value.byteLength !== 32) {
    invalid(`${name} must be 32 bytes or canonical lowercase 64-hex`)
  }
  return b4a.toString(value, 'hex')
}

function sameBytes(left, right) {
  return b4a.equals(b4a.from(left), b4a.from(right))
}

function boundedUint(value, name, fallback) {
  const candidate = value == null ? fallback : value
  if (!Number.isSafeInteger(candidate) || candidate < 0) invalid(`${name} must be a non-negative safe integer`)
  return candidate
}

function normalizeTitle(value) {
  if (typeof value !== 'string') invalid('publication title must be a string')
  const normalized = value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ')
  if (!normalized || b4a.byteLength(normalized) > INDEX_SCHEMA_LIMITS.maxNormalizedTitleBytes) {
    invalid('normalized publication title is out of bounds')
  }
  return normalized
}

function titleTokens(normalizedTitle) {
  const tokens = [...new Set(normalizedTitle.match(/[\p{L}\p{N}]+/gu) || [])].sort()
  if (tokens.length > PUBLISHER_LIMITS.maxApplyBatch) invalid('normalized title token count exceeds its bound')
  return tokens
}

function currentWriter(authorization, operation, capability, now) {
  if (!authorization || !Array.isArray(authorization.writers) || authorization.writers.length > MAX_PROJECTIONS) {
    invalid('catalog authorization state is missing or invalid')
  }
  const signer = exactHex(operation.signerKey, 'operation signer')
  const writer = authorization.writers.find(candidate => candidate?.signerKey === signer)
  if (!writer || !Array.isArray(writer.capabilities) || !writer.capabilities.includes(capability)) {
    invalid(`operation signer is not authorized for ${capability}`)
  }
  if (writer.revocation) invalid('operation signer is revoked')
  const writerExpiry = boundedUint(writer.expiresAt, 'writer expiry')
  if (writerExpiry < now) invalid('operation signer authorization is expired')
  if (boundedUint(writer.admissionPolicyEpoch, 'writer policy epoch') !== operation.policyEpoch) {
    invalid('operation policy epoch does not match writer admission')
  }
  const signedAt = boundedUint(operation.signedAt, 'operation signedAt')
  if (signedAt > now) invalid('operation is future-issued')
  if (operation.expiresAt !== undefined) {
    const operationExpiry = boundedUint(operation.expiresAt, 'operation expiresAt')
    if (operationExpiry > 0 && operationExpiry < now) invalid('operation is expired')
  }
  const sequence = boundedUint(operation.issuerSequence, 'operation sequence')
  const first = boundedUint(writer.firstAcceptedSequence, 'writer first sequence')
  const last = boundedUint(writer.lastAcceptedSequence, 'writer last sequence')
  if (sequence < first || sequence > last) invalid('operation sequence is outside writer authorization')
}

function verifyPublisherFrame(frame, raw, publisherId) {
  if (frame.transitionId || !frame.signature) invalid('projection must contain a singly signed publisher operation')
  if (!sameBytes(encodePublisherCatalogFrame(frame), raw)) invalid('publisher operation frame is noncanonical')
  if (exactHex(frame.issuerIdentityKey, 'operation publisher') !== publisherId) invalid('operation publisher mismatch')
  const expectedId = crypto.hash(encodeUnsignedSignedEnvelope(frame))
  if (!sameBytes(expectedId, frame.recordId)) invalid('publisher operation recordId mismatch')
  if (!crypto.verify(signedRecordSignaturePreimage(frame), frame.signature, frame.signerKey)) {
    invalid('publisher operation signature verification failed')
  }
}

function sourceRow(context, frame, raw) {
  return {
    publisherId: context.publisherId,
    catalogEpoch: context.catalogEpoch,
    recordId: exactHex(frame.recordId, 'operation recordId'),
    recordType: frame.recordType,
    sourceSequence: boundedUint(frame.issuerSequence, 'operation source sequence'),
    canonicalEnvelope: b4a.from(raw),
    projectionState: 'active',
    ingestedAt: context.ingestedAt,
  }
}

function row(collection, record) {
  return { collection, record }
}

function rowToken(entry) {
  return JSON.stringify([
    entry.collection,
    ...INDEX_KEY_FIELDS[entry.collection].map(field => entry.record[field]),
  ])
}

function dedupeRows(rows) {
  const seen = new Set()
  const output = []
  for (const entry of rows) {
    const token = rowToken(entry)
    if (seen.has(token)) continue
    seen.add(token)
    output.push(entry)
  }
  if (output.length > MAX_DERIVED_ROWS_PER_SOURCE + 1) invalid('one projection emits too many index rows')
  return output
}

function exactWorkId(manifest, publicationId) {
  for (const claim of manifest.body.claims) {
    if (claim?.role === 'work' && typeof claim.entityId === 'string' && HEX_32.test(claim.entityId)) {
      return claim.entityId
    }
  }
  return publicationId
}

async function normalizePublication(context, keyId, frame, body, raw, requireCurrentAuthorization) {
  if (frame.recordType !== PUBLISHER_RECORD_TYPES.PUBLICATION) invalid('publication projection contains the wrong record type')
  const publicationId = exactHex(body.publicationId, 'publicationId')
  const manifestId = exactHex(body.manifestId, 'manifestId')
  if (keyId !== publicationId) invalid('publication projection key and publicationId mismatch')
  if (requireCurrentAuthorization) currentWriter(context.authorization, frame, 'publish', context.ingestedAt)

  const manifest = decodePublicationManifest(body.payload)
  const verified = await verifyCatalogPublicationManifest(manifest, {
    publisherId: context.publisherId,
    publicationId,
    manifestId,
    signer: frame.signerKey,
    payload: body.payload,
    now: frame.signedAt,
  })
  if (!verified) invalid('publication manifest verification failed')

  const renditions = [
    ...manifest.body.renditions,
    ...manifest.body.artwork,
    ...manifest.body.subtitles,
  ]
  if (renditions.length > MAX_RENDITIONS) invalid('publication rendition count exceeds its bound')

  const sourceRecordRef = exactHex(frame.recordId, 'operation recordId')
  const normalizedTitle = normalizeTitle(manifest.body.title)
  const rows = [
    row(COLLECTIONS.sourceRecords, sourceRow(context, frame, raw)),
    row(COLLECTIONS.publicationProjections, {
      publisherId: context.publisherId,
      sourceRecordRef,
      publicationId,
      workEntityId: exactWorkId(manifest, publicationId),
      normalizedTitle,
      manifestId,
    }),
  ]
  for (const token of titleTokens(normalizedTitle)) {
    rows.push(row(COLLECTIONS.relationshipEdges, {
      publisherId: context.publisherId,
      sourceRecordRef,
      relationType: 'title-token',
      fromId: publicationId,
      toId: token,
    }))
  }

  for (const rendition of renditions) {
    const renditionId = exactHex(rendition.renditionId, 'renditionId')
    const assetId = exactHex(rendition.core?.assetId, 'assetId')
    rows.push(row(COLLECTIONS.renditionProjections, {
      publisherId: context.publisherId,
      sourceRecordRef,
      renditionId,
      assetId,
      format: rendition.format,
      mediaFeatures: rendition.purpose,
      byteLength: boundedUint(rendition.core?.byteLength, 'rendition byteLength'),
    }))
    rows.push(row(COLLECTIONS.relationshipEdges, {
      publisherId: context.publisherId,
      sourceRecordRef,
      relationType: 'publication-rendition',
      fromId: publicationId,
      toId: renditionId,
    }))
    rows.push(row(COLLECTIONS.relationshipEdges, {
      publisherId: context.publisherId,
      sourceRecordRef,
      relationType: 'rendition-asset',
      fromId: renditionId,
      toId: assetId,
    }))
  }
  return dedupeRows(rows)
}

function externalReferenceRow(context, sourceRecordRef, subject, namespace, identifier, confidence) {
  if (!subject || typeof subject.entityKind !== 'string' || typeof subject.entityId !== 'string') {
    invalid('external reference subject is invalid')
  }
  const normalizedIdentifier = normalizeExternalIdentifier(namespace, identifier)
  if (normalizedIdentifier == null) {
    const normalized = createEntityReference({
      entityKind: subject.entityKind,
      namespace,
      normalizedIdentifier: identifier,
    })
    return row(COLLECTIONS.externalReferenceProjections, {
      publisherId: context.publisherId,
      sourceRecordRef,
      namespace: normalized.namespace,
      normalizedIdentifier: normalized.normalizedIdentifier,
      entityKind: subject.entityKind,
      entityId: subject.entityId,
      evidenceWeight: confidence,
    })
  }
  return row(COLLECTIONS.externalReferenceProjections, {
    publisherId: context.publisherId,
    sourceRecordRef,
    namespace: String(namespace).toLowerCase(),
    normalizedIdentifier,
    entityKind: subject.entityKind,
    entityId: subject.entityId,
    evidenceWeight: confidence,
  })
}

function relationRows(context, sourceRecordRef, claim) {
  if (claim.claimType !== 'EditionOfClaim' && claim.claimType !== 'RecordingOfClaim') return []
  if (!claim.payload.workRef) invalid(`${claim.claimType} requires a workRef`)

  const work = createEntityReference(claim.payload.workRef)
  if (work.entityKind !== 'work') invalid(`${claim.claimType} workRef must identify a work`)

  const expectedKind = claim.claimType === 'EditionOfClaim' ? 'edition' : 'recording'
  const subjects = claim.subjectRefs.map(subject => {
    const normalized = createEntityReference(subject)
    if (normalized.entityKind !== expectedKind) {
      invalid(`${claim.claimType} subject must identify an ${expectedKind}`)
    }
    return normalized
  })
  if (claim.claimType === 'RecordingOfClaim') return []

  return subjects.map(subject => row(COLLECTIONS.relationshipEdges, {
    publisherId: context.publisherId,
    sourceRecordRef,
    relationType: 'work-edition',
    fromId: work.entityId,
    toId: subject.entityId,
  }))
}

function availabilityRows(context, sourceRecordRef, claim, envelope) {
  if (claim.claimType !== 'AvailabilityObservation') return []
  const assetId = claim.payload.assetId
  if (assetId == null) return []
  if (typeof assetId !== 'string' || !HEX_32.test(assetId)) {
    invalid('AvailabilityObservation assetId must be canonical lowercase 64-hex')
  }
  const state = claim.payload.availabilityStatus
  if (!AVAILABILITY_STATES.has(state)) invalid('AvailabilityObservation state is invalid')
  return [row(COLLECTIONS.availabilityProjections, {
    publisherId: context.publisherId,
    sourceRecordRef,
    assetId,
    observerId: exactHex(envelope.signer, 'availability observer'),
    observedSeeders: boundedUint(claim.payload.observedSeeders, 'observedSeeders', 0),
    observedCompleteSeeders: boundedUint(claim.payload.observedCompleteSeeders, 'observedCompleteSeeders', 0),
    observedAt: boundedUint(claim.payload.observedAt, 'observedAt', envelope.issuedAt),
    expiresAt: boundedUint(envelope.expiresAt, 'availability expiry', 0),
    availabilityState: state,
  })]
}

async function normalizeClaim(context, keyId, frame, body, raw, requireCurrentAuthorization) {
  if (frame.recordType !== PUBLISHER_RECORD_TYPES.CLAIM) invalid('claim projection contains the wrong record type')
  const claimId = exactHex(body.claimId, 'claimId')
  if (keyId !== claimId) invalid('claim projection key and claimId mismatch')
  if (requireCurrentAuthorization) currentWriter(context.authorization, frame, 'claim', context.ingestedAt)

  const envelope = decodeApplicationEnvelope(body.payload)
  if (!sameBytes(encodeApplicationEnvelope(envelope), body.payload)) invalid('claim application envelope is noncanonical')
  const claim = decodeClaimBody(envelope.body)
  if (exactHex(envelope.recordId, 'claim envelope recordId') !== claimId ||
      exactHex(envelope.signer, 'claim envelope signer') !== exactHex(frame.signerKey, 'operation signer') ||
      claim.claimType !== body.claimType) {
    invalid('claim envelope identity does not match publisher operation')
  }
  if (!await verifyMediaClaim(envelope, {
    allowedSigners: [frame.signerKey],
    now: requireCurrentAuthorization ? context.ingestedAt : envelope.issuedAt,
  })) invalid('claim signature verification failed')

  const sourceRecordRef = exactHex(frame.recordId, 'operation recordId')
  const rows = [row(COLLECTIONS.sourceRecords, sourceRow(context, frame, raw))]
  for (const subject of claim.subjectRefs) {
    if (subject.namespace !== 'issuer-native') {
      rows.push(externalReferenceRow(
        context,
        sourceRecordRef,
        subject,
        subject.namespace,
        subject.normalizedIdentifier,
        claim.confidence,
      ))
    }
  }
  if (claim.claimType === 'ExternalReferenceClaim') {
    const external = claim.payload.externalRef
    if (!external || typeof external.namespace !== 'string' || typeof external.identifier !== 'string') {
      invalid('ExternalReferenceClaim requires an externalRef')
    }
    for (const subject of claim.subjectRefs) {
      rows.push(externalReferenceRow(
        context,
        sourceRecordRef,
        subject,
        external.namespace,
        external.identifier,
        claim.confidence,
      ))
    }
  }
  rows.push(...relationRows(context, sourceRecordRef, claim))
  rows.push(...availabilityRows(context, sourceRecordRef, claim, envelope))
  return dedupeRows(rows)
}

async function normalizeProjection(context, entry, requireCurrentAuthorization) {
  if (!entry || typeof entry.key !== 'string' || !(b4a.isBuffer(entry.value) || entry.value instanceof Uint8Array)) {
    invalid('projection entry is malformed')
  }
  const match = PROJECTION_KEY.exec(entry.key)
  if (!match) invalid(`projection key ${entry.key} is invalid or unsupported`)
  const [, kind, keyId] = match
  const raw = b4a.from(entry.value)
  const frame = decodePublisherCatalogFrame(raw)
  verifyPublisherFrame(frame, raw, context.publisherId)
  const body = decodePublisherOperationBody(frame.recordType, frame.canonicalBody)
  if (kind === 'publication') return normalizePublication(context, keyId, frame, body, raw, requireCurrentAuthorization)
  return normalizeClaim(context, keyId, frame, body, raw, requireCurrentAuthorization)
}

function cursorFor(context) {
  return {
    publisherId: context.publisherId,
    catalogEpoch: context.catalogEpoch,
    catalogBootstrapKey: context.catalogBootstrapKey,
    viewFork: context.viewFork,
    viewVersion: context.viewVersion,
    sourceHead: context.sourceHead,
    lastVerifiedDescriptor: context.descriptorDigest,
  }
}

function cursorMatches(cursor, next) {
  return cursor.publisherId === next.publisherId &&
    cursor.catalogEpoch === next.catalogEpoch &&
    cursor.catalogBootstrapKey === next.catalogBootstrapKey &&
    cursor.viewFork === next.viewFork &&
    cursor.viewVersion === next.viewVersion &&
    cursor.sourceHead === next.sourceHead &&
    cursor.lastVerifiedDescriptor === next.lastVerifiedDescriptor
}


function scaledLimit(value, factor) {
  return value > Math.floor(Number.MAX_SAFE_INTEGER / factor)
    ? Number.MAX_SAFE_INTEGER
    : value * factor
}

function createIngestionBudget(limits, cursor, incremental = false) {
  if (!limits || !Number.isSafeInteger(limits.maxRows) || limits.maxRows < 0 ||
      !Number.isSafeInteger(limits.maxRetainedBytes) || limits.maxRetainedBytes < 0) {
    throw new TypeError('index publisher admission limits are invalid')
  }
  const configuredRows = Math.min(limits.maxRows, MAX_INGEST_ROWS)
  const configuredBytes = Math.min(limits.maxRetainedBytes, MAX_INGEST_BYTES)
  const budget = {
    maxRows: incremental ? scaledLimit(configuredRows, 2) : configuredRows,
    maxBytes: incremental ? scaledLimit(configuredBytes, 2) : configuredBytes,
    rows: incremental ? 0 : 1,
    bytes: incremental ? 0 : measureEncodedIndexerRow(COLLECTIONS.sourceCursors, cursor),
  }
  if (budget.rows > budget.maxRows) invalid('ingestion row budget is smaller than its source cursor')
  if (budget.bytes > budget.maxBytes) invalid('ingestion byte budget is smaller than its source cursor')
  return budget
}

function appendBounded(target, entries, budget) {
  const nextRows = budget.rows + entries.length
  if (!Number.isSafeInteger(nextRows) || nextRows > budget.maxRows) {
    invalid(`ingestion row budget ${budget.maxRows} exceeded`)
  }
  let nextBytes = budget.bytes
  for (const entry of entries) {
    const charge = measureEncodedIndexerRow(entry.collection, entry.record)
    if (nextBytes > budget.maxBytes - charge) {
      invalid(`ingestion byte budget ${budget.maxBytes} exceeded`)
    }
    nextBytes += charge
  }
  budget.rows = nextRows
  budget.bytes = nextBytes
  target.push(...entries)
}
async function collectCurrentRows(context, pinnedView, budget) {
  const rows = []
  let count = 0
  throwIfAborted(context.signal)
  for await (const entry of pinnedView.createReadStream({
    ...PROJECTION_RANGE,
    limit: MAX_PROJECTIONS + 1,
  })) {
    throwIfAborted(context.signal)
    count++
    if (count > MAX_PROJECTIONS) invalid('publisher projection count exceeds its bound')
    const normalized = await normalizeProjection(context, entry, true)
    throwIfAborted(context.signal)
    appendBounded(rows, normalized, budget)
  }
  throwIfAborted(context.signal)
  return rows
}

async function collectChanges(context, pinnedView, previousVersion, budget) {
  const operations = []
  let count = 0
  throwIfAborted(context.signal)
  for await (const difference of pinnedView.createDiffStream(previousVersion, {
    ...PROJECTION_RANGE,
    limit: MAX_PROJECTIONS + 1,
  })) {
    throwIfAborted(context.signal)
    count++
    if (count > MAX_PROJECTIONS) invalid('publisher projection diff exceeds its bound')
    if (difference.right) {
      const previousRows = await normalizeProjection(context, difference.right, false)
      throwIfAborted(context.signal)
      appendBounded(operations, previousRows.map(entry => ({ type: 'delete', ...entry })), budget)
    }
    if (difference.left) {
      const currentRows = await normalizeProjection(context, difference.left, true)
      throwIfAborted(context.signal)
      appendBounded(operations, currentRows.map(entry => ({ type: 'put', ...entry })), budget)
    }
  }
  throwIfAborted(context.signal)
  return operations
}

function validateCatalogSurface(catalog) {
  if (!catalog || typeof catalog !== 'object' ||
      typeof catalog.update !== 'function' ||
      typeof catalog.getViewHead !== 'function' ||
      typeof catalog.getAuthorizationState !== 'function') {
    throw new TypeError('catalog must expose update(), getViewHead(), and getAuthorizationState()')
  }
}

function validateIndexSurface(index) {
  if (!index || typeof index.getSourceCursor !== 'function' ||
      typeof index.getPublisherSourceCursor !== 'function' ||
      typeof index.getPublisherAdmissionLimits !== 'function' ||
      typeof index.replacePublisherSlice !== 'function' ||
      typeof index.applyPublisherChanges !== 'function') {
    throw new TypeError('index must be a Plan 04 indexer store with publisher cursor and admission limits')
  }
}

async function preparePinnedContext({ publisherId, descriptor, catalog, now, signal }) {
  const canonicalPublisherId = exactHex(publisherId, 'publisherId')
  verifyPublisherNamespaceDescriptor(descriptor)
  const descriptorBytes = encodePublisherNamespaceDescriptor(descriptor)
  if (exactHex(descriptor.publisherId, 'descriptor publisherId') !== canonicalPublisherId) {
    invalid('descriptor publisherId mismatch')
  }

  throwIfAborted(signal)
  await catalog.update()
  throwIfAborted(signal)
  const view = catalog.view
  if (catalog.key == null || !view || typeof view.checkout !== 'function') {
    invalid('updated catalog must expose its bootstrap key and view')
  }
  const catalogBootstrapKey = exactHex(catalog.key, 'catalog bootstrap key')
  if (catalogBootstrapKey !== exactHex(descriptor.catalogBootstrapKey, 'descriptor catalogBootstrapKey')) {
    invalid('catalog bootstrap key does not match descriptor')
  }
  const viewVersion = view.version
  const viewFork = view.core?.fork
  if (!Number.isSafeInteger(viewVersion) || viewVersion < 1 ||
      !Number.isSafeInteger(viewFork) || viewFork < 0) invalid('catalog view head is invalid')

  const ingestedAt = now()
  if (!Number.isSafeInteger(ingestedAt) || ingestedAt < 0) throw new TypeError('now() must return a non-negative safe integer')
  return {
    catalogEpoch: boundedUint(descriptor.catalogEpoch, 'catalogEpoch'),
    catalogBootstrapKey,
    descriptorBytes,
    descriptorDigest: b4a.toString(crypto.hash(descriptorBytes), 'hex'),
    ingestedAt,
    publisherId: canonicalPublisherId,
    sourceHead: viewVersion,
    view,
    viewFork,
    viewVersion,
    signal,
  }
}

export function createCatalogIngestor({ index, now = Date.now } = {}) {
  validateIndexSurface(index)
  if (typeof now !== 'function') throw new TypeError('now must be a function')

  async function run({ publisherId, descriptor, catalog, signal } = {}, requestedRepairReason = AUTOMATIC_REPAIR) {
    validateSignal(signal)
    throwIfAborted(signal)
    validateCatalogSurface(catalog)
    if (requestedRepairReason !== AUTOMATIC_REPAIR && !REPAIR_REASONS.has(requestedRepairReason)) {
      throw new TypeError('repair reason must be a supported bounded value')
    }
    const context = await preparePinnedContext({ publisherId, descriptor, catalog, now, signal })
    const pinnedView = context.view.checkout(context.viewVersion)
    try {
      throwIfAborted(signal)
      await pinnedView.ready()
      throwIfAborted(signal)
      if (pinnedView.version !== context.viewVersion || pinnedView.core.fork !== context.viewFork) {
        invalid('catalog checkout does not match the captured fork and version')
      }
      throwIfAborted(signal)
      const acceptedDescriptor = await pinnedView.get('state/descriptor')
      throwIfAborted(signal)
      if (!acceptedDescriptor) invalid('pinned catalog has no accepted namespace descriptor')
      const decodedDescriptor = decodePublisherNamespaceDescriptor(acceptedDescriptor.value, {
        legacyCompatibility: PUBLISHER_CATALOG_LEGACY_COMPATIBILITY,
      })
      verifyPublisherNamespaceDescriptor(decodedDescriptor)
      if (!sameBytes(encodePublisherNamespaceDescriptor(decodedDescriptor), context.descriptorBytes)) {
        invalid('pinned catalog descriptor does not match the verified descriptor')
      }
      throwIfAborted(signal)
      const authorization = await getPublisherAuthorizationState(pinnedView)
      throwIfAborted(signal)
      if (!authorization) invalid('pinned catalog has no accepted authorization state')
      const pinnedContext = { ...context, authorization }
      const previous = await index.getPublisherSourceCursor({
        publisherId: pinnedContext.publisherId,
      })
      throwIfAborted(signal)
      const cursor = cursorFor(pinnedContext)
      const admissionLimits = await index.getPublisherAdmissionLimits({
        publisherId: pinnedContext.publisherId,
      })
      throwIfAborted(signal)

      if (previous &&
          previous.catalogEpoch === cursor.catalogEpoch &&
          previous.catalogBootstrapKey === cursor.catalogBootstrapKey &&
          previous.lastVerifiedDescriptor === cursor.lastVerifiedDescriptor &&
          previous.viewFork === pinnedContext.viewFork &&
          previous.viewVersion > pinnedContext.viewVersion) {
        invalid('catalog source is behind the durable cursor')
      }

      let repairReason = requestedRepairReason === AUTOMATIC_REPAIR ? null : requestedRepairReason
      if (repairReason === null && previous) {
        if (previous.catalogEpoch !== cursor.catalogEpoch ||
            previous.catalogBootstrapKey !== cursor.catalogBootstrapKey ||
            previous.lastVerifiedDescriptor !== cursor.lastVerifiedDescriptor) {
          repairReason = 'source-identity-changed'
        } else if (previous.viewFork !== pinnedContext.viewFork) {
          repairReason = 'source-fork-changed'
        }
      }
      if (repairReason !== null) {
        const rows = await collectCurrentRows(
          pinnedContext,
          pinnedView,
          createIngestionBudget(admissionLimits, cursor),
        )
        throwIfAborted(signal)
        await index.replacePublisherSlice({
          publisherId: pinnedContext.publisherId,
          rows,
          cursor,
          expectedCursor: previous,
        })
        return Object.freeze({
          status: 'repaired',
          mode: 'repair',
          reason: repairReason,
          changed: rows.length,
          cursor,
        })
      }
      if (previous && previous.viewVersion === pinnedContext.viewVersion) {
        if (!cursorMatches(previous, cursor)) invalid('stored cursor conflicts with the pinned catalog head')
        await collectCurrentRows(
          pinnedContext,
          pinnedView,
          createIngestionBudget(admissionLimits, cursor),
        )
        return Object.freeze({ mode: 'noop', changed: 0, cursor })
      }
      const usablePrevious = previous &&
        Number.isSafeInteger(previous.viewVersion) &&
        previous.viewVersion >= 1 &&
        previous.viewVersion < pinnedContext.viewVersion
      if (!usablePrevious) {
        const rows = await collectCurrentRows(
          pinnedContext,
          pinnedView,
          createIngestionBudget(admissionLimits, cursor),
        )
        throwIfAborted(signal)
        await index.replacePublisherSlice({
          publisherId: pinnedContext.publisherId,
          rows,
          cursor,
          expectedCursor: previous,
        })
        return Object.freeze({ mode: 'bootstrap', changed: rows.length, cursor })
      }
      const currentRows = await collectCurrentRows(
        pinnedContext,
        pinnedView,
        createIngestionBudget(admissionLimits, cursor),
      )

      let operations
      try {
        operations = await collectChanges(
          pinnedContext,
          pinnedView,
          previous.viewVersion,
          createIngestionBudget(admissionLimits, cursor, true),
        )
      } catch (error) {
        if (error?.code !== 'SNAPSHOT_NOT_AVAILABLE') throw error
        throwIfAborted(signal)
        await index.replacePublisherSlice({
          publisherId: pinnedContext.publisherId,
          rows: currentRows,
          cursor,
          expectedCursor: previous,
        })
        return Object.freeze({
          status: 'repaired',
          mode: 'repair',
          reason: 'source-history-unavailable',
          changed: currentRows.length,
          cursor,
        })
      }
      throwIfAborted(signal)
      await index.applyPublisherChanges({
        publisherId: pinnedContext.publisherId,
        operations,
        cursor,
        expectedCursor: previous,
      })
      return Object.freeze({ mode: 'incremental', changed: operations.length, cursor })
    } finally {
      await pinnedView.close()
    }
  }

  return Object.freeze({
    ingest(input) {
      return run(input, AUTOMATIC_REPAIR)
    },
    repairPublisher(input = {}) {
      return run(input, input.reason ?? null)
    },
  })
}
