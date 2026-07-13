import test from 'brittle'
import b4a from 'b4a'

import * as routes from '../index.js'
import {
  descriptorChecker,
  expectCode,
  privateRoleIdentity,
  safetyRoleIdentity,
  seed
} from './helpers.js'

function signedAdvertisement(identity, overrides = {}) {
  return routes.signRelayAdvertisement(
    {
      version: routes.PROTOCOL_VERSION,
      identityKey: identity.publicKey,
      routeEncryptionKey: seed(90),
      dial: b4a.from('public.example:49737'),
      role: routes.roleForIdentity(identity.publicKey),
      capabilities: routes.CAPABILITY.KNOWN,
      epoch: 7n,
      expiresAt: 1_000_000n,
      ...overrides
    },
    identity.secretKey
  )
}

function evidenceFixture(overrides = {}) {
  let current = 100_000n
  const authority = routes.createDiscoveryEvidenceAuthority({
    now: () => current,
    ...overrides
  })

  return {
    ...authority,
    setNow(value) {
      current = value
    }
  }
}

function receiptFor(receiptIssuer, encoded, advertisement, overrides = {}) {
  return receiptIssuer.issue({
    advertisementHash32: routes.cryptoSuite.hash(encoded),
    peerIdentity32: advertisement.identityKey,
    observedDial: advertisement.dial,
    observedAt: 99_000n,
    channel: routes.PUBLIC_DHT,
    ...overrides
  })
}

function numericIdentity(value) {
  const identity = b4a.alloc(32)
  identity.writeUInt32BE(value, 28)
  return identity
}

test('discovery evidence authority exposes three isolated frozen capabilities', (t) => {
  const authority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })

  t.alike(Object.keys(authority).sort(), ['checker', 'receiptIssuer', 'verifier'])
  t.ok(authority.receiptIssuer !== authority.verifier)
  t.ok(authority.verifier !== authority.checker)
  t.ok(authority.checker !== authority.receiptIssuer)
  t.ok(Object.isFrozen(authority.receiptIssuer))
  t.ok(Object.isFrozen(authority.verifier))
  t.ok(Object.isFrozen(authority.checker))
  t.alike(Object.keys(authority.receiptIssuer), ['issue'])
  t.alike(Object.keys(authority.verifier), ['verify'])
  t.alike(Object.keys(authority.checker).sort(), ['isVerified', 'read'])
})

test('a fresh public-DHT receipt verifies one signed advertisement', (t) => {
  const identity = privateRoleIdentity(40)
  const advertisement = signedAdvertisement(identity)
  const encoded = routes.encodeRelayAdvertisement(advertisement)
  const { receiptIssuer, verifier, checker } = evidenceFixture()
  const receipt = receiptFor(receiptIssuer, encoded, advertisement)
  const evidence = verifier.verify(encoded, receipt)

  t.ok(checker.isVerified(evidence))
  t.absent(checker.isVerified({ ...evidence }))
  t.absent(checker.isVerified(checker.read(evidence)))
  t.alike(checker.read(evidence).peerIdentity32, identity.publicKey)
  t.alike(checker.read(evidence).observedDial, advertisement.dial)
  t.is(checker.read(evidence).epoch, 7n)
  t.is(checker.read(evidence).channel, routes.PUBLIC_DHT)
})

test('discovery evidence is copy-on-read and independent of caller route bytes', (t) => {
  const identity = privateRoleIdentity(40)
  const advertisement = signedAdvertisement(identity)
  const encoded = routes.encodeRelayAdvertisement(advertisement)
  const expectedEncoding = b4a.from(encoded)
  const { receiptIssuer, verifier, checker } = evidenceFixture()
  const receipt = receiptFor(receiptIssuer, encoded, advertisement)
  const evidence = verifier.verify(encoded, receipt)

  encoded.fill(0)
  advertisement.identityKey.fill(0)
  advertisement.dial.fill(0)
  const first = checker.read(evidence)
  first.peerIdentity32.fill(0)
  first.observedDial.fill(0)
  first.advertisementHash32.fill(0)
  first.advertisementEncoding.fill(0)
  const second = checker.read(evidence)

  t.alike(second.advertisementEncoding, expectedEncoding)
  t.ok(second.peerIdentity32.some((byte) => byte !== 0))
  t.ok(second.observedDial.some((byte) => byte !== 0))
  t.ok(second.advertisementHash32.some((byte) => byte !== 0))
  expectCode(t, () => checker.read({}), 'UNAUTHORIZED')
})

test('discovery receipt is single-use even after a failed replay', (t) => {
  const identity = privateRoleIdentity(40)
  const advertisement = signedAdvertisement(identity)
  const encoded = routes.encodeRelayAdvertisement(advertisement)
  const { receiptIssuer, verifier } = evidenceFixture()
  const receipt = receiptFor(receiptIssuer, encoded, advertisement)

  verifier.verify(encoded, receipt)
  expectCode(t, () => verifier.verify(encoded, receipt), 'REPLAY')
  expectCode(t, () => verifier.verify(encoded, { ...receipt }), 'UNAUTHORIZED')
})

test('discovery verification rejects stale, future, and expired observations', (t) => {
  const identity = privateRoleIdentity(40)
  const advertisement = signedAdvertisement(identity)
  const encoded = routes.encodeRelayAdvertisement(advertisement)
  const fixture = evidenceFixture()

  for (const [observedAt, code] of [
    [69_999n, 'UNAUTHORIZED'],
    [100_001n, 'UNAUTHORIZED']
  ]) {
    const receipt = receiptFor(fixture.receiptIssuer, encoded, advertisement, { observedAt })
    expectCode(t, () => fixture.verifier.verify(encoded, receipt), code)
  }

  const expiredAdvertisement = signedAdvertisement(identity, { expiresAt: 100_000n })
  const expiredEncoding = routes.encodeRelayAdvertisement(expiredAdvertisement)
  const receipt = receiptFor(fixture.receiptIssuer, expiredEncoding, expiredAdvertisement)
  expectCode(t, () => fixture.verifier.verify(expiredEncoding, receipt), 'UNAUTHORIZED')
})

test('discovery freshness is fixed at exactly thirty seconds', (t) => {
  const identity = privateRoleIdentity(40)
  const advertisement = signedAdvertisement(identity)
  const encoded = routes.encodeRelayAdvertisement(advertisement)
  const fixture = evidenceFixture()

  t.is(routes.DISCOVERY_MAX_AGE, 30_000n)
  const boundary = receiptFor(fixture.receiptIssuer, encoded, advertisement, {
    observedAt: 70_000n
  })
  t.ok(fixture.checker.isVerified(fixture.verifier.verify(encoded, boundary)))
  const stale = receiptFor(fixture.receiptIssuer, encoded, advertisement, {
    observedAt: 69_999n
  })
  expectCode(t, () => fixture.verifier.verify(encoded, stale), 'UNAUTHORIZED')
  expectCode(
    t,
    () => routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n, maxAge: 30_001 }),
    'INVALID_ROUTE'
  )
})

