import test from 'brittle'
import b4a from 'b4a'

import * as publicApi from '../index.js'
import {
  MAX_ROUTE_PAYLOAD,
  createPrivateDestinationActor,
  createPrivateRelayActor,
  createDestinationReplayCache,
  createRemoteActivationVerifier,
  createRemoteRegistrationVerifier,
  decodeTopologyGrant,
  destroyPrivateDestinationActor,
  destroyPrivateRelayActor,
  verifyTopologyGrant
} from '../index.js'
import {
  LIVE_ROUTE_ACTIVATE_ENDPOINT,
  LIVE_ROUTE_CREATE_CONTROL,
  LIVE_ROUTE_REGISTER_ACTOR
} from '../lib/live-route-node.js'
import { UdxAdapter } from '../lib/udx-adapter.js'
import {
  LIVE_ROUTE_CONTACTS,
  LIVE_ROUTE_KNOWLEDGE,
  LIVE_ROUTE_ROLES,
  createLiveRouteFixture
} from './live-route-fixture.js'
import { FakeUdxAdapter } from './fake-udx.js'

function scheduler() {
  const records = new Set()
  return {
    records,
    schedule(callback) {
      records.add(callback)
      return callback
    },
    cancel(callback) {
      records.delete(callback)
    }
  }
}

class TracedUdxAdapter {
  constructor(role, transmissions) {
    this.role = role
    this.transmissions = transmissions
  }

  create() {
    const udx = new UdxAdapter().create()
    return {
      createSocket: () => {
        const socket = udx.createSocket()
        const wrapped = {
          on(name, listener) {
            socket.on(name, listener)
            return wrapped
          },
          bind(port, host) {
            return socket.bind(port, host)
          },
          send: (packet, port, host) => {
            this.transmissions.push({
              from: this.role,
              host,
              port,
              bytes: packet.byteLength,
              cellClass: packet[1]
            })
            return socket.send(packet, port, host)
          },
          close() {
            return socket.close()
          }
        }
        return wrapped
      }
    }
  }
}

async function waitForValue(read, deadline = Date.now() + 5_000) {
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() >= deadline) throw new Error('live route delivery deadline exceeded')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function privateActorGraph(fixture) {
  const destinationProjection = fixture.projections.get('destination')
  const destination = createPrivateDestinationActor({
    identity: destinationProjection.local.identity32,
    identitySecretKey: destinationProjection.local.identitySecretKey,
    routeSigningKey: destinationProjection.route.routeSigningKey,
    routeSigningSecretKey: destinationProjection.route.routeSigningSecretKey,
    routeEncryptionSecretKey: destinationProjection.route.routeEncryptionSecretKey,
    finalToken: destinationProjection.route.finalToken,
    now: Date.now,
    randomBytes: publicApi.cryptoSuite.randomBytes
  })
  const relays = []
  let next = destination
  for (const role of ['private-final', 'private-middle', 'private-entry']) {
    const projection = fixture.projections.get(role)
    const relay = createPrivateRelayActor({
      identity: projection.local.identity32,
      identitySecretKey: projection.local.identitySecretKey,
      routeEncryptionSecretKey: projection.local.routeEncryptionSecretKey,
      ...(role === 'private-final' ? { destination: next } : { next }),
      now: Date.now,
      randomBytes: publicApi.cryptoSuite.randomBytes
    })
    relays.unshift(relay)
    next = relay
  }
  return {
    entry: relays[0],
    destroy() {
      for (const relay of relays) destroyPrivateRelayActor(relay)
      destroyPrivateDestinationActor(destination)
    }
  }
}

