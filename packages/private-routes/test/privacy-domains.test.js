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

test('private-only route material never promotes public or direct authorization', (t) => {
  const { registry, entry } = policyFixture()
  registry.learnRoute(entry.publicKey, {
    provenance: 'private-only',
    epoch: 7n,
    expiresAt: 200_000n
  })

  t.is(registry.allows(entry.publicKey, 'route-forward'), true)
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

function issueEvidence(authority, identity, overrides = {}) {
  const advertisement = signedAdvertisement(identity, overrides)
  const encoded = routes.encodeRelayAdvertisement(advertisement)
  const receipt = receiptFor(authority.receiptIssuer, encoded, advertisement)
  return authority.verifier.verify(encoded, receipt)
}

function registryFor(evidenceChecker, circuitChecker, now) {
  return new routes.PrivacyDomainRegistry({
    evidenceChecker,
    descriptorChecker: descriptorChecker(),
    circuitChecker,
    now
  })
}

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
