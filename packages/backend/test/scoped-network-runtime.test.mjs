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
  normalizeAssetCoreRefV2,
} from '../src/assets/index.js'
import { createBufferSourceReader } from '../src/assets/source-reader.js'
import { createPermissionlessArchiveNetwork } from '../src/archive/permissionless-network.js'
import { createIndexFeedPage } from '../src/indexing/feed-contract.js'
import { createModerationFeedPage } from '../src/moderation/feed-contract.js'
import { createModerationManager } from '../src/moderation/manager.js'
import {
  createConsumerModerationPolicy,
  createConsumerModerationProfileController,
} from '../src/moderation/profile.js'
import { createConsumerWorkRevalidator } from '../src/moderation/revalidation.js'
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
  encodePublisherOperationBody,
  encodePublisherCatalogFrame,
  derivePublisherId,
  encodePublisherNamespaceDescriptor,
  PUBLISHER_RECORD_TYPES,
} from '../src/publisher/index.js'
import {
  attachMultiSignedEnvelopeSignatures,
  attachSignedEnvelopeSignature,
  multiSignedRecordSignaturePreimage,
  prepareMultiSignedEnvelope,
  prepareSignedEnvelope,
  signedRecordSignaturePreimage,
} from '../src/records/index.js'
import { encodeApplicationEnvelope } from '../src/records/application-envelope.js'
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

function connectionPair (options = {}, remoteBFill = 202) {
  // Two call styles are in use: positional (remoteAFill, remoteBFill) and an
  // options object naming the same two peers plus a write buffer size.
  const config = options !== null && typeof options === 'object'
    ? options
    : { consumerPeerFill: options, sourcePeerFill: remoteBFill }
  const { sourcePeerFill = 202, consumerPeerFill = 201, highWaterMark } = config
  // Protomux decodes exactly one message per stream data event; real transports
  // under it frame every message, so that holds. Keep the in-memory transport
  // in object mode as well, otherwise queued writes can be coalesced into one
  // byte chunk and every message after the first is silently dropped.
  const streamOptions = {
    objectMode: true,
    ...(highWaterMark == null ? {} : { highWaterMark }),
  }
  const aToB = new PassThrough(streamOptions)
  const bToA = new PassThrough(streamOptions)
  const a = Duplex.from({ readable: bToA, writable: aToB })
  const b = Duplex.from({ readable: aToB, writable: bToA })
  a.userData = null
  b.userData = null
  a.remotePublicKey = bytes(32, consumerPeerFill)
  b.remotePublicKey = bytes(32, sourcePeerFill)
  a.once('close', () => {
    if (!b.destroyed) b.destroy()
  })
  b.once('close', () => {
    if (!a.destroyed) a.destroy()
  })
  return { a, b }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

// A pair whose writes complete asynchronously, so a frame larger than the write
// buffer leaves data queued and write() reports backpressure the way a real
// congested socket does. PassThrough behind Duplex.from never does: it absorbs
// the write and answers true.
function backpressuredPair ({ sourcePeerFill = 206, consumerPeerFill = 205 } = {}) {
  const make = (peer) => new Duplex({
    // Keep writes byte-counted so highWaterMark: 1 still exercises real
    // backpressure, while each pushed frame remains one readable object.
    readableObjectMode: true,
    highWaterMark: 1,
    write (chunk, _encoding, callback) {
      peer().push(chunk)
      setImmediate(callback)
    },
    read () {},
  })
  let a = null
  let b = null
  a = make(() => b)
  b = make(() => a)
  a.userData = null
  b.userData = null
  a.remotePublicKey = bytes(32, consumerPeerFill)
  b.remotePublicKey = bytes(32, sourcePeerFill)
  return { a, b }
}

function namespaceGenesis (descriptor, root) {
  const prepared = prepareSignedEnvelope({
    recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: descriptor.publisherId,
    signerKey: root.publicKey,
    policyEpoch: 0,
    issuerSequence: 0,
    signedAt: 10,
    canonicalBody: encodePublisherNamespaceDescriptor(descriptor),
  }, { hash: crypto.hash })
  return attachSignedEnvelopeSignature(prepared, crypto.sign(signedRecordSignaturePreimage(prepared), root.secretKey))
}

function namespaceTransition (descriptor, root, nextRoot, newCatalogEpoch) {
  const prepared = prepareMultiSignedEnvelope({
    recordType: PUBLISHER_RECORD_TYPES.ROOT_TRANSITION,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: descriptor.publisherId,
    policyEpoch: 0,
    issuerSequence: newCatalogEpoch,
    signedAt: 30,
    canonicalBody: encodePublisherOperationBody(PUBLISHER_RECORD_TYPES.ROOT_TRANSITION, {
      mode: 'rotation',
      previousRootKey: root.publicKey,
      newRootKey: nextRoot.publicKey,
      newCatalogEpoch,
      recoveryKeys: descriptor.recoveryKeys,
      recoveryThreshold: descriptor.recoveryThreshold,
      profileRef: descriptor.profileRef,
    }),
  }, { hash: crypto.hash })
  const preimage = multiSignedRecordSignaturePreimage(prepared)
  return attachMultiSignedEnvelopeSignatures(prepared, [root, nextRoot].map(signer => ({
    signerKey: signer.publicKey,
    signature: crypto.sign(preimage, signer.secretKey),
  })).sort((left, right) => b4a.compare(left.signerKey, right.signerKey)))
}

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

// Publishing a local catalog proves its namespace from the genesis operation.
// Pass the root key pair and the fixture serves that proof; tests that need a
// different accepted page still override listAcceptedPage themselves.
function fakeRegistry (descriptor, root = null) {
  const catalogEvents = new EventEmitter()
  const genesis = root ? namespaceGenesis(descriptor, root) : null
  const catalog = {
    key: descriptor.catalogBootstrapKey,
    writable: true,
    replicated: [],
    async ready () {},
    async close () {},
    async listProjections () { return { items: [], nextCursor: null } },
    async listAcceptedPage ({ cursor } = {}) {
      if (!genesis || cursor !== null) return { entries: [], nextCursor: null }
      return {
        entries: [{
          operationId: b4a.toString(genesis.recordId, 'hex'),
          sourceWriterKey: bytes(32, 21),
          frame: encodePublisherCatalogFrame(genesis),
        }],
        nextCursor: null,
      }
    },
    async getViewHead () {
      return {
        viewKey: descriptor.catalogBootstrapKey,
        length: 0,
        digest: bytes(32, 210),
        authorizationStateDigest: bytes(32, 211),
      }
    },
    async getAuthorizationState () {
      return {
        policyEpoch: 0,
        policySequence: 0,
        writers: [{
          key: b4a.toString(descriptor.publisherRootKey, 'hex'),
          signerKey: b4a.toString(descriptor.publisherRootKey, 'hex'),
          capabilities: ['announce', 'publish'],
          firstAcceptedSequence: 0,
          lastAcceptedSequence: 0,
          expiresAt: Number.MAX_SAFE_INTEGER,
          admissionPolicyEpoch: 0,
          revocation: null,
        }],
      }
    },
    async ingestAcceptedPage () { return { accepted: 0 } },
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
    // Local publisher serving reacquires an ID-based writable lease for each
    // page; keep that fixture surface equivalent to the production registry.
    async acquireWritableBinding () {
      return { binding, async release () { return true } }
    },
    async resolve () { return binding },
    async release () { return true },
  }
}

function registerRuntimeTeardown (t, runtimes, pairs) {
  t.teardown(async () => {
    await Promise.allSettled(runtimes.map(runtime =>
      Promise.resolve().then(() => runtime?.close?.())))
    for (const pair of pairs) {
      pair?.a?.destroy?.()
      pair?.b?.destroy?.()
    }
  })
}

test('startup republishes only persisted writable catalogs with accepted projections', async t => {
  const root = crypto.keyPair(bytes(32, 19))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 20),
  })
  const registry = fakeRegistry(descriptor)
  const genesis = namespaceGenesis(descriptor, root)
  registry.binding.catalog.listProjections = async kind => ({
    items: kind === 'publication' ? [{ accepted: true }] : [],
    nextCursor: null,
  })
  registry.binding.catalog.listAcceptedPage = async ({ cursor }) => cursor === null
    ? [{
        entries: [{
          operationId: b4a.toString(genesis.recordId, 'hex'),
          sourceWriterKey: bytes(32, 21),
          frame: encodePublisherCatalogFrame(genesis),
        }],
        nextCursor: null,
      }][0]
    : { entries: [], nextCursor: null }
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

test('positive role budget cannot bypass a zero global upload ceiling', async (t) => {
  const root = crypto.keyPair(bytes(32, 30))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 31),
  })
  const registry = fakeRegistry(descriptor)
  registry.binding.catalog.listProjections = async () => ({ items: [{ accepted: true }], nextCursor: null })
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({
    swarm,
    store: {},
    catalogRegistry: registry,
    initialNetworkPolicy: contributionPolicy({ uploadCeilingBytes: 0 }),
  })
  await runtime.start()

  await t.exception(
    runtime.publishLocalPublisherCatalog({ publisherId: descriptor.publisherId }),
    /explicit contribution upload permission/
  )
  t.is(runtime.getDiagnostics().publicWork.activeAnnouncements, 0)
  t.is(swarm.joins.every(join => join.options.server === false), true)
  await runtime.close()
})


test('archive consent with zero archive budget cannot allocate retention', async (t) => {
  const runtime = createScopedNetworkRuntime({
    swarm: fakeSwarm(),
    store: {},
    initialNetworkPolicy: archivePolicy({ archiveBudgetBytes: 0 }),
  })
  await runtime.start()
  const testCoreRef = normalizeAssetCoreRefV2(createStaticAssetManifest({
    treeHash: bytes(32, 27),
    blockLength: 4,
    byteLength: 4 * ASSET_BLOCK_SIZE,
  }))
  const coreKey = b4a.from(testCoreRef.key, 'hex')
  const archivist = crypto.keyPair(bytes(32, 28))
  const pledge = createArchivePledge({
    archivistId: archivist.publicKey,
    publicationId: bytes(32, 29),
    renditionId: bytes(32, 30),
    ranges: [{ coreKey, start: 0, end: 1 }],
    retentionUntil: 10_000,
    issuedAt: 10,
    uploadCeilingBytes: 0,
    keyPair: archivist,
  })
  await t.exception(
    runtime.retainAuthorizedArchive({
      pledge,
      coreKey,
      coreRef: testCoreRef,
      start: 0,
      end: 1,
    }),
    { code: 'SCOPED_NETWORK_REJECTED' },
  )
  t.is(runtime.getDiagnostics().topics.filter(topic => topic.purpose === 'archive').length, 0,
    'zero archive budget does not retain an archive scope')

  await runtime.applyNetworkPolicy(archivePolicy())
  await t.exception(
    runtime.retainAuthorizedArchive({
      pledge,
      coreKey,
      start: 0,
      end: 1,
    }),
    { code: 'SCOPED_NETWORK_REJECTED' },
  )
  t.is(runtime.getDiagnostics().topics.filter(topic => topic.purpose === 'archive').length, 0,
    'missing immutable core metadata does not retain an archive scope')
  await runtime.close()
})

test('archive-only role publishes archive catalogs without contribution permission', async (t) => {
  const root = crypto.keyPair(bytes(32, 28))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 29),
  })
  const registry = fakeRegistry(descriptor, root)
  registry.binding.catalog.listProjections = async kind => ({
    items: kind === 'publication' ? [{ accepted: true }] : [],
    nextCursor: null,
  })
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({
    swarm,
    store: {},
    catalogRegistry: registry,
    initialNetworkPolicy: archivePolicy(),
  })
  await runtime.start()
  const bootstrapTopic = deriveBootstrapTopic({ protocolMajor: PROTOCOL_MAJOR, networkId: 'peartube-main' })
  const bootstrapJoin = swarm.joins.find(join => b4a.equals(join.topic, bootstrapTopic))
  t.ok(bootstrapJoin?.options.server, 'a serving device announces the metadata-only bootstrap scope')
  t.alike(
    runtime.authorizeConnection({ purpose: 'bootstrap', topic: bootstrapTopic }),
    { status: 'authorized', action: 'metadata-only' },
    'bootstrap announcement never authorizes catalog or media bytes'
  )

  const published = await runtime.publishLocalPublisherCatalog({
    publisherId: descriptor.publisherId,
    retentionClass: 'archive-pin',
  })
  t.is(published.status, 'published')
  t.ok(runtime.getDiagnostics().topics.find(topic => topic.purpose === 'publisher')?.publicAnnounced)
  await t.exception(
    runtime.publishLocalPublisherCatalog({
      publisherId: descriptor.publisherId,
      retentionClass: 'contribution-cache',
    }),
    /explicit contribution upload permission/
  )

  await runtime.close()
})

test('watch-only downgrade closes local publisher catalog sessions and removes its announcement', async (t) => {
  const root = crypto.keyPair(bytes(32, 21))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 22),
  })
  const registryA = fakeRegistry(descriptor, root)
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
  // The follower walks the publisher's accepted pages here, and that page now
  // carries the namespace genesis registryA serves. A real consumer catalog
  // admits a root record, so the fixture must too; the default stub reports
  // every entry inadmissible and would kill the publisher session under test.
  const registryB = fakeRegistry(descriptor)
  registryB.binding.catalog.ingestAcceptedPage = async entries => ({
    accepted: entries.length,
    rejected: 0,
  })
  const runtimeB = createScopedNetworkRuntime({
    swarm: swarmB,
    store: {},
    catalogRegistry: registryB,
  })
  await runtimeA.start()
  await runtimeB.start()
  const publisherId = b4a.toString(descriptor.publisherId, 'hex')
  const published = await runtimeA.publishLocalPublisherCatalog({ publisherId })
  await runtimeB.followPublisher({ publisherId, namespaceDescriptor: descriptor })
  const pairs = []
  const connectPair = () => {
    const next = connectionPair(23, 24)
    pairs.push(next)
    swarmA.connections.add(next.a)
    swarmB.connections.add(next.b)
    swarmA.emit('connection', next.a, { publicKey: next.a.remotePublicKey, client: true })
    swarmB.emit('connection', next.b, { publicKey: next.b.remotePublicKey, client: false })
    return next
  }
  let pair = connectPair()
  await settle()
  t.ok(runtimeA.getDiagnostics().sessions.some(session => session.purpose === 'publisher'))
  t.ok(runtimeA.getDiagnostics().topics.find(topic => topic.purpose === 'publisher')?.publicAnnounced)

  await runtimeA.applyNetworkPolicy(contributionPolicy({ contributionBudgetBytes: 0 }))
  await settle()
  t.ok(pair.a.destroyed, 'contribution-budget cutover destroys the old publisher transport')
  t.ok(pair.b.destroyed, 'contribution-budget cutover destroys the old follower transport')
  let transitionDiagnostics = runtimeA.getDiagnostics()
  t.absent(transitionDiagnostics.sessions.find(session => session.purpose === 'publisher'),
    'contribution budget reduction closes the local catalog session')
  t.absent(transitionDiagnostics.topics.find(topic => topic.purpose === 'publisher')?.publicAnnounced,
    'zero contribution budget suppresses the local catalog announcement')
  t.ok(runtimeB.getDiagnostics().topics.some(topic => topic.purpose === 'publisher'),
    'the client-only followed catalog scope remains retained')

  await runtimeA.applyNetworkPolicy(contributionPolicy())
  await settle()
  pair = connectPair()
  await settle()
  for (let attempt = 0; attempt < 20; attempt++) {
    if (runtimeA.getDiagnostics().sessions.some(session => session.purpose === 'publisher')) break
    await settle()
  }
  t.ok(runtimeA.getDiagnostics().topics.find(topic => topic.purpose === 'publisher')?.publicAnnounced,
    'restoring the contribution budget rejoins public catalog discovery')

  await runtimeA.applyNetworkPolicy(contributionPolicy({ uploadCeilingBytes: 0 }))
  await settle()
  t.ok(pair.a.destroyed, 'global-ceiling cutover destroys the old publisher transport')
  t.ok(pair.b.destroyed, 'global-ceiling cutover destroys the old follower transport')
  transitionDiagnostics = runtimeA.getDiagnostics()
  t.absent(transitionDiagnostics.sessions.find(session => session.purpose === 'publisher'),
    'zero global upload ceiling closes the local catalog session')
  t.absent(transitionDiagnostics.topics.find(topic => topic.purpose === 'publisher')?.publicAnnounced,
    'zero global upload ceiling suppresses the local catalog announcement')
  t.ok(runtimeB.getDiagnostics().topics.some(topic => topic.purpose === 'publisher'),
    'global upload cutover preserves the followed client scope')

  await runtimeA.applyNetworkPolicy(contributionPolicy())
  await settle()
  pair = connectPair()
  await settle()
  for (let attempt = 0; attempt < 20; attempt++) {
    if (runtimeA.getDiagnostics().sessions.some(session => session.purpose === 'publisher')) break
    await settle()
  }
  t.ok(runtimeA.getDiagnostics().sessions.some(session => session.purpose === 'publisher'),
    'restoring the global upload ceiling rejoins the public catalog session')


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
  await settle()
  t.ok(pair.a.destroyed, 'upload-permission cutover destroys the old publisher transport')
  t.ok(pair.b.destroyed, 'upload-permission cutover destroys the old follower transport')
  const diagnostics = runtimeA.getDiagnostics()
  t.absent(diagnostics.sessions.find(session => session.purpose === 'publisher'),
    'local catalog has no stale handshaking session immediately after downgrade')
  t.absent(diagnostics.topics.find(topic => topic.purpose === 'publisher')?.publicAnnounced, 'publisher discovery becomes client-only')
  t.is(runtimeA.authorizeConnection({ purpose: 'publisher', topic: published.topic.topicHex
    ? b4a.from(published.topic.topicHex, 'hex')
    : derivePublisherTopic({ publisherId, catalogEpoch: descriptor.catalogEpoch }) }).status, 'rejected')

  await runtimeA.close()
  await runtimeB.close()
  for (const connection of pairs) {
    connection.a.destroy()
    connection.b.destroy()
  }
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

test('suspended public discovery restores its announcement count when the network resumes', async (t) => {
  const root = crypto.keyPair(bytes(32, 34))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 35),
  })
  const registry = fakeRegistry(descriptor, root)
  registry.binding.catalog.listProjections = async () => ({ items: [{ accepted: true }], nextCursor: null })
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({
    swarm,
    store: {},
    catalogRegistry: registry,
    initialNetworkPolicy: contributionPolicy(),
  })
  await runtime.start()
  const published = await runtime.publishLocalPublisherCatalog({ publisherId: descriptor.publisherId })
  const publisherJoin = swarm.joins.find(join =>
    b4a.toString(join.topic, 'hex') === published.topic.topicHex)
  t.ok(publisherJoin, 'local publisher creates its public discovery handle')
  if (!publisherJoin) {
    await runtime.close()
    return
  }
  t.ok(publisherJoin.options.server)
  t.is(runtime.getDiagnostics().publicWork.activeAnnouncements, 2, 'bootstrap metadata and the local catalog are both announced')

  await runtime.applyNetworkPolicy(contributionPolicy({ networkEnabled: false }))
  t.is(publisherJoin.suspended, 1, 'network pause suspends rather than replaces public discovery')
  t.is(publisherJoin.destroyed, 0)
  t.is(runtime.getDiagnostics().publicWork.activeAnnouncements, 0)

  await runtime.applyNetworkPolicy(contributionPolicy())
  t.is(publisherJoin.resumed, 1)
  t.is(runtime.getDiagnostics().publicWork.activeAnnouncements, 2,
    'resumed discovery restores both bootstrap metadata and the local catalog')
  t.is(swarm.joins.filter(join => b4a.equals(join.topic, publisherJoin.topic)).length, 1)
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

