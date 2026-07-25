import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import test from 'brittle'

import { resolveRelayConfig } from '../src/config.js'
import { createRelayService } from '../src/service.js'

const noop = () => {}
const logger = Object.fromEntries(
  ['relay', 'runtime', 'status', 'archive', 'admission', 'discovery', 'mirror', 'storage'].map((scope) => [
    scope,
    { info: noop, warn: noop, error: noop, debug: noop }
  ])
)

function diagnostics () {
  return {
    network: { status: 'ready', peers: 2, connections: 1, dht: { bootstrapped: true } },
    publisher: { catalogs: 1, followed: 1 },
    bootstrap: { joined: true, locators: 2, rejected: 0, maxLocators: 64 },
    assets: { retainedRenditions: 1, activeSessions: 1, topics: 1, maxSessions: 4 },
    seedRetention: { activeSeeds: 2, pinnedChannels: 1 },
    archive: { success: true, activePledgeCount: 1 },
    storage: { success: true, totalCategorizedBytes: 128 }
  }
}

function fakeRuntime (calls) {
  return {
    ctx: { metaDb: null },
    api: {},
    identityManager: {},
    uploadManager: {},
    setCandidateHandler (handler) { calls.push(['candidate-handler', typeof handler]) },
    async start () { calls.push(['start']) },
    async close () { calls.push(['close']) },
    async getDiagnostics () { return diagnostics() },
    async followPublisher (request) { calls.push(['follow', request]); return { status: 'following' } },
    async resolvePublisherCatalog (request) { calls.push(['resolve', request]); return { status: 'resolved' } },
    async publishPublisherCatalog (request) { calls.push(['publish', request]); return { status: 'published' } },
    async retainRendition (request) { calls.push(['retain-rendition', request]); return { status: 'retained' } },
    async retainArchive (request) { calls.push(['retain-archive', request]); return { status: 'retained' } },
    async refreshAuthorization () { return true }
  }
}

function configFor (storagePath) {
  return resolveRelayConfig({
    storage: { path: storagePath, maxBytes: 4096, minFreeBytes: 0 },
    archive: { enabled: false, uiEnabled: false, localMirror: { enabled: false } },
    classification: { tmdb: { enabled: false } },
    discovery: { enabled: false, seedDiscovered: false },
    seedPin: { enabled: true, trustedClients: [] }
  }, { env: {} })
}

test('relay service starts one universal runtime and reports structured diagnostics', async (t) => {
  const storagePath = mkdtempSync(join(tmpdir(), 'peartube-cli-service-'))
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))
  const calls = []
  const runtime = fakeRuntime(calls)
  const timers = []
  const service = await createRelayService({
    config: configFor(storagePath),
    logger,
    runtimeFactory: async () => { calls.push(['create']); return runtime },
    writeStatusFile: async () => {},
    setIntervalFn: (fn, ms) => { const timer = { fn, ms, unref: noop }; timers.push(timer); return timer },
    clearIntervalFn: (timer) => { timer.cleared = true }
  })

  await service.start()
  const status = service.getStatus()
  t.alike(calls.slice(0, 3).map(([name]) => name), ['create', 'candidate-handler', 'start'])
  t.is(timers.length, 1)
  t.is(status.runtime.publisher.catalogs, 1)
  t.is(status.runtime.bootstrap.locators, 2)
  t.is(status.runtime.assets.retainedRenditions, 1)
  t.is(status.runtime.seedRetention.activeSeeds, 2)
  t.is(status.runtime.archive.activePledgeCount, 1)

  await service.close()
  t.is(calls.at(-1)[0], 'close')
  t.is(timers[0].cleared, true)
})

test('completed archive publishes an authenticated catalog and retains bounded assets', async (t) => {
  const storagePath = mkdtempSync(join(tmpdir(), 'peartube-cli-archive-'))
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))
  const calls = []
  const runtime = fakeRuntime(calls)
  const service = await createRelayService({
    config: configFor(storagePath),
    logger,
    runtimeFactory: async () => runtime,
    writeStatusFile: async () => {},
    setIntervalFn: () => ({ unref: noop }),
    clearIntervalFn: noop,
    nowFn: () => 1234
  })

  const result = await service.publishArchiveJob({
    status: 'completed',
    publish: true,
    channelKey: 'channel-1',
    publisherId: 'a'.repeat(64),
    previewVideo: {
      id: 'video-1',
      immutablePublication: { manifest: { body: { publisherId: 'a'.repeat(64), renditions: [] } }, renditionId: 'rendition-1' },
      archivePledge: { recordId: 'pledge-1' },
      blobsCoreKey: 'b'.repeat(64),
      blobId: '4:8'
    }
  })

  t.alike(result, { published: true, previewVideos: 1, retained: 2 })
  t.alike(calls.map(([name]) => name), ['publish', 'retain-rendition', 'retain-archive'])
  t.is(service.catalog.getChannel('channel-1').publisherId, 'a'.repeat(64))
  await service.close()
})
