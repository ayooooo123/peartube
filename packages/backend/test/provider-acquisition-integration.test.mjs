import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import b4a from 'b4a'
import test from 'brittle'
import Corestore from 'corestore'

import { CLOSED_ACQUISITION_POLICY } from '../src/acquisition/index.js'
import { createBufferSourceReader } from '../src/assets/source-reader.js'
import { createProviderSubsystem } from '../src/provider/subsystem.js'

const NOW = 1_787_788_800_000
const PUBLISHER_ID = 'a'.repeat(64)
const SOURCE = b4a.from('bounded provider acquisition smoke payload')

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

  let publishedAsset = null
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
        async resolve() { return createBufferSourceReader(SOURCE, { mimeType: 'video/mp4' }) },
      },
    },
    now: Date.now,
  })
  t.teardown(() => subsystem.close())

  const resolution = subsystem.issueLocalResolution({
    title: 'Smoke title',
    selector: { namespace: 'catalog', identifier: 'smoke-1', kind: 'movie' },
    publisherId: PUBLISHER_ID,
    expectedBytes: SOURCE.byteLength,
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

  const completed = await eventually(
    () => subsystem.service.getAcquisition({ acquisitionId: queued.acquisitionId, principal }),
    acquisition => ['completed', 'failed'].includes(acquisition.state),
  )
  t.is(completed.state, 'completed', completed.errorCode || 'completed')
  if (completed.state !== 'completed') return
  t.is(completed.bytesAcquired, SOURCE.byteLength)
  t.is(completed.assetId, publishedAsset.assetId)

  const core = store.get({ key: b4a.from(completed.assetId, 'hex') })
  await core.ready()
  t.ok(core.length > 0)
  await core.close()
})
