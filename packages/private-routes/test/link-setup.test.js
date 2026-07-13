import test from 'brittle'
import b4a from 'b4a'

import {
  CELL_CLASS,
  DOMAIN,
  PrivateRouteError,
  createLinkSetupAuthority,
  cryptoSuite
} from '../index.js'
import {
  TEST_ONLY_TICKET_OBSERVER,
  decodeLinkCreate,
  decodeLinkCreated,
  encodeLinkCreate,
  encodeLinkCreated,
  linkChallengeCipher,
  linkPossessionTag
} from '../lib/link-setup.js'
import { expectCode, seed } from './helpers.js'

function randomSequence(values) {
  let index = 0
  return (size) => {
    if (size !== 32 || index === values.length) throw new Error('unexpected random request')
    return b4a.alloc(32, values[index++])
  }
}

function shadowedAlias(value) {
  const alias = value.subarray(0)
  Object.defineProperty(alias, 'buffer', { value: new ArrayBuffer(value.byteLength) })
  Object.defineProperty(alias, 'byteOffset', { value: 0 })
  return alias
}

function fixture() {
  const initiatorIdentity = cryptoSuite.keyPair(seed(1))
  const responderIdentity = cryptoSuite.keyPair(seed(2))
  const responderStatic = cryptoSuite.encryptionKeyPair(seed(3))
  const observed = new Map()
  const authority = createLinkSetupAuthority({
    crypto: cryptoSuite,
    now: () => 1_000,
    randomBytes: randomSequence([4, 5]),
    [TEST_ONLY_TICKET_OBSERVER](ticket, value) {
      observed.set(ticket, value)
    }
  })
  const common = {
    circuitId: b4a.alloc(16, 0x11),
    epoch: 7n,
    initiatorIdentity: initiatorIdentity.publicKey,
    responderIdentity: responderIdentity.publicKey,
    initiatorLocalId: b4a.alloc(16, 0x12),
    responderLocalId: b4a.alloc(16, 0x13),
    expiresAt: 2_000n
  }

  function start(overrides = {}) {
    return authority.initiate({
      ...common,
      responderStaticKey: responderStatic.publicKey,
      initiatorIdentitySecretKey: initiatorIdentity.secretKey,
      ...overrides
    })
  }

  function respond(message, overrides = {}) {
    return authority.respond(message, {
      ...common,
      responderStaticSecretKey: responderStatic.secretKey,
      responderIdentitySecretKey: responderIdentity.secretKey,
      ...overrides
    })
  }

  return {
    authority,
    observed,
    common,
    initiatorIdentity,
    responderIdentity,
    responderStatic,
    start,
    respond
  }
}

test('link challenge and possession known-answer vectors are locked', (t) => {
  const sharedSecret = seed(3)
  const baseHash = seed(4)
  const challenge = seed(5)
  const createHash = seed(6)

  t.is(
    b4a.toString(linkChallengeCipher(sharedSecret, baseHash, challenge), 'hex'),
    '6f712676663138cab149aaaa580a96d2599559a900e6f1985a13f760845f10acbd15b7e929ca7fc3c7bcbb7d687f936b'
  )
  t.is(
    b4a.toString(linkPossessionTag(sharedSecret, baseHash, challenge, createHash), 'hex'),
    '8106cf71313cef2ab00f781e97a2db30'
  )
  t.is(
    b4a.toString(
      cryptoSuite.hash([DOMAIN.LINK_CREATED, seed(6), seed(7), b4a.from([CELL_CLASS.CONTROL])]),
      'hex'
    ),
    'ecb723d81ec8aafec62e286aa33206afc9bb8d893bb633dc0e0abbfd340bd99f'
  )
})

