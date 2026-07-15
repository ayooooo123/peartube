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
import { BRANCH_CLASS, CONTEXT_CLASS, DIRECTION } from '../lib/protocol.js'
import {
  TAIL_READY_SIZE,
  createTailControlSession,
  decodeTailReady,
  deriveTailControlTestVector,
  encodeTailControlTranscript,
  digestAdmittedLimits
} from '../lib/tail-control.js'

const NOW = 1_000

function seed(byte, size = 32) {
  return b4a.alloc(size, byte)
}

function transcript(identity) {
  return encodeTailControlTranscript({
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(0x11, 16),
    circuitId: seed(0x12, 16),
    generation: 7n,
    extensionIndex: 0,
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
      expiresAtMs: 5_000n
    })
  })
}

function pair(now = () => NOW, responderNow = () => NOW) {
  const identity = cryptoSuite.keyPair(seed(0x21))
  const encodedTranscript = transcript(identity)
  const sharedSecret = seed(0x22)
  const initiatorTail = TEST_ONLY_M3_TAIL_ISSUER.issue({
    initiator: true,
    sharedSecret,
    transcript: encodedTranscript,
    expiresAt: 5_000n
  })
  const responderTail = TEST_ONLY_M3_TAIL_ISSUER.issue({
    initiator: false,
    sharedSecret,
    transcript: encodedTranscript,
    expiresAt: 5_000n
  })
  return {
    client: createTailControlSession(initiatorTail, { now, crypto: cryptoSuite }),
    encodedTranscript,
    identity,
    responder: createTailControlSession(responderTail, { now: responderNow, crypto: cryptoSuite }),
    sharedSecret
  }
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
