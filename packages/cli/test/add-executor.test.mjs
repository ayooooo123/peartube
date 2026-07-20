import test from 'brittle'
import { createExecutor } from '../src/add/executor.js'
import { createJobStore } from '../src/add/job-store.js'

function fakeBee () {
  const map = new Map()
  return {
    map,
    async get (key) { return map.has(key) ? { value: map.get(key) } : null },
    async put (key, value) { map.set(key, JSON.parse(JSON.stringify(value))) },
    async del (key) { map.delete(key) },
    batch () {
      const staged = []
      return { async put (k, v) { staged.push([k, v]) }, async flush () { for (const [k, v] of staged) map.set(k, JSON.parse(JSON.stringify(v))) } }
    },
    async * createReadStream ({ gte, lt } = {}) {
      for (const key of [...map.keys()].sort()) {
        if (gte !== undefined && key < gte) continue
        if (lt !== undefined && key >= lt) continue
        yield { key, value: map.get(key) }
      }
    }
  }
}

const CHANNEL = { channelKey: 'chan-1', writerKeyHex: 'a'.repeat(64), publicBeeKey: 'b'.repeat(64) }

function baseDeps (overrides = {}) {
  const calls = { download: 0, upload: [], pin: 0, project: 0, announce: 0, finalize: 0, markDurable: 0, claims: [] }
  const deps = {
    resolveChannel: async () => CHANNEL,
    loadChannel: async () => CHANNEL,
    duplicateCheck: { check: async () => ({ status: 'ok', advisories: [] }) },
    deriveImportClaimantId: (writer, jobId) => `claim:${writer.slice(0, 4)}:${jobId}`,
    writeClaim: async (claim) => { calls.claims.push(claim) },
    resolveClaimWinner: async ({ identityKey }) => ({ claimantId: `claim:${CHANNEL.writerKeyHex.slice(0, 4)}:job-1`, identityKey }),
    downloadSource: async () => { calls.download += 1; return { artifactPath: '/tmp/pilot.mkv', checksum: 'sha256:v' } },
    uploadFromPath: async (args) => { calls.upload.push(args); return { videoId: args.videoId, channelKey: CHANNEL.channelKey, blobKey: 'blob-1' } },
    requestPin: async () => { calls.pin += 1 },
    awaitDurable: async () => ({ verified: true, holders: ['relay-1'] }),
    publication: {
      markDurabilityVerified: async () => { calls.markDurable += 1 },
      project: async () => { calls.project += 1; return { channelKey: CHANNEL.channelKey, publicBeeKey: CHANNEL.publicBeeKey } },
      announce: async () => { calls.announce += 1 },
      finalize: async () => { calls.finalize += 1 }
    },
    ...overrides
  }
  return { deps, calls }
}

async function seedJob (bee, item) {
  const store = createJobStore({ bee, now: () => 1000 })
  await store.createJob({
    jobId: 'job-1',
    rows: [{ rowId: 'r1', data: { item, channelDraft: { channelTarget: { mode: 'new' } }, channelTarget: { mode: 'new' } } }]
  })
  return store
}

const EPISODE = { contentKind: 'episode', title: 'Pilot', seasonNumber: 1, episodeNumber: 1, sourceProvider: 'youtube', sourceVideoId: 'v1', identityUrl: 'https://youtube.com/watch?v=v1' }

test('a verified import advances to published only after durability, projection, and announcement', async (t) => {
  const bee = fakeBee()
  const store = await seedJob(bee, EPISODE)
  const { deps, calls } = baseDeps({ jobStore: store })
  const executor = createExecutor(deps)
  const job = await store.getJob('job-1')
  const result = await executor.executeRow(job, job.rows[0])

  t.is(result.status, 'published')
  t.is(calls.download, 1)
  t.is(calls.upload.length, 1)
  t.is(calls.pin, 1)
  t.is(calls.markDurable, 1)
  t.is(calls.project, 1)
  t.is(calls.announce, 1)
  t.is(calls.finalize, 1)
})

