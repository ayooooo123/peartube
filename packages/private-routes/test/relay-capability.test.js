import test from 'brittle'
import b4a from 'b4a'
import sodium from 'sodium-universal'

import * as routes from '../index.js'
import {
  ACTIVE_CHALLENGE_TIMEOUT,
  BRANCH_CLASS,
  CAPACITY_CLASS,
  M3_MESSAGE_ID,
  RELAY_CAPABILITY,
  RelayCapabilityDirectory,
  createActiveChallengeResponderAuthority,
  cryptoSuite,
  decodeRelayCapabilityAdvertisement,
  deriveM3DhtNodeId,
  digestRelayCapabilityAdvertisement,
  encodeCanonicalEndpoint,
  encodeRelayCapabilityAdvertisement,
  providerServicePolicyForCapabilities,
  signRelayCapabilityAdvertisement
} from '../index.js'
import { expectCode, seed } from './helpers.js'

const NOW = 1_000_000n

function fakeClock(start = NOW) {
  let now = start
  let next = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = ++next
      timers.set(id, { callback, at: now + BigInt(delay) })
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
    },
    pending() {
      return timers.size
    }
  }
}

function endpoint(last = 7, port = 49737) {
  return encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, last]),
    port
  })
}

function identity(value = 1) {
  return cryptoSuite.keyPair(seed(value))
}

function routeKey(value = 2) {
  return cryptoSuite.encryptionKeyPair(seed(value))
}

function advertisement(identityKeyPair, routeKeyPair, overrides = {}) {
  const reachableEndpoint = endpoint()
  const capabilityMask = RELAY_CAPABILITY.CIRCUIT_RELAY_V1
  return {
    relayIdentity: identityKeyPair.publicKey,
    currentDhtNodeId: deriveM3DhtNodeId(reachableEndpoint),
    reachableEndpoint,
    routeEncryptionPublicKey: routeKeyPair.publicKey,
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
    epoch: 7n,
    issuedAtMs: NOW,
    expiresAtMs: NOW + 30_000n,
    providerServicePolicyEntries: providerServicePolicyForCapabilities(capabilityMask),
    ...overrides
  }
}

function signedAdvertisement(overrides = {}) {
  const signer = identity(
    (overrides.capabilityMask ?? RELAY_CAPABILITY.CIRCUIT_RELAY_V1) & RELAY_CAPABILITY.DHT_EXIT_V1
      ? 1
      : 2
  )
  const route = routeKey(2)
  const value = advertisement(signer, route, overrides)
  return {
    encoded: encodeRelayCapabilityAdvertisement(
      signRelayCapabilityAdvertisement(value, signer.secretKey)
    ),
    route,
    signer,
    value
  }
}

function activeExchange(
  directory,
  fixture,
  { now = () => NOW, sourceEndpoint = endpoint(240) } = {}
) {
  const responder = createActiveChallengeResponderAuthority({
    now,
    crypto: { ...cryptoSuite, randomBytes: (size) => b4a.alloc(size, 0x5d) }
  })
  const query = {
    sourceEndpoint,
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget: seed(210),
    queryNonce: seed(211),
    maximumResults: 1
  }
  const cookie = responder.issueCookie(query)
  const binding = responder.admitCapsRetry({
    ...query,
    ...cookie,
    advertisement: fixture.encoded
  })
  const candidate = directory.admit(fixture.encoded, {
    observedEndpoint: fixture.value.reachableEndpoint,
    capsBinding: { queryNonce: query.queryNonce, ...cookie }
  })
  return {
    candidate,
    responder,
    respond(pending, overrides = {}) {
      return responder.respond(binding, pending.message, {
        sourceEndpoint,
        advertisement: fixture.encoded,
        identitySecretKey: fixture.signer.secretKey,
        routeEncryptionSecretKey: fixture.route.secretKey,
        ...overrides
      })
    }
  }
}

test('M3 relay advertisement is canonical, signed, exact-sized, and defensively copied', (t) => {
  const { encoded, value } = signedAdvertisement()
  t.is(encoded.byteLength, 260)
  t.is(encoded.readUInt32BE(0), 1)
  t.is(encoded.readUInt16BE(4), M3_MESSAGE_ID.CAPABILITY_ADVERTISEMENT_V1)
  t.is(encoded.readUInt16BE(6), 188)

  const decoded = decodeRelayCapabilityAdvertisement(encoded, { now: NOW + 1n })
  t.alike(decoded.relayIdentity, value.relayIdentity)
  t.alike(decoded.reachableEndpoint, value.reachableEndpoint)
  t.alike(decoded.providerServicePolicyEntries, [])

  encoded.fill(0)
  value.relayIdentity.fill(0)
  t.absent(b4a.equals(decoded.relayIdentity, b4a.alloc(32)))
  t.absent(b4a.equals(decoded.reachableEndpoint, b4a.alloc(19)))
})

test('M3 DHT node identity uses IPv4 octets and little-endian port exactly', (t) => {
  const reachableEndpoint = endpoint(9, 0x1234)
  const expected = b4a.alloc(32)
  sodium.crypto_generichash(expected, b4a.from([192, 0, 2, 9, 0x34, 0x12]))
  t.alike(deriveM3DhtNodeId(reachableEndpoint), expected)
})

test('provider policy is the exact capability-derived 0/4/5/9 tuple set', (t) => {
  const cases = [
    [RELAY_CAPABILITY.CIRCUIT_RELAY_V1, 0],
    [RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1, 4],
    [RELAY_CAPABILITY.PRIVATE_RECORDS_V1, 5],
    [
      RELAY_CAPABILITY.CIRCUIT_RELAY_V1 |
        RELAY_CAPABILITY.DHT_EXIT_V1 |
        RELAY_CAPABILITY.PRIVATE_RECORDS_V1,
      9
    ]
  ]

  for (const [capabilityMask, count] of cases) {
    const policies = providerServicePolicyForCapabilities(capabilityMask)
    t.is(policies.length, count)
    const expectedIds = []
    if (capabilityMask & RELAY_CAPABILITY.DHT_EXIT_V1) {
      expectedIds.push(0x0120, 0x0121, 0x0122, 0x0123)
    }
    if (capabilityMask & RELAY_CAPABILITY.PRIVATE_RECORDS_V1) {
      expectedIds.push(0x0200, 0x02a0, 0x02a1, 0x02a2, 0x02a3)
    }
    t.alike(
      policies.map((entry) => entry.commandId),
      expectedIds
    )
    const fixture = signedAdvertisement({
      capabilityMask,
      providerServicePolicyEntries: policies
    })
    t.is(fixture.encoded.byteLength, 260 + count * 32)
    t.is(
      decodeRelayCapabilityAdvertisement(fixture.encoded, { now: NOW }).providerServicePolicyEntries
        .length,
      count
    )
  }

  expectCode(
    t,
    () =>
      signedAdvertisement({
        capabilityMask: RELAY_CAPABILITY.DHT_EXIT_V1,
        providerServicePolicyEntries: []
      }),
    'ERR_INCOMPATIBLE_RELAY'
  )
})

test('advertisement validation rejects signature, expiry, lifetime, framing, ID, and role mismatches', (t) => {
  const fixture = signedAdvertisement()
  const forged = b4a.from(fixture.encoded)
  forged[20] ^= 1

  expectCode(
    t,
    () => decodeRelayCapabilityAdvertisement(forged, { now: NOW }),
    'ERR_AUTHENTICATION'
  )
  expectCode(
    t,
    () => decodeRelayCapabilityAdvertisement(fixture.encoded, { now: NOW + 30_000n }),
    'ERR_INCOMPATIBLE_RELAY'
  )

  for (const overrides of [
    { expiresAtMs: NOW + 1_800_001n },
    { cellSize: 1199 },
    { currentDhtNodeId: seed(99) },
    { capabilityMask: RELAY_CAPABILITY.DHT_EXIT_V1 }
  ]) {
    expectCode(t, () => signedAdvertisement(overrides), 'ERR_INCOMPATIBLE_RELAY')
  }
})

