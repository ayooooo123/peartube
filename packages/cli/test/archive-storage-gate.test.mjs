import test from 'brittle'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createArchiveManager } from '../src/archive-manager.js'

function fakeStore (privateInput) {
  const jobs = new Map()
  return {
    jobs,
    async getPrivateInput () { return privateInput },
    async updateJob (id, patch) {
      const next = { id, ...(jobs.get(id) || {}), ...patch }
      jobs.set(id, next)
      return next
    },
    async listJobs () { return [...jobs.values()] },
  }
}

function mutableStore ({ jobs = [], inputs = {} } = {}) {
  const jobRows = new Map(jobs.map((job) => [job.id, { ...job }]))
  return {
    async getPrivateInput (id) { return inputs[id] || null },
    async updateJob (id, patch) {
      const next = { id, ...(jobRows.get(id) || {}), ...patch }
      jobRows.set(id, next)
      return next
    },
    async listJobs () { return [...jobRows.values()] },
  }
}

test('runJob refuses ingestion when the storage guard is tripped', async function (t) {
  let downloadCalls = 0
  let ensureChannelCalls = 0
  const manager = createArchiveManager({
    store: fakeStore({ url: 'https://example.com/v.mp4' }),
    downloader: { async download () { downloadCalls++; return { title: 't', cleanup () {} } } },
    publisher: { async ensureAnonymousChannel () { ensureChannelCalls++; return {} } },
    canIngest: () => false,
  })

  const result = await manager.runJob('job-1')

  t.is(result.status, 'failed', 'job is marked failed')
  t.ok(/storage threshold/i.test(result.error), 'error explains the storage threshold')
  t.is(downloadCalls, 0, 'never downloads when over threshold')
  t.is(ensureChannelCalls, 0, 'never touches channels when over threshold')
})

test('runJob proceeds when the storage guard allows ingestion', async function (t) {
  let downloadCalls = 0
  const store = fakeStore({ url: 'https://example.com/v.mp4' })
  const manager = createArchiveManager({
    store,
    downloader: { async download () { downloadCalls++; return { title: 't', cleanup () {} } } },
    // Make it fail AFTER the guard passes (channel step) so we only assert the
    // guard let it past download without standing up the full publish pipeline.
    publisher: { async ensureAnonymousChannel () { throw new Error('stop-after-download') } },
    canIngest: () => true,
  })

  const result = await manager.runJob('job-2')

  t.is(downloadCalls, 1, 'downloads when under threshold')
  t.is(result.status, 'failed')
  t.ok(/stop-after-download/.test(result.error), 'failed past the guard, at the channel step')
})

test('runNext serializes archive jobs so concurrent POSTs cannot overbook storage', async function (t) {
  const store = fakeStore({ url: 'https://example.com/v.mp4' })
  store.jobs.set('job-1', { id: 'job-1', status: 'queued' })
  store.jobs.set('job-2', { id: 'job-2', status: 'queued' })

  let activeDownloads = 0
  let overlapped = false
  let firstStartedResolve
  let releaseFirst
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve })
  const release = new Promise((resolve) => { releaseFirst = resolve })
  let first = true

  const runQueue = { tail: Promise.resolve() }
  const makeManager = () => createArchiveManager({
    store,
    runQueue,
    downloader: {
      async download () {
        activeDownloads += 1
        if (activeDownloads > 1) overlapped = true
        if (first) {
          first = false
          firstStartedResolve()
          await release
        }
        activeDownloads -= 1
        return { title: 't', cleanup () {} }
      }
    },
    publisher: { async ensureAnonymousChannel () { throw new Error('stop-after-download') } },
    canIngest: () => true,
  })

  const managerA = makeManager()
  const managerB = makeManager()
  const a = managerA.runNext()
  await firstStarted
  const b = managerB.runNext()
  await Promise.resolve()
  t.is(activeDownloads, 1, 'second runNext waits while the first download is active')
  releaseFirst()
  await Promise.all([a, b])
  t.absent(overlapped, 'downloads never overlap inside one archive manager')
})

