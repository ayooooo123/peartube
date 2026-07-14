import test from 'brittle'
import b4a from 'b4a'

import {
  AUTHORIZATION_MODE,
  CAPABILITY,
  CELL_CLASS,
  DIRECTION,
  LINK_CONTROL_KIND,
  LINK_OPERATION,
  MAX_ROUTE_PAYLOAD,
  PROTOCOL_VERSION,
  ROLE,
  ROUTE_FRAME_SIZE,
  CellCodec,
  DatagramReplayWindow,
  LinkDirectory,
  OrderedReceiver,
  RemoteControlMux,
  RouteManager,
  RoutePayloadCodec,
  SenderCounter,
  TOPOLOGY_ROLE,
  UdxCellEndpoint,
  VirtualNetwork,
  createRouteCompilerAuthority,
  createSafetyInstallerAuthority,
  createCompiledRouteDuplex,
  cryptoSuite,
  encodeDescriptor,
  encodeRelayAdvertisement,
  signDescriptor,
  signRelayAdvertisement,
  signTopologyGrant,
  verifyDescriptor
} from '../index.js'
import {
  failCompiledRouteDuplex,
  mintCompiledRouteReady,
  readCompiledRouteDuplexStats,
  receiveCompiledRouteCell,
  replaceCompiledRouteDuplex
} from '../lib/compiled-route-duplex.js'
import { mintCreatedRoutePayloadContext, ROUTE_ENDPOINT } from '../lib/route-payload.js'
import { UDX_LINK_OPEN, UDX_SEND_CELL } from '../lib/udx-adapter.js'
import { FakeUdxAdapter } from './fake-udx.js'
import {
  descriptorChecker,
  expectCode,
  privateRoleIdentity,
  safetyRoleIdentity,
  seed
} from './helpers.js'

const MAX_UINT63 = (1n << 63n) - 1n

function scheduler(clock) {
  const records = new Set()
  return {
    records,
    schedule(callback, delay) {
      const record = { callback, at: clock.now + delay }
      records.add(record)
      return record
    },
    cancel(record) {
      records.delete(record)
    },
    async advance(milliseconds) {
      clock.now += milliseconds
      for (;;) {
        const due = Array.from(records)
          .filter((record) => record.at <= clock.now)
          .sort((left, right) => left.at - right.at)[0]
        if (!due) break
        records.delete(due)
        due.callback()
        await Promise.resolve()
      }
    }
  }
}

function routePair(marker, options = {}) {
  const keys = cryptoSuite.deriveKeys(seed(marker), b4a.from(`compiled-duplex-${marker}`))
  const common = {
    descriptorId: options.descriptorId || seed(marker + 1),
    circuitId: options.circuitId || b4a.alloc(16, marker + 2),
    ...keys
  }
  function create(endpointRole) {
    return new RoutePayloadCodec({
      crypto: cryptoSuite,
      context: mintCreatedRoutePayloadContext({ endpointRole, ...common }),
      window: 64,
      gapTimeout: 5_000,
      now: () => 0,
      padding: (size) => b4a.alloc(size),
      ...(options.senderInitial === undefined ? {} : { senderInitial: options.senderInitial })
    })
  }
  return {
    source: create(ROUTE_ENDPOINT.SOURCE),
    destination: create(ROUTE_ENDPOINT.DESTINATION)
  }
}

