import test from 'brittle'
import b4a from 'b4a'

import * as routes from '../index.js'
import * as api from '../lib/branch-construction-authority.js'
import { safetyRoleIdentity, seed } from './helpers.js'

const NOW = 1_000n

function endpoint(last = 31) {
  return routes.encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, last]),
    port: 43_000 + last
  })
}

function advertisement({
  identity = safetyRoleIdentity(20),
  at = endpoint(),
  epoch = 2n,
  routeSeed = 21 + Number(epoch)
} = {}) {
  const route = routes.cryptoSuite.encryptionKeyPair(seed(routeSeed))
  const capabilityMask = routes.RELAY_CAPABILITY.CIRCUIT_RELAY_V1
  return routes.encodeRelayCapabilityAdvertisement(
    routes.signRelayCapabilityAdvertisement(
      {
        relayIdentity: identity.publicKey,
        currentDhtNodeId: routes.deriveM3DhtNodeId(at),
        reachableEndpoint: at,
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
        maxConcurrentCircuits: 8,
        capacityClass: routes.CAPACITY_CLASS.SMALL,
        maxCellsPerCircuit: 100,
        maxBytesPerCircuit: 100_000,
        maxCommandsPerCircuit: 10,
        idleTimeoutMs: 30_000,
        maxQueuedBytes: 65_536,
        epoch,
        issuedAtMs: NOW,
        expiresAtMs: 10_000n,
        providerServicePolicyEntries: routes.providerServicePolicyForCapabilities(capabilityMask)
      },
      identity.secretKey
    )
  )
}

function branch(branchClass, byte) {
  return Object.freeze({
    branchClass,
    branchId: b4a.alloc(16, byte),
    circuitId: b4a.alloc(16, byte + 1),
    generation: BigInt(byte),
    clientCircuitIdentity: routes.cryptoSuite.keyPair(seed(byte)),
    clientTailEphemeral: routes.cryptoSuite.encryptionKeyPair(seed(byte + 1)),
    deadline: 5_000n,
    requestedLimits: Object.freeze({})
  })
}

function authority(overrides = {}) {
  return api.createBranchConstructionAuthority({
    lookup: branch(routes.BRANCH_CLASS.LOOKUP, 41),
    announce: branch(routes.BRANCH_CLASS.ANNOUNCE, 61),
    now: () => NOW,
    ...overrides
  })
}

function resource(onDestroy = null) {
  let destroys = 0
  return {
    value: Object.freeze({
      destroy() {
        destroys++
        if (onDestroy) onDestroy()
      }
    }),
    get destroys() {
      return destroys
    }
  }
}

test('paired authority gates the second branch on one immutable guard lease', (t) => {
  const pair = authority()
  t.alike(Object.keys(pair.bootstrapRequest), [])
  t.alike(Object.keys(pair.revalidationRequest), [])
  t.ok(Object.isFrozen(pair.bootstrapRequest))
  t.ok(Object.isFrozen(pair.revalidationRequest))
  t.not(pair.bootstrapRequest, pair.revalidationRequest)

  t.exception(
    () => api.takeBranchConstructionRequest(pair.revalidationRequest),
    'second branch is unusable before guard pinning'
  )
  const lookup = api.takeBranchConstructionRequest(pair.bootstrapRequest)
  t.exception(() => api.takeBranchConstructionRequest(pair.bootstrapRequest), 'request is one-use')
  const pinned = advertisement()
  api.initializeBranchGuardLease(lookup, pinned)
  t.exception(() => api.initializeBranchGuardLease(lookup, pinned), 'lease initializes once')

  const announce = api.takeBranchConstructionRequest(pair.revalidationRequest)
  api.validateBranchGuardLease(announce, pinned)
  t.exception(() => pair.takePair(), 'one completed branch is never externally transferable')

  const lookupResource = resource()
  const announceResource = resource()
  api.completeBranchConstruction(lookup, lookupResource.value)
  t.exception(() => pair.takePair(), 'the first completed half remains private')
  api.completeBranchConstruction(announce, announceResource.value)
  const transfer = pair.takePair()
  t.alike(Object.keys(transfer), [])
  const allocate = b4a.allocUnsafeSlow
  const allocated = []
  b4a.allocUnsafeSlow = (size) => {
    const value = allocate(allocated.length === 1 ? size - 1 : size)
    allocated.push(value)
    return value
  }
  try {
    t.exception(
      () => api.consumeBranchConstructionPair(transfer),
      'partial path-binding allocation fails before pair ownership moves'
    )
  } finally {
    b4a.allocUnsafeSlow = allocate
  }
  t.is(allocated.length, 2)
  t.ok(allocated.every((value) => b4a.equals(value, b4a.alloc(value.byteLength))))
  const moved = api.consumeBranchConstructionPair(transfer)
  t.is(moved.lookup, lookupResource.value)
  t.is(moved.announce, announceResource.value)
  t.ok(Object.isFrozen(moved.pathBinding))
  t.alike(Object.keys(moved.pathBinding), [])
  t.is(api.revokeBranchPathPairBinding(moved.pathBinding), true)
  t.is(api.revokeBranchPathPairBinding(moved.pathBinding), false)
  t.exception(() => api.consumeBranchConstructionPair(transfer), 'pair transfer is one-use')
  t.is(pair.destroy(), false, 'pair consumption terminally erases the authority')
  t.is(lookupResource.destroys, 0, 'consumed resource ownership moved to the manager')
  t.is(announceResource.destroys, 0)
})

