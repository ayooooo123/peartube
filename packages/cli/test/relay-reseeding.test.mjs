// Relay re-seeding: a relay both asks the network to mirror what it publishes
// and mirrors what other relays publish, inside the storage guard's ceiling.
//
// Every fake here sits at the runtime seam (the injected backend context, or
// the injected runtime the service is built on), so nothing in this file needs
// a DHT, a swarm, or a real archive network.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import test from 'brittle'

import { parseArgv } from '../src/argv.js'
import { resolveRelayConfig } from '../src/config.js'
import { createRelayRuntime } from '../src/runtime.js'
import { createRelayService } from '../src/service.js'
import { RelayCatalog } from '../src/catalog.js'
import { buildRelayStatus, formatRelayStatus } from '../src/status.js'
import { measureVolumeBytes } from '../src/storage-guard.js'

const noop = () => {}
const logger = Object.fromEntries(
  ['relay', 'runtime', 'status', 'archive', 'admission', 'discovery', 'mirror', 'storage'].map((scope) => [
    scope,
    { info: noop, warn: noop, error: noop, debug: noop }
  ])
)

const PUBLICATION_ID = 'a'.repeat(64)
const RENDITION_ID = 'b'.repeat(64)
const CORE_KEY = 'c'.repeat(64)
const PUBLISHER_ID = 'd'.repeat(64)

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function manifestFor({ coreLength = 8, byteLength = 4096 } = {}) {
  return {
    publicationId: PUBLICATION_ID,
    body: {
      publisherId: PUBLISHER_ID,
      renditions: [{
        renditionId: RENDITION_ID,
        core: { key: CORE_KEY, length: coreLength, byteLength }
      }]
    }
  }
}

// A backend context that records every option it was constructed with and every
// archive call made through it. Participation state is kept exactly the way the
// permissionless network keeps it: capacity and reservations are separate
// numbers, and reservations are only ever changed by a pledge.
function fakeBackendFactory(captured, { reservedBytes = 0, evidence = [] } = {}) {
  const participation = {
    success: true,
    enabled: false,
    capacityBytes: 0,
    maxRequestBytes: 0,
    reservedBytes,
    availableBytes: 0,
    acceptedRequests: reservedBytes > 0 ? 1 : 0,
    knownRequests: 0,
    receivedPledges: 0,
    randomRejections: 0,
    capacityRejections: 0,
    authorizationRejections: 0,
    acceptancePermille: 0
  }
  return async (options) => {
    captured.options = options
    return {
      ctx: {
        permissionlessArchiveNetwork: {
          getOffloadEvidence(publicationId, locators) {
            captured.evidenceCalls.push({ publicationId, locators })
            return evidence
          }
        }
      },
      api: {
        async getScopedNetworkDiagnostics() { return { status: 'active', counters: {}, topics: [], sessions: [] } },
        async listBootstrapLocators() { return [] },
        async getArchiveParticipation() {
          return { ...participation }
        },
        async setArchiveParticipation(request) {
          captured.participationCalls.push(request)
          participation.enabled = request.enabled
          participation.capacityBytes = request.capacityBytes
          participation.maxRequestBytes = request.maxRequestBytes
          participation.acceptancePermille = request.acceptancePermille
          participation.availableBytes = Math.max(0, request.capacityBytes - participation.reservedBytes)
          return { ...participation }
        },
        async requestArchivePublication(request) {
          captured.archiveRequests.push(request)
          if (captured.archiveRequestResult instanceof Error) throw captured.archiveRequestResult
          return captured.archiveRequestResult ||
            { success: true, status: 'published', requestId: 'request-1' }
        },
        async setDeviceConditions(request) {
          captured.deviceConditions.push(request)
          return { success: true }
        },
        async getParticipationStatus() {
          captured.participationStatusCalls += 1
          return { success: true, state: 'eligible' }
        }
      },
      destroy: async () => { captured.destroyed = true }
    }
  }
}

function capture() {
  return {
    options: null,
    participationCalls: [],
    archiveRequests: [],
    evidenceCalls: [],
    deviceConditions: [],
    participationStatusCalls: 0,
    archiveRequestResult: null,
    destroyed: false
  }
}