test('advertisements reject unspecified, multicast, broadcast, and signer-identity substitution', (t) => {
  for (const address of [
    b4a.from([0, 0, 0, 0]),
    b4a.from([224, 0, 0, 1]),
    b4a.from([255, 255, 255, 255])
  ]) {
    const reachableEndpoint = encodeCanonicalEndpoint({
      addressFamily: 4,
      addressBytes: address,
      port: 49737
    })
    expectCode(
      t,
      () =>
        signedAdvertisement({
          reachableEndpoint,
          currentDhtNodeId: deriveM3DhtNodeId(reachableEndpoint)
        }),
      'ERR_INCOMPATIBLE_RELAY'
    )
  }

  const fixture = signedAdvertisement()
  expectCode(
    t,
    () => signRelayCapabilityAdvertisement(fixture.value, identity(40).secretKey),
    'ERR_AUTHENTICATION'
  )
})

test('route roles are derived exactly from relay capabilities while storage-only is role-independent', (t) => {
  const safety = identity(2)
  const privateRelay = identity(1)
  const route = routeKey(5)
  const cases = [
    [safety, RELAY_CAPABILITY.CIRCUIT_RELAY_V1, true],
    [privateRelay, RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1, true],
    [safety, RELAY_CAPABILITY.PRIVATE_RECORDS_V1, true],
    [privateRelay, RELAY_CAPABILITY.PRIVATE_RECORDS_V1, true],
    [privateRelay, RELAY_CAPABILITY.CIRCUIT_RELAY_V1, false],
    [safety, RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1, false]
  ]

  for (const [signer, capabilityMask, legal] of cases) {
    const value = advertisement(signer, route, {
      capabilityMask,
      providerServicePolicyEntries: providerServicePolicyForCapabilities(capabilityMask)
    })
    const encode = () =>
      encodeRelayCapabilityAdvertisement(signRelayCapabilityAdvertisement(value, signer.secretKey))
    if (legal) t.ok(encode())
    else expectCode(t, encode, 'ERR_INCOMPATIBLE_RELAY')
  }
})

test('advertisement digest is unavailable until canonical signature validation succeeds', (t) => {
  const fixture = signedAdvertisement()
  const digest = digestRelayCapabilityAdvertisement(fixture.encoded, { now: NOW })
  t.is(digest.byteLength, 32)
  t.is(
    b4a.toString(digest, 'hex'),
    '3e52c4d4e3ea2357cdb8cadebfb33ed7582a6d9a35904c921a0d681c9ea54557'
  )
  const forged = b4a.from(fixture.encoded)
  forged[20] ^= 1
  expectCode(
    t,
    () => digestRelayCapabilityAdvertisement(forged, { now: NOW }),
    'ERR_AUTHENTICATION'
  )
})

test('validated relay capabilities have no process-global expiry bypass', (t) => {
  t.is(routes.isValidatedRelayCapability, undefined)
  t.is(routes.readValidatedRelayCapability, undefined)
})

test('directory enforces epoch monotonicity, fresh route keys, and same-epoch quarantine', (t) => {
  const directory = new RelayCapabilityDirectory({ now: () => NOW })
  const first = signedAdvertisement()
  directory.admit(first.encoded, { observedEndpoint: first.value.reachableEndpoint })

  const identical = directory.admit(first.encoded, {
    observedEndpoint: first.value.reachableEndpoint
  })
  t.ok(identical)

  expectCode(
    t,
    () =>
      directory.admit(signedAdvertisement({ epoch: 6n }).encoded, {
        observedEndpoint: first.value.reachableEndpoint
      }),
    'ERR_REPLAY'
  )
  expectCode(
    t,
    () =>
      directory.admit(signedAdvertisement({ epoch: 8n }).encoded, {
        observedEndpoint: first.value.reachableEndpoint
      }),
    'ERR_REPLAY'
  )

  const freshRoute = routeKey(3)
  const current = signedAdvertisement({
    epoch: 8n,
    routeEncryptionPublicKey: freshRoute.publicKey
  })
  t.ok(
    directory.admit(current.encoded, {
      observedEndpoint: current.value.reachableEndpoint
    })
  )
  expectCode(
    t,
    () =>
      directory.admit(first.encoded, {
        observedEndpoint: first.value.reachableEndpoint
      }),
    'ERR_REPLAY'
  )

  const equivocation = signedAdvertisement({
    epoch: 8n,
    routeEncryptionPublicKey: freshRoute.publicKey,
    maxQueuedBytes: 262_145
  })
  expectCode(
    t,
    () =>
      directory.admit(equivocation.encoded, {
        observedEndpoint: equivocation.value.reachableEndpoint
      }),
    'ERR_AUTHENTICATION'
  )
  t.ok(directory.isQuarantined(first.signer.publicKey))
})

test('directory admit cannot revive candidate state after its clock destroys the generation', (t) => {
  let directory = null
  const fixture = signedAdvertisement()
  directory = new RelayCapabilityDirectory({
    now() {
      directory.destroy()
      return NOW
    }
  })

  expectCode(
    t,
    () =>
      directory.admit(fixture.encoded, {
        observedEndpoint: fixture.value.reachableEndpoint,
        capsBinding: {
          queryNonce: seed(9),
          cookieExpiresAtMs: NOW + 5_000n,
          returnRoutabilityCookie: seed(10)
        }
      }),
    'ERR_DESTROYED'
  )
  t.is(directory._identities.size, 0)
  t.is(directory._history.size, 0)
})

test('directory invalidates stale candidates and validated tokens on replacement, quarantine, and expiry', (t) => {
  let now = NOW
  const directory = new RelayCapabilityDirectory({
    now: () => now,
    randomBytes: (size) => b4a.alloc(size, 0x21)
  })
  const first = signedAdvertisement({ expiresAtMs: NOW + 1_000n })
  const exchange = activeExchange(directory, first, { now: () => now })
  const candidate = exchange.candidate
  const pending = directory.beginActiveChallenge(candidate)
  t.is(pending.message.readBigUInt64BE(8 + 96), NOW + 1_000n)
  const response = exchange.respond(pending)
  const validated = directory.completeActiveChallenge(pending, response, {
    observedEndpoint: first.value.reachableEndpoint
  })
  t.ok(directory.isValidated(validated))

  now = NOW + 1_000n
  t.absent(directory.isValidated(validated))
  expectCode(t, () => directory.read(validated), 'ERR_INCOMPATIBLE_RELAY')
  expectCode(t, () => directory.beginActiveChallenge(candidate), 'ERR_INCOMPATIBLE_RELAY')

  now = NOW
  const freshRoute = routeKey(30)
  const replacement = signedAdvertisement({
    epoch: 8n,
    routeEncryptionPublicKey: freshRoute.publicKey
  })
  directory.admit(replacement.encoded, {
    observedEndpoint: replacement.value.reachableEndpoint
  })
  expectCode(t, () => directory.beginActiveChallenge(candidate), 'ERR_REPLAY')
})

test('directory bounds identity and pending state and clears pending secrets on cancel/failure', async (t) => {
  const directory = new RelayCapabilityDirectory({
    now: () => NOW,
    randomBytes: (size) => b4a.alloc(size, 0x31),
    maxIdentities: 1,
    maxPending: 1
  })
  const first = signedAdvertisement()
  const candidate = directory.admit(first.encoded, {
    observedEndpoint: first.value.reachableEndpoint,
    capsBinding: {
      queryNonce: seed(10),
      cookieExpiresAtMs: NOW + 5_000n,
      returnRoutabilityCookie: seed(11)
    }
  })
  const otherSigner = identity(3)
  const otherRoute = routeKey(42)
  const otherValue = advertisement(otherSigner, otherRoute, {
    reachableEndpoint: endpoint(8),
    currentDhtNodeId: deriveM3DhtNodeId(endpoint(8))
  })
  const other = encodeRelayCapabilityAdvertisement(
    signRelayCapabilityAdvertisement(otherValue, otherSigner.secretKey)
  )
  expectCode(
    t,
    () => directory.admit(other, { observedEndpoint: otherValue.reachableEndpoint }),
    'ERR_BUSY'
  )

  const pending = directory.beginActiveChallenge(candidate)
  expectCode(t, () => directory.beginActiveChallenge(candidate), 'ERR_BUSY')
  directory.cancelActiveChallenge(pending)
  t.alike(directory.diagnostics(), {
    identities: 1,
    quarantined: 0,
    pending: 0,
    validated: 0,
    guardAdmissions: 0
  })

  let error = null
  try {
    await directory.validate(candidate, async () => {
      throw new Error('network failed')
    })
  } catch (err) {
    error = err
  }
  t.ok(error)
  t.is(directory.diagnostics().pending, 0)
})