test('discovery verification rejects peer, dial, hash, and channel mismatches', (t) => {
  const identity = privateRoleIdentity(40)
  const other = privateRoleIdentity(80)
  const advertisement = signedAdvertisement(identity)
  const encoded = routes.encodeRelayAdvertisement(advertisement)
  const fixture = evidenceFixture()
  const cases = [
    { peerIdentity32: other.publicKey },
    { observedDial: b4a.from('other.example:49737') },
    { advertisementHash32: seed(222) }
  ]

  for (const overrides of cases) {
    const receipt = receiptFor(fixture.receiptIssuer, encoded, advertisement, overrides)
    expectCode(t, () => fixture.verifier.verify(encoded, receipt), 'UNAUTHORIZED')
  }

  expectCode(
    t,
    () => receiptFor(fixture.receiptIssuer, encoded, advertisement, { channel: 1 }),
    'INVALID_ROUTE'
  )
})

test('signed route advertisements cannot bypass the receipt authority', (t) => {
  const identity = privateRoleIdentity(40)
  const advertisement = signedAdvertisement(identity)
  const encoded = routes.encodeRelayAdvertisement(advertisement)
  const { verifier } = evidenceFixture()

  expectCode(t, () => verifier.verify(encoded, {}), 'UNAUTHORIZED')
  expectCode(t, () => verifier.verify(encoded, b4a.from(encoded)), 'UNAUTHORIZED')
})

function verifiedEvidence(identity, overrides = {}) {
  const fixture = evidenceFixture()
  const advertisement = signedAdvertisement(identity, overrides)
  const encoded = routes.encodeRelayAdvertisement(advertisement)
  const receipt = receiptFor(fixture.receiptIssuer, encoded, advertisement)
  return { evidence: fixture.verifier.verify(encoded, receipt), checker: fixture.checker }
}

function verifiedRouteDescriptor(entryIdentity, overrides = {}) {
  const endpoint = routes.cryptoSuite.keyPair(seed(180))
  const entry = signedAdvertisement(entryIdentity, {
    dial: b4a.from('private-entry.example:49737'),
    epoch: 7n,
    expiresAt: 900_000n,
    ...overrides.entry
  })
  const descriptor = routes.signDescriptor(
    {
      version: routes.PROTOCOL_VERSION,
      authorizationMode: routes.AUTHORIZATION_MODE.DIRECT,
      descriptorId: seed(181),
      endpointKey: endpoint.publicKey,
      routeSigningKey: endpoint.publicKey,
      routeEncryptionKey: seed(182),
      entryAdvertisement: routes.encodeRelayAdvertisement(entry),
      epoch: entry.epoch,
      expiresAt: entry.expiresAt,
      capabilities: entry.capabilities,
      cellSize: 1200,
      encryptedHops: b4a.from('opaque-route'),
      ...overrides.descriptor
    },
    endpoint.secretKey
  )
  return routes.verifyDescriptor(routes.encodeDescriptor(descriptor), {
    requestedEndpointKey: endpoint.publicKey,
    now: 100_000n
  })
}

test('circuit authority issues only opaque role-correct final-safety capabilities', (t) => {
  const safety = safetyRoleIdentity(100)
  const entry = privateRoleIdentity(120)
  const authority = routes.createCircuitAuthority()
  const value = {
    circuitId: b4a.alloc(16, 4),
    epoch: 7n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: entry.publicKey,
    expiresAt: 200_000n
  }
  const context = authority.issuer.issueFinalSafety(value)

  t.alike(Object.keys(authority).sort(), ['checker', 'issuer'])
  t.ok(Object.isFrozen(authority.issuer))
  t.ok(Object.isFrozen(authority.checker))
  t.alike(Object.keys(authority.issuer), ['issueFinalSafety'])
  t.alike(Object.keys(authority.checker), ['read'])
  t.alike(authority.checker.read(context), value)
  t.absent(authority.checker.isVerified)
  expectCode(t, () => authority.checker.read({ ...context }), 'UNAUTHORIZED')
  expectCode(
    t,
    () => authority.issuer.issueFinalSafety({ ...value, finalSafetyIdentity32: entry.publicKey }),
    'UNAUTHORIZED'
  )
  expectCode(
    t,
    () => authority.issuer.issueFinalSafety({ ...value, entryIdentity32: safety.publicKey }),
    'UNAUTHORIZED'
  )

  const first = authority.checker.read(context)
  first.circuitId.fill(0)
  first.finalSafetyIdentity32.fill(0)
  t.alike(authority.checker.read(context), value)
})

function policyFixture() {
  let current = 100_000n
  const safety = safetyRoleIdentity(100)
  const entry = privateRoleIdentity(120)
  const otherEntry = privateRoleIdentity(150)
  const publicResult = verifiedEvidence(safety)
  const circuitAuthority = routes.createCircuitAuthority()
  const context = circuitAuthority.issuer.issueFinalSafety({
    circuitId: b4a.alloc(16, 4),
    epoch: 7n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: entry.publicKey,
    expiresAt: 200_000n
  })
  const registry = new routes.PrivacyDomainRegistry({
    evidenceChecker: publicResult.checker,
    descriptorChecker: descriptorChecker(),
    circuitChecker: circuitAuthority.checker,
    now: () => current
  })

  return {
    registry,
    safety,
    entry,
    otherEntry,
    evidence: publicResult.evidence,
    circuitAuthority,
    context,
    setNow(value) {
      current = value
    }
  }
}

test('privacy registry implements the exact private-mode operation matrix', (t) => {
  const fixture = policyFixture()
  const { registry, safety, entry, evidence, context } = fixture
  const descriptor = verifiedRouteDescriptor(entry)

  registry.learnPublic(evidence)
  registry.learnRoute(entry.publicKey, {
    provenance: 'route-entry',
    descriptor,
    circuitContext: context
  })

  const cases = [
    [safety.publicKey, 'guard-dial', { selectedGuard: true }, true],
    [safety.publicKey, 'guard-dial', {}, false],
    [entry.publicKey, 'guard-dial', { selectedGuard: true }, false],
    [entry.publicKey, 'route-entry-dial', context, true],
    [entry.publicKey, 'route-forward', { epoch: 7n }, true],
    [entry.publicKey, 'direct-dial', {}, false],
    [entry.publicKey, 'direct-ping', {}, false],
    [safety.publicKey, 'public-return', { consumer: 'relay-discovery' }, true],
    [safety.publicKey, 'public-return', { consumer: 'endpoint' }, false],
    [safety.publicKey, 'unknown-operation', {}, false]
  ]
  for (const [identity, operation, operationContext, expected] of cases) {
    t.is(registry.allows(identity, operation, operationContext), expected)
  }
})

