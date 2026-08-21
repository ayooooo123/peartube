import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  createPublisherNamespaceDescriptor,
  encodePublisherCatalogFrame,
  encodePublisherNamespaceDescriptor,
  PUBLISHER_RECORD_TYPES,
} from '../src/publisher/index.js'
import {
  attachSignedEnvelopeSignature,
  prepareSignedEnvelope,
  signedRecordSignaturePreimage,
} from '../src/records/index.js'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'

function bytes (size, fill) { return b4a.alloc(size, fill) }

function connectionPair (consumerPeerFill = 201, sourcePeerFill = 202) {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = Duplex.from({ readable: bToA, writable: aToB })
  const b = Duplex.from({ readable: aToB, writable: bToA })
  a.userData = null
  b.userData = null
  a.remotePublicKey = bytes(32, consumerPeerFill)
  b.remotePublicKey = bytes(32, sourcePeerFill)
  a.once('close', () => { if (!b.destroyed) b.destroy() })
  b.once('close', () => { if (!a.destroyed) a.destroy() })
  return { a, b }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

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
    async resolve () { return binding },
    async release () { return true },
  }
}

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
const registryB = fakeRegistry(descriptor)
registryB.binding.catalog.ingestAcceptedPage = async entries => ({ accepted: entries.length, rejected: 0 })
const runtimeB = createScopedNetworkRuntime({
  swarm: swarmB,
  store: {},
  catalogRegistry: registryB,
})
await runtimeA.start()
await runtimeB.start()
const publisherId = b4a.toString(descriptor.publisherId, 'hex')
await runtimeA.publishLocalPublisherCatalog({ publisherId })
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
const dump = (label) => {
  const a = runtimeA.getDiagnostics()
  const b = runtimeB.getDiagnostics()
  console.log(`--- ${label}`)
  console.log('  A sessions', JSON.stringify(a.sessions))
  console.log('  A topics', JSON.stringify(a.topics?.map(t => ({ purpose: t.purpose, publicAnnounced: t.publicAnnounced }))))
  console.log('  B sessions', JSON.stringify(b.sessions))
  console.log('  A counters', JSON.stringify(a.counters))
  console.log('  A errors', JSON.stringify(a.recentErrors ?? a.errors))
  console.log('  B errors', JSON.stringify(b.recentErrors ?? b.errors))
}
let pair = connectPair()
await settle()
dump('after first connect')
console.log('pair destroyed?', pair.a.destroyed, pair.b.destroyed)

await runtimeA.applyNetworkPolicy(contributionPolicy({ contributionBudgetBytes: 0 }))
await settle()
console.log('after contribution cutover; destroyed?', pair.a.destroyed, pair.b.destroyed)
dump('after contribution cutover')

await runtimeA.close()
await runtimeB.close()
for (const connection of pairs) { connection.a.destroy(); connection.b.destroy() }
