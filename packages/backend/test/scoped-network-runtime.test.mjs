import test from 'brittle'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Duplex, PassThrough } from 'node:stream'
import b4a from 'b4a'
import Corestore from 'corestore'
import crypto from 'hypercore-crypto'

import {
  BOOTSTRAP_LOCATOR_CAPABILITY,
  createBootstrapLocator,
} from '../src/discovery/bootstrap-protocol.js'
import {
  ASSET_BLOCK_SIZE,
  createPublicationManifest,
  createRenditionDescriptor,
  createStaticAssetManifest,
  deriveStaticAssetTopic,
  writeStaticAsset,
} from '../src/assets/index.js'
import {
  createArchiveChallenge,
  createArchiveChallengeEnvelope,
  createArchiveChallengeResponse,
  createArchivePossessionProof,
} from '../src/archive/challenge.js'
import { createArchivePledge } from '../src/archive/pledge.js'
import { createArchiveRequest } from '../src/archive/request.js'
import {
  createPublisherNamespaceDescriptor,
  derivePublisherId,
} from '../src/publisher/index.js'
import {
  createScopedNetworkRuntime,
  createScopedProtocolSession,
  encodeScopedHello,
} from '../src/network/scoped-runtime.js'
import {
  deriveArchiveTopic,
  deriveBootstrapTopic,
  derivePublisherTopic,
} from '../src/network/topics.js'
import { encodePeerFrame } from '../src/network/frame.js'

function bytes (size, fill) {
  return b4a.alloc(size, fill)
}

function connectionPair () {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = Duplex.from({ readable: bToA, writable: aToB })
  const b = Duplex.from({ readable: aToB, writable: bToA })
  a.userData = null
  b.userData = null
  a.remotePublicKey = bytes(32, 201)
  b.remotePublicKey = bytes(32, 202)
  return { a, b }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

function fakeSwarm () {
  const swarm = new EventEmitter()
  swarm.connections = new Set()
  swarm.joins = []
  swarm.join = (topic, options) => {
    const handle = {
      topic: b4a.from(topic),
      options,
      destroyed: 0,
      flushed: async () => {},
      destroy () { this.destroyed++ },
      suspended: 0,
      resumed: 0,
      async suspend () { this.suspended++ },
      async resume () { this.resumed++ },
    }
    swarm.joins.push(handle)
    return handle
  }
  return swarm
}

function fakeRegistry (descriptor) {
  const catalogEvents = new EventEmitter()
  const catalog = {
    key: descriptor.catalogBootstrapKey,
    writable: true,
    replicated: [],
    async ready () {},
    async close () {},
    async listProjections () { return { items: [], nextCursor: null } },
  }
  const core = {
    key: descriptor.catalogBootstrapKey,
    replicate (connection) { catalog.replicated.push(connection) },
  }
  catalog.base = Object.assign(catalogEvents, {
    key: descriptor.catalogBootstrapKey,
    _primaryBootstrap: core,
    local: core,
    core,
    view: { core },
    activeWriters: [],
    _bootstrapWriters: [],
  })
  catalog.view = catalog.base.view
  const binding = {
    catalog,
    publisherId: descriptor.publisherId,
    genesisRootKey: descriptor.publisherRootKey,
    catalogBootstrapKey: descriptor.catalogBootstrapKey,
    namespaceDescriptor: descriptor,
  }
  return {
    binding,
    async bindNamespace () { return binding },
    async resolve () { return binding },
    async release () { return true },
  }
}

test('startup republishes only persisted writable catalogs with accepted projections', async t => {
  const root = crypto.keyPair(bytes(32, 19))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 20),
  })
  const registry = fakeRegistry(descriptor)
  registry.binding.catalog.listProjections = async kind => ({
    items: kind === 'publication' ? [{ accepted: true }] : [],
    nextCursor: null,
  })
  registry.getWritableBindings = async () => [registry.binding]
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({ swarm, store: {}, catalogRegistry: registry })

  await runtime.start()

  t.is(swarm.joins.length, 2, 'bootstrap and persisted non-empty publisher scopes are joined')
  t.ok(runtime.getDiagnostics().topics.some(topic => topic.purpose === 'publisher'))
  await runtime.close()
})

test('persisted runtime policy gates discovery startup and resumes without duplicate scopes', async (t) => {
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({
    swarm,
    store: {},
    initialNetworkPolicy: {
      networkEnabled: false,
      uploadPermission: 'disabled',
      uploadCeilingBytes: 0,
      diskCeilingBytes: 0,
    },
  })

  await runtime.start()
  t.is(swarm.joins.length, 0, 'forbidden persisted network policy applies before discovery starts')

  await runtime.applyNetworkPolicy({
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 1024,
    diskCeilingBytes: 1024,
  })
  t.is(swarm.joins.length, 1)

  await runtime.applyNetworkPolicy({
    networkEnabled: false,
    uploadPermission: 'disabled',
    uploadCeilingBytes: 0,
    diskCeilingBytes: 0,
  })
  t.is(swarm.joins[0].suspended, 1)
  t.is(runtime.getDiagnostics().sessions.length, 0)

  await runtime.applyNetworkPolicy({
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 1024,
    diskCeilingBytes: 1024,
  })
  t.is(swarm.joins.length, 1, 'resume reuses the existing bounded scope')
  t.is(swarm.joins[0].resumed, 1)
  await runtime.close()
})


