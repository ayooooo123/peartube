import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import b4a from 'b4a'
import test from 'brittle'
import Corestore from 'corestore'
import Hypercore from 'hypercore'

import { createBlockOffloader } from '../src/archive/block-offloader.js'
import { createOffloadStorage } from '../src/archive/offload-storage.js'
import { createRemoteBlockStore } from '../src/archive/remote-block-store.js'
import { ASSET_BLOCK_SIZE, writeStaticAsset } from '../src/assets/static-core.js'
import { createIngestJobStore } from '../../cli/src/companion/ingest-job-store.js'
import { createIngestManager, ingestJobIdForRequest } from '../../cli/src/companion/ingest-manager.js'
import { SourceCallbackError } from '../../cli/src/companion/source-client.js'

// "Is this job worth retrying?" and "are the bytes it already staged still
// worth resuming from?" are two different questions, and a digest mismatch is
// the one failure that answers them differently: the job IS worth retrying,
// because corruption need not recur, and the staged prefix is NOT worth
// resuming from, because it is precisely the thing whose digest failed.
//
// Conflating them costs a job that retries forever and can never succeed: every
// attempt resumes from the same poisoned prefix and recomputes the same wrong
// digest until the staging TTL expires.
//
// READ THIS BEFORE CHANGING THE GATE. The first test reaches a combination the
// wiring currently prevents. archive-manager's ranged source sets
// `resumable: digest === null`, so a grant that states a SHA-256 is read in one
// pass from byte zero and never builds `resume`, which means no job that owns
// staging state can fail with HASH_MISMATCH today. The test gets there by
// latching that failure onto a digest-less grant.
//
// That is deliberate, and it is why the test exists rather than in spite of it.
// `resumable: digest === null` is the only reason a digest-bearing grant cannot
// resume, so it is the obvious thing to relax — and the moment it is relaxed
// this combination becomes live. The test pins the behaviour now so relaxing
// the gate later is a one-line change rather than a silent livelock.
//
// It lives in the backend package because it needs a real Corestore and real
// staging objects for the reclaim to be observable at all — a manager with no
// asset store reclaims nothing and would prove nothing.

const NOW = 1_786_406_400_000
const PREFIX = 'relay'
const ETAG = '"remote-sha256-0123456789abcdef"'
const WINDOW_BYTES = 2 * ASSET_BLOCK_SIZE
const BLOCK_COUNT = 4
const BYTE_LENGTH = BLOCK_COUNT * ASSET_BLOCK_SIZE
const BREAK_AT_BLOCK = 2
const CAPABILITY = 'source-capability-poisoned-000000000000001'

