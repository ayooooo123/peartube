import test from 'brittle'
import b4a from 'b4a'

import {
  ACTOR_CONTROL_KIND,
  ASYNC_CIRCUIT_STATE,
  AUTHORIZATION_MODE,
  CAPABILITY,
  CELL_CLASS,
  CIRCUIT_DESTROY_REASON,
  CellCodec,
  CONTROL_NAMESPACE,
  DIRECTION,
  LINK_OPERATION,
  LINK_CONTROL_KIND,
  LINK_PING_AFTER,
  LINK_UNRESPONSIVE_AFTER,
  PROTOCOL_VERSION,
  ROLE,
  STREAM_ACK_TIMEOUT,
  AsyncRouteControlSession,
  LinkCircuitTeardown,
  LinkControlSession,
  LinkDirectory,
  SenderCounter,
  OrderedReceiver,
  DatagramReplayWindow,
  UdxCellEndpoint,
  TOPOLOGY_ROLE,
  PrivateRouteError,
  RemoteControlMux,
  activationChallengeCipher,
  buildPrivateTemplates,
  createDestinationReplayCache,
  createOpenCircuitDirectionCapability,
  createRemoteActivationVerifier,
  cryptoSuite,
  encodeActivationRequest,
  encodeCreate,
  encodeRelayAdvertisement,
  hashCreateBase,
  signRelayAdvertisement,
  signTopologyGrant
} from '../index.js'
import { createLinkControlBoundary } from '../lib/link-control-session.js'
import { createRemoteActorHostTestDouble } from '../lib/remote-actor-host.js'
import { UDX_LINK_OPEN, UDX_LINK_STATS, UDX_SEND_CELL } from '../lib/udx-adapter.js'
import { FakeUdxAdapter } from './fake-udx.js'
import { privateRoleIdentity, safetyRoleIdentity, seed } from './helpers.js'

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

function sequenceBytes(start) {
  let value = start
  return (size) => b4a.alloc(size, value++)
}

function openCircuitFixture(start, clock, audit, { dropDestroy = true } = {}) {
  const circuitId = b4a.alloc(16, start + 1)
  const owner = cryptoSuite.keyPair(seed(start + 200))
  const descriptorId = seed(start + 201)
  const relayIdentity = privateRoleIdentity(start)
  const relayEncryption = cryptoSuite.encryptionKeyPair(seed(start + 80))
  const destinationEncryption = cryptoSuite.encryptionKeyPair(seed(start + 202))
  const source = cryptoSuite.encryptionKeyPair(seed(start + 203))
  const finalToken = b4a.alloc(64, 0xfe)
  const entryChallenge = seed(start + 205)
  const destinationChallenge = seed(start + 206)
  const advertisement = signRelayAdvertisement(
    {
      version: PROTOCOL_VERSION,
      identityKey: relayIdentity.publicKey,
      routeEncryptionKey: relayEncryption.publicKey,
      dial: b4a.from(`link-teardown-${start}`),
      role: ROLE.PRIVATE,
      capabilities: CAPABILITY.KNOWN,
      epoch: 7n,
      expiresAt: 10_000n
    },
    relayIdentity.secretKey
  )
  const built = buildPrivateTemplates({
    descriptorId,
    epoch: 7n,
    expiresAt: 9_000n,
    endpointKey: owner.publicKey,
    routeSigningKey: owner.publicKey,
    authorizationMode: AUTHORIZATION_MODE.DIRECT,
    destinationSecretKey: owner.secretKey,
    relays: [encodeRelayAdvertisement(advertisement)],
    randomBytes: sequenceBytes(start + 10),
    finalToken,
    now: 1_000n
  })
  const createValue = {
    version: PROTOCOL_VERSION,
    circuitId,
    epoch: 7n,
    descriptorId,
    sourceEphemeralKey: source.publicKey,
    safetyTranscriptHash: seed(start + 204),
    entryChallengeCipher: b4a.alloc(48),
    destinationChallengeCipher: b4a.alloc(48),
    encryptedHops: built.encryptedHops
  }
  const base = hashCreateBase(createValue)
  const entryShared = cryptoSuite.keyAgreement(source.secretKey, relayEncryption.publicKey)
  const destinationShared = cryptoSuite.keyAgreement(
    source.secretKey,
    destinationEncryption.publicKey
  )
  createValue.entryChallengeCipher = activationChallengeCipher(entryShared, base, entryChallenge, 0)
  createValue.destinationChallengeCipher = activationChallengeCipher(
    destinationShared,
    base,
    destinationChallenge,
    1
  )
  const create = encodeCreate(createValue)
  const body = encodeActivationRequest({
    entry: true,
    create,
    layer: b4a.alloc(0),
    expiresAt: 9_000n,
    startedAt: 1_000,
    parameters: {
      version: PROTOCOL_VERSION,
      cellSize: 1200,
      routeFrameSize: 1100,
      maxCellPayload: 1146,
      maxRoutePayload: 1073,
      capabilities: 7,
      safetyMin: 1,
      safetyMax: 3,
      privateMin: 1,
      privateMax: 3,
      counterWindow: 64
    },
    entryProof: b4a.alloc(0)
  })
  const verifier = createRemoteActivationVerifier({
    request: body,
    circuitId,
    generation: 1n,
    entryIdentity: relayIdentity.publicKey,
    entryRouteEncryptionKey: relayEncryption.publicKey,
    endpointIdentity: owner.publicKey,
    routeSigningKey: owner.publicKey,
    destinationRouteEncryptionKey: destinationEncryption.publicKey,
    sourceEphemeralSecretKey: source.secretKey,
    entryChallenge,
    destinationChallenge,
    replayCache: createDestinationReplayCache({ now: () => clock.now }),
    now: () => clock.now
  })
  const remote = createRemoteActorHostTestDouble(
    (kind, _actorId, requestedCircuitId, generation, request, options) => {
      audit.push({
        kind,
        circuitId: b4a.from(requestedCircuitId),
        generation,
        reason: kind === ACTOR_CONTROL_KIND.CIRCUIT_DESTROY ? request[0] : null
      })
      if (kind === ACTOR_CONTROL_KIND.ACTIVATE_CREATE) return Promise.resolve(b4a.alloc(305, 2))
      if (kind !== ACTOR_CONTROL_KIND.CIRCUIT_DESTROY)
        return Promise.reject(PrivateRouteError.INVALID_ROUTE())
      if (!dropDestroy) return Promise.resolve(b4a.alloc(0))
      return new Promise((resolve, reject) => {
        const abort = () => reject(PrivateRouteError.ROUTE_UNAVAILABLE())
        options.signal.addEventListener('abort', abort, { once: true })
      })
    }
  )
  const session = new AsyncRouteControlSession({
    remote,
    actorId: b4a.alloc(16, start + 2),
    now: () => clock.now
  })
  const opened = session.activate({ body, circuitId, generation: 1n, activationVerifier: verifier })
  for (const value of [
    owner.secretKey,
    relayIdentity.secretKey,
    relayEncryption.secretKey,
    destinationEncryption.secretKey,
    source.secretKey,
    finalToken,
    entryChallenge,
    destinationChallenge,
    base,
    entryShared,
    destinationShared,
    create,
    createValue.entryChallengeCipher,
    createValue.destinationChallengeCipher,
    body
  ])
    value.fill(0)
  return { opened, session, remote }
}

function errorCode(operation) {
  try {
    const result = operation()
    if (result && typeof result.then === 'function')
      return result.then(
        () => null,
        (err) => err.code
      )
    return null
  } catch (err) {
    return err && err.code
  }
}