test('recoverInterruptedJobs fails stale running jobs and removes staging', async function (t) {
  const stagingRoot = join(tmpdir(), `pt-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const directDir = join(stagingRoot, 'job-direct')
  const uploadDir = join(stagingRoot, 'uploads', 'up_abc123')
  const outsideDir = resolve(stagingRoot, '..', 'pt-recovery-outside')
  const rootFile = join(stagingRoot, 'root-file.mkv')
  mkdirSync(directDir, { recursive: true })
  mkdirSync(uploadDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(join(directDir, 'partial.mkv'), 'partial')
  writeFileSync(join(uploadDir, 'movie.mkv'), 'upload')
  writeFileSync(join(outsideDir, 'movie.mkv'), 'outside')
  writeFileSync(rootFile, 'root')

  const store = mutableStore({
    jobs: [
      { id: 'job-direct', status: 'running', title: 'direct' },
      { id: 'job-upload', status: 'running', title: 'upload' },
      { id: 'job-outside', status: 'running', title: 'outside' },
      { id: 'job-traversal', status: 'running', title: 'traversal' },
      { id: 'job-root-parent', status: 'running', title: 'root parent' },
      { id: 'job-queued', status: 'queued', title: 'queued' }
    ],
    inputs: {
      'job-direct': { url: 'https://example.com/video.mkv' },
      'job-upload': { uploadPath: join(uploadDir, 'movie.mkv') },
      'job-outside': { uploadPath: join(outsideDir, 'movie.mkv') },
      'job-traversal': { uploadPath: `${stagingRoot}/../pt-recovery-outside/movie.mkv` },
      'job-root-parent': { uploadPath: rootFile }
    }
  })
  const manager = createArchiveManager({
    store,
    downloader: { async download () { throw new Error('not used') } },
    publisher: {},
    stagingRoot
  })

  try {
    const recovered = await manager.recoverInterruptedJobs()
    const jobs = await store.listJobs()
    t.is(recovered.recovered, 5, 'all running jobs are marked recovered')
    t.absent(existsSync(directDir), 'direct downloader staging is removed by job id')
    t.absent(existsSync(uploadDir), 'multipart upload staging is removed from private upload path')
    t.ok(existsSync(outsideDir), 'normalized parent escapes are not removed')
    t.ok(existsSync(stagingRoot), 'the staging root itself is never removed')
    t.is(jobs.find((job) => job.id === 'job-direct').status, 'failed')
    t.ok(/interrupted by relay restart/.test(jobs.find((job) => job.id === 'job-direct').error))
    t.is(jobs.find((job) => job.id === 'job-upload').status, 'skipped', 'cleaned uploads are not retried without bytes')
    t.is(jobs.find((job) => job.id === 'job-outside').status, 'skipped')
    t.is(jobs.find((job) => job.id === 'job-traversal').status, 'skipped')
    t.is(jobs.find((job) => job.id === 'job-root-parent').status, 'skipped')
    t.is(jobs.find((job) => job.id === 'job-queued').status, 'queued', 'queued jobs remain eligible')
  } finally {
    rmSync(resolve(stagingRoot, '..', 'pt-recovery-outside'), { recursive: true, force: true })
    rmSync(stagingRoot, { recursive: true, force: true })
  }
})

test('runNext skips recovered uploads whose staged file was discarded', async function (t) {
  const stagingRoot = join(tmpdir(), `pt-recovery-upload-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const uploadDir = join(stagingRoot, 'uploads', 'up_only')
  mkdirSync(uploadDir, { recursive: true })
  writeFileSync(join(uploadDir, 'movie.mkv'), 'upload')
  const store = mutableStore({
    jobs: [{ id: 'job-upload', status: 'running', title: 'upload' }],
    inputs: { 'job-upload': { uploadPath: join(uploadDir, 'movie.mkv') } }
  })
  let downloadCalls = 0
  const manager = createArchiveManager({
    store,
    downloader: { async download () { downloadCalls += 1; throw new Error('not used') } },
    publisher: {},
    stagingRoot
  })

  try {
    await manager.recoverInterruptedJobs()
    const next = await manager.runNext()
    const jobs = await store.listJobs()
    t.is(next, null, 'no retryable archive job remains')
    t.is(jobs[0].status, 'skipped')
    t.is(downloadCalls, 0, 'recovered upload is never retried after deleting its bytes')
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
})