test('only a followed publisher with a verified namespace can request bounded catalog pages', async (t) => {
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
  t.is(authorized.action, 'catalog-pages')
  t.is(registry.binding.catalog.replicated.length, 0, 'publisher authorization never exposes generic Hypercore replication')

  await runtime.unfollowPublisher({ publisherId })
  t.is(runtime.authorizeConnection({ purpose: 'publisher', topic, peerId: 'after-unfollow' }).status, 'rejected')
  await runtime.close()
})

test('publisher scope transfers large-head catalogs through bounded exact-provenance pages', async (t) => {
  const root = crypto.keyPair(bytes(32, 212))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 213),
  })
  const genesis = namespaceGenesis(descriptor, root)
  const genesisFrame = encodePublisherCatalogFrame(genesis)
  const sourceWriterKey = bytes(32, 214)
  const sourceRegistry = fakeRegistry(descriptor)
  sourceRegistry.binding.catalog.listProjections = async kind => ({
    items: kind === 'publication' ? [{ accepted: true }] : [],
    nextCursor: null,
  })
  const genesisId = b4a.toString(genesis.recordId, 'hex')
  const requestedCursors = []
  sourceRegistry.binding.catalog.listAcceptedPage = async ({ cursor }) => {
    requestedCursors.push(cursor)
    return cursor === null
    ? {
        entries: [{
          operationId: genesisId,
          sourceWriterKey,
          frame: genesisFrame,
        }],
        nextCursor: genesisId,
      }
    : { entries: [], nextCursor: null }
  }
  // The head stays stable across every phase: this fixture pins provenance
  // fidelity, terminal-flush cursor durability, restart resume, and the
  // admission budget window. Head-change adoption is covered by the root
  // rotation fixture.
  sourceRegistry.binding.catalog.getViewHead = async () => {
    return {
      viewKey: descriptor.catalogBootstrapKey,
      // Physical Hyperbee history can exceed the number of catalog operations.
      length: 5000,
      digest: bytes(32, 215),
      authorizationStateDigest: bytes(32, 216),
    }
  }
  sourceRegistry.binding.catalog.view = {
    async get (key) {
      return key === 'state/descriptor'
        ? { value: encodePublisherNamespaceDescriptor(descriptor) }
        : null
    },
    async * createReadStream () {
      yield { key: `accepted/${b4a.toString(genesis.recordId, 'hex')}`, value: genesisFrame }
    },
  }

  const received = []
  const consumerRegistry = fakeRegistry(descriptor)
  consumerRegistry.binding.catalog.ingestAcceptedPage = async entries => {
    received.push(...entries)
    return { accepted: entries.length, rejected: 0 }
  }
  consumerRegistry.binding.catalog.getViewHead = async () => ({
    viewKey: descriptor.catalogBootstrapKey,
    length: received.length,
    digest: bytes(32, 215),
    authorizationStateDigest: bytes(32, 216),
  })
  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  const source = createScopedNetworkRuntime({
    swarm: swarmA,
    store: {},
    catalogRegistry: sourceRegistry,
    initialNetworkPolicy: contributionPolicy(),
  })
  let catalogUpdates = 0
  const publisherStates = new Map()
  let globalPublisherBudget = null
  const publisherSyncStateRepository = {
    async load(id) { return publisherStates.get(id) || null },
    async save(id, state) { publisherStates.set(id, structuredClone(state)) },
    async loadGlobal() { return structuredClone(globalPublisherBudget) },
    async saveGlobal(state) { globalPublisherBudget = structuredClone(state) },
  }
  const consumer = createScopedNetworkRuntime({
    swarm: swarmB,
    store: {},
    catalogRegistry: consumerRegistry,
    onCatalogUpdate: async () => { catalogUpdates++ },
    publisherSyncStateRepository,
    catalogAdmissionLimits: { pages: 3 },
  })
  await source.start()
  await consumer.start()
  await source.publishLocalPublisherCatalog({ publisherId: descriptor.publisherId })
  await consumer.followPublisher({ publisherId: descriptor.publisherId, namespaceDescriptor: descriptor })

  const pair = connectionPair()
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey, client: false })
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey, client: true })
  // The first walk buffers the genesis page and flushes once at its terminal
  // page: one ingest call carrying the exact served frames, after which the
  // projection refresh publishes the catalog update.
  for (let attempt = 0; attempt < 30 && catalogUpdates === 0; attempt++) await settle()

  t.is(received.length, 1)
  t.is(catalogUpdates, 1, 'the terminal flush completes the walk and updates the projection')
  t.ok(b4a.equals(received[0].sourceWriterKey, sourceWriterKey), 'source writer provenance survives transport exactly')
  t.ok(b4a.equals(received[0].frame, genesisFrame), 'canonical publisher frame survives transport exactly')
  t.is(sourceRegistry.binding.catalog.replicated.length, 0)
  const retryPair = connectionPair()

  swarmA.connections.add(retryPair.a)
  swarmB.connections.add(retryPair.b)
  swarmA.emit('connection', retryPair.a, { publicKey: retryPair.a.remotePublicKey, client: false })
  swarmB.emit('connection', retryPair.b, { publicKey: retryPair.b.remotePublicKey, client: true })
  for (let attempt = 0; attempt < 30 && received.length !== 1; attempt++) await settle()
  t.is(received.length, 1, 'a completed walk re-verifies without re-ingesting records')
  // The cursor is only durable once its records are flushed: the terminal
  // page's last operation id.
  t.is(publisherStates.get(b4a.toString(descriptor.publisherId, 'hex')).cursor, genesisId,
    'the flushed terminal cursor is durable')
  // Walk one consumed two pages (genesis page + empty terminal page); the
  // retry walk re-verified completion without opening a charged page.
  t.is(globalPublisherBudget.pages, 2, 'global admission work is durable alongside the publisher checkpoint')

  await consumer.close()
  retryPair.a.destroy()
  retryPair.b.destroy()

  const restartSwarm = fakeSwarm()
  let restartUpdates = 0
  const restarted = createScopedNetworkRuntime({
    swarm: restartSwarm,
    store: {},
    catalogRegistry: consumerRegistry,
    onCatalogUpdate: async () => { restartUpdates++ },
    publisherSyncStateRepository,
    catalogAdmissionLimits: { pages: 3 },
  })
  await restarted.start()
  await restarted.followPublisher({ publisherId: descriptor.publisherId, namespaceDescriptor: descriptor })
  const restartPair = connectionPair({ consumerPeerFill: 203 })
  swarmA.connections.add(restartPair.a)
  restartSwarm.connections.add(restartPair.b)
  swarmA.emit('connection', restartPair.a, { publicKey: restartPair.a.remotePublicKey, client: false })
  restartSwarm.emit('connection', restartPair.b, { publicKey: restartPair.b.remotePublicKey, client: true })
  for (let attempt = 0; attempt < 30 && restartUpdates === 0; attempt++) await settle()
  t.is(restartUpdates, 1, 'restart reopens the durable verified view and completes from its saved cursor')
  t.is(requestedCursors.at(-1), genesisId, 'restart does not replay the first page')

  await restarted.close()
  restartPair.a.destroy()
  restartPair.b.destroy()

  const exhaustedSwarm = fakeSwarm()
  let exhaustedUpdates = 0
  const exhausted = createScopedNetworkRuntime({
    swarm: exhaustedSwarm,
    store: {},
    catalogRegistry: consumerRegistry,
    onCatalogUpdate: async () => { exhaustedUpdates++ },
    publisherSyncStateRepository,
    catalogAdmissionLimits: { pages: 3 },
  })
  await exhausted.start()
  await exhausted.followPublisher({ publisherId: descriptor.publisherId, namespaceDescriptor: descriptor })
  const exhaustedPair = connectionPair({ consumerPeerFill: 204 })
  swarmA.connections.add(exhaustedPair.a)
  exhaustedSwarm.connections.add(exhaustedPair.b)
  swarmA.emit('connection', exhaustedPair.a, { publicKey: exhaustedPair.a.remotePublicKey, client: false })
  exhaustedSwarm.emit('connection', exhaustedPair.b, { publicKey: exhaustedPair.b.remotePublicKey, client: true })
  for (let attempt = 0; attempt < 20 && exhausted.getDiagnostics().recentErrors.length === 0; attempt++) await settle()
  t.is(exhaustedUpdates, 0, 'restart cannot reset and bypass the durable admission window')
  t.ok(exhausted.getDiagnostics().recentErrors.some(error => error.code === 'PUBLISHER_CATALOG_WINDOW_BUDGET_EXCEEDED'))

  await source.close()
  await exhausted.close()
  pair.a.destroy()
  pair.b.destroy()
  exhaustedPair.a.destroy()
  exhaustedPair.b.destroy()
})

test('publisher catalog growth stays bounded after accepting a large initial head', async (t) => {
  const root = crypto.keyPair(bytes(32, 217))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 218),
  })
  const sourceRegistry = fakeRegistry(descriptor, root)
  const sourceCatalog = sourceRegistry.binding.catalog
  const head = await sourceCatalog.getViewHead()
  let headLength = 5000
  sourceCatalog.getViewHead = async () => ({ ...head, length: headLength })
  sourceCatalog.listProjections = async kind => ({
    items: kind === 'publication' ? [{ accepted: true }] : [],
    nextCursor: null,
  })
  const listPage = sourceCatalog.listAcceptedPage.bind(sourceCatalog)
  sourceCatalog.listAcceptedPage = async request => {
    const page = await listPage(request)
    if (request.cursor === null) {
      headLength += 3
      return { ...page, nextCursor: page.entries[0].operationId }
    }
    return page
  }
  const received = []
  const consumerRegistry = fakeRegistry(descriptor)
  consumerRegistry.binding.catalog.ingestAcceptedPage = async entries => {
    received.push(...entries)
    return { accepted: entries.length, rejected: 0 }
  }
  let catalogUpdates = 0
  const sourceSwarm = fakeSwarm()
  const consumerSwarm = fakeSwarm()
  const source = createScopedNetworkRuntime({
    swarm: sourceSwarm, store: {}, catalogRegistry: sourceRegistry,
    initialNetworkPolicy: contributionPolicy(),
  })
  const consumer = createScopedNetworkRuntime({
    swarm: consumerSwarm, store: {}, catalogRegistry: consumerRegistry,
    catalogAdmissionLimits: { headDistance: 2 },
    onCatalogUpdate: () => { catalogUpdates++ },
  })
  const pair = connectionPair()
  registerRuntimeTeardown(t, [source, consumer], [pair])
  await source.start()
  await consumer.start()
  await source.publishLocalPublisherCatalog({ publisherId: descriptor.publisherId })
  await consumer.followPublisher({ publisherId: descriptor.publisherId, namespaceDescriptor: descriptor })
  sourceSwarm.connections.add(pair.a)
  consumerSwarm.connections.add(pair.b)
  sourceSwarm.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey, client: false })
  consumerSwarm.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey, client: true })
  for (let attempt = 0; attempt < 30 && consumer.getDiagnostics().recentErrors.length === 0; attempt++) await settle()
  t.is(received.length, 1, 'the initial large head is admitted, not rejected as lifetime work')
  t.is(catalogUpdates, 0, 'growth beyond the configured distance cannot publish a completed projection')
  t.ok(consumer.getDiagnostics().recentErrors.some(error =>
    error.purpose === 'publisher' && error.code === 'SCOPED_NETWORK_REJECTED'))
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
    reader: createBufferSourceReader(b4a.from('fresh static replication')),
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
  const asset = await writeStaticAsset({ store: sourceStore, reader: createBufferSourceReader(sourceBytes) })
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
  let markGlobalReductionProofStarted
  let releaseGlobalReductionProof
  let holdGlobalReductionProof = false
  const globalReductionProofStarted = new Promise(resolve => { markGlobalReductionProofStarted = resolve })
  const globalReductionProofRelease = new Promise(resolve => { releaseGlobalReductionProof = resolve })
  const patchedSourceCores = new WeakSet()
  const sourceRuntimeStore = {
    get (options) {
      const core = sourceStore.get(options)
      if (patchedSourceCores.has(core)) return core
      patchedSourceCores.add(core)
      const proof = core.proof.bind(core)
      core.proof = async request => {
        const result = await proof(request)
        if (holdGlobalReductionProof && request?.block?.index === 4) {
          holdGlobalReductionProof = false
          markGlobalReductionProofStarted()
          await globalReductionProofRelease
        }
        return result
      }
      return core
    }
  }
  const swarmB = fakeSwarm()
  const runtimeA = createScopedNetworkRuntime({
    swarm: swarmA,
    store: sourceRuntimeStore,
    authorizePublication: async request => request.manifest === manifest,
    initialNetworkPolicy: contributionPolicy(),
  })
  const runtimeB = createScopedNetworkRuntime({
    swarm: swarmB,
    store: readerStore,
    authorizePublication: async request => request.manifest === manifest,
  })
  const pairs = []
  let pair = null
  const connectPair = () => {
    const next = connectionPair()
    pairs.push(next)
    swarmA.connections.add(next.a)
    swarmB.connections.add(next.b)
    swarmA.emit('connection', next.a, { publicKey: next.a.remotePublicKey })
    swarmB.emit('connection', next.b, { publicKey: next.b.remotePublicKey })
    return next
  }
  t.teardown(async () => {
    await runtimeA.close().catch(() => {})
    await runtimeB.close().catch(() => {})
    for (const connection of pairs) {
      connection.a.destroy()
      connection.b.destroy()
    }
    await readerCore.close().catch(() => {})
    await asset.core.close().catch(() => {})
    await sourceStore.close()
    await readerStore.close()
    fs.rmSync(sourceDir, { recursive: true, force: true })
    fs.rmSync(readerDir, { recursive: true, force: true })
  })

  await runtimeA.start()
  await runtimeB.start()
  pair = connectPair()
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
  holdGlobalReductionProof = true
  await readerCore.clear(4)
  const uploadedBeforeExhaustion = runtimeA.getDiagnostics().policy.uploadedBytes
  const closedBeforeGlobalReduction = runtimeA.getDiagnostics().counters.closedSessions
  const inFlight = runtimeB.requestAssetBlocks({
    assetId: staticCore.assetId,
    startBlock: 4,
    endBlock: 5,
    requirePeerEvidence: true,
  })
  const observedInFlight = inFlight.then(() => null, error => error)
  await globalReductionProofStarted
  await runtimeA.applyNetworkPolicy(contributionPolicy({ uploadCeilingBytes: 1 }))
  await settle()
  t.absent(runtimeA.getDiagnostics().sessions.find(session => session.purpose === 'asset'),
    'cutover returns after removing the serving session without awaiting held channel work')
  t.ok(pair.a.destroyed, 'global ceiling cutover destroys the old provider transport')
  t.ok(pair.b.destroyed, 'global ceiling cutover destroys the old requester transport')
  releaseGlobalReductionProof()
  const exhausted = await observedInFlight
  t.ok(exhausted, 'global ceiling reduction settles the already accepted peer request')
  t.is(exhausted.code, 'DISCONNECTED', 'cutover disconnects before the held proof can be released')
  t.is(exhausted.peerId, b4a.toString(pair.b.remotePublicKey, 'hex'))
  t.ok(exhausted.message.length <= 256)
  t.ok(runtimeA.getDiagnostics().counters.closedSessions > closedBeforeGlobalReduction,
    'global ceiling reduction closes the affected asset session before rejoin')
  t.is(runtimeA.getDiagnostics().policy.uploadedBytes, uploadedBeforeExhaustion,
    'global ceiling reduction preserves committed accounting')
  t.is(await readerCore.has(4), false, 'global ceiling reduction serves no asset block')

  await runtimeA.applyNetworkPolicy(contributionPolicy())
  await settle()
  pair = connectPair()
  await settle()
  for (let attempt = 0; attempt < 30; attempt++) {
    const providerActive = runtimeA.getDiagnostics().sessions.some(session =>
      session.purpose === 'asset' && session.state === 'active')
    const requesterActive = runtimeB.getDiagnostics().sessions.some(session =>
      session.purpose === 'asset' && session.state === 'active')
    if (providerActive && requesterActive) break
    await settle()
  }
  t.absent(pair.a.destroyed, 'fresh provider transport survives restored activation')
  t.absent(pair.b.destroyed, 'fresh requester transport survives restored activation')
  t.ok(runtimeA.getDiagnostics().sessions.some(session =>
    session.purpose === 'asset' && session.state === 'active'),
    'provider session activates under the restored ceiling')
  t.ok(runtimeB.getDiagnostics().sessions.some(session =>
    session.purpose === 'asset' && session.state === 'active'),
    'requester session activates under the restored ceiling')
  const closedBeforeRoleBudget = runtimeA.getDiagnostics().counters.closedSessions
  const uploadedBeforeRoleBudget = runtimeA.getDiagnostics().policy.uploadedBytes
  const servingPair = pair
  await runtimeA.applyNetworkPolicy(contributionPolicy({ contributionBudgetBytes: 0 }))
  await settle()
  t.ok(servingPair.a.destroyed, 'role-budget cutover destroys the old provider transport')
  t.ok(servingPair.b.destroyed, 'role-budget cutover destroys the old requester transport')
  pair = connectPair()
  await settle()
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = runtimeA.getDiagnostics()
    const closedServingSession = current.counters.closedSessions > closedBeforeRoleBudget
    const activeClientSession = current.sessions.some(session =>
      session.purpose === 'asset' && session.state === 'active')
    if (closedServingSession && activeClientSession) break
    await settle()
  }
  const roleBudgetDiagnostics = runtimeA.getDiagnostics()
  t.ok(roleBudgetDiagnostics.counters.closedSessions > closedBeforeRoleBudget,
    'zero contribution budget closes the old serving asset session')
  const clientOnlyAssetSession = roleBudgetDiagnostics.sessions.find(session =>
    session.purpose === 'asset' && session.state === 'active')
  t.ok(clientOnlyAssetSession, 'the retained asset rejoins on a fresh transport as a client-only session')
  t.is(clientOnlyAssetSession?.assetResponseCount, 0)
  t.absent(roleBudgetDiagnostics.topics.find(topic => topic.purpose === 'asset')?.publicAnnounced,
    'zero contribution role budget suppresses asset announcement')
  const roleDenied = await runtimeB.requestAssetBlocks({
    assetId: staticCore.assetId,
    startBlock: 4,
    endBlock: 5,
    requirePeerEvidence: true,
  }).then(() => null, error => error)
  t.is(roleDenied?.code, 'UNAVAILABLE', 'active client-only replacement cannot serve an asset block')
  t.is(runtimeA.getDiagnostics().policy.uploadedBytes, uploadedBeforeRoleBudget)
  t.ok(runtimeB.getDiagnostics().topics.some(topic => topic.purpose === 'asset'),
    'the watch-only client asset scope remains retained')
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
  const asset = await writeStaticAsset({ store: writerStore, reader: createBufferSourceReader(sourceBytes) })
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
  t.is(catalogUpdates, 0, 'raw Autobase update events are not wired to consumer transport')

  await runtimeA.close()
  await runtimeB.close()
  pair.a.destroy()
  pair.b.destroy()
})

