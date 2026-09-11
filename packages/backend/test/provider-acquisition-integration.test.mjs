import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import b4a from 'b4a'
import test from 'brittle'
import Corestore from 'corestore'
import Hypercore from 'hypercore'

import { createBlockOffloader } from '../src/archive/block-offloader.js'
import { createOffloadStorage } from '../src/archive/offload-storage.js'
import { createRemoteBlockStore } from '../src/archive/remote-block-store.js'
import { CLOSED_ACQUISITION_POLICY } from '../src/acquisition/index.js'
import { ASSET_BLOCK_SIZE, writeStaticAsset } from '../src/assets/static-core.js'
import { createBufferSourceReader, createSourceReader } from '../src/assets/source-reader.js'
import { normalizeAssetCoreRefV2 } from '../src/assets/rendition.js'
import { createProviderSubsystem } from '../src/provider/subsystem.js'

const NOW = 1_787_788_800_000
const PUBLISHER_ID = 'a'.repeat(64)
const SOURCE = b4a.from('bounded provider acquisition smoke payload')
const ARTWORK = b4a.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64')

function fakeBee() {
  const entries = new Map()
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
  const apply = operations => {
    for (const [operation, key, value] of operations) {
      if (operation === 'put') entries.set(key, clone(value))
      else entries.delete(key)
    }
  }
  return {
    async get(key) { return entries.has(key) ? { value: clone(entries.get(key)) } : null },
    async put(key, value) { apply([['put', key, value]]) },
    async del(key) { apply([['del', key]]) },
    batch() {
      const operations = []
      return {
        async put(key, value) { operations.push(['put', key, value]) },
        async del(key) { operations.push(['del', key]) },
        async flush() { apply(operations) },
      }
    },
    async * createReadStream({ gte, lt }) {
      for (const key of [...entries.keys()].sort()) {
        if (key >= gte && key < lt) yield { key, value: clone(entries.get(key)) }
      }
    },
  }
}

function queryView() {
  return {
    async query() { return { results: [], nextCursor: null } },
    async getEntity() { return null },
    async getPublication() { return null },
    async getManifest() { return null },
    async getRendition() { return null },
    async authorizeRendition() { return false },
    async isVisible() { return true },
  }
}

function policy() {
  return {
    ...CLOSED_ACQUISITION_POLICY,
    migrationRequired: false,
    enabled: true,
    allowedPublisherIds: [PUBLISHER_ID],
    allowedAdapterIds: ['memory-source'],
    maxQueuedJobs: 4,
    maxConcurrentJobs: 1,
    maxConcurrentPerRequester: 1,
    maxRequestBytes: 4096,
    maxAcquireBytesPer24h: 4096,
    maxAcquireBytesPerSecond: 16,
    maxStagingBytes: 4096,
    minFreeDiskBytes: 1,
    maxJobRuntimeMs: 60_000,
    sourceGrantTtlMs: 30_000,
    publicRequestsPerMinute: 1,
    maxAttempts: 2,
    retryBaseMs: 1,
    retryMaxMs: 10,
  }
}

async function eventually(read, predicate) {
  for (let attempt = 0; attempt < 2000; attempt++) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('acquisition did not reach a terminal state')
}

