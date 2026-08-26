import test from 'brittle'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createGrantedRangedSource } from '../src/archive-manager.js'
import { createIngestJobStore } from '../src/companion/ingest-job-store.js'
import { createIngestManager } from '../src/companion/ingest-manager.js'
import { SourceCallbackError } from '../src/companion/source-client.js'

// The last hop of resumable ingest, on the relay side: a granted title is read
// as ranges straight into the asset core and never lands on the volume, the
// staged prefix it leaves behind is named by the ingest job id, and a job that
// ends for good hands that prefix back.
//
// What a staged prefix IS, and that reclaiming one really empties the bucket, is
// proven against a real corestore in backend/test/resumable-upload.test.mjs.
// What is proven here is the wiring: which job ids the sweep is handed, which it
// is never handed, and when reclamation is invoked at all.

const NOW = 1_786_406_400_000
const ETAG = '"remote-sha256-0123456789abcdef"'
const CAPABILITY = 'source-capability-granted-staging-00000001'

function sha256 (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function movieRequest (bytes, identifier = '603') {
  return {
    retentionClass: 'archive-pin',
    mediaContext: { kind: 'movie', namespace: 'tmdb', identifier },
    measuredFacts: { title: 'The Matrix', byteLength: bytes.byteLength, container: 'mkv' },
    // No whole-file digest: a debrid-backed title cannot state one without being
    // pulled through client application first, so the ETag is its identity.
    expected: { byteLength: bytes.byteLength, etag: ETAG }
  }
}

function fakeBee () {
  const map = new Map()
  const clone = value => JSON.parse(JSON.stringify(value))
  return {
    map,
    async get (key) { return map.has(key) ? { value: clone(map.get(key)) } : null },
    batch () {
      const operations = []
      return {
        async put (key, value) { operations.push(['put', key, clone(value)]) },
        async del (key) { operations.push(['del', key]) },
        async flush () {
          for (const [operation, key, value] of operations) {
            if (operation === 'put') map.set(key, value)
            else map.delete(key)
          }
        }
      }
    },
    async * createReadStream ({ gte, lt }) {
      for (const key of [...map.keys()].sort()) {
        if (key >= gte && key < lt) yield { key, value: clone(map.get(key)) }
      }
    }
  }
}

function fakePublisher () {
  const videos = new Map()
  const ingested = []
  const grants = []
  return {
    ingested,
    grants,
    async ensureAnonymousChannel () {
      return {
        channel: { async getVideo (videoId) { return videos.get(videoId) || null } },
        channelKey: 'c'.repeat(64),
        publicBeeKey: 'b'.repeat(64),
        publisherId: 'a'.repeat(64)
      }
    },
    async importVideo ({ videoId, sourceGrant, filePath, mimeType }) {
      grants.push({ videoId, sourceGrant, filePath, mimeType })
      if (sourceGrant) {
        const source = createGrantedRangedSource(sourceGrant)
        const chunks = []
        for await (const chunk of source.open(0)) chunks.push(Buffer.from(chunk))
        ingested.push(Buffer.concat(chunks))
      }
      const metadata = {
        id: videoId,
        immutablePublication: {
          publicationId: sha256(Buffer.from(`publication:${videoId}`)),
          manifestId: sha256(Buffer.from(`manifest:${videoId}`)),
          renditionId: sha256(Buffer.from(`rendition:${videoId}`)),
          assetId: sha256(Buffer.from(`asset:${videoId}`)),
          coreKey: sha256(Buffer.from(`core:${videoId}`))
        }
      }
      videos.set(videoId, metadata)
      return { metadata }
    },
    async publishCatalog () {},
    async retainAssets () {}
  }
}

function stubSourceClient (bytes, { failWith = null, failAfterBytes = 0, gate = null } = {}) {
  const ranges = []
  let armed = failWith !== null
  return {
    ranges,
    chunkBytes: 4,
    async head () {
      return { length: bytes.byteLength, etag: ETAG, mimeType: 'video/x-matroska' }
    },
    async getRange ({ start, end, onChunk }) {
      if (armed && start >= failAfterBytes) {
        armed = false
        throw failWith
      }
      ranges.push(`bytes=${start}-${end}`)
      onChunk(bytes.subarray(start, end + 1), 0)
      if (gate !== null && start === 0) await gate.promise
      return end - start + 1
    },
    async revoke () { return true }
  }
}

/**
 * Just enough of a corestore for the real `reclaimStagingState` to run against:
 * a staging core per derived name, which the test uses to see WHICH core a
 * reclamation opened and whether it was removed. The names are opaque hashes of
 * the resume id, so what is asserted is their stability and distinctness, not
 * their spelling.
 */
function fakeAssetStore () {
  const cores = new Map()
  const opened = []
  return {
    cores,
    opened,
    async createKeyPair (name) { return { publicKey: name, secretKey: name } },
    get ({ keyPair }) {
      const name = keyPair.publicKey
      opened.push(name)
      let core = cores.get(name)
      if (core === undefined) {
        core = {
          name,
          length: 0,
          closed: false,
          removed: false,
          async ready () {},
          async getUserData () { return null },
          async setUserData () {},
          async close () { core.closed = true },
          core: {
            async close () {},
            state: {
              storage: {
                store: { async deleteCore () { core.removed = true } },
                core: {}
              }
            }
          }
        }
        cores.set(name, core)
      }
      core.closed = false
      return core
    }
  }
}

function fakeStagingStores () {
  const opened = []
  return {
    opened,
    create ({ core }) {
      opened.push(core.name)
      return {
        async put () {},
        async has () { return false },
        async get () { return null },
        async purge () { return { deleted: 0 } }
      }
    }
  }
}

function harness (t, { client, canIngest = () => true, staging = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'peartube-granted-staging-'))
  t.teardown(() => rmSync(root, { recursive: true, force: true }))
  const bee = fakeBee()
  const store = createIngestJobStore({ bee, now: () => NOW })
  const publisher = fakePublisher()
  const spoolRoot = join(root, 'spool')
  const assetStore = fakeAssetStore()
  const stagingStores = fakeStagingStores()
  const manager = createIngestManager({
    store,
    publisher,
    spoolRoot,
    sourceClient: client,
    assetStore: staging ? assetStore : null,
    createStagingStore: staging ? stagingStores.create : null,
    canIngest,
    verifyChunkBytes: 4,
    now: () => NOW
  })
  return { manager, store, publisher, spoolRoot, assetStore, stagingStores }
}