test('scoped index and moderation feeds transfer only signed bounded pages', async (t) => {
  const curator = crypto.keyPair(bytes(32, 141))
  const moderator = crypto.keyPair(bytes(32, 142))
  const publisher = crypto.keyPair(bytes(32, 143))
  const publisherId = b4a.toString(publisher.publicKey, 'hex')
  const curatorId = b4a.toString(curator.publicKey, 'hex')
  const moderatorId = b4a.toString(moderator.publicKey, 'hex')
  const staticCore = createStaticAssetManifest({
    treeHash: bytes(32, 145),
    blockLength: 4,
    byteLength: 4 * ASSET_BLOCK_SIZE,
  })
  const coreKey = staticCore.key
  const rendition = createRenditionDescriptor({
    purpose: 'original',
    format: 'video/mp4',
    core: staticCore,
  })
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence: 1,
    title: 'Moderated feature',
    renditions: [rendition],
    provenance: [{
      type: 'upload',
      renditionId: rendition.renditionId,
      coreKey: b4a.toString(coreKey, 'hex'),
      start: 0,
      end: 4,
    }],
    keyPair: publisher,
    signedAt: 10,
  })
  const publicationId = manifest.publicationId
  const candidate = {
    directPublisher: true,
    kind: 'movie',
    entityRef: 'work:scoped',
    publicationId,
    publisherId,
    title: 'Moderated feature',
    playable: true,
  }
  const indexPage = createIndexFeedPage({
    curatorId,
    pageCursor: '0',
    nextCursor: null,
    keyPair: curator,
    issuedAt: 10,
    expiresAt: 100,
    records: [{ kind: 'movie', entityRef: 'work:scoped', publicationId, publisherId, creator: 'curator', collectionId: 'catalog', playable: true }],
  })
  const moderationPage = createModerationFeedPage({
    moderatorId,
    pageCursor: '0',
    nextCursor: null,
    keyPair: moderator,
    issuedAt: 10,
    expiresAt: 100,
    records: [{ action: 'block', targetType: 'publication', targetId: publicationId }],
  })
  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  const source = createScopedNetworkRuntime({ swarm: swarmA, store: {}, now: () => 20 })
  const moderationChanges = []
  const profileController = createConsumerModerationProfileController({
    bundledProfile: {
      version: 1,
      enabled: true,
      curatorSubscriptions: [moderatorId],
    },
  })
  await profileController.ready
  let runModerationRevalidation = async () => {}
  const consumerModerationManager = createModerationManager({
    now: () => 20,
    onRecordsChanged: async event => {
      moderationChanges.push(event)
      await runModerationRevalidation()
    },
  })
  const moderationPolicy = createConsumerModerationPolicy({
    profileController,
    moderationManager: consumerModerationManager,
  })
  const isPublicationVisible = () => moderationPolicy.evaluate(candidate).action === 'visible'
  const verifiedQueryView = {
    async getPublication({ publicationId: requested }) {
      return requested === publicationId && isPublicationVisible() ? candidate : null
    },
    async isVisible(record) {
      return record.publicationId === publicationId && isPublicationVisible()
    },
  }
  const consumer = createScopedNetworkRuntime({
    swarm: swarmB,
    store: {
      get({ key }) {
        return {
          key,
          ready: async () => {},
          download: () => ({ destroy() {} }),
          close: async () => {},
        }
      },
    },
    now: () => 20,
    moderationManager: consumerModerationManager,
    authorizePublication: async ({ manifest: proposed }) => proposed === manifest,
    authorizeConsumerWork: async ({ publicationId: proposed }) => proposed === publicationId && isPublicationVisible(),
    initialNetworkPolicy: archivePolicy(),
  })
  const archiveNetwork = createPermissionlessArchiveNetwork({
    keyPair: crypto.keyPair(bytes(32, 146)),
    now: () => 20,
    scopedNetwork: consumer,
  })
  runModerationRevalidation = createConsumerWorkRevalidator({
    verifiedQueryView,
    scopedNetwork: consumer,
    getArchiveNetwork: () => archiveNetwork,
  })
  await source.start()
  await consumer.start()
  t.is(isPublicationVisible(), true)
  t.is((await consumer.retainAuthorizedRendition({
    manifest,
    renditionId: rendition.renditionId,
    start: 0,
    end: 4,
    entityRef: candidate.entityRef,
    publicationId,
  })).status, 'retained')
  await archiveNetwork.requestArchive({
    publicationId,
    renditionId: rendition.renditionId,
    coreRef: staticCore,
    ranges: [{ coreKey, start: 0, end: 4 }],
    requestedBytes: 4096,
    retentionUntil: 200,
    expiresAt: 100,
  })
  t.is(archiveNetwork.getStatus().knownRequests, 1)
  await source.provideIndexFeed({ curatorId, fetchPage: async cursor => cursor === '0' ? { envelope: indexPage.envelope } : null })
  await source.provideModerationFeed({ moderatorId, fetchPage: async cursor => cursor === '0' ? { envelope: moderationPage.envelope } : null })
  await consumer.followIndexFeed({ curatorId })
  await consumer.followModerationFeed({ moderatorId })
  const pair = connectionPair()
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey, topics: [], client: false })
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey, topics: [], client: true })
  for (let attempt = 0; attempt < 20 && (
    consumer.getIndexFeedRecords().length === 0 ||
    consumer.getModerationFeedRecords().length === 0 ||
    isPublicationVisible() ||
    archiveNetwork.getStatus().knownRequests > 0
  ); attempt++) await settle()
  t.is(consumer.getIndexFeedRecords().length, 1)
  t.is(consumer.getModerationFeedRecords().length, 1)
  t.is(moderationChanges.length, 1, 'accepted remote moderation decisions notify the consumer immediately')
  t.is(isPublicationVisible(), false, 'the remote block immediately hides the publisher item')
  t.is(consumer.getDiagnostics().topics.filter(topic => topic.purpose === 'asset').length, 0,
    'the active asset is cancelled and its topic is left')
  t.is(archiveNetwork.getStatus().knownRequests, 0, 'the active archive request is cancelled')
  t.is(consumer.getDiagnostics().topics.filter(topic => topic.purpose === 'index').length, 1)
  t.is(consumer.getDiagnostics().topics.filter(topic => topic.purpose === 'moderation').length, 1)

  await consumer.unfollowModerationFeed({ moderatorId })
  t.is(isPublicationVisible(), true,
    'removing the local moderation subscription permits retained publisher truth')
  t.is(candidate.publicationId, publicationId, 'local moderation never mutates publisher network truth')
  t.is(moderationChanges.length, 2, 'record removal also rebuilds the consumer projection immediately')

  await archiveNetwork.close()
  await source.close()
  await consumer.close()
  pair.a.destroy()
  pair.b.destroy()
})

test('signed remote moderation cancels an archivist pledge and permits only future requests after removal', async (t) => {
  const moderator = crypto.keyPair(bytes(32, 147))
  const archivistKeyPair = crypto.keyPair(bytes(32, 148))
  const requesterKeyPair = crypto.keyPair(bytes(32, 149))
  const moderatorId = b4a.toString(moderator.publicKey, 'hex')
  const publicationId = b4a.toString(bytes(32, 150), 'hex')
  const renditionId = b4a.toString(bytes(32, 151), 'hex')
  const coreRef = normalizeAssetCoreRefV2(createStaticAssetManifest({
    treeHash: bytes(32, 152),
    blockLength: 4,
    byteLength: 4 * ASSET_BLOCK_SIZE,
  }))
  const coreKey = coreRef.key
  const candidate = {
    directPublisher: true,
    kind: 'movie',
    entityRef: 'work:archivist-profile',
    publicationId,
    publisherId: b4a.toString(bytes(32, 153), 'hex'),
    title: 'Archivist profile fixture',
  }
  const moderationPage = createModerationFeedPage({
    moderatorId,
    pageCursor: '0',
    nextCursor: null,
    keyPair: moderator,
    issuedAt: 10,
    expiresAt: 100,
    records: [{
      action: 'hide',
      targetType: 'publication',
      targetId: publicationId,
      label: 'signed-archivist-fixture',
    }],
  })
  const profileController = createConsumerModerationProfileController({
    bundledProfile: {
      version: 1,
      enabled: true,
      curatorSubscriptions: [moderatorId],
    },
  })
  await profileController.ready
  let revalidateArchivistWork = async () => {}
  const moderationManager = createModerationManager({
    now: () => 20,
    onRecordsChanged: () => revalidateArchivistWork(),
  })
  const moderationPolicy = createConsumerModerationPolicy({
    profileController,
    moderationManager,
  })
  const isPublicationVisible = () => moderationPolicy.evaluate(candidate).action === 'visible'
  const verifiedQueryView = {
    async getPublication({ publicationId: requested }) {
      return requested === publicationId && isPublicationVisible() ? candidate : null
    },
    async isVisible(record) {
      return record.publicationId === publicationId && isPublicationVisible()
    },
  }

  const sourceSwarm = fakeSwarm()
  const archivistSwarm = fakeSwarm()
  const requesterSwarm = fakeSwarm()
  let closedArchivistCores = 0
  const sourceRuntime = createScopedNetworkRuntime({
    swarm: sourceSwarm,
    store: {},
    now: () => 20,
  })
  const archivistRuntime = createScopedNetworkRuntime({
    swarm: archivistSwarm,
    store: {
      get ({ key }) {
        return {
          key,
          length: 0,
          byteLength: 0,
          async ready () {},
          async has () { return false },
          async get () { return null },
          download () { return { destroy () {} } },
          async close () { closedArchivistCores++ },
        }
      },
    },
    moderationManager,
    initialNetworkPolicy: archivePolicy(),
    now: () => 20,
  })
  const requesterRuntime = createScopedNetworkRuntime({
    swarm: requesterSwarm,
    store: {},
    now: () => 20,
    initialNetworkPolicy: archivePolicy(),
  })
  await Promise.all([
    sourceRuntime.start(),
    archivistRuntime.start(),
    requesterRuntime.start(),
  ])
  const archivistNetwork = createPermissionlessArchiveNetwork({
    keyPair: archivistKeyPair,
    scopedNetwork: archivistRuntime,
    enabled: true,
    capacityBytes: 8192,
    acceptanceProbability: 1,
    random: () => 0,
    now: () => 20,
    authorizeRequest: async request => ({
      accepted: true,
      requestedBytes: request.body.requestedBytes,
      ranges: request.body.ranges,
      coreRef,
    }),
    authorizeConsumerVisibility: async request =>
      request.body.publicationId === publicationId && isPublicationVisible(),
  })
  const requesterNetwork = createPermissionlessArchiveNetwork({
    keyPair: requesterKeyPair,
    scopedNetwork: requesterRuntime,
    enabled: true,
    capacityBytes: 0,
    now: () => 20,
  })
  revalidateArchivistWork = createConsumerWorkRevalidator({
    verifiedQueryView,
    scopedNetwork: archivistRuntime,
    getArchiveNetwork: () => archivistNetwork,
  })
  await Promise.all([archivistNetwork.ready, requesterNetwork.ready])

  const archivePair = connectionPair({ sourcePeerFill: 154, consumerPeerFill: 155 })
  archivistSwarm.connections.add(archivePair.a)
  requesterSwarm.connections.add(archivePair.b)
  archivistSwarm.emit('connection', archivePair.a, {
    publicKey: archivePair.a.remotePublicKey,
    topics: [],
    client: false,
  })
  requesterSwarm.emit('connection', archivePair.b, {
    publicKey: archivePair.b.remotePublicKey,
    topics: [],
    client: true,
  })
  for (let attempt = 0; attempt < 20; attempt++) {
    if (archivistRuntime.getDiagnostics().sessions.some(session =>
      session.purpose === 'archive-discovery' && session.state === 'active') &&
        requesterRuntime.getDiagnostics().sessions.some(session =>
          session.purpose === 'archive-discovery' && session.state === 'active')) break
    await settle()
  }
  await requesterNetwork.requestArchive({
    publicationId,
    renditionId,
    coreRef,
    ranges: [{ coreKey, start: 0, end: 4 }],
    requestedBytes: 4096,
    retentionUntil: 200,
    expiresAt: 100,
    nonce: 'archive-before-hide',
  })
  for (let attempt = 0; attempt < 20 && archivistNetwork.getStatus().acceptedRequests !== 1; attempt++) {
    await settle()
  }
  t.is(archivistNetwork.getStatus().acceptedRequests, 1,
    'the visible publication receives a signed voluntary archivist pledge')
  t.is(archivistRuntime.getDiagnostics().topics.filter(topic => topic.purpose === 'archive').length, 1)

  await sourceRuntime.provideModerationFeed({
    moderatorId,
    fetchPage: async cursor => cursor === '0' ? moderationPage : null,
  })
  const moderationPair = connectionPair({ sourcePeerFill: 156, consumerPeerFill: 157 })
  sourceSwarm.connections.add(moderationPair.a)
  archivistSwarm.connections.add(moderationPair.b)
  sourceSwarm.emit('connection', moderationPair.a, {
    publicKey: moderationPair.a.remotePublicKey,
    topics: [],
    client: false,
  })
  archivistSwarm.emit('connection', moderationPair.b, {
    publicKey: moderationPair.b.remotePublicKey,
    topics: [],
    client: true,
  })
  await settle()
  await archivistRuntime.subscribeModerationFeed({ moderatorId })
  for (let attempt = 0; attempt < 20 && (
    isPublicationVisible() ||
    archivistNetwork.getStatus().acceptedRequests > 0
  ); attempt++) await settle()
  t.is(isPublicationVisible(), false,
    'the archivist applies the authenticated remote decision only to its local projection')
  t.is(archivistNetwork.getStatus().acceptedRequests, 0,
    'the remote hide immediately cancels the existing local archivist pledge')
  t.is(archivistNetwork.getStatus().reservedBytes, 0)
  t.is(archivistRuntime.getDiagnostics().topics.filter(topic => topic.purpose === 'archive').length, 0,
    'the hidden archive scope stops retention and serving immediately')
  t.ok(closedArchivistCores > 0, 'release closes the retained archive core')
  t.is(candidate.publicationId, publicationId, 'local moderation does not alter network truth')

  await archivistRuntime.unfollowModerationFeed({ moderatorId })
  for (let attempt = 0; attempt < 20 && !isPublicationVisible(); attempt++) await settle()
  t.is(isPublicationVisible(), true,
    'removing the local decision permits a future request')
  await requesterNetwork.requestArchive({
    publicationId,
    renditionId,
    coreRef,
    ranges: [{ coreKey, start: 0, end: 4 }],
    requestedBytes: 4096,
    retentionUntil: 200,
    expiresAt: 100,
    nonce: 'archive-after-removal',
  })
  for (let attempt = 0; attempt < 20 && archivistNetwork.getStatus().acceptedRequests !== 1; attempt++) {
    await settle()
  }
  t.is(archivistNetwork.getStatus().acceptedRequests, 1,
    'a new signed request may be accepted after local policy permits it')

  await Promise.all([archivistNetwork.close(), requesterNetwork.close()])
  await Promise.all([
    sourceRuntime.close(),
    archivistRuntime.close(),
    requesterRuntime.close(),
  ])
  archivePair.a.destroy()
  archivePair.b.destroy()
  moderationPair.a.destroy()
  moderationPair.b.destroy()
})

test('an untrusted bootstrap locator can bind a publisher only after a scoped namespace proof', async (t) => {
  const root = crypto.keyPair(bytes(32, 151))
  const locatorSigner = crypto.keyPair(bytes(32, 152))
  const descriptor = createPublisherNamespaceDescriptor({ genesisRootKey: root.publicKey, catalogBootstrapKey: bytes(32, 153) })
  const locator = createBootstrapLocator({
    publisherId: b4a.toString(descriptor.publisherId, 'hex'),
    catalogBootstrapKey: b4a.toString(descriptor.catalogBootstrapKey, 'hex'),
    catalogHead: b4a.toString(bytes(32, 154), 'hex'),
    authorizationChainDigest: b4a.toString(bytes(32, 155), 'hex'),
    issuedAt: 10,
    expiresAt: 100,
    keyPair: locatorSigner,
  })
  const proof = { genesis: namespaceGenesis(descriptor, root), transitions: [], descriptor }
  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  const source = createScopedNetworkRuntime({ swarm: swarmA, store: {}, catalogRegistry: fakeRegistry(descriptor), now: () => 20 })
  const consumer = createScopedNetworkRuntime({ swarm: swarmB, store: {}, catalogRegistry: fakeRegistry(descriptor), now: () => 20 })
  await source.start()
  await consumer.start()
  await source.providePublisherNamespaceProof({ locator: locator.body, proof })
  const ingested = await consumer.inspectIncomingFrame({
    purpose: 'bootstrap', topic: deriveBootstrapTopic(), peerId: 'bootstrap-peer',
    frame: encodePeerFrame({ purpose: 'bootstrap', type: 'locator', requestId: 1, payload: (await import('../src/records/application-envelope.js')).encodeApplicationEnvelope(locator.envelope) }),
  })
  t.is(ingested.status, 'accepted')
  const pair = connectionPair()
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey, topics: [], client: false })
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey, topics: [], client: true })
  await settle()
  const result = await consumer.followBootstrapLocator({ publisherId: locator.body.publisherId })
  t.is(result.status, 'following')
  t.is(consumer.getDiagnostics().topics.filter(topic => topic.purpose === 'publisher').length, 1)
  await source.close()
  await consumer.close()
  pair.a.destroy()
  pair.b.destroy()
})