test('upload receives identityUrl provenance and the deterministic video id, never fetchUrl', async (t) => {
  const bee = fakeBee()
  const store = await seedJob(bee, EPISODE)
  const { deps, calls } = baseDeps({ jobStore: store })
  const executor = createExecutor(deps)
  const job = await store.getJob('job-1')
  await executor.executeRow(job, job.rows[0])

  const upload = calls.upload[0]
  t.is(upload.identityUrl, 'https://youtube.com/watch?v=v1')
  t.is(upload.videoId, job.rows[0].intent.videoId, 'deterministic video id is the idempotency key')
  t.absent('fetchUrl' in upload)
})

test('does not report success on pin acceptance and remains pending without durability', async (t) => {
  const bee = fakeBee()
  const store = await seedJob(bee, EPISODE)
  let verified = false
  const { deps, calls } = baseDeps({ jobStore: store, awaitDurable: async () => ({ verified }) })
  const executor = createExecutor(deps)
  let job = await store.getJob('job-1')
  const pending = await executor.executeRow(job, job.rows[0])
  t.is(pending.status, 'replicationPending')
  t.is(calls.pin, 1)
  t.is(calls.project, 0, 'no projection before verified durability')

  // Durability later succeeds; resuming advances without re-download or re-upload.
  verified = true
  job = await store.getJob('job-1')
  const row = job.rows[0]
  const done = await executor.executeRow(job, row)
  t.is(done.status, 'published')
  t.is(calls.download, 1, 'download not repeated')
  t.is(calls.upload.length, 1, 'upload not repeated')
})

test('an existing target-authority identity returns already-exists with no transfer', async (t) => {
  const bee = fakeBee()
  const store = await seedJob(bee, EPISODE)
  const { deps, calls } = baseDeps({
    jobStore: store,
    duplicateCheck: { check: async () => ({ status: 'already-exists', existing: { channelKey: 'chan-1', videoId: 'existing-9', availability: 'published' } }) }
  })
  const executor = createExecutor(deps)
  const job = await store.getJob('job-1')
  const result = await executor.executeRow(job, job.rows[0])

  t.is(result.status, 'already-exists')
  t.is(result.existing.videoId, 'existing-9')
  t.is(calls.download, 0, 'no download for an existing item')
  t.is(calls.upload.length, 0)
})

test('a losing import claim is released without downloading or uploading', async (t) => {
  const bee = fakeBee()
  const store = await seedJob(bee, EPISODE)
  const { deps, calls } = baseDeps({
    jobStore: store,
    resolveClaimWinner: async () => ({ claimantId: 'claim:other:job-9' })
  })
  const executor = createExecutor(deps)
  const job = await store.getJob('job-1')
  const result = await executor.executeRow(job, job.rows[0])

  t.is(result.status, 'released')
  t.is(calls.download, 0)
  t.is(calls.upload.length, 0)
})

test('a failed step retries idempotently without duplicating completed work', async (t) => {
  const bee = fakeBee()
  const store = await seedJob(bee, EPISODE)
  let failUpload = true
  const { deps, calls } = baseDeps({
    jobStore: store,
    uploadFromPath: async (args) => {
      if (failUpload) { failUpload = false; throw Object.assign(new Error('upload glitch'), { code: 'UPLOAD' }) }
      calls.upload.push(args)
      return { videoId: args.videoId, channelKey: CHANNEL.channelKey, blobKey: 'blob-1' }
    }
  })
  const executor = createExecutor(deps)
  let job = await store.getJob('job-1')
  const failedResult = await executor.executeRow(job, job.rows[0])
  t.is(failedResult.status, 'failed')
  t.is(calls.download, 1)

  job = await store.getJob('job-1')
  const retry = await executor.executeRow(job, job.rows[0])
  t.is(retry.status, 'published')
  t.is(calls.download, 1, 'download not repeated after upload retry')
  t.is(calls.upload.length, 1, 'exactly one successful upload')
})