function endpointFixture(options = {}) {
  const marker = options.marker || 20
  const clock = { now: 1_000 }
  const timers = scheduler(clock)
  const authority = cryptoSuite.keyPair(seed(marker + 10))
  const local = cryptoSuite.keyPair(seed(marker + 11))
  const peer = safetyRoleIdentity(marker + 12)
  const runId32 = seed(marker + 13)
  const epoch = options.epoch || 17n
  const circuitId = options.circuitId || b4a.alloc(16, marker + 14)
  const grant = signTopologyGrant(
    {
      version: PROTOCOL_VERSION,
      format: 0,
      grantId32: seed(marker + 15),
      endpointA: {
        identity32: local.publicKey,
        role: TOPOLOGY_ROLE.SOURCE,
        host: '127.0.0.41',
        port: 47441,
        operations: LINK_OPERATION.INITIATE
      },
      endpointB: {
        identity32: peer.publicKey,
        role: TOPOLOGY_ROLE.SAFETY_GUARD,
        host: '127.0.0.42',
        port: 47442,
        operations: LINK_OPERATION.ACCEPT
      },
      epoch,
      notBefore: 0n,
      expiresAt: 100_000n,
      runId32
    },
    authority.secretKey
  )
  const directory = new LinkDirectory({
    localIdentity32: local.publicKey,
    localRole: TOPOLOGY_ROLE.SOURCE,
    authorityPublicKey: authority.publicKey,
    epoch,
    runId32,
    now: () => BigInt(clock.now),
    schedule: timers.schedule,
    cancel: timers.cancel,
    onClose() {}
  })
  const digest32 = directory.add(grant)
  const linkHandle = directory.authorize({
    digest32,
    operation: LINK_OPERATION.INITIATE,
    localIdentity32: local.publicKey,
    localRole: TOPOLOGY_ROLE.SOURCE,
    peerIdentity32: peer.publicKey,
    peerRole: TOPOLOGY_ROLE.SAFETY_GUARD,
    epoch,
    runId32
  })
  const adapter = options.adapter || new FakeUdxAdapter(options.adapterOptions)
  let duplex = null
  const endpoint = new UdxCellEndpoint({
    adapter,
    host: '127.0.0.41',
    port: 47441,
    onBootstrap() {},
    onCell(payload, handle, metadata) {
      return receiveCompiledRouteCell(duplex, handle, payload, metadata)
    },
    onLinkFailure() {
      if (duplex) failCompiledRouteDuplex(duplex)
    }
  })
  const contexts = {}
  for (const cellClass of [CELL_CLASS.CONTROL, CELL_CLASS.STREAM, CELL_CLASS.DATAGRAM]) {
    contexts[cellClass] = {
      tx: {
        key: b4a.alloc(32, 0xa0 + cellClass),
        noncePrefix: b4a.alloc(16, 0xb0 + cellClass),
        counter: new SenderCounter()
      },
      rx: {
        key: b4a.alloc(32, 0xc0 + cellClass),
        noncePrefix: b4a.alloc(16, 0xd0 + cellClass),
        counter:
          cellClass === CELL_CLASS.DATAGRAM
            ? new DatagramReplayWindow({ window: 256 })
            : new OrderedReceiver({ window: 256, gapTimeout: 5_000, now: () => clock.now })
      }
    }
  }
  const remoteCounters = {
    [CELL_CLASS.CONTROL]: new SenderCounter(),
    [CELL_CLASS.STREAM]: new SenderCounter(),
    [CELL_CLASS.DATAGRAM]: new SenderCounter()
  }
  const remoteLogical = { stream: 0n }
  const outboundReceivers = {
    [CELL_CLASS.STREAM]: new OrderedReceiver({
      window: 256,
      gapTimeout: 5_000,
      now: () => clock.now
    }),
    [CELL_CLASS.DATAGRAM]: new DatagramReplayWindow({ window: 256 })
  }
  return {
    adapter,
    circuitId,
    clock,
    contexts,
    directory,
    endpoint,
    epoch,
    linkHandle,
    remoteCounters,
    remoteLogical,
    outboundReceivers,
    timers,
    setDuplex(value) {
      duplex = value
    }
  }
}

