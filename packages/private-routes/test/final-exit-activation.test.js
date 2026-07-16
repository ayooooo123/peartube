import test from 'brittle'
import b4a from 'b4a'

import {
  DHT_EXIT_ACTIVATE_SIZE,
  decodeDhtExitActivate,
  digestExitOriginServicePolicy,
  digestPayloadParameters,
  encodeDhtExitActivate
} from '../lib/final-exit.js'
import { FinalExitActivationSession } from '../lib/final-exit-activation.js'
import { cryptoSuite } from '../lib/crypto-suite.js'
import { TEST_ONLY_M3_TAIL_ISSUER } from '../lib/m3-adjacency-runtime.js'
import { decodeM3ContextEnvelope } from '../lib/m3-context.js'
import {
  BRANCH_CLASS,
  CONTEXT_CLASS,
  M3_MESSAGE_ID,
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

function handoffPair(now = () => 1_000n, expiresAt = 5_000n, clientCrypto = cryptoSuite) {
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
    client: new FinalExitActivationSession(client.takeFinalExitHandoff(), {
      now,
      crypto: clientCrypto,
      payloadParameters: PAYLOAD_PARAMETERS
    }),
    exit: new FinalExitActivationSession(exit.takeFinalExitHandoff(), {
      now,
      crypto: cryptoSuite,
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
