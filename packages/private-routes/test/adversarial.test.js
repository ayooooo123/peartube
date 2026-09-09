import test from 'brittle'
import b4a from 'b4a'

import {
  AUTHORIZATION_MODE,
  CAPABILITY,
  CELL_CLASS,
  CELL_SIZE,
  CIRCUIT_STATE,
  CellCodec,
  DIRECTION,
  PROTOCOL_VERSION,
  PrivateRouteError,
  ROLE,
  RelayService,
  RouteManager,
  SenderCounter,
  VirtualNetwork,
  createCircuitAuthority,
  createLinkSetupAuthority,
  createRouteCompilerAuthority,
  createSafetyInstallerAuthority,
  cryptoSuite,
  encodeDescriptor,
  encodeRelayAdvertisement,
  signDescriptor,
  signRelayAdvertisement,
  verifyDescriptor
} from '../index.js'
import { TEST_ONLY_TICKET_OBSERVER } from '../lib/link-setup.js'
import { TEST_ONLY_RELAY_OBSERVER } from '../lib/relay-service.js'
import { assertNoLiveResources, publicActorRouteFixture } from './compiled-route-fixture.js'
import {
  descriptorChecker,
  expectCode,
  privateRoleIdentity,
  safetyRoleIdentity,
  seed
} from './helpers.js'

function sequence(start = 1) {
  let value = start
  return (size) => b4a.alloc(size, value++)
}

function link(authority, common, initiator, responder, responderStatic) {
  const started = authority.initiate({
    ...common,
    initiatorIdentity: initiator.publicKey,
    responderIdentity: responder.publicKey,
    responderStaticKey: responderStatic.publicKey,
    initiatorIdentitySecretKey: initiator.secretKey
  })
  const accepted = authority.respond(started.message, {
    ...common,
    initiatorIdentity: initiator.publicKey,
    responderIdentity: responder.publicKey,
    responderStaticSecretKey: responderStatic.secretKey,
    responderIdentitySecretKey: responder.secretKey
  })
  return {
    initiatorTicket: authority.complete(started.pending, accepted.message),
    responderTicket: accepted.ticket
  }
}