test('authenticated link setup agrees on six peer contexts without exposing tickets', (t) => {
  const f = fixture()
  const started = f.start()
  const accepted = f.respond(started.message)
  const initiatorTicket = f.authority.complete(started.pending, accepted.message)
  const initiator = f.observed.get(initiatorTicket)
  const responder = f.observed.get(accepted.ticket)

  t.alike(Object.keys(initiatorTicket), [])
  t.alike(Object.keys(accepted.ticket), [])
  t.is('key' in initiatorTicket, false)
  t.alike(initiator.localIdentity, f.common.initiatorIdentity)
  t.alike(responder.localIdentity, f.common.responderIdentity)

  const keys = []
  const noncePrefixes = []
  const counters = []
  for (const cellClass of [CELL_CLASS.CONTROL, CELL_CLASS.STREAM, CELL_CLASS.DATAGRAM]) {
    const left = initiator.contexts[cellClass]
    const right = responder.contexts[cellClass]
    t.alike(left.tx.key, right.rx.key)
    t.alike(left.tx.noncePrefix, right.rx.noncePrefix)
    t.alike(left.rx.key, right.tx.key)
    t.alike(left.rx.noncePrefix, right.tx.noncePrefix)
    t.is(left.tx.counter === right.tx.counter, false)
    t.is(left.rx.counter === right.rx.counter, false)
    keys.push(left.tx.key, left.rx.key)
    noncePrefixes.push(left.tx.noncePrefix, left.rx.noncePrefix)
    counters.push(left.tx.counter, left.rx.counter, right.tx.counter, right.rx.counter)
  }

  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) t.is(b4a.equals(keys[i], keys[j]), false)
  }
  for (let i = 0; i < noncePrefixes.length; i++) {
    for (let j = i + 1; j < noncePrefixes.length; j++) {
      t.is(b4a.equals(noncePrefixes[i], noncePrefixes[j]), false)
    }
  }
  t.is(new Set(counters).size, 12)
})

test('link setup uses different material for every adjacency', (t) => {
  const first = fixture()
  const firstStart = first.start()
  const firstAccepted = first.respond(firstStart.message)
  const firstTicket = first.authority.complete(firstStart.pending, firstAccepted.message)

  const second = fixture()
  const secondStart = second.start({ circuitId: b4a.alloc(16, 0x21) })
  const secondAccepted = second.respond(secondStart.message, {
    circuitId: b4a.alloc(16, 0x21)
  })
  const secondTicket = second.authority.complete(secondStart.pending, secondAccepted.message)

  const left = first.observed.get(firstTicket)
  const right = second.observed.get(secondTicket)
  const leftContexts = []
  const rightContexts = []
  for (const cellClass of [0, 1, 2]) {
    leftContexts.push(left.contexts[cellClass].tx, left.contexts[cellClass].rx)
    rightContexts.push(right.contexts[cellClass].tx, right.contexts[cellClass].rx)
  }
  for (const leftContext of leftContexts) {
    for (const rightContext of rightContexts) {
      t.is(b4a.equals(leftContext.key, rightContext.key), false)
      t.is(b4a.equals(leftContext.noncePrefix, rightContext.noncePrefix), false)
    }
  }
})

test('responder rejects forged identity signatures before challenge decryption', (t) => {
  const f = fixture()
  const started = f.start()
  const value = decodeLinkCreate(started.message)
  value.initiatorIdentitySignature[0] ^= 1
  let opens = 0
  const crypto = { ...cryptoSuite, open: (...args) => (opens++, cryptoSuite.open(...args)) }
  const authority = createLinkSetupAuthority({
    crypto,
    now: () => 1_000,
    randomBytes: randomSequence([9])
  })

  expectCode(
    t,
    () =>
      authority.respond(encodeLinkCreate(value), {
        ...f.common,
        responderStaticSecretKey: f.responderStatic.secretKey,
        responderIdentitySecretKey: f.responderIdentity.secretKey
      }),
    'UNAUTHORIZED'
  )
  t.is(opens, 0)
})

test('link setup fails closed on identity, ids, epoch, expiry, static key, and replay', (t) => {
  for (const [name, override] of [
    ['initiatorIdentity', { initiatorIdentity: seed(91) }],
    ['responderIdentity', { responderIdentity: seed(92) }],
    ['initiatorLocalId', { initiatorLocalId: b4a.alloc(16, 93) }],
    ['responderLocalId', { responderLocalId: b4a.alloc(16, 94) }],
    ['epoch', { epoch: 8n }],
    ['expiresAt', { expiresAt: 2_001n }]
  ]) {
    const f = fixture()
    const started = f.start()
    expectCode(t, () => f.respond(started.message, override), 'INVALID_ROUTE')
    t.pass(name)
  }

  const wrongStatic = fixture()
  const started = wrongStatic.start({ responderStaticKey: seed(99) })
  expectCode(t, () => wrongStatic.respond(started.message), 'UNAUTHORIZED')

  const replay = fixture()
  const replayStart = replay.start()
  replay.respond(replayStart.message)
  expectCode(t, () => replay.respond(replayStart.message), 'REPLAY')
})

