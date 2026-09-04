import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import test from 'brittle'
import b4a from 'b4a'

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

function fakeMetaDb() {
  const map = new Map()
  return {
    async get(key) { return map.has(key) ? { value: map.get(key) } : null },
    async put(key, value) { map.set(key, value) }
  }
}

function fakeRuntime (calls) {
  let currentPolicy = {
    policyVersion: 2,
    consentVersion: 0,
    migrationRequired: true,
    contributeWatchedMedia: false,
    archiveEnabled: false,
    contributionBudgetBytes: 0,
    archiveBudgetBytes: 0,
    uploadPermission: 'disabled',
    uploadCeilingBytes: 0,
  }
  return {
    ctx: {
      metaDb: null,
      networkPolicyRuntime: {
        getPolicy: () => ({ ...currentPolicy }),
      },
    },
    api: {
      async setNetworkPolicy(policy) {
        currentPolicy = {
          ...policy,
          effectiveRole: policy.archiveEnabled ? 'archive-enabled' : (policy.contributeWatchedMedia ? 'contributor' : 'watch-only'),
          permissions: {
            contribute: policy.contributeWatchedMedia === true,
            archive: policy.archiveEnabled === true,
          },
        }
        return { success: true, policy: { ...currentPolicy } }
      },
      // publisher-shell provisions the relay's own catalog before it publishes.
      // The fake answers with the shape api/publisher.js returns, so the shell
      // takes its success path without reaching a real registry.
      async provisionPublisherCatalog({ publisherId }) {
        return {
          success: true,
          publisherId,
          catalogBootstrapKey: b4a.alloc(32, 7),
          localWriterKey: b4a.alloc(32, 8),
          localSignerKey: b4a.alloc(32, 9),
          writable: true,
          namespaceInitialized: true,
          admitted: true,
          errorCode: null,
        }
      },
    },
    provider: {
      async search () { return { candidates: [], nextCursor: null } },
      async resolve () { throw Object.assign(new Error('disabled'), { code: 'ACQUISITION_DISABLED' }) },
      async requestAcquisition () { throw Object.assign(new Error('disabled'), { code: 'ACQUISITION_DISABLED' }) },
      async attachSourceGrant () { throw Object.assign(new Error('disabled'), { code: 'ACQUISITION_DISABLED' }) },
      async getAcquisition () { return null },
      async listAcquisitions () { return { items: [], cursor: null } },
      async cancelAcquisition () { return null },
      async getPublication () { return null },
      async openStream () { throw Object.assign(new Error('disabled'), { code: 'ACQUISITION_DISABLED' }) },
      async getStatus () { return { ready: true } },
      async getPolicy () { return {} },
      async setPolicy (value) { return value },
      async getAcquisitionPolicy () { return { enabled: false, migrationRequired: true } },
      async setAcquisitionPolicy ({ policy }) { return policy },
      async migrateLegacyIngest () { return { migrated: 0, skipped: 0 } }
    },
    identityManager: {},
    uploadManager: {},
    seedingManager: {
      getRetentionBudgetStatus: () => ({
        contributionUsedBytes: 0,
        archiveUsedBytes: 0,
      }),
    },
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
    companion: { enabled: false },
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
  t.is(status.publicWork.activeServes, 0)
  await timers[0].fn()
  t.is(service.getStatus().network.status, 'ready', 'async heartbeat refreshes the bounded top-level status')

  await service.close()
  t.is(calls.at(-1)[0], 'close')
  t.is(timers[0].cleared, true)
})

test('companion acquisition remains closed before runtime policy readiness', async (t) => {
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
          const denied = await liveService.requestAcquisition({}).then(() => null, error => error)
          t.is(denied?.code, 'ACQUISITION_DISABLED')
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
  const denied = await companionService.requestAcquisition({}).then(
    () => null,
    error => error
  )
  t.is(denied?.code, 'ACQUISITION_DISABLED')
  await runtimeStarted
  releaseRuntime()
  await starting
  await service.close()
})