test('expired pending challenges are purged and release bounded challenge capacity', (t) => {
  let now = NOW
  const directory = new RelayCapabilityDirectory({
    now: () => now,
    randomBytes: (size) => b4a.alloc(size, 0x32),
    maxPending: 1
  })
  const fixture = signedAdvertisement()
  const candidate = directory.admit(fixture.encoded, {
    observedEndpoint: fixture.value.reachableEndpoint,
    capsBinding: {
      queryNonce: seed(12),
      cookieExpiresAtMs: NOW + 20_000n,
      returnRoutabilityCookie: seed(13)
    }
  })

  directory.beginActiveChallenge(candidate)
  expectCode(t, () => directory.beginActiveChallenge(candidate), 'ERR_BUSY')
  now += 5_001n
  t.is(directory.diagnostics().pending, 0)

  directory.beginActiveChallenge(candidate)
  t.is(directory.diagnostics().pending, 1)
})

test('pending and validated tokens share one bounded live challenge-authority budget', (t) => {
  const directory = new RelayCapabilityDirectory({
    now: () => NOW,
    maxPending: 2
  })
  const fixture = signedAdvertisement({ expiresAtMs: NOW + 60_000n })
  const exchanges = []
  const validated = []
  for (let index = 0; index < 3; index++) exchanges.push(activeExchange(directory, fixture))
  for (let index = 0; index < 2; index++) {
    const pending = directory.beginActiveChallenge(exchanges[index].candidate)
    validated.push(
      directory.completeActiveChallenge(pending, exchanges[index].respond(pending), {
        observedEndpoint: fixture.value.reachableEndpoint
      })
    )
  }

  expectCode(t, () => directory.beginActiveChallenge(exchanges[2].candidate), 'ERR_BUSY')
  t.alike(directory.diagnostics(), {
    identities: 1,
    quarantined: 0,
    pending: 0,
    validated: 2,
    guardAdmissions: 0
  })
  t.ok(directory.revokeValidated(validated[0]))
  const replacement = directory.beginActiveChallenge(exchanges[2].candidate)
  validated.push(
    directory.completeActiveChallenge(replacement, exchanges[2].respond(replacement), {
      observedEndpoint: fixture.value.reachableEndpoint
    })
  )
  t.is(directory.diagnostics().validated, 2, 'released capacity is synchronously reusable')
  for (const exchange of exchanges) exchange.responder.destroy()
  directory.destroy()
})

test('pending capacity is reserved before recursive random providers', (t) => {
  let directory = null
  let candidate = null
  let reentered = false
  let recursive = null
  directory = new RelayCapabilityDirectory({
    now: () => NOW,
    maxPending: 1,
    randomBytes(size) {
      if (candidate && !reentered) {
        reentered = true
        try {
          recursive = directory.beginActiveChallenge(candidate)
        } catch (err) {
          recursive = err && err.code
        }
      }
      return b4a.alloc(size, 0x34)
    }
  })
  const fixture = signedAdvertisement()
  candidate = directory.admit(fixture.encoded, {
    observedEndpoint: fixture.value.reachableEndpoint,
    capsBinding: {
      queryNonce: seed(16),
      cookieExpiresAtMs: NOW + 20_000n,
      returnRoutabilityCookie: seed(17)
    }
  })

  const pending = directory.beginActiveChallenge(candidate)
  t.is(recursive, 'ERR_BUSY')
  t.is(directory.diagnostics().pending, 1)
  directory.cancelActiveChallenge(pending)
  directory.destroy()
})

test('destroy invalidates an in-flight pending reservation and erases RNG scratch', (t) => {
  let directory = null
  let candidate = null
  const generated = []
  directory = new RelayCapabilityDirectory({
    now: () => NOW,
    maxPending: 1,
    randomBytes(size) {
      const bytes = b4a.alloc(size, 0x35 + generated.length)
      generated.push(bytes)
      if (candidate && generated.length === 1) directory.destroy()
      return bytes
    }
  })
  const fixture = signedAdvertisement()
  candidate = directory.admit(fixture.encoded, {
    observedEndpoint: fixture.value.reachableEndpoint,
    capsBinding: {
      queryNonce: seed(18),
      cookieExpiresAtMs: NOW + 20_000n,
      returnRoutabilityCookie: seed(19)
    }
  })

  expectCode(t, () => directory.beginActiveChallenge(candidate), 'ERR_DESTROYED')
  t.is(directory._pendingTokens.size, 0)
  t.is(directory._pendingReservations.size, 0)
  for (const bytes of generated) t.alike(bytes, b4a.alloc(bytes.byteLength))
})

test('validation timer registration cannot queue exchange after destroying its generation', async (t) => {
  let directory = null
  let exchangeCount = 0
  const generated = []
  directory = new RelayCapabilityDirectory({
    now: () => NOW,
    randomBytes(size) {
      const bytes = b4a.alloc(size, 0x71 + generated.length)
      generated.push(bytes)
      return bytes
    },
    setTimeout() {
      directory.destroy()
      return Object.freeze({})
    },
    clearTimeout() {}
  })
  const fixture = signedAdvertisement()
  const candidate = directory.admit(fixture.encoded, {
    observedEndpoint: fixture.value.reachableEndpoint,
    capsBinding: {
      queryNonce: seed(20),
      cookieExpiresAtMs: NOW + 20_000n,
      returnRoutabilityCookie: seed(21)
    }
  })
  const candidateState = directory._candidates.get(candidate)
  const encoded = candidateState.encoded
  const endpoint = candidateState.endpoint

  let code = null
  await directory
    .validate(candidate, () => {
      exchangeCount++
      return b4a.alloc(344)
    })
    .catch((err) => {
      code = err && err.code
    })

  t.is(code, 'ERR_DESTROYED')
  t.is(exchangeCount, 0)
  t.is(directory._validations.size, 0)
  t.is(directory._pendingTokens.size, 0)
  t.is(directory._pendingReservations.size, 0)
  t.alike(encoded, b4a.alloc(encoded.byteLength))
  t.alike(endpoint, b4a.alloc(endpoint.byteLength))
  for (const bytes of generated) t.alike(bytes, b4a.alloc(bytes.byteLength))
})

test('immediate destroy prevents an already queued active exchange', async (t) => {
  let exchangeCount = 0
  const directory = new RelayCapabilityDirectory({
    now: () => NOW,
    randomBytes: (size) => b4a.alloc(size, 0x73)
  })
  const fixture = signedAdvertisement()
  const candidate = directory.admit(fixture.encoded, {
    observedEndpoint: fixture.value.reachableEndpoint,
    capsBinding: {
      queryNonce: seed(22),
      cookieExpiresAtMs: NOW + 20_000n,
      returnRoutabilityCookie: seed(23)
    }
  })
  const validation = directory.validate(candidate, () => {
    exchangeCount++
    return b4a.alloc(344)
  })
  const operation = [...directory._validations][0]
  const pendingState = directory._pending.get(operation.pending)
  const challenge = pendingState.challenge
  const ephemeralSecretKey = pendingState.ephemeralSecretKey

  directory.destroy()
  let code = null
  await validation.catch((err) => {
    code = err && err.code
  })

  t.is(code, 'ERR_DESTROYED')
  t.is(exchangeCount, 0)
  t.is(directory._validations.size, 0)
  t.is(directory._pendingTokens.size, 0)
  t.is(directory._pendingReservations.size, 0)
  t.alike(challenge, b4a.alloc(challenge.byteLength))
  t.alike(ephemeralSecretKey, b4a.alloc(ephemeralSecretKey.byteLength))
})

