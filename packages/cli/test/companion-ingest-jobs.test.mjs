import test from 'brittle'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createIngestJobStore,
  IngestJobStoreError
} from '../src/companion/ingest-job-store.js'
import {
  createIngestManager,
  fingerprintIngestRequest,
  normalizeIngestRequest
} from '../src/companion/ingest-manager.js'
import { createCompanionRouter } from '../src/companion/routes.js'

function fakeBee ({ failFlush = false } = {}) {
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
          if (failFlush) throw new Error(`database exploded ${'secret'.repeat(1000)}`)
          for (const [operation, key, value] of operations) {
            if (operation === 'put') map.set(key, value)
            else map.delete(key)
          }
        }
      }
    },
    async * createReadStream ({ gte, lt } = {}) {
      for (const key of [...map.keys()].sort()) {
        if (gte !== undefined && key < gte) continue
        if (lt !== undefined && key >= lt) continue
        yield { key, value: clone(map.get(key)) }
      }
    }
  }
}

function sha256 (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function movieRequest (bytes, patch = {}) {
  const request = {
    retentionClass: 'contribution-cache',
    mediaContext: {
      kind: 'movie',
      namespace: 'tmdb',
      identifier: '348'
    },
    measuredFacts: {
      title: 'Alien',
      byteLength: bytes.byteLength,
      durationMs: 7_020_000,
      container: 'mkv',
      videoCodec: 'hevc',
      width: 3840,
      height: 2160,
      hdrFormats: ['HDR10', 'dolby-vision'],
      audioTracks: [{ codec: 'eac3', channels: 6, languages: ['EN'] }],
      subtitleTracks: [{ format: 'srt', language: 'en' }]
    },
    expected: {
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      etag: '"alien-immutable-v1"'
    },
    bundleProvenance: {
      sourceKind: 'public-torrent',
      releaseName: 'Alien.1979.UHD',
      sourcePath: 'Alien.1979/Alien.mkv',
      fileIndex: 0,
      memberCount: 2,
      publicTrackerIndependent: true,
      publicInfohash: 'ab'.repeat(20)
    }
  }
  return { ...request, ...patch }
}

function episodeRequest (bytes) {
  return {
    retentionClass: 'archive-pin',
    mediaContext: {
      kind: 'episode',
      seriesNamespace: 'tvdb',
      seriesIdentifier: '121361',
      seasonNumber: 1,
      episodeNumber: 2,
      providerEpisodeNamespace: 'tmdb',
      providerEpisodeIdentifier: '62086'
    },
    measuredFacts: {
      title: 'The Cat Came Back',
      byteLength: bytes.byteLength,
      durationMs: 1_500_000,
      container: 'mp4'
    },
    expected: { byteLength: bytes.byteLength, sha256: sha256(bytes) }
  }
}

function reorderedMovieRequest (request) {
  return {
    expected: { etag: request.expected.etag, sha256: request.expected.sha256, byteLength: request.expected.byteLength },
    bundleProvenance: {
      memberCount: request.bundleProvenance.memberCount,
      publicInfohash: request.bundleProvenance.publicInfohash,
      sourcePath: request.bundleProvenance.sourcePath,
      sourceKind: request.bundleProvenance.sourceKind,
      publicTrackerIndependent: request.bundleProvenance.publicTrackerIndependent,
      fileIndex: request.bundleProvenance.fileIndex,
      releaseName: request.bundleProvenance.releaseName
    },
    measuredFacts: {
      subtitleTracks: request.measuredFacts.subtitleTracks,
      audioTracks: request.measuredFacts.audioTracks,
      hdrFormats: request.measuredFacts.hdrFormats,
      height: request.measuredFacts.height,
      width: request.measuredFacts.width,
      videoCodec: request.measuredFacts.videoCodec,
      container: request.measuredFacts.container,
      durationMs: request.measuredFacts.durationMs,
      byteLength: request.measuredFacts.byteLength,
      title: request.measuredFacts.title
    },
    mediaContext: {
      identifier: request.mediaContext.identifier,
      namespace: request.mediaContext.namespace,
      kind: request.mediaContext.kind
    },
    retentionClass: request.retentionClass
  }
}

function fixture (t) {
  const root = mkdtempSync(join(tmpdir(), 'peartube-ingest-'))
  const spoolRoot = join(root, 'spool')
  mkdirSync(spoolRoot, { recursive: true })
  t.teardown(() => rmSync(root, { recursive: true, force: true }))
  return {
    root,
    spoolRoot,
    writeSpool (bytes, name = 'complete.bin', overrides = {}) {
      const filePath = join(spoolRoot, name)
      writeFileSync(filePath, bytes)
      return {
        path: name,
        complete: true,
        mimeType: 'video/x-matroska',
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
        etag: '"alien-immutable-v1"',
        ...overrides
      }
    }
  }
}

function publicationFor (videoId, byte = '1') {
  const id = value => createHash('sha256').update(`${value}:${videoId}`).digest('hex')
  const immutablePublication = {
    publicationId: id(`publication-${byte}`),
    manifestId: id(`manifest-${byte}`),
    renditionId: id(`rendition-${byte}`),
    assetId: id(`asset-${byte}`),
    coreKey: id(`core-${byte}`),
    manifest: { publicationId: id(`publication-${byte}`), body: { renditions: [] } }
  }
  return { id: videoId, immutablePublication }
}

function fakePublisher ({ blockImport = false, importError = null } = {}) {
  const videos = new Map()
  const calls = { ensure: 0, import: 0, catalog: 0, retain: 0 }
  let releaseImport = null
  const importGate = blockImport
    ? new Promise(resolve => { releaseImport = resolve })
    : null
  const channel = {
    async getVideo (videoId) { return videos.get(videoId) || null }
  }
  const publisher = {
    calls,
    videos,
    releaseImport,
    seed (videoId, byte) { videos.set(videoId, publicationFor(videoId, byte)) },
    async ensureAnonymousChannel () {
      calls.ensure++
      return {
        channel,
        channelKey: 'c'.repeat(64),
        publicBeeKey: 'b'.repeat(64),
        publisherId: 'a'.repeat(64)
      }
    },
    async importVideo (input) {
      calls.import++
      if (importGate) {
        await new Promise((resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }))
          input.signal?.addEventListener('abort', abort, { once: true })
          importGate.then(() => {
            input.signal?.removeEventListener?.('abort', abort)
            resolve()
          })
        })
      }
      if (importError) throw importError
      if (input.signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' })
      const metadata = publicationFor(input.videoId)
      videos.set(input.videoId, metadata)
      return { success: true, videoId: input.videoId, metadata, ...metadata.immutablePublication }
    },
    async publishCatalog () {
      calls.catalog++
      return { status: calls.catalog === 1 ? 'published' : 'already-published' }
    },
    async retainAssets () { calls.retain++; return [] }
  }
  return publisher
}