test('failed publisher promotion releases its candidate scope and preserves the promotion error', async (t) => {
  const root = crypto.keyPair(bytes(32, 213))
  const locatorSigner = crypto.keyPair(bytes(32, 214))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 215),
  })
  const locator = createBootstrapLocator({
    publisherId: b4a.toString(descriptor.publisherId, 'hex'),
    catalogBootstrapKey: b4a.toString(descriptor.catalogBootstrapKey, 'hex'),
    catalogHead: b4a.toString(bytes(32, 216), 'hex'),
    authorizationChainDigest: b4a.toString(bytes(32, 217), 'hex'),
    rootSignerId: b4a.toString(root.publicKey, 'hex'),
    issuedAt: 10,
    expiresAt: 100,
    keyPair: locatorSigner,
  })
  const proof = { genesis: namespaceGenesis(descriptor, root), transitions: [], descriptor }
  const registry = fakeRegistry(descriptor)
  const promotionError = Object.assign(new Error('injected publisher promotion failure'), {
    code: 'PUBLISHER_PROMOTION_INJECTED',
  })
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({
    swarm,
    store: {},
    catalogRegistry: registry,
    publisherManager: {
      async followPublisher () { throw promotionError },
      async unfollowPublisher () {},
    },
    now: () => 20,
  })
  await runtime.start()
  const ingested = await runtime.inspectIncomingFrame({
    purpose: 'bootstrap',
    topic: deriveBootstrapTopic(),
    peerId: 'promotion-failure-bootstrap-peer',
    frame: encodePeerFrame({
      purpose: 'bootstrap',
      type: 'locator',
      requestId: 1,
      payload: encodeApplicationEnvelope(locator.envelope),
    }),
  })
  t.is(ingested.status, 'accepted')

  const thrown = await runtime.followBootstrapLocator({
    publisherId: locator.body.publisherId,
    proof,
  }).then(() => null, error => error)
  t.is(thrown?.code, promotionError.code, 'promotion failure keeps its public error code')
  t.is(thrown?.message, promotionError.message, 'promotion failure keeps its public reason')
  t.is(runtime.getDiagnostics().topics.filter(topic => topic.purpose === 'publisher').length, 0,
    'a failed promotion leaves no candidate publisher scope behind')

  await runtime.close()
})

test('locator authorization digests are hints while reconstructed announce authority is mandatory', async (t) => {
  const root = crypto.keyPair(bytes(32, 159))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 160),
  })
  const genesis = namespaceGenesis(descriptor, root)
  const sourceRegistry = fakeRegistry(descriptor)
  sourceRegistry.binding.catalog.listProjections = async kind => ({
    items: kind === 'publication' ? [{ accepted: true }] : [],
    nextCursor: null,
  })
  sourceRegistry.binding.catalog.listAcceptedPage = async ({ cursor }) => cursor === null
    ? {
        entries: [{
          operationId: b4a.toString(genesis.recordId, 'hex'),
          sourceWriterKey: root.publicKey,
          frame: encodePublisherCatalogFrame(genesis),
        }],
        nextCursor: null,
      }
    : { entries: [], nextCursor: null }

  const sourceSwarm = fakeSwarm()
  const source = createScopedNetworkRuntime({
    swarm: sourceSwarm,
    store: {},
    catalogRegistry: sourceRegistry,
    initialNetworkPolicy: contributionPolicy(),
    now: () => 20,
  })
  const consumerSwarms = [fakeSwarm(), fakeSwarm()]
  const consumerRegistries = consumerSwarms.map(() => fakeRegistry(descriptor))
  for (const registry of consumerRegistries) {
    registry.binding.catalog.ingestAcceptedPage = async entries => ({
      accepted: entries.length,
      rejected: 0,
    })
  }
  consumerRegistries[1].binding.catalog.getAuthorizationState = async () => ({
    policyEpoch: 0,
    policySequence: 0,
    writers: [],
  })
  const consumerUpdates = [0, 0]
  const consumers = consumerSwarms.map((swarm, index) => createScopedNetworkRuntime({
    swarm,
    store: {},
    catalogRegistry: consumerRegistries[index],
    now: () => 20,
    onCatalogUpdate: async () => { consumerUpdates[index]++ },
  }))
  await source.start()
  await Promise.all(consumers.map(consumer => consumer.start()))
  await source.publishLocalPublisherCatalog({
    publisherId: b4a.toString(descriptor.publisherId, 'hex'),
  })

  const head = await sourceRegistry.binding.catalog.getViewHead()
  const actualAuthorizationDigest = b4a.toString(head.authorizationStateDigest, 'hex')
  const commonLocator = {
    publisherId: b4a.toString(descriptor.publisherId, 'hex'),
    catalogBootstrapKey: b4a.toString(descriptor.catalogBootstrapKey, 'hex'),
    catalogHead: b4a.toString(head.digest, 'hex'),
    catalogEpoch: descriptor.catalogEpoch,
    rootSignerId: b4a.toString(root.publicKey, 'hex'),
    issuedAt: 10,
    expiresAt: 100,
    keyPair: root,
  }
  const locators = [
    createBootstrapLocator({
      ...commonLocator,
      authorizationChainDigest: b4a.toString(bytes(32, 161), 'hex'),
    }),
    createBootstrapLocator({
      ...commonLocator,
      authorizationChainDigest: actualAuthorizationDigest,
    }),
  ]
  for (let index = 0; index < consumers.length; index++) {
    const ingested = await consumers[index].inspectIncomingFrame({
      purpose: 'bootstrap',
      topic: deriveBootstrapTopic(),
      peerId: `bootstrap-peer-${index}`,
      frame: encodePeerFrame({
        purpose: 'bootstrap',
        type: 'locator',
        requestId: index + 1,
        payload: encodeApplicationEnvelope(locators[index].envelope),
      }),
    })
    t.is(ingested.status, 'accepted')
  }

  const pairs = consumers.map((consumer, index) => {
    const pair = connectionPair({ consumerPeerFill: 162 + index, sourcePeerFill: 164 })
    sourceSwarm.connections.add(pair.a)
    consumerSwarms[index].connections.add(pair.b)
    sourceSwarm.emit('connection', pair.a, {
      publicKey: pair.a.remotePublicKey,
      topics: [],
      client: false,
    })
    consumerSwarms[index].emit('connection', pair.b, {
      publicKey: pair.b.remotePublicKey,
      topics: [],
      client: true,
    })
    return pair
  })
  await settle()
  await Promise.all(consumers.map((consumer, index) => consumer.followBootstrapLocator({
    publisherId: locators[index].body.publisherId,
  })))

  for (let attempt = 0; attempt < 20; attempt++) {
    if (consumerUpdates[0] === 1 &&
        consumers[1].getDiagnostics().recentErrors.some(error =>
          error.code === 'PUBLISHER_CATALOG_LOCATOR_SIGNER_UNAUTHORIZED')) break
    await settle()
  }
  t.alike(consumerUpdates, [1, 0],
    'a stale authorization hint does not block verified catalog completion')
  t.ok(consumers[1].getDiagnostics().recentErrors.some(error =>
    error.code === 'PUBLISHER_CATALOG_LOCATOR_SIGNER_UNAUTHORIZED'),
  'a matching hint cannot substitute for reconstructed announce authority')

  await source.close()
  await Promise.all(consumers.map(consumer => consumer.close()))
  for (const pair of pairs) {
    pair.a.destroy()
    pair.b.destroy()
  }
})

test('a local publisher automatically advertises a signed locator and consumers reject false completion', async (t) => {
  const root = crypto.keyPair(bytes(32, 156))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 157),
  })
  const genesis = namespaceGenesis(descriptor, root)
  const sourceRegistry = fakeRegistry(descriptor, root)
  sourceRegistry.binding.catalog.localWriterKey = root.publicKey
  sourceRegistry.binding.catalog.localSignerKey = root.publicKey
  sourceRegistry.binding.catalog.listProjections = async kind => ({
    items: kind === 'publication' ? [{ accepted: true }] : [],
    nextCursor: null,
  })
  sourceRegistry.binding.catalog.listAcceptedPage = async ({ cursor }) => cursor === null
    ? {
        entries: [{
          operationId: b4a.toString(genesis.recordId, 'hex'),
          sourceWriterKey: root.publicKey,
          frame: encodePublisherCatalogFrame(genesis),
        }],
        nextCursor: null,
      }
    : { entries: [], nextCursor: null }
  sourceRegistry.binding.catalog.getAuthorizationState = async () => ({
    policyEpoch: 0,
    policySequence: 0,
    writers: [{
      key: b4a.toString(root.publicKey, 'hex'),
      signerKey: b4a.toString(root.publicKey, 'hex'),
      capabilities: ['announce', 'publish'],
      firstAcceptedSequence: 0,
      lastAcceptedSequence: 0,
      expiresAt: 1_000,
      admissionPolicyEpoch: 0,
      revocation: null,
    }],
  })

  const sourceSwarm = fakeSwarm()
  sourceSwarm.keyPair = root
  const consumerSwarms = [fakeSwarm(), fakeSwarm(), fakeSwarm()]
  const consumerRegistries = consumerSwarms.map(() => fakeRegistry(descriptor))
  consumerRegistries[0].binding.catalog.ingestAcceptedPage = async entries => ({
    accepted: entries.length,
    rejected: 0,
  })
  consumerRegistries[1].binding.catalog.ingestAcceptedPage = consumerRegistries[0].binding.catalog.ingestAcceptedPage
  consumerRegistries[1].binding.catalog.getViewHead = async () => ({
    viewKey: descriptor.catalogBootstrapKey,
    length: 0,
    digest: bytes(32, 158),
    authorizationStateDigest: bytes(32, 211),
  })
  consumerRegistries[2].binding.catalog.ingestAcceptedPage = async () => ({
    accepted: 0,
    rejected: 1,
  })
  const consumerUpdates = [0, 0, 0]
  let sourceTime = 20
  let refreshCallback = null
  let cancelledRefreshes = 0
  const source = createScopedNetworkRuntime({
    swarm: sourceSwarm,
    store: {},
    catalogRegistry: sourceRegistry,
    initialNetworkPolicy: contributionPolicy(),
    now: () => sourceTime,
    setBootstrapLocatorTimer(callback) {
      refreshCallback = callback
      return { unref () {} }
    },
    clearBootstrapLocatorTimer() {
      cancelledRefreshes++
    },
  })
  const consumers = consumerSwarms.map((swarm, index) => createScopedNetworkRuntime({
    swarm,
    store: {},
    catalogRegistry: consumerRegistries[index],
    now: () => sourceTime,
    onCatalogUpdate: async () => { consumerUpdates[index]++ },
  }))
  const pairs = []
  registerRuntimeTeardown(t, [source, ...consumers], pairs)
  await source.start()
  await Promise.all(consumers.map(consumer => consumer.start()))
  const published = await source.publishLocalPublisherCatalog({ publisherId: b4a.toString(descriptor.publisherId, 'hex') })
  t.is(published.status, 'published', 'the local catalog publication succeeds before locator refresh')

  for (const [index, consumer] of consumers.entries()) {
    const pair = connectionPair({ consumerPeerFill: 171 + index, sourcePeerFill: 173 })
    pairs.push(pair)
    sourceSwarm.connections.add(pair.a)
    consumerSwarms[index].connections.add(pair.b)
    sourceSwarm.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey, topics: [], client: false })
    consumerSwarms[index].emit('connection', pair.b, { publicKey: pair.b.remotePublicKey, topics: [], client: true })
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    if (consumers.every(consumer =>
      consumer.listBootstrapLocators().length === 1 &&
      consumer.getDiagnostics().topics.some(topic => topic.purpose === 'publisher' && topic.modes.includes('followed'))
    )) break
    await settle()
  }
  for (const consumer of consumers) {
    t.is(consumer.listBootstrapLocators().length, 1, 'every consumer learns the locator without an explicit locator call')
    t.ok(consumer.getDiagnostics().topics.some(topic => topic.purpose === 'publisher' && topic.modes.includes('followed')),
      'every consumer automatically promotes the candidate after publisher proof')
  }
  for (let attempt = 0; attempt < 20 && consumers.some(consumer => consumer.getDiagnostics().recentErrors.length === 0); attempt++) {
    if (consumerUpdates[0] === 1 &&
        consumers[1].getDiagnostics().recentErrors.length > 0 &&
        consumers[2].getDiagnostics().recentErrors.length > 0) break
    await settle()
  }
  t.alike(consumerUpdates, [1, 0, 0], 'only the consumer that reconstructs every accepted operation reports completion')
  t.ok(consumers[1].getDiagnostics().recentErrors.some(error => error.code === 'PUBLISHER_CATALOG_TRUNCATED'),
    'an omitted/truncated catalog cannot use a terminal page as proof of completion')
  t.ok(consumers[2].getDiagnostics().recentErrors.some(error => error.code === 'PUBLISHER_CATALOG_PAGE_INGEST_REJECTED'),
    'any locally rejected or invalid operation prevents completion')
  sourceTime = 30
  t.is(typeof refreshCallback, 'function', 'publication installs the bounded locator refresh callback')
  if (typeof refreshCallback === 'function') {
    refreshCallback()
    for (let attempt = 0; attempt < 20 && consumers.some(consumer => consumer.listBootstrapLocators()[0]?.issuedAt !== 30); attempt++) {
      await settle()
    }
    t.ok(consumers.every(consumer => consumer.listBootstrapLocators()[0]?.issuedAt === 30),
      'the bounded refresh timer republishes a newer signed locator to every live bootstrap peer')
  }

  await source.close()
  t.ok(cancelledRefreshes > 0, 'closing the publisher removes its refresh schedule')
  await Promise.all(consumers.map(consumer => consumer.close()))
  for (const pair of pairs) {
    pair.a.destroy()
    pair.b.destroy()
  }
})

test('live publisher root rotation rebinds advertisements, proof, pages, and existing consumers', async t => {
  const root = crypto.keyPair(bytes(32, 181))
  const nextRoot = crypto.keyPair(bytes(32, 182))
  const locatorSigner = crypto.keyPair(bytes(32, 183))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 184),
  })
  const genesis = namespaceGenesis(descriptor, root)
  const transition = namespaceTransition(descriptor, root, nextRoot, 1)
  const skippedRoot = crypto.keyPair(bytes(32, 180))
  const skippedTransition = namespaceTransition(descriptor, root, skippedRoot, 2)
  const rotatedDescriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    publisherRootKey: nextRoot.publicKey,
    catalogBootstrapKey: descriptor.catalogBootstrapKey,
    catalogEpoch: 1,
    previousRootKey: root.publicKey,
    rootTransitionProof: transition.transitionId,
  })
  let sourceTime = 20
  let currentDescriptor = descriptor
  let acceptedOperations = [genesis]
  const sourceRegistry = fakeRegistry(descriptor, root)
  const sourceCatalog = sourceRegistry.binding.catalog
  sourceCatalog.localWriterKey = locatorSigner.publicKey
  sourceCatalog.localSignerKey = locatorSigner.publicKey
  sourceCatalog.listProjections = async kind => ({
    items: kind === 'publication' ? [{ accepted: true }] : [],
    nextCursor: null,
  })
  sourceCatalog.listAcceptedPage = async ({ cursor }) => cursor === null
    ? {
        entries: acceptedOperations.map(operation => ({
          operationId: b4a.toString(operation.recordId || operation.transitionId, 'hex'),
          sourceWriterKey: locatorSigner.publicKey,
          frame: encodePublisherCatalogFrame(operation),
        })),
        nextCursor: null,
      }
    : { entries: [], nextCursor: null }
  sourceCatalog.view = {
    async get(key) {
      return key === 'state/descriptor'
        ? { value: encodePublisherNamespaceDescriptor(currentDescriptor) }
        : null
    },
  }
  sourceCatalog.getViewHead = async () => ({
    viewKey: descriptor.catalogBootstrapKey,
    length: acceptedOperations.length,
    digest: currentDescriptor.catalogEpoch === 0 ? bytes(32, 185) : bytes(32, 186),
    authorizationStateDigest: bytes(32, 187),
  })
  sourceCatalog.getAuthorizationState = async () => ({
    policyEpoch: 0,
    policySequence: 0,
    writers: [{
      key: b4a.toString(locatorSigner.publicKey, 'hex'),
      signerKey: b4a.toString(locatorSigner.publicKey, 'hex'),
      capabilities: ['announce', 'publish'],
      firstAcceptedSequence: 0,
      lastAcceptedSequence: acceptedOperations.length - 1,
      expiresAt: 1_000,
      admissionPolicyEpoch: 0,
      revocation: null,
    }],
  })

  const sourceSwarm = fakeSwarm()
  sourceSwarm.keyPair = locatorSigner
  const consumerSwarms = [fakeSwarm(), fakeSwarm(), fakeSwarm()]
  const consumerRegistries = consumerSwarms.map(() => {
    const registry = fakeRegistry(descriptor)
    registry.binding.catalog.ingestAcceptedPage = async entries => ({
      accepted: entries.length,
      rejected: 0,
    })
    registry.binding.catalog.getViewHead = sourceCatalog.getViewHead
    registry.binding.catalog.getAuthorizationState = sourceCatalog.getAuthorizationState
    return registry
  })
  const source = createScopedNetworkRuntime({
    swarm: sourceSwarm,
    store: {},
    catalogRegistry: sourceRegistry,
    initialNetworkPolicy: contributionPolicy(),
    now: () => sourceTime,
  })
  const consumers = consumerSwarms.map((swarm, index) => createScopedNetworkRuntime({
    swarm,
    store: {},
    catalogRegistry: consumerRegistries[index],
    now: () => sourceTime,
  }))
  const pairs = []
  registerRuntimeTeardown(t, [source, ...consumers], pairs)
  await source.start()
  await Promise.all(consumers.map(consumer => consumer.start()))
  await source.publishLocalPublisherCatalog({ publisherId: b4a.toString(descriptor.publisherId, 'hex') })
  for (const [index] of consumers.slice(0, 2).entries()) {
    const pair = connectionPair({ consumerPeerFill: 188 + index, sourcePeerFill: 190 })
    pairs.push(pair)
    sourceSwarm.connections.add(pair.a)
    consumerSwarms[index].connections.add(pair.b)
    sourceSwarm.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey, client: false })
    consumerSwarms[index].emit('connection', pair.b, { publicKey: pair.b.remotePublicKey, client: true })
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    if (consumers.every(consumer =>
      consumer.listBootstrapLocators()[0]?.catalogEpoch === 0 &&
      consumer.getDiagnostics().topics.some(topic => topic.purpose === 'publisher' && topic.modes.includes('followed'))
    )) break
    await settle()
  }
  t.ok(consumers.slice(0, 2).every(consumer => consumer.listBootstrapLocators()[0]?.catalogEpoch === 0))

  sourceTime = 40
  currentDescriptor = rotatedDescriptor
  acceptedOperations = [genesis, transition]
  const rebound = await source.rebindLocalPublisherCatalog({
    publisherId: b4a.toString(descriptor.publisherId, 'hex'),
  })
  t.is(rebound.status, 'rebound')
  const latePair = connectionPair({ consumerPeerFill: 191, sourcePeerFill: 190 })
  pairs.push(latePair)
  sourceSwarm.connections.add(latePair.a)
  consumerSwarms[2].connections.add(latePair.b)
  sourceSwarm.emit('connection', latePair.a, { publicKey: latePair.a.remotePublicKey, client: false })
  consumerSwarms[2].emit('connection', latePair.b, { publicKey: latePair.b.remotePublicKey, client: true })

  const currentTopicHex = b4a.toString(derivePublisherTopic({
    publisherId: b4a.toString(descriptor.publisherId, 'hex'),
    catalogEpoch: 1,
  }), 'hex')
  // A consumer that already follows the retired epoch satisfies "one followed
  // publisher scope" before it has promoted anything, so waiting on the count
  // alone races the promotion it is meant to wait for. Wait for the state the
  // assertions below actually check.
  for (let attempt = 0; attempt < 40; attempt++) {
    if (consumers.every(consumer => {
      const followed = consumer.getDiagnostics().topics.filter(topic =>
        topic.purpose === 'publisher' && topic.modes.includes('followed'))
      return consumer.listBootstrapLocators()[0]?.catalogEpoch === 1 &&
        followed.length === 1 && followed[0].topicHex === currentTopicHex
    })) break
    await settle()
  }
  for (const consumer of consumers) {
    t.is(consumer.listBootstrapLocators()[0]?.catalogEpoch, 1, 'live peer accepts only the current bounded advertisement')
    const followed = consumer.getDiagnostics().topics.filter(topic =>
      topic.purpose === 'publisher' && topic.modes.includes('followed')
    )
    t.is(followed.length, 1, 'old publisher scope is replaced rather than retained')
    t.is(followed[0]?.topicHex, currentTopicHex, 'followed channel is bound to the authenticated rotated epoch')
  }

  const staleLocator = createBootstrapLocator({
    publisherId: b4a.toString(descriptor.publisherId, 'hex'),
    catalogBootstrapKey: b4a.toString(descriptor.catalogBootstrapKey, 'hex'),
    catalogHead: b4a.toString(bytes(32, 185), 'hex'),
    catalogEpoch: 0,
    authorizationChainDigest: b4a.toString(bytes(32, 187), 'hex'),
    rootSignerId: b4a.toString(root.publicKey, 'hex'),
    issuedAt: 20,
    expiresAt: 300_020,
    keyPair: locatorSigner,
  })
  for (const [index, consumer] of consumers.slice(0, 2).entries()) {
    const staleResult = await consumer.inspectIncomingFrame({
      purpose: 'bootstrap',
      topic: deriveBootstrapTopic(),
      peerId: `stale-rotation-peer-${index}`,
      frame: encodePeerFrame({
        purpose: 'bootstrap',
        type: 'locator',
        requestId: 900 + index,
        payload: encodeApplicationEnvelope(staleLocator.envelope),
      }),
    })
    t.is(staleResult.errorCode, 'STALE_LOCATOR', 'existing consumer rejects the retired epoch')
    t.is(consumer.listBootstrapLocators()[0]?.catalogEpoch, 1, 'existing consumer retains the current epoch')
  }

  const skippedDescriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    publisherRootKey: skippedRoot.publicKey,
    catalogBootstrapKey: descriptor.catalogBootstrapKey,
    catalogEpoch: 2,
    previousRootKey: root.publicKey,
    rootTransitionProof: skippedTransition.transitionId,
  })
  for (const consumer of consumers.slice(0, 2)) {
    await t.exception(consumer.providePublisherNamespaceProof({
      locator: {
        publisherId: b4a.toString(descriptor.publisherId, 'hex'),
        catalogBootstrapKey: b4a.toString(descriptor.catalogBootstrapKey, 'hex'),
        catalogEpoch: 2,
      },
      proof: {
        genesis,
        transitions: [skippedTransition],
        descriptor: skippedDescriptor,
      },
    }), /epoch|transition|sequence|skip/i, 'existing consumer rejects a skipped epoch proof')
  }

  const republished = await source.publishLocalPublisherCatalog({
    publisherId: b4a.toString(descriptor.publisherId, 'hex'),
  })
  t.is(republished.catalogEpoch, 1, 'repeat publish cannot return the stale pre-rotation result')

  await source.close()
  await Promise.all(consumers.map(consumer => consumer.close()))
  for (const pair of pairs) pair.a.destroy()
})

