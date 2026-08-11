import test from 'brittle'
import { EventEmitter } from 'node:events'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  createIndexServiceAnnouncement,
  deriveIndexerId,
} from '../src/indexer/service-announcement.js'
import { attachIndexServiceProtocol } from '../src/indexer/protocol.js'
import * as indexerEntry from '../src/indexer/index.js'
import {
  INDEX_QUERY_CAPABILITY,
  createScopedNetworkRuntime,
  encodeScopedHello,
} from '../src/network/scoped-runtime.js'
import { deriveIndexTopic } from '../src/network/topics.js'
import { MAX_PEER_FRAME_BYTES, decodePeerFrame, encodePeerFrame } from '../src/network/frame.js'
import { PROTOCOL_MAJOR } from '../src/network/version.js'

const NOW = 1_700_000_000_000

function keyPair(fill) {
  return crypto.keyPair(b4a.alloc(32, fill))
}

function announcement({ signer = keyPair(1), transportPublicKey = b4a.alloc(32, 2), sequence = 1, issuedAt = NOW, expiresAt = NOW + 60_000 } = {}) {
  return createIndexServiceAnnouncement({
    indexerId: deriveIndexerId(signer.publicKey),
    transportPublicKey,
    dimensions: ['external-ref'],
    shardRanges: [{ dimension: 'external-ref', start: null, end: null }],
    queryCapabilities: ['exact-external-ref'],
    policyDigest: b4a.alloc(32, 3),
    sequence,
    issuedAt,
    expiresAt,
  }, signer)
}

function fakeMux({ autoOpen = false } = {}) {
  const channels = []
  const pairs = []
  return {
    channels,
    pairs,
    pair(spec, onpair) { pairs.push({ spec, onpair }) },
    cork() {},
    uncork() {},
    createChannel(spec) {
      const channel = {
        closed: false,
        closeCount: 0,
        messages: spec.messages.map(message => ({ ...message, send() { return true } })),
        open(localHello) {
          this.localHello = localHello
          if (autoOpen) queueMicrotask(() => spec.onopen(localHello))
        },
        close() {
          if (this.closed) return
          this.closed = true
          this.closeCount++
          spec.onclose?.()
        },
      }
      channels.push({ spec, channel })
      return channel
    },
  }
}

function attach(overrides = {}) {
  const service = overrides.announcement || announcement()
  const connection = overrides.connection || Object.assign(new EventEmitter(), {
    remotePublicKey: b4a.from(service.transportPublicKey),
    destroyCount: 0,
    destroy() { this.destroyCount++ },
  })
  const mux = overrides.mux || fakeMux()
  const indexStore = overrides.indexStore || { closeCount: 0, close() { this.closeCount++ } }
  const protocol = attachIndexServiceProtocol({
    connection,
    announcement: service,
    indexStore,
    limits: {
      sequenceState: new Map(),
      now: () => NOW + 1,
      muxFactory: () => mux,
      maxFrameBytes: 8192,
      ...overrides.limits,
    },
  })
  return { connection, indexStore, mux, protocol, service }
}

test('indexer public entry exports the service announcement and protocol helpers', t => {
  t.is(indexerEntry.createIndexServiceAnnouncement, createIndexServiceAnnouncement)
  t.is(indexerEntry.attachIndexServiceProtocol, attachIndexServiceProtocol)
  for (const name of [
    'signIndexServiceAnnouncement',
    'encodeIndexServiceAnnouncement',
    'decodeIndexServiceAnnouncement',
    'verifyIndexServiceAnnouncement',
    'deriveIndexerId',
  ]) t.is(typeof indexerEntry[name], 'function', name)
  t.is(indexerEntry.IndexServiceAnnouncementV1.version, 1)
  t.is(typeof indexerEntry.INDEX_SERVICE_PROTOCOL, 'string')
})

test('index peer frames use the stable scoped purpose code', t => {
  const encoded = encodePeerFrame({
    purpose: 'index',
    type: 'probe',
    requestId: 1,
    payload: b4a.from('index'),
  })
  t.is(encoded.readUInt8(6), 7)
  const decoded = decodePeerFrame(encoded)
  t.is(decoded.purpose, 'index')
  t.is(decoded.type, 'probe')
  t.alike(decoded.payload, b4a.from('index'))
  const live = encodePeerFrame({ purpose: 'live', type: 'probe', requestId: 2, payload: b4a.alloc(0) })
  t.is(live.readUInt8(6), 4)
  t.is(decodePeerFrame(live).purpose, 'live')
})