test('directory owns a non-extending deadline and aborts a never-settling active exchange', async (t) => {
  const clock = fakeClock()
  const directory = new RelayCapabilityDirectory({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    randomBytes: (size) => b4a.alloc(size, 0x33)
  })
  const fixture = signedAdvertisement()
  const candidate = directory.admit(fixture.encoded, {
    observedEndpoint: fixture.value.reachableEndpoint,
    capsBinding: {
      queryNonce: seed(14),
      cookieExpiresAtMs: NOW + 20_000n,
      returnRoutabilityCookie: seed(15)
    }
  })
  let signal = null
  let settled = false
  let code = null
  directory
    .validate(candidate, async (_message, _endpoint, value) => {
      signal = value
      return new Promise(() => {})
    })
    .then(
      () => {
        settled = true
      },
      (err) => {
        settled = true
        code = err && err.code
      }
    )
  for (let index = 0; index < 8; index++) await Promise.resolve()
  clock.advance(5_001)
  for (let index = 0; index < 8; index++) await Promise.resolve()

  t.ok(settled)
  t.is(code, 'ERR_PRIVACY_UNAVAILABLE')
  t.ok(signal && signal.aborted)
  t.is(directory.diagnostics().pending, 0)
})

test('directory destroy aborts validation and ignores a late exchange settlement', async (t) => {
  const clock = fakeClock()
  const directory = new RelayCapabilityDirectory({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    randomBytes: (size) => b4a.alloc(size, 0x34)
  })
  const fixture = signedAdvertisement()
  const candidate = directory.admit(fixture.encoded, {
    observedEndpoint: fixture.value.reachableEndpoint,
    capsBinding: {
      queryNonce: seed(16),
      cookieExpiresAtMs: NOW + 20_000n,
      returnRoutabilityCookie: seed(17)
    }
  })
  let settleExchange
  let signal
  const pending = directory.validate(candidate, (_message, _endpoint, value) => {
    signal = value
    return new Promise((resolve) => {
      settleExchange = resolve
    })
  })
  for (let index = 0; index < 4; index++) await Promise.resolve()
  directory.destroy()
  let error = null
  try {
    await pending
  } catch (err) {
    error = err
  }
  t.is(error && error.code, 'ERR_DESTROYED')
  t.ok(signal.aborted)
  settleExchange(b4a.alloc(344))
  for (let index = 0; index < 4; index++) await Promise.resolve()
  expectCode(t, () => directory.diagnostics(), 'ERR_DESTROYED')
})

test('identity epoch high-water survives advertisement and quarantine expiry', (t) => {
  let now = NOW
  const directory = new RelayCapabilityDirectory({ now: () => now })
  const initial = signedAdvertisement({ expiresAtMs: NOW + 100n })
  directory.admit(initial.encoded, { observedEndpoint: initial.value.reachableEndpoint })
  now = NOW + 101n

  const rollback = signedAdvertisement({
    epoch: 6n,
    issuedAtMs: now,
    expiresAtMs: now + 100n,
    routeEncryptionPublicKey: routeKey(30).publicKey
  })
  expectCode(
    t,
    () => directory.admit(rollback.encoded, { observedEndpoint: rollback.value.reachableEndpoint }),
    'ERR_REPLAY'
  )
  const higher = signedAdvertisement({
    epoch: 8n,
    issuedAtMs: now,
    expiresAtMs: now + 100n,
    routeEncryptionPublicKey: routeKey(31).publicKey
  })
  t.ok(directory.admit(higher.encoded, { observedEndpoint: higher.value.reachableEndpoint }))

  now = NOW
  const quarantined = new RelayCapabilityDirectory({ now: () => now })
  const first = signedAdvertisement({ expiresAtMs: NOW + 100n })
  quarantined.admit(first.encoded, { observedEndpoint: first.value.reachableEndpoint })
  const conflicting = signedAdvertisement({
    reachableEndpoint: endpoint(8),
    currentDhtNodeId: deriveM3DhtNodeId(endpoint(8)),
    expiresAtMs: NOW + 100n
  })
  expectCode(
    t,
    () =>
      quarantined.admit(conflicting.encoded, {
        observedEndpoint: conflicting.value.reachableEndpoint
      }),
    'ERR_AUTHENTICATION'
  )
  now = NOW + 101n
  expectCode(
    t,
    () =>
      quarantined.admit(rollback.encoded, {
        observedEndpoint: rollback.value.reachableEndpoint
      }),
    'ERR_REPLAY'
  )
  t.ok(
    quarantined.admit(higher.encoded, {
      observedEndpoint: higher.value.reachableEndpoint
    })
  )
})

test('equivocating route keys remain spent after quarantine expiry', (t) => {
  let now = NOW
  const directory = new RelayCapabilityDirectory({ now: () => now })
  const initial = signedAdvertisement({ expiresAtMs: NOW + 100n })
  directory.admit(initial.encoded, { observedEndpoint: initial.value.reachableEndpoint })
  const conflictingRoute = routeKey(40)
  const conflicting = signedAdvertisement({
    routeEncryptionPublicKey: conflictingRoute.publicKey,
    maxQueuedBytes: 262_145,
    expiresAtMs: NOW + 100n
  })
  expectCode(
    t,
    () =>
      directory.admit(conflicting.encoded, {
        observedEndpoint: conflicting.value.reachableEndpoint
      }),
    'ERR_AUTHENTICATION'
  )
  now = NOW + 101n
  const reuse = signedAdvertisement({
    epoch: 8n,
    routeEncryptionPublicKey: conflictingRoute.publicKey,
    issuedAtMs: now,
    expiresAtMs: now + 100n
  })
  expectCode(
    t,
    () => directory.admit(reuse.encoded, { observedEndpoint: reuse.value.reachableEndpoint }),
    'ERR_REPLAY'
  )
})

test('byte-identical current advertisement accepts a fresh CAPS binding without reviving stale epochs', (t) => {
  let now = NOW
  const fixture = signedAdvertisement()
  const directory = new RelayCapabilityDirectory({
    now: () => now,
    randomBytes: (size) => b4a.alloc(size, 0x44)
  })
  const candidate = directory.admit(fixture.encoded, {
    observedEndpoint: fixture.value.reachableEndpoint,
    capsBinding: {
      queryNonce: seed(10),
      cookieExpiresAtMs: NOW + 100n,
      returnRoutabilityCookie: seed(11)
    }
  })
  now += 100n
  const refreshed = directory.admit(fixture.encoded, {
    observedEndpoint: fixture.value.reachableEndpoint,
    capsBinding: {
      queryNonce: seed(12),
      cookieExpiresAtMs: NOW + 5_000n,
      returnRoutabilityCookie: seed(13)
    }
  })
  t.is(refreshed, candidate)
  t.ok(directory.beginActiveChallenge(refreshed))
})

test('challenge completion rechecks advertisement and CAPS-cookie expiry', (t) => {
  let now = NOW
  const fixture = signedAdvertisement({ expiresAtMs: NOW + 2_000n })
  const directory = new RelayCapabilityDirectory({
    now: () => now,
    randomBytes: (size) => b4a.alloc(size, 0x61)
  })
  const exchange = activeExchange(directory, fixture, { now: () => now })
  const candidate = exchange.candidate
  const pending = directory.beginActiveChallenge(candidate)
  const response = exchange.respond(pending)
  now = NOW + 5_000n
  expectCode(
    t,
    () =>
      directory.completeActiveChallenge(pending, response, {
        observedEndpoint: fixture.value.reachableEndpoint
      }),
    'ERR_INCOMPATIBLE_RELAY'
  )
  t.is(directory.diagnostics().pending, 0)
})

