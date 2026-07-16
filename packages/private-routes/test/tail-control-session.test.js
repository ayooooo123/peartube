import b4a from 'b4a'
import test from 'brittle'

import { cryptoSuite } from '../lib/crypto-suite.js'
import { TEST_ONLY_M3_TAIL_ISSUER, revokeM3TailCapability } from '../lib/m3-adjacency-runtime.js'
import {
  M3_CONTEXT_ENVELOPE_SIZE,
  decodeM3ContextEnvelope,
  encodeM3ContextAD,
  encodeM3ContextEnvelope
} from '../lib/m3-context.js'
import {
  BRANCH_CLASS,
  CONTEXT_CLASS,
  DIRECTION,
  M3_LINK_ROLE,
  M3_MESSAGE_ID,
  RELAY_CAPABILITY,
  decodeM3Object
} from '../lib/protocol.js'
import {
  RELAY_DISCOVER_SIZE,
  TAIL_READY_SIZE,
  createTailControlSession,
  decodeRelayDiscoverRequest,
  decodeTailReady,
  deriveTailControlTestVector,
  encodeRelayDiscoverRequest,
  encodeTailControlTranscript,
  digestAdmittedLimits
} from '../lib/tail-control.js'

const NOW = 1_000

function seed(byte, size = 32) {
  return b4a.alloc(size, byte)
}

function transcript(identity, extensionIndex = 0, expiresAt = 5_000n) {
  return encodeTailControlTranscript({
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(0x11, 16),
    circuitId: seed(0x12, 16),
    generation: 7n,
    extensionIndex,
    clientTailEphemeralPublicKey: seed(0x13),
    advertisedTailRouteEncryptionPublicKey: seed(0x14),
    candidateAdvertisementDigest: seed(0x15),
    clientNonce: seed(0x16),
    tailIdentity: identity.publicKey,
    admittedLimitsDigest: digestAdmittedLimits({
      cellSize: 1200,
      maxCells: 64,
      maxBytes: 65_536,
      maxCommands: 32,
      idleTimeoutMs: 5_000,
      expiresAtMs: expiresAt
    })
  })
}

function pair(now = () => NOW, responderNow = () => NOW, extensionIndex = 0, expiresAt = 5_000n) {
  const identity = cryptoSuite.keyPair(seed(0x21))
  const encodedTranscript = transcript(identity, extensionIndex, expiresAt)
  const sharedSecret = seed(0x22)
  const initiatorTail = TEST_ONLY_M3_TAIL_ISSUER.issue({
    initiator: true,
    sharedSecret,
    transcript: encodedTranscript,
    expiresAt
  })
  const responderTail = TEST_ONLY_M3_TAIL_ISSUER.issue({
    initiator: false,
    sharedSecret,
    transcript: encodedTranscript,
    expiresAt
  })
  return {
    client: createTailControlSession(initiatorTail, { now, crypto: cryptoSuite }),
    encodedTranscript,
    identity,
    responder: createTailControlSession(responderTail, { now: responderNow, crypto: cryptoSuite }),
    sharedSecret
  }
}

function activate(fixture, byte = 0x31) {
  const ready = fixture.responder.sealReady({
    identitySecretKey: fixture.identity.secretKey,
    randomBytes: (size) => seed(byte, size)
  })
  fixture.client.openReady(ready)
}

function writeUint64(target, value, offset = 0) {
  for (let index = 7; index >= 0; index--) {
    target[offset + index] = Number(value & 0xffn)
    value >>= 8n
  }
}

