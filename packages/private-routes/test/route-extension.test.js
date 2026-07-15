import test from 'brittle'
import b4a from 'b4a'

import * as routes from '../index.js'
import * as routeManagerModule from '../lib/route-manager.js'
import { privateRoleIdentity, safetyRoleIdentity, seed } from './helpers.js'

const NOW = 1_000n

function completeSurface() {
  return (
    typeof routes.RouteManager.createDynamic === 'function' &&
    typeof routes.M3AdjacencyAuthority === 'function' &&
    typeof routes.RouteExtensionSession === 'function' &&
    typeof routeManagerModule.TEST_ONLY_DYNAMIC_OBSERVER === 'symbol'
  )
}

function endpoint(last, port) {
  return routes.encodeCanonicalEndpoint({
    addressFamily: 4,
    addressBytes: b4a.from([192, 0, 2, last]),
    port
  })
}

function signedRelay({ identity, routeSeed, reachableEndpoint, capabilities }) {
  const routeKeyPair = routes.cryptoSuite.encryptionKeyPair(seed(routeSeed))
  return routes.encodeRelayCapabilityAdvertisement(
    routes.signRelayCapabilityAdvertisement(
      {
        relayIdentity: identity.publicKey,
        currentDhtNodeId: routes.deriveM3DhtNodeId(reachableEndpoint),
        reachableEndpoint,
        routeEncryptionPublicKey: routeKeyPair.publicKey,
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
        expiresAtMs: 20_000n,
        providerServicePolicyEntries: routes.providerServicePolicyForCapabilities(capabilities)
      },
      identity.secretKey
    )
  )
}

function advertisements() {
  const relay = routes.RELAY_CAPABILITY.CIRCUIT_RELAY_V1
  const exit = relay | routes.RELAY_CAPABILITY.DHT_EXIT_V1
  return Object.freeze([
    signedRelay({
      identity: safetyRoleIdentity(40),
      routeSeed: 41,
      reachableEndpoint: endpoint(11, 41_011),
      capabilities: relay
    }),
    signedRelay({
      identity: privateRoleIdentity(80),
      routeSeed: 81,
      reachableEndpoint: endpoint(12, 41_012),
      capabilities: exit
    }),
    signedRelay({
      identity: safetyRoleIdentity(120),
      routeSeed: 121,
      reachableEndpoint: endpoint(13, 41_013),
      capabilities: relay
    }),
    signedRelay({
      identity: privateRoleIdentity(160),
      routeSeed: 161,
      reachableEndpoint: endpoint(14, 41_014),
      capabilities: exit
    })
  ])
}

function assertOpaque(t, value, label) {
  t.ok(Object.isFrozen(value), `${label} is frozen`)
  t.alike(Object.keys(value), [], `${label} is opaque`)
}

function pendingIo(t, name, trace) {
  const requests = []
  const actors = []
  const factory = (request) => {
    assertOpaque(t, request, `${name} construction request`)
    requests.push(request)
    let rejectOpen = null
    let destroyed = false
    const actor = Object.freeze({
      open() {
        trace.push(`${name}:open`)
        return new Promise((resolve, reject) => {
          rejectOpen = reject
        })
      },
      destroy() {
        if (destroyed) return
        destroyed = true
        trace.push(`${name}:destroy`)
        if (rejectOpen) rejectOpen(new Error(`${name} destroyed`))
      }
    })
    actors.push(actor)
    return actor
  }
  return Object.freeze({ actors, factory, requests })
}

function pendingTailTransport(t, trace) {
  const requests = []
  return Object.freeze({
    factory(request) {
      assertOpaque(t, request, 'tail-control transport request')
      requests.push(request)
      let rejectReceive = null
      let destroyed = false
      return Object.freeze({
        async send(encoded) {
          if (!b4a.isBuffer(encoded)) throw new Error('tail control must send encoded bytes')
          trace.push('tail-transport:send')
        },
        receive() {
          return new Promise((resolve, reject) => {
            rejectReceive = reject
          })
        },
        destroy() {
          if (destroyed) return
          destroyed = true
          trace.push('tail-transport:destroy')
          if (rejectReceive) rejectReceive(new Error('tail transport destroyed'))
        }
      })
    },
    requests
  })
}