function remoteCell(f, cellClass, payload, generation = 1n, logical = 0n) {
  const prefix = cellClass === CELL_CLASS.CONTROL ? 0 : cellClass === CELL_CLASS.STREAM ? 16 : 8
  const framed = b4a.alloc(prefix + payload.byteLength)
  if (cellClass !== CELL_CLASS.CONTROL) {
    let value = generation
    for (let index = 7; index >= 0; index--) {
      framed[index] = Number(value & 0xffn)
      value >>= 8n
    }
    if (cellClass === CELL_CLASS.STREAM) {
      value = logical
      for (let index = 15; index >= 8; index--) {
        framed[index] = Number(value & 0xffn)
        value >>= 8n
      }
    }
  }
  framed.set(payload, prefix)
  try {
    return new CellCodec({ crypto: cryptoSuite, cellSize: 1_200 }).seal({
      key: f.contexts[cellClass].rx.key,
      noncePrefix: f.contexts[cellClass].rx.noncePrefix,
      senderCounter: f.remoteCounters[cellClass],
      class: cellClass,
      direction: DIRECTION.REVERSE,
      epoch: f.epoch,
      circuitId: f.circuitId,
      payload: framed
    })
  } finally {
    framed.fill(0)
  }
}

function acknowledge(f, generation, counter) {
  const payload = new RemoteControlMux().encodeLink(
    {
      version: PROTOCOL_VERSION,
      kind: LINK_CONTROL_KIND.STREAM_ACK,
      flags: 0,
      direction: DIRECTION.REVERSE,
      circuitId: f.circuitId,
      generation,
      acknowledgedDirection: DIRECTION.FORWARD,
      counter
    },
    { class: CELL_CLASS.CONTROL, direction: DIRECTION.REVERSE, circuitId: f.circuitId }
  )
  f.adapter.sockets[0].emitMessage(
    remoteCell(f, CELL_CLASS.CONTROL, payload, 0n),
    '127.0.0.42',
    47442
  )
  payload.fill(0)
}

function decodeOutbound(f, packet, cellClass) {
  const value = new CellCodec({ crypto: cryptoSuite, cellSize: 1_200 }).open(
    {
      key: f.contexts[cellClass].tx.key,
      noncePrefix: f.contexts[cellClass].tx.noncePrefix,
      receiver: f.outboundReceivers[cellClass],
      expectedClass: cellClass,
      expectedDirection: DIRECTION.FORWARD,
      expectedEpoch: f.epoch,
      expectedCircuitId: f.circuitId
    },
    packet
  )
  return (Array.isArray(value) ? value[0] : value).subarray(
    cellClass === CELL_CLASS.STREAM ? 16 : 8
  )
}

async function readyFixture(options = {}) {
  const f = endpointFixture(options)
  const routes = routePair((options.marker || 20) + 40, {
    ...options.routeOptions,
    circuitId: f.circuitId,
    ...(options.descriptorId === undefined ? {} : { descriptorId: options.descriptorId })
  })
  await f.endpoint.bind()
  const handle = f.endpoint.openLink(f.linkHandle)
  f.endpoint[UDX_LINK_OPEN](handle, {
    linkState: { circuitId: f.circuitId, epoch: f.epoch, contexts: f.contexts },
    mode: 'initiate',
    now: () => f.clock.now,
    schedule: f.timers.schedule,
    cancel: f.timers.cancel,
    randomBytes: (size) => b4a.alloc(size, 0xe2)
  })
  const circuitContext = options.circuitContext || Object.freeze({})
  const ready = mintCompiledRouteReady({
    endpoint: f.endpoint,
    handle,
    routePayload: routes.source,
    generation: options.generation || 1n,
    direction: DIRECTION.FORWARD,
    circuitContext
  })
  return { ...f, ...routes, circuitContext, handle, ready }
}

async function fixture(options = {}) {
  const f = await readyFixture(options)
  const duplex = createCompiledRouteDuplex({
    ready: f.ready,
    schedule: f.timers.schedule,
    cancel: f.timers.cancel,
    ...options.limits
  })
  f.setDuplex(duplex)
  return { ...f, duplex }
}

async function close(f) {
  await f.duplex.destroy()
  f.destination.destroy()
  await f.endpoint.close()
  f.directory.destroy()
}

async function settle() {
  for (let index = 0; index < 100; index++) await Promise.resolve()
}