test('revalidation accepts only identical or strictly newer pinned-guard advertisements', (t) => {
  const identity = safetyRoleIdentity(30)
  const at = endpoint(32)
  const initial = advertisement({ identity, at, epoch: 2n })

  for (const [name, candidate, accepted] of [
    ['byte-identical', initial, true],
    ['higher epoch', advertisement({ identity, at, epoch: 3n }), true],
    ['lower epoch', advertisement({ identity, at, epoch: 1n }), false],
    ['same epoch equivocation', advertisement({ identity, at, epoch: 2n, routeSeed: 99 }), false],
    ['identity drift', advertisement({ identity: safetyRoleIdentity(31), at, epoch: 3n }), false],
    ['endpoint drift', advertisement({ identity, at: endpoint(33), epoch: 3n }), false]
  ]) {
    const pair = authority()
    const lookup = api.takeBranchConstructionRequest(pair.bootstrapRequest)
    api.initializeBranchGuardLease(lookup, initial)
    const announce = api.takeBranchConstructionRequest(pair.revalidationRequest)
    if (accepted) api.validateBranchGuardLease(announce, candidate)
    else t.exception(() => api.validateBranchGuardLease(announce, candidate), name)
    pair.destroy()
  }
})

test('pair rollback erases metadata before closing both branch resources exactly once', (t) => {
  const events = []
  let pair = null
  const lookupResource = resource(() => {
    events.push({
      diagnostics: pair.diagnostics(),
      announceDestroys: announceResource.destroys
    })
  })
  const announceResource = resource()
  pair = authority({
    [api.TEST_ONLY_BRANCH_CONSTRUCTION_OBSERVER](event) {
      events.push(event)
    }
  })
  const lookup = api.takeBranchConstructionRequest(pair.bootstrapRequest)
  api.initializeBranchGuardLease(lookup, advertisement())
  const announce = api.takeBranchConstructionRequest(pair.revalidationRequest)
  api.validateBranchGuardLease(announce, advertisement())
  api.completeBranchConstruction(lookup, lookupResource.value)
  api.completeBranchConstruction(announce, announceResource.value)

  t.is(pair.destroy(), true)
  t.is(pair.destroy(), false)
  t.is(lookupResource.destroys, 1)
  t.is(announceResource.destroys, 1)
  const callback = events.find((event) => event.diagnostics)
  t.alike(callback.diagnostics, { state: 'DESTROYED', completedBranches: 0 })
  t.is(callback.announceDestroys, 0, 'all metadata is terminal before external closes begin')
  for (const event of events.filter((event) => event.type)) {
    t.ok(Object.isFrozen(event))
    t.absent(
      Object.values(event).some(b4a.isBuffer),
      'observer never receives branch or lease bytes'
    )
  }
})

test('clock, observer, and resource-getter reentry cannot resurrect branch ownership', (t) => {
  let pair = null
  pair = authority({
    now() {
      pair.destroy()
      return NOW
    }
  })
  t.exception(() => api.takeBranchConstructionRequest(pair.bootstrapRequest))
  t.alike(pair.diagnostics(), { state: 'DESTROYED', completedBranches: 0 })

  let clockCalls = 0
  pair = authority({
    now() {
      clockCalls++
      if (clockCalls === 2) pair.destroy()
      return NOW
    }
  })
  const clockSession = api.takeBranchConstructionRequest(pair.bootstrapRequest)
  t.exception(() => api.initializeBranchGuardLease(clockSession, advertisement()))
  t.alike(pair.diagnostics(), { state: 'DESTROYED', completedBranches: 0 })

  let reentrySession = null
  let observerReentry = null
  const observerAdvertisement = advertisement()
  pair = authority({
    [api.TEST_ONLY_BRANCH_CONSTRUCTION_OBSERVER](event) {
      if (event.type !== 'guard-pinned') return
      try {
        api.initializeBranchGuardLease(reentrySession, observerAdvertisement)
      } catch (err) {
        observerReentry = err
      }
    }
  })
  reentrySession = api.takeBranchConstructionRequest(pair.bootstrapRequest)
  t.exception(() => api.initializeBranchGuardLease(reentrySession, observerAdvertisement))
  t.ok(observerReentry, 'caught observer reentry poisons the outer mutation')
  t.alike(pair.diagnostics(), { state: 'DESTROYED', completedBranches: 0 })

  let observerResource = null
  pair = authority({
    [api.TEST_ONLY_BRANCH_CONSTRUCTION_OBSERVER](event) {
      if (event.type === 'branch-completed') pair.destroy()
    }
  })
  const observerSession = api.takeBranchConstructionRequest(pair.bootstrapRequest)
  api.initializeBranchGuardLease(observerSession, advertisement())
  observerResource = resource()
  t.exception(() => api.completeBranchConstruction(observerSession, observerResource.value))
  t.is(observerResource.destroys, 1, 'observer destroy closes published ownership once')
  t.alike(pair.diagnostics(), { state: 'DESTROYED', completedBranches: 0 })

  let getterDestroys = 0
  pair = authority()
  const getterSession = api.takeBranchConstructionRequest(pair.bootstrapRequest)
  api.initializeBranchGuardLease(getterSession, advertisement())
  const hostile = Object.freeze(
    Object.defineProperty({}, 'destroy', {
      get() {
        pair.destroy()
        return () => {
          getterDestroys++
        }
      }
    })
  )
  t.exception(() => api.completeBranchConstruction(getterSession, hostile))
  t.is(getterDestroys, 1, 'ownership reserved before the getter closes after terminal reentry')
  t.alike(pair.diagnostics(), { state: 'DESTROYED', completedBranches: 0 })
})

