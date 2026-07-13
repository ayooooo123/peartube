import test from 'brittle'
import b4a from 'b4a'

import { CELL_CLASS, CELL_SIZE, DIRECTION, cryptoSuite } from '../index.js'
import { LINK_CREATED_SIZE, LINK_CREATE_SIZE } from '../lib/link-setup.js'
import { createCompiledRouteSimulator } from '../lib/route-manager.js'
import { expectCode } from './helpers.js'
import { assertZeroResources, publicActorRouteFixture } from './compiled-route-fixture.js'

const ROUTE_ROTATE_AT = (1n << 63n) - 1n - 1024n
const MAX_ROUTE_LOGICAL_COUNTER = (1n << 63n) - 1n

test('adjacent actor failure before retention rolls back every staged circuit', (t) => {
  const fixture = publicActorRouteFixture()
  const destinationDestroyedBefore = fixture.destinationEvents.filter(
    (event) => event.type === 'private-destination-circuit-destroyed'
  ).length
  fixture.setRejectActorTransmission(true)

  expectCode(t, () => fixture.open(), 'ROUTE_UNAVAILABLE')

  const relayDestroyed = fixture.actorEvents.filter(
    (event) => event.type === 'private-circuit-destroyed'
  )
  t.alike(
    relayDestroyed.map((event) => event.activeCircuits),
    [0]
  )
  t.is(fixture.resources().safetyRoutes, 0)
  t.is(fixture.resources().safetyCallbacks, 0)
  t.is(fixture.resources().networkPending, 0)
  const destinationDestroyed = fixture.destinationEvents.filter(
    (event) => event.type === 'private-destination-circuit-destroyed'
  )
  t.is(destinationDestroyed.length, destinationDestroyedBefore)
  fixture.destroyActors()
})

test('queued actor LinkCreate and LinkCreated setup is cancelled fail closed', (t) => {
  for (const size of [LINK_CREATE_SIZE, LINK_CREATED_SIZE]) {
    const fixture = publicActorRouteFixture()
    fixture.setQueuedActorSetupSize(size)

    expectCode(t, () => fixture.open(), 'ROUTE_UNAVAILABLE')

    const resources = fixture.resources()
    t.is(resources.queuedActorSetup, 0, `${size} leaves no queued setup bytes`)
    t.is(resources.cancelledActorSetup, 1, `${size} cancellation invoked exactly once`)
    t.is(resources.networkPending, 0, `${size} leaves no VNet delivery`)
    t.is(resources.safetyRoutes, 0, `${size} tears down the Safety route`)
    t.is(resources.safetyEntryAttachments, 0, `${size} tears down the entry attachment`)
    const actorEventsBeforeLateDelivery = fixture.actorEvents.length
    const destinationEventsBeforeLateDelivery = fixture.destinationEvents.length
    let lateError = null
    try {
      fixture.fireRetainedActorSetupCallbacks()
    } catch (err) {
      lateError = err
    }
    t.is(lateError, null, `${size} ignores callbacks retained after setup cancellation`)
    t.is(
      fixture.actorEvents.length,
      actorEventsBeforeLateDelivery,
      `${size} late callback cannot mutate relay state`
    )
    t.is(
      fixture.destinationEvents.length,
      destinationEventsBeforeLateDelivery,
      `${size} late callback cannot mutate destination state`
    )
    fixture.destroyActors()
  }
})

test('deep compiled simulator remains a non-normative smoke harness', (t) => {
  const route = createCompiledRouteSimulator({ safetyHops: 2, privateHops: 2 })
  t.alike(Object.keys(route.circuit).sort(), [
    'destroy',
    'drain',
    'sendDatagram',
    'sendStreamFrame'
  ])
  route.circuit.destroy()
})