test('index protocol requires the scoped hello before use and activates only after authorization', async t => {
  const fixture = attach()
  t.is(fixture.protocol.state, 'handshaking')
  await t.exception(fixture.protocol.receive(b4a.alloc(0)), /handshake required/)

  const entry = fixture.mux.channels[0]
  await entry.spec.onopen(encodeScopedHello({
    purpose: 'index',
    topic: deriveIndexTopic({ indexerId: fixture.service.indexerId }),
    protocolMajor: PROTOCOL_MAJOR,
    capabilities: [INDEX_QUERY_CAPABILITY],
    maxFrameBytes: 4096,
  }))
  t.is(fixture.protocol.state, 'active')
  t.is(fixture.protocol.maxFrameBytes, 4096)
})

test('index protocol compares the live Noise transport key before creating a channel', t => {
  const service = announcement()
  const mux = fakeMux()
  t.exception(() => attach({
    announcement: service,
    connection: { remotePublicKey: b4a.alloc(32, 99) },
    mux,
  }), /transport public key mismatch/)
  t.is(mux.channels.length, 0)
  t.exception(() => attach({
    announcement: service,
    connection: { remotePublicKey: b4a.alloc(31) },
    mux,
  }), /live 32-byte remote transport key/)
})

test('index protocol rejects a peer without index-query:v1', async t => {
  const fixture = attach()
  const entry = fixture.mux.channels[0]
  await entry.spec.onopen(encodeScopedHello({
    purpose: 'index',
    topic: deriveIndexTopic({ indexerId: fixture.service.indexerId }),
    protocolMajor: PROTOCOL_MAJOR,
    capabilities: [],
    maxFrameBytes: 4096,
  }))
  t.is(fixture.protocol.state, 'closed')
  t.ok(entry.channel.closed)
})

test('index protocol rejects expired and unsupported announcements before channel creation', t => {
  const expired = announcement({ issuedAt: NOW - 60_000, expiresAt: NOW })
  const expiredMux = fakeMux()
  t.exception(() => attach({ announcement: expired, mux: expiredMux, limits: { now: () => NOW + 1 } }), /announcement.*invalid|expired/)
  t.is(expiredMux.channels.length, 0)

  const unsupported = announcement()
  unsupported.queryCapabilities = ['unsupported-query']
  const unsupportedMux = fakeMux()
  t.exception(() => attach({ announcement: unsupported, mux: unsupportedMux }), /announcement.*invalid|unsupported/)
  t.is(unsupportedMux.channels.length, 0)
})

test('index protocol negotiates the lower bounded frame ceiling', async t => {
  const fixture = attach({ limits: { maxFrameBytes: 8192 } })
  const entry = fixture.mux.channels[0]
  await entry.spec.onopen(encodeScopedHello({
    purpose: 'index',
    topic: deriveIndexTopic({ indexerId: fixture.service.indexerId }),
    protocolMajor: PROTOCOL_MAJOR,
    capabilities: [INDEX_QUERY_CAPABILITY],
    maxFrameBytes: 2048,
  }))
  t.is(fixture.protocol.maxFrameBytes, 2048)
  t.ok(fixture.protocol.maxFrameBytes <= MAX_PEER_FRAME_BYTES)
})

test('index protocol teardown is idempotent and preserves caller-owned connection and store', t => {
  const fixture = attach()
  t.is(fixture.protocol.close('test-complete'), true)
  t.is(fixture.protocol.close('duplicate'), false)
  t.is(fixture.mux.channels[0].channel.closeCount, 1)
  t.is(fixture.connection.destroyCount, 0)
  t.is(fixture.indexStore.closeCount, 0)
})

test('index protocol requires explicit monotonic sequence state and rejects stale or repeated announcements', t => {
  const signer = keyPair(9)
  const transportPublicKey = b4a.alloc(32, 10)
  const sequenceState = new Map()
  const current = announcement({ signer, transportPublicKey, sequence: 8 })
  const stale = announcement({ signer, transportPublicKey, sequence: 7 })
  t.exception(() => attach({
    announcement: current,
    limits: { sequenceState, maxFrameBytes: MAX_PEER_FRAME_BYTES + 1 },
  }), /maxFrameBytes|frame/)
  t.is(sequenceState.size, 0)
  const first = attach({ announcement: current, limits: { sequenceState } })
  first.protocol.close('complete')
  t.exception(() => attach({ announcement: stale, limits: { sequenceState } }), /invalid|replay|sequence/)
  t.exception(() => attach({ announcement: current, limits: { sequenceState } }), /invalid|replay|sequence/)
  t.exception(() => attachIndexServiceProtocol({
    connection: { remotePublicKey: transportPublicKey },
    announcement: current,
    indexStore: {},
    limits: { now: () => NOW + 1, muxFactory: () => fakeMux() },
  }), /sequenceState/)
})

