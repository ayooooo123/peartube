import crypto from 'node:crypto'
import {
  EventType,
  DescriptorState,
  WorkerPhase,
  DescriptorAddedPayload,
  ProofAddedPayload,
  QuarantinedPayload,
  TombstonedPayload,
  encodeLogEntry,
  decodeLogEntry,
  decodeDescriptorAddedPayload,
  decodeProofAddedPayload,
  decodeQuarantinedPayload,
  decodeTombstonedPayload,
  toFixed32,
  toFixed64,
} from './schemas.js'

const textEncoder = new TextEncoder()
const ZERO_32 = new Uint8Array(32)
const ZERO_64 = new Uint8Array(64)

function keyHex(bytes) {
  return Buffer.from(bytes || ZERO_32).toString('hex')
}

function cloneBytes(bytes) {
  return new Uint8Array(bytes || ZERO_32)
}

function stableSerialize(value) {
  if (value === null || value === undefined) return String(value)
  if (value instanceof Uint8Array) return keyHex(value)
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableSerialize(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function descriptorFingerprint(descriptor) {
  if (!descriptor) return ''
  return stableSerialize({
    descriptorId: keyHex(descriptor.descriptorId),
    contentRoot: keyHex(descriptor.contentRoot),
    dasRoot: keyHex(descriptor.dasRoot),
    swarmTopic: keyHex(descriptor.swarmTopic),
    sourceRefHash: keyHex(descriptor.sourceRefHash),
    availabilityEpoch: Number(descriptor.availabilityEpoch || 0),
    expiresAt: String(descriptor.expiresAt ?? 0n),
    flags: Number(descriptor.flags || 0),
    signer: keyHex(descriptor.signer),
    signature: keyHex(descriptor.signature),
  })
}

async function sha256Bytes(input) {
  const data = input instanceof Uint8Array ? input : textEncoder.encode(String(input ?? ''))
  if (globalThis.crypto?.subtle?.digest) {
    return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data))
  }
  return new Uint8Array(crypto.createHash('sha256').update(Buffer.from(data)).digest())
}

function ensureBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.max(0, Math.floor(value)))
  if (typeof value === 'string' && value.trim()) {
    try { return BigInt(value) } catch {}
  }
  return fallback
}

function compareEventOrder(observedAtA, eventIdA, observedAtB, eventIdB) {
  const timeA = ensureBigInt(observedAtA)
  const timeB = ensureBigInt(observedAtB)
  if (timeA > timeB) return 1
  if (timeA < timeB) return -1
  return keyHex(eventIdA).localeCompare(keyHex(eventIdB))
}

function isNewerTransition(current, observedAt, eventId) {
  if (!current) return true
  return compareEventOrder(observedAt, eventId, current.lastTransitionAt ?? current.firstSeenAt ?? 0n, current.lastEventId) >= 0
}

function maxBigInt(...values) {
  return values.reduce((acc, value) => (ensureBigInt(value) > acc ? ensureBigInt(value) : acc), 0n)
}

function createDescriptorRecord(descriptor, observedAt, eventId, stateAfter = DescriptorState.ACTIVE) {
  const now = ensureBigInt(observedAt)
  return {
    descriptor,
    state: stateAfter,
    firstSeenAt: now,
    lastSeenAt: now,
    lastTransitionAt: now,
    lastProofAt: 0n,
    failureCount: 0,
    quarantineUntil: 0n,
    tombstonedAt: 0n,
    lastProofId: cloneBytes(ZERO_32),
    lastEventId: cloneBytes(eventId),
    lastDescriptorHash: descriptorFingerprint(descriptor),
    duplicateProofCount: 0,
    conflictCount: 0,
    outOfOrderCount: 0,
  }
}

function getOrCreateRecord(state, descriptor, observedAt, eventId, stateAfter) {
  const id = keyHex(descriptor.descriptorId)
  const current = state.activeIndex.get(id)
  if (!current) {
    const record = createDescriptorRecord(descriptor, observedAt, eventId, stateAfter)
    state.activeIndex.set(id, record)
    return record
  }
  return current
}