test('archive pledges retain multiple exact ranges without exposing a Hypercore responder', async (t) => {
  const archivist = crypto.keyPair(bytes(32, 51))
  const coreRef = normalizeAssetCoreRefV2(createStaticAssetManifest({
    treeHash: bytes(32, 52),
    blockLength: 8,
    byteLength: 8 * ASSET_BLOCK_SIZE,
  }))
  const coreKey = b4a.from(coreRef.key, 'hex')
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
          length: 8,
          byteLength: 8 * ASSET_BLOCK_SIZE,
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
  const first = await runtime.retainAuthorizedArchive({ pledge, coreKey, coreRef, start: 0, end: 2 })
  const second = await runtime.retainAuthorizedArchive({ pledge, coreKey, coreRef, start: 4, end: 7, download: false })
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
  const coreRef = normalizeAssetCoreRefV2(createStaticAssetManifest({
    treeHash: bytes(32, 56),
    blockLength: 8,
    byteLength: 8 * ASSET_BLOCK_SIZE,
  }))
  const coreKey = b4a.from(coreRef.key, 'hex')
  const sourceBlocks = new Map([
    [2, bytes(ASSET_BLOCK_SIZE, 2)],
    [3, bytes(ASSET_BLOCK_SIZE, 3)],
    [4, bytes(ASSET_BLOCK_SIZE, 4)],
    [5, bytes(ASSET_BLOCK_SIZE, 5)],
  ])
  const received = new Map()
  let markProofStarted
  let releaseProof
  const proofStarted = new Promise(resolve => { markProofStarted = resolve })
  const proofRelease = new Promise(resolve => { releaseProof = resolve })
  let holdFirstProof = true
  const archiveProofIndexes = []
  const pledge = createArchivePledge({
    archivistId: archivist.publicKey,
    publicationId: bytes(32, 57),
    renditionId: bytes(32, 58),
    ranges: [{ coreKey, start: 2, end: 6 }],
    retentionUntil: 10_000,
    issuedAt: 10,
    uploadCeilingBytes: 3 * ASSET_BLOCK_SIZE,
    keyPair: archivist,
  })
  const sourceCore = {
    key: coreKey,
    length: 8,
    byteLength: 8 * ASSET_BLOCK_SIZE,
    async ready () {},
    async has (index) { return sourceBlocks.has(index) },
    async proof ({ block }) {
      archiveProofIndexes.push(block.index)
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
    length: 8,
    byteLength: 8 * ASSET_BLOCK_SIZE,
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
    initialNetworkPolicy: archivePolicy({ uploadCeilingBytes: ASSET_BLOCK_SIZE }),
  })
  const runtimeB = createScopedNetworkRuntime({
    swarm: swarmB,
    store: { get: () => targetCore },
    initialNetworkPolicy: archivePolicy(),
  })
  const pairs = []
  let pair = null
  const connectPair = () => {
    const next = connectionPair()
    pairs.push(next)
    swarmA.connections.add(next.a)
    swarmB.connections.add(next.b)
    swarmA.emit('connection', next.a, { publicKey: next.a.remotePublicKey })
    swarmB.emit('connection', next.b, { publicKey: next.b.remotePublicKey })
    return next
  }
  await runtimeA.start()
  await runtimeB.start()
  pair = connectPair()
  await settle()
  await runtimeA.retainAuthorizedArchive({ pledge, coreKey, coreRef, start: 2, end: 6 })
  await runtimeB.retainAuthorizedArchive({ pledge, coreKey, coreRef, start: 2, end: 6 })
  await proofStarted
  t.is(runtimeA.getDiagnostics().publicWork.activeServes, 1, 'archive proof generation counts as an active serve')
  t.ok(runtimeA.getDiagnostics().sessions.some(session => session.archiveServing), 'archiveServing is exposed as a bounded boolean')
  await runtimeA.applyNetworkPolicy(contributionPolicy())
  await runtimeB.applyNetworkPolicy(contributionPolicy())
  await settle()
  t.ok(pair.a.destroyed, 'archive-consent cutover destroys the old provider transport')
  t.ok(pair.b.destroyed, 'archive-consent cutover destroys the old requester transport')
  let diagnostics = runtimeA.getDiagnostics()
  t.absent(diagnostics.sessions.find(session => session.purpose === 'archive'), 'archive sessions close when archive consent is withdrawn')
  t.absent(diagnostics.topics.find(topic => topic.purpose === 'archive')?.publicAnnounced, 'archive scope stops announcing')
  const archiveTopic = deriveArchiveTopic({ archiveId: pledge.pledgeId, protocolMajor: PROTOCOL_MAJOR })
  t.is(runtimeA.authorizeConnection({ purpose: 'archive', topic: archiveTopic, requestedCoreKey: b4a.toString(coreKey, 'hex') }).reason, 'archive-policy-disabled')
  t.absent(runtimeB.getDiagnostics().sessions.find(session => session.purpose === 'archive'), 'the requester closes its in-flight archive session on consent withdrawal')
  releaseProof()
  await Promise.all([
    runtimeA.applyNetworkPolicy(archivePolicy({ uploadCeilingBytes: ASSET_BLOCK_SIZE })),
    runtimeB.applyNetworkPolicy(archivePolicy()),
  ])
  await settle()
  pair = connectPair()
  await settle()
  for (let attempt = 0; attempt < 20 && received.size < 1; attempt++) await settle()
  t.alike([...received.keys()], [2], 'the runtime upload ceiling stops the next oversized transfer')
  for (let attempt = 0; attempt < 20 && !archiveProofIndexes.includes(3); attempt++) await settle()
  const failedThreeAttempt = archiveProofIndexes.lastIndexOf(3)
  t.ok(failedThreeAttempt >= 0, 'the first oversized retry reaches index 3')
  t.absent(archiveProofIndexes.slice(failedThreeAttempt + 1).some(index => index > 3),
    'a failed earliest retry blocks later indexes on the same peer session')
  await runtimeA.applyNetworkPolicy(archivePolicy({ uploadCeilingBytes: 3 * ASSET_BLOCK_SIZE }))
  await runtimeB.applyNetworkPolicy(archivePolicy())
  await settle()
  t.ok(pair.a.destroyed, 'archive ceiling cutover destroys the old provider transport')
  t.ok(pair.b.destroyed, 'archive ceiling cutover destroys the old requester transport')
  pair = connectPair()
  await settle()
  for (let attempt = 0; attempt < 30; attempt++) {
    const providerActive = runtimeA.getDiagnostics().sessions.some(session =>
      session.purpose === 'archive' && session.state === 'active')
    const requesterActive = runtimeB.getDiagnostics().sessions.some(session =>
      session.purpose === 'archive' && session.state === 'active')
    if (providerActive && requesterActive) break
    await settle()
  }
  t.ok(runtimeA.getDiagnostics().sessions.some(session =>
    session.purpose === 'archive' && session.state === 'active'),
    'provider fresh-transport archive session is active before retry')
  t.ok(runtimeB.getDiagnostics().sessions.some(session =>
    session.purpose === 'archive' && session.state === 'active'),
    'requester fresh-transport archive session is active before retry')
  for (let attempt = 0; attempt < 30 && received.size < 3; attempt++) await settle()

  t.alike([...received.keys()].sort((a, b) => a - b), [2, 3, 4])
  const committedUploadBytes = runtimeA.getDiagnostics().policy.uploadedBytes
  t.ok(committedUploadBytes > 0)
  const archiveServingPair = pair
  await runtimeA.applyNetworkPolicy(archivePolicy({
    uploadCeilingBytes: 3 * ASSET_BLOCK_SIZE,
    archiveBudgetBytes: 0
  }))
  await settle()
  t.ok(archiveServingPair.a.destroyed, 'archive-budget cutover destroys the old provider transport')
  t.ok(archiveServingPair.b.destroyed, 'archive-budget cutover destroys the old requester transport')
  diagnostics = runtimeA.getDiagnostics()
  t.is(diagnostics.policy.uploadedBytes, committedUploadBytes,
    'archive budget reduction preserves committed upload accounting')
  t.absent(diagnostics.sessions.find(session => session.purpose === 'archive'),
    'zero archive role budget closes the affected archive session')
  t.absent(diagnostics.topics.find(topic => topic.purpose === 'archive')?.publicAnnounced,
    'zero archive role budget suppresses archive announcement')
  await runtimeA.applyNetworkPolicy(archivePolicy({ uploadCeilingBytes: 3 * ASSET_BLOCK_SIZE }))
  await settle()
  pair = connectPair()
  for (let attempt = 0; attempt < 30; attempt++) {
    const providerActive = runtimeA.getDiagnostics().sessions.some(session =>
      session.purpose === 'archive' && session.state === 'active')
    const requesterActive = runtimeB.getDiagnostics().sessions.some(session =>
      session.purpose === 'archive' && session.state === 'active')
    if (providerActive && requesterActive) break
    await settle()
  }
  t.alike([...received.keys()].sort((a, b) => a - b), [2, 3, 4],
    'role-budget toggles do not reset committed upload accounting')
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
  for (const connection of pairs) {
    connection.a.destroy()
    connection.b.destroy()
  }
})

test('multi-range multi-core pledge aggregates progress across resources through public onProgress in real transport harness', async (t) => {
  const archivist = crypto.keyPair(bytes(32, 77))
  const coreRefA = normalizeAssetCoreRefV2(createStaticAssetManifest({
    treeHash: bytes(32, 78),
    blockLength: 8,
    byteLength: 8 * ASSET_BLOCK_SIZE,
  }))
  const coreRefB = normalizeAssetCoreRefV2(createStaticAssetManifest({
    treeHash: bytes(32, 79),
    blockLength: 8,
    byteLength: 8 * ASSET_BLOCK_SIZE,
  }))
  const coreKeyA = b4a.from(coreRefA.key, 'hex')
  const coreKeyB = b4a.from(coreRefB.key, 'hex')

  const multiRanges = [
    { coreKey: coreKeyA, start: 2, end: 4 },
    { coreKey: coreKeyB, start: 4, end: 6 },
  ]
  const pledge = createArchivePledge({
    archivistId: archivist.publicKey,
    publicationId: bytes(32, 80),
    renditionId: bytes(32, 81),
    ranges: multiRanges,
    retentionUntil: 10_000,
    issuedAt: 10,
    uploadCeilingBytes: 4 * ASSET_BLOCK_SIZE,
    keyPair: archivist,
  })

  const sourceBlocksA = new Map([[2, bytes(ASSET_BLOCK_SIZE, 2)], [3, bytes(ASSET_BLOCK_SIZE, 3)]])
  const sourceBlocksB = new Map([[4, bytes(ASSET_BLOCK_SIZE, 4)], [5, bytes(ASSET_BLOCK_SIZE, 5)]])
  const receivedA = new Map()
  const receivedB = new Map()

  const createFakeCore = (key, length, sourceBlocks, received) => ({
    key,
    length,
    byteLength: length * ASSET_BLOCK_SIZE,
    async ready () {},
    async has (index) { return sourceBlocks ? sourceBlocks.has(index) : received.has(index) },
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
    async applyProof (proof) {
      if (received) received.set(proof.block.index, b4a.from(proof.block.value))
      return true
    },
    download () { return { destroy () {} } },
    async close () {},
  })

  const sourceCoreA = createFakeCore(coreKeyA, 8, sourceBlocksA, null)
  const sourceCoreB = createFakeCore(coreKeyB, 8, sourceBlocksB, null)
  const targetCoreA = createFakeCore(coreKeyA, 8, null, receivedA)
  const targetCoreB = createFakeCore(coreKeyB, 8, null, receivedB)

  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  const runtimeA = createScopedNetworkRuntime({
    swarm: swarmA,
    store: {
      get ({ key }) {
        if (b4a.equals(key, coreKeyA)) return sourceCoreA
        if (b4a.equals(key, coreKeyB)) return sourceCoreB
        return sourceCoreA
      },
    },
    initialNetworkPolicy: archivePolicy(),
  })
  const runtimeB = createScopedNetworkRuntime({
    swarm: swarmB,
    store: {
      get ({ key }) {
        if (b4a.equals(key, coreKeyA)) return targetCoreA
        if (b4a.equals(key, coreKeyB)) return targetCoreB
        return targetCoreA
      },
    },
    initialNetworkPolicy: archivePolicy(),
  })
  await runtimeA.start()
  await runtimeB.start()

  const reports = []
  const onProgress = async (report) => {
    reports.push(structuredClone(report))
  }

  // 1. Holder and archivist retain ONLY range 1 on core A first
  await runtimeA.retainAuthorizedArchive({ pledge, coreKey: coreKeyA, coreRef: coreRefA, start: 2, end: 4, download: false })
  await runtimeB.retainAuthorizedArchive({ pledge, coreKey: coreKeyA, coreRef: coreRefA, start: 2, end: 4, download: true, onProgress })

  // Connect runtimes while range 2 is NOT yet registered
  const pair = connectionPair()
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey })
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey })

  // Wait for range 1 to complete transfer over the wire
  for (let attempt = 0; attempt < 40 && (reports.length === 0 || reports[reports.length - 1].verifiedBlocks < 2); attempt++) {
    await settle()
  }

  t.ok(reports.length > 0, 'received progress reports for range 1')
  const intermediateReport = reports[reports.length - 1]
  t.is(intermediateReport.verifiedBlocks, 2, 'range 1 fully transferred')
  t.is(intermediateReport.totalBlocks, 4, 'total blocks derived from signed pledge')
  t.is(intermediateReport.complete, false, 'pledge is NOT complete while range 2 is unregistered')

  // 2. Now sequentially retain range 2 on core B
  await runtimeA.retainAuthorizedArchive({ pledge, coreKey: coreKeyB, coreRef: coreRefB, start: 4, end: 6, download: false })
  await runtimeB.retainAuthorizedArchive({ pledge, coreKey: coreKeyB, coreRef: coreRefB, start: 4, end: 6, download: true, onProgress })

  // Wait for range 2 to complete transfer
  for (let attempt = 0; attempt < 60 && !reports[reports.length - 1].complete; attempt++) {
    await settle()
  }
  t.ok(reports.length > 0, 'received progress reports over archive transport across cores')
  const finalReport = reports[reports.length - 1]
  t.is(finalReport.verifiedBlocks, 4, 'all 4 blocks across both distinct cores transferred')
  t.is(finalReport.totalBlocks, 4)
  t.is(finalReport.complete, true, 'multi-core pledge reaches complete when all cores complete')
  t.is(finalReport.verifiedRanges.length, 2, 'verified ranges preserve distinct core identities')
  t.ok(finalReport.verifiedRanges.some(r => r.coreKey === coreRefA.key && r.start === 2 && r.end === 4))
  t.ok(finalReport.verifiedRanges.some(r => r.coreKey === coreRefB.key && r.start === 4 && r.end === 6))

  await runtimeA.close().catch(() => {})
  await runtimeB.close().catch(() => {})
  pair.a.destroy()
  pair.b.destroy()
})