test('index-zero tail session signs, seals, and verifies exactly one TAIL_READY', (t) => {
  const fixture = pair()
  const envelope = fixture.responder.sealReady({
    identitySecretKey: fixture.identity.secretKey,
    randomBytes: (size) => seed(0x31, size)
  })

  t.is(envelope.byteLength, M3_CONTEXT_ENVELOPE_SIZE)
  const ready = fixture.client.openReady(envelope)
  t.is(ready.encoded.byteLength, TAIL_READY_SIZE)
  t.is(decodeTailReady(ready.encoded).extensionIndex, 0)
  t.alike(ready.readyNonce, seed(0x31))
  t.is(fixture.client.diagnostics().state, 'ACTIVE')
  t.is(fixture.responder.diagnostics().state, 'ACTIVE')
  t.exception(() => fixture.client.openReady(envelope), 'ready is one-use')
  t.exception(
    () =>
      fixture.responder.sealReady({
        identitySecretKey: fixture.identity.secretKey,
        randomBytes: (size) => seed(0x32, size)
      }),
    'responder cannot send a second ready'
  )
  fixture.client.destroy()
  fixture.responder.destroy()
})

test('RELAY_DISCOVER_V1 has one canonical 77-byte encoding', (t) => {
  const request = {
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget: seed(0x81),
    queryNonce: seed(0x82),
    maximumResults: 8
  }
  const encoded = encodeRelayDiscoverRequest(request)
  const object = decodeM3Object(encoded)

  t.is(encoded.byteLength, RELAY_DISCOVER_SIZE)
  t.is(object.messageId, M3_MESSAGE_ID.RELAY_DISCOVER_V1)
  t.is(object.body.byteLength, 69)
  t.is(object.body.readUInt32BE(0), request.requestedCapabilityMask)
  t.alike(object.body.subarray(4, 36), request.randomTarget)
  t.alike(object.body.subarray(36, 68), request.queryNonce)
  t.is(object.body[68], request.maximumResults)
  t.alike(decodeRelayDiscoverRequest(encoded), request)

  t.exception(() => encodeRelayDiscoverRequest({ ...request, maximumResults: 0 }))
  t.exception(() => encodeRelayDiscoverRequest({ ...request, maximumResults: 9 }))
  t.exception(() => encodeRelayDiscoverRequest({ ...request, requestedCapabilityMask: 0 }))
  t.is(
    decodeRelayDiscoverRequest(
      encodeRelayDiscoverRequest({
        ...request,
        requestedCapabilityMask: RELAY_CAPABILITY.DHT_EXIT_V1
      })
    ).requestedCapabilityMask,
    RELAY_CAPABILITY.DHT_EXIT_V1
  )
  t.exception(() => decodeRelayDiscoverRequest(encoded.subarray(0, 76)))
})

test('active tails authenticate forward relay discovery for only the next legal role', (t) => {
  const indexZero = pair()
  activate(indexZero)
  const zeroEnvelope = indexZero.client.sealDiscoverRequest({
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget: seed(0x83),
    queryNonce: seed(0x84),
    maximumResults: 4,
    randomBytes: (size) => seed(0x85, size)
  })
  t.is(decodeM3ContextEnvelope(zeroEnvelope).frame.readBigUInt64BE(0), 0n)
  const zero = indexZero.responder.openDiscoverRequest(zeroEnvelope)
  t.is(zero.requestedCapabilityMask, RELAY_CAPABILITY.CIRCUIT_RELAY_V1)
  t.alike(zero.randomTarget, seed(0x83))
  t.alike(zero.queryNonce, seed(0x84))
  t.is(zero.maximumResults, 4)
  t.is(zero.branchClass, BRANCH_CLASS.LOOKUP)
  t.is(zero.currentExtensionIndex, 0)
  t.is(zero.extensionIndex, 1)
  t.is(zero.requiredRole, M3_LINK_ROLE.SAFETY_RELAY)
  t.alike(zero.branchId, seed(0x11, 16))
  t.alike(zero.circuitId, seed(0x12, 16))
  t.is(zero.generation, 7n)
  t.alike(zero.currentTailIdentity, indexZero.identity.publicKey)
  t.alike(zero.currentTailAdvertisementDigest, seed(0x15))
  t.is(zero.localAdmissionDeadline, 5_000n)
  t.is(zero.tailExpiresAt, 5_000n)
  t.ok(Object.isFrozen(zero))
  indexZero.client.destroy()
  indexZero.responder.destroy()

  const indexOne = pair(
    () => NOW,
    () => NOW,
    1
  )
  activate(indexOne, 0x86)
  const oneEnvelope = indexOne.client.sealDiscoverRequest({
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1,
    randomTarget: seed(0x87),
    queryNonce: seed(0x88),
    maximumResults: 1,
    randomBytes: (size) => seed(0x89, size)
  })
  const one = indexOne.responder.openDiscoverRequest(oneEnvelope)
  t.is(one.currentExtensionIndex, 1)
  t.is(one.extensionIndex, 2)
  t.is(one.requiredRole, M3_LINK_ROLE.DHT_EXIT)
  t.is(
    one.requestedCapabilityMask,
    RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1
  )
  indexOne.client.destroy()
  indexOne.responder.destroy()
})