test('guard and public-return contexts require exact own data properties without throwing', (t) => {
  const fixture = policyFixture()
  fixture.registry.learnPublic(fixture.evidence)

  const inheritedGuard = Object.create({ selectedGuard: true })
  const getterGuard = Object.defineProperty({}, 'selectedGuard', {
    enumerable: true,
    get() {
      throw new Error('guard getter must not run')
    }
  })
  const proxyGuard = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('guard proxy must not run')
      },
      get() {
        throw new Error('guard proxy must not run')
      }
    }
  )
  const cyclicGuard = { selectedGuard: true }
  cyclicGuard.self = cyclicGuard
  const invalidGuards = [
    { selectedGuard: true, extra: true },
    inheritedGuard,
    getterGuard,
    proxyGuard,
    cyclicGuard,
    null,
    'guard'
  ]

  t.is(
    fixture.registry.allows(fixture.safety.publicKey, 'guard-dial', { selectedGuard: true }),
    true
  )
  for (const context of invalidGuards) {
    t.is(fixture.registry.allows(fixture.safety.publicKey, 'guard-dial', context), false)
  }

  const inheritedReturn = Object.create({ consumer: 'relay-discovery' })
  const getterReturn = Object.defineProperty({}, 'consumer', {
    enumerable: true,
    get() {
      throw new Error('return getter must not run')
    }
  })
  const proxyReturn = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('return proxy must not run')
      },
      get() {
        throw new Error('return proxy must not run')
      }
    }
  )
  const cyclicReturn = { consumer: 'relay-discovery' }
  cyclicReturn.self = cyclicReturn
  const invalidReturns = [
    { consumer: 'relay-discovery', extra: true },
    inheritedReturn,
    getterReturn,
    proxyReturn,
    cyclicReturn,
    null,
    'return'
  ]

  t.is(
    fixture.registry.allows(fixture.safety.publicKey, 'public-return', {
      consumer: 'relay-discovery'
    }),
    true
  )
  for (const context of invalidReturns) {
    t.is(fixture.registry.allows(fixture.safety.publicKey, 'public-return', context), false)
  }
})

test('private-only route material never promotes public or direct authorization', (t) => {
  const { registry, entry } = policyFixture()
  registry.learnRoute(entry.publicKey, {
    provenance: 'private-only',
    epoch: 7n,
    expiresAt: 200_000n
  })

  t.is(registry.allows(entry.publicKey, 'route-forward'), false)
  t.is(registry.allows(entry.publicKey, 'route-forward', {}), false)
  t.is(registry.allows(entry.publicKey, 'route-forward', { epoch: 7 }), false)
  t.is(registry.allows(entry.publicKey, 'route-forward', { epoch: 7n }), true)
  t.is(registry.allows(entry.publicKey, 'route-forward', { epoch: 8n }), false)
  t.is(registry.allows(entry.publicKey, 'guard-dial', { selectedGuard: true }), false)
  t.is(registry.allows(entry.publicKey, 'direct-dial'), false)
  t.is(registry.allows(entry.publicKey, 'direct-ping'), false)
  t.is(registry.allows(entry.publicKey, 'public-return', { consumer: 'relay-discovery' }), false)
  expectCode(
    t,
    () => registry.learnPublic({ peerIdentity32: entry.publicKey, authenticated: true }),
    'UNAUTHORIZED'
  )
})

test('invalid route imports do not allocate identity records', (t) => {
  const fixture = policyFixture()

  for (let value = 1; value <= 32; value++) {
    expectCode(
      t,
      () =>
        fixture.registry.learnRoute(numericIdentity(value), {
          provenance: 'private-only',
          epoch: 7,
          expiresAt: 200_000n
        }),
      'INVALID_ROUTE'
    )
  }

  t.is(fixture.registry.size, 0)
})

test('route-entry requires Task 4 brand and exact circuit identity, epoch, and expiry', (t) => {
  const fixture = policyFixture()
  const { registry, entry, otherEntry, safety, circuitAuthority, context } = fixture
  const descriptor = verifiedRouteDescriptor(entry)
  registry.learnRoute(entry.publicKey, {
    provenance: 'route-entry',
    descriptor,
    circuitContext: context
  })

  const otherCircuit = circuitAuthority.issuer.issueFinalSafety({
    circuitId: b4a.alloc(16, 5),
    epoch: 7n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: entry.publicKey,
    expiresAt: 200_000n
  })
  const otherEpoch = circuitAuthority.issuer.issueFinalSafety({
    circuitId: b4a.alloc(16, 4),
    epoch: 8n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: entry.publicKey,
    expiresAt: 200_000n
  })
  const otherRelay = circuitAuthority.issuer.issueFinalSafety({
    circuitId: b4a.alloc(16, 4),
    epoch: 7n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: otherEntry.publicKey,
    expiresAt: 200_000n
  })

  for (const invalid of [{ ...context }, 'circuit', otherCircuit, otherEpoch, otherRelay]) {
    t.is(registry.allows(entry.publicKey, 'route-entry-dial', invalid), false)
  }
  fixture.setNow(200_000n)
  t.is(registry.allows(entry.publicKey, 'route-entry-dial', context), false)
  t.is(registry.allows(entry.publicKey, 'route-forward', { epoch: 7n }), true)

  expectCode(
    t,
    () =>
      new routes.PrivacyDomainRegistry({
        evidenceChecker: verifiedEvidence(safety).checker,
        descriptorChecker: Object.freeze({
          isVerified: () => true,
          read: () => routes.readVerifiedDescriptor(descriptor)
        }),
        circuitChecker: circuitAuthority.checker,
        now: () => 100_000n
      }),
    'UNAUTHORIZED'
  )
})

test('route-entry circuit expiry is part of the exact installed binding', (t) => {
  const fixture = policyFixture()
  const { registry, entry, safety, circuitAuthority } = fixture
  const installed = circuitAuthority.issuer.issueFinalSafety({
    circuitId: b4a.alloc(16, 12),
    epoch: 7n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: entry.publicKey,
    expiresAt: 110_000n
  })
  const extended = circuitAuthority.issuer.issueFinalSafety({
    circuitId: b4a.alloc(16, 12),
    epoch: 7n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: entry.publicKey,
    expiresAt: 200_000n
  })
  registry.learnRoute(entry.publicKey, {
    provenance: 'route-entry',
    descriptor: verifiedRouteDescriptor(entry),
    circuitContext: installed
  })

  t.is(registry.allows(entry.publicKey, 'route-entry-dial', extended), false)
  fixture.setNow(150_000n)
  t.is(registry.allows(entry.publicKey, 'route-entry-dial', installed), false)
  t.is(registry.allows(entry.publicKey, 'route-entry-dial', extended), false)
})