function sha256 (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function assetBytes () {
  const bytes = b4a.alloc(BYTE_LENGTH)
  for (let index = 0; index < BLOCK_COUNT; index++) {
    bytes.fill((index + 1) & 0xff, index * ASSET_BLOCK_SIZE, (index + 1) * ASSET_BLOCK_SIZE)
  }
  return bytes
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

/**
 * A publisher whose importVideo fails the way the real one does: the ranged
 * source hands the exception back through `onFailure`, and what actually gets
 * thrown is the flattened message the upload manager produces. If the manager
 * classified on the thrown error rather than the latched one, every case here
 * would look like PUBLICATION_FAILED.
 */
function failingPublisher (failure) {
  const calls = { imports: 0 }
  return {
    calls,
    async ensureAnonymousChannel () {
      return {
        channel: { async getVideo () { return null } },
        channelKey: 'c'.repeat(64),
        publicBeeKey: 'b'.repeat(64),
        publisherId: 'a'.repeat(64)
      }
    },
    async importVideo ({ sourceGrant }) {
      calls.imports++
      sourceGrant?.onFailure?.(failure)
      throw new Error('Upload failed: aborted')
    },
    async publishCatalog () {},
    async retainAssets () {}
  }
}

async function fixture (t) {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-poisoned-progress-'))
  const objects = new Map()

  const provider = {
    async putBlock ({ key, data }) {
      objects.set(key, b4a.from(data))
      return { success: true }
    },
    async hasBlock ({ key }) { return objects.has(key) },
    async getBlock ({ key }) { return objects.has(key) ? objects.get(key) : null },
    async deleteBlock ({ key }) {
      objects.delete(key)
      return { success: true }
    }
  }

  const storage = createOffloadStorage({
    storage: Hypercore.defaultStorage(directory),
    resolveStore: ({ keyHex }) => (
      typeof keyHex === 'string' ? createRemoteBlockStore({ provider, prefix: PREFIX, coreKey: keyHex }) : null
    ),
    log: () => {}
  })
  const assetStore = new Corestore(storage)
  await assetStore.ready()
  t.teardown(async () => {
    await assetStore.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  const createStagingStore = ({ core }) => createRemoteBlockStore({ provider, prefix: PREFIX, coreKey: core.key })

  return { assetStore, createStagingStore, objects, provider, directory }
}

function managerFor (t, { assetStore, createStagingStore, publisher }) {
  const root = mkdtempSync(join(tmpdir(), 'peartube-poisoned-spool-'))
  t.teardown(() => rmSync(root, { recursive: true, force: true }))
  const store = createIngestJobStore({ bee: fakeBee(), now: () => NOW })
  const manager = createIngestManager({
    store,
    publisher,
    spoolRoot: join(root, 'spool'),
    assetStore,
    createStagingStore,
    sourceClient: {
      chunkBytes: 4 * 1024 * 1024,
      async head () { return { length: BYTE_LENGTH, etag: ETAG, mimeType: 'video/x-matroska' } },
      async getRange () { return 0 },
      async revoke () { return true }
    },
    canIngest: () => true,
    verifyChunkBytes: 4,
    now: () => NOW
  })
  t.teardown(() => manager.close())
  return { manager, store }
}

/**
 * Leave real staging state behind for `id`, the way an interrupted download
 * does: a staging core with a partial tree and its confirmed blocks in the
 * bucket.
 */
async function stageInterrupted (assetStore, createStagingStore, id, bytes) {
  const error = await writeStaticAsset({
    store: assetStore,
    offload: {
      createStagingStore,
      createOffloader: ({ core }) => createBlockOffloader({
        core,
        store: createStagingStore({ core }),
        windowBytes: WINDOW_BYTES
      })
    },
    resume: {
      id,
      etag: ETAG,
      open ({ byteOffset }) {
        return (async function * () {
          const limit = BREAK_AT_BLOCK * ASSET_BLOCK_SIZE
          for (let offset = byteOffset; offset < limit; offset += ASSET_BLOCK_SIZE) {
            yield bytes.subarray(offset, offset + ASSET_BLOCK_SIZE)
          }
          throw Object.assign(new Error('source connection reset'), { code: 'SOURCE_RANGE_SHORT' })
        })()
      }
    }
  }).then(() => null, (value) => value)
  if (error?.staging?.retained !== true) throw new Error('the fixture failed to leave staging state behind')
  return error
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

test('a digest mismatch reclaims the staged prefix it condemns, while leaving the job retryable', async (t) => {
  const bytes = assetBytes()
  const request = movieRequest(bytes)
  const idempotencyKey = 'poisoned-digest'
  const jobId = ingestJobIdForRequest(idempotencyKey, request)

  const { assetStore, createStagingStore, objects } = await fixture(t)
  await stageInterrupted(assetStore, createStagingStore, jobId, bytes)
  t.is(objects.size, BREAK_AT_BLOCK, 'the interrupted download left a staged prefix in the bucket')

  const publisher = failingPublisher(Object.assign(new Error('digest mismatch'), { code: 'HASH_MISMATCH' }))
  const { manager } = managerFor(t, { assetStore, createStagingStore, publisher })
  await manager.start()

  const submitted = await manager.submitJob({ idempotencyKey, request, sourceCapability: CAPABILITY })
  t.is(submitted.jobId, jobId, 'the job id the staging core was named for is the job id that runs')
  const failed = await waitForState(manager, jobId, 'failed')

  t.is(failed.errorCode, 'HASH_MISMATCH', 'the latched failure keeps its identity through the upload boundary')
  t.is(failed.recoverable, true, 'the JOB is still worth retrying: corruption need not recur')
  t.is(objects.size, 0, 'but the prefix whose digest failed is gone, so a retry cannot resume into it')
})

test('a transport interruption leaves the staged prefix exactly where it is', async (t) => {
  const bytes = assetBytes()
  const request = movieRequest(bytes)
  const idempotencyKey = 'interrupted-transport'
  const jobId = ingestJobIdForRequest(idempotencyKey, request)

  const { assetStore, createStagingStore, objects } = await fixture(t)
  await stageInterrupted(assetStore, createStagingStore, jobId, bytes)
  const staged = [...objects.keys()].sort()
  t.is(staged.length, BREAK_AT_BLOCK, 'the interrupted download left a staged prefix in the bucket')

  const publisher = failingPublisher(new SourceCallbackError('SOURCE_RANGE_SHORT'))
  const { manager } = managerFor(t, { assetStore, createStagingStore, publisher })
  await manager.start()

  await manager.submitJob({ idempotencyKey, request, sourceCapability: CAPABILITY })
  const failed = await waitForState(manager, jobId, 'failed')

  t.is(failed.errorCode, 'SOURCE_RANGE_SHORT', 'a transport break is reported as itself')
  t.is(failed.recoverable, true, 'and is recoverable')
  t.alike([...objects.keys()].sort(), staged, 'with every confirmed block still in the bucket for the retry')
})

test('a permanently failed job takes its staged prefix with it', async (t) => {
  const bytes = assetBytes()
  const request = movieRequest(bytes)
  const idempotencyKey = 'grant-revoked'
  const jobId = ingestJobIdForRequest(idempotencyKey, request)

  const { assetStore, createStagingStore, objects } = await fixture(t)
  await stageInterrupted(assetStore, createStagingStore, jobId, bytes)
  t.is(objects.size, BREAK_AT_BLOCK, 'the interrupted download left a staged prefix in the bucket')

  // 410 from the grant: the underlying file is gone, so nothing will ever
  // complete this prefix.
  const publisher = failingPublisher(new SourceCallbackError('SOURCE_GRANT_UNAVAILABLE', false))
  const { manager } = managerFor(t, { assetStore, createStagingStore, publisher })
  await manager.start()

  await manager.submitJob({ idempotencyKey, request, sourceCapability: CAPABILITY })
  const failed = await waitForState(manager, jobId, 'failed')

  t.is(failed.errorCode, 'SOURCE_GRANT_UNAVAILABLE', 'a revoked or missing source is reported as itself')
  t.is(failed.recoverable, false, 'and is terminal')
  t.is(objects.size, 0, 'so the staged prefix goes with the job')
})