test('active challenge binds endpoint, advertisement, CAPS cookie, identity, and route-key proof', async (t) => {
  const fixture = signedAdvertisement()
  const directory = new RelayCapabilityDirectory({
    now: () => NOW,
    randomBytes: (size) => b4a.alloc(size, 0x41)
  })
  const exchange = activeExchange(directory, fixture)
  const candidate = exchange.candidate
  const pending = directory.beginActiveChallenge(candidate)
  const response = exchange.respond(pending)

  expectCode(
    t,
    () =>
      directory.completeActiveChallenge(pending, response, {
        observedEndpoint: endpoint(8)
      }),
    'ERR_AUTHENTICATION'
  )
  const validated = directory.completeActiveChallenge(pending, response, {
    observedEndpoint: fixture.value.reachableEndpoint
  })

  t.ok(directory.isValidated(validated))
  t.alike(directory.read(validated).relayIdentity, fixture.signer.publicKey)
  expectCode(
    t,
    () =>
      directory.completeActiveChallenge(pending, response, {
        observedEndpoint: fixture.value.reachableEndpoint
      }),
    'ERR_REPLAY'
  )

  for (const bodyOffset of [0, 96, 104, 136, 144]) {
    const substituted = activeExchange(directory, fixture)
    const next = directory.beginActiveChallenge(substituted.candidate)
    const substitutedChallenge = b4a.from(next.message)
    substitutedChallenge[8 + bodyOffset] ^= 1
    expectCode(
      t,
      () => substituted.respond({ message: substitutedChallenge }),
      'ERR_AUTHENTICATION'
    )
    directory.cancelActiveChallenge(next)
    substituted.responder.destroy()
  }
  exchange.responder.destroy()
})

test('relay codecs reject hostile objects and forged buffer intrinsics without retaining aliases', (t) => {
  const fixture = signedAdvertisement()
  const hostile = new Proxy(fixture.value, {
    get() {
      throw new Error('hostile')
    }
  })
  expectCode(
    t,
    () => signRelayCapabilityAdvertisement(hostile, fixture.signer.secretKey),
    'ERR_INCOMPATIBLE_RELAY'
  )

  const forged = b4a.from(fixture.encoded)
  Object.defineProperty(forged, 'byteLength', { value: 260 })
  forged.subarray = () => b4a.alloc(0)
  t.alike(
    decodeRelayCapabilityAdvertisement(forged, { now: NOW }).relayIdentity,
    fixture.signer.publicKey
  )
})

test('active challenge responder requires a live source-bound CAPS admission before crypto', (t) => {
  let now = NOW
  const calls = { random: 0, agreement: 0, sign: 0 }
  const crypto = {
    ...cryptoSuite,
    randomBytes(size) {
      calls.random++
      return b4a.alloc(size, 0x61 + calls.random)
    },
    keyAgreement(secretKey, publicKey) {
      calls.agreement++
      return cryptoSuite.keyAgreement(secretKey, publicKey)
    },
    sign(message, secretKey) {
      calls.sign++
      return cryptoSuite.sign(message, secretKey)
    }
  }
  const responder = createActiveChallengeResponderAuthority({ now: () => now, crypto })
  const fixture = signedAdvertisement()
  const sourceEndpoint = endpoint(44, 51001)
  const query = {
    sourceEndpoint,
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget: seed(70),
    queryNonce: seed(71),
    maximumResults: 1
  }
  const cookie = responder.issueCookie(query)
  const binding = responder.admitCapsRetry({
    ...query,
    ...cookie,
    advertisement: fixture.encoded
  })
  const directory = new RelayCapabilityDirectory({
    now: () => now,
    randomBytes: (size) => b4a.alloc(size, 0x62)
  })
  const candidate = directory.admit(fixture.encoded, {
    observedEndpoint: fixture.value.reachableEndpoint,
    capsBinding: {
      queryNonce: query.queryNonce,
      ...cookie
    }
  })
  const pending = directory.beginActiveChallenge(candidate)
  const beforeInvalid = { ...calls }

  expectCode(
    t,
    () =>
      responder.respond(Object.freeze({}), pending.message, {
        sourceEndpoint,
        advertisement: fixture.encoded,
        identitySecretKey: fixture.signer.secretKey,
        routeEncryptionSecretKey: fixture.route.secretKey
      }),
    'ERR_AUTHENTICATION'
  )
  expectCode(
    t,
    () =>
      responder.respond(binding, pending.message, {
        sourceEndpoint: endpoint(45, 51001),
        advertisement: fixture.encoded,
        identitySecretKey: fixture.signer.secretKey,
        routeEncryptionSecretKey: fixture.route.secretKey
      }),
    'ERR_AUTHENTICATION'
  )
  t.alike(calls, beforeInvalid, 'invalid admission performs no response crypto or randomness')

  const response = responder.respond(binding, pending.message, {
    sourceEndpoint,
    advertisement: fixture.encoded,
    identitySecretKey: fixture.signer.secretKey,
    routeEncryptionSecretKey: fixture.route.secretKey
  })
  t.is(calls.random, beforeInvalid.random + 1)
  t.is(calls.agreement, 1)
  t.is(calls.sign, 1)
  t.ok(
    directory.completeActiveChallenge(pending, response, {
      observedEndpoint: fixture.value.reachableEndpoint
    })
  )
  expectCode(
    t,
    () =>
      responder.respond(binding, pending.message, {
        sourceEndpoint,
        advertisement: fixture.encoded,
        identitySecretKey: fixture.signer.secretKey,
        routeEncryptionSecretKey: fixture.route.secretKey
      }),
    'ERR_REPLAY'
  )

  now += 5_001n
  expectCode(
    t,
    () => responder.admitCapsRetry({ ...query, ...cookie, advertisement: fixture.encoded }),
    'ERR_AUTHENTICATION'
  )
  t.absent(routes.createActiveChallengeResponse, 'raw responder bypass is not public')
  responder.destroy()
})

test('active challenge responder rejects conflicting, hostile, and destroyed CAPS admission', (t) => {
  let now = NOW
  const responder = createActiveChallengeResponderAuthority({
    now: () => now,
    crypto: { ...cryptoSuite, randomBytes: (size) => b4a.alloc(size, 0x73) },
    maxBindings: 1
  })
  const fixture = signedAdvertisement()
  const query = {
    sourceEndpoint: endpoint(50, 51002),
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget: seed(72),
    queryNonce: seed(73),
    maximumResults: 1
  }
  const cookie = responder.issueCookie(query)
  const binding = responder.admitCapsRetry({
    ...query,
    ...cookie,
    advertisement: fixture.encoded
  })
  t.is(
    responder.admitCapsRetry({ ...query, ...cookie, advertisement: fixture.encoded }),
    binding,
    'exact retry reuses the same bounded admission'
  )
  const conflicting = b4a.from(fixture.encoded)
  conflicting[20] ^= 1
  expectCode(
    t,
    () => responder.admitCapsRetry({ ...query, ...cookie, advertisement: conflicting }),
    'ERR_AUTHENTICATION'
  )
  expectCode(
    t,
    () =>
      responder.admitCapsRetry(
        new Proxy(
          {},
          {
            get() {
              throw new Error('hostile')
            }
          }
        )
      ),
    'ERR_INCOMPATIBLE_RELAY'
  )
  responder.destroy()
  expectCode(t, () => responder.issueCookie(query), 'ERR_DESTROYED')
  now += 5_001n
})

test('CAPS responder constructor erases generated secrets when timer setup throws', (t) => {
  let generated = null
  let error = null
  try {
    createActiveChallengeResponderAuthority({
      now: () => NOW,
      crypto: {
        ...cryptoSuite,
        randomBytes(size) {
          generated = b4a.alloc(size, 0x7a)
          return generated
        }
      },
      setTimeout() {
        throw new Error('timer setup failed')
      },
      clearTimeout() {}
    })
  } catch (err) {
    error = err
  }

  t.is(error && error.message, 'timer setup failed')
  t.alike(generated, b4a.alloc(32), 'failed construction does not leak RNG secret aliases')
})

