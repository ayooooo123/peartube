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
import { PROTOCOL_MAJOR } from '../src/network/version.js'

function bytes (size, fill) {
  return b4a.alloc(size, fill)
}

function connectionPair (remoteAFill = 201, remoteBFill = 202) {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = Duplex.from({ readable: bToA, writable: aToB })
  const b = Duplex.from({ readable: aToB, writable: bToA })
  a.userData = null
  b.userData = null
  a.remotePublicKey = bytes(32, remoteAFill)
  b.remotePublicKey = bytes(32, remoteBFill)
  return { a, b }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

function contributionPolicy (overrides = {}) {
  return {
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 1024 * 1024,
    diskCeilingBytes: 1024 * 1024,
    permissions: { contribute: true, archive: false },
    publicServingAllowed: true,
    contributionBudgetBytes: 1024 * 1024,
    archiveBudgetBytes: 0,
    ...overrides,
  }
}

function archivePolicy (overrides = {}) {
  return {
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 1024 * 1024,
    diskCeilingBytes: 1024 * 1024,
    permissions: { contribute: false, archive: true },
    publicServingAllowed: true,
    contributionBudgetBytes: 0,
    archiveBudgetBytes: 1024 * 1024,
    ...overrides,
  }
}

function assertCurrentRuntimeTopics(t, runtime) {
  const topics = runtime.getDiagnostics().topics
  t.ok(topics.length > 0)
  for (const topic of topics) {
    t.is(topic.protocolMajor, PROTOCOL_MAJOR, `${topic.purpose} diagnostic uses the current major`)
  }
}

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

  t.is(swarm.joins.length, 1, 'watch-only startup joins only private bootstrap discovery')
  t.is(swarm.joins[0].options.server, false)
  t.absent(runtime.getDiagnostics().topics.some(topic => topic.purpose === 'publisher'))
  await t.exception(
    runtime.publishLocalPublisherCatalog({ publisherId: descriptor.publisherId }),
    /explicit contribution upload permission/
  )
  await runtime.close()
})

test('role budgets cannot bypass disabled upload permission', async (t) => {
  const root = crypto.keyPair(bytes(32, 25))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 26),
  })
  const registry = fakeRegistry(descriptor)
  registry.binding.catalog.listProjections = async () => ({ items: [{ accepted: true }], nextCursor: null })
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({
    swarm,
    store: {},
    catalogRegistry: registry,
    initialNetworkPolicy: contributionPolicy({
      uploadPermission: 'disabled',
      uploadCeilingBytes: 1024 * 1024,
    }),
  })
  await runtime.start()
  await t.exception(
    runtime.publishLocalPublisherCatalog({ publisherId: descriptor.publisherId }),
    /explicit contribution upload permission/
  )
  t.is(runtime.getDiagnostics().publicWork.activeAnnouncements, 0)
  t.is(swarm.joins.every(join => join.options.server === false), true, 'nonzero role budget cannot announce while uploads are disabled')
  await runtime.close()
})

test('archive consent with zero archive budget cannot allocate retention', async (t) => {
  const runtime = createScopedNetworkRuntime({
    swarm: fakeSwarm(),
    store: {},
    initialNetworkPolicy: archivePolicy({ archiveBudgetBytes: 0 }),
  })
  await runtime.start()
  await t.exception(
    runtime.retainAuthorizedArchive({
      pledge: {},
      coreKey: bytes(32, 27),
      start: 0,
      end: 1,
    }),
    /archive budget exhausted/
  )
  await runtime.close()
})

