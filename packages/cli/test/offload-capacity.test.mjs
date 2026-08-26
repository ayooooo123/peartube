import { mkdtempSync, rmSync } from 'node:fs'
import * as realFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import test from 'brittle'
import b4a from 'b4a'

import { resolveRelayConfig } from '../src/config.js'
import { createRelayService } from '../src/service.js'

// A relay with block offload holds its archive in a bucket and keeps one window
// of block data on its own volume. Its capacity accounting did not know that:
// every archived byte was counted as a byte of this disk, so the ceiling handed
// to the archive network was the volume's headroom and a relay with a 1 TiB
// budget on a 32 MiB volume could pledge 32 MiB. These tests hold the new line
// in both directions — the disk stops bounding the archive, the window does not
// stop bounding the disk — and pin the offload-off path to exactly what it was.

// The backend's asset block size, and the bound a bounded ingest is held to:
// one window plus the two blocks in flight, plus ~128 bytes of merkle
// bookkeeping per block (storage-guard.js, boundedIngestBytes).
const BLOCK = 256 * 1024
const WINDOW = 8 * 1024 * 1024
const IDLE_WORKING_SET = WINDOW + (2 * BLOCK)
const TITLE = 4 * 1024 ** 3
const TITLE_FOOTPRINT = IDLE_WORKING_SET + ((TITLE / BLOCK) * 128)

// A volume far too small for the archive it is about to admit, and an operator
// budget three orders of magnitude larger than it.
const DISK = 32 * 1024 * 1024
const ARCHIVE_BUDGET = 1024 ** 4
const ALREADY_ARCHIVED = 64 * 1024 ** 3
const REMAINING_BUDGET = ARCHIVE_BUDGET - ALREADY_ARCHIVED

// What the volume can carry, derived the way admission derives it: the window
// and the two blocks in flight are fixed, and each remaining 128 bytes of
// headroom buys one more block of title. This is the ceiling a pledge has to
// respect — a relay that pledges past it is pledging work it will refuse.
const MAX_ADMISSIBLE_TITLE = Math.floor((DISK - IDLE_WORKING_SET) / 128) * BLOCK

// A volume with room for the bookkeeping of the whole remaining budget, so the
// budget is what binds and the pledge is the budget.
const ROOMY_DISK = 4 * 1024 ** 3

const noop = () => {}
const logger = Object.fromEntries(
  ['relay', 'runtime', 'status', 'archive', 'admission', 'discovery', 'mirror', 'storage'].map((scope) => [
    scope,
    { info: noop, warn: noop, error: noop, debug: noop }
  ])
)

const S3 = {
  enabled: true,
  endpoint: 'https://s3.example.com',
  bucket: 'peartube-archive',
  accessKeyId: 'AKIA-TEST',
  secretAccessKey: 'secret',
  offloadWindowBytes: WINDOW
}

// Consent is already in place, because these tests are about what happens after
// the operator has said yes: 1 TiB of archive budget, 64 GiB of it spent.
function fakeRuntime (capacityCalls) {
  const policy = {
    policyVersion: 2,
    consentVersion: 1,
    migrationRequired: false,
    contributeWatchedMedia: true,
    archiveEnabled: true,
    contributionBudgetBytes: ARCHIVE_BUDGET,
    archiveBudgetBytes: ARCHIVE_BUDGET,
    uploadPermission: 'enabled',
    uploadCeilingBytes: ARCHIVE_BUDGET,
    effectiveRole: 'archive-enabled',
    permissions: { contribute: true, archive: true }
  }
  return {
    ctx: {
      metaDb: null,
      networkPolicyRuntime: { getPolicy: () => ({ ...policy }) }
    },
    api: {
      async setNetworkPolicy (next) { return { success: true, policy: { ...policy, ...next } } },
      async provisionPublisherCatalog ({ publisherId }) {
        return {
          success: true,
          publisherId,
          catalogBootstrapKey: b4a.alloc(32, 7),
          localWriterKey: b4a.alloc(32, 8),
          localSignerKey: b4a.alloc(32, 9),
          writable: true,
          namespaceInitialized: true,
          admitted: true,
          errorCode: null
        }
      }
    },
    identityManager: {},
    uploadManager: {},
    seedingManager: {
      getRetentionBudgetStatus: () => ({ contributionUsedBytes: 0, archiveUsedBytes: ALREADY_ARCHIVED })
    },
    setCandidateHandler: noop,
    async start () {},
    async close () {},
    async getDiagnostics () { return {} },
    async publishPublisherCatalog () { return { status: 'published' } },
    async applyArchiveCapacity (request) { capacityCalls.push(request); return { applied: true } }
  }
}