function relayConfig(storagePath, overrides = {}) {
  return resolveRelayConfig({
    storage: { path: storagePath, maxBytes: 4096, minFreeBytes: 0 },
    archive: { enabled: false, uiEnabled: false, localMirror: { enabled: false } },
    classification: { tmdb: { enabled: false } },
    discovery: { enabled: false, seedDiscovered: false },
    seedPin: { enabled: true, trustedClients: [] },
    ...overrides
  }, { env: {} })
}

test('a relay comes up as an archivist and re-applies capacity from storage headroom', async (t) => {
  const dir = tempDir('peartube-reseed-runtime-')
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  const captured = capture()

  const runtime = await createRelayRuntime({
    config: relayConfig(dir),
    logger,
    dependencies: { createBackendContext: fakeBackendFactory(captured) }
  })
  t.teardown(() => runtime.close())

  t.is(captured.options.networkPolicy.retentionMode, 'archive-pledges',
    'the relay asks the backend for archive participation, not the shared "none" default')
  t.is(captured.options.networkPolicy.diskCeilingBytes, 4096,
    'the archive ceiling is the storage ceiling, not a second number')
  t.not(captured.options.archive, undefined)
  t.not(captured.options.archive.enabled, false)

  // Storage guard reports 3000 bytes of room and nothing is pledged yet.
  const applied = await runtime.applyArchiveCapacity({ headroomBytes: 3000 })
  t.is(applied.applied, true)
  t.alike(captured.participationCalls.at(-1), {
    enabled: true,
    capacityBytes: 3000,
    maxRequestBytes: 3000,
    acceptancePermille: 1000
  })
})

test('an explicit networkPolicy value still outranks the re-seeding default', async (t) => {
  const dir = tempDir('peartube-reseed-policy-')
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  const captured = capture()

  const runtime = await createRelayRuntime({
    config: relayConfig(dir, { networkPolicy: { retentionMode: 'none', uploadPermission: 'disabled' } }),
    logger,
    dependencies: { createBackendContext: fakeBackendFactory(captured) }
  })
  t.teardown(() => runtime.close())

  t.is(captured.options.networkPolicy.retentionMode, 'none')
  t.is(captured.options.networkPolicy.uploadPermission, 'disabled')
})

test('a relay at its storage ceiling declines new pledges without releasing the ones it holds', async (t) => {
  const dir = tempDir('peartube-reseed-ceiling-')
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  // 1024 bytes already pledged to peer relays, and no room left on disk.
  const captured = capture()

  const runtime = await createRelayRuntime({
    config: relayConfig(dir),
    logger,
    dependencies: { createBackendContext: fakeBackendFactory(captured, { reservedBytes: 1024 }) }
  })
  t.teardown(() => runtime.close())

  const applied = await runtime.applyArchiveCapacity({ headroomBytes: 0 })
  t.is(applied.applied, true)
  const call = captured.participationCalls.at(-1)

  // permissionless-network.js setParticipation releases EVERY local pledge when
  // the new capacity falls below what is already reserved
  // (`if (nextCapacity < locallyReservedBytes) await releaseLocalPledges()`).
  // A full disk must never be read as an instruction to abandon custody, so the
  // capacity handed down is floored at the reserved bytes.
  t.is(call.capacityBytes, 1024, 'capacity is floored at the bytes already pledged')
  t.is(call.enabled, true, 'a full relay keeps serving what it already holds')
  t.is(call.maxRequestBytes, 0)

  // And the ingest arithmetic the network applies to a new request
  // (`reserved + requestedBytes > capacityBytes` -> capacity-exceeded) rejects
  // everything at this ceiling, down to a single byte.
  t.ok(1024 + 1 > call.capacityBytes, 'the smallest possible new pledge is refused')

  // Headroom returning: capacity grows above the floor again.
  await runtime.applyArchiveCapacity({ headroomBytes: 512 })
  t.is(captured.participationCalls.at(-1).capacityBytes, 1536)
  t.is(captured.participationCalls.at(-1).maxRequestBytes, 512)
})

