import test from 'brittle'
import b4a from 'b4a'

import * as routes from '../index.js'
import {
  LINK_OPERATION,
  LinkDirectory,
  PROTOCOL_VERSION,
  TOPOLOGY_ROLE,
  UdxCellEndpoint,
  BootstrapEnvelopeCodec,
  createLinkSetupAuthority,
  cryptoSuite,
  signTopologyGrant
} from '../index.js'
import { FakeUdxAdapter } from './fake-udx.js'
import { expectCode, safetyRoleIdentity, seed } from './helpers.js'
import { UDX_LINK_CLOSE, UDX_LINK_OPEN, selectUdxLoopbackHosts } from '../lib/udx-adapter.js'

function clock() {
  let id = 0
  return {
    now: () => 1_000n,
    schedule: () => ++id,
    cancel() {}
  }
}

function fixture(options = {}) {
  const authority = cryptoSuite.keyPair(seed(240))
  const local = cryptoSuite.keyPair(seed(241))
  const peer = safetyRoleIdentity(242)
  const runId32 = seed(243)
  const epoch = 7n
  const grant = signTopologyGrant(
    {
      version: PROTOCOL_VERSION,
      format: 0,
      grantId32: seed(244),
      endpointA: {
        identity32: local.publicKey,
        role: TOPOLOGY_ROLE.SOURCE,
        host: '127.0.0.11',
        port: 45111,
        operations: LINK_OPERATION.INITIATE
      },
      endpointB: {
        identity32: peer.publicKey,
        role: TOPOLOGY_ROLE.SAFETY_GUARD,
        host: '127.0.0.12',
        port: 45112,
        operations: LINK_OPERATION.ACCEPT
      },
      epoch,
      notBefore: 900n,
      expiresAt: 10_000n,
      runId32
    },
    authority.secretKey
  )
  const c = clock()
  const directory = new LinkDirectory({
    localIdentity32: local.publicKey,
    localRole: TOPOLOGY_ROLE.SOURCE,
    authorityPublicKey: authority.publicKey,
    epoch,
    runId32,
    now: c.now,
    schedule: c.schedule,
    cancel: c.cancel,
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
  const received = []
  const endpoint = new UdxCellEndpoint({
    adapter,
    host: '127.0.0.11',
    port: 45111,
    maxQueuedPackets: options.maxQueuedPackets || 2,
    maxQueuedBytes: options.maxQueuedBytes || 2400,
    maxInboundPackets: options.maxInboundPackets,
    maxInboundBytes: options.maxInboundBytes,
    maxInboundPacketsPerPeer: options.maxInboundPacketsPerPeer,
    maxInboundBytesPerPeer: options.maxInboundBytesPerPeer,
    onBootstrap:
      options.onBootstrap || ((packet, handle) => received.push(['bootstrap', packet, handle])),
    onCell: options.onCell || ((packet, handle) => received.push(['cell', packet, handle]))
  })
  return {
    adapter,
    directory,
    endpoint,
    linkHandle,
    received,
    authority,
    local,
    peer,
    runId32,
    epoch,
    digest32
  }
}

async function errorCode(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err && err.code
  }
}

function openHandle(endpoint, linkHandle) {
  const handle = endpoint.openLink(linkHandle)
  endpoint[UDX_LINK_OPEN](handle)
  return handle
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

test('endpoint owns one socket, binds explicitly, and exposes no dialing surface', async (t) => {
  const f = fixture()
  t.alike(Object.getOwnPropertyNames(UdxCellEndpoint.prototype), [
    'constructor',
    'queuedPackets',
    'queuedBytes',
    'inFlightSends',
    'bind',
    'openLink',
    'send',
    'close'
  ])
  await f.endpoint.bind()
  t.is(f.adapter.instances, 1)
  t.is(f.adapter.sockets.length, 1)
  t.alike(f.adapter.sockets[0].binds, [{ port: 45111, host: '127.0.0.11' }])
  const handle = openHandle(f.endpoint, f.linkHandle)
  t.is(Object.keys(handle).length, 0)
  t.is(await f.endpoint.send(handle, b4a.alloc(1200, 1)), true)
  t.alike(f.adapter.sockets[0].sends[0], {
    packet: b4a.alloc(1200, 1),
    port: 45112,
    host: '127.0.0.12'
  })
  t.is(
    await errorCode(f.endpoint.send({ host: '127.0.0.12', port: 45112 }, b4a.alloc(1200))),
    'UNAUTHORIZED'
  )
  t.is('trySend' in f.endpoint, false)
  t.is('UdxAdapter' in routes, false)
  await f.endpoint.close()
})

test('loopback selection requires distinct IPv4 aliases off explicit macOS fallback', (t) => {
  t.alike(selectUdxLoopbackHosts({ platform: 'linux' }), ['127.0.0.1', '127.0.0.2'])
  t.alike(selectUdxLoopbackHosts({ platform: 'darwin' }), ['127.0.0.1', '127.0.0.1'])
  t.alike(selectUdxLoopbackHosts({ platform: 'darwin', forceDistinct: true }), [
    '127.0.0.1',
    '127.0.0.2'
  ])
})

test('established packets cannot send or dispatch until authenticated OPEN', async (t) => {
  const f = fixture()
  await f.endpoint.bind()
  const handle = f.endpoint.openLink(f.linkHandle)
  const cell = b4a.alloc(1200)
  cell[1] = 1
  t.is(await errorCode(f.endpoint.send(handle, cell)), 'CIRCUIT_STATE')
  f.adapter.sockets[0].emitMessage(cell, '127.0.0.12', 45112)
  t.is(f.received.length, 0)
  await f.endpoint.close()
})

test('failed session construction publishes no pending source authority', async (t) => {
  for (const sessionOptions of [null, {}]) {
    const f = fixture()
    await f.endpoint.bind()
    let code = null
    try {
      f.endpoint.openLink(f.linkHandle, sessionOptions)
    } catch (err) {
      code = err && err.code
    }
    t.is(code, 'INVALID_ROUTE')
    const bootstrap = b4a.alloc(1200)
    bootstrap[1] = 0x80
    f.adapter.sockets[0].emitMessage(bootstrap, '127.0.0.12', 45112)
    t.is(f.received.length, 0)
    await f.endpoint.close()
  }
})

test('endpoint rejects a bootstrap codec authorized by a different grant capability', async (t) => {
  const f = fixture()
  await f.endpoint.bind()
  const alternateGrant = signTopologyGrant(
    {
      version: PROTOCOL_VERSION,
      format: 0,
      grantId32: seed(246),
      endpointA: {
        identity32: f.local.publicKey,
        role: TOPOLOGY_ROLE.SOURCE,
        host: '127.0.0.11',
        port: 45111,
        operations: LINK_OPERATION.INITIATE
      },
      endpointB: {
        identity32: f.peer.publicKey,
        role: TOPOLOGY_ROLE.SAFETY_GUARD,
        host: '127.0.0.12',
        port: 45112,
        operations: LINK_OPERATION.ACCEPT
      },
      epoch: f.epoch,
      notBefore: 900n,
      expiresAt: 10_000n,
      runId32: f.runId32
    },
    f.authority.secretKey
  )
  const alternateDigest = f.directory.add(alternateGrant)
  const alternateHandle = f.directory.authorize({
    digest32: alternateDigest,
    operation: LINK_OPERATION.INITIATE,
    localIdentity32: f.local.publicKey,
    localRole: TOPOLOGY_ROLE.SOURCE,
    peerIdentity32: f.peer.publicKey,
    peerRole: TOPOLOGY_ROLE.SAFETY_GUARD,
    epoch: f.epoch,
    runId32: f.runId32
  })
  const codec = new BootstrapEnvelopeCodec({
    linkHandle: alternateHandle,
    localIdentitySecretKey: f.local.secretKey,
    padding: (size) => b4a.alloc(size)
  })
  expectCode(
    t,
    () =>
      f.endpoint.openLink(f.linkHandle, {
        mode: 'initiate',
        codec,
        linkSetup: createLinkSetupAuthority({ now: () => 1_000, randomBytes: seed }),
        setup: {},
        now: () => 1_000,
        schedule: () => 1,
        cancel() {},
        randomBytes: seed
      }),
    'UNAUTHORIZED'
  )
  codec.destroy()
  await f.endpoint.close()
})

test('endpoint rejects DNS names, wildcards, and invalid numeric addresses before binding', (t) => {
  for (const host of ['localhost', '', '127.0.0.999', ':::', '2001:db8::1::2']) {
    expectCode(
      t,
      () =>
        new UdxCellEndpoint({
          adapter: new FakeUdxAdapter(),
          host,
          port: 45111,
          onBootstrap() {},
          onCell() {}
        }),
      'INVALID_ROUTE'
    )
  }
})

test('send queue copies ownership, bounds packets/bytes, and handles cancellation', async (t) => {
  const releases = []
  const adapter = new FakeUdxAdapter({
    send(call) {
      return new Promise((resolve) => releases.push(() => resolve(true)))
    }
  })
  const f = fixture({ adapter })
  await f.endpoint.bind()
  const handle = openHandle(f.endpoint, f.linkHandle)
  const first = b4a.alloc(1200, 3)
  const a = f.endpoint.send(handle, first)
  first.fill(9)
  const controller = abortController()
  const b = f.endpoint.send(handle, b4a.alloc(1200, 4), { signal: controller.signal })
  t.is(f.endpoint.queuedPackets, 1)
  t.is(f.endpoint.queuedBytes, 1200)
  t.is(await errorCode(f.endpoint.send(handle, b4a.alloc(1200, 5))), 'CIRCUIT_LIMIT')
  controller.abort()
  t.is(await errorCode(b), 'ROUTE_UNAVAILABLE')
  t.alike(adapter.sockets[0].sends[0].packet, b4a.alloc(1200, 3))
  releases.shift()()
  t.is(await a, true)
  await f.endpoint.close()
  t.is(f.endpoint.queuedPackets, 0)
  t.is(f.endpoint.queuedBytes, 0)
  t.is(f.endpoint.inFlightSends, 0)
})

test('all non-true native results fail and close waits for in-flight before socket close', async (t) => {
  for (const send of [
    () => false,
    () => undefined,
    () => {
      throw new Error('sync')
    },
    () => Promise.reject(new Error('no'))
  ]) {
    const f = fixture({ adapterOptions: { send } })
    await f.endpoint.bind()
    const handle = openHandle(f.endpoint, f.linkHandle)
    t.is(await errorCode(f.endpoint.send(handle, b4a.alloc(1200))), 'ROUTE_UNAVAILABLE')
    await f.endpoint.close()
  }

  let finish
  const events = []
  const f = fixture({
    adapterOptions: {
      send() {
        events.push('send')
        return new Promise((resolve) => (finish = resolve))
      },
      close() {
        events.push('close')
      }
    }
  })
  await f.endpoint.bind()
  const handle = openHandle(f.endpoint, f.linkHandle)
  const sending = errorCode(f.endpoint.send(handle, b4a.alloc(1200)))
  const closing = f.endpoint.close()
  await Promise.resolve()
  t.alike(events, ['send'])
  finish(true)
  t.is(await sending, 'ROUTE_UNAVAILABLE')
  await closing
  t.alike(events, ['send', 'close'])
  t.is(await errorCode(f.endpoint.send(handle, b4a.alloc(1200))), 'CIRCUIT_STATE')
})

test('reentrant socket error cannot close before native send wait is registered', async (t) => {
  let finish
  const events = []
  const f = fixture({
    adapterOptions: {
      send(call, socket) {
        events.push('send')
        socket.emitError(new Error('reentrant'))
        return new Promise((resolve) => {
          finish = resolve
        })
      },
      close() {
        events.push('close')
      }
    }
  })
  await f.endpoint.bind()
  const handle = openHandle(f.endpoint, f.linkHandle)
  const sending = errorCode(f.endpoint.send(handle, b4a.alloc(1200, 1)))
  await Promise.resolve()
  t.alike(events, ['send'])
  finish(true)
  t.is(await sending, 'ROUTE_UNAVAILABLE')
  await f.endpoint.close()
  t.alike(events, ['send', 'close'])
})

test('in-flight cancellation tombstones native completion and reentrant sends stay ordered', async (t) => {
  let finish
  let endpoint
  let handle
  let reentrant
  const adapter = new FakeUdxAdapter({
    send(call, socket) {
      if (socket.sends.length === 1) {
        reentrant = endpoint.send(handle, b4a.alloc(1200, 8))
        return new Promise((resolve) => (finish = resolve))
      }
      return true
    }
  })
  const f = fixture({ adapter })
  endpoint = f.endpoint
  await endpoint.bind()
  handle = openHandle(endpoint, f.linkHandle)
  const controller = abortController()
  const first = endpoint.send(handle, b4a.alloc(1200, 7), { signal: controller.signal })
  controller.abort()
  finish(true)
  t.is(await errorCode(first), 'ROUTE_UNAVAILABLE')
  t.is(await reentrant, true)
  t.alike(
    adapter.sockets[0].sends.map((send) => send.packet[0]),
    [7, 8]
  )
  await endpoint.close()
})

test('link invalidation drains queued sends and tombstones native completion', async (t) => {
  let finish
  const f = fixture({
    adapterOptions: {
      send() {
        return new Promise((resolve) => {
          finish = resolve
        })
      }
    }
  })
  await f.endpoint.bind()
  const handle = openHandle(f.endpoint, f.linkHandle)
  const first = f.endpoint.send(handle, b4a.alloc(1200, 1))
  const queued = f.endpoint.send(handle, b4a.alloc(1200, 2))
  f.endpoint[UDX_LINK_CLOSE](handle)
  t.is(f.endpoint.queuedPackets, 0)
  t.is(await errorCode(queued), 'UNAUTHORIZED')
  finish(true)
  t.is(await errorCode(first), 'ROUTE_UNAVAILABLE')
  t.is(f.endpoint.inFlightSends, 0)
  await f.endpoint.close()
})

test('revoked link handles cannot send or receive', async (t) => {
  const f = fixture()
  await f.endpoint.bind()
  const handle = openHandle(f.endpoint, f.linkHandle)
  const before = b4a.alloc(1200)
  before[1] = 1
  f.adapter.sockets[0].emitMessage(before, '127.0.0.12', 45112)
  t.is(f.received.length, 1)
  const digest32 = f.directory.add(
    signTopologyGrant(
      {
        version: PROTOCOL_VERSION,
        format: 0,
        grantId32: seed(244),
        endpointA: {
          identity32: cryptoSuite.keyPair(seed(241)).publicKey,
          role: TOPOLOGY_ROLE.SOURCE,
          host: '127.0.0.11',
          port: 45111,
          operations: LINK_OPERATION.INITIATE
        },
        endpointB: {
          identity32: safetyRoleIdentity(242).publicKey,
          role: TOPOLOGY_ROLE.SAFETY_GUARD,
          host: '127.0.0.12',
          port: 45112,
          operations: LINK_OPERATION.ACCEPT
        },
        epoch: 7n,
        notBefore: 900n,
        expiresAt: 10_000n,
        runId32: seed(243)
      },
      cryptoSuite.keyPair(seed(240)).secretKey
    )
  )
  f.directory.revoke({ digest32, epoch: 7n, runId32: seed(243) })
  t.is(await errorCode(f.endpoint.send(handle, b4a.alloc(1200))), 'UNAUTHORIZED')
  f.adapter.sockets[0].emitMessage(before, '127.0.0.12', 45112)
  t.is(f.received.length, 1)
  await f.endpoint.close()
})

test('revoked source mapping cannot block a replacement grant for the same address', async (t) => {
  const f = fixture()
  await f.endpoint.bind()
  f.endpoint.openLink(f.linkHandle)
  f.directory.revoke({ digest32: f.digest32, epoch: f.epoch, runId32: f.runId32 })
  const replacement = signTopologyGrant(
    {
      version: PROTOCOL_VERSION,
      format: 0,
      grantId32: seed(245),
      endpointA: {
        identity32: f.local.publicKey,
        role: TOPOLOGY_ROLE.SOURCE,
        host: '127.0.0.11',
        port: 45111,
        operations: LINK_OPERATION.INITIATE
      },
      endpointB: {
        identity32: f.peer.publicKey,
        role: TOPOLOGY_ROLE.SAFETY_GUARD,
        host: '127.0.0.12',
        port: 45112,
        operations: LINK_OPERATION.ACCEPT
      },
      epoch: f.epoch,
      notBefore: 900n,
      expiresAt: 10_000n,
      runId32: f.runId32
    },
    f.authority.secretKey
  )
  const digest32 = f.directory.add(replacement)
  const linkHandle = f.directory.authorize({
    digest32,
    operation: LINK_OPERATION.INITIATE,
    localIdentity32: f.local.publicKey,
    localRole: TOPOLOGY_ROLE.SOURCE,
    peerIdentity32: f.peer.publicKey,
    peerRole: TOPOLOGY_ROLE.SAFETY_GUARD,
    epoch: f.epoch,
    runId32: f.runId32
  })
  let replacementHandle = null
  let replacementError = null
  try {
    replacementHandle = f.endpoint.openLink(linkHandle)
  } catch (err) {
    replacementError = err
  }
  t.is(replacementError && replacementError.code, null)
  if (replacementHandle) t.is(Object.keys(replacementHandle).length, 0)
  await f.endpoint.close()
})

test('receive pins exact adjacent source before fixed-size class dispatch', async (t) => {
  const f = fixture()
  await f.endpoint.bind()
  const handle = openHandle(f.endpoint, f.linkHandle)
  const socket = f.adapter.sockets[0]
  socket.emitMessage(b4a.alloc(1200, 0), '127.0.0.99', 45112)
  socket.emitMessage(b4a.alloc(1200, 0), '127.0.0.12', 45113)
  socket.emitMessage(b4a.alloc(1199), '127.0.0.12', 45112)
  const bootstrap = b4a.alloc(1200)
  bootstrap[1] = 0x80
  socket.emitMessage(bootstrap, '127.0.0.12', 45112)
  const established = b4a.alloc(1200)
  established[1] = 1
  socket.emitMessage(established, '127.0.0.12', 45112)
  t.is(f.received.length, 2)
  t.is(f.received[0][0], 'bootstrap')
  t.is(f.received[0][2], handle)
  t.is(f.received[1][0], 'cell')
  await f.endpoint.close()
})

test('received packet copy is cleared after an async handler settles', async (t) => {
  let captured
  let settle
  const f = fixture({
    onCell(packet) {
      captured = packet
      return new Promise((resolve) => {
        settle = resolve
      })
    }
  })
  await f.endpoint.bind()
  openHandle(f.endpoint, f.linkHandle)
  const packet = b4a.alloc(1200, 0x44)
  packet[0] = 0
  packet[1] = 1
  f.adapter.sockets[0].emitMessage(packet, '127.0.0.12', 45112)
  packet.fill(0x99)
  t.is(captured[2], 0x44)
  settle()
  await Promise.resolve()
  await Promise.resolve()
  t.alike(captured, b4a.alloc(1200))
  await f.endpoint.close()
})

test('close waits bounded receive ownership and preserves bytes until slow handler settles', async (t) => {
  let captured
  let settle
  const f = fixture({
    onCell(packet) {
      captured = packet
      return new Promise((resolve) => {
        settle = resolve
      })
    }
  })
  await f.endpoint.bind()
  openHandle(f.endpoint, f.linkHandle)
  const packet = b4a.alloc(1200, 0x55)
  packet[0] = 0
  packet[1] = 1
  f.adapter.sockets[0].emitMessage(packet, '127.0.0.12', 45112)
  let closed = false
  const closing = f.endpoint.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 5_025))
  t.is(closed, false)
  t.is(captured[2], 0x55)
  settle()
  await closing
  t.alike(captured, b4a.alloc(1200))
})