function fakeSwarm() {
  const swarm = new EventEmitter()
  swarm.connections = new Set()
  swarm.joins = []
  swarm.joinedPeers = []
  swarm.leftPeers = []
  swarm.join = (topic, options) => {
    const handle = {
      topic: b4a.from(topic),
      options,
      destroyed: 0,
      async flushed() {},
      destroy() { this.destroyed++ },
      async suspend() {},
      async resume() {},
    }
    swarm.joins.push(handle)
    return handle
  }
  swarm.joinPeer = key => { swarm.joinedPeers.push(b4a.from(key)) }
  swarm.leavePeer = key => { swarm.leftPeers.push(b4a.from(key)) }
  return swarm
}

test('scoped runtime ref-counts direct peers and never globally discovers index scopes', async t => {
  const transportPublicKey = b4a.alloc(32, 44)
  const first = announcement({ signer: keyPair(11), transportPublicKey })
  const second = announcement({ signer: keyPair(12), transportPublicKey })
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({ swarm, store: {}, bootstrapEnabled: false, now: () => NOW + 1 })
  await runtime.start()

  await runtime.retainIndexService({ announcement: first, indexStore: {} })
  await runtime.retainIndexService({ announcement: second, indexStore: {} })
  t.is(swarm.joinedPeers.length, 1)
  t.is(swarm.joins.length, 0, 'index service does not create a global topic discovery')

  await runtime.releaseIndexService({ indexerId: first.indexerId })
  t.is(swarm.leftPeers.length, 0, 'shared transport remains joined')
  await runtime.releaseIndexService({ indexerId: second.indexerId })
  t.is(swarm.leftPeers.length, 1)
  t.alike(swarm.leftPeers[0], transportPublicKey)
  await runtime.close()
})

test('overlapping network disable and enable leaves retained direct peers joined for the final policy', async t => {
  const service = announcement({ signer: keyPair(18), transportPublicKey: b4a.alloc(32, 52) })
  const swarm = fakeSwarm()
  let effectivelyJoined = false
  let releaseLeave
  const leaveBarrier = new Promise(resolve => { releaseLeave = resolve })
  let enteredLeave
  const leaveEntered = new Promise(resolve => { enteredLeave = resolve })
  swarm.joinPeer = key => {
    swarm.joinedPeers.push(b4a.from(key))
    effectivelyJoined = true
  }
  swarm.leavePeer = async key => {
    swarm.leftPeers.push(b4a.from(key))
    enteredLeave()
    await leaveBarrier
    effectivelyJoined = false
  }
  const runtime = createScopedNetworkRuntime({ swarm, store: {}, bootstrapEnabled: false, now: () => NOW + 1 })
  await runtime.start()
  await runtime.retainIndexService({ announcement: service, indexStore: {} })
  const disable = runtime.applyNetworkPolicy({
    networkEnabled: false,
    uploadPermission: 'disabled',
    uploadCeilingBytes: 0,
    diskCeilingBytes: 0,
  })
  await leaveEntered
  const enable = runtime.applyNetworkPolicy({
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 1,
    diskCeilingBytes: 1,
  })
  releaseLeave()
  await Promise.all([disable, enable])
  t.is(runtime.getDiagnostics().policy.networkEnabled, true)
  t.is(effectivelyJoined, true)
  t.is(swarm.joinedPeers.length, 2)
  await runtime.close()
})

test('monotonic supersession on one transport avoids direct-peer join churn', async t => {
  const signer = keyPair(13)
  const transportPublicKey = b4a.alloc(32, 46)
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({ swarm, store: {}, bootstrapEnabled: false, now: () => NOW + 1 })
  await runtime.start()
  await runtime.retainIndexService({ announcement: announcement({ signer, transportPublicKey, sequence: 1 }), indexStore: {} })
  const result = await runtime.retainIndexService({ announcement: announcement({ signer, transportPublicKey, sequence: 2 }), indexStore: {} })
  t.is(result.status, 'superseded')
  t.is(swarm.joinedPeers.length, 1)
  t.is(swarm.leftPeers.length, 0)
  await runtime.releaseIndexService({ indexerId: deriveIndexerId(signer.publicKey) })
  t.is(swarm.leftPeers.length, 1)
  await runtime.close()
})