test('public actor route exposes bounded API and carries both payload classes bidirectionally', (t) => {
  const fixture = publicActorRouteFixture()
  const circuit = fixture.open()
  t.is(fixture.sourceDestinationReplayCacheSize(), 1)
  t.is(fixture.resources().safetyEntryAttachments, 1)
  t.alike(Object.keys(circuit).sort(), ['destroy', 'drain', 'sendDatagram', 'sendStreamFrame'])
  t.is(circuit.directFallback, undefined)
  t.ok(fixture.actorTransmissions.some(({ bytes }) => bytes === LINK_CREATE_SIZE))
  t.ok(fixture.actorTransmissions.some(({ bytes }) => bytes === LINK_CREATED_SIZE))
  const permittedActorEdges = new Set([
    `${fixture.nodes.safetyNode}->${fixture.nodes.privateNodes[0]}`,
    `${fixture.nodes.privateNodes[0]}->${fixture.nodes.safetyNode}`,
    ...fixture.nodes.privateNodes.slice(0, -1).flatMap((from, index) => {
      const to = fixture.nodes.privateNodes[index + 1]
      return [`${from}->${to}`, `${to}->${from}`]
    }),
    `${fixture.nodes.privateNodes.at(-1)}->${fixture.nodes.destinationNode}`,
    `${fixture.nodes.destinationNode}->${fixture.nodes.privateNodes.at(-1)}`
  ])
  t.ok(
    fixture.actorTransmissions.every(({ from, to }) => permittedActorEdges.has(`${from}->${to}`))
  )
  t.ok(
    fixture.actorTransmissions.every(
      ({ from, to }) =>
        !(
          (from === fixture.nodes.sourceNode && to === fixture.nodes.destinationNode) ||
          (from === fixture.nodes.destinationNode && to === fixture.nodes.sourceNode)
        )
    )
  )

  circuit.sendStreamFrame(b4a.from('forward stream'))
  circuit.sendDatagram(b4a.from('forward datagram'))
  fixture.sendDestinationStream(b4a.from('reverse stream'))
  fixture.sendDestinationDatagram(b4a.from('reverse datagram'))

  t.alike(fixture.atDestinationStream, [b4a.from('forward stream')])
  t.alike(fixture.atDestinationDatagram, [b4a.from('forward datagram')])
  t.alike(fixture.atSourceStream, [b4a.from('reverse stream')])
  t.alike(fixture.atSourceDatagram, [b4a.from('reverse datagram')])
  t.alike(fixture.network.directPeers(fixture.nodes.sourceNode), [fixture.nodes.safetyGuardNode])
  t.alike(fixture.network.directPeers(fixture.nodes.destinationNode), [
    fixture.nodes.privateNodes.at(-1)
  ])
  t.is(fixture.routeFrames.length, 4)
  t.ok(fixture.routeFrames.every(({ frame }) => frame.byteLength === 1100))
  const plaintexts = [
    b4a.from('forward stream'),
    b4a.from('forward datagram'),
    b4a.from('reverse stream'),
    b4a.from('reverse datagram')
  ]
  t.ok(
    fixture.routeFrames.every(({ frame }) =>
      plaintexts.every((plaintext) => frame.indexOf(plaintext) === -1)
    )
  )
  t.ok(
    fixture.routeFrames.every(({ frame }) =>
      fixture.forbiddenFrameBytes.every((secret) => frame.indexOf(secret) === -1)
    )
  )
  t.is(
    new Set(fixture.routeFrames.map(({ frame }) => b4a.toString(cryptoSuite.hash([frame]), 'hex')))
      .size,
    4
  )
  t.is(fixture.relayFrames.length, 20)
  t.ok(
    fixture.relayFrames.every(
      ({ frame, keys }) =>
        frame.byteLength === 1100 &&
        keys.join(',') === 'afterHash,beforeHash,byteLength,class,direction,frame,type' &&
        keys.every((key) => !/key|secret|nonce|ticket/i.test(key)) &&
        plaintexts.every((plaintext) => frame.indexOf(plaintext) === -1) &&
        fixture.forbiddenFrameBytes.every((secret) => frame.indexOf(secret) === -1)
    )
  )
  const relayFramesByDirection = new Map()
  for (const observed of fixture.relayFrames) {
    const key = `${observed.direction}:${observed.cellClass}`
    const values = relayFramesByDirection.get(key) || []
    values.push(observed)
    relayFramesByDirection.set(key, values)
  }
  t.is(relayFramesByDirection.size, 4)
  t.ok(
    Array.from(relayFramesByDirection.values()).every(
      (observed) =>
        observed.length === 5 &&
        new Set(observed.map(({ relay }) => relay)).size === 5 &&
        new Set(observed.map(({ frame }) => b4a.toString(cryptoSuite.hash([frame]), 'hex')))
          .size === 1
    )
  )
  const payloadSafety = fixture.safetyEvents.filter(
    (event) => event.cellClass !== CELL_CLASS.CONTROL
  )
  t.alike(
    payloadSafety.map((event) => [event.cellClass, event.direction, event.packetBytes]),
    [
      [CELL_CLASS.STREAM, DIRECTION.FORWARD, CELL_SIZE],
      [CELL_CLASS.DATAGRAM, DIRECTION.FORWARD, CELL_SIZE],
      [CELL_CLASS.STREAM, DIRECTION.REVERSE, CELL_SIZE],
      [CELL_CLASS.DATAGRAM, DIRECTION.REVERSE, CELL_SIZE]
    ]
  )
  t.ok(
    fixture.actorEvents.some(
      (event) =>
        event.type === 'private-frame' &&
        event.cellClass === CELL_CLASS.STREAM &&
        event.direction === DIRECTION.FORWARD &&
        typeof event.bindingFingerprint === 'string'
    )
  )
  const edges = fixture.network.edges()
  t.ok(
    edges.some(
      ([from, to]) => from === fixture.nodes.sourceNode && to === fixture.nodes.safetyGuardNode
    )
  )
  t.ok(
    edges.some(
      ([from, to]) => from === fixture.nodes.safetyGuardNode && to === fixture.nodes.safetyNode
    )
  )
  t.ok(
    edges.some(
      ([from, to]) => from === fixture.nodes.safetyNode && to === fixture.nodes.privateNodes[0]
    )
  )
  t.ok(
    fixture.nodes.privateNodes
      .slice(0, -1)
      .every((from, index) =>
        edges.some(
          ([edgeFrom, to]) => edgeFrom === from && to === fixture.nodes.privateNodes[index + 1]
        )
      )
  )
  t.ok(
    edges.some(
      ([from, to]) =>
        from === fixture.nodes.privateNodes.at(-1) && to === fixture.nodes.destinationNode
    )
  )
  const entryBindings = fixture.actorEvents.filter(
    (event) =>
      event.type === 'private-binding-opened' && event.localIdentity === fixture.entryIdentity
  )
  t.is(entryBindings.length, 2)
  t.ok(
    fixture.actorEvents.some(
      (event) =>
        event.type === 'private-frame' &&
        event.cellClass === CELL_CLASS.DATAGRAM &&
        event.direction === DIRECTION.REVERSE &&
        typeof event.bindingFingerprint === 'string'
    )
  )
  t.ok(
    fixture.safetyEvents.every(
      (event) => typeof event.bindingFingerprint === 'string' && typeof event.counter === 'bigint'
    )
  )
  t.ok(
    fixture.actorEvents
      .filter((event) => event.type === 'private-frame')
      .every((event) => event.packetBytes === CELL_SIZE)
  )
  t.is(
    fixture.network
      .edges()
      .some(
        ([from, to]) =>
          (from === fixture.nodes.sourceNode && to === fixture.nodes.destinationNode) ||
          (from === fixture.nodes.destinationNode && to === fixture.nodes.sourceNode)
      ),
    false
  )

  circuit.destroy()
  assertZeroResources(t, fixture)
  t.is(fixture.sourceDestinationReplayCacheSize(), 1)
  fixture.destroyActors()
})