test('CAPS responder cannot install a binding after a hostile getter destroys it', (t) => {
  const responder = createActiveChallengeResponderAuthority({ now: () => NOW })
  const fixture = signedAdvertisement()
  const query = {
    sourceEndpoint: endpoint(57, 51008),
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget: seed(92),
    queryNonce: seed(93),
    maximumResults: 1
  }
  const cookie = responder.issueCookie(query)
  const hostile = {
    ...query,
    ...cookie,
    get advertisement() {
      responder.destroy()
      return fixture.encoded
    }
  }

  expectCode(t, () => responder.admitCapsRetry(hostile), 'ERR_DESTROYED')
  t.is(responder._bindingTokens.size, 0)
  t.is(responder._cache.size, 0)
})

test('CAPS responder rotates exactly at five minutes and accepts only the live prior overlap', (t) => {
  const clock = fakeClock(0n)
  let generated = 0
  const responder = createActiveChallengeResponderAuthority({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    crypto: {
      ...cryptoSuite,
      randomBytes(size) {
        generated++
        return b4a.alloc(size, generated)
      }
    }
  })
  const fixture = signedAdvertisement({ issuedAtMs: 0n, expiresAtMs: 1_000_000n })
  const query = {
    sourceEndpoint: endpoint(51, 51003),
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget: seed(74),
    queryNonce: seed(75),
    maximumResults: 1
  }
  clock.advance(299_999)
  const cookie = responder.issueCookie(query)
  t.is(generated, 1)

  clock.advance(1)
  t.is(generated, 2, 'idle timer rotates without an API call')
  const binding = responder.admitCapsRetry({
    ...query,
    ...cookie,
    advertisement: fixture.encoded
  })
  t.ok(binding, 'the immediately prior secret overlaps after exact rotation')
  clock.advance(4_998)
  t.is(responder.admitCapsRetry({ ...query, ...cookie, advertisement: fixture.encoded }), binding)
  clock.advance(1)
  expectCode(
    t,
    () => responder.admitCapsRetry({ ...query, ...cookie, advertisement: fixture.encoded }),
    'ERR_AUTHENTICATION'
  )

  t.is(clock.pending(), 2)
  clock.advance(1)
  t.is(clock.pending(), 1, 'the prior-secret erase timer fires at exactly 5,000 ms')
  clock.advance(295_000)
  responder.issueCookie({ ...query, queryNonce: seed(76) })
  t.is(generated, 3, 'rotation retains at most current and immediately prior secrets')
  clock.advance(300_000)
  responder.issueCookie({ ...query, queryNonce: seed(77) })
  t.is(generated, 4)
  responder.destroy()
})

test('CAPS responder catches up safely after suspended timers without extending stale overlap', (t) => {
  for (const resume of ['api', 'timer']) {
    const clock = fakeClock(0n)
    let generated = 0
    const responder = createActiveChallengeResponderAuthority({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      crypto: {
        ...cryptoSuite,
        randomBytes(size) {
          generated++
          return b4a.alloc(size, generated)
        }
      }
    })
    const fixture = signedAdvertisement({ issuedAtMs: 0n, expiresAtMs: 1_000_000n })
    const query = {
      sourceEndpoint: endpoint(55, 51006),
      requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
      randomTarget: seed(88),
      queryNonce: seed(89),
      maximumResults: 1
    }
    clock.advance(299_999)
    const cookie = responder.issueCookie(query)
    clock.jump(10_001)
    if (resume === 'api') {
      expectCode(
        t,
        () => responder.admitCapsRetry({ ...query, ...cookie, advertisement: fixture.encoded }),
        'ERR_AUTHENTICATION'
      )
    } else {
      clock.flush()
    }
    t.is(generated, 2)
    t.is(clock.pending(), 1, 'stale prior secret gets no new overlap timer')
    responder.destroy()
  }
})

test('CAPS responder synchronously erases an expired prior secret when erase timers resume late', (t) => {
  const clock = fakeClock(0n)
  const responder = createActiveChallengeResponderAuthority({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    crypto: { ...cryptoSuite, randomBytes: (size) => b4a.alloc(size, 0x7b) }
  })
  const query = {
    sourceEndpoint: endpoint(56, 51007),
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget: seed(90),
    queryNonce: seed(91),
    maximumResults: 1
  }
  clock.advance(300_000)
  t.is(clock.pending(), 2)
  clock.jump(5_000)
  responder.issueCookie(query)
  t.is(clock.pending(), 1)
  responder.destroy()
})

test('CAPS responder binds every query field and releases unique-tuple capacity on expiry', (t) => {
  let now = NOW
  const responder = createActiveChallengeResponderAuthority({
    now: () => now,
    crypto: { ...cryptoSuite, randomBytes: (size) => b4a.alloc(size, 0x79) },
    maxBindings: 2
  })
  const fixture = signedAdvertisement()
  const base = {
    sourceEndpoint: endpoint(52, 51004),
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget: seed(78),
    queryNonce: seed(79),
    maximumResults: 1
  }
  const cookie = responder.issueCookie(base)
  responder.admitCapsRetry({ ...base, ...cookie, advertisement: fixture.encoded })

  const mutations = [
    { sourceEndpoint: endpoint(53, 51004) },
    { requestedCapabilityMask: RELAY_CAPABILITY.PRIVATE_RECORDS_V1 },
    { randomTarget: seed(80) },
    { queryNonce: seed(81) },
    { maximumResults: 2 },
    { cookieExpiresAtMs: cookie.cookieExpiresAtMs - 1n },
    { returnRoutabilityCookie: seed(82) }
  ]
  for (const mutation of mutations) {
    expectCode(
      t,
      () =>
        responder.admitCapsRetry({
          ...base,
          ...cookie,
          ...mutation,
          advertisement: fixture.encoded
        }),
      'ERR_AUTHENTICATION'
    )
  }

  const second = { ...base, queryNonce: seed(83) }
  const secondCookie = responder.issueCookie(second)
  responder.admitCapsRetry({ ...second, ...secondCookie, advertisement: fixture.encoded })
  const third = { ...base, queryNonce: seed(84) }
  const thirdCookie = responder.issueCookie(third)
  expectCode(
    t,
    () => responder.admitCapsRetry({ ...third, ...thirdCookie, advertisement: fixture.encoded }),
    'ERR_BUSY'
  )

  now += 5_001n
  const released = { ...base, queryNonce: seed(85) }
  const releasedCookie = responder.issueCookie(released)
  t.ok(
    responder.admitCapsRetry({
      ...released,
      ...releasedCookie,
      advertisement: fixture.encoded
    })
  )
  responder.destroy()
})

test('malformed active challenges do zero response crypto and conflicting signed reuse fails', (t) => {
  const calls = { random: 0, agreement: 0, sign: 0 }
  const crypto = {
    ...cryptoSuite,
    randomBytes(size) {
      calls.random++
      return b4a.alloc(size, 0x7a)
    },
    keyAgreement(secretKey, publicKey) {
      calls.agreement++
      return cryptoSuite.keyAgreement(secretKey, publicKey)
    },
    sign(message, secretKey) {
      calls.sign++
      return cryptoSuite.sign(message, secretKey)
    }
  }
  const responder = createActiveChallengeResponderAuthority({ now: () => NOW, crypto })
  const fixture = signedAdvertisement()
  const query = {
    sourceEndpoint: endpoint(54, 51005),
    requestedCapabilityMask: RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    randomTarget: seed(86),
    queryNonce: seed(87),
    maximumResults: 1
  }
  const cookie = responder.issueCookie(query)
  const binding = responder.admitCapsRetry({
    ...query,
    ...cookie,
    advertisement: fixture.encoded
  })
  const before = { ...calls }
  for (const malformed of [b4a.alloc(0), b4a.alloc(183), b4a.alloc(185)]) {
    expectCode(
      t,
      () =>
        responder.respond(binding, malformed, {
          sourceEndpoint: query.sourceEndpoint,
          advertisement: fixture.encoded,
          identitySecretKey: fixture.signer.secretKey,
          routeEncryptionSecretKey: fixture.route.secretKey
        }),
      'ERR_AUTHENTICATION'
    )
  }
  t.alike(calls, before)

  const conflicting = signedAdvertisement({ maxQueuedBytes: 262_145 })
  expectCode(
    t,
    () =>
      responder.admitCapsRetry({
        ...query,
        ...cookie,
        advertisement: conflicting.encoded
      }),
    'ERR_AUTHENTICATION'
  )
  responder.destroy()
})

