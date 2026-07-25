import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import test from 'brittle'

import { PROTOCOL_VERSION } from '@peartube/host/contracts'
import { openAddRuntime } from '../src/add/runtime.js'
import { createRelayRuntime } from '../src/runtime.js'

const cliRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const sourceRoot = join(cliRoot, 'src')

function productionFiles (directory = sourceRoot) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? productionFiles(path) : [path]
    })
    .filter((path) => extname(path) === '.js')
}

const banned = [
  ['deleted public feed', /public[-_ ]?feed|publicFeed/i],
  ['deleted canonical feed', /canonical[-_ ]?feed|canonicalFeed/i],
  ['deleted blind relay peer', /relay[-_ ]?blind[-_ ]?peer|blindPeer/i],
  ['shared global topic', /global[-_ ]?topic|shared[-_ ]?topic/i],
  ['legacy feed submission', /submitToFeed/i]
]

test('CLI production sources contain no legacy discovery or relay backend surfaces', (t) => {
  const violations = []
  for (const path of productionFiles()) {
    const source = readFileSync(path, 'utf8')
    for (const [name, pattern] of banned) {
      if (pattern.test(source)) violations.push(`${relative(cliRoot, path)}: ${name}`)
    }
  }

  t.alike(violations, [])
})

test('add opens exactly one host-versioned universal backend without legacy mirror configuration', async (t) => {
  const calls = []
  const backend = {
    ctx: { metaDb: { name: 'metadata' } },
    api: { name: 'api' },
    identityManager: { name: 'identity' },
    uploadManager: { name: 'upload' },
    seedingManager: { name: 'seeding' },
    seedPinClients: new Map(),
    async destroy () { calls.push(['destroy']) }
  }
  const target = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((name) => [name, () => name]))
  const originalLog = target.log
  const runtime = await openAddRuntime({
    storagePath: '/tmp/peartube-add',
    network: {
      trustedRelayKeys: ['a'.repeat(64)],
      blindPeerMirrors: ['b'.repeat(64)]
    },
    logger: { log () {}, debug () {} },
    target,
    backendFactory: async (options) => {
      calls.push(['create', options])
      return backend
    }
  })

  t.is(calls.length, 1)
  t.is(calls[0][1].expectedProtocolVersion, PROTOCOL_VERSION)
  t.is(calls[0][1].platform, 'cli')
  t.is(calls[0][1].role, 'hybrid')
  t.alike(calls[0][1].network, { trustedRelayKeys: ['a'.repeat(64)] })
  t.absent(Object.hasOwn(runtime, 'publicFeed'))
  t.is(runtime.api, backend.api)

  await runtime.close()
  t.alike(calls.map(([name]) => name), ['create', 'destroy'])
  t.is(target.log, originalLog, 'diagnostic console is restored after backend shutdown')
})

test('relay uses one scoped backend for bounded catalog discovery and authorized retention', async (t) => {
  const calls = []
  const api = {
    async followPublisher (request) { calls.push(['follow', request]); return { status: 'following', publisherId: request.publisherId } },
    async publishLocalPublisherCatalog (request) { calls.push(['publish-catalog', request]); return { status: 'published', publisherId: request.publisherId } },
    async listBootstrapLocators () { return [{ body: { publisherId: 'c'.repeat(64) } }] },
    async retainAuthorizedRendition (request) { calls.push(['retain-rendition', request]); return { status: 'retained', renditionId: request.renditionId } },
    async retainAuthorizedArchive (request) { calls.push(['retain-archive', request]); return { status: 'retained', archiveId: 'archive-1' } },
    async getScopedNetworkDiagnostics () {
      return {
        status: 'ready',
        protocolMajor: PROTOCOL_VERSION,
        networkId: 'testnet',
        topics: [{ role: 'publisher' }, { role: 'asset' }],
        sessions: [{ role: 'asset' }],
        counters: { publishersFollowed: 1, locatorsRejected: 2, retainedRenditions: 1 }
      }
    },
    async getArchiveOperatorStatus () { return { success: true, activePledgeCount: 1 } },
    async getStorageStats () { return { success: true, totalCategorizedBytes: 512 } }
  }
  const backend = {
    ctx: {
      swarm: {
        peers: new Set(['peer-a']),
        connections: new Set(['connection-a']),
        dht: { bootstrapped: true, firewalled: false, online: true },
        _peartubeOffline: false,
        _peartubeListenResolved: true
      }
    },
    api,
    scopedNetwork: {},
    seedingManager: {
      async getStatus () { return { activeSeeds: 2, pinnedChannels: 1, storageUsedBytes: 256 } }
    },
    identityManager: {},
    uploadManager: {},
    seedPinClients: new Map(),
    async destroy () { calls.push(['destroy']) }
  }
  const runtime = await createRelayRuntime({
    config: {
      mode: 'public',
      policy: 'open',
      storage: { path: '/tmp/relay', maxBytes: 4096 },
      network: {
        networkId: 'testnet',
        trustedBootstrapSigners: ['a'.repeat(64)],
        trustedBootstrapRootIds: ['b'.repeat(64)],
        bootstrapEnabled: true
      },
      seedPin: { enabled: true, maxConcurrent: 3, maxBytes: 2048, retentionDays: 7, trustedClients: [] }
    },
    logger: { runtime: { info () {}, warn () {}, error () {}, debug () {} } },
    dependencies: {
      async createBackendContext (options) {
        calls.push(['create', options])
        return backend
      }
    }
  })

  await runtime.start()
  const options = calls[0][1]
  t.is(options.platform, 'relay')
  t.is(options.role, 'relay')
  t.is(options.expectedProtocolVersion, PROTOCOL_VERSION)
  t.is(options.network.networkId, 'testnet')
  t.is(options.network.trustedBootstrapSigners[0].byteLength, 32)
  t.alike(options.network.trustedBootstrapRootIds, ['b'.repeat(64)])
  t.is(options.resources.profile.maxBytesPerDay, 4096)

  await runtime.followPublisher({ publisherId: 'c'.repeat(64), namespaceDescriptor: { version: 1 } })
  await runtime.publishPublisherCatalog({ publisherId: 'c'.repeat(64) })
  await runtime.retainRendition({ manifest: { body: { renditions: [] } }, renditionId: 'rendition-1' })
  await runtime.retainArchive({ pledge: { recordId: 'pledge-1' }, coreKey: 'd'.repeat(64), start: 0, end: 2 })
  const diagnostics = await runtime.getDiagnostics()

  t.is(diagnostics.network.peers, 1)
  t.is(diagnostics.publisher.followed, 1)
  t.is(diagnostics.bootstrap.locators, 1)
  t.is(diagnostics.assets.retainedRenditions, 1)
  t.is(diagnostics.seedRetention.activeSeeds, 2)
  t.is(diagnostics.archive.activePledgeCount, 1)
  t.is(diagnostics.storage.totalCategorizedBytes, 512)
  t.alike(calls.slice(1, 5).map(([name]) => name), ['follow', 'publish-catalog', 'retain-rendition', 'retain-archive'])

  await runtime.close()
  t.is(calls.at(-1)[0], 'destroy')
})
