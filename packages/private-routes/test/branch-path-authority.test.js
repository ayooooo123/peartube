import b4a from 'b4a'
import test from 'brittle'

import * as routes from '../index.js'
import * as construction from '../lib/branch-construction-authority.js'
import {
  createRoutedCandidateAuthority,
  encodeRelayDiscoverResponse,
  publishAuthenticatedDiscoveryEvidence
} from '../lib/routed-candidate.js'
import {
  completeBranchPathReservation,
  createBranchPathAuthority,
  failBranchPathAuthorization,
  failBranchPathReservation,
  takeBranchPathAuthorization
} from '../lib/branch-path-authority.js'
import { expectCode, privateRoleIdentity, safetyRoleIdentity, seed } from './helpers.js'

const NOW = 1_000n
const DEADLINE = 8_000n

function endpoint(last) {
  return routes.encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, last]),
    port: 44_000 + last
  })
}

function advertisement(identity, last, role, endpointOverride = null) {
  const reachableEndpoint = endpointOverride || endpoint(last)
  const route = routes.cryptoSuite.encryptionKeyPair(seed(last + 1))
  const capabilities =
    role === routes.M3_LINK_ROLE.DHT_EXIT
      ? routes.RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | routes.RELAY_CAPABILITY.DHT_EXIT_V1
      : routes.RELAY_CAPABILITY.CIRCUIT_RELAY_V1
  return routes.encodeRelayCapabilityAdvertisement(
    routes.signRelayCapabilityAdvertisement(
      {
        relayIdentity: identity.publicKey,
        currentDhtNodeId: routes.deriveM3DhtNodeId(reachableEndpoint),
        reachableEndpoint,
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
        expiresAtMs: DEADLINE,
        providerServicePolicyEntries: routes.providerServicePolicyForCapabilities(capabilities)
      },
      identity.secretKey
    )
  )
}

function pairedBinding({ now, guard, guardEndpoint, lookup, announce }) {
  const branch = (value, byte) =>
    Object.freeze({
      branchClass: value.branchClass,
      branchId: value.branchId,
      circuitId: value.circuitId,
      generation: value.generation,
      clientCircuitIdentity: routes.cryptoSuite.keyPair(seed(byte)),
      clientTailEphemeral: routes.cryptoSuite.encryptionKeyPair(seed(byte + 1)),
      deadline: value.deadline,
      requestedLimits: Object.freeze({})
    })
  const authority = construction.createBranchConstructionAuthority({
    lookup: branch(lookup, 0xa1),
    announce: branch(announce, 0xb1),
    now
  })
  const guardAdvertisement = advertisement(
    guard,
    10,
    routes.M3_LINK_ROLE.SAFETY_RELAY,
    guardEndpoint
  )
  const lookupSession = construction.takeBranchConstructionRequest(authority.bootstrapRequest)
  construction.initializeBranchGuardLease(lookupSession, guardAdvertisement)
  const announceSession = construction.takeBranchConstructionRequest(authority.revalidationRequest)
  construction.validateBranchGuardLease(announceSession, guardAdvertisement)
  construction.completeBranchConstruction(lookupSession, Object.freeze({ destroy() {} }))
  construction.completeBranchConstruction(announceSession, Object.freeze({ destroy() {} }))
  return construction.consumeBranchConstructionPair(authority.takePair()).pathBinding
}