function configFor (storagePath, { offload, maxBytes, minFreeBytes }) {
  return resolveRelayConfig({
    storage: { path: storagePath, maxBytes, minFreeBytes },
    archive: {
      enabled: false,
      uiEnabled: false,
      localMirror: { enabled: false },
      s3: { ...S3, offload }
    },
    companion: { enabled: false },
    classification: { tmdb: { enabled: false } },
    discovery: { enabled: false, seedDiscovered: false },
    seedPin: { enabled: true, trustedClients: [] }
  }, { env: {} })
}

// The relay's volume, simulated: one file of `usedBytes` under the storage
// directory and a chosen amount of free space, so the guard measures the disk
// each test describes rather than whatever the machine running it has. Every
// other call is the real fs — the relay writes a real catalog, a real creators
// DB and a real publisher root into the temp directory below.
function simulatedVolume (storagePath, { usedBytes, freeBytes }) {
  const marker = `${storagePath}/__simulated_volume__`
  return {
    ...realFs,
    statfsSync (target) {
      if (target !== storagePath) return realFs.statfsSync(target)
      return { bsize: 512, bavail: freeBytes / 512 }
    },
    readdirSync (target, options) {
      if (target !== storagePath) return realFs.readdirSync(target, options)
      return [{ name: '__simulated_volume__', isDirectory: () => false }]
    },
    statSync (target, options) {
      if (target !== marker) return realFs.statSync(target, options)
      return { blocks: usedBytes / 512, size: usedBytes, dev: 1 }
    }
  }
}

// A runtime that cannot measure this volume at all: no statfs and no way to
// walk the storage directory. Bare's `#fs` shipped exactly this shape for the
// whole life of the project, so it is the ordinary case rather than an exotic
// one. Only the three primitives the storage guard reads are withheld; every
// other call is the real fs, so the relay still writes its real catalog.
function unmeasurableVolume () {
  return { ...realFs, statfsSync: undefined, readdirSync: undefined, statSync: undefined }
}

async function relay (t, {
  offload,
  usedBytes = 0,
  freeBytes = 64 * 1024 ** 3,
  maxBytes = DISK,
  minFreeBytes = 0,
  unmeasurable = false
} = {}) {
  const storagePath = mkdtempSync(join(tmpdir(), 'pt-offload-capacity-'))
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))
  const config = configFor(storagePath, { offload, maxBytes, minFreeBytes })
  const capacityCalls = []
  const service = await createRelayService({
    config,
    logger,
    runtimeFactory: async () => fakeRuntime(capacityCalls),
    fsModule: unmeasurable
      ? unmeasurableVolume()
      : simulatedVolume(config.storage.path, { usedBytes, freeBytes }),
    writeStatusFile: async () => {},
    setIntervalFn: () => ({ unref: noop }),
    clearIntervalFn: noop
  })
  t.teardown(() => service.close())
  return { service, capacityCalls }
}

const archiveRequest = { retentionClass: 'archive-pin', expected: { byteLength: TITLE } }

