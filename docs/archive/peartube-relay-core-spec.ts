import cenc from 'compact-encoding'

export const PEARTUBE_RELAY_CORE_VERSION = 1 as const

export const SourceType = {
  YOUTUBE: 0,
  TIKTOK: 1,
  DIRECT_URL: 2,
  OTHER: 3,
} as const

export const MirrorMode = {
  ARCHIVE: 0,
  SEED: 1,
  SEED_AND_PUBLISH: 2,
} as const

export const DescriptorFlags = {
  PUBLIC: 1 << 0,
  BLIND: 1 << 1,
  MIRRORED: 1 << 2,
  SEEDED: 1 << 3,
  QUARANTINED: 1 << 4,
  TOMBSTONED: 1 << 5,
  EXTERNAL_SOURCE: 1 << 6,
} as const

export const QuarantineReason = {
  BAD_SIGNATURE: 0,
  STALE: 1,
  UNREACHABLE: 2,
  SAMPLE_FAILED: 3,
  SPAM_SUSPECTED: 4,
  DUPLICATE: 5,
  POLICY_VIOLATION: 6,
} as const

export const TombstoneReason = {
  EXPIRED: 0,
  REVOKED: 1,
  UNAVAILABLE: 2,
  REPEATED_FAILURE: 3,
  SPAM_CONFIRMED: 4,
  SUPERSEDED: 5,
} as const

export const WorkerPhase = {
  IDLE: 0,
  DISCOVERY: 1,
  MIRRORING: 2,
  SEEDING: 3,
  PROOF_EMISSION: 4,
  EXPIRY: 5,
} as const

export const DescriptorState = {
  DISCOVERED: 0,
  VERIFIED: 1,
  ACTIVE: 2,
  QUARANTINED: 3,
  TOMBSTONED: 4,
} as const

export const ProofKind = {
  FETCH: 0,
  SAMPLE: 1,
  REHYDRATE: 2,
  SEED: 3,
  RELAY_SERVE: 4,
} as const

export const EventType = {
  DESCRIPTOR_ADDED: 1,
  PROOF_ADDED: 2,
  QUARANTINED: 3,
  TOMBSTONED: 4,
} as const

export type SourceTypeValue = (typeof SourceType)[keyof typeof SourceType]
export type MirrorModeValue = (typeof MirrorMode)[keyof typeof MirrorMode]
export type WorkerPhaseValue = (typeof WorkerPhase)[keyof typeof WorkerPhase]
export type DescriptorStateValue = (typeof DescriptorState)[keyof typeof DescriptorState]
export type ProofKindValue = (typeof ProofKind)[keyof typeof ProofKind]
export type EventTypeValue = (typeof EventType)[keyof typeof EventType]

export const V1VideoDescriptor = cenc.struct([
  ['version', cenc.uint8],
  ['descriptorId', cenc.fixed32],
  ['contentRoot', cenc.fixed32],
  ['dasRoot', cenc.fixed32],
  ['swarmTopic', cenc.fixed32],
  ['sourceRefHash', cenc.fixed32],
  ['sourceType', cenc.uint8],
  ['mirrorOrigin', cenc.uint8],
  ['contentBytes', cenc.uint64],
  ['segmentCount', cenc.uint32],
  ['durationMs', cenc.uint64],
  ['publishAt', cenc.uint64],
  ['expiresAt', cenc.uint64],
  ['availabilityEpoch', cenc.uint32],
  ['publisherIdentity', cenc.fixed32],
  ['parentDescriptorId', cenc.fixed32],
  ['titleHash', cenc.fixed32],
  ['descriptionHash', cenc.fixed32],
  ['languageTag', cenc.string],
  ['codecProfile', cenc.uint8],
  ['flags', cenc.uint16],
  ['signer', cenc.fixed32],
  ['signature', cenc.fixed64],
])

export const V1AvailabilityProof = cenc.struct([
  ['version', cenc.uint8],
  ['proofId', cenc.fixed32],
  ['descriptorId', cenc.fixed32],
  ['contentRoot', cenc.fixed32],
  ['dasRoot', cenc.fixed32],
  ['relayId', cenc.fixed32],
  ['reachable', cenc.bool],
  ['proofKind', cenc.uint8],
  ['sampleCount', cenc.uint16],
  ['sampleWindowMs', cenc.uint32],
  ['observedAt', cenc.uint64],
  ['expiresAt', cenc.uint64],
  ['servedBytes', cenc.uint64],
  ['latencyMs', cenc.uint32],
  ['activePeers', cenc.uint16],
  ['chainHead', cenc.fixed32],
  ['evidence', cenc.buffer],
  ['signer', cenc.fixed32],
  ['signature', cenc.fixed64],
])

