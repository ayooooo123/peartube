import b4a from 'b4a'
import Hyperbee from 'hyperbee'
import crypto from 'hypercore-crypto'

import {
  decodeSignedEnvelope,
  decodeMultiSignedEnvelope,
  encodeSignedEnvelope,
  encodeMultiSignedEnvelope,
  signedRecordSignaturePreimage
} from '../records/index.js'
import { assertBytes, isBytes, equalBytes } from '../records/canonical.js'
import {
  PUBLISHER_LIMITS,
  PUBLISHER_RECORD_TYPES,
  decodePublisherOperationBody
} from './canonical.js'
import {
  decodePublisherNamespaceDescriptor,
  PUBLISHER_CATALOG_LEGACY_COMPATIBILITY,
  encodePublisherNamespaceDescriptor
} from './namespace.js'
import {
  createPublisherAuthorizationState,
  clonePublisherAuthorizationState,
  comparePublisherOperationEntries,
  encodePublisherAuthorizationState,
  publisherProjectionIdentity,
  reducePublisherOperation
} from './authorization.js'
import { createPublisherKeyProvider } from './key-provider.js'

const PREFIX = Object.freeze({
  JOURNAL: 'journal/',
  ACCEPTED: 'accepted/',
  REJECTED: 'rejected/',
  OVERFLOW: 'overflow/',
  DRAINED: 'checkpoint/drained/',
  PROJECTION: 'projection/',
  ROSTER: 'roster/',
  STATE: 'state/'
})
const JOURNAL_COUNT_KEY = 'meta/journal-count'
const STATE_DESCRIPTOR_KEY = 'state/descriptor'
const STATE_AUTHORIZATION_KEY = 'state/authorization'
const LEGACY_GENESIS_ID_KEY = 'meta/legacy-genesis-id'
const LATEST_HEAD_KEY = 'projection/view-head/latest'
const CONTEXT_INDEPENDENT_REJECTION_CODES = new Set([
  'ISSUER_MISMATCH',
  'MALFORMED_OPERATION',
  'UNKNOWN_RECORD_TYPE',
  'UNSUPPORTED_SCHEMA'
])

function invalid (message) {
  throw new Error(`Invalid publisher catalog: ${message}`)
}

function idHex (value) {
  const id = value.recordId || value.transitionId
  assertBytes(id, 32, 'operationId')
  return b4a.toString(id, 'hex')
}

function journalEntryFingerprint (input) {
  return b4a.toString(crypto.hash(input), 'hex')
}

function decodeAuthorizationMetadata (input) {
  if (!isBytes(input) || input.byteLength < 5 || input[0] !== 1) invalid('authorization state is corrupt')
  const jsonLength = input[1] | (input[2] << 8) | (input[3] << 16) | (input[4] << 24)
  if (jsonLength < 2 || jsonLength > input.byteLength - 5) invalid('authorization state is corrupt')
  let metadata
  try {
    metadata = JSON.parse(b4a.toString(input.subarray(input.byteLength - jsonLength)))
  } catch {
    invalid('authorization state is corrupt')
  }
  if (!Number.isSafeInteger(metadata?.policyEpoch) || metadata.policyEpoch < 0) invalid('authorization state is corrupt')
  return metadata
}

function sourceKey (node) {
  const key = node?.from?.key || node?.writer?.key || node?.key
  assertBytes(key, 32, 'Autobase source writer key')
  return key
}

function journalKey (ordinal) {
  return `${PREFIX.JOURNAL}${String(ordinal).padStart(16, '0')}`
}

function parseCount (entry) {
  if (!entry) return 0
  const text = b4a.toString(entry.value)
  if (!/^\d+$/.test(text)) invalid('journal count is corrupt')
  const count = Number(text)
  if (!Number.isSafeInteger(count) || count < 0 || count > PUBLISHER_LIMITS.maxJournalOperations) invalid('journal count is out of bounds')
  return count
}

function encodeJournalValue (writerKey, frame) {
  assertBytes(writerKey, 32, 'source writer key')
  if (!isBytes(frame) || frame.byteLength > PUBLISHER_LIMITS.maxOperationBytes) invalid('operation frame exceeds its byte limit')
  return b4a.concat([writerKey, frame])
}

function decodeJournalValue (input) {
  if (!isBytes(input) || input.byteLength < 33 || input.byteLength > PUBLISHER_LIMITS.maxOperationBytes + 32) invalid('journal value is out of bounds')
  return { sourceWriterKey: input.subarray(0, 32), frame: input.subarray(32) }
}

export function encodePublisherCatalogFrame (value) {
  const frame = value?.transitionId ? encodeMultiSignedEnvelope(value) : encodeSignedEnvelope(value)
  if (frame.byteLength > PUBLISHER_LIMITS.maxOperationBytes) invalid('operation frame exceeds its byte limit')
  return frame
}

export function decodePublisherCatalogFrame (input) {
  if (!isBytes(input)) invalid('operation frame must be bytes')
  if (input.byteLength === 0 || input.byteLength > PUBLISHER_LIMITS.maxOperationBytes) invalid('operation frame exceeds its byte limit')
  if (input[0] === 1) return decodeSignedEnvelope(input)
  if (input[0] === 2) return decodeMultiSignedEnvelope(input)
  invalid('unknown operation frame variant')
}

// Accepted projections used to retain only a frame. That loses the distinct
// Autobase writer identity needed to replay authorization safely on another
// device. New entries retain the exact authenticated journal provenance.
function encodeAcceptedEntry (entry) {
  assertBytes(entry.sourceWriterKey, 32, 'accepted source writer key')
  return b4a.concat([entry.sourceWriterKey, entry.frame])
}

export function decodeAcceptedEntry (input) {
  if (!isBytes(input) || input.byteLength <= 32) return null
  const sourceWriterKey = b4a.from(input.subarray(0, 32))
  const frame = b4a.from(input.subarray(32))
  try {
    const value = decodePublisherCatalogFrame(frame)
    return { sourceWriterKey, frame, value }
  } catch {
    return null
  }
}