test('expired public and route records deny only their own operations', (t) => {
  const fixture = policyFixture()
  const { registry, safety, entry, evidence } = fixture
  registry.learnPublic(evidence)
  registry.learnRoute(entry.publicKey, {
    provenance: 'private-only',
    epoch: 7n,
    expiresAt: 150_000n
  })
  fixture.setNow(150_000n)

  t.is(registry.allows(entry.publicKey, 'route-forward', { epoch: 7n }), false)
  t.is(registry.allows(safety.publicKey, 'guard-dial', { selectedGuard: true }), true)
  fixture.setNow(1_000_000n)
  t.is(registry.allows(safety.publicKey, 'guard-dial', { selectedGuard: true }), false)
})

test('route-entry expires with its verified descriptor before its relay advertisement', (t) => {
  const fixture = policyFixture()
  const { registry, entry, context } = fixture
  registry.learnRoute(entry.publicKey, {
    provenance: 'route-entry',
    descriptor: verifiedRouteDescriptor(entry, {
      entry: { expiresAt: 900_000n },
      descriptor: { expiresAt: 150_000n }
    }),
    circuitContext: context
  })
  fixture.setNow(150_000n)

  t.is(registry.allows(entry.publicKey, 'route-entry-dial', context), false)
  t.is(registry.allows(entry.publicKey, 'route-forward', { epoch: 7n }), false)
})

test('forged checker capabilities cannot mint registry provenance', (t) => {
  const circuitAuthority = routes.createCircuitAuthority()
  const realEvidence = verifiedEvidence(safetyRoleIdentity(100))
  const options = {
    evidenceChecker: realEvidence.checker,
    descriptorChecker: descriptorChecker(),
    circuitChecker: circuitAuthority.checker,
    now: () => 100_000n
  }

  expectCode(
    t,
    () =>
      new routes.PrivacyDomainRegistry({
        ...options,
        evidenceChecker: Object.freeze({ isVerified: () => true, read: () => ({}) })
      }),
    'UNAUTHORIZED'
  )
  expectCode(
    t,
    () =>
      new routes.PrivacyDomainRegistry({
        ...options,
        circuitChecker: Object.freeze({ read: () => ({}) })
      }),
    'UNAUTHORIZED'
  )
})

test('registry snapshots checker capabilities before caller mutation', (t) => {
  const safety = safetyRoleIdentity(100)
  const entry = privateRoleIdentity(120)
  const evidenceResult = verifiedEvidence(safety)
  const circuitAuthority = routes.createCircuitAuthority()
  const context = circuitAuthority.issuer.issueFinalSafety({
    circuitId: b4a.alloc(16, 13),
    epoch: 7n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: entry.publicKey,
    expiresAt: 200_000n
  })
  const descriptor = verifiedRouteDescriptor(entry)
  const mutableDescriptorChecker = {
    isVerified: routes.isVerifiedDescriptor,
    read: routes.readVerifiedDescriptor
  }
  const registry = new routes.PrivacyDomainRegistry({
    evidenceChecker: evidenceResult.checker,
    descriptorChecker: mutableDescriptorChecker,
    circuitChecker: circuitAuthority.checker,
    now: () => 100_000n
  })

  mutableDescriptorChecker.isVerified = () => true
  mutableDescriptorChecker.read = () => routes.readVerifiedDescriptor(descriptor)
  expectCode(
    t,
    () =>
      registry.learnRoute(entry.publicKey, {
        provenance: 'route-entry',
        descriptor: {},
        circuitContext: context
      }),
    'UNAUTHORIZED'
  )

  t.is(
    Reflect.set(evidenceResult.checker, 'isVerified', () => false),
    false
  )
  t.is(
    Reflect.set(circuitAuthority.checker, 'read', () => ({})),
    false
  )
  registry.learnPublic(evidenceResult.evidence)
  t.is(registry.allows(safety.publicKey, 'guard-dial', { selectedGuard: true }), true)
})

function issueEvidence(authority, identity, overrides = {}) {
  const advertisement = signedAdvertisement(identity, overrides)
  const encoded = routes.encodeRelayAdvertisement(advertisement)
  const receipt = receiptFor(authority.receiptIssuer, encoded, advertisement)
  return authority.verifier.verify(encoded, receipt)
}

function registryFor(evidenceChecker, circuitChecker, now, limits) {
  return new routes.PrivacyDomainRegistry({
    evidenceChecker,
    descriptorChecker: descriptorChecker(),
    circuitChecker,
    now,
    limits
  })
}

function smallLimits(overrides = {}) {
  return {
    maxIdentities: 2,
    maxPublicEpochsPerIdentity: 2,
    maxRouteEpochsPerIdentity: 2,
    maxCircuitsPerEpoch: 2,
    ...overrides
  }
}

test('registry bounds identities and prunes expired nonquarantined records', (t) => {
  t.is(routes.MAX_IDENTITIES, 4096)
  t.is(routes.MAX_PUBLIC_EPOCHS_PER_IDENTITY, 8)
  t.is(routes.MAX_ROUTE_EPOCHS_PER_IDENTITY, 8)
  t.is(routes.MAX_CIRCUITS_PER_EPOCH, 128)

  let current = 100_000n
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()
  const registry = registryFor(
    evidenceAuthority.checker,
    circuitAuthority.checker,
    () => current,
    smallLimits()
  )
  for (let value = 1; value <= 2; value++) {
    registry.learnRoute(numericIdentity(value), {
      provenance: 'private-only',
      epoch: 7n,
      expiresAt: 110_000n
    })
  }
  expectCode(
    t,
    () =>
      registry.learnRoute(numericIdentity(3), {
        provenance: 'private-only',
        epoch: 7n,
        expiresAt: 200_000n
      }),
    'CIRCUIT_LIMIT'
  )
  t.is(registry.size, 2)
  current = 110_000n
  registry.learnRoute(numericIdentity(3), {
    provenance: 'private-only',
    epoch: 7n,
    expiresAt: 200_000n
  })
  t.is(registry.size, 1)
})

test('registry amortizes capacity sweeps until the earliest known expiry', (t) => {
  let current = 50_000n
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 50_000n })
  const circuitAuthority = routes.createCircuitAuthority()
  const registry = registryFor(
    evidenceAuthority.checker,
    circuitAuthority.checker,
    () => current,
    smallLimits()
  )
  registry.learnRoute(numericIdentity(1), {
    provenance: 'private-only',
    epoch: 7n,
    expiresAt: 100_000n
  })
  registry.learnRoute(numericIdentity(2), {
    provenance: 'private-only',
    epoch: 7n,
    expiresAt: 200_000n
  })
  t.is(registry.sweepCount, 0)

  for (const value of [3, 4, 5]) {
    expectCode(
      t,
      () =>
        registry.learnRoute(numericIdentity(value), {
          provenance: 'private-only',
          epoch: 7n,
          expiresAt: 300_000n
        }),
      'CIRCUIT_LIMIT'
    )
    t.is(registry.sweepCount, 0)
  }

  current = 100_000n
  registry.learnRoute(numericIdentity(3), {
    provenance: 'private-only',
    epoch: 7n,
    expiresAt: 300_000n
  })
  t.is(registry.sweepCount, 1)
  t.is(registry.size, 2)

  for (const value of [4, 5]) {
    expectCode(
      t,
      () =>
        registry.learnRoute(numericIdentity(value), {
          provenance: 'private-only',
          epoch: 7n,
          expiresAt: 300_000n
        }),
      'CIRCUIT_LIMIT'
    )
    t.is(registry.sweepCount, 1)
  }
})

