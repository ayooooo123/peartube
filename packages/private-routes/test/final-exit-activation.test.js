import test from 'brittle'
import b4a from 'b4a'

import {
  DHT_EXIT_ACTIVATE_SIZE,
  DHT_EXIT_OPEN_SIZE,
  DHT_EXIT_READY_SIZE,
  DHT_EXIT_READY_ACK_SIZE,
  decodeDhtExitActivate,
  decodeDhtExitOpen,
  decodeDhtExitReady,
  decodeDhtExitReadyAck,
  dhtExitReadySignatureInput,
  digestDhtExitReady,
  digestDhtExitReadyAck,
  digestFinalExitTranscript,
  digestExitOriginServicePolicy,
  digestPayloadParameters,
  encodeDhtExitActivate,
  encodeDhtExitOpen,
  encodeDhtExitReady,
  encodeDhtExitReadyAck,
  encodeDhtExitReadyBody,
  encodeFinalExitTranscript
} from '../lib/final-exit.js'
import { FinalExitActivationSession } from '../lib/final-exit-activation.js'
import { cryptoSuite } from '../lib/crypto-suite.js'
import { TEST_ONLY_M3_TAIL_ISSUER } from '../lib/m3-adjacency-runtime.js'
import { decodeM3ContextEnvelope } from '../lib/m3-context.js'
import {
  BRANCH_CLASS,
  CONTEXT_CLASS,
  M3_MESSAGE_ID,
  M3_PROTOCOL_VERSION,
  decodeM3Object,
  encodeM3Object
} from '../lib/protocol.js'
import {
  createTailControlSession,
  digestAdmittedLimits,
  encodeTailControlTranscript
} from '../lib/tail-control.js'

function seed(byte, size = 32) {
  return b4a.alloc(size, byte)
}

function writeUint16(buffer, value, offset) {
  buffer[offset] = value >>> 8
  buffer[offset + 1] = value
}

function writeUint32(buffer, value, offset) {
  buffer[offset] = value >>> 24
  buffer[offset + 1] = value >>> 16
  buffer[offset + 2] = value >>> 8
  buffer[offset + 3] = value
}