export function openPublisherCatalogView (viewStore) {
  return new Hyperbee(viewStore.get('peartube-publisher-catalog-view'), {
    keyEncoding: 'utf-8',
    valueEncoding: 'binary',
    extension: false
  })
}

async function collectPrefix (view, prefix, maximum = PUBLISHER_LIMITS.maxJournalOperations) {
  const entries = []
  for await (const entry of view.createReadStream({ gte: prefix, lt: prefix + '\xff' })) {
    if (entries.length >= maximum) invalid(`${prefix} entry count exceeds its bound`)
    entries.push(entry)
  }
  return entries
}

async function getPersistedLegacyGenesisId (view, bootstrapKey, publisherId) {
  const marker = await view.get(LEGACY_GENESIS_ID_KEY)
  if (marker) {
    const operationId = b4a.toString(marker.value)
    if (/^[0-9a-f]{64}$/.test(operationId)) return operationId
    invalid('persisted legacy genesis marker is corrupt')
  }

  const descriptorEntry = await view.get(STATE_DESCRIPTOR_KEY)
  if (!descriptorEntry) return null
  try {
    decodePublisherNamespaceDescriptor(descriptorEntry.value)
    return null
  } catch {
    // Only an exact previously accepted descriptor may enter the bounded legacy window.
  }

  let descriptor
  try {
    descriptor = decodePublisherNamespaceDescriptor(descriptorEntry.value, {
      legacyCompatibility: PUBLISHER_CATALOG_LEGACY_COMPATIBILITY
    })
  } catch {
    return null
  }
  if (!equalBytes(descriptor.publisherId, publisherId) ||
      !equalBytes(descriptor.catalogBootstrapKey, bootstrapKey)) return null

  for (const entry of await collectPrefix(view, PREFIX.ACCEPTED)) {
    let value = null
    try {
      const accepted = decodeAcceptedEntry(entry.value)
      if (accepted) value = accepted.value
    } catch {}
    if (!value) {
      try {
        value = decodePublisherCatalogFrame(entry.value)
      } catch {}
    }
    if (!value) continue
    const operationId = idHex(value)
    if (value.recordType !== PUBLISHER_RECORD_TYPES.NAMESPACE ||
        entry.key !== `${PREFIX.ACCEPTED}${operationId}` ||
        !equalBytes(value.canonicalBody, descriptorEntry.value)) continue
    await view.put(LEGACY_GENESIS_ID_KEY, b4a.from(operationId))
    return operationId
  }
  return null
}

async function clearDerived (view) {
  for (const prefix of [PREFIX.ACCEPTED, PREFIX.REJECTED, PREFIX.PROJECTION, PREFIX.ROSTER, PREFIX.STATE]) {
    for await (const entry of view.createReadStream({ gte: prefix, lt: prefix + '\xff' })) await view.del(entry.key)
  }
}

function verifyGenesis (value, bootstrapKey, publisherId, keyProvider, legacyGenesisId = null) {
  if (value.recordType !== PUBLISHER_RECORD_TYPES.NAMESPACE || value.transitionId) invalid('catalog genesis must be a single-signed namespace descriptor')
  if (value.schemaMajor !== 1 || value.schemaMinor !== 0 || value.policyEpoch !== 0 || value.issuerSequence !== 0) invalid('catalog genesis schema, epoch, and sequence are fixed')
  const descriptor = decodePublisherNamespaceDescriptor(value.canonicalBody, legacyGenesisId === idHex(value)
    ? { legacyCompatibility: PUBLISHER_CATALOG_LEGACY_COMPATIBILITY }
    : undefined)
  if (!equalBytes(descriptor.publisherId, publisherId)) invalid('namespace descriptor does not match the expected publisherId')
  if (descriptor.catalogEpoch !== 0 || descriptor.policySequence !== 0) invalid('catalog genesis descriptor must begin at epoch and policy sequence zero')
  if (!equalBytes(descriptor.catalogBootstrapKey, bootstrapKey)) invalid('namespace descriptor catalogBootstrapKey does not match Autobase')
  if (!equalBytes(descriptor.publisherId, value.issuerIdentityKey) || !equalBytes(descriptor.publisherRootKey, value.signerKey)) invalid('namespace descriptor envelope authority mismatch')
  keyProvider.verifySignedEnvelope(value, {
    issuerIdentityKey: descriptor.publisherId,
    policyEpoch: 0,
    authorizeSigner: candidate => equalBytes(candidate.signerKey, descriptor.publisherRootKey),
    authorizeSequence: candidate => candidate.issuerSequence === 0,
    claimReplay: () => true,
    now: value.signedAt,
    maxClockSkew: 0
  })
  return descriptor
}

function isRootPolicyOperation (value) {
  return value.recordType === PUBLISHER_RECORD_TYPES.WRITER_ADMISSION ||
    value.recordType === PUBLISHER_RECORD_TYPES.WRITER_REVOCATION ||
    value.recordType === PUBLISHER_RECORD_TYPES.ROOT_TRANSITION
}

function isAuthorityOperation (value) {
  return value.recordType === PUBLISHER_RECORD_TYPES.NAMESPACE || isRootPolicyOperation(value)
}

function writerGenerationKey (writer) {
  return `${b4a.toString(writer.signerKey, 'hex')}:${writer.admissionPolicyEpoch}`
}