test('relay discovery fixes local deadlines and rejects role substitution, replay, and reentry', (t) => {
  const deadline = pair(
    () => 1_000,
    () => 1_500,
    0,
    10_000n
  )
  activate(deadline, 0xb0)
  const deadlineEnvelope = deadline.client.sealDiscoverRequest({
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget: seed(0xb1),
    queryNonce: seed(0xb2),
    maximumResults: 1,
    randomBytes: (size) => seed(0xb3, size)
  })
  t.is(deadline.responder.openDiscoverRequest(deadlineEnvelope).localAdmissionDeadline, 6_500n)
  deadline.client.destroy()
  deadline.responder.destroy()

  let sweepNow = 1_000
  const swept = pair(
    () => sweepNow,
    () => 1_000,
    0,
    10_000n
  )
  activate(swept, 0xb4)
  swept.client.sealDiscoverRequest({
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget: seed(0xb5),
    queryNonce: seed(0xb6),
    maximumResults: 1,
    randomBytes: (size) => seed(0xb7, size)
  })
  t.is(swept.client.diagnostics().pendingDiscoveries, 1)
  sweepNow = 6_000
  t.is(swept.client.diagnostics().pendingDiscoveries, 0)
  t.is(swept.client.diagnostics().discoveryAttempts, 1)
  swept.client.destroy()
  swept.responder.destroy()

  const wrongRole = pair()
  activate(wrongRole, 0xb8)
  t.exception(() =>
    wrongRole.client.sealDiscoverRequest({
      requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1,
      randomTarget: seed(0xb9),
      queryNonce: seed(0xba),
      maximumResults: 1,
      randomBytes: (size) => seed(0xbb, size)
    })
  )
  t.is(wrongRole.client.diagnostics().state, 'DESTROYED')
  wrongRole.responder.destroy()

  const replay = pair()
  activate(replay, 0xbc)
  const replayEnvelope = replay.client.sealDiscoverRequest({
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget: seed(0xbd),
    queryNonce: seed(0xbe),
    maximumResults: 1,
    randomBytes: (size) => seed(0xbf, size)
  })
  replay.responder.openDiscoverRequest(replayEnvelope)
  t.exception(() => replay.responder.openDiscoverRequest(replayEnvelope))
  t.is(replay.responder.diagnostics().state, 'DESTROYED')
  replay.client.destroy()

  const reentrant = pair()
  activate(reentrant, 0xc0)
  let attempted = false
  const options = {
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget: seed(0xc1),
    queryNonce: seed(0xc2),
    maximumResults: 1,
    randomBytes(size) {
      if (!attempted) {
        attempted = true
        try {
          reentrant.client.sealDiscoverRequest({
            ...options,
            queryNonce: seed(0xc3),
            randomBytes: (nestedSize) => seed(0xc4, nestedSize)
          })
        } catch {}
      }
      return seed(0xc5, size)
    }
  }
  t.exception(() => reentrant.client.sealDiscoverRequest(options))
  t.ok(attempted)
  t.is(reentrant.client.diagnostics().state, 'DESTROYED')
  reentrant.responder.destroy()
})