test('initiator rejects responder transcript, signature, possession, and ephemeral mutations', (t) => {
  for (const mutate of [
    (value) => (value.responderIdentitySignature[0] ^= 1),
    (value) => (value.staticPossessionTag[0] ^= 1),
    (value) => (value.responderEphemeralKey[0] ^= 1),
    (value) => (value.createHash[0] ^= 1),
    (value) => (value.epoch += 1n),
    (value) => (value.responderLocalId[0] ^= 1)
  ]) {
    const f = fixture()
    const started = f.start()
    const accepted = f.respond(started.message)
    const value = decodeLinkCreated(accepted.message)
    mutate(value)
    expectCode(
      t,
      () => f.authority.complete(started.pending, encodeLinkCreated(value)),
      'UNAUTHORIZED'
    )
    expectCode(t, () => f.authority.complete(started.pending, accepted.message), 'REPLAY')
  }
})

test('expired links and malformed messages fail with stable private-route errors', (t) => {
  const f = fixture()
  const started = f.start({ expiresAt: 999n })
  expectCode(t, () => f.respond(started.message, { expiresAt: 999n }), 'INVALID_ROUTE')

  for (const malformed of [null, {}, b4a.alloc(0), b4a.alloc(272), b4a.alloc(274)]) {
    let error = null
    try {
      f.respond(malformed)
    } catch (err) {
      error = err
    }
    t.ok(error instanceof PrivateRouteError)
  }
})

test('hostile crypto method getters are normalized to private-route errors', (t) => {
  const crypto = { ...cryptoSuite }
  Object.defineProperty(crypto, 'randomBytes', {
    get() {
      throw new Error('hostile getter')
    }
  })

  expectCode(t, () => createLinkSetupAuthority({ crypto, now: () => 1_000 }), 'INVALID_ROUTE')
})

test('sign adapter output cannot alias and erase a caller identity secret', (t) => {
  const f = fixture()
  const secret = b4a.from(f.initiatorIdentity.secretKey)
  const crypto = {
    ...cryptoSuite,
    sign(_message, secretKey) {
      return secretKey
    }
  }
  const authority = createLinkSetupAuthority({
    crypto,
    now: () => 1_000,
    randomBytes: randomSequence([31])
  })

  let result = null
  expectCode(
    t,
    () => {
      result = authority.initiate({
        ...f.common,
        responderStaticKey: f.responderStatic.publicKey,
        initiatorIdentitySecretKey: f.initiatorIdentity.secretKey
      })
    },
    'INVALID_ROUTE'
  )

  t.is(result, null)
  t.alike(f.initiatorIdentity.secretKey, secret)
})

test('key-agreement adapter output cannot alias and erase a caller static secret', (t) => {
  const f = fixture()
  const started = f.start()
  const secret = b4a.from(f.responderStatic.secretKey)
  let derives = 0
  const crypto = {
    ...cryptoSuite,
    keyAgreement(secretKey) {
      return secretKey
    },
    deriveKeys(...args) {
      derives++
      return cryptoSuite.deriveKeys(...args)
    }
  }
  const authority = createLinkSetupAuthority({
    crypto,
    now: () => 1_000,
    randomBytes: randomSequence([32])
  })

  expectCode(
    t,
    () =>
      authority.respond(started.message, {
        ...f.common,
        responderStaticSecretKey: f.responderStatic.secretKey,
        responderIdentitySecretKey: f.responderIdentity.secretKey
      }),
    'UNAUTHORIZED'
  )

  t.is(derives, 0)
  t.alike(f.responderStatic.secretKey, secret)
})

test('sign rejects an aliased identity secret with shadowed extent properties', (t) => {
  const f = fixture()
  const secret = b4a.from(f.initiatorIdentity.secretKey)
  const crypto = {
    ...cryptoSuite,
    sign(_message, secretKey) {
      return shadowedAlias(secretKey)
    }
  }
  const authority = createLinkSetupAuthority({
    crypto,
    now: () => 1_000,
    randomBytes: randomSequence([33])
  })

  expectCode(
    t,
    () =>
      authority.initiate({
        ...f.common,
        responderStaticKey: f.responderStatic.publicKey,
        initiatorIdentitySecretKey: f.initiatorIdentity.secretKey
      }),
    'INVALID_ROUTE'
  )
  t.alike(f.initiatorIdentity.secretKey, secret)
})

