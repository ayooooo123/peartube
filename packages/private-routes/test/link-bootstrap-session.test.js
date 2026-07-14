import test from 'brittle'
import b4a from 'b4a'

import {
  ACTOR_CONTROL_KIND,
  BOOTSTRAP_TYPE,
  CELL_CLASS,
  CIRCUIT_DESTROY_REASON,
  DIRECTION,
  LINK_OPERATION,
  LinkBootstrapSession,
  LinkDirectory,
  PROTOCOL_VERSION,
  TOPOLOGY_ROLE,
  UdxCellEndpoint,
  BootstrapEnvelopeCodec,
  ActorControlCodec,
  RemoteActorHost,
  RemoteControlFragmentCodec,
  RemoteControlMux,
  createLinkSetupAuthority,
  cryptoSuite,
  signTopologyGrant
} from '../index.js'
import { readEstablishedLink } from '../lib/link-bootstrap-session.js'
import { createRemoteActorControlBoundary } from '../lib/remote-control.js'
import { FakeUdxAdapter } from './fake-udx.js'
import { safetyRoleIdentity, seed } from './helpers.js'

function sequence(first) {
  let value = first
  return (size) => b4a.alloc(size, value++)
}

function fakeClock(start = Date.now()) {
  let now = start
  let nextId = 1
  const timers = new Map()
  function runDue() {
    let progressed = true
    while (progressed) {
      progressed = false
      for (const [id, timer] of timers) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.callback()
        progressed = true
        break
      }
    }
  }
  return {
    now: () => now,
    schedule(callback, delay) {
      const id = nextId++
      timers.set(id, { callback, at: now + delay })
      return id
    },
    cancel(id) {
      timers.delete(id)
    },
    advance(delta) {
      now += delta
      runDue()
    },
    pending: () => timers.size
  }
}

function makeDirectory({
  local,
  peer,
  role,
  peerRole,
  operation,
  authority,
  grant,
  epoch,
  runId32,
  clock
}) {
  const directory = new LinkDirectory({
    localIdentity32: local.publicKey,
    localRole: role,
    authorityPublicKey: authority.publicKey,
    epoch,
    runId32,
    now: () => BigInt(clock.now()),
    schedule: clock.schedule,
    cancel: clock.cancel,
    onClose() {}
  })
  const digest32 = directory.add(grant)
  const linkHandle = directory.authorize({
    digest32,
    operation,
    localIdentity32: local.publicKey,
    localRole: role,
    peerIdentity32: peer.publicKey,
    peerRole,
    epoch,
    runId32
  })
  return { directory, linkHandle, digest32 }
}