function carryAuthenticatedWriterHighWater (state, parsed, admissionPositions, keyProvider, upperPosition) {
  for (const writer of state.writers.values()) {
    if (!writer.revocation) continue
    const generation = writerGenerationKey(writer)
    const admissionPosition = admissionPositions.get(generation)
    if (admissionPosition === undefined) continue
    const trialState = clonePublisherAuthorizationState(state)
    const signerId = b4a.toString(writer.signerKey, 'hex')
    const trialWriter = trialState.signers.get(signerId)
    let highWater = writer.lastAcceptedSequence
    for (const entry of parsed) {
      if (entry.position <= admissionPosition || entry.position > upperPosition || isAuthorityOperation(entry.value)) continue
      if (!entry.value.signerKey || !equalBytes(entry.value.signerKey, writer.signerKey) || !equalBytes(entry.sourceWriterKey, writer.writerKey)) continue
      const reduced = reducePublisherOperation(trialState, entry.value, {
        keyProvider,
        sourceWriterKey: entry.sourceWriterKey
      })
      if (reduced.accepted || reduced.code === 'DUPLICATE' || reduced.code === 'REVOKED_WRITER' || reduced.code === 'WRITER_SEQUENCE_NOT_MONOTONIC') {
        highWater = Math.max(highWater, entry.value.issuerSequence)
        trialWriter.lastAcceptedSequence = highWater
      }
    }
    writer.lastAcceptedSequence = highWater
  }
}

function rejectionValue (value, code, error = '') {
  return b4a.from(JSON.stringify({ operationId: idHex(value), recordType: value.recordType, code, error }))
}

function frameForResult (entry) {
  return entry.frame
}

function contextualRejection (entry, code, error = '') {
  return {
    value: entry.value,
    code,
    error,
    frame: entry.frame,
    sourceWriterKey: entry.sourceWriterKey
  }
}

function projectionKey (identity) {
  return `${PREFIX.PROJECTION}${identity.kind}/${b4a.toString(identity.id, 'hex')}`
}

async function applyProjection (projections, rejected, result, entry) {
  const { value, body } = result
  if (value.recordType === PUBLISHER_RECORD_TYPES.RETRACTION) {
    projections.delete(`${PREFIX.PROJECTION}${body.targetType}/${b4a.toString(body.targetId, 'hex')}`)
    return
  }
  if (value.recordType === PUBLISHER_RECORD_TYPES.VIEW_HEAD) {
    const previous = projections.get(LATEST_HEAD_KEY)
    if (!previous || body.length > previous.body.length || (body.length === previous.body.length && b4a.compare(value.recordId, previous.value.recordId) < 0)) {
      if (previous) rejected.push(contextualRejection(previous, 'CONFLICT_LOST', 'view-head announcement lost deterministic length/operation-ID tie-break'))
      projections.set(LATEST_HEAD_KEY, { value, body, frame: entry.frame, sourceWriterKey: entry.sourceWriterKey })
    } else {
      rejected.push(contextualRejection(entry, 'CONFLICT_LOST', 'view-head announcement lost deterministic length/operation-ID tie-break'))
    }
    return
  }
  const identity = publisherProjectionIdentity(value.recordType, body, value)
  if (!identity) return
  const key = projectionKey(identity)
  const previous = projections.get(key)
  if (!previous || b4a.compare(value.recordId, previous.value.recordId) < 0) {
    if (previous) rejected.push(contextualRejection(previous, 'CONFLICT_LOST', 'operation lost the canonical operation-ID conflict tie-break'))
    projections.set(key, { value, body, frame: entry.frame, sourceWriterKey: entry.sourceWriterKey })
  } else {
    rejected.push(contextualRejection(entry, 'CONFLICT_LOST', 'operation lost the canonical operation-ID conflict tie-break'))
  }
}