test('--no-reseed produces a runtime that never enables participation', async (t) => {
  const dir = tempDir('peartube-reseed-off-')
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))

  const { flags } = parseArgv(['run', '--no-reseed'])
  t.is(flags.noReseed, true)

  const config = relayConfig(dir, { reseed: { enabled: false } })
  t.is(config.reseed.enabled, false)

  const captured = capture()
  const runtime = await createRelayRuntime({
    config,
    logger,
    dependencies: { createBackendContext: fakeBackendFactory(captured, { reservedBytes: 1024 }) }
  })
  t.teardown(() => runtime.close())

  t.not(captured.options.networkPolicy.retentionMode, 'archive-pledges')

  const applied = await runtime.applyArchiveCapacity({ headroomBytes: 4096 })
  t.is(applied.applied, false)
  t.is(applied.reason, 'reseed-disabled')
  t.is(captured.participationCalls.length, 0,
    'turning re-seeding off never calls setArchiveParticipation, so live pledges are left exactly where they are')

  const requested = await runtime.requestArchiveMirror({
    publicationId: PUBLICATION_ID,
    renditionId: RENDITION_ID,
    locators: [{ coreKey: CORE_KEY, start: 0, end: 8 }]
  })
  t.is(requested.requested, false)
  t.is(requested.reason, 'reseed-disabled')
  t.is(captured.archiveRequests.length, 0)
})

test('a requested mirror is reported with the archivist evidence behind it', async (t) => {
  const dir = tempDir('peartube-reseed-evidence-')
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  const captured = capture()
  const backend = fakeBackendFactory(captured, {
    evidence: [
      { archivistId: 'e'.repeat(64), passed: true, recent: true, connected: true },
      { archivistId: 'f'.repeat(64), passed: true, recent: false, connected: false }
    ]
  })

  const runtime = await createRelayRuntime({
    config: relayConfig(dir),
    logger,
    dependencies: { createBackendContext: backend }
  })
  t.teardown(() => runtime.close())

  const locators = [{ coreKey: CORE_KEY, start: 0, end: 8 }]
  const requested = await runtime.requestArchiveMirror({
    publicationId: PUBLICATION_ID,
    renditionId: RENDITION_ID,
    locators
  })
  t.is(requested.requested, true)
  t.alike(captured.archiveRequests, [{ publicationId: PUBLICATION_ID, renditionId: RENDITION_ID }])

  const diagnostics = await runtime.getDiagnostics()
  t.is(diagnostics.archiveRequests.length, 1)
  const record = diagnostics.archiveRequests[0]
  t.is(record.publicationId, PUBLICATION_ID)
  t.is(record.renditionId, RENDITION_ID)
  t.is(record.status, 'published')
  t.is(record.archivists, 2)
  t.is(record.freshArchivists, 1, 'only a recent passed challenge counts as fresh evidence')
  t.alike(captured.evidenceCalls.at(-1), { publicationId: PUBLICATION_ID, locators })
  t.is(diagnostics.archiveParticipation.success, true)
})

test('a failed archive request is recorded and never fails the publication', async (t) => {
  const dir = tempDir('peartube-reseed-failure-')
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  const captured = capture()
  captured.archiveRequestResult = { success: false, status: 'failed', requestId: '', errorCode: 'ARCHIVE_REQUEST_FAILED' }

  const runtime = await createRelayRuntime({
    config: relayConfig(dir),
    logger,
    dependencies: { createBackendContext: fakeBackendFactory(captured) }
  })
  t.teardown(() => runtime.close())

  const requested = await runtime.requestArchiveMirror({
    publicationId: PUBLICATION_ID,
    renditionId: RENDITION_ID,
    locators: [{ coreKey: CORE_KEY, start: 0, end: 8 }]
  })
  t.is(requested.requested, false)
  t.is(requested.errorCode, 'ARCHIVE_REQUEST_FAILED')

  const diagnostics = await runtime.getDiagnostics()
  t.is(diagnostics.archiveRequests[0].status, 'failed')
  t.is(diagnostics.archiveRequests[0].errorCode, 'ARCHIVE_REQUEST_FAILED')
  t.is(diagnostics.archiveRequests[0].archivists, 0)

  // A throwing archive network is the same story: recorded, never raised.
  captured.archiveRequestResult = new Error('archive network is gone')
  const threw = await runtime.requestArchiveMirror({
    publicationId: PUBLICATION_ID,
    renditionId: RENDITION_ID,
    locators: [{ coreKey: CORE_KEY, start: 0, end: 8 }]
  })
  t.is(threw.requested, false)
  t.is(threw.errorCode, 'ARCHIVE_REQUEST_FAILED')
})