test('compiled live route exposes only the bounded duplex surface', async (t) => {
  const f = await fixture()
  t.alike(Object.keys(f.duplex).sort(), [
    'destroy',
    'drain',
    'read',
    'receiveDatagram',
    'sendDatagram',
    'write'
  ])
  t.is(Object.isFrozen(f.duplex), true)
  for (const forbidden of [
    'host',
    'port',
    'socket',
    'udx',
    'linkGrant',
    'actor',
    'dial',
    'directDial',
    'fallback'
  ]) {
    t.is(f.duplex[forbidden], undefined, forbidden)
  }
  expectCode(
    t,
    () =>
      createCompiledRouteDuplex({
        ready: Object.freeze(Object.create(null)),
        schedule() {},
        cancel() {}
      }),
    'INVALID_ROUTE'
  )
  expectCode(
    t,
    () =>
      createCompiledRouteDuplex({
        ready: f.ready,
        schedule: f.timers.schedule,
        cancel: f.timers.cancel
      }),
    'INVALID_ROUTE'
  )
  await close(f)
})

test('authenticated CREATED route material can mint exactly one generation', async (t) => {
  const f = await readyFixture({ marker: 25 })
  expectCode(
    t,
    () =>
      mintCompiledRouteReady({
        endpoint: f.endpoint,
        handle: f.handle,
        routePayload: f.source,
        generation: 2n,
        direction: DIRECTION.FORWARD,
        circuitContext: f.circuitContext
      }),
    'UNAUTHORIZED'
  )
  const duplex = createCompiledRouteDuplex({
    ready: f.ready,
    schedule: f.timers.schedule,
    cancel: f.timers.cancel
  })
  f.setDuplex(duplex)
  f.duplex = duplex
  t.is(f.duplex.write(b4a.from('sole-generation')), true)
  await close(f)
})

test('stream writes preserve ordering through the maximum eight route fragments', async (t) => {
  const f = await fixture({ marker: 30 })
  const payload = b4a.alloc(MAX_ROUTE_PAYLOAD * 8)
  for (let index = 0; index < payload.byteLength; index++) payload[index] = index & 0xff
  t.is(f.duplex.write(payload), true)
  await settle()
  const packets = f.adapter.sockets[0].sends.filter(({ packet }) => packet[1] === CELL_CLASS.STREAM)
  t.is(packets.length, 8)
  const chunks = []
  for (const { packet } of packets) {
    const frame = decodeOutbound(f, packet, CELL_CLASS.STREAM)
    t.is(frame.byteLength, ROUTE_FRAME_SIZE)
    const deliveries = f.destination.open({ direction: DIRECTION.FORWARD }, frame)
    chunks.push(...deliveries.map(({ payload }) => payload))
  }
  t.alike(b4a.concat(chunks), payload)
  for (const chunk of chunks) chunk.fill(0)
  const drained = f.duplex.drain()
  let resolved = false
  drained.then(() => {
    resolved = true
  })
  await settle()
  t.is(resolved, false, 'first-hop send completion is not an ACK')
  acknowledge(f, 1n, 7n)
  await f.timers.advance(1)
  await drained
  t.pass('drain is hop-by-hop backpressure, not an end-to-end application read receipt')
  payload.fill(0)
  await close(f)
})

test('datagrams are atomic and oversize input consumes no route or link counter', async (t) => {
  const f = await fixture({ marker: 40 })
  const before = f.source.stats.forward.datagramSenderNext
  expectCode(t, () => f.duplex.sendDatagram(b4a.alloc(MAX_ROUTE_PAYLOAD + 1)), 'INVALID_ROUTE')
  t.is(f.source.stats.forward.datagramSenderNext, before)
  t.is(f.adapter.sockets[0].sends.length, 0)
  const payload = b4a.alloc(MAX_ROUTE_PAYLOAD, 0x41)
  t.is(f.duplex.sendDatagram(payload), true)
  await settle()
  const packets = f.adapter.sockets[0].sends.filter(
    ({ packet }) => packet[1] === CELL_CLASS.DATAGRAM
  )
  t.is(packets.length, 1)
  const opened = f.destination.open(
    { direction: DIRECTION.FORWARD },
    decodeOutbound(f, packets[0].packet, CELL_CLASS.DATAGRAM)
  )
  t.alike(opened.payload, payload)
  opened.payload.fill(0)
  payload.fill(0)
  await close(f)
})