function harness (t, options = {}) {
  const files = options.files || fixture(t)
  const bee = options.bee || fakeBee()
  const store = createIngestJobStore({ bee, now: options.now || (() => Date.now()) })
  const publisher = options.publisher || fakePublisher()
  const manager = createIngestManager({
    store,
    publisher,
    spoolRoot: files.spoolRoot,
    canIngest: options.canIngest || (() => true),
    verifyChunkBytes: 64,
    now: options.now || (() => Date.now())
  })
  t.teardown(() => manager.close())
  return { bee, files, manager, publisher, store }
}

async function waitForState (manager, jobId, state, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await manager.getJob(jobId)
    if (job?.state === state) return job
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`job ${jobId} did not reach ${state}`)
}

async function seedState (manager, store, request, state) {
  const created = await manager.submitJob({ idempotencyKey: `seed-${state}`, request })
  let raw = await store.getJob(created.jobId)
  for (const target of ['acquiring', 'verifying', 'publishing']) {
    if (raw.state === state) break
    raw = await store.transition(created.jobId, { expectedVersion: raw.version, from: raw.state, to: target })
    if (target === state) break
  }
  return raw
}

test('canonical request normalization makes property-order replay stable and keeps ephemeral data out of storage', async (t) => {
  const bytes = Buffer.from('canonical movie payload')
  const request = movieRequest(bytes)
  const { files, manager, store, bee } = harness(t)
  const spool = files.writeSpool(bytes, 'canonical.bin')
  const first = await manager.submitJob({
    idempotencyKey: 'watch-123',
    request,
    spool,
    sourceCapability: 'source-capability-never-durable'
  })
  const replay = await manager.submitJob({ idempotencyKey: 'watch-123', request: reorderedMovieRequest(request), spool: null })

  t.is(first.jobId, replay.jobId)
  t.is(fingerprintIngestRequest(request), fingerprintIngestRequest(reorderedMovieRequest(request)))
  t.alike(normalizeIngestRequest(request), normalizeIngestRequest(reorderedMovieRequest(request)))
  const raw = await store.getJob(first.jobId)
  t.is(raw.requestFingerprint, fingerprintIngestRequest(request))
  const durable = JSON.stringify([...bee.map.entries()])
  t.is(durable.includes(join(files.spoolRoot, 'canonical.bin')), false)
  t.is(durable.includes('source-capability-never-durable'), false)
  t.is(durable.includes('watch-123'), false, 'the idempotency index stores only a digest')
})