export async function rebuildPublisherCatalogView (view, host, { keyProvider = createPublisherKeyProvider(), publisherId } = {}) {
  assertBytes(publisherId, 32, 'expected publisherId')
  const legacyGenesisId = await getPersistedLegacyGenesisId(view, host.key, publisherId)
  const journal = await collectPrefix(view, PREFIX.JOURNAL)
  const parsed = []
  for (const item of journal) {
    try {
      const decoded = decodeJournalValue(item.value)
      parsed.push({ ...decoded, value: decodePublisherCatalogFrame(decoded.frame), orderKey: item.key, position: parsed.length })
    } catch {
      // Noncanonical entries cannot be projected. Autobase history retains the raw block.
    }
  }

  const genesisCandidates = []
  for (const entry of parsed) {
    if (entry.value.recordType !== PUBLISHER_RECORD_TYPES.NAMESPACE) continue
    try {
      entry.descriptor = verifyGenesis(entry.value, host.key, publisherId, keyProvider, legacyGenesisId)
      genesisCandidates.push(entry)
    } catch {
      // Recorded below after the canonical genesis is selected.
    }
  }
  genesisCandidates.sort((left, right) => b4a.compare(left.value.recordId, right.value.recordId))
  const genesis = genesisCandidates[0] || null
  const oldRoster = new Set((await collectPrefix(view, PREFIX.ROSTER)).map(entry => entry.key.slice(PREFIX.ROSTER.length)))
  const drainedCheckpoints = new Map(
    (await collectPrefix(view, PREFIX.DRAINED)).map(entry => [
      entry.key.slice(PREFIX.DRAINED.length),
      b4a.toString(entry.value)
    ])
  )
  await clearDerived(view)
  if (!genesis) return { descriptor: null, state: null, accepted: [], rejected: [], projections: new Map() }

  const rootGroups = new Map()
  for (const entry of parsed) {
    if (entry === genesis || entry.value.recordType === PUBLISHER_RECORD_TYPES.NAMESPACE || !isRootPolicyOperation(entry.value)) continue
    const group = rootGroups.get(entry.value.issuerSequence)
    if (group) group.push(entry)
    else rootGroups.set(entry.value.issuerSequence, [entry])
  }

  const rootState = createPublisherAuthorizationState(genesis.descriptor)
  const rootEvents = []
  const rootRejected = []
  const anticipatedRevocations = new Map()
  const admissionPositions = new Map()
  let effectivePosition = genesis.position
  const orderedRootGroups = [...rootGroups.entries()].sort((left, right) => left[0] - right[0])
  for (const [, candidates] of orderedRootGroups) {
    candidates.sort(comparePublisherOperationEntries)
    const baseline = clonePublisherAuthorizationState(rootState)
    const authorized = []
    for (const candidate of candidates) {
      const candidateState = clonePublisherAuthorizationState(baseline)
      const candidatePosition = Math.max(effectivePosition, candidate.position)
      carryAuthenticatedWriterHighWater(candidateState, parsed, admissionPositions, keyProvider, candidatePosition)
      const trial = reducePublisherOperation(candidateState, candidate.value, {
        keyProvider,
        sourceWriterKey: candidate.sourceWriterKey
      })
      if (trial.accepted || trial.code === 'DUPLICATE') authorized.push({ candidate, trial })
      else rootRejected.push(contextualRejection(candidate, trial.code, trial.error || ''))
    }
    if (authorized.length === 0) continue
    const { candidate: winner, trial } = authorized[0]
    const winnerPosition = Math.max(effectivePosition, winner.position)
    if (winner.value.recordType === PUBLISHER_RECORD_TYPES.WRITER_REVOCATION) {
      for (const revocation of trial.body.revocations) {
        const writer = rootState.writers.get(b4a.toString(revocation.writerKey, 'hex'))
        if (!writer) continue
        anticipatedRevocations.set(writerGenerationKey(writer), {
          revokedFromEpoch: rootState.policyEpoch,
          revokedAtEpoch: trial.body.newPolicyEpoch,
          acceptedThroughSequence: revocation.acceptedThroughSequence
        })
      }
    }
    carryAuthenticatedWriterHighWater(rootState, parsed, admissionPositions, keyProvider, winnerPosition)
    const reduced = reducePublisherOperation(rootState, winner.value, {
      keyProvider,
      sourceWriterKey: winner.sourceWriterKey
    })
    if (!reduced.accepted && reduced.code !== 'DUPLICATE') {
      rootRejected.push(contextualRejection(winner, reduced.code, reduced.error || ''))
      continue
    }
    effectivePosition = winnerPosition
    rootEvents.push({ position: effectivePosition, entry: winner })
    if (winner.value.recordType === PUBLISHER_RECORD_TYPES.WRITER_ADMISSION) {
      const admittedWriter = rootState.writers.get(b4a.toString(reduced.body.writerKey, 'hex'))
      admissionPositions.set(writerGenerationKey(admittedWriter), effectivePosition)
    }
    for (let index = 1; index < authorized.length; index++) {
      const candidate = authorized[index].candidate
      if (!b4a.equals(candidate.value.recordId || candidate.value.transitionId, winner.value.recordId || winner.value.transitionId)) {
        rootRejected.push(contextualRejection(candidate, 'SEQUENCE_CONFLICT', 'authorized operation lost the canonical operation-ID sequence tie-break'))
      }
    }
  }

  const state = createPublisherAuthorizationState(genesis.descriptor)
  const accepted = [{ value: genesis.value, body: genesis.descriptor, frame: genesis.frame, sourceWriterKey: genesis.sourceWriterKey, code: 'ACCEPTED' }]
  const rejected = [...rootRejected]
  const projections = new Map()
  const drainedWriterIds = new Set()
  const eventsByPosition = new Map()
  for (const event of rootEvents) {
    const events = eventsByPosition.get(event.position)
    if (events) events.push(event.entry)
    else eventsByPosition.set(event.position, [event.entry])
  }

  for (const entry of parsed) {
    const events = eventsByPosition.get(entry.position) || []
    for (const event of events) {
      const reduced = reducePublisherOperation(state, event.value, {
        keyProvider,
        sourceWriterKey: event.sourceWriterKey
      })
      if (!reduced.accepted && reduced.code !== 'DUPLICATE') {
        rejected.push(contextualRejection(event, reduced.code, reduced.error || ''))
        continue
      }
      accepted.push({ ...reduced, frame: frameForResult(event), sourceWriterKey: event.sourceWriterKey })
    }

    if (entry === genesis) continue
    if (entry.value.recordType === PUBLISHER_RECORD_TYPES.NAMESPACE) {
      rejected.push(contextualRejection(entry, 'CONFLICTING_NAMESPACE', 'catalog has one canonical genesis descriptor'))
      continue
    }
    if (isRootPolicyOperation(entry.value)) continue

    const writer = entry.value.signerKey
      ? state.signers.get(b4a.toString(entry.value.signerKey, 'hex'))
      : null
    let injectedRevocation = false
    if (writer && !writer.revocation) {
      const anticipated = anticipatedRevocations.get(writerGenerationKey(writer))
      if (anticipated) {
        writer.revocation = { ...anticipated }
        injectedRevocation = true
      }
    }
    const reduced = reducePublisherOperation(state, entry.value, {
      keyProvider,
      sourceWriterKey: entry.sourceWriterKey
    })
    if (injectedRevocation) writer.revocation = null

    if (!reduced.accepted && reduced.code !== 'DUPLICATE') {
      if (writer && reduced.code === 'REVOKED_WRITER') {
        writer.lastAcceptedSequence = Math.max(writer.lastAcceptedSequence, entry.value.issuerSequence)
      }
      rejected.push(contextualRejection(entry, reduced.code, reduced.error || ''))
      if (writer?.revocation && reduced.code === 'REVOKED_WRITER') {
        drainedWriterIds.add(b4a.toString(writer.writerKey, 'hex'))
      } else if (injectedRevocation && reduced.code === 'REVOKED_WRITER') {
        drainedWriterIds.add(b4a.toString(writer.writerKey, 'hex'))
      }
      continue
    }
    accepted.push({ ...reduced, frame: frameForResult(entry), sourceWriterKey: entry.sourceWriterKey })
    if (reduced.accepted && reduced.effect?.type === 'projection') await applyProjection(projections, rejected, reduced, entry)
  }
  const acceptedOperationIds = new Set(accepted.map(entry => idHex(entry.value)))
  const canonicalRejected = rejected.filter(entry => !acceptedOperationIds.has(idHex(entry.value)) || entry.code === 'CONFLICT_LOST')
  const desiredRoster = new Map()
  const knownWriterIds = new Set()
  for (const writer of state.writers.values()) {
    const writerId = b4a.toString(writer.writerKey, 'hex')
    const generation = writerGenerationKey(writer)
    const checkpointed = drainedCheckpoints.get(writerId) === generation
    const cutoffReached = writer.revocation &&
      writer.lastAcceptedSequence >= writer.revocation.acceptedThroughSequence
    const hardDrained = writer.revocation &&
      (writer.revocation.acceptedThroughSequence < writer.firstAcceptedSequence || drainedWriterIds.has(writerId))
    const checkpointCutoff = cutoffReached && !hardDrained && !checkpointed
    const drained = hardDrained || checkpointed
    knownWriterIds.add(writerId)
    if (checkpointCutoff) {
      desiredRoster.set(writerId, writer.writerKey)
      await view.put(`${PREFIX.DRAINED}${writerId}`, b4a.from(generation))
    } else if (!writer.revocation || !drained) {
      desiredRoster.set(writerId, writer.writerKey)
      if (drainedCheckpoints.has(writerId)) await view.del(`${PREFIX.DRAINED}${writerId}`)
    } else if (!checkpointed) {
      await view.put(`${PREFIX.DRAINED}${writerId}`, b4a.from(generation))
    }
  }
  for (const writerId of drainedCheckpoints.keys()) {
    if (!knownWriterIds.has(writerId)) await view.del(`${PREFIX.DRAINED}${writerId}`)
  }
  const persistedRoster = new Map(desiredRoster)
  for (const [writerId, writerKey] of desiredRoster) {
    if (!oldRoster.has(writerId)) await host.addWriter(writerKey, { indexer: true })
  }
  for (const writerId of oldRoster) {
    if (desiredRoster.has(writerId)) continue
    const writerKey = b4a.from(writerId, 'hex')
    if (host.removeable(writerKey)) await host.removeWriter(writerKey)
    else persistedRoster.set(writerId, writerKey)
  }

  await view.put(STATE_DESCRIPTOR_KEY, encodePublisherNamespaceDescriptor(state.descriptor))
  await view.put(STATE_AUTHORIZATION_KEY, encodePublisherAuthorizationState(state))
  for (const [writerId, writerKey] of persistedRoster) await view.put(`${PREFIX.ROSTER}${writerId}`, writerKey)
  for (const entry of accepted) await view.put(`${PREFIX.ACCEPTED}${idHex(entry.value)}`, encodeAcceptedEntry(entry))
  for (const entry of canonicalRejected) await view.put(`${PREFIX.REJECTED}${idHex(entry.value)}`, rejectionValue(entry.value, entry.code, entry.error))
  for (const [key, entry] of projections) await view.put(key, entry.frame)
  return { descriptor: state.descriptor, state, accepted, rejected: canonicalRejected, projections }
}