test('an offloading relay admits an archive its own volume could never hold', async (t) => {
  t.ok(TITLE > DISK, 'the title alone is over a hundred times the volume')
  t.ok(TITLE_FOOTPRINT < DISK, 'but what it costs the volume is one window plus its merkle tree')

  const { service } = await relay(t, { offload: true })

  t.is(service.canArchive(), true, 'the relay is open for archive work')
  t.is(service.canIngest(archiveRequest), true,
    'a 4 GiB title is admitted onto a 32 MiB volume that already holds 64 GiB of archive')

  const capacity = service.getStatus().capacity
  t.is(capacity.localHeadroomBytes, DISK, 'the volume still reports the 32 MiB it actually has')
  t.is(capacity.effectiveCapacityBytes, MAX_ADMISSIBLE_TITLE,
    'and capacity is the largest title this volume can carry for the bucket, not what it can hold')
  t.ok(capacity.effectiveCapacityBytes > capacity.localHeadroomBytes * 1000,
    'which is three orders of magnitude past the disk')
  t.ok(capacity.effectiveCapacityBytes < REMAINING_BUDGET,
    'and short of the operator budget, because on this volume the disk is what binds')
})

test('the window still has to fit, so a volume too small for one refuses', async (t) => {
  const tooSmall = 4 * 1024 * 1024
  t.ok(tooSmall < IDLE_WORKING_SET, 'four megabytes cannot hold an eight megabyte window')

  const { service } = await relay(t, { offload: true, maxBytes: tooSmall })

  t.is(service.storageGuard.snapshot().ok, true,
    'the aggregate guard is happy: nothing is over budget and no floor is breached')
  t.is(service.canArchive(), false, 'but the ingest has nowhere to keep its window, so it is refused')
  t.is(service.canIngest(archiveRequest), false, 'and so is the title behind it')
  t.is(service.getStatus().capacity.effectiveCapacityBytes, 0,
    'a relay that cannot hold a window pledges nothing, however large its budget')
})

test('a genuinely full volume still refuses an offloading ingest', async (t) => {
  const full = await relay(t, { offload: true, usedBytes: DISK })
  t.is(full.service.storageGuard.snapshot().overBudget, true, 'the volume is at its ceiling')
  t.is(full.service.canIngest(archiveRequest), false, 'and the bucket does not excuse it')

  const lowDisk = await relay(t, {
    offload: true,
    freeBytes: 1024 ** 3,
    minFreeBytes: 4 * 1024 ** 3
  })
  t.is(lowDisk.service.storageGuard.snapshot().lowDisk, true, 'free disk is under the operator floor')
  t.is(lowDisk.service.canIngest(archiveRequest), false, 'and the floor is not relaxed by offload')
  t.is(lowDisk.service.getStatus().capacity.effectiveCapacityBytes, 0, 'nor is the capacity it reports')
})

test('with offload off, admission is byte-for-byte the decision it was', async (t) => {
  // Every cell is the pre-change rule: the storage guard's boundary, and then
  // the retention budget — which permits throughout, since 64 GiB + 4 GiB is
  // far inside 1 TiB. Nothing here may consult the window or the title.
  const scenarios = [
    { name: 'room to spare', setup: {} },
    { name: 'a volume smaller than one window', setup: { maxBytes: 4 * 1024 * 1024 } },
    { name: 'a full volume', setup: { usedBytes: DISK } },
    { name: 'free disk under the floor', setup: { freeBytes: 1024 ** 3, minFreeBytes: 4 * 1024 ** 3 } }
  ]

  const decisions = []
  for (const scenario of scenarios) {
    const { service } = await relay(t, { offload: false, ...scenario.setup })
    const guardOk = service.storageGuard.snapshot().ok
    t.is(service.canIngest(archiveRequest), guardOk,
      `${scenario.name}: admission is exactly the storage guard plus the budget`)
    t.is(service.canArchive(), guardOk, `${scenario.name}: and so is the archive probe`)
    const capacity = service.getStatus().capacity
    t.is(capacity.effectiveCapacityBytes, capacity.localHeadroomBytes,
      `${scenario.name}: capacity is still the volume's headroom and nothing else`)
    decisions.push(service.canIngest(archiveRequest))
  }

  t.alike(decisions, [true, true, false, false],
    'a small volume admits the title without offload, exactly as it does today')
})