function makeProtocolSession ({ purpose = 'bootstrap', topic = deriveBootstrapTopic(), capability = BOOTSTRAP_LOCATOR_CAPABILITY, work } = {}) {
  return createScopedProtocolSession({
    peerId: 'remote-a',
    purpose,
    topic,
    protocolMajor: 1,
    requiredCapability: capability,
    onActivate: work,
    onFrame: work,
  })
}

test('protocol rejects wrong capability, topic, major, replay and oversize before work', async (t) => {
  const topic = deriveBootstrapTopic()
  let work = 0
  const wrongCapability = makeProtocolSession({ topic, work: () => { work++ } })
  await t.exception(wrongCapability.acceptHello(encodeScopedHello({
    purpose: 'bootstrap', topic, protocolMajor: 1, capabilities: ['not-supported:v1'], maxFrameBytes: 1024,
  })), /capability/i)

  const wrongTopic = makeProtocolSession({ topic, work: () => { work++ } })
  await t.exception(wrongTopic.acceptHello(encodeScopedHello({
    purpose: 'bootstrap', topic: bytes(32, 9), protocolMajor: 1, capabilities: [BOOTSTRAP_LOCATOR_CAPABILITY], maxFrameBytes: 1024,
  })), /topic/i)

  const wrongMajor = makeProtocolSession({ topic, work: () => { work++ } })
  await t.exception(wrongMajor.acceptHello(encodeScopedHello({
    purpose: 'bootstrap', topic, protocolMajor: 2, capabilities: [BOOTSTRAP_LOCATOR_CAPABILITY], maxFrameBytes: 1024,
  })), /major/i)

  const active = makeProtocolSession({ topic, work: () => { work++ } })
  await active.acceptHello(encodeScopedHello({
    purpose: 'bootstrap', topic, protocolMajor: 1, capabilities: [BOOTSTRAP_LOCATOR_CAPABILITY], maxFrameBytes: 1024,
  }))
  const frame = encodePeerFrame({ purpose: 'bootstrap', type: 'locator', requestId: 1, payload: bytes(4, 1) })
  await active.receive(frame)
  await t.exception(active.receive(frame), /replay/i)
  await t.exception(active.receive(bytes(1025, 1)), /maximum|frame/i)
  t.is(work, 2, 'only activation and the first valid frame reached work')
})

test('bootstrap frames can never authorize or open a core', async (t) => {
  const swarm = fakeSwarm()
  let opened = 0
  const runtime = createScopedNetworkRuntime({
    swarm,
    store: { get () { opened++; throw new Error('bootstrap opened core') } },
    trustedBootstrapSigners: [bytes(32, 1)],
  })
  await runtime.start()
  const result = await runtime.inspectIncomingFrame({
    purpose: 'bootstrap',
    topic: deriveBootstrapTopic(),
    peerId: 'peer-a',
    frame: encodePeerFrame({ purpose: 'bootstrap', type: 'open-core', requestId: 1, payload: bytes(32, 2) }),
  })
  t.is(result.status, 'rejected')
  t.is(opened, 0)
  await runtime.close()
})

test('only a followed publisher with a verified namespace can open its catalog', async (t) => {
  const root = crypto.keyPair(bytes(32, 11))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 12),
  })
  const registry = fakeRegistry(descriptor)
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({ swarm, store: {}, catalogRegistry: registry, muxFactory: connection => connection })
  await runtime.start()

  const publisherId = b4a.toString(derivePublisherId(root.publicKey), 'hex')
  const topic = derivePublisherTopic({ publisherId, catalogEpoch: 0 })
  t.is(runtime.authorizeConnection({ purpose: 'publisher', topic, peerId: 'before-follow' }).status, 'rejected')
  t.is(registry.binding.catalog.replicated.length, 0)

  const followed = await runtime.followPublisher({ publisherId, namespaceDescriptor: descriptor })
  t.is(followed.status, 'following')
  const connection = { id: 'catalog-connection' }
  const authorized = runtime.authorizeConnection({ purpose: 'publisher', topic, peerId: 'after-follow', connection })
  t.is(authorized.status, 'authorized')
  t.is(registry.binding.catalog.replicated.length, 1)

  await runtime.unfollowPublisher({ publisherId })
  t.is(runtime.authorizeConnection({ purpose: 'publisher', topic, peerId: 'after-unfollow' }).status, 'rejected')
  await runtime.close()
})