test('concurrent different-transport supersessions cannot overwrite a newer sequence', async t => {
  const signer = keyPair(14)
  const transport1 = b4a.alloc(32, 47)
  const transport2 = b4a.alloc(32, 48)
  const transport3 = b4a.alloc(32, 49)
  const swarm = fakeSwarm()
  let releaseBarrier
  const barrier = new Promise(resolve => { releaseBarrier = resolve })
  let enteredRelease
  const releaseEntered = new Promise(resolve => { enteredRelease = resolve })
  let blockFirstRelease = true
  swarm.leavePeer = key => {
    swarm.leftPeers.push(b4a.from(key))
    if (!blockFirstRelease) return undefined
    blockFirstRelease = false
    enteredRelease()
    return barrier
  }
  const runtime = createScopedNetworkRuntime({ swarm, store: {}, bootstrapEnabled: false, now: () => NOW + 1 })
  await runtime.start()
  await runtime.retainIndexService({ announcement: announcement({ signer, transportPublicKey: transport1, sequence: 1 }), indexStore: {} })
  const sequence2 = runtime.retainIndexService({ announcement: announcement({ signer, transportPublicKey: transport2, sequence: 2 }), indexStore: {} })
  await releaseEntered
  const sequence3 = runtime.retainIndexService({ announcement: announcement({ signer, transportPublicKey: transport3, sequence: 3 }), indexStore: {} })
  releaseBarrier()
  await Promise.all([sequence2, sequence3])
  t.alike(swarm.joinedPeers.at(-1), transport3)
  t.is(runtime.getDiagnostics().topics.find(topic => topic.purpose === 'index').transportPublicKey, b4a.toString(transport3, 'hex'))
  await runtime.releaseIndexService({ indexerId: deriveIndexerId(signer.publicKey) })
  await runtime.close()
})

test('runtime close drains a blocked supersession and prevents post-close service resurrection', async t => {
  const signer = keyPair(15)
  const transport1 = b4a.alloc(32, 50)
  const transport2 = b4a.alloc(32, 51)
  const swarm = fakeSwarm()
  let releaseBarrier
  const barrier = new Promise(resolve => { releaseBarrier = resolve })
  let enteredRelease
  const releaseEntered = new Promise(resolve => { enteredRelease = resolve })
  swarm.leavePeer = key => {
    swarm.leftPeers.push(b4a.from(key))
    enteredRelease()
    return barrier
  }
  const indexStore = { closes: 0, close() { this.closes++ } }
  const runtime = createScopedNetworkRuntime({ swarm, store: {}, bootstrapEnabled: false, now: () => NOW + 1 })
  await runtime.start()
  await runtime.retainIndexService({ announcement: announcement({ signer, transportPublicKey: transport1, sequence: 1 }), indexStore })
  const replacement = runtime.retainIndexService({
    announcement: announcement({ signer, transportPublicKey: transport2, sequence: 2 }),
    indexStore,
  })
  await releaseEntered
  const closing = runtime.close()
  releaseBarrier()
  await t.exception(replacement, /runtime is not active|runtime is closed/)
  await closing
  t.is(runtime.getDiagnostics().status, 'closed')
  t.absent(runtime.getDiagnostics().topics.find(topic => topic.purpose === 'index'))
  t.is(swarm.joinedPeers.length, 1)
  t.is(indexStore.closes, 0)
  await runtime.close()
})

test('announcement expiry closes the retained index scope and releases its direct peer', async t => {
  let clock = NOW + 1
  let expire = null
  const timer = { unref() {} }
  const service = announcement({ transportPublicKey: b4a.alloc(32, 45), expiresAt: NOW + 2 })
  const swarm = fakeSwarm()
  const indexStore = { closes: 0, close() { this.closes++ } }
  const runtime = createScopedNetworkRuntime({ swarm, store: {}, bootstrapEnabled: false, now: () => clock })
  await runtime.start()
  await runtime.retainIndexService({
    announcement: service,
    indexStore,
    limits: {
      setTimeout(callback) { expire = callback; return timer },
      clearTimeout() {},
    },
  })
  t.is(swarm.joinedPeers.length, 1)
  clock = NOW + 3
  expire()
  await new Promise(resolve => setTimeout(resolve, 0))
  t.is(swarm.leftPeers.length, 1)
  t.absent(runtime.getDiagnostics().topics.find(topic => topic.purpose === 'index'))
  t.is(indexStore.closes, 0)
  await runtime.close()
})