test('idempotency conflicts and prohibited source material fail before job mutation', async (t) => {
  const bytes = Buffer.from('conflict payload')
  const request = movieRequest(bytes)
  const { manager, bee } = harness(t)
  await manager.submitJob({ idempotencyKey: 'watch-conflict', request })
  const before = JSON.stringify([...bee.map.entries()])
  await t.exception(
    manager.submitJob({
      idempotencyKey: 'watch-conflict',
      request: { ...request, retentionClass: 'archive-pin' },
      spool: { path: '../escape', complete: true, mimeType: 'video/mp4', byteLength: bytes.byteLength }
    }),
    /IDEMPOTENCY_CONFLICT/
  )
  t.is(JSON.stringify([...bee.map.entries()]), before)

  const invalid = [
    { ...request, sourceUrl: 'https://private.invalid/movie' },
    { ...request, headers: { authorization: 'Bearer secret' } },
    { ...request, passkey: 'secret' },
    { ...request, bundleProvenance: { ...request.bundleProvenance, trackerUrl: 'https://tracker.invalid/a' } },
    { ...request, bundleProvenance: { ...request.bundleProvenance, sourceKind: 'private-torrent' } },
    { ...request, bundleProvenance: { ...request.bundleProvenance, publicTrackerIndependent: false } },
    { ...request, bundleProvenance: { ...request.bundleProvenance, publicTrackerIndependent: undefined } },
    { ...request, unknown: true }
  ]
  for (let index = 0; index < invalid.length; index++) {
    await t.exception(manager.submitJob({ idempotencyKey: `invalid-${index}`, request: invalid[index] }), /INGEST_REQUEST_INVALID/)
  }
})

test('episode coordinates and tracker-independent public infohash are canonical and bounded', async (t) => {
  const bytes = Buffer.from('episode payload')
  const { manager, store } = harness(t)
  const job = await manager.submitJob({ idempotencyKey: 'episode-1', request: episodeRequest(bytes) })
  const raw = await store.getJob(job.jobId)
  t.alike(raw.request.mediaContext, {
    kind: 'episode',
    seriesNamespace: 'tvdb',
    seriesIdentifier: '121361',
    seasonNumber: 1,
    episodeNumber: 2,
    providerEpisodeNamespace: 'tmdb',
    providerEpisodeIdentifier: '62086'
  })
  t.is(raw.retentionClass, 'archive-pin')
})

