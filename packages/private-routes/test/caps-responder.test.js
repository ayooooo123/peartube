import test from 'brittle'
import b4a from 'b4a'

import * as routes from '../index.js'
import {
  CAPACITY_CLASS,
  M3_MESSAGE_ID,
  RELAY_CAPABILITY,
  ROLE,
  RelayCapabilityDirectory,
  cryptoSuite,
  decodeM3Object,
  decodeRelayCapabilityAdvertisement,
  deriveM3DhtNodeId,
  digestRelayCapabilityAdvertisement,
  encodeCanonicalEndpoint,
  encodeM3Object,
  encodeRelayCapabilityAdvertisement,
  providerServicePolicyForCapabilities,
  roleForIdentity,
  signRelayCapabilityAdvertisement
} from '../index.js'
import { CapsResponder } from '../lib/caps-responder.js'
import { expectCode, seed } from './helpers.js'

const NOW = 1_000_000n
const CAPS_RESPONSE_DOMAIN = b4a.from('hyperdht-private-routes/m3/caps-response/v1')
const FRAGMENT_DOMAIN = b4a.from('hyperdht-private-routes/m3/core-fragment/object/v1')

function fakeClock(start = NOW) {
  let now = start
  let next = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = ++next
      timers.set(id, { at: now + BigInt(delay), callback })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    advance(delay) {
      now += BigInt(delay)
      for (const [id, timer] of timers) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.callback()
      }
    },
    jump(delay) {
      now += BigInt(delay)
    },
    flush() {
      for (const [id, timer] of timers) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.callback()
      }
    }
  }
}

function endpoint(last, port = 49_737) {
  return encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, last]),
    port
  })
}

function identityForRole(role, start) {
  for (let value = start; value < start + 1_000; value++) {
    const pair = cryptoSuite.keyPair(seed(value))
    if (roleForIdentity(pair.publicKey) === role) return pair
  }
  throw new Error('identity role fixture unavailable')
}

function fixture({
  start = 10,
  endpointLast = 7,
  capabilityMask = RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
  epoch = 1n,
  expiresAtMs = NOW + 1_000_000n
} = {}) {
  const role = capabilityMask & RELAY_CAPABILITY.DHT_EXIT_V1 ? ROLE.PRIVATE : ROLE.SAFETY
  const identity = identityForRole(role, start)
  const route = cryptoSuite.encryptionKeyPair(seed(start + 2_000))
  const reachableEndpoint = endpoint(endpointLast)
  const value = {
    relayIdentity: identity.publicKey,
    currentDhtNodeId: deriveM3DhtNodeId(reachableEndpoint),
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
    maxConcurrentCircuits: 32,
    capacityClass: CAPACITY_CLASS.MEDIUM,
    maxCellsPerCircuit: 10_000,
    maxBytesPerCircuit: 10_000_000,
    maxCommandsPerCircuit: 256,
    idleTimeoutMs: 30_000,
    maxQueuedBytes: 262_144,
    epoch,
    issuedAtMs: NOW,
    expiresAtMs,
    providerServicePolicyEntries: providerServicePolicyForCapabilities(capabilityMask)
  }
  const encoded = encodeRelayCapabilityAdvertisement(
    signRelayCapabilityAdvertisement(value, identity.secretKey)
  )
  return { encoded, identity, route, value }
}

function writeUint32(output, value, offset) {
  output[offset] = value >>> 24
  output[offset + 1] = value >>> 16
  output[offset + 2] = value >>> 8
  output[offset + 3] = value
}