test('all-quarantined capacity rejects without global sweeps', (t) => {
  let current = 100_000n
  const safety = safetyRoleIdentity(100)
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()
  const registry = registryFor(
    evidenceAuthority.checker,
    circuitAuthority.checker,
    () => current,
    smallLimits({ maxIdentities: 1 })
  )
  registry.learnPublic(issueEvidence(evidenceAuthority, safety, { expiresAt: 200_000n }))
  registry.learnPublic(
    issueEvidence(evidenceAuthority, safety, {
      expiresAt: 200_000n,
      dial: b4a.from('capacity-quarantine.example:49737')
    })
  )

  current = 200_000n
  for (const value of [1, 2, 3]) {
    expectCode(
      t,
      () =>
        registry.learnRoute(numericIdentity(value), {
          provenance: 'private-only',
          epoch: 7n,
          expiresAt: 300_000n
        }),
      'CIRCUIT_LIMIT'
    )
    t.is(registry.sweepCount, 0)
  }
})

test('registry hot paths prune only the requested identity', (t) => {
  let current = 100_000n
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()
  const registry = registryFor(
    evidenceAuthority.checker,
    circuitAuthority.checker,
    () => current,
    smallLimits()
  )
  const expiredIdentity = numericIdentity(1)
  const existingIdentity = numericIdentity(2)
  const admittedIdentity = numericIdentity(3)

  registry.learnRoute(expiredIdentity, {
    provenance: 'private-only',
    epoch: 7n,
    expiresAt: 110_000n
  })
  registry.learnRoute(existingIdentity, {
    provenance: 'private-only',
    epoch: 7n,
    expiresAt: 200_000n
  })

  current = 110_000n
  t.is(registry.allows(existingIdentity, 'route-forward', { epoch: 7n }), true)
  t.is(registry.size, 2)

  registry.learnRoute(existingIdentity, {
    provenance: 'private-only',
    epoch: 8n,
    expiresAt: 200_000n
  })
  t.is(registry.size, 2)

  registry.learnRoute(admittedIdentity, {
    provenance: 'private-only',
    epoch: 7n,
    expiresAt: 200_000n
  })
  t.is(registry.size, 2)
})

test('quarantine tombstones are sticky and count against the identity bound', (t) => {
  const safety = safetyRoleIdentity(100)
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()
  const registry = registryFor(
    evidenceAuthority.checker,
    circuitAuthority.checker,
    () => 500_000n,
    smallLimits()
  )
  registry.learnPublic(issueEvidence(evidenceAuthority, safety, { expiresAt: 600_000n, epoch: 7n }))
  registry.learnPublic(
    issueEvidence(evidenceAuthority, safety, {
      expiresAt: 600_000n,
      epoch: 7n,
      dial: b4a.from('quarantine.example:49737')
    })
  )
  registry.learnRoute(numericIdentity(1000), {
    provenance: 'private-only',
    epoch: 1n,
    expiresAt: 600_000n
  })

  expectCode(
    t,
    () =>
      registry.learnRoute(numericIdentity(1001), {
        provenance: 'private-only',
        epoch: 1n,
        expiresAt: 600_000n
      }),
    'CIRCUIT_LIMIT'
  )
  t.is(registry.size, 2)
  t.is(registry.allows(safety.publicKey, 'guard-dial', { selectedGuard: true }), false)
})

test('registry bounds and prunes public and private route epochs', (t) => {
  let current = 100_000n
  const safety = safetyRoleIdentity(100)
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()
  const publicRegistry = registryFor(
    evidenceAuthority.checker,
    circuitAuthority.checker,
    () => current,
    smallLimits()
  )
  publicRegistry.learnPublic(
    issueEvidence(evidenceAuthority, safety, { epoch: 7n, expiresAt: 110_000n })
  )
  publicRegistry.learnPublic(
    issueEvidence(evidenceAuthority, safety, { epoch: 8n, expiresAt: 200_000n })
  )
  const epoch9 = issueEvidence(evidenceAuthority, safety, { epoch: 9n, expiresAt: 200_000n })
  expectCode(t, () => publicRegistry.learnPublic(epoch9), 'CIRCUIT_LIMIT')
  current = 110_000n
  publicRegistry.learnPublic(epoch9)
  t.is(publicRegistry.size, 1)

  current = 100_000n
  const routeRegistry = registryFor(
    evidenceAuthority.checker,
    circuitAuthority.checker,
    () => current,
    smallLimits()
  )
  for (const [epoch, expiresAt] of [
    [7n, 110_000n],
    [8n, 200_000n]
  ]) {
    routeRegistry.learnRoute(numericIdentity(2000), {
      provenance: 'private-only',
      epoch,
      expiresAt
    })
  }
  expectCode(
    t,
    () =>
      routeRegistry.learnRoute(numericIdentity(2000), {
        provenance: 'private-only',
        epoch: 9n,
        expiresAt: 200_000n
      }),
    'CIRCUIT_LIMIT'
  )
  current = 110_000n
  routeRegistry.learnRoute(numericIdentity(2000), {
    provenance: 'private-only',
    epoch: 9n,
    expiresAt: 200_000n
  })
  t.is(routeRegistry.size, 1)
})

test('registry bounds and prunes exact circuit bindings per route epoch', (t) => {
  let current = 100_000n
  const safety = safetyRoleIdentity(100)
  const entry = privateRoleIdentity(120)
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()
  const registry = registryFor(
    evidenceAuthority.checker,
    circuitAuthority.checker,
    () => current,
    smallLimits()
  )
  const descriptor = verifiedRouteDescriptor(entry, {
    entry: { expiresAt: 300_000n },
    descriptor: { expiresAt: 300_000n }
  })
  const contexts = [
    [21, 110_000n],
    [22, 200_000n],
    [23, 200_000n]
  ].map(([id, expiresAt]) =>
    circuitAuthority.issuer.issueFinalSafety({
      circuitId: b4a.alloc(16, id),
      epoch: 7n,
      finalSafetyIdentity32: safety.publicKey,
      entryIdentity32: entry.publicKey,
      expiresAt
    })
  )
  const learn = (circuitContext) =>
    registry.learnRoute(entry.publicKey, {
      provenance: 'route-entry',
      descriptor,
      circuitContext
    })
  learn(contexts[0])
  learn(contexts[1])
  expectCode(t, () => learn(contexts[2]), 'CIRCUIT_LIMIT')
  t.is(registry.allows(entry.publicKey, 'route-entry-dial', contexts[1]), true)
  current = 110_000n
  learn(contexts[2])
  t.is(registry.allows(entry.publicKey, 'route-entry-dial', contexts[2]), true)
})