async function fixture(options = {}) {
  const sessionClock = options.clock || {
    now: Date.now,
    schedule: setTimeout,
    cancel: clearTimeout
  }
  const topologyClock = options.topologyClock || {
    now: Date.now,
    schedule: setTimeout,
    cancel: clearTimeout
  }
  const authority = cryptoSuite.keyPair(seed(250))
  const initiator = cryptoSuite.keyPair(seed(251))
  const responder = safetyRoleIdentity(252)
  const responderStatic = cryptoSuite.encryptionKeyPair(seed(253))
  const epoch = 9n
  const runId32 = seed(254)
  const topologyNow = BigInt(topologyClock.now())
  const expiresAt = topologyNow + BigInt(options.grantLifetime || 60_000)
  const grant = signTopologyGrant(
    {
      version: PROTOCOL_VERSION,
      format: 0,
      grantId32: seed(255),
      endpointA: {
        identity32: initiator.publicKey,
        role: TOPOLOGY_ROLE.SOURCE,
        host: '127.0.0.31',
        port: 46331,
        operations: LINK_OPERATION.INITIATE
      },
      endpointB: {
        identity32: responder.publicKey,
        role: TOPOLOGY_ROLE.SAFETY_GUARD,
        host: '127.0.0.32',
        port: 46332,
        operations: LINK_OPERATION.ACCEPT
      },
      epoch,
      notBefore: topologyNow > 1_000n ? topologyNow - 1_000n : 0n,
      expiresAt,
      runId32
    },
    authority.secretKey
  )
  const left = makeDirectory({
    local: initiator,
    peer: responder,
    role: TOPOLOGY_ROLE.SOURCE,
    peerRole: TOPOLOGY_ROLE.SAFETY_GUARD,
    operation: LINK_OPERATION.INITIATE,
    authority,
    grant,
    epoch,
    runId32,
    clock: topologyClock
  })
  const right = makeDirectory({
    local: responder,
    peer: initiator,
    role: TOPOLOGY_ROLE.SAFETY_GUARD,
    peerRole: TOPOLOGY_ROLE.SOURCE,
    operation: LINK_OPERATION.ACCEPT,
    authority,
    grant,
    epoch,
    runId32,
    clock: topologyClock
  })
  let leftSession
  let rightSession
  const heldLeft = {}
  let leftCalls = 0
  let rightCalls = 0
  const leftAdapter = new FakeUdxAdapter({
    send(call) {
      leftCalls++
      if (options.reentrantBootstrap) {
        rightAdapter.sockets[0].emitMessage(call.packet, '127.0.0.31', 46331)
      }
      if (options.holdLeft && leftCalls === 1) {
        return new Promise((resolve) => {
          heldLeft.resolve = resolve
        })
      }
      if (options.dropFirstLeft && leftCalls === 1) return true
      if (options.dropLeft) return true
      if (!options.reentrantBootstrap) {
        queueMicrotask(() => rightAdapter.sockets[0].emitMessage(call.packet, '127.0.0.31', 46331))
      }
      return true
    }
  })
  const rightAdapter = new FakeUdxAdapter({
    send(call) {
      rightCalls++
      if (options.holdRight) {
        return new Promise((resolve) => {
          heldLeft.resolveRight = resolve
        })
      }
      if (options.dropFirstRight && rightCalls === 1) return true
      if (options.dropRight) return true
      if (options.reentrantBootstrap) {
        leftAdapter.sockets[0].emitMessage(call.packet, '127.0.0.32', 46332)
      } else {
        queueMicrotask(() => leftAdapter.sockets[0].emitMessage(call.packet, '127.0.0.32', 46332))
      }
      return true
    }
  })
  const leftEndpoint = new UdxCellEndpoint({
    adapter: leftAdapter,
    host: '127.0.0.31',
    port: 46331,
    onBootstrap: (packet) => void leftSession.receive(packet),
    onCell() {},
    onLinkFailure() {}
  })
  const rightEndpoint = new UdxCellEndpoint({
    adapter: rightAdapter,
    host: '127.0.0.32',
    port: 46332,
    onBootstrap: (packet) => void rightSession.receive(packet),
    onCell() {},
    onLinkFailure() {}
  })
  await leftEndpoint.bind()
  await rightEndpoint.bind()
  const common = {
    circuitId: b4a.alloc(16, 0x51),
    epoch,
    initiatorIdentity: initiator.publicKey,
    responderIdentity: responder.publicKey,
    initiatorLocalId: b4a.alloc(16, 0x52),
    responderLocalId: b4a.alloc(16, 0x53),
    expiresAt
  }
  const leftSetup = createLinkSetupAuthority({
    now: sessionClock.now,
    randomBytes: sequence(0x61)
  })
  const rightSetup = createLinkSetupAuthority({
    now: sessionClock.now,
    randomBytes: sequence(0x71)
  })
  leftSession = leftEndpoint.openLink(left.linkHandle, {
    mode: 'initiate',
    codec: new BootstrapEnvelopeCodec({
      linkHandle: left.linkHandle,
      localIdentitySecretKey: initiator.secretKey,
      padding: sequence(0x81)
    }),
    linkSetup: leftSetup,
    setup: {
      ...common,
      responderStaticKey: responderStatic.publicKey,
      initiatorIdentitySecretKey: initiator.secretKey
    },
    now: sessionClock.now,
    schedule: sessionClock.schedule,
    cancel: sessionClock.cancel,
    randomBytes: sequence(1)
  })
  rightSession = rightEndpoint.openLink(right.linkHandle, {
    mode: 'accept',
    codec: new BootstrapEnvelopeCodec({
      linkHandle: right.linkHandle,
      localIdentitySecretKey: responder.secretKey,
      padding: sequence(0x91)
    }),
    linkSetup: rightSetup,
    setup: {
      ...common,
      responderStaticSecretKey: responderStatic.secretKey,
      responderIdentitySecretKey: responder.secretKey
    },
    now: sessionClock.now,
    schedule: sessionClock.schedule,
    cancel: sessionClock.cancel,
    randomBytes: sequence(11)
  })
  return {
    leftSession,
    rightSession,
    leftEndpoint,
    rightEndpoint,
    leftAdapter,
    rightAdapter,
    left,
    right,
    heldLeft,
    initiator,
    responder,
    authority,
    runId32,
    epoch,
    responderStatic,
    common,
    leftSetup
  }
}