export const V1MirrorRequest = cenc.struct([
  ['version', cenc.uint8],
  ['requestId', cenc.fixed32],
  ['requestedBy', cenc.fixed32],
  ['sourceUrl', cenc.string],
  ['sourceType', cenc.uint8],
  ['mirrorMode', cenc.uint8],
  ['priority', cenc.uint8],
  ['maxDownloadBytes', cenc.uint64],
  ['maxDurationMs', cenc.uint32],
  ['allowDescriptorPublish', cenc.bool],
  ['allowPublicSourceUrl', cenc.bool],
  ['retainForMs', cenc.uint64],
  ['targetTopic', cenc.fixed32],
  ['notesHash', cenc.fixed32],
  ['expectedTitleHash', cenc.fixed32],
  ['expectedDescriptionHash', cenc.fixed32],
])

export const PeartubeLogEntry = cenc.struct([
  ['version', cenc.uint8],
  ['entryType', cenc.uint8],
  ['entryId', cenc.fixed32],
  ['prevEntryId', cenc.fixed32],
  ['actorId', cenc.fixed32],
  ['observedAt', cenc.uint64],
  ['payload', cenc.buffer],
  ['signer', cenc.fixed32],
  ['signature', cenc.fixed64],
])

export const DescriptorAddedPayload = cenc.struct([
  ['descriptor', V1VideoDescriptor],
  ['reason', cenc.uint8],
  ['parentEventId', cenc.fixed32],
  ['localSeenAt', cenc.uint64],
  ['initialState', cenc.uint8],
])

export const ProofAddedPayload = cenc.struct([
  ['proof', V1AvailabilityProof],
  ['localSeenAt', cenc.uint64],
  ['confidence', cenc.uint8],
  ['stateAfterProof', cenc.uint8],
  ['failureCountReset', cenc.bool],
])

export const QuarantinedPayload = cenc.struct([
  ['descriptorId', cenc.fixed32],
  ['reasonCode', cenc.uint8],
  ['reasonTextHash', cenc.fixed32],
  ['firstObservedAt', cenc.uint64],
  ['lastObservedAt', cenc.uint64],
  ['failureCount', cenc.uint16],
  ['relatedProofId', cenc.fixed32],
  ['quarantineUntil', cenc.uint64],
])

export const TombstonedPayload = cenc.struct([
  ['descriptorId', cenc.fixed32],
  ['reasonCode', cenc.uint8],
  ['reasonTextHash', cenc.fixed32],
  ['tombstonedAt', cenc.uint64],
  ['retentionExpiredAt', cenc.uint64],
  ['lastProofId', cenc.fixed32],
  ['purgeEligibleAt', cenc.uint64],
])

export interface V1VideoDescriptorValue {
  version: number
  descriptorId: Uint8Array
  contentRoot: Uint8Array
  dasRoot: Uint8Array
  swarmTopic: Uint8Array
  sourceRefHash: Uint8Array
  sourceType: SourceTypeValue
  mirrorOrigin: number
  contentBytes: bigint
  segmentCount: number
  durationMs: bigint
  publishAt: bigint
  expiresAt: bigint
  availabilityEpoch: number
  publisherIdentity: Uint8Array
  parentDescriptorId: Uint8Array
  titleHash: Uint8Array
  descriptionHash: Uint8Array
  languageTag: string
  codecProfile: number
  flags: number
  signer: Uint8Array
  signature: Uint8Array
}

export interface V1AvailabilityProofValue {
  version: number
  proofId: Uint8Array
  descriptorId: Uint8Array
  contentRoot: Uint8Array
  dasRoot: Uint8Array
  relayId: Uint8Array
  reachable: boolean
  proofKind: ProofKindValue
  sampleCount: number
  sampleWindowMs: number
  observedAt: bigint
  expiresAt: bigint
  servedBytes: bigint
  latencyMs: number
  activePeers: number
  chainHead: Uint8Array
  evidence: Uint8Array
  signer: Uint8Array
  signature: Uint8Array
}

export interface V1MirrorRequestValue {
  version: number
  requestId: Uint8Array
  requestedBy: Uint8Array
  sourceUrl: string
  sourceType: SourceTypeValue
  mirrorMode: MirrorModeValue
  priority: number
  maxDownloadBytes: bigint
  maxDurationMs: number
  allowDescriptorPublish: boolean
  allowPublicSourceUrl: boolean
  retainForMs: bigint
  targetTopic: Uint8Array
  notesHash: Uint8Array
  expectedTitleHash: Uint8Array
  expectedDescriptionHash: Uint8Array
}