function writeUint64(buffer, value, offset) {
  for (let index = offset + 7; index >= offset; index--) {
    buffer[index] = Number(value & 0xffn)
    value >>= 8n
  }
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

const PAYLOAD_PARAMETERS = Object.freeze({
  cellSize: 1200,
  maxCellPayload: 1146,
  contextEnvelopeSize: 1101,
  routeFrameSize: 1100,
  maxRoutePayload: 1073,
  datagramReplayWindow: 64,
  maxQueuedBytes: 65_536,
  idleTimeoutMs: 5_000
})

function handoffPair(
  now = () => 1_000n,
  expiresAt = 5_000n,
  clientCrypto = cryptoSuite,
  exitCrypto = cryptoSuite
) {
  const identity = cryptoSuite.keyPair(seed(0x21))
  const transcript = encodeTailControlTranscript({
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(0x11, 16),
    circuitId: seed(0x12, 16),
    generation: 7n,
    extensionIndex: 2,
    clientTailEphemeralPublicKey: seed(0x13),
    advertisedTailRouteEncryptionPublicKey: seed(0x14),
    candidateAdvertisementDigest: seed(0x15),
    clientNonce: seed(0x16),
    tailIdentity: identity.publicKey,
    admittedLimitsDigest: digestAdmittedLimits({
      cellSize: 1200,
      maxCells: 64,
      maxBytes: 65_536,
      maxCommands: 10,
      idleTimeoutMs: 5_000,
      expiresAtMs: expiresAt
    })
  })
  const sharedSecret = seed(0x22)
  const client = createTailControlSession(
    TEST_ONLY_M3_TAIL_ISSUER.issue({
      initiator: true,
      sharedSecret,
      transcript,
      expiresAt
    }),
    { now, crypto: cryptoSuite }
  )
  const exit = createTailControlSession(
    TEST_ONLY_M3_TAIL_ISSUER.issue({
      initiator: false,
      sharedSecret,
      transcript,
      expiresAt
    }),
    { now, crypto: cryptoSuite }
  )
  client.openReady(
    exit.sealReady({
      identitySecretKey: identity.secretKey,
      randomBytes: (size) => seed(0x31, size)
    })
  )
  return {
    identity,
    tailControlTranscript: b4a.from(transcript),
    client: new FinalExitActivationSession(client.takeFinalExitHandoff(), {
      now,
      crypto: clientCrypto,
      payloadParameters: PAYLOAD_PARAMETERS
    }),
    exit: new FinalExitActivationSession(exit.takeFinalExitHandoff(), {
      now,
      crypto: exitCrypto,
      payloadParameters: PAYLOAD_PARAMETERS
    })
  }
}

function readyPair(...args) {
  const pair = handoffPair(...args)
  pair.exit.openActivate(pair.client.sealActivate({ randomBytes: (size) => seed(0xc1, size) }))
  pair.client.openReady(
    pair.exit.sealReady({
      identitySecretKey: pair.identity.secretKey,
      randomBytes: (size) => seed(0xc2, size)
    })
  )
  return pair
}

test('DHT_EXIT_ACTIVATE_V1 has one canonical unsigned encoding', (t) => {
  const value = {
    clientActivationNonce: seed(0x11),
    exitOriginCommandPolicyDigest: seed(0x12),
    payloadParametersDigest: seed(0x13)
  }
  const encoded = encodeDhtExitActivate(value)
  t.is(encoded.byteLength, DHT_EXIT_ACTIVATE_SIZE)
  t.alike(decodeDhtExitActivate(encoded), value)

  const object = decodeM3Object(encoded)
  t.is(object.messageId, M3_MESSAGE_ID.DHT_EXIT_ACTIVATE_V1)
  t.is(object.body.byteLength, 96)
  t.is(object.authSuffix.byteLength, 0)
  t.alike(object.body.subarray(0, 32), value.clientActivationNonce)
  t.alike(object.body.subarray(32, 64), value.exitOriginCommandPolicyDigest)
  t.alike(object.body.subarray(64, 96), value.payloadParametersDigest)
})

test('DHT_EXIT_ACTIVATE_V1 rejects wrong message, auth, size, and field lengths', (t) => {
  const canonical = encodeM3Object({
    messageId: M3_MESSAGE_ID.DHT_EXIT_ACTIVATE_V1,
    body: b4a.alloc(96)
  })
  const wrongMessage = b4a.from(canonical)
  wrongMessage.writeUInt16BE(M3_MESSAGE_ID.DHT_EXIT_READY_V1, 4)
  const unexpectedAuth = b4a.concat([canonical, b4a.alloc(1)])
  const shortBody = b4a.from(canonical.subarray(0, canonical.byteLength - 1))
  shortBody.writeUInt16BE(95, 6)
  for (const encoded of [wrongMessage, unexpectedAuth, shortBody]) {
    t.exception(() => decodeDhtExitActivate(encoded))
  }
  t.exception(() =>
    encodeDhtExitActivate({
      clientActivationNonce: seed(0x11, 31),
      exitOriginCommandPolicyDigest: seed(0x12),
      payloadParametersDigest: seed(0x13)
    })
  )
})

test('DHT_EXIT_READY_V1 has one canonical signed encoding and signature input', (t) => {
  const value = {
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(0x21, 16),
    circuitId: seed(0x22, 16),
    generation: 0x0102_0304_0506_0708n,
    exitIdentity: seed(0x23),
    clientActivationNonce: seed(0x24),
    exitOriginCommandPolicyDigest: seed(0x25),
    payloadParametersDigest: seed(0x26),
    finalExitTranscriptDigest: seed(0x27),
    readyNonce: seed(0x28)
  }
  const body = encodeDhtExitReadyBody(value)
  const expectedBody = b4a.alloc(233)
  expectedBody[0] = value.branchClass
  expectedBody.set(value.branchId, 1)
  expectedBody.set(value.circuitId, 17)
  writeUint64(expectedBody, value.generation, 33)
  let offset = 41
  for (const field of [
    value.exitIdentity,
    value.clientActivationNonce,
    value.exitOriginCommandPolicyDigest,
    value.payloadParametersDigest,
    value.finalExitTranscriptDigest,
    value.readyNonce
  ]) {
    expectedBody.set(field, offset)
    offset += 32
  }
  t.alike(body, expectedBody)

  const domain = b4a.from('hyperdht-private-routes/m3/dht-exit-ready/v1')
  const expectedInput = b4a.alloc(10 + domain.byteLength + body.byteLength)
  writeUint16(expectedInput, domain.byteLength, 0)
  expectedInput.set(domain, 2)
  writeUint32(expectedInput, M3_PROTOCOL_VERSION, 2 + domain.byteLength)
  writeUint16(expectedInput, M3_MESSAGE_ID.DHT_EXIT_READY_V1, 6 + domain.byteLength)
  writeUint16(expectedInput, body.byteLength, 8 + domain.byteLength)
  expectedInput.set(body, 10 + domain.byteLength)
  t.alike(dhtExitReadySignatureInput(body), expectedInput)

  const signature = seed(0x29, 64)
  const encoded = encodeDhtExitReady({ ...value, signature })
  t.is(encoded.byteLength, DHT_EXIT_READY_SIZE)
  const decoded = decodeDhtExitReady(encoded)
  t.alike(decoded.body, body)
  t.alike(decoded.signature, signature)
  for (const [name, expected] of Object.entries(value)) t.alike(decoded[name], expected, name)
})

test('final-exit transcript digest is canonical and READY rejects malformed framing', (t) => {
  const transcript = encodeFinalExitTranscript({
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(0x31, 16),
    circuitId: seed(0x32, 16),
    generation: 9n,
    tailControlTranscriptDigest: seed(0x33),
    exitAdvertisementDigest: seed(0x34),
    exitIdentity: seed(0x35),
    clientActivationNonce: seed(0x36),
    exitOriginCommandPolicyDigest: seed(0x37),
    payloadParametersDigest: seed(0x38)
  })
  const domain = b4a.from('hyperdht-private-routes/m3/final-exit/transcript-digest/v1')
  t.alike(digestFinalExitTranscript(transcript), cryptoSuite.hash([domain, transcript]))

  const body = b4a.alloc(233)
  body[0] = BRANCH_CLASS.LOOKUP
  const signature = b4a.alloc(64)
  const canonical = encodeM3Object({
    messageId: M3_MESSAGE_ID.DHT_EXIT_READY_V1,
    body,
    authSuffix: signature
  })
  const wrongMessage = b4a.from(canonical)
  wrongMessage.writeUInt16BE(M3_MESSAGE_ID.DHT_EXIT_ACTIVATE_V1, 4)
  const shortSignature = canonical.subarray(0, canonical.byteLength - 1)
  const shortBody = b4a.concat([canonical.subarray(0, 8 + 232), signature])
  shortBody.writeUInt16BE(232, 6)
  for (const encoded of [wrongMessage, shortSignature, shortBody]) {
    t.exception(() => decodeDhtExitReady(encoded))
  }
  t.exception(() => dhtExitReadySignatureInput(body.subarray(1)))
  t.exception(() =>
    encodeDhtExitReadyBody({
      branchClass: BRANCH_CLASS.LOOKUP,
      branchId: seed(0x41, 15),
      circuitId: seed(0x42, 16),
      generation: 1n,
      exitIdentity: seed(0x43),
      clientActivationNonce: seed(0x44),
      exitOriginCommandPolicyDigest: seed(0x45),
      payloadParametersDigest: seed(0x46),
      finalExitTranscriptDigest: seed(0x47),
      readyNonce: seed(0x48)
    })
  )
})

test('DHT_EXIT_READY_ACK_V1 has one canonical encoding and digest', (t) => {
  const value = {
    branchClass: BRANCH_CLASS.ANNOUNCE,
    branchId: seed(0x51, 16),
    circuitId: seed(0x52, 16),
    generation: 0x0102_0304_0506_0708n,
    clientActivationNonce: seed(0x53),
    readyDigest: seed(0x54)
  }
  const expectedBody = b4a.alloc(105)
  expectedBody[0] = value.branchClass
  expectedBody.set(value.branchId, 1)
  expectedBody.set(value.circuitId, 17)
  writeUint64(expectedBody, value.generation, 33)
  expectedBody.set(value.clientActivationNonce, 41)
  expectedBody.set(value.readyDigest, 73)

  const encoded = encodeDhtExitReadyAck(value)
  t.is(encoded.byteLength, DHT_EXIT_READY_ACK_SIZE)
  const object = decodeM3Object(encoded)
  t.is(object.messageId, M3_MESSAGE_ID.DHT_EXIT_READY_ACK_V1)
  t.alike(object.body, expectedBody)
  t.is(object.authSuffix.byteLength, 0)
  t.alike(decodeDhtExitReadyAck(encoded), value)

  const domain = b4a.from('hyperdht-private-routes/m3/dht-exit-ready-ack-digest/v1')
  t.alike(digestDhtExitReadyAck(encoded), cryptoSuite.hash([domain, encoded]))
})

test('DHT_EXIT_OPEN_V1 has one canonical encoding and READY digest is byte-exact', (t) => {
  const ready = encodeM3Object({
    messageId: M3_MESSAGE_ID.DHT_EXIT_READY_V1,
    body: b4a.concat([b4a.from([BRANCH_CLASS.LOOKUP]), b4a.alloc(232)]),
    authSuffix: seed(0x60, 64)
  })
  const readyDomain = b4a.from('hyperdht-private-routes/m3/dht-exit-ready-digest/v1')
  t.alike(digestDhtExitReady(ready), cryptoSuite.hash([readyDomain, ready]))

  const value = {
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(0x61, 16),
    circuitId: seed(0x62, 16),
    generation: 0x1112_1314_1516_1718n,
    ackDigest: seed(0x63),
    clientActivationNonce: seed(0x64),
    exitOriginCommandPolicyDigest: seed(0x65),
    payloadParametersDigest: seed(0x66)
  }
  const expectedBody = b4a.alloc(169)
  expectedBody[0] = value.branchClass
  expectedBody.set(value.branchId, 1)
  expectedBody.set(value.circuitId, 17)
  writeUint64(expectedBody, value.generation, 33)
  let offset = 41
  for (const field of [
    value.ackDigest,
    value.clientActivationNonce,
    value.exitOriginCommandPolicyDigest,
    value.payloadParametersDigest
  ]) {
    expectedBody.set(field, offset)
    offset += 32
  }

  const encoded = encodeDhtExitOpen(value)
  t.is(encoded.byteLength, DHT_EXIT_OPEN_SIZE)
  const object = decodeM3Object(encoded)
  t.is(object.messageId, M3_MESSAGE_ID.DHT_EXIT_OPEN_V1)
  t.alike(object.body, expectedBody)
  t.is(object.authSuffix.byteLength, 0)
  t.alike(decodeDhtExitOpen(encoded), value)
})

test('READY_ACK and OPEN reject non-canonical framing and fields', (t) => {
  const ack = encodeM3Object({
    messageId: M3_MESSAGE_ID.DHT_EXIT_READY_ACK_V1,
    body: b4a.concat([b4a.from([BRANCH_CLASS.LOOKUP]), b4a.alloc(104)])
  })
  const open = encodeM3Object({
    messageId: M3_MESSAGE_ID.DHT_EXIT_OPEN_V1,
    body: b4a.concat([b4a.from([BRANCH_CLASS.LOOKUP]), b4a.alloc(168)])
  })
  const wrongAck = b4a.from(ack)
  wrongAck.writeUInt16BE(M3_MESSAGE_ID.DHT_EXIT_OPEN_V1, 4)
  const wrongOpen = b4a.from(open)
  wrongOpen.writeUInt16BE(M3_MESSAGE_ID.DHT_EXIT_READY_ACK_V1, 4)
  for (const operation of [
    () => decodeDhtExitReadyAck(wrongAck),
    () => decodeDhtExitReadyAck(b4a.concat([ack, b4a.from([0])])),
    () => decodeDhtExitOpen(wrongOpen),
    () => decodeDhtExitOpen(open.subarray(0, open.byteLength - 1)),
    () => digestDhtExitReady(ack),
    () => digestDhtExitReadyAck(open),
    () =>
      encodeDhtExitReadyAck({
        branchClass: 0xff,
        branchId: seed(0x71, 16),
        circuitId: seed(0x72, 16),
        generation: 1n,
        clientActivationNonce: seed(0x73),
        readyDigest: seed(0x74)
      }),
    () =>
      encodeDhtExitOpen({
        branchClass: BRANCH_CLASS.LOOKUP,
        branchId: seed(0x75, 15),
        circuitId: seed(0x76, 16),
        generation: 1n,
        ackDigest: seed(0x77),
        clientActivationNonce: seed(0x78),
        exitOriginCommandPolicyDigest: seed(0x79),
        payloadParametersDigest: seed(0x7a)
      })
  ]) {
    t.exception(operation)
  }
})

test('client and exit exchange ACTIVATE on an independent tail-finalize datagram context', (t) => {
  const pair = handoffPair()
  const first = pair.client.sealActivate({ randomBytes: (size) => seed(0x41, size) })
  const decodedFirst = decodeM3ContextEnvelope(first)
  t.is(decodedFirst.contextClass, CONTEXT_CLASS.TAIL_FINALIZE_DATAGRAM)
  t.is(decodedFirst.frame.readBigUInt64BE(0), 0n)

  const activation = pair.exit.openActivate(first)
  t.alike(activation.clientActivationNonce, seed(0x41))
  t.alike(activation.exitOriginCommandPolicyDigest, digestExitOriginServicePolicy())
  t.alike(activation.payloadParametersDigest, digestPayloadParameters(PAYLOAD_PARAMETERS))
  t.alike(pair.client.diagnostics(), { state: 'ACTIVATING' })
  t.alike(pair.exit.diagnostics(), { state: 'FINALIZING' })
  t.is(pair.exit.openActivate(first), null, 'an authenticated counter replay is discarded')

  const retry = pair.client.retryActivate({ randomBytes: (size) => seed(0x42, size) })
  t.is(decodeM3ContextEnvelope(retry).frame.readBigUInt64BE(0), 1n)
  t.alike(pair.exit.openActivate(retry), activation)
  t.ok(pair.client.destroy())
  t.ok(pair.exit.destroy())
})

test('ACTIVATE accepts authenticated gaps and reordering but rejects a semantic conflict', (t) => {
  const reordered = handoffPair()
  const first = reordered.client.sealActivate({ randomBytes: (size) => seed(0x45, size) })
  const second = reordered.client.retryActivate({ randomBytes: (size) => seed(0x46, size) })
  const third = reordered.client.retryActivate({ randomBytes: (size) => seed(0x47, size) })
  const activation = reordered.exit.openActivate(third)
  t.alike(reordered.exit.openActivate(first), activation)
  t.alike(reordered.exit.openActivate(second), activation)
  reordered.client.destroy()
  reordered.exit.destroy()

  let seals = 0
  const conflictingCrypto = {
    open: (options) => cryptoSuite.open(options),
    sign: (input, secretKey) => cryptoSuite.sign(input, secretKey),
    verify: (input, signature, publicKey) => cryptoSuite.verify(input, signature, publicKey),
    seal(options) {
      const plaintext = b4a.from(options.plaintext)
      if (seals++ === 1) plaintext[11] ^= 1
      return cryptoSuite.seal({ ...options, plaintext })
    }
  }
  const conflicting = handoffPair(() => 1_000n, 5_000n, conflictingCrypto)
  conflicting.exit.openActivate(
    conflicting.client.sealActivate({ randomBytes: (size) => seed(0x48, size) })
  )
  const conflict = conflicting.client.retryActivate({
    randomBytes: (size) => seed(0x49, size)
  })
  expectCode(t, () => conflicting.exit.openActivate(conflict), 'ERR_AUTHENTICATION')
  t.alike(conflicting.exit.diagnostics(), { state: 'DESTROYED' })
  conflicting.client.destroy()
})

test('ACTIVATE class substitution, tampering, and deadline failure destroy terminal state', (t) => {
  const wrongClass = handoffPair()
  const substituted = wrongClass.client.sealActivate({
    randomBytes: (size) => seed(0x51, size)
  })
  substituted[0] = CONTEXT_CLASS.TAIL_CONTROL_ORDERED
  expectCode(t, () => wrongClass.exit.openActivate(substituted), 'INVALID_ROUTE')
  t.alike(wrongClass.exit.diagnostics(), { state: 'DESTROYED' })
  wrongClass.client.destroy()

  const tampered = handoffPair()
  const corrupted = tampered.client.sealActivate({ randomBytes: (size) => seed(0x52, size) })
  corrupted[corrupted.byteLength - 1] ^= 1
  t.exception(() => tampered.exit.openActivate(corrupted))
  t.alike(tampered.exit.diagnostics(), { state: 'DESTROYED' })
  tampered.client.destroy()

  let current = 1_000n
  const expired = handoffPair(() => current)
  current = 5_000n
  expectCode(
    t,
    () => expired.client.sealActivate({ randomBytes: (size) => seed(0x53, size) }),
    'ERR_PRIVACY_UNAVAILABLE'
  )
  t.alike(expired.client.diagnostics(), { state: 'DESTROYED' })
  expired.exit.destroy()
})

test('ACTIVATE rejects actor substitution and caught callback reentry', (t) => {
  const exitAsSender = handoffPair()
  expectCode(
    t,
    () => exitAsSender.exit.sealActivate({ randomBytes: (size) => seed(0x61, size) }),
    'ERR_AUTHENTICATION'
  )
  t.alike(exitAsSender.exit.diagnostics(), { state: 'DESTROYED' })
  exitAsSender.client.destroy()

  const clientAsReceiver = handoffPair()
  const activate = clientAsReceiver.client.sealActivate({
    randomBytes: (size) => seed(0x62, size)
  })
  expectCode(t, () => clientAsReceiver.client.openActivate(activate), 'ERR_AUTHENTICATION')
  t.alike(clientAsReceiver.client.diagnostics(), { state: 'DESTROYED' })
  clientAsReceiver.exit.destroy()

  const reentrant = handoffPair()
  let reentryCode = null
  expectCode(
    t,
    () =>
      reentrant.client.sealActivate({
        randomBytes(size) {
          try {
            reentrant.client.retryActivate({ randomBytes: (length) => seed(0x63, length) })
          } catch (err) {
            reentryCode = err && err.code
          }
          return seed(0x64, size)
        }
      }),
    'INVALID_ROUTE'
  )
  t.is(reentryCode, 'ERR_BUSY')
  t.alike(reentrant.client.diagnostics(), { state: 'DESTROYED' })
  reentrant.exit.destroy()
})

test('ACTIVATE starts its exact five-second deadline on the initial send', (t) => {
  let current = 1_000n
  const pair = handoffPair(() => current, 20_000n)
  current = 2_000n
  pair.client.sealActivate({ randomBytes: (size) => seed(0x71, size) })
  current = 6_999n
  t.ok(pair.client.retryActivate({ randomBytes: (size) => seed(0x72, size) }))
  current = 7_000n
  expectCode(
    t,
    () => pair.client.retryActivate({ randomBytes: (size) => seed(0x73, size) }),
    'ERR_PRIVACY_UNAVAILABLE'
  )
  t.alike(pair.client.diagnostics(), { state: 'DESTROYED' })
  pair.exit.destroy()
})

test('exit signs cached READY and client verifies the complete final transcript', (t) => {
  const pair = handoffPair()
  const activate = pair.client.sealActivate({ randomBytes: (size) => seed(0x81, size) })
  pair.exit.openActivate(activate)
  const readyEnvelope = pair.exit.sealReady({
    identitySecretKey: pair.identity.secretKey,
    randomBytes: (size) => seed(0x82, size)
  })
  const context = decodeM3ContextEnvelope(readyEnvelope)
  t.is(context.contextClass, CONTEXT_CLASS.TAIL_FINALIZE_DATAGRAM)
  t.is(context.frame.readBigUInt64BE(0), 0n, 'reverse finalize counter is independent')

  const ready = pair.client.openReady(readyEnvelope)
  const tailDigest = cryptoSuite.hash([
    b4a.from('hyperdht-private-routes/final-exit/tail-digest/v1'),
    pair.tailControlTranscript
  ])
  const finalTranscript = encodeFinalExitTranscript({
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(0x11, 16),
    circuitId: seed(0x12, 16),
    generation: 7n,
    tailControlTranscriptDigest: tailDigest,
    exitAdvertisementDigest: seed(0x15),
    exitIdentity: pair.identity.publicKey,
    clientActivationNonce: seed(0x81),
    exitOriginCommandPolicyDigest: digestExitOriginServicePolicy(),
    payloadParametersDigest: digestPayloadParameters(PAYLOAD_PARAMETERS)
  })
  t.alike(ready.exitIdentity, pair.identity.publicKey)
  t.alike(ready.clientActivationNonce, seed(0x81))
  t.alike(ready.finalExitTranscriptDigest, digestFinalExitTranscript(finalTranscript))
  t.alike(ready.readyNonce, seed(0x82))
  t.alike(pair.client.diagnostics(), { state: 'ACKING' })
  t.alike(pair.exit.diagnostics(), { state: 'FINALIZING' })
  t.is(pair.client.openReady(readyEnvelope), null, 'authenticated counter replay is discarded')

  const retry = pair.exit.retryReady({ randomBytes: (size) => seed(0x83, size) })
  t.is(decodeM3ContextEnvelope(retry).frame.readBigUInt64BE(0), 1n)
  t.alike(pair.client.openReady(retry), ready, 'semantic READY bytes are cached')
  pair.client.destroy()
  pair.exit.destroy()
})

test('READY rejects the wrong signer, tampering, role substitution, and callback reentry', (t) => {
  const wrongSigner = handoffPair()
  wrongSigner.exit.openActivate(
    wrongSigner.client.sealActivate({ randomBytes: (size) => seed(0x91, size) })
  )
  expectCode(
    t,
    () =>
      wrongSigner.exit.sealReady({
        identitySecretKey: cryptoSuite.keyPair(seed(0x92)).secretKey,
        randomBytes: (size) => seed(0x93, size)
      }),
    'INVALID_ROUTE'
  )
  t.alike(wrongSigner.exit.diagnostics(), { state: 'DESTROYED' })
  wrongSigner.client.destroy()

  const tampered = handoffPair()
  tampered.exit.openActivate(
    tampered.client.sealActivate({ randomBytes: (size) => seed(0x94, size) })
  )
  const corrupted = tampered.exit.sealReady({
    identitySecretKey: tampered.identity.secretKey,
    randomBytes: (size) => seed(0x95, size)
  })
  corrupted[corrupted.byteLength - 1] ^= 1
  t.exception(() => tampered.client.openReady(corrupted))
  t.alike(tampered.client.diagnostics(), { state: 'DESTROYED' })
  tampered.exit.destroy()

  const wrongRole = handoffPair()
  expectCode(
    t,
    () =>
      wrongRole.client.sealReady({
        identitySecretKey: wrongRole.identity.secretKey,
        randomBytes: (size) => seed(0x96, size)
      }),
    'ERR_AUTHENTICATION'
  )
  t.alike(wrongRole.client.diagnostics(), { state: 'DESTROYED' })
  wrongRole.exit.destroy()

  const reentrant = handoffPair()
  reentrant.exit.openActivate(
    reentrant.client.sealActivate({ randomBytes: (size) => seed(0x97, size) })
  )
  let reentryCode = null
  expectCode(
    t,
    () =>
      reentrant.exit.sealReady({
        identitySecretKey: reentrant.identity.secretKey,
        randomBytes(size) {
          try {
            reentrant.exit.retryReady({ randomBytes: (length) => seed(0x98, length) })
          } catch (err) {
            reentryCode = err && err.code
          }
          return seed(0x99, size)
        }
      }),
    'INVALID_ROUTE'
  )
  t.is(reentryCode, 'ERR_BUSY')
  t.alike(reentrant.exit.diagnostics(), { state: 'DESTROYED' })
  reentrant.client.destroy()
})

test('READY rejects direction substitution and a fresh-counter semantic conflict', (t) => {
  const wrongDirection = handoffPair()
  const forward = wrongDirection.client.sealActivate({
    randomBytes: (size) => seed(0xa1, size)
  })
  t.exception(() => wrongDirection.client.openReady(forward))
  t.alike(wrongDirection.client.diagnostics(), { state: 'DESTROYED' })
  wrongDirection.exit.destroy()

  let seals = 0
  const conflictingCrypto = {
    open: (options) => cryptoSuite.open(options),
    sign: (input, secretKey) => cryptoSuite.sign(input, secretKey),
    verify: (input, signature, publicKey) => cryptoSuite.verify(input, signature, publicKey),
    seal(options) {
      const plaintext = b4a.from(options.plaintext)
      if (seals++ === 1) plaintext[20] ^= 1
      return cryptoSuite.seal({ ...options, plaintext })
    }
  }
  const conflicting = handoffPair(() => 1_000n, 5_000n, cryptoSuite, conflictingCrypto)
  conflicting.exit.openActivate(
    conflicting.client.sealActivate({ randomBytes: (size) => seed(0xa2, size) })
  )
  const first = conflicting.exit.sealReady({
    identitySecretKey: conflicting.identity.secretKey,
    randomBytes: (size) => seed(0xa3, size)
  })
  conflicting.client.openReady(first)
  const conflict = conflicting.exit.retryReady({ randomBytes: (size) => seed(0xa4, size) })
  expectCode(t, () => conflicting.client.openReady(conflict), 'ERR_AUTHENTICATION')
  t.alike(conflicting.client.diagnostics(), { state: 'DESTROYED' })
  conflicting.exit.destroy()
})

test('both finalization contexts use inherited DATAGRAM delivery framing', (t) => {
  const clientClasses = []
  const exitClasses = []
  const observedCrypto = (classes) => ({
    open: (options) => cryptoSuite.open(options),
    sign: (input, secretKey) => cryptoSuite.sign(input, secretKey),
    verify: (input, signature, publicKey) => cryptoSuite.verify(input, signature, publicKey),
    seal(options) {
      classes.push(options.plaintext[0])
      return cryptoSuite.seal(options)
    }
  })
  const pair = handoffPair(
    () => 1_000n,
    5_000n,
    observedCrypto(clientClasses),
    observedCrypto(exitClasses)
  )
  pair.exit.openActivate(pair.client.sealActivate({ randomBytes: (size) => seed(0xb1, size) }))
  pair.client.openReady(
    pair.exit.sealReady({
      identitySecretKey: pair.identity.secretKey,
      randomBytes: (size) => seed(0xb2, size)
    })
  )
  const ack = pair.client.sealAck({ randomBytes: (size) => seed(0xb3, size) })
  pair.client.openOpen(pair.exit.openAck(ack, { randomBytes: (size) => seed(0xb4, size) }))
  t.alike(clientClasses, [2, 2])
  t.alike(exitClasses, [2, 2])
  pair.client.destroy()
  pair.exit.destroy()
})

test('client ACK and exit OPEN use independent final-finalize contexts', (t) => {
  const pair = readyPair()
  const ackEnvelope = pair.client.sealAck({ randomBytes: (size) => seed(0xd1, size) })
  const ackContext = decodeM3ContextEnvelope(ackEnvelope)
  t.is(ackContext.contextClass, CONTEXT_CLASS.FINAL_EXIT_FINALIZE_DATAGRAM)
  t.is(ackContext.frame.readBigUInt64BE(0), 0n, 'final forward counter starts at zero')

  const openEnvelope = pair.exit.openAck(ackEnvelope, {
    randomBytes: (size) => seed(0xd2, size)
  })
  const openContext = decodeM3ContextEnvelope(openEnvelope)
  t.is(openContext.contextClass, CONTEXT_CLASS.FINAL_EXIT_FINALIZE_DATAGRAM)
  t.is(openContext.frame.readBigUInt64BE(0), 0n, 'final reverse counter starts at zero')
  t.alike(pair.exit.diagnostics(), { state: 'OPEN' })

  const opened = pair.client.openOpen(openEnvelope)
  t.alike(opened.branchId, seed(0x11, 16))
  t.alike(opened.circuitId, seed(0x12, 16))
  t.is(opened.generation, 7n)
  t.alike(opened.clientActivationNonce, seed(0xc1))
  t.alike(opened.exitOriginCommandPolicyDigest, digestExitOriginServicePolicy())
  t.alike(opened.payloadParametersDigest, digestPayloadParameters(PAYLOAD_PARAMETERS))
  t.alike(pair.client.diagnostics(), { state: 'OPEN' })
  pair.client.destroy()
  pair.exit.destroy()
})

test('ACK and OPEN retries preserve semantic bytes under fresh counters', (t) => {
  const pair = readyPair()
  const firstAck = pair.client.sealAck({ randomBytes: (size) => seed(0xe1, size) })
  const firstOpen = pair.exit.openAck(firstAck, { randomBytes: (size) => seed(0xe2, size) })
  t.is(pair.exit.openAck(firstAck, { randomBytes: (size) => seed(0xe3, size) }), null)

  const retryAck = pair.client.retryAck({ randomBytes: (size) => seed(0xe4, size) })
  t.is(decodeM3ContextEnvelope(retryAck).frame.readBigUInt64BE(0), 1n)
  const retryOpen = pair.exit.openAck(retryAck, {
    randomBytes: (size) => seed(0xe5, size)
  })
  t.is(decodeM3ContextEnvelope(retryOpen).frame.readBigUInt64BE(0), 1n)
  const opened = pair.client.openOpen(retryOpen)
  t.alike(pair.client.openOpen(firstOpen), opened, 'reordered semantic OPEN is identical')

  const proactiveRetry = pair.exit.retryOpen({ randomBytes: (size) => seed(0xe6, size) })
  t.is(decodeM3ContextEnvelope(proactiveRetry).frame.readBigUInt64BE(0), 2n)
  t.alike(pair.client.openOpen(proactiveRetry), opened)
  pair.client.destroy()
  pair.exit.destroy()
})

test('final-finalize rejects class, role, and semantic substitution', (t) => {
  const wrongClass = readyPair()
  const ack = wrongClass.client.sealAck({ randomBytes: (size) => seed(0xf1, size) })
  ack[0] = CONTEXT_CLASS.TAIL_FINALIZE_DATAGRAM
  expectCode(
    t,
    () => wrongClass.exit.openAck(ack, { randomBytes: (size) => seed(0xf2, size) }),
    'INVALID_ROUTE'
  )
  t.alike(wrongClass.exit.diagnostics(), { state: 'DESTROYED' })
  wrongClass.client.destroy()

  const wrongRole = readyPair()
  expectCode(
    t,
    () => wrongRole.exit.sealAck({ randomBytes: (size) => seed(0xf3, size) }),
    'ERR_AUTHENTICATION'
  )
  t.alike(wrongRole.exit.diagnostics(), { state: 'DESTROYED' })
  wrongRole.client.destroy()

  let seals = 0
  const conflictingCrypto = {
    open: (options) => cryptoSuite.open(options),
    sign: (input, secretKey) => cryptoSuite.sign(input, secretKey),
    verify: (input, signature, publicKey) => cryptoSuite.verify(input, signature, publicKey),
    seal(options) {
      const plaintext = b4a.from(options.plaintext)
      if (seals++ === 2) plaintext[20] ^= 1
      return cryptoSuite.seal({ ...options, plaintext })
    }
  }
  const conflicting = readyPair(() => 1_000n, 5_000n, conflictingCrypto)
  const first = conflicting.client.sealAck({ randomBytes: (size) => seed(0xf4, size) })
  conflicting.exit.openAck(first, { randomBytes: (size) => seed(0xf5, size) })
  const conflict = conflicting.client.retryAck({ randomBytes: (size) => seed(0xf6, size) })
  expectCode(
    t,
    () => conflicting.exit.openAck(conflict, { randomBytes: (size) => seed(0xf7, size) }),
    'ERR_AUTHENTICATION'
  )
  t.alike(conflicting.exit.diagnostics(), { state: 'DESTROYED' })
  conflicting.client.destroy()
})