async function code(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err && err.code
  }
}

function abortController() {
  const listeners = new Set()
  const signal = {
    aborted: false,
    addEventListener(name, listener) {
      if (name === 'abort') listeners.add(listener)
    },
    removeEventListener(name, listener) {
      if (name === 'abort') listeners.delete(listener)
    }
  }
  return {
    signal,
    abort() {
      if (signal.aborted) return
      signal.aborted = true
      for (const listener of listeners) listener()
      listeners.clear()
    }
  }
}

function readU64(buffer, offset) {
  let value = 0n
  for (let index = offset; index < offset + 8; index++) {
    value = (value << 8n) | BigInt(buffer[index])
  }
  return value
}

test('async bootstrap transitions IDLE to CREATING to OPEN and installs opaque link state', async (t) => {
  const f = await fixture()
  t.is(f.leftSession.state, 'IDLE')
  const opening = f.leftSession.open()
  t.is(f.leftSession.state, 'CREATING')
  const established = await opening
  await new Promise((resolve) => setTimeout(resolve, 0))
  t.is(f.leftSession.state, 'OPEN')
  t.is(f.rightSession.state, 'OPEN')
  t.is(Object.keys(established).length, 0)
  const left = readEstablishedLink(established)
  const right = readEstablishedLink(f.rightSession.established)
  t.alike(left.localIdentity, right.peerIdentity)
  t.alike(left.peerIdentity, right.localIdentity)
  await f.leftSession.close()
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
  t.is(f.leftSession.state, 'TOMBSTONE')
  t.is(f.leftSession.pending, 0)
})