test('job store enforces legal serialized CAS transitions and terminal rules', async (t) => {
  const bytes = Buffer.from('store payload')
  const { manager, store } = harness(t)
  const created = await manager.submitJob({ idempotencyKey: 'cas-1', request: movieRequest(bytes) })
  let raw = await store.getJob(created.jobId)
  raw = await store.transition(created.jobId, { expectedVersion: 0, from: 'queued', to: 'acquiring' })
  t.is(raw.version, 1)
  await t.exception(store.transition(created.jobId, { expectedVersion: 0, from: 'acquiring', to: 'verifying' }), /INGEST_VERSION_CONFLICT/)
  await t.exception(store.transition(created.jobId, { expectedVersion: 1, from: 'acquiring', to: 'publishing' }), /INGEST_INVALID_TRANSITION/)
  raw = await store.transition(created.jobId, { expectedVersion: 1, from: 'acquiring', to: 'verifying' })
  raw = await store.transition(created.jobId, { expectedVersion: raw.version, from: 'verifying', to: 'failed', patch: { errorCode: 'HASH_MISMATCH', recoverable: false } })
  t.is(raw.state, 'failed')
  await t.exception(store.transition(created.jobId, { expectedVersion: raw.version, from: 'failed', to: 'cancelled' }), /INGEST_JOB_TERMINAL/)
})

test('restart bounds acquiring and verifying jobs as recoverable source reattachment failures', async (t) => {
  const bytes = Buffer.from('restart source payload')
  for (const state of ['acquiring', 'verifying']) {
    const files = fixture(t)
    const bee = fakeBee()
    const first = harness(t, { files, bee })
    const seeded = await seedState(first.manager, first.store, movieRequest(bytes), state)
    await first.manager.close()

    const restarted = harness(t, { files, bee })
    await restarted.manager.start()
    const job = await restarted.manager.getJob(seeded.jobId)
    t.is(job.state, 'failed')
    t.is(job.errorCode, 'SOURCE_REATTACH_REQUIRED')
    t.is(job.recoverable, true)
  }
})

test('restart reconciles a publishing fence through result lookup without a second static publication', async (t) => {
  const bytes = Buffer.from('publishing restart payload')
  const files = fixture(t)
  const bee = fakeBee()
  const publisher = fakePublisher()
  const first = harness(t, { files, bee, publisher })
  const seeded = await seedState(first.manager, first.store, movieRequest(bytes), 'publishing')
  publisher.seed(seeded.publicationFence.videoId, 'restart')
  await first.manager.close()

  const restarted = harness(t, { files, bee, publisher })
  await restarted.manager.start()
  const completed = await restarted.manager.getJob(seeded.jobId)
  t.is(completed.state, 'completed')
  t.is(completed.publicationId, publicationFor(seeded.publicationFence.videoId, 'restart').immutablePublication.publicationId)
  t.is(publisher.calls.import, 0, 'durable fence lookup avoids duplicate static publication')
  t.is(publisher.calls.catalog, 1, 'catalog exposure is idempotently reconciled once')

  await restarted.manager.close()
  const again = harness(t, { files, bee, publisher })
  await again.manager.start()
  t.is(publisher.calls.import, 0)
  t.is(publisher.calls.catalog, 1)
})

test('completed spools stream through the static publisher once and are removed', async (t) => {
  const bytes = Buffer.from('streamed static media '.repeat(100))
  const { files, manager, publisher } = harness(t)
  await manager.start()
  const descriptor = files.writeSpool(bytes, 'success.mkv')
  const created = await manager.submitJob({ idempotencyKey: 'success-1', request: movieRequest(bytes), spool: descriptor })
  const completed = await waitForState(manager, created.jobId, 'completed')
  t.is(completed.bytesReceived, bytes.byteLength)
  t.ok(completed.publicationId)
  t.ok(completed.renditionId)
  t.ok(completed.assetId)
  t.is(publisher.calls.import, 1)
  t.is(publisher.calls.catalog, 1)
  t.is(publisher.calls.retain, 0, 'contribution cache is not archive-pinned')
  t.exception(() => readFileSync(join(files.spoolRoot, 'success.mkv')), /ENOENT/)
})

test('archive-pin publication retains only the completed independent rendition', async (t) => {
  const bytes = Buffer.from('archive pin payload')
  const { files, manager, publisher } = harness(t)
  await manager.start()
  const descriptor = files.writeSpool(bytes, 'archive.mp4', { mimeType: 'video/mp4', etag: undefined })
  const created = await manager.submitJob({ idempotencyKey: 'archive-1', request: episodeRequest(bytes), spool: descriptor })
  await waitForState(manager, created.jobId, 'completed')
  t.is(publisher.calls.import, 1)
  t.is(publisher.calls.retain, 1)
})