test('deep payload counter requests rotation before exhaustion and fails closed without a candidate', (t) => {
  const fixture = publicActorRouteFixture({ sourceSenderInitial: ROUTE_ROTATE_AT - 1n })
  const circuit = fixture.open()

  expectCode(
    t,
    () => circuit.sendStreamFrame(b4a.from('last frame before rotation threshold')),
    'ROUTE_UNAVAILABLE'
  )
  t.alike(fixture.atDestinationStream, [b4a.from('last frame before rotation threshold')])
  t.is(circuit.directFallback, undefined)
  assertZeroResources(t, fixture)
  expectCode(t, () => circuit.sendStreamFrame(b4a.from('closed')), 'CIRCUIT_STATE')
  fixture.destroyActors()
})

test('real actor facade rotates epoch 7 to 8 while the old reverse path drains', (t) => {
  const fixture = publicActorRouteFixture({
    sourceSenderInitial: ROUTE_ROTATE_AT - 1n,
    higherEpochReplacement: true
  })
  const circuit = fixture.open()
  const facade = circuit

  circuit.sendStreamFrame(b4a.from('epoch 7 rotation trigger'))
  t.is(circuit, facade)
  t.alike(fixture.candidateProviderCalls, [[7n, 'rotation']])
  t.alike(fixture.installedSafetyEpochs, [7n, 7n, 8n, 8n])
  t.is(fixture.resources().safetyRoutes, 2)
  t.is(fixture.resources().scheduledDrains, 1)
  t.is(fixture.sourceDestinationReplayCacheSize(), 2)

  circuit.sendDatagram(b4a.from('epoch 8 forward'))
  fixture.sendDestinationStream(b4a.from('epoch 7 reverse at drain start'), 0)
  fixture.advance(4_999)
  fixture.sendDestinationDatagram(b4a.from('epoch 7 reverse at 4999'), 0)
  t.alike(fixture.atDestinationStream, [b4a.from('epoch 7 rotation trigger')])
  t.alike(fixture.atDestinationDatagram, [b4a.from('epoch 8 forward')])
  t.alike(fixture.atSourceStream, [b4a.from('epoch 7 reverse at drain start')])
  t.alike(fixture.atSourceDatagram, [b4a.from('epoch 7 reverse at 4999')])

  fixture.advance(1)
  t.is(fixture.resources().safetyRoutes, 1)
  t.is(fixture.resources().scheduledDrains, 0)
  expectCode(
    t,
    () => fixture.sendDestinationStream(b4a.from('epoch 7 reverse at 5000'), 0),
    'CIRCUIT_STATE'
  )
  circuit.sendStreamFrame(b4a.from('epoch 8 forward after old drain'))
  t.alike(fixture.atDestinationStream, [
    b4a.from('epoch 7 rotation trigger'),
    b4a.from('epoch 8 forward after old drain')
  ])

  circuit.destroy()
  assertZeroResources(t, fixture)
  fixture.destroyActors()
})