test('same-epoch public claims conflict on canonical dial or capabilities and quarantine', (t) => {
  const safety = safetyRoleIdentity(100)
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()

  for (const changed of [
    { dial: b4a.from('conflict.example:49737') },
    { capabilities: routes.CAPABILITY.FORWARD }
  ]) {
    const registry = registryFor(
      evidenceAuthority.checker,
      circuitAuthority.checker,
      () => 100_000n
    )
    registry.learnPublic(issueEvidence(evidenceAuthority, safety))
    t.is(registry.allows(safety.publicKey, 'guard-dial', { selectedGuard: true }), true)
    registry.learnPublic(issueEvidence(evidenceAuthority, safety, changed))
    t.is(registry.allows(safety.publicKey, 'guard-dial', { selectedGuard: true }), false)
    t.is(registry.allows(safety.publicKey, 'public-return', { consumer: 'relay-discovery' }), false)
    registry.learnPublic(issueEvidence(evidenceAuthority, safety))
    t.is(registry.allows(safety.publicKey, 'guard-dial', { selectedGuard: true }), false)
  }
})

test('public claims are retained and compared independently per epoch', (t) => {
  let current = 100_000n
  const safety = safetyRoleIdentity(100)
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()
  const claim7 = {
    epoch: 7n,
    expiresAt: 150_000n,
    dial: b4a.from('public-epoch7.example:49737')
  }
  const claim8 = {
    epoch: 8n,
    expiresAt: 250_000n,
    dial: b4a.from('public-epoch8.example:49737'),
    routeEncryptionKey: seed(201)
  }
  const rotation = registryFor(evidenceAuthority.checker, circuitAuthority.checker, () => current)
  rotation.learnPublic(issueEvidence(evidenceAuthority, safety, claim7))
  rotation.learnPublic(issueEvidence(evidenceAuthority, safety, claim7))
  rotation.learnPublic(issueEvidence(evidenceAuthority, safety, claim8))

  current = 150_000n
  t.is(rotation.allows(safety.publicKey, 'guard-dial', { selectedGuard: true }), true)
  current = 250_000n
  t.is(rotation.allows(safety.publicKey, 'guard-dial', { selectedGuard: true }), false)

  current = 100_000n
  const conflict = registryFor(evidenceAuthority.checker, circuitAuthority.checker, () => current)
  conflict.learnPublic(issueEvidence(evidenceAuthority, safety, claim7))
  conflict.learnPublic(issueEvidence(evidenceAuthority, safety, claim8))
  conflict.learnPublic(
    issueEvidence(evidenceAuthority, safety, {
      ...claim7,
      dial: b4a.from('conflicting-old-epoch.example:49737')
    })
  )
  t.is(conflict.allows(safety.publicKey, 'guard-dial', { selectedGuard: true }), false)
  t.is(conflict.allows(safety.publicKey, 'public-return', { consumer: 'relay-discovery' }), false)
})

test('identical public claims retain their longest same-epoch expiry', (t) => {
  let current = 100_000n
  const safety = safetyRoleIdentity(100)
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()
  const long = { epoch: 7n, expiresAt: 200_000n }
  const short = { epoch: 7n, expiresAt: 150_000n }

  for (const claims of [
    [long, short],
    [short, long]
  ]) {
    const registry = registryFor(evidenceAuthority.checker, circuitAuthority.checker, () => current)
    for (const claim of claims)
      registry.learnPublic(issueEvidence(evidenceAuthority, safety, claim))
    current = 175_000n
    t.is(registry.allows(safety.publicKey, 'guard-dial', { selectedGuard: true }), true)
    t.is(registry.allows(safety.publicKey, 'public-return', { consumer: 'relay-discovery' }), true)
    current = 100_000n
  }
})

test('same-epoch descriptor and public claims conflict and quarantine every operation', (t) => {
  const safety = safetyRoleIdentity(100)
  const entry = privateRoleIdentity(120)
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()
  const context = circuitAuthority.issuer.issueFinalSafety({
    circuitId: b4a.alloc(16, 7),
    epoch: 7n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: entry.publicKey,
    expiresAt: 300_000n
  })
  const registry = registryFor(evidenceAuthority.checker, circuitAuthority.checker, () => 100_000n)

  registry.learnRoute(entry.publicKey, {
    provenance: 'route-entry',
    descriptor: verifiedRouteDescriptor(entry),
    circuitContext: context
  })
  registry.learnPublic(
    issueEvidence(evidenceAuthority, entry, {
      dial: b4a.from('different-public.example:49737'),
      epoch: 7n
    })
  )

  t.is(registry.allows(entry.publicKey, 'route-entry-dial', context), false)
  t.is(registry.allows(entry.publicKey, 'route-forward', { epoch: 7n }), false)
  t.is(registry.allows(entry.publicKey, 'public-return', { consumer: 'relay-discovery' }), false)
  t.is(registry.allows(entry.publicKey, 'direct-dial'), false)
})

test('matching public and route-entry provenance accumulates without promotion', (t) => {
  const safety = safetyRoleIdentity(100)
  const entry = privateRoleIdentity(120)
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()
  const context = circuitAuthority.issuer.issueFinalSafety({
    circuitId: b4a.alloc(16, 11),
    epoch: 7n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: entry.publicKey,
    expiresAt: 300_000n
  })
  const registry = registryFor(evidenceAuthority.checker, circuitAuthority.checker, () => 100_000n)

  registry.learnPublic(issueEvidence(evidenceAuthority, entry))
  registry.learnRoute(entry.publicKey, {
    provenance: 'route-entry',
    descriptor: verifiedRouteDescriptor(entry, {
      entry: {
        dial: b4a.from('public.example:49737'),
        routeEncryptionKey: seed(90)
      }
    }),
    circuitContext: context
  })

  t.alike(Object.keys(registry), [])
  t.is(registry.receiptIssuer, undefined)
  t.is(registry.verifier, undefined)
  t.is(registry.allows(entry.publicKey, 'route-entry-dial', context), true)
  t.is(registry.allows(entry.publicKey, 'route-forward', { epoch: 7n }), true)
  t.is(registry.allows(entry.publicKey, 'public-return', { consumer: 'relay-discovery' }), true)
  t.is(registry.allows(entry.publicKey, 'guard-dial', { selectedGuard: true }), false)
  t.is(registry.allows(entry.publicKey, 'direct-dial'), false)
})

