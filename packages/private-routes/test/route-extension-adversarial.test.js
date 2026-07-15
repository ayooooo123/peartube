import test from 'brittle'
import b4a from 'b4a'

import * as routes from '../index.js'
import * as routeManagerInternals from '../lib/route-manager.js'

const NOW = 1_000n
const TEST_ONLY_DYNAMIC_OBSERVER = routeManagerInternals.TEST_ONLY_DYNAMIC_OBSERVER
const FORBIDDEN_INPUTS = Object.freeze([
  'branchId',
  'candidateEndpoint',
  'circuitId',
  'generation',
  'grant',
  'guard',
  'linkHandle',
  'path',
  'topologyGrant'
])
function hasSurface() {
  return (
    typeof routes.RouteManager.createDynamic === 'function' &&
    typeof routes.M3AdjacencyAuthority === 'function' &&
    typeof routes.RelayService.prototype.installM3 === 'function' &&
    typeof TEST_ONLY_DYNAMIC_OBSERVER === 'symbol'
  )
}

function requireSurface(t) {
  const required = [
    ['RouteManager.createDynamic', routes.RouteManager.createDynamic, 'function'],
    ['M3AdjacencyAuthority', routes.M3AdjacencyAuthority, 'function'],
    ['RelayService.installM3', routes.RelayService.prototype.installM3, 'function'],
    ['deep TEST_ONLY_DYNAMIC_OBSERVER', TEST_ONLY_DYNAMIC_OBSERVER, 'symbol']
  ]
  for (const [name, value, type] of required) {
    t.is(typeof value, type, `${name} is a reviewed Task 3 surface`)
  }
}

function opaque(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.isFrozen(value) &&
    Object.keys(value).length === 0
  )
}

function trackedRandom(values) {
  let byte = 0x31
  return (size) => {
    const value = b4a.allocUnsafeSlow(size).fill(byte++)
    values.push(value)
    return value
  }
}

function allZero(values) {
  return values.every((value) => b4a.equals(value, b4a.alloc(value.byteLength)))
}

function containsBuffer(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  if (b4a.isBuffer(value)) return true
  for (const child of Object.values(value)) {
    if (containsBuffer(child, seen)) return true
  }
  return false
}

function actorFactory(name, harness, behavior = {}) {
  return (request) => {
    harness.local.push(`${name}:create`)
    harness.t.ok(opaque(request), `${name} receives one frozen zero-key request capability`)
    let destroyed = false
    let opened = false
    const record = { closes: 0, name }
    const actor = Object.freeze({
      async open() {
        harness.local.push(`${name}:open`)
        if (opened) throw new Error(`${name} opened twice`)
        opened = true
        if (behavior.reenter) behavior.reenter()
        if (behavior.defer) await Promise.resolve()
        if (behavior.fail) throw behavior.fail
        const transfer = Object.freeze({})
        harness.transfers.push(transfer)
        return transfer
      },
      destroy() {
        if (destroyed) return
        destroyed = true
        record.closes++
        harness.local.push(`${name}:destroy`)
      }
    })
    harness.actors.push(actor)
    harness.records.push(record)
    return actor
  }
}

function tailControlTransportFactory(harness) {
  return (request) => {
    harness.local.push('tail-transport:create')
    harness.t.ok(opaque(request), 'tail transport receives only an opaque request capability')
    let destroyed = false
    const record = { closes: 0, name: 'tail-transport' }
    const transport = Object.freeze({
      async receive() {
        return new Promise(() => {})
      },
      async send() {},
      destroy() {
        if (destroyed) return
        destroyed = true
        record.closes++
      }
    })
    harness.records.push(record)
    return transport
  }
}

function harness(t, overrides = {}) {
  const state = {
    actors: [],
    local: [],
    observer: [],
    random: [],
    records: [],
    t,
    transfers: []
  }
  const options = {
    adjacencyAuthority: new routes.M3AdjacencyAuthority({
      now: overrides.now || (() => NOW),
      crypto: routes.cryptoSuite
    }),
    bootstrapIOFactory:
      overrides.bootstrapIOFactory || actorFactory('bootstrap-io', state, overrides.bootstrap),
    cancel: overrides.cancel || clearTimeout,
    crypto: routes.cryptoSuite,
    guardRevalidationIOFactory:
      overrides.guardRevalidationIOFactory ||
      actorFactory('guard-revalidation-io', state, overrides.revalidation),
    limits: Object.freeze({}),
    now: overrides.now || (() => NOW),
    randomBytes: overrides.randomBytes || trackedRandom(state.random),
    routedDiscoveryService: Object.freeze({
      async request() {
        throw new Error('routed discovery is unavailable in the pre-guard fixture')
      }
    }),
    schedule: overrides.schedule || setTimeout,
    tailControlTransportFactory:
      overrides.tailControlTransportFactory || tailControlTransportFactory(state),
    [TEST_ONLY_DYNAMIC_OBSERVER](event) {
      state.observer.push(event)
    }
  }
  return { options, state }
}