test('live route fixture emits exact isolated role projections', (t) => {
  const fixture = createLiveRouteFixture()
  t.alike(Array.from(fixture.projections.keys()), LIVE_ROUTE_ROLES)
  for (const role of LIVE_ROUTE_ROLES) {
    const projection = fixture.projections.get(role)
    t.is(projection.role, role, role)
    t.alike(
      projection.known.map((value) => value.role),
      LIVE_ROUTE_KNOWLEDGE[role],
      `${role} knowledge`
    )
    t.alike(
      projection.contacts.map((value) => value.role),
      LIVE_ROUTE_CONTACTS[role],
      `${role} direct contacts`
    )
    t.is(projection.grants.length, LIVE_ROUTE_CONTACTS[role].length, `${role} grants`)
    t.is('path' in projection, false, `${role} has no path`)
    t.is('projections' in projection, false, `${role} has no coordinator view`)
    t.is('addresses' in projection, false, `${role} has no address map`)
    t.is(
      Boolean(projection.route.payload),
      role === 'source' || role === 'destination',
      `${role} end-to-end payload material`
    )
    const local = projection.local.identity32
    for (const encoding of projection.grants) {
      verifyTopologyGrant(encoding, projection.linkAuthorityPublicKey, {
        localIdentity32: local,
        now: 1_000n
      })
      const grant = decodeTopologyGrant(encoding)
      const peer = b4a.equals(grant.endpointA.identity32, local)
        ? grant.endpointB.identity32
        : grant.endpointA.identity32
      t.ok(
        projection.contacts.some((contact) => b4a.equals(contact.identity32, peer)),
        `${role} grant is adjacent`
      )
    }
  }
})

test('public live route node composition surface exists', (t) => {
  t.is(typeof publicApi.createLiveRouteNode, 'function')
})

test('one live route node binds one socket and reports only redacted resources', async (t) => {
  const fixture = createLiveRouteFixture()
  const timers = scheduler()
  const adapter = new FakeUdxAdapter()
  const events = []
  const node = publicApi.createLiveRouteNode(fixture.projections.get('source'), {
    adapter,
    now: () => 1_000,
    schedule: timers.schedule,
    cancel: timers.cancel,
    randomBytes: (size) => b4a.alloc(size, 0x41),
    observe: (event) => events.push(event)
  })
  t.alike(Object.keys(node).sort(), ['connect', 'snapshot', 'start', 'stop'])
  t.alike(node.snapshot(), {
    role: 'source',
    state: 'NEW',
    links: 0,
    counters: { queuedPackets: 0, queuedBytes: 0, inFlightSends: 0 },
    resources: { bindings: 0, waits: 0, timers: 0, openSockets: 0 }
  })
  await node.start()
  t.is(adapter.sockets.length, 1)
  t.alike(adapter.sockets[0].binds, [{ host: '127.0.0.51', port: 48_100 }])
  t.alike(node.snapshot(), {
    role: 'source',
    state: 'READY',
    links: 0,
    counters: { queuedPackets: 0, queuedBytes: 0, inFlightSends: 0 },
    resources: { bindings: 1, waits: 0, timers: 1, openSockets: 1 }
  })
  t.ok(events.every((event) => !JSON.stringify(event).includes('127.0.0.')))
  await node.stop()
  t.alike(node.snapshot(), {
    role: 'source',
    state: 'CLOSED',
    links: 0,
    counters: { queuedPackets: 0, queuedBytes: 0, inFlightSends: 0 },
    resources: { bindings: 0, waits: 0, timers: 0, openSockets: 0 }
  })
  t.is(adapter.sockets[0].closeCalls, 1)
})

test('live route connect failure closes every owned resource', async (t) => {
  const fixture = createLiveRouteFixture()
  const adapter = new FakeUdxAdapter()
  let rejectSchedules = false
  const timers = new Set()
  const node = publicApi.createLiveRouteNode(fixture.projections.get('source'), {
    adapter,
    now: () => 1_000,
    schedule(callback) {
      if (rejectSchedules) throw new Error('injected scheduler failure')
      timers.add(callback)
      return callback
    },
    cancel(callback) {
      timers.delete(callback)
    },
    randomBytes: (size) => b4a.alloc(size, 0x42)
  })
  await node.start()
  rejectSchedules = true
  let code = null
  try {
    await node.connect()
  } catch (err) {
    code = err && err.code
  }
  t.is(code, 'ROUTE_UNAVAILABLE')
  t.is(node.snapshot().state, 'CLOSED')
  t.alike(node.snapshot().resources, {
    bindings: 0,
    waits: 0,
    timers: 0,
    openSockets: 0
  })
  t.is(adapter.sockets[0].closeCalls, 1)
})