function relayFixture({ fault } = {}) {
  let now = 1_000
  const source = cryptoSuite.keyPair(seed(11))
  const relayIdentity = cryptoSuite.keyPair(seed(12))
  const destination = cryptoSuite.keyPair(seed(13))
  const relayStatic = cryptoSuite.encryptionKeyPair(seed(14))
  const destinationStatic = cryptoSuite.encryptionKeyPair(seed(15))
  const states = new Map()
  const zeroizations = []
  const authority = createLinkSetupAuthority({
    crypto: cryptoSuite,
    now: () => now,
    randomBytes: sequence(20),
    [TEST_ONLY_TICKET_OBSERVER](ticket, state) {
      states.set(ticket, state)
    }
  })
  const common = { circuitId: b4a.alloc(16, 0x31), epoch: 7n, expiresAt: 10_000n }
  const previousIds = {
    initiatorLocalId: b4a.alloc(16, 0x32),
    responderLocalId: b4a.alloc(16, 0x33)
  }
  const nextIds = {
    initiatorLocalId: b4a.alloc(16, 0x34),
    responderLocalId: b4a.alloc(16, 0x35)
  }
  const previous = link(
    authority,
    { ...common, ...previousIds },
    source,
    relayIdentity,
    relayStatic
  )
  const next = link(
    authority,
    { ...common, ...nextIds },
    relayIdentity,
    destination,
    destinationStatic
  )
  const sourceState = states.get(previous.initiatorTicket)
  const relayPreviousState = states.get(previous.responderTicket)
  const destinationState = states.get(next.responderTicket)
  const relayNextState = states.get(next.initiatorTicket)
  const network = new VirtualNetwork({ now, fault })
  let relay = null
  network.register('source', () => {})
  network.register('relay', (packet) => {
    const localId = packet.subarray(12, 28)
    relay.receive(
      b4a.equals(localId, previousIds.responderLocalId) ? source.publicKey : destination.publicKey,
      packet
    )
  })
  network.register('destination', () => {})
  const relaySends = []
  relay = new RelayService({
    identity: relayIdentity.publicKey,
    ticketChecker: authority.checker,
    crypto: cryptoSuite,
    now: () => now,
    padding: (size) => b4a.alloc(size),
    send(peer, packet) {
      relaySends.push({ peer: b4a.from(peer), packet: b4a.from(packet) })
      return true
    },
    [TEST_ONLY_RELAY_OBSERVER](event) {
      if (event.type === 'zeroized') zeroizations.push(event)
    }
  })
  relay.install(previous.responderTicket, next.initiatorTicket)

  function sealFromSource(cellClass, payload, initial = 0n) {
    const context = sourceState.contexts[cellClass].tx
    return new CellCodec({
      crypto: cryptoSuite,
      cellSize: CELL_SIZE,
      padding: (size) => b4a.alloc(size)
    }).seal({
      key: context.key,
      noncePrefix: context.noncePrefix,
      senderCounter: new SenderCounter({ initial }),
      class: cellClass,
      direction: DIRECTION.FORWARD,
      epoch: common.epoch,
      circuitId: sourceState.peerLocalId,
      payload
    })
  }

  function sealFromDestination(cellClass, payload, initial = 0n, overrides = {}) {
    const context = destinationState.contexts[cellClass].tx
    return new CellCodec({
      crypto: cryptoSuite,
      cellSize: CELL_SIZE,
      padding: (size) => b4a.alloc(size)
    }).seal({
      key: context.key,
      noncePrefix: context.noncePrefix,
      senderCounter: new SenderCounter({ initial }),
      class: cellClass,
      direction: DIRECTION.REVERSE,
      epoch: common.epoch,
      circuitId: destinationState.peerLocalId,
      payload,
      ...overrides
    })
  }

  function ownedSecretBytes() {
    let total = 0
    const contexts = zeroizations.length
      ? zeroizations.at(-1).contexts
      : [relayPreviousState, relayNextState].flatMap((state) =>
          Object.values(state.contexts).flatMap((pair) => [pair.tx, pair.rx])
        )
    for (const context of contexts) {
      for (const byte of context.key) if (byte !== 0) total++
      for (const byte of context.noncePrefix) if (byte !== 0) total++
    }
    return total
  }

  return {
    destination,
    network,
    nextIds,
    previousIds,
    relay,
    relayNextState,
    relayPreviousState,
    relaySends,
    source,
    ownedSecretBytes,
    sealFromDestination,
    sealFromSource,
    setNow(value) {
      now = value
      network.advance(value - network.now)
    }
  }
}

function routeFrame(byte = 0x61) {
  return b4a.alloc(1100, byte)
}

function openCircuit(fixture) {
  fixture.relay.created(fixture.source.publicKey, fixture.previousIds.responderLocalId)
  fixture.relay.open(fixture.source.publicKey, fixture.previousIds.responderLocalId)
  return fixture
}

function stableResourceSnapshot(fixture) {
  const secrets = []
  for (const state of [fixture.relayPreviousState, fixture.relayNextState]) {
    for (const pair of Object.values(state.contexts)) {
      for (const context of [pair.tx, pair.rx]) {
        secrets.push(context.key, context.noncePrefix)
      }
    }
  }
  return {
    activeCircuits: fixture.relay.activeCircuits,
    queuedBytes: fixture.relay.queuedBytes,
    ownedSecretDigest: b4a.toString(cryptoSuite.hash(secrets), 'hex'),
    networkEdges: fixture.network.edges().map((edge) => [...edge]),
    sourceState: fixture.relay.state(
      fixture.source.publicKey,
      fixture.previousIds.responderLocalId
    ),
    destinationState: fixture.relay.state(
      fixture.destination.publicKey,
      fixture.nextIds.initiatorLocalId
    ),
    sourceReceivers: receiverSnapshot(fixture.relayPreviousState),
    destinationReceivers: receiverSnapshot(fixture.relayNextState)
  }
}