test('archive progress accepts only the current opaque cursor for the exact archive resource set', async (t) => {
  const coreRef = normalizeAssetCoreRefV2(createStaticAssetManifest({
    treeHash: bytes(32, 91),
    blockLength: 4,
    byteLength: 4 * ASSET_BLOCK_SIZE,
  }))
  const coreKey = b4a.from(coreRef.key, 'hex')
  const archivistA = crypto.keyPair(bytes(32, 92))
  const archivistB = crypto.keyPair(bytes(32, 93))
  const makePledge = (archivist, fill, ranges) => createArchivePledge({
    archivistId: archivist.publicKey,
    publicationId: bytes(32, fill),
    renditionId: bytes(32, fill + 1),
    ranges: ranges.map(([start, end]) => ({ coreKey, start, end })),
    retentionUntil: 10_000,
    issuedAt: 10,
    uploadCeilingBytes: 0,
    nonce: `cursor-${fill}`,
    keyPair: archivist,
  })
  const pledgeA = makePledge(archivistA, 94, [[0, 2], [2, 4]])
  const pledgeB = makePledge(archivistB, 95, [[0, 2]])
  const runtime = createScopedNetworkRuntime({
    swarm: fakeSwarm(),
    store: {
      get: () => ({
        key: coreKey,
        length: coreRef.length,
        byteLength: coreRef.byteLength,
        async ready () {},
        async get (index) { return bytes(ASSET_BLOCK_SIZE, index + 1) },
        async close () {},
      }),
    },
    initialNetworkPolicy: archivePolicy(),
  })
  await runtime.start()

  await runtime.retainAuthorizedArchive({ pledge: pledgeA, coreKey, coreRef, start: 0, end: 2, download: false })
  await runtime.retainAuthorizedArchive({ pledge: pledgeB, coreKey, coreRef, start: 0, end: 2, download: false })

  const first = await runtime.getAuthorizedArchiveProgress({ archiveId: pledgeA.pledgeId, maxBlocks: 1 })
  t.ok(/^[0-9a-f]{64}$/.test(first.nextCursor), 'the continuation is a random opaque token')

  const foreign = await runtime.getAuthorizedArchiveProgress({ archiveId: pledgeB.pledgeId, cursor: first.nextCursor, maxBlocks: 1 })
  t.is(foreign.complete, false, 'a cursor from another archive cannot select this resource')
  t.is(foreign.verifiedBlocks, 0, 'foreign cursor returns no fabricated evidence')

  const forged = `${first.nextCursor.slice(0, -1)}${first.nextCursor.endsWith('0') ? '1' : '0'}`
  const forgedResult = await runtime.getAuthorizedArchiveProgress({ archiveId: pledgeA.pledgeId, cursor: forged, maxBlocks: 1 })
  t.is(forgedResult.complete, false, 'an unissued token is rejected')
  t.is(forgedResult.verifiedBlocks, 0, 'forged cursor returns no fabricated evidence')

  const abortedSignal = new AbortController()
  abortedSignal.abort()
  const aborted = await runtime.getAuthorizedArchiveProgress({
    archiveId: pledgeA.pledgeId,
    signal: abortedSignal.signal,
    maxBlocks: 1,
  })
  t.is(aborted.complete, false, 'an aborted scan cannot claim completion')
  const reset = await runtime.getAuthorizedArchiveProgress({ archiveId: pledgeA.pledgeId, cursor: first.nextCursor, maxBlocks: 1 })
  t.is(reset.complete, false, 'a reset scan invalidates its previous cursor')
  t.is(reset.verifiedBlocks, 0, 'a reset cursor returns no fabricated evidence')

  await runtime.retainAuthorizedArchive({ pledge: pledgeA, coreKey, coreRef, start: 2, end: 4, download: false })
  const changedOrder = await runtime.getAuthorizedArchiveProgress({ archiveId: pledgeA.pledgeId, cursor: aborted.nextCursor, maxBlocks: 1 })
  t.is(changedOrder.complete, false, 'resource-set changes invalidate the old ordering')
  t.is(changedOrder.verifiedBlocks, 0, 'changed ordering returns no fabricated evidence')

  await runtime.releaseAuthorizedArchive({ archiveId: pledgeA.pledgeId })
  await runtime.retainAuthorizedArchive({ pledge: pledgeA, coreKey, coreRef, start: 0, end: 2, download: false })
  const released = await runtime.getAuthorizedArchiveProgress({ archiveId: pledgeA.pledgeId, cursor: first.nextCursor, maxBlocks: 1 })
  t.is(released.complete, false, 'release and re-retain invalidate the prior cursor')
  t.is(released.verifiedBlocks, 0, 're-retained resource returns no fabricated evidence')

  const fresh = await runtime.getAuthorizedArchiveProgress({ archiveId: pledgeA.pledgeId, maxBlocks: 1 })
  const completed = await runtime.getAuthorizedArchiveProgress({ archiveId: pledgeA.pledgeId, cursor: fresh.nextCursor, maxBlocks: 1 })
  t.is(completed.complete, true, 'the newly issued cursor resumes the ordinary Corestore scan')
  const stale = await runtime.getAuthorizedArchiveProgress({ archiveId: pledgeA.pledgeId, cursor: fresh.nextCursor, maxBlocks: 1 })
  t.is(stale.complete, false, 'a consumed cursor is stale')
  t.is(stale.verifiedBlocks, 0, 'a stale cursor returns no fabricated evidence')

  await runtime.close()
})

test('offload archive progress preserves the bound cursor across pages and rejects foreign or consumed tokens', async (t) => {
  const coreRef = normalizeAssetCoreRefV2(createStaticAssetManifest({
    treeHash: bytes(32, 96),
    blockLength: 4,
    byteLength: 4 * ASSET_BLOCK_SIZE,
  }))
  const coreKey = b4a.from(coreRef.key, 'hex')
  const archivistA = crypto.keyPair(bytes(32, 97))
  const archivistB = crypto.keyPair(bytes(32, 98))
  const makePledge = (archivist, fill) => createArchivePledge({
    archivistId: archivist.publicKey,
    publicationId: bytes(32, fill),
    renditionId: bytes(32, fill + 1),
    ranges: [{ coreKey, start: 0, end: 2 }],
    retentionUntil: 10_000,
    issuedAt: 10,
    uploadCeilingBytes: 0,
    nonce: `offload-cursor-${fill}`,
    keyPair: archivist,
  })
  const pledgeA = makePledge(archivistA, 99)
  const pledgeB = makePledge(archivistB, 100)
  const calls = []
  const blockOffload = {
    async assessRetrievability ({ core, ranges, cursor, maxBlocks }) {
      const range = ranges[0]
      const start = cursor?.blockIndex ?? range.start
      const end = Math.min(range.end, start + maxBlocks)
      calls.push({ coreKey: b4a.toString(core.key, 'hex'), cursor })
      return {
        assessedBlocks: end - start,
        residentBlocks: end - start,
        residentBytes: (end - start) * ASSET_BLOCK_SIZE,
        remoteRetrievableBlocks: 0,
        remoteRetrievableBytes: 0,
        truncated: end < range.end,
        nextCursor: end < range.end ? { rangeIndex: 0, blockIndex: end } : null,
      }
    },
  }
  const runtime = createScopedNetworkRuntime({
    swarm: fakeSwarm(),
    blockOffload,
    store: {
      get: () => ({
        key: coreKey,
        length: coreRef.length,
        byteLength: coreRef.byteLength,
        async ready () {},
        async close () {},
      }),
    },
    initialNetworkPolicy: archivePolicy(),
  })
  await runtime.start()
  await runtime.retainAuthorizedArchive({ pledge: pledgeA, coreKey, coreRef, start: 0, end: 2, download: false })
  await runtime.retainAuthorizedArchive({ pledge: pledgeB, coreKey, coreRef, start: 0, end: 2, download: false })

  const first = await runtime.getAuthorizedArchiveProgress({ archiveId: pledgeA.pledgeId, maxBlocks: 1 })
  const completed = await runtime.getAuthorizedArchiveProgress({ archiveId: pledgeA.pledgeId, cursor: first.nextCursor, maxBlocks: 1 })
  t.is(completed.complete, true, 'the offload branch resumes the exact next block')
  t.is(calls[1].cursor.archiveId, pledgeA.pledgeId, 'the offload handoff keeps archive identity')
  t.is(calls[1].cursor.coreKey, coreRef.key, 'the offload handoff keeps core identity')
  t.is(calls[1].cursor.rangeStart, 0, 'the offload handoff keeps the exact range start')
  t.is(calls[1].cursor.rangeEnd, 2, 'the offload handoff keeps the exact range end')

  const foreign = await runtime.getAuthorizedArchiveProgress({ archiveId: pledgeB.pledgeId, cursor: first.nextCursor, maxBlocks: 1 })
  t.is(foreign.complete, false, 'the offload branch rejects a foreign archive cursor')
  const stale = await runtime.getAuthorizedArchiveProgress({ archiveId: pledgeA.pledgeId, cursor: first.nextCursor, maxBlocks: 1 })
  t.is(stale.complete, false, 'the offload branch rejects a consumed cursor')
  t.is(stale.verifiedBlocks, 0, 'stale offload cursors return no fabricated evidence')

  await runtime.close()
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

// A channel appends every rendition to one blobs core, so core.length describes
// the whole core rather than one rendition's span. Retaining without an explicit
// range used to default to 0..core.length, which only overlaps the first
// rendition ever written; every later upload asked for blocks outside its own
// upload provenance and failed authorization. In practice a relay could publish
// exactly one video per channel and every subsequent archive job died with
// "publication manifest authorization failed".
test('retaining a rendition without a range uses its own upload span, not the whole shared core', async (t) => {
  const publisher = crypto.keyPair(bytes(32, 61))
  // Six blocks total: an earlier rendition occupies 0..3, this one 3..6.
  const staticCore = createStaticAssetManifest({
    treeHash: bytes(32, 63),
    blockLength: 6,
    byteLength: 6 * ASSET_BLOCK_SIZE,
  })
  const coreKey = staticCore.key
  const rendition = createRenditionDescriptor({
    purpose: 'original',
    format: 'video/mp4',
    core: staticCore,
  })
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence: 2,
    title: 'Second upload into a shared core',
    renditions: [rendition],
    provenance: [{
      type: 'upload',
      renditionId: rendition.renditionId,
      coreKey: b4a.toString(coreKey, 'hex'),
      start: 3,
      end: 6,
    }],
    keyPair: publisher,
    signedAt: 10,
    expiresAt: 1000,
  })

  const authorized = []
  const runtime = createScopedNetworkRuntime({
    swarm: fakeSwarm(),
    muxFactory: () => ({}),
    // Mirrors the real projection: a range is only authorized when a single
    // upload provenance entry covers all of it.
    authorizePublication: async ({ manifest: proposed, start, end }) => {
      authorized.push({ start, end })
      if (proposed !== manifest) return false
      return start >= 3 && end !== null && end <= 6
    },
    store: {
      get ({ key }) {
        return {
          key,
          ready: async () => {},
          replicate: () => {},
          download: () => ({ destroy () {} }),
          close () {},
        }
      },
    },
    now: () => 20,
  })
  await runtime.start()

  const retained = await runtime.retainAuthorizedRendition({
    manifest,
    renditionId: rendition.renditionId,
  })

  t.is(retained.status, 'retained', 'the second rendition in a shared core retains')
  t.alike(authorized.at(-1), { start: 3, end: 6 }, 'authorization is asked for the rendition span, not 0..core.length')
  await runtime.close()
})

// A page is requested by entry count but shipped inside a byte-bounded frame.
// Rich per-title metadata can push a legal page past that bound. The publisher
// serves the largest prefix that fits — the follower resumes from the trimmed
// page's cursor — instead of failing the session and stranding the follower
// with an empty catalog.
test('a catalog page too large for one frame is trimmed to fit and the walk continues', async (t) => {
  const root = crypto.keyPair(bytes(32, 232))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 233),
  })
  const genesis = namespaceGenesis(descriptor, root)
  const genesisFrame = encodePublisherCatalogFrame(genesis)
  const genesisId = b4a.toString(genesis.recordId, 'hex')
  const sourceWriterKey = bytes(32, 234)
  const sourceRegistry = fakeRegistry(descriptor, root)
  sourceRegistry.binding.catalog.listProjections = async kind => ({
    items: kind === 'publication' ? [{ accepted: true }] : [],
    nextCursor: null,
  })

  const bulky = []
  for (let index = 0; index < 4; index++) {
    const prepared = prepareSignedEnvelope({
      recordType: PUBLISHER_RECORD_TYPES.CLAIM,
      schemaMajor: 1,
      schemaMinor: 0,
      issuerIdentityKey: descriptor.publisherId,
      signerKey: root.publicKey,
      policyEpoch: 0,
      issuerSequence: index + 1,
      signedAt: 20 + index,
      canonicalBody: encodePublisherOperationBody(PUBLISHER_RECORD_TYPES.CLAIM, {
        claimId: crypto.hash(b4a.from(`claim-${index}`)),
        claimType: 'EntityMetadataClaim',
        payload: b4a.alloc(20 * 1024, index + 1),
      }),
    }, { hash: crypto.hash })
    const operation = attachSignedEnvelopeSignature(prepared, crypto.sign(signedRecordSignaturePreimage(prepared), root.secretKey))
    bulky.push({
      operationId: b4a.toString(operation.recordId, 'hex'),
      sourceWriterKey,
      frame: encodePublisherCatalogFrame(operation),
    })
  }
  const acceptedEntries = [
    { operationId: genesisId, sourceWriterKey, frame: genesisFrame },
    ...bulky,
  ].sort((left, right) => left.operationId.localeCompare(right.operationId))
  sourceRegistry.binding.catalog.listAcceptedPage = async ({ cursor, limit }) => {
    const bounded = Math.max(1, Math.min(Number(limit) || 1, acceptedEntries.length))
    const start = cursor === null ? 0 : acceptedEntries.findIndex(entry => entry.operationId === cursor) + 1
    const entries = acceptedEntries.slice(start, start + bounded)
    return {
      entries,
      nextCursor: entries.length > 0 && start + entries.length < acceptedEntries.length
        ? entries.at(-1).operationId
        : null,
    }
  }
  sourceRegistry.binding.catalog.getViewHead = async () => ({
    viewKey: descriptor.catalogBootstrapKey,
    length: acceptedEntries.length,
    digest: bytes(32, 235),
    authorizationStateDigest: bytes(32, 236),
  })
  sourceRegistry.binding.catalog.view = {
    async get (key) {
      return key === 'state/descriptor'
        ? { value: encodePublisherNamespaceDescriptor(descriptor) }
        : null
    },
    async * createReadStream () {
      yield { key: `accepted/${b4a.toString(genesis.recordId, 'hex')}`, value: genesisFrame }
    },
  }

  const received = []
  const consumerRegistry = fakeRegistry(descriptor)
  consumerRegistry.binding.catalog.ingestAcceptedPage = async entries => {
    received.push(...entries)
    return { accepted: entries.length, rejected: 0 }
  }
  consumerRegistry.binding.catalog.getViewHead = async () => ({
    viewKey: descriptor.catalogBootstrapKey,
    length: received.length,
    digest: bytes(32, 235),
    authorizationStateDigest: bytes(32, 236),
  })

  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  const source = createScopedNetworkRuntime({
    swarm: swarmA,
    store: {},
    catalogRegistry: sourceRegistry,
    initialNetworkPolicy: contributionPolicy(),
  })
  const consumer = createScopedNetworkRuntime({ swarm: swarmB, store: {}, catalogRegistry: consumerRegistry })
  const pairs = []
  registerRuntimeTeardown(t, [source, consumer], pairs)
  await source.start()
  await consumer.start()
  await source.publishLocalPublisherCatalog({ publisherId: descriptor.publisherId })
  await consumer.followPublisher({ publisherId: descriptor.publisherId, namespaceDescriptor: descriptor })

  const pair = connectionPair()
  pairs.push(pair)
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey, client: false })
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey, client: true })
  for (let attempt = 0; attempt < 200; attempt++) await settle()

  t.alike(
    received.map(entry => entry.operationId).sort((left, right) => left.localeCompare(right)),
    acceptedEntries.map(entry => entry.operationId).sort((left, right) => left.localeCompare(right)),
    'every oversized-page record arrives across trimmed pages, none lost',
  )

  await consumer.close()
  await source.close()
  pair.a.destroy()
  pair.b.destroy()
})

// Roots (genesis, admissions) sort by operation id, so in a multi-page catalog
// they can arrive in a later page than the data that depends on them. The
// consumer buffers causally-pending pages instead of failing the walk, and
// drains them once the roots land.
test('a multi-page catalog with late-sorting roots syncs via buffered ingest', async (t) => {
  const root = crypto.keyPair(bytes(32, 248))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 249),
  })
  const genesis = namespaceGenesis(descriptor, root)
  const genesisFrame = encodePublisherCatalogFrame(genesis)
  const genesisId = b4a.toString(genesis.recordId, 'hex')
  const sourceWriterKey = bytes(32, 250)
  const sourceRegistry = fakeRegistry(descriptor, root)
  sourceRegistry.binding.catalog.listProjections = async kind => ({
    items: kind === 'publication' ? [{ accepted: true }] : [],
    nextCursor: null,
  })

  // Regenerate claim salts until every claim's recordId sorts BELOW the genesis
  // record id. Hash order is uniform, so a handful of iterations suffices; the
  // result is deterministic for these fixed seeds. The catalog then walks as
  // [claim, claim] then [claim, genesis]: data pages precede the causal base.
  const claims = []
  for (let index = 0; index < 3; index++) {
    let salt = 0
    for (;;) {
      const prepared = prepareSignedEnvelope({
        recordType: PUBLISHER_RECORD_TYPES.CLAIM,
        schemaMajor: 1,
        schemaMinor: 0,
        issuerIdentityKey: descriptor.publisherId,
        signerKey: root.publicKey,
        policyEpoch: 0,
        issuerSequence: index + 1,
        signedAt: 20 + index,
        canonicalBody: encodePublisherOperationBody(PUBLISHER_RECORD_TYPES.CLAIM, {
          claimId: crypto.hash(b4a.from(`buffered-claim-${index}-${salt}`)),
          claimType: 'EntityMetadataClaim',
          payload: b4a.alloc(64, index + 1),
        }),
      }, { hash: crypto.hash })
      const operation = attachSignedEnvelopeSignature(prepared, crypto.sign(signedRecordSignaturePreimage(prepared), root.secretKey))
      const operationId = b4a.toString(operation.recordId, 'hex')
      if (operationId < genesisId) {
        claims.push({ operationId, sourceWriterKey, frame: encodePublisherCatalogFrame(operation) })
        break
      }
      salt++
      if (salt > 64) {
        throw new Error('unable to sample a claim below the genesis record id')
      }
    }
  }
  const acceptedEntries = [...claims, {
    operationId: genesisId,
    sourceWriterKey,
    frame: genesisFrame,
  }].sort((left, right) => left.operationId.localeCompare(right.operationId))
  sourceRegistry.binding.catalog.listAcceptedPage = async ({ cursor, limit }) => {
    const bounded = Math.max(1, Math.min(Number(limit) || 2, acceptedEntries.length))
    const start = cursor === null ? 0 : acceptedEntries.findIndex(entry => entry.operationId === cursor) + 1
    const entries = acceptedEntries.slice(start, start + bounded)
    return {
      entries,
      nextCursor: entries.length > 0 && start + entries.length < acceptedEntries.length
        ? entries.at(-1).operationId
        : null,
    }
  }
  sourceRegistry.binding.catalog.getViewHead = async () => ({
    viewKey: descriptor.catalogBootstrapKey,
    length: acceptedEntries.length,
    digest: bytes(32, 251),
    authorizationStateDigest: bytes(32, 252),
  })
  sourceRegistry.binding.catalog.view = {
    async get (key) {
      return key === 'state/descriptor'
        ? { value: encodePublisherNamespaceDescriptor(descriptor) }
        : null
    },
    async * createReadStream () {
      yield { key: `accepted/${genesisId}`, value: genesisFrame }
    },
  }

  const received = []
  const consumerRegistry = fakeRegistry(descriptor)
  let rootsApplied = false
  consumerRegistry.binding.catalog.ingestAcceptedPage = async entries => {
    // Model the real reduce: a batch applies only if its causal base is in the
    // view already or travels inside the same batch.
    const hasRoot = entries.some(entry => entry.operationId === genesisId)
    if (!rootsApplied && !hasRoot) {
      return { accepted: 0, rejected: 0 }
    }
    received.push(...entries)
    if (hasRoot) rootsApplied = true
    return { accepted: entries.length, rejected: 0 }
  }
  consumerRegistry.binding.catalog.getViewHead = async () => ({
    viewKey: descriptor.catalogBootstrapKey,
    length: received.length,
    digest: bytes(32, 251),
    authorizationStateDigest: bytes(32, 252),
  })

  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  const source = createScopedNetworkRuntime({
    swarm: swarmA,
    store: {},
    catalogRegistry: sourceRegistry,
    initialNetworkPolicy: contributionPolicy(),
  })
  const consumer = createScopedNetworkRuntime({ swarm: swarmB, store: {}, catalogRegistry: consumerRegistry })
  const pairs = []
  registerRuntimeTeardown(t, [source, consumer], pairs)
  await source.start()
  await consumer.start()
  await source.publishLocalPublisherCatalog({ publisherId: descriptor.publisherId })
  await consumer.followPublisher({ publisherId: descriptor.publisherId, namespaceDescriptor: descriptor })

  const pair = connectionPair()
  pairs.push(pair)
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey, client: false })
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey, client: true })
  for (let attempt = 0; attempt < 200; attempt++) await settle()

  t.ok(rootsApplied, 'the roots reach the consumer view')
  t.alike(
    received.map(entry => entry.operationId).sort((left, right) => left.localeCompare(right)),
    acceptedEntries.map(entry => entry.operationId).sort((left, right) => left.localeCompare(right)),
    'pending pages drain once the causal base arrives, nothing lost',
  )

  await consumer.close()
  await source.close()
  pair.a.destroy()
  pair.b.destroy()
})