function containsSensitiveValue(value, seen = new Set()) {
  if (b4a.isBuffer(value)) return true
  if (value === null || typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    if (/endpoint|identity|key|nonce|circuit|advertisement/i.test(key)) return true
    if (containsSensitiveValue(child, seen)) return true
  }
  return false
}

function managerHarness(t) {
  const observer = routeManagerModule.TEST_ONLY_DYNAMIC_OBSERVER
  const trace = []
  const snapshots = []
  const bootstrap = pendingIo(t, 'bootstrap', trace)
  const revalidation = pendingIo(t, 'guard-revalidation', trace)
  const tailTransport = pendingTailTransport(t, trace)
  const discoveryAdvertisements = advertisements()
  let randomByte = 0x31
  let discoveryCalls = 0
  const manager = routes.RouteManager.createDynamic({
    now: () => NOW,
    randomBytes(size) {
      return b4a.alloc(size, randomByte++)
    },
    schedule: setTimeout,
    cancel: clearTimeout,
    crypto: routes.cryptoSuite,
    limits: Object.freeze({}),
    bootstrapIOFactory: bootstrap.factory,
    guardRevalidationIOFactory: revalidation.factory,
    tailControlTransportFactory: tailTransport.factory,
    adjacencyAuthority: new routes.M3AdjacencyAuthority({
      now: () => NOW,
      crypto: routes.cryptoSuite
    }),
    routedDiscoveryService: Object.freeze({
      async request() {
        discoveryCalls++
        return discoveryAdvertisements
      }
    }),
    [observer](snapshot) {
      snapshots.push(snapshot)
    }
  })
  return Object.freeze({
    bootstrap,
    get discoveryCalls() {
      return discoveryCalls
    },
    manager,
    revalidation,
    snapshots,
    tailTransport,
    trace
  })
}

async function turn() {
  await Promise.resolve()
  await Promise.resolve()
}

test('dynamic manager API is opt-in and its observer is not public', (t) => {
  t.ok(
    typeof routes.RouteManager.createDynamic === 'function',
    'RouteManager.createDynamic(options) exists'
  )
  t.is(
    typeof routeManagerModule.TEST_ONLY_DYNAMIC_OBSERVER,
    'symbol',
    'the deep module exposes a test-only observer symbol'
  )
  t.is(routes.TEST_ONLY_DYNAMIC_OBSERVER, undefined, 'the observer is absent from the public index')
})

test('openDynamic rejects caller topology and accepts no arguments', async (t) => {
  if (!completeSurface()) return
  const f = managerHarness(t)
  await t.exception(f.manager.openDynamic({}), 'openDynamic rejects even an empty options object')
  f.manager.destroy()
})

test('manager publishes no branch while real extension sessions are unavailable', async (t) => {
  if (!completeSurface()) return
  const f = managerHarness(t)
  let settled = false
  const opening = f.manager.openDynamic()
  opening.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await turn()

  t.absent(settled, 'openDynamic remains pending before an authenticated index-zero transfer')
  t.is(f.bootstrap.requests.length, 1, 'the manager starts one cold bootstrap acquisition')
  t.is(f.revalidation.requests.length, 0, 'guard revalidation cannot start before guard pinning')
  t.is(f.tailTransport.requests.length, 0, 'tail control cannot start before guard readiness')
  t.is(f.discoveryCalls, 0, 'routed discovery cannot start before guard readiness')
  t.ok(f.snapshots.length > 0, 'manager transitions are observable through the private hook')
  for (const snapshot of f.snapshots) {
    t.ok(Object.isFrozen(snapshot), 'observer snapshot is frozen')
    t.absent(containsSensitiveValue(snapshot), 'observer snapshot is redacted')
    t.absent(snapshot.state === 'CONSTRUCTED', 'no branch is constructed before ACTIVE extensions')
  }

  f.manager.destroy()
  await t.exception(opening, 'destroy rejects the pending construction')
})