function fixture(overrides = {}) {
  const clock = overrides.clock || { now: 10_000 }
  const timers = overrides.timers || scheduler(clock)
  const link = Object.freeze({})
  const circuitId = b4a.alloc(16, overrides.circuitByte || 0x61)
  const epoch = overrides.epoch || 11n
  const boundary = createLinkControlBoundary({ link, epoch, circuitId })
  const sent = []
  const order = []
  const mux = new RemoteControlMux()
  const session = new LinkControlSession({
    control: boundary.consumer,
    circuitId,
    epoch,
    heartbeatDirection: DIRECTION.FORWARD,
    now: overrides.now || (() => clock.now),
    schedule: overrides.schedule || timers.schedule,
    cancel:
      overrides.cancel ||
      ((record) => {
        order.push('cancel-timer')
        timers.cancel(record)
      }),
    randomBytes: overrides.randomBytes || ((size) => b4a.alloc(size, 0x72)),
    sendControl:
      overrides.sendControl ||
      (async (payload) => {
        sent.push(b4a.from(payload))
        return true
      }),
    cancelPending:
      overrides.cancelPending ||
      (() => {
        order.push('cancel-pending')
      }),
    notifyCircuit:
      overrides.notifyCircuit ||
      ((direction, reason) => {
        order.push(`notify-${direction}-${reason}`)
      }),
    closeLink:
      overrides.closeLink ||
      (() => {
        order.push('close-link')
      }),
    maxPendingStreams: overrides.maxPendingStreams,
    maxPendingBytes: overrides.maxPendingBytes
  })

  let controlCounter = 0n
  let datagramCounter = 0n
  let streamCounter = 0n
  function authenticated({
    class: kind = CELL_CLASS.DATAGRAM,
    direction = DIRECTION.FORWARD,
    generation = kind === CELL_CLASS.CONTROL ? 0n : 1n,
    counter,
    payload = b4a.from('payload'),
    ...context
  } = {}) {
    if (counter === undefined) {
      if (kind === CELL_CLASS.CONTROL) counter = controlCounter++
      else if (kind === CELL_CLASS.STREAM) counter = streamCounter++
      else counter = datagramCounter++
    }
    return boundary.pushAuthenticated({
      link,
      epoch,
      circuitId,
      class: kind,
      direction,
      generation,
      counter,
      payload,
      ...context
    })
  }
  function linkPayload(value) {
    return mux.encodeLink(value, {
      class: CELL_CLASS.CONTROL,
      direction: value.direction,
      circuitId
    })
  }
  function receiveLink(value) {
    const payload = linkPayload(value)
    try {
      return session.receiveAuthenticated(
        authenticated({ class: CELL_CLASS.CONTROL, direction: value.direction, payload })
      )
    } finally {
      payload.fill(0)
    }
  }
  return {
    clock,
    timers,
    link,
    circuitId,
    epoch,
    boundary,
    mux,
    session,
    sent,
    order,
    authenticated,
    linkPayload,
    receiveLink
  }
}