test('local publisher scope is not announced before an accepted publication or claim exists', async t => {
  const root = crypto.keyPair(bytes(32, 18))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 19),
  })
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({ swarm, store: {}, catalogRegistry: fakeRegistry(descriptor) })
  await runtime.start()
  await t.exception(runtime.publishLocalPublisherCatalog({ publisherId: descriptor.publisherId }), /empty|accepted/i)
  t.is(swarm.joins.length, 1, 'only bootstrap discovery is joined')
  await runtime.close()
})

test('authorized rendition range opens the canonical static core and never crosses asset topics', async (t) => {
  const publisher = crypto.keyPair(bytes(32, 21))
  const staticCore = createStaticAssetManifest({
    treeHash: bytes(32, 24),
    blockLength: 8,
    byteLength: 8 * ASSET_BLOCK_SIZE,
  })
  const allowedCore = staticCore.key
  const otherCore = bytes(32, 23)
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    title: 'Scoped asset',
    renditions: [createRenditionDescriptor({ purpose: 'video', format: 'video/mp4', core: staticCore })],
    keyPair: publisher,
    signedAt: 10,
    expiresAt: 1000,
  })
  const renditionId = manifest.body.renditions[0].renditionId
  const opened = []
  const downloads = []
  const swarm = fakeSwarm()
  let unrestrictedReplications = 0
  const runtime = createScopedNetworkRuntime({
    swarm,
    authorizePublication: async request => request.manifest === manifest,
    muxFactory: () => ({}),
    store: {
      get ({ key, manifest: hypercoreManifest, writable }) {
        const keyHex = b4a.toString(key, 'hex')
        opened.push(keyHex)
        t.ok(hypercoreManifest, 'canonical Hypercore manifest accompanies the static key')
        t.is(writable, false)
        return {
          key,
          ready: async () => {},
          replicate: () => { unrestrictedReplications++ },
          download: range => { downloads.push(range); return { destroy () {} } },
          close () {},
        }
      },
    },
    now: () => 20,
  })
  await runtime.start()
  const retained = await runtime.retainAuthorizedRendition({ manifest, renditionId, start: 2, end: 5 })
  t.is(retained.status, 'retained')
  t.is(retained.assetId, b4a.toString(allowedCore, 'hex'))
  t.alike(opened, [b4a.toString(allowedCore, 'hex')])
  t.alike(downloads, [{ start: 2, end: 5 }])
  const assetTopic = deriveStaticAssetTopic(allowedCore)
  const authorized = runtime.authorizeConnection({
    purpose: 'asset',
    topic: assetTopic,
    peerId: 'asset-authorized',
    connection: {},
    requestedCoreKey: b4a.toString(allowedCore, 'hex'),
  })
  t.is(authorized.status, 'authorized')
  t.is(unrestrictedReplications, 0, 'authorized exact ranges never expose unrestricted Hypercore replication')

  t.is(runtime.authorizeConnection({ purpose: 'asset', topic: assetTopic, peerId: 'asset-a', requestedCoreKey: b4a.toString(otherCore, 'hex') }).status, 'rejected')
  t.is(runtime.authorizeConnection({ purpose: 'asset', topic: deriveStaticAssetTopic(otherCore), peerId: 'asset-b' }).status, 'rejected')
  t.alike(opened, [b4a.toString(allowedCore, 'hex')], 'unauthorized known core is never opened')

  await runtime.releaseAuthorizedRendition({ renditionId })
  await runtime.close()
})

test('fresh Corestore retains and replicates a canonical static asset using its reconstructed manifest', async (t) => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-static-source-'))
  const readerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-static-reader-'))
  const sourceStore = new Corestore(sourceDir)
  const readerStore = new Corestore(readerDir)
  await sourceStore.ready()
  await readerStore.ready()
  const asset = await writeStaticAsset({
    store: sourceStore,
    source: [b4a.from('fresh static replication')],
  })
  const sourceReplication = sourceStore.replicate(true)
  const readerReplication = readerStore.replicate(false)
  sourceReplication.pipe(readerReplication).pipe(sourceReplication)
  const publisher = crypto.keyPair(bytes(32, 25))
  const rendition = createRenditionDescriptor({
    purpose: 'video',
    format: 'video/webm',
    core: asset.descriptor,
  })
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    title: 'Fresh static reader',
    renditions: [rendition],
    keyPair: publisher,
    signedAt: 10,
    expiresAt: 1000,
  })
  const runtime = createScopedNetworkRuntime({
    swarm: fakeSwarm(),
    store: readerStore,
    authorizePublication: async request => request.manifest === manifest,
  })
  t.teardown(async () => {
    await runtime.close().catch(() => {})
    sourceReplication.destroy()
    readerReplication.destroy()
    await asset.core.close().catch(() => {})
    await sourceStore.close()
    await readerStore.close()
    fs.rmSync(sourceDir, { recursive: true, force: true })
    fs.rmSync(readerDir, { recursive: true, force: true })
  })

  await runtime.start()
  const retained = await runtime.retainAuthorizedRendition({
    manifest,
    renditionId: rendition.renditionId,
    start: 0,
    end: rendition.core.length,
  })
  t.is(retained.status, 'retained')
  t.is(retained.assetId, rendition.core.assetId)
  const replicated = readerStore.get({
    key: asset.descriptor.key,
    manifest: asset.descriptor.hypercoreManifest,
    writable: false,
  })
  await replicated.ready()
  t.is(b4a.toString(await replicated.get(0)), 'fresh static replication')
  await replicated.close()
})

