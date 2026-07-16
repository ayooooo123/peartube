import b4a from 'b4a'
import test from 'brittle'

import * as routes from '../index.js'
import * as construction from '../lib/branch-construction-authority.js'
import { createBranchPathAuthority } from '../lib/branch-path-authority.js'
import { cryptoSuite } from '../lib/crypto-suite.js'
import {
  LINK_ACCEPT_SIZE,
  LINK_OFFER_SIZE,
  abortExtensionLinkCompletion,
  abortExtensionLinkOffer,
  completeExtensionLink,
  createExtensionLinkOffer,
  createExtensionLinkResponder,
  takeExtensionResponderAdjacency
} from '../lib/guard-link.js'
import {
  createExtensionOfferReceiver,
  createExtensionResponseReceiver
} from '../lib/extension-setup-channel.js'
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
  decodeM3Object,
  encodeM3Object
} from '../lib/protocol.js'
import {
  createCurrentTailCandidateAdmissionAuthority,
  createRoutedCandidateAuthority,
  encodeRelayDiscoverResponse
} from '../lib/routed-candidate.js'
import {
  EXTENDED_SIZE,
  EXTEND_REQUEST_MAX_SIZE,
  EXTEND_REQUEST_MIN_SIZE,
  RELAY_DISCOVER_SIZE,
  TAIL_READY_SIZE,
  abortClientTailExtension,
  completeClientTailExtension,
  createTailControlSession,
  decodeRelayDiscoverRequest,
  decodeExtendRequest,
  decodeExtended,
  decodeTailReady,
  deriveTailControlTestVector,
  encodeRelayDiscoverRequest,
  encodeExtendRequest,
  encodeExtended,
  encodeTailControlTranscript,
  digestAdmittedLimits,
  takeAdmittedExtendRequest
} from '../lib/tail-control.js'
import {
  REDACTED_RESPONDER_PROOF_SIZE,
  createRedactedResponderProofAuthority,
  decodeRedactedResponderProof
} from '../lib/redacted-responder-proof.js'
import { createTailExtensionCommitter } from '../lib/tail-extension-committer.js'
import { privateRoleIdentity, safetyRoleIdentity } from './helpers.js'

const NOW = 1_000
const CORE_FRAGMENT_DOMAIN = b4a.from('hyperdht-private-routes/m3/core-fragment/object/v1')

function seed(byte, size = 32) {
  return b4a.alloc(size, byte)
}

function expectCode(t, operation, code, message) {
  let error = null
  try {
    operation()
  } catch (err) {
    error = err
  }
  t.is(error && error.code, code, message)
}

function endpoint(last) {
  return routes.encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, last]),
    port: 44_000 + last
  })
}

function forwardingRecord() {
  let live = true
  return Object.freeze({
    diagnostics() {
      if (!live) throw new Error('destroyed')
      return Object.freeze({ state: 'CREATE', expiresAt: 5_000n })
    },
    destroy() {
      if (!live) return false
      live = false
      return true
    }
  })
}

function relayAdvertisementForIdentity(identity, byte, role = M3_LINK_ROLE.DHT_EXIT) {
  const reachableEndpoint = endpoint(byte)
  const route = cryptoSuite.encryptionKeyPair(seed(byte + 1))
  const capabilityMask =
    role === M3_LINK_ROLE.SAFETY_RELAY
      ? RELAY_CAPABILITY.CIRCUIT_RELAY_V1
      : RELAY_CAPABILITY.CIRCUIT_RELAY_V1 |
        RELAY_CAPABILITY.DHT_EXIT_V1 |
        RELAY_CAPABILITY.PRIVATE_RECORDS_V1
  return routes.encodeRelayCapabilityAdvertisement(
    routes.signRelayCapabilityAdvertisement(
      {
        relayIdentity: identity.publicKey,
        currentDhtNodeId: routes.deriveM3DhtNodeId(reachableEndpoint),
        reachableEndpoint,
        routeEncryptionPublicKey: route.publicKey,
        capabilityMask,
        minimumProtocolVersion: 1,
        maximumProtocolVersion: 1,
        cellSize: 1200,
        maxCellPayload: 1146,
        contextEnvelopeSize: 1101,
        routeFrameSize: 1100,
        maxRoutePayload: 1073,
        datagramReplayWindow: 64,
        maxConcurrentCircuits: 8,
        capacityClass: routes.CAPACITY_CLASS.SMALL,
        maxCellsPerCircuit: 100,
        maxBytesPerCircuit: 100_000,
        maxCommandsPerCircuit: 10,
        idleTimeoutMs: 30_000,
        maxQueuedBytes: 65_536,
        epoch: 1n,
        issuedAtMs: BigInt(NOW),
        expiresAtMs: 10_000n,
        providerServicePolicyEntries: routes.providerServicePolicyForCapabilities(capabilityMask)
      },
      identity.secretKey
    )
  )
}

function relayAdvertisement(byte, role = M3_LINK_ROLE.DHT_EXIT) {
  const identity =
    role === M3_LINK_ROLE.SAFETY_RELAY ? safetyRoleIdentity(byte) : privateRoleIdentity(byte)
  return relayAdvertisementForIdentity(identity, byte, role)
}

function privateAdvertisement(byte) {
  return relayAdvertisement(byte)
}

function safetyAdvertisement(byte) {
  return relayAdvertisement(byte, M3_LINK_ROLE.SAFETY_RELAY)
}

function compareAdvertisements(left, right, target) {
  const a = routes.decodeRelayCapabilityAdvertisement(left, { now: BigInt(NOW) })
  const b = routes.decodeRelayCapabilityAdvertisement(right, { now: BigInt(NOW) })
  for (let index = 0; index < 32; index++) {
    const leftDistance = a.currentDhtNodeId[index] ^ target[index]
    const rightDistance = b.currentDhtNodeId[index] ^ target[index]
    if (leftDistance !== rightDistance) return leftDistance - rightDistance
  }
  return b4a.compare(a.relayIdentity, b.relayIdentity)
}

function privateAdvertisements(count, target, start = 40) {
  const advertisements = []
  const identities = new Set()
  for (let byte = start; advertisements.length < count; byte++) {
    const encoded = privateAdvertisement(byte)
    const advertisement = routes.decodeRelayCapabilityAdvertisement(encoded, {
      now: BigInt(NOW)
    })
    const identity = b4a.toString(advertisement.relayIdentity, 'hex')
    if (identities.has(identity)) continue
    identities.add(identity)
    advertisements.push(encoded)
  }
  return advertisements.sort((left, right) => compareAdvertisements(left, right, target))
}