test('key agreement rejects an aliased static secret with shadowed extent properties', (t) => {
  const f = fixture()
  const started = f.start()
  const secret = b4a.from(f.responderStatic.secretKey)
  const crypto = {
    ...cryptoSuite,
    keyAgreement(secretKey) {
      return shadowedAlias(secretKey)
    }
  }
  const authority = createLinkSetupAuthority({
    crypto,
    now: () => 1_000,
    randomBytes: randomSequence([34])
  })

  expectCode(
    t,
    () =>
      authority.respond(started.message, {
        ...f.common,
        responderStaticSecretKey: f.responderStatic.secretKey,
        responderIdentitySecretKey: f.responderIdentity.secretKey
      }),
    'UNAUTHORIZED'
  )
  t.alike(f.responderStatic.secretKey, secret)
})

test('ephemeral key-pair adapter fields are snapshotted exactly once', (t) => {
  const f = fixture()
  const reads = { publicKey: 0, secretKey: 0 }
  const crypto = {
    ...cryptoSuite,
    encryptionKeyPair(seedValue) {
      const pair = cryptoSuite.encryptionKeyPair(seedValue)
      return Object.defineProperties(
        {},
        {
          publicKey: {
            get() {
              if (++reads.publicKey > 1) throw new Error('publicKey read twice')
              return pair.publicKey
            }
          },
          secretKey: {
            get() {
              if (++reads.secretKey > 1) throw new Error('secretKey read twice')
              return pair.secretKey
            }
          }
        }
      )
    }
  }
  const authority = createLinkSetupAuthority({
    crypto,
    now: () => 1_000,
    randomBytes: randomSequence([35])
  })

  const started = authority.initiate({
    ...f.common,
    responderStaticKey: f.responderStatic.publicKey,
    initiatorIdentitySecretKey: f.initiatorIdentity.secretKey
  })

  t.is(started.message.byteLength, 273)
  t.alike(reads, { publicKey: 1, secretKey: 1 })
})

test('derived-key adapter fields are snapshotted exactly once', (t) => {
  const f = fixture()
  const reads = {
    forwardKey: 0,
    reverseKey: 0,
    forwardNoncePrefix: 0,
    reverseNoncePrefix: 0
  }
  const crypto = {
    ...cryptoSuite,
    deriveKeys(...args) {
      const keys = cryptoSuite.deriveKeys(...args)
      const result = {}
      for (const name of Object.keys(reads)) {
        Object.defineProperty(result, name, {
          get() {
            if (++reads[name] > 1) throw new Error(`${name} read twice`)
            return keys[name]
          }
        })
      }
      return result
    }
  }
  const authority = createLinkSetupAuthority({
    crypto,
    now: () => 1_000,
    randomBytes: randomSequence([36])
  })

  const started = authority.initiate({
    ...f.common,
    responderStaticKey: f.responderStatic.publicKey,
    initiatorIdentitySecretKey: f.initiatorIdentity.secretKey
  })

  t.is(started.message.byteLength, 273)
  t.alike(reads, {
    forwardKey: 1,
    reverseKey: 1,
    forwardNoncePrefix: 1,
    reverseNoncePrefix: 1
  })
})

test('hash rejects a shadowed alias before deriving from its input', (t) => {
  const f = fixture()
  let aliased = false
  let derives = 0
  const crypto = {
    ...cryptoSuite,
    hash(parts) {
      const part = parts.find((value) => b4a.isBuffer(value) && value.byteLength === 32)
      if (!aliased && part) {
        aliased = true
        return shadowedAlias(part)
      }
      return cryptoSuite.hash(parts)
    },
    deriveKeys(...args) {
      derives++
      return cryptoSuite.deriveKeys(...args)
    }
  }
  const authority = createLinkSetupAuthority({
    crypto,
    now: () => 1_000,
    randomBytes: randomSequence([37])
  })

  expectCode(
    t,
    () =>
      authority.initiate({
        ...f.common,
        responderStaticKey: f.responderStatic.publicKey,
        initiatorIdentitySecretKey: f.initiatorIdentity.secretKey
      }),
    'INVALID_ROUTE'
  )
  t.is(derives, 0)
})
