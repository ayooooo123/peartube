import test from 'brittle'
import b4a from 'b4a'

import { cryptoSuite } from '../lib/crypto-suite.js'
import { decodeM3ContextEnvelope } from '../lib/m3-context.js'
import { createOpenRouteHandoff } from '../lib/open-route-handoff.js'
import { OpenRouteSession } from '../lib/open-route-session.js'
import { BRANCH_CLASS, CONTEXT_CLASS } from '../lib/protocol.js'

function seed(byte, size = 32) {
  return b4a.alloc(size, byte)
}

function material(initiator, expiresAt = 10_000n) {
  return {
    initiator,
    expiresAt,
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(0x11, 16),
    circuitId: seed(0x12, 16),
    generation: 7n,
    exitIdentity: seed(0x13),
    policyDigest: seed(0x14),
    payloadDigest: seed(0x15),
    payloadForwardKey: seed(0x21),
    payloadReverseKey: seed(0x22),
    payloadForwardNoncePrefix: seed(0x23, 16),
    payloadReverseNoncePrefix: seed(0x24, 16),
    controlForwardKey: seed(0x25),
    controlReverseKey: seed(0x26),
    controlForwardNoncePrefix: seed(0x27, 16),
    controlReverseNoncePrefix: seed(0x28, 16)
  }
}

function pair(now = () => 1_000n, clientCrypto = cryptoSuite, exitCrypto = cryptoSuite) {
  const clientOwner = {}
  const exitOwner = {}
  return {
    client: new OpenRouteSession(createOpenRouteHandoff(clientOwner, material(true)), {
      now,
      crypto: clientCrypto
    }),
    exit: new OpenRouteSession(createOpenRouteHandoff(exitOwner, material(false)), {
      now,
      crypto: exitCrypto
    })
  }
}

function expectCode(t, operation, code) {
  let error = null
  try {
    operation()
  } catch (err) {
    error = err
  }
  t.is(error && error.code, code)
}

test('OPEN route carries bidirectional payload with independent exact counters', (t) => {
  const route = pair()
  const forward = route.client.sealPayload(seed(0x31, 1073), {
    randomBytes: (size) => seed(0x32, size)
  })
  const forwardContext = decodeM3ContextEnvelope(forward)
  t.is(forwardContext.contextClass, CONTEXT_CLASS.ROUTE_PAYLOAD)
  t.is(forwardContext.frame.readBigUInt64BE(0), 0n)
  t.alike(route.exit.openPayload(forward), seed(0x31, 1073))

  const reverse = route.exit.sealPayload(seed(0x33, 17), {
    randomBytes: (size) => seed(0x34, size)
  })
  t.is(decodeM3ContextEnvelope(reverse).frame.readBigUInt64BE(0), 0n)
  t.alike(route.client.openPayload(reverse), seed(0x33, 17))
  t.alike(route.client.diagnostics(), { state: 'OPEN' })
  t.alike(route.exit.diagnostics(), { state: 'OPEN' })
  route.client.destroy()
  route.exit.destroy()
})

test('terminal control is CONTROL-framed and counter-independent from payload', (t) => {
  const clientClasses = []
  const exitClasses = []
  const observed = (classes) => ({
    open: (options) => cryptoSuite.open(options),
    seal(options) {
      classes.push(options.plaintext[0])
      return cryptoSuite.seal(options)
    }
  })
  const route = pair(() => 1_000n, observed(clientClasses), observed(exitClasses))
  const payload = route.client.sealPayload(seed(0x41, 1), {
    randomBytes: (size) => seed(0x42, size)
  })
  const control = route.client.sealControl(seed(0x43, 50), {
    randomBytes: (size) => seed(0x44, size)
  })
  t.is(decodeM3ContextEnvelope(payload).frame.readBigUInt64BE(0), 0n)
  t.is(decodeM3ContextEnvelope(control).frame.readBigUInt64BE(0), 0n)
  t.alike(route.exit.openPayload(payload), seed(0x41, 1))
  t.alike(route.exit.openControl(control), seed(0x43, 50))

  const reverseControl = route.exit.sealControl(seed(0x45, 3), {
    randomBytes: (size) => seed(0x46, size)
  })
  t.alike(route.client.openControl(reverseControl), seed(0x45, 3))
  t.alike(clientClasses, [1, 0])
  t.alike(exitClasses, [0])
  route.client.destroy()
  route.exit.destroy()
})

test('ordered route contexts reject replay, class substitution, tampering, and oversize', (t) => {
  const replay = pair()
  const envelope = replay.client.sealPayload(seed(0x51, 2), {
    randomBytes: (size) => seed(0x52, size)
  })
  t.alike(replay.exit.openPayload(envelope), seed(0x51, 2))
  expectCode(t, () => replay.exit.openPayload(envelope), 'ERR_AUTHENTICATION')
  t.alike(replay.exit.diagnostics(), { state: 'DESTROYED' })
  replay.client.destroy()

  const substitution = pair()
  const payload = substitution.client.sealPayload(seed(0x53, 2), {
    randomBytes: (size) => seed(0x54, size)
  })
  expectCode(t, () => substitution.exit.openControl(payload), 'INVALID_ROUTE')
  t.alike(substitution.exit.diagnostics(), { state: 'DESTROYED' })
  substitution.client.destroy()

  const tampered = pair()
  const corrupted = tampered.client.sealPayload(seed(0x55, 2), {
    randomBytes: (size) => seed(0x56, size)
  })
  corrupted[corrupted.byteLength - 1] ^= 1
  t.exception(() => tampered.exit.openPayload(corrupted))
  t.alike(tampered.exit.diagnostics(), { state: 'DESTROYED' })
  tampered.client.destroy()

  const oversize = pair()
  expectCode(
    t,
    () =>
      oversize.client.sealPayload(seed(0x57, 1074), {
        randomBytes: (size) => seed(0x58, size)
      }),
    'INVALID_ROUTE'
  )
  t.alike(oversize.client.diagnostics(), { state: 'DESTROYED' })
  oversize.exit.destroy()
})

test('route lifetime expiry and caught callback reentry fail closed', (t) => {
  let current = 1_000n
  const expired = pair(() => current)
  current = 10_000n
  expectCode(
    t,
    () =>
      expired.client.sealPayload(seed(0x61, 1), {
        randomBytes: (size) => seed(0x62, size)
      }),
    'ERR_PRIVACY_UNAVAILABLE'
  )
  t.alike(expired.client.diagnostics(), { state: 'DESTROYED' })
  expired.exit.destroy()

  const reentrant = pair()
  let reentryCode = null
  expectCode(
    t,
    () =>
      reentrant.client.sealPayload(seed(0x63, 1), {
        randomBytes(size) {
          try {
            reentrant.client.sealControl(seed(0x64, 1), {
              randomBytes: (length) => seed(0x65, length)
            })
          } catch (err) {
            reentryCode = err && err.code
          }
          return seed(0x66, size)
        }
      }),
    'INVALID_ROUTE'
  )
  t.is(reentryCode, 'ERR_BUSY')
  t.alike(reentrant.client.diagnostics(), { state: 'DESTROYED' })
  reentrant.exit.destroy()
})