async function rejects(t, operation, message) {
  let failed = false
  try {
    await operation()
  } catch {
    failed = true
  }
  t.ok(failed, message)
}

function events(state, type, resource = null) {
  return state.observer.filter(
    (event) => event.type === type && (resource === null || event.resource === resource)
  )
}

function assertRedactedObserver(t, state) {
  for (const event of state.observer) {
    t.ok(Object.isFrozen(event), 'observer transition is immutable')
    t.absent(containsBuffer(event), 'observer transition contains no identity, endpoint, or secret')
  }
}

test('Task 3 keeps a minimal public surface and a deep test-only observer', (t) => {
  requireSurface(t)
  t.absent(
    'TEST_ONLY_DYNAMIC_OBSERVER' in routes,
    'dynamic observer is not exported from the package namespace'
  )
})

test('caller allocations, paths, grants, handles, and open arguments reject before IO', async (t) => {
  if (!hasSurface()) return

  for (const name of FORBIDDEN_INPUTS) {
    const { options, state } = harness(t)
    await rejects(
      t,
      async () => routes.RouteManager.createDynamic({ ...options, [name]: Object.freeze({}) }),
      `createDynamic rejects caller-supplied ${name}`
    )
    t.is(state.local.length, 0, `${name} rejects before IO creation`)
  }

  const { options, state } = harness(t)
  const manager = routes.RouteManager.createDynamic(options)
  await rejects(
    t,
    () => manager.openDynamic({ linkHandle: Object.freeze({}) }),
    'openDynamic rejects every argument'
  )
  t.is(state.local.length, 0, 'invalid open input reaches no IO')
  manager.destroy()
})

test('both manager allocations precede bootstrap and are erased on bootstrap failure', async (t) => {
  if (!hasSurface()) return
  const { options, state } = harness(t, { bootstrap: { fail: new Error('bootstrap failed') } })
  const manager = routes.RouteManager.createDynamic(options)
  await rejects(t, () => manager.openDynamic(), 'bootstrap failure fails the unopened pair')

  const allocations = events(state, 'allocation-reserved')
  const bootstrapCreated = state.observer.findIndex(
    (event) => event.type === 'io-created' && event.resource === 'bootstrap'
  )
  t.is(allocations.length, 2, 'lookup and announce are both allocated')
  t.ok(
    allocations.every((event) => state.observer.indexOf(event) < bootstrapCreated),
    'both allocations precede BootstrapIO creation'
  )
  t.is(events(state, 'allocation-erased').length, 2, 'both unpublished allocations are erased')
  t.is(state.records[0].closes, 1, 'failed BootstrapIO closes once')
  t.ok(state.random.length > 0, 'the manager allocated owned random state')
  t.ok(allZero(state.random), 'manager-owned allocation randomness is zeroized')
  assertRedactedObserver(t, state)
  manager.destroy()
  t.is(state.records[0].closes, 1, 'terminal destroy cannot close BootstrapIO twice')
})

test('reentry and queued completion cannot publish a transfer after terminal destroy', async (t) => {
  if (!hasSurface()) return
  let manager = null
  const { options, state } = harness(t)
  options.bootstrapIOFactory = actorFactory('bootstrap-io', state, {
    defer: true,
    reenter: () => manager.destroy()
  })
  manager = routes.RouteManager.createDynamic(options)
  await rejects(t, () => manager.openDynamic(), 'destroy during awaited IO fails closed')
  await Promise.resolve()

  t.is(events(state, 'guard-link-transferred').length, 0, 'queued completion publishes no link')
  t.is(events(state, 'allocation-erased').length, 2, 'reentry erases both allocations')
  t.absent(
    state.local.includes('guard-revalidation-io:create'),
    'queued completion cannot create revalidation IO'
  )
  t.is(state.records[0].closes, 1, 'reentrant destroy closes IO once')
  t.ok(state.random.length > 0, 'the manager allocated random state before IO')
  t.ok(allZero(state.random), 'reentrant terminal path erases manager-owned secrets')
  assertRedactedObserver(t, state)
  await rejects(t, () => manager.openDynamic(), 'destroyed manager remains terminal')
  t.is(state.records[0].closes, 1, 'stable terminal failure cannot close twice')
})