function syncTerminalMaps(state, id, current) {
  if (current.state === DescriptorState.TOMBSTONED) {
    state.tombstoned.set(id, {
      descriptorId: cloneBytes(current.descriptor.descriptorId),
      tombstonedAt: current.tombstonedAt,
      lastProofId: cloneBytes(current.lastProofId),
      reasonCode: 0,
    })
    state.quarantined.delete(id)
    return
  }
  if (current.state === DescriptorState.QUARANTINED) {
    state.quarantined.set(id, {
      descriptorId: cloneBytes(current.descriptor.descriptorId),
      quarantineUntil: current.quarantineUntil,
      failureCount: current.failureCount,
      reasonCode: 0,
    })
    state.tombstoned.delete(id)
    return
  }
  state.quarantined.delete(id)
  state.tombstoned.delete(id)
}

function updateDescriptorRecord(state, descriptor, observedAt, eventId, nextState) {
  const id = keyHex(descriptor.descriptorId)
  const current = getOrCreateRecord(state, descriptor, observedAt, eventId, nextState)
  const newer = isNewerTransition(current, observedAt, eventId)
  const nextFingerprint = descriptorFingerprint(descriptor)

  current.lastSeenAt = maxBigInt(current.lastSeenAt, observedAt)
  if (current.lastDescriptorHash && current.lastDescriptorHash !== nextFingerprint) {
    current.conflictCount += 1
  }
  if (!newer) {
    current.outOfOrderCount += 1
    state.activeIndex.set(id, current)
    return { record: current, applied: false, newer: false }
  }

  if (current.state !== DescriptorState.TOMBSTONED) {
    current.descriptor = descriptor
    current.lastDescriptorHash = nextFingerprint
    current.lastEventId = cloneBytes(eventId)
    current.lastTransitionAt = ensureBigInt(observedAt)
    if (nextState === DescriptorState.TOMBSTONED) {
      current.state = DescriptorState.TOMBSTONED
      current.tombstonedAt = ensureBigInt(observedAt)
    } else if (current.state !== DescriptorState.TOMBSTONED) {
      current.state = nextState
    }
  }

  syncTerminalMaps(state, id, current)
  state.activeIndex.set(id, current)
  return { record: current, applied: true, newer: true }
}

function updateProofRecord(state, payload, observedAt, eventId) {
  const descriptorId = keyHex(payload.proof.descriptorId)
  const proofId = keyHex(payload.proof.proofId)
  if (state.proofs.has(proofId)) {
    const existing = state.proofs.get(proofId)
    existing.duplicateCount = (existing.duplicateCount || 0) + 1
    return { record: existing, applied: false, duplicate: true }
  }

  const proofRecord = {
    proof: payload.proof,
    confidence: payload.confidence,
    stateAfterProof: payload.stateAfterProof,
    seenAt: ensureBigInt(payload.localSeenAt, observedAt),
    duplicateCount: 0,
    eventId: cloneBytes(eventId),
  }
  state.proofs.set(proofId, proofRecord)
  state.proofsByDescriptor.set(descriptorId, proofRecord)
  return { record: proofRecord, applied: true, duplicate: false }
}