test('inbound packet and byte ownership bounds drop excess until settlement', async (t) => {
  const variants = [
    { maxInboundPackets: 2, maxInboundBytes: 3600 },
    { maxInboundPackets: 3, maxInboundBytes: 2400 },
    {
      maxInboundPackets: 3,
      maxInboundBytes: 3600,
      maxInboundPacketsPerPeer: 2,
      maxInboundBytesPerPeer: 3600
    },
    {
      maxInboundPackets: 3,
      maxInboundBytes: 3600,
      maxInboundPacketsPerPeer: 3,
      maxInboundBytesPerPeer: 2400
    }
  ]
  for (const limits of variants) {
    const releases = []
    let calls = 0
    const f = fixture({
      ...limits,
      onCell() {
        calls++
        return new Promise((resolve) => releases.push(resolve))
      }
    })
    await f.endpoint.bind()
    openHandle(f.endpoint, f.linkHandle)
    const packet = b4a.alloc(1200)
    packet[1] = 1
    const socket = f.adapter.sockets[0]
    socket.emitMessage(packet, '127.0.0.12', 45112)
    socket.emitMessage(packet, '127.0.0.12', 45112)
    socket.emitMessage(packet, '127.0.0.12', 45112)
    t.is(calls, 2)
    releases.shift()()
    await Promise.resolve()
    await Promise.resolve()
    socket.emitMessage(packet, '127.0.0.12', 45112)
    t.is(calls, 3)
    for (const release of releases) release()
    await f.endpoint.close()
  }
})

test('synchronous handler-triggered close awaits its pre-registered receive ownership', async (t) => {
  let endpoint
  let captured
  let settle
  let closing
  let closed = false
  const f = fixture({
    onCell(packet) {
      captured = packet
      closing = endpoint.close().then(() => {
        closed = true
      })
      return new Promise((resolve) => {
        settle = resolve
      })
    }
  })
  endpoint = f.endpoint
  await endpoint.bind()
  openHandle(endpoint, f.linkHandle)
  const packet = b4a.alloc(1200)
  packet[1] = 1
  f.adapter.sockets[0].emitMessage(packet, '127.0.0.12', 45112)
  await Promise.resolve()
  t.is(closed, false)
  t.is(captured[2], 0)
  captured[2] = 0x55
  settle()
  await closing
  t.alike(captured, b4a.alloc(1200))
  t.is(f.adapter.sockets[0].closeCalls, 1)
})
