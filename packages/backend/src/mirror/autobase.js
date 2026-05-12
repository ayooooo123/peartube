import crypto from 'node:crypto'
import {
  EventType,
  DescriptorState,
  WorkerPhase,
  PeartubeLogEntry,
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
  return fallback
}

export function createPeartubeRelayState(now = BigInt(Date.now())) {
  return {
    workerPhase: WorkerPhase.IDLE,
    currentJobId: cloneBytes(ZERO_32),
    identityWeight: 0,
    activeIndex: new Map(),
    proofs: new Map(),
    quarantined: new Map(),
    tombstoned: new Map(),
    now,
  }
}

function upsertDescriptor(state, descriptor, observedAt, eventId, stateAfter = DescriptorState.ACTIVE) {
  const id = keyHex(descriptor.descriptorId)
  const current = state.activeIndex.get(id) || {
    descriptor,
    state: DescriptorState.DISCOVERED,
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
    lastProofAt: 0n,
    failureCount: 0,
    quarantineUntil: 0n,
    tombstonedAt: 0n,
    lastProofId: cloneBytes(ZERO_32),
    lastEventId: cloneBytes(ZERO_32),
  }

  current.descriptor = descriptor
  current.state = stateAfter
  current.lastSeenAt = observedAt
  current.lastEventId = cloneBytes(eventId)
  state.activeIndex.set(id, current)
  return current
}

function markQuarantined(state, payload, eventId) {
  const id = keyHex(payload.descriptorId)
  state.quarantined.set(id, payload)
  const current = state.activeIndex.get(id)
  if (current) {
    current.state = DescriptorState.QUARANTINED
    current.failureCount = Math.max(current.failureCount, payload.failureCount)
    current.quarantineUntil = payload.quarantineUntil
    current.lastEventId = cloneBytes(eventId)
  }
}

function markTombstoned(state, payload, eventId) {
  const id = keyHex(payload.descriptorId)
  state.tombstoned.set(id, payload)
  const current = state.activeIndex.get(id)
  if (current) {
    current.state = DescriptorState.TOMBSTONED
    current.tombstonedAt = payload.tombstonedAt
    current.lastProofId = cloneBytes(payload.lastProofId)
    current.lastEventId = cloneBytes(eventId)
  }
}

export function applyPeartubeEvent(state, entryBuffer) {
  const entry = decodeLogEntry(entryBuffer)
  state.now = ensureBigInt(entry.observedAt, state.now)

  switch (entry.entryType) {
    case EventType.DESCRIPTOR_ADDED: {
      const payload = decodeDescriptorAddedPayload(entry.payload)
      const descriptor = payload.descriptor
      const nextState = payload.initialState === DescriptorState.DISCOVERED ? DescriptorState.DISCOVERED : DescriptorState.VERIFIED
      upsertDescriptor(state, descriptor, ensureBigInt(payload.localSeenAt, state.now), entry.entryId, nextState)
      state.workerPhase = WorkerPhase.SEEDING
      return { state, entry, kind: 'descriptor-added', payload }
    }
    case EventType.PROOF_ADDED: {
      const payload = decodeProofAddedPayload(entry.payload)
      const proofId = keyHex(payload.proof.proofId)
      state.proofs.set(proofId, {
        proof: payload.proof,
        confidence: payload.confidence,
        stateAfterProof: payload.stateAfterProof,
        seenAt: ensureBigInt(payload.localSeenAt, state.now),
      })
      const current = state.activeIndex.get(keyHex(payload.proof.descriptorId))
      if (current) {
        current.state = payload.stateAfterProof === DescriptorState.QUARANTINED ? DescriptorState.QUARANTINED : DescriptorState.ACTIVE
        current.lastProofAt = ensureBigInt(payload.localSeenAt, state.now)
        current.lastProofId = cloneBytes(payload.proof.proofId)
        current.failureCount = payload.failureCountReset ? 0 : current.failureCount
        current.lastEventId = cloneBytes(entry.entryId)
      }
      state.identityWeight = Math.min(1000, state.identityWeight + Math.max(1, Number(payload.confidence || 0)))
      state.workerPhase = WorkerPhase.PROOF_EMISSION
      return { state, entry, kind: 'proof-added', payload }
    }
    case EventType.QUARANTINED: {
      const payload = decodeQuarantinedPayload(entry.payload)
      markQuarantined(state, payload, entry.entryId)
      state.identityWeight = Math.max(0, state.identityWeight - 10)
      state.workerPhase = WorkerPhase.EXPIRY
      return { state, entry, kind: 'quarantined', payload }
    }
    case EventType.TOMBSTONED: {
      const payload = decodeTombstonedPayload(entry.payload)
      markTombstoned(state, payload, entry.entryId)
      state.identityWeight = Math.max(0, state.identityWeight - 25)
      state.workerPhase = WorkerPhase.EXPIRY
      return { state, entry, kind: 'tombstoned', payload }
    }
    default:
      return { state, entry, kind: 'unknown', payload: null }
  }
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