async function recordJournalOverflow (view, sourceWriterKey, value, reason) {
  const sourceWriterKeyHex = b4a.toString(sourceWriterKey, 'hex')
  const key = `${PREFIX.OVERFLOW}${sourceWriterKeyHex}`
  let droppedCount = 0
  const previous = await view.get(key)
  if (previous) {
    try {
      const decoded = JSON.parse(b4a.toString(previous.value))
      if (Number.isSafeInteger(decoded.droppedCount) && decoded.droppedCount >= 0) droppedCount = decoded.droppedCount
    } catch {
      // Replace a corrupt aggregate with a valid bounded diagnostic.
    }
  }
  droppedCount = Math.min(Number.MAX_SAFE_INTEGER, droppedCount + 1)
  await view.put(key, b4a.from(JSON.stringify({
    code: 'JOURNAL_OVERFLOW',
    sourceWriterKey: sourceWriterKeyHex,
    droppedCount,
    lastOperationId: idHex(value),
    recordType: value.recordType,
    reason
  })))
}

function journalUsage (journal, rebuilt = null) {
  const acceptedOperationIds = new Set(rebuilt ? rebuilt.accepted.map(entry => idHex(entry.value)) : [])
  const acceptedAuthorityIds = new Set(rebuilt
    ? rebuilt.accepted.filter(entry => isAuthorityOperation(entry.value)).map(entry => idHex(entry.value))
    : [])
  const usage = {
    total: journal.length,
    authority: 0,
    speculativeAuthority: 0,
    data: 0,
    operationIds: new Set(),
    acceptedOperationIds,
    entryFingerprints: new Set()
  }
  for (const item of journal) {
    try {
      const decoded = decodeJournalValue(item.value)
      const value = decodePublisherCatalogFrame(decoded.frame)
      usage.operationIds.add(idHex(value))
      usage.entryFingerprints.add(journalEntryFingerprint(item.value))
      if (isAuthorityOperation(value)) {
        usage.authority++
        if (rebuilt && !acceptedAuthorityIds.has(idHex(value))) usage.speculativeAuthority++
      } else {
        usage.data++
      }
    } catch {
      usage.data++
    }
  }
  return usage
}

async function readJournalUsage (view, rebuilt = null) {
  return journalUsage(await collectPrefix(view, PREFIX.JOURNAL), rebuilt)
}

function authorityReserve (journalLimit) {
  if (journalLimit === 1) return 1
  return Math.min(journalLimit - 1, Math.max(4, Math.ceil(journalLimit / 16)))
}

function speculativeAuthorityLimit (journalLimit) {
  return Math.max(1, Math.floor(authorityReserve(journalLimit) / 4))
}

function authorityCandidateAccepted (rebuilt, value, sourceWriterKey, keyProvider, host, publisherId) {
  const operationId = idHex(value)
  if (rebuilt.accepted.some(entry => idHex(entry.value) === operationId)) return true
  if (value.recordType === PUBLISHER_RECORD_TYPES.NAMESPACE) {
    if (rebuilt.descriptor !== null) return false
    try {
      verifyGenesis(value, host.key, publisherId, keyProvider)
      return true
    } catch {
      return false
    }
  }
  if (!rebuilt.state) return false
  const trial = reducePublisherOperation(clonePublisherAuthorizationState(rebuilt.state), value, {
    keyProvider,
    sourceWriterKey
  })
  return trial.accepted || trial.code === 'DUPLICATE'
}