async function waitForState (manager, jobId, state) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const job = await manager.getJob(jobId)
    if (job?.state === state) return job
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`job ${jobId} did not reach ${state}`)
}

// Every regular file under a directory tree, so "no title-sized copy anywhere"
// is measured rather than assumed from one directory listing.
function filesUnder (directory) {
  const found = []
  let entries
  try {
    entries = readdirSync(directory)
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) found.push(...filesUnder(path))
    else found.push(path)
  }
  return found
}

test('a granted ingest publishes the whole title without putting a byte of it on the volume', async (t) => {
  const bytes = Buffer.from('abcdefghijkl')
  const client = stubSourceClient(bytes)
  const { manager, publisher, spoolRoot } = harness(t, { client })
  t.teardown(() => manager.close())
  await manager.start()

  const job = await manager.submitJob({
    idempotencyKey: 'granted-streams-through',
    request: movieRequest(bytes),
    sourceCapability: CAPABILITY
  })
  const completed = await waitForState(manager, job.jobId, 'completed')

  t.is(completed.bytesReceived, bytes.byteLength, 'the whole title was read')
  t.alike(publisher.ingested[0], bytes, 'and reached the publisher byte-exact')
  t.alike(
    client.ranges,
    ['bytes=0-3', 'bytes=4-7', 'bytes=8-11'],
    'as ranges asked for one at a time, in order, exactly once each'
  )

  // Requirement of the whole feature: a 60 GB remux must not need 60 GB of
  // local disk. Nothing was spooled, so the spool tree holds no files at all.
  t.alike(filesUnder(spoolRoot), [], 'no file of any size was staged on the volume')

  // The grant reached the publisher whole, with the job id doing double duty as
  // the resume id, so a staged prefix is findable again after a restart.
  const grant = publisher.grants[0]
  t.is(grant.sourceGrant.jobId, job.jobId, 'the ingest job id is what names the staging core')
  t.is(grant.sourceGrant.etag, ETAG, 'the grant ETag travels as the source identity')
  t.is(grant.sourceGrant.length, bytes.byteLength, 'with the grant\'s authoritative total length')
  t.is(grant.filePath, undefined, 'and no file path, because there is no file')
  t.is(grant.mimeType, 'video/x-matroska', 'the media type came from the grant')
})

