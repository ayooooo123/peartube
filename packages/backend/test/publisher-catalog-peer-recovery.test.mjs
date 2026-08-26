// Losing the catalog peer without losing the connection.
//
// Observed on the desktop client against a live relay: one
// PUBLISHER_CATALOG_PEER_DISCONNECTED, and from then on every republished
// locator was refused with "locator identical; no live session yet". The
// bootstrap channel on the same connection kept delivering those locators, so
// the peer was plainly still there - but the publisher scope had no session,
// the topic was already joined so no connection event rejoined it, and the
// catalog stayed short for the life of the process. Only an unrelated second
// peer connecting ever broke it.
//
// The connection has to survive for this to reproduce, so the test closes one
// protomux channel rather than the stream, through the muxFactory seam the
// runtime already exposes.
import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Protomux from 'protomux'
import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'

import {
  PUBLISHER_RECORD_TYPES,
  createPublisherNamespaceDescriptor,
  encodePublisherCatalogFrame,
  encodePublisherNamespaceDescriptor,
} from '../src/publisher/index.js'
import {
  attachSignedEnvelopeSignature,
  prepareSignedEnvelope,
  signedRecordSignaturePreimage,
} from '../src/records/index.js'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'

function bytes (size, fill) {
  return b4a.alloc(size, fill)
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

function connectionPair () {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = Duplex.from({ readable: bToA, writable: aToB })
  const b = Duplex.from({ readable: aToB, writable: bToA })
  a.userData = null
  b.userData = null
  a.remotePublicKey = bytes(32, 181)
  b.remotePublicKey = bytes(32, 182)
  return { a, b }
}

function fakeSwarm () {
  const swarm = new EventEmitter()
  swarm.connections = new Set()
  swarm.join = () => ({
    flushed: async () => {},
    destroy () {},
    async suspend () {},
    async resume () {},
  })
  return swarm
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

// The registry the runtime reads its own catalog through, matching the double
// the rest of the scoped-network suite uses. `head` overrides the view head so
// a consumer's walk can be made to never reconstruct it.
function fakeRegistry (descriptor, { head = null } = {}) {
  const catalogEvents = new EventEmitter()
  const catalog = {
    key: descriptor.catalogBootstrapKey,
    writable: true,
    replicated: [],
    async ready () {},
    async close () {},
    async listProjections () { return { items: [], nextCursor: null } },
    async listAcceptedPage () { return { entries: [], nextCursor: null } },
    async getViewHead () {
      return head || {
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
    async resolve () { return binding },
    async release () { return true },
  }
}

test('a publisher scope that loses its catalog peer recovers on the next republished locator', async (t) => {
  const root = crypto.keyPair(bytes(32, 183))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: bytes(32, 184),
  })
  const genesis = namespaceGenesis(descriptor, root)

  const sourceRegistry = fakeRegistry(descriptor)
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

  // A consumer that reads the publisher's catalog successfully, so the session
  // it loses later is a healthy one rather than one already failing.
  const consumerRegistry = fakeRegistry(descriptor)
  consumerRegistry.binding.catalog.ingestAcceptedPage = async entries => ({
    accepted: entries.length,
    rejected: 0,
  })

  const sourceSwarm = fakeSwarm()
  sourceSwarm.keyPair = root
  const consumerSwarm = fakeSwarm()

  // One mux per connection, with every channel each runtime opens recorded, so
  // the test can close exactly one channel on both peers and leave the stream
  // and its other channels untouched.
  const recordChannels = (sink, who) => connection => {
    const mux = Protomux.from(connection)
    if (!mux.__recording) {
      mux.__recording = true
      const createChannel = mux.createChannel.bind(mux)
      mux.createChannel = options => {
        const channel = createChannel(options)
        if (channel) sink.push({ protocol: options.protocol, channel })
        return channel
      }
    }
    return mux
  }
  const channels = []
  const sourceChannels = []

  // A refreshed locator only reaches the follow scheduler if it is genuinely
  // new; a byte-identical republish is refused as a replay, exactly as a real
  // relay's clock-stamped refresh avoids.
  let clock = 20
  let refreshCallback = null
  const source = createScopedNetworkRuntime({
    swarm: sourceSwarm,
    store: {},
    catalogRegistry: sourceRegistry,
    muxFactory: recordChannels(sourceChannels, 'source'),
    initialNetworkPolicy: {
      networkEnabled: true,
      uploadPermission: 'enabled',
      uploadCeilingBytes: 1024 * 1024,
      contributionBudgetBytes: 1024 * 1024,
      publicServingAllowed: true,
      permissions: { contribute: true },
    },
    now: () => clock,
    setBootstrapLocatorTimer (callback) {
      refreshCallback = callback
      return { unref () {} }
    },
    clearBootstrapLocatorTimer () {},
  })
  const consumer = createScopedNetworkRuntime({
    swarm: consumerSwarm,
    store: {},
    catalogRegistry: consumerRegistry,
    muxFactory: recordChannels(channels, 'consumer'),
    now: () => clock,
  })

  await source.start()
  await consumer.start()
  await source.publishLocalPublisherCatalog({ publisherId: b4a.toString(descriptor.publisherId, 'hex') })

  const pair = connectionPair()
  sourceSwarm.connections.add(pair.a)
  consumerSwarm.connections.add(pair.b)
  sourceSwarm.emit('connection', pair.a, { publicKey: pair.a.remotePublicKey, topics: [], client: false })
  consumerSwarm.emit('connection', pair.b, { publicKey: pair.b.remotePublicKey, topics: [], client: true })

  const publisherSessions = () => consumer.getDiagnostics().sessions
    .filter(session => session.purpose === 'publisher' && session.state === 'active')

  for (let attempt = 0; attempt < 40 && publisherSessions().length === 0; attempt++) await settle()
  t.is(publisherSessions().length, 1, 'the consumer follows the advertised publisher and opens a catalog session')

  const publisherChannel = channels.find(entry => String(entry.protocol).endsWith('/publisher'))
  t.ok(publisherChannel, 'the consumer opened a publisher channel to close')

  t.teardown(async () => {
    await source.close().catch(() => {})
    await consumer.close().catch(() => {})
    pair.a.destroy()
    pair.b.destroy()
  })

  // Close only the catalog channel. The stream, and with it the bootstrap
  // channel carrying locators, stays up.
  publisherChannel.channel.close()
  for (const entry of sourceChannels) {
    if (String(entry.protocol).endsWith('/publisher')) entry.channel.close()
  }
  for (let attempt = 0; attempt < 20 && publisherSessions().length > 0; attempt++) await settle()
  t.is(publisherSessions().length, 0, 'losing the channel drops the catalog session')
  t.ok(consumer.getDiagnostics().sessions.some(session => session.purpose === 'bootstrap'),
    'the connection survives, so locators keep arriving on the same peer')

  // The publisher re-advertises the same locator on its refresh tick, which is
  // the only retry signal a consumer ever gets.
  for (let tick = 0; tick < 3; tick++) {
    clock += 1
    await refreshCallback?.()
    await settle()
  }
  for (let attempt = 0; attempt < 200 && publisherSessions().length === 0; attempt++) {
    if (attempt % 40 === 39) { clock += 1; await refreshCallback?.() }
    await settle()
  }

  t.is(publisherSessions().length, 1, 'a republished locator rebuilds the scope instead of skipping it forever')
})
