import test from 'brittle'
import { createJobStore, deriveIntentIds, sanitize } from '../src/add/job-store.js'

function fakeBee () {
  const map = new Map()
  const api = {
    map,
    async get (key) { return map.has(key) ? { value: map.get(key) } : null },
    async put (key, value) { map.set(key, JSON.parse(JSON.stringify(value))) },
    async del (key) { map.delete(key) },
    batch () {
      const staged = []
      return {
        async put (key, value) { staged.push([key, value]) },
        async flush () { for (const [key, value] of staged) map.set(key, JSON.parse(JSON.stringify(value))) }
      }
    },
    async * createReadStream ({ gte, lt } = {}) {
      for (const key of [...map.keys()].sort()) {
        if (gte !== undefined && key < gte) continue
        if (lt !== undefined && key >= lt) continue
        yield { key, value: map.get(key) }
      }
    }
  }
  return api
}

async function seedJob (bee, { now = () => 1000 } = {}) {
  const store = createJobStore({ bee, now })
  await store.createJob({
    jobId: 'job-1',
    manifestChecksum: 'sha256:manifest',
    rows: [
      { rowId: 'r1', data: { title: 'Pilot' } },
      { rowId: 'r2', data: { title: 'Cat' } }
    ]
  })
  return store
}

test('createJob persists rows, deterministic intents, and an active pointer', async (t) => {
  const bee = fakeBee()
  const store = await seedJob(bee)
  const job = await store.getJob('job-1')
  t.is(job.rows.length, 2)
  t.is(job.rows[0].state, 'pending')
  t.alike(job.rows[0].intent, deriveIntentIds('job-1', 'r1'))
  t.is(job.manifestChecksum, 'sha256:manifest')
  const active = await store.listActive()
  t.is(active.length, 1)
  t.is(active[0].jobId, 'job-1')

  // createJob is idempotent: re-creating returns the existing job unchanged.
  const again = await store.createJob({ jobId: 'job-1', rows: [{ rowId: 'r1' }] })
  t.is(again.rows.length, 2)
})

test('the full lifecycle advances one state at a time with version checkpoints', async (t) => {
  const bee = fakeBee()
  const store = await seedJob(bee)
  const sequence = ['resolving', 'downloading', 'uploading', 'uploaded', 'replicationPending', 'durabilityVerified', 'projecting', 'projected', 'announcing', 'announced', 'finalizing', 'published']
  let version = 0
  for (const to of sequence) {
    const row = await store.transitionRow('job-1', 'r1', { to, expectedVersion: version })
    t.is(row.state, to)
    version = row.version
  }
  t.is(version, sequence.length)
  const done = await store.getRow('job-1', 'r1')
  t.is(done.state, 'published')
})

test('entering uploading persists deterministic upload intent before upload', async (t) => {
  const bee = fakeBee()
  const store = await seedJob(bee)
  await store.transitionRow('job-1', 'r1', { to: 'resolving' })
  await store.transitionRow('job-1', 'r1', { to: 'downloading', patch: { data: { verifiedArtifact: '/tmp/pilot.mkv', checksum: 'sha256:v' } } })
  const uploading = await store.transitionRow('job-1', 'r1', { to: 'uploading' })
  t.is(uploading.data.verifiedArtifact, '/tmp/pilot.mkv')
  t.is(uploading.intent.videoId, deriveIntentIds('job-1', 'r1').videoId)
})

test('stale versions and illegal transitions are rejected', async (t) => {
  const bee = fakeBee()
  const store = await seedJob(bee)
  await store.transitionRow('job-1', 'r1', { to: 'resolving', expectedVersion: 0 })
  await t.exception(store.transitionRow('job-1', 'r1', { to: 'downloading', expectedVersion: 0 }), /stale row version/)
  await t.exception(store.transitionRow('job-1', 'r1', { to: 'uploaded' }), /illegal transition/)
})

test('a failed row retries its failed step, counts attempts, and never corrupts siblings', async (t) => {
  const bee = fakeBee()
  const store = await seedJob(bee)
  await store.transitionRow('job-1', 'r1', { to: 'resolving' })
  await store.transitionRow('job-1', 'r1', { to: 'downloading' })
  const failed = await store.transitionRow('job-1', 'r1', { to: 'failed', error: Object.assign(new Error('network'), { code: 'NET' }) })
  t.is(failed.state, 'failed')
  t.is(failed.failedFrom, 'downloading')
  t.alike(failed.error, { message: 'network', code: 'NET' })

  await t.exception(store.transitionRow('job-1', 'r1', { to: 'uploading' }), /retry must resume/)
  const retried = await store.transitionRow('job-1', 'r1', { to: 'downloading' })
  t.is(retried.state, 'downloading')
  t.is(retried.attempts, 1)
  t.is(retried.error, null)

  const sibling = await store.getRow('job-1', 'r2')
  t.is(sibling.state, 'pending', 'sibling row unaffected by failure')
})

test('resume returns the first incomplete row across a process restart', async (t) => {
  const bee = fakeBee()
  await seedJob(bee)
  // r1 completes, r2 partially advances, then a fresh store instance reopens the bee.
  const store1 = createJobStore({ bee, now: () => 2000 })
  for (const to of ['resolving', 'downloading', 'uploading', 'uploaded', 'replicationPending', 'durabilityVerified', 'projecting', 'projected', 'announcing', 'announced', 'finalizing', 'published']) {
    await store1.transitionRow('job-1', 'r1', { to })
  }
  await store1.transitionRow('job-1', 'r2', { to: 'resolving' })

  const store2 = createJobStore({ bee, now: () => 3000 })
  const resume = await store2.firstIncompleteRow('job-1')
  t.is(resume.rowId, 'r2')
  t.is(resume.state, 'resolving', 'persisted mid-flight state survives restart')

  await store2.transitionRow('job-1', 'r1', { to: 'resolving' }).then(() => t.fail('completed row must not transition'), (error) => t.is(error.code, 'ERR_ROW_TERMINAL'))
})

test('manifest checksum mismatch is rejected', async (t) => {
  const bee = fakeBee()
  const store = await seedJob(bee)
  t.is(await store.validateManifestChecksum('job-1', 'sha256:manifest'), true)
  await t.exception(store.validateManifestChecksum('job-1', 'sha256:other'), /checksum mismatch/)
})

test('serialization strips fetchUrl, displayUrl, and secret-bearing keys', async (t) => {
  const bee = fakeBee()
  const store = createJobStore({ bee, now: () => 1000 })
  await store.createJob({
    jobId: 'job-2',
    rows: [{ rowId: 'r1', data: { identityUrl: 'https://x/y', fetchUrl: 'https://secret/y', displayUrl: 'https://x/y', tmdbApiKey: 'k', authorization: 'Bearer z' } }]
  })
  const row = await store.getRow('job-2', 'r1')
  t.is(row.data.identityUrl, 'https://x/y')
  t.absent('fetchUrl' in row.data)
  t.absent('displayUrl' in row.data)
  t.absent('tmdbApiKey' in row.data)
  t.absent('authorization' in row.data)

  const cleaned = sanitize({ keep: 1, fetchUrl: 'x', nested: { cookie: 'c', ok: 2 } })
  t.alike(cleaned, { keep: 1, nested: { ok: 2 } })
})