test('route-key history poisons an identity instead of evicting the seventeenth key', (t) => {
  let now = NOW
  const directory = new RelayCapabilityDirectory({ now: () => now })
  const initial = signedAdvertisement({ expiresAtMs: now + 100n })
  directory.admit(initial.encoded, { observedEndpoint: initial.value.reachableEndpoint })
  for (let index = 1; index < 17; index++) {
    now += 101n
    const key = routeKey(100 + index)
    const conflicting = signedAdvertisement({
      routeEncryptionPublicKey: key.publicKey,
      expiresAtMs: now + 100n,
      maxQueuedBytes: 262_144 + index
    })
    expectCode(
      t,
      () =>
        directory.admit(conflicting.encoded, {
          observedEndpoint: conflicting.value.reachableEndpoint
        }),
      'ERR_AUTHENTICATION'
    )
  }
  now += 101n
  const fresh = signedAdvertisement({
    epoch: 8n,
    routeEncryptionPublicKey: routeKey(200).publicKey,
    expiresAtMs: now + 100n
  })
  expectCode(
    t,
    () => directory.admit(fresh.encoded, { observedEndpoint: fresh.value.reachableEndpoint }),
    'ERR_AUTHENTICATION'
  )
})

test('destroyed capability directories erase authority and stable-fail every live method', async (t) => {
  const directory = new RelayCapabilityDirectory({ now: () => NOW })
  const fixture = signedAdvertisement()
  const exchange = activeExchange(directory, fixture)
  const pending = directory.beginActiveChallenge(exchange.candidate)
  directory.destroy()
  directory.destroy()
  const operations = [
    () => directory.admit(fixture.encoded, { observedEndpoint: fixture.value.reachableEndpoint }),
    () => directory.beginActiveChallenge(exchange.candidate),
    () =>
      directory.completeActiveChallenge(pending, b4a.alloc(344), { observedEndpoint: endpoint() }),
    () => directory.cancelActiveChallenge(pending),
    () => directory.isValidated(Object.freeze({})),
    () => directory.read(Object.freeze({})),
    () => directory.consumeValidated(Object.freeze({})),
    () => directory.revokeValidated(Object.freeze({})),
    () => directory.reserveGuardAdmission(Object.freeze({}), {}),
    () => directory.readGuardAdmission(Object.freeze({})),
    () => directory.consumeGuardAdmission(Object.freeze({})),
    () => directory.revokeGuardAdmission(Object.freeze({})),
    () => directory.isQuarantined(fixture.signer.publicKey),
    () => directory.diagnostics()
  ]
  for (const operation of operations) expectCode(t, operation, 'ERR_DESTROYED')
  let code = null
  try {
    await directory.validate(exchange.candidate, async () => b4a.alloc(344))
  } catch (err) {
    code = err && err.code
  }
  t.is(code, 'ERR_DESTROYED')
  exchange.responder.destroy()
})

test('active validation expires at its challenge deadline before the advertisement', (t) => {
  let now = NOW
  const directory = new RelayCapabilityDirectory({ now: () => now })
  const fixture = signedAdvertisement({ expiresAtMs: NOW + 60_000n })
  const exchange = activeExchange(directory, fixture, { now: () => now })
  const pending = directory.beginActiveChallenge(exchange.candidate)
  const validated = directory.completeActiveChallenge(pending, exchange.respond(pending), {
    observedEndpoint: fixture.value.reachableEndpoint
  })

  const state = directory.read(validated)
  t.is(state.challengeExpiresAtMs, NOW + ACTIVE_CHALLENGE_TIMEOUT)
  t.ok(directory.isValidated(validated))

  now = state.challengeExpiresAtMs
  t.absent(directory.isValidated(validated))
  expectCode(t, () => directory.read(validated), 'ERR_INCOMPATIBLE_RELAY')
  exchange.responder.destroy()
})

test('validated challenge authority is consumed or revoked exactly once and erased', (t) => {
  for (const operation of ['consume', 'revoke']) {
    const directory = new RelayCapabilityDirectory({ now: () => NOW })
    const fixture = signedAdvertisement({ expiresAtMs: NOW + 60_000n })
    const exchange = activeExchange(directory, fixture)
    const pending = directory.beginActiveChallenge(exchange.candidate)
    const validated = directory.completeActiveChallenge(pending, exchange.respond(pending), {
      observedEndpoint: fixture.value.reachableEndpoint
    })

    if (operation === 'consume') {
      const state = directory.consumeValidated(validated)
      t.alike(state.queryNonce, seed(211))
      t.exception(() => directory.consumeValidated(validated))
      t.absent(directory.revokeValidated(validated))
    } else {
      t.ok(directory.revokeValidated(validated))
      t.absent(directory.revokeValidated(validated))
      t.exception(() => directory.consumeValidated(validated))
    }
    t.absent(directory.isValidated(validated))
    t.exception(() => directory.read(validated))
    exchange.responder.destroy()
    directory.destroy()
  }
})

test('guard admission atomically spends validation and binds one exact OFFER setup', (t) => {
  const directory = new RelayCapabilityDirectory({ now: () => NOW })
  const fixture = signedAdvertisement({ expiresAtMs: NOW + 60_000n })
  const exchange = activeExchange(directory, fixture)
  const pending = directory.beginActiveChallenge(exchange.candidate)
  const validated = directory.completeActiveChallenge(pending, exchange.respond(pending), {
    observedEndpoint: fixture.value.reachableEndpoint
  })
  const binding = {
    clientIdentity: seed(220),
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(221).subarray(0, 16),
    circuitId: seed(222).subarray(0, 16),
    generation: 7n
  }

  const admission = directory.reserveGuardAdmission(validated, binding)
  t.absent(directory.isValidated(validated), 'reservation atomically spends validation')
  t.exception(() => directory.reserveGuardAdmission(validated, binding), 'cannot double reserve')
  const readable = directory.readGuardAdmission(admission)
  t.alike(
    readable.advertisementDigest,
    digestRelayCapabilityAdvertisement(fixture.encoded, { now: NOW })
  )
  t.alike(readable.reachableEndpoint, fixture.value.reachableEndpoint)
  t.alike(readable.clientIdentity, binding.clientIdentity)
  t.alike(readable.branchId, binding.branchId)
  t.alike(readable.circuitId, binding.circuitId)
  t.is(readable.generation, 7n)
  t.absent('queryNonce' in readable)
  t.absent('returnRoutabilityCookie' in readable)

  const consumed = directory.consumeGuardAdmission(admission)
  t.alike(consumed.clientIdentity, binding.clientIdentity)
  t.exception(() => directory.consumeGuardAdmission(admission), 'admission is one-shot')
  t.absent(directory.revokeGuardAdmission(admission))
  exchange.responder.destroy()
  directory.destroy()
})

test('guard admissions are bounded and synchronously prune expired authority', (t) => {
  const clock = fakeClock()
  const directory = new RelayCapabilityDirectory({
    now: clock.now,
    maxGuardAdmissions: 1
  })
  const fixture = signedAdvertisement({ expiresAtMs: NOW + 60_000n })
  const firstExchange = activeExchange(directory, fixture, { now: clock.now })
  const validate = (exchange) => {
    const pending = directory.beginActiveChallenge(exchange.candidate)
    return directory.completeActiveChallenge(pending, exchange.respond(pending), {
      observedEndpoint: fixture.value.reachableEndpoint
    })
  }
  const binding = (value) => ({
    clientIdentity: seed(value),
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(value + 1).subarray(0, 16),
    circuitId: seed(value + 2).subarray(0, 16),
    generation: 1n
  })

  const first = directory.reserveGuardAdmission(validate(firstExchange), binding(223))
  const firstState = directory._guardAdmissions.get(first)
  const erased = [
    firstState.advertisement,
    firstState.advertisementDigest,
    firstState.relayIdentity,
    firstState.reachableEndpoint,
    firstState.clientIdentity,
    firstState.branchId,
    firstState.circuitId
  ]

  clock.jump(4_000)
  const busyExchange = activeExchange(directory, fixture, { now: clock.now })
  expectCode(
    t,
    () => directory.reserveGuardAdmission(validate(busyExchange), binding(226)),
    'ERR_BUSY'
  )
  const spareExchange = activeExchange(directory, fixture, { now: clock.now })
  const spare = validate(spareExchange)

  clock.jump(1_001)
  t.is(directory.diagnostics().guardAdmissions, 0, 'suspended timers cannot retain expiry')
  for (const bytes of erased) t.alike(bytes, b4a.alloc(bytes.byteLength))
  t.is(firstState.candidateState, null)

  const second = directory.reserveGuardAdmission(spare, binding(229))
  t.is(directory.diagnostics().guardAdmissions, 1, 'expired capacity is reusable')
  t.ok(directory.revokeGuardAdmission(second))
  firstExchange.responder.destroy()
  busyExchange.responder.destroy()
  spareExchange.responder.destroy()
  directory.destroy()
})