test('local queue high water rejects without partial admission and drain waits below low water', async (t) => {
  const sends = []
  const f = await fixture({
    marker: 50,
    adapterOptions: {
      send() {
        return new Promise((resolve) => sends.push(resolve))
      }
    },
    limits: { maxQueuedBytes: MAX_ROUTE_PAYLOAD, lowWaterMark: MAX_ROUTE_PAYLOAD }
  })
  t.is(f.duplex.write(b4a.alloc(MAX_ROUTE_PAYLOAD, 1)), true)
  t.is(f.duplex.write(b4a.from('blocked')), false)
  const drained = f.duplex.drain()
  acknowledge(f, 1n, 0n)
  await f.timers.advance(1)
  let resolved = false
  drained.then(() => {
    resolved = true
  })
  await settle()
  t.is(resolved, false, 'ACK alone cannot bypass the local low-water boundary')
  sends.shift()(true)
  await settle()
  await f.timers.advance(1)
  await drained
  await close(f)
})

test('drain ignores unrelated generation accounting and requires its exact cumulative ACK', async (t) => {
  const f = await fixture({ marker: 55 })
  t.is(f.duplex.write(b4a.from('owned-generation')), true)
  t.is(
    await f.endpoint[UDX_SEND_CELL](f.handle, {
      class: CELL_CLASS.STREAM,
      direction: DIRECTION.FORWARD,
      generation: 99n,
      payload: b4a.alloc(ROUTE_FRAME_SIZE)
    }),
    true
  )
  const drained = f.duplex.drain()
  acknowledge(f, 1n, 0n)
  await f.timers.advance(1)
  let resolved = false
  drained.then(() => {
    resolved = true
  })
  await settle()
  t.is(resolved, true, 'another generation cannot block the captured generation ACK')
  if (resolved) await drained
  else {
    const rejected = t.exception(drained, /Route is unavailable/)
    failCompiledRouteDuplex(f.duplex)
    await rejected
  }
  await close(f)
})

test('equivalent drain calls share one bounded retained barrier', async (t) => {
  const f = await fixture({ marker: 57 })
  t.is(f.duplex.write(b4a.from('one-captured-counter')), true)
  const first = f.duplex.drain()
  const duplicates = Array.from({ length: 64 }, () => f.duplex.drain())
  t.ok(duplicates.every((value) => value === first))
  t.is(readCompiledRouteDuplexStats(f.duplex).drains, 1)
  acknowledge(f, 1n, 0n)
  await f.timers.advance(1)
  await Promise.all([first, ...duplicates])
  await close(f)
})

test('distinct captured drain barriers have a strict retained cap', async (t) => {
  const f = await fixture({ marker: 58 })
  const drains = []
  for (let index = 0; index < 8; index++) {
    t.is(f.duplex.write(b4a.from([index])), true)
    drains.push(f.duplex.drain())
    await settle()
  }
  t.is(readCompiledRouteDuplexStats(f.duplex).drains, 8)
  t.is(f.duplex.write(b4a.from('ninth')), true)
  await t.exception(f.duplex.drain(), /Circuit limit was reached/)
  const rejected = drains.map((value) => t.exception(value, /Route is unavailable/))
  failCompiledRouteDuplex(f.duplex)
  await Promise.all(rejected)
  await close(f)
})

