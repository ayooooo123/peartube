import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import test from 'brittle'

import { prepareStoredProtocolState, STORAGE_FORMAT_VERSION } from '@peartube/backend/storage'
import { PROTOCOL_MAJOR } from '../../backend/src/network/version.js'
import { openAddRuntime } from '../src/add/runtime.js'
import { createRelayRuntime } from '../src/runtime.js'
import { resolveRelayConfig } from '../src/config.js'

test('add opens exactly one universal backend with storage-format expectation and no legacy mirror configuration', async (t) => {
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
  let runtime = null
  try {
    runtime = await openAddRuntime({
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
    t.is(calls[0][1].expectedStorageFormatVersion, STORAGE_FORMAT_VERSION)
    t.is(calls[0][1].platform, 'cli')
    t.is(calls[0][1].role, 'hybrid')
    t.alike(calls[0][1].network, { trustedRelayKeys: ['a'.repeat(64)] })
    t.absent(Object.hasOwn(runtime, 'publicFeed'))
    t.is(runtime.api, backend.api)
  } finally {
    await runtime?.close?.()
  }

  t.alike(calls.map(([name]) => name), ['create', 'destroy'])
  t.is(target.log, originalLog, 'diagnostic console is restored after backend shutdown')
})

test('add runtime closes private grants before surfacing a backend shutdown error', async (t) => {
  const destroyError = new Error('backend shutdown failed')
  const events = []
  const target = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((name) => [name, () => {}]))
  const runtime = await openAddRuntime({
    storagePath: '/tmp/peartube-add-close-error',
    logger: { log () {}, debug () {} },
    target,
    backendFactory: async () => ({
      ctx: {},
      api: {},
      async destroy () {
        events.push('destroy')
        throw destroyError
      }
    })
  })

  runtime.localFileSourceGrants.issue({
    acquisitionId: 'acq-close-error',
    principalId: 'local-provider',
    path: '/private/staged/video.mp4',
    expiresAt: Date.now() + 60_000,
    dispose: () => events.push('dispose')
  })

  let caught = null
  try {
    await runtime.close()
  } catch (error) {
    caught = error
  }

  t.is(caught, destroyError, 'the original backend error is preserved when private cleanup succeeds')
  t.alike(events, ['destroy', 'dispose'], 'private grants are cleaned after destroy rejects')
})

test('relay runtime closes every source adapter after backend shutdown and aggregates cleanup failures', async (t) => {
  const storagePath = mkdtempSync(join(tmpdir(), 'peartube-relay-close-error-'))
  const destroyError = new Error('relay backend shutdown failed')
  const adapterError = new Error('source adapter shutdown failed')
  const events = []
  let runtime = null

  try {
    runtime = await createRelayRuntime({
      config: resolveRelayConfig({
        storage: { path: storagePath, maxBytes: 1_000_000 }
      }, { env: {} }),
      logger: { runtime: { info () {}, warn () {}, error () {}, debug () {} } },
      dependencies: {
        sourceAdapters: {
          testAdapter: {
            async close () {
              events.push('adapter-close')
              throw adapterError
            }
          }
        },
        async createBackendContext () {
          return {
            ctx: {},
            api: {},
            async destroy () {
              events.push('destroy')
              throw destroyError
            }
          }
        }
      }
    })

    runtime.localFileSourceGrants.issue({
      acquisitionId: 'acq-relay-close-error',
      principalId: 'local-provider',
      path: '/private/staged/video.mp4',
      expiresAt: Date.now() + 60_000,
      dispose: () => events.push('dispose')
    })

    let caught = null
    try {
      await runtime.close()
    } catch (error) {
      caught = error
    }

    t.ok(caught instanceof AggregateError)
    t.is(caught.errors[0], destroyError, 'the backend error remains the primary aggregate error')
    t.is(caught.errors[1], adapterError)
    t.ok(events.includes('dispose'), 'the local private registry is closed')
    t.ok(events.includes('adapter-close'), 'injected source adapters are closed')
    t.is(events[0], 'destroy')
  } finally {
    rmSync(storagePath, { recursive: true, force: true })
  }
})

test('relay runtime closes every owned source resource when backend open fails', async (t) => {
  const storagePath = mkdtempSync(join(tmpdir(), 'peartube-relay-open-fail-'))
  const openError = new Error('relay backend open failed')
  const events = []
  let caught = null

  try {
    try {
      await createRelayRuntime({
        config: resolveRelayConfig({
          storage: { path: storagePath, maxBytes: 1_000_000 }
        }, { env: {} }),
        logger: { runtime: { info () {}, warn () {}, error () {}, debug () {} } },
        dependencies: {
          sourceAdapters: {
            testAdapter: {
              async close () { events.push('adapter-close') }
            }
          },
          async createBackendContext () {
            throw openError
          }
        }
      })
    } catch (error) {
      caught = error
    }

    t.is(caught, openError, 'the original backend open error is preserved when cleanup succeeds')
    t.alike(events, ['adapter-close'], 'injected source adapters are closed exactly once')
  } finally {
    rmSync(storagePath, { recursive: true, force: true })
  }
})

test('relay runtime aggregates failed-open cleanup errors behind the backend open error', async (t) => {
  const storagePath = mkdtempSync(join(tmpdir(), 'peartube-relay-open-cleanup-fail-'))
  const openError = new Error('relay backend open failed')
  const adapterError = new Error('source adapter shutdown failed')
  let caught = null

  try {
    try {
      await createRelayRuntime({
        config: resolveRelayConfig({
          storage: { path: storagePath, maxBytes: 1_000_000 }
        }, { env: {} }),
        logger: { runtime: { info () {}, warn () {}, error () {}, debug () {} } },
        dependencies: {
          sourceAdapters: {
            testAdapter: {
              async close () { throw adapterError }
            }
          },
          async createBackendContext () {
            throw openError
          }
        }
      })
    } catch (error) {
      caught = error
    }

    t.ok(caught instanceof AggregateError)
    t.is(caught.errors[0], openError, 'the backend open error remains the primary aggregate error')
    t.is(caught.errors[1], adapterError, 'the failed adapter cleanup is aggregated behind it')
  } finally {
    rmSync(storagePath, { recursive: true, force: true })
  }
})

test('relay starts one scoped backend with storage-format acceptance and bounded catalog discovery', async (t) => {
  const calls = []
  const storagePath = mkdtempSync(join(tmpdir(), 'peartube-relay-format-'))
  const api = {
    async followPublisher (request) { calls.push(['follow', request]); return { status: 'following', publisherId: request.publisherId } },
    async publishLocalPublisherCatalog (request) { calls.push(['publish-catalog', request]); return { status: 'published', publisherId: request.publisherId } },
    async listBootstrapLocators () { return [{ body: { publisherId: 'c'.repeat(64) } }] },
    async retainAuthorizedRendition (request) { calls.push(['retain-rendition', request]); return { status: 'retained', renditionId: request.renditionId } },
    async retainAuthorizedArchive (request) { calls.push(['retain-archive', request]); return { status: 'retained', archiveId: 'archive-1' } },
    async getScopedNetworkDiagnostics () {
      return {
        status: 'ready',
        protocolMajor: PROTOCOL_MAJOR,
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
  let runtime = null
  let storageState = null
  try {
    writeFileSync(
      join(storagePath, 'stored-protocol.json'),
      JSON.stringify({ protocolVersion: STORAGE_FORMAT_VERSION })
    )
    runtime = await createRelayRuntime({
      config: {
        mode: 'public',
        policy: 'open',
        storage: { path: storagePath, maxBytes: 4096 },
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
          storageState = prepareStoredProtocolState({
            storagePath: options.storagePath,
            expectedVersion: options.expectedStorageFormatVersion,
            fs: { existsSync, statSync, readFileSync },
            path: { join }
          })
          await storageState.migrate({})
          storageState.commit()
          return backend
        }
      }
    })

    await runtime.start()
    const options = calls[0][1]
    t.is(options.platform, 'relay')
    t.is(options.role, 'relay')
    t.is(options.expectedStorageFormatVersion, STORAGE_FORMAT_VERSION)
    t.is(options.network.networkId, 'testnet')
    t.is(options.network.trustedBootstrapSigners[0].byteLength, 32)
    t.alike(options.network.trustedBootstrapRootIds, ['b'.repeat(64)])
    t.is(options.resources.profile.maxBytesPerDay, 4096)
    t.is(storageState.status, 'compatible')
    t.is(storageState.expectedVersion, STORAGE_FORMAT_VERSION)
    t.alike(JSON.parse(readFileSync(join(storagePath, 'stored-protocol.json'), 'utf8')), {
      protocolVersion: STORAGE_FORMAT_VERSION
    })

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
  } finally {
    await runtime?.close?.()
    rmSync(storagePath, { recursive: true, force: true })
  }
  t.is(calls.at(-1)[0], 'destroy')
})