function serviceRuntime(calls, { mirrorResult = { requested: true, status: 'published' } } = {}) {
  return {
    ctx: {},
    api: {},
    identityManager: {},
    uploadManager: {},
    setCandidateHandler() {},
    async start() {},
    async close() {},
    async getDiagnostics() {
      return {
        network: {}, publisher: {}, bootstrap: {}, assets: {}, seedRetention: {}, archive: {}, storage: {},
        archiveRequests: [], archiveParticipation: {}
      }
    },
    async publishPublisherCatalog(request) { calls.push(['publish', request]); return { status: 'published' } },
    async retainRendition(request) { calls.push(['retain-rendition', request]); return { status: 'retained' } },
    async retainArchive(request) { calls.push(['retain-archive', request]); return { status: 'retained' } },
    async applyArchiveCapacity(request) { calls.push(['apply-capacity', request]); return { applied: true } },
    async requestArchiveMirror(request) {
      calls.push(['request-mirror', request])
      if (mirrorResult instanceof Error) throw mirrorResult
      return mirrorResult
    },
    async refreshAuthorization() { return true }
  }
}

function completedJob() {
  return {
    id: 'job-1',
    status: 'completed',
    publisherId: PUBLISHER_ID,
    channelKey: 'channel-1',
    completedAt: 1000,
    previewVideo: {
      id: 'video-1',
      title: 'A Title',
      immutablePublication: {
        publicationId: PUBLICATION_ID,
        renditionId: RENDITION_ID,
        manifest: manifestFor()
      }
    }
  }
}

test('publishing a rendition also asks the network to mirror it', async (t) => {
  const dir = tempDir('peartube-reseed-publish-')
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  const calls = []
  const service = await createRelayService({
    config: relayConfig(dir),
    logger,
    runtimeFactory: async () => serviceRuntime(calls),
    writeStatusFile: async () => {},
    setIntervalFn: () => ({ unref: noop }),
    clearIntervalFn: noop
  })
  t.teardown(() => service.close())

  const result = await service.publishArchiveJob(completedJob())
  t.is(result.published, true)

  const mirror = calls.find(([name]) => name === 'request-mirror')
  t.ok(mirror, 'the publish path asks for a mirror')
  t.is(mirror[1].publicationId, PUBLICATION_ID)
  t.is(mirror[1].renditionId, RENDITION_ID)
  t.alike(mirror[1].locators, [{ coreKey: CORE_KEY, start: 0, end: 8, renditionId: RENDITION_ID }],
    'the mirror request carries the same rendition core the relay just retained')

  const order = calls.map(([name]) => name)
  t.ok(order.indexOf('retain-rendition') < order.indexOf('request-mirror'),
    'nothing is offered for mirroring before this relay holds it')
})

test('a publication whose archive request fails is still published', async (t) => {
  const dir = tempDir('peartube-reseed-publish-fail-')
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  const calls = []
  const service = await createRelayService({
    config: relayConfig(dir),
    logger,
    runtimeFactory: async () => serviceRuntime(calls, { mirrorResult: new Error('archive network unavailable') }),
    writeStatusFile: async () => {},
    setIntervalFn: () => ({ unref: noop }),
    clearIntervalFn: noop
  })
  t.teardown(() => service.close())

  const result = await service.publishArchiveJob(completedJob())
  t.is(result.published, true, 'a mirror this relay cannot ask for is not a failed publication')
  t.is(result.mirrorRequested, false)
  t.ok(calls.some(([name]) => name === 'request-mirror'))
})