function applyProofTransition(state, payload, entry, eventId) {
  const descriptorId = keyHex(payload.proof.descriptorId)
  const current = state.activeIndex.get(descriptorId)
  const observedAt = ensureBigInt(payload.localSeenAt, state.now)
  const proofResult = updateProofRecord(state, payload, observedAt, eventId)
  if (proofResult.duplicate) return { state, entry, kind: 'duplicate-proof', payload, applied: false }

  if (!current) {
    return { state, entry, kind: 'proof-added', payload, applied: true }
  }

  const newer = isNewerTransition(current, observedAt, eventId)
  current.lastSeenAt = maxBigInt(current.lastSeenAt, observedAt)
  current.lastProofAt = maxBigInt(current.lastProofAt, observedAt)
  current.lastProofId = cloneBytes(payload.proof.proofId)
  current.failureCount = payload.failureCountReset ? 0 : current.failureCount

  if (!newer) {
    current.outOfOrderCount += 1
    state.activeIndex.set(descriptorId, current)
    return { state, entry, kind: 'proof-added', payload, applied: false, outOfOrder: true }
  }

  if (current.state !== DescriptorState.TOMBSTONED) {
    current.state = payload.stateAfterProof === DescriptorState.QUARANTINED ? DescriptorState.QUARANTINED : DescriptorState.ACTIVE
    current.lastTransitionAt = observedAt
    current.lastEventId = cloneBytes(eventId)
    if (payload.stateAfterProof === DescriptorState.ACTIVE && payload.failureCountReset) {
      current.failureCount = 0
    }
  }

  syncTerminalMaps(state, descriptorId, current)
  state.activeIndex.set(descriptorId, current)
  state.identityWeight = Math.min(1000, state.identityWeight + Math.max(0, Number(payload.confidence || 0)))
  return { state, entry, kind: 'proof-added', payload, applied: true }
}

function applyQuarantineTransition(state, payload, entry, eventId) {
  const descriptorId = keyHex(payload.descriptorId)
  const current = state.activeIndex.get(descriptorId)
  const observedAt = ensureBigInt(payload.lastObservedAt || payload.firstObservedAt, state.now)
  if (!current) {
    const placeholder = createDescriptorRecord({ descriptorId: cloneBytes(payload.descriptorId) }, observedAt, eventId, DescriptorState.QUARANTINED)
    placeholder.quarantineUntil = ensureBigInt(payload.quarantineUntil, observedAt)
    placeholder.failureCount = Number(payload.failureCount || 0)
    placeholder.tombstonedAt = 0n
    state.activeIndex.set(descriptorId, placeholder)
    syncTerminalMaps(state, descriptorId, placeholder)
    state.identityWeight = Math.max(0, state.identityWeight - 10)
    return { state, entry, kind: 'quarantined', payload, applied: true }
  }

  const newer = isNewerTransition(current, observedAt, eventId)
  current.lastSeenAt = maxBigInt(current.lastSeenAt, observedAt)
  if (!newer || current.state === DescriptorState.TOMBSTONED) {
    current.outOfOrderCount += 1
    state.activeIndex.set(descriptorId, current)
    return { state, entry, kind: 'quarantined', payload, applied: false, outOfOrder: true }
  }

  current.state = DescriptorState.QUARANTINED
  current.quarantineUntil = maxBigInt(current.quarantineUntil, payload.quarantineUntil)
  current.failureCount = Math.max(current.failureCount, Number(payload.failureCount || 0))
  current.lastTransitionAt = observedAt
  current.lastEventId = cloneBytes(eventId)
  syncTerminalMaps(state, descriptorId, current)
  state.activeIndex.set(descriptorId, current)
  state.identityWeight = Math.max(0, state.identityWeight - 10)
  return { state, entry, kind: 'quarantined', payload, applied: true }
}

function applyTombstoneTransition(state, payload, entry, eventId) {
  const descriptorId = keyHex(payload.descriptorId)
  const current = state.activeIndex.get(descriptorId)
  const observedAt = ensureBigInt(payload.tombstonedAt, state.now)
  if (!current) {
    const placeholder = createDescriptorRecord({ descriptorId: cloneBytes(payload.descriptorId) }, observedAt, eventId, DescriptorState.TOMBSTONED)
    placeholder.tombstonedAt = observedAt
    placeholder.lastProofId = cloneBytes(payload.lastProofId)
    state.activeIndex.set(descriptorId, placeholder)
    syncTerminalMaps(state, descriptorId, placeholder)
    state.identityWeight = Math.max(0, state.identityWeight - 25)
    return { state, entry, kind: 'tombstoned', payload, applied: true }
  }

  const newer = isNewerTransition(current, observedAt, eventId)
  current.lastSeenAt = maxBigInt(current.lastSeenAt, observedAt)
  if (!newer) {
    current.outOfOrderCount += 1
    state.activeIndex.set(descriptorId, current)
    return { state, entry, kind: 'tombstoned', payload, applied: false, outOfOrder: true }
  }

  current.state = DescriptorState.TOMBSTONED
  current.tombstonedAt = maxBigInt(current.tombstonedAt, payload.tombstonedAt)
  current.lastProofId = cloneBytes(payload.lastProofId)
  current.lastTransitionAt = observedAt
  current.lastEventId = cloneBytes(eventId)
  syncTerminalMaps(state, descriptorId, current)
  state.activeIndex.set(descriptorId, current)
  state.identityWeight = Math.max(0, state.identityWeight - 25)
  return { state, entry, kind: 'tombstoned', payload, applied: true }
}