test('actor control authenticates the established link independently of inner route IDs', async (t) => {
  const f = await fixture()
  const established = await f.leftSession.open()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const link = readEstablishedLink(established)
  t.is(b4a.equals(link.circuitId, b4a.alloc(16)), false, 'real link circuit is nonzero')

  const actorId = b4a.alloc(16, 0xa1)
  const codec = new ActorControlCodec()
  const registration = codec.encode({
    version: 0,
    kind: ACTOR_CONTROL_KIND.REGISTER_STAGE,
    flags: 0,
    requestId: 1n,
    actorId,
    circuitId: b4a.alloc(16),
    generation: 0n,
    body: b4a.from([1])
  })
  const sender = new RemoteControlFragmentCodec({ now: () => 1_000 })
  const mux = new RemoteControlMux()
  const [frame] = sender.fragment(registration, { messageId: b4a.alloc(16, 0xa2) })
  const payload = mux.encodeActorFragment(frame)

  function hostAndBoundary() {
    const sent = []
    const boundary = createRemoteActorControlBoundary({
      link: established,
      epoch: link.epoch,
      circuitId: link.circuitId,
      now: () => 1_000
    })
    const host = new RemoteActorHost({
      control: boundary.consumer,
      sendControl(message) {
        sent.push(b4a.from(message))
        return true
      },
      now: () => 1_000,
      randomBytes: sequence(1),
      schedule() {
        return 1
      },
      cancel() {}
    })
    return { boundary, host, sent }
  }

  const accepted = hostAndBoundary()
  const event = accepted.boundary.pushAuthenticated(payload, {
    link: established,
    epoch: link.epoch,
    direction: DIRECTION.FORWARD,
    circuitId: link.circuitId
  })
  t.is(await accepted.host.receiveAuthenticated(event), true)
  t.is(accepted.sent.length, 1)
  accepted.host.destroy()
  accepted.boundary.destroy()

  for (const [name, kind, body] of [
    ['activation', ACTOR_CONTROL_KIND.ACTIVATE_CREATE, b4a.alloc(1_200, 0xb1)],
    ['destroy', ACTOR_CONTROL_KIND.CIRCUIT_DESTROY, b4a.from([CIRCUIT_DESTROY_REASON.REQUESTED])]
  ]) {
    const innerCircuitId = b4a.alloc(16, kind + 1)
    t.is(b4a.equals(innerCircuitId, link.circuitId), false, `${name} uses an inner route ID`)
    const command = codec.encode({
      version: 0,
      kind,
      flags: 0,
      requestId: BigInt(kind + 2),
      actorId,
      circuitId: innerCircuitId,
      generation: 7n,
      body
    })
    const frames = sender.fragment(command, { messageId: b4a.alloc(16, kind + 2) })
    const routed = hostAndBoundary()
    let routedEvent = null
    for (const routedFrame of frames) {
      const routedPayload = mux.encodeActorFragment(routedFrame)
      routedEvent = routed.boundary.pushAuthenticated(routedPayload, {
        link: established,
        epoch: link.epoch,
        direction: DIRECTION.FORWARD,
        circuitId: link.circuitId
      })
      routedPayload.fill(0)
      routedFrame.fill(0)
    }
    t.is(await routed.host.receiveAuthenticated(routedEvent), true, name)
    t.is(routed.sent.length, 1, name)
    const reply = codec.decode(routed.sent[0])
    t.is(b4a.equals(reply.circuitId, innerCircuitId), true, `${name} reply keeps inner route`)
    t.is(reply.generation, 7n, `${name} reply keeps inner generation`)
    reply.actorId.fill(0)
    reply.circuitId.fill(0)
    reply.body.fill(0)
    command.fill(0)
    innerCircuitId.fill(0)
    body.fill(0)
    routed.host.destroy()
    routed.boundary.destroy()
  }

  for (const [name, mutation] of [
    ['link', { link: Object.freeze({}) }],
    ['epoch', { epoch: link.epoch + 1n }],
    ['direction', { direction: DIRECTION.REVERSE }],
    ['circuit', { circuitId: b4a.alloc(16, 0xa3) }]
  ]) {
    const rejected = hostAndBoundary()
    let failure = null
    try {
      const rejectedEvent = rejected.boundary.pushAuthenticated(payload, {
        link: established,
        epoch: link.epoch,
        direction: DIRECTION.FORWARD,
        circuitId: link.circuitId,
        ...mutation
      })
      await rejected.host.receiveAuthenticated(rejectedEvent)
    } catch (err) {
      failure = err && err.code
    }
    t.is(failure, 'INVALID_ROUTE', name)
    t.is(rejected.sent.length, 0, name)
    rejected.host.destroy()
    rejected.boundary.destroy()
  }

  let innerFailure = null
  try {
    codec.encode({
      version: 0,
      kind: ACTOR_CONTROL_KIND.REGISTER_STAGE,
      flags: 0,
      requestId: 2n,
      actorId,
      circuitId: b4a.alloc(16, 1),
      generation: 1n,
      body: b4a.from([1])
    })
  } catch (err) {
    innerFailure = err && err.code
  }
  t.is(innerFailure, 'INVALID_ROUTE', 'inner registration remains zero/zero only')

  frame.fill(0)
  payload.fill(0)
  registration.fill(0)
  sender.destroy()
  await f.leftSession.close()
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
})