test('authenticated reverse stream and datagram cells preserve type and ordering', async (t) => {
  const f = await fixture({ marker: 60 })
  for (const value of ['reverse-one', 'reverse-two']) {
    const frame = f.destination.seal({
      class: CELL_CLASS.STREAM,
      direction: DIRECTION.REVERSE,
      payload: b4a.from(value)
    })
    f.adapter.sockets[0].emitMessage(
      remoteCell(f, CELL_CLASS.STREAM, frame, 1n, f.remoteLogical.stream++),
      '127.0.0.42',
      47442
    )
    frame.fill(0)
  }
  const datagram = f.destination.seal({
    class: CELL_CLASS.DATAGRAM,
    direction: DIRECTION.REVERSE,
    payload: b4a.from('atomic-reverse')
  })
  f.adapter.sockets[0].emitMessage(
    remoteCell(f, CELL_CLASS.DATAGRAM, datagram, 1n),
    '127.0.0.42',
    47442
  )
  datagram.fill(0)
  t.alike(f.duplex.read(), b4a.from('reverse-one'))
  t.alike(f.duplex.read(), b4a.from('reverse-two'))
  t.is(f.duplex.read(), null)
  t.alike(f.duplex.receiveDatagram(), b4a.from('atomic-reverse'))
  t.is(f.duplex.receiveDatagram(), null)
  await close(f)
})

test('stream and datagram ingress limits remain independent', async (t) => {
  const f = await fixture({ marker: 62, limits: { maxReadFragments: 1 } })
  const stream = f.destination.seal({
    class: CELL_CLASS.STREAM,
    direction: DIRECTION.REVERSE,
    payload: b4a.from('stream-full')
  })
  f.adapter.sockets[0].emitMessage(
    remoteCell(f, CELL_CLASS.STREAM, stream, 1n, f.remoteLogical.stream++),
    '127.0.0.42',
    47442
  )
  stream.fill(0)
  const datagram = f.destination.seal({
    class: CELL_CLASS.DATAGRAM,
    direction: DIRECTION.REVERSE,
    payload: b4a.from('datagram-independent')
  })
  f.adapter.sockets[0].emitMessage(
    remoteCell(f, CELL_CLASS.DATAGRAM, datagram, 1n),
    '127.0.0.42',
    47442
  )
  datagram.fill(0)
  t.alike(f.duplex.read(), b4a.from('stream-full'))
  t.alike(f.duplex.receiveDatagram(), b4a.from('datagram-independent'))
  await close(f)
})

test('authenticated outer cell class must match the decrypted route class', async (t) => {
  const f = await fixture({ marker: 63 })
  const innerDatagram = f.destination.seal({
    class: CELL_CLASS.DATAGRAM,
    direction: DIRECTION.REVERSE,
    payload: b4a.from('class-confusion')
  })
  f.adapter.sockets[0].emitMessage(
    remoteCell(f, CELL_CLASS.STREAM, innerDatagram, 1n, f.remoteLogical.stream++),
    '127.0.0.42',
    47442
  )
  innerDatagram.fill(0)
  t.is(readCompiledRouteDuplexStats(f.duplex).closed, true)
  expectCode(t, () => f.duplex.receiveDatagram(), 'CIRCUIT_STATE')
  await close(f)
})

test('out-of-order inner route data is never hop-ACKed or retained outside duplex accounting', async (t) => {
  const f = await fixture({ marker: 65 })
  const zero = f.destination.seal({
    class: CELL_CLASS.STREAM,
    direction: DIRECTION.REVERSE,
    payload: b4a.from('zero')
  })
  const one = f.destination.seal({
    class: CELL_CLASS.STREAM,
    direction: DIRECTION.REVERSE,
    payload: b4a.from('one')
  })
  const before = f.adapter.sockets[0].sends.length
  f.adapter.sockets[0].emitMessage(
    remoteCell(f, CELL_CLASS.STREAM, one, 1n, 0n),
    '127.0.0.42',
    47442
  )
  await settle()
  t.is(f.adapter.sockets[0].sends.length, before, 'no STREAM_ACK precedes read-queue admission')
  t.alike(readCompiledRouteDuplexStats(f.duplex), {
    generation: 1n,
    closed: true,
    queuedBytes: 0,
    queuedFragments: 0,
    readBytes: 0,
    readFragments: 0,
    datagramBytes: 0,
    datagrams: 0,
    drains: 0,
    timers: 0
  })
  zero.fill(0)
  one.fill(0)
  await close(f)
})