test('watch-only downgrade closes local publisher catalog sessions and removes its announcement', async (t) => {
  const root = crypto.keyPair(bytes(32, 21))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 22),
  })
  const registryA = fakeRegistry(descriptor)
  registryA.binding.catalog.listProjections = async kind => ({
    items: kind === 'publication' ? [{ accepted: true }] : [],
    nextCursor: null,
  })
  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  const runtimeA = createScopedNetworkRuntime({
    swarm: swarmA,
    store: {},
    catalogRegistry: registryA,
    initialNetworkPolicy: contributionPolicy(),
  })
  const runtimeB = createScopedNetworkRuntime({
    swarm: swarmB,
    store: {},
    catalogRegistry: fakeRegistry(descriptor),
  })
  await runtimeA.start()
  await runtimeB.start()
  const publisherId = b4a.toString(descriptor.publisherId, 'hex')
  const published = await runtimeA.publishLocalPublisherCatalog({ publisherId })
  await runtimeB.followPublisher({ publisherId, namespaceDescriptor: descriptor })
  const pair = connectionPair(23, 24)
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey, client: true })
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey, client: false })
  await settle()
  t.ok(runtimeA.getDiagnostics().sessions.some(session => session.purpose === 'publisher'))
  t.ok(runtimeA.getDiagnostics().topics.find(topic => topic.purpose === 'publisher')?.publicAnnounced)

  await runtimeA.applyNetworkPolicy({
    networkEnabled: true,
    uploadPermission: 'disabled',
    uploadCeilingBytes: 0,
    diskCeilingBytes: 1024,
    permissions: { contribute: false, archive: false },
    publicServingAllowed: false,
    contributionBudgetBytes: 0,
    archiveBudgetBytes: 0,
  })
  const diagnostics = runtimeA.getDiagnostics()
  t.absent(diagnostics.sessions.find(session => session.purpose === 'publisher'), 'local catalog session closes on downgrade')
  t.absent(diagnostics.topics.find(topic => topic.purpose === 'publisher')?.publicAnnounced, 'publisher discovery becomes client-only')
  t.is(runtimeA.authorizeConnection({ purpose: 'publisher', topic: published.topic.topicHex
    ? b4a.from(published.topic.topicHex, 'hex')
    : derivePublisherTopic({ publisherId, catalogEpoch: descriptor.catalogEpoch }) }).status, 'rejected')

  await runtimeA.close()
  await runtimeB.close()
  pair.a.destroy()
  pair.b.destroy()
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
    permissions: { contribute: true, archive: false },
    publicServingAllowed: true,
    contributionBudgetBytes: 1024,
    archiveBudgetBytes: 0,
  })
  t.is(swarm.joins.length, 1)

  await runtime.applyNetworkPolicy({
    networkEnabled: false,
    uploadPermission: 'disabled',
    uploadCeilingBytes: 0,
    diskCeilingBytes: 0,
    permissions: { contribute: false, archive: false },
    publicServingAllowed: false,
    contributionBudgetBytes: 0,
    archiveBudgetBytes: 0,
  })
  t.is(swarm.joins[0].destroyed, 1)
  t.is(runtime.getDiagnostics().sessions.length, 0)

  await runtime.applyNetworkPolicy({
    networkEnabled: true,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 1024,
    diskCeilingBytes: 1024,
    permissions: { contribute: false, archive: false },
    publicServingAllowed: false,
    contributionBudgetBytes: 0,
    archiveBudgetBytes: 0,
  })
  t.is(swarm.joins.length, 2, 'role downgrade replaced the public join with client-only discovery')
  t.is(swarm.joins.at(-1).options.server, false)
  await runtime.close()
})


function makeProtocolSession ({ purpose = 'bootstrap', topic = deriveBootstrapTopic({ protocolMajor: PROTOCOL_MAJOR }), capability = BOOTSTRAP_LOCATOR_CAPABILITY, work } = {}) {
  return createScopedProtocolSession({
    peerId: 'remote-a',
    purpose,
    topic,
    protocolMajor: PROTOCOL_MAJOR,
    requiredCapability: capability,
    onActivate: work,
    onFrame: work,
  })
}