function receiverSnapshot(state) {
  return [CELL_CLASS.CONTROL, CELL_CLASS.STREAM, CELL_CLASS.DATAGRAM].map((cellClass) => {
    const counter = state.contexts[cellClass].rx.counter
    return cellClass === CELL_CLASS.DATAGRAM
      ? {
          cellClass,
          highest: counter.highest,
          floor: counter.floor,
          buffered: counter.buffered,
          closed: counter.closed
        }
      : {
          cellClass,
          next: counter.next,
          buffered: counter.buffered,
          closed: counter.closed
        }
  })
}

function assertRejectedBeforeCounter(t, fixture, side, packet, label) {
  const state = side === 'source' ? fixture.relayPreviousState : fixture.relayNextState
  const before = receiverSnapshot(state)
  const cellClass = packet[1]
  if ([CELL_CLASS.CONTROL, CELL_CLASS.STREAM, CELL_CLASS.DATAGRAM].includes(cellClass)) {
    const context = state.contexts[cellClass].rx
    const codec = new CellCodec({
      crypto: cryptoSuite,
      cellSize: CELL_SIZE,
      padding: (size) => b4a.alloc(size)
    })
    expectCode(
      t,
      () =>
        codec.open(
          {
            key: context.key,
            noncePrefix: context.noncePrefix,
            receiver: context.counter,
            expectedClass: cellClass,
            expectedDirection: side === 'source' ? DIRECTION.FORWARD : DIRECTION.REVERSE,
            expectedEpoch: state.epoch,
            expectedCircuitId: state.localId
          },
          packet
        ),
      'CELL_INVALID'
    )
  }
  t.alike(receiverSnapshot(state), before, `${label} leaves every receiver counter unchanged`)
}

function verifiedDescriptor() {
  const endpoint = cryptoSuite.keyPair(seed(40))
  const entry = privateRoleIdentity(1)
  const entryEncryption = cryptoSuite.encryptionKeyPair(seed(41))
  const entryAdvertisement = signRelayAdvertisement(
    {
      version: PROTOCOL_VERSION,
      identityKey: entry.publicKey,
      routeEncryptionKey: entryEncryption.publicKey,
      dial: b4a.from('adversarial-entry'),
      role: ROLE.PRIVATE,
      capabilities: CAPABILITY.KNOWN,
      epoch: 7n,
      expiresAt: 10_000n
    },
    entry.secretKey
  )
  const signed = signDescriptor(
    {
      version: PROTOCOL_VERSION,
      authorizationMode: AUTHORIZATION_MODE.DIRECT,
      descriptorId: seed(42),
      endpointKey: endpoint.publicKey,
      routeSigningKey: endpoint.publicKey,
      routeEncryptionKey: cryptoSuite.encryptionKeyPair(seed(43)).publicKey,
      entryAdvertisement: encodeRelayAdvertisement(entryAdvertisement),
      epoch: 7n,
      expiresAt: 9_000n,
      capabilities: CAPABILITY.KNOWN,
      cellSize: CELL_SIZE,
      encryptedHops: b4a.from('opaque')
    },
    endpoint.secretKey
  )
  return verifyDescriptor(encodeDescriptor(signed), {
    requestedEndpointKey: endpoint.publicKey,
    now: 1_000n
  })
}