function fixture(now = () => NOW) {
  const guard = safetyRoleIdentity(10)
  const guardEndpoint = endpoint(10)
  const guardAdvertisement = advertisement(
    guard,
    10,
    routes.M3_LINK_ROLE.SAFETY_RELAY,
    guardEndpoint
  )
  const guardDigest = routes.digestRelayCapabilityAdvertisement(guardAdvertisement, { now: NOW })
  const lookup = {
    branchClass: routes.BRANCH_CLASS.LOOKUP,
    branchId: b4a.alloc(16, 0x11),
    circuitId: b4a.alloc(16, 0x12),
    generation: 11n,
    currentTailAdvertisementDigest: guardDigest,
    deadline: DEADLINE
  }
  const announce = {
    branchClass: routes.BRANCH_CLASS.ANNOUNCE,
    branchId: b4a.alloc(16, 0x21),
    circuitId: b4a.alloc(16, 0x22),
    generation: 21n,
    currentTailAdvertisementDigest: guardDigest,
    deadline: DEADLINE
  }
  const routed = createRoutedCandidateAuthority({ now })
  const pairBinding = pairedBinding({ now, guard, guardEndpoint, lookup, announce })
  const authority = createBranchPathAuthority({
    now,
    candidateDirectory: routed.directory,
    pairBinding
  })

  return {
    authority,
    pairBinding,
    directory: routed.directory,
    guard,
    guardEndpoint,
    lookup,
    announce,
    candidate(branch, index, encoded, tailIdentity, tailDigest, nonceByte) {
      const decoded = routes.decodeRelayCapabilityAdvertisement(encoded, { now: NOW })
      const queryNonce = seed(nonceByte)
      const randomTarget = decoded.currentDhtNodeId
      const response = encodeRelayDiscoverResponse({
        queryNonce,
        responseTimeMs: NOW,
        advertisements: [encoded]
      })
      const evidence = publishAuthenticatedDiscoveryEvidence(routed.evidenceProducer, {
        encodedResponse: response,
        queryNonce,
        randomTarget,
        requestedCapabilityMask:
          index === 1
            ? routes.RELAY_CAPABILITY.CIRCUIT_RELAY_V1
            : routes.RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | routes.RELAY_CAPABILITY.DHT_EXIT_V1,
        maximumResults: 1,
        currentTailIdentity: tailIdentity,
        currentTailAdvertisementDigest: tailDigest,
        branchClass: branch.branchClass,
        branchId: branch.branchId,
        circuitId: branch.circuitId,
        generation: branch.generation,
        extensionIndex: index,
        requiredRole: index === 1 ? routes.M3_LINK_ROLE.SAFETY_RELAY : routes.M3_LINK_ROLE.DHT_EXIT,
        requestDeadline: DEADLINE,
        tailExpiresAt: DEADLINE
      })
      return routed.directory.admit(evidence)[0]
    },
    destroy() {
      authority.destroy()
      routed.directory.destroy()
    }
  }
}

test('branch path authority advances paired branches with opaque one-use authorizations', (t) => {
  const f = fixture()
  const lookupMiddleIdentity = safetyRoleIdentity(30)
  const lookupMiddle = advertisement(lookupMiddleIdentity, 30, routes.M3_LINK_ROLE.SAFETY_RELAY)
  const candidate = f.candidate(
    f.lookup,
    1,
    lookupMiddle,
    f.guard.publicKey,
    f.lookup.currentTailAdvertisementDigest,
    0x31
  )
  const authorization = f.authority.reserve(candidate)

  t.ok(Object.isFrozen(authorization))
  t.alike(Object.keys(authorization), [])
  t.exception(() => f.directory.read(candidate), 'reservation consumes the routed candidate')
  const transfer = takeBranchPathAuthorization(authorization)
  t.alike(transfer.advertisement, lookupMiddle)
  t.is(transfer.branchClass, routes.BRANCH_CLASS.LOOKUP)
  t.is(transfer.extensionIndex, 1)
  t.alike(transfer.currentTailIdentity, f.guard.publicKey)
  t.ok(Object.isFrozen(transfer.reservation))
  t.alike(Object.keys(transfer.reservation), [])
  expectCode(t, () => takeBranchPathAuthorization(authorization), 'ERR_REPLAY')
  t.is(completeBranchPathReservation(transfer.reservation), true)
  expectCode(t, () => completeBranchPathReservation(transfer.reservation), 'ERR_REPLAY')

  const lookupExitIdentity = privateRoleIdentity(40)
  const lookupExit = advertisement(lookupExitIdentity, 40, routes.M3_LINK_ROLE.DHT_EXIT)
  const exitCandidate = f.candidate(
    f.lookup,
    2,
    lookupExit,
    lookupMiddleIdentity.publicKey,
    routes.digestRelayCapabilityAdvertisement(lookupMiddle, { now: NOW }),
    0x32
  )
  const exitTransfer = takeBranchPathAuthorization(f.authority.reserve(exitCandidate))
  t.is(exitTransfer.extensionIndex, 2)
  t.alike(exitTransfer.currentTailIdentity, lookupMiddleIdentity.publicKey)
  t.is(completeBranchPathReservation(exitTransfer.reservation), true)
  t.alike(f.authority.diagnostics(), {
    state: 'ACTIVE',
    liveReservations: 0,
    retainedAuthorizations: 2,
    lookupIndex: 2,
    announceIndex: 0
  })
  f.destroy()
})