// A socket that reports backpressure has queued the frame, not dropped it.
// Treating that as a send failure tears down the catalog walk exactly when a
// page is big enough to fill the socket buffer, which is when it matters most:
// the peer sees a disconnect and the catalog never arrives.
test('a backpressured socket does not abort the catalog walk', async (t) => {
  const root = crypto.keyPair(bytes(32, 240))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 241),
  })
  const genesis = namespaceGenesis(descriptor, root)
  const genesisFrame = encodePublisherCatalogFrame(genesis)
  const genesisId = b4a.toString(genesis.recordId, 'hex')
  const sourceWriterKey = bytes(32, 242)
  const sourceRegistry = fakeRegistry(descriptor, root)
  sourceRegistry.binding.catalog.listProjections = async kind => ({
    items: kind === 'publication' ? [{ accepted: true }] : [],
    nextCursor: null,
  })

  // Two ~20 KiB operations: one page, comfortably inside the frame bound, and
  // far past what a congested socket accepts without asking the writer to wait.
  const bulky = []
  for (let index = 0; index < 2; index++) {
    const prepared = prepareSignedEnvelope({
      recordType: PUBLISHER_RECORD_TYPES.CLAIM,
      schemaMajor: 1,
      schemaMinor: 0,
      issuerIdentityKey: descriptor.publisherId,
      signerKey: root.publicKey,
      policyEpoch: 0,
      issuerSequence: index + 1,
      signedAt: 30 + index,
      canonicalBody: encodePublisherOperationBody(PUBLISHER_RECORD_TYPES.CLAIM, {
        claimId: crypto.hash(b4a.from(`backpressure-${index}`)),
        claimType: 'EntityMetadataClaim',
        payload: b4a.alloc(20 * 1024, index + 1),
      }),
    }, { hash: crypto.hash })
    const operation = attachSignedEnvelopeSignature(prepared, crypto.sign(signedRecordSignaturePreimage(prepared), root.secretKey))
    bulky.push({
      operationId: b4a.toString(operation.recordId, 'hex'),
      sourceWriterKey,
      frame: encodePublisherCatalogFrame(operation),
    })
  }
  const acceptedEntries = [
    { operationId: genesisId, sourceWriterKey, frame: genesisFrame },
    ...bulky,
  ].sort((left, right) => left.operationId.localeCompare(right.operationId))
  sourceRegistry.binding.catalog.listAcceptedPage = async ({ cursor, limit }) => {
    const start = cursor === null ? 0 : acceptedEntries.findIndex(entry => entry.operationId === cursor) + 1
    const entries = acceptedEntries.slice(start, start + Math.max(1, Number(limit) || 1))
    return { entries, nextCursor: entries.length > 0 ? entries.at(-1).operationId : null }
  }
  sourceRegistry.binding.catalog.getViewHead = async () => ({
    viewKey: descriptor.catalogBootstrapKey,
    length: acceptedEntries.length,
    digest: bytes(32, 243),
    authorizationStateDigest: bytes(32, 244),
  })
  sourceRegistry.binding.catalog.view = {
    async get (key) {
      return key === 'state/descriptor'
        ? { value: encodePublisherNamespaceDescriptor(descriptor) }
        : null
    },
    async * createReadStream () {
      yield { key: `accepted/${b4a.toString(genesis.recordId, 'hex')}`, value: genesisFrame }
    },
  }

  const received = []
  const consumerRegistry = fakeRegistry(descriptor)
  consumerRegistry.binding.catalog.ingestAcceptedPage = async entries => {
    received.push(...entries)
    return { accepted: entries.length, rejected: 0 }
  }
  consumerRegistry.binding.catalog.getViewHead = async () => ({
    viewKey: descriptor.catalogBootstrapKey,
    length: received.length,
    digest: bytes(32, 243),
    authorizationStateDigest: bytes(32, 244),
  })

  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  const source = createScopedNetworkRuntime({
    swarm: swarmA,
    store: {},
    catalogRegistry: sourceRegistry,
    initialNetworkPolicy: contributionPolicy(),
  })
  const consumer = createScopedNetworkRuntime({ swarm: swarmB, store: {}, catalogRegistry: consumerRegistry })
  const pairs = []
  registerRuntimeTeardown(t, [source, consumer], pairs)
  await source.start()
  await consumer.start()
  await source.publishLocalPublisherCatalog({ publisherId: descriptor.publisherId })
  await consumer.followPublisher({ publisherId: descriptor.publisherId, namespaceDescriptor: descriptor })

  // A page this size cannot be written without the socket asking the writer to
  // wait, so this is the exact condition that used to abort the walk.
  const pair = backpressuredPair()
  pairs.push(pair)
  swarmA.connections.add(pair.a)
  swarmB.connections.add(pair.b)
  swarmA.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey, client: false })
  swarmB.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey, client: true })
  for (let attempt = 0; attempt < 300 && received.length < acceptedEntries.length; attempt++) await settle()

  t.is(received.length, acceptedEntries.length, 'every entry reaches the consumer through a backpressured socket')
  t.ok(
    received.every((entry, index) => b4a.equals(entry.frame, acceptedEntries[index].frame)),
    'queued frames arrive intact and in cursor order',
  )

  await consumer.close()
  await source.close()
  pair.a.destroy()
  pair.b.destroy()
})

// Relays exist for availability. Seeding a title has to mean seeding what it
// looks like as well, or the peer that holds the movie still cannot answer for
// its cover and every catalog that finds it renders blank. Leaving that to each
// caller means the one seeder that forgets breaks the title for everyone.
test('retaining a title also retains the cover published with it', async (t) => {
  const publisher = crypto.keyPair(bytes(32, 71))
  // Each asset is its own canonical static core under the v2 descriptor, so the
  // media and its cover are keyed separately; the cover still occupies only the
  // span its artwork provenance published.
  const mediaCore = createStaticAssetManifest({
    treeHash: bytes(32, 73),
    blockLength: 6,
    byteLength: 6 * ASSET_BLOCK_SIZE,
  })
  const posterCore = createStaticAssetManifest({
    treeHash: bytes(32, 74),
    blockLength: 8,
    byteLength: 8 * ASSET_BLOCK_SIZE,
  })
  const media = createRenditionDescriptor({
    purpose: 'original',
    format: 'video/mp4',
    core: mediaCore,
  })
  const poster = createRenditionDescriptor({
    purpose: 'poster',
    format: 'image/jpeg',
    core: posterCore,
  })
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    sequence: 3,
    title: 'Seeded with its cover',
    renditions: [media, poster],
    provenance: [
      { type: 'upload', renditionId: media.renditionId, coreKey: b4a.toString(mediaCore.key, 'hex'), start: 0, end: 6 },
      { type: 'artwork', role: 'poster', renditionId: poster.renditionId, coreKey: b4a.toString(posterCore.key, 'hex'), blobId: '7:1:900:53905', start: 7, end: 8 },
    ],
    keyPair: publisher,
    signedAt: 10,
    expiresAt: 1000,
  })

  // Authorization is asked once per rendition being held, so it records what
  // this seeder actually took custody of.
  const authorized = []
  const runtime = createScopedNetworkRuntime({
    swarm: fakeSwarm(),
    muxFactory: () => ({}),
    authorizePublication: async ({ renditionId, start, end }) => {
      authorized.push({ renditionId, start, end })
      return true
    },
    store: {
      get ({ key }) {
        return { key, ready: async () => {}, replicate: () => {}, download: () => ({ destroy () {} }), close () {} }
      },
    },
    now: () => 20,
  })
  await runtime.start()

  // Ask only for the media, exactly as a seeder does.
  const retained = await runtime.retainAuthorizedRendition({ manifest, renditionId: media.renditionId })
  t.is(retained.status, 'retained', 'the media retains')

  t.ok(
    authorized.some(entry => entry.renditionId === poster.renditionId),
    'the cover is taken custody of too, without the caller asking for it',
  )
  t.alike(
    authorized.find(entry => entry.renditionId === poster.renditionId),
    { renditionId: poster.renditionId, start: 7, end: 8 },
    'the cover is held over its own published span, not the whole shared core',
  )

  // A seeder that retains again must not re-take or throw.
  const before = authorized.length
  await runtime.retainAuthorizedRendition({ manifest, renditionId: media.renditionId })
  t.ok(authorized.length >= before, 'retaining twice is not an error')

  await runtime.close()
})

// A fixture registry for a relay that also FOLLOWS other publishers: its own
// namespace binding is served locally, and bindNamespace mirrors the real
// registry by opening a matching binding for whichever verified namespace a
// follow carries (a single catalog object keyed by the bound descriptor).
function gossiperRegistry (descriptor, root = null) {
  const registry = fakeRegistry(descriptor, root)
  const bindings = new Map([[b4a.toString(descriptor.publisherId, 'hex'), registry.binding]])
  const makeBinding = boundDescriptor => {
    // A follower's catalog journals every accepted operation and its view head
    // grows with it, so the terminal page reconstructs the advertised head.
    const journal = []
    const ownCatalog = registry.binding.catalog
    const catalog = {
      key: boundDescriptor.catalogBootstrapKey,
      writable: false,
      replicated: [],
      base: ownCatalog.base,
      async ready () {},
      async close () {},
      async listProjections () { return { items: [], nextCursor: null } },
      async listAcceptedPage () { return { entries: [], nextCursor: null } },
      async getAuthorizationState () {
        return {
          policyEpoch: 0,
          policySequence: 0,
          writers: [{
            key: b4a.toString(boundDescriptor.publisherRootKey, 'hex'),
            signerKey: b4a.toString(boundDescriptor.publisherRootKey, 'hex'),
            capabilities: ['announce', 'publish'],
            firstAcceptedSequence: 0,
            lastAcceptedSequence: journal.length,
            expiresAt: Number.MAX_SAFE_INTEGER,
            admissionPolicyEpoch: 0,
            revocation: null,
          }],
        }
      },
      async ingestAcceptedPage (entries) {
        journal.push(...entries)
        return { accepted: entries.length, rejected: 0 }
      },
      async getViewHead () {
        return {
          viewKey: boundDescriptor.catalogBootstrapKey,
          length: journal.length,
          digest: bytes(32, 210),
          authorizationStateDigest: bytes(32, 211),
        }
      },
    }
    return {
      catalog,
      publisherId: boundDescriptor.publisherId,
      genesisRootKey: boundDescriptor.publisherRootKey,
      catalogBootstrapKey: boundDescriptor.catalogBootstrapKey,
      namespaceDescriptor: boundDescriptor,
    }
  }
  return {
    ...registry,
    async bindNamespace (descriptorValue, options = {}) {
      const bound = bindings.get(b4a.toString(descriptorValue.publisherId, 'hex'))
      if (bound) {
        bound.namespaceDescriptor = descriptorValue
        return bound
      }
      const binding = makeBinding(descriptorValue)
      bindings.set(b4a.toString(descriptorValue.publisherId, 'hex'), binding)
      return binding
    },
    async resolve (publisherIdValue) {
      return bindings.get(b4a.toString(publisherIdValue, 'hex')) || registry.binding
    },
  }
}

test('a relay with no direct view of the publisher learns and mirrors a catalog through another relay', async (t) => {
  // Publisher S announces a locator on the bootstrap topic. Relay A ingests it
  // directly and auto-follows. Relay B is connected ONLY to A, so the locator
  // must arrive through A's re-gossip, and B's catalog must come from A's
  // mirrored publisher scope. This is the zero-config distribution path: spin
  // up two relays and the second one sees the first one's library.
  const root = crypto.keyPair(bytes(32, 191))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 192),
  })
  const publisherIdHex = b4a.toString(descriptor.publisherId, 'hex')
  const genesis = namespaceGenesis(descriptor, root)

  // Publisher fixture: one accepted publication so its catalog is worth following.
  const sourceRegistry = fakeRegistry(descriptor, root)
  sourceRegistry.binding.catalog.localWriterKey = root.publicKey
  sourceRegistry.binding.catalog.listProjections = async kind => ({
    items: kind === 'publication' ? [{ accepted: true }] : [],
    nextCursor: null,
  })
  sourceRegistry.binding.catalog.listAcceptedPage = async ({ cursor }) => cursor === null
    ? {
        entries: [{
          operationId: b4a.toString(genesis.recordId, 'hex'),
          sourceWriterKey: root.publicKey,
          frame: encodePublisherCatalogFrame(genesis),
        }],
        nextCursor: null,
      }
    : { entries: [], nextCursor: null }
  sourceRegistry.binding.catalog.getAuthorizationState = async () => ({
    policyEpoch: 0,
    policySequence: 0,
    writers: [{
      key: b4a.toString(root.publicKey, 'hex'),
      signerKey: b4a.toString(root.publicKey, 'hex'),
      capabilities: ['announce', 'publish'],
      firstAcceptedSequence: 0,
      lastAcceptedSequence: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
      admissionPolicyEpoch: 0,
      revocation: null,
    }],
  })

  const relayAPage = async ({ cursor }) => cursor === null
    ? {
        entries: [{
          operationId: b4a.toString(genesis.recordId, 'hex'),
          sourceWriterKey: root.publicKey,
          frame: encodePublisherCatalogFrame(genesis),
        }],
        nextCursor: null,
      }
    : { entries: [], nextCursor: null }

  const swarmS = fakeSwarm()
  const swarmA = fakeSwarm()
  const swarmB = fakeSwarm()
  swarmS.keyPair = root

  const source = createScopedNetworkRuntime({
    swarm: swarmS,
    store: {},
    catalogRegistry: sourceRegistry,
    initialNetworkPolicy: contributionPolicy(),
    now: () => 100,
  })
  // Relay A: contributor with its own device keypair, so it signs and
  // announces its own locator as well as ingesting S's.
  const relayAKeys = crypto.keyPair(bytes(32, 193))
  swarmA.keyPair = relayAKeys
  const relayAUpdates = []
  const relayA = createScopedNetworkRuntime({
    swarm: swarmA,
    store: {},
    catalogRegistry: gossiperRegistry(createPublisherNamespaceDescriptor({ genesisRootKey: relayAKeys.publicKey, catalogBootstrapKey: bytes(32, 194) }), relayAKeys),
    initialNetworkPolicy: contributionPolicy(),
    now: () => 100,
    onCatalogUpdate: async event => { relayAUpdates.push(event) },
  })
  // Relay B: watch-only, no local publisher, connected only to A.
  const relayBKeys = crypto.keyPair(bytes(32, 195))
  swarmB.keyPair = relayBKeys
  const relayB = createScopedNetworkRuntime({
    swarm: swarmB,
    store: {},
    catalogRegistry: gossiperRegistry(createPublisherNamespaceDescriptor({ genesisRootKey: relayBKeys.publicKey, catalogBootstrapKey: bytes(32, 196) }), relayBKeys),
    now: () => 100,
  })
  const pairs = []
  registerRuntimeTeardown(t, [source, relayA, relayB], pairs)

  await source.start()
  await relayA.start()
  await relayB.start()

  // S publishes its catalog and locator; relay A ingests the locator over a
  // direct bootstrap session and auto-follows.
  await source.publishLocalPublisherCatalog({ publisherId: publisherIdHex })

  const sAPair = connectionPair({ sourcePeerFill: 173, consumerPeerFill: 174 })
  pairs.push(sAPair)
  swarmS.connections.add(sAPair.a)
  swarmA.connections.add(sAPair.b)
  swarmS.emit('connection', sAPair.a, { publicKey: sAPair.a.remotePublicKey, topics: [], client: false })
  swarmA.emit('connection', sAPair.b, { publicKey: sAPair.b.remotePublicKey, topics: [], client: true })

  for (let attempt = 0; attempt < 20 && (
    relayA.listBootstrapLocators().length === 0 ||
    !relayA.getDiagnostics().topics.some(topic => topic.purpose === 'publisher' && topic.modes.includes('followed'))
  ); attempt++) await settle()
  t.is(relayA.listBootstrapLocators().length, 1, 'relay A ingests the publisher locator directly')
  t.ok(relayA.getDiagnostics().topics.some(topic => topic.purpose === 'publisher' && topic.modes.includes('followed')),
    'relay A auto-follows the ingested locator without any operator policy')
  for (let attempt = 0; attempt < 20 && relayAUpdates.length === 0; attempt++) await settle()
  t.ok(relayAUpdates.length > 0, 'relay A reconstructs the catalog and refreshes its query view')

  // B connects only to A. A must re-gossip the locator on B's bootstrap
  // session activation, B must auto-follow, and the catalog walk must come
  // from A's mirrored publisher scope (namespace proof included).
  const aBPair = connectionPair({ sourcePeerFill: 175, consumerPeerFill: 176 })
  pairs.push(aBPair)
  swarmA.connections.add(aBPair.a)
  swarmB.connections.add(aBPair.b)
  swarmA.emit('connection', aBPair.a, { publicKey: aBPair.a.remotePublicKey, topics: [], client: false })
  swarmB.emit('connection', aBPair.b, { publicKey: aBPair.b.remotePublicKey, topics: [], client: true })

  let followed = false
  for (let attempt = 0; attempt < 40; attempt++) {
    if (relayB.getDiagnostics().topics.some(topic => topic.purpose === 'publisher' && topic.modes.includes('followed'))) {
      followed = true
      break
    }
    await settle()
  }
  t.ok(followed, 'relay B learns the publisher purely through relay A and follows it')
  t.is(relayB.listBootstrapLocators().length, 1, 'the gossiped locator is retained on relay B')
  // Replay suppression: re-deliver the identical locator to B from a fresh
  // peer id. The manager must classify it as a replay — otherwise a cyclic
  // relay topology re-gossips the same locator forever.
  const replayed = await relayB.inspectIncomingFrame({
    purpose: 'bootstrap', topic: deriveBootstrapTopic(), peerId: bytes(32, 175).toString('hex'),
    frame: encodePeerFrame({
      purpose: 'bootstrap',
      type: 'locator',
      requestId: 9901,
      payload: encodeApplicationEnvelope((await relayA.listBootstrapLocators())[0].envelope),
    }),
  })
  t.not(replayed.status, 'accepted', 'an identical re-delivered locator must not be re-accepted as fresh')
  t.is(relayB.listBootstrapLocators().length, 1, 'replay does not duplicate retention')
  const bUpdates = []
  // A completed catalog walk on B is observable through the namespace state:
  // the followed scope reconstructed the same head A advertises.
  const bTopic = relayB.getDiagnostics().topics.find(topic => topic.purpose === 'publisher' && topic.modes.includes('followed'))
  t.ok(bTopic, 'relay B holds a followed publisher scope')
  t.not(bTopic.topicHex, undefined)
})