test('relay discovery is active-only, bounded, nonce-unique, and forbidden at index two', (t) => {
  const waiting = pair()
  t.exception(() =>
    waiting.client.sealDiscoverRequest({
      requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
      randomTarget: seed(0x91),
      queryNonce: seed(0x92),
      maximumResults: 1,
      randomBytes: (size) => seed(0x93, size)
    })
  )
  t.is(waiting.client.diagnostics().state, 'DESTROYED')
  waiting.responder.destroy()

  const bounded = pair()
  activate(bounded, 0x94)
  for (let index = 0; index < 3; index++) {
    const envelope = bounded.client.sealDiscoverRequest({
      requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
      randomTarget: seed(0x95 + index),
      queryNonce: seed(0x98 + index),
      maximumResults: 1,
      randomBytes: (size) => seed(0x9b + index, size)
    })
    bounded.responder.openDiscoverRequest(envelope)
  }
  let fourthError = null
  try {
    bounded.client.sealDiscoverRequest({
      requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
      randomTarget: seed(0xa0),
      queryNonce: seed(0xa1),
      maximumResults: 1,
      randomBytes: (size) => seed(0xa2, size)
    })
  } catch (err) {
    fourthError = err
  }
  t.is(fourthError && fourthError.code, 'ERR_BUSY')
  t.is(bounded.client.diagnostics().state, 'DESTROYED')
  bounded.responder.destroy()

  const duplicate = pair()
  activate(duplicate, 0xa3)
  const options = {
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget: seed(0xa4),
    queryNonce: seed(0xa5),
    maximumResults: 1,
    randomBytes: (size) => seed(0xa6, size)
  }
  duplicate.client.sealDiscoverRequest(options)
  let replayError = null
  try {
    duplicate.client.sealDiscoverRequest(options)
  } catch (err) {
    replayError = err
  }
  t.is(replayError && replayError.code, 'ERR_REPLAY')
  t.is(duplicate.client.diagnostics().state, 'DESTROYED')
  duplicate.responder.destroy()

  const terminal = pair(
    () => NOW,
    () => NOW,
    2
  )
  activate(terminal, 0xa7)
  t.exception(() => terminal.client.sealDiscoverRequest(options))
  t.is(terminal.client.diagnostics().state, 'DESTROYED')
  terminal.responder.destroy()
})

test('tail session rejects wrong actor, tampering, replay, and expired readiness', (t) => {
  const wrongActor = pair()
  t.exception(() =>
    wrongActor.client.sealReady({
      identitySecretKey: wrongActor.identity.secretKey,
      randomBytes: (size) => seed(0x41, size)
    })
  )
  wrongActor.client.destroy()
  wrongActor.responder.destroy()

  const tampered = pair()
  const envelope = tampered.responder.sealReady({
    identitySecretKey: tampered.identity.secretKey,
    randomBytes: (size) => seed(0x42, size)
  })
  envelope[100] ^= 1
  t.exception(() => tampered.client.openReady(envelope))
  t.is(tampered.client.diagnostics().state, 'DESTROYED')
  tampered.responder.destroy()

  let current = NOW
  const expired = pair(() => current)
  const late = expired.responder.sealReady({
    identitySecretKey: expired.identity.secretKey,
    randomBytes: (size) => seed(0x43, size)
  })
  current = 5_000
  t.exception(() => expired.client.openReady(late))
  t.is(expired.client.diagnostics().state, 'DESTROYED')
  expired.responder.destroy()
})