export interface PeartubeLogEntryValue {
  version: number
  entryType: EventTypeValue
  entryId: Uint8Array
  prevEntryId: Uint8Array
  actorId: Uint8Array
  observedAt: bigint
  payload: Uint8Array
  signer: Uint8Array
  signature: Uint8Array
}

export interface DescriptorRecord {
  descriptor: V1VideoDescriptorValue
  state: DescriptorStateValue
  firstSeenAt: bigint
  lastSeenAt: bigint
  lastProofAt: bigint
  failureCount: number
  quarantineUntil: bigint
  tombstonedAt: bigint
  lastProofId: Uint8Array
  lastEventId: Uint8Array
}

export interface ProofRecord {
  proof: V1AvailabilityProofValue
  confidence: number
  stateAfterProof: DescriptorStateValue
  seenAt: bigint
}

export interface PeartubeRelayCoreState {
  workerPhase: WorkerPhaseValue
  currentJobId: Uint8Array
  identityWeight: number
  activeIndex: Map<string, DescriptorRecord>
  proofs: Map<string, ProofRecord>
  quarantined: Map<string, QuarantinedPayloadValue>
  tombstoned: Map<string, TombstonedPayloadValue>
  pendingMirrorJobs: V1MirrorRequestValue[]
  discoveryQueue: string[]
  now: bigint
}

export interface QuarantinedPayloadValue {
  descriptorId: Uint8Array
  reasonCode: number
  reasonTextHash: Uint8Array
  firstObservedAt: bigint
  lastObservedAt: bigint
  failureCount: number
  relatedProofId: Uint8Array
  quarantineUntil: bigint
}

export interface TombstonedPayloadValue {
  descriptorId: Uint8Array
  reasonCode: number
  reasonTextHash: Uint8Array
  tombstonedAt: bigint
  retentionExpiredAt: bigint
  lastProofId: Uint8Array
  purgeEligibleAt: bigint
}

export type PeartubeEventEnvelope =
  | {
      type: 'descriptor-added'
      entry: PeartubeLogEntryValue
      payload: {
        descriptor: V1VideoDescriptorValue
        reason: number
        parentEventId: Uint8Array
        localSeenAt: bigint
        initialState: DescriptorStateValue
      }
    }
  | {
      type: 'proof-added'
      entry: PeartubeLogEntryValue
      payload: {
        proof: V1AvailabilityProofValue
        localSeenAt: bigint
        confidence: number
        stateAfterProof: DescriptorStateValue
        failureCountReset: boolean
      }
    }
  | {
      type: 'quarantined'
      entry: PeartubeLogEntryValue
      payload: QuarantinedPayloadValue
    }
  | {
      type: 'tombstoned'
      entry: PeartubeLogEntryValue
      payload: TombstonedPayloadValue
    }

export function createPeartubeRelayCoreState(now: bigint = BigInt(Date.now())): PeartubeRelayCoreState {
  return {
    workerPhase: WorkerPhase.IDLE,
    currentJobId: new Uint8Array(32),
    identityWeight: 0,
    activeIndex: new Map(),
    proofs: new Map(),
    quarantined: new Map(),
    tombstoned: new Map(),
    pendingMirrorJobs: [],
    discoveryQueue: [],
    now,
  }
}

export function encodeDescriptor(descriptor: V1VideoDescriptorValue): Uint8Array {
  return cenc.encode(V1VideoDescriptor, descriptor)
}

export function decodeDescriptor(buffer: Uint8Array): V1VideoDescriptorValue {
  return cenc.decode(V1VideoDescriptor, buffer) as V1VideoDescriptorValue
}

export function encodeProof(proof: V1AvailabilityProofValue): Uint8Array {
  return cenc.encode(V1AvailabilityProof, proof)
}

export function decodeProof(buffer: Uint8Array): V1AvailabilityProofValue {
  return cenc.decode(V1AvailabilityProof, buffer) as V1AvailabilityProofValue
}

export function encodeMirrorRequest(request: V1MirrorRequestValue): Uint8Array {
  return cenc.encode(V1MirrorRequest, request)
}

export function decodeMirrorRequest(buffer: Uint8Array): V1MirrorRequestValue {
  return cenc.decode(V1MirrorRequest, buffer) as V1MirrorRequestValue
}

export function decodePeartubeLogEntry(buffer: Uint8Array): PeartubeLogEntryValue {
  return cenc.decode(PeartubeLogEntry, buffer) as PeartubeLogEntryValue
}