test('same-epoch descriptor conflicts quarantine while identical claims are idempotent', (t) => {
  const safety = safetyRoleIdentity(100)
  const entry = privateRoleIdentity(120)
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()
  const context = circuitAuthority.issuer.issueFinalSafety({
    circuitId: b4a.alloc(16, 8),
    epoch: 7n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: entry.publicKey,
    expiresAt: 300_000n
  })
  const registry = registryFor(evidenceAuthority.checker, circuitAuthority.checker, () => 100_000n)
  const descriptor = verifiedRouteDescriptor(entry)

  for (const value of [descriptor, descriptor]) {
    registry.learnRoute(entry.publicKey, {
      provenance: 'route-entry',
      descriptor: value,
      circuitContext: context
    })
  }
  t.is(registry.allows(entry.publicKey, 'route-entry-dial', context), true)

  registry.learnRoute(entry.publicKey, {
    provenance: 'route-entry',
    descriptor: verifiedRouteDescriptor(entry, {
      entry: { dial: b4a.from('conflicting-entry.example:49737') }
    }),
    circuitContext: context
  })
  t.is(registry.allows(entry.publicKey, 'route-entry-dial', context), false)
  t.is(registry.allows(entry.publicKey, 'route-forward', { epoch: 7n }), false)
})

test('quarantine compacts claims and ignores all later valid learns', (t) => {
  const safety = safetyRoleIdentity(100)
  const entry = privateRoleIdentity(120)
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()
  const limits = smallLimits({
    maxPublicEpochsPerIdentity: 1,
    maxRouteEpochsPerIdentity: 1,
    maxCircuitsPerEpoch: 1
  })
  const publicRegistry = registryFor(
    evidenceAuthority.checker,
    circuitAuthority.checker,
    () => 100_000n,
    limits
  )

  publicRegistry.learnPublic(issueEvidence(evidenceAuthority, safety, { epoch: 7n }))
  publicRegistry.learnPublic(
    issueEvidence(evidenceAuthority, safety, {
      epoch: 7n,
      dial: b4a.from('quarantine-public.example:49737')
    })
  )
  for (const epoch of [8n, 9n]) {
    publicRegistry.learnPublic(issueEvidence(evidenceAuthority, safety, { epoch }))
    publicRegistry.learnRoute(safety.publicKey, {
      provenance: 'private-only',
      epoch,
      expiresAt: 900_000n
    })
  }
  t.is(publicRegistry.size, 1)
  t.is(publicRegistry.allows(safety.publicKey, 'guard-dial', { selectedGuard: true }), false)
  t.is(publicRegistry.allows(safety.publicKey, 'route-forward', { epoch: 9n }), false)

  const routeRegistry = registryFor(
    evidenceAuthority.checker,
    circuitAuthority.checker,
    () => 100_000n,
    limits
  )
  const context = circuitAuthority.issuer.issueFinalSafety({
    circuitId: b4a.alloc(16, 31),
    epoch: 7n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: entry.publicKey,
    expiresAt: 900_000n
  })
  routeRegistry.learnRoute(entry.publicKey, {
    provenance: 'route-entry',
    descriptor: verifiedRouteDescriptor(entry),
    circuitContext: context
  })
  routeRegistry.learnRoute(entry.publicKey, {
    provenance: 'route-entry',
    descriptor: verifiedRouteDescriptor(entry, {
      entry: { dial: b4a.from('quarantine-entry.example:49737') }
    }),
    circuitContext: context
  })

  for (const epoch of [8n, 9n]) {
    const laterContext = circuitAuthority.issuer.issueFinalSafety({
      circuitId: b4a.alloc(16, Number(epoch)),
      epoch,
      finalSafetyIdentity32: safety.publicKey,
      entryIdentity32: entry.publicKey,
      expiresAt: 900_000n
    })
    routeRegistry.learnRoute(entry.publicKey, {
      provenance: 'private-only',
      epoch,
      expiresAt: 900_000n
    })
    routeRegistry.learnRoute(entry.publicKey, {
      provenance: 'route-entry',
      descriptor: verifiedRouteDescriptor(entry, {
        entry: { epoch },
        descriptor: { descriptorId: b4a.alloc(32, Number(epoch)) }
      }),
      circuitContext: laterContext
    })
    t.is(routeRegistry.allows(entry.publicKey, 'route-entry-dial', laterContext), false)
  }
  t.is(routeRegistry.size, 1)
  t.is(routeRegistry.allows(entry.publicKey, 'route-entry-dial', context), false)
  t.is(routeRegistry.allows(entry.publicKey, 'route-forward', { epoch: 9n }), false)
})

test('private-only imports never erase same-epoch descriptor conflict claims', (t) => {
  const safety = safetyRoleIdentity(100)
  const entry = privateRoleIdentity(120)
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()
  const context = circuitAuthority.issuer.issueFinalSafety({
    circuitId: b4a.alloc(16, 14),
    epoch: 7n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: entry.publicKey,
    expiresAt: 300_000n
  })
  const descriptorA = verifiedRouteDescriptor(entry)
  const descriptorB = verifiedRouteDescriptor(entry, {
    entry: { dial: b4a.from('overwrite-conflict.example:49737') }
  })
  const descriptorMaterial = (descriptor) => ({
    provenance: 'route-entry',
    descriptor,
    circuitContext: context
  })
  const privateMaterial = {
    provenance: 'private-only',
    epoch: 7n,
    expiresAt: 250_000n
  }
  const sequences = [
    [descriptorMaterial(descriptorA), privateMaterial, descriptorMaterial(descriptorB)],
    [
      privateMaterial,
      descriptorMaterial(descriptorA),
      privateMaterial,
      descriptorMaterial(descriptorB)
    ]
  ]

  for (const sequence of sequences) {
    const registry = registryFor(
      evidenceAuthority.checker,
      circuitAuthority.checker,
      () => 100_000n
    )
    for (const material of sequence) registry.learnRoute(entry.publicKey, material)

    t.is(registry.allows(entry.publicKey, 'route-entry-dial', context), false)
    t.is(registry.allows(entry.publicKey, 'route-forward', { epoch: 7n }), false)
    t.is(registry.allows(entry.publicKey, 'direct-dial'), false)
  }
})