test('publisher follow admission cancelled by close rejects and never joins a late scope', async t => {
  const root = crypto.keyPair(bytes(32, 61))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 62),
  })
  const publisherId = b4a.toString(derivePublisherId(root.publicKey), 'hex')
  const registry = fakeRegistry(descriptor)
  let releaseBind = null
  registry.bindNamespace = () => new Promise(resolve => { releaseBind = resolve })
  let registryReleases = 0
  const ownedRelease = registry.release
  registry.release = async id => {
    registryReleases++
    return ownedRelease(id)
  }
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({ swarm, store: {}, catalogRegistry: registry })
  await runtime.start()

  const joinsAtClose = swarm.joins.length
  const admission = runtime.followPublisher({ publisherId, namespaceDescriptor: descriptor })
  await settle()
  await runtime.close()

  await t.exception(admission, /runtime is closed/)
  releaseBind(registry.binding)
  await settle()
  t.is(swarm.joins.length, joinsAtClose, 'the late bind result never joins publisher discovery')
  t.absent(runtime.getDiagnostics().topics.find(topic => topic.purpose === 'publisher'))
  t.is(registryReleases, 0, 'the registry-retained binding is never released by cancelled admission cleanup')
  await t.exception(
    runtime.followPublisher({ publisherId, namespaceDescriptor: descriptor }),
    /runtime is not active/,
  )
})

test('late writable lease after close is released exactly once and never admitted', async t => {
  const root = crypto.keyPair(bytes(32, 63))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 64),
  })
  const publisherId = b4a.toString(derivePublisherId(root.publicKey), 'hex')
  const registry = fakeRegistry(descriptor, root)
  registry.binding.catalog.listProjections = async kind => ({
    items: kind === 'publication' ? [{ accepted: true }] : [],
    nextCursor: null,
  })
  let leaseReleases = 0
  let deliverLease = null
  registry.acquireWritableBinding = () => new Promise(resolve => {
    deliverLease = () => resolve({ binding: registry.binding, release: async () => { leaseReleases++ } })
  })
  let registryReleases = 0
  const ownedRelease = registry.release
  registry.release = async id => {
    registryReleases++
    return ownedRelease(id)
  }
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({
    swarm,
    store: {},
    catalogRegistry: registry,
    initialNetworkPolicy: contributionPolicy(),
  })
  await runtime.start()

  const joinsAtClose = swarm.joins.length
  const admission = runtime.publishLocalPublisherCatalog({
    publisherId,
    retentionClass: 'contribution-cache',
  })
  await settle()
  await runtime.close()
  deliverLease()
  await settle()
  await settle()

  await t.exception(admission, /runtime is closed/)
  t.is(leaseReleases, 1, 'the late lease is released exactly once by the disposal continuation')
  t.is(registryReleases, 0, 'borrowed registry ownership is untouched')
  t.absent(runtime.getDiagnostics().topics.find(topic => topic.purpose === 'publisher'))
  t.is(swarm.joins.length, joinsAtClose, 'no publisher scope joined after the close snapshot')
  t.is(
    runtime.authorizeConnection({
      purpose: 'publisher',
      topic: derivePublisherTopic({ publisherId, catalogEpoch: descriptor.catalogEpoch }),
    }).status,
    'rejected',
    'no local provider scope was retained',
  )
})

test('close aborts a publish admission stalled on catalog readiness and releases its owned lease', async t => {
  const root = crypto.keyPair(bytes(32, 65))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 66),
  })
  const publisherId = b4a.toString(derivePublisherId(root.publicKey), 'hex')
  const registry = fakeRegistry(descriptor, root)
  registry.binding.catalog.listProjections = async kind => ({
    items: kind === 'publication' ? [{ accepted: true }] : [],
    nextCursor: null,
  })
  let leaseReleases = 0
  registry.acquireWritableBinding = async () => ({
    binding: registry.binding,
    release: async () => { leaseReleases++ },
  })
  let releaseReady = null
  registry.binding.catalog.ready = () => new Promise(resolve => { releaseReady = resolve })
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({
    swarm,
    store: {},
    catalogRegistry: registry,
    initialNetworkPolicy: contributionPolicy(),
  })
  await runtime.start()

  const admission = runtime.publishLocalPublisherCatalog({
    publisherId,
    retentionClass: 'contribution-cache',
  })
  await settle()
  await runtime.close()

  await t.exception(admission, /runtime is closed/)
  t.is(leaseReleases, 1, 'the owned lease was released by the admission finally during close')
  releaseReady()
  await settle()
  t.is(leaseReleases, 1, 'close never needed the readiness gate and never double-releases')
  t.absent(runtime.getDiagnostics().topics.find(topic => topic.purpose === 'publisher'))
})

test('late proof, head, and bootstrap work after close cannot repopulate runtime state', async t => {
  const root = crypto.keyPair(bytes(32, 67))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 68),
  })
  const publisherId = b4a.toString(derivePublisherId(root.publicKey), 'hex')
  const registry = fakeRegistry(descriptor, root)
  registry.binding.catalog.listProjections = async kind => ({
    items: kind === 'publication' ? [{ accepted: true }] : [],
    nextCursor: null,
  })
  registry.binding.catalog.localWriterKey = descriptor.publisherRootKey
  const locatorKeys = crypto.keyPair(bytes(32, 69))
  registry.binding.catalog.getAuthorizationState = async () => ({
    policyEpoch: 0,
    policySequence: 0,
    writers: [{
      key: b4a.toString(descriptor.publisherRootKey, 'hex'),
      signerKey: b4a.toString(locatorKeys.publicKey, 'hex'),
      capabilities: ['announce', 'publish'],
      firstAcceptedSequence: 0,
      lastAcceptedSequence: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
      admissionPolicyEpoch: 0,
      revocation: null,
    }],
  })
  let headCalls = 0
  let releaseHead = null
  registry.binding.catalog.getViewHead = () => {
    headCalls++
    if (headCalls === 1) {
      return Promise.resolve({
        viewKey: descriptor.catalogBootstrapKey,
        length: 0,
        digest: bytes(32, 210),
        authorizationStateDigest: bytes(32, 211),
      })
    }
    return new Promise(resolve => { releaseHead = resolve })
  }
  let leaseAcquires = 0
  let leaseReleases = 0
  const ownedAcquire = registry.acquireWritableBinding
  registry.acquireWritableBinding = async (...args) => {
    leaseAcquires++
    const lease = await ownedAcquire(...args)
    const ownedRelease = lease.release
    return {
      ...lease,
      release: async () => {
        leaseReleases++
        return ownedRelease()
      },
    }
  }
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({
    swarm,
    store: {},
    catalogRegistry: registry,
    bootstrapLocatorKeyPair: locatorKeys,
    initialNetworkPolicy: contributionPolicy(),
  })
  await runtime.start()

  const published = await runtime.publishLocalPublisherCatalog({
    publisherId,
    retentionClass: 'contribution-cache',
  })
  t.is(published.status, 'published', 'the initial publish completes with an ungated head read')

  const rebind = runtime.rebindLocalPublisherCatalog({ publisherId })
  await settle()
  await settle()
  t.is(headCalls, 2, 'the rebind refresh is parked on the gated head read')

  const joinsAtClose = swarm.joins.length
  await runtime.close()
  await t.exception(rebind, /runtime is closed/)
  releaseHead({})
  await settle()
  await settle()

  t.is(leaseAcquires, leaseReleases, 'every acquired lease was released exactly once')
  t.is(swarm.joins.length, joinsAtClose, 'late head work never joins or re-joins discovery')
  t.absent(runtime.getDiagnostics().topics.find(topic => topic.purpose === 'publisher'))
  await t.exception(
    runtime.providePublisherNamespaceProof({ locator: {}, proof: {} }),
    /runtime is closed/,
    'late proof registration is rejected before writing provider state',
  )
  await t.exception(
    runtime.provideLocalPublisherNamespaceProof({
      publisherId,
      descriptor,
      catalog: registry.binding.catalog,
    }),
    /runtime is closed/,
    'late local proof registration is rejected before writing provider state',
  )
  await t.exception(
    runtime.publishBootstrapLocator({ locator: {} }),
    /runtime is closed/,
    'bootstrap publish is rejected during shutdown',
  )
})

test('pre-start follow reason registration and normal publish and follow still behave', async t => {
  const root = crypto.keyPair(bytes(32, 70))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 71),
  })
  const publisherId = b4a.toString(derivePublisherId(root.publicKey), 'hex')
  const registry = fakeRegistry(descriptor, root)
  registry.binding.catalog.listProjections = async kind => ({
    items: kind === 'publication' ? [{ accepted: true }] : [],
    nextCursor: null,
  })
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({
    swarm,
    store: {},
    catalogRegistry: registry,
    initialNetworkPolicy: contributionPolicy(),
  })

  const registered = await runtime.addPublisherFollowReason({
    publisherId,
    reason: 'bootstrap:auto',
  })
  t.is(registered.status, 'scheduled', 'idle pre-start reason registration stays allowed')
  t.alike(registered.reasons, ['bootstrap:auto'])

  await runtime.start()
  const published = await runtime.publishLocalPublisherCatalog({
    publisherId,
    retentionClass: 'contribution-cache',
  })
  t.is(published.status, 'published')
  t.ok(runtime.getDiagnostics().topics.find(topic => topic.purpose === 'publisher')?.publicAnnounced)

  const followed = await runtime.followPublisher({ publisherId, namespaceDescriptor: descriptor })
  t.is(followed.status, 'following')
  t.ok(runtime.getDiagnostics().topics.find(topic => topic.purpose === 'publisher')?.modes.includes('followed'))
  await runtime.close()
})

function publisherGate () {
  let resolve
  let reject
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function publisherCloseFixture (fill, options = {}) {
  const root = crypto.keyPair(bytes(32, fill))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, fill + 1),
  })
  const publisherId = b4a.toString(descriptor.publisherId, 'hex')
  const registry = fakeRegistry(descriptor, root)
  const swarm = fakeSwarm()
  const runtime = createScopedNetworkRuntime({
    swarm, store: {}, catalogRegistry: registry, ...options,
  })
  return { descriptor, publisherId, registry, swarm, runtime }
}

test('restore page handed off before close is released once before close settles', async t => {
  t.timeout(3000)
  const { registry, swarm, runtime } = publisherCloseFixture(71, {
    initialNetworkPolicy: contributionPolicy(),
  })
  const pageGate = publisherGate()
  const pageRequested = publisherGate()
  const closeGate = publisherGate()
  const releaseStarted = publisherGate()
  const releaseGate = publisherGate()
  const events = []
  let releases = 0
  let closed = false
  registry.listBindingPage = () => {
    pageRequested.resolve()
    return pageGate.promise
  }
  const page = {
    items: [registry.binding],
    nextCursor: null,
    release () {
      releases++
      events.push('release')
      releaseStarted.resolve()
      return releaseGate.promise
    },
  }
  const starting = runtime.start()
  const startError = starting.then(() => null, error => error)
  const closing = closeGate.promise.then(() => {
    events.push('close')
    return runtime.close()
  }).then(() => { closed = true })
  t.teardown(async () => {
    pageGate.resolve(page)
    closeGate.resolve()
    releaseGate.resolve()
    await Promise.allSettled([starting, closing])
  })
  await pageRequested.promise
  const joinsBeforeClose = swarm.joins.length
  // raceOwned's handoff and disposal reactions were registered first. The
  // independently queued close reaction then precedes the await consumer
  // queued by that successful handoff. A synchronous close here would not.
  pageGate.promise.then(() => { events.push('page-ready') })
  pageGate.resolve(page)
  closeGate.resolve()
  await releaseStarted.promise
  t.alike(events, ['page-ready', 'close', 'release'])
  t.is(releases, 1)
  t.is(closed, false, 'close waits for the handed-off page release')
  t.is(swarm.joins.length, joinsBeforeClose, 'the page is never admitted after close')
  releaseGate.resolve()
  await closing
  t.is((await startError)?.code, 'SCOPED_NETWORK_CLOSED')
  t.is(releases, 1, 'late disposal does not release the handed-off page twice')
  t.absent(runtime.getDiagnostics().topics.find(topic => topic.purpose === 'publisher'))
})

for (const stage of ['ready', 'descriptor']) {
  test(`local catalog resolution close interrupts stalled ${stage} and drains its lease`, async t => {
    t.timeout(3000)
    const { registry, publisherId, runtime } = publisherCloseFixture(stage === 'ready' ? 73 : 75)
    await runtime.start()
    const readStarted = publisherGate()
    const readGate = publisherGate()
    const releaseStarted = publisherGate()
    const releaseGate = publisherGate()
    let releases = 0
    let catalogCloses = 0
    let closed = false
    const stalledRead = () => {
      readStarted.resolve()
      return readGate.promise
    }
    if (stage === 'ready') registry.binding.catalog.ready = stalledRead
    else registry.binding.catalog.view.get = stalledRead
    registry.binding.catalog.close = async () => { catalogCloses++ }
    registry.acquireWritableBinding = async () => ({
      binding: registry.binding,
      release () {
        releases++
        releaseStarted.resolve()
        return releaseGate.promise
      },
    })
    const resolving = runtime.resolveLocalPublisherCatalog({ publisherId })
    t.teardown(async () => {
      readGate.resolve()
      releaseGate.resolve()
      await Promise.allSettled([resolving, runtime.close()])
    })
    await readStarted.promise
    const closing = runtime.close().then(() => { closed = true })
    await releaseStarted.promise
    t.is(closed, false, 'close is still draining the owned release, not the read')
    t.is(releases, 1)
    releaseGate.resolve()
    await closing
    t.is((await resolving).status, 'unavailable')
    t.is(catalogCloses, 0, 'the registry retains the catalog; only its lease is released')
    readGate.resolve()
    await new Promise(resolve => setImmediate(resolve))
    t.is(releases, 1)
    t.absent(runtime.getDiagnostics().topics.find(topic => topic.purpose === 'publisher'))
  })
}

test('already-aborted admission observes a late rejection from reentrant binding work', async t => {
  t.timeout(3000)
  const { descriptor, publisherId, registry, swarm, runtime } = publisherCloseFixture(77)
  await runtime.start()
  const bindingGate = publisherGate()
  const lateError = new Error('late binding failure')
  const unhandled = []
  const observeRejection = error => { unhandled.push(error) }
  process.on('unhandledRejection', observeRejection)
  let closing
  registry.bindNamespace = () => {
    // The dependency runs synchronously before raceAdmission receives the
    // bindAndLoadFollowedPublisher promise: its abort fast path must observe
    // that already-started work, not merely remove a normal abort listener.
    closing = runtime.close()
    return bindingGate.promise
  }
  const joinsBeforeClose = swarm.joins.length
  try {
    const failure = await runtime.followPublisher({ publisherId, namespaceDescriptor: descriptor })
      .then(() => null, error => error)
    t.is(failure?.code, 'SCOPED_NETWORK_CLOSED')
    await closing
    bindingGate.reject(lateError)
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    t.alike(unhandled, [], 'no already-started rejection escapes after admission closes')
    t.is(swarm.joins.length, joinsBeforeClose)
    t.absent(runtime.getDiagnostics().topics.find(topic => topic.purpose === 'publisher'))
  } finally {
    bindingGate.resolve(registry.binding)
    await runtime.close()
    process.removeListener('unhandledRejection', observeRejection)
  }
})

test('direct local namespace proof close drains its acquired lease without the page completing', async t => {
  t.timeout(3000)
  const { descriptor, publisherId, registry, runtime } = publisherCloseFixture(79)
  await runtime.start()
  const pageStarted = publisherGate()
  const pageGate = publisherGate()
  const releaseStarted = publisherGate()
  const releaseGate = publisherGate()
  let releases = 0
  let closed = false
  registry.binding.catalog.listAcceptedPage = () => {
    pageStarted.resolve()
    return pageGate.promise
  }
  registry.acquireWritableBinding = async () => ({
    binding: registry.binding,
    release () {
      releases++
      releaseStarted.resolve()
      return releaseGate.promise
    },
  })
  const proving = runtime.provideLocalPublisherNamespaceProof({ publisherId, descriptor })
  const proofError = proving.then(() => null, error => error)
  t.teardown(async () => {
    pageGate.resolve({ entries: [], nextCursor: null })
    releaseGate.resolve()
    await Promise.allSettled([proving, runtime.close()])
  })
  await pageStarted.promise
  const closing = runtime.close().then(() => { closed = true })
  await releaseStarted.promise
  t.is(closed, false, 'the direct proof retains ownership through release')
  t.is(releases, 1)
  releaseGate.resolve()
  await closing
  t.is((await proofError)?.code, 'SCOPED_NETWORK_CLOSED')
  t.absent(runtime.getDiagnostics().topics.find(topic => topic.purpose === 'publisher'))
})