test('seven live route nodes authenticate exactly six real UDX adjacencies', async (t) => {
  t.timeout(10_000)
  const platform = typeof Bare === 'undefined' ? process.platform : Bare.platform
  const forceDistinct =
    typeof process !== 'undefined' && process.env.PRIVATE_ROUTES_DISTINCT_LOOPBACK === '1'
  const random = publicApi.cryptoSuite.randomBytes(2)
  const portBase = 49_000 + ((random[0] * 256 + random[1]) % 1_000)
  random.fill(0)
  const startedAt = BigInt(Date.now())
  const fixture = createLiveRouteFixture({
    portBase,
    distinctHosts: platform !== 'darwin' || forceDistinct,
    now: startedAt,
    expiresAt: startedAt + 30_000n
  })
  const transmissions = []
  const nodes = LIVE_ROUTE_ROLES.map((role, index) => {
    let value = 0x51 + index * 7
    return publicApi.createLiveRouteNode(fixture.projections.get(role), {
      adapter: new TracedUdxAdapter(role, transmissions),
      now: Date.now,
      schedule: setTimeout,
      cancel: clearTimeout,
      randomBytes(size) {
        return b4a.alloc(size, value++)
      }
    })
  })
  let actors = null
  let control = null
  try {
    await Promise.all(nodes.map((node) => node.start()))
    const connected = await Promise.all(nodes.map((node) => node.connect()))
    for (let index = 0; index < nodes.length; index++) {
      const snapshot = nodes[index].snapshot()
      t.is(snapshot.state, 'OPEN', LIVE_ROUTE_ROLES[index])
      t.is(snapshot.links, LIVE_ROUTE_CONTACTS[LIVE_ROUTE_ROLES[index]].length)
      t.is(snapshot.resources.openSockets, 1)
    }
    const source = connected[0]
    const destination = connected.at(-1)
    t.alike(Object.keys(source).sort(), [
      'destroy',
      'drain',
      'read',
      'receiveDatagram',
      'sendDatagram',
      'write'
    ])
    t.alike(Object.keys(destination).sort(), Object.keys(source).sort())
    t.ok(connected.slice(1, -1).every((value) => value === true))
    let preCreatedCode = null
    try {
      source.write(b4a.from('must not leave before CREATED'))
    } catch (err) {
      preCreatedCode = err && err.code
    }
    t.is(preCreatedCode, 'CIRCUIT_STATE')

    actors = privateActorGraph(fixture)
    const sourceRoute = fixture.projections.get('source').route
    nodes[3][LIVE_ROUTE_REGISTER_ACTOR](sourceRoute.entryActorId, actors.entry)
    control = nodes[0][LIVE_ROUTE_CREATE_CONTROL](sourceRoute.entryActorId)
    const registered = await control.register({
      stage: sourceRoute.registrationCapsule,
      prepare: sourceRoute.prepareCapsule,
      finalize: sourceRoute.finalizeCapsule,
      abort: sourceRoute.abortCapsule,
      registrationVerifier: createRemoteRegistrationVerifier({
        request: sourceRoute.registrationCapsule,
        registrations: sourceRoute.registrations
      })
    })
    t.is(registered.registered, true)
    t.ok(registered.acknowledgements.byteLength > 0)
    registered.acknowledgements.fill(0)
    const activation = sourceRoute.activation
    const proof = await control.activate({
      body: activation.body,
      circuitId: activation.circuitId,
      generation: activation.generation,
      activationVerifier: createRemoteActivationVerifier({
        request: activation.body,
        circuitId: activation.circuitId,
        generation: activation.generation,
        entryIdentity: activation.entryIdentity,
        entryRouteEncryptionKey: activation.entryRouteEncryptionKey,
        endpointIdentity: activation.endpointIdentity,
        routeSigningKey: activation.routeSigningKey,
        destinationRouteEncryptionKey: activation.destinationRouteEncryptionKey,
        sourceEphemeralSecretKey: activation.sourceEphemeralSecretKey,
        entryChallenge: activation.entryChallenge,
        destinationChallenge: activation.destinationChallenge,
        replayCache: createDestinationReplayCache({ now: Date.now }),
        now: Date.now
      })
    })
    t.ok(proof.byteLength > 305, 'authenticated entry and destination CREATED proof')
    proof.fill(0)
    t.is(nodes[0][LIVE_ROUTE_ACTIVATE_ENDPOINT](), source)
    t.is(nodes[6][LIVE_ROUTE_ACTIVATE_ENDPOINT](), destination)

    const sourceStream = b4a.from('source stream one|source stream two')
    const destinationStream = b4a.from('destination stream one|destination stream two')
    const sourceDatagram = b4a.alloc(MAX_ROUTE_PAYLOAD, 0x71)
    const destinationDatagram = b4a.alloc(MAX_ROUTE_PAYLOAD, 0x72)
    t.is(source.write(sourceStream.subarray(0, 17)), true)
    t.is(source.write(sourceStream.subarray(17)), true)
    t.is(destination.write(destinationStream.subarray(0, 22)), true)
    t.is(destination.write(destinationStream.subarray(22)), true)
    t.is(source.sendDatagram(sourceDatagram), true)
    t.is(destination.sendDatagram(destinationDatagram), true)

    const receivedAtDestination = [
      await waitForValue(() => destination.read()),
      await waitForValue(() => destination.read())
    ]
    const receivedAtSource = [
      await waitForValue(() => source.read()),
      await waitForValue(() => source.read())
    ]
    t.alike(b4a.concat(receivedAtDestination), sourceStream)
    t.alike(b4a.concat(receivedAtSource), destinationStream)
    t.alike(await waitForValue(() => destination.receiveDatagram()), sourceDatagram)
    t.alike(await waitForValue(() => source.receiveDatagram()), destinationDatagram)
    t.is(destination.receiveDatagram(), null, 'source datagram delivered exactly once')
    t.is(source.receiveDatagram(), null, 'destination datagram delivered exactly once')
    await Promise.all([source.drain(), destination.drain()])
    t.pass('both first-hop stream queues received authenticated cumulative ACKs')

    const roleByPort = new Map(
      LIVE_ROUTE_ROLES.map((role) => {
        const bind = fixture.projections.get(role).bind
        return [`${bind.host}:${bind.port}`, role]
      })
    )
    const directed = new Set()
    for (const transmission of transmissions) {
      const to = roleByPort.get(`${transmission.host}:${transmission.port}`)
      directed.add(`${transmission.from}>${to}`)
    }
    t.ok(
      transmissions.every((value) => value.bytes === 1_200),
      'every native UDX transmission is exactly one fixed-size cell'
    )
    t.ok(
      transmissions.every((value) => roleByPort.has(`${value.host}:${value.port}`)),
      'every native UDX transmission targets one projected role'
    )
    t.ok(
      transmissions.every((value) => {
        const to = roleByPort.get(`${value.host}:${value.port}`)
        return LIVE_ROUTE_CONTACTS[value.from].includes(to)
      }),
      'every native UDX transmission stays on an authorized adjacent link'
    )
    t.alike(
      Array.from(new Set(transmissions.map((value) => value.cellClass))).sort(
        (left, right) => left - right
      ),
      [0, 1, 2, 128],
      'trace covers bootstrap, control, stream, and datagram cells'
    )
    const expectedDirected = []
    for (let index = 0; index < LIVE_ROUTE_ROLES.length - 1; index++) {
      const left = LIVE_ROUTE_ROLES[index]
      const right = LIVE_ROUTE_ROLES[index + 1]
      expectedDirected.push(`${left}>${right}`, `${right}>${left}`)
    }
    t.alike(
      Array.from(directed).sort(),
      expectedDirected.sort(),
      'exactly six bilateral adjacencies'
    )

    for (const value of [...receivedAtDestination, ...receivedAtSource]) value.fill(0)
    sourceStream.fill(0)
    destinationStream.fill(0)
    sourceDatagram.fill(0)
    destinationDatagram.fill(0)
  } finally {
    if (control) await control.stop()
    await Promise.all(nodes.reverse().map((node) => node.stop()))
    if (actors) actors.destroy()
  }
  for (const node of nodes) {
    t.alike(node.snapshot().resources, {
      bindings: 0,
      waits: 0,
      timers: 0,
      openSockets: 0
    })
  }
})