test('actor activation tombstones and entry replay cache stop exactly at 128', (t) => {
  const fixture = publicActorRouteFixture({ longRunRandom: true })

  for (let index = 0; index < 128; index++) fixture.open().destroy()

  const destroyed = fixture.actorEvents.filter(
    (event) => event.type === 'private-circuit-destroyed'
  )
  t.is(destroyed.length, 128 * 3)
  t.alike(
    destroyed
      .slice(-3)
      .map((event) => [
        event.activeCircuits,
        event.activationReplayTombstones,
        event.entryReplayTombstones
      ]),
    [
      [0, 128, 0],
      [0, 128, 0],
      [0, 128, 128]
    ]
  )

  expectCode(t, () => fixture.open(), 'CIRCUIT_LIMIT')
  t.is(
    fixture.actorEvents.filter((event) => event.type === 'private-circuit-destroyed').length,
    128 * 3 + 1
  )
  const afterLimit = fixture.actorEvents
    .filter((event) => event.type === 'private-circuit-destroyed')
    .at(-1)
  t.alike(
    [
      afterLimit.activeCircuits,
      afterLimit.activationReplayTombstones,
      afterLimit.entryReplayTombstones
    ],
    [0, 128, 128]
  )
  fixture.advance(8_000)
  fixture.destroyActors()
  t.alike(
    fixture.actorEvents
      .filter((event) => event.type === 'private-relay-destroying')
      .map((event) => [
        event.records,
        event.activationReplayTombstones,
        event.entryReplayTombstones
      ]),
    [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ]
  )
})