test('the ranged opener asks only for what is missing, and for nothing at all at the end', async (t) => {
  const bytes = Buffer.from('abcdefghijkl')
  const client = stubSourceClient(bytes)
  const source = createGrantedRangedSource({
    client,
    capability: CAPABILITY,
    jobId: 'ing_opener',
    etag: ETAG,
    length: bytes.byteLength
  })

  const tail = []
  for await (const chunk of source.open(8)) tail.push(Buffer.from(chunk))
  t.alike(Buffer.concat(tail), bytes.subarray(8), 'opening at an offset yields the remainder')
  t.alike(client.ranges, ['bytes=8-11'], 'having asked for that remainder and nothing before it')

  // The attempt whose download finished and then died before the core was
  // sealed. There is nothing left to ask for, and asking would be a 416 against
  // a grant that is behaving perfectly correctly.
  const nothing = []
  for await (const chunk of source.open(bytes.byteLength)) nothing.push(chunk)
  t.is(nothing.length, 0, 'opening at the total length yields nothing')
  t.alike(client.ranges, ['bytes=8-11'], 'and asks the grant for nothing')

  t.is(source.id, 'ing_opener', 'the resume id is the job id')
  t.is(source.resumable, true, 'and a grant with no whole-file digest is resumable')
})

test('the staging sweep plan covers every durable job, keeps the unsettled, and never names a running one', async (t) => {
  const bytes = Buffer.from('abcdefghijkl')
  let release = null
  const gate = { promise: new Promise(resolve => { release = resolve }) }
  const client = stubSourceClient(bytes, { gate })
  const { manager, store } = harness(t, { client })
  t.teardown(() => manager.close())
  await manager.start()

  // Settled: cancelled before it ever ran, so it owns nothing a retry wants.
  const abandoned = await manager.submitJob({
    idempotencyKey: 'sweep-abandoned',
    request: movieRequest(bytes, '101'),
    sourceCapability: CAPABILITY
  })
  await manager.cancelJob(abandoned.jobId)

  // Unsettled: queued with nothing attached, so it never scheduled and its
  // staging state must survive a sweep.
  const queued = await manager.submitJob({
    idempotencyKey: 'sweep-queued',
    request: movieRequest(bytes, '102')
  })

  // Running: gated inside its first range, so it is mid-ingest right now.
  const running = await manager.submitJob({
    idempotencyKey: 'sweep-running',
    request: movieRequest(bytes, '103'),
    sourceCapability: 'source-capability-granted-staging-00000002'
  })
  await waitForState(manager, running.jobId, 'publishing')

  const plan = await manager.stagingSweepPlan()

  t.ok(plan.ids.includes(abandoned.jobId), 'the settled job is offered to the sweep')
  t.ok(plan.ids.includes(queued.jobId), 'so is the unsettled one')
  t.absent(plan.keep.includes(abandoned.jobId), 'but only the settled one may be reclaimed')
  t.ok(plan.keep.includes(queued.jobId), 'the unsettled one is kept')

  // The guarantee that matters: reading a staged length that is being appended
  // to is not reading a length at all, so a running ingest is left out of the
  // set entirely rather than merely spared inside it.
  t.absent(plan.ids.includes(running.jobId), 'the running job is not offered to the sweep at all')
  t.absent(plan.keep.includes(running.jobId), 'nor named in the keep list')

  release()
  await waitForState(manager, running.jobId, 'completed')

  // Once it has settled it becomes reclaimable like any other finished job.
  const after = await manager.stagingSweepPlan()
  t.ok(after.ids.includes(running.jobId), 'and is offered once it has settled')
  t.absent(after.keep.includes(running.jobId), 'as a job nothing will come back for')
  t.is(after.ids.length, (await store.listJobIds()).length, 'with every durable job id accounted for')
})

