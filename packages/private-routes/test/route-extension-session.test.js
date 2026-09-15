import test from 'brittle'
import b4a from 'b4a'

import { RouteExtensionSession } from '../index.js'
import {
  createRouteExtensionLimits,
  createRouteExtensionSessionRequest,
  takeRouteExtensionTransfer
} from '../lib/route-extension.js'
import { RELAY_CAPABILITY } from '../lib/protocol.js'

function opaque(t, value, name) {
  t.ok(Object.isFrozen(value), `${name} is frozen`)
  t.alike(Object.keys(value), [], `${name} is opaque`)
}

function harness(t, overrides = {}) {
  const extensionIndex = overrides.extensionIndex || 1
  const trace = []
  const candidate = Object.freeze({})
  const evidence = Object.freeze({})
  const completion = Object.freeze({})
  const nextTail = Object.freeze({ destroy() {} })
  let tailDestroys = 0
  let transportDestroys = 0
  let received = 0
  const tailControl = {
    sealDiscoverRequest(options) {
      trace.push('discover:seal')
      t.is(options.maximumResults, 1)
      t.is(
        options.requestedCapabilityMask,
        extensionIndex === 1
          ? RELAY_CAPABILITY.CIRCUIT_RELAY_V1
          : RELAY_CAPABILITY.CIRCUIT_RELAY_V1 | RELAY_CAPABILITY.DHT_EXIT_V1
      )
      t.is(options.randomTarget.byteLength, 32)
      t.is(options.queryNonce.byteLength, 32)
      return b4a.alloc(1101, 0x11)
    },
    openDiscoverResponse() {
      trace.push('discover:open')
      return evidence
    },
    sealExtend(selected, options) {
      trace.push('extend:seal')
      t.is(selected, candidate)
      t.is(options.requestedLimits.cellSize, 1200)
      t.is(options.requestedLimits.expiresAtMs, 6_000n)
      return b4a.alloc(1101, 0x22)
    },
    openExtended() {
      trace.push('extended:open')
      return completion
    },
    completeClientExtension(selected, ready) {
      trace.push('ready:open')
      t.is(selected, completion)
      t.is(ready[0], 0x44)
      return nextTail
    },
    abortClientExtension(selected) {
      trace.push('extension:abort')
      t.is(selected, completion)
      return true
    },
    destroy() {
      tailDestroys++
      trace.push('tail:destroy')
    }
  }
  const responses = overrides.responses || [
    b4a.alloc(1101, 0x33),
    b4a.alloc(1101, 0x43),
    b4a.alloc(1101, 0x44)
  ]
  const transport = {
    async send(frame) {
      trace.push(`send:${frame[0]}`)
    },
    async receive() {
      trace.push('receive')
      if (overrides.receive) return overrides.receive()
      return responses[received++]
    },
    destroy() {
      transportDestroys++
      trace.push('transport:destroy')
    }
  }
  const candidateDirectory = {
    admit(selected) {
      trace.push('candidate:admit')
      t.is(selected, evidence)
      return overrides.candidates || Object.freeze([candidate])
    }
  }
  let randomByte = 0x51
  const request = createRouteExtensionSessionRequest({
    candidateDirectory,
    cancel: clearTimeout,
    deadline: 6_000n,
    extensionIndex,
    limits: Object.freeze({}),
    now: () => 1_000n,
    randomBytes: (size) => b4a.alloc(size, randomByte++),
    routedDiscoveryService: Object.freeze({
      async request(capability) {
        trace.push('discovery:request')
        opaque(t, capability, 'routed discovery request')
      }
    }),
    schedule: setTimeout,
    tailControl,
    tailControlTransportFactory(capability) {
      trace.push('transport:create')
      opaque(t, capability, 'tail transport request')
      return transport
    }
  })
  return {
    nextTail,
    request,
    trace,
    get tailDestroys() {
      return tailDestroys
    },
    get transportDestroys() {
      return transportDestroys
    },
    transport
  }
}

test('RouteExtensionSession transfers one authenticated successor tail', async (t) => {
  const f = harness(t)
  opaque(t, f.request, 'route extension request')
  const session = new RouteExtensionSession(f.request)
  t.alike(session.diagnostics(), { state: 'REQUESTED' })

  const transfer = await session.open()
  opaque(t, transfer, 'route extension transfer')
  t.alike(session.diagnostics(), { state: 'ACTIVE' })
  const moved = takeRouteExtensionTransfer(transfer)

  t.is(moved.tailControl, f.nextTail)
  t.is(moved.transport, f.transport)
  t.alike(session.diagnostics(), { state: 'DESTROYED' })
  t.is(f.tailDestroys, 0)
  t.is(f.transportDestroys, 0)
  t.alike(f.trace, [
    'transport:create',
    'discover:seal',
    'send:17',
    'discovery:request',
    'receive',
    'discover:open',
    'candidate:admit',
    'extend:seal',
    'send:34',
    'receive',
    'extended:open',
    'receive',
    'ready:open'
  ])
  t.exception(() => takeRouteExtensionTransfer(transfer), 'the transfer is one-use')
})

test('the final extension discovers a relay-capable DHT exit', async (t) => {
  const f = harness(t, { extensionIndex: 2 })
  const session = new RouteExtensionSession(f.request)
  const transfer = await session.open()
  const moved = takeRouteExtensionTransfer(transfer)

  t.is(moved.tailControl, f.nextTail)
  t.is(moved.transport, f.transport)
})

test('RouteExtensionSession fails closed when discovery mints no candidate', async (t) => {
  const f = harness(t, { candidates: Object.freeze([]) })
  const session = new RouteExtensionSession(f.request)

  await t.exception(session.open())
  t.alike(session.diagnostics(), { state: 'DESTROYED' })
  t.is(f.tailDestroys, 1)
  t.is(f.transportDestroys, 1)
  t.is(session.destroy(), false, 'terminal teardown is idempotent')
})

test('RouteExtensionSession consumes its manager request exactly once', (t) => {
  const f = harness(t)
  const session = new RouteExtensionSession(f.request)
  t.exception(() => new RouteExtensionSession(f.request), 'request replay rejects')
  t.ok(session.destroy())
  t.is(f.tailDestroys, 1)
})

test('dynamic route limits fill safe defaults and clamp to the tail deadline', (t) => {
  t.alike(
    createRouteExtensionLimits(Object.freeze({}), () => 1_000n, 4_000n),
    {
      cellSize: 1200,
      maxCells: 64,
      maxBytes: 65_536,
      maxCommands: 10,
      idleTimeoutMs: 5_000,
      expiresAtMs: 4_000n
    }
  )
  t.exception(
    () => createRouteExtensionLimits(Object.freeze({ maxCells: 65 }), () => 1_000n, 4_000n),
    'limit overrides cannot exceed the reviewed hard cap'
  )
  t.exception(
    () => createRouteExtensionLimits(Object.freeze({ endpoint: 1 }), () => 1_000n, 4_000n),
    'unknown limit fields reject'
  )
})

test('destroy rejects a pending receive even when transport destroy is inert', async (t) => {
  const f = harness(t, { receive: () => new Promise(() => {}) })
  const session = new RouteExtensionSession(f.request)
  const opening = session.open()
  while (!f.trace.includes('receive')) await Promise.resolve()

  t.ok(session.destroy())
  await t.exception(opening, 'destroy rejects the coordinator wait')
  t.is(f.tailDestroys, 1)
  t.is(f.transportDestroys, 1)
})