test('public counter exhaustion destroys the installed route and never asks for fallback', (t) => {
  let providerCalls = 0
  const fixture = publicActorRouteFixture({
    sourceSenderInitial: MAX_ROUTE_LOGICAL_COUNTER,
    rotationAlreadyRequested: true,
    routeCandidateProvider() {
      providerCalls++
      throw new Error('counter exhaustion must not request a route candidate')
    }
  })
  const circuit = fixture.open()

  circuit.sendStreamFrame(b4a.from('uint63 max is emitted once'))
  t.alike(fixture.atDestinationStream, [b4a.from('uint63 max is emitted once')])
  expectCode(t, () => circuit.sendStreamFrame(b4a.from('must not wrap')), 'COUNTER_EXHAUSTED')
  t.is(providerCalls, 0)
  t.is(circuit.directFallback, undefined)
  assertZeroResources(t, fixture)
  expectCode(t, () => circuit.sendDatagram(b4a.from('closed')), 'CIRCUIT_STATE')
  fixture.destroyActors()
})

test('public Safety queue overflow destroys all installed state without fallback', (t) => {
  let providerCalls = 0
  const fixture = publicActorRouteFixture({
    maxSafetyCircuitQueuedBytes: CELL_SIZE,
    routeCandidateProvider() {
      providerCalls++
      throw new Error('queue overflow must not request a route candidate')
    }
  })
  const circuit = fixture.open()
  fixture.setStallSafetyForward(true)

  circuit.sendDatagram(b4a.from('one queued cell'))
  t.is(fixture.resources().safetyQueuedBytes, CELL_SIZE)
  t.alike(fixture.atDestinationDatagram, [])
  expectCode(t, () => circuit.sendDatagram(b4a.from('overflow')), 'CIRCUIT_LIMIT')
  t.is(providerCalls, 0)
  t.is(circuit.directFallback, undefined)
  assertZeroResources(t, fixture)
  expectCode(t, () => circuit.sendStreamFrame(b4a.from('closed')), 'CIRCUIT_STATE')
  fixture.destroyActors()
})

test('public actor drain is reverse-only and expires at exactly 5000ms', (t) => {
  const fixture = publicActorRouteFixture()
  const circuit = fixture.open()
  circuit.drain()
  expectCode(t, () => circuit.sendStreamFrame(b4a.from('late forward')), 'CIRCUIT_STATE')
  fixture.sendDestinationStream(b4a.from('reverse at drain start'))
  fixture.advance(4_999)
  fixture.sendDestinationDatagram(b4a.from('reverse at 4999'))
  t.alike(fixture.atSourceStream, [b4a.from('reverse at drain start')])
  t.alike(fixture.atSourceDatagram, [b4a.from('reverse at 4999')])
  fixture.advance(1)
  assertZeroResources(t, fixture)
  expectCode(t, () => fixture.sendDestinationStream(b4a.from('reverse at 5000')), 'CIRCUIT_STATE')
  fixture.destroyActors()
})

test('public actor destroy cancels queued Safety delivery and zeroes all resources', (t) => {
  const fixture = publicActorRouteFixture()
  const circuit = fixture.open()
  fixture.setAutoFlush(false)
  circuit.sendDatagram(b4a.from('queued datagram'))
  t.is(fixture.resources().networkPending, 1)
  circuit.destroy()
  t.is(fixture.atDestinationDatagram.length, 0)
  t.is(fixture.resources().networkPending, 0)
  t.is(fixture.network.flush(), 0)
  t.is(fixture.atDestinationDatagram.length, 0)
  expectCode(t, () => circuit.sendDatagram(b4a.from('after destroy')), 'CIRCUIT_STATE')
  assertZeroResources(t, fixture)
  circuit.destroy()
  fixture.destroyActors()
})