test('endpoint close tombstones tracked OPEN session and revokes established authority', async (t) => {
  const f = await fixture()
  const established = await f.leftSession.open()
  t.is(f.leftSession.state, 'OPEN')
  await f.leftEndpoint.close()
  t.is(f.leftSession.state, 'TOMBSTONE')
  let code = null
  try {
    readEstablishedLink(established)
  } catch (err) {
    code = err && err.code
  }
  t.is(code, 'UNAUTHORIZED')
  await f.rightSession.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
})

test('revoked codec grant closes OPEN session on established authority read', async (t) => {
  const f = await fixture()
  const established = await f.leftSession.open()
  f.left.directory.revoke({
    digest32: f.left.digest32,
    epoch: f.epoch,
    runId32: f.runId32
  })
  let code = null
  try {
    readEstablishedLink(established)
  } catch (err) {
    code = err && err.code
  }
  t.is(code, 'UNAUTHORIZED')
  t.is(f.leftSession.state, 'TOMBSTONE')
  await f.leftSession.close()
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
})

test('revocation immediately destroys retained established key and counter state', async (t) => {
  const f = await fixture()
  const established = await f.leftSession.open()
  const retained = readEstablishedLink(established)
  const context = retained.contexts[CELL_CLASS.STREAM].tx
  t.ok(context.key.some((byte) => byte !== 0))
  t.is(context.counter.closed, false)
  f.left.directory.revoke({
    digest32: f.left.digest32,
    epoch: f.epoch,
    runId32: f.runId32
  })
  t.alike(context.key, b4a.alloc(context.key.byteLength))
  t.is(context.counter.closed, true)
  t.is(f.leftSession.state, 'TOMBSTONE')
  await f.leftSession.close()
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
})

test('idle grant expiry immediately destroys retained established key and counter state', async (t) => {
  const clock = fakeClock(1_000)
  const f = await fixture({ clock, topologyClock: clock, grantLifetime: 100 })
  const established = await f.leftSession.open()
  const retained = readEstablishedLink(established)
  const context = retained.contexts[CELL_CLASS.STREAM].tx
  t.ok(context.key.some((byte) => byte !== 0))
  t.is(context.counter.closed, false)
  clock.advance(100)
  t.alike(context.key, b4a.alloc(context.key.byteLength))
  t.is(context.counter.closed, true)
  t.is(f.leftSession.state, 'TOMBSTONE')
  await f.leftSession.close()
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
})

test('initiator stages reentrant valid response until create send resolves exact true', async (t) => {
  const successful = await fixture({ reentrantBootstrap: true, holdLeft: true })
  const successfulOpen = successful.leftSession.open()
  await Promise.resolve()
  await Promise.resolve()
  t.is(successful.leftSession.state, 'CREATING')
  successful.heldLeft.resolve(true)
  await successfulOpen
  t.is(successful.leftSession.state, 'OPEN')
  await successful.leftSession.close()
  await successful.rightSession.close()
  await successful.leftEndpoint.close()
  await successful.rightEndpoint.close()
  successful.left.directory.destroy()
  successful.right.directory.destroy()

  const f = await fixture({ reentrantBootstrap: true, holdLeft: true })
  const opening = f.leftSession.open()
  await Promise.resolve()
  await Promise.resolve()
  t.is(f.leftSession.state, 'CREATING')
  t.is(f.leftSession.established, null)
  f.heldLeft.resolve(false)
  t.is(await code(opening), 'ROUTE_UNAVAILABLE')
  t.is(f.leftSession.state, 'TOMBSTONE')
  await f.leftSession.close()
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
})