test('route counter exhaustion fails closed and destroy is reentrant and idempotent', async (t) => {
  const f = await fixture({
    marker: 70,
    routeOptions: { senderInitial: MAX_UINT63 }
  })
  t.is(f.duplex.write(b4a.from('last-counter')), true)
  expectCode(t, () => f.duplex.write(b4a.from('exhausted')), 'COUNTER_EXHAUSTED')
  const first = f.duplex.destroy()
  const second = f.duplex.destroy()
  t.is(first, second)
  await first
  expectCode(t, () => f.duplex.read(), 'CIRCUIT_STATE')
  f.destination.destroy()
  await f.endpoint.close()
  f.directory.destroy()
})

test('replacement rejects old-generation drain and cannot reuse its route object', async (t) => {
  const f = await fixture({ marker: 80 })
  t.is(f.duplex.write(b4a.from('old-generation')), true)
  const drained = f.duplex.drain()
  replaceCompiledRouteDuplex(f.duplex, 2n)
  await t.exception(drained, /Route is unavailable/)
  expectCode(t, () => f.duplex.write(b4a.from('must-not-reopen')), 'CIRCUIT_STATE')
  const stats = readCompiledRouteDuplexStats(f.duplex)
  t.is(stats.generation, 1n)
  t.is(stats.closed, true)
  await close(f)
})

test('unacknowledged first-hop stream rejects drain at the authenticated ACK deadline', async (t) => {
  const f = await fixture({ marker: 90 })
  t.is(f.duplex.write(b4a.from('never-acked')), true)
  const drained = f.duplex.drain()
  await settle()
  for (let elapsed = 0; elapsed < 5_000; elapsed += 400) {
    const frame = f.destination.seal({
      class: CELL_CLASS.DATAGRAM,
      direction: DIRECTION.REVERSE,
      payload: b4a.from('liveness')
    })
    f.adapter.sockets[0].emitMessage(
      remoteCell(f, CELL_CLASS.DATAGRAM, frame, 1n),
      '127.0.0.42',
      47442
    )
    frame.fill(0)
    await f.timers.advance(Math.min(400, 5_000 - elapsed))
  }
  await t.exception(drained, /Route is unavailable/)
  t.is(readCompiledRouteDuplexStats(f.duplex).closed, true)
  await close(f)
})

test('close clears every retained plaintext and exact queue accounting', async (t) => {
  const f = await fixture({ marker: 100 })
  const reverse = f.destination.seal({
    class: CELL_CLASS.STREAM,
    direction: DIRECTION.REVERSE,
    payload: b4a.from('retained-read')
  })
  f.adapter.sockets[0].emitMessage(
    remoteCell(f, CELL_CLASS.STREAM, reverse, 1n, 0n),
    '127.0.0.42',
    47442
  )
  reverse.fill(0)
  t.is(f.duplex.write(b4a.from('retained-write-accounting')), true)
  await f.duplex.destroy()
  t.alike(readCompiledRouteDuplexStats(f.duplex), {
    generation: 1n,
    closed: true,
    queuedBytes: 0,
    queuedFragments: 0,
    readBytes: 0,
    readFragments: 0,
    datagramBytes: 0,
    datagrams: 0,
    drains: 0,
    timers: 0
  })
  f.destination.destroy()
  await f.endpoint.close()
  f.directory.destroy()
})

function managerAdvertisement(pair, dial, overrides = {}) {
  const route = cryptoSuite.encryptionKeyPair(seed(dial.charCodeAt(0)))
  return signRelayAdvertisement(
    {
      version: PROTOCOL_VERSION,
      identityKey: pair.publicKey,
      routeEncryptionKey: route.publicKey,
      dial: b4a.from(dial),
      role: ROLE.SAFETY,
      capabilities: CAPABILITY.KNOWN,
      epoch: 7n,
      expiresAt: 10_000n,
      ...overrides
    },
    pair.secretKey
  )
}