function contextIndependentRejection (entry, keyProvider) {
  if (isBytes(entry.value?.signature) && isBytes(entry.value?.signerKey)) {
    try {
      if (keyProvider.verifySignature(
        entry.value.signature,
        signedRecordSignaturePreimage(entry.value),
        entry.value.signerKey
      ) !== true) return true
    } catch {
      // A verifier failure is not proof that an otherwise contextual frame is terminal.
    }
  }
  return CONTEXT_INDEPENDENT_REJECTION_CODES.has(entry.code)
}

async function compactRejectedJournal (view, rebuilt, journalLimit, keyProvider) {
  const journal = await collectPrefix(view, PREFIX.JOURNAL)
  const acceptedIds = new Set(rebuilt.accepted.map(entry => idHex(entry.value)))
  const acceptedFingerprints = new Map(rebuilt.accepted
    .filter(entry => entry.code !== 'DUPLICATE')
    .map(entry => [
      idHex(entry.value),
      journalEntryFingerprint(encodeJournalValue(entry.sourceWriterKey, entry.frame))
    ]))
  const terminalRejectedFingerprints = new Set(
    rebuilt.rejected
      .filter(entry => entry.sourceWriterKey && entry.frame && contextIndependentRejection(entry, keyProvider))
      .map(entry => journalEntryFingerprint(encodeJournalValue(entry.sourceWriterKey, entry.frame)))
  )
  const target = Math.floor(journalLimit * 3 / 4)
  const dropBudget = Math.max(1, journal.length - target)
  const retained = []
  const dropped = []
  const retainedAcceptedIds = new Set()
  for (const item of journal) {
    let decoded
    let value
    try {
      decoded = decodeJournalValue(item.value)
      value = decodePublisherCatalogFrame(decoded.frame)
    } catch {
      retained.push(item)
      continue
    }
    const operationId = idHex(value)
    const fingerprint = journalEntryFingerprint(item.value)
    const acceptedFingerprint = acceptedFingerprints.get(operationId)
    const supersededAcceptedContext = acceptedFingerprint !== undefined && acceptedFingerprint !== fingerprint
    const duplicateAcceptedReplay = acceptedFingerprint === fingerprint && retainedAcceptedIds.has(operationId)
    const terminalRejection = terminalRejectedFingerprints.has(fingerprint) && !acceptedIds.has(operationId)
    if (dropped.length < dropBudget && (terminalRejection || supersededAcceptedContext || duplicateAcceptedReplay)) {
      dropped.push({
        ...decoded,
        value,
        reason: terminalRejection
          ? 'terminal rejected frame evicted at bounded journal checkpoint'
          : 'noncanonical accepted-record context evicted at bounded journal checkpoint'
      })
    } else {
      retained.push(item)
      if (acceptedFingerprint === fingerprint) retainedAcceptedIds.add(operationId)
    }
  }
  if (dropped.length === 0) return journalUsage(journal, rebuilt)
  for (const item of journal) await view.del(item.key)
  for (let index = 0; index < retained.length; index++) await view.put(journalKey(index), retained[index].value)
  await view.put(JOURNAL_COUNT_KEY, b4a.from(String(retained.length)))
  for (const entry of dropped) {
    await recordJournalOverflow(view, entry.sourceWriterKey, entry.value, entry.reason)
  }
  return journalUsage(retained, rebuilt)
}

export async function applyPublisherCatalogNodes (nodes, view, host, options = {}) {
  if (!Array.isArray(nodes)) invalid('Autobase apply batch must be an array')
  const journalLimit = options.journalLimit ?? PUBLISHER_LIMITS.maxJournalOperations
  if (!Number.isSafeInteger(journalLimit) || journalLimit < 1 || journalLimit > PUBLISHER_LIMITS.maxJournalOperations) invalid('journal limit is out of bounds')
  const dataLimit = journalLimit - authorityReserve(journalLimit)
  const speculativeLimit = speculativeAuthorityLimit(journalLimit)
  const keyProvider = options.keyProvider || createPublisherKeyProvider()
  if (typeof keyProvider.verifySignature !== 'function') invalid('key provider must expose raw signature verification')
  const count = parseCount(await view.get(JOURNAL_COUNT_KEY))
  let usage = await readJournalUsage(view)
  if (count !== usage.total) invalid('journal count does not match retained entries')
  for (const node of nodes) {
    const frame = node?.value
    let value
    let writerKey
    try {
      value = decodePublisherCatalogFrame(frame)
      writerKey = sourceKey(node)
    } catch {
      // Reject malformed/noncanonical input before any catalog-view mutation.
      continue
    }
    const operationId = idHex(value)
    const journalValue = encodeJournalValue(writerKey, frame)
    const entryFingerprint = journalEntryFingerprint(journalValue)
    if (usage.entryFingerprints.has(entryFingerprint)) continue
    let rebuilt = null
    if (usage.operationIds.has(operationId)) {
      rebuilt = await rebuildPublisherCatalogView(view, host, options)
      usage = await readJournalUsage(view, rebuilt)
      if (usage.acceptedOperationIds.has(operationId)) continue
    }
    const authority = isAuthorityOperation(value)
    let trustedAuthority = false
    if (authority) {
      rebuilt ||= await rebuildPublisherCatalogView(view, host, options)
      usage = await readJournalUsage(view, rebuilt)
      trustedAuthority = authorityCandidateAccepted(rebuilt, value, writerKey, keyProvider, host, options.publisherId)
    }
    const atCapacity = () => usage.total >= journalLimit ||
      (!authority && usage.data >= dataLimit) ||
      (authority && !trustedAuthority && usage.speculativeAuthority >= speculativeLimit)
    if (atCapacity()) {
      rebuilt ||= await rebuildPublisherCatalogView(view, host, options)
      usage = await compactRejectedJournal(view, rebuilt, journalLimit, keyProvider)
    }
    if (atCapacity()) {
      await recordJournalOverflow(
        view,
        writerKey,
        value,
        authority
          ? trustedAuthority
              ? 'accepted journal checkpoint exhausted its authority reserve'
              : 'speculative authority reached its bounded journal quota'
          : 'source data reached the bounded journal quota reserved below authority'
      )
      continue
    }
    await view.put(journalKey(usage.total), journalValue)
    usage.operationIds.add(operationId)
    usage.entryFingerprints.add(entryFingerprint)
    usage.total++
    if (authority) {
      usage.authority++
      if (!trustedAuthority) usage.speculativeAuthority++
    } else {
      usage.data++
    }
  }
  await view.put(JOURNAL_COUNT_KEY, b4a.from(String(usage.total)))
  let rebuilt = await rebuildPublisherCatalogView(view, host, options)
  if (usage.total >= journalLimit) {
    const compacted = await compactRejectedJournal(view, rebuilt, journalLimit)
    if (compacted.total < usage.total) {
      usage = compacted
      rebuilt = await rebuildPublisherCatalogView(view, host, options)
    }
  }
  return rebuilt
}

