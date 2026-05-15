import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import {
  DescriptorState,
  QuarantineReason,
  TombstoneReason,
  encodeLogEntry,
  encodeDescriptorAddedPayload,
  encodeProofAddedPayload,
  encodeQuarantinedPayload,
  encodeTombstonedPayload,
  decodeLogEntry,
  decodeDescriptorAddedPayload,
  toFixed32,
  toFixed64,
} from '../src/mirror/schemas.js'
import {
  applyPeartubeEvent,
  appendDescriptorAdded,
  createPeartubeRelayState,
} from '../src/mirror/autobase.js'
import { buildAvailabilityProof, sampleCoreAvailability } from '../src/mirror/proof.js'

const ZERO_32 = new Uint8Array(32)
const ZERO_64 = new Uint8Array(64)

function fixed(byte, size = 32) {
  return new Uint8Array(size).fill(byte)
}

function descriptor(overrides = {}) {
  const now = BigInt(Date.now())
  return {
    version: 1,
    descriptorId: fixed(1),
    contentRoot: fixed(2),
    dasRoot: fixed(3),
    swarmTopic: fixed(4),
    sourceRefHash: fixed(5),
    sourceType: 2,
    mirrorOrigin: 0,
    contentBytes: 1024n,
    segmentCount: 1,
    durationMs: 1000n,
    publishAt: now,
    expiresAt: now + 60_000n,
    availabilityEpoch: Number(now / 600_000n),
    publisherIdentity: fixed(6),
    parentDescriptorId: ZERO_32,
    titleHash: fixed(7),
    descriptionHash: fixed(8),
    languageTag: 'und',
    codecProfile: 0,
    flags: 0,
    signer: fixed(9),
    signature: fixed(10, 64),
    ...overrides,
  }
}

function logEntry(entryType, payload, observedAt = 1000n) {
  const encoders = {
    1: encodeDescriptorAddedPayload,
    2: encodeProofAddedPayload,
    3: encodeQuarantinedPayload,
    4: encodeTombstonedPayload,
  }
  const payloadBuffer = encoders[entryType](payload)
  return encodeLogEntry({
    version: 1,
    entryType,
    entryId: crypto.createHash('sha256').update(Buffer.from([entryType])).update(Buffer.from(String(observedAt))).digest().subarray(0, 32),
    prevEntryId: ZERO_32,
    actorId: fixed(11),
    observedAt,
    payload: payloadBuffer,
    signer: fixed(12),
    signature: ZERO_64,
  })
}

test('append descriptor uses payload encoding helpers that round-trip compact payloads', async () => {
  let captured
  const sample = descriptor()
  await appendDescriptorAdded({ append: async (buf) => { captured = buf } }, {
    descriptor: sample,
    reason: 1,
    parentEventId: ZERO_32,
    localSeenAt: 123n,
    initialState: DescriptorState.ACTIVE,
  }, {
    signBytes: async () => fixed(13, 64),
    signer: fixed(12),
    actorId: fixed(11),
    observedAt: 123n,
  })

  const entry = decodeLogEntry(captured)
  const payload = decodeDescriptorAddedPayload(entry.payload)
  assert.equal(Buffer.from(payload.descriptor.descriptorId).toString('hex'), Buffer.from(sample.descriptorId).toString('hex'))
})

