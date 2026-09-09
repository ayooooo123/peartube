import test from 'brittle'
import b4a from 'b4a'

import {
  ActivationReassembler,
  CELL_CLASS,
  CELL_SIZE,
  CIRCUIT_STATE,
  CellCodec,
  DEFAULT_MAX_CIRCUITS,
  DEFAULT_MAX_CIRCUITS_PER_SOURCE,
  DIRECTION,
  RelayService,
  SenderCounter,
  createLinkSetupAuthority,
  cryptoSuite,
  fragment
} from '../index.js'
import { RELAY_DESTROY_PAYLOAD, TEST_ONLY_RELAY_OBSERVER } from '../lib/relay-service.js'
import { TEST_ONLY_TICKET_OBSERVER } from '../lib/link-setup.js'
import { expectCode, seed } from './helpers.js'

function sequence(start = 20) {
  let value = start
  return (size) => b4a.alloc(size, value++)
}

function zeroPadding(size) {
  return b4a.alloc(size)
}

function shadowedBuffer(value, properties) {
  const copy = value.subarray(0)
  for (const [name, property] of Object.entries(properties)) {
    Object.defineProperty(copy, name, { value: property })
  }
  return copy
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

function relayFixture(overrides = {}) {
  let now = overrides.initialNow === undefined ? 1_000 : overrides.initialNow
  const previous = cryptoSuite.keyPair(seed(31))
  const relayIdentity = overrides.relayIdentity || cryptoSuite.keyPair(seed(32))
  const next = overrides.samePeer ? previous : cryptoSuite.keyPair(seed(33))
  const relayStatic = cryptoSuite.encryptionKeyPair(seed(34))
  const nextStatic = cryptoSuite.encryptionKeyPair(seed(35))
  const ticketStates = new Map()
  const relayEvents = []
  const authority = createLinkSetupAuthority({
    crypto: cryptoSuite,
    now: () => now,
    randomBytes: sequence(),
    [TEST_ONLY_TICKET_OBSERVER](ticket, state) {
      ticketStates.set(ticket, state)
    }
  })
  const base = {
    circuitId: b4a.alloc(16, 0x41),
    epoch: 9n,
    expiresAt: overrides.expiresAt === undefined ? 10_000n : overrides.expiresAt
  }
  const previousIds = {
    initiatorLocalId: b4a.alloc(16, 0x42),
    responderLocalId: b4a.alloc(16, 0x43)
  }
  const nextIds = {
    initiatorLocalId: b4a.alloc(16, overrides.duplicateLocalIds ? 0x43 : 0x44),
    responderLocalId: b4a.alloc(16, 0x45)
  }
  const previousLink = link(
    authority,
    { ...base, ...previousIds },
    previous,
    relayIdentity,
    relayStatic
  )
  const nextLink = link(authority, { ...base, ...nextIds }, relayIdentity, next, nextStatic)
  const previousPeer = ticketStates.get(previousLink.initiatorTicket)
  const nextPeer = ticketStates.get(nextLink.responderTicket)
  const sent = []
  let relay = null
  const send = overrides.send || ((peer, packet) => sent.push({ peer: b4a.from(peer), packet }))

  relay = new RelayService({
    identity: relayIdentity.publicKey,
    ticketChecker: authority.checker,
    crypto: cryptoSuite,
    now: () => now,
    padding: zeroPadding,
    send,
    [TEST_ONLY_RELAY_OBSERVER](event) {
      relayEvents.push(event)
    },
    ...overrides
  })
  relay.install(previousLink.responderTicket, nextLink.initiatorTicket)

  function sealInbound(side, cellClass, payload, cellOverrides = {}) {
    const peer = side === 'previous' ? previousPeer : nextPeer
    const direction = side === 'previous' ? DIRECTION.FORWARD : DIRECTION.REVERSE
    return new CellCodec({ crypto: cryptoSuite, cellSize: CELL_SIZE, padding: zeroPadding }).seal({
      key: peer.contexts[cellClass].tx.key,
      noncePrefix: peer.contexts[cellClass].tx.noncePrefix,
      senderCounter: peer.contexts[cellClass].tx.counter,
      class: cellClass,
      direction,
      epoch: base.epoch,
      circuitId: peer.peerLocalId,
      payload,
      ...cellOverrides
    })
  }

  function openSent(side, cellClass, packet) {
    const peer = side === 'previous' ? previousPeer : nextPeer
    const direction = side === 'previous' ? DIRECTION.REVERSE : DIRECTION.FORWARD
    const opened = new CellCodec({
      crypto: cryptoSuite,
      cellSize: CELL_SIZE,
      padding: zeroPadding
    }).open(
      {
        key: peer.contexts[cellClass].rx.key,
        noncePrefix: peer.contexts[cellClass].rx.noncePrefix,
        receiver: peer.contexts[cellClass].rx.counter,
        expectedClass: cellClass,
        expectedDirection: direction,
        expectedEpoch: base.epoch,
        expectedCircuitId: peer.localId
      },
      packet
    )
    return Array.isArray(opened) ? opened[0] : opened
  }

  return {
    relay,
    sent,
    relayEvents,
    previous,
    next,
    previousIds,
    nextIds,
    setNow(value) {
      now = value
    },
    sealInbound,
    openSent
  }
}

function relayHarness(overrides = {}) {
  let now = 1_000
  const relayIdentity = cryptoSuite.keyPair(seed(101))
  const relayStatic = cryptoSuite.encryptionKeyPair(seed(102))
  const ticketStates = new Map()
  const authority = createLinkSetupAuthority({
    crypto: cryptoSuite,
    now: () => now,
    randomBytes: sequence(110),
    [TEST_ONLY_TICKET_OBSERVER](ticket, state) {
      ticketStates.set(ticket, state)
    }
  })
  const sent = []
  const send = overrides.send || ((peer, packet) => sent.push({ peer: b4a.from(peer), packet }))
  const relay = new RelayService({
    identity: relayIdentity.publicKey,
    ticketChecker: authority.checker,
    crypto: cryptoSuite,
    now: () => now,
    padding: zeroPadding,
    send,
    ...overrides
  })

  function tickets({
    source,
    next,
    circuitByte,
    sourceLocalByte,
    relayPreviousByte,
    relayNextByte,
    nextLocalByte,
    epoch = 1n,
    expiresAt = 20_000n
  }) {
    const nextStatic = cryptoSuite.encryptionKeyPair(seed(next.seedByte + 50))
    const common = {
      circuitId: b4a.alloc(16, circuitByte),
      epoch,
      expiresAt
    }
    const previousLink = link(
      authority,
      {
        ...common,
        initiatorLocalId: b4a.alloc(16, sourceLocalByte),
        responderLocalId: b4a.alloc(16, relayPreviousByte)
      },
      source.identity,
      relayIdentity,
      relayStatic
    )
    const nextLink = link(
      authority,
      {
        ...common,
        initiatorLocalId: b4a.alloc(16, relayNextByte),
        responderLocalId: b4a.alloc(16, nextLocalByte)
      },
      relayIdentity,
      next.identity,
      nextStatic
    )
    return {
      source,
      next,
      common,
      previousLocalId: b4a.alloc(16, relayPreviousByte),
      nextLocalId: b4a.alloc(16, relayNextByte),
      previousTicket: previousLink.responderTicket,
      nextTicket: nextLink.initiatorTicket,
      previousPeer: ticketStates.get(previousLink.initiatorTicket),
      nextPeer: ticketStates.get(nextLink.responderTicket)
    }
  }

  function install(options) {
    const value = tickets(options)
    relay.install(value.previousTicket, value.nextTicket)
    return value
  }

  function sealPrevious(circuit, cellClass, payload, senderCounter) {
    const context = circuit.previousPeer.contexts[cellClass].tx
    return new CellCodec({ crypto: cryptoSuite, cellSize: CELL_SIZE, padding: zeroPadding }).seal({
      key: context.key,
      noncePrefix: context.noncePrefix,
      senderCounter: senderCounter || context.counter,
      class: cellClass,
      direction: DIRECTION.FORWARD,
      epoch: circuit.common.epoch,
      circuitId: circuit.previousPeer.peerLocalId,
      payload
    })
  }

  return {
    relay,
    relayIdentity,
    sent,
    authority,
    ticketStates,
    tickets,
    install,
    sealPrevious,
    setNow(value) {
      now = value
    }
  }
}

function peer(seedByte) {
  return { identity: cryptoSuite.keyPair(seed(seedByte)), seedByte }
}

function twoRelayChain() {
  let now = 1_000
  const source = cryptoSuite.keyPair(seed(181))
  const relayAIdentity = cryptoSuite.keyPair(seed(182))
  const relayBIdentity = cryptoSuite.keyPair(seed(183))
  const destination = cryptoSuite.keyPair(seed(184))
  const relayAStatic = cryptoSuite.encryptionKeyPair(seed(185))
  const relayBStatic = cryptoSuite.encryptionKeyPair(seed(186))
  const destinationStatic = cryptoSuite.encryptionKeyPair(seed(187))
  const ticketStates = new Map()
  const authority = createLinkSetupAuthority({
    crypto: cryptoSuite,
    now: () => now,
    randomBytes: sequence(190),
    [TEST_ONLY_TICKET_OBSERVER](ticket, state) {
      ticketStates.set(ticket, state)
    }
  })
  const common = {
    circuitId: b4a.alloc(16, 0xd0),
    epoch: 12n,
    expiresAt: 20_000n
  }
  const sourceLink = link(
    authority,
    {
      ...common,
      initiatorLocalId: b4a.alloc(16, 1),
      responderLocalId: b4a.alloc(16, 2)
    },
    source,
    relayAIdentity,
    relayAStatic
  )
  const middleLink = link(
    authority,
    {
      ...common,
      initiatorLocalId: b4a.alloc(16, 3),
      responderLocalId: b4a.alloc(16, 4)
    },
    relayAIdentity,
    relayBIdentity,
    relayBStatic
  )
  const destinationLink = link(
    authority,
    {
      ...common,
      initiatorLocalId: b4a.alloc(16, 5),
      responderLocalId: b4a.alloc(16, 6)
    },
    relayBIdentity,
    destination,
    destinationStatic
  )
  const toSource = []
  const toDestination = []
  const relayATrace = []
  const relayBTrace = []
  let relayA = null
  let relayB = null

  relayA = new RelayService({
    identity: relayAIdentity.publicKey,
    ticketChecker: authority.checker,
    crypto: cryptoSuite,
    now: () => now,
    padding: zeroPadding,
    [TEST_ONLY_RELAY_OBSERVER](event) {
      relayATrace.push(event)
    },
    send(peerIdentity, packet) {
      if (b4a.equals(peerIdentity, relayBIdentity.publicKey)) {
        relayB.receive(relayAIdentity.publicKey, packet)
      } else if (b4a.equals(peerIdentity, source.publicKey)) {
        toSource.push(b4a.from(packet))
      } else {
        throw new Error('unexpected relay A peer')
      }
    }
  })
  relayB = new RelayService({
    identity: relayBIdentity.publicKey,
    ticketChecker: authority.checker,
    crypto: cryptoSuite,
    now: () => now,
    padding: zeroPadding,
    [TEST_ONLY_RELAY_OBSERVER](event) {
      relayBTrace.push(event)
    },
    send(peerIdentity, packet) {
      if (b4a.equals(peerIdentity, relayAIdentity.publicKey)) {
        relayA.receive(relayBIdentity.publicKey, packet)
      } else if (b4a.equals(peerIdentity, destination.publicKey)) {
        toDestination.push(b4a.from(packet))
      } else {
        throw new Error('unexpected relay B peer')
      }
    }
  })
  relayA.install(sourceLink.responderTicket, middleLink.initiatorTicket)
  relayB.install(middleLink.responderTicket, destinationLink.initiatorTicket)

  const sourceState = ticketStates.get(sourceLink.initiatorTicket)
  const destinationState = ticketStates.get(destinationLink.responderTicket)
  const codec = new CellCodec({ crypto: cryptoSuite, cellSize: CELL_SIZE, padding: zeroPadding })

  function sealEndpoint(state, direction, payload) {
    const context = state.contexts[CELL_CLASS.CONTROL].tx
    return codec.seal({
      key: context.key,
      noncePrefix: context.noncePrefix,
      senderCounter: context.counter,
      class: CELL_CLASS.CONTROL,
      direction,
      epoch: common.epoch,
      circuitId: state.peerLocalId,
      payload
    })
  }

  function openEndpoint(state, direction, packet) {
    const context = state.contexts[CELL_CLASS.CONTROL].rx
    return codec.open(
      {
        key: context.key,
        noncePrefix: context.noncePrefix,
        receiver: context.counter,
        expectedClass: CELL_CLASS.CONTROL,
        expectedDirection: direction,
        expectedEpoch: common.epoch,
        expectedCircuitId: state.localId
      },
      packet
    )
  }

  return {
    source,
    destination,
    relayA,
    relayB,
    sourceState,
    destinationState,
    toSource,
    toDestination,
    relayATrace,
    relayBTrace,
    sealEndpoint,
    openEndpoint
  }
}

function routeFrame(value) {
  return b4a.alloc(1100, value)
}

function openCircuit(f) {
  f.relay.created(f.previous.publicKey, f.previousIds.responderLocalId)
  f.relay.open(f.previous.publicKey, f.previousIds.responderLocalId)
}

test('relay forwards raw fixed cells through one route-local binding in both directions', (t) => {
  const f = relayFixture()
  openCircuit(f)

  f.relay.receive(f.previous.publicKey, f.sealInbound('previous', CELL_CLASS.STREAM, routeFrame(1)))
  f.relay.receive(f.next.publicKey, f.sealInbound('next', CELL_CLASS.DATAGRAM, routeFrame(2)))

  t.alike(
    f.sent.map(({ peer }) => peer),
    [f.next.publicKey, f.previous.publicKey]
  )
  t.ok(f.sent.every(({ packet }) => packet.byteLength === 1200))
  t.alike(f.openSent('next', CELL_CLASS.STREAM, f.sent[0].packet), routeFrame(1))
  t.alike(f.openSent('previous', CELL_CLASS.DATAGRAM, f.sent[1].packet), routeFrame(2))
})

test('CONTROL callback can forward one bounded replacement batch without exposing link state', (t) => {
  const payloads = [b4a.from('nested-1'), b4a.from('nested-2')]
  let fields = null
  const f = relayFixture({
    onControl(event) {
      fields = Object.keys(event).sort()
      event.forward(payloads)
      return false
    }
  })
  f.relay.receive(
    f.previous.publicKey,
    f.sealInbound('previous', CELL_CLASS.CONTROL, b4a.from('outer'))
  )
  t.alike(fields, ['byteLength', 'direction', 'forward', 'payload', 'reply'])
  t.is(f.sent.length, 2)
  t.alike(
    f.sent.map(({ peer }) => peer),
    [f.next.publicKey, f.next.publicKey]
  )
  t.alike(
    f.sent.map(({ packet }) => f.openSent('next', CELL_CLASS.CONTROL, packet)),
    payloads
  )
})

test('CONTROL callback can reply with a bounded reverse batch', (t) => {
  const payloads = [b4a.from('ack-1'), b4a.from('ack-2')]
  const f = relayFixture({
    onControl(event) {
      event.reply(payloads)
    }
  })
  f.relay.receive(
    f.previous.publicKey,
    f.sealInbound('previous', CELL_CLASS.CONTROL, b4a.from('register'))
  )
  t.is(f.sent.length, 2)
  t.alike(
    f.sent.map(({ peer }) => peer),
    [f.previous.publicKey, f.previous.publicKey]
  )
  t.alike(
    f.sent.map(({ packet }) => f.openSent('previous', CELL_CLASS.CONTROL, packet)),
    payloads
  )
})

test('CONTROL callback capabilities are one-shot, mutually exclusive, bounded, and revoked', (t) => {
  let escaped = null
  const revoked = relayFixture({
    onControl(event) {
      escaped = event.forward
      return true
    }
  })
  revoked.relay.receive(
    revoked.previous.publicKey,
    revoked.sealInbound('previous', CELL_CLASS.CONTROL, b4a.from('x'))
  )
  expectCode(t, () => escaped(b4a.from('late')), 'CIRCUIT_STATE')
  t.is(revoked.relay.activeCircuits, 0)

  const double = relayFixture({
    onControl(event) {
      event.forward(b4a.from('one'))
      event.reply(b4a.from('two'))
    }
  })
  expectCode(
    t,
    () =>
      double.relay.receive(
        double.previous.publicKey,
        double.sealInbound('previous', CELL_CLASS.CONTROL, b4a.from('x'))
      ),
    'CELL_INVALID'
  )
  t.is(double.relay.activeCircuits, 0)
  t.is(double.sent.length, 2)
  t.alike(
    double.sent.map(({ peer }) => peer),
    [double.previous.publicKey, double.next.publicKey]
  )

  const throwing = relayFixture({
    onControl(event) {
      event.forward(b4a.from('staged'))
      throw new Error('later failure')
    }
  })
  expectCode(
    t,
    () =>
      throwing.relay.receive(
        throwing.previous.publicKey,
        throwing.sealInbound('previous', CELL_CLASS.CONTROL, b4a.from('x'))
      ),
    'CELL_INVALID'
  )
  t.is(throwing.relay.activeCircuits, 0)
  t.is(throwing.sent.length, 2)
  t.alike(
    throwing.sent.map(({ peer }) => peer),
    [throwing.previous.publicKey, throwing.next.publicKey]
  )

  let selfDestroy = null
  selfDestroy = relayFixture({
    onControl(event) {
      event.forward(b4a.alloc(1146, 0xaa))
      selfDestroy.relay.transportClosed(selfDestroy.previous.publicKey)
      return true
    }
  })
  expectCode(
    t,
    () =>
      selfDestroy.relay.receive(
        selfDestroy.previous.publicKey,
        selfDestroy.sealInbound('previous', CELL_CLASS.CONTROL, b4a.from('x'))
      ),
    'CELL_INVALID'
  )
  t.is(selfDestroy.relay.activeCircuits, 0)
  t.is(selfDestroy.sent.length, 2)
  t.is(selfDestroy.relayEvents.filter((event) => event.type === 'zeroized').length, 1)

  const boundedArray = [b4a.from('bounded-index')]
  boundedArray[Symbol.iterator] = () => {
    throw new Error('must not iterate')
  }
  const bounded = relayFixture({
    onControl(event) {
      event.forward(boundedArray)
    }
  })
  bounded.relay.receive(
    bounded.previous.publicKey,
    bounded.sealInbound('previous', CELL_CLASS.CONTROL, b4a.from('x'))
  )
  t.is(bounded.sent.length, 1)
  t.alike(bounded.openSent('next', CELL_CLASS.CONTROL, bounded.sent[0].packet), boundedArray[0])

  for (const payloads of [[], Array.from({ length: 9 }, () => b4a.alloc(0)), [b4a.alloc(1147)]]) {
    const invalid = relayFixture({
      onControl(event) {
        event.forward(payloads)
      }
    })
    expectCode(
      t,
      () =>
        invalid.relay.receive(
          invalid.previous.publicKey,
          invalid.sealInbound('previous', CELL_CLASS.CONTROL, b4a.from('x'))
        ),
      'CELL_INVALID'
    )
    t.is(invalid.relay.activeCircuits, 0)
    t.is(invalid.sent.length, 2)
  }
})

test('relay constructor intrinsically copies an identity with a shadowed length', (t) => {
  const relayIdentity = cryptoSuite.keyPair(seed(32))
  const identity = shadowedBuffer(relayIdentity.publicKey, { length: 1 })

  const f = relayFixture({ relayIdentity, identity })

  t.is(f.relay.activeCircuits, 1)
})

test('shadowed peer and local-id lengths cannot change canonical binding keys', (t) => {
  const f = relayFixture()
  const peerIdentity = shadowedBuffer(f.previous.publicKey, { length: 1 })
  const localId = shadowedBuffer(f.previousIds.responderLocalId, { length: 1 })

  t.is(f.relay.state(peerIdentity, localId), CIRCUIT_STATE.CREATE)
})

test('relay accepts only raw 1200-byte authenticated packets and fails closed after selection', (t) => {
  const plain = relayFixture()
  for (const packet of [{}, b4a.alloc(0), b4a.alloc(1199), b4a.alloc(1201)]) {
    expectCode(t, () => plain.relay.receive(plain.previous.publicKey, packet), 'CELL_INVALID')
  }
  t.is(plain.relay.activeCircuits, 1)

  const forged = relayFixture()
  const packet = forged.sealInbound('previous', CELL_CLASS.CONTROL, b4a.from('create'))
  packet[100] ^= 1
  expectCode(t, () => forged.relay.receive(forged.previous.publicKey, packet), 'CELL_INVALID')
  t.is(forged.relay.activeCircuits, 0)
  t.is(forged.relay.queuedBytes, 0)
})

test('forged CONTROL cells never invoke activation reassembly', (t) => {
  let calls = 0
  const reassembler = new ActivationReassembler({ now: () => 1_000 })
  const f = relayFixture({
    onControl(event) {
      calls++
      reassembler.pushAuthenticated(event.payload)
      return true
    }
  })
  const packet = f.sealInbound('previous', CELL_CLASS.CONTROL, b4a.alloc(22))
  packet[100] ^= 1

  expectCode(t, () => f.relay.receive(f.previous.publicKey, packet), 'CELL_INVALID')
  t.is(calls, 0)
  t.is(reassembler.bufferedBytes, 0)
})

test('relay enforces half-open state, exact opaque frame size, and independent classes', (t) => {
  const halfOpen = relayFixture()
  expectCode(
    t,
    () =>
      halfOpen.relay.receive(
        halfOpen.previous.publicKey,
        halfOpen.sealInbound('previous', CELL_CLASS.STREAM, routeFrame(1))
      ),
    'CELL_INVALID'
  )
  t.is(halfOpen.relay.activeCircuits, 0)

  const wrongSize = relayFixture()
  openCircuit(wrongSize)
  expectCode(
    t,
    () =>
      wrongSize.relay.receive(
        wrongSize.previous.publicKey,
        wrongSize.sealInbound('previous', CELL_CLASS.DATAGRAM, b4a.alloc(1099))
      ),
    'CELL_INVALID'
  )
  t.is(wrongSize.relay.activeCircuits, 0)
})

test('relay limits circuits and queued bytes and removes all state on overflow', (t) => {
  expectCode(t, () => relayFixture({ maxCircuits: 0 }), 'CIRCUIT_LIMIT')

  const f = relayFixture({
    maxCircuitQueuedBytes: 1200,
    maxQueuedBytes: 1200,
    send: () => false
  })
  f.relay.receive(
    f.previous.publicKey,
    f.sealInbound('previous', CELL_CLASS.CONTROL, b4a.alloc(1146, 1))
  )
  t.is(f.relay.queuedBytes, 1200)
  expectCode(
    t,
    () =>
      f.relay.receive(
        f.previous.publicKey,
        f.sealInbound('previous', CELL_CLASS.CONTROL, b4a.alloc(1146, 2))
      ),
    'CIRCUIT_LIMIT'
  )
  t.is(f.relay.activeCircuits, 0)
  t.is(f.relay.queuedBytes, 0)
})

test('half-open timeout, transport close, and authenticated destroy clean both bindings', (t) => {
  const timeout = relayFixture()
  timeout.setNow(6_000)
  timeout.relay.expire()
  t.is(timeout.relay.activeCircuits, 0)

  const close = relayFixture()
  close.relay.transportClosed(close.next.publicKey)
  t.is(close.relay.activeCircuits, 0)

  const destroy = relayFixture()
  destroy.relay.receive(
    destroy.previous.publicKey,
    destroy.sealInbound('previous', CELL_CLASS.CONTROL, RELAY_DESTROY_PAYLOAD)
  )
  t.is(destroy.relay.activeCircuits, 0)
  t.is(destroy.relay.queuedBytes, 0)
})

test('cleanup deletes maps and zeroes all 12 contexts before destroy sends', (t) => {
  let f = null
  const sendObservations = []
  f = relayFixture({
    send(peer, packet) {
      expectCode(
        t,
        () => f.relay.state(f.previous.publicKey, f.previousIds.responderLocalId),
        'CIRCUIT_STATE'
      )
      expectCode(
        t,
        () => f.relay.state(f.next.publicKey, f.nextIds.initiatorLocalId),
        'CIRCUIT_STATE'
      )
      const zeroized = f.relayEvents.find((event) => event.type === 'zeroized')
      t.ok(zeroized)
      t.is(zeroized.contexts.length, 12)
      for (const context of zeroized.contexts) {
        t.alike(context.key, b4a.alloc(32))
        t.alike(context.noncePrefix, b4a.alloc(16))
        t.is(context.counter.closed, true)
      }
      sendObservations.push({
        active: f.relay.activeCircuits,
        queued: f.relay.queuedBytes,
        peer: b4a.from(peer),
        packet
      })
    }
  })
  f.relay.destroy(f.previous.publicKey, f.previousIds.responderLocalId)

  t.is(f.relay.activeCircuits, 0)
  t.is(f.relay.queuedBytes, 0)
  t.is(sendObservations.length, 2)
  t.ok(sendObservations.every(({ active, queued }) => active === 0 && queued === 0))
  for (const notice of sendObservations) {
    const side = b4a.equals(notice.peer, f.previous.publicKey) ? 'previous' : 'next'
    t.alike(f.openSent(side, CELL_CLASS.CONTROL, notice.packet), RELAY_DESTROY_PAYLOAD)
  }
  const zeroized = f.relayEvents.find((event) => event.type === 'zeroized')
  t.ok(zeroized)
  t.is(zeroized.contexts.length, 12)
  for (const context of zeroized.contexts) {
    t.alike(context.key, b4a.alloc(32))
    t.alike(context.noncePrefix, b4a.alloc(16))
    t.is(context.counter.closed, true)
  }
})

test('relay API exposes no endpoint, DHT, topic, path, or end-to-end key surface', (t) => {
  const f = relayFixture()
  for (const name of [
    'endpointIp',
    'dhtKey',
    'topic',
    'path',
    'routeKey',
    'receiveAuthenticated'
  ]) {
    t.is(name in f.relay, false)
  }
  t.is(f.relay.state(f.previous.publicKey, f.previousIds.responderLocalId), CIRCUIT_STATE.CREATE)
})

test('candidate selection is stateless for a wrong peer and selected direction or epoch fails closed', (t) => {
  const wrongPeer = relayFixture()
  const valid = wrongPeer.sealInbound('previous', CELL_CLASS.CONTROL, b4a.from('create'))
  expectCode(t, () => wrongPeer.relay.receive(seed(90), valid), 'CELL_INVALID')
  t.is(wrongPeer.relay.activeCircuits, 1)

  for (const override of [{ direction: DIRECTION.REVERSE }, { epoch: 10n }]) {
    const selected = relayFixture()
    const packet = selected.sealInbound(
      'previous',
      CELL_CLASS.CONTROL,
      b4a.from('create'),
      override
    )
    expectCode(t, () => selected.relay.receive(selected.previous.publicKey, packet), 'CELL_INVALID')
    t.is(selected.relay.activeCircuits, 0)
  }
})

test('install rejects duplicate adjacent peers or relay-local ids', (t) => {
  expectCode(t, () => relayFixture({ samePeer: true }), 'INVALID_ROUTE')
  expectCode(t, () => relayFixture({ duplicateLocalIds: true }), 'INVALID_ROUTE')
})

test('all six inbound class/direction paths use independent zero-based outbound counters', (t) => {
  const f = relayFixture()
  openCircuit(f)
  const payloads = {
    [CELL_CLASS.CONTROL]: b4a.from('control'),
    [CELL_CLASS.STREAM]: routeFrame(3),
    [CELL_CLASS.DATAGRAM]: routeFrame(4)
  }

  for (const side of ['previous', 'next']) {
    const peer = side === 'previous' ? f.previous : f.next
    for (const cellClass of [CELL_CLASS.CONTROL, CELL_CLASS.STREAM, CELL_CLASS.DATAGRAM]) {
      f.relay.receive(peer.publicKey, f.sealInbound(side, cellClass, payloads[cellClass]))
    }
  }

  t.is(f.sent.length, 6)
  for (let index = 0; index < f.sent.length; index++) {
    const { packet } = f.sent[index]
    const cellClass = index % 3
    const side = index < 3 ? 'next' : 'previous'
    t.alike(packet.subarray(28, 36), b4a.alloc(8))
    t.alike(f.openSent(side, cellClass, packet), payloads[cellClass])
  }
})

test('open cannot resurrect expired half-open state and deadlines cannot overflow', (t) => {
  const expired = relayFixture()
  expired.relay.created(expired.previous.publicKey, expired.previousIds.responderLocalId)
  expired.setNow(6_000)
  expectCode(
    t,
    () => expired.relay.open(expired.previous.publicKey, expired.previousIds.responderLocalId),
    'CIRCUIT_STATE'
  )
  t.is(expired.relay.activeCircuits, 0)

  expectCode(
    t,
    () =>
      relayFixture({
        initialNow: Number.MAX_SAFE_INTEGER - 100,
        expiresAt: BigInt(Number.MAX_SAFE_INTEGER) + 10_000n
      }),
    'INVALID_ROUTE'
  )
})

test('relay state transitions cannot skip or repeat CREATE to CREATED to OPEN', (t) => {
  const valid = relayFixture()
  t.is(
    valid.relay.state(valid.previous.publicKey, valid.previousIds.responderLocalId),
    CIRCUIT_STATE.CREATE
  )
  valid.relay.created(valid.previous.publicKey, valid.previousIds.responderLocalId)
  t.is(
    valid.relay.state(valid.previous.publicKey, valid.previousIds.responderLocalId),
    CIRCUIT_STATE.CREATED
  )
  valid.relay.open(valid.previous.publicKey, valid.previousIds.responderLocalId)
  t.is(
    valid.relay.state(valid.previous.publicKey, valid.previousIds.responderLocalId),
    CIRCUIT_STATE.OPEN
  )

  const skipped = relayFixture()
  expectCode(
    t,
    () => skipped.relay.open(skipped.previous.publicKey, skipped.previousIds.responderLocalId),
    'CIRCUIT_STATE'
  )
  t.is(skipped.relay.activeCircuits, 0)

  const repeatedCreated = relayFixture()
  repeatedCreated.relay.created(
    repeatedCreated.previous.publicKey,
    repeatedCreated.previousIds.responderLocalId
  )
  expectCode(
    t,
    () =>
      repeatedCreated.relay.created(
        repeatedCreated.previous.publicKey,
        repeatedCreated.previousIds.responderLocalId
      ),
    'CIRCUIT_STATE'
  )
  t.is(repeatedCreated.relay.activeCircuits, 0)

  const repeatedOpen = relayFixture()
  openCircuit(repeatedOpen)
  expectCode(
    t,
    () =>
      repeatedOpen.relay.open(
        repeatedOpen.previous.publicKey,
        repeatedOpen.previousIds.responderLocalId
      ),
    'CIRCUIT_STATE'
  )
  t.is(repeatedOpen.relay.activeCircuits, 0)
})

test('ordered CONTROL and STREAM gaps expire at the exact five-second boundary', (t) => {
  for (const side of ['previous', 'next']) {
    for (const cellClass of [CELL_CLASS.CONTROL, CELL_CLASS.STREAM]) {
      const f = relayFixture()
      openCircuit(f)
      const peerIdentity = side === 'previous' ? f.previous.publicKey : f.next.publicKey
      const payload = cellClass === CELL_CLASS.CONTROL ? b4a.from('counter one') : routeFrame(9)
      const outOfOrder = f.sealInbound(side, cellClass, payload, {
        senderCounter: new SenderCounter({ initial: 1n })
      })
      f.relay.receive(peerIdentity, outOfOrder)
      t.is(f.sent.length, 0)

      f.setNow(5_999)
      f.relay.expire()
      t.is(f.relay.activeCircuits, 1)

      f.setNow(6_000)
      expectCode(t, () => f.relay.expire(), 'COUNTER_GAP')
      t.is(f.relay.activeCircuits, 0)
      t.is(f.relay.queuedBytes, 0)
    }
  }
})

test('multi-fragment CREATE and CREATED cross every relay before either circuit opens', (t) => {
  const chain = twoRelayChain()
  const create = fragment(b4a.alloc(2_500, 0xc1), { messageId: b4a.alloc(16, 0xc2) })
  const created = fragment(b4a.alloc(2_300, 0xd1), { messageId: b4a.alloc(16, 0xd2) })
  t.ok(create.length > 1)
  t.ok(created.length > 1)

  for (const frame of create) {
    chain.relayA.receive(
      chain.source.publicKey,
      chain.sealEndpoint(chain.sourceState, DIRECTION.FORWARD, frame)
    )
  }
  const receivedCreate = []
  for (const packet of chain.toDestination) {
    receivedCreate.push(...chain.openEndpoint(chain.destinationState, DIRECTION.FORWARD, packet))
  }
  t.alike(receivedCreate, create)

  for (const frame of created) {
    chain.relayB.receive(
      chain.destination.publicKey,
      chain.sealEndpoint(chain.destinationState, DIRECTION.REVERSE, frame)
    )
  }
  const receivedCreated = []
  for (const packet of chain.toSource) {
    receivedCreated.push(...chain.openEndpoint(chain.sourceState, DIRECTION.REVERSE, packet))
  }
  t.alike(receivedCreated, created)
  const expectedForwards = create.length + created.length
  t.is(chain.relayATrace.filter(({ type }) => type === 'forward').length, expectedForwards)
  t.is(chain.relayBTrace.filter(({ type }) => type === 'forward').length, expectedForwards)
  t.is(chain.relayA.activeCircuits, 1)
  t.is(chain.relayB.activeCircuits, 1)
  t.is(chain.relayA.state(chain.source.publicKey, b4a.alloc(16, 2)), CIRCUIT_STATE.CREATE)
  t.is(chain.relayB.state(chain.destination.publicKey, b4a.alloc(16, 5)), CIRCUIT_STATE.CREATE)
})

test('per-source admission is bounded below the global circuit limit', (t) => {
  t.is(DEFAULT_MAX_CIRCUITS, 128)
  t.ok(DEFAULT_MAX_CIRCUITS_PER_SOURCE > 0)
  t.ok(DEFAULT_MAX_CIRCUITS_PER_SOURCE <= DEFAULT_MAX_CIRCUITS)

  const h = relayHarness({ maxCircuits: 3, maxCircuitsPerSource: 2 })
  const sourceA = peer(121)
  const sourceB = peer(122)
  const firstA = h.install({
    source: sourceA,
    next: peer(131),
    circuitByte: 1,
    sourceLocalByte: 11,
    relayPreviousByte: 21,
    relayNextByte: 31,
    nextLocalByte: 41
  })
  h.install({
    source: sourceA,
    next: peer(132),
    circuitByte: 2,
    sourceLocalByte: 12,
    relayPreviousByte: 22,
    relayNextByte: 32,
    nextLocalByte: 42
  })
  expectCode(
    t,
    () =>
      h.install({
        source: sourceA,
        next: peer(133),
        circuitByte: 3,
        sourceLocalByte: 13,
        relayPreviousByte: 23,
        relayNextByte: 33,
        nextLocalByte: 43
      }),
    'CIRCUIT_LIMIT'
  )
  t.is(h.relay.activeCircuits, 2)

  h.install({
    source: sourceB,
    next: peer(134),
    circuitByte: 4,
    sourceLocalByte: 14,
    relayPreviousByte: 24,
    relayNextByte: 34,
    nextLocalByte: 44
  })
  t.is(h.relay.activeCircuits, 3)

  t.is(h.relay.destroy(sourceA.identity.publicKey, firstA.previousLocalId), true)
  h.install({
    source: sourceA,
    next: peer(135),
    circuitByte: 5,
    sourceLocalByte: 15,
    relayPreviousByte: 25,
    relayNextByte: 35,
    nextLocalByte: 45
  })
  t.is(h.relay.activeCircuits, 3)
})

test('install rejects outbound ticket mismatch and an existing binding collision', (t) => {
  const mismatch = relayHarness()
  const left = mismatch.tickets({
    source: peer(141),
    next: peer(151),
    circuitByte: 51,
    sourceLocalByte: 61,
    relayPreviousByte: 71,
    relayNextByte: 81,
    nextLocalByte: 91
  })
  const right = mismatch.tickets({
    source: peer(142),
    next: peer(152),
    circuitByte: 52,
    sourceLocalByte: 62,
    relayPreviousByte: 72,
    relayNextByte: 82,
    nextLocalByte: 92
  })
  expectCode(
    t,
    () => mismatch.relay.install(left.previousTicket, right.nextTicket),
    'INVALID_ROUTE'
  )
  t.is(mismatch.relay.activeCircuits, 0)

  const collision = relayHarness()
  const source = peer(143)
  collision.install({
    source,
    next: peer(153),
    circuitByte: 53,
    sourceLocalByte: 63,
    relayPreviousByte: 73,
    relayNextByte: 83,
    nextLocalByte: 93
  })
  expectCode(
    t,
    () =>
      collision.install({
        source,
        next: peer(154),
        circuitByte: 54,
        sourceLocalByte: 64,
        relayPreviousByte: 73,
        relayNextByte: 84,
        nextLocalByte: 94
      }),
    'INVALID_ROUTE'
  )
  t.is(collision.relay.activeCircuits, 1)
})

test('global queue exhaustion removes only the overflowing circuit', (t) => {
  const h = relayHarness({
    maxCircuits: 2,
    maxCircuitsPerSource: 2,
    maxCircuitQueuedBytes: 2_400,
    maxQueuedBytes: 1_200,
    send: () => false
  })
  const first = h.install({
    source: peer(161),
    next: peer(171),
    circuitByte: 101,
    sourceLocalByte: 111,
    relayPreviousByte: 121,
    relayNextByte: 131,
    nextLocalByte: 141
  })
  const second = h.install({
    source: peer(162),
    next: peer(172),
    circuitByte: 102,
    sourceLocalByte: 112,
    relayPreviousByte: 122,
    relayNextByte: 132,
    nextLocalByte: 142
  })
  h.relay.receive(
    first.source.identity.publicKey,
    h.sealPrevious(first, CELL_CLASS.CONTROL, b4a.from('first'))
  )
  t.is(h.relay.queuedBytes, 1_200)
  expectCode(
    t,
    () =>
      h.relay.receive(
        second.source.identity.publicKey,
        h.sealPrevious(second, CELL_CLASS.CONTROL, b4a.from('second'))
      ),
    'CIRCUIT_LIMIT'
  )
  t.is(h.relay.activeCircuits, 1)
  t.is(h.relay.queuedBytes, 1_200)
})

test('local control receives borrowed authenticated bytes which are cleared after callback', (t) => {
  let borrowed = null
  let received = null
  const f = relayFixture({
    onControl(event) {
      borrowed = event.payload
      received = b4a.from(event.payload)
      return true
    }
  })
  const payload = b4a.from('local activation fragment')
  f.relay.receive(f.previous.publicKey, f.sealInbound('previous', CELL_CLASS.CONTROL, payload))

  t.alike(received, payload)
  t.alike(borrowed, b4a.alloc(payload.byteLength))
  t.is(f.sent.length, 0)
  t.is(f.relay.activeCircuits, 1)
})

test('a non-consuming control callback cannot mutate the forwarded authenticated fragment', (t) => {
  let borrowed = null
  const f = relayFixture({
    onControl(event) {
      borrowed = event.payload
      event.payload.fill(0xaa)
      return false
    }
  })
  const payload = b4a.from('forward this exact fragment')
  f.relay.receive(f.previous.publicKey, f.sealInbound('previous', CELL_CLASS.CONTROL, payload))

  t.is(f.sent.length, 1)
  t.alike(f.openSent('next', CELL_CLASS.CONTROL, f.sent[0].packet), payload)
  t.alike(borrowed, b4a.alloc(payload.byteLength))
})

test('backpressure retries copies so a hostile failed send cannot corrupt the queue', (t) => {
  let calls = 0
  let delivered = null
  const f = relayFixture({
    send(peer, packet) {
      calls++
      if (calls === 2) packet.fill(0)
      if (calls < 3) return false
      delivered = { peer: b4a.from(peer), packet: b4a.from(packet) }
      return true
    }
  })
  const payload = b4a.from('bounded control')
  f.relay.receive(f.previous.publicKey, f.sealInbound('previous', CELL_CLASS.CONTROL, payload))
  t.is(f.relay.queuedBytes, 1200)

  f.relay.flush()
  t.is(f.relay.queuedBytes, 1200)
  f.relay.flush()

  t.is(f.relay.queuedBytes, 0)
  t.alike(delivered.peer, f.next.publicKey)
  t.alike(f.openSent('next', CELL_CLASS.CONTROL, delivered.packet), payload)
})

test('an OPEN circuit expires absolutely and a regressing clock destroys all state', (t) => {
  const expired = relayFixture()
  openCircuit(expired)
  const packet = expired.sealInbound('previous', CELL_CLASS.STREAM, routeFrame(8))
  expired.setNow(10_000)
  expectCode(t, () => expired.relay.receive(expired.previous.publicKey, packet), 'CELL_INVALID')
  t.is(expired.relay.activeCircuits, 0)

  const regressed = relayFixture()
  regressed.setNow(999)
  expectCode(t, () => regressed.relay.expire(), 'INVALID_ROUTE')
  t.is(regressed.relay.activeCircuits, 0)
})

test('reentrant and throwing callbacks fail closed without retaining route state', (t) => {
  let reentrant = null
  let nestedPacket = null
  let calls = 0
  reentrant = relayFixture({
    send() {
      calls++
      if (calls === 1) reentrant.relay.receive(reentrant.previous.publicKey, nestedPacket)
    }
  })
  const first = reentrant.sealInbound('previous', CELL_CLASS.CONTROL, b4a.from('first'))
  nestedPacket = reentrant.sealInbound('previous', CELL_CLASS.CONTROL, b4a.from('nested'))
  expectCode(t, () => reentrant.relay.receive(reentrant.previous.publicKey, first), 'CELL_INVALID')
  t.is(reentrant.relay.activeCircuits, 0)

  const hostile = relayFixture({
    onControl() {
      throw new Error('hostile control callback')
    }
  })
  expectCode(
    t,
    () =>
      hostile.relay.receive(
        hostile.previous.publicKey,
        hostile.sealInbound('previous', CELL_CLASS.CONTROL, b4a.from('control'))
      ),
    'CELL_INVALID'
  )
  t.is(hostile.relay.activeCircuits, 0)
})

test('created and open reentry through the clock fail closed without state regression', (t) => {
  for (const method of ['created', 'open']) {
    let fixture = null
    let armed = false
    const f = relayFixture({
      now() {
        if (armed) {
          armed = false
          fixture.relay[method](fixture.previous.publicKey, fixture.previousIds.responderLocalId)
        }
        return 1_000
      }
    })
    fixture = f
    if (method === 'open') {
      f.relay.created(f.previous.publicKey, f.previousIds.responderLocalId)
    }
    armed = true

    expectCode(
      t,
      () => f.relay[method](f.previous.publicKey, f.previousIds.responderLocalId),
      'INVALID_ROUTE'
    )
    t.is(f.relay.activeCircuits, 0)
    t.is(f.sent.length, 2)
  }
})

test('a control callback may legitimately advance CREATED to OPEN', (t) => {
  let fixture = null
  const f = relayFixture({
    onControl() {
      fixture.relay.open(fixture.previous.publicKey, fixture.previousIds.responderLocalId)
      return true
    }
  })
  fixture = f
  f.relay.created(f.previous.publicKey, f.previousIds.responderLocalId)

  f.relay.receive(
    f.previous.publicKey,
    f.sealInbound('previous', CELL_CLASS.CONTROL, b4a.from('activate'))
  )

  t.is(f.relay.state(f.previous.publicKey, f.previousIds.responderLocalId), CIRCUIT_STATE.OPEN)
  t.is(f.sent.length, 0)
})

test('a reentrant flush cannot send or debit the same queued packet twice', (t) => {
  let fixture = null
  let calls = 0
  let reenter = false
  const delivered = []
  const f = relayFixture({
    send(peer, packet) {
      calls++
      if (calls === 1) return false
      delivered.push({ peer: b4a.from(peer), packet: b4a.from(packet) })
      if (reenter) {
        reenter = false
        fixture.relay.flush()
      }
      return true
    }
  })
  fixture = f
  f.relay.receive(
    f.previous.publicKey,
    f.sealInbound('previous', CELL_CLASS.CONTROL, b4a.from('one queued packet'))
  )
  t.is(f.relay.queuedBytes, CELL_SIZE)
  reenter = true

  f.relay.flush()

  t.is(delivered.length, 1)
  t.is(f.relay.queuedBytes, 0)
  t.is(f.relay.activeCircuits, 1)
})

test('flush does not debit a queue twice when send destroys its record', (t) => {
  let fixture = null
  let calls = 0
  const f = relayFixture({
    send() {
      calls++
      if (calls === 1) return false
      fixture.relay.destroy(fixture.previous.publicKey, fixture.previousIds.responderLocalId)
      return true
    }
  })
  fixture = f
  f.relay.receive(
    f.previous.publicKey,
    f.sealInbound('previous', CELL_CLASS.CONTROL, b4a.from('destroy queued record'))
  )
  t.is(f.relay.queuedBytes, CELL_SIZE)

  f.relay.flush()

  t.is(f.relay.queuedBytes, 0)
  t.is(f.relay.activeCircuits, 0)
})

for (const stage of ['seal', 'post-seal hash', 'observer']) {
  test(`${stage} teardown cannot forward data after destroy notices`, (t) => {
    let fixture = null
    let armed = false
    let hashCalls = 0
    const crypto = {
      ...cryptoSuite,
      seal(options) {
        const packet = cryptoSuite.seal(options)
        if (stage === 'seal' && armed) {
          armed = false
          fixture.relay.destroy(fixture.previous.publicKey, fixture.previousIds.responderLocalId)
        }
        return packet
      },
      hash(parts) {
        const value = cryptoSuite.hash(parts)
        if (stage === 'post-seal hash' && armed && ++hashCalls === 2) {
          armed = false
          fixture.relay.destroy(fixture.previous.publicKey, fixture.previousIds.responderLocalId)
        }
        return value
      }
    }
    const overrides = {
      crypto,
      [TEST_ONLY_RELAY_OBSERVER](event) {
        if (stage === 'observer' && armed && event.type === 'forward') {
          armed = false
          fixture.relay.destroy(fixture.previous.publicKey, fixture.previousIds.responderLocalId)
        }
      }
    }
    const f = relayFixture(overrides)
    fixture = f
    openCircuit(f)
    armed = true

    expectCode(
      t,
      () =>
        f.relay.receive(
          f.previous.publicKey,
          f.sealInbound('previous', CELL_CLASS.STREAM, routeFrame(0x72))
        ),
      'CELL_INVALID'
    )

    t.is(f.relay.activeCircuits, 0)
    t.is(f.sent.length, 2)
  })
}

test('relay hash rejects a shadowed payload alias without forwarding mutated data', (t) => {
  let armed = false
  const crypto = {
    ...cryptoSuite,
    hash(parts) {
      if (armed) {
        armed = false
        return shadowedBuffer(parts[0].subarray(0, 32), {
          buffer: new ArrayBuffer(32),
          byteOffset: 0
        })
      }
      return cryptoSuite.hash(parts)
    }
  }
  const f = relayFixture({ crypto })
  openCircuit(f)
  armed = true

  expectCode(
    t,
    () =>
      f.relay.receive(
        f.previous.publicKey,
        f.sealInbound('previous', CELL_CLASS.STREAM, routeFrame(0x73))
      ),
    'CELL_INVALID'
  )

  t.is(f.relay.activeCircuits, 0)
  t.is(f.sent.length, 2)
})

test('forward trace exposes only equal opaque-frame hashes and public metadata', (t) => {
  const f = relayFixture()
  openCircuit(f)
  f.relay.receive(f.previous.publicKey, f.sealInbound('previous', CELL_CLASS.STREAM, routeFrame(7)))

  const event = f.relayEvents.find(({ type }) => type === 'forward')
  t.ok(event)
  t.alike(event.beforeHash, event.afterHash)
  t.is(event.class, CELL_CLASS.STREAM)
  t.is(event.direction, DIRECTION.FORWARD)
  t.is(event.byteLength, 1100)
  t.is('payload' in event, false)
})