test('branch path authority rejects skips, concurrency, guard reuse, and cross-branch reuse', (t) => {
  const f = fixture()
  const skipped = f.candidate(
    f.announce,
    2,
    advertisement(privateRoleIdentity(48), 48, routes.M3_LINK_ROLE.DHT_EXIT),
    f.guard.publicKey,
    f.announce.currentTailAdvertisementDigest,
    0x40
  )
  expectCode(t, () => f.authority.reserve(skipped), 'ERR_AUTHENTICATION')

  const middleIdentity = safetyRoleIdentity(50)
  const middle = advertisement(middleIdentity, 50, routes.M3_LINK_ROLE.SAFETY_RELAY)
  const first = f.candidate(
    f.lookup,
    1,
    middle,
    f.guard.publicKey,
    f.lookup.currentTailAdvertisementDigest,
    0x41
  )
  const firstTransfer = takeBranchPathAuthorization(f.authority.reserve(first))

  const concurrentIdentity = safetyRoleIdentity(60)
  const concurrent = f.candidate(
    f.lookup,
    1,
    advertisement(concurrentIdentity, 60, routes.M3_LINK_ROLE.SAFETY_RELAY),
    f.guard.publicKey,
    f.lookup.currentTailAdvertisementDigest,
    0x42
  )
  expectCode(t, () => f.authority.reserve(concurrent), 'ERR_BUSY')

  const guardCandidate = f.candidate(
    f.announce,
    1,
    advertisement(f.guard, 10, routes.M3_LINK_ROLE.SAFETY_RELAY, f.guardEndpoint),
    f.guard.publicKey,
    f.announce.currentTailAdvertisementDigest,
    0x43
  )
  expectCode(t, () => f.authority.reserve(guardCandidate), 'ERR_AUTHENTICATION')
  t.is(failBranchPathReservation(firstTransfer.reservation), true)

  const accepted = f.candidate(
    f.lookup,
    1,
    middle,
    f.guard.publicKey,
    f.lookup.currentTailAdvertisementDigest,
    0x44
  )
  const committed = takeBranchPathAuthorization(f.authority.reserve(accepted))
  completeBranchPathReservation(committed.reservation)

  const reused = f.candidate(
    f.announce,
    1,
    middle,
    f.guard.publicKey,
    f.announce.currentTailAdvertisementDigest,
    0x45
  )
  expectCode(t, () => f.authority.reserve(reused), 'ERR_AUTHENTICATION')

  const wrongTail = f.candidate(
    f.announce,
    1,
    advertisement(safetyRoleIdentity(70), 70, routes.M3_LINK_ROLE.SAFETY_RELAY),
    seed(0xee),
    f.announce.currentTailAdvertisementDigest,
    0x46
  )
  expectCode(t, () => f.authority.reserve(wrongTail), 'ERR_AUTHENTICATION')
  f.destroy()

  const alias = fixture()
  const aliasMiddleIdentity = safetyRoleIdentity(75)
  const aliasMiddle = advertisement(aliasMiddleIdentity, 75, routes.M3_LINK_ROLE.SAFETY_RELAY)
  const aliasFirst = alias.candidate(
    alias.lookup,
    1,
    aliasMiddle,
    alias.guard.publicKey,
    alias.lookup.currentTailAdvertisementDigest,
    0x47
  )
  const aliasTransfer = takeBranchPathAuthorization(alias.authority.reserve(aliasFirst))
  completeBranchPathReservation(aliasTransfer.reservation)
  const aliasedEndpoint = alias.candidate(
    alias.announce,
    1,
    advertisement(safetyRoleIdentity(80), 80, routes.M3_LINK_ROLE.SAFETY_RELAY, endpoint(75)),
    alias.guard.publicKey,
    alias.announce.currentTailAdvertisementDigest,
    0x48
  )
  expectCode(t, () => alias.authority.reserve(aliasedEndpoint), 'ERR_AUTHENTICATION')
  alias.destroy()
})

