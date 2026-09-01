import b4a from 'b4a'
import test from 'brittle'

import * as routes from '../index.js'
import * as api from '../lib/routed-candidate.js'
import { privateRoleIdentity, safetyRoleIdentity, seed } from './helpers.js'

const NOW = 1_000n

function endpoint(last) {
  return routes.encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, last]),
    port: 44_000 + last
  })
}

function advertisement({
  byte,
  role = 'safety',
  capabilities = routes.RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
  expiresAtMs = 10_000n
}) {
  const identity = role === 'safety' ? safetyRoleIdentity(byte) : privateRoleIdentity(byte)
  const at = endpoint(byte)
  const route = routes.cryptoSuite.encryptionKeyPair(seed(byte + 1))
  return routes.encodeRelayCapabilityAdvertisement(
    routes.signRelayCapabilityAdvertisement(
      {
        relayIdentity: identity.publicKey,
        currentDhtNodeId: routes.deriveM3DhtNodeId(at),
        reachableEndpoint: at,
        routeEncryptionPublicKey: route.publicKey,
        capabilityMask: capabilities,
        minimumProtocolVersion: 1,
        maximumProtocolVersion: 1,
        cellSize: 1200,
        maxCellPayload: 1146,
        contextEnvelopeSize: 1101,
        routeFrameSize: 1100,
        maxRoutePayload: 1073,
        datagramReplayWindow: 64,
        maxConcurrentCircuits: 8,
        capacityClass: routes.CAPACITY_CLASS.SMALL,
        maxCellsPerCircuit: 100,
        maxBytesPerCircuit: 100_000,
        maxCommandsPerCircuit: 10,
        idleTimeoutMs: 30_000,
        maxQueuedBytes: 65_536,
        epoch: 1n,
        issuedAtMs: NOW,
        expiresAtMs,
        providerServicePolicyEntries: routes.providerServicePolicyForCapabilities(capabilities)
      },
      identity.secretKey
    )
  )
}

function uniqueAdvertisements(count, start = 30, options = {}) {
  const advertisements = []
  const identities = new Set()
  for (let byte = start; advertisements.length < count; byte++) {
    const encoded = advertisement({ byte, ...options })
    const decoded = routes.decodeRelayCapabilityAdvertisement(encoded, { now: NOW })
    const identity = b4a.toString(decoded.relayIdentity, 'hex')
    if (identities.has(identity)) continue
    identities.add(identity)
    advertisements.push(encoded)
  }
  return advertisements.sort((left, right) => compare(left, right, seed(0x7b)))
}

function compare(left, right, target) {
  const a = routes.decodeRelayCapabilityAdvertisement(left, { now: NOW })
  const b = routes.decodeRelayCapabilityAdvertisement(right, { now: NOW })
  for (let index = 0; index < 32; index++) {
    const leftDistance = a.currentDhtNodeId[index] ^ target[index]
    const rightDistance = b.currentDhtNodeId[index] ^ target[index]
    if (leftDistance !== rightDistance) return leftDistance - rightDistance
  }
  return b4a.compare(a.relayIdentity, b.relayIdentity) || (a.epoch < b.epoch ? -1 : 1)
}

function evidenceMaterial({
  advertisements = [advertisement({ byte: 31 })],
  branchClass = routes.BRANCH_CLASS.LOOKUP,
  extensionIndex = 1,
  nonceByte = 0x41,
  requiredRole = routes.M3_LINK_ROLE.SAFETY_RELAY,
  requestedCapabilityMask = routes.RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
  deadline = 5_000n,
  branchByte = branchClass + 1
} = {}) {
  const randomTarget = seed(nonceByte + 1)
  const sorted = [...advertisements].sort((left, right) => compare(left, right, randomTarget))
  const queryNonce = seed(nonceByte)
  const encodedResponse = api.encodeRelayDiscoverResponse({
    queryNonce,
    responseTimeMs: NOW,
    advertisements: sorted
  })
  return {
    encodedResponse,
    queryNonce,
    randomTarget,
    requestedCapabilityMask,
    maximumResults: 8,
    currentTailIdentity: seed(0x51),
    currentTailAdvertisementDigest: seed(0x52),
    branchClass,
    branchId: b4a.alloc(16, branchByte),
    circuitId: b4a.alloc(16, branchByte + 2),
    generation: BigInt(branchClass + 7),
    extensionIndex,
    requiredRole,
    requestDeadline: deadline,
    tailExpiresAt: 9_000n
  }
}