test('tail capabilities move once and can be revoked before session creation', (t) => {
  const identity = cryptoSuite.keyPair(seed(0x51))
  const capability = TEST_ONLY_M3_TAIL_ISSUER.issue({
    initiator: true,
    sharedSecret: seed(0x52),
    transcript: transcript(identity),
    expiresAt: 5_000n
  })
  t.ok(revokeM3TailCapability(capability))
  t.is(revokeM3TailCapability(capability), false)
  t.exception(() => createTailControlSession(capability, { now: () => NOW }))

  const moved = TEST_ONLY_M3_TAIL_ISSUER.issue({
    initiator: true,
    sharedSecret: seed(0x53),
    transcript: transcript(identity),
    expiresAt: 5_000n
  })
  const session = createTailControlSession(moved, { now: () => NOW })
  t.exception(() => createTailControlSession(moved, { now: () => NOW }))
  session.destroy()
})

test('tail readiness rejects the wrong signer and caught same-session callback reentry', (t) => {
  const wrongSigner = pair()
  t.exception(() =>
    wrongSigner.responder.sealReady({
      identitySecretKey: cryptoSuite.keyPair(seed(0x61)).secretKey,
      randomBytes: (size) => seed(0x62, size)
    })
  )
  t.is(wrongSigner.responder.diagnostics().state, 'DESTROYED')
  wrongSigner.client.destroy()

  const reentrant = pair()
  let attempted = false
  t.exception(() =>
    reentrant.responder.sealReady({
      identitySecretKey: reentrant.identity.secretKey,
      randomBytes(size) {
        if (!attempted) {
          attempted = true
          try {
            reentrant.responder.sealReady({
              identitySecretKey: reentrant.identity.secretKey,
              randomBytes: (nestedSize) => seed(0x63, nestedSize)
            })
          } catch {}
        }
        return seed(0x64, size)
      }
    })
  )
  t.ok(attempted)
  t.is(reentrant.responder.diagnostics().state, 'DESTROYED')
  reentrant.client.destroy()
})

test('authenticated wrong-counter clock reentry tears the tail session down transactionally', (t) => {
  let client = null
  let clockCalls = 0
  const fixture = pair(() => {
    clockCalls++
    if (clockCalls === 3) client.destroy()
    return NOW
  })
  client = fixture.client
  const counterZero = fixture.responder.sealReady({
    identitySecretKey: fixture.identity.secretKey,
    randomBytes: (size) => seed(0x71, size)
  })
  const decoded = decodeM3ContextEnvelope(counterZero)
  const vector = deriveTailControlTestVector(fixture.sharedSecret, fixture.encodedTranscript, 0)
  const context = (counter) =>
    encodeM3ContextAD({
      contextClass: CONTEXT_CLASS.TAIL_CONTROL_ORDERED,
      branchId: seed(0x11, 16),
      circuitId: seed(0x12, 16),
      generation: 7n,
      direction: DIRECTION.REVERSE,
      innerCounter: counter
    })
  const plaintext = cryptoSuite.open({
    key: vector.reverseKey,
    noncePrefix: vector.reverseNoncePrefix,
    counter: 0n,
    associatedData: context(0n),
    ciphertext: decoded.frame.subarray(8)
  })
  const ciphertext = cryptoSuite.seal({
    key: vector.reverseKey,
    noncePrefix: vector.reverseNoncePrefix,
    counter: 1n,
    associatedData: context(1n),
    plaintext
  })
  const frame = b4a.alloc(1100)
  writeUint64(frame, 1n)
  frame.set(ciphertext, 8)
  const wrongCounter = encodeM3ContextEnvelope({
    contextClass: CONTEXT_CLASS.TAIL_CONTROL_ORDERED,
    frame
  })

  t.exception(() => client.openReady(wrongCounter))
  t.ok(clockCalls >= 2, 'authenticated delivery reached the reentrant receiver clock')
  t.is(client.diagnostics().state, 'DESTROYED')
  t.absent(client.destroy(), 'transactional teardown already tombstoned the session')
  fixture.responder.destroy()
})
