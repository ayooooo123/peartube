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
    api: {
      async setNetworkPolicy(policy) {
        return {
          success: true,
          policy: {
            ...policy,
            effectiveRole: policy.archiveEnabled ? 'archive-enabled' : (policy.contributeWatchedMedia ? 'contributor' : 'watch-only'),
            permissions: {
              contribute: policy.contributeWatchedMedia === true,
              archive: policy.archiveEnabled === true,
            },
          },
        }
      },
    },
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
  t.is(status.network.peers, 2)
  t.is(status.network.connections, 1)
  t.is(status.publicWork.activeAnnouncements, 2)
  t.is(status.publicWork.activeUploads, 0)
  await timers[0].fn()
  t.is(service.getStatus().network.status, 'ready', 'async heartbeat refreshes the bounded top-level status')

  await service.close()
  t.is(calls.at(-1)[0], 'close')
  t.is(timers[0].cleared, true)
})

test('companion startup cannot accept ingest before runtime policy readiness', async (t) => {
  const storagePath = mkdtempSync(join(tmpdir(), 'peartube-cli-policy-startup-'))
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))
  const calls = []
  const runtime = fakeRuntime(calls)
  let releaseRuntime
  let markRuntimeStarted
  const runtimeStarted = new Promise(resolve => { markRuntimeStarted = resolve })
  const runtimeRelease = new Promise(resolve => { releaseRuntime = resolve })
  runtime.start = async () => {
    calls.push(['start'])
    markRuntimeStarted()
    await runtimeRelease
  }
  let companionService
  const companionStarted = new Promise(resolve => {
    runtime.markCompanionStarted = resolve
  })
  const config = configFor(storagePath)
  config.companion = { ...(config.companion || {}), enabled: true }
  const service = await createRelayService({
    config,
    logger,
    runtimeFactory: async () => runtime,
    companionServerFactory: async ({ service: liveService }) => {
      companionService = liveService
      return {
        async start() {
          runtime.markCompanionStarted()
          t.is(liveService.canStageIngest(), false)
        },
        async close() {}
      }
    },
    writeStatusFile: async () => {},
    setIntervalFn: () => ({ unref: noop }),
    clearIntervalFn: noop
  })
  const starting = service.start()
  await companionStarted
  t.is(companionService.canStageIngest(), false)
  const denied = await companionService.submitIngestJob({}).then(
    () => null,
    error => error
  )
  t.is(denied?.code, 'RETENTION_ADMISSION_DENIED')
  await runtimeStarted
  releaseRuntime()
  await starting
  await service.close()
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
  const blocked = await service.publishArchiveJob({
    status: 'completed',
    publish: true,
    channelKey: 'channel-1',
  })
  t.alike(blocked, { published: false, reason: 'archive-consent-required' })
  t.alike(calls, [])
  await service.applyNetworkPolicy({
    policyVersion: 2,
    consentVersion: 1,
    migrationRequired: false,
    contributeWatchedMedia: false,
    archiveEnabled: true,
    contributionBudgetBytes: 0,
    archiveBudgetBytes: 4096,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 4096,
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