function setupManager(compile) {
  let activeSafetyRoutes = 0
  let safetyRollbacks = 0
  const safetyIdentity = safetyRoleIdentity(1)
  const safetyAdvertisement = signRelayAdvertisement(
    {
      version: PROTOCOL_VERSION,
      identityKey: safetyIdentity.publicKey,
      routeEncryptionKey: cryptoSuite.encryptionKeyPair(seed(50)).publicKey,
      dial: b4a.from('adversarial-guard'),
      role: ROLE.SAFETY,
      capabilities: CAPABILITY.KNOWN,
      epoch: 7n,
      expiresAt: 10_000n
    },
    safetyIdentity.secretKey
  )
  const circuitAuthority = createCircuitAuthority()
  const safetyAuthority = createSafetyInstallerAuthority()
  const safetyInstaller = safetyAuthority.issuer.issue({
    authenticate() {},
    install() {},
    rollback() {
      safetyRollbacks++
    },
    finalize() {
      activeSafetyRoutes++
      let live = true
      return {
        transcriptHash32: seed(51),
        attachEntry() {
          return Object.freeze({})
        },
        sendControl() {
          return true
        },
        sendFrame() {
          return true
        },
        sendReverseFrame() {
          return true
        },
        destroy() {
          if (!live) return
          live = false
          activeSafetyRoutes--
        }
      }
    }
  })
  const compilerAuthority = createRouteCompilerAuthority()
  const routeCompiler = compilerAuthority.issuer.issue(compile)
  const manager = new RouteManager({
    network: new VirtualNetwork({ now: 1_000 }),
    registry: { allows: () => true },
    crypto: cryptoSuite,
    clock: () => 1_000,
    descriptorChecker: descriptorChecker(),
    circuitIssuer: circuitAuthority.issuer,
    safetyInstaller,
    safetyInstallerChecker: safetyAuthority.checker,
    safetyRouteChecker: safetyAuthority.routeChecker,
    routeCompiler,
    routeCompilerChecker: compilerAuthority.checker,
    limits: { maxSafetyHops: 3 }
  })
  return {
    activeSafetyRoutes: () => activeSafetyRoutes,
    manager,
    descriptor: verifiedDescriptor(),
    safety: [encodeRelayAdvertisement(safetyAdvertisement)],
    safetyRollbacks: () => safetyRollbacks
  }
}

function assertDestroyed(t, fixture) {
  t.is(fixture.relay.activeCircuits, 0)
  t.is(fixture.relay.queuedBytes, 0)
  t.is(fixture.ownedSecretBytes(), 0)
  t.is(fixture.network.flush(), 0)
  t.is(
    fixture.network.edges().some(([from, to]) => from === 'source' && to === 'destination'),
    false
  )
  expectCode(
    t,
    () => fixture.relay.state(fixture.source.publicKey, fixture.previousIds.responderLocalId),
    'CIRCUIT_STATE'
  )
}

test('adversarial dropped CREATE fails ROUTE_UNAVAILABLE and destroys half-open state', (t) => {
  const fixture = publicActorRouteFixture({ setupFault: 'drop-create' })

  expectCode(t, () => fixture.open(), 'ROUTE_UNAVAILABLE')
  t.alike(fixture.setupFaultEvents, [
    {
      stage: 'create',
      from: fixture.nodes.safetyNode,
      to: fixture.nodes.privateNodes[0],
      byteLength: CELL_SIZE,
      synchronous: false,
      consumedAt: 1_000,
      cancelled: 1,
      deliveredAt: null
    }
  ])
  assertNoLiveResources(t, fixture)
  fixture.destroyActors()
})

test('adversarial authenticated compiler rejection preserves UNAUTHORIZED', (t) => {
  const route = setupManager(() => {
    throw PrivateRouteError.UNAUTHORIZED()
  })

  expectCode(
    t,
    () => route.manager.open({ safety: route.safety, descriptor: route.descriptor }),
    'UNAUTHORIZED'
  )
  t.is(route.manager.directFallback, undefined)
  t.is(route.activeSafetyRoutes(), 0)
  t.is(route.safetyRollbacks(), 1)
})