function keyFor(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

function toBigInt(v: bigint | number): bigint {
  return typeof v === 'bigint' ? v : BigInt(v)
}

function normalizeDescriptorRecord(descriptor: V1VideoDescriptorValue, now: bigint): DescriptorRecord {
  return {
    descriptor,
    state: DescriptorState.ACTIVE,
    firstSeenAt: now,
    lastSeenAt: now,
    lastProofAt: 0n,
    failureCount: 0,
    quarantineUntil: 0n,
    tombstonedAt: 0n,
    lastProofId: new Uint8Array(32),
    lastEventId: new Uint8Array(32),
  }
}

function upsertDescriptor(state: PeartubeRelayCoreState, descriptor: V1VideoDescriptorValue, now: bigint, eventId: Uint8Array): void {
  const id = keyFor(descriptor.descriptorId)
  const existing = state.activeIndex.get(id)
  if (!existing) {
    state.activeIndex.set(id, {
      ...normalizeDescriptorRecord(descriptor, now),
      lastEventId: cloneBytes(eventId),
    })
    return
  }

  existing.descriptor = descriptor
  existing.state = DescriptorState.ACTIVE
  existing.lastSeenAt = now
  existing.lastEventId = cloneBytes(eventId)
  existing.quarantineUntil = 0n
  existing.tombstonedAt = 0n
}

function markQuarantined(
  state: PeartubeRelayCoreState,
  payload: QuarantinedPayloadValue,
  eventId: Uint8Array,
): void {
  const id = keyFor(payload.descriptorId)
  state.quarantined.set(id, payload)
  const record = state.activeIndex.get(id)
  if (record) {
    record.state = DescriptorState.QUARANTINED
    record.failureCount = Math.max(record.failureCount, payload.failureCount)
    record.quarantineUntil = payload.quarantineUntil
    record.lastEventId = cloneBytes(eventId)
  }
}

function markTombstoned(
  state: PeartubeRelayCoreState,
  payload: TombstonedPayloadValue,
  eventId: Uint8Array,
): void {
  const id = keyFor(payload.descriptorId)
  state.tombstoned.set(id, payload)
  const record = state.activeIndex.get(id)
  if (record) {
    record.state = DescriptorState.TOMBSTONED
    record.tombstonedAt = payload.tombstonedAt
    record.lastProofId = cloneBytes(payload.lastProofId)
    record.lastEventId = cloneBytes(eventId)
  }
}

function applyDescriptorAdded(
  state: PeartubeRelayCoreState,
  entry: PeartubeLogEntryValue,
): PeartubeRelayCoreState {
  const payload = cenc.decode(DescriptorAddedPayload, entry.payload) as {
    descriptor: V1VideoDescriptorValue
    reason: number
    parentEventId: Uint8Array
    localSeenAt: bigint
    initialState: DescriptorStateValue
  }

  if (payload.initialState === DescriptorState.TOMBSTONED) {
    markTombstoned(state, {
      descriptorId: payload.descriptor.descriptorId,
      reasonCode: TombstoneReason.SUPERSEDED,
      reasonTextHash: new Uint8Array(32),
      tombstonedAt: payload.localSeenAt,
      retentionExpiredAt: payload.descriptor.expiresAt,
      lastProofId: new Uint8Array(32),
      purgeEligibleAt: payload.descriptor.expiresAt,
    }, entry.entryId)
    return state
  }

  upsertDescriptor(state, payload.descriptor, toBigInt(payload.localSeenAt), entry.entryId)
  const record = state.activeIndex.get(keyFor(payload.descriptor.descriptorId))
  if (record) {
    record.state = payload.initialState === DescriptorState.DISCOVERED ? DescriptorState.DISCOVERED : DescriptorState.VERIFIED
    if (payload.initialState === DescriptorState.ACTIVE) record.state = DescriptorState.ACTIVE
  }

  state.workerPhase = WorkerPhase.SEEDING
  return state
}

function applyProofAdded(
  state: PeartubeRelayCoreState,
  entry: PeartubeLogEntryValue,
): PeartubeRelayCoreState {
  const payload = cenc.decode(ProofAddedPayload, entry.payload) as {
    proof: V1AvailabilityProofValue
    localSeenAt: bigint
    confidence: number
    stateAfterProof: DescriptorStateValue
    failureCountReset: boolean
  }

  const proofKey = keyFor(payload.proof.proofId)
  state.proofs.set(proofKey, {
    proof: payload.proof,
    confidence: payload.confidence,
    stateAfterProof: payload.stateAfterProof,
    seenAt: toBigInt(payload.localSeenAt),
  })

  const descriptorKey = keyFor(payload.proof.descriptorId)
  const record = state.activeIndex.get(descriptorKey)
  if (record) {
    record.state = payload.stateAfterProof === DescriptorState.QUARANTINED ? DescriptorState.QUARANTINED : DescriptorState.ACTIVE
    record.lastProofAt = toBigInt(payload.localSeenAt)
    record.lastProofId = cloneBytes(payload.proof.proofId)
    record.failureCount = payload.failureCountReset ? 0 : record.failureCount
    record.lastEventId = cloneBytes(entry.entryId)
  }

  state.workerPhase = WorkerPhase.PROOF_EMISSION
  state.identityWeight = Math.min(1000, state.identityWeight + Math.max(1, payload.confidence))
  return state
}

function applyQuarantined(
  state: PeartubeRelayCoreState,
  entry: PeartubeLogEntryValue,
): PeartubeRelayCoreState {
  const payload = cenc.decode(QuarantinedPayload, entry.payload) as QuarantinedPayloadValue
  markQuarantined(state, payload, entry.entryId)
  state.identityWeight = Math.max(0, state.identityWeight - 10)
  state.workerPhase = WorkerPhase.EXPIRY
  return state
}

function applyTombstoned(
  state: PeartubeRelayCoreState,
  entry: PeartubeLogEntryValue,
): PeartubeRelayCoreState {
  const payload = cenc.decode(TombstonedPayload, entry.payload) as TombstonedPayloadValue
  markTombstoned(state, payload, entry.entryId)
  state.identityWeight = Math.max(0, state.identityWeight - 25)
  state.workerPhase = WorkerPhase.EXPIRY
  return state
}

export function reducePeartubeLogEntry(
  state: PeartubeRelayCoreState,
  entryBuffer: Uint8Array,
): PeartubeRelayCoreState {
  const entry = decodePeartubeLogEntry(entryBuffer)
  state.now = entry.observedAt

  switch (entry.entryType) {
    case EventType.DESCRIPTOR_ADDED:
      return applyDescriptorAdded(state, entry)
    case EventType.PROOF_ADDED:
      return applyProofAdded(state, entry)
    case EventType.QUARANTINED:
      return applyQuarantined(state, entry)
    case EventType.TOMBSTONED:
      return applyTombstoned(state, entry)
    default:
      return state
  }
}

export function enqueueMirrorRequest(state: PeartubeRelayCoreState, request: V1MirrorRequestValue): PeartubeRelayCoreState {
  state.pendingMirrorJobs.push(request)
  if (state.workerPhase === WorkerPhase.IDLE) state.workerPhase = WorkerPhase.DISCOVERY
  return state
}

export function advanceWorkerPhase(state: PeartubeRelayCoreState): PeartubeRelayCoreState {
  const hasJobs = state.pendingMirrorJobs.length > 0
  const hasDiscovery = state.discoveryQueue.length > 0

  switch (state.workerPhase) {
    case WorkerPhase.IDLE:
      if (hasJobs || hasDiscovery) state.workerPhase = WorkerPhase.DISCOVERY
      break
    case WorkerPhase.DISCOVERY:
      if (hasJobs) state.workerPhase = WorkerPhase.MIRRORING
      else if (hasDiscovery) state.workerPhase = WorkerPhase.SEEDING
      else state.workerPhase = WorkerPhase.IDLE
      break
    case WorkerPhase.MIRRORING:
      state.workerPhase = WorkerPhase.SEEDING
      break
    case WorkerPhase.SEEDING:
      state.workerPhase = WorkerPhase.PROOF_EMISSION
      break
    case WorkerPhase.PROOF_EMISSION:
      state.workerPhase = WorkerPhase.EXPIRY
      break
    case WorkerPhase.EXPIRY:
      state.workerPhase = hasJobs || hasDiscovery ? WorkerPhase.DISCOVERY : WorkerPhase.IDLE
      break
  }

  return state
}

export function shouldForwardDescriptor(state: PeartubeRelayCoreState, descriptorId: Uint8Array): boolean {
  const key = keyFor(descriptorId)
  const record = state.activeIndex.get(key)
  if (!record) return false
  if (record.state === DescriptorState.TOMBSTONED) return false
  if (record.state === DescriptorState.QUARANTINED && state.now < record.quarantineUntil) return false
  return record.descriptor.expiresAt > state.now
}

export function isEmptyFeedFailureMode(state: PeartubeRelayCoreState): boolean {
  for (const record of state.activeIndex.values()) {
    if (record.state === DescriptorState.ACTIVE || record.state === DescriptorState.VERIFIED) return false
  }
  return true
}