function writeUint64(output, value, offset) {
  for (let index = 7; index >= 0; index--) {
    output[offset + index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function readUint16(input, offset) {
  return (input[offset] << 8) | input[offset + 1]
}

function readUint32(input, offset) {
  return (
    input[offset] * 0x1000000 +
    (input[offset + 1] << 16) +
    (input[offset + 2] << 8) +
    input[offset + 3]
  )
}

function readUint64(input, offset) {
  let value = 0n
  for (let index = 0; index < 8; index++) value = (value << 8n) | BigInt(input[offset + index])
  return value
}

function phase0({
  mask = RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
  target = seed(90),
  nonce = seed(91),
  maximumResults = 8
} = {}) {
  const body = b4a.alloc(110)
  writeUint32(body, mask, 0)
  body.set(target, 4)
  body.set(nonce, 36)
  body[68] = maximumResults
  return encodeM3Object({ messageId: M3_MESSAGE_ID.CAPS_QUERY_V1, body })
}

function phase1(initial, challenge) {
  const query = decodeM3Object(initial)
  const cookie = decodeM3Object(challenge)
  const body = b4a.from(query.body)
  body[69] = 1
  body.set(cookie.body.subarray(32, 40), 70)
  body.set(cookie.body.subarray(40, 72), 78)
  return encodeM3Object({ messageId: M3_MESSAGE_ID.CAPS_QUERY_V1, body })
}

function signatureInput(domain, messageId, body) {
  const input = b4a.allocUnsafe(2 + domain.byteLength + 8 + body.byteLength)
  input[0] = domain.byteLength >>> 8
  input[1] = domain.byteLength
  input.set(domain, 2)
  writeUint32(input, 1, 2 + domain.byteLength)
  input[6 + domain.byteLength] = messageId >>> 8
  input[7 + domain.byteLength] = messageId
  input[8 + domain.byteLength] = body.byteLength >>> 8
  input[9 + domain.byteLength] = body.byteLength
  input.set(body, 10 + domain.byteLength)
  return input
}

function parseResponse(datagrams) {
  if (datagrams.length === 1) {
    const object = decodeM3Object(datagrams[0])
    if (object.messageId === M3_MESSAGE_ID.CAPS_RESPONSE_V1) return datagrams[0]
  }
  const pieces = []
  let total = null
  let digest = null
  let count = null
  for (const datagram of datagrams) {
    tassert(datagram.byteLength <= 1_200)
    const object = decodeM3Object(datagram)
    tassert(object.messageId === M3_MESSAGE_ID.CORE_FRAGMENT_V1)
    const body = object.body
    tassert(readUint16(body, 0) === M3_MESSAGE_ID.CAPS_RESPONSE_V1)
    total ??= readUint32(body, 34)
    digest ??= b4a.from(body.subarray(2, 34))
    count ??= readUint16(body, 40)
    const index = readUint16(body, 38)
    const offset = readUint32(body, 42)
    const bytes = readUint16(body, 46)
    tassert(count === Math.ceil(total / 1_144))
    tassert(offset === index * 1_144)
    tassert(bytes === body.byteLength - 48)
    tassert(bytes === (index === count - 1 ? total - offset : 1_144))
    pieces[index] = b4a.from(body.subarray(48))
  }
  tassert(pieces.length === count)
  const complete = b4a.concat(pieces)
  tassert(complete.byteLength === total)
  tassert(b4a.equals(cryptoSuite.hash([FRAGMENT_DOMAIN, complete]), digest))
  return complete
}

function parseAdvertisements(response) {
  const object = decodeM3Object(response)
  const body = object.body
  const advertisements = []
  let offset = 73
  for (let index = 0; index < body[72]; index++) {
    const bytes = readUint16(body, offset)
    offset += 2
    advertisements.push(b4a.from(body.subarray(offset, offset + bytes)))
    offset += bytes
  }
  tassert(offset === body.byteLength)
  return { advertisements, object }
}

function tassert(value) {
  if (!value) throw new Error('invalid test fixture')
}

function responder(fixture, options = {}) {
  return new CapsResponder({
    now: options.clock?.now ?? (() => NOW),
    setTimeout: options.clock?.setTimeout,
    clearTimeout: options.clock?.clearTimeout,
    advertisement: fixture.encoded,
    identitySecretKey: fixture.identity.secretKey,
    routeEncryptionSecretKey: fixture.route.secretKey,
    ...options
  })
}

test('CAPS responder exposes only its narrow canonical datagram authority', (t) => {
  t.is(routes.CapsResponder, CapsResponder)
  const self = fixture()
  const caps = responder(self)
  for (const name of ['query', 'request', 'send', 'fragment', 'sign', 'issueCookie']) {
    t.is(caps[name], undefined)
  }
  caps.destroy()
})

test('CAPS phase 0 emits only the exact smaller stateless cookie challenge', (t) => {
  const self = fixture()
  let selections = 0
  let signatures = 0
  const crypto = {
    ...cryptoSuite,
    sign(input, secretKey) {
      signatures++
      return cryptoSuite.sign(input, secretKey)
    }
  }
  const caps = responder(self, {
    crypto,
    selectAdvertisements() {
      selections++
      return [self.encoded]
    }
  })
  signatures = 0
  const query = phase0()
  const [challenge] = caps.receive(query, endpoint(240))
  const object = decodeM3Object(challenge)

  t.is(query.byteLength, 118)
  t.is(challenge.byteLength, 80)
  t.is(object.messageId, M3_MESSAGE_ID.CAPS_COOKIE_CHALLENGE_V1)
  t.alike(object.body.subarray(0, 32), seed(91))
  t.is(readUint64(object.body, 32), NOW + 5_000n)
  t.absent(b4a.equals(object.body.subarray(40), b4a.alloc(32)))
  t.is(selections, 0)
  t.is(signatures, 0)
  caps.destroy()
})

test('invalid and hostile pre-cookie datagrams fail closed without bulk work or signing', (t) => {
  const self = fixture()
  let selections = 0
  let signatures = 0
  const caps = responder(self, {
    crypto: {
      ...cryptoSuite,
      sign(input, secretKey) {
        signatures++
        return cryptoSuite.sign(input, secretKey)
      }
    },
    selectAdvertisements() {
      selections++
      return [self.encoded]
    }
  })
  signatures = 0
  const invalidPhase = phase0()
  invalidPhase[8 + 69] = 2
  const nonzeroCookie = phase0()
  nonzeroCookie[8 + 109] = 1
  const proxy = new Proxy(b4a.alloc(118), {
    get() {
      throw new Error('hostile getter')
    }
  })

  for (const datagram of [
    b4a.alloc(0),
    b4a.alloc(20),
    b4a.alloc(1_201),
    invalidPhase,
    nonzeroCookie,
    proxy
  ]) {
    t.alike(caps.receive(datagram, endpoint(240)), [])
  }
  t.alike(caps.receive(phase0(), b4a.alloc(19)), [])
  t.is(selections, 0)
  t.is(signatures, 0)
  caps.destroy()
})

test('cookie-authenticated CAPS response is signed, query-bound, self-bearing, and canonical', (t) => {
  const self = fixture({ start: 100, endpointLast: 7, epoch: 3n })
  const otherA = fixture({ start: 200, endpointLast: 8, epoch: 4n })
  const otherB = fixture({ start: 300, endpointLast: 9, epoch: 2n })
  let selections = 0
  const caps = responder(self, {
    selectAdvertisements(query) {
      selections++
      t.is(query.requestedCapabilityMask, RELAY_CAPABILITY.CIRCUIT_RELAY_V1)
      return [otherB.encoded, self.encoded, otherA.encoded]
    }
  })
  const source = endpoint(240)
  const initial = phase0({ maximumResults: 3 })
  const [challenge] = caps.receive(initial, source)
  const retry = phase1(initial, challenge)
  const wire = parseResponse(caps.receive(retry, source))
  const { advertisements, object } = parseAdvertisements(wire)

  t.is(selections, 1)
  t.is(object.messageId, M3_MESSAGE_ID.CAPS_RESPONSE_V1)
  t.alike(object.body.subarray(0, 32), self.identity.publicKey)
  t.alike(object.body.subarray(32, 64), seed(91))
  t.is(readUint64(object.body, 64), NOW)
  t.is(advertisements.length, 3)
  t.ok(
    cryptoSuite.verify(
      signatureInput(CAPS_RESPONSE_DOMAIN, M3_MESSAGE_ID.CAPS_RESPONSE_V1, object.body),
      object.authSuffix,
      self.identity.publicKey
    )
  )

  const decoded = advertisements.map((encoded) => decodeRelayCapabilityAdvertisement(encoded))
  const expected = [self, otherA, otherB].slice().sort((left, right) => {
    for (let index = 0; index < 32; index++) {
      const a = seed(90)[index] ^ left.value.currentDhtNodeId[index]
      const b = seed(90)[index] ^ right.value.currentDhtNodeId[index]
      if (a !== b) return a - b
    }
    return b4a.compare(left.identity.publicKey, right.identity.publicKey)
  })
  t.alike(
    decoded.map((advertisement) => advertisement.relayIdentity),
    expected.map((entry) => entry.identity.publicKey)
  )
  caps.destroy()
})

test('exact phase-1 replay is byte-identical and conflicting reuse is silent', (t) => {
  const self = fixture()
  let selections = 0
  let signatures = 0
  const caps = responder(self, {
    crypto: {
      ...cryptoSuite,
      sign(input, secretKey) {
        signatures++
        return cryptoSuite.sign(input, secretKey)
      }
    },
    selectAdvertisements() {
      selections++
      return [self.encoded]
    }
  })
  signatures = 0
  const source = endpoint(240)
  const initial = phase0({ maximumResults: 1 })
  const [challenge] = caps.receive(initial, source)
  const retry = phase1(initial, challenge)
  const first = caps.receive(retry, source)
  const pristine = first.map((datagram) => b4a.from(datagram))
  first[0].fill(0)
  const replay = caps.receive(retry, source)

  t.alike(replay, pristine)
  t.is(selections, 1)
  t.is(signatures, 1)
  t.alike(caps.receive(retry, endpoint(241)), [])
  const conflict = b4a.from(retry)
  conflict[8 + 4] ^= 1
  t.alike(caps.receive(conflict, source), [])
  t.is(selections, 1)
  t.is(signatures, 1)
  caps.destroy()
})

test('same-cookie reentry from active admission is refused before responder callbacks', (t) => {
  const self = fixture()
  const baseClock = fakeClock()
  let caps = null
  let retry = null
  let source = null
  let armed = false
  let calls = 0
  let nested = null
  const clock = {
    ...baseClock,
    now() {
      if (armed && ++calls === 2) nested = caps.receive(retry, source)
      return baseClock.now()
    }
  }
  caps = responder(self, { clock, maxReplayEntries: 1 })
  source = endpoint(240)
  const initial = phase0({ maximumResults: 1 })
  const [challenge] = caps.receive(initial, source)
  retry = phase1(initial, challenge)
  armed = true
  const response = caps.receive(retry, source)

  t.alike(nested, [])
  t.is(response.length, 1)
  t.is(caps._responses.size, 1)
  t.alike(caps.receive(retry, source), response)
  caps.destroy()
})

test('same-cookie reentry from advertisement selection is refused exactly once', (t) => {
  const self = fixture()
  const source = endpoint(240)
  let caps = null
  let retry = null
  let armed = false
  let nested = null
  let selections = 0
  caps = responder(self, {
    maxReplayEntries: 1,
    selectAdvertisements() {
      selections++
      if (armed) {
        armed = false
        nested = caps.receive(retry, source)
      }
      return [self.encoded]
    }
  })
  const initial = phase0({ maximumResults: 1 })
  const [challenge] = caps.receive(initial, source)
  retry = phase1(initial, challenge)
  armed = true
  const response = caps.receive(retry, source)

  t.alike(nested, [])
  t.is(response.length, 1)
  t.is(selections, 1)
  t.is(caps._responses.size, 1)
  t.alike(caps.receive(retry, source), response)
  t.is(selections, 1)
  caps.destroy()
})

test('same-cookie reentry from response sign and fragment hash is refused exactly once', (t) => {
  for (const hook of ['sign', 'hash']) {
    const capabilityMask =
      RELAY_CAPABILITY.CIRCUIT_RELAY_V1 |
      RELAY_CAPABILITY.DHT_EXIT_V1 |
      RELAY_CAPABILITY.PRIVATE_RECORDS_V1
    const fixtures = Array.from({ length: hook === 'hash' ? 8 : 1 }, (_, index) =>
      fixture({
        start: 1_200 + index * 20,
        endpointLast: 30 + index,
        capabilityMask
      })
    )
    const self = fixtures[0]
    const source = endpoint(240)
    let caps = null
    let retry = null
    let armed = false
    let nested = null
    let calls = 0
    const crypto = {
      ...cryptoSuite,
      sign(input, secretKey) {
        if (hook === 'sign') {
          calls++
          if (armed) {
            armed = false
            nested = caps.receive(retry, source)
          }
        }
        return cryptoSuite.sign(input, secretKey)
      },
      hash(inputs) {
        if (hook === 'hash') {
          calls++
          if (armed) {
            armed = false
            nested = caps.receive(retry, source)
          }
        }
        return cryptoSuite.hash(inputs)
      }
    }
    caps = responder(self, {
      crypto,
      maxReplayEntries: 1,
      selectAdvertisements: () => fixtures.map((value) => value.encoded)
    })
    const initial = phase0({ mask: capabilityMask, maximumResults: fixtures.length })
    const [challenge] = caps.receive(initial, source)
    retry = phase1(initial, challenge)
    armed = true
    const response = caps.receive(retry, source)

    t.alike(nested, [], `${hook} reentry is silent`)
    t.ok(response.length >= 1, `${hook} outer response succeeds`)
    t.is(calls, 1, `${hook} executes once`)
    t.is(caps._responses.size, 1, `${hook} installs one response`)
    t.alike(caps.receive(retry, source), response, `${hook} replay is exact`)
    t.is(calls, 1, `${hook} replay does not recompute`)
    caps.destroy()
  }
})

test('failed response installation erases every unowned response copy', (t) => {
  const self = fixture()
  const caps = responder(self)
  let rejected = null
  caps._responses = new (class RefusingResponses extends Map {
    set(key, value) {
      rejected = value
      super.set(key, value)
      throw new Error('install failed')
    }
  })()
  const source = endpoint(240)
  const initial = phase0({ maximumResults: 1 })
  const [challenge] = caps.receive(initial, source)
  const retry = phase1(initial, challenge)

  t.alike(caps.receive(retry, source), [])
  t.ok(rejected)
  t.is(caps._responses.size, 0)
  t.is(caps._pendingResponses.size, 0)
  t.alike(rejected.retry, b4a.alloc(118))
  t.alike(rejected.sourceEndpoint, b4a.alloc(19))
  t.alike(rejected.queryNonce, b4a.alloc(32))
  t.alike(rejected.returnRoutabilityCookie, b4a.alloc(32))
  t.alike(rejected.datagrams, [])
  caps._responses = new Map()
  t.is(caps.receive(retry, source).length, 1)
  t.is(caps._pendingResponses.size, 0)
  caps.destroy()
})

test('CAPS retry destroy from active selection sign and hash callbacks is terminal', (t) => {
  for (const hook of ['active', 'select', 'sign', 'hash']) {
    const capabilityMask =
      RELAY_CAPABILITY.CIRCUIT_RELAY_V1 |
      RELAY_CAPABILITY.DHT_EXIT_V1 |
      RELAY_CAPABILITY.PRIVATE_RECORDS_V1
    const fixtures = Array.from({ length: hook === 'hash' ? 8 : 1 }, (_, index) =>
      fixture({
        start: 1_500 + index * 20,
        endpointLast: 50 + index,
        capabilityMask
      })
    )
    const self = fixtures[0]
    const baseClock = fakeClock()
    const source = endpoint(240)
    let caps = null
    let armed = false
    let clockCalls = 0
    let selectedTarget = null
    let selectedNonce = null
    let signedInput = null
    let generatedSignature = null
    let generatedDigest = null
    const clock = {
      ...baseClock,
      now() {
        if (armed && hook === 'active' && ++clockCalls === 2) caps.destroy()
        return baseClock.now()
      }
    }
    const crypto = {
      ...cryptoSuite,
      sign(input, secretKey) {
        const signature = cryptoSuite.sign(input, secretKey)
        if (armed && hook === 'sign') {
          signedInput = input
          generatedSignature = signature
          caps.destroy()
        }
        return signature
      },
      hash(inputs) {
        const digest = cryptoSuite.hash(inputs)
        if (armed && hook === 'hash') {
          generatedDigest = digest
          caps.destroy()
        }
        return digest
      }
    }
    caps = responder(self, {
      clock,
      crypto,
      maxReplayEntries: 1,
      selectAdvertisements(query) {
        if (armed && hook === 'select') {
          selectedTarget = query.randomTarget
          selectedNonce = query.queryNonce
          caps.destroy()
        }
        return fixtures.map((value) => value.encoded)
      }
    })
    const initial = phase0({ mask: capabilityMask, maximumResults: fixtures.length })
    const [challenge] = caps.receive(initial, source)
    const retry = phase1(initial, challenge)
    armed = true

    expectCode(t, () => caps.receive(retry, source), 'ERR_DESTROYED')
    t.is(caps._responses.size, 0, `${hook} cannot publish a response`)
    t.is(caps._pendingResponses.size, 0, `${hook} cannot retain a reservation`)
    if (selectedTarget) t.alike(selectedTarget, b4a.alloc(32), 'selection target is erased')
    if (selectedNonce) t.alike(selectedNonce, b4a.alloc(32), 'selection nonce is erased')
    if (signedInput) t.alike(signedInput, b4a.alloc(signedInput.byteLength), 'sign input is erased')
    if (generatedSignature) {
      t.alike(generatedSignature, b4a.alloc(64), 'generated signature is erased')
    }
    if (generatedDigest) t.alike(generatedDigest, b4a.alloc(32), 'fragment digest is erased')
    caps.destroy()
  }
})

test('phase-0 destroy from outer and active clocks is terminal', (t) => {
  for (const destroyAtCall of [1, 2]) {
    const self = fixture({ start: 1_700 + destroyAtCall * 20 })
    const baseClock = fakeClock()
    let caps = null
    let armed = false
    let calls = 0
    const clock = {
      ...baseClock,
      now() {
        if (armed && ++calls === destroyAtCall) caps.destroy()
        return baseClock.now()
      }
    }
    caps = responder(self, { clock })
    armed = true

    expectCode(t, () => caps.receive(phase0(), endpoint(240)), 'ERR_DESTROYED')
    t.is(caps._responses.size, 0)
    t.is(caps._pendingResponses.size, 0)
    caps.destroy()
  }
})

test('active challenge destroy from authority callbacks cannot publish response bytes', (t) => {
  for (const hook of ['now', 'random', 'agreement', 'sign']) {
    const self = fixture({
      start: 1_800 + ['now', 'random', 'agreement', 'sign'].indexOf(hook) * 20
    })
    const baseClock = fakeClock()
    const source = endpoint(240)
    let caps = null
    let armed = false
    let clockCalls = 0
    const clock = {
      ...baseClock,
      now() {
        if (armed && hook === 'now' && ++clockCalls === 2) caps.destroy()
        return baseClock.now()
      }
    }
    const crypto = {
      ...cryptoSuite,
      randomBytes(size) {
        const value = cryptoSuite.randomBytes(size)
        if (armed && hook === 'random') caps.destroy()
        return value
      },
      keyAgreement(publicKey, secretKey) {
        const value = cryptoSuite.keyAgreement(publicKey, secretKey)
        if (armed && hook === 'agreement') caps.destroy()
        return value
      },
      sign(input, secretKey) {
        const value = cryptoSuite.sign(input, secretKey)
        if (armed && hook === 'sign') caps.destroy()
        return value
      }
    }
    caps = responder(self, { clock, crypto })
    const initial = phase0({ maximumResults: 1 })
    const [challenge] = caps.receive(initial, source)
    caps.receive(phase1(initial, challenge), source)
    const cookieObject = decodeM3Object(challenge)
    const directory = new RelayCapabilityDirectory({
      now: baseClock.now,
      randomBytes: (size) => b4a.alloc(size, 0x71)
    })
    const candidate = directory.admit(self.encoded, {
      observedEndpoint: self.value.reachableEndpoint,
      capsBinding: {
        queryNonce: seed(91),
        cookieExpiresAtMs: readUint64(cookieObject.body, 32),
        returnRoutabilityCookie: cookieObject.body.subarray(40)
      }
    })
    const pending = directory.beginActiveChallenge(candidate)
    armed = true

    expectCode(t, () => caps.receive(pending.message, source), 'ERR_DESTROYED')
    t.is(caps._responses.size, 0, `${hook} destroy clears response authority`)
    t.is(caps._pendingResponses.size, 0, `${hook} destroy clears pending authority`)
    directory.destroy()
    caps.destroy()
  }
})

test('large authenticated CAPS responses use exact bounded CORE fragments', (t) => {
  const capabilityMask =
    RELAY_CAPABILITY.CIRCUIT_RELAY_V1 |
    RELAY_CAPABILITY.DHT_EXIT_V1 |
    RELAY_CAPABILITY.PRIVATE_RECORDS_V1
  const fixtures = Array.from({ length: 8 }, (_, index) =>
    fixture({ start: 500 + index * 20, endpointLast: 20 + index, capabilityMask })
  )
  const self = fixtures[0]
  const caps = responder(self, {
    selectAdvertisements: () =>
      fixtures
        .slice()
        .reverse()
        .map((x) => x.encoded)
  })
  const source = endpoint(240)
  const initial = phase0({ mask: capabilityMask, maximumResults: 8 })
  const [challenge] = caps.receive(initial, source)
  const datagrams = caps.receive(phase1(initial, challenge), source)
  const response = parseResponse(datagrams)
  const { advertisements } = parseAdvertisements(response)

  t.ok(datagrams.length > 1)
  t.ok(datagrams.length <= 11)
  t.ok(datagrams.every((datagram) => datagram.byteLength <= 1_200))
  t.ok(response.byteLength <= 4_545)
  t.is(advertisements.length, 8)
  caps.destroy()
})

test('active challenge response is bound to the live CAPS tuple and consumes once', (t) => {
  const self = fixture()
  const caps = responder(self)
  const source = endpoint(240)
  const initial = phase0({ maximumResults: 1 })
  const [challenge] = caps.receive(initial, source)
  const retry = phase1(initial, challenge)
  caps.receive(retry, source)
  const cookieObject = decodeM3Object(challenge)

  const directory = new RelayCapabilityDirectory({
    now: () => NOW,
    randomBytes: (size) => b4a.alloc(size, 0x61)
  })
  const candidate = directory.admit(self.encoded, {
    observedEndpoint: self.value.reachableEndpoint,
    capsBinding: {
      queryNonce: seed(91),
      cookieExpiresAtMs: readUint64(cookieObject.body, 32),
      returnRoutabilityCookie: cookieObject.body.subarray(40)
    }
  })
  const pending = directory.beginActiveChallenge(candidate)
  const [response] = caps.receive(pending.message, source)
  const validated = directory.completeActiveChallenge(pending, response, {
    observedEndpoint: self.value.reachableEndpoint
  })

  t.ok(directory.isValidated(validated))
  t.alike(caps.receive(pending.message, source), [])
  const substituted = b4a.from(pending.message)
  substituted[8 + 32] ^= 1
  t.alike(caps.receive(substituted, source), [])
  directory.destroy()
  caps.destroy()
})

test('selection cannot omit, duplicate, mismatch, or exceed the matching self advertisement', (t) => {
  const self = fixture()
  const other = fixture({ start: 700, endpointLast: 8 })
  const cases = [[], [other.encoded], [self.encoded, self.encoded], [self.encoded, other.encoded]]
  for (let index = 0; index < cases.length; index++) {
    const caps = responder(self, { selectAdvertisements: () => cases[index] })
    const source = endpoint(240)
    const initial = phase0({
      mask: index === 3 ? RELAY_CAPABILITY.PRIVATE_RECORDS_V1 : RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
      maximumResults: 1
    })
    const [challenge] = caps.receive(initial, source)
    t.alike(caps.receive(phase1(initial, challenge), source), [])
    caps.destroy()
  }
})

test('a locally faulty response signer cannot emit unauthenticated CAPS bytes', (t) => {
  const self = fixture()
  const caps = responder(self, {
    crypto: {
      ...cryptoSuite,
      sign: () => b4a.alloc(64)
    }
  })
  const source = endpoint(240)
  const initial = phase0({ maximumResults: 1 })
  const [challenge] = caps.receive(initial, source)

  t.alike(caps.receive(phase1(initial, challenge), source), [])
  caps.destroy()
})

test('cookie rotation accepts only the exact five-second prior-secret overlap and catches up', (t) => {
  const clock = fakeClock()
  const self = fixture({ expiresAtMs: NOW + 1_000_000n })
  const caps = responder(self, { clock })
  const source = endpoint(240)
  clock.advance(299_999)
  const initial = phase0({ nonce: seed(140), maximumResults: 1 })
  const [challenge] = caps.receive(initial, source)
  const retry = phase1(initial, challenge)
  clock.advance(2)
  t.is(caps.receive(retry, source).length, 1)

  const oldInitial = phase0({ nonce: seed(141), maximumResults: 1 })
  const [oldChallenge] = caps.receive(oldInitial, source)
  const oldRetry = phase1(oldInitial, oldChallenge)
  clock.jump(600_000)
  clock.flush()
  t.alike(caps.receive(oldRetry, source), [])
  caps.destroy()
})

test('phase-1 response and active-binding state share the configured bound and expire', (t) => {
  const clock = fakeClock()
  const self = fixture()
  const caps = responder(self, { clock, maxReplayEntries: 1 })
  const source = endpoint(240)
  const first = phase0({ nonce: seed(150), maximumResults: 1 })
  const second = phase0({ nonce: seed(151), maximumResults: 1 })
  const [firstCookie] = caps.receive(first, source)
  const [secondCookie] = caps.receive(second, source)
  t.is(caps.receive(phase1(first, firstCookie), source).length, 1)
  t.alike(caps.receive(phase1(second, secondCookie), source), [])

  clock.advance(5_001)
  const third = phase0({ nonce: seed(152), maximumResults: 1 })
  const [thirdCookie] = caps.receive(third, source)
  t.is(caps.receive(phase1(third, thirdCookie), source).length, 1)
  caps.destroy()
})

test('constructor copies local keys, rejects mismatches, and destroy is terminal', (t) => {
  const self = fixture()
  const identitySecretKey = b4a.from(self.identity.secretKey)
  const routeEncryptionSecretKey = b4a.from(self.route.secretKey)
  const caps = new CapsResponder({
    now: () => NOW,
    advertisement: self.encoded,
    identitySecretKey,
    routeEncryptionSecretKey
  })
  identitySecretKey.fill(0)
  routeEncryptionSecretKey.fill(0)
  const source = endpoint(240)
  const initial = phase0({ maximumResults: 1 })
  const [challenge] = caps.receive(initial, source)
  t.is(caps.receive(phase1(initial, challenge), source).length, 1)
  caps.destroy()
  expectCode(t, () => caps.receive(initial, source), 'ERR_DESTROYED')

  expectCode(
    t,
    () =>
      new CapsResponder({
        now: () => NOW,
        advertisement: self.encoded,
        identitySecretKey: fixture({ start: 800 }).identity.secretKey,
        routeEncryptionSecretKey: self.route.secretKey
      }),
    'ERR_AUTHENTICATION'
  )
  expectCode(
    t,
    () =>
      new CapsResponder({
        now: () => NOW,
        advertisement: self.encoded,
        identitySecretKey: self.identity.secretKey,
        routeEncryptionSecretKey: fixture({ start: 900 }).route.secretKey
      }),
    'ERR_AUTHENTICATION'
  )
})

test('constructor erases copied long-term secrets when a later option getter throws', (t) => {
  const advertisement = b4a.alloc(260, 0xc3)
  const identitySecretKey = b4a.alloc(64, 0xa1)
  const routeEncryptionSecretKey = b4a.alloc(32, 0xb2)
  const allocated = []
  const allocUnsafeSlow = b4a.allocUnsafeSlow
  b4a.allocUnsafeSlow = function trackedAllocation(size) {
    const value = allocUnsafeSlow(size)
    allocated.push(value)
    return value
  }
  try {
    const options = new Proxy(
      {
        now: () => NOW,
        advertisement,
        identitySecretKey,
        routeEncryptionSecretKey
      },
      {
        get(target, name) {
          if (name === 'selectAdvertisements') throw new Error('hostile late getter')
          return target[name]
        }
      }
    )
    expectCode(t, () => new CapsResponder(options), 'ERR_INCOMPATIBLE_RELAY')
  } finally {
    b4a.allocUnsafeSlow = allocUnsafeSlow
  }

  const identityCopy = allocated.find((value) => value.byteLength === 64)
  const routeCopy = allocated.find((value) => value.byteLength === 32)
  t.ok(identityCopy)
  t.ok(routeCopy)
  t.alike(identityCopy, b4a.alloc(64))
  t.alike(routeCopy, b4a.alloc(32))
  t.alike(identitySecretKey, b4a.alloc(64, 0xa1))
  t.alike(routeEncryptionSecretKey, b4a.alloc(32, 0xb2))
})