function managerDescriptor() {
  const endpoint = cryptoSuite.keyPair(seed(220))
  const descriptorId = seed(222)
  const entry = privateRoleIdentity(1)
  const entryAdvertisement = managerAdvertisement(entry, 'entry', { role: ROLE.PRIVATE })
  const signed = signDescriptor(
    {
      version: PROTOCOL_VERSION,
      authorizationMode: AUTHORIZATION_MODE.DIRECT,
      descriptorId,
      endpointKey: endpoint.publicKey,
      routeSigningKey: endpoint.publicKey,
      routeEncryptionKey: cryptoSuite.encryptionKeyPair(seed(223)).publicKey,
      entryAdvertisement: encodeRelayAdvertisement(entryAdvertisement),
      epoch: 7n,
      expiresAt: 9_000n,
      capabilities: CAPABILITY.KNOWN,
      cellSize: 1_200,
      encryptedHops: b4a.from('opaque')
    },
    endpoint.secretKey
  )
  return {
    descriptorId,
    verified: verifyDescriptor(encodeDescriptor(signed), {
      requestedEndpointKey: endpoint.publicKey,
      now: 1_000n
    })
  }
}

function managerFor(compile, options = {}) {
  const circuitContext = options.circuitContext || Object.freeze({})
  const circuitId = options.circuitId || b4a.alloc(16, 0xf1)
  const installed = {
    authenticate() {},
    install() {},
    rollback() {},
    finalize() {
      return {
        transcriptHash32: seed(250),
        attachEntry() {},
        sendControl() {},
        sendFrame() {},
        sendReverseFrame() {},
        destroy() {}
      }
    }
  }
  const installer = createSafetyInstallerAuthority()
  const compiler = createRouteCompilerAuthority()
  const crypto = Object.freeze({
    verify: cryptoSuite.verify,
    randomBytes(size) {
      return size === 16 ? b4a.from(circuitId) : cryptoSuite.randomBytes(size)
    }
  })
  return new RouteManager({
    network: new VirtualNetwork({ now: 1_000 }),
    registry: { allows: () => true },
    crypto,
    clock: () => 1_000,
    descriptorChecker: descriptorChecker(),
    circuitIssuer: { issueFinalSafety: () => circuitContext },
    safetyInstaller: installer.issuer.issue(installed),
    safetyInstallerChecker: installer.checker,
    safetyRouteChecker: installer.routeChecker,
    routeCompiler: compiler.issuer.issue(compile),
    routeCompilerChecker: compiler.checker,
    limits: { maxSafetyHops: 3 }
  })
}

test('RouteManager returns only an already authenticated live duplex and rejects async half-open output', async (t) => {
  const f = await fixture({ marker: 110 })
  const safety = [
    encodeRelayAdvertisement(managerAdvertisement(safetyRoleIdentity(1), 'guard-live'))
  ]
  const { descriptorId, verified: descriptor } = managerDescriptor()
  const substituted = managerFor(() => f.duplex)
  expectCode(t, () => substituted.open({ safety, descriptor }), 'INVALID_ROUTE')
  t.is(readCompiledRouteDuplexStats(f.duplex).closed, true)
  const circuitId = b4a.alloc(16, 0xf2)
  const circuitContext = Object.freeze({})
  const correct = await fixture({
    marker: 120,
    circuitId,
    circuitContext,
    descriptorId,
    epoch: 7n
  })
  const halfOpen = managerFor(() => Promise.resolve(correct.duplex), {
    circuitId,
    circuitContext
  })
  expectCode(t, () => halfOpen.open({ safety, descriptor }), 'INVALID_ROUTE')
  const manager = managerFor(() => correct.duplex, { circuitId, circuitContext })
  t.is(manager.open({ safety, descriptor }), correct.duplex)
  t.is(correct.duplex.write(b4a.from('post-created-only')), true)
  await close(f)
  await close(correct)
})