test('scoped runtime authorizes index channels only on the signed transport connection', async t => {
  const service = announcement({ transportPublicKey: b4a.alloc(32, 55) })
  const swarm = fakeSwarm()
  const wrongMux = fakeMux({ autoOpen: true })
  const rightMux = fakeMux({ autoOpen: true })
  const muxedConnections = []
  const wrong = Object.assign(new EventEmitter(), { remotePublicKey: b4a.alloc(32, 56) })
  const missing = new EventEmitter()
  const right = Object.assign(new EventEmitter(), { remotePublicKey: b4a.from(service.transportPublicKey) })
  const runtime = createScopedNetworkRuntime({
    swarm,
    store: {},
    bootstrapEnabled: false,
    now: () => NOW + 1,
    muxFactory: connection => {
      muxedConnections.push(connection)
      return connection === right ? rightMux : wrongMux
    },
  })
  await runtime.start()
  await runtime.retainIndexService({ announcement: service, indexStore: {} })
  t.is(runtime.authorizeConnection({
    purpose: 'index',
    topic: deriveIndexTopic({ indexerId: service.indexerId }),
    peerId: b4a.toString(service.transportPublicKey, 'hex'),
  }).status, 'rejected')
  swarm.emit('connection', wrong, { publicKey: service.transportPublicKey, client: true })
  swarm.emit('connection', missing, { publicKey: service.transportPublicKey, client: true })
  swarm.emit('connection', right, { publicKey: right.remotePublicKey, client: true })
  await new Promise(resolve => setTimeout(resolve, 0))

  t.is(wrongMux.channels.length, 0)
  t.is(muxedConnections.includes(wrong), true)
  t.is(muxedConnections.includes(missing), true)
  t.is(rightMux.channels.length, 1)
  t.ok(runtime.getDiagnostics().sessions.some(session => session.purpose === 'index' && session.state === 'active'))

  await runtime.releaseIndexService({ indexerId: service.indexerId })
  t.ok(rightMux.channels[0].channel.closed)
  await runtime.close()
})

test('incoming unmatched connection is paired before a later retained index scope opens', async t => {
  const first = announcement({ signer: keyPair(19), transportPublicKey: b4a.alloc(32, 57) })
  const second = announcement({ signer: keyPair(20), transportPublicKey: b4a.alloc(32, 58) })
  const swarm = fakeSwarm()
  const mux = fakeMux({ autoOpen: true })
  const connection = Object.assign(new EventEmitter(), { remotePublicKey: b4a.from(second.transportPublicKey) })
  const runtime = createScopedNetworkRuntime({
    swarm,
    store: {},
    bootstrapEnabled: false,
    now: () => NOW + 1,
    muxFactory: () => mux,
  })
  await runtime.start()
  await runtime.retainIndexService({ announcement: first, indexStore: {} })
  swarm.emit('connection', connection, { publicKey: first.transportPublicKey, client: false })
  const pair = mux.pairs.find(entry => entry.spec.protocol.endsWith('/index'))
  t.ok(pair)
  await runtime.retainIndexService({ announcement: second, indexStore: {} })
  pair.onpair(deriveIndexTopic({ indexerId: second.indexerId }))
  await new Promise(resolve => setTimeout(resolve, 0))
  t.is(mux.channels.length, 1)
  t.ok(runtime.getDiagnostics().sessions.some(session =>
    session.purpose === 'index' &&
    session.peerId === b4a.toString(second.transportPublicKey, 'hex') &&
    session.state === 'active'
  ))
  await runtime.releaseIndexService({ indexerId: first.indexerId })
  await runtime.releaseIndexService({ indexerId: second.indexerId })
  await runtime.close()
})

test('runtime close releases each retained direct transport once without closing caller resources', async t => {
  const service = announcement({ transportPublicKey: b4a.alloc(32, 66) })
  const swarm = fakeSwarm()
  const indexStore = { closes: 0, close() { this.closes++ } }
  const connection = Object.assign(new EventEmitter(), { remotePublicKey: b4a.from(service.transportPublicKey), destroys: 0, destroy() { this.destroys++ } })
  swarm.connections.add(connection)
  const runtime = createScopedNetworkRuntime({ swarm, store: {}, bootstrapEnabled: false, now: () => NOW + 1, muxFactory: () => fakeMux({ autoOpen: true }) })
  await runtime.start()
  await runtime.retainIndexService({ announcement: service, indexStore })
  await runtime.close()
  await runtime.close()
  t.is(swarm.leftPeers.length, 1)
  t.is(indexStore.closes, 0)
  t.is(connection.destroys, 0)
})