function endpointFixture({ clock, timers, onCell = () => false, onLinkFailure, adapter }) {
  const authority = cryptoSuite.keyPair(seed(180))
  const local = cryptoSuite.keyPair(seed(181))
  const peer = safetyRoleIdentity(182)
  const runId32 = seed(183)
  const epoch = 17n
  const circuitId = b4a.alloc(16, 0x91)
  const grant = signTopologyGrant(
    {
      version: PROTOCOL_VERSION,
      format: 0,
      grantId32: seed(184),
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
  adapter = adapter || new FakeUdxAdapter()
  const endpoint = new UdxCellEndpoint({
    adapter,
    host: '127.0.0.41',
    port: 47441,
    onBootstrap() {},
    onCell,
    onLinkFailure: onLinkFailure || (() => {})
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
  return { adapter, circuitId, contexts, directory, endpoint, epoch, linkHandle }
}

function remoteCell(
  f,
  cellClass,
  direction,
  payload,
  counter = new SenderCounter(),
  generation = 1n,
  logicalCounter = 0n
) {
  const context = f.contexts[cellClass].rx
  let framed = payload
  if (cellClass !== CELL_CLASS.CONTROL) {
    const prefix = cellClass === CELL_CLASS.STREAM ? 16 : 8
    framed = b4a.alloc(prefix + payload.byteLength)
    let value = generation
    for (let index = 7; index >= 0; index--) {
      framed[index] = Number(value & 0xffn)
      value >>= 8n
    }
    if (cellClass === CELL_CLASS.STREAM) {
      value = logicalCounter
      for (let index = 15; index >= 8; index--) {
        framed[index] = Number(value & 0xffn)
        value >>= 8n
      }
    }
    framed.set(payload, prefix)
  }
  try {
    return new CellCodec({ crypto: cryptoSuite, cellSize: 1_200 }).seal({
      key: context.key,
      noncePrefix: context.noncePrefix,
      senderCounter: counter,
      class: cellClass,
      direction,
      epoch: f.epoch,
      circuitId: f.circuitId,
      payload: framed
    })
  } finally {
    if (framed !== payload) framed.fill(0)
  }
}

test('authenticated UDX link open starts sealed heartbeat traffic immediately', async (t) => {
  const clock = { now: 1_000 }
  const timers = scheduler(clock)
  const f = endpointFixture({ clock, timers })
  await f.endpoint.bind()
  const handle = f.endpoint.openLink(f.linkHandle)
  f.endpoint[UDX_LINK_OPEN](handle, {
    linkState: { circuitId: f.circuitId, epoch: f.epoch, contexts: f.contexts },
    mode: 'initiate',
    now: () => clock.now,
    schedule: timers.schedule,
    cancel: timers.cancel,
    randomBytes: (size) => b4a.alloc(size, 0xe1)
  })
  await timers.advance(LINK_PING_AFTER)
  t.is(f.adapter.sockets[0].sends.length, 1, 'heartbeat is owned by the live UDX link')
  const packet = f.adapter.sockets[0].sends[0].packet
  t.is(packet.byteLength, 1_200)
  t.is(packet[1], CELL_CLASS.CONTROL)
  t.is(packet[2], DIRECTION.FORWARD)
  await f.endpoint.close()
  f.directory.destroy()
})

test('established UDX STREAM admission owns hop accounting until an authenticated ACK', async (t) => {
  const clock = { now: 2_000 }
  const timers = scheduler(clock)
  const f = endpointFixture({ clock, timers })
  await f.endpoint.bind()
  const handle = f.endpoint.openLink(f.linkHandle)
  f.endpoint[UDX_LINK_OPEN](handle, {
    linkState: { circuitId: f.circuitId, epoch: f.epoch, contexts: f.contexts },
    mode: 'initiate',
    now: () => clock.now,
    schedule: timers.schedule,
    cancel: timers.cancel,
    randomBytes: (size) => b4a.alloc(size, 0xe2)
  })
  t.is(
    await f.endpoint[UDX_SEND_CELL](handle, {
      class: CELL_CLASS.STREAM,
      direction: DIRECTION.FORWARD,
      generation: 5n,
      payload: b4a.from('owned')
    }),
    true
  )
  t.is(
    await f.endpoint[UDX_SEND_CELL](handle, {
      class: CELL_CLASS.STREAM,
      direction: DIRECTION.FORWARD,
      generation: 6n,
      payload: b4a.from('next')
    }),
    true
  )
  t.is(
    await f.endpoint[UDX_SEND_CELL](handle, {
      class: CELL_CLASS.STREAM,
      direction: DIRECTION.FORWARD,
      generation: 5n,
      payload: b4a.from('again')
    }),
    true
  )
  t.alike(f.endpoint[UDX_LINK_STATS](handle), {
    pendingStreams: 3,
    pendingBytes: 14,
    pendingSends: 0,
    closed: false
  })
  const mux = new RemoteControlMux()
  const remoteControlCounter = new SenderCounter()
  const ack = mux.encodeLink(
    {
      version: PROTOCOL_VERSION,
      kind: LINK_CONTROL_KIND.STREAM_ACK,
      flags: 0,
      direction: DIRECTION.REVERSE,
      circuitId: f.circuitId,
      generation: 5n,
      acknowledgedDirection: DIRECTION.FORWARD,
      counter: 1n
    },
    { class: CELL_CLASS.CONTROL, direction: DIRECTION.REVERSE, circuitId: f.circuitId }
  )
  f.adapter.sockets[0].emitMessage(
    remoteCell(f, CELL_CLASS.CONTROL, DIRECTION.REVERSE, ack, remoteControlCounter),
    '127.0.0.42',
    47442
  )
  t.alike(f.endpoint[UDX_LINK_STATS](handle), {
    pendingStreams: 1,
    pendingBytes: 4,
    pendingSends: 0,
    closed: false
  })
  const nextAck = mux.encodeLink(
    {
      version: PROTOCOL_VERSION,
      kind: LINK_CONTROL_KIND.STREAM_ACK,
      flags: 0,
      direction: DIRECTION.REVERSE,
      circuitId: f.circuitId,
      generation: 6n,
      acknowledgedDirection: DIRECTION.FORWARD,
      counter: 0n
    },
    { class: CELL_CLASS.CONTROL, direction: DIRECTION.REVERSE, circuitId: f.circuitId }
  )
  f.adapter.sockets[0].emitMessage(
    remoteCell(f, CELL_CLASS.CONTROL, DIRECTION.REVERSE, nextAck, remoteControlCounter),
    '127.0.0.42',
    47442
  )
  t.alike(f.endpoint[UDX_LINK_STATS](handle), {
    pendingStreams: 0,
    pendingBytes: 0,
    pendingSends: 0,
    closed: false
  })
  await f.endpoint.close()
  f.directory.destroy()
})

test('installed replay window rejects repeated authenticated UDX cells as liveness', async (t) => {
  const clock = { now: 3_000 }
  const timers = scheduler(clock)
  const failures = []
  let actorDispatches = 0
  const f = endpointFixture({
    clock,
    timers,
    onCell: () => {
      actorDispatches++
      return true
    },
    onLinkFailure: (_handle, direction, reason) => failures.push([direction, reason])
  })
  await f.endpoint.bind()
  const handle = f.endpoint.openLink(f.linkHandle)
  f.endpoint[UDX_LINK_OPEN](handle, {
    linkState: { circuitId: f.circuitId, epoch: f.epoch, contexts: f.contexts },
    mode: 'initiate',
    now: () => clock.now,
    schedule: timers.schedule,
    cancel: timers.cancel,
    randomBytes: (size) => b4a.alloc(size, 0xe3)
  })
  const mux = new RemoteControlMux()
  const challenge = b4a.alloc(16, 0xe4)
  const ping = mux.encodeLink(
    {
      version: PROTOCOL_VERSION,
      kind: LINK_CONTROL_KIND.LINK_PING,
      flags: 0,
      direction: DIRECTION.REVERSE,
      circuitId: f.circuitId,
      generation: 0n,
      challenge
    },
    { class: CELL_CLASS.CONTROL, direction: DIRECTION.REVERSE, circuitId: f.circuitId }
  )
  const packet = remoteCell(f, CELL_CLASS.CONTROL, DIRECTION.REVERSE, ping)
  f.adapter.sockets[0].emitMessage(packet, '127.0.0.42', 47442)
  for (let elapsed = 100; elapsed < LINK_UNRESPONSIVE_AFTER; elapsed += 100) {
    await timers.advance(100)
    f.adapter.sockets[0].emitMessage(packet, '127.0.0.42', 47442)
  }
  await timers.advance(100)
  t.is(actorDispatches, 0, 'link namespace remains local')
  t.alike(failures, [
    [DIRECTION.FORWARD, 'ROUTE_UNAVAILABLE'],
    [DIRECTION.REVERSE, 'ROUTE_UNAVAILABLE']
  ])
  t.is(
    errorCode(() => f.endpoint[UDX_LINK_STATS](handle)),
    'UNAUTHORIZED'
  )
  await f.endpoint.close()
  f.directory.destroy()
})

test('authenticated ordered gaps cannot extend established UDX liveness', async (t) => {
  const clock = { now: 6_000 }
  const timers = scheduler(clock)
  const failures = []
  const f = endpointFixture({
    clock,
    timers,
    onLinkFailure: (_handle, direction) => failures.push(direction)
  })
  await f.endpoint.bind()
  const handle = f.endpoint.openLink(f.linkHandle)
  f.endpoint[UDX_LINK_OPEN](handle, {
    linkState: { circuitId: f.circuitId, epoch: f.epoch, contexts: f.contexts },
    mode: 'initiate',
    now: () => clock.now,
    schedule: timers.schedule,
    cancel: timers.cancel,
    randomBytes: (size) => b4a.alloc(size, 0xe6)
  })
  const mux = new RemoteControlMux()
  const gapCounter = new SenderCounter({ initial: 1n })
  const ping = mux.encodeLink(
    {
      version: PROTOCOL_VERSION,
      kind: LINK_CONTROL_KIND.LINK_PING,
      flags: 0,
      direction: DIRECTION.REVERSE,
      circuitId: f.circuitId,
      generation: 0n,
      challenge: b4a.alloc(16, 0xe7)
    },
    { class: CELL_CLASS.CONTROL, direction: DIRECTION.REVERSE, circuitId: f.circuitId }
  )
  for (let elapsed = 0; elapsed < 1_400; elapsed += 100) {
    f.adapter.sockets[0].emitMessage(
      remoteCell(f, CELL_CLASS.CONTROL, DIRECTION.REVERSE, ping, gapCounter),
      '127.0.0.42',
      47442
    )
    await timers.advance(100)
  }
  await timers.advance(100)
  t.is(
    errorCode(() => f.endpoint[UDX_LINK_STATS](handle)),
    'UNAUTHORIZED'
  )
  t.alike(failures, [DIRECTION.FORWARD, DIRECTION.REVERSE])
  await f.endpoint.close()
  f.directory.destroy()
})

test('ordered gap enforces established deadline even when its scheduler never fires', async (t) => {
  const clock = { now: 8_000 }
  const inert = { schedule: () => Object.freeze({}), cancel() {} }
  const f = endpointFixture({ clock, timers: inert })
  await f.endpoint.bind()
  const handle = f.endpoint.openLink(f.linkHandle)
  f.endpoint[UDX_LINK_OPEN](handle, {
    linkState: { circuitId: f.circuitId, epoch: f.epoch, contexts: f.contexts },
    mode: 'initiate',
    now: () => clock.now,
    schedule: inert.schedule,
    cancel: inert.cancel,
    randomBytes: (size) => b4a.alloc(size, 0xe9)
  })
  const mux = new RemoteControlMux()
  const gapCounter = new SenderCounter({ initial: 1n })
  const ping = mux.encodeLink(
    {
      version: PROTOCOL_VERSION,
      kind: LINK_CONTROL_KIND.LINK_PING,
      flags: 0,
      direction: DIRECTION.REVERSE,
      circuitId: f.circuitId,
      generation: 0n,
      challenge: b4a.alloc(16, 0xea)
    },
    { class: CELL_CLASS.CONTROL, direction: DIRECTION.REVERSE, circuitId: f.circuitId }
  )
  f.adapter.sockets[0].emitMessage(
    remoteCell(f, CELL_CLASS.CONTROL, DIRECTION.REVERSE, ping, gapCounter),
    '127.0.0.42',
    47442
  )
  clock.now += LINK_UNRESPONSIVE_AFTER
  f.adapter.sockets[0].emitMessage(
    remoteCell(f, CELL_CLASS.CONTROL, DIRECTION.REVERSE, ping, gapCounter),
    '127.0.0.42',
    47442
  )
  t.is(
    errorCode(() => f.endpoint[UDX_LINK_STATS](handle)),
    'UNAUTHORIZED'
  )
  await f.endpoint.close()
  f.directory.destroy()
})

test('link tombstone rejects an in-flight cell caller before native send settles', async (t) => {
  const clock = { now: 9_000 }
  const timers = scheduler(clock)
  let releaseNative = null
  const failures = []
  const adapter = new FakeUdxAdapter({
    send() {
      return new Promise((resolve) => {
        releaseNative = resolve
      })
    }
  })
  const f = endpointFixture({
    clock,
    timers,
    adapter,
    onLinkFailure: (_handle, direction) => failures.push(direction)
  })
  await f.endpoint.bind()
  const handle = f.endpoint.openLink(f.linkHandle)
  f.endpoint[UDX_LINK_OPEN](handle, {
    linkState: { circuitId: f.circuitId, epoch: f.epoch, contexts: f.contexts },
    mode: 'initiate',
    now: () => clock.now,
    schedule: timers.schedule,
    cancel: timers.cancel,
    randomBytes: (size) => b4a.alloc(size, 0xeb)
  })
  let outcome = null
  f.endpoint[UDX_SEND_CELL](handle, {
    class: CELL_CLASS.STREAM,
    direction: DIRECTION.FORWARD,
    generation: 1n,
    payload: b4a.from('held-native')
  }).then(
    () => {
      outcome = 'sent'
    },
    (err) => {
      outcome = err && err.code
    }
  )
  await timers.advance(LINK_UNRESPONSIVE_AFTER)
  await Promise.resolve()
  t.is(outcome, 'ROUTE_UNAVAILABLE', 'caller settles at tombstone, not native completion')
  t.is(
    errorCode(() => f.endpoint[UDX_LINK_STATS](handle)),
    'UNAUTHORIZED'
  )
  t.alike(failures, [DIRECTION.FORWARD, DIRECTION.REVERSE])
  t.is(f.adapter.sockets[0].closed, false, 'native safety ownership is still retained')
  releaseNative(true)
  await Promise.resolve()
  await f.endpoint.close()
  t.is(f.adapter.sockets[0].closed, true)
  f.directory.destroy()
})

for (const cellClass of [CELL_CLASS.STREAM, CELL_CLASS.DATAGRAM]) {
  test(`established ${cellClass} generation is exact uint64 without truncation`, async (t) => {
    const clock = { now: 7_000 + cellClass }
    const timers = scheduler(clock)
    const f = endpointFixture({ clock, timers })
    await f.endpoint.bind()
    const handle = f.endpoint.openLink(f.linkHandle)
    f.endpoint[UDX_LINK_OPEN](handle, {
      linkState: { circuitId: f.circuitId, epoch: f.epoch, contexts: f.contexts },
      mode: 'initiate',
      now: () => clock.now,
      schedule: timers.schedule,
      cancel: timers.cancel,
      randomBytes: (size) => b4a.alloc(size, 0xe8)
    })
    const maximum = (1n << 64n) - 1n
    t.is(
      await f.endpoint[UDX_SEND_CELL](handle, {
        class: cellClass,
        direction: DIRECTION.FORWARD,
        generation: maximum,
        payload: b4a.from('max')
      }),
      true
    )
    const before = f.endpoint[UDX_LINK_STATS](handle)
    t.is(
      await errorCode(() =>
        f.endpoint[UDX_SEND_CELL](handle, {
          class: cellClass,
          direction: DIRECTION.FORWARD,
          generation: maximum + 1n,
          payload: b4a.from('overflow')
        })
      ),
      'INVALID_ROUTE'
    )
    t.is(f.adapter.sockets[0].sends.length, 1)
    t.alike(f.endpoint[UDX_LINK_STATS](handle), before)
    await f.endpoint.close()
    f.directory.destroy()
  })
}

for (const [accepted, expectedAcks] of [
  [false, 0],
  [true, 1]
]) {
  test(`live UDX STREAM queue ${accepted ? 'acceptance emits' : 'pressure suppresses'} ACK`, async (t) => {
    const clock = { now: accepted ? 4_000 : 5_000 }
    const timers = scheduler(clock)
    let owned = null
    let receivedGeneration = null
    const f = endpointFixture({
      clock,
      timers,
      onCell(payload, _handle, metadata) {
        owned = payload
        receivedGeneration = metadata.generation
        return accepted
      }
    })
    await f.endpoint.bind()
    const handle = f.endpoint.openLink(f.linkHandle)
    f.endpoint[UDX_LINK_OPEN](handle, {
      linkState: { circuitId: f.circuitId, epoch: f.epoch, contexts: f.contexts },
      mode: 'initiate',
      now: () => clock.now,
      schedule: timers.schedule,
      cancel: timers.cancel,
      randomBytes: (size) => b4a.alloc(size, 0xe5)
    })
    const packet = remoteCell(
      f,
      CELL_CLASS.STREAM,
      DIRECTION.REVERSE,
      b4a.from('next-hop'),
      new SenderCounter(),
      5n
    )
    f.adapter.sockets[0].emitMessage(packet, '127.0.0.42', 47442)
    await Promise.resolve()
    t.alike(owned, accepted ? b4a.from('next-hop') : b4a.alloc(8))
    t.is(receivedGeneration, 5n)
    t.is(f.adapter.sockets[0].sends.length, expectedAcks)
    if (expectedAcks === 1) t.is(f.adapter.sockets[0].sends[0].packet[1], CELL_CLASS.CONTROL)
    if (owned) owned.fill(0)
    await f.endpoint.close()
    f.directory.destroy()
  })
}

test('authenticated STREAM logical counter gap closes before queue or ACK', async (t) => {
  const clock = { now: 10_000 }
  const timers = scheduler(clock)
  const failures = []
  let queueCalls = 0
  const f = endpointFixture({
    clock,
    timers,
    onCell: () => {
      queueCalls++
      return true
    },
    onLinkFailure: (_handle, direction) => failures.push(direction)
  })
  await f.endpoint.bind()
  const handle = f.endpoint.openLink(f.linkHandle)
  f.endpoint[UDX_LINK_OPEN](handle, {
    linkState: { circuitId: f.circuitId, epoch: f.epoch, contexts: f.contexts },
    mode: 'initiate',
    now: () => clock.now,
    schedule: timers.schedule,
    cancel: timers.cancel,
    randomBytes: (size) => b4a.alloc(size, 0xec)
  })
  f.adapter.sockets[0].emitMessage(
    remoteCell(
      f,
      CELL_CLASS.STREAM,
      DIRECTION.REVERSE,
      b4a.from('gap'),
      new SenderCounter(),
      3n,
      2n
    ),
    '127.0.0.42',
    47442
  )
  t.is(queueCalls, 0)
  t.is(f.adapter.sockets[0].sends.length, 0)
  t.alike(failures, [DIRECTION.FORWARD, DIRECTION.REVERSE])
  t.is(
    errorCode(() => f.endpoint[UDX_LINK_STATS](handle)),
    'UNAUTHORIZED'
  )
  await f.endpoint.close()
  f.directory.destroy()
})

test('link liveness starts immediately and expires independently of UDP send success', async (t) => {
  const clock = { now: 1_000 }
  const timers = scheduler(clock)
  const link = Object.freeze({})
  const circuitId = b4a.alloc(16, 0x42)
  const boundary = createLinkControlBoundary({ link, epoch: 7n, circuitId })
  const sent = []
  const closed = []
  const session = new LinkControlSession({
    control: boundary.consumer,
    circuitId,
    epoch: 7n,
    heartbeatDirection: DIRECTION.FORWARD,
    now: () => clock.now,
    schedule: timers.schedule,
    cancel: timers.cancel,
    randomBytes: (size) => b4a.alloc(size, 0x91),
    sendControl: async (payload) => {
      sent.push(b4a.from(payload))
      return true
    },
    cancelPending() {},
    notifyCircuit() {},
    closeLink: (reason) => closed.push(reason)
  })

  t.is(LINK_PING_AFTER, 500)
  t.is(LINK_UNRESPONSIVE_AFTER, 1_500)
  await timers.advance(500)
  t.is(sent.length, 1, 'idle link sends a ping')
  t.is(session.closed, false)
  await timers.advance(1_000)
  t.is(session.closed, true, 'successful UDP sends do not refresh receive activity')
  t.is(closed.length, 1)
  t.is(session.pendingBytes, 0)
  t.is(session.pendingStreams, 0)
})

test('only a fresh opaque authenticated cell refreshes liveness', async (t) => {
  const clock = { now: 2_000 }
  const timers = scheduler(clock)
  const link = Object.freeze({})
  const circuitId = b4a.alloc(16, 0x43)
  const boundary = createLinkControlBoundary({ link, epoch: 9n, circuitId })
  const session = new LinkControlSession({
    control: boundary.consumer,
    circuitId,
    epoch: 9n,
    heartbeatDirection: DIRECTION.FORWARD,
    now: () => clock.now,
    schedule: timers.schedule,
    cancel: timers.cancel,
    randomBytes: (size) => b4a.alloc(size, 0x92),
    sendControl: async () => true,
    cancelPending() {},
    notifyCircuit() {},
    closeLink() {}
  })

  const fresh = boundary.pushAuthenticated({
    link,
    epoch: 9n,
    circuitId,
    class: CELL_CLASS.DATAGRAM,
    direction: DIRECTION.FORWARD,
    generation: 1n,
    counter: 0n,
    payload: b4a.from('fresh')
  })
  t.is(session.receiveAuthenticated(fresh, { enqueueDatagram: () => true }), true)
  await timers.advance(1_400)
  t.is(session.closed, false)
  await timers.advance(100)
  t.is(session.closed, true)
})

test('opaque authenticated events are one-shot and cannot refresh twice', (t) => {
  const f = fixture()
  const first = f.authenticated({ counter: 0n })
  t.is(f.session.receiveAuthenticated(first, { enqueueDatagram: () => true }), true)
  t.is(
    errorCode(() => f.session.receiveAuthenticated(first, { enqueueDatagram: () => true })),
    'INVALID_ROUTE'
  )
  t.is(f.session.closed, true)
})

test('ping and pong use the authenticated link namespace and exact challenge', async (t) => {
  const f = fixture()
  await f.timers.advance(LINK_PING_AFTER)
  t.is(f.sent.length, 1)
  const ping = f.mux.decode(f.sent.shift(), {
    class: CELL_CLASS.CONTROL,
    direction: DIRECTION.FORWARD,
    circuitId: f.circuitId
  })
  t.is(ping.namespace, CONTROL_NAMESPACE.LINK)
  t.is(ping.message.kind, LINK_CONTROL_KIND.LINK_PING)
  t.is(ping.message.generation, 0n)

  const accepted = f.receiveLink({
    version: PROTOCOL_VERSION,
    kind: LINK_CONTROL_KIND.LINK_PONG,
    flags: 0,
    direction: DIRECTION.REVERSE,
    circuitId: f.circuitId,
    generation: 0n,
    challenge: ping.message.challenge
  })
  t.is(accepted, true)
  ping.message.circuitId.fill(0)
  ping.message.challenge.fill(0)
  await f.timers.advance(LINK_UNRESPONSIVE_AFTER - 1)
  t.is(f.session.closed, false)
  await f.timers.advance(1)
  t.is(f.session.closed, true)
})

test('wrong pong challenge fails closed and link control never reaches actor dispatch', (t) => {
  const f = fixture()
  let actorDispatches = 0
  const code = errorCode(() =>
    f.session.receiveAuthenticated(
      f.authenticated({
        class: CELL_CLASS.CONTROL,
        direction: DIRECTION.REVERSE,
        payload: f.linkPayload({
          version: PROTOCOL_VERSION,
          kind: LINK_CONTROL_KIND.LINK_PONG,
          flags: 0,
          direction: DIRECTION.REVERSE,
          circuitId: f.circuitId,
          generation: 0n,
          challenge: b4a.alloc(16, 0x99)
        })
      }),
      {
        dispatchActor() {
          actorDispatches++
        }
      }
    )
  )
  t.is(code, 'ROUTE_UNAVAILABLE')
  t.is(f.session.closed, true)
  t.is(actorDispatches, 0)
})

test('inbound ping is consumed locally and returns an opposite-direction authenticated pong', async (t) => {
  const f = fixture()
  const challenge = b4a.alloc(16, 0xa4)
  let actorDispatches = 0
  t.is(
    f.session.receiveAuthenticated(
      f.authenticated({
        class: CELL_CLASS.CONTROL,
        direction: DIRECTION.FORWARD,
        payload: f.linkPayload({
          version: PROTOCOL_VERSION,
          kind: LINK_CONTROL_KIND.LINK_PING,
          flags: 0,
          direction: DIRECTION.FORWARD,
          circuitId: f.circuitId,
          generation: 0n,
          challenge
        })
      }),
      { dispatchActor: () => actorDispatches++ }
    ),
    true
  )
  await Promise.resolve()
  t.is(actorDispatches, 0)
  t.is(f.sent.length, 1)
  const decoded = f.mux.decode(f.sent[0], {
    class: CELL_CLASS.CONTROL,
    direction: DIRECTION.REVERSE,
    circuitId: f.circuitId
  })
  t.is(decoded.message.kind, LINK_CONTROL_KIND.LINK_PONG)
  t.alike(decoded.message.challenge, challenge)
  decoded.message.circuitId.fill(0)
  decoded.message.challenge.fill(0)
})

test('stream accounting is independent by direction and generation and releases cumulatively', (t) => {
  const f = fixture()
  t.is(f.session.trackStream(DIRECTION.FORWARD, 1n, 0n, 5), true)
  t.is(f.session.trackStream(DIRECTION.FORWARD, 1n, 1n, 7), true)
  t.is(f.session.trackStream(DIRECTION.REVERSE, 1n, 0n, 11), true)
  t.is(f.session.trackStream(DIRECTION.FORWARD, 2n, 0n, 13), true)
  t.is(f.session.pendingStreams, 4)
  t.is(f.session.pendingBytes, 36)

  t.is(
    f.receiveLink({
      version: PROTOCOL_VERSION,
      kind: LINK_CONTROL_KIND.STREAM_ACK,
      flags: 0,
      direction: DIRECTION.REVERSE,
      circuitId: f.circuitId,
      generation: 1n,
      acknowledgedDirection: DIRECTION.FORWARD,
      counter: 1n
    }),
    true
  )
  t.is(f.session.pendingStreams, 2)
  t.is(f.session.pendingBytes, 24)
})

for (const [name, setup, ack] of [
  [
    'regression',
    (f) => {
      f.session.trackStream(DIRECTION.FORWARD, 1n, 0n, 1)
      f.session.trackStream(DIRECTION.FORWARD, 1n, 1n, 1)
      f.receiveLink({
        version: 0,
        kind: LINK_CONTROL_KIND.STREAM_ACK,
        flags: 0,
        direction: DIRECTION.REVERSE,
        circuitId: f.circuitId,
        generation: 1n,
        acknowledgedDirection: DIRECTION.FORWARD,
        counter: 1n
      })
    },
    {
      generation: 1n,
      counter: 0n,
      direction: DIRECTION.REVERSE,
      acknowledgedDirection: DIRECTION.FORWARD
    }
  ],
  [
    'unsent counter',
    (f) => f.session.trackStream(DIRECTION.FORWARD, 1n, 0n, 1),
    {
      generation: 1n,
      counter: 1n,
      direction: DIRECTION.REVERSE,
      acknowledgedDirection: DIRECTION.FORWARD
    }
  ],
  [
    'wrong direction',
    (f) => f.session.trackStream(DIRECTION.FORWARD, 1n, 0n, 1),
    {
      generation: 1n,
      counter: 0n,
      direction: DIRECTION.FORWARD,
      acknowledgedDirection: DIRECTION.REVERSE
    }
  ],
  [
    'wrong generation',
    (f) => f.session.trackStream(DIRECTION.FORWARD, 1n, 0n, 1),
    {
      generation: 2n,
      counter: 0n,
      direction: DIRECTION.REVERSE,
      acknowledgedDirection: DIRECTION.FORWARD
    }
  ]
]) {
  test(`stream ACK ${name} fails closed`, (t) => {
    const f = fixture()
    setup(f)
    const code = errorCode(() =>
      f.receiveLink({
        version: PROTOCOL_VERSION,
        kind: LINK_CONTROL_KIND.STREAM_ACK,
        flags: 0,
        circuitId: f.circuitId,
        ...ack
      })
    )
    t.is(code, 'ROUTE_UNAVAILABLE')
    t.is(f.session.closed, true)
    t.is(f.session.pendingStreams, 0)
    t.is(f.session.pendingBytes, 0)
  })
}

test('relay and endpoint send ACK only after the whole STREAM payload enters the bounded queue', async (t) => {
  const f = fixture()
  let rejectedOwnership = null
  const pressured = f.authenticated({
    class: CELL_CLASS.STREAM,
    generation: 3n,
    counter: 0n,
    payload: b4a.from('whole-fragment')
  })
  t.is(
    f.session.receiveAuthenticated(pressured, {
      enqueueStream(payload) {
        rejectedOwnership = payload
        return false
      }
    }),
    false
  )
  await Promise.resolve()
  t.is(f.sent.length, 0, 'no queue ownership means no ACK')
  t.alike(rejectedOwnership, b4a.alloc(rejectedOwnership.byteLength), 'rejected copy is cleared')

  const accepted = f.authenticated({
    class: CELL_CLASS.STREAM,
    generation: 3n,
    counter: 1n,
    payload: b4a.from('accepted')
  })
  t.is(f.session.receiveAuthenticated(accepted, { enqueueStream: () => true }), false)
  await Promise.resolve()
  t.is(f.sent.length, 0, 'cumulative ACK cannot skip the unqueued counter zero')

  const independent = fixture({ circuitByte: 0x65 })
  let acceptedOwnership = null
  t.is(
    independent.session.receiveAuthenticated(
      independent.authenticated({
        class: CELL_CLASS.STREAM,
        generation: 3n,
        counter: 0n,
        payload: b4a.from('accepted')
      }),
      {
        enqueueStream(payload) {
          acceptedOwnership = payload
          return true
        }
      }
    ),
    true
  )
  await Promise.resolve()
  t.alike(acceptedOwnership, b4a.from('accepted'), 'accepted queue owns its copy')
  t.is(independent.sent.length, 1)
  const ack = independent.mux.decode(independent.sent[0], {
    class: CELL_CLASS.CONTROL,
    direction: DIRECTION.REVERSE,
    circuitId: independent.circuitId
  })
  t.is(ack.message.kind, LINK_CONTROL_KIND.STREAM_ACK)
  t.is(ack.message.acknowledgedDirection, DIRECTION.FORWARD)
  t.is(ack.message.generation, 3n)
  t.is(ack.message.counter, 0n)
  ack.message.circuitId.fill(0)
})

test('authenticated inbound counter spaces are independent per direction and generation', (t) => {
  const f = fixture()
  for (const [direction, generation] of [
    [DIRECTION.FORWARD, 1n],
    [DIRECTION.REVERSE, 1n],
    [DIRECTION.FORWARD, 2n]
  ]) {
    const event = f.boundary.pushAuthenticated({
      link: f.link,
      epoch: f.epoch,
      circuitId: f.circuitId,
      class: CELL_CLASS.STREAM,
      direction,
      generation,
      counter: 0n,
      payload: b4a.from('independent')
    })
    t.is(f.session.receiveAuthenticated(event, { enqueueStream: () => true }), true)
  }

  const reordered = fixture({ circuitByte: 0x69 })
  for (const counter of [9n, 7n, 8n]) {
    const event = reordered.boundary.pushAuthenticated({
      link: reordered.link,
      epoch: reordered.epoch,
      circuitId: reordered.circuitId,
      class: CELL_CLASS.DATAGRAM,
      direction: DIRECTION.FORWARD,
      generation: 3n,
      counter,
      payload: b4a.from('datagram')
    })
    t.is(
      reordered.session.receiveAuthenticated(event, { enqueueDatagram: () => true }),
      true,
      `post-replay-window datagram ${counter}`
    )
  }
})

test('DATAGRAM queue admission never emits a STREAM ACK', async (t) => {
  const f = fixture()
  t.is(f.session.receiveAuthenticated(f.authenticated(), { enqueueDatagram: () => true }), true)
  await Promise.resolve()
  t.is(f.sent.length, 0)
})

test('unacknowledged STREAM accounting times out at 5000ms while fresh cells keep link alive', async (t) => {
  const f = fixture()
  t.is(STREAM_ACK_TIMEOUT, 5_000)
  f.session.trackStream(DIRECTION.FORWARD, 4n, 0n, 100)
  for (let elapsed = 400; elapsed < STREAM_ACK_TIMEOUT; elapsed += 400) {
    await f.timers.advance(400)
    if (f.session.closed) break
    f.session.receiveAuthenticated(f.authenticated(), { enqueueDatagram: () => true })
  }
  if (!f.session.closed) await f.timers.advance(STREAM_ACK_TIMEOUT - (f.clock.now - 10_000))
  t.is(f.session.closed, true)
  t.is(f.session.pendingStreams, 0)
  t.is(f.session.pendingBytes, 0)
})

test('receive enforces liveness and ACK deadlines even when the scheduler never fires', (t) => {
  const inertTimers = {
    schedule() {
      return Object.freeze({})
    },
    cancel() {}
  }
  const livenessClock = { now: 1_000 }
  const liveness = fixture({ clock: livenessClock, timers: inertTimers })
  const late = liveness.authenticated()
  livenessClock.now += LINK_UNRESPONSIVE_AFTER
  t.is(
    errorCode(() => liveness.session.receiveAuthenticated(late, { enqueueDatagram: () => true })),
    'ROUTE_UNAVAILABLE'
  )
  t.is(liveness.session.closed, true)

  const ackClock = { now: 2_000 }
  const ack = fixture({ clock: ackClock, timers: inertTimers, circuitByte: 0x66 })
  ack.session.trackStream(DIRECTION.FORWARD, 1n, 0n, 4)
  const payload = ack.linkPayload({
    version: PROTOCOL_VERSION,
    kind: LINK_CONTROL_KIND.STREAM_ACK,
    flags: 0,
    direction: DIRECTION.REVERSE,
    circuitId: ack.circuitId,
    generation: 1n,
    acknowledgedDirection: DIRECTION.FORWARD,
    counter: 0n
  })
  const lateAck = ack.authenticated({
    class: CELL_CLASS.CONTROL,
    direction: DIRECTION.REVERSE,
    payload
  })
  ackClock.now += STREAM_ACK_TIMEOUT
  t.is(
    errorCode(() => ack.session.receiveAuthenticated(lateAck)),
    'ROUTE_UNAVAILABLE'
  )
  t.is(ack.session.closed, true)
  t.is(ack.session.pendingStreams, 0)
  payload.fill(0)
})

test('stream accounting enforces exact counters and configured record/byte bounds', (t) => {
  const f = fixture({ maxPendingStreams: 2, maxPendingBytes: 8 })
  t.is(f.session.trackStream(DIRECTION.FORWARD, 1n, 0n, 4), true)
  t.is(
    errorCode(() => f.session.trackStream(DIRECTION.FORWARD, 1n, 2n, 4)),
    'COUNTER_GAP'
  )
  t.is(f.session.closed, true)

  const bounded = fixture({ circuitByte: 0x62, maxPendingStreams: 2, maxPendingBytes: 8 })
  bounded.session.trackStream(DIRECTION.FORWARD, 1n, 0n, 4)
  bounded.session.trackStream(DIRECTION.FORWARD, 1n, 1n, 4)
  t.is(
    errorCode(() => bounded.session.trackStream(DIRECTION.REVERSE, 1n, 0n, 1)),
    'CIRCUIT_LIMIT'
  )
  t.is(bounded.session.closed, true)
})

test('close tombstones first, cancels owned work, notifies both directions, then stops timers before socket close', (t) => {
  const f = fixture()
  f.session.trackStream(DIRECTION.FORWARD, 1n, 0n, 5)
  t.is(f.session.close('TRANSPORT_LOST'), true)
  t.is(f.session.close('TRANSPORT_LOST'), false, 'idempotent')
  t.alike(f.order, [
    'cancel-pending',
    'notify-0-TRANSPORT_LOST',
    'notify-1-TRANSPORT_LOST',
    'cancel-timer',
    'cancel-timer',
    'close-link'
  ])
  t.is(f.session.pendingStreams, 0)
  t.is(f.session.pendingBytes, 0)
  t.is(f.timers.records.size, 0)
  t.is(f.session.pendingSends, 0)
  t.is(
    errorCode(() => f.authenticated()),
    'INVALID_ROUTE',
    'closed session invalidates its authenticated event authority'
  )
})

test('close tombstones unresolved link-control sends and ignores their late completion', async (t) => {
  let resolveSend = null
  const f = fixture({
    sendControl() {
      return new Promise((resolve) => {
        resolveSend = resolve
      })
    }
  })
  await f.timers.advance(LINK_PING_AFTER)
  t.is(f.session.pendingSends, 1)
  f.session.close()
  t.is(f.session.pendingSends, 0)
  resolveSend(true)
  await Promise.resolve()
  t.is(f.session.pendingSends, 0)
  t.is(f.session.closed, true)
})

test('clock, scheduler, cancellation, and callback faults fail closed without reentrant resurrection', (t) => {
  let closes = 0
  let session = null
  const clock = { now: 1 }
  const f = fixture({
    clock,
    cancel() {
      throw new Error('cancel fault')
    },
    notifyCircuit() {
      if (session) session.close()
      throw new Error('notify fault')
    },
    closeLink() {
      closes++
      if (session) session.close()
      throw new Error('close fault')
    }
  })
  session = f.session
  clock.now = 0
  t.is(
    errorCode(() =>
      session.receiveAuthenticated(f.authenticated(), { enqueueDatagram: () => true })
    ),
    'ROUTE_UNAVAILABLE'
  )
  t.is(session.closed, true)
  t.is(closes, 1)

  let synchronousClose = 0
  const link = Object.freeze({})
  const circuitId = b4a.alloc(16, 0x64)
  const boundary = createLinkControlBoundary({ link, epoch: 1n, circuitId })
  t.is(
    errorCode(
      () =>
        new LinkControlSession({
          control: boundary.consumer,
          circuitId,
          epoch: 1n,
          heartbeatDirection: 0,
          now: () => 1,
          schedule(callback) {
            callback()
            return 1
          },
          cancel() {},
          randomBytes: (size) => b4a.alloc(size, 1),
          sendControl: () => true,
          cancelPending() {},
          notifyCircuit() {},
          closeLink() {
            synchronousClose++
          }
        })
    ),
    'ROUTE_UNAVAILABLE'
  )
  t.is(synchronousClose, 1)
})

test('randomness, cancellation, and queue callbacks cannot publish after reentrant close', async (t) => {
  let randomSession = null
  const random = fixture({
    randomBytes(size) {
      randomSession.close()
      return b4a.alloc(size, 0xa8)
    }
  })
  randomSession = random.session
  await random.timers.advance(LINK_PING_AFTER)
  t.is(random.session.closed, true)
  t.is(random.sent.length, 0)
  t.is(random.session.pendingSends, 0)

  let queueSession = null
  const queue = fixture({ circuitByte: 0x68 })
  queueSession = queue.session
  t.is(
    errorCode(() =>
      queue.session.receiveAuthenticated(
        queue.authenticated({ class: CELL_CLASS.STREAM, generation: 1n }),
        {
          enqueueStream() {
            queueSession.close()
            return true
          }
        }
      )
    ),
    'ROUTE_UNAVAILABLE'
  )
  await Promise.resolve()
  t.is(queue.sent.length, 0)
  t.is(queue.session.closed, true)
})

test('dead middle leaves both adjacent link failures independent and bounded with no fallback creation', async (t) => {
  const clock = { now: 20_000 }
  const timers = scheduler(clock)
  const audit = []
  const teardown = new LinkCircuitTeardown({
    now: () => clock.now,
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  t.is(
    errorCode(() =>
      createOpenCircuitDirectionCapability({
        link: Object.freeze({}),
        direction: DIRECTION.FORWARD,
        session: Object.freeze({ circuitState: ASYNC_CIRCUIT_STATE.OPEN })
      })
    ),
    'INVALID_ROUTE',
    'plain open-looking sessions cannot mint teardown authority'
  )
  t.is(
    errorCode(() => teardown.add(Object.freeze({}))),
    'INVALID_ROUTE',
    'plain capabilities cannot enter teardown state'
  )
  const unopenedRemote = createRemoteActorHostTestDouble(() =>
    Promise.reject(PrivateRouteError.ROUTE_UNAVAILABLE())
  )
  const unopened = new AsyncRouteControlSession({
    remote: unopenedRemote,
    actorId: b4a.alloc(16, 0x7a),
    now: () => clock.now
  })
  Object.defineProperty(unopened, 'circuitState', { value: ASYNC_CIRCUIT_STATE.OPEN })
  t.is(
    errorCode(() =>
      createOpenCircuitDirectionCapability({
        link: Object.freeze({}),
        direction: DIRECTION.FORWARD,
        session: unopened
      })
    ),
    'INVALID_ROUTE',
    'a genuine non-open session cannot shadow its state getter to mint authority'
  )
  await unopened.stop()
  unopenedRemote.destroy()
  const staleAudit = []
  const stale = openCircuitFixture(23, clock, staleAudit, { dropDestroy: false })
  await stale.opened
  const staleCapability = createOpenCircuitDirectionCapability({
    link: Object.freeze({}),
    direction: DIRECTION.REVERSE,
    session: stale.session
  })
  await stale.session.destroy()
  Object.defineProperty(stale.session, 'circuitState', {
    value: ASYNC_CIRCUIT_STATE.OPEN
  })
  t.is(
    errorCode(() => teardown.add(staleCapability)),
    'INVALID_ROUTE',
    'a capability cannot be added after genuine circuit destruction despite a forged own state'
  )
  await stale.session.stop()
  stale.remote.destroy()
  for (const event of staleAudit) event.circuitId.fill(0)
  const left = endpointFixture({
    clock,
    timers,
    onLinkFailure: (handle, direction) => teardown.fail(handle, direction)
  })
  const right = endpointFixture({
    clock,
    timers,
    onLinkFailure: (handle, direction) => teardown.fail(handle, direction)
  })
  await left.endpoint.bind()
  await right.endpoint.bind()
  const leftHandle = left.endpoint.openLink(left.linkHandle)
  const rightHandle = right.endpoint.openLink(right.linkHandle)
  const controls = [0, 1, 2, 3].map((index) => openCircuitFixture(30 + index * 7, clock, audit))
  await Promise.all(controls.map((control) => control.opened))
  let mutableFallbackCalls = 0
  for (const control of controls) {
    control.session.destroy = () => {
      mutableFallbackCalls++
      return Promise.resolve(true)
    }
    control.session.stop = () => {
      mutableFallbackCalls++
      return Promise.resolve(true)
    }
  }
  t.alike(
    controls.map((control) => control.session.circuitState),
    [
      ASYNC_CIRCUIT_STATE.OPEN,
      ASYNC_CIRCUIT_STATE.OPEN,
      ASYNC_CIRCUIT_STATE.OPEN,
      ASYNC_CIRCUIT_STATE.OPEN
    ]
  )
  for (const [index, link, direction] of [
    [0, leftHandle, DIRECTION.FORWARD],
    [1, leftHandle, DIRECTION.REVERSE],
    [2, rightHandle, DIRECTION.FORWARD],
    [3, rightHandle, DIRECTION.REVERSE]
  ]) {
    const capability = createOpenCircuitDirectionCapability({
      link,
      direction,
      session: controls[index].session
    })
    t.is(teardown.add(capability), true)
  }
  t.alike(teardown.stats, { live: 4, destroying: 0, timers: 0 })
  for (const [side, handle, byte] of [
    [left, leftHandle, 0xf1],
    [right, rightHandle, 0xf2]
  ]) {
    side.endpoint[UDX_LINK_OPEN](handle, {
      linkState: { circuitId: side.circuitId, epoch: side.epoch, contexts: side.contexts },
      mode: 'initiate',
      now: () => clock.now,
      schedule: timers.schedule,
      cancel: timers.cancel,
      randomBytes: (size) => b4a.alloc(size, byte)
    })
  }
  await timers.advance(LINK_UNRESPONSIVE_AFTER)
  t.is(
    errorCode(() => left.endpoint[UDX_LINK_STATS](leftHandle)),
    'UNAUTHORIZED'
  )
  t.is(
    errorCode(() => right.endpoint[UDX_LINK_STATS](rightHandle)),
    'UNAUTHORIZED'
  )
  t.is(left.endpoint.queuedPackets + right.endpoint.queuedPackets, 0)
  t.is(left.endpoint.queuedBytes + right.endpoint.queuedBytes, 0)
  t.alike(
    teardown.stats,
    { live: 0, destroying: 4, timers: 4 },
    'surviving circuit directions enter production bounded destroy state'
  )
  t.alike(
    audit
      .filter((event) => event.kind === ACTOR_CONTROL_KIND.CIRCUIT_DESTROY)
      .map((event) => event.reason),
    [
      CIRCUIT_DESTROY_REASON.TRANSPORT_LOST,
      CIRCUIT_DESTROY_REASON.TRANSPORT_LOST,
      CIRCUIT_DESTROY_REASON.TRANSPORT_LOST,
      CIRCUIT_DESTROY_REASON.TRANSPORT_LOST
    ],
    'genuine async sessions emit four authenticated circuit destroys'
  )
  await timers.advance(4_999)
  t.alike(teardown.stats, { live: 0, destroying: 4, timers: 4 })
  await timers.advance(1)
  await teardown.close()
  t.alike(teardown.stats, { live: 0, destroying: 0, timers: 0 })
  for (const control of controls) {
    t.is(control.session.stats.waits, 0)
    t.is(control.session.stats.timers, 0)
    t.is(control.session.stats.ownedBytes, 0)
    t.is(control.session.stats.stopped, true)
  }
  t.is(audit.length, 8, 'only activation and destroy control operations occur')
  t.is(mutableFallbackCalls, 0, 'mutable instance fallbacks are never invoked')
  t.ok(clock.now - 20_000 <= 6_500)
  await left.endpoint.close()
  await right.endpoint.close()
  for (const control of controls) control.remote.destroy()
  for (const event of audit) event.circuitId.fill(0)
  left.directory.destroy()
  right.directory.destroy()
})

test('plain objects and wrong link context cannot refresh activity or dispatch plaintext', (t) => {
  const f = fixture()
  t.is(
    errorCode(() =>
      f.session.receiveAuthenticated(
        {
          class: CELL_CLASS.DATAGRAM,
          direction: 0,
          generation: 1n,
          counter: 0n,
          payload: b4a.from('forged')
        },
        { enqueueDatagram: () => true }
      )
    ),
    'INVALID_ROUTE'
  )
  t.is(f.session.closed, true)

  const other = fixture({ circuitByte: 0x73 })
  t.is(
    errorCode(() =>
      other.boundary.pushAuthenticated({
        link: Object.freeze({}),
        epoch: other.epoch,
        circuitId: other.circuitId,
        class: CELL_CLASS.DATAGRAM,
        direction: DIRECTION.FORWARD,
        generation: 1n,
        counter: 0n,
        payload: b4a.from('wrong source')
      })
    ),
    'INVALID_ROUTE'
  )
  t.is(other.session.closed, false)
})

test('link circuit allocation is nonzero and generation zero is reserved for heartbeat control', (t) => {
  const link = Object.freeze({})
  t.is(
    errorCode(() => createLinkControlBoundary({ link, epoch: 1n, circuitId: b4a.alloc(16) })),
    'INVALID_ROUTE'
  )
  const f = fixture()
  t.is(
    errorCode(() => f.session.trackStream(DIRECTION.FORWARD, 0n, 0n, 1)),
    'INVALID_ROUTE'
  )
  t.is(f.session.closed, true)
})

test('session authority is bound to one exact epoch/circuit consumer', (t) => {
  const link = Object.freeze({})
  const circuitId = b4a.alloc(16, 0x81)
  const boundary = createLinkControlBoundary({ link, epoch: 3n, circuitId })
  const common = {
    control: boundary.consumer,
    circuitId,
    epoch: 3n,
    heartbeatDirection: DIRECTION.FORWARD,
    now: () => 1,
    schedule: () => Object.freeze({}),
    cancel() {},
    randomBytes: (size) => b4a.alloc(size, 1),
    sendControl: () => true,
    cancelPending() {},
    notifyCircuit() {},
    closeLink() {}
  }
  t.is(
    errorCode(() => new LinkControlSession({ ...common, epoch: 4n })),
    'INVALID_ROUTE'
  )
  t.is(
    errorCode(() => new LinkControlSession({ ...common, circuitId: b4a.alloc(16, 0x82) })),
    'INVALID_ROUTE'
  )
  const session = new LinkControlSession(common)
  t.is(
    errorCode(() => new LinkControlSession(common)),
    'CIRCUIT_STATE'
  )
  session.close()
})

test('authenticated events and unresolved control sends are bounded without eviction', (t) => {
  const link = Object.freeze({})
  const circuitId = b4a.alloc(16, 0x83)
  const boundary = createLinkControlBoundary({ link, epoch: 1n, circuitId })
  for (let counter = 0n; counter < 64n; counter++) {
    boundary.pushAuthenticated({
      link,
      epoch: 1n,
      circuitId,
      class: CELL_CLASS.DATAGRAM,
      direction: DIRECTION.FORWARD,
      generation: 1n,
      counter,
      payload: b4a.alloc(0)
    })
  }
  t.is(
    errorCode(() =>
      boundary.pushAuthenticated({
        link,
        epoch: 1n,
        circuitId,
        class: CELL_CLASS.DATAGRAM,
        direction: DIRECTION.FORWARD,
        generation: 1n,
        counter: 64n,
        payload: b4a.alloc(0)
      })
    ),
    'INVALID_ROUTE'
  )

  const pending = fixture({
    circuitByte: 0x84,
    sendControl: () => new Promise(() => {})
  })
  for (let counter = 0n; counter < 64n; counter++) {
    t.is(
      pending.receiveLink({
        version: 0,
        kind: LINK_CONTROL_KIND.LINK_PING,
        flags: 0,
        direction: DIRECTION.FORWARD,
        circuitId: pending.circuitId,
        generation: 0n,
        challenge: b4a.alloc(16, Number(counter) + 1)
      }),
      true
    )
  }
  t.is(pending.session.pendingSends, 64)
  t.is(
    errorCode(() =>
      pending.receiveLink({
        version: 0,
        kind: LINK_CONTROL_KIND.LINK_PING,
        flags: 0,
        direction: DIRECTION.FORWARD,
        circuitId: pending.circuitId,
        generation: 0n,
        challenge: b4a.alloc(16, 0xf0)
      })
    ),
    'ROUTE_UNAVAILABLE'
  )
  t.is(pending.session.closed, true)
  t.is(pending.session.pendingSends, 0)
})

test('errors remain stable private route errors', (t) => {
  const f = fixture()
  let failure = null
  try {
    f.session.receiveAuthenticated({}, {})
  } catch (err) {
    failure = err
  }
  t.ok(failure instanceof PrivateRouteError)
  t.is(failure.code, 'INVALID_ROUTE')
})