test('protocol rejects wrong capability, topic, major, replay and oversize before work', async (t) => {
  const topic = deriveBootstrapTopic({ protocolMajor: PROTOCOL_MAJOR })
  let work = 0
  const wrongCapability = makeProtocolSession({ topic, work: () => { work++ } })
  await t.exception(wrongCapability.acceptHello(encodeScopedHello({
    purpose: 'bootstrap', topic, protocolMajor: PROTOCOL_MAJOR, capabilities: ['not-supported:v1'], maxFrameBytes: 1024,
  })), /capability/i)

  const wrongTopic = makeProtocolSession({ topic, work: () => { work++ } })
  await t.exception(wrongTopic.acceptHello(encodeScopedHello({
    purpose: 'bootstrap', topic: bytes(32, 9), protocolMajor: PROTOCOL_MAJOR, capabilities: [BOOTSTRAP_LOCATOR_CAPABILITY], maxFrameBytes: 1024,
  })), /topic/i)

  const wrongMajor = makeProtocolSession({ topic, work: () => { work++ } })
  await t.exception(wrongMajor.acceptHello(encodeScopedHello({
    purpose: 'bootstrap', topic, protocolMajor: 1, capabilities: [BOOTSTRAP_LOCATOR_CAPABILITY], maxFrameBytes: 1024,
  })), /major/i)

  const active = makeProtocolSession({ topic, work: () => { work++ } })
  await active.acceptHello(encodeScopedHello({
    purpose: 'bootstrap', topic, protocolMajor: PROTOCOL_MAJOR, capabilities: [BOOTSTRAP_LOCATOR_CAPABILITY], maxFrameBytes: 1024,
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
  const runtime = createScopedNetworkRuntime({
    swarm,
    store: {},
    catalogRegistry: fakeRegistry(descriptor),
    initialNetworkPolicy: contributionPolicy(),
  })
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
  const destroyedDownloads = []
  const swarm = fakeSwarm()
  let unrestrictedReplications = 0
  const authorizations = []
  const runtime = createScopedNetworkRuntime({
    swarm,
    authorizePublication: async request => {
      authorizations.push({ start: request.start, end: request.end })
      return request.manifest === manifest
    },
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
          download: range => {
            downloads.push(range)
            return { destroy () { destroyedDownloads.push(range) } }
          },
          close () {},
        }
      },
    },
    now: () => 20,
    initialNetworkPolicy: contributionPolicy(),
  })
  await runtime.start()
  const retained = await runtime.retainAuthorizedRendition({
    manifest,
    renditionId,
    ownerId: 'playback-owner',
    start: 0,
    end: staticCore.length,
  })
  const verificationLease = await runtime.retainAuthorizedRendition({
    manifest,
    renditionId,
    ownerId: 'verification-owner',
    start: 0,
    end: 1,
  })
  t.is(retained.status, 'retained')
  t.is(retained.assetId, b4a.toString(allowedCore, 'hex'))
  t.alike(verificationLease.range, { start: 0, end: 1 })
  t.alike(authorizations, [
    { start: 0, end: staticCore.length },
    { start: 0, end: 1 },
  ])
  t.alike(opened, [b4a.toString(allowedCore, 'hex')])
  t.alike(downloads, [{ start: 0, end: staticCore.length }])
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

  await t.exception(runtime.retainAuthorizedRendition({
    manifest,
    renditionId,
    ownerId: 'playback-owner',
    start: 0,
    end: 1,
  }), /retention owner already has a different authorization range/)
  const verificationRelease = await runtime.releaseAuthorizedRendition({
    renditionId,
    ownerId: 'verification-owner',
    assetId: staticCore.assetId,
  })
  t.is(verificationRelease.released, true)
  t.is(verificationRelease.remainingOwners, 1)
  t.is(runtime.authorizeConnection({
    purpose: 'asset',
    topic: assetTopic,
    requestedCoreKey: b4a.toString(allowedCore, 'hex'),
  }).status, 'authorized', 'releasing the dependent short lease preserves the full owner')
  await runtime.retainAuthorizedRendition({
    manifest,
    renditionId,
    ownerId: 'verification-owner',
    start: 0,
    end: 1,
  })
  const playbackRelease = await runtime.releaseAuthorizedRendition({
    renditionId,
    ownerId: 'playback-owner',
    assetId: staticCore.assetId,
  })
  t.is(playbackRelease.released, true)
  t.is(playbackRelease.remainingOwners, 0)
  t.is(playbackRelease.scopeQuiescent, true)
  t.alike(destroyedDownloads, [{ start: 0, end: staticCore.length }])
  const revokedVerificationRelease = await runtime.releaseAuthorizedRendition({
    renditionId,
    ownerId: 'verification-owner',
    assetId: staticCore.assetId,
  })
  t.is(revokedVerificationRelease.released, false)
  t.is(revokedVerificationRelease.remainingOwners, 0)
  t.is(runtime.authorizeConnection({
    purpose: 'asset',
    topic: assetTopic,
    requestedCoreKey: b4a.toString(allowedCore, 'hex'),
  }).status, 'rejected', 'releasing the last full-range owner revokes dependent short leases')
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
    initialNetworkPolicy: contributionPolicy(),
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
  const removedOwnerRelease = await runtime.releaseAuthorizedRendition({
    renditionId: secondRendition.renditionId,
    ownerId: manifest.publicationId,
    assetId: core.assetId,
  })
  t.is(removedOwnerRelease.released, false)
  t.is(removedOwnerRelease.remainingOwners, 1)
  t.is(removedOwnerRelease.scopeQuiescent, false)
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
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-range-source-'))
  const readerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-range-reader-'))
  const sourceStore = new Corestore(sourceDir)
  const readerStore = new Corestore(readerDir)
  await sourceStore.ready()
  await readerStore.ready()
  const sourceBytes = b4a.alloc((5 * ASSET_BLOCK_SIZE) + 24)
  for (let index = 0; index < 5; index++) {
    sourceBytes.fill(index + 1, index * ASSET_BLOCK_SIZE, (index + 1) * ASSET_BLOCK_SIZE)
  }
  sourceBytes.fill(6, 5 * ASSET_BLOCK_SIZE)
  const asset = await writeStaticAsset({ store: sourceStore, source: [sourceBytes] })
  const staticCore = asset.descriptor
  const publisher = crypto.keyPair(bytes(32, 61))
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    title: 'Scoped transfer',
    renditions: [createRenditionDescriptor({ purpose: 'video', format: 'video/mp4', core: staticCore })],
    keyPair: publisher,
    signedAt: 10,
    expiresAt: 1000,
  })
  const renditionId = manifest.body.renditions[0].renditionId
  const readerCore = readerStore.get({
    key: staticCore.key,
    manifest: staticCore.hypercoreManifest,
    writable: false,
  })
  await readerCore.ready()
  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  const runtimeA = createScopedNetworkRuntime({
    swarm: swarmA,
    store: sourceStore,
    authorizePublication: async request => request.manifest === manifest,
    initialNetworkPolicy: contributionPolicy(),
  })
  const runtimeB = createScopedNetworkRuntime({
    swarm: swarmB,
    store: readerStore,
    authorizePublication: async request => request.manifest === manifest,
  })
  const pair = connectionPair()
  t.teardown(async () => {
    await runtimeA.close().catch(() => {})
    await runtimeB.close().catch(() => {})
    pair.a.destroy()
    pair.b.destroy()
    await readerCore.close().catch(() => {})
    await asset.core.close().catch(() => {})
    await sourceStore.close()
    await readerStore.close()
    fs.rmSync(sourceDir, { recursive: true, force: true })
    fs.rmSync(readerDir, { recursive: true, force: true })
  })

  await runtimeA.start()
  await runtimeB.start()
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey })
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey })
  await settle()
  await runtimeA.retainAuthorizedRendition({ manifest, renditionId, start: 2, end: 5 })
  await runtimeB.retainAuthorizedRendition({ manifest, renditionId, start: 2, end: 5 })
  for (let attempt = 0; attempt < 20; attempt++) {
    const activeA = runtimeA.getDiagnostics().sessions.some(session =>
      session.purpose === 'asset' && session.state === 'active')
    const activeB = runtimeB.getDiagnostics().sessions.some(session =>
      session.purpose === 'asset' && session.state === 'active')
    if (activeA && activeB) break
    await settle()
  }
  t.ok(runtimeA.getDiagnostics().sessions.some(session =>
    session.purpose === 'asset' && session.state === 'active'))
  t.ok(runtimeB.getDiagnostics().sessions.some(session =>
    session.purpose === 'asset' && session.state === 'active'))

  const observed = runtimeB.requestAssetBlocks({
    assetId: staticCore.assetId,
    startBlock: 2,
    endBlock: 5,
  }).then(value => ({ value, error: null }), error => ({ value: null, error }))
  const outcome = await observed
  if (outcome.error) throw outcome.error
  t.alike(outcome.value.verifiedBlockIndexes, [2, 3, 4])
  t.alike(outcome.value.peerIds, [b4a.toString(pair.b.remotePublicKey, 'hex')])
  t.is(await readerCore.has(1), false, 'the peer never receives a block below its authorized range')
  const defaultCached = await runtimeB.requestAssetBlocks({
    assetId: staticCore.assetId,
    startBlock: 2,
    endBlock: 3,
  })
  t.alike(defaultCached.verifiedBlockIndexes, [2])
  t.alike(defaultCached.peerIds, [], 'default cached-block fast path remains local')
  const cachedPeerEvidence = await runtimeB.requestAssetBlocks({
    assetId: staticCore.assetId,
    startBlock: 2,
    endBlock: 3,
    requirePeerEvidence: true,
  })
  t.alike(cachedPeerEvidence.verifiedBlockIndexes, [2])
  t.alike(cachedPeerEvidence.peerIds, [b4a.toString(pair.b.remotePublicKey, 'hex')])
  await t.exception(runtimeB.requestAssetBlocks({
    assetId: staticCore.assetId,
    startBlock: 2,
    endBlock: 3,
    requirePeerEvidence: 'true',
  }), /requirePeerEvidence must be a boolean/)
  for (let index = 2; index < 5; index++) {
    t.is(await readerCore.has(index), true)
    t.alike(await readerCore.get(index), sourceBytes.subarray(
      index * ASSET_BLOCK_SIZE,
      (index + 1) * ASSET_BLOCK_SIZE,
    ))
  }
  t.is(await readerCore.has(5), false, 'the peer never receives a block at or above its authorized range end')
  await readerCore.clear(4)
  const uploadedBeforeExhaustion = runtimeA.getDiagnostics().policy.uploadedBytes
  await runtimeA.applyNetworkPolicy(contributionPolicy({
    uploadCeilingBytes: 1,
    contributionBudgetBytes: 1,
  }))
  const exhausted = await runtimeB.requestAssetBlocks({
    assetId: staticCore.assetId,
    startBlock: 4,
    endBlock: 5,
    requirePeerEvidence: true,
  }).then(() => null, error => error)
  t.ok(exhausted, 'exhausted upload budget settles the accepted peer request')
  t.is(exhausted.code, 'UNAVAILABLE')
  t.is(exhausted.peerId, b4a.toString(pair.b.remotePublicKey, 'hex'))
  t.ok(exhausted.message.length <= 256)
  t.is(runtimeA.getDiagnostics().policy.uploadedBytes, uploadedBeforeExhaustion,
    'reservation denial commits no uploaded bytes')
  t.is(await readerCore.has(4), false, 'budget exhaustion serves no asset block')
  t.is(runtimeA.getDiagnostics().status, 'active')
  t.is(runtimeB.getDiagnostics().status, 'active')
})