test('destroying a live destination actor tears down the compiled route', (t) => {
  const fixture = publicActorRouteFixture()
  const circuit = fixture.open()

  fixture.destroyDestinationActor()

  expectCode(t, () => circuit.sendDatagram(b4a.from('closed')), 'CIRCUIT_STATE')
  assertZeroResources(t, fixture)
  fixture.destroyActors()
})

test('destroying a live middle relay tears down both route directions', (t) => {
  const fixture = publicActorRouteFixture()
  const circuit = fixture.open()

  fixture.destroyRelayActor(1)

  expectCode(t, () => circuit.sendStreamFrame(b4a.from('closed')), 'CIRCUIT_STATE')
  assertZeroResources(t, fixture)
  fixture.destroyActors()
})

test('late cancelled Safety and actor payload callbacks are inert after destroy', (t) => {
  for (const [path, target] of [
    ['Safety entry attachment', 1],
    ['actor adjacency', 2]
  ]) {
    const fixture = publicActorRouteFixture()
    const circuit = fixture.open()
    fixture.queueLatePayloadAt(target)

    circuit.sendDatagram(b4a.from(`${path} queued payload`))
    t.is(fixture.resources().queuedLatePayloads, 1, `${path} adapter retains one callback`)
    t.alike(fixture.atDestinationDatagram, [], `${path} payload is not delivered before destroy`)

    circuit.destroy()
    t.is(fixture.resources().queuedLatePayloads, 0, `${path} pending delivery is cancelled`)
    t.is(
      fixture.resources().cancelledLatePayloads,
      1,
      `${path} adapter cancellation runs exactly once`
    )
    const actorEventsBeforeLateDelivery = fixture.actorEvents.length
    const destinationEventsBeforeLateDelivery = fixture.destinationEvents.length
    let lateError = null
    try {
      fixture.fireRetainedLatePayloads()
    } catch (err) {
      lateError = err
    }
    t.is(lateError, null, `${path} callback retained past destroy is ignored`)
    t.is(
      fixture.actorEvents.length,
      actorEventsBeforeLateDelivery,
      `${path} late callback cannot mutate relay state`
    )
    t.is(
      fixture.destinationEvents.length,
      destinationEventsBeforeLateDelivery,
      `${path} late callback cannot mutate destination state`
    )
    t.alike(fixture.atDestinationDatagram, [], `${path} late callback cannot deliver payload`)
    assertZeroResources(t, fixture)
    fixture.destroyActors()
  }
})

test('queued authenticated transport failures destroy the entire compiled route', (t) => {
  for (const [path, send] of [
    ['Safety forward', (fixture, circuit) => circuit.sendDatagram(b4a.from('forward'))],
    ['destination reverse', (fixture) => fixture.sendDestinationStream(b4a.from('reverse'))]
  ]) {
    const fixture = publicActorRouteFixture()
    const circuit = fixture.open()
    fixture.queueLatePayloadAt(1)

    send(fixture, circuit)
    t.is(fixture.resources().queuedLatePayloads, 1, `${path} delivery is queued`)
    t.exception(() => fixture.fireRetainedLatePayloads(true), `${path} rejects a corrupt cell`)
    assertZeroResources(t, fixture)
    fixture.destroyActors()
  }
})

test('route destroy leaves unrelated virtual-network delivery intact', (t) => {
  const fixture = publicActorRouteFixture()
  const circuit = fixture.open()
  fixture.setAutoFlush(false)
  fixture.queueUnrelated(b4a.from('unrelated'))
  circuit.sendDatagram(b4a.from('route-owned'))
  t.is(fixture.resources().networkPending, 2)

  circuit.destroy()
  t.is(fixture.resources().networkPending, 1)
  t.is(fixture.network.flush(), 1)
  t.alike(fixture.unrelatedDeliveries, [b4a.from('unrelated')])
  t.is(fixture.resources().networkPending, 0)
  t.is(fixture.network.flush(), 0)
  fixture.destroyActors()
})