test('relay status reports both mirroring directions', async (t) => {
  const dir = tempDir('peartube-reseed-status-')
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  const catalog = await RelayCatalog.open({ storagePath: dir })
  const config = relayConfig(dir)

  const status = buildRelayStatus({
    config,
    catalog,
    runtimeStats: {
      archiveRequests: [
        { publicationId: PUBLICATION_ID, renditionId: RENDITION_ID, status: 'published', requestId: 'r1', requestedAt: 5, errorCode: null, archivists: 2, freshArchivists: 1 },
        { publicationId: 'e'.repeat(64), renditionId: 'f'.repeat(64), status: 'failed', requestId: '', requestedAt: 6, errorCode: 'ARCHIVE_REQUEST_FAILED', archivists: 0, freshArchivists: 0 }
      ],
      archiveParticipation: {
        success: true,
        enabled: true,
        capacityBytes: 4096,
        maxRequestBytes: 2048,
        reservedBytes: 1024,
        availableBytes: 3072,
        acceptedRequests: 3,
        knownRequests: 9,
        receivedPledges: 2,
        randomRejections: 1,
        capacityRejections: 4,
        authorizationRejections: 0,
        acceptancePermille: 1000
      }
    }
  })

  // Existing shape is preserved; the new fields are additions.
  t.ok(status.runtime.network)
  t.ok(status.runtime.assets)
  t.is(status.runtime.archiveRequests.length, 2)
  t.is(status.runtime.archiveParticipation.reservedBytes, 1024)

  const text = formatRelayStatus(status)
  t.ok(text.includes('archiveRequests: total=2 published=1 failed=1 withArchivistEvidence=1'), text)
  t.ok(text.includes('archiveMirroring: enabled=true reservedBytes=1024 availableBytes=3072 capacityBytes=4096 receivedPledges=2 acceptedRequests=3 rejected=capacity:4/random:1/authorization:0'), text)
  t.ok(text.includes(`- ${PUBLICATION_ID}/${RENDITION_ID} status=published archivists=2 fresh=1`), text)
  t.ok(text.includes(`- ${'e'.repeat(64)}/${'f'.repeat(64)} status=failed archivists=0 fresh=0 error=ARCHIVE_REQUEST_FAILED`), text)
})

test('a relay that has mirrored nothing says so without implying durability', async (t) => {
  const dir = tempDir('peartube-reseed-zero-')
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  const catalog = await RelayCatalog.open({ storagePath: dir })

  const status = buildRelayStatus({ config: relayConfig(dir), catalog, runtimeStats: {} })
  t.alike(status.runtime.archiveRequests, [])
  t.alike(status.runtime.archiveParticipation, {})

  const text = formatRelayStatus(status)
  t.ok(text.includes('archiveRequests: total=0 published=0 failed=0 withArchivistEvidence=0'), text)
  t.ok(text.includes('archiveMirroring: enabled=false reservedBytes=0 availableBytes=0 capacityBytes=0 receivedPledges=0 acceptedRequests=0 rejected=capacity:0/random:0/authorization:0'), text)
  t.absent(/durab|redundan|safe|backed up|protected by/i.test(text),
    'a relay with no archivist evidence never claims the content is kept anywhere else')
})

// The participation decision will not clear this machine to promise anyone
// durable storage until it has a real free-disk reading, so a relay reports
// its host volume. Exactly its host volume: the other OS signals are
// not-applicable on a server host, and the operator's byte budget is a
// different authority that applyArchiveCapacity already enforces.
const SYNTHESIZABLE_SIGNALS = ['metered', 'thermalState', 'batteryPercent', 'charging', 'backgroundPermitted']

function fakeStatfs({ bsize = 4096, bavail = 250_000, blocks = 1_000_000 } = {}) {
  return { statfsSync: () => ({ bsize, bavail, blocks }) }
}

test('a relay reports its measured host volume and no signal it did not measure', async (t) => {
  const dir = tempDir('peartube-reseed-disk-')
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  const captured = capture()

  const runtime = await createRelayRuntime({
    config: relayConfig(dir),
    logger,
    dependencies: { createBackendContext: fakeBackendFactory(captured), fs: fakeStatfs() }
  })
  t.teardown(() => runtime.close())
  await runtime.start()

  t.is(captured.deviceConditions.length, 1, 'the host volume is reported once at start')
  const reported = captured.deviceConditions[0]
  t.alike(Object.keys(reported).sort(), [
    'freeDiskBytes', 'freeDiskBytesProvided', 'totalDiskBytes', 'totalDiskBytesProvided'
  ], 'only the two measured disk fields are reported')
  for (const signal of SYNTHESIZABLE_SIGNALS) {
    t.absent(signal in reported, `${signal} is never synthesized to open the custody gate`)
  }
  // The volume's own numbers, straight off statfs — never storage.maxBytes,
  // which is 4096 in this config and answers a different question.
  t.is(reported.freeDiskBytes, 250_000 * 4096)
  t.is(reported.totalDiskBytes, 1_000_000 * 4096)
  t.is(reported.freeDiskBytesProvided, true)
  t.is(reported.totalDiskBytesProvided, true)

  // start() returning must mean a decision has been published, so the first
  // inbound archive request cannot land while there is none.
  t.is(captured.participationStatusCalls, 1)

  const diagnostics = await runtime.getDiagnostics()
  t.alike(diagnostics.archiveHostDisk, {
    measured: true,
    reason: null,
    freeBytes: 250_000 * 4096,
    totalBytes: 1_000_000 * 4096
  })
})