test('guard admission capacity is reserved before recursive binding getters', (t) => {
  const directory = new RelayCapabilityDirectory({
    now: () => NOW,
    maxGuardAdmissions: 1
  })
  const fixture = signedAdvertisement({ expiresAtMs: NOW + 60_000n })
  const exchanges = []
  const validations = []
  for (let index = 0; index < 4; index++) {
    const exchange = activeExchange(directory, fixture)
    const pending = directory.beginActiveChallenge(exchange.candidate)
    validations.push(
      directory.completeActiveChallenge(pending, exchange.respond(pending), {
        observedEndpoint: fixture.value.reachableEndpoint
      })
    )
    exchanges.push(exchange)
  }
  const admissions = []
  const errors = []
  let next = 1
  const binding = (value) => {
    let reentered = false
    return {
      get clientIdentity() {
        if (!reentered && next < validations.length) {
          reentered = true
          const index = next++
          try {
            admissions.push(
              directory.reserveGuardAdmission(validations[index], binding(240 + index))
            )
          } catch (err) {
            errors.push(err && err.code)
          }
        }
        return seed(value)
      },
      branchClass: BRANCH_CLASS.LOOKUP,
      branchId: seed(value + 1).subarray(0, 16),
      circuitId: seed(value + 2).subarray(0, 16),
      generation: 1n
    }
  }

  admissions.push(directory.reserveGuardAdmission(validations[0], binding(239)))
  t.is(admissions.length, 1, 'recursive binding getters cannot overbook guard admission state')
  t.alike(errors, ['ERR_BUSY'])
  t.is(directory.diagnostics().guardAdmissions, 1)
  directory.revokeGuardAdmission(admissions[0])
  for (const exchange of exchanges) exchange.responder.destroy()
  directory.destroy()
})

test('destroy invalidates an in-flight guard admission and erases consumed projections', (t) => {
  const directory = new RelayCapabilityDirectory({ now: () => NOW, maxGuardAdmissions: 1 })
  const fixture = signedAdvertisement({ expiresAtMs: NOW + 60_000n })
  const exchange = activeExchange(directory, fixture)
  const pending = directory.beginActiveChallenge(exchange.candidate)
  const validated = directory.completeActiveChallenge(pending, exchange.respond(pending), {
    observedEndpoint: fixture.value.reachableEndpoint
  })
  const originalConsume = directory.consumeValidated.bind(directory)
  let consumedProjection = null
  directory.consumeValidated = (value) => {
    consumedProjection = originalConsume(value)
    return consumedProjection
  }
  const binding = {
    clientIdentity: seed(250),
    branchClass: BRANCH_CLASS.LOOKUP,
    branchId: seed(251).subarray(0, 16),
    circuitId: seed(252).subarray(0, 16),
    get generation() {
      directory.destroy()
      return 1n
    }
  }

  expectCode(t, () => directory.reserveGuardAdmission(validated, binding), 'ERR_DESTROYED')
  t.is(directory._guardAdmissionTokens.size, 0)
  t.is(directory._guardAdmissionReservations.size, 0)
  for (const name of [
    'advertisement',
    'relayIdentity',
    'currentDhtNodeId',
    'reachableEndpoint',
    'routeEncryptionPublicKey',
    'queryNonce',
    'returnRoutabilityCookie'
  ]) {
    const bytes = consumedProjection[name]
    t.alike(bytes, b4a.alloc(bytes.byteLength), `${name} projection is erased`)
  }
  exchange.responder.destroy()
})

test('candidate authority is zeroed on refresh, replacement, quarantine, expiry, and destroy', (t) => {
  const aliases = (state) => [
    state.encoded,
    state.endpoint,
    state.advertisement.relayIdentity,
    state.advertisement.currentDhtNodeId,
    state.advertisement.reachableEndpoint,
    state.advertisement.routeEncryptionPublicKey,
    state.advertisement.signature
  ]
  const assertCleared = (state, label) => {
    t.absent(state.active, label)
    t.is(state.binding, null, label)
    for (const bytes of aliases(state)) t.alike(bytes, b4a.alloc(bytes.byteLength), label)
  }

  {
    const directory = new RelayCapabilityDirectory({ now: () => NOW })
    const fixture = signedAdvertisement({ expiresAtMs: NOW + 60_000n })
    const first = activeExchange(directory, fixture)
    const state = directory._candidates.get(first.candidate)
    const oldNonce = state.binding.queryNonce
    const oldCookie = state.binding.returnRoutabilityCookie
    const refreshed = activeExchange(directory, fixture)
    t.is(refreshed.candidate, first.candidate)
    t.alike(oldNonce, b4a.alloc(32), 'refresh erases the superseded nonce')
    t.alike(oldCookie, b4a.alloc(32), 'refresh erases the superseded cookie')
    t.ok(state.active, 'refresh preserves the accepted current candidate')
    first.responder.destroy()
    refreshed.responder.destroy()
    directory.destroy()
  }

  {
    const directory = new RelayCapabilityDirectory({ now: () => NOW })
    const fixture = signedAdvertisement({ expiresAtMs: NOW + 60_000n })
    const exchange = activeExchange(directory, fixture)
    const state = directory._candidates.get(exchange.candidate)
    const replacement = signedAdvertisement({
      epoch: 8n,
      expiresAtMs: NOW + 60_000n,
      routeEncryptionPublicKey: routeKey(44).publicKey
    })
    directory.admit(replacement.encoded, {
      observedEndpoint: replacement.value.reachableEndpoint
    })
    assertCleared(state, 'replacement')
    exchange.responder.destroy()
    directory.destroy()
  }

  {
    const directory = new RelayCapabilityDirectory({ now: () => NOW })
    const fixture = signedAdvertisement({ expiresAtMs: NOW + 60_000n })
    const exchange = activeExchange(directory, fixture)
    const state = directory._candidates.get(exchange.candidate)
    const conflicting = signedAdvertisement({
      expiresAtMs: NOW + 60_000n,
      maxQueuedBytes: 262_145
    })
    expectCode(
      t,
      () =>
        directory.admit(conflicting.encoded, {
          observedEndpoint: conflicting.value.reachableEndpoint
        }),
      'ERR_AUTHENTICATION'
    )
    assertCleared(state, 'quarantine')
    exchange.responder.destroy()
    directory.destroy()
  }

  {
    let now = NOW
    const directory = new RelayCapabilityDirectory({ now: () => now })
    const fixture = signedAdvertisement({ expiresAtMs: NOW + 1n })
    const exchange = activeExchange(directory, fixture, { now: () => now })
    const state = directory._candidates.get(exchange.candidate)
    now++
    t.is(directory.diagnostics().identities, 0)
    assertCleared(state, 'expiry')
    exchange.responder.destroy()
    directory.destroy()
  }

  {
    const directory = new RelayCapabilityDirectory({ now: () => NOW })
    const fixture = signedAdvertisement({ expiresAtMs: NOW + 60_000n })
    const exchange = activeExchange(directory, fixture)
    const state = directory._candidates.get(exchange.candidate)
    directory.destroy()
    assertCleared(state, 'destroy')
    exchange.responder.destroy()
  }
})
