import test from 'brittle'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createGrantedRangedSource } from '../src/archive-manager.js'
import { createIngestJobStore } from '../src/companion/ingest-job-store.js'
import { createIngestManager } from '../src/companion/ingest-manager.js'
import { SourceCallbackError } from '../src/companion/source-client.js'

// An archive job used to die whenever the thing feeding it did. That is the
// wrong coupling: "the connection went away" is not "the operator changed their
// mind", and only one of the two should end a job and delete its bytes.
//
// These tests drive the ingest manager with a stubbed source client so the
// interruption can be an exact, chosen failure.

const NOW = 1_786_406_400_000
const ETAG = '"remote-sha256-0123456789abcdef"'
const CAPABILITY = 'source-capability-interrupted-000000000001'

function sha256 (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function movieRequest (bytes) {
  return {
    retentionClass: 'archive-pin',
    mediaContext: { kind: 'movie', namespace: 'tmdb', identifier: '603' },
    measuredFacts: { title: 'The Matrix', byteLength: bytes.byteLength, container: 'mkv' },
    expected: { byteLength: bytes.byteLength, sha256: sha256(bytes), etag: ETAG }
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
  const calls = { imports: 0 }
  const videos = new Map()
  const ingested = []
  return {
    calls,
    ingested,
    async ensureAnonymousChannel () {
      return {
        channel: { async getVideo (videoId) { return videos.get(videoId) || null } },
        channelKey: 'c'.repeat(64),
        publicBeeKey: 'b'.repeat(64),
        publisherId: 'a'.repeat(64)
      }
    },
    // What the real archive publisher does with what it is handed, minus the
    // publication itself: a granted source is opened as ranges through the very
    // builder production uses and read to the end. Nothing about the job
    // lifecycle is meaningful unless the bytes are genuinely pulled, because
    // every gate under test fires while they are moving.
    async importVideo ({ videoId, sourceGrant, filePath }) {
      calls.imports++
      if (sourceGrant) {
        const source = createGrantedRangedSource(sourceGrant)
        const chunks = []
        for await (const chunk of source.open(0)) chunks.push(Buffer.from(chunk))
        ingested.push(Buffer.concat(chunks))
      } else if (filePath) {
        ingested.push(readFileSync(filePath))
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

/**
 * A source client that serves `bytes` in 4-byte ranges and fails once, with a
 * failure the test chooses, after `failAfterBytes` have been delivered.
 */
function stubSourceClient (bytes, { failWith = null, failAfterBytes = 0, etag = ETAG } = {}) {
  const ranges = []
  const revokes = []
  let armed = failWith !== null
  return {
    ranges,
    revokes,
    chunkBytes: 4,
    async head () {
      return { length: bytes.byteLength, etag, mimeType: 'video/x-matroska' }
    },
    async getRange ({ start, end, onChunk }) {
      if (armed && start >= failAfterBytes) {
        armed = false
        throw failWith
      }
      ranges.push(`bytes=${start}-${end}`)
      onChunk(bytes.subarray(start, end + 1), 0)
      return end - start + 1
    },
    async revoke ({ capability }) {
      revokes.push(capability)
      return true
    }
  }
}

function harness (t, { client, canIngest = () => true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'peartube-interrupted-ingest-'))
  t.teardown(() => rmSync(root, { recursive: true, force: true }))
  const bee = fakeBee()
  const store = createIngestJobStore({ bee, now: () => NOW })
  const publisher = fakePublisher()
  const spoolRoot = join(root, 'spool')
  const manager = createIngestManager({
    store,
    publisher,
    spoolRoot,
    sourceClient: client,
    canIngest,
    verifyChunkBytes: 4,
    now: () => NOW
  })
  return { manager, store, publisher, spoolRoot }
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

function sourceSpools (spoolRoot) {
  try {
    return readdirSync(join(spoolRoot, 'sources')).sort()
  } catch {
    return []
  }
}

test('an abort raised downstream is an interruption, not a cancellation, and leaves the job resumable', async (t) => {
  const bytes = Buffer.from('abcdefghijkl')
  // What a playback session going away looks like from in here: something below
  // the manager aborts, with the code an AbortSignal rejection carries.
  const aborted = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })
  const client = stubSourceClient(bytes, { failWith: aborted, failAfterBytes: 8 })
  const { manager, store, spoolRoot } = harness(t, { client })
  t.teardown(() => manager.close())
  await manager.start()

  const job = await manager.submitJob({
    idempotencyKey: 'interrupted-by-abort',
    request: movieRequest(bytes),
    sourceCapability: CAPABILITY
  })
  const failed = await waitForState(manager, job.jobId, 'failed')

  t.is(failed.state, 'failed', 'an interruption ends the run')
  t.not(failed.state, 'cancelled', 'but it is NOT a cancellation: nobody withdrew consent')
  t.is(failed.recoverable, true, 'and the job is recoverable, so a resubmit resumes it')
  t.is(failed.bytesReceived, 8, 'keeping every byte that was read before the abort')
  t.is((await store.getJob(job.jobId)).bytesReceived, 8, 'durably, not just in memory')
  // The bytes of a granted title never touch this volume — they go to the asset
  // core as ranges arrive — so there is no part-file to keep OR to leak. What a
  // resumable interruption preserves lives in the staging core the asset writer
  // owns, under this job's id.
  t.alike(sourceSpools(spoolRoot), [], 'and no part-downloaded title was staged on the volume')

  // The dead grant is still revoked — it is worthless and holding it open costs
  // MediaStorm a capability slot. What survives is the PROGRESS, which is the
  // whole difference: a resubmit brings a fresh grant and carries on.
  t.ok(client.revokes.includes(CAPABILITY), 'the spent grant is released')
})

test('a resubmit after an interruption finishes the title without a second publication', async (t) => {
  const bytes = Buffer.from('abcdefghijkl')
  const reset = new SourceCallbackError('SOURCE_RANGE_SHORT')
  const client = stubSourceClient(bytes, { failWith: reset, failAfterBytes: 8 })
  const { manager, publisher } = harness(t, { client })
  t.teardown(() => manager.close())
  await manager.start()

  const request = movieRequest(bytes)
  const first = await manager.submitJob({
    idempotencyKey: 'interrupted-then-resumed',
    request,
    sourceCapability: CAPABILITY
  })
  const failed = await waitForState(manager, first.jobId, 'failed')
  t.is(failed.recoverable, true, 'a transport break is recoverable')
  // The failure travelled through the upload manager, which reports failures as
  // messages rather than as the exceptions they were. It still names itself,
  // because the ranged source hands the exception back before it is flattened —
  // and that name is what decides resume-or-reclaim.
  t.is(failed.errorCode, 'SOURCE_RANGE_SHORT', 'and names itself rather than being flattened to PUBLICATION_FAILED')
  t.alike(client.ranges, ['bytes=0-3', 'bytes=4-7'], 'two ranges landed before the break')

  const fresh = 'source-capability-interrupted-000000000002'
  const replay = await manager.submitJob({ idempotencyKey: 'interrupted-then-resumed', request, sourceCapability: fresh })
  t.is(replay.jobId, first.jobId, 'the resubmit is the same job')
  const completed = await waitForState(manager, first.jobId, 'completed')

  t.is(completed.bytesReceived, bytes.byteLength, 'which finishes the title')
  t.is(publisher.calls.imports, 2, 'each attempt imported once, and only the second one published')
  t.alike(publisher.ingested.at(-1), bytes, 'and what it published is the whole title, byte-exact')
  // This relay has no object store, so there is nowhere durable to keep a
  // part-read title and the retry reads it again from the start. It is the
  // OFFLOAD-backed relay that resumes from a staged prefix — proven end to end
  // in backend/test/resumable-upload.test.mjs — and this is the honest cost of
  // not configuring one. What is never paid either way is a title-sized file.
  t.alike(
    client.ranges,
    ['bytes=0-3', 'bytes=4-7', 'bytes=0-3', 'bytes=4-7', 'bytes=8-11'],
    'the retry re-read the title rather than leaving a partial copy on the volume'
  )
})

test('a source that reports a different identity is terminal and takes the partial download with it', async (t) => {
  const bytes = Buffer.from('abcdefghijkl')
  const client = stubSourceClient(bytes, { etag: '"remote-sha256-rotated"' })
  const { manager, spoolRoot } = harness(t, { client })
  t.teardown(() => manager.close())
  await manager.start()

  const job = await manager.submitJob({
    idempotencyKey: 'identity-drift',
    request: movieRequest(bytes),
    sourceCapability: CAPABILITY
  })
  const failed = await waitForState(manager, job.jobId, 'failed')

  t.is(failed.errorCode, 'SOURCE_ETAG_MISMATCH', 'the identity guard names itself')
  t.is(failed.recoverable, false, 'and is terminal: no retry changes what the source says it is serving')
  t.is(client.ranges.length, 0, 'not one byte was read, so nothing could be spliced')
  t.alike(sourceSpools(spoolRoot), [], 'and no partial file was left behind')

  const replay = await manager.submitJob({
    idempotencyKey: 'identity-drift',
    request: movieRequest(bytes),
    sourceCapability: 'source-capability-identity-drift-00000001'
  })
  t.is(replay.state, 'failed', 'a resubmit does not reopen it')
  t.is(replay.recoverable, false, 'because the failure was never one to retry into')
  t.ok(client.revokes.includes('source-capability-identity-drift-00000001'), 'and the unused grant is revoked')
})

// A grant that expired or was revoked is a failure about REACHING the source,
// not about what the source is. Without this, one such failure memoized forever:
// every later submission got the old failure back, so a title broken by a
// since-fixed bug could never be archived again. Observed live - four titles
// stuck on SOURCE_GRANT_UNAVAILABLE that no amount of replaying could revive.
test('a fresh grant revives a job that died because its grant was gone', async (t) => {
  const bytes = Buffer.from('abcdefghijkl')
  const client = stubSourceClient(bytes, {
    failWith: new SourceCallbackError('SOURCE_GRANT_UNAVAILABLE', false)
  })
  const { manager } = harness(t, { client })
  t.teardown(() => manager.close())
  await manager.start()

  const job = await manager.submitJob({
    idempotencyKey: 'grant-gone',
    request: movieRequest(bytes),
    sourceCapability: CAPABILITY
  })
  const failed = await waitForState(manager, job.jobId, 'failed')
  t.is(failed.errorCode, 'SOURCE_GRANT_UNAVAILABLE', 'the grant failure names itself')
  t.is(failed.recoverable, false, 'and the run that hit it is over')

  // The stub disarms itself after firing once, so the source is reachable again,
  // and the caller has a new grant to prove it re-authorized the source.
  const revived = await manager.submitJob({
    idempotencyKey: 'grant-gone',
    request: movieRequest(bytes),
    sourceCapability: 'source-capability-grant-gone-000000001'
  })
  t.not(revived.state, 'failed', 'a fresh grant reopens it instead of replaying the failure')
  t.is(revived.jobId, job.jobId, 'as the same job, so idempotency still holds')
  t.is(revived.bytesReceived, 0, 'starting over, because a terminal failure keeps no progress worth trusting')
})

test('withdrawn retention consent terminates the job and deletes what it had downloaded', async (t) => {
  const bytes = Buffer.from('abcdefghijkl')
  let admitted = true
  // Consent is withdrawn once the first range has landed, so there is real
  // progress on disk for the cleanup to have to deal with.
  const client = stubSourceClient(bytes)
  const wrapped = {
    ...client,
    async getRange (options) {
      const result = await client.getRange(options)
      admitted = false
      return result
    }
  }
  const { manager, spoolRoot } = harness(t, { client: wrapped, canIngest: () => admitted })
  t.teardown(() => manager.close())
  await manager.start()

  const job = await manager.submitJob({
    idempotencyKey: 'consent-withdrawn',
    request: movieRequest(bytes),
    sourceCapability: CAPABILITY
  })
  const failed = await waitForState(manager, job.jobId, 'failed')

  t.is(failed.errorCode, 'RETENTION_ADMISSION_DENIED', 'a withdrawal is reported as one')
  t.is(failed.recoverable, false, 'and is not recoverable, whatever progress there was')
  t.alike(sourceSpools(spoolRoot), [], 'so the bytes it had downloaded are gone')
  t.is(existsSync(join(spoolRoot, 'sources', `${job.jobId}.part`)), false, 'including the part file by name')
  t.ok(client.revokes.includes(CAPABILITY), 'and the source grant is revoked')
})

test('an explicit cancellation is still a cancellation and still cleans up', async (t) => {
  const bytes = Buffer.from('abcdefghijkl')
  let release = null
  const gate = new Promise(resolve => { release = resolve })
  const client = stubSourceClient(bytes)
  const wrapped = {
    ...client,
    async getRange (options) {
      const result = await client.getRange(options)
      if (options.start === 0) await gate
      return result
    }
  }
  const { manager, spoolRoot } = harness(t, { client: wrapped })
  t.teardown(() => manager.close())
  await manager.start()

  const job = await manager.submitJob({
    idempotencyKey: 'explicit-cancel',
    request: movieRequest(bytes),
    sourceCapability: CAPABILITY
  })
  const cancelling = manager.cancelJob(job.jobId)
  release()
  const cancelled = await cancelling

  t.is(cancelled.state, 'cancelled', 'an explicit cancel is a cancellation')
  t.is(cancelled.errorCode, 'CANCELLED', 'reported as one')
  t.is(cancelled.recoverable, false, 'and never resumable')
  t.alike(sourceSpools(spoolRoot), [], 'with every downloaded byte removed')
  t.ok(client.revokes.includes(CAPABILITY), 'and the grant revoked')
})


test('a granted source with no up-front digest still ingests, and a request with no identity at all is refused', async (t) => {
  const bytes = Buffer.from('abcdefghijkl')
  const client = stubSourceClient(bytes)
  const { manager, publisher } = harness(t, { client })
  t.teardown(() => manager.close())
  await manager.start()

  // A debrid-backed title has no whole-file SHA-256 to state: computing one
  // means pulling every byte through MediaStorm first, which is the cost the
  // granted path exists to avoid. Its identity is the ETag instead.
  const request = movieRequest(bytes)
  delete request.expected.sha256
  const job = await manager.submitJob({
    idempotencyKey: 'granted-no-digest',
    request,
    sourceCapability: CAPABILITY
  })
  const completed = await waitForState(manager, job.jobId, 'completed')
  t.is(completed.bytesReceived, bytes.byteLength, 'the whole title landed')
  t.is(publisher.calls.imports, 1, 'and published once')

  // A digest that IS stated is still checked, so the local path is unchanged.
  const wrong = movieRequest(bytes)
  wrong.expected.sha256 = 'f'.repeat(64)
  const drifted = await manager.submitJob({
    idempotencyKey: 'granted-wrong-digest',
    request: wrong,
    sourceCapability: 'source-capability-wrong-digest-0000000001'
  })
  const failed = await waitForState(manager, drifted.jobId, 'failed')
  t.is(failed.errorCode, 'HASH_MISMATCH', 'a stated digest that does not match is still a hard failure')

  // And a request that claims nothing about its content is refused outright.
  const anonymous = movieRequest(bytes)
  delete anonymous.expected.sha256
  delete anonymous.expected.etag
  await t.exception(
    manager.submitJob({ idempotencyKey: 'no-identity', request: anonymous, sourceCapability: CAPABILITY }),
    /SHA-256 digest or an ETag/,
    'a request with neither a digest nor an ETag has no identity to verify against'
  )
})