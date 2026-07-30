import test from 'brittle'
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