test('a cancelled job hands its staging state back; an interrupted one keeps it', async (t) => {
  const bytes = Buffer.from('abcdefghijkl')
  const client = stubSourceClient(bytes)
  const { manager, assetStore, stagingStores } = harness(t, { client })
  t.teardown(() => manager.close())
  await manager.start()

  const cancelled = await manager.submitJob({
    idempotencyKey: 'reclaim-on-cancel',
    request: movieRequest(bytes, '201')
  })
  const settled = await manager.cancelJob(cancelled.jobId)
  t.is(settled.state, 'cancelled', 'the job was cancelled')
  t.is(stagingStores.opened.length, 1, 'and exactly one staging core was reclaimed')
  const reclaimedName = stagingStores.opened[0]
  t.is(assetStore.cores.get(reclaimedName).removed, true, 'the staging core itself was removed')

  // An interruption is the opposite decision: the prefix is the whole reason a
  // resubmit is cheap, so nothing is handed back.
  const interrupted = stubSourceClient(bytes, {
    failWith: new SourceCallbackError('SOURCE_RANGE_SHORT'),
    failAfterBytes: 4
  })
  const kept = harness(t, { client: interrupted })
  t.teardown(() => kept.manager.close())
  await kept.manager.start()
  const job = await kept.manager.submitJob({
    idempotencyKey: 'keep-on-interruption',
    request: movieRequest(bytes, '202'),
    sourceCapability: CAPABILITY
  })
  const failed = await waitForState(kept.manager, job.jobId, 'failed')
  t.is(failed.recoverable, true, 'a transport break leaves the job resumable')
  t.is(kept.stagingStores.opened.length, 0, 'so its staged prefix was not touched')
})

test('a permanently failed job hands its staging state back', async (t) => {
  const bytes = Buffer.from('abcdefghijkl')
  // A revoked grant: the transport carries its own verdict, and no retry gets
  // past it, so the prefix is dead weight rather than progress.
  const client = stubSourceClient(bytes, {
    failWith: new SourceCallbackError('SOURCE_GRANT_UNAVAILABLE', false),
    failAfterBytes: 4
  })
  const { manager, assetStore, stagingStores } = harness(t, { client })
  t.teardown(() => manager.close())
  await manager.start()

  const job = await manager.submitJob({
    idempotencyKey: 'reclaim-on-permanent-failure',
    request: movieRequest(bytes, '301'),
    sourceCapability: CAPABILITY
  })
  const failed = await waitForState(manager, job.jobId, 'failed')

  t.is(failed.errorCode, 'SOURCE_GRANT_UNAVAILABLE', 'the failure names itself through the upload manager')
  t.is(failed.recoverable, false, 'and is terminal')
  t.is(stagingStores.opened.length, 1, 'so the staged prefix was handed back')
  t.is(assetStore.cores.get(stagingStores.opened[0]).removed, true, 'and its staging core removed')

  // Same job id, same staging core: reclaiming twice is idempotent, which is
  // what lets the startup sweep be the backstop for a reclaim that failed.
  const plan = await manager.stagingSweepPlan()
  t.ok(plan.ids.includes(job.jobId), 'the sweep would still consider it')
  t.absent(plan.keep.includes(job.jobId), 'and would not keep it')
})

test('with block offload unconfigured there is no staging state to reclaim and nothing tries', async (t) => {
  const bytes = Buffer.from('abcdefghijkl')
  const client = stubSourceClient(bytes)
  const { manager, publisher } = harness(t, { client, staging: false })
  t.teardown(() => manager.close())
  await manager.start()

  const job = await manager.submitJob({
    idempotencyKey: 'no-offload-no-staging',
    request: movieRequest(bytes, '401'),
    sourceCapability: CAPABILITY
  })
  const completed = await waitForState(manager, job.jobId, 'completed')
  t.is(completed.bytesReceived, bytes.byteLength, 'the granted ingest still ran')
  t.alike(publisher.ingested[0], bytes, 'and delivered the whole title')

  const cancelled = await manager.submitJob({
    idempotencyKey: 'no-offload-cancel',
    request: movieRequest(bytes, '402')
  })
  const settled = await manager.cancelJob(cancelled.jobId)
  t.is(settled.state, 'cancelled', 'a cancellation still settles the job')
  t.is(settled.errorCode, 'CANCELLED', 'and reports itself as one')
})