function encodeSnapshotEntry (entry) {
  const key = b4a.from(entry.key)
  const value = entry.value
  const output = b4a.allocUnsafe(8 + key.byteLength + value.byteLength)
  output[0] = key.byteLength >>> 24; output[1] = key.byteLength >>> 16; output[2] = key.byteLength >>> 8; output[3] = key.byteLength
  output[4] = value.byteLength >>> 24; output[5] = value.byteLength >>> 16; output[6] = value.byteLength >>> 8; output[7] = value.byteLength
  output.set(key, 8)
  output.set(value, 8 + key.byteLength)
  return output
}

export async function getPublisherViewSnapshot (view) {
  const chunks = []
  let length = 0
  for await (const entry of view.createReadStream()) {
    const chunk = encodeSnapshotEntry(entry)
    length += chunk.byteLength
    if (length > PUBLISHER_LIMITS.maxSnapshotBytes) invalid('view snapshot exceeds its byte bound')
    chunks.push(chunk)
  }
  return b4a.concat(chunks, length)
}

export async function getPublisherViewHead (view, { hash = crypto.hash } = {}) {
  await view.ready()
  const snapshot = await getPublisherViewSnapshot(view)
  const authorization = await view.get(STATE_AUTHORIZATION_KEY)
  return {
    viewKey: b4a.from(view.key),
    length: view.core.length,
    digest: hash(snapshot),
    authorizationStateDigest: hash(authorization?.value || b4a.alloc(0))
  }
}

export async function listPublisherAcceptedPage (view, { cursor = null, limit = 64 } = {}) {
  if (cursor !== null && (typeof cursor !== 'string' || !/^[0-9a-f]{64}$/.test(cursor))) invalid('accepted page cursor is invalid')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) invalid('accepted page limit is invalid')
  const entries = []
  for await (const entry of view.createReadStream({
    gte: cursor === null ? PREFIX.ACCEPTED : `${PREFIX.ACCEPTED}${cursor}\u0000`,
    lt: `${PREFIX.ACCEPTED}\xff`, limit: limit + 1,
  })) {
    const decoded = decodeAcceptedEntry(entry.value)
    if (!decoded) continue
    const operationId = idHex(decoded.value)
    if (entry.key !== `${PREFIX.ACCEPTED}${operationId}`) continue
    entries.push({ operationId, sourceWriterKey: b4a.from(decoded.sourceWriterKey), frame: b4a.from(decoded.frame) })
    if (entries.length > limit) break
  }
  const page = entries.slice(0, limit)
  return { entries: page, nextCursor: entries.length > limit ? page.at(-1).operationId : null }
}

export async function getPublisherProjection (view, kind, identifier) {
  if (typeof kind !== 'string' || !/^[a-z-]+$/.test(kind)) invalid('projection kind is invalid')
  assertBytes(identifier, 32, 'projection identifier')
  const entry = await view.get(`${PREFIX.PROJECTION}${kind}/${b4a.toString(identifier, 'hex')}`)
  if (!entry) return null
  const value = decodePublisherCatalogFrame(entry.value)
  const body = value.recordType === PUBLISHER_RECORD_TYPES.NAMESPACE
    ? decodePublisherNamespaceDescriptor(value.canonicalBody)
    : decodePublisherOperationBody(value.recordType, value.canonicalBody)
  return { ...value, body }
}

export async function getPublisherAuthorizationState (view) {
  if (!view) return null
  const entry = typeof view.get === 'function' ? await view.get(STATE_AUTHORIZATION_KEY).catch(() => null) : null
  if (!entry) return null
  const metadata = decodeAuthorizationMetadata(entry.value)
  if (!Number.isSafeInteger(metadata.policySequence) || metadata.policySequence < 0 ||
      !Array.isArray(metadata.writers) || metadata.writers.length > PUBLISHER_LIMITS.maxJournalOperations) {
    invalid('authorization state is corrupt')
  }
  const writers = metadata.writers.map(writer => {
    if (!writer || typeof writer.key !== 'string' || !/^[0-9a-f]{64}$/.test(writer.key) ||
        typeof writer.signerKey !== 'string' || !/^[0-9a-f]{64}$/.test(writer.signerKey) ||
        !Array.isArray(writer.capabilities) ||
        !Number.isSafeInteger(writer.firstAcceptedSequence) || writer.firstAcceptedSequence < 0 ||
        !Number.isSafeInteger(writer.lastAcceptedSequence) ||
        !Number.isSafeInteger(writer.expiresAt) || writer.expiresAt < 0 ||
        !Number.isSafeInteger(writer.admissionPolicyEpoch) || writer.admissionPolicyEpoch < 0) {
      invalid('authorization state is corrupt')
    }
    return {
      ...writer,
      capabilities: [...writer.capabilities],
      revocation: writer.revocation ? { ...writer.revocation } : null
    }
  })
  return { policyEpoch: metadata.policyEpoch, policySequence: metadata.policySequence, writers }
}