test('branch path authority enforces brands, expiry, rollback tombstones, and destroy', (t) => {
  let current = NOW
  const f = fixture(() => current)
  expectCode(t, () => createBranchPathAuthority({}), 'INVALID_ROUTE')
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  expectCode(t, () => createBranchPathAuthority(revoked.proxy), 'INVALID_ROUTE')
  expectCode(
    t,
    () =>
      createBranchPathAuthority({
        now: () => NOW,
        candidateDirectory: f.directory,
        pairBinding: f.pairBinding
      }),
    'ERR_REPLAY'
  )
  expectCode(
    t,
    () =>
      createBranchPathAuthority({
        now: () => NOW,
        candidateDirectory: Object.freeze({ read() {}, consume() {} }),
        pairBinding: Object.freeze({})
      }),
    'INVALID_ROUTE'
  )
  const allocate = b4a.allocUnsafeSlow
  let wrongSized = null
  const allocationBinding = pairedBinding({
    now: () => NOW,
    guard: f.guard,
    guardEndpoint: f.guardEndpoint,
    lookup: f.lookup,
    announce: f.announce
  })
  b4a.allocUnsafeSlow = (size) => {
    wrongSized = allocate(size - 1)
    return wrongSized
  }
  try {
    expectCode(
      t,
      () =>
        createBranchPathAuthority({
          now: () => NOW,
          candidateDirectory: f.directory,
          pairBinding: allocationBinding
        }),
      'INVALID_ROUTE'
    )
  } finally {
    b4a.allocUnsafeSlow = allocate
  }
  t.ok(wrongSized && b4a.equals(wrongSized, b4a.alloc(wrongSized.byteLength)))
  expectCode(t, () => takeBranchPathAuthorization(Object.freeze({})), 'ERR_REPLAY')
  expectCode(t, () => completeBranchPathReservation(Object.freeze({})), 'ERR_REPLAY')

  const identity = safetyRoleIdentity(80)
  const authorizationOnly = f.authority.reserve(
    f.candidate(
      f.announce,
      1,
      advertisement(identity, 80, routes.M3_LINK_ROLE.SAFETY_RELAY),
      f.guard.publicKey,
      f.announce.currentTailAdvertisementDigest,
      0x50
    )
  )
  t.is(failBranchPathAuthorization(authorizationOnly), true)
  expectCode(t, () => takeBranchPathAuthorization(authorizationOnly), 'ERR_REPLAY')
  const candidate = f.candidate(
    f.announce,
    1,
    advertisement(identity, 80, routes.M3_LINK_ROLE.SAFETY_RELAY),
    f.guard.publicKey,
    f.announce.currentTailAdvertisementDigest,
    0x51
  )
  const transfer = takeBranchPathAuthorization(f.authority.reserve(candidate))
  t.is(failBranchPathReservation(transfer.reservation), true)
  expectCode(t, () => failBranchPathReservation(transfer.reservation), 'ERR_REPLAY')
  current = DEADLINE
  t.alike(f.authority.diagnostics(), {
    state: 'ACTIVE',
    liveReservations: 0,
    retainedAuthorizations: 0,
    lookupIndex: 0,
    announceIndex: 0
  })
  t.is(f.authority.destroy(), true)
  t.is(f.authority.destroy(), false)
  expectCode(t, () => f.authority.reserve(Object.freeze({})), 'ERR_DESTROYED')
  f.directory.destroy()
})