test('cancellation after dispatch sends an authenticated LINK_CANCEL and tombstones setup', async (t) => {
  const f = await fixture({ dropRight: true })
  const controller = abortController()
  const opening = f.leftSession.open({ signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 5))
  controller.abort()
  t.is(await code(opening), 'ROUTE_UNAVAILABLE')
  await new Promise((resolve) => setTimeout(resolve, 5))
  t.is(f.leftSession.state, 'TOMBSTONE')
  t.ok(f.leftAdapter.sockets[0].sends.some((send) => send.packet[2] === BOOTSTRAP_TYPE.LINK_CANCEL))
  await f.leftSession.close()
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
})

test('same request is answered from cache while different-body and late responses stay closed', async (t) => {
  const f = await fixture({ dropRight: true })
  const opening = f.leftSession.open()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const request = f.leftAdapter.sockets[0].sends[0].packet
  await f.rightSession.receive(request)
  await f.rightSession.receive(request)
  t.is(f.rightAdapter.sockets[0].sends.length, 3)
  t.alike(f.rightAdapter.sockets[0].sends[0].packet, f.rightAdapter.sockets[0].sends[1].packet)
  t.alike(f.rightAdapter.sockets[0].sends[1].packet, f.rightAdapter.sockets[0].sends[2].packet)
  await f.leftSession.close()
  t.is(await code(opening), 'ROUTE_UNAVAILABLE')
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
})

test('a lost LINK_CREATE is retransmitted exactly and opens before the deadline', async (t) => {
  const clock = fakeClock()
  const f = await fixture({ dropFirstLeft: true, clock })
  const opening = f.leftSession.open()
  await new Promise((resolve) => setTimeout(resolve, 0))
  t.is(f.leftAdapter.sockets[0].sends.length, 1)
  const original = b4a.from(f.leftAdapter.sockets[0].sends[0].packet)
  clock.advance(249)
  t.is(f.leftAdapter.sockets[0].sends.length, 1)
  clock.advance(1)
  await opening
  await new Promise((resolve) => setTimeout(resolve, 0))
  t.is(f.leftAdapter.sockets[0].sends.length, 2)
  t.alike(f.leftAdapter.sockets[0].sends[1].packet, original)
  t.is(f.leftSession.state, 'OPEN')
  t.is(f.rightSession.state, 'OPEN')
  original.fill(0)
  await f.leftSession.close()
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
  t.is(clock.pending(), 0)
})

test('a lost LINK_CREATED is recovered from the authenticated response cache', async (t) => {
  const clock = fakeClock()
  const f = await fixture({ dropFirstRight: true, clock })
  const opening = f.leftSession.open()
  await new Promise((resolve) => setTimeout(resolve, 0))
  t.is(f.leftAdapter.sockets[0].sends.length, 1)
  t.is(f.rightAdapter.sockets[0].sends.length, 1)
  const request = b4a.from(f.leftAdapter.sockets[0].sends[0].packet)
  const response = b4a.from(f.rightAdapter.sockets[0].sends[0].packet)
  clock.advance(250)
  await opening
  await new Promise((resolve) => setTimeout(resolve, 0))
  t.is(f.leftAdapter.sockets[0].sends.length, 2)
  t.is(f.rightAdapter.sockets[0].sends.length, 2)
  t.alike(f.leftAdapter.sockets[0].sends[1].packet, request)
  t.alike(f.rightAdapter.sockets[0].sends[1].packet, response)
  t.is(f.leftSession.state, 'OPEN')
  t.is(f.rightSession.state, 'OPEN')
  request.fill(0)
  response.fill(0)
  await f.leftSession.close()
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
  t.is(clock.pending(), 0)
})

