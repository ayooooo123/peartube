import test from 'brittle'
import b4a from 'b4a'

import {
  DHT_EXIT_ACTIVATE_SIZE,
  DHT_EXIT_READY_SIZE,
  decodeDhtExitActivate,
  decodeDhtExitReady,
  dhtExitReadySignatureInput,
  digestFinalExitTranscript,
  digestExitOriginServicePolicy,
  digestPayloadParameters,
  encodeDhtExitActivate,
  encodeDhtExitReady,
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