test('same-epoch descriptor and private-only lifetimes remain independent', (t) => {
  let current = 100_000n
  const safety = safetyRoleIdentity(100)
  const entry = privateRoleIdentity(120)
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()

  function setup({ circuitId, descriptorExpiresAt, privateExpiresAt }) {
    const context = circuitAuthority.issuer.issueFinalSafety({
      circuitId: b4a.alloc(16, circuitId),
      epoch: 7n,
      finalSafetyIdentity32: safety.publicKey,
      entryIdentity32: entry.publicKey,
      expiresAt: 300_000n
    })
    const descriptor = verifiedRouteDescriptor(entry, {
      entry: { expiresAt: 300_000n },
      descriptor: { expiresAt: descriptorExpiresAt }
    })
    const registry = registryFor(evidenceAuthority.checker, circuitAuthority.checker, () => current)
    const routeMaterial = { provenance: 'route-entry', descriptor, circuitContext: context }
    const privateMaterial = {
      provenance: 'private-only',
      epoch: 7n,
      expiresAt: privateExpiresAt
    }
    registry.learnRoute(entry.publicKey, routeMaterial)
    registry.learnRoute(entry.publicKey, routeMaterial)
    registry.learnRoute(entry.publicKey, privateMaterial)
    registry.learnRoute(entry.publicKey, privateMaterial)
    return { registry, context }
  }

  const privateOutlives = setup({
    circuitId: 15,
    descriptorExpiresAt: 150_000n,
    privateExpiresAt: 250_000n
  })
  const descriptorOutlives = setup({
    circuitId: 16,
    descriptorExpiresAt: 250_000n,
    privateExpiresAt: 150_000n
  })
  current = 150_000n

  t.is(
    privateOutlives.registry.allows(entry.publicKey, 'route-entry-dial', privateOutlives.context),
    false
  )
  t.is(privateOutlives.registry.allows(entry.publicKey, 'route-forward', { epoch: 7n }), true)
  t.is(
    descriptorOutlives.registry.allows(
      entry.publicKey,
      'route-entry-dial',
      descriptorOutlives.context
    ),
    true
  )
  t.is(descriptorOutlives.registry.allows(entry.publicKey, 'route-forward', { epoch: 7n }), true)
})

test('descriptor expiry strips its claim and circuits while preserving private-only lifetime', (t) => {
  let current = 100_000n
  const safety = safetyRoleIdentity(100)
  const entry = privateRoleIdentity(120)
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()
  const registry = registryFor(evidenceAuthority.checker, circuitAuthority.checker, () => current)
  const oldContext = circuitAuthority.issuer.issueFinalSafety({
    circuitId: b4a.alloc(16, 24),
    epoch: 7n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: entry.publicKey,
    expiresAt: 300_000n
  })
  registry.learnRoute(entry.publicKey, {
    provenance: 'route-entry',
    descriptor: verifiedRouteDescriptor(entry, {
      entry: { expiresAt: 300_000n },
      descriptor: { expiresAt: 150_000n }
    }),
    circuitContext: oldContext
  })
  registry.learnRoute(entry.publicKey, {
    provenance: 'private-only',
    epoch: 7n,
    expiresAt: 250_000n
  })
  current = 150_000n

  t.is(registry.allows(entry.publicKey, 'route-entry-dial', oldContext), false)
  t.is(registry.allows(entry.publicKey, 'route-forward', { epoch: 7n }), true)

  const newContext = circuitAuthority.issuer.issueFinalSafety({
    circuitId: b4a.alloc(16, 25),
    epoch: 7n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: entry.publicKey,
    expiresAt: 300_000n
  })
  registry.learnRoute(entry.publicKey, {
    provenance: 'route-entry',
    descriptor: verifiedRouteDescriptor(entry, {
      entry: {
        expiresAt: 300_000n,
        dial: b4a.from('replacement-claim.example:49737'),
        routeEncryptionKey: seed(211)
      },
      descriptor: { expiresAt: 300_000n }
    }),
    circuitContext: newContext
  })

  t.is(registry.allows(entry.publicKey, 'route-entry-dial', oldContext), false)
  t.is(registry.allows(entry.publicKey, 'route-entry-dial', newContext), true)
  t.is(registry.allows(entry.publicKey, 'route-forward', { epoch: 7n }), true)
})

test('descriptor expiry removes an otherwise empty identity despite a longer circuit', (t) => {
  let current = 100_000n
  const safety = safetyRoleIdentity(100)
  const entry = privateRoleIdentity(120)
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()
  const registry = registryFor(evidenceAuthority.checker, circuitAuthority.checker, () => current)
  const context = circuitAuthority.issuer.issueFinalSafety({
    circuitId: b4a.alloc(16, 26),
    epoch: 7n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: entry.publicKey,
    expiresAt: 300_000n
  })
  registry.learnRoute(entry.publicKey, {
    provenance: 'route-entry',
    descriptor: verifiedRouteDescriptor(entry, {
      entry: { expiresAt: 300_000n },
      descriptor: { expiresAt: 150_000n }
    }),
    circuitContext: context
  })
  current = 150_000n

  t.is(registry.allows(entry.publicKey, 'route-entry-dial', context), false)
  t.is(registry.size, 0)
})

test('adjacent route epochs rotate independently and retain unrelated public provenance', (t) => {
  let current = 100_000n
  const safety = safetyRoleIdentity(100)
  const entry = privateRoleIdentity(120)
  const evidenceAuthority = routes.createDiscoveryEvidenceAuthority({ now: () => 100_000n })
  const circuitAuthority = routes.createCircuitAuthority()
  const registry = registryFor(evidenceAuthority.checker, circuitAuthority.checker, () => current)
  const context7 = circuitAuthority.issuer.issueFinalSafety({
    circuitId: b4a.alloc(16, 9),
    epoch: 7n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: entry.publicKey,
    expiresAt: 150_000n
  })
  const context8 = circuitAuthority.issuer.issueFinalSafety({
    circuitId: b4a.alloc(16, 10),
    epoch: 8n,
    finalSafetyIdentity32: safety.publicKey,
    entryIdentity32: entry.publicKey,
    expiresAt: 250_000n
  })

  registry.learnPublic(
    issueEvidence(evidenceAuthority, entry, {
      epoch: 9n,
      dial: b4a.from('public-independent.example:49737')
    })
  )
  registry.learnRoute(entry.publicKey, {
    provenance: 'route-entry',
    descriptor: verifiedRouteDescriptor(entry, {
      entry: { epoch: 7n, expiresAt: 150_000n, dial: b4a.from('epoch7.example:49737') },
      descriptor: { expiresAt: 150_000n }
    }),
    circuitContext: context7
  })
  registry.learnRoute(entry.publicKey, {
    provenance: 'route-entry',
    descriptor: verifiedRouteDescriptor(entry, {
      entry: {
        epoch: 8n,
        expiresAt: 250_000n,
        dial: b4a.from('epoch8.example:49737'),
        routeEncryptionKey: seed(191)
      },
      descriptor: { expiresAt: 250_000n }
    }),
    circuitContext: context8
  })

  t.is(registry.allows(entry.publicKey, 'route-entry-dial', context7), true)
  t.is(registry.allows(entry.publicKey, 'route-entry-dial', context8), true)
  current = 150_000n
  t.is(registry.allows(entry.publicKey, 'route-entry-dial', context7), false)
  t.is(registry.allows(entry.publicKey, 'route-entry-dial', context8), true)
  t.is(registry.allows(entry.publicKey, 'route-forward', { epoch: 7n }), false)
  t.is(registry.allows(entry.publicKey, 'route-forward', { epoch: 8n }), true)
  t.is(registry.allows(entry.publicKey, 'public-return', { consumer: 'relay-discovery' }), true)
  current = 250_000n
  t.is(registry.allows(entry.publicKey, 'route-entry-dial', context8), false)
  t.is(registry.allows(entry.publicKey, 'public-return', { consumer: 'relay-discovery' }), true)
})