export function createPeartubeRelayState(now = BigInt(Date.now())) {
  return {
    workerPhase: WorkerPhase.IDLE,
    currentJobId: cloneBytes(ZERO_32),
    identityWeight: 0,
    activeIndex: new Map(),
    proofs: new Map(),
    proofsByDescriptor: new Map(),
    quarantined: new Map(),
    tombstoned: new Map(),
    eventIndex: new Map(),
    now,
  }
}

export function applyPeartubeEvent(state, entryBuffer) {
  const entry = decodeLogEntry(entryBuffer)
  state.now = ensureBigInt(entry.observedAt, state.now)
  const eventKey = keyHex(entry.entryId)
  const previousEvent = state.eventIndex.get(eventKey)
  if (previousEvent) {
    return { state, entry, kind: 'duplicate-entry', payload: previousEvent.payload || null, applied: false, duplicate: true }
  }

  let result
  switch (entry.entryType) {
    case EventType.DESCRIPTOR_ADDED: {
      const payload = decodeDescriptorAddedPayload(entry.payload)
      const descriptor = payload.descriptor
      const nextState = payload.initialState === DescriptorState.DISCOVERED ? DescriptorState.DISCOVERED : DescriptorState.VERIFIED
      result = updateDescriptorRecord(state, descriptor, ensureBigInt(payload.localSeenAt, state.now), entry.entryId, nextState)
      if (result.applied) {
        state.workerPhase = WorkerPhase.SEEDING
      }
      result = { ...result, state, entry, kind: 'descriptor-added', payload }
      break
    }
    case EventType.PROOF_ADDED: {
      const payload = decodeProofAddedPayload(entry.payload)
      result = applyProofTransition(state, payload, entry, entry.entryId)
      if (result.applied) {
        state.workerPhase = WorkerPhase.PROOF_EMISSION
      }
      result = { ...result, state, entry }
      break
    }
    case EventType.QUARANTINED: {
      const payload = decodeQuarantinedPayload(entry.payload)
      result = applyQuarantineTransition(state, payload, entry, entry.entryId)
      if (result.applied) {
        state.workerPhase = WorkerPhase.EXPIRY
      }
      result = { ...result, state, entry }
      break
    }
    case EventType.TOMBSTONED: {
      const payload = decodeTombstonedPayload(entry.payload)
      result = applyTombstoneTransition(state, payload, entry, entry.entryId)
      if (result.applied) {
        state.workerPhase = WorkerPhase.EXPIRY
      }
      result = { ...result, state, entry }
      break
    }
    default:
      result = { state, entry, kind: 'unknown', payload: null, applied: false }
  }

  state.eventIndex.set(eventKey, result)
  return result
}

export function isFeedHealthy(state) {
  for (const record of state.activeIndex.values()) {
    if (record.state === DescriptorState.ACTIVE || record.state === DescriptorState.VERIFIED) return true
  }
  return false
}

export function shouldForwardDescriptor(state, descriptorId) {
  const current = state.activeIndex.get(keyHex(descriptorId))
  if (!current) return false
  if (current.state === DescriptorState.TOMBSTONED) return false
  if (current.state === DescriptorState.QUARANTINED && state.now < current.quarantineUntil) return false
  return ensureBigInt(current.descriptor.expiresAt, 0n) > state.now
}