test('same request id with another authenticated create body fails closed', async (t) => {
  const f = await fixture({ dropRight: true })
  const opening = f.leftSession.open()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const original = f.leftAdapter.sockets[0].sends[0].packet
  const alternate = f.leftSetup.initiate({
    ...f.common,
    responderStaticKey: f.responderStatic.publicKey,
    initiatorIdentitySecretKey: f.initiator.secretKey
  })
  const codec = new BootstrapEnvelopeCodec({
    linkHandle: f.left.linkHandle,
    localIdentitySecretKey: f.initiator.secretKey,
    padding: sequence(0xa1)
  })
  const packet = codec.encode({
    type: BOOTSTRAP_TYPE.LINK_CREATE,
    requestId: readU64(original, 4),
    epoch: f.common.epoch,
    body: alternate.message,
    requestDigest32: b4a.alloc(32)
  })
  t.is(await f.rightSession.receive(packet), false)
  t.is(f.rightSession.state, 'TOMBSTONE')
  t.is(f.leftSetup.abort(alternate.pending), true)
  codec.destroy()
  await f.leftSession.close()
  t.is(await code(opening), 'ROUTE_UNAVAILABLE')
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
})

test('the exact 5000ms deadline tombstones pending setup and rejects late response', async (t) => {
  const clock = fakeClock()
  const f = await fixture({ dropRight: true, clock })
  const opening = f.leftSession.open()
  await Promise.resolve()
  const late = f.rightAdapter.sockets[0].sends[0].packet
  clock.advance(4_999)
  t.is(f.leftSession.state, 'CREATING')
  clock.advance(1)
  t.is(await code(opening), 'ROUTE_UNAVAILABLE')
  t.is(f.leftSession.state, 'TOMBSTONE')
  t.is(await f.leftSession.receive(late), false)
  await f.leftSession.close()
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
  t.is(clock.pending(), 0)
})