test('DELETE cancellation aborts active publication, reaches terminal state, and cleans staging', async (t) => {
  const bytes = Buffer.from('cancel payload '.repeat(100))
  const publisher = fakePublisher({ blockImport: true })
  const { files, manager } = harness(t, { publisher })
  await manager.start()
  const descriptor = files.writeSpool(bytes, 'cancel.mkv')
  const created = await manager.submitJob({ idempotencyKey: 'cancel-1', request: movieRequest(bytes), spool: descriptor })
  await waitForState(manager, created.jobId, 'publishing')
  const cancelled = await manager.cancelJob(created.jobId)
  t.is(cancelled.state, 'cancelled')
  t.is(cancelled.errorCode, 'CANCELLED')
  t.exception(() => readFileSync(join(files.spoolRoot, 'cancel.mkv')), /ENOENT/)
  t.alike(await manager.cancelJob(created.jobId), cancelled, 'terminal DELETE is idempotent')
})

test('size, hash, and ETag mismatches fail closed without publication', async (t) => {
  const bytes = Buffer.from('verified payload')

  {
    const { files, manager, publisher } = harness(t)
    const descriptor = files.writeSpool(bytes, 'size.bin')
    const created = await manager.submitJob({ idempotencyKey: 'size-1', request: movieRequest(bytes), spool: descriptor })
    writeFileSync(join(files.spoolRoot, 'size.bin'), Buffer.concat([bytes, Buffer.from('drift')]))
    await manager.start()
    const failed = await waitForState(manager, created.jobId, 'failed')
    t.is(failed.errorCode, 'SPOOL_LENGTH_MISMATCH')
    t.is(publisher.calls.import, 0)
    t.exception(() => readFileSync(join(files.spoolRoot, 'size.bin')), /ENOENT/)
  }

  {
    const { files, manager, publisher } = harness(t)
    await manager.start()
    const descriptor = files.writeSpool(bytes, 'hash.bin', { sha256: undefined })
    const request = movieRequest(bytes)
    request.expected.sha256 = '00'.repeat(32)
    const created = await manager.submitJob({ idempotencyKey: 'hash-1', request, spool: descriptor })
    const failed = await waitForState(manager, created.jobId, 'failed')
    t.is(failed.errorCode, 'HASH_MISMATCH')
    t.is(publisher.calls.import, 0)
  }

  {
    const { files, manager } = harness(t)
    const descriptor = files.writeSpool(bytes, 'etag.bin', { etag: '"changed"' })
    await t.exception(manager.submitJob({ idempotencyKey: 'etag-1', request: movieRequest(bytes), spool: descriptor }), /ETAG_MISMATCH/)
  }
})

test('disk admission failure is terminal and removes the accepted spool', async (t) => {
  const bytes = Buffer.from('disk admission payload')
  const { files, manager, publisher } = harness(t, { canIngest: () => false })
  await manager.start()
  const descriptor = files.writeSpool(bytes, 'no-space.bin')
  const created = await manager.submitJob({ idempotencyKey: 'disk-1', request: movieRequest(bytes), spool: descriptor })
  const failed = await waitForState(manager, created.jobId, 'failed')
  t.is(failed.errorCode, 'STORAGE_ADMISSION_DENIED')
  t.is(publisher.calls.import, 0)
  t.exception(() => readFileSync(join(files.spoolRoot, 'no-space.bin')), /ENOENT/)
})

test('spool ownership rejects traversal, absolute paths, directories, and symlinks', async (t) => {
  const bytes = Buffer.from('path payload')
  const files = fixture(t)
  const { manager } = harness(t, { files })
  const request = movieRequest(bytes)
  const outside = join(files.root, 'outside.bin')
  writeFileSync(outside, bytes)
  symlinkSync(outside, join(files.spoolRoot, 'linked.bin'))
  mkdirSync(join(files.spoolRoot, 'directory'))

  const invalid = [
    { path: '../outside.bin', complete: true, mimeType: 'video/mp4', byteLength: bytes.byteLength },
    { path: outside, complete: true, mimeType: 'video/mp4', byteLength: bytes.byteLength },
    { path: 'directory', complete: true, mimeType: 'video/mp4', byteLength: bytes.byteLength },
    { path: 'linked.bin', complete: true, mimeType: 'video/mp4', byteLength: bytes.byteLength }
  ]
  for (let index = 0; index < invalid.length; index++) {
    await t.exception(manager.submitJob({ idempotencyKey: `path-${index}`, request, spool: invalid[index] }), /SPOOL_PATH_INVALID|SPOOL_TYPE_INVALID/)
  }
  t.is(readFileSync(outside).toString(), bytes.toString(), 'rejected staging never removes an outside target')
})