test('a volume under the free-disk floor is reported exactly as measured', async (t) => {
  const dir = tempDir('peartube-reseed-disk-low-')
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  const captured = capture()

  // 4 MiB free on a 4 GiB volume: far under the decision's floor of
  // max(2 GiB, 10% of total). Reporting it honestly is what makes the decision
  // refuse custody with DISK_BELOW_FLOOR; clamping or omitting it would instead
  // read as "unknown" and hide a full disk behind a missing signal.
  const runtime = await createRelayRuntime({
    config: relayConfig(dir),
    logger,
    dependencies: {
      createBackendContext: fakeBackendFactory(captured),
      fs: fakeStatfs({ bsize: 4096, bavail: 1024, blocks: 1_048_576 })
    }
  })
  t.teardown(() => runtime.close())
  await runtime.start()

  t.is(captured.deviceConditions.length, 1)
  t.is(captured.deviceConditions[0].freeDiskBytes, 4 * 1024 * 1024)
  t.is(captured.deviceConditions[0].totalDiskBytes, 4 * 1024 * 1024 * 1024)
  const diagnostics = await runtime.getDiagnostics()
  t.is(diagnostics.archiveHostDisk.measured, true)
})

test('a host that cannot measure its disk reports nothing and says why', async (t) => {
  const dir = tempDir('peartube-reseed-disk-none-')
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  const captured = capture()
  const warnings = []
  const warnLogger = {
    ...logger,
    runtime: { ...logger.runtime, warn: (message, detail) => warnings.push([message, detail]) }
  }

  // Bare's `#fs` exports no statfsSync. A relay there must not promise anyone
  // durable storage, and must not paper over the gap with an estimate.
  const runtime = await createRelayRuntime({
    config: relayConfig(dir),
    logger: warnLogger,
    dependencies: { createBackendContext: fakeBackendFactory(captured), fs: {} }
  })
  t.teardown(() => runtime.close())
  await runtime.start()

  t.is(captured.deviceConditions.length, 0, 'an unmeasurable disk is reported as nothing, never as a number')
  t.is(captured.participationStatusCalls, 1, 'the boot barrier still runs; the answer is just "no custody"')
  const diagnostics = await runtime.getDiagnostics()
  t.alike(diagnostics.archiveHostDisk, {
    measured: false,
    reason: 'statfs-unavailable',
    freeBytes: null,
    totalBytes: null
  })
  t.ok(warnings.some(([message]) => /will not take archive pledges/.test(message)),
    'the operator is told why their relay is not pledging')

  const catalog = await RelayCatalog.open({ storagePath: dir })
  const text = formatRelayStatus(buildRelayStatus({
    config: relayConfig(dir),
    catalog,
    runtimeStats: diagnostics
  }))
  t.ok(text.includes('archiveHostDisk: measured=false freeBytes=unknown totalBytes=unknown reason=statfs-unavailable'), text)
})

test('a statfs that reports free blocks but no total leaves custody unknown', async (t) => {
  const dir = tempDir('peartube-reseed-disk-partial-')
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  const captured = capture()

  // The decision's floor is max(2 GiB, 10% of total), so a free reading with no
  // total cannot be judged. It stays unknown rather than being measured against
  // a guess -- and the storage guard's own free-disk floor, which needs only
  // the first number, keeps working off the same reading.
  const runtime = await createRelayRuntime({
    config: relayConfig(dir),
    logger,
    dependencies: {
      createBackendContext: fakeBackendFactory(captured),
      fs: { statfsSync: () => ({ bsize: 4096, bavail: 100 }) }
    }
  })
  t.teardown(() => runtime.close())
  await runtime.start()

  t.is(captured.deviceConditions.length, 0)
  t.is((await runtime.getDiagnostics()).archiveHostDisk.reason, 'statfs-unavailable')
  t.is(measureVolumeBytes({ storagePath: dir, statfsSync: () => ({ bsize: 4096, bavail: 100 }) }).freeBytes,
    409_600, 'the free-disk floor still gets its number')
})