test('archive WebUI publisher follows current explicit archive consent', async (t) => {
  const storagePath = mkdtempSync(join(tmpdir(), 'peartube-cli-archive-ui-policy-'))
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))
  const calls = []
  const runtime = fakeRuntime(calls)
  const config = configFor(storagePath)
  config.archive = { ...config.archive, uiEnabled: true, uiPort: 0 }
  let uiPublisher = null
  const service = await createRelayService({
    config,
    logger,
    runtimeFactory: async () => runtime,
    archiveConsoleFactory: async ({ publisher }) => {
      uiPublisher = publisher
      return { async start () {}, async close () {} }
    },
    writeStatusFile: async () => {},
    setIntervalFn: () => ({ unref: noop }),
    clearIntervalFn: noop
  })
  await service.start()

  await service.applyNetworkPolicy({
    policyVersion: 2,
    consentVersion: 1,
    migrationRequired: false,
    contributeWatchedMedia: true,
    archiveEnabled: false,
    contributionBudgetBytes: 4096,
    archiveBudgetBytes: 4096,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 4096,
  })
  const denied = await uiPublisher.publishCatalog({
    publisherId: 'archive-ui-publisher',
    retentionClass: 'archive-pin'
  }).then(() => null, error => error)
  t.is(denied?.code, 'RETENTION_PERMISSION_DENIED')
  // The relay publishes its OWN catalog at startup, and a UI publish is
  // addressed by the relay's provisioned publisher root rather than the
  // caller's label — publishing under the caller's identity would name a
  // catalog this relay cannot write. So the question is not whether anything
  // published, it is whether an archive-pin publish happened for this request.
  const archivePublishes = () => calls.filter(([name, request]) =>
    name === 'publish' && request?.retentionClass === 'archive-pin')
  t.absent(archivePublishes().length, 'a refused request publishes nothing')

  await service.applyNetworkPolicy({
    policyVersion: 2,
    consentVersion: 1,
    migrationRequired: false,
    contributeWatchedMedia: true,
    archiveEnabled: true,
    contributionBudgetBytes: 4096,
    archiveBudgetBytes: 4096,
    uploadPermission: 'enabled',
    uploadCeilingBytes: 4096,
  })
  t.is((await uiPublisher.publishCatalog({
    publisherId: 'archive-ui-publisher',
    retentionClass: 'archive-pin'
  })).status, 'published')
  const published = archivePublishes()
  t.is(published.length, 1, 'consent admits exactly one archive-pin publish')
  t.ok(/^[0-9a-f]{64}$/.test(published[0][1].publisherId),
    "the publish is addressed by the relay's own publisher root")
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
    contributeWatchedMedia: true,
    archiveEnabled: true,
    contributionBudgetBytes: 4096,
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

  // This fixture's publication carries no publicationId, so there is nothing
  // the relay can name in an archive request and none is published.
  t.alike(result, { published: true, previewVideos: 1, retained: 2, mirrorRequested: false })
  t.alike(calls.map(([name]) => name), ['publish', 'retain-rendition', 'retain-archive'])
  t.alike(calls.find(([name]) => name === 'publish')?.[1], {
    publisherId: 'a'.repeat(64),
    retentionClass: 'archive-pin'
  })
  t.alike(calls.find(([name]) => name === 'retain-rendition')?.[1], {
    manifest: { body: { publisherId: 'a'.repeat(64), renditions: [] } },
    renditionId: 'rendition-1',
    retentionClass: 'archive-pin'
  })
  t.is(service.catalog.getChannel('channel-1').publisherId, 'a'.repeat(64))
  await service.close()
})

test('relay archive command delegates to the v2 console ingest adapter', async (t) => {
  const storagePath = mkdtempSync(join(tmpdir(), 'peartube-cli-archive-command-'))
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))
  const calls = []
  const config = configFor(storagePath)
  config.archive.uiEnabled = true
  config.archive.uiHost = '127.0.0.1'
  config.archive.uiPort = 0
  const service = await createRelayService({
    config,
    logger,
    runtimeFactory: async () => fakeRuntime(calls),
    archiveConsoleFactory: async () => ({
      manager: {
        async enqueue(input) {
          calls.push(['archive-submit', input])
          return { id: 'ing_cli_1', jobId: 'ing_cli_1', status: 'queued' }
        }
      },
      async start() {},
      async close() {}
    }),
    writeStatusFile: async () => {},
    setIntervalFn: () => ({ unref: noop }),
    clearIntervalFn: noop
  })
  await service.start()
  const queued = await service.enqueueArchiveJob({ url: 'https://example.com/video.mp4' })
  t.is(queued.jobId, 'ing_cli_1')
  t.alike(calls.find(([name]) => name === 'archive-submit')?.[1], {
    url: 'https://example.com/video.mp4'
  })
  await service.close()
})