function candidateFixture(now = () => NOW) {
  const authority = api.createRoutedCandidateAuthority({ now })
  return {
    directory: authority.directory,
    evidence(options) {
      return api.publishAuthenticatedDiscoveryEvidence(
        authority.evidenceProducer,
        evidenceMaterial(options)
      )
    }
  }
}

function tailRequest(nonceByte, branchByte = 0x82) {
  return {
    queryNonce: seed(nonceByte),
    randomTarget: seed(0x7b),
    requestedCapabilityMask: routes.RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    maximumResults: 8,
    branchClass: routes.BRANCH_CLASS.ANNOUNCE,
    branchId: b4a.alloc(16, branchByte),
    circuitId: b4a.alloc(16, branchByte + 1),
    generation: BigInt(branchByte),
    extensionIndex: 1,
    requiredRole: routes.M3_LINK_ROLE.SAFETY_RELAY,
    currentTailIdentity: seed(0x84),
    currentTailAdvertisementDigest: seed(0x85),
    requestDeadline: 5_000n
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

test('tail-authenticated discovery evidence mints one-use routed candidates', (t) => {
  const { directory, evidence } = candidateFixture()
  const candidates = directory.admit(evidence())

  t.is(candidates.length, 1)
  t.ok(Object.isFrozen(candidates[0]))
  t.alike(Object.keys(candidates[0]), [])
  const projection = directory.read(candidates[0])
  t.is(projection.extensionIndex, 1)
  t.is(projection.requiredRole, routes.M3_LINK_ROLE.SAFETY_RELAY)
  t.is(projection.branchClass, routes.BRANCH_CLASS.LOOKUP)
  t.is(projection.deadline, 5_000n)
  t.is(projection.advertisement.byteLength >= 260, true)
  t.alike(directory.consume(candidates[0]).advertisement, projection.advertisement)
  t.exception(() => directory.read(candidates[0]), 'consumption leaves a replay tombstone')
  t.exception(() => directory.admit(Object.freeze({})), 'direct or forged brands are incompatible')
  directory.destroy()
})

test('relay discovery response enforces exact zero/eight-result wire bounds and canonical order', (t) => {
  const empty = api.encodeRelayDiscoverResponse({
    queryNonce: seed(0x61),
    responseTimeMs: NOW,
    advertisements: []
  })
  t.is(empty.byteLength, 49)
  t.is(api.decodeRelayDiscoverResponse(empty).advertisements.length, 0)

  const capabilities =
    routes.RELAY_CAPABILITY.CIRCUIT_RELAY_V1 |
    routes.RELAY_CAPABILITY.DHT_EXIT_V1 |
    routes.RELAY_CAPABILITY.PRIVATE_RECORDS_V1
  const maximum = Array.from({ length: 8 }, (_, index) =>
    advertisement({ byte: 80 + index, role: 'private', capabilities })
  )
  const target = seed(0x62)
  maximum.sort((left, right) => compare(left, right, target))
  const encoded = api.encodeRelayDiscoverResponse({
    queryNonce: seed(0x63),
    responseTimeMs: NOW,
    advertisements: maximum
  })
  t.is(
    maximum.every((value) => value.byteLength === 548),
    true
  )
  t.is(encoded.byteLength, 4_449)
  t.is(api.decodeRelayDiscoverResponse(encoded).advertisements.length, 8)
  t.exception(() =>
    api.encodeRelayDiscoverResponse({
      queryNonce: seed(0x64),
      responseTimeMs: NOW,
      advertisements: [...maximum, maximum[0]]
    })
  )

  const reversed = api.encodeRelayDiscoverResponse({
    queryNonce: seed(0x65),
    responseTimeMs: NOW,
    advertisements: [...maximum].reverse()
  })
  const authority = api.createRoutedCandidateAuthority({ now: () => NOW })
  const directory = authority.directory
  const forged = api.publishAuthenticatedDiscoveryEvidence(authority.evidenceProducer, {
    ...evidenceMaterial(),
    encodedResponse: reversed,
    queryNonce: seed(0x65),
    randomTarget: target
  })
  t.exception(() => directory.admit(forged), 'authenticated but noncanonical order fails closed')
  directory.destroy()
})

test('candidate state caps, request attempts, expiry, and synchronous tombstones are exact', (t) => {
  let now = NOW
  const { directory, evidence } = candidateFixture(() => now)
  const ads = uniqueAdvertisements(8, 100)
  const first = directory.admit(evidence({ advertisements: ads, nonceByte: 0x71 }))
  const second = directory.admit(evidence({ advertisements: ads, nonceByte: 0x72 }))
  t.is(directory.diagnostics().live, 16)
  t.exception(
    () => directory.admit(evidence({ advertisements: ads, nonceByte: 0x73 })),
    'sixteen live candidates is a hard cap'
  )
  for (const candidate of first) directory.consume(candidate)
  const third = directory.admit(
    evidence({
      advertisements: ads,
      branchClass: routes.BRANCH_CLASS.ANNOUNCE,
      nonceByte: 0x73
    })
  )
  t.is(third.length, 8)
  t.is(directory.diagnostics().states, 24)
  t.exception(
    () => directory.admit(evidence({ advertisements: ads, nonceByte: 0x74 })),
    'one branch/index permits only three requests'
  )

  for (const candidate of [...second, ...third]) directory.consume(candidate)
  now = 5_000n
  t.alike(directory.diagnostics(), { state: 'ACTIVE', live: 0, states: 0, requests: 0 })
  t.exception(() => directory.admit(evidence({ deadline: 5_000n })), 'deadline is exclusive')
  directory.destroy()
})

test('candidate expiry preserves tombstones and the global state cap is ninety-six', (t) => {
  let now = NOW
  const expiringFixture = candidateFixture(() => now)
  const expiring = expiringFixture.directory
  const short = advertisement({ byte: 130, expiresAtMs: 2_000n })
  expiring.admit(expiringFixture.evidence({ advertisements: [short] }))
  now = 2_000n
  t.alike(expiring.diagnostics(), { state: 'ACTIVE', live: 0, states: 1, requests: 1 })
  now = 5_000n
  t.alike(expiring.diagnostics(), { state: 'ACTIVE', live: 0, states: 0, requests: 0 })
  expiring.destroy()

  now = NOW
  const fixture = candidateFixture(() => now)
  const directory = fixture.directory
  const safety = uniqueAdvertisements(8, 140)
  const exitCapabilities =
    routes.RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | routes.RELAY_CAPABILITY.DHT_EXIT_V1
  const exits = uniqueAdvertisements(8, 180, {
    role: 'private',
    capabilities: exitCapabilities
  })
  for (let request = 0; request < 12; request++) {
    const index = request % 2 === 0 ? 1 : 2
    const candidates = directory.admit(
      fixture.evidence({
        advertisements: index === 1 ? safety : exits,
        branchClass: request % 4 < 2 ? routes.BRANCH_CLASS.LOOKUP : routes.BRANCH_CLASS.ANNOUNCE,
        branchByte: 20 + request,
        extensionIndex: index,
        nonceByte: 0x90 + request,
        requiredRole: index === 1 ? routes.M3_LINK_ROLE.SAFETY_RELAY : routes.M3_LINK_ROLE.DHT_EXIT,
        requestedCapabilityMask:
          index === 1 ? routes.RELAY_CAPABILITY.CIRCUIT_RELAY_V1 : exitCapabilities
      })
    )
    for (const candidate of candidates) directory.consume(candidate)
  }
  t.alike(directory.diagnostics(), { state: 'ACTIVE', live: 0, states: 96, requests: 12 })
  t.exception(
    () =>
      directory.admit(
        fixture.evidence({ advertisements: safety, branchByte: 50, nonceByte: 0xb0 })
      ),
    'ninety-six live-plus-tombstoned states is a hard cap'
  )
  directory.destroy()
})

test('current-tail digest admissions authorize only advertisements actually returned', (t) => {
  const authority = api.createCurrentTailCandidateAdmissionAuthority({ now: () => NOW })
  const included = advertisement({ byte: 41 })
  const omitted = advertisement({ byte: 42 })
  const request = {
    queryNonce: seed(0x81),
    randomTarget: seed(0x7b),
    requestedCapabilityMask: routes.RELAY_CAPABILITY.CIRCUIT_RELAY_V1,
    maximumResults: 8,
    branchClass: routes.BRANCH_CLASS.ANNOUNCE,
    branchId: b4a.alloc(16, 0x82),
    circuitId: b4a.alloc(16, 0x83),
    generation: 9n,
    extensionIndex: 1,
    requiredRole: routes.M3_LINK_ROLE.SAFETY_RELAY,
    currentTailIdentity: seed(0x84),
    currentTailAdvertisementDigest: seed(0x85),
    requestDeadline: 5_000n
  }
  const reservation = api.reserveCurrentTailCandidateResponse(authority.producer, {
    ...request,
    advertisements: [included]
  })
  const includedDigest = routes.digestRelayCapabilityAdvertisement(included, { now: NOW })
  const omittedDigest = routes.digestRelayCapabilityAdvertisement(omitted, { now: NOW })

  expectCode(
    t,
    () =>
      api.consumeCurrentTailCandidateAdmission(authority.consumer, {
        ...request,
        candidateAdvertisementDigest: includedDigest
      }),
    'ERR_AUTHENTICATION',
    'an uncommitted response cannot authorize a dial'
  )
  api.commitCurrentTailCandidateResponse(authority.producer, reservation)
  t.ok(
    api.consumeCurrentTailCandidateAdmission(authority.consumer, {
      ...request,
      candidateAdvertisementDigest: includedDigest
    })
  )
  t.exception(
    () =>
      api.consumeCurrentTailCandidateAdmission(authority.consumer, {
        ...request,
        candidateAdvertisementDigest: includedDigest
      }),
    'local admission is one-use'
  )
  t.exception(
    () =>
      api.consumeCurrentTailCandidateAdmission(authority.consumer, {
        ...request,
        candidateAdvertisementDigest: omittedDigest
      }),
    'a valid but omitted advertisement cannot authorize a dial'
  )
  authority.destroy()
})

test('evidence and tail-admission brands are owner-bound split capabilities', (t) => {
  const first = api.createRoutedCandidateAuthority({ now: () => NOW })
  const second = api.createRoutedCandidateAuthority({ now: () => NOW })
  const evidence = api.publishAuthenticatedDiscoveryEvidence(
    first.evidenceProducer,
    evidenceMaterial()
  )
  t.exception(() => second.directory.admit(evidence), 'another directory cannot consume evidence')
  t.is(first.directory.admit(evidence).length, 1, 'the owning directory retains authority')
  t.absent('TEST_ONLY_AUTHENTICATED_DISCOVERY_ISSUER' in api)
  first.directory.destroy()
  second.directory.destroy()

  const tail = api.createCurrentTailCandidateAdmissionAuthority({ now: () => NOW })
  const otherTail = api.createCurrentTailCandidateAdmissionAuthority({ now: () => NOW })
  t.alike(Object.keys(tail.producer), [])
  t.alike(Object.keys(tail.consumer), [])
  t.exception(
    () => api.reserveCurrentTailCandidateResponse(tail.consumer, {}),
    'consumer cannot mint admissions'
  )
  t.exception(
    () => api.consumeCurrentTailCandidateAdmission(tail.producer, {}),
    'producer cannot consume admissions'
  )
  const request = tailRequest(0x99)
  const reservation = api.reserveCurrentTailCandidateResponse(tail.producer, {
    ...request,
    advertisements: [advertisement({ byte: 47 })]
  })
  const admissions = api.commitCurrentTailCandidateResponse(tail.producer, reservation)
  expectCode(
    t,
    () => api.consumeCurrentTailCandidateAdmissionHandle(otherTail.consumer, admissions[0]),
    'ERR_AUTHENTICATION',
    'another consumer cannot use the committed opaque handle'
  )
  t.ok(api.consumeCurrentTailCandidateAdmissionHandle(tail.consumer, admissions[0]))
  tail.destroy()
  otherTail.destroy()
})

test('committed tail-admission handles expire at the original local deadline', (t) => {
  let current = NOW
  const authority = api.createCurrentTailCandidateAdmissionAuthority({ now: () => current })
  const request = tailRequest(0x98)
  const reservation = api.reserveCurrentTailCandidateResponse(authority.producer, {
    ...request,
    advertisements: [advertisement({ byte: 46 })]
  })
  const admissions = api.commitCurrentTailCandidateResponse(authority.producer, reservation)
  current = request.requestDeadline
  expectCode(
    t,
    () => api.consumeCurrentTailCandidateAdmissionHandle(authority.consumer, admissions[0]),
    'ERR_AUTHENTICATION'
  )
  t.alike(authority.diagnostics(), { state: 'ACTIVE', live: 0, states: 0, requests: 0 })
  authority.destroy()
})

test('unexposed evidence and response reservations can be revoked exactly once', (t) => {
  const routed = api.createRoutedCandidateAuthority({ now: () => NOW })
  const evidence = api.publishAuthenticatedDiscoveryEvidence(
    routed.evidenceProducer,
    evidenceMaterial()
  )

  t.ok(api.revokeAuthenticatedDiscoveryEvidence(routed.evidenceProducer, evidence))
  t.is(api.revokeAuthenticatedDiscoveryEvidence(routed.evidenceProducer, evidence), false)
  expectCode(
    t,
    () => routed.directory.admit(evidence),
    'ERR_AUTHENTICATION',
    'revoked evidence cannot mint candidates'
  )
  t.alike(routed.directory.diagnostics(), {
    state: 'ACTIVE',
    live: 0,
    states: 0,
    requests: 0
  })
  routed.directory.destroy()

  const tail = api.createCurrentTailCandidateAdmissionAuthority({ now: () => NOW })
  const request = tailRequest(0x9a)
  const included = advertisement({ byte: 48 })
  const reservation = api.reserveCurrentTailCandidateResponse(tail.producer, {
    ...request,
    advertisements: [included]
  })
  const digest = routes.digestRelayCapabilityAdvertisement(included, { now: NOW })

  t.ok(api.rollbackCurrentTailCandidateResponse(tail.producer, reservation))
  t.is(api.rollbackCurrentTailCandidateResponse(tail.producer, reservation), false)
  expectCode(
    t,
    () =>
      api.consumeCurrentTailCandidateAdmission(tail.consumer, {
        ...request,
        candidateAdvertisementDigest: digest
      }),
    'ERR_AUTHENTICATION',
    'rolled-back advertisements cannot authorize a dial'
  )
  t.alike(tail.diagnostics(), { state: 'ACTIVE', live: 0, states: 0, requests: 1 })
  tail.destroy()
})

test('tail response reservations terminalize on commit, consumption, and destroy', (t) => {
  const committed = api.createCurrentTailCandidateAdmissionAuthority({ now: () => NOW })
  const committedRequest = tailRequest(0x9b)
  const committedAdvertisement = advertisement({ byte: 49 })
  const committedReservation = api.reserveCurrentTailCandidateResponse(committed.producer, {
    ...committedRequest,
    advertisements: [committedAdvertisement]
  })
  const committedAdmissions = api.commitCurrentTailCandidateResponse(
    committed.producer,
    committedReservation
  )
  t.is(committedAdmissions.length, 1, 'commit publishes one opaque admission per advertisement')
  t.ok(Object.isFrozen(committedAdmissions[0]))
  t.alike(Object.keys(committedAdmissions[0]), [])
  t.is(api.commitCurrentTailCandidateResponse(committed.producer, committedReservation), false)
  t.is(api.rollbackCurrentTailCandidateResponse(committed.producer, committedReservation), false)
  t.ok(
    api.consumeCurrentTailCandidateAdmissionHandle(committed.consumer, committedAdmissions[0]),
    'commit preserves the published admission'
  )
  t.is(
    api.revokeCurrentTailCandidateAdmissionHandle(committed.consumer, committedAdmissions[0]),
    false,
    'consumed handles retain their replay tombstone'
  )
  expectCode(
    t,
    () =>
      api.consumeCurrentTailCandidateAdmissionHandle(committed.consumer, committedAdmissions[0]),
    'ERR_REPLAY',
    'published admission handles are one-use tombstones'
  )
  committed.destroy()

  const consumed = api.createCurrentTailCandidateAdmissionAuthority({ now: () => NOW })
  const consumedRequest = tailRequest(0x9c)
  const consumedAdvertisements = uniqueAdvertisements(2, 50)
  const consumedReservation = api.reserveCurrentTailCandidateResponse(consumed.producer, {
    ...consumedRequest,
    advertisements: consumedAdvertisements
  })
  api.commitCurrentTailCandidateResponse(consumed.producer, consumedReservation)
  t.ok(
    api.consumeCurrentTailCandidateAdmission(consumed.consumer, {
      ...consumedRequest,
      candidateAdvertisementDigest: routes.digestRelayCapabilityAdvertisement(
        consumedAdvertisements[0],
        { now: NOW }
      )
    })
  )
  t.is(
    api.rollbackCurrentTailCandidateResponse(consumed.producer, consumedReservation),
    false,
    'commit terminalizes the reservation handle'
  )
  consumed.destroy()

  const destroyed = api.createCurrentTailCandidateAdmissionAuthority({ now: () => NOW })
  const destroyedRequest = tailRequest(0x9d)
  const destroyedReservation = api.reserveCurrentTailCandidateResponse(destroyed.producer, {
    ...destroyedRequest,
    advertisements: [advertisement({ byte: 52 })]
  })
  destroyed.destroy()
  t.is(
    api.rollbackCurrentTailCandidateResponse(destroyed.producer, destroyedReservation),
    false,
    'authority destroy synchronously invalidates retained reservations'
  )
})

test('tail response admission validates and digests one owned advertisement snapshot', (t) => {
  const authority = api.createCurrentTailCandidateAdmissionAuthority({ now: () => NOW })
  const request = tailRequest(0x9e)
  const validated = advertisement({ byte: 53 })
  const substituted = advertisement({ byte: 54 })
  let indexReads = 0
  const advertisements = new Proxy([validated], {
    get(target, name, receiver) {
      if (name === '0') {
        indexReads++
        return indexReads === 1 ? validated : substituted
      }
      return Reflect.get(target, name, receiver)
    }
  })

  const reservation = api.reserveCurrentTailCandidateResponse(authority.producer, {
    ...request,
    advertisements
  })
  api.commitCurrentTailCandidateResponse(authority.producer, reservation)
  t.is(indexReads, 1, 'the authority snapshots each caller-controlled index exactly once')
  t.ok(
    api.consumeCurrentTailCandidateAdmission(authority.consumer, {
      ...request,
      candidateAdvertisementDigest: routes.digestRelayCapabilityAdvertisement(validated, {
        now: NOW
      })
    }),
    'the validated snapshot receives the admission'
  )
  expectCode(
    t,
    () =>
      api.consumeCurrentTailCandidateAdmission(authority.consumer, {
        ...request,
        candidateAdvertisementDigest: routes.digestRelayCapabilityAdvertisement(substituted, {
          now: NOW
        })
      }),
    'ERR_AUTHENTICATION',
    'a second-read substitution receives no admission'
  )
  authority.destroy()
})

test('evidence producer independently enforces replay and three, sixteen, ninety-six caps', (t) => {
  const attempts = api.createRoutedCandidateAuthority({ now: () => NOW })
  const evidence = []
  for (let index = 0; index < 3; index++) {
    evidence.push(
      api.publishAuthenticatedDiscoveryEvidence(
        attempts.evidenceProducer,
        evidenceMaterial({ nonceByte: 0xa0 + index })
      )
    )
  }
  t.exception(
    () =>
      api.publishAuthenticatedDiscoveryEvidence(
        attempts.evidenceProducer,
        evidenceMaterial({ nonceByte: 0xa3 })
      ),
    'a fourth evidence publication for one branch/index is rejected'
  )
  attempts.directory.admit(evidence[0])
  expectCode(
    t,
    () => attempts.directory.admit(evidence[0]),
    'ERR_REPLAY',
    'consumed evidence retains a replay tombstone'
  )
  attempts.directory.destroy()

  const live = api.createRoutedCandidateAuthority({ now: () => NOW })
  for (let index = 0; index < 16; index++) {
    api.publishAuthenticatedDiscoveryEvidence(
      live.evidenceProducer,
      evidenceMaterial({ advertisements: [], branchByte: 20 + index, nonceByte: 0xb0 + index })
    )
  }
  t.exception(
    () =>
      api.publishAuthenticatedDiscoveryEvidence(
        live.evidenceProducer,
        evidenceMaterial({ advertisements: [], branchByte: 50, nonceByte: 0xc0 })
      ),
    'sixteen outstanding evidence capabilities is a hard cap'
  )
  live.directory.destroy()

  const states = api.createRoutedCandidateAuthority({ now: () => NOW })
  for (let index = 0; index < 96; index++) {
    const capability = api.publishAuthenticatedDiscoveryEvidence(
      states.evidenceProducer,
      evidenceMaterial({ advertisements: [], branchByte: 100 + index, nonceByte: index })
    )
    states.directory.admit(capability)
  }
  t.exception(
    () =>
      api.publishAuthenticatedDiscoveryEvidence(
        states.evidenceProducer,
        evidenceMaterial({ advertisements: [], branchByte: 220, nonceByte: 0xd0 })
      ),
    'ninety-six live-plus-tombstoned evidence states is a hard cap'
  )
  states.directory.destroy()

  let now = NOW
  const expiry = api.createRoutedCandidateAuthority({ now: () => now })
  const expired = api.publishAuthenticatedDiscoveryEvidence(
    expiry.evidenceProducer,
    evidenceMaterial({ advertisements: [], nonceByte: 0xd1 })
  )
  expiry.directory.admit(expired)
  now = 5_000n
  expiry.directory.diagnostics()
  expectCode(
    t,
    () => expiry.directory.admit(expired),
    'ERR_AUTHENTICATION',
    'evidence replay tombstone is released at the original deadline'
  )
  expiry.directory.destroy()
})

test('hostile clock destruction cannot resurrect either authority', (t) => {
  let directory = null
  let destroyCandidate = false
  const candidateAuthority = api.createRoutedCandidateAuthority({
    now() {
      if (destroyCandidate) {
        destroyCandidate = false
        directory.destroy()
      }
      return NOW
    }
  })
  directory = candidateAuthority.directory
  const evidence = api.publishAuthenticatedDiscoveryEvidence(
    candidateAuthority.evidenceProducer,
    evidenceMaterial()
  )
  destroyCandidate = true
  expectCode(t, () => directory.admit(evidence), 'ERR_DESTROYED')
  t.alike(directory.diagnostics(), { state: 'DESTROYED', live: 0, states: 0, requests: 0 })

  let tail = null
  let destroyTail = true
  tail = api.createCurrentTailCandidateAdmissionAuthority({
    now() {
      if (destroyTail) {
        destroyTail = false
        tail.destroy()
      }
      return NOW
    }
  })
  expectCode(
    t,
    () =>
      api.reserveCurrentTailCandidateResponse(tail.producer, {
        ...tailRequest(0xc1),
        advertisements: [advertisement({ byte: 51 })]
      }),
    'ERR_DESTROYED'
  )
  t.alike(tail.diagnostics(), { state: 'DESTROYED', live: 0, states: 0, requests: 0 })
})

test('deadlines are immutable and current-tail limits mirror three, sixteen, and ninety-six', (t) => {
  const authority = api.createCurrentTailCandidateAdmissionAuthority({ now: () => NOW })
  const advertisements = uniqueAdvertisements(8, 210)
  const first = tailRequest(0xd1)
  const second = tailRequest(0xd2)
  const firstReservation = api.reserveCurrentTailCandidateResponse(authority.producer, {
    ...first,
    advertisements
  })
  const secondReservation = api.reserveCurrentTailCandidateResponse(authority.producer, {
    ...second,
    advertisements
  })
  api.commitCurrentTailCandidateResponse(authority.producer, firstReservation)
  api.commitCurrentTailCandidateResponse(authority.producer, secondReservation)
  t.alike(authority.diagnostics(), { state: 'ACTIVE', live: 16, states: 16, requests: 1 })
  t.exception(
    () =>
      api.reserveCurrentTailCandidateResponse(authority.producer, {
        ...tailRequest(0xd3),
        advertisements
      }),
    'sixteen live admissions is a hard cap'
  )
  const firstDigest = routes.digestRelayCapabilityAdvertisement(advertisements[0], { now: NOW })
  expectCode(
    t,
    () =>
      api.consumeCurrentTailCandidateAdmission(authority.consumer, {
        ...first,
        requestDeadline: 6_000n,
        candidateAdvertisementDigest: firstDigest
      }),
    'ERR_AUTHENTICATION',
    'request deadline substitution is rejected'
  )
  for (const advertisement of advertisements) {
    api.consumeCurrentTailCandidateAdmission(authority.consumer, {
      ...first,
      candidateAdvertisementDigest: routes.digestRelayCapabilityAdvertisement(advertisement, {
        now: NOW
      })
    })
  }
  t.exception(
    () =>
      api.reserveCurrentTailCandidateResponse(authority.producer, {
        ...tailRequest(0xd4),
        advertisements
      }),
    'a fourth request cannot extend the original branch/index authority'
  )
  authority.destroy()

  const capped = api.createCurrentTailCandidateAdmissionAuthority({ now: () => NOW })
  let consumedTombstonesProtected = true
  for (let requestIndex = 0; requestIndex < 12; requestIndex++) {
    const request = tailRequest(0xe0 + requestIndex, 20 + requestIndex)
    const reservation = api.reserveCurrentTailCandidateResponse(capped.producer, {
      ...request,
      advertisements
    })
    const handles = api.commitCurrentTailCandidateResponse(capped.producer, reservation)
    for (const handle of handles) {
      api.consumeCurrentTailCandidateAdmissionHandle(capped.consumer, handle)
      if (api.revokeCurrentTailCandidateAdmissionHandle(capped.consumer, handle)) {
        consumedTombstonesProtected = false
      }
    }
  }
  t.ok(consumedTombstonesProtected, 'consumed handles cannot erase global-cap tombstones')
  t.alike(capped.diagnostics(), { state: 'ACTIVE', live: 0, states: 96, requests: 12 })
  t.exception(
    () =>
      api.reserveCurrentTailCandidateResponse(capped.producer, {
        ...tailRequest(0xf0, 60),
        advertisements
      }),
    'ninety-six current-tail admission states is a hard cap'
  )
  capped.destroy()
})

test('hostile getters and partial copies fail with zeroized staged ownership', (t) => {
  const authority = api.createRoutedCandidateAuthority({ now: () => NOW })
  const material = evidenceMaterial()
  material.currentTailAdvertisementDigest = b4a.alloc(31)
  const allocated = []
  const allocate = b4a.allocUnsafeSlow
  b4a.allocUnsafeSlow = (size) => {
    const value = allocate(size)
    allocated.push(value)
    return value
  }
  try {
    expectCode(
      t,
      () => api.publishAuthenticatedDiscoveryEvidence(authority.evidenceProducer, material),
      'INVALID_ROUTE'
    )
  } finally {
    b4a.allocUnsafeSlow = allocate
  }
  t.ok(allocated.length > 0)
  t.ok(allocated.every((value) => b4a.equals(value, b4a.alloc(value.byteLength))))

  const destroyedByGetter = api.createRoutedCandidateAuthority({ now: () => NOW })
  const hostileMaterial = evidenceMaterial({ nonceByte: 0xf0 })
  Object.defineProperty(hostileMaterial, 'currentTailIdentity', {
    get() {
      destroyedByGetter.directory.destroy()
      return seed(0xf0)
    }
  })
  expectCode(
    t,
    () =>
      api.publishAuthenticatedDiscoveryEvidence(
        destroyedByGetter.evidenceProducer,
        hostileMaterial
      ),
    'ERR_DESTROYED',
    'producer cannot publish after getter-triggered teardown'
  )
  t.alike(destroyedByGetter.directory.diagnostics(), {
    state: 'DESTROYED',
    live: 0,
    states: 0,
    requests: 0
  })

  const encoded = advertisement({ byte: 61 })
  Object.defineProperty(encoded, 'byteLength', {
    get() {
      throw new Error('hostile shadowed getter')
    }
  })
  t.is(
    api.encodeRelayDiscoverResponse({
      queryNonce: seed(0xf1),
      responseTimeMs: NOW,
      advertisements: [encoded]
    }).byteLength,
    49 + encoded.length + 2
  )
  let lengthReads = 0
  const shifting = new Proxy([encoded], {
    get(target, name, receiver) {
      if (name === 'length') {
        lengthReads++
        return lengthReads === 1 ? 1 : 0
      }
      return Reflect.get(target, name, receiver)
    }
  })
  t.is(
    api.decodeRelayDiscoverResponse(
      api.encodeRelayDiscoverResponse({
        queryNonce: seed(0xf4),
        responseTimeMs: NOW,
        advertisements: shifting
      })
    ).advertisements.length,
    1,
    'response count uses one stable array-length snapshot'
  )
  expectCode(
    t,
    () =>
      api.encodeRelayDiscoverResponse(
        new Proxy(
          {},
          {
            get() {
              throw new Error('hostile options getter')
            }
          }
        )
      ),
    'INVALID_ROUTE',
    'hostile encoder options map to a stable protocol error'
  )
  authority.directory.destroy()

  const tail = api.createCurrentTailCandidateAdmissionAuthority({ now: () => NOW })
  expectCode(
    t,
    () =>
      api.consumeCurrentTailCandidateAdmission(tail.consumer, {
        ...tailRequest(0xf2),
        generation: -1,
        candidateAdvertisementDigest: seed(0xf3)
      }),
    'INVALID_ROUTE',
    'invalid generation never escapes as a raw runtime error'
  )
  tail.destroy()
})