function transcript(
  identity,
  extensionIndex = 0,
  expiresAt = 5_000n,
  candidateAdvertisementDigest = seed(0x15)
) {
  return encodeTailControlTranscript({
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(0x11, 16),
    circuitId: seed(0x12, 16),
    generation: 7n,
    extensionIndex,
    clientTailEphemeralPublicKey: seed(0x13),
    advertisedTailRouteEncryptionPublicKey: seed(0x14),
    candidateAdvertisementDigest,
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

function pair(
  now = () => NOW,
  responderNow = () => NOW,
  extensionIndex = 0,
  expiresAt = 5_000n,
  options = {}
) {
  const identity = options.identity || cryptoSuite.keyPair(seed(0x21))
  const encodedTranscript = transcript(
    identity,
    extensionIndex,
    expiresAt,
    options.candidateAdvertisementDigest
  )
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
  const clientOptions = options.client || {}
  const responderOptions = options.responder || {}
  return {
    client: createTailControlSession(initiatorTail, {
      now,
      crypto: cryptoSuite,
      ...clientOptions
    }),
    encodedTranscript,
    identity,
    responder: createTailControlSession(responderTail, {
      now: responderNow,
      crypto: cryptoSuite,
      ...responderOptions
    }),
    sharedSecret
  }
}

function clientPathAuthority(routed, guardIdentity) {
  const guardAdvertisement = relayAdvertisementForIdentity(
    guardIdentity,
    221,
    M3_LINK_ROLE.SAFETY_RELAY
  )
  const guardDigest = routes.digestRelayCapabilityAdvertisement(guardAdvertisement, {
    now: BigInt(NOW)
  })
  const branch = (branchClass, branchByte, circuitByte, generation, seedByte) =>
    Object.freeze({
      branchClass,
      branchId: seed(branchByte, 16),
      circuitId: seed(circuitByte, 16),
      generation,
      clientCircuitIdentity: cryptoSuite.keyPair(seed(seedByte)),
      clientTailEphemeral: cryptoSuite.encryptionKeyPair(seed(seedByte + 1)),
      deadline: 5_000n,
      requestedLimits: Object.freeze({})
    })
  const authority = construction.createBranchConstructionAuthority({
    lookup: branch(BRANCH_CLASS.LOOKUP, 0x11, 0x12, 7n, 0x71),
    announce: branch(BRANCH_CLASS.ANNOUNCE, 0x31, 0x32, 8n, 0x81),
    now: () => BigInt(NOW)
  })
  const lookup = construction.takeBranchConstructionRequest(authority.bootstrapRequest)
  construction.initializeBranchGuardLease(lookup, guardAdvertisement)
  const announce = construction.takeBranchConstructionRequest(authority.revalidationRequest)
  construction.validateBranchGuardLease(announce, guardAdvertisement)
  construction.completeBranchConstruction(lookup, Object.freeze({ destroy() {} }))
  construction.completeBranchConstruction(announce, Object.freeze({ destroy() {} }))
  const pair = construction.consumeBranchConstructionPair(authority.takePair())
  const path = createBranchPathAuthority({
    now: () => BigInt(NOW),
    candidateDirectory: routed.directory,
    pairBinding: pair.pathBinding
  })
  pair.lookup.destroy()
  pair.announce.destroy()
  return Object.freeze({ path, guardDigest })
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

function resealReverseEnvelope(
  fixture,
  envelope,
  sourceCounter,
  targetCounter,
  extensionIndex,
  replacement = null
) {
  const decoded = decodeM3ContextEnvelope(envelope)
  const vector = deriveTailControlTestVector(
    fixture.sharedSecret,
    fixture.encodedTranscript,
    extensionIndex
  )
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
    counter: sourceCounter,
    associatedData: context(sourceCounter),
    ciphertext: decoded.frame.subarray(8)
  })
  if (replacement) {
    plaintext.writeUInt16BE(replacement.byteLength, 1)
    plaintext.set(replacement, 3)
  }
  const ciphertext = cryptoSuite.seal({
    key: vector.reverseKey,
    noncePrefix: vector.reverseNoncePrefix,
    counter: targetCounter,
    associatedData: context(targetCounter),
    plaintext
  })
  const frame = b4a.alloc(1100)
  writeUint64(frame, targetCounter)
  frame.set(ciphertext, 8)
  return encodeM3ContextEnvelope({
    contextClass: CONTEXT_CLASS.TAIL_CONTROL_ORDERED,
    frame
  })
}

function resealForwardEnvelope(
  fixture,
  envelope,
  sourceCounter,
  targetCounter,
  extensionIndex,
  replacement
) {
  const decoded = decodeM3ContextEnvelope(envelope)
  const vector = deriveTailControlTestVector(
    fixture.sharedSecret,
    fixture.encodedTranscript,
    extensionIndex
  )
  const context = (counter) =>
    encodeM3ContextAD({
      contextClass: CONTEXT_CLASS.TAIL_CONTROL_ORDERED,
      branchId: seed(0x11, 16),
      circuitId: seed(0x12, 16),
      generation: 7n,
      direction: DIRECTION.FORWARD,
      innerCounter: counter
    })
  const plaintext = cryptoSuite.open({
    key: vector.forwardKey,
    noncePrefix: vector.forwardNoncePrefix,
    counter: sourceCounter,
    associatedData: context(sourceCounter),
    ciphertext: decoded.frame.subarray(8)
  })
  plaintext.writeUInt16BE(replacement.byteLength, 1)
  plaintext.set(replacement, 3)
  const ciphertext = cryptoSuite.seal({
    key: vector.forwardKey,
    noncePrefix: vector.forwardNoncePrefix,
    counter: targetCounter,
    associatedData: context(targetCounter),
    plaintext
  })
  const frame = b4a.alloc(1100)
  writeUint64(frame, targetCounter)
  frame.set(ciphertext, 8)
  return encodeM3ContextEnvelope({
    contextClass: CONTEXT_CLASS.TAIL_CONTROL_ORDERED,
    frame
  })
}

function extendRequest(advertisement, extensionIndex = 1, payloadParametersDigest = seed(0xa3)) {
  return encodeExtendRequest({
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(0x11, 16),
    circuitId: seed(0x12, 16),
    generation: 7n,
    extensionIndex,
    advertisement,
    clientTailEphemeralPublicKey: seed(0xa1),
    clientNonce: seed(0xa2),
    payloadParametersDigest,
    requestedLimits: {
      cellSize: 1200,
      maxCells: 64,
      maxBytes: 65_536,
      maxCommands: 10,
      idleTimeoutMs: 5_000,
      expiresAtMs: 10_000n
    },
    extensionNonce: seed(0xa4)
  })
}

function firstResponseFragment(encodedResponse) {
  const fragmentDataBytes = 1_017
  const body = b4a.alloc(48 + fragmentDataBytes)
  const digest = cryptoSuite.hash([CORE_FRAGMENT_DOMAIN, encodedResponse])
  body.writeUInt16BE(M3_MESSAGE_ID.RELAY_DISCOVER_RESPONSE_V1, 0)
  body.set(digest, 2)
  body.writeUInt32BE(encodedResponse.byteLength, 34)
  body.writeUInt16BE(0, 38)
  body.writeUInt16BE(Math.ceil(encodedResponse.byteLength / fragmentDataBytes), 40)
  body.writeUInt32BE(0, 42)
  body.writeUInt16BE(fragmentDataBytes, 46)
  body.set(encodedResponse.subarray(0, fragmentDataBytes), 48)
  return encodeM3Object({ messageId: M3_MESSAGE_ID.CORE_FRAGMENT_V1, body })
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

test('EXTEND_REQUEST_V1 and EXTENDED_V1 lock canonical Task 3 bytes', (t) => {
  const advertisement = privateAdvertisement(0x91)
  const requestedLimits = {
    cellSize: 1200,
    maxCells: 64,
    maxBytes: 65_536,
    maxCommands: 32,
    idleTimeoutMs: 5_000,
    expiresAtMs: 5_000n
  }
  const request = {
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(0x11, 16),
    circuitId: seed(0x12, 16),
    generation: 7n,
    extensionIndex: 1,
    advertisement,
    clientTailEphemeralPublicKey: seed(0x92),
    clientNonce: seed(0x93),
    payloadParametersDigest: seed(0x94),
    requestedLimits,
    extensionNonce: seed(0x95)
  }
  const encodedRequest = encodeExtendRequest(request)
  const requestObject = decodeM3Object(encodedRequest)

  t.is(encodedRequest.byteLength, 206 + advertisement.byteLength)
  t.ok(
    encodedRequest.byteLength >= EXTEND_REQUEST_MIN_SIZE &&
      encodedRequest.byteLength <= EXTEND_REQUEST_MAX_SIZE
  )
  t.is(requestObject.messageId, M3_MESSAGE_ID.EXTEND_REQUEST_V1)
  t.is(requestObject.body.byteLength, 198 + advertisement.byteLength)
  t.is(requestObject.body[0], BRANCH_CLASS.LOOKUP)
  t.is(requestObject.body.readBigUInt64BE(33), 7n)
  t.is(requestObject.body[41], 1)
  t.is(requestObject.body.readUInt16BE(42), advertisement.byteLength)
  const decodedRequest = decodeExtendRequest(encodedRequest)
  t.alike(decodedRequest.branchId, request.branchId)
  t.alike(decodedRequest.circuitId, request.circuitId)
  t.alike(decodedRequest.advertisement, advertisement)
  t.alike(decodedRequest.requestedLimits, requestedLimits)
  t.alike(decodedRequest.extensionNonce, request.extensionNonce)

  const proof = encodeM3Object({
    messageId: M3_MESSAGE_ID.REDACTED_RESPONDER_PROOF_V1,
    body: seed(0x96, 306),
    authSuffix: seed(0x97, 64)
  })
  const extended = {
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(0x11, 16),
    circuitId: seed(0x12, 16),
    generation: 7n,
    extensionIndex: 1,
    responderAdvertisementDigest: seed(0x98),
    redactedProof: proof,
    extensionNonce: seed(0x95)
  }
  const encodedExtended = encodeExtended(extended)
  const extendedObject = decodeM3Object(encodedExtended)

  t.is(encodedExtended.byteLength, EXTENDED_SIZE)
  t.is(extendedObject.messageId, M3_MESSAGE_ID.EXTENDED_V1)
  t.is(extendedObject.body.byteLength, 486)
  t.is(extendedObject.body.readUInt16BE(74), 378)
  t.alike(decodeExtended(encodedExtended), extended)

  t.exception(() => decodeExtendRequest(encodedRequest.subarray(0, encodedRequest.byteLength - 1)))
  t.exception(() => encodeExtendRequest({ ...request, extensionIndex: 0 }))
  t.exception(() =>
    encodeExtendRequest({ ...request, requestedLimits: { ...requestedLimits, maxCells: 0 } })
  )
  t.exception(() =>
    encodeExtendRequest({
      ...request,
      requestedLimits: { ...requestedLimits, expiresAtMs: 0n }
    })
  )
  t.exception(() => decodeExtended(encodedExtended.subarray(0, EXTENDED_SIZE - 1)))
  t.exception(() => encodeExtended({ ...extended, redactedProof: proof.subarray(0, 377) }))
})

test('extension codecs clear partial ownership and wrong-sized limits allocations', (t) => {
  const advertisement = privateAdvertisement(0x99)
  const requestedLimits = {
    cellSize: 1200,
    maxCells: 64,
    maxBytes: 65_536,
    maxCommands: 32,
    idleTimeoutMs: 5_000,
    expiresAtMs: 5_000n
  }
  const request = {
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(0x11, 16),
    circuitId: seed(0x12, 16),
    generation: 7n,
    extensionIndex: 1,
    advertisement,
    clientTailEphemeralPublicKey: seed(0x9a),
    clientNonce: seed(0x9b),
    payloadParametersDigest: seed(0x9c),
    requestedLimits,
    extensionNonce: seed(0x9d)
  }
  const encodedRequest = encodeExtendRequest(request)
  const proof = encodeM3Object({
    messageId: M3_MESSAGE_ID.REDACTED_RESPONDER_PROOF_V1,
    body: seed(0x9e, 306),
    authSuffix: seed(0x9f, 64)
  })
  const encodedExtended = encodeExtended({
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(0x11, 16),
    circuitId: seed(0x12, 16),
    generation: 7n,
    extensionIndex: 1,
    responderAdvertisementDigest: seed(0xa0),
    redactedProof: proof,
    extensionNonce: seed(0x9d)
  })
  const allocate = b4a.allocUnsafeSlow
  let wrongLimits = null
  b4a.allocUnsafeSlow = (size) => {
    if (size === 26 && wrongLimits === null) {
      wrongLimits = allocate(25)
      wrongLimits.fill(0xaa)
      return wrongLimits
    }
    return allocate(size)
  }
  try {
    t.exception(() => encodeExtendRequest(request))
  } finally {
    b4a.allocUnsafeSlow = allocate
  }
  t.ok(wrongLimits && wrongLimits.every((byte) => byte === 0))

  for (const [name, operation, failingCopy] of [
    ['request', () => decodeExtendRequest(encodedRequest), 3],
    ['extended', () => decodeExtended(encodedExtended), 2]
  ]) {
    const owned = []
    let copies = 0
    b4a.allocUnsafeSlow = (size) => {
      if (size === 16 || size === 32 || size === 378) {
        if (size === 32) copies++
        const output = allocate(size === 32 && copies === failingCopy ? 31 : size)
        output.fill(0xaa)
        owned.push(output)
        return output
      }
      return allocate(size)
    }
    try {
      t.exception(operation, name)
    } finally {
      b4a.allocUnsafeSlow = allocate
    }
    t.ok(owned.length > 0, name)
    t.ok(
      owned.every((buffer) => buffer.every((byte) => byte === 0)),
      `${name} clears every staged owned buffer`
    )
  }
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

test('current tail authenticates one direct discovery response into client evidence', (t) => {
  const routed = createRoutedCandidateAuthority({ now: () => BigInt(NOW) })
  const admissions = createCurrentTailCandidateAdmissionAuthority({ now: () => BigInt(NOW) })
  const fixture = pair(
    () => NOW,
    () => NOW,
    0,
    5_000n,
    {
      client: { evidenceProducer: routed.evidenceProducer },
      responder: {
        candidateAdmissionProducer: admissions.producer,
        candidateAdmissionConsumer: admissions.consumer
      }
    }
  )
  activate(fixture, 0xd0)
  const requestEnvelope = fixture.client.sealDiscoverRequest({
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget: seed(0xd1),
    queryNonce: seed(0xd2),
    maximumResults: 8,
    randomBytes: (size) => seed(0xd3, size)
  })
  fixture.responder.openDiscoverRequest(requestEnvelope)
  const encodedResponse = encodeRelayDiscoverResponse({
    queryNonce: seed(0xd2),
    responseTimeMs: BigInt(NOW),
    advertisements: []
  })
  const envelopes = fixture.responder.sealDiscoverResponse({
    encodedResponse,
    randomBytes: (size) => seed(0xd4, size)
  })

  t.is(envelopes.length, 1)
  t.is(decodeM3ContextEnvelope(envelopes[0]).frame.readBigUInt64BE(0), 1n)
  const evidence = fixture.client.openDiscoverResponse(envelopes[0])
  t.alike(routed.directory.admit(evidence), [])
  t.alike(admissions.diagnostics(), {
    state: 'ACTIVE',
    live: 0,
    states: 0,
    requests: 1
  })
  t.is(fixture.client.diagnostics().pendingDiscoveries, 0)
  t.is(fixture.responder.diagnostics().pendingDiscoveries, 0)

  fixture.client.destroy()
  fixture.responder.destroy()
  routed.directory.destroy()
  admissions.destroy()
})

test('current tail opens one EXTEND only for an advertisement it returned', (t) => {
  const admissions = createCurrentTailCandidateAdmissionAuthority({ now: () => BigInt(NOW) })
  const fixture = pair(
    () => NOW,
    () => NOW,
    1,
    5_000n,
    {
      identity: safetyRoleIdentity(200),
      responder: {
        candidateAdmissionProducer: admissions.producer,
        candidateAdmissionConsumer: admissions.consumer
      }
    }
  )
  activate(fixture, 0xc0)
  const randomTarget = seed(0xc1)
  const queryNonce = seed(0xc2)
  const advertisement = privateAdvertisements(1, randomTarget, 130)[0]
  const requestEnvelope = fixture.client.sealDiscoverRequest({
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1,
    randomTarget,
    queryNonce,
    maximumResults: 1,
    randomBytes: (size) => seed(0xc3, size)
  })
  fixture.responder.openDiscoverRequest(requestEnvelope)
  fixture.responder.sealDiscoverResponse({
    encodedResponse: encodeRelayDiscoverResponse({
      queryNonce,
      responseTimeMs: BigInt(NOW),
      advertisements: [advertisement]
    }),
    randomBytes: (size) => seed(0xc4, size)
  })
  const encodedExtend = extendRequest(advertisement, 2)
  expectCode(
    t,
    () => takeAdmittedExtendRequest(decodeExtendRequest(encodedExtend)),
    'ERR_REPLAY',
    'decoded request bytes do not carry dial authority'
  )
  const extendEnvelope = resealForwardEnvelope(fixture, requestEnvelope, 0n, 1n, 1, encodedExtend)
  const admitted = fixture.responder.openExtendRequest(extendEnvelope)
  t.ok(Object.isFrozen(admitted))
  t.alike(Object.keys(admitted), [])
  const opened = takeAdmittedExtendRequest(admitted)

  t.is(opened.request.extensionIndex, 2)
  t.alike(opened.request.advertisement, advertisement)
  t.alike(opened.currentTailIdentity, fixture.identity.publicKey)
  t.alike(opened.currentTailAdvertisementDigest, seed(0x15))
  t.is(opened.deadline, 5_000n)
  expectCode(t, () => takeAdmittedExtendRequest(admitted), 'ERR_REPLAY')
  t.exception(() => fixture.responder.openExtendRequest(extendEnvelope))
  t.is(fixture.responder.diagnostics().state, 'DESTROYED')
  t.alike(admissions.diagnostics(), {
    state: 'ACTIVE',
    live: 0,
    states: 1,
    requests: 1
  })

  fixture.client.destroy()
  admissions.destroy()
})

test('an admitted EXTEND completes the exact successor OFFER ACCEPT PROOF exchange', (t) => {
  const admissions = createCurrentTailCandidateAdmissionAuthority({ now: () => BigInt(NOW) })
  const currentTailAdjacencyAuthority = new routes.M3AdjacencyAuthority({ now: () => NOW })
  const installedForwarding = forwardingRecord()
  let enqueuedExtended = null
  let installedNextRuntime = null
  const extensionCommitter = createTailExtensionCommitter({
    enqueue(envelope) {
      enqueuedExtended = envelope
    },
    install(runtime) {
      installedNextRuntime = runtime
      return installedForwarding
    },
    destroy() {}
  })
  const fixture = pair(
    () => NOW,
    () => NOW,
    1,
    5_000n,
    {
      identity: safetyRoleIdentity(220),
      responder: {
        candidateAdmissionProducer: admissions.producer,
        candidateAdmissionConsumer: admissions.consumer,
        adjacencyAuthority: currentTailAdjacencyAuthority,
        extensionCommitter
      }
    }
  )
  activate(fixture, 0xe0)
  const randomTarget = seed(0xe1)
  const queryNonce = seed(0xe2)
  const advertisement = privateAdvertisements(1, randomTarget, 180)[0]
  const decodedAdvertisement = routes.decodeRelayCapabilityAdvertisement(advertisement, {
    now: BigInt(NOW)
  })
  const discoverEnvelope = fixture.client.sealDiscoverRequest({
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1,
    randomTarget,
    queryNonce,
    maximumResults: 1,
    randomBytes: (size) => seed(0xe3, size)
  })
  fixture.responder.openDiscoverRequest(discoverEnvelope)
  fixture.responder.sealDiscoverResponse({
    encodedResponse: encodeRelayDiscoverResponse({
      queryNonce,
      responseTimeMs: BigInt(NOW),
      advertisements: [advertisement]
    }),
    randomBytes: (size) => seed(0xe4, size)
  })
  const encodedExtend = extendRequest(
    advertisement,
    2,
    routes.digestPayloadParameters(decodedAdvertisement)
  )
  const envelope = resealForwardEnvelope(fixture, discoverEnvelope, 0n, 1n, 1, encodedExtend)
  const admitted = fixture.responder.openExtendRequest(envelope)
  let reentryCode = null
  let randomReentryCode = null
  const options = {
    initiatorIdentitySecretKey: fixture.identity.secretKey,
    get now() {
      try {
        createExtensionLinkOffer(admitted, {
          initiatorIdentitySecretKey: fixture.identity.secretKey,
          now: BigInt(NOW),
          randomBytes: (size) => seed(0xff, size)
        })
      } catch (err) {
        reentryCode = err && err.code
      }
      return BigInt(NOW)
    },
    randomBytes(size) {
      try {
        createExtensionLinkOffer(admitted, {
          initiatorIdentitySecretKey: fixture.identity.secretKey,
          now: BigInt(NOW),
          randomBytes: (nestedSize) => seed(0xfe, nestedSize)
        })
      } catch (err) {
        randomReentryCode = err && err.code
      }
      return seed(0xe5, size)
    }
  }
  const extension = createExtensionLinkOffer(admitted, options)
  const object = decodeM3Object(extension.offer)

  t.is(reentryCode, 'ERR_REPLAY', 'admission moves before hostile option getters')
  t.is(randomReentryCode, 'ERR_REPLAY', 'admission moves before hostile randomness')
  t.is(extension.offer.byteLength, LINK_OFFER_SIZE)
  t.is(object.messageId, M3_MESSAGE_ID.LINK_OFFER_V1)
  t.alike(object.body.subarray(32, 64), fixture.identity.publicKey)
  t.alike(object.body.subarray(64, 96), decodedAdvertisement.relayIdentity)
  t.is(object.body[96], M3_LINK_ROLE.SAFETY_RELAY)
  t.is(object.body[97], M3_LINK_ROLE.DHT_EXIT)
  t.is(object.body[139], 2)
  t.alike(object.body.subarray(172, 204), seed(0xa1))
  t.alike(object.body.subarray(204, 236), seed(0xa2))
  t.alike(object.body.subarray(236, 268), routes.digestPayloadParameters(decodedAdvertisement))
  t.is(object.body.readBigUInt64BE(294), 5_000n)
  t.ok(Object.isFrozen(extension.pending))
  t.alike(Object.keys(extension.pending), [])
  expectCode(t, () => takeAdmittedExtendRequest(admitted), 'ERR_REPLAY')

  const successorIdentity = privateRoleIdentity(180)
  const successorRoute = cryptoSuite.encryptionKeyPair(seed(181))
  const reentrantAuthority = new routes.M3AdjacencyAuthority({ now: () => NOW })
  let reentrant = null
  let recursiveCode = null
  let reentrantCloses = 0
  let reentrantReads = 0
  reentrant = createExtensionLinkResponder({
    advertisement,
    adjacencyAdopter: reentrantAuthority.responderAdopter(),
    responderIdentitySecretKey: successorIdentity.secretKey,
    responderRouteEncryptionSecretKey: successorRoute.secretKey,
    now: () => BigInt(NOW),
    offerReceiver: createExtensionOfferReceiver({
      observedPredecessorEndpoint: endpoint(220),
      receiveObject() {
        if (reentrantReads++ > 0) return null
        try {
          reentrant.accept()
        } catch (err) {
          recursiveCode = err && err.code
        }
        return extension.offer
      },
      takePhysicalChannel: () =>
        Object.freeze({
          destroy() {
            reentrantCloses++
          }
        }),
      sendObject() {},
      finish() {},
      destroy() {
        reentrantCloses++
      }
    })
  })
  expectCode(t, () => reentrant.accept(), 'INVALID_ROUTE')
  t.is(recursiveCode, 'ERR_BUSY')
  t.is(reentrantCloses, 1)
  t.alike(reentrantAuthority.diagnostics(), { activeRuntimes: 0, maxRuntimes: 128 })
  t.is(reentrant.destroy(), false, 'reentry terminalizes the responder')

  const sendReentryAuthority = new routes.M3AdjacencyAuthority({ now: () => NOW })
  const sentBeforeViolation = []
  let sendReentry = null
  let sendReentryCode = null
  let sendNow = BigInt(NOW)
  sendReentry = createExtensionLinkResponder({
    advertisement,
    adjacencyAdopter: sendReentryAuthority.responderAdopter(),
    responderIdentitySecretKey: successorIdentity.secretKey,
    responderRouteEncryptionSecretKey: successorRoute.secretKey,
    now: () => sendNow,
    offerReceiver: createExtensionOfferReceiver({
      observedPredecessorEndpoint: endpoint(220),
      receiveObject: (() => {
        const objects = [extension.offer, null]
        return () => objects.shift()
      })(),
      takePhysicalChannel: () => Object.freeze({ destroy() {} }),
      sendObject(object) {
        sentBeforeViolation.push(object)
        sendNow = 5_000n
        try {
          sendReentry.accept()
        } catch (err) {
          sendReentryCode = err && err.code
        }
      },
      finish() {},
      destroy() {}
    })
  })
  expectCode(t, () => sendReentry.accept(), 'INVALID_ROUTE')
  t.is(sendReentryCode, 'ERR_BUSY')
  t.is(sentBeforeViolation.length, 1, 'a hostile ACCEPT enqueue cannot release PROOF')
  t.alike(sendReentryAuthority.diagnostics(), { activeRuntimes: 0, maxRuntimes: 128 })
  t.is(sendReentry.destroy(), false, 'send reentry terminalizes the responder')

  const successorPhysical = Object.freeze({ destroy() {} })
  const successorAdjacencyAuthority = new routes.M3AdjacencyAuthority({
    now: () => NOW
  })
  let randomByte = 0xf0
  let randomCalls = 0
  let proofSawLiveTail = false
  const successorSetupObjects = []
  const responder = createExtensionLinkResponder({
    advertisement,
    adjacencyAdopter: successorAdjacencyAuthority.responderAdopter(),
    responderIdentitySecretKey: successorIdentity.secretKey,
    responderRouteEncryptionSecretKey: successorRoute.secretKey,
    now: () => BigInt(NOW),
    offerReceiver: createExtensionOfferReceiver({
      observedPredecessorEndpoint: endpoint(220),
      receiveObject: (() => {
        const objects = [extension.offer, null]
        return () => objects.shift()
      })(),
      takePhysicalChannel: () => successorPhysical,
      sendObject: (object) => successorSetupObjects.push(object),
      finish: () => successorSetupObjects.push(null),
      destroy() {}
    }),
    randomBytes(size) {
      randomCalls++
      if (randomCalls === 3) {
        proofSawLiveTail = successorAdjacencyAuthority.diagnostics().activeRuntimes === 1
      }
      return seed(randomByte++, size)
    }
  })
  const accepted = responder.accept()
  const successorAdjacency = takeExtensionResponderAdjacency(responder, accepted.accepted)
  const [accept, proof] = successorSetupObjects
  let proofVerificationSampled = false
  let postProofClockSamples = 0
  const proofAuthority = createRedactedResponderProofAuthority({
    now() {
      proofVerificationSampled = true
      return BigInt(NOW)
    }
  })
  const initiatorPhysical = Object.freeze({ destroy() {} })
  const completed = completeExtensionLink(extension.pending, {
    now() {
      if (proofVerificationSampled) postProofClockSamples++
      return BigInt(NOW)
    },
    proofVerifier: proofAuthority.verifier,
    proofConsumer: proofAuthority.consumer,
    setupReceiver: createExtensionResponseReceiver({
      receiveObject: () => successorSetupObjects.shift(),
      takePhysicalChannel: () => initiatorPhysical,
      destroy() {}
    })
  })
  const expectedProof = decodeRedactedResponderProof(proof)
  const forwarding = fixture.responder.sealExtended(completed, {
    randomBytes: (size) => seed(0xf8, size)
  })

  t.is(accept.byteLength, LINK_ACCEPT_SIZE)
  t.is(proof.byteLength, REDACTED_RESPONDER_PROOF_SIZE)
  t.is(proofSawLiveTail, true, 'proof randomness is requested only after TAIL_ENDPOINT is live')
  t.is(postProofClockSamples, 1, 'the current-tail clock is refreshed after proof verification')
  t.is(expectedProof.expiresAtMs, 5_000n, 'admitted expiry clamps to the offer deadline')
  t.alike(successorAdjacency.runtime.diagnostics(), {
    state: 'TAIL_ENDPOINT',
    expiresAt: 5_000n
  })
  t.ok(Object.isFrozen(completed))
  t.alike(Object.keys(completed), [])
  t.is(enqueuedExtended.byteLength, M3_CONTEXT_ENVELOPE_SIZE)
  t.alike(installedNextRuntime.diagnostics(), {
    state: 'TAIL_ENDPOINT',
    expiresAt: 5_000n
  })
  t.alike(forwarding.diagnostics(), { state: 'CREATE', expiresAt: 5_000n })
  t.alike(proofAuthority.diagnostics(), { state: 'ACTIVE', live: 0, states: 1 })
  t.is(abortExtensionLinkOffer(extension.pending), false)
  t.is(abortExtensionLinkCompletion(completed), false)
  installedNextRuntime.destroy()
  forwarding.destroy()
  successorAdjacency.runtime.destroy()
  revokeM3TailCapability(successorAdjacency.tail)
  responder.destroy()
  proofAuthority.destroy()

  fixture.client.destroy()
  t.is(fixture.responder.destroy(), false, 'EXTENDED commit retires the old tail context')
  admissions.destroy()
})

test('the first extension establishes a safety-relay successor over the same setup channel', (t) => {
  const admissions = createCurrentTailCandidateAdmissionAuthority({ now: () => BigInt(NOW) })
  const routed = createRoutedCandidateAuthority({ now: () => BigInt(NOW) })
  const currentTailIdentity = safetyRoleIdentity(221)
  const clientPath = clientPathAuthority(routed, currentTailIdentity)
  const currentTailAuthority = new routes.M3AdjacencyAuthority({ now: () => NOW })
  const installedForwarding = forwardingRecord()
  let installedNextRuntime = null
  let enqueuedExtended = null
  const extensionCommitter = createTailExtensionCommitter({
    enqueue(envelope) {
      enqueuedExtended = envelope
    },
    install(runtime) {
      installedNextRuntime = runtime
      return installedForwarding
    },
    destroy() {}
  })
  const fixture = pair(
    () => NOW,
    () => NOW,
    0,
    5_000n,
    {
      identity: currentTailIdentity,
      candidateAdvertisementDigest: clientPath.guardDigest,
      client: {
        evidenceProducer: routed.evidenceProducer,
        branchPathAuthority: clientPath.path
      },
      responder: {
        candidateAdmissionProducer: admissions.producer,
        candidateAdmissionConsumer: admissions.consumer,
        adjacencyAuthority: currentTailAuthority,
        extensionCommitter
      }
    }
  )
  activate(fixture, 0xd0)
  const randomTarget = seed(0xd1)
  const queryNonce = seed(0xd2)
  const advertisement = safetyAdvertisement(190)
  const discoverEnvelope = fixture.client.sealDiscoverRequest({
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget,
    queryNonce,
    maximumResults: 1,
    randomBytes: (size) => seed(0xd3, size)
  })
  fixture.responder.openDiscoverRequest(discoverEnvelope)
  const responseEnvelopes = fixture.responder.sealDiscoverResponse({
    encodedResponse: encodeRelayDiscoverResponse({
      queryNonce,
      responseTimeMs: BigInt(NOW),
      advertisements: [advertisement]
    }),
    randomBytes: (size) => seed(0xd4, size)
  })
  const evidence = fixture.client.openDiscoverResponse(responseEnvelopes[0])
  const [candidate] = routed.directory.admit(evidence)
  let clientRandomByte = 0xd8
  const envelope = fixture.client.sealExtend(candidate, {
    requestedLimits: {
      cellSize: 1200,
      maxCells: 64,
      maxBytes: 65_536,
      maxCommands: 10,
      idleTimeoutMs: 5_000,
      expiresAtMs: 9_000n
    },
    randomBytes: (size) => seed(clientRandomByte++, size)
  })
  const admitted = fixture.responder.openExtendRequest(envelope)
  const extension = createExtensionLinkOffer(admitted, {
    initiatorIdentitySecretKey: fixture.identity.secretKey,
    now: BigInt(NOW),
    randomBytes: (size) => seed(0xd5, size)
  })
  const offer = decodeM3Object(extension.offer)
  const setupObjects = []
  const successorAuthority = new routes.M3AdjacencyAuthority({ now: () => NOW })
  const responder = createExtensionLinkResponder({
    advertisement,
    adjacencyAdopter: successorAuthority.responderAdopter(),
    responderIdentitySecretKey: safetyRoleIdentity(190).secretKey,
    responderRouteEncryptionSecretKey: cryptoSuite.encryptionKeyPair(seed(191)).secretKey,
    now: () => BigInt(NOW),
    offerReceiver: createExtensionOfferReceiver({
      observedPredecessorEndpoint: endpoint(221),
      receiveObject: (() => {
        const objects = [extension.offer, null]
        return () => objects.shift()
      })(),
      takePhysicalChannel: () => Object.freeze({ destroy() {} }),
      sendObject: (object) => setupObjects.push(object),
      finish: () => setupObjects.push(null),
      destroy() {}
    }),
    randomBytes: (size) => seed(0xd6, size)
  })
  const accepted = responder.accept()
  const successor = takeExtensionResponderAdjacency(responder, accepted.accepted)
  const [accept, proof] = setupObjects
  const proofAuthority = createRedactedResponderProofAuthority({ now: () => BigInt(NOW) })
  const completed = completeExtensionLink(extension.pending, {
    now: () => BigInt(NOW),
    proofVerifier: proofAuthority.verifier,
    proofConsumer: proofAuthority.consumer,
    setupReceiver: createExtensionResponseReceiver({
      receiveObject: () => setupObjects.shift(),
      takePhysicalChannel: () => Object.freeze({ destroy() {} }),
      destroy() {}
    })
  })
  const expectedProof = decodeRedactedResponderProof(proof)
  const forwarding = fixture.responder.sealExtended(completed, {
    randomBytes: (size) => seed(0xd7, size)
  })
  const clientCompletion = fixture.client.openExtended(enqueuedExtended)
  t.ok(Object.isFrozen(clientCompletion))
  t.alike(Object.keys(clientCompletion), [])
  t.alike(clientPath.path.diagnostics(), {
    state: 'ACTIVE',
    liveReservations: 1,
    retainedAuthorizations: 1,
    lookupIndex: 0,
    announceIndex: 0
  })
  const successorTail = createTailControlSession(successor.tail, {
    now: () => NOW,
    crypto: cryptoSuite
  })
  const ready = successorTail.sealReady({
    identitySecretKey: safetyRoleIdentity(190).secretKey,
    randomBytes: (size) => seed(0xda, size)
  })
  const nextClientTail = completeClientTailExtension(clientCompletion, ready)

  t.is(offer.body[96], M3_LINK_ROLE.SAFETY_RELAY)
  t.is(offer.body[97], M3_LINK_ROLE.SAFETY_RELAY)
  t.is(offer.body[139], 1)
  t.is(accept.byteLength, LINK_ACCEPT_SIZE)
  t.is(expectedProof.extensionIndex, 1)
  t.alike(successor.runtime.diagnostics(), { state: 'TAIL_ENDPOINT', expiresAt: 5_000n })
  t.alike(installedNextRuntime.diagnostics(), { state: 'TAIL_ENDPOINT', expiresAt: 5_000n })
  t.alike(forwarding.diagnostics(), { state: 'CREATE', expiresAt: 5_000n })
  t.alike(proofAuthority.diagnostics(), { state: 'ACTIVE', live: 0, states: 1 })
  t.alike(nextClientTail.diagnostics(), {
    state: 'ACTIVE',
    pendingDiscoveries: 0,
    discoveryAttempts: 0,
    responseReassemblies: 0
  })
  t.alike(clientPath.path.diagnostics(), {
    state: 'ACTIVE',
    liveReservations: 0,
    retainedAuthorizations: 1,
    lookupIndex: 1,
    announceIndex: 0
  })
  t.is(abortClientTailExtension(clientCompletion), false)
  expectCode(t, () => completeClientTailExtension(clientCompletion, ready), 'ERR_REPLAY')

  installedNextRuntime.destroy()
  forwarding.destroy()
  nextClientTail.destroy()
  successorTail.destroy()
  successor.runtime.destroy()
  responder.destroy()
  proofAuthority.destroy()
  t.is(fixture.client.destroy(), false)
  t.is(fixture.responder.destroy(), false)
  clientPath.path.destroy()
  routed.directory.destroy()
  admissions.destroy()
})

test('client EXTEND teardown rolls its uncommitted branch reservation back', (t) => {
  const admissions = createCurrentTailCandidateAdmissionAuthority({ now: () => BigInt(NOW) })
  const routed = createRoutedCandidateAuthority({ now: () => BigInt(NOW) })
  const currentTailIdentity = safetyRoleIdentity(222)
  const clientPath = clientPathAuthority(routed, currentTailIdentity)
  const fixture = pair(
    () => NOW,
    () => NOW,
    0,
    5_000n,
    {
      identity: currentTailIdentity,
      candidateAdvertisementDigest: clientPath.guardDigest,
      client: {
        evidenceProducer: routed.evidenceProducer,
        branchPathAuthority: clientPath.path
      },
      responder: {
        candidateAdmissionProducer: admissions.producer,
        candidateAdmissionConsumer: admissions.consumer
      }
    }
  )
  activate(fixture, 0xdb)
  const advertisement = safetyAdvertisement(191)
  const randomTarget = seed(0xdc)
  const queryNonce = seed(0xdd)
  const discover = fixture.client.sealDiscoverRequest({
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget,
    queryNonce,
    maximumResults: 1,
    randomBytes: (size) => seed(0xde, size)
  })
  fixture.responder.openDiscoverRequest(discover)
  const responses = fixture.responder.sealDiscoverResponse({
    encodedResponse: encodeRelayDiscoverResponse({
      queryNonce,
      responseTimeMs: BigInt(NOW),
      advertisements: [advertisement]
    }),
    randomBytes: (size) => seed(0xdf, size)
  })
  const evidence = fixture.client.openDiscoverResponse(responses[0])
  const [candidate] = routed.directory.admit(evidence)
  const extend = fixture.client.sealExtend(candidate, {
    requestedLimits: {
      cellSize: 1200,
      maxCells: 64,
      maxBytes: 65_536,
      maxCommands: 10,
      idleTimeoutMs: 5_000,
      expiresAtMs: 5_000n
    },
    randomBytes: (size) => seed(0xe0, size)
  })

  t.is(extend.byteLength, M3_CONTEXT_ENVELOPE_SIZE)
  t.is(clientPath.path.diagnostics().liveReservations, 1)
  t.is(clientPath.path.diagnostics().lookupIndex, 0)
  t.is(fixture.client.destroy(), true)
  t.is(clientPath.path.diagnostics().liveReservations, 0)
  t.is(clientPath.path.diagnostics().lookupIndex, 0)

  fixture.responder.destroy()
  clientPath.path.destroy()
  routed.directory.destroy()
  admissions.destroy()
})

test('current tail rejects omitted advertisements and mismatched admission owners', (t) => {
  const admissions = createCurrentTailCandidateAdmissionAuthority({ now: () => BigInt(NOW) })
  const other = createCurrentTailCandidateAdmissionAuthority({ now: () => BigInt(NOW) })
  const fixture = pair(
    () => NOW,
    () => NOW,
    1,
    5_000n,
    {
      responder: {
        candidateAdmissionProducer: admissions.producer,
        candidateAdmissionConsumer: admissions.consumer
      }
    }
  )
  activate(fixture, 0xc5)
  const randomTarget = seed(0xc6)
  const queryNonce = seed(0xc7)
  const returned = privateAdvertisements(1, randomTarget, 140)[0]
  const omitted = privateAdvertisements(1, randomTarget, 150)[0]
  const requestEnvelope = fixture.client.sealDiscoverRequest({
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1,
    randomTarget,
    queryNonce,
    maximumResults: 1,
    randomBytes: (size) => seed(0xc8, size)
  })
  fixture.responder.openDiscoverRequest(requestEnvelope)
  fixture.responder.sealDiscoverResponse({
    encodedResponse: encodeRelayDiscoverResponse({
      queryNonce,
      responseTimeMs: BigInt(NOW),
      advertisements: [returned]
    }),
    randomBytes: (size) => seed(0xc9, size)
  })
  const omittedEnvelope = resealForwardEnvelope(
    fixture,
    requestEnvelope,
    0n,
    1n,
    1,
    extendRequest(omitted, 2)
  )

  t.exception(() => fixture.responder.openExtendRequest(omittedEnvelope))
  t.is(fixture.responder.diagnostics().state, 'DESTROYED')
  t.alike(admissions.diagnostics(), {
    state: 'ACTIVE',
    live: 0,
    states: 0,
    requests: 1
  })

  const identity = cryptoSuite.keyPair(seed(0xca))
  const encodedTranscript = transcript(identity)
  const capability = TEST_ONLY_M3_TAIL_ISSUER.issue({
    initiator: false,
    sharedSecret: seed(0xcb),
    transcript: encodedTranscript,
    expiresAt: 5_000n
  })
  t.exception(() =>
    createTailControlSession(capability, {
      now: () => NOW,
      crypto: cryptoSuite,
      candidateAdmissionProducer: admissions.producer,
      candidateAdmissionConsumer: other.consumer
    })
  )
  t.ok(revokeM3TailCapability(capability))

  fixture.client.destroy()
  admissions.destroy()
  other.destroy()
})

test('repeated discovery refreshes one retained candidate without destroying the tail', (t) => {
  const admissions = createCurrentTailCandidateAdmissionAuthority({ now: () => BigInt(NOW) })
  const fixture = pair(
    () => NOW,
    () => NOW,
    1,
    5_000n,
    {
      responder: {
        candidateAdmissionProducer: admissions.producer,
        candidateAdmissionConsumer: admissions.consumer
      }
    }
  )
  activate(fixture, 0xcc)
  const randomTarget = seed(0xcd)
  const advertisement = privateAdvertisements(1, randomTarget, 160)[0]

  for (const nonceByte of [0xce, 0xcf]) {
    const queryNonce = seed(nonceByte)
    const requestEnvelope = fixture.client.sealDiscoverRequest({
      requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1,
      randomTarget,
      queryNonce,
      maximumResults: 1,
      randomBytes: (size) => seed(nonceByte + 1, size)
    })
    fixture.responder.openDiscoverRequest(requestEnvelope)
    fixture.responder.sealDiscoverResponse({
      encodedResponse: encodeRelayDiscoverResponse({
        queryNonce,
        responseTimeMs: BigInt(NOW),
        advertisements: [advertisement]
      }),
      randomBytes: (size) => seed(nonceByte + 2, size)
    })
  }

  t.is(fixture.responder.diagnostics().state, 'ACTIVE')
  t.alike(admissions.diagnostics(), {
    state: 'ACTIVE',
    live: 1,
    states: 1,
    requests: 1
  })

  fixture.client.destroy()
  fixture.responder.destroy()
  t.alike(admissions.diagnostics(), {
    state: 'ACTIVE',
    live: 0,
    states: 0,
    requests: 1
  })
  admissions.destroy()
})

test('EXTEND reserves before hostile clock and crypto-open reentry', (t) => {
  for (const mode of ['clock', 'crypto']) {
    let fixture = null
    let extendEnvelope = null
    let trigger = false
    let reentryCode = null
    const reenter = () => {
      if (!trigger) return
      trigger = false
      try {
        fixture.responder.openExtendRequest(extendEnvelope)
      } catch (err) {
        reentryCode = err.code
      }
    }
    const responderNow = () => {
      if (mode === 'clock') reenter()
      return NOW
    }
    const responderCrypto = {
      sign: (...args) => cryptoSuite.sign(...args),
      verify: (...args) => cryptoSuite.verify(...args),
      seal: (...args) => cryptoSuite.seal(...args),
      open(...args) {
        if (mode === 'crypto') reenter()
        return cryptoSuite.open(...args)
      }
    }
    fixture = pair(() => NOW, responderNow, 1, 5_000n, { responder: { crypto: responderCrypto } })
    activate(fixture, 0xd1)
    const baseEnvelope = fixture.client.sealDiscoverRequest({
      requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1,
      randomTarget: seed(0xd2),
      queryNonce: seed(0xd3),
      maximumResults: 1,
      randomBytes: (size) => seed(0xd4, size)
    })
    extendEnvelope = resealForwardEnvelope(
      fixture,
      baseEnvelope,
      0n,
      0n,
      1,
      extendRequest(privateAdvertisement(170), 2)
    )

    trigger = true
    expectCode(t, () => fixture.responder.openExtendRequest(extendEnvelope), 'INVALID_ROUTE', mode)
    t.is(reentryCode, 'ERR_BUSY', mode)
    t.is(fixture.responder.diagnostics().state, 'DESTROYED', mode)
    fixture.client.destroy()
  }
})

test('maximum routed discovery response uses five canonical authenticated fragments', (t) => {
  const routed = createRoutedCandidateAuthority({ now: () => BigInt(NOW) })
  const admissions = createCurrentTailCandidateAdmissionAuthority({ now: () => BigInt(NOW) })
  const fixture = pair(
    () => NOW,
    () => NOW,
    1,
    5_000n,
    {
      client: { evidenceProducer: routed.evidenceProducer },
      responder: {
        candidateAdmissionProducer: admissions.producer,
        candidateAdmissionConsumer: admissions.consumer
      }
    }
  )
  activate(fixture, 0xd5)
  const randomTarget = seed(0xd6)
  const advertisements = privateAdvertisements(8, randomTarget)
  const requestEnvelope = fixture.client.sealDiscoverRequest({
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1,
    randomTarget,
    queryNonce: seed(0xd7),
    maximumResults: 8,
    randomBytes: (size) => seed(0xd8, size)
  })
  fixture.responder.openDiscoverRequest(requestEnvelope)
  const encodedResponse = encodeRelayDiscoverResponse({
    queryNonce: seed(0xd7),
    responseTimeMs: BigInt(NOW),
    advertisements
  })
  t.is(encodedResponse.byteLength, 4_449)
  const envelopes = fixture.responder.sealDiscoverResponse({
    encodedResponse,
    randomBytes: (size) => seed(0xd9, size)
  })
  t.is(envelopes.length, 5)
  for (let index = 0; index < envelopes.length; index++) {
    t.is(decodeM3ContextEnvelope(envelopes[index]).frame.readBigUInt64BE(0), BigInt(index + 1))
  }
  const delivered = [
    envelopes[0],
    resealReverseEnvelope(fixture, envelopes[0], 1n, 2n, 1),
    ...envelopes
      .slice(1)
      .map((envelope, index) =>
        resealReverseEnvelope(fixture, envelope, BigInt(index + 2), BigInt(index + 3), 1)
      )
  ]
  t.is(fixture.client.openDiscoverResponse(delivered[0]), null)
  const beforeDuplicate = fixture.client.diagnostics()
  t.is(fixture.client.openDiscoverResponse(delivered[1]), null)
  t.alike(fixture.client.diagnostics(), beforeDuplicate)
  for (let index = 2; index < delivered.length - 1; index++) {
    t.is(fixture.client.openDiscoverResponse(delivered[index]), null)
  }
  const evidence = fixture.client.openDiscoverResponse(delivered[5])
  t.is(routed.directory.admit(evidence).length, 8)
  t.alike(admissions.diagnostics(), {
    state: 'ACTIVE',
    live: 8,
    states: 8,
    requests: 1
  })

  fixture.client.destroy()
  fixture.responder.destroy()
  routed.directory.destroy()
  admissions.destroy()
})

test('partial discovery response reassembly expires at the client request deadline', (t) => {
  let current = NOW
  const routed = createRoutedCandidateAuthority({ now: () => BigInt(current) })
  const admissions = createCurrentTailCandidateAdmissionAuthority({ now: () => BigInt(NOW) })
  const fixture = pair(
    () => current,
    () => NOW,
    1,
    10_000n,
    {
      client: { evidenceProducer: routed.evidenceProducer },
      responder: {
        candidateAdmissionProducer: admissions.producer,
        candidateAdmissionConsumer: admissions.consumer
      }
    }
  )
  activate(fixture, 0xda)
  const randomTarget = seed(0xdb)
  const requestEnvelope = fixture.client.sealDiscoverRequest({
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1,
    randomTarget,
    queryNonce: seed(0xdc),
    maximumResults: 4,
    randomBytes: (size) => seed(0xdd, size)
  })
  fixture.responder.openDiscoverRequest(requestEnvelope)
  const envelopes = fixture.responder.sealDiscoverResponse({
    encodedResponse: encodeRelayDiscoverResponse({
      queryNonce: seed(0xdc),
      responseTimeMs: BigInt(NOW),
      advertisements: privateAdvertisements(4, randomTarget, 70)
    }),
    randomBytes: (size) => seed(0xde, size)
  })
  t.ok(envelopes.length > 1)
  t.is(fixture.client.openDiscoverResponse(envelopes[0]), null)
  t.is(fixture.client.diagnostics().responseReassemblies, 1)
  current = 6_000
  t.is(fixture.client.diagnostics().pendingDiscoveries, 0)
  t.is(fixture.client.diagnostics().responseReassemblies, 0)
  t.exception(() => fixture.client.openDiscoverResponse(envelopes[1]))
  t.is(fixture.client.diagnostics().state, 'DESTROYED')

  fixture.responder.destroy()
  routed.directory.destroy()
  admissions.destroy()
})

test('one discovery binds exactly one fragmented response object and mode', (t) => {
  for (const conflict of ['digest', 'direct']) {
    const routed = createRoutedCandidateAuthority({ now: () => BigInt(NOW) })
    const admissions = createCurrentTailCandidateAdmissionAuthority({ now: () => BigInt(NOW) })
    const fixture = pair(
      () => NOW,
      () => NOW,
      1,
      5_000n,
      {
        client: { evidenceProducer: routed.evidenceProducer },
        responder: {
          candidateAdmissionProducer: admissions.producer,
          candidateAdmissionConsumer: admissions.consumer
        }
      }
    )
    activate(fixture, 0xea)
    const randomTarget = seed(0xeb)
    const queryNonce = seed(0xec)
    const requestEnvelope = fixture.client.sealDiscoverRequest({
      requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1,
      randomTarget,
      queryNonce,
      maximumResults: 4,
      randomBytes: (size) => seed(0xed, size)
    })
    fixture.responder.openDiscoverRequest(requestEnvelope)
    const encodedResponse = encodeRelayDiscoverResponse({
      queryNonce,
      responseTimeMs: BigInt(NOW),
      advertisements: privateAdvertisements(4, randomTarget, 100)
    })
    const envelopes = fixture.responder.sealDiscoverResponse({
      encodedResponse,
      randomBytes: (size) => seed(0xee, size)
    })
    t.is(fixture.client.openDiscoverResponse(envelopes[0]), null, conflict)

    const replacement =
      conflict === 'digest'
        ? firstResponseFragment(
            encodeRelayDiscoverResponse({
              queryNonce,
              responseTimeMs: BigInt(NOW + 1),
              advertisements: privateAdvertisements(4, randomTarget, 100)
            })
          )
        : encodeRelayDiscoverResponse({
            queryNonce,
            responseTimeMs: BigInt(NOW),
            advertisements: []
          })
    const conflictingEnvelope = resealReverseEnvelope(fixture, envelopes[0], 1n, 2n, 1, replacement)
    t.exception(() => fixture.client.openDiscoverResponse(conflictingEnvelope), conflict)
    t.is(fixture.client.diagnostics().state, 'DESTROYED', conflict)

    fixture.responder.destroy()
    routed.directory.destroy()
    admissions.destroy()
  }
})

test('current tail rejects a noncanonical response before sealing or reserving', (t) => {
  const routed = createRoutedCandidateAuthority({ now: () => BigInt(NOW) })
  const admissions = createCurrentTailCandidateAdmissionAuthority({ now: () => BigInt(NOW) })
  const fixture = pair(
    () => NOW,
    () => NOW,
    1,
    5_000n,
    {
      client: { evidenceProducer: routed.evidenceProducer },
      responder: {
        candidateAdmissionProducer: admissions.producer,
        candidateAdmissionConsumer: admissions.consumer
      }
    }
  )
  activate(fixture, 0xef)
  const randomTarget = seed(0xf0)
  const queryNonce = seed(0xf1)
  const requestEnvelope = fixture.client.sealDiscoverRequest({
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1,
    randomTarget,
    queryNonce,
    maximumResults: 2,
    randomBytes: (size) => seed(0xf2, size)
  })
  fixture.responder.openDiscoverRequest(requestEnvelope)
  const reversed = privateAdvertisements(2, randomTarget, 120).reverse()

  t.exception(() =>
    fixture.responder.sealDiscoverResponse({
      encodedResponse: encodeRelayDiscoverResponse({
        queryNonce,
        responseTimeMs: BigInt(NOW),
        advertisements: reversed
      }),
      randomBytes: (size) => seed(0xf3, size)
    })
  )
  t.is(fixture.responder.diagnostics().state, 'DESTROYED')
  t.alike(admissions.diagnostics(), {
    state: 'ACTIVE',
    live: 0,
    states: 0,
    requests: 0
  })

  fixture.client.destroy()
  routed.directory.destroy()
  admissions.destroy()
})

test('tail response reservation rolls admissions back after callback destruction', (t) => {
  let responder = null
  let trigger = false
  const routed = createRoutedCandidateAuthority({ now: () => BigInt(NOW) })
  const admissions = createCurrentTailCandidateAdmissionAuthority({
    now() {
      if (trigger) responder.destroy()
      return BigInt(NOW)
    }
  })
  const fixture = pair(
    () => NOW,
    () => NOW,
    1,
    5_000n,
    {
      client: { evidenceProducer: routed.evidenceProducer },
      responder: {
        candidateAdmissionProducer: admissions.producer,
        candidateAdmissionConsumer: admissions.consumer
      }
    }
  )
  responder = fixture.responder
  activate(fixture, 0xdf)
  const randomTarget = seed(0xe0)
  const requestEnvelope = fixture.client.sealDiscoverRequest({
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1,
    randomTarget,
    queryNonce: seed(0xe1),
    maximumResults: 1,
    randomBytes: (size) => seed(0xe2, size)
  })
  fixture.responder.openDiscoverRequest(requestEnvelope)
  trigger = true
  t.exception(() =>
    fixture.responder.sealDiscoverResponse({
      encodedResponse: encodeRelayDiscoverResponse({
        queryNonce: seed(0xe1),
        responseTimeMs: BigInt(NOW),
        advertisements: privateAdvertisements(1, randomTarget, 90)
      }),
      randomBytes: (size) => seed(0xe3, size)
    })
  )
  t.is(fixture.responder.diagnostics().state, 'DESTROYED')
  t.alike(admissions.diagnostics(), {
    state: 'ACTIVE',
    live: 0,
    states: 0,
    requests: 1
  })

  fixture.client.destroy()
  routed.directory.destroy()
  admissions.destroy()
})

test('client teardown during evidence publication revokes the unexposed capability', (t) => {
  let client = null
  let trigger = false
  const routed = createRoutedCandidateAuthority({
    now() {
      if (trigger) client.destroy()
      return BigInt(NOW)
    }
  })
  const admissions = createCurrentTailCandidateAdmissionAuthority({ now: () => BigInt(NOW) })
  const fixture = pair(
    () => NOW,
    () => NOW,
    0,
    5_000n,
    {
      client: { evidenceProducer: routed.evidenceProducer },
      responder: {
        candidateAdmissionProducer: admissions.producer,
        candidateAdmissionConsumer: admissions.consumer
      }
    }
  )
  client = fixture.client
  activate(fixture, 0xe4)
  const requestEnvelope = fixture.client.sealDiscoverRequest({
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget: seed(0xe5),
    queryNonce: seed(0xe6),
    maximumResults: 8,
    randomBytes: (size) => seed(0xe7, size)
  })
  fixture.responder.openDiscoverRequest(requestEnvelope)
  const envelopes = fixture.responder.sealDiscoverResponse({
    encodedResponse: encodeRelayDiscoverResponse({
      queryNonce: seed(0xe6),
      responseTimeMs: BigInt(NOW),
      advertisements: []
    }),
    randomBytes: (size) => seed(0xe8, size)
  })

  trigger = true
  t.exception(() => fixture.client.openDiscoverResponse(envelopes[0]))
  t.is(fixture.client.diagnostics().state, 'DESTROYED')
  t.alike(routed.directory.diagnostics(), {
    state: 'ACTIVE',
    live: 0,
    states: 0,
    requests: 0
  })

  fixture.responder.destroy()
  routed.directory.destroy()
  admissions.destroy()
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