test('cancellation after native dispatch but before completion queues signed cancel', async (t) => {
  const f = await fixture({ holdLeft: true, dropLeft: true })
  const controller = abortController()
  const opening = f.leftSession.open({ signal: controller.signal })
  await Promise.resolve()
  controller.abort()
  t.is(await code(opening), 'ROUTE_UNAVAILABLE')
  t.is(f.leftAdapter.sockets[0].sends.length, 1)
  f.heldLeft.resolve(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  t.is(f.leftAdapter.sockets[0].sends.length, 2)
  t.is(f.leftAdapter.sockets[0].sends[1].packet[2], BOOTSTRAP_TYPE.LINK_CANCEL)
  await f.leftSession.close()
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
})

test('immediate concurrent close waits for held create and sends cancel before invalidation', async (t) => {
  const f = await fixture({ holdLeft: true, dropLeft: true })
  const controller = abortController()
  const opening = f.leftSession.open({ signal: controller.signal })
  await Promise.resolve()
  controller.abort()
  t.is(await code(opening), 'ROUTE_UNAVAILABLE')
  let firstClosed = false
  let secondClosed = false
  const firstClose = f.leftSession.close().then(() => {
    firstClosed = true
  })
  const secondClose = f.leftSession.close().then(() => {
    secondClosed = true
  })
  await Promise.resolve()
  t.is(firstClosed, false)
  t.is(secondClosed, false)
  f.heldLeft.resolve(true)
  await Promise.all([firstClose, secondClose])
  t.is(f.leftAdapter.sockets[0].sends.length, 2)
  t.is(f.leftAdapter.sockets[0].sends[1].packet[2], BOOTSTRAP_TYPE.LINK_CANCEL)
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
})

test('pre-dispatch cancellation removes queued create without sending cancel', async (t) => {
  const f = await fixture({ holdLeft: true, dropLeft: true })
  const sendHandle = f.leftEndpoint.openLink(f.left.linkHandle)
  const blockerPacket = b4a.alloc(1200)
  blockerPacket[1] = 0x80
  const blocker = code(f.leftEndpoint.send(sendHandle, blockerPacket))
  const controller = abortController()
  const opening = f.leftSession.open({ signal: controller.signal })
  controller.abort()
  t.is(await code(opening), 'ROUTE_UNAVAILABLE')
  t.is(f.leftAdapter.sockets[0].sends.length, 1)
  f.heldLeft.resolve(true)
  t.is(await blocker, 'ROUTE_UNAVAILABLE')
  await Promise.resolve()
  t.is(f.leftAdapter.sockets[0].sends.length, 1)
  await f.leftSession.close()
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
})

test('responder setup tombstones at 5000ms while native response send is unresolved', async (t) => {
  const clock = fakeClock()
  const f = await fixture({ holdRight: true, clock })
  const opening = f.leftSession.open()
  await Promise.resolve()
  clock.advance(4_999)
  t.is(f.rightSession.state, 'CREATING')
  clock.advance(1)
  t.is(f.rightSession.state, 'TOMBSTONE')
  f.heldLeft.resolveRight(true)
  await f.leftSession.close()
  t.is(await code(opening), 'ROUTE_UNAVAILABLE')
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
})

test('signed cancel after responder OPEN cannot tear down established link', async (t) => {
  const f = await fixture()
  await f.leftSession.open()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const request = f.leftAdapter.sockets[0].sends[0].packet
  const codec = new BootstrapEnvelopeCodec({
    linkHandle: f.left.linkHandle,
    localIdentitySecretKey: f.initiator.secretKey,
    padding: sequence(0xb1)
  })
  const cancel = codec.encode({
    type: BOOTSTRAP_TYPE.LINK_CANCEL,
    requestId: readU64(request, 4),
    epoch: f.common.epoch,
    rejectedType: BOOTSTRAP_TYPE.LINK_CREATE,
    requestPacket: request
  })
  t.is(await f.rightSession.receive(cancel), false)
  t.is(f.rightSession.state, 'OPEN')
  codec.destroy()
  await f.leftSession.close()
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
})

test('synchronous abort listener cannot continue into timer or packet dispatch', async (t) => {
  const f = await fixture({ dropLeft: true })
  const signal = {
    aborted: false,
    addEventListener(name, listener) {
      if (name === 'abort') {
        this.aborted = true
        listener()
      }
    },
    removeEventListener() {}
  }
  t.is(await code(f.leftSession.open({ signal })), 'ROUTE_UNAVAILABLE')
  t.is(f.leftSession.state, 'TOMBSTONE')
  t.is(f.leftAdapter.sockets[0].sends.length, 0)
  await f.leftSession.close()
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
})

test('already-aborted open invalidates the pending endpoint authority', async (t) => {
  const f = await fixture({ dropLeft: true })
  const before = f.leftEndpoint.openLink(f.left.linkHandle)
  const controller = abortController()
  controller.abort()
  t.is(await code(f.leftSession.open({ signal: controller.signal })), 'ROUTE_UNAVAILABLE')
  const after = f.leftEndpoint.openLink(f.left.linkHandle)
  t.not(after, before)
  const bootstrap = b4a.alloc(1200)
  bootstrap[1] = 0x80
  f.leftAdapter.sockets[0].emitMessage(bootstrap, '127.0.0.12', 46112)
  t.is(f.leftSession.state, 'TOMBSTONE')
  t.is(f.leftAdapter.sockets[0].sends.length, 0)
  await f.leftSession.close()
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
})

test('throwing abort-listener removal cannot escape or strand the opening promise', async (t) => {
  const f = await fixture({ dropLeft: true })
  let listener
  const signal = {
    aborted: false,
    addEventListener(name, value) {
      if (name === 'abort') listener = value
    },
    removeEventListener() {
      throw new Error('hostile remove')
    }
  }
  const opening = f.leftSession.open({ signal })
  signal.aborted = true
  let escaped = false
  try {
    listener()
  } catch {
    escaped = true
  }
  t.is(escaped, false)
  if (!escaped) t.is(await code(opening), 'ROUTE_UNAVAILABLE')
  else void opening.catch(() => {})
  await f.leftSession.close()
  await f.rightSession.close()
  await f.leftEndpoint.close()
  await f.rightEndpoint.close()
  f.left.directory.destroy()
  f.right.directory.destroy()
})