function buildEnvelopePayload(entryType, payload) {
  if (entryType === EventType.DESCRIPTOR_ADDED) return DescriptorAddedPayload.encode(payload)
  if (entryType === EventType.PROOF_ADDED) return ProofAddedPayload.encode(payload)
  if (entryType === EventType.QUARANTINED) return QuarantinedPayload.encode(payload)
  if (entryType === EventType.TOMBSTONED) return TombstonedPayload.encode(payload)
  throw new Error(`Unknown Peartube event type: ${entryType}`)
}

async function signEntry(signBytes, entryType, entryId, prevEntryId, actorId, observedAt, payloadBuffer, signer) {
  const unsigned = encodeLogEntry({
    version: 1,
    entryType,
    entryId,
    prevEntryId,
    actorId,
    observedAt,
    payload: payloadBuffer,
    signer,
    signature: ZERO_64,
  })
  const signature = await signBytes(unsigned)
  return signature instanceof Uint8Array ? signature : new Uint8Array(signature)
}

export async function appendPeartubeEvent(autobase, { entryType, payload, actorId = ZERO_32, prevEntryId = ZERO_32, signer = ZERO_32, observedAt = BigInt(Date.now()), signBytes, entryId } = {}) {
  if (!autobase) throw new Error('appendPeartubeEvent requires an autobase instance')
  if (typeof signBytes !== 'function') throw new Error('appendPeartubeEvent requires signBytes(payload)')

  const payloadBuffer = buildEnvelopePayload(entryType, payload)
  const entryBuffer = entryId || await sha256Bytes(Buffer.concat([
    Buffer.from([entryType]),
    Buffer.from(prevEntryId),
    Buffer.from(actorId),
    Buffer.from(payloadBuffer),
    Buffer.from(String(observedAt)),
  ]))
  const signature = await signEntry(signBytes, entryType, entryBuffer, prevEntryId, actorId, observedAt, payloadBuffer, signer)
  const logEntry = {
    version: 1,
    entryType,
    entryId: toFixed32(entryBuffer),
    prevEntryId: toFixed32(prevEntryId),
    actorId: toFixed32(actorId),
    observedAt,
    payload: payloadBuffer,
    signer: toFixed32(signer),
    signature: toFixed64(signature),
  }
  const encoded = encodeLogEntry(logEntry)

  if (typeof autobase.append === 'function') {
    await autobase.append(encoded)
    return { entry: logEntry, encoded }
  }

  if (typeof autobase.write === 'function') {
    await autobase.write(encoded)
    return { entry: logEntry, encoded }
  }

  if (autobase.log && typeof autobase.log.append === 'function') {
    await autobase.log.append(encoded)
    return { entry: logEntry, encoded }
  }

  throw new Error('appendPeartubeEvent: unsupported autobase interface')
}

export async function appendDescriptorAdded(autobase, payload, options = {}) {
  return appendPeartubeEvent(autobase, {
    ...options,
    entryType: EventType.DESCRIPTOR_ADDED,
    payload,
  })
}

export async function appendProofAdded(autobase, payload, options = {}) {
  return appendPeartubeEvent(autobase, {
    ...options,
    entryType: EventType.PROOF_ADDED,
    payload,
  })
}

export async function appendQuarantined(autobase, payload, options = {}) {
  return appendPeartubeEvent(autobase, {
    ...options,
    entryType: EventType.QUARANTINED,
    payload,
  })
}

export async function appendTombstoned(autobase, payload, options = {}) {
  return appendPeartubeEvent(autobase, {
    ...options,
    entryType: EventType.TOMBSTONED,
    payload,
  })
}

export function createPeartubeAutobaseReducer(initialState = createPeartubeRelayState()) {
  const state = initialState

  return {
    state,
    apply(entryBuffer) {
      return applyPeartubeEvent(state, entryBuffer)
    },
    ingest(entryBuffer) {
      return this.apply(entryBuffer)
    },
    snapshot() {
      return state
    },
  }
}

export default {
  createPeartubeRelayState,
  applyPeartubeEvent,
  shouldForwardDescriptor,
  isFeedHealthy,
  appendPeartubeEvent,
  appendDescriptorAdded,
  appendProofAdded,
  appendQuarantined,
  appendTombstoned,
  createPeartubeAutobaseReducer,
}