test('terminal maps preserve quarantine and tombstone reason codes', () => {
  const state = createPeartubeRelayState(1000n)
  const sample = descriptor({ descriptorId: fixed(20) })
  applyPeartubeEvent(state, logEntry(1, {
    descriptor: sample,
    reason: 0,
    parentEventId: ZERO_32,
    localSeenAt: 1000n,
    initialState: DescriptorState.ACTIVE,
  }, 1000n))

  applyPeartubeEvent(state, logEntry(3, {
    descriptorId: sample.descriptorId,
    reasonCode: QuarantineReason.SAMPLE_FAILED,
    reasonTextHash: ZERO_32,
    firstObservedAt: 1100n,
    lastObservedAt: 1100n,
    failureCount: 1,
    relatedProofId: ZERO_32,
    quarantineUntil: 5000n,
  }, 1100n))
  assert.equal(state.quarantined.get(Buffer.from(sample.descriptorId).toString('hex')).reasonCode, QuarantineReason.SAMPLE_FAILED)

  applyPeartubeEvent(state, logEntry(4, {
    descriptorId: sample.descriptorId,
    reasonCode: TombstoneReason.REVOKED,
    reasonTextHash: ZERO_32,
    tombstonedAt: 6000n,
    retentionExpiredAt: 7000n,
    lastProofId: ZERO_32,
    purgeEligibleAt: 8000n,
  }, 6000n))
  assert.equal(state.tombstoned.get(Buffer.from(sample.descriptorId).toString('hex')).reasonCode, TombstoneReason.REVOKED)
})

test('reachable proof does not revive quarantine before quarantineUntil', () => {
  const state = createPeartubeRelayState(1000n)
  const sample = descriptor({ descriptorId: fixed(30) })
  const id = Buffer.from(sample.descriptorId).toString('hex')
  applyPeartubeEvent(state, logEntry(1, {
    descriptor: sample,
    reason: 0,
    parentEventId: ZERO_32,
    localSeenAt: 1000n,
    initialState: DescriptorState.ACTIVE,
  }, 1000n))
  applyPeartubeEvent(state, logEntry(3, {
    descriptorId: sample.descriptorId,
    reasonCode: QuarantineReason.UNREACHABLE,
    reasonTextHash: ZERO_32,
    firstObservedAt: 1100n,
    lastObservedAt: 1100n,
    failureCount: 1,
    relatedProofId: ZERO_32,
    quarantineUntil: 5000n,
  }, 1100n))
  applyPeartubeEvent(state, logEntry(2, {
    proof: {
      version: 1,
      proofId: fixed(31),
      descriptorId: sample.descriptorId,
      contentRoot: sample.contentRoot,
      dasRoot: sample.dasRoot,
      relayId: fixed(32),
      reachable: true,
      proofKind: 1,
      sampleCount: 1,
      sampleWindowMs: 1000,
      observedAt: 2000n,
      expiresAt: 6000n,
      servedBytes: 1n,
      latencyMs: 1,
      activePeers: 1,
      chainHead: fixed(33),
      evidence: new Uint8Array([1]),
      signer: fixed(34),
      signature: fixed(35, 64),
    },
    localSeenAt: 2000n,
    confidence: 3,
    stateAfterProof: DescriptorState.ACTIVE,
    failureCountReset: true,
  }, 2000n))

  assert.equal(state.activeIndex.get(id).state, DescriptorState.QUARANTINED)
  assert.equal(state.quarantined.has(id), true)
})

test('proof sampling uses checkout length and broad digest entropy', async () => {
  const indexes = []
  let checkoutArg = null
  const core = {
    length: 10_000,
    checkout(length) {
      checkoutArg = length
      return {
        get(index) {
          indexes.push(index)
          return new Uint8Array([index & 0xff])
        },
      }
    },
  }

  await sampleCoreAvailability(core, descriptor(), { sampleCount: 32 })

  assert.equal(checkoutArg, 10_000)
  assert.equal(new Set(indexes.map((index) => Math.floor(index / 256))).size > 1, true)
})

test('availability proof exposes final canonical unsigned bytes', async () => {
  const sample = descriptor()
  const core = { length: 1, get: () => new Uint8Array([1, 2, 3]) }
  let signedPayload
  const proof = await buildAvailabilityProof(sample, core, {
    now: 1234n,
    relayId: fixed(40),
    signer: fixed(41),
    signBytes: async (payload) => {
      signedPayload = payload
      return fixed(42, 64)
    },
  })

  assert.notDeepEqual(Buffer.from(proof.unsigned), Buffer.from(signedPayload))
  assert.equal(Buffer.from(proof.proof.signature).toString('hex'), Buffer.from(fixed(42, 64)).toString('hex'))
})