test('identical assets share discovery while rendition owners retain independent leases', async (t) => {
  const publisher = crypto.keyPair(bytes(32, 26))
  const core = createStaticAssetManifest({
    treeHash: bytes(32, 27),
    blockLength: 1,
    byteLength: 1024,
  })
  const firstRendition = createRenditionDescriptor({ purpose: 'original', format: 'video/mp4', core })
  const secondRendition = createRenditionDescriptor({ purpose: 'preview', format: 'video/webm', core })
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    title: 'Shared static asset',
    renditions: [firstRendition, secondRendition],
    keyPair: publisher,
    signedAt: 10,
    expiresAt: 1000,
  })
  const alternateManifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence: 2,
    title: 'Alternate publication owner',
    renditions: [firstRendition],
    keyPair: publisher,
    signedAt: 11,
    expiresAt: 1000,
  })
  const authorizedManifests = new Set([manifest, alternateManifest])
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({
    swarm,
    authorizePublication: async request => authorizedManifests.has(request.manifest),
    store: {
      get({ key }) {
        return {
          key,
          async ready() {},
          download() { return { destroy() {} } },
          async close() {},
        }
      },
    },
  })
  await runtime.start()
  const first = await runtime.retainAuthorizedRendition({
    manifest,
    renditionId: firstRendition.renditionId,
    ownerId: manifest.publicationId,
    end: core.length,
  })
  const second = await runtime.retainAuthorizedRendition({
    manifest,
    renditionId: secondRendition.renditionId,
    ownerId: manifest.publicationId,
    end: core.length,
  })
  const alternate = await runtime.retainAuthorizedRendition({
    manifest: alternateManifest,
    renditionId: firstRendition.renditionId,
    ownerId: alternateManifest.publicationId,
    end: core.length,
  })
  t.is(first.assetId, core.assetId)
  t.is(second.assetId, core.assetId)
  t.is(alternate.status, 'retained')
  t.is(first.topic.topicHex, second.topic.topicHex)
  t.is(swarm.joins.filter(join => b4a.equals(join.topic, deriveStaticAssetTopic(core.assetId))).length, 1)

  authorizedManifests.delete(manifest)
  t.alike(await runtime.revalidateRetainedRenditions(), { released: 2 })
  t.is(runtime.authorizeConnection({
    purpose: 'asset',
    topic: deriveStaticAssetTopic(core.assetId),
    requestedCoreKey: core.key,
  }).status, 'authorized')
  await runtime.releaseAuthorizedRendition({
    renditionId: firstRendition.renditionId,
    ownerId: alternateManifest.publicationId,
  })
  t.is(runtime.authorizeConnection({
    purpose: 'asset',
    topic: deriveStaticAssetTopic(core.assetId),
    requestedCoreKey: core.key,
  }).status, 'rejected')
  await runtime.close()
})