test('adversarial late CREATED after 5000ms is rejected without reinstall', (t) => {
  const fixture = publicActorRouteFixture({ setupFault: 'late-created' })

  expectCode(t, () => fixture.open(), 'ROUTE_UNAVAILABLE')
  t.alike(fixture.setupFaultEvents, [
    {
      stage: 'created',
      from: fixture.nodes.destinationNode,
      to: fixture.nodes.privateNodes.at(-1),
      byteLength: CELL_SIZE,
      synchronous: false,
      consumedAt: 1_000,
      cancelled: 0,
      deliveredAt: 6_001
    }
  ])
  assertNoLiveResources(t, fixture)
  fixture.destroyActors()
})

test('adversarial duplicate authenticated packet is REPLAY and destroys its circuit', (t) => {
  const fixture = openCircuit(relayFixture())
  const packet = fixture.sealFromSource(CELL_CLASS.DATAGRAM, routeFrame(0x62))

  fixture.relay.receive(fixture.source.publicKey, packet)
  t.is(fixture.relay.activeCircuits, 1)
  expectCode(t, () => fixture.relay.receive(fixture.source.publicKey, packet), 'REPLAY')
  assertDestroyed(t, fixture)
})

test('adversarial datagrams reordered inside the replay window deliver once and stay OPEN', (t) => {
  const fixture = openCircuit(relayFixture())
  const later = fixture.sealFromDestination(CELL_CLASS.DATAGRAM, routeFrame(0x63), 1n)
  const first = fixture.sealFromDestination(CELL_CLASS.DATAGRAM, routeFrame(0x64), 0n)

  fixture.relay.receive(fixture.destination.publicKey, later)
  fixture.relay.receive(fixture.destination.publicKey, first)

  t.is(fixture.relaySends.length, 2)
  t.is(fixture.relay.activeCircuits, 1)
  t.is(
    fixture.relay.state(fixture.source.publicKey, fixture.previousIds.responderLocalId),
    CIRCUIT_STATE.OPEN
  )
  t.is(
    fixture.relay.state(fixture.destination.publicKey, fixture.nextIds.initiatorLocalId),
    CIRCUIT_STATE.OPEN
  )
  t.is(fixture.relay.queuedBytes, 0)
  t.is(fixture.network.flush(), 0)
  fixture.relay.destroy(fixture.source.publicKey, fixture.previousIds.responderLocalId)
  assertDestroyed(t, fixture)
})

test('adversarial datagram below the inclusive floor is REPLAY and cleaned', (t) => {
  const fixture = openCircuit(relayFixture())
  const advancesFloor = fixture.sealFromSource(CELL_CLASS.DATAGRAM, routeFrame(0x65), 1024n)
  const belowFloor = fixture.sealFromSource(CELL_CLASS.DATAGRAM, routeFrame(0x66), 0n)

  fixture.relay.receive(fixture.source.publicKey, advancesFloor)
  expectCode(t, () => fixture.relay.receive(fixture.source.publicKey, belowFloor), 'REPLAY')
  assertDestroyed(t, fixture)
})

test('adversarial known-binding header mutations are CELL_INVALID before counter advance', (t) => {
  const mutations = [
    ['version', 0],
    ['class', 1],
    ['direction', 2],
    ['flags', 3],
    ['epoch', 11],
    ['counter', 35]
  ]

  for (const [name, offset] of mutations) {
    const fixture = openCircuit(relayFixture())
    const valid = fixture.sealFromSource(CELL_CLASS.DATAGRAM, routeFrame(0x67))
    const forged = b4a.from(valid)
    forged[offset] ^= 1

    assertRejectedBeforeCounter(t, fixture, 'source', forged, name)

    expectCode(t, () => fixture.relay.receive(fixture.source.publicKey, forged), 'CELL_INVALID')
    t.comment(`${name} mutation selected and destroyed only its known binding`)
    assertDestroyed(t, fixture)
  }
})