test('publication failures persist only bounded error codes and clean staging', async (t) => {
  const bytes = Buffer.from('bounded error payload')
  const huge = Object.assign(new Error(`authorization=${'secret'.repeat(1000)}`), { code: `TOO_${'LONG'.repeat(100)}` })
  const publisher = fakePublisher({ importError: huge })
  const { files, manager, store, bee } = harness(t, { publisher })
  await manager.start()
  const descriptor = files.writeSpool(bytes, 'failure.bin')
  const created = await manager.submitJob({ idempotencyKey: 'failure-1', request: movieRequest(bytes), spool: descriptor })
  const failed = await waitForState(manager, created.jobId, 'failed')
  t.is(failed.errorCode, 'PUBLICATION_FAILED')
  t.ok(Buffer.byteLength(failed.errorCode) <= 64)
  const raw = await store.getJob(created.jobId)
  t.is('error' in raw, false)
  t.is(JSON.stringify([...bee.map.entries()]).includes('authorization='), false)
  t.exception(() => readFileSync(join(files.spoolRoot, 'failure.bin')), /ENOENT/)
})

test('persistence failures expose one bounded stable error and never half-write the idempotency index', async (t) => {
  const bytes = Buffer.from('persistence payload')
  const files = fixture(t)
  const bee = fakeBee({ failFlush: true })
  const store = createIngestJobStore({ bee })
  const manager = createIngestManager({ store, publisher: fakePublisher(), spoolRoot: files.spoolRoot })
  t.teardown(() => manager.close())
  const error = await manager.submitJob({ idempotencyKey: 'persistence-1', request: movieRequest(bytes) }).then(() => null, value => value)
  t.ok(error instanceof IngestJobStoreError)
  t.is(error.code, 'INGEST_PERSISTENCE_FAILED')
  t.ok(Buffer.byteLength(error.message) <= 128)
  t.is(bee.map.size, 0)
})

test('companion routes expose redacted jobs and map idempotency conflict without weakening the route contract', async (t) => {
  const bytes = Buffer.from('route payload')
  const { manager } = harness(t)
  const service = {
    submitIngestJob: input => manager.submitJob(input),
    getIngestJob: jobId => manager.getJob(jobId),
    cancelIngestJob: jobId => manager.cancelJob(jobId)
  }
  const router = createCompanionRouter({ service })
  const request = movieRequest(bytes)
  const post = await router.dispatch({
    method: 'POST',
    url: '/api/v2/ingest/jobs',
    body: Buffer.from(JSON.stringify({ idempotencyKey: 'route-1', request, sourceCapability: 'opaque-source-capability' }))
  })
  t.is(post.statusCode, 202)
  t.is(post.body.job.state, 'queued')
  t.absent(post.body.job.request)
  t.absent(post.body.job.requestFingerprint)
  t.absent(post.body.job.publicationFence)
  t.absent(post.body.job.sourceCapability)
  t.absent(post.body.job.spool)

  const get = await router.dispatch({ method: 'GET', url: `/api/v2/ingest/jobs/${post.body.job.jobId}`, body: Buffer.alloc(0) })
  t.is(get.statusCode, 200)
  t.alike(get.body.job, post.body.job)

  const changed = await router.dispatch({
    method: 'POST',
    url: '/api/v2/ingest/jobs',
    body: Buffer.from(JSON.stringify({ idempotencyKey: 'route-1', request: { ...request, retentionClass: 'archive-pin' } }))
  })
  t.is(changed.statusCode, 409)
  t.is(changed.body.error.code, 'IDEMPOTENCY_CONFLICT')
})