test('asset sessions transfer only manifest-authorized blocks over their scoped channel', async (t) => {
  const publisher = crypto.keyPair(bytes(32, 61))
  const staticCore = createStaticAssetManifest({
    treeHash: bytes(32, 63),
    blockLength: 6,
    byteLength: (5 * ASSET_BLOCK_SIZE) + 24,
  })
  const coreKey = staticCore.key
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    title: 'Scoped transfer',
    renditions: [createRenditionDescriptor({ purpose: 'video', format: 'video/mp4', core: staticCore })],
    keyPair: publisher,
    signedAt: 10,
    expiresAt: 1000,
  })
  const renditionId = manifest.body.renditions[0].renditionId
  const sourceBlocks = new Map([
    [2, b4a.from('block-2')],
    [3, b4a.from('block-3')],
    [4, b4a.from('block-4')],
  ])
  const received = new Map()
  const sourceCore = {
    key: coreKey,
    length: 6,
    async ready () {},
    async has (index) { return sourceBlocks.has(index) },
    async proof ({ block }) {
      return {
        fork: 0,
        block: { index: block.index, value: sourceBlocks.get(block.index), nodes: [] },
        hash: null,
        seek: null,
        upgrade: null,
        manifest: null,
      }
    },
    download () { return { destroy () {} } },
    async close () {},
  }
  const targetCore = {
    key: coreKey,
    length: 6,
    async ready () {},
    async has (index) { return received.has(index) },
    async applyProof (proof) {
      received.set(proof.block.index, b4a.from(proof.block.value))
      return true
    },
    download () { return { destroy () {} } },
    async close () {},
  }
  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  const runtimeA = createScopedNetworkRuntime({
    swarm: swarmA,
    store: { get: () => sourceCore },
    authorizePublication: async request => request.manifest === manifest,
  })
  const runtimeB = createScopedNetworkRuntime({
    swarm: swarmB,
    store: { get: () => targetCore },
    authorizePublication: async request => request.manifest === manifest,
  })
  await runtimeA.start()
  await runtimeB.start()

  const pair = connectionPair()
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey })
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey })
  await settle()
  await runtimeA.retainAuthorizedRendition({ manifest, renditionId, start: 2, end: 5 })
  await runtimeB.retainAuthorizedRendition({ manifest, renditionId, start: 2, end: 5 })
  for (let attempt = 0; attempt < 20 && received.size < 3; attempt++) await settle()

  t.alike([...received.keys()].sort((a, b) => a - b), [2, 3, 4])
  t.is(received.has(1), false, 'the peer never receives a block below its authorized range')
  t.is(received.has(5), false, 'the peer never receives a block at or above its authorized range end')

  await runtimeA.close()
  await runtimeB.close()
  pair.a.destroy()
  pair.b.destroy()
})

test('separate publishers and assets never cross-open and cleanup is exactly once', async (t) => {
  const swarm = fakeSwarm()
  const rootA = crypto.keyPair(bytes(32, 31))
  const descriptorA = createPublisherNamespaceDescriptor({ genesisRootKey: rootA.publicKey, catalogBootstrapKey: bytes(32, 32) })
  const runtime = createScopedNetworkRuntime({ swarm, store: {}, catalogRegistry: fakeRegistry(descriptorA) })
  await runtime.start()
  const publisherA = b4a.toString(descriptorA.publisherId, 'hex')
  await runtime.followPublisher({ publisherId: publisherA, namespaceDescriptor: descriptorA })

  const otherPublisherTopic = derivePublisherTopic({ publisherId: b4a.toString(bytes(32, 33), 'hex'), catalogEpoch: 0 })
  t.is(runtime.authorizeConnection({ purpose: 'publisher', topic: otherPublisherTopic, peerId: 'cross-publisher' }).status, 'rejected')

  const diagnostics = runtime.getDiagnostics()
  t.ok(diagnostics.topics.some(entry => entry.purpose === 'bootstrap'))
  t.ok(diagnostics.topics.some(entry => entry.purpose === 'publisher'))
  await runtime.close()
  await runtime.close()
  for (const handle of swarm.joins) t.is(handle.destroyed, 1, 'each scoped join leaves exactly once')
  t.is(runtime.getDiagnostics().status, 'closed')
})

test('real Protomux sessions open on both sides without server topic metadata and on late scopes', async (t) => {
  const root = crypto.keyPair(bytes(32, 41))
  const descriptor = createPublisherNamespaceDescriptor({ genesisRootKey: root.publicKey, catalogBootstrapKey: bytes(32, 42) })
  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  const registryA = fakeRegistry(descriptor)
  const registryB = fakeRegistry(descriptor)
  let catalogUpdates = 0
  const runtimeA = createScopedNetworkRuntime({
    swarm: swarmA,
    store: {},
    catalogRegistry: registryA,
    onCatalogUpdate: async () => { catalogUpdates++ },
  })
  const runtimeB = createScopedNetworkRuntime({ swarm: swarmB, store: {}, catalogRegistry: registryB })
  await runtimeA.start()
  await runtimeB.start()
  const pair = connectionPair()
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey, topics: [], client: false })
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey, topics: [deriveBootstrapTopic()], client: true })
  await settle()
  t.ok(runtimeA.getDiagnostics().sessions.some(session => session.purpose === 'bootstrap' && session.state === 'active'))
  t.ok(runtimeB.getDiagnostics().sessions.some(session => session.purpose === 'bootstrap' && session.state === 'active'))

  const publisherId = b4a.toString(descriptor.publisherId, 'hex')
  await runtimeB.followPublisher({ publisherId, namespaceDescriptor: descriptor })
  await settle()
  t.absent(runtimeB.getDiagnostics().sessions.find(session => session.purpose === 'publisher'), 'server-side late scope waits for the client initiator')
  await runtimeA.followPublisher({ publisherId, namespaceDescriptor: descriptor })
  await settle()
  t.ok(runtimeA.getDiagnostics().sessions.some(session => session.purpose === 'publisher' && session.state === 'active'))
  t.ok(runtimeB.getDiagnostics().sessions.some(session => session.purpose === 'publisher' && session.state === 'active'))
  registryA.binding.catalog.base.emit('update')
  await settle()
  t.is(catalogUpdates, 1, 'replicated catalog updates trigger projection refresh exactly once per session')

  await runtimeA.close()
  await runtimeB.close()
  pair.a.destroy()
  pair.b.destroy()
})