test('watch-only requester receives a bounded unavailable error from a contributor without protocol failure', async (t) => {
  const publisher = crypto.keyPair(bytes(32, 91))
  const staticCore = createStaticAssetManifest({
    treeHash: bytes(32, 92),
    blockLength: 1,
    byteLength: 1024,
  })
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    title: 'Watch-only source',
    renditions: [createRenditionDescriptor({ purpose: 'video', format: 'video/mp4', core: staticCore })],
    keyPair: publisher,
    signedAt: 10,
    expiresAt: 1000,
  })
  const renditionId = manifest.body.renditions[0].renditionId
  const unavailableStore = {
    get ({ key }) {
      return {
        key,
        length: staticCore.length,
        byteLength: staticCore.byteLength,
        async ready () {},
        async has () { return false },
        download () { return { destroy () {} } },
        async close () {},
      }
    },
  }
  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  const runtimeA = createScopedNetworkRuntime({
    swarm: swarmA,
    initialNetworkPolicy: contributionPolicy(),
    store: unavailableStore,
    authorizePublication: async request => request.manifest === manifest,
  })
  const runtimeB = createScopedNetworkRuntime({
    swarm: swarmB,
    store: unavailableStore,
    authorizePublication: async request => request.manifest === manifest,
  })
  const pair = connectionPair(211, 212)
  t.teardown(async () => {
    await Promise.allSettled([runtimeA.close(), runtimeB.close()])
    pair.a.destroy()
    pair.b.destroy()
  })

  await runtimeA.start()
  await runtimeB.start()
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey })
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey })
  await settle()
  await runtimeA.retainAuthorizedRendition({ manifest, renditionId, start: 0, end: 1 })
  await runtimeB.retainAuthorizedRendition({ manifest, renditionId, start: 0, end: 1 })
  for (let attempt = 0; attempt < 20; attempt++) {
    if (runtimeA.getDiagnostics().sessions.some(session => session.purpose === 'asset' && session.state === 'active') &&
        runtimeB.getDiagnostics().sessions.some(session => session.purpose === 'asset' && session.state === 'active')) break
    await settle()
  }
  t.ok(runtimeA.getDiagnostics().sessions.some(session => session.purpose === 'asset' && session.state === 'active'))
  t.ok(runtimeB.getDiagnostics().sessions.some(session => session.purpose === 'asset' && session.state === 'active'))
  const assetTopic = deriveStaticAssetTopic(staticCore.assetId)
  const sourceAssetJoin = swarmA.joins.find(join => b4a.equals(join.topic, assetTopic))
  const requesterAssetJoin = swarmB.joins.find(join => b4a.equals(join.topic, assetTopic))
  t.is(sourceAssetJoin?.options.server, true, 'explicit contributor serves the scoped asset topic')
  t.is(requesterAssetJoin?.options.server, false, 'watch-only requester joins the scoped asset topic as a client')

  const rejection = runtimeB.requestAssetBlocks({
    assetId: staticCore.assetId,
    startBlock: 0,
    endBlock: 1,
    requirePeerEvidence: true,
  }).then(() => null, error => error)
  const error = await rejection
  t.ok(error)
  t.is(error.code, 'UNAVAILABLE')
  t.is(error.peerId, b4a.toString(pair.b.remotePublicKey, 'hex'))
  t.ok(error.message.length <= 256)
  t.is(runtimeA.getDiagnostics().status, 'active')
  t.is(runtimeB.getDiagnostics().status, 'active')
})