test('verified catalog rows receive playable resolution refs from provider search', async (t) => {
  const storagePath = mkdtempSync(join(tmpdir(), 'peartube-cli-verified-shelf-'))
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))
  const calls = []
  const runtime = fakeRuntime(calls)
  runtime.api.getMediaCatalog = async () => ({
    success: true,
    items: [{
      entityId: 'work-1',
      sources: [{
        publicationId: 'publication-1',
        renditionId: 'rendition-1',
        // A raw index candidate token rides the source from the backend. It
        // is NOT playable: provider.resolve refuses anything not minted by
        // its own lease store, so the enrichment must replace it.
        candidateRef: 'C'.repeat(43),
        mediaCoordinates: { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '603' }
      }]
    }],
    nextCursor: null
  })
  runtime.api.searchIndexCandidates = async () => {
    calls.push(['candidate-search'])
    return [{ candidateRef: 'C'.repeat(43), publication: { publicationId: 'publication-1' }, rendition: { renditionId: 'rendition-1' } }]
  }
  // The provider's own search mints resolution leases (`ref`). The raw index
  // candidate token is never playable - provider.resolve refuses it - so the
  // catalog enrichment must come from the provider search results, not the
  // index candidates the backend already attached.
  runtime.provider.search = async input => {
    calls.push(['provider-search', input.selector])
    return {
      candidates: [{
        schemaVersion: 1,
        kind: 'published',
        ref: 'A'.repeat(43),
        title: 'The Matrix',
        publicationId: 'publication-1',
        renditionId: 'rendition-1'
      }],
      nextCursor: null
    }
  }
  const service = await createRelayService({
    config: configFor(storagePath),
    logger,
    runtimeFactory: async () => runtime,
    writeStatusFile: async () => {},
    setIntervalFn: () => ({ unref: noop }),
    clearIntervalFn: noop
  })
  await service.start()
  const page = await service.getVerifiedMediaCatalog({ limit: 20 })
  t.is(page.items[0].candidateRef, 'A'.repeat(43), 'the provider lease reaches the row')
  t.is(page.items[0].sources[0].candidateRef, 'A'.repeat(43), 'the provider lease replaces the raw index token')
  t.is(calls.filter(([name]) => name === 'candidate-search').length, 0, 'the old index-token path stays dormant')
  t.alike(calls.find(([name]) => name === 'provider-search')?.[1], {
    namespace: 'tmdb',
    identifier: '603',
    kind: 'movie'
  })
  await service.close()
})

test('deterministic publication open warms the requested resume byte range', async (t) => {
  const storagePath = mkdtempSync(join(tmpdir(), 'peartube-cli-resume-warm-'))
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))
  const calls = []
  const runtime = fakeRuntime(calls)
  runtime.api.openMediaRenditionUrl = async () => ({
    success: true,
    publicationId: 'publication-1',
    renditionId: 'rendition-1',
    assetId: 'asset-1',
    byteLength: 1000,
    contentType: 'video/mp4',
    url: 'http://127.0.0.1:9000/blob'
  })
  runtime.api.openMediaRendition = async () => ({
    success: true,
    byteLength: 1000,
    async * read(range) {
      calls.push(['warm-range', { start: range.start, length: range.length }])
      yield b4a.alloc(range.length)
    },
    async close() {}
  })
  let companionService = null
  const config = configFor(storagePath)
  config.companion = { ...(config.companion || {}), enabled: true }
  const service = await createRelayService({
    config,
    logger,
    runtimeFactory: async () => runtime,
    companionServerFactory: async ({ service: liveService }) => {
      companionService = liveService
      return { async start() {}, async close() {} }
    },
    writeStatusFile: async () => {},
    setIntervalFn: () => ({ unref: noop }),
    clearIntervalFn: noop
  })
  await service.start()

  const opened = await companionService.openPublication({
    publicationId: 'publication-1',
    renditionId: 'rendition-1',
    startOffsetSeconds: 25,
    durationSeconds: 100,
    localTransport: true
  })

  t.is(opened.url, 'http://127.0.0.1:9000/blob')
  t.alike(calls.find(([name]) => name === 'warm-range')?.[1], { start: 250, length: 750 })
  await service.close()
})

test('deterministic publication open returns streamable asset lease when local transport is disabled', async (t) => {
  const storagePath = mkdtempSync(join(tmpdir(), 'peartube-cli-open-pub-remote-'))
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))
  const calls = []
  const runtime = fakeRuntime(calls)
  runtime.api.openMediaRendition = async () => ({
    success: true,
    publicationId: 'publication-1',
    renditionId: 'rendition-1',
    assetId: 'asset-1',
    byteLength: 1000,
    contentType: 'video/mp4',
    async * read(range) {
      calls.push(['read-range', { start: range.start, length: range.length }])
      yield b4a.alloc(range.length)
    },
    async close() {
      calls.push(['close'])
    }
  })
  let companionService = null
  const config = configFor(storagePath)
  config.companion = { ...(config.companion || {}), enabled: true }
  const service = await createRelayService({
    config,
    logger,
    runtimeFactory: async () => runtime,
    companionServerFactory: async ({ service: liveService }) => {
      companionService = liveService
      return { async start() {}, async close() {} }
    },
    writeStatusFile: async () => {},
    setIntervalFn: () => ({ unref: noop }),
    clearIntervalFn: noop
  })
  await service.start()

  const opened = await companionService.openPublication({
    publicationId: 'publication-1',
    renditionId: 'rendition-1',
    localTransport: false
  })

  t.is(opened.publicationId, 'publication-1')
  t.is(opened.renditionId, 'rendition-1')
  t.is(opened.assetId, 'asset-1')
  t.ok(opened.asset, 'asset lease is returned')
  t.is(opened.url, undefined, 'no loopback url is returned for remote transport')

  const range = await opened.asset.requestRange({ byteStart: 0, byteEnd: 100 })
  t.is(range.status, 'ok')
  t.is(range.verified, true)
  t.is(range.bytes.byteLength, 100)

  await service.close()
})