test('archive pledges retain multiple exact ranges without exposing a Hypercore responder', async (t) => {
  const archivist = crypto.keyPair(bytes(32, 51))
  const coreKey = bytes(32, 52)
  const pledge = createArchivePledge({
    archivistId: archivist.publicKey,
    publicationId: bytes(32, 53),
    renditionId: bytes(32, 54),
    ranges: [
      { coreKey, start: 0, end: 2 },
      { coreKey, start: 4, end: 7 },
    ],
    retentionUntil: 1000,
    issuedAt: 10,
    uploadCeilingBytes: 0,
    keyPair: archivist,
  })
  let replicated = 0
  let downloads = 0
  let closed = 0
  let protectedRanges = 0
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({
    swarm,
    now: () => 20,
    store: {
      get ({ key }) {
        return {
          key,
          async ready () {},
          replicate () { replicated++ },
          download () { downloads++; return { destroy () {} } },
          async close () { closed++ },
        }
      },
    },
    retainArchiveCore () {
      protectedRanges++
      return () => { protectedRanges-- }
    },
  })
  await runtime.start()
  const first = await runtime.retainAuthorizedArchive({ pledge, coreKey, start: 0, end: 2 })
  const second = await runtime.retainAuthorizedArchive({ pledge, coreKey, start: 4, end: 7, download: false })
  t.is(protectedRanges, 2)
  t.is(downloads, 1, 'verification-only requester scopes do not start a full-range download')
  t.is(first.archiveId, second.archiveId)
  t.is(runtime.getDiagnostics().topics.filter(topic => topic.purpose === 'archive').length, 1)
  const archiveTopic = deriveArchiveTopic({ archiveId: first.archiveId })
  t.is(runtime.authorizeConnection({ purpose: 'archive', topic: archiveTopic, requestedCoreKey: b4a.toString(coreKey, 'hex'), connection: {} }).action, 'archive-range')
  t.is(replicated, 0, 'archive connection never receives an unrestricted Hypercore responder')
  const released = await runtime.releaseAuthorizedArchive({ archiveId: first.archiveId })
  t.is(released.released, true)
  t.is(closed, 2)
  t.is(protectedRanges, 0)
  await runtime.close()
})