test('branch path copies and commit remain atomic across late allocation failures', (t) => {
  const f = fixture()
  const middleIdentity = safetyRoleIdentity(85)
  const candidate = f.candidate(
    f.lookup,
    1,
    advertisement(middleIdentity, 85, routes.M3_LINK_ROLE.SAFETY_RELAY),
    f.guard.publicKey,
    f.lookup.currentTailAdvertisementDigest,
    0x59
  )
  const authorization = f.authority.reserve(candidate)
  const allocate = b4a.allocUnsafeSlow
  const takeAllocations = []
  b4a.allocUnsafeSlow = (size) => {
    const count = takeAllocations.length + 1
    const value = allocate(count === 6 ? size - 1 : size)
    takeAllocations.push(value)
    return value
  }
  try {
    expectCode(t, () => takeBranchPathAuthorization(authorization), 'INVALID_ROUTE')
  } finally {
    b4a.allocUnsafeSlow = allocate
  }
  t.ok(takeAllocations.length === 6)
  t.ok(takeAllocations.every((value) => b4a.equals(value, b4a.alloc(value.byteLength))))

  const transfer = takeBranchPathAuthorization(authorization)
  const commitAllocations = []
  b4a.allocUnsafeSlow = (size) => {
    const count = commitAllocations.length + 1
    const value = allocate(count === 4 ? size - 1 : size)
    commitAllocations.push(value)
    return value
  }
  try {
    expectCode(t, () => completeBranchPathReservation(transfer.reservation), 'INVALID_ROUTE')
  } finally {
    b4a.allocUnsafeSlow = allocate
  }
  t.ok(commitAllocations.length === 4)
  t.ok(commitAllocations.every((value) => b4a.equals(value, b4a.alloc(value.byteLength))))
  t.is(completeBranchPathReservation(transfer.reservation), true)
  t.is(f.authority.diagnostics().lookupIndex, 1)
  f.destroy()
})

test('branch path inserts a global pending reservation before its first clock callback', (t) => {
  let authority = null
  let reentrantCandidate = null
  let attemptReentry = false
  let reentryCode = null
  const f = fixture(() => {
    if (attemptReentry) {
      attemptReentry = false
      try {
        authority.reserve(reentrantCandidate)
      } catch (err) {
        reentryCode = err.code
      }
    }
    return NOW
  })
  authority = f.authority
  const lookupCandidate = f.candidate(
    f.lookup,
    1,
    advertisement(safetyRoleIdentity(91), 91, routes.M3_LINK_ROLE.SAFETY_RELAY),
    f.guard.publicKey,
    f.lookup.currentTailAdvertisementDigest,
    0x62
  )
  const lookupTransfer = takeBranchPathAuthorization(authority.reserve(lookupCandidate))

  const announceCandidate = f.candidate(
    f.announce,
    1,
    advertisement(safetyRoleIdentity(92), 92, routes.M3_LINK_ROLE.SAFETY_RELAY),
    f.guard.publicKey,
    f.announce.currentTailAdvertisementDigest,
    0x63
  )
  reentrantCandidate = f.candidate(
    f.announce,
    1,
    advertisement(safetyRoleIdentity(93), 93, routes.M3_LINK_ROLE.SAFETY_RELAY),
    f.guard.publicKey,
    f.announce.currentTailAdvertisementDigest,
    0x64
  )
  attemptReentry = true
  const announceTransfer = takeBranchPathAuthorization(authority.reserve(announceCandidate))
  t.is(reentryCode, 'ERR_BUSY')
  t.is(authority.diagnostics().state, 'ACTIVE')
  failBranchPathReservation(lookupTransfer.reservation)
  failBranchPathReservation(announceTransfer.reservation)
  f.destroy()
})

test('branch path authority fails closed when its clock destroys a reserved operation', (t) => {
  let authority = null
  let calls = 0
  let destroyAt = -1
  const f = fixture(() => {
    calls++
    if (calls === destroyAt) authority.destroy()
    return NOW
  })
  authority = f.authority
  const candidate = f.candidate(
    f.lookup,
    1,
    advertisement(safetyRoleIdentity(90), 90, routes.M3_LINK_ROLE.SAFETY_RELAY),
    f.guard.publicKey,
    f.lookup.currentTailAdvertisementDigest,
    0x61
  )
  destroyAt = calls + 3
  expectCode(t, () => authority.reserve(candidate), 'ERR_DESTROYED')
  t.is(authority.diagnostics().state, 'DESTROYED')
  f.directory.destroy()
})