test('the archive network is handed the effective capacity, not the disk', async (t) => {
  const offloading = await relay(t, { offload: true })
  await offloading.service.start()
  t.is(offloading.capacityCalls.at(-1)?.headroomBytes, MAX_ADMISSIBLE_TITLE,
    'an offloading relay pledges the largest archive its volume can carry')

  const roomy = await relay(t, { offload: true, maxBytes: ROOMY_DISK })
  await roomy.service.start()
  t.is(roomy.capacityCalls.at(-1)?.headroomBytes, REMAINING_BUDGET,
    'and once the volume can carry the bookkeeping of the whole budget, it pledges the budget')

  const local = await relay(t, { offload: false })
  await local.service.start()
  t.is(local.capacityCalls.at(-1)?.headroomBytes, DISK,
    'and a local-only relay pledges against its volume, unchanged')
})

// The invariant the pledge exists to keep. Capacity is an offer to the archive
// network, and an offer the relay will refuse is worse for the network than a
// smaller honest one: a peer sends the title, the relay declines it, and the
// title has to find another home having already cost a round trip. So the
// pledged number is required to be a title admission actually takes.
test('a relay never advertises capacity its own admission would refuse', async (t) => {
  for (const maxBytes of [DISK, ROOMY_DISK, 16 * 1024 * 1024, IDLE_WORKING_SET + (128 * BLOCK)]) {
    const { service } = await relay(t, { offload: true, maxBytes })
    const pledged = service.getStatus().capacity.effectiveCapacityBytes

    t.is(service.canIngest({ retentionClass: 'archive-pin', expected: { byteLength: pledged } }), true,
      `${maxBytes} byte volume: a title of exactly the pledged size is admitted`)
    t.is(service.canIngest({ retentionClass: 'archive-pin', expected: { byteLength: pledged + BLOCK } }), false,
      `${maxBytes} byte volume: and a block past it is refused — the pledge is the boundary itself, ` +
      'whichever of the volume and the budget drew it')
  }
})

// `null` is not zero. A capacity field that reads 0 says the operator has run
// out of volume; one that reads null says this runtime could not tell. Bare's
// `#fs` has no statfs, so the second case is the ordinary one on a real relay,
// and `Number(null)` being 0 is exactly how it came out looking like the first.
test('a signal this runtime cannot measure serialises as null, not as a measured zero', async (t) => {
  const { service } = await relay(t, { offload: false, unmeasurable: true })

  t.is(service.storageGuard.snapshot().enabled, false, 'the guard measures neither signal here')
  const capacity = service.getStatus().capacity
  t.is(capacity.localUsedBytes, null, 'bytes on the volume are unknown, not zero')
  t.is(capacity.localFreeBytes, null, 'free bytes are unknown, not zero')
  t.is(capacity.localHeadroomBytes, null, 'headroom is unknown, not zero')
  t.is(capacity.effectiveCapacityBytes, null, 'and capacity is unknown, not a relay with nothing left')

  const parsed = JSON.parse(JSON.stringify(service.getStatus())).capacity
  t.alike(parsed, {
    localUsedBytes: null,
    localFreeBytes: null,
    localHeadroomBytes: null,
    effectiveCapacityBytes: null
  }, 'the written status file keeps every unmeasured reading null through JSON')
})

test('the status file reports local capacity without inventing bucket inventory', async (t) => {
  const { service } = await relay(t, { offload: true })
  const status = service.getStatus()

  t.is(status.blockOffload.enabled, true, 'the status file says offload is on')
  t.is(status.blockOffload.residentBytes, 0, 'and reports what the offload-backed cores hold locally')
  t.alike(Object.keys(status.capacity).sort(), [
    'effectiveCapacityBytes',
    'localFreeBytes',
    'localHeadroomBytes',
    'localUsedBytes'
  ], 'capacity contains only measured local signals and the admission ceiling')
  t.is(status.capacity.localUsedBytes, 0, 'nothing is on the volume yet')
  t.absent(Object.hasOwn(status.blockOffload, 'uploadedBytes'), 'temporary writes are not exposed as durable inventory')
  t.absent(Object.hasOwn(status.blockOffload, 'bytesOffloaded'), 'restart-scoped totals are not exposed as durable inventory')

  const serialized = JSON.stringify(status)
  for (const secret of [S3.bucket, S3.accessKeyId, S3.secretAccessKey, S3.endpoint]) {
    t.absent(serialized.includes(secret), 'the widened status file still names no bucket or credential')
  }
})