export async function listPublisherProjections (view, kind, { cursor = null, limit = 128 } = {}) {
  if (typeof kind !== 'string' || !/^[a-z-]+$/.test(kind)) invalid('projection kind is invalid')
  if (cursor !== null && (typeof cursor !== 'string' || !/^[0-9a-f]{64}$/.test(cursor))) invalid('projection cursor is invalid')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PUBLISHER_LIMITS.maxApplyBatch) invalid('projection page limit is invalid')
  const prefix = `${PREFIX.PROJECTION}${kind}/`
  const entries = []
  for await (const entry of view.createReadStream({
    gte: cursor === null ? prefix : `${prefix}${cursor}\u0000`,
    lt: `${prefix}\xff`,
    limit: limit + 1
  })) {
    entries.push(entry)
  }
  const hasMore = entries.length > limit
  const page = entries.slice(0, limit)
  const items = page.map(entry => {
    const value = decodePublisherCatalogFrame(entry.value)
    return { ...value, body: decodePublisherOperationBody(value.recordType, value.canonicalBody) }
  })
  return {
    items,
    nextCursor: hasMore ? page.at(-1).key.slice(prefix.length) : null
  }
}

export async function getPublisherOperationReceipt (view, operationId) {
  assertBytes(operationId, 32, 'operationId')
  const operationIdHex = b4a.toString(operationId, 'hex')
  const rejected = await view.get(`${PREFIX.REJECTED}${operationIdHex}`)
  if (rejected) {
    const diagnostic = JSON.parse(b4a.toString(rejected.value))
    return { accepted: false, rejectionCode: diagnostic.code }
  }
  if (await view.get(`${PREFIX.ACCEPTED}${operationIdHex}`)) return { accepted: true }
  for await (const entry of view.createReadStream({ gte: PREFIX.OVERFLOW, lt: PREFIX.OVERFLOW + '\xff' })) {
    const diagnostic = JSON.parse(b4a.toString(entry.value))
    if (diagnostic.lastOperationId === operationIdHex) {
      return { accepted: false, rejectionCode: 'JOURNAL_OVERFLOW' }
    }
  }
  return { accepted: false }
}

export async function getPublisherRootOperationAuthorization (view, { recordType, body } = {}) {
  if (recordType !== PUBLISHER_RECORD_TYPES.WRITER_ADMISSION &&
      recordType !== PUBLISHER_RECORD_TYPES.WRITER_REVOCATION) {
    invalid('root operation type is unsupported')
  }
  const [descriptorEntry, authorizationEntry] = await Promise.all([
    view.get(STATE_DESCRIPTOR_KEY),
    view.get(STATE_AUTHORIZATION_KEY)
  ])
  if (!descriptorEntry || !authorizationEntry) invalid('publisher namespace genesis is not initialized')
  const descriptor = decodePublisherNamespaceDescriptor(descriptorEntry.value, { legacyCompatibility: PUBLISHER_CATALOG_LEGACY_COMPATIBILITY })
  const authorization = decodeAuthorizationMetadata(authorizationEntry.value)
  if (recordType === PUBLISHER_RECORD_TYPES.WRITER_REVOCATION &&
      body?.newPolicyEpoch !== authorization.policyEpoch + 1) {
    invalid('writer revocation policy epoch is stale')
  }
  return {
    publisherId: b4a.from(descriptor.publisherId),
    activeRootKey: b4a.from(descriptor.publisherRootKey),
    policyEpoch: authorization.policyEpoch,
    expectedSequence: descriptor.policySequence + 1,
    catalogEpoch: descriptor.catalogEpoch,
    signerPolicy: {
      requiredSignerKeys: [b4a.from(descriptor.publisherRootKey)],
      quorumSignerKeys: [],
      quorum: 0
    }
  }
}

export async function getPublisherRootTransitionAuthorization (view, { mode, newRootKey } = {}) {
  if (mode !== 'rotation' && mode !== 'recovery') invalid('root transition mode must be rotation or recovery')
  assertBytes(newRootKey, 32, 'newRootKey')
  const [descriptorEntry, authorizationEntry] = await Promise.all([
    view.get(STATE_DESCRIPTOR_KEY),
    view.get(STATE_AUTHORIZATION_KEY)
  ])
  if (!descriptorEntry || !authorizationEntry) invalid('publisher namespace genesis is not initialized')
  const descriptor = decodePublisherNamespaceDescriptor(descriptorEntry.value, { legacyCompatibility: PUBLISHER_CATALOG_LEGACY_COMPATIBILITY })
  const authorization = decodeAuthorizationMetadata(authorizationEntry.value)
  if (mode === 'recovery' && (descriptor.recoveryThreshold === 0 || descriptor.recoveryKeys.length === 0)) {
    invalid('publisher recovery is disabled by the committed policy')
  }
  const requiredSignerKeys = mode === 'rotation'
    ? [descriptor.publisherRootKey, newRootKey]
    : [newRootKey]
  const quorumSignerKeys = mode === 'recovery' ? descriptor.recoveryKeys : []
  return {
    publisherId: b4a.from(descriptor.publisherId),
    activeRootKey: b4a.from(descriptor.publisherRootKey),
    policyEpoch: authorization.policyEpoch,
    expectedSequence: descriptor.policySequence + 1,
    catalogEpoch: descriptor.catalogEpoch,
    signerPolicy: {
      requiredSignerKeys: requiredSignerKeys.map(key => b4a.from(key)).sort(b4a.compare),
      quorumSignerKeys: quorumSignerKeys.map(key => b4a.from(key)).sort(b4a.compare),
      quorum: mode === 'recovery' ? descriptor.recoveryThreshold : 0
    }
  }
}

export async function listPublisherRejections (view) {
  const output = []
  for (const prefix of [PREFIX.REJECTED, PREFIX.OVERFLOW]) {
    for await (const entry of view.createReadStream({ gte: prefix, lt: prefix + '\xff' })) output.push(JSON.parse(b4a.toString(entry.value)))
  }
  return output
}

export async function getLatestPublisherAnnouncement (view) {
  const entry = await view.get(LATEST_HEAD_KEY)
  if (!entry) return null
  const value = decodePublisherCatalogFrame(entry.value)
  return { ...value, body: decodePublisherOperationBody(value.recordType, value.canonicalBody) }
}