test('provider subsystem acquires, verifies, and publishes one private-grant source', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-provider-acquisition-'))
  const store = new Corestore(directory)
  await store.ready()
  t.teardown(async () => {
    await store.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  let releaseCopy
  let copying = false
  const copyGate = new Promise(resolve => { releaseCopy = resolve })
  const get = store.get.bind(store)
  store.get = options => {
    const core = get(options)
    if (options?.manifest) {
      const ready = core.ready.bind(core)
      let patched = false
      core.ready = async () => {
        await ready()
        if (patched) return
        patched = true
        const copyPrologue = core.core.copyPrologue.bind(core.core)
        core.core.copyPrologue = async sourceState => {
          copying = true
          await copyGate
          return copyPrologue(sourceState)
        }
      }
    }
    return core
  }

  let publishedAsset = null
  let publishedArtwork = null
  const subsystem = await createProviderSubsystem({
    ctx: { metaDb: fakeBee(), store },
    verifiedQueryView: queryView(),
    indexVerificationRuntime: {
      async searchIndexCandidates() { return [] },
      async verifyIndexCandidate() { throw new Error('not found') },
    },
    uploadManager: {
      async hasPublisherAuthority() { return true },
      async getAuthorizedPublisherIds() { return [PUBLISHER_ID] },
      async getAcquiredPublication() { return null },
      async publishAcquiredAsset({ asset, createArtworkSources }) {
        const [artwork] = await createArtworkSources()
        const description = await artwork.reader.describe()
        const chunks = []
        for await (const chunk of artwork.reader.open({ offset: 0, length: description.byteLength })) chunks.push(chunk)
        publishedArtwork = b4a.concat(chunks)
        await artwork.reader.close()
        publishedAsset = asset
        return {
          publicationId: 'publication-1',
          manifestId: 'manifest-1',
          renditionId: 'rendition-1',
          assetId: asset.assetId,
        }
      },
    },
    mediaApi: { async openMediaRenditionUrl() { return { success: false } } },
    config: {
      acquisitionPolicy: policy(),
      freeDiskBytes: () => 4096,
      sourceGrantResolver: {
        async resolve() {
          const media = createBufferSourceReader(SOURCE, { mimeType: 'video/mp4' })
          return createSourceReader({
            resumable: media.resumable,
            maxReadBytes: media.maxReadBytes,
            describe: media.describe,
            open: media.open,
            close: media.close,
            openArtwork: async () => [{
              role: 'poster',
              mimeType: 'image/png',
              reader: createBufferSourceReader(ARTWORK, { mimeType: 'image/png' }),
            }],
          })
        },
      },
    },
    now: Date.now,
  })
  t.teardown(() => subsystem.close())
  t.teardown(() => releaseCopy())

  const resolution = subsystem.issueLocalResolution({
    title: 'Smoke title',
    selector: { namespace: 'catalog', identifier: 'smoke-1', kind: 'movie' },
    publisherId: PUBLISHER_ID,
    expectedBytes: SOURCE.byteLength,
    artworkRoles: ['poster'],
  })
  const principal = { principalId: 'local-user', publisherId: PUBLISHER_ID, isLocal: true, publisherIds: [PUBLISHER_ID] }
  const queued = await subsystem.service.requestAcquisition({
    idempotencyKey: 'smoke-request-1',
    request: {
      schemaVersion: 1,
      resolutionRef: resolution.resolutionRef,
      publisherId: PUBLISHER_ID,
      retentionClass: 'archive-pin',
    },
    principal,
  })
  await subsystem.service.attachSourceGrant({
    acquisitionId: queued.acquisitionId,
    principal,
    grant: {
      token: 'memory-source-grant-0001',
      adapterId: 'memory-source',
      audience: { principalId: principal.principalId, acquisitionId: queued.acquisitionId },
      expiresAt: Date.now() + 10_000,
    },
  })
  const duringCopy = await eventually(
    () => subsystem.service.getAcquisition({ acquisitionId: queued.acquisitionId, principal }),
    acquisition => copying || ['completed', 'failed'].includes(acquisition.state),
  )
  t.is(duringCopy.state, 'verifying', 'source completion does not hide a pending disk copy')
  t.is(duringCopy.bytesAcquired, SOURCE.byteLength)
  t.is(duringCopy.publicationId, null, 'an unfinished copy is not a playable publication')
  releaseCopy()

  const completed = await eventually(
    () => subsystem.service.getAcquisition({ acquisitionId: queued.acquisitionId, principal }),
    acquisition => ['completed', 'failed'].includes(acquisition.state),
  )
  t.is(completed.state, 'completed', completed.errorCode || 'completed')
  if (completed.state !== 'completed') return
  t.is(completed.bytesAcquired, SOURCE.byteLength)
  t.is(completed.assetId, publishedAsset.assetId)
  t.alike(publishedArtwork, ARTWORK, 'the private grant supplies the exact publisher artwork bytes')

  const core = store.get({ key: b4a.from(completed.assetId, 'hex') })
  await core.ready()
  t.alike(await core.get(0), SOURCE, 'the completed asset holds the acquired bytes')
  await core.close()
})

// A retried acquisition whose prior attempt died before it could set a
// verified prefix still carries durable progress counters. The writer's
// attempt-local counter restarts at zero, so without a floor seeded from the
// durable job the first progress patch regresses the durable counter and the
// job dies as ACQUISITION_ACCOUNTING_REGRESSION - discarding every byte the
// prior attempt already landed. The retry must keep reporting monotonic
// counters instead.
test('a retried acquisition with durable progress does not regress its counters', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-provider-retry-'))
  const store = new Corestore(directory)
  await store.ready()
  t.teardown(async () => {
    await store.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  // Fail the FIRST acquire attempt mid-stream, then succeed on the retry.
  let attempts = 0
  const subsystem = await createProviderSubsystem({
    ctx: { metaDb: fakeBee(), store },
    verifiedQueryView: queryView(),
    indexVerificationRuntime: {
      async searchIndexCandidates() { return [] },
      async verifyIndexCandidate() { throw new Error('not found') },
    },
    uploadManager: {
      async hasPublisherAuthority() { return true },
      async getAuthorizedPublisherIds() { return [PUBLISHER_ID] },
      async getAcquiredPublication() { return null },
      async publishAcquiredAsset({ asset }) {
        return {
          publicationId: 'publication-1',
          manifestId: 'manifest-1',
          renditionId: 'rendition-1',
          assetId: asset.assetId,
        }
      },
    },
    mediaApi: { async openMediaRenditionUrl() { return { success: false } } },
    config: {
      acquisitionPolicy: { ...policy(), maxAttempts: 3, maxAcquireBytesPer24h: 65536, maxAcquireBytesPerSecond: 1024, sourceGrantTtlMs: 120_000 },
      freeDiskBytes: () => 4096,
      sourceGrantResolver: {
        async resolve() {
          attempts++
          const reader = createBufferSourceReader(SOURCE, { mimeType: 'video/mp4' })
          if (attempts === 1) {
            // Abort mid-stream on the first attempt only, after delivering
            // some bytes, exactly like a grant expiry cancelling a write.
            return {
              resumable: true,
              maxReadBytes: SOURCE.byteLength,
              describe: input => reader.describe(input),
              open(input) {
                return (async function * () {
                  // Deliver a strict PREFIX of the first chunk, then abort -
                  // a buffer reader may yield the whole payload as one chunk,
                  // so splitting on chunk boundaries never aborts mid-stream.
                  for await (const chunk of reader.open(input)) {
                    const prefixBytes = Math.max(1, chunk.byteLength >> 1)
                    yield chunk.subarray(0, prefixBytes)
                    const error = new Error('first attempt aborted')
                    error.code = 'ASSET_WRITE_CANCELLED'
                    error.recoverable = true
                    throw error
                  }
                })()
              },
              close: reason => reader.close(reason),
            }
          }
          return reader
        },
      },
    },
    now: Date.now,
  })
  t.teardown(() => subsystem.close())

  const resolution = subsystem.issueLocalResolution({
    title: 'Retry title',
    selector: { namespace: 'catalog', identifier: 'retry-1', kind: 'movie' },
    publisherId: PUBLISHER_ID,
    expectedBytes: SOURCE.byteLength,
  })
  const principal = { principalId: 'local-user', publisherId: PUBLISHER_ID, isLocal: true, publisherIds: [PUBLISHER_ID] }
  const queued = await subsystem.service.requestAcquisition({
    idempotencyKey: 'retry-request-1',
    request: {
      schemaVersion: 1,
      resolutionRef: resolution.resolutionRef,
      publisherId: PUBLISHER_ID,
      retentionClass: 'archive-pin',
    },
    principal,
  })
  await subsystem.service.attachSourceGrant({
    acquisitionId: queued.acquisitionId,
    principal,
    grant: {
      token: 'retry-source-grant-0001',
      adapterId: 'memory-source',
      audience: { principalId: principal.principalId, acquisitionId: queued.acquisitionId },
      expiresAt: Date.now() + 60_000,
    },
  })

  // The manager does not auto-retry: a recoverable failure waits for the
  // client to re-request, which is exactly MediaStorm's re-drive.
  const first = await eventually(
    () => subsystem.service.getAcquisition({ acquisitionId: queued.acquisitionId, principal }),
    acquisition => acquisition.state === 'failed',
  )
  t.ok(first.errorCode === 'ASSET_WRITE_CANCELLED', 'the first attempt aborted mid-write')

  const requeued = await subsystem.service.requestAcquisition({
    idempotencyKey: 'retry-request-1',
    request: {
      schemaVersion: 1,
      resolutionRef: resolution.resolutionRef,
      publisherId: PUBLISHER_ID,
      retentionClass: 'archive-pin',
    },
    principal,
  })
  await subsystem.service.attachSourceGrant({
    acquisitionId: requeued.acquisitionId,
    principal,
    grant: {
      token: 'retry-source-grant-0002',
      adapterId: 'memory-source',
      audience: { principalId: principal.principalId, acquisitionId: requeued.acquisitionId },
      expiresAt: Date.now() + 60_000,
    },
  })

  const settled = await eventually(
    () => subsystem.service.getAcquisition({ acquisitionId: requeued.acquisitionId, principal }),
    acquisition => ['completed', 'failed', 'cancelled'].includes(acquisition.state),
  )
  t.is(settled.state, 'completed', settled.errorCode || 'completed')
  t.is(settled.bytesAcquired, SOURCE.byteLength, 'the retry completed the full acquisition')
  t.ok(attempts >= 2, 'the first attempt actually aborted and a retry ran')
})

test('a failed acquisition with a resumable reader resumes from its staged byte offset on rewatch / retry', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-provider-resume-'))
  const objects = new Map()
  const blockStorageProvider = {
    async putBlock ({ key, data }) {
      objects.set(key, b4a.from(data))
      return { success: true }
    },
    async hasBlock ({ key }) {
      return objects.has(key)
    },
    async getBlock ({ key }) {
      const data = objects.get(key)
      if (!data) throw new Error(`missing block ${key}`)
      return b4a.from(data)
    },
    async deleteBlock ({ key }) {
      objects.delete(key)
      return { success: true }
    },
  }
  const raw = Hypercore.defaultStorage(directory)
  const storage = createOffloadStorage({
    storage: raw,
    resolveStore: ({ keyHex }) => (
      typeof keyHex === 'string' ? createRemoteBlockStore({ provider: blockStorageProvider, prefix: 'relay', coreKey: keyHex }) : null
    ),
    log: () => {},
  })
  const store = new Corestore(storage)
  await store.ready()
  t.teardown(async () => {
    await store.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })
  const blockOffload = {
    createOffloader ({ core }) {
      return createBlockOffloader({
        core,
        store: createRemoteBlockStore({
          coreKey: core.key,
          provider: blockStorageProvider,
          prefix: 'relay',
        }),
        windowBytes: 2 * ASSET_BLOCK_SIZE,
      })
    },
    createStagingStore ({ core, signal }) {
      return createRemoteBlockStore({
        coreKey: core.key,
        provider: blockStorageProvider,
        prefix: 'relay',
        signal,
      })
    },
  }

  const TOTAL_BLOCKS = 3
  const payloadBytes = b4a.alloc(TOTAL_BLOCKS * ASSET_BLOCK_SIZE)
  for (let i = 0; i < TOTAL_BLOCKS; i++) {
    payloadBytes.fill(i + 1, i * ASSET_BLOCK_SIZE, (i + 1) * ASSET_BLOCK_SIZE)
  }

  const rangesRequested = []
  let attemptCount = 0
  const subsystem = await createProviderSubsystem({
    ctx: { metaDb: fakeBee(), store, blockOffload },
    verifiedQueryView: queryView(),
    indexVerificationRuntime: {
      async searchIndexCandidates () { return [] },
      async verifyIndexCandidate () { throw new Error('not found') },
    },
    uploadManager: {
      async hasPublisherAuthority () { return true },
      async getAuthorizedPublisherIds () { return [PUBLISHER_ID] },
      async getAcquiredPublication () { return null },
      async publishAcquiredAsset ({ asset }) {
        return {
          publicationId: 'publication-resumed-1',
          manifestId: 'manifest-resumed-1',
          renditionId: 'rendition-resumed-1',
          assetId: asset.assetId,
        }
      },
    },
    mediaApi: { async openMediaRenditionUrl () { return { success: false } } },
    config: {
      acquisitionPolicy: { ...policy(), maxAttempts: 3, maxAcquireBytesPer24h: 10 * 1024 * 1024, maxAcquireBytesPerSecond: 1024 * 1024, sourceGrantTtlMs: 120_000 },
      freeDiskBytes: () => 1024 * 1024 * 1024,
      sourceGrantResolver: {
        async resolve () {
          attemptCount++
          const currentAttempt = attemptCount
          return createSourceReader({
            resumable: true,
            maxReadBytes: payloadBytes.byteLength,
            async describe () {
              return {
                identity: { kind: 'etag', value: 'video-source-etag-v1' },
                byteLength: payloadBytes.byteLength,
                mimeType: 'video/mp4',
              }
            },
            open ({ offset, length }) {
              rangesRequested.push({ attempt: currentAttempt, offset, length })
              return (async function * () {
                if (currentAttempt === 1) {
                  // Deliver the first canonical block, then simulate a connection interruption
                  yield payloadBytes.subarray(offset, offset + ASSET_BLOCK_SIZE)
                  const err = new Error('stream connection interrupted')
                  err.code = 'ASSET_WRITE_CANCELLED'
                  err.recoverable = true
                  throw err
                }
                // On subsequent attempts, stream the requested range
                for (let pos = offset; pos < offset + length; pos += 65536) {
                  yield payloadBytes.subarray(pos, Math.min(pos + 65536, offset + length))
                }
              })()
            },
            async close () {},
          })
        },
      },
    },
    now: Date.now,
  })
  t.teardown(() => subsystem.close())

  const resolution = subsystem.issueLocalResolution({
    title: 'Stream title',
    selector: { namespace: 'catalog', identifier: 'stream-1', kind: 'movie' },
    publisherId: PUBLISHER_ID,
    expectedBytes: payloadBytes.byteLength,
  })
  const principal = { principalId: 'local-user', publisherId: PUBLISHER_ID, isLocal: true, publisherIds: [PUBLISHER_ID] }

  // First watch / acquisition request
  const queued = await subsystem.service.requestAcquisition({
    idempotencyKey: 'stream-archive-key-1',
    request: {
      schemaVersion: 1,
      resolutionRef: resolution.resolutionRef,
      publisherId: PUBLISHER_ID,
      retentionClass: 'archive-pin',
    },
    principal,
  })
  await subsystem.service.attachSourceGrant({
    acquisitionId: queued.acquisitionId,
    principal,
    grant: {
      token: 'stream-grant-attempt-1',
      adapterId: 'memory-source',
      audience: { principalId: principal.principalId, acquisitionId: queued.acquisitionId },
      expiresAt: Date.now() + 60_000,
    },
  })

  const failedAttempt = await eventually(
    () => subsystem.service.getAcquisition({ acquisitionId: queued.acquisitionId, principal }),
    job => job.state === 'failed',
  )
  t.is(failedAttempt.errorCode, 'ASSET_WRITE_CANCELLED', 'first attempt failed mid-stream')
  t.is(rangesRequested[0].offset, 0, 'first attempt started at offset 0')

  // Rewatch / re-request stream acquisition with the same idempotency key
  const requeued = await subsystem.service.requestAcquisition({
    idempotencyKey: 'stream-archive-key-1',
    request: {
      schemaVersion: 1,
      resolutionRef: resolution.resolutionRef,
      publisherId: PUBLISHER_ID,
      retentionClass: 'archive-pin',
    },
    principal,
  })
  await subsystem.service.attachSourceGrant({
    acquisitionId: requeued.acquisitionId,
    principal,
    grant: {
      token: 'stream-grant-attempt-2',
      adapterId: 'memory-source',
      audience: { principalId: principal.principalId, acquisitionId: requeued.acquisitionId },
      expiresAt: Date.now() + 60_000,
    },
  })

  const completedJob = await eventually(
    () => subsystem.service.getAcquisition({ acquisitionId: requeued.acquisitionId, principal }),
    job => ['completed', 'failed', 'cancelled'].includes(job.state),
  )
  t.is(completedJob.state, 'completed', completedJob.errorCode || 'completed')
  t.is(completedJob.bytesAcquired, payloadBytes.byteLength, 'archive job finished completely')
  t.is(rangesRequested.length, 2, 'source was opened twice across the two attempts')
  t.is(rangesRequested[1].offset, ASSET_BLOCK_SIZE, 'second attempt resumed from the staged block boundary')
})

test('subsystem shutdown aborts a stalled transferred import before it can publish or outlive close', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-provider-transfer-shutdown-'))
  const coreStore = new Corestore(directory)
  await coreStore.ready()
  t.teardown(async () => {
    await coreStore.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  const written = await writeStaticAsset({ store: coreStore, reader: createBufferSourceReader(SOURCE) })
  const core = normalizeAssetCoreRefV2(written.descriptor)
  await written.core.close()
  const transfer = { calls: 0, signal: null, sawAbort: false, settled: false }
  let publishes = 0
  const subsystem = await createProviderSubsystem({
    ctx: { metaDb: fakeBee(), store: coreStore },
    verifiedQueryView: queryView(),
    indexVerificationRuntime: {
      async searchIndexCandidates() { return [] },
      async verifyIndexCandidate() { throw new Error('not found') },
    },
    uploadManager: {
      async hasPublisherAuthority() { return true },
      async getAuthorizedPublisherIds() { return [PUBLISHER_ID] },
      async getAcquiredPublication() { return null },
      async publishAcquiredAsset() {
        publishes++
        throw new Error('a shutdown-aborted transfer must never reach publication')
      },
    },
    mediaApi: { async openMediaRenditionUrl() { return { success: false } } },
    config: {
      acquisitionPolicy: policy(),
      freeDiskBytes: () => 4096,
      acquisitionProvider: {
        async importAsset({ signal }) {
          transfer.calls++
          transfer.signal = signal
          return await new Promise((resolve, reject) => {
            const abort = () => {
              transfer.sawAbort = true
              reject(Object.assign(new Error('transfer aborted during shutdown'), { code: 'TRANSFER_ABORTED' }))
            }
            if (signal?.aborted) abort()
            else if (signal?.addEventListener) signal.addEventListener('abort', abort, { once: true })
            else setTimeout(() => {
              transfer.settled = true
              resolve({ imported: true, byteLength: core.byteLength, descriptor: {
                assetId: core.assetId, key: core.key, treeHash: core.treeHash,
                length: core.length, byteLength: core.byteLength, blockSize: core.blockSize
              } })
            }, 40)
          })
        },
      },
      sourceGrantResolver: { async resolve() { return createBufferSourceReader(SOURCE) } },
    },
    now: Date.now,
  })
  t.teardown(() => subsystem.close())

  const resolution = subsystem.issueLocalResolution({
    title: 'Transfer shutdown title',
    selector: { namespace: 'catalog', identifier: 'transfer-shutdown-1', kind: 'movie' },
    publisherId: PUBLISHER_ID,
    expectedBytes: SOURCE.byteLength,
  })
  const principal = { principalId: 'local-user', publisherId: PUBLISHER_ID, isLocal: true, publisherIds: [PUBLISHER_ID] }
  const queued = await subsystem.service.requestAcquisition({
    idempotencyKey: 'transfer-shutdown-1',
    request: {
      schemaVersion: 1,
      resolutionRef: resolution.resolutionRef,
      publisherId: PUBLISHER_ID,
      retentionClass: 'archive-pin',
    },
    principal,
  })
  const assignmentId = '33'.repeat(32)
  await subsystem.store.saveCoordination(queued.acquisitionId, {
    schemaVersion: 1,
    role: 'requester',
    phase: 'assigned',
    requestId: '11'.repeat(32),
    offerId: '22'.repeat(32),
    assignmentId,
    peerId: '44'.repeat(32),
    requesterId: '55'.repeat(32),
    acquirerId: '66'.repeat(32),
    sourceRef: resolution.resolutionRef,
    publisherId: PUBLISHER_ID,
    publicationIntentDigest: '88'.repeat(32),
    budget: { maxSourceBytes: 4096, maxOutputBytes: 4096, maxNetworkBytes: 8192, maxWallClockMs: 60_000 },
    output: { purpose: 'original', formats: ['application/octet-stream'] },
    resultHoldUntil: Date.now() + 180_000,
    requestGeneration: 1,
    epoch: 1,
    deadline: Date.now() + 60_000,
    progress: null,
    result: null,
    error: null,
  })

  const notification = subsystem.coordinator.networkManager.onResult({
    result: {
      assignmentId,
      acquiredBytes: core.byteLength,
      completedAt: Date.now(),
      availabilityUntil: Date.now() + 120_000,
      sourceIdentity: { kind: 'sha256', value: 'e'.repeat(64) },
      assets: [{ purpose: 'original', format: 'application/octet-stream', renditionId: 'd'.repeat(64), core }],
    },
    peerId: '44'.repeat(32),
  }).then(() => 'resolved', error => 'rejected:' + (error?.code || error?.message))

  await eventually(() => transfer.calls, calls => calls === 1)
  await subsystem.close()

  t.ok(transfer.signal, 'the transferred import receives a coordinator-lifetime signal')
  t.is(transfer.sawAbort, true, 'shutdown aborts the stalled transfer through the real provider chain')
  t.is(transfer.settled, false, 'the un-abortable fallback path never ran; close did not wait it out silently')
  t.is(await notification, 'rejected:TRANSFER_ABORTED')
  t.is(publishes, 0, 'an aborted transfer never publishes')
  const afterClose = await subsystem.service.getAcquisition({ acquisitionId: queued.acquisitionId, principal })
  t.is(afterClose.state, 'queued', 'the interrupted transfer leaves a durable, re-drivable acquisition')
  const coord = await subsystem.store.getCoordination(queued.acquisitionId)
  t.is(coord.phase, 'result-ready', 'the result stays re-driveable after shutdown')
  t.is(coord.error?.code, 'TRANSFER_ABORTED')
})

test('subsystem shutdown leaves a transferred import stalled in verification resumable, not terminalized', async t => {
  t.timeout(5000)
  const directory = mkdtempSync(join(tmpdir(), 'peartube-provider-verify-shutdown-'))
  const coreStore = new Corestore(directory)
  await coreStore.ready()
  t.teardown(async () => {
    await coreStore.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  const written = await writeStaticAsset({ store: coreStore, reader: createBufferSourceReader(SOURCE) })
  const core = normalizeAssetCoreRefV2(written.descriptor)
  await written.core.close()
  const verification = { calls: 0, sawAbort: false }
  let markVerificationStarted
  const verificationStarted = new Promise(resolve => { markVerificationStarted = resolve })
  let publishes = 0
  const subsystem = await createProviderSubsystem({
    ctx: { metaDb: fakeBee(), store: coreStore },
    verifiedQueryView: queryView(),
    indexVerificationRuntime: {
      async searchIndexCandidates() { return [] },
      async verifyIndexCandidate() { throw new Error('not found') },
    },
    uploadManager: {
      async hasPublisherAuthority() { return true },
      async getAuthorizedPublisherIds() { return [PUBLISHER_ID] },
      async getAcquiredPublication() { return null },
      async publishAcquiredAsset() {
        publishes++
        throw new Error('a shutdown-interrupted verification must never reach publication')
      },
    },
    mediaApi: { async openMediaRenditionUrl() { return { success: false } } },
    config: {
      // This fixture imports the complete payload in one burst; the ordinary
      // source-reader fixture is deliberately throttled to 16 bytes/second.
      acquisitionPolicy: { ...policy(), maxAcquireBytesPerSecond: SOURCE.byteLength },
      freeDiskBytes: () => 4096,
      acquisitionProvider: {
        async importAsset() {
          return { imported: true, byteLength: core.byteLength, descriptor: {
            assetId: core.assetId, key: core.key, treeHash: core.treeHash,
            length: core.length, byteLength: core.byteLength, blockSize: core.blockSize
          } }
        },
        async verify({ signal }) {
          verification.calls++
          markVerificationStarted()
          return await new Promise((resolve, reject) => {
            const abort = () => {
              verification.sawAbort = true
              reject(Object.assign(new Error('verification interrupted by coordinator shutdown'), { code: 'ASSET_VERIFY_INTERRUPTED' }))
            }
            if (signal?.aborted) abort()
            else signal.addEventListener('abort', abort, { once: true })
          })
        },
      },
      sourceGrantResolver: { async resolve() { return createBufferSourceReader(SOURCE) } },
    },
    now: Date.now,
  })
  t.teardown(() => subsystem.close())

  const resolution = subsystem.issueLocalResolution({
    title: 'Verify shutdown title',
    selector: { namespace: 'catalog', identifier: 'verify-shutdown-1', kind: 'movie' },
    publisherId: PUBLISHER_ID,
    expectedBytes: SOURCE.byteLength,
  })
  const principal = { principalId: 'local-user', publisherId: PUBLISHER_ID, isLocal: true, publisherIds: [PUBLISHER_ID] }
  const queued = await subsystem.service.requestAcquisition({
    idempotencyKey: 'verify-shutdown-1',
    request: {
      schemaVersion: 1,
      resolutionRef: resolution.resolutionRef,
      publisherId: PUBLISHER_ID,
      retentionClass: 'archive-pin',
    },
    principal,
  })
  const assignmentId = '33'.repeat(32)
  await subsystem.store.saveCoordination(queued.acquisitionId, {
    schemaVersion: 1,
    role: 'requester',
    phase: 'assigned',
    requestId: '11'.repeat(32),
    offerId: '22'.repeat(32),
    assignmentId,
    peerId: '44'.repeat(32),
    requesterId: '55'.repeat(32),
    acquirerId: '66'.repeat(32),
    sourceRef: resolution.resolutionRef,
    publisherId: PUBLISHER_ID,
    publicationIntentDigest: '88'.repeat(32),
    budget: { maxSourceBytes: 4096, maxOutputBytes: 4096, maxNetworkBytes: 8192, maxWallClockMs: 60_000 },
    output: { purpose: 'original', formats: ['application/octet-stream'] },
    resultHoldUntil: Date.now() + 180_000,
    requestGeneration: 1,
    epoch: 1,
    deadline: Date.now() + 60_000,
    progress: null,
    result: null,
    error: null,
  })

  const notification = subsystem.coordinator.networkManager.onResult({
    result: {
      assignmentId,
      acquiredBytes: core.byteLength,
      completedAt: Date.now(),
      availabilityUntil: Date.now() + 120_000,
      sourceIdentity: { kind: 'sha256', value: 'e'.repeat(64) },
      assets: [{ purpose: 'original', format: 'application/octet-stream', renditionId: 'd'.repeat(64), core }],
    },
    peerId: '44'.repeat(32),
  }).then(() => 'resolved', error => 'rejected:' + (error?.code || error?.message))

  await Promise.race([
    verificationStarted,
    notification.then(async outcome => {
      const job = await subsystem.store.get(queued.acquisitionId)
      throw new Error(`transferred import settled before verification: ${outcome}; ${job?.state}; ${job?.errorCode}`)
    }),
  ])
  const admitted = await subsystem.service.getAcquisition({ acquisitionId: queued.acquisitionId, principal })
  t.is(admitted.state, 'verifying', 'the transfer passed durable admission and persisted its byte counters before verification stalled')
  t.is(admitted.bytesAcquired, SOURCE.byteLength)
  await subsystem.close()

  t.is(verification.sawAbort, true, 'coordinator shutdown aborts the stalled verification through the real provider chain')
  t.is(publishes, 0, 'an aborted verification never publishes')
  t.is(await notification, 'rejected:ASSET_VERIFY_INTERRUPTED')
  const afterClose = await subsystem.service.getAcquisition({ acquisitionId: queued.acquisitionId, principal })
  t.is(afterClose.state, 'verifying', 'the transport-lifetime abort leaves the durable job non-terminal and resumable, not failed')
  t.absent(afterClose.errorCode)
  const coord = await subsystem.store.getCoordination(queued.acquisitionId)
  t.is(coord.phase, 'result-ready', 'the result stays re-driveable after shutdown')
  t.is(coord.error?.code, 'ASSET_VERIFY_INTERRUPTED')
})