test('three real scoped runtimes keep disjoint peer inventory, transfers, loss, and corruption attributable', async (t) => {
  const directories = Array.from({ length: 4 }, (_, index) =>
    fs.mkdtempSync(path.join(os.tmpdir(), `peartube-multi-peer-${index}-`)))
  const [writerStore, firstStore, secondStore, readerStore] = directories.map(directory => new Corestore(directory))
  await Promise.all([writerStore.ready(), firstStore.ready(), secondStore.ready(), readerStore.ready()])
  const sourceBytes = b4a.alloc((5 * ASSET_BLOCK_SIZE) + 24)
  for (let index = 0; index < 5; index++) {
    sourceBytes.fill(index + 1, index * ASSET_BLOCK_SIZE, (index + 1) * ASSET_BLOCK_SIZE)
  }
  sourceBytes.fill(6, 5 * ASSET_BLOCK_SIZE)
  const asset = await writeStaticAsset({ store: writerStore, source: [sourceBytes] })
  const descriptor = asset.descriptor
  const firstCore = firstStore.get({ key: descriptor.key, manifest: descriptor.hypercoreManifest, writable: false })
  const secondCore = secondStore.get({ key: descriptor.key, manifest: descriptor.hypercoreManifest, writable: false })
  const readerCore = readerStore.get({ key: descriptor.key, manifest: descriptor.hypercoreManifest, writable: false })
  await Promise.all([firstCore.ready(), secondCore.ready(), readerCore.ready()])
  for (const index of [0, 1, 2]) {
    const proof = await asset.core.proof({
      block: { index, nodes: 0 },
      upgrade: { start: 0, length: descriptor.length },
    })
    t.is(await firstCore.applyProof(proof), true)
  }
  for (const index of [3, 4, 5]) {
    const proof = await asset.core.proof({
      block: { index, nodes: 0 },
      upgrade: { start: 0, length: descriptor.length },
    })
    t.is(await secondCore.applyProof(proof), true)
  }

  const publisher = crypto.keyPair(bytes(32, 81))
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    title: 'Three scoped peers',
    renditions: [createRenditionDescriptor({ purpose: 'video', format: 'video/mp4', core: descriptor })],
    keyPair: publisher,
    signedAt: 10,
    expiresAt: 1000,
  })
  const renditionId = manifest.body.renditions[0].renditionId
  let holdLastProof = true
  let lastProofStarted = false
  let releaseLastProof
  let corruptLastProof = false
  const lastProofGate = new Promise(resolve => { releaseLastProof = resolve })
  const patchedCores = new WeakSet()
  const secondRuntimeStore = {
    get(options) {
      const core = secondStore.get(options)
      if (patchedCores.has(core)) return core
      patchedCores.add(core)
      const proof = core.proof.bind(core)
      core.proof = async request => {
        const result = await proof(request)
        if (request?.block?.index === 5 && holdLastProof) {
          lastProofStarted = true
          await lastProofGate
        }
        if (request?.block?.index === 5 && corruptLastProof) {
          result.block.value = b4a.from(result.block.value)
          result.block.value[0] ^= 0xff
        }
        return result
      }
      return core
    },
  }
  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  const swarmC = fakeSwarm()
  const runtimeA = createScopedNetworkRuntime({
    swarm: swarmA,
    store: firstStore,
    authorizePublication: async request => request.manifest === manifest,
    initialNetworkPolicy: contributionPolicy(),
  })
  const runtimeB = createScopedNetworkRuntime({
    swarm: swarmB,
    store: readerStore,
    authorizePublication: async request => request.manifest === manifest,
  })
  const runtimeC = createScopedNetworkRuntime({
    swarm: swarmC,
    store: secondRuntimeStore,
    authorizePublication: async request => request.manifest === manifest,
    initialNetworkPolicy: contributionPolicy({
      uploadCeilingBytes: 4 * 1024 * 1024,
      contributionBudgetBytes: 4 * 1024 * 1024,
    }),
  })
  const pairA = connectionPair(201, 202)
  let pairC = connectionPair(203, 204)
  t.teardown(async () => {
    await Promise.allSettled([runtimeA.close(), runtimeB.close(), runtimeC.close()])
    pairA.a.destroy()
    pairA.b.destroy()
    pairC.a.destroy()
    pairC.b.destroy()
    await Promise.allSettled([readerCore.close(), firstCore.close(), secondCore.close(), asset.core.close()])
    await Promise.all([writerStore.close(), firstStore.close(), secondStore.close(), readerStore.close()])
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true })
  })

  await Promise.all([runtimeA.start(), runtimeB.start(), runtimeC.start()])
  swarmA.connections.add(pairA.a)
  swarmB.connections.add(pairA.b)
  swarmC.connections.add(pairC.a)
  swarmB.connections.add(pairC.b)
  swarmA.emit('connection', pairA.a, { publicKey: pairA.a.remotePublicKey })
  swarmB.emit('connection', pairA.b, { publicKey: pairA.b.remotePublicKey })
  swarmC.emit('connection', pairC.a, { publicKey: pairC.a.remotePublicKey })
  swarmB.emit('connection', pairC.b, { publicKey: pairC.b.remotePublicKey })
  await settle()
  await runtimeA.retainAuthorizedRendition({ manifest, renditionId, start: 0, end: descriptor.length })
  await runtimeC.retainAuthorizedRendition({ manifest, renditionId, start: 0, end: descriptor.length })
  await runtimeB.retainAuthorizedRendition({ manifest, renditionId, start: 0, end: descriptor.length })

  let activeReaderSessions = []
  for (let attempt = 0; attempt < 20; attempt++) {
    activeReaderSessions = runtimeB.getDiagnostics().sessions.filter(session =>
      session.purpose === 'asset' && session.state === 'active')
    const sourceAActive = runtimeA.getDiagnostics().sessions.some(session =>
      session.purpose === 'asset' && session.state === 'active')
    const sourceCActive = runtimeC.getDiagnostics().sessions.some(session =>
      session.purpose === 'asset' && session.state === 'active')
    if (activeReaderSessions.length === 2 && sourceAActive && sourceCActive) break
    await settle()
  }
  t.is(activeReaderSessions.length, 2)
  t.ok(runtimeA.getDiagnostics().sessions.some(session =>
    session.purpose === 'asset' && session.state === 'active'))
  t.ok(runtimeC.getDiagnostics().sessions.some(session =>
    session.purpose === 'asset' && session.state === 'active'))
  const peerIds = runtimeB.getActiveAssetPeerIds({ assetId: descriptor.assetId })
  const firstPeerId = b4a.toString(pairA.b.remotePublicKey, 'hex')
  const secondPeerId = b4a.toString(pairC.b.remotePublicKey, 'hex')
  t.alike(peerIds, [firstPeerId, secondPeerId].sort())

  const [firstInventory, secondInventory] = await Promise.all([
    runtimeB.listPeerAssetRanges({
      assetId: descriptor.assetId,
      peerId: firstPeerId,
      cursor: null,
      limit: 1,
    }),
    runtimeB.listPeerAssetRanges({
      assetId: descriptor.assetId,
      peerId: secondPeerId,
      cursor: null,
      limit: 1,
    }),
  ])
  const inventoryHas = (page, blockIndex) => page.ranges.some(range => {
    if (blockIndex < range.startBlock || blockIndex >= range.startBlock + range.bitCount) return false
    const offset = blockIndex - range.startBlock
    return (range.presentBitfield[offset >> 3] & (1 << (offset & 7))) !== 0
  })
  t.ok(inventoryHas(firstInventory, 0))
  t.is(inventoryHas(firstInventory, 3), false)
  t.is(inventoryHas(secondInventory, 0), false)
  t.ok(inventoryHas(secondInventory, 3))

  const firstRun = await runtimeB.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 0,
    endBlock: 3,
    peerIds: [firstPeerId],
  })
  t.alike(firstRun.verifiedBlockIndexes, [0, 1, 2])
  t.alike(firstRun.peerIds, [firstPeerId])

  const interrupted = runtimeB.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 3,
    endBlock: 6,
    peerIds: [secondPeerId],
  })
  const observedDisconnect = interrupted.then(() => null, error => error)
  for (let attempt = 0; attempt < 100 && !lastProofStarted; attempt++) await settle()
  t.ok(lastProofStarted)
  const oldPairC = pairC
  const readerClosedBeforeReplacement = runtimeB.getDiagnostics().counters.closedSessions
  const sourceClosedBeforeReplacement = runtimeC.getDiagnostics().counters.closedSessions
  holdLastProof = false
  pairC = connectionPair(203, 204)
  swarmC.connections.add(pairC.a)
  swarmB.connections.add(pairC.b)
  swarmC.emit('connection', pairC.a, { publicKey: pairC.a.remotePublicKey })
  swarmB.emit('connection', pairC.b, { publicKey: pairC.b.remotePublicKey })
  await settle()
  releaseLastProof()
  const disconnected = await observedDisconnect
  t.ok(disconnected)
  t.is(disconnected.code, 'DISCONNECTED')
  t.is(disconnected.peerId, secondPeerId)

  for (let attempt = 0; attempt < 20; attempt++) {
    if (runtimeB.getActiveAssetPeerIds({ assetId: descriptor.assetId }).includes(secondPeerId)) break
    await settle()
  }
  t.is(runtimeB.getDiagnostics().counters.closedSessions, readerClosedBeforeReplacement + 2,
    'replacement closes the old reader bootstrap and asset scopes exactly once')
  t.is(runtimeC.getDiagnostics().counters.closedSessions, sourceClosedBeforeReplacement + 2,
    'replacement closes the old source bootstrap and asset scopes exactly once')
  oldPairC.a.destroy()
  oldPairC.b.destroy()
  await settle()
  t.is(runtimeB.getDiagnostics().counters.closedSessions, readerClosedBeforeReplacement + 2,
    'delayed old reader connection close cannot recount either replaced scope')
  t.is(runtimeC.getDiagnostics().counters.closedSessions, sourceClosedBeforeReplacement + 2,
    'delayed old source connection close cannot recount either replaced scope')
  t.ok(runtimeB.getActiveAssetPeerIds({ assetId: descriptor.assetId }).includes(secondPeerId),
    'delayed old connection close preserves the replacement reader session')
  t.ok(runtimeC.getDiagnostics().sessions.some(session =>
    session.purpose === 'asset' && session.state === 'active'),
    'delayed old connection close preserves the replacement source session')
  const secondRun = await runtimeB.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 3,
    endBlock: 6,
    peerIds: [secondPeerId],
  })
  t.alike(secondRun.verifiedBlockIndexes, [3, 4, 5])
  t.alike(secondRun.peerIds, [secondPeerId])

  await readerCore.clear(5)
  corruptLastProof = true
  const invalid = await runtimeB.requestAssetBlocks({
    assetId: descriptor.assetId,
    startBlock: 5,
    endBlock: 6,
    peerIds: [secondPeerId],
  }).then(() => null, error => error)
  t.ok(invalid)
  t.is(invalid.code, 'INVALID_PROOF')
  t.is(invalid.peerId, secondPeerId)
  t.ok(invalid.message.length <= 256)
  await settle()
  t.is(runtimeB.getDiagnostics().status, 'active')
  t.is(runtimeC.getDiagnostics().status, 'active')
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
  assertCurrentRuntimeTopics(t, runtimeA)
  assertCurrentRuntimeTopics(t, runtimeB)

  const publisherId = b4a.toString(descriptor.publisherId, 'hex')
  await runtimeB.followPublisher({ publisherId, namespaceDescriptor: descriptor })
  await settle()
  t.absent(runtimeB.getDiagnostics().sessions.find(session => session.purpose === 'publisher'), 'server-side late scope waits for the client initiator')
  await runtimeA.followPublisher({ publisherId, namespaceDescriptor: descriptor })
  await settle()
  t.ok(runtimeA.getDiagnostics().sessions.some(session => session.purpose === 'publisher' && session.state === 'active'))
  t.ok(runtimeB.getDiagnostics().sessions.some(session => session.purpose === 'publisher' && session.state === 'active'))
  assertCurrentRuntimeTopics(t, runtimeA)
  assertCurrentRuntimeTopics(t, runtimeB)
  const publisherTopic = runtimeA.getDiagnostics().topics.find(topic => topic.purpose === 'publisher')
  t.is(publisherTopic.topicHex, b4a.toString(derivePublisherTopic({
    publisherId,
    catalogEpoch: descriptor.catalogEpoch,
    protocolMajor: PROTOCOL_MAJOR,
  }), 'hex'))
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
    initialNetworkPolicy: archivePolicy(),
  })
  await runtime.start()
  const first = await runtime.retainAuthorizedArchive({ pledge, coreKey, start: 0, end: 2 })
  const second = await runtime.retainAuthorizedArchive({ pledge, coreKey, start: 4, end: 7, download: false })
  t.is(protectedRanges, 2)
  t.is(downloads, 1, 'verification-only requester scopes do not start a full-range download')
  t.is(first.archiveId, second.archiveId)
  t.is(runtime.getDiagnostics().topics.filter(topic => topic.purpose === 'archive').length, 1)
  assertCurrentRuntimeTopics(t, runtime)
  const archiveTopic = deriveArchiveTopic({ archiveId: first.archiveId, protocolMajor: PROTOCOL_MAJOR })
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
  let markProofStarted
  let releaseProof
  const proofStarted = new Promise(resolve => { markProofStarted = resolve })
  const proofRelease = new Promise(resolve => { releaseProof = resolve })
  let holdFirstProof = true
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
      if (holdFirstProof) {
        holdFirstProof = false
        markProofStarted()
        await proofRelease
      }
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
    initialNetworkPolicy: archivePolicy({ uploadCeilingBytes: 1024 }),
  })
  const runtimeB = createScopedNetworkRuntime({
    swarm: swarmB,
    store: { get: () => targetCore },
    initialNetworkPolicy: archivePolicy(),
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
  await proofStarted
  t.is(runtimeA.getDiagnostics().publicWork.activeUploads, 1, 'archive proof generation counts as an active upload')
  t.ok(runtimeA.getDiagnostics().sessions.some(session => session.archiveServing), 'archiveServing is exposed as a bounded boolean')
  await runtimeA.applyNetworkPolicy(contributionPolicy())
  let diagnostics = runtimeA.getDiagnostics()
  t.absent(diagnostics.sessions.find(session => session.purpose === 'archive'), 'archive sessions close when archive consent is withdrawn')
  t.absent(diagnostics.topics.find(topic => topic.purpose === 'archive')?.publicAnnounced, 'archive scope stops announcing')
  const archiveTopic = deriveArchiveTopic({ archiveId: pledge.pledgeId, protocolMajor: PROTOCOL_MAJOR })
  t.is(runtimeA.authorizeConnection({ purpose: 'archive', topic: archiveTopic, requestedCoreKey: b4a.toString(coreKey, 'hex') }).reason, 'archive-policy-disabled')
  releaseProof()
  await runtimeA.applyNetworkPolicy(archivePolicy({ uploadCeilingBytes: 1024 }))
  for (let attempt = 0; attempt < 20 && received.size < 1; attempt++) await settle()
  t.alike([...received.keys()], [2], 'the runtime upload ceiling stops the next oversized transfer')
  await runtimeA.applyNetworkPolicy(archivePolicy({ uploadCeilingBytes: 256 * 1024 }))
  await runtimeB.applyNetworkPolicy(archivePolicy())
  for (let attempt = 0; attempt < 30 && received.size < 3; attempt++) await settle()

  t.alike([...received.keys()].sort((a, b) => a - b), [2, 3, 4])
  const committedUploadBytes = runtimeA.getDiagnostics().policy.uploadedBytes
  t.ok(committedUploadBytes > 0)
  await runtimeA.applyNetworkPolicy(archivePolicy({ uploadCeilingBytes: 0 }))
  t.is(runtimeA.getDiagnostics().policy.uploadedBytes, committedUploadBytes, 'lower ceilings preserve committed upload accounting')
  await runtimeA.applyNetworkPolicy(archivePolicy({ uploadCeilingBytes: 256 * 1024 }))
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
  const runtimeA = createScopedNetworkRuntime({ swarm: swarmA, store: {}, initialNetworkPolicy: archivePolicy() })
  const runtimeB = createScopedNetworkRuntime({ swarm: swarmB, store: {}, initialNetworkPolicy: archivePolicy() })
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
  assertCurrentRuntimeTopics(t, runtimeA)
  assertCurrentRuntimeTopics(t, runtimeB)

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