test('archive sessions transfer only pledge-authorized blocks over their scoped channel', async (t) => {
  const archivist = crypto.keyPair(bytes(32, 55))
  const coreKey = bytes(32, 56)
  const sourceBlocks = new Map([
    [2, bytes(1024, 2)],
    [3, bytes(96 * 1024, 3)],
    [4, bytes(1024, 4)],
    [5, bytes(200 * 1024, 5)],
  ])
  const received = new Map()
  const pledge = createArchivePledge({
    archivistId: archivist.publicKey,
    publicationId: bytes(32, 57),
    renditionId: bytes(32, 58),
    ranges: [{ coreKey, start: 2, end: 6 }],
    retentionUntil: 10_000,
    issuedAt: 10,
    uploadCeilingBytes: 256 * 1024,
    keyPair: archivist,
  })
  const sourceCore = {
    key: coreKey,
    length: 6,
    async ready () {},
    async has (index) { return sourceBlocks.has(index) },
    async proof ({ block }) {
      return {
        fork: 0,
        block: { index: block.index, value: sourceBlocks.get(block.index), nodes: [] },
        hash: null,
        seek: null,
        upgrade: null,
        manifest: null,
      }
    },
    download () { return { destroy () {} } },
    async close () {},
  }
  const targetCore = {
    key: coreKey,
    length: 6,
    async ready () {},
    async has (index) { return received.has(index) },
    async applyProof (proof) {
      received.set(proof.block.index, b4a.from(proof.block.value))
      return true
    },
    async verifyFullyRemote (proof) {
      if (!b4a.equals(proof.block.value, received.get(proof.block.index))) throw new Error('invalid proof')
      return true
    },
    download () { return { destroy () {} } },
    async close () {},
  }
  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  const runtimeA = createScopedNetworkRuntime({
    swarm: swarmA,
    store: { get: () => sourceCore },
    initialNetworkPolicy: {
      networkEnabled: true,
      uploadPermission: 'enabled',
      uploadCeilingBytes: 1024,
      diskCeilingBytes: 1024 * 1024,
    },
  })
  const runtimeB = createScopedNetworkRuntime({
    swarm: swarmB,
    store: { get: () => targetCore },
    initialNetworkPolicy: {
      networkEnabled: true,
      uploadPermission: 'enabled',
      uploadCeilingBytes: 1024 * 1024,
      diskCeilingBytes: 1024 * 1024,
    },
  })
  await runtimeA.start()
  await runtimeB.start()
  const pair = connectionPair()
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey })
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey })
  await settle()
  await runtimeA.retainAuthorizedArchive({ pledge, coreKey, start: 2, end: 6 })
  await runtimeB.retainAuthorizedArchive({ pledge, coreKey, start: 2, end: 6 })
  for (let attempt = 0; attempt < 20 && received.size < 1; attempt++) await settle()
  t.alike([...received.keys()], [2], 'the runtime upload ceiling stops the next oversized transfer')
  await runtimeA.applyNetworkPolicy({
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 256 * 1024,
    diskCeilingBytes: 1024 * 1024,
  })
  await runtimeB.applyNetworkPolicy({
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 1024 * 1024,
    diskCeilingBytes: 1024 * 1024,
  })
  for (let attempt = 0; attempt < 30 && received.size < 3; attempt++) await settle()

  t.alike([...received.keys()].sort((a, b) => a - b), [2, 3, 4])
  const committedUploadBytes = runtimeA.getDiagnostics().policy.uploadedBytes
  t.ok(committedUploadBytes > 0)
  await runtimeA.applyNetworkPolicy({
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 0,
    diskCeilingBytes: 1024 * 1024,
  })
  t.is(runtimeA.getDiagnostics().policy.uploadedBytes, committedUploadBytes, 'lower ceilings preserve committed upload accounting')
  await runtimeA.applyNetworkPolicy({
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 256 * 1024,
    diskCeilingBytes: 1024 * 1024,
  })
  for (let attempt = 0; attempt < 20; attempt++) await settle()
  t.alike([...received.keys()].sort((a, b) => a - b), [2, 3, 4], 'policy toggles do not reset committed upload accounting')
  t.is(received.has(1), false, 'the peer never receives a block below its pledged range')
  t.is(received.has(5), false, 'the peer never receives a block exceeding the runtime upload ceiling')
  const challengeProof = await runtimeA.createAuthorizedArchiveChallengeProof({
    archiveId: pledge.pledgeId,
    coreKey,
    index: 2,
  })
  t.ok(await runtimeB.verifyAuthorizedArchiveChallengeProof({
    archiveId: pledge.pledgeId,
    coreKey,
    index: 2,
    proofBytes: challengeProof,
  }), 'bounded Hypercore proof verifies against the pledged retained core')

  await runtimeA.close()
  await runtimeB.close()
  pair.a.destroy()
  pair.b.destroy()
})