test('adversarial unknown circuit-ID byte mutations are stateless', (t) => {
  const fixture = openCircuit(relayFixture())
  const valid = fixture.sealFromSource(CELL_CLASS.DATAGRAM, routeFrame(0x68))
  const before = stableResourceSnapshot(fixture)

  for (let index = 12; index < 28; index++) {
    const forged = b4a.from(valid)
    forged[index] ^= 1
    expectCode(t, () => fixture.relay.receive(fixture.source.publicKey, forged), 'CELL_INVALID')
    t.alike(stableResourceSnapshot(fixture), before, `circuit-ID byte ${index - 12}`)
    t.is(fixture.network.flush(), 0, `circuit-ID byte ${index - 12} queues no delivery`)
  }

  fixture.relay.receive(fixture.source.publicKey, valid)
  t.is(
    fixture.relay.state(fixture.source.publicKey, fixture.previousIds.responderLocalId),
    CIRCUIT_STATE.OPEN,
    'the original counter zero remains acceptable after all unknown-ID faults'
  )
  fixture.relay.destroy(fixture.source.publicKey, fixture.previousIds.responderLocalId)
  assertDestroyed(t, fixture)
})

test('adversarial ciphertext first middle and final mutations are CELL_INVALID and cleaned', (t) => {
  for (const [name, offset] of [
    ['first', 36],
    ['middle', 618],
    ['final', CELL_SIZE - 1]
  ]) {
    const fixture = openCircuit(relayFixture())
    const valid = fixture.sealFromSource(CELL_CLASS.DATAGRAM, routeFrame(0x69))
    const forged = b4a.from(valid)
    forged[offset] ^= 1

    assertRejectedBeforeCounter(t, fixture, 'source', forged, name)

    expectCode(t, () => fixture.relay.receive(fixture.source.publicKey, forged), 'CELL_INVALID')
    t.comment(`${name} ciphertext mutation is fail-closed`)
    assertDestroyed(t, fixture)
  }
})

test('adversarial forward packet on the reverse binding is CELL_INVALID and cleaned', (t) => {
  const fixture = openCircuit(relayFixture())
  const wrongBinding = fixture.sealFromDestination(CELL_CLASS.DATAGRAM, routeFrame(0x6a), 0n, {
    direction: DIRECTION.FORWARD
  })

  assertRejectedBeforeCounter(t, fixture, 'destination', wrongBinding, 'wrong direction')

  expectCode(
    t,
    () => fixture.relay.receive(fixture.destination.publicKey, wrongBinding),
    'CELL_INVALID'
  )
  assertDestroyed(t, fixture)
})

test('adversarial suppressed entry proof fails closed with no half-open state', (t) => {
  const fixture = publicActorRouteFixture({ setupFault: 'suppress-entry-proof' })

  expectCode(t, () => fixture.open(), 'ROUTE_UNAVAILABLE')
  t.alike(fixture.setupFaultEvents, [
    {
      stage: 'entry-proof',
      from: fixture.nodes.privateNodes[0],
      to: fixture.nodes.privateNodes[1],
      byteLength: CELL_SIZE,
      synchronous: true,
      consumedAt: 1_000,
      cancelled: 1,
      deliveredAt: null
    }
  ])
  assertNoLiveResources(t, fixture)
  fixture.destroyActors()
})

test('adversarial suppressed destination proof times out ROUTE_UNAVAILABLE with no half-open state', (t) => {
  const fixture = publicActorRouteFixture({ setupFault: 'suppress-destination-proof' })

  expectCode(t, () => fixture.open(), 'ROUTE_UNAVAILABLE')
  t.alike(fixture.setupFaultEvents, [
    {
      stage: 'destination-proof',
      from: fixture.nodes.destinationNode,
      to: fixture.nodes.privateNodes.at(-1),
      byteLength: CELL_SIZE,
      synchronous: false,
      consumedAt: 1_000,
      cancelled: 1,
      deliveredAt: null
    }
  ])
  assertNoLiveResources(t, fixture)
  fixture.destroyActors()
})
