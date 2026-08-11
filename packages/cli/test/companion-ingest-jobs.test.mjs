import test from 'brittle'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request as httpRequest } from 'node:http'

import {
  createIngestJobStore,
  IngestJobStoreError
} from '../src/companion/ingest-job-store.js'
import {
  createIngestManager,
  fingerprintIngestRequest,
  normalizeIngestRequest
} from '../src/companion/ingest-manager.js'
import { signControlRequest } from '../src/companion/auth.js'
import { resolveCompanionConfig } from '../src/companion/config.js'
import { createCompanionServer } from '../src/companion/server.js'
import { createCompanionRouter } from '../src/companion/routes.js'
import { createArchivePublisher } from '../src/archive-manager.js'

function fakeBee ({ failFlush = false, beforeGet = null, afterFlush = null } = {}) {
  const map = new Map()
  const clone = value => JSON.parse(JSON.stringify(value))
  return {
    map,
    async get (key) {
      await beforeGet?.(key)
      return map.has(key) ? { value: clone(map.get(key)) } : null
    },
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
          await afterFlush?.()
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

function fakePublisher ({ blockImport = false, importError = null, commitThenThrow = false, blockAfterCommit = false } = {}) {
  const videos = new Map()
  const calls = { ensure: 0, ensureOptions: [], import: 0, importSignals: [], catalog: 0, retain: 0 }
  let releaseImport = null
  let releaseCommitted = null
  let notifyCommitted = null
  const committed = blockAfterCommit ? new Promise(resolve => { notifyCommitted = resolve }) : null
  const committedGate = blockAfterCommit ? new Promise(resolve => { releaseCommitted = resolve }) : null
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
    committed,
    releaseCommitted,
    async ensureAnonymousChannel (options) {
      calls.ensure++
      calls.ensureOptions.push(options)
      return {
        channel,
        channelKey: 'c'.repeat(64),
        publicBeeKey: 'b'.repeat(64),
        publisherId: 'a'.repeat(64)
      }
    },
    async importVideo (input) {
      calls.import++
      calls.importSignals.push(input.signal)
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
      if (committedGate) {
        notifyCommitted()
        await committedGate
      }
      if (commitThenThrow) throw new Error('publication acknowledgement lost')
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
  const { manager, bee, files } = harness(t)
  await manager.submitJob({ idempotencyKey: 'watch-conflict', request })
  const before = JSON.stringify([...bee.map.entries()])
  const callerSpool = files.writeSpool(bytes, 'conflict-caller-owned.mkv')
  await t.exception(
    manager.submitJob({
      idempotencyKey: 'watch-conflict',
      request: { ...request, retentionClass: 'archive-pin' },
      spool: callerSpool
    }),
    /IDEMPOTENCY_CONFLICT/
  )
  t.is(JSON.stringify([...bee.map.entries()]), before)
  t.is(readFileSync(join(files.spoolRoot, 'conflict-caller-owned.mkv')).byteLength, bytes.byteLength)

  const invalid = [
    { ...request, sourceUrl: 'https://private.invalid/movie' },
    { ...request, headers: { authorization: 'Bearer secret' } },
    { ...request, passkey: 'secret' },
    { ...request, bundleProvenance: { ...request.bundleProvenance, trackerUrl: 'https://tracker.invalid/a' } },
    { ...request, bundleProvenance: { ...request.bundleProvenance, sourceKind: 'private-torrent' } },
    { ...request, bundleProvenance: { ...request.bundleProvenance, publicTrackerIndependent: false } },
    { ...request, bundleProvenance: { ...request.bundleProvenance, publicTrackerIndependent: undefined } },
    { ...request, expected: { byteLength: bytes.byteLength } },
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

test('job store rejects duplicate idempotency aliases and corrupt index bindings', async (t) => {
  const bytes = Buffer.from('index corruption payload')
  const { manager, store, bee } = harness(t)
  const created = await manager.submitJob({ idempotencyKey: 'index-original', request: movieRequest(bytes) })
  const originalIndexKey = [...bee.map.keys()].find(key => key.startsWith('companion-ingest/v1/idempotency/'))
  const originalDigest = originalIndexKey.slice('companion-ingest/v1/idempotency/'.length)
  const pointer = bee.map.get(originalIndexKey)
  const duplicateDigest = 'f'.repeat(64)
  bee.map.set(`companion-ingest/v1/idempotency/${duplicateDigest}`, { ...pointer, idempotencyDigest: duplicateDigest })

  const duplicateError = await store.findByIdempotency(duplicateDigest).then(() => null, error => error)
  t.is(duplicateError?.code, 'INGEST_PERSISTENCE_CORRUPT')

  const jobKey = `companion-ingest/v1/job/${created.jobId}`
  const record = bee.map.get(jobKey)
  bee.map.set(jobKey, { ...record, requestFingerprint: '0'.repeat(64) })
  const corruptError = await store.findByIdempotency(originalDigest).then(() => null, error => error)
  t.is(corruptError?.code, 'INGEST_PERSISTENCE_CORRUPT')
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

test('an uncertain publication acknowledgement reconciles the fenced result without publishing twice', async (t) => {
  const bytes = Buffer.from('uncertain publication payload')
  const publisher = fakePublisher({ commitThenThrow: true })
  const { files, manager } = harness(t, { publisher })
  await manager.start()
  const descriptor = files.writeSpool(bytes, 'uncertain.mkv')
  const created = await manager.submitJob({ idempotencyKey: 'uncertain-1', request: movieRequest(bytes), spool: descriptor })
  const completed = await waitForState(manager, created.jobId, 'completed')

  t.ok(completed.publicationId)
  t.is(publisher.calls.import, 1)
  t.is(publisher.calls.catalog, 1)

  t.exception(() => readFileSync(join(files.spoolRoot, 'uncertain.mkv')), /ENOENT/)
})

test('a publication crossing its commit fence wins cancellation without a second import', async (t) => {
  const bytes = Buffer.from('publication cancellation fence payload')
  const publisher = fakePublisher({ commitThenThrow: true, blockAfterCommit: true })
  const { files, manager } = harness(t, { publisher })
  await manager.start()
  const descriptor = files.writeSpool(bytes, 'cancel-fence.mkv')
  const created = await manager.submitJob({ idempotencyKey: 'cancel-fence-1', request: movieRequest(bytes), spool: descriptor })
  await publisher.committed
  const cancellation = manager.cancelJob(created.jobId)
  while (!publisher.calls.importSignals[0]?.aborted) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  publisher.releaseCommitted()
  const completed = await cancellation

  t.is(completed.state, 'completed')
  t.ok(completed.publicationId)
  t.is(publisher.calls.import, 1)
  t.is(publisher.calls.catalog, 1)
  t.exception(() => readFileSync(join(files.spoolRoot, 'cancel-fence.mkv')), /ENOENT/)
})

test('ingest publication requires a deterministic media-context source channel', async (t) => {
  const bytes = Buffer.from('deterministic source payload')
  const { files, manager, publisher } = harness(t)
  await manager.start()
  const first = await manager.submitJob({
    idempotencyKey: 'source-channel-1',
    request: movieRequest(bytes),
    spool: files.writeSpool(bytes, 'source-1.mkv')
  })
  await waitForState(manager, first.jobId, 'completed')
  const secondRequest = movieRequest(bytes, {
    measuredFacts: { ...movieRequest(bytes).measuredFacts, title: 'A Different Display Title' }
  })
  const second = await manager.submitJob({
    idempotencyKey: 'source-channel-2',
    request: secondRequest,
    spool: files.writeSpool(bytes, 'source-2.mkv')
  })
  await waitForState(manager, second.jobId, 'completed')

  t.is(publisher.calls.ensureOptions.length, 2)
  t.ok(publisher.calls.ensureOptions.every(options => options.requireSourceChannel === true))
  t.is(publisher.calls.ensureOptions[0].sourceIdentity.sourceId, publisher.calls.ensureOptions[1].sourceIdentity.sourceId)
  t.not(publisher.calls.ensureOptions[0].sourceIdentity.creatorName, publisher.calls.ensureOptions[1].sourceIdentity.creatorName)
})

test('archive publisher does not fall back to the shared channel when deterministic source creation fails', async (t) => {
  let sharedChannelReads = 0
  const publisher = createArchivePublisher({
    identityManager: {
      getActiveIdentity () { return { driveKey: 'd'.repeat(64), publicKey: 'a'.repeat(64) } },
      async getActiveChannel () {
        sharedChannelReads++
        return { blobs: {}, async getMetadata () { return { publicBeeKey: 'b'.repeat(64) } } }
      }
    },
    uploadManager: {},
    api: {},
    runtime: { ctx: {}, logger: { archive: { warn () {} } } },
    createChannelFn: async () => { throw new Error('source channel unavailable') }
  })

  await t.exception(publisher.ensureAnonymousChannel({
    sourceIdentity: { sourceId: 'companion-source', creatorName: 'Archive' },
    requireSourceChannel: true
  }), /source channel unavailable/)
  t.is(sharedChannelReads, 0)
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

test('direct queued and terminal replays discard only the unadopted spool', async (t) => {
  const bytes = Buffer.from('direct replay cleanup payload '.repeat(20))
  const request = movieRequest(bytes)
  const { files, manager, publisher } = harness(t)
  const accepted = files.writeSpool(bytes, 'direct-accepted.mkv')
  const created = await manager.submitJob({ idempotencyKey: 'direct-replay-cleanup', request, spool: accepted })
  const queuedReplay = files.writeSpool(bytes, 'direct-queued-replay.mkv')
  const replayed = await manager.submitJob({ idempotencyKey: 'direct-replay-cleanup', request, spool: queuedReplay })

  t.is(replayed.jobId, created.jobId)
  t.is(readFileSync(join(files.spoolRoot, 'direct-accepted.mkv')).byteLength, bytes.byteLength)
  t.exception(() => readFileSync(join(files.spoolRoot, 'direct-queued-replay.mkv')), /ENOENT/)

  await manager.start()
  await waitForState(manager, created.jobId, 'completed')
  t.is(publisher.calls.import, 1)
  const terminalReplay = files.writeSpool(bytes, 'direct-terminal-replay.mkv')
  const completed = await manager.submitJob({ idempotencyKey: 'direct-replay-cleanup', request, spool: terminalReplay })
  t.is(completed.state, 'completed')
  t.is(publisher.calls.import, 1)
  t.exception(() => readFileSync(join(files.spoolRoot, 'direct-terminal-replay.mkv')), /ENOENT/)
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

test('cancellation serializes with replay attachment without orphaning or conflicting the accepted spool', async (t) => {
  let blockReplayRead = false
  let enterReplayRead
  let releaseReplayRead
  const replayReadEntered = new Promise(resolve => { enterReplayRead = resolve })
  const replayReadGate = new Promise(resolve => { releaseReplayRead = resolve })
  const bee = fakeBee({
    beforeGet: async key => {
      if (!blockReplayRead || !key.startsWith('companion-ingest/v1/idempotency/')) return
      blockReplayRead = false
      enterReplayRead()
      await replayReadGate
    }
  })
  const publisher = fakePublisher({ blockImport: true })
  const { files, manager } = harness(t, { bee, publisher })
  await manager.start()
  const bytes = Buffer.from('cancel replay race payload '.repeat(20))
  const request = movieRequest(bytes)
  const created = await manager.submitJob({ idempotencyKey: 'cancel-replay-race', request })
  const descriptor = files.writeSpool(bytes, 'cancel-replay-race.mkv')
  let accepted = 0
  blockReplayRead = true
  const replayPromise = manager.submitJob({
    idempotencyKey: 'cancel-replay-race',
    request,
    spool: descriptor,
    ingestSpoolLease: {
      accept (spool) {
        accepted++
        t.is(spool.filePath, join(files.spoolRoot, 'cancel-replay-race.mkv'))
        return true
      }
    }
  })
  await replayReadEntered
  const cancelPromise = manager.cancelJob(created.jobId)
  releaseReplayRead()

  const replay = await replayPromise
  const cancelled = await cancelPromise
  publisher.releaseImport()
  t.is(replay.jobId, created.jobId)
  t.is(accepted, 1)
  t.is(cancelled.state, 'cancelled')
  t.is(cancelled.errorCode, 'CANCELLED')
  t.exception(() => readFileSync(join(files.spoolRoot, 'cancel-replay-race.mkv')), /ENOENT/)
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
  const publisher = fakePublisher()
  const manager = createIngestManager({ store, publisher, spoolRoot: files.spoolRoot })
  t.teardown(() => manager.close())
  await manager.start()
  const descriptor = files.writeSpool(bytes, 'persistence-failure.mkv')
  const error = await manager.submitJob({
    idempotencyKey: 'persistence-1',
    request: movieRequest(bytes),
    spool: descriptor
  }).then(() => null, value => value)
  t.ok(error instanceof IngestJobStoreError)
  t.is(error.code, 'INGEST_PERSISTENCE_FAILED')
  t.ok(Buffer.byteLength(error.message) <= 128)
  t.is(bee.map.size, 0)
  t.is(publisher.calls.import, 0)
  t.exception(() => readFileSync(join(files.spoolRoot, 'persistence-failure.mkv')), /ENOENT/)
})

test('direct spool abort during committed persistence cleans the unadopted file and permits replay', async (t) => {
  let blockPersistence = false
  let enterPersistence
  let releasePersistence
  const persistenceEntered = new Promise(resolve => { enterPersistence = resolve })
  const persistenceGate = new Promise(resolve => { releasePersistence = resolve })
  const bee = fakeBee({
    afterFlush: async () => {
      if (!blockPersistence) return
      blockPersistence = false
      enterPersistence()
      await persistenceGate
    }
  })
  const files = fixture(t)
  const store = createIngestJobStore({ bee })
  const publisher = fakePublisher()
  const manager = createIngestManager({ store, publisher, spoolRoot: files.spoolRoot, verifyChunkBytes: 64 })
  t.teardown(() => manager.close())
  await manager.start()
  const bytes = Buffer.from('direct abort persistence payload '.repeat(10))
  const request = movieRequest(bytes)
  const controller = new globalThis.AbortController()
  blockPersistence = true
  const submission = manager.submitJob({
    idempotencyKey: 'direct-abort-persistence',
    request,
    spool: files.writeSpool(bytes, 'direct-abort.mkv'),
    signal: controller.signal
  })
  await persistenceEntered
  controller.abort()
  releasePersistence()
  const error = await submission.then(() => null, value => value)

  t.is(error?.code, 'CANCELLED')
  t.is(publisher.calls.import, 0)
  t.exception(() => readFileSync(join(files.spoolRoot, 'direct-abort.mkv')), /ENOENT/)
  const jobKey = [...bee.map.keys()].find(key => key.startsWith('companion-ingest/v1/job/'))
  const jobId = jobKey.slice('companion-ingest/v1/job/'.length)
  t.is((await manager.getJob(jobId)).state, 'queued')

  const replay = await manager.submitJob({
    idempotencyKey: 'direct-abort-persistence',
    request,
    spool: files.writeSpool(bytes, 'direct-abort-replay.mkv')
  })
  t.is(replay.jobId, jobId)
  await waitForState(manager, jobId, 'completed')
  t.is(publisher.calls.import, 1)
  t.exception(() => readFileSync(join(files.spoolRoot, 'direct-abort-replay.mkv')), /ENOENT/)
})

test('manager close during committed persistence cleans a direct spool and leaves a replayable job', async (t) => {
  let blockPersistence = false
  let enterPersistence
  let releasePersistence
  const persistenceEntered = new Promise(resolve => { enterPersistence = resolve })
  const persistenceGate = new Promise(resolve => { releasePersistence = resolve })
  const bee = fakeBee({
    afterFlush: async () => {
      if (!blockPersistence) return
      blockPersistence = false
      enterPersistence()
      await persistenceGate
    }
  })
  const files = fixture(t)
  const publisher = fakePublisher()
  const firstStore = createIngestJobStore({ bee })
  const first = createIngestManager({ store: firstStore, publisher, spoolRoot: files.spoolRoot, verifyChunkBytes: 64 })
  await first.start()
  const bytes = Buffer.from('direct close persistence payload '.repeat(10))
  const request = movieRequest(bytes)
  blockPersistence = true
  const submission = first.submitJob({
    idempotencyKey: 'direct-close-persistence',
    request,
    spool: files.writeSpool(bytes, 'direct-close.mkv')
  })
  await persistenceEntered
  const closing = first.close()
  releasePersistence()
  const error = await submission.then(() => null, value => value)
  await closing

  t.is(error?.code, 'INGEST_MANAGER_CLOSED')
  t.is(publisher.calls.import, 0)
  t.exception(() => readFileSync(join(files.spoolRoot, 'direct-close.mkv')), /ENOENT/)
  const jobKey = [...bee.map.keys()].find(key => key.startsWith('companion-ingest/v1/job/'))
  const jobId = jobKey.slice('companion-ingest/v1/job/'.length)

  const secondStore = createIngestJobStore({ bee })
  const second = createIngestManager({ store: secondStore, publisher, spoolRoot: files.spoolRoot, verifyChunkBytes: 64 })
  t.teardown(() => second.close())
  await second.start()
  t.is((await second.getJob(jobId)).state, 'queued')
  const replay = await second.submitJob({
    idempotencyKey: 'direct-close-persistence',
    request,
    spool: files.writeSpool(bytes, 'direct-close-replay.mkv')
  })
  t.is(replay.jobId, jobId)
  await waitForState(second, jobId, 'completed')
  t.is(publisher.calls.import, 1)
  t.exception(() => readFileSync(join(files.spoolRoot, 'direct-close-replay.mkv')), /ENOENT/)
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

const MULTIPART_SECRET = 'ef'.repeat(32)
const MULTIPART_CLIENT = 'mediastorm-multipart'
const MULTIPART_NOW = 1_786_406_400_000

function multipartBody ({ boundary, request, idempotencyKey, bytes, etag = null, extraParts = [], close = true }) {
  const chunks = []
  const field = (name, value) => {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  field('idempotencyKey', idempotencyKey)
  field('request', JSON.stringify(request))
  if (etag != null) field('etag', etag)
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="media.bin"\r\nContent-Type: video/mp4\r\n\r\n`))
  chunks.push(bytes, Buffer.from('\r\n'))
  for (const part of extraParts) {
    if (part.file) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename || 'extra.bin'}"\r\nContent-Type: application/octet-stream\r\n\r\n`))
      chunks.push(part.bytes || Buffer.from('extra'), Buffer.from('\r\n'))
    } else {
      field(part.name, part.value)
    }
  }
  if (close) chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

function stagingEntries (spoolRoot) {
  try {
    return readdirSync(join(spoolRoot, 'uploads'))
  } catch {
    return []
  }
}

async function createMultipartHarness (t, {
  requestDeadlineMs = 30_000,
  maxBodyBytes = 64 * 1024,
  maxIngestBytes = 1024 * 1024,
  clock = () => MULTIPART_NOW,
  canArchive = () => true,
  publisher = fakePublisher(),
  bee = fakeBee(),
  onSubmitSignal = null
} = {}) {
  const files = fixture(t)
  const store = createIngestJobStore({ bee })
  const manager = createIngestManager({ store, publisher, spoolRoot: files.spoolRoot, verifyChunkBytes: 64 })
  await manager.start()
  let submissions = 0
  const service = {
    canArchive,
    async submitIngestJob (input, { ingestSpoolLease = null, signal = null } = {}) {
      submissions++
      onSubmitSignal?.(signal)
      return manager.submitJob({ ...input, ingestSpoolLease, signal })
    },
    getIngestJob: jobId => manager.getJob(jobId),
    cancelIngestJob: jobId => manager.cancelJob(jobId)
  }
  const config = resolveCompanionConfig({
    enabled: true,
    transport: 'tcp',
    host: '127.0.0.1',
    port: 0,
    client: MULTIPART_CLIENT,
    sharedSecret: MULTIPART_SECRET,
    maxBodyBytes
  }, { storagePath: files.root })
  const server = createCompanionServer({
    service,
    config,
    clock,
    ingestSpoolRoot: files.spoolRoot,
    maxIngestBytes,
    requestDeadlineMs
  })
  const state = await server.start()
  t.teardown(async () => {
    await server.close().catch(() => {})
    await manager.close().catch(() => {})
  })
  return { bee, files, manager, publisher, server, state, store, submissions: () => submissions }
}

function sendMultipart ({
  state,
  body,
  boundary,
  nonce,
  timestamp = MULTIPART_NOW,
  signedBody = body,
  chunkBytes = body.byteLength,
  delayMs = 0,
  contentLength = false,
  headersOnly = false,
  onChunk = null,
  abortAfterChunks = null,
  onRequest = null
}) {
  const path = '/api/v2/ingest/jobs'
  const auth = signControlRequest({
    method: 'POST',
    path,
    body: signedBody,
    timestamp,
    nonce,
    client: MULTIPART_CLIENT,
    secret: MULTIPART_SECRET
  })
  return new Promise((resolve, reject) => {
    let settled = false
    let responseStarted = false
    let stopWriting = false
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      stopWriting = true
      callback(value)
    }
    const req = httpRequest({
      host: state.host,
      port: state.port,
      method: 'POST',
      path,
      headers: {
        ...auth,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        ...(contentLength ? { 'content-length': body.byteLength } : {})
      }
    }, response => {
      responseStarted = true
      stopWriting = true
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => settle(resolve, {
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }))
      response.once('error', error => settle(reject, error))
    })
    onRequest?.(req)
    req.once('error', error => {
      if (responseStarted || settled) return
      if (abortAfterChunks != null) settle(resolve, { aborted: true, error })
      else settle(reject, error)
    })
    if (headersOnly) {
      req.end()
      return
    }
    void (async () => {
      let chunkIndex = 0
      for (let offset = 0; offset < body.byteLength; offset += chunkBytes) {
        if (stopWriting || settled) return
        const chunk = body.subarray(offset, Math.min(offset + chunkBytes, body.byteLength))
        try {
          req.write(chunk)
        } catch (error) {
          if (responseStarted || settled) return
          throw error
        }
        chunkIndex++
        onChunk?.(chunkIndex)
        if (abortAfterChunks != null && chunkIndex >= abortAfterChunks) {
          stopWriting = true
          req.destroy()
          return
        }
        if (delayMs) await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs))
      }
      if (!stopWriting && !settled) req.end()
    })().catch(error => {
      if (!responseStarted && !settled) settle(reject, error)
    })
  })
}

test('authenticated multipart ingest streams a chunked body larger than the JSON limit and uses an idle deadline', async (t) => {
  const bytes = Buffer.from('multipart streamed media '.repeat(80))
  const request = movieRequest(bytes)
  const boundary = 'peartubeMultipartSuccess'
  const body = multipartBody({
    boundary,
    request,
    idempotencyKey: 'multipart-success',
    bytes,
    etag: request.expected.etag
  })
  let now = MULTIPART_NOW
  const harness = await createMultipartHarness(t, {
    requestDeadlineMs: 50,
    maxBodyBytes: 2048,
    clock: () => now
  })
  t.ok(body.byteLength > 2048)
  const response = await sendMultipart({
    state: harness.state,
    body,
    boundary,
    nonce: 'multipart-success-nonce',
    chunkBytes: 512,
    delayMs: 20,
    onChunk (index) {
      if (index === 2) now = MULTIPART_NOW + 60_000
    }
  })
  t.is(response.statusCode, 202, response.body)
  const accepted = JSON.parse(response.body).job
  await waitForState(harness.manager, accepted.jobId, 'completed')
  const terminalReplay = await sendMultipart({
    state: harness.state,
    body,
    boundary,
    nonce: 'multipart-terminal-replay',
    timestamp: now
  })
  t.is(terminalReplay.statusCode, 202, terminalReplay.body)
  t.is(JSON.parse(terminalReplay.body).job.jobId, accepted.jobId)
  t.is(JSON.parse(terminalReplay.body).job.state, 'completed')
  t.is(harness.publisher.calls.import, 1)
  t.alike(stagingEntries(harness.files.spoolRoot), [])
})

test('disconnect at the final spool-handoff checkpoint leaves ownership unaccepted and replayable', async (t) => {
  let blockSubmission = false
  let enterPersistence
  let releasePersistence
  const persistenceEntered = new Promise(resolve => { enterPersistence = resolve })
  const persistenceGate = new Promise(resolve => { releasePersistence = resolve })
  const bee = fakeBee({
    afterFlush: async () => {
      if (!blockSubmission) return
      blockSubmission = false
      enterPersistence()
      await persistenceGate
    }
  })
  let observeAbort
  const submissionAborted = new Promise(resolve => { observeAbort = resolve })
  const harness = await createMultipartHarness(t, {
    bee,
    onSubmitSignal (signal) {
      if (signal?.aborted) observeAbort()
      else signal?.addEventListener?.('abort', observeAbort, { once: true })
    }
  })
  const bytes = Buffer.from('disconnect after staging payload '.repeat(10))
  const request = movieRequest(bytes)
  const boundary = 'peartubeMultipartDisconnect'
  const body = multipartBody({
    boundary,
    request,
    idempotencyKey: 'multipart-disconnect',
    bytes,
    etag: request.expected.etag
  })
  let clientRequest = null
  blockSubmission = true
  const response = sendMultipart({
    state: harness.state,
    body,
    boundary,
    nonce: 'multipart-disconnect-nonce',
    onRequest (value) { clientRequest = value }
  })
  await persistenceEntered
  clientRequest.destroy(new Error('client disconnected'))
  await t.exception(response)
  await submissionAborted
  await new Promise(resolve => setTimeout(resolve, 0))
  releasePersistence()

  const deadline = Date.now() + 2000
  while (stagingEntries(harness.files.spoolRoot).length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  t.is(harness.submissions(), 1)
  t.alike(stagingEntries(harness.files.spoolRoot), [])
  const jobKey = [...bee.map.keys()].find(key => key.startsWith('companion-ingest/v1/job/'))
  t.ok(jobKey, 'the acknowledged persistence boundary may retain a replayable queued job')
  const jobId = jobKey.slice('companion-ingest/v1/job/'.length)
  t.is((await harness.manager.getJob(jobId)).state, 'queued')
  t.is(harness.publisher.calls.import, 0)

  const replay = await sendMultipart({
    state: harness.state,
    body,
    boundary,
    nonce: 'multipart-disconnect-replay'
  })
  t.is(replay.statusCode, 202, replay.body)
  t.is(JSON.parse(replay.body).job.jobId, jobId)
  await waitForState(harness.manager, jobId, 'completed')
  t.is(harness.publisher.calls.import, 1)
  t.alike(stagingEntries(harness.files.spoolRoot), [])
})

test('multipart replay while the original attachment publishes never transfers the second staging lease', async (t) => {
  const bytes = Buffer.from('multipart active replay payload '.repeat(20))
  const request = movieRequest(bytes)
  const boundary = 'peartubeMultipartActiveReplay'
  const body = multipartBody({
    boundary,
    request,
    idempotencyKey: 'multipart-active-replay',
    bytes,
    etag: request.expected.etag
  })
  const publisher = fakePublisher({ blockImport: true })
  const harness = await createMultipartHarness(t, { publisher })
  const first = await sendMultipart({
    state: harness.state,
    body,
    boundary,
    nonce: 'multipart-active-first'
  })
  t.is(first.statusCode, 202, first.body)
  const firstJob = JSON.parse(first.body).job
  await waitForState(harness.manager, firstJob.jobId, 'publishing')
  const ownedBeforeReplay = stagingEntries(harness.files.spoolRoot)
  t.is(ownedBeforeReplay.length, 1)

  const replay = await sendMultipart({
    state: harness.state,
    body,
    boundary,
    nonce: 'multipart-active-second'
  })
  t.is(replay.statusCode, 202, replay.body)
  t.is(JSON.parse(replay.body).job.jobId, firstJob.jobId)
  t.alike(stagingEntries(harness.files.spoolRoot), ownedBeforeReplay)
  t.is(publisher.calls.import, 1)

  publisher.releaseImport()
  await waitForState(harness.manager, firstJob.jobId, 'completed')
  t.is(publisher.calls.import, 1)
  t.alike(stagingEntries(harness.files.spoolRoot), [])
})

test('multipart invalid MAC and replay delete staging before any second job mutation', async (t) => {
  const bytes = Buffer.from('multipart authentication payload')
  const request = movieRequest(bytes)
  const boundary = 'peartubeMultipartAuth'
  const body = multipartBody({ boundary, request, idempotencyKey: 'multipart-auth', bytes, etag: request.expected.etag })
  const harness = await createMultipartHarness(t)

  const invalid = await sendMultipart({
    state: harness.state,
    body,
    signedBody: Buffer.from('different raw body'),
    boundary,
    nonce: 'multipart-invalid-mac'
  })
  t.is(invalid.statusCode, 401)
  t.is(harness.submissions(), 0)
  t.alike(stagingEntries(harness.files.spoolRoot), [])

  const first = await sendMultipart({ state: harness.state, body, boundary, nonce: 'multipart-replay-nonce' })
  t.is(first.statusCode, 202)
  await waitForState(harness.manager, JSON.parse(first.body).job.jobId, 'completed')
  const replay = await sendMultipart({ state: harness.state, body, boundary, nonce: 'multipart-replay-nonce' })
  t.is(replay.statusCode, 409)
  t.is(harness.submissions(), 1)
  t.alike(stagingEntries(harness.files.spoolRoot), [])
})

test('multipart parser rejects semantic errors, declared body overflow, and chunked file overflow with cleanup', async (t) => {
  const bytes = Buffer.from('multipart strict parser payload')
  const request = movieRequest(bytes)
  const harness = await createMultipartHarness(t, { maxIngestBytes: 128 })
  const cases = [
    {
      boundary: 'peartubeExtraFile',
      body: multipartBody({
        boundary: 'peartubeExtraFile',
        request,
        idempotencyKey: 'multipart-extra-file',
        bytes,
        etag: request.expected.etag,
        extraParts: [{ file: true, name: 'file', bytes: Buffer.from('second') }]
      }),
      nonce: 'multipart-extra-file-nonce',
      expected: 400
    },
    {
      boundary: 'peartubeUnknownField',
      body: multipartBody({
        boundary: 'peartubeUnknownField',
        request,
        idempotencyKey: 'multipart-unknown-field',
        bytes,
        etag: request.expected.etag,
        extraParts: [{ name: 'sourceUrl', value: 'opaque' }]
      }),
      nonce: 'multipart-unknown-nonce',
      expected: 400
    },
    {
      boundary: 'peartubeMalformed',
      body: multipartBody({
        boundary: 'peartubeMalformed',
        request,
        idempotencyKey: 'multipart-malformed',
        bytes,
        etag: request.expected.etag,
        close: false
      }),
      nonce: 'multipart-malformed-nonce',
      expected: 400
    },
    {
      boundary: 'peartubeOversize',
      body: multipartBody({
        boundary: 'peartubeOversize',
        request,
        idempotencyKey: 'multipart-oversize',
        bytes: Buffer.alloc(2 * 1024 * 1024, 1),
        etag: request.expected.etag
      }),
      nonce: 'multipart-oversize-nonce',
      expected: 413,
      contentLength: true,
      headersOnly: true
    },
    {
      boundary: 'peartubeChunkedOversize',
      body: multipartBody({
        boundary: 'peartubeChunkedOversize',
        request,
        idempotencyKey: 'multipart-chunked-oversize',
        bytes: Buffer.alloc(256, 1),
        etag: request.expected.etag
      }),
      nonce: 'multipart-chunked-oversize-nonce',
      expected: 413,
      chunkBytes: 64,
      delayMs: 1
    }
  ]
  for (const item of cases) {
    const response = await sendMultipart({
      state: harness.state,
      body: item.body,
      boundary: item.boundary,
      nonce: item.nonce,
      contentLength: item.contentLength,
      headersOnly: item.headersOnly,
      chunkBytes: item.chunkBytes,
      delayMs: item.delayMs
    })
    t.is(response.statusCode, item.expected, response.body)
    t.alike(stagingEntries(harness.files.spoolRoot), [])
  }
  t.is(harness.submissions(), 0)
})

test('multipart abort, staging admission, and request/file size mismatch never leave a spool or durable job', async (t) => {
  const bytes = Buffer.from('multipart abort payload '.repeat(20))
  const request = movieRequest(bytes)

  {
    const boundary = 'peartubeAbort'
    const body = multipartBody({ boundary, request, idempotencyKey: 'multipart-abort', bytes, etag: request.expected.etag })
    const harness = await createMultipartHarness(t)
    const aborted = await sendMultipart({
      state: harness.state,
      body,
      boundary,
      nonce: 'multipart-abort-nonce',
      chunkBytes: 256,
      abortAfterChunks: 6
    })
    t.is(aborted.aborted, true)
    await new Promise(resolve => setTimeout(resolve, 25))
    t.is(harness.submissions(), 0)
    t.alike(stagingEntries(harness.files.spoolRoot), [])
  }

  {
    const boundary = 'peartubeAdmission'
    const body = multipartBody({ boundary, request, idempotencyKey: 'multipart-admission', bytes, etag: request.expected.etag })
    const harness = await createMultipartHarness(t, { canArchive: () => false })
    const denied = await sendMultipart({ state: harness.state, body, boundary, nonce: 'multipart-admission-nonce' })
    t.is(denied.statusCode, 507)
    t.is(harness.submissions(), 0)
    t.alike(stagingEntries(harness.files.spoolRoot), [])
  }

  {
    const boundary = 'peartubeSizeMismatch'
    const changed = movieRequest(Buffer.concat([bytes, Buffer.from('drift')]))
    const body = multipartBody({
      boundary,
      request: changed,
      idempotencyKey: 'multipart-size-mismatch',
      bytes,
      etag: changed.expected.etag
    })
    const harness = await createMultipartHarness(t)
    const mismatch = await sendMultipart({ state: harness.state, body, boundary, nonce: 'multipart-size-nonce' })
    t.is(mismatch.statusCode, 400)
    t.is(harness.submissions(), 1)
    t.alike(stagingEntries(harness.files.spoolRoot), [])
    t.is(harness.bee?.map?.size || 0, 0)
  }
})