test('permissionless archive discovery carries bounded signed requests and pledges without a relay registry', async (t) => {
  const publisher = crypto.keyPair(bytes(32, 66))
  const archivist = crypto.keyPair(bytes(32, 67))
  const request = createArchiveRequest({
    requesterId: publisher.publicKey,
    publicationId: bytes(32, 68),
    renditionId: bytes(32, 69),
    ranges: [{ coreKey: bytes(32, 70), start: 0, end: 2 }],
    requestedBytes: 2048,
    retentionUntil: 10_000,
    expiresAt: 2_000,
    issuedAt: 1_000,
    keyPair: publisher,
  })
  const pledge = createArchivePledge({
    archivistId: archivist.publicKey,
    publicationId: request.body.publicationId,
    renditionId: request.body.renditionId,
    ranges: request.body.ranges,
    retentionUntil: request.body.retentionUntil,
    uploadCeilingBytes: 8192,
    issuedAt: 1_100,
    nonce: request.requestId,
    keyPair: archivist,
  })
  const challenge = createArchiveChallenge({
    pledgeEnvelope: pledge.envelope,
    auditorEntropy: bytes(32, 77),
    coreKey: request.body.ranges[0].coreKey,
    range: { start: 1, end: 2 },
    deadline: 1_900,
    auditorPublicKey: publisher.publicKey,
  })
  const signedChallenge = createArchiveChallengeEnvelope({ challenge, keyPair: publisher, issuedAt: 1_200 })
  const proofBytes = bytes(96 * 1024, 78)
  const proof = createArchivePossessionProof({ challenge, proofBytes })
  const challengeResponse = createArchiveChallengeResponse({
    challenge,
    pledgeEnvelope: pledge.envelope,
    proof,
    transportPeerId: bytes(32, 201),
    keyPair: archivist,
    issuedAt: 1_300,
  })
  const receivedRequests = []
  const receivedPledges = []
  const receivedChallenges = []
  const receivedProofs = []
  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  const runtimeA = createScopedNetworkRuntime({ swarm: swarmA, store: {} })
  const runtimeB = createScopedNetworkRuntime({ swarm: swarmB, store: {} })
  await runtimeA.start()
  await runtimeB.start()
  await runtimeA.retainArchiveDiscovery({
    onPledge: envelope => receivedPledges.push(b4a.toString(envelope.recordId, 'hex')),
    onChallengeProof: (packet, context) => receivedProofs.push({ packet, context }),
  })
  await runtimeB.retainArchiveDiscovery({
    onRequest: envelope => receivedRequests.push(b4a.toString(envelope.recordId, 'hex')),
    onChallenge: (envelope, context) => receivedChallenges.push({ envelope, context }),
  })
  const pair = connectionPair()
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey, client: false })
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey, client: true })
  for (let attempt = 0; attempt < 20; attempt++) {
    if (runtimeA.getDiagnostics().sessions.some(session => session.purpose === 'archive-discovery' && session.state === 'active') &&
        runtimeB.getDiagnostics().sessions.some(session => session.purpose === 'archive-discovery' && session.state === 'active')) break
    await settle()
  }

  t.is((await runtimeA.publishArchiveRequest({ envelope: request.envelope })).delivered, 1)
  await settle()
  t.alike(receivedRequests, [request.requestId])
  t.is((await runtimeB.publishArchivePledge({ envelope: pledge.envelope })).delivered, 1)
  await settle()
  t.alike(receivedPledges, [pledge.pledgeId])
  t.is((await runtimeA.publishArchiveChallenge({ envelope: signedChallenge.envelope })).delivered, 1)
  await settle()
  t.is(b4a.toString(receivedChallenges[0].envelope.recordId, 'hex'), b4a.toString(signedChallenge.challengeId, 'hex'))
  t.is(receivedChallenges[0].context.peerId, b4a.toString(bytes(32, 202), 'hex'))
  t.is((await runtimeB.publishArchiveChallengeProof({ envelope: challengeResponse.envelope, proofBytes })).delivered, 1)
  await settle()
  t.ok(b4a.equals(receivedProofs[0].packet.proofBytes, proofBytes))
  t.is(receivedProofs[0].context.peerId, b4a.toString(bytes(32, 201), 'hex'))
  t.is(runtimeA.getDiagnostics().topics.filter(topic => topic.purpose === 'archive-discovery').length, 1)

  await runtimeA.close()
  await runtimeB.close()
  pair.a.destroy()
  pair.b.destroy()
})

test('rotated namespace descriptors fail closed until a committed transition verifier is available', async (t) => {
  const genesis = crypto.keyPair(bytes(32, 61))
  const rotated = crypto.keyPair(bytes(32, 62))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: genesis.publicKey,
    publisherRootKey: rotated.publicKey,
    catalogBootstrapKey: bytes(32, 63),
    catalogEpoch: 1,
    previousRootKey: genesis.publicKey,
    rootTransitionProof: bytes(32, 64),
  })
  const runtime = createScopedNetworkRuntime({ swarm: fakeSwarm(), store: {}, catalogRegistry: fakeRegistry(descriptor) })
  await runtime.start()
  await t.exception(runtime.followPublisher({
    publisherId: b4a.toString(descriptor.publisherId, 'hex'),
    namespaceDescriptor: descriptor,
  }), /verified committed transition/)
  await runtime.close()
})

test('release waits for asynchronous discovery and core cleanup', async (t) => {
  const publisher = crypto.keyPair(bytes(32, 71))
  const staticCore = createStaticAssetManifest({
    treeHash: bytes(32, 73),
    blockLength: 1,
    byteLength: 1024,
  })
  const coreKey = staticCore.key
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    title: 'Await cleanup',
    renditions: [createRenditionDescriptor({ purpose: 'video', format: 'video/mp4', core: staticCore })],
    keyPair: publisher,
    signedAt: 10,
    expiresAt: 1000,
  })
  let discoveryClosed = false
  let coreClosed = false
  const swarm = fakeSwarm()
  swarm.join = topic => {
    const handle = {
      topic,
      async flushed () {},
      async destroy () { await settle(); discoveryClosed = true },
    }
    swarm.joins.push(handle)
    return handle
  }
  const runtime = createScopedNetworkRuntime({
    swarm,
    now: () => 20,
    authorizePublication: async request => request.manifest === manifest,
    store: {
      get ({ key }) {
        return {
          key,
          async ready () {},
          replicate () {},
          download () { return { async destroy () { await settle() } } },
          async close () { await settle(); coreClosed = true },
        }
      },
    },
  })
  await runtime.start()
  const renditionId = manifest.body.renditions[0].renditionId
  await runtime.retainAuthorizedRendition({ manifest, renditionId, start: 0, end: 1 })
  await runtime.releaseAuthorizedRendition({ renditionId })
  t.is(coreClosed, true)
  t.is(discoveryClosed, true)
  await runtime.close()
})