test('the same live resource cannot be installed in both branches', (t) => {
  const pair = authority()
  const lookup = api.takeBranchConstructionRequest(pair.bootstrapRequest)
  api.initializeBranchGuardLease(lookup, advertisement())
  const announce = api.takeBranchConstructionRequest(pair.revalidationRequest)
  api.validateBranchGuardLease(announce, advertisement())
  const shared = resource()
  api.completeBranchConstruction(lookup, shared.value)
  t.exception(() => api.completeBranchConstruction(announce, shared.value))
  t.is(pair.destroy(), true)
  t.is(shared.destroys, 1, 'rollback closes a uniquely owned resource once')
})

test('caught observer reentry leaves no failed revalidation or completion committed', (t) => {
  const pinned = advertisement()
  let pair = null
  let announce = null
  let nestedError = null
  pair = authority({
    [api.TEST_ONLY_BRANCH_CONSTRUCTION_OBSERVER](event) {
      if (event.type !== 'guard-revalidated') return
      try {
        api.validateBranchGuardLease(announce, pinned)
      } catch (err) {
        nestedError = err
      }
    }
  })
  const lookup = api.takeBranchConstructionRequest(pair.bootstrapRequest)
  api.initializeBranchGuardLease(lookup, pinned)
  announce = api.takeBranchConstructionRequest(pair.revalidationRequest)
  t.exception(() => api.validateBranchGuardLease(announce, pinned))
  t.ok(nestedError)
  t.alike(pair.diagnostics(), { state: 'DESTROYED', completedBranches: 0 })

  let lookupSession = null
  let owned = null
  nestedError = null
  pair = authority({
    [api.TEST_ONLY_BRANCH_CONSTRUCTION_OBSERVER](event) {
      if (event.type !== 'branch-completed') return
      try {
        api.completeBranchConstruction(lookupSession, owned.value)
      } catch (err) {
        nestedError = err
      }
    }
  })
  lookupSession = api.takeBranchConstructionRequest(pair.bootstrapRequest)
  api.initializeBranchGuardLease(lookupSession, pinned)
  owned = resource()
  t.exception(() => api.completeBranchConstruction(lookupSession, owned.value))
  t.ok(nestedError)
  t.alike(pair.diagnostics(), { state: 'DESTROYED', completedBranches: 0 })
  t.is(owned.destroys, 1, 'failed outer completion closes its committed resource once')
})

test('branch authority rejects caller topology and malformed paired allocations', (t) => {
  for (const name of ['path', 'guard', 'endpoint', 'branchId', 'generation']) {
    t.exception(() =>
      api.createBranchConstructionAuthority({
        lookup: branch(routes.BRANCH_CLASS.LOOKUP, 81),
        announce: branch(routes.BRANCH_CLASS.ANNOUNCE, 101),
        now: () => NOW,
        [name]: Object.freeze({})
      })
    )
  }
  t.exception(() =>
    api.createBranchConstructionAuthority({
      lookup: branch(routes.BRANCH_CLASS.LOOKUP, 81),
      announce: branch(routes.BRANCH_CLASS.LOOKUP, 101),
      now: () => NOW
    })
  )
  t.exception(() =>
    api.createBranchConstructionAuthority({
      lookup: branch(routes.BRANCH_CLASS.LOOKUP, 81),
      announce: branch(routes.BRANCH_CLASS.ANNOUNCE, 81),
      now: () => NOW
    })
  )
  const nested = b4a.alloc(16, 0xee)
  const lookup = branch(routes.BRANCH_CLASS.LOOKUP, 121)
  t.exception(() =>
    api.createBranchConstructionAuthority({
      lookup: Object.freeze({ ...lookup, requestedLimits: Object.freeze({ nested }) }),
      announce: branch(routes.BRANCH_CLASS.ANNOUNCE, 141),
      now: () => NOW
    })
  )
  t.alike(nested, b4a.alloc(16, 0xee), 'rejected caller limits remain caller-owned')
})
