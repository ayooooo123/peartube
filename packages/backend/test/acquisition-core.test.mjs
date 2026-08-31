import test from 'brittle'

import {
  CLOSED_ACQUISITION_POLICY,
  createAcquisitionAdmissionLedger,
  createAcquisitionPolicyRuntime,
  createAcquisitionStore,
  createSourceGrantVault,
  migrateLegacyIngest,
  normalizeAcquisitionJob,
  normalizeAcquisitionRequest
} from '../src/acquisition/index.js'
import { createBufferSourceReader, createSourceReader } from '../src/assets/source-reader.js'

const NOW = 1_787_788_800_000
const REF = 'A'.repeat(43)
const PRINCIPAL = { principalId: 'local-user', isLocal: true, publisherIds: ['publisher-1'] }
function request (overrides = {}) { return { schemaVersion: 1, resolutionRef: REF, publisherId: 'publisher-1', retentionClass: 'archive-pin', ...overrides } }
function openPolicy (overrides = {}) {
  return { ...CLOSED_ACQUISITION_POLICY, migrationRequired: false, enabled: true, allowedPublisherIds: ['publisher-1'], allowedAdapterIds: ['local-adapter'], maxQueuedJobs: 4, maxConcurrentJobs: 2, maxConcurrentPerRequester: 1, maxRequestBytes: 4096, maxAcquireBytesPer24h: 1024 * 1024, maxAcquireBytesPerSecond: 1024 * 1024, maxStagingBytes: 1024 * 1024, minFreeDiskBytes: 1, maxJobRuntimeMs: 60_000, sourceGrantTtlMs: 30_000, publicRequestsPerMinute: 2, maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 10, ...overrides }
}
function fakeBee () {
  const map = new Map(); const clone = value => JSON.parse(JSON.stringify(value))
  return { map, async get (key) { return map.has(key) ? { value: clone(map.get(key)) } : null }, batch () { const operations = []; return { async put (key, value) { operations.push(['put', key, clone(value)]) }, async del (key) { operations.push(['del', key]) }, async flush () { for (const [operation, key, value] of operations) { if (operation === 'put') map.set(key, value); else map.delete(key) } } } }, async * createReadStream ({ gte, lt }) { for (const key of [...map.keys()].sort()) if (key >= gte && key < lt) yield { key, value: clone(map.get(key)) } } }
}
function durableJob (overrides = {}) {
  return { schemaVersion: 1, acquisitionId: 'acq_test', state: 'queued', version: 0, principalId: 'local-user', publisherId: 'publisher-1', requesterPublisherIds: ['publisher-1'], isRemote: false, idempotencyDigest: 'd'.repeat(64), requestFingerprint: 'f'.repeat(64), request: request(), retentionClass: 'archive-pin', expectedBytes: 8, expectedIdentity: { kind: 'etag', value: 'asset-v1' }, sourceBytesRead: 0, sourceBytesAccepted: 0, bytesAcquired: 0, verifiedBytes: 0, committedBytes: 0, retainedBytes: 0, stagingBytes: 0, stagingPeakBytes: 0, attempts: 0, startedAt: null, finishedAt: null, verifiedPrefix: null, verifiedAsset: null, publication: null, errorCode: null, recoverable: false, createdAt: NOW, updatedAt: NOW, ...overrides }
}

test('acquisition request and job contracts are exact and reject source secrets', t => {
  t.alike(normalizeAcquisitionRequest(request()), request())
  t.exception(() => normalizeAcquisitionRequest({ ...request(), sourceUrl: 'https://private.invalid/title' }), /ACQUISITION_SECRET_REJECTED/)
  t.exception(() => normalizeAcquisitionRequest(request({ resolutionRef: 'https://private.invalid' })), /ACQUISITION_SECRET_REJECTED/)
  t.exception(() => normalizeAcquisitionRequest({ ...request(), expected: { byteLength: 8, sha256: '0'.repeat(64) } }), /unknown field expected/)
  const job = normalizeAcquisitionJob({ schemaVersion: 1, acquisitionId: 'acq_test', state: 'queued', retentionClass: 'archive-pin', bytesAcquired: 0, expectedBytes: 8, publicationId: null, manifestId: null, renditionId: null, assetId: null, errorCode: null, recoverable: false, createdAt: NOW, updatedAt: NOW })
  t.alike(Object.keys(job), ['schemaVersion', 'acquisitionId', 'state', 'retentionClass', 'title', 'sourceFileName', 'mediaContext', 'bytesAcquired', 'expectedBytes', 'publicationId', 'manifestId', 'renditionId', 'assetId', 'errorCode', 'recoverable', 'createdAt', 'updatedAt'])
  t.is(job.title, null, 'a job with no publisher metadata names no work')
  t.is(job.mediaContext, null)
  const release = normalizeAcquisitionJob({ ...job, title: 'FUBAR', sourceFileName: 'Fubar.S02E07.2160p.mkv' })
  t.is(release.sourceFileName, 'Fubar.S02E07.2160p.mkv', 'the name the source gave the file survives projection')
  const punctuatedFile = normalizeAcquisitionRequest(request({ sourceFileName: 'Constantine: City of Demons.2018.1080p.mkv' }))
  t.is(punctuatedFile.sourceFileName, 'Constantine: City of Demons.2018.1080p.mkv', 'filename punctuation is a label, not a source locator')
  const punctuated = normalizeAcquisitionJob({ ...job, title: 'Spider-Man: Into the Spider-Verse' })
  t.is(punctuated.title, 'Spider-Man: Into the Spider-Verse', 'ordinary title punctuation is not treated as a source locator')
  t.exception(() => normalizeAcquisitionJob({ ...job, title: 'https://private.invalid/title' }), /title is invalid/)
  t.exception(() => normalizeAcquisitionJob({ ...job, sourceFileName: '/private/spool/Fubar.mkv' }), /sourceFileName is invalid/)
  const named = normalizeAcquisitionJob({ ...job, title: 'Eagle Eye', mediaContext: { kind: 'movie', identifier: '13027', workEntityId: 'show:246:s3:e11', releaseYear: 2008 } })
  t.alike(named.mediaContext, { kind: 'movie', identifier: '13027', workEntityId: 'show:246:s3:e11', releaseYear: 2008 }, 'whitelisted coordinates survive projection')
  t.exception(() => normalizeAcquisitionJob({ ...job, mediaContext: { sourceUrl: 'https://private.invalid/title' } }), /prohibited field|not permitted/)
  t.exception(() => normalizeAcquisitionJob({ ...job, mediaContext: { kind: -1 } }), /mediaContext.kind is invalid/)
  t.exception(() => normalizeAcquisitionJob({ ...job, sourceToken: 'secret-secret-secret' }), /prohibited field|unknown field/)
})

test('policy is closed by default and requires consent, allowlists, and limits', async t => {
  const runtime = createAcquisitionPolicyRuntime({ now: () => NOW })
  await t.exception(runtime.admit({ request: request(), principal: PRINCIPAL, adapterId: 'local-adapter', freeDiskBytes: 10 }), /MIGRATION_REQUIRED/)
  await t.exception(runtime.setPolicy(openPolicy()), /CONSENT_REQUIRED/)
  await runtime.setPolicy(openPolicy(), { consent: { version: 1, granted: true } })
  t.is((await runtime.admit({ request: request({ retentionUntil: NOW + 1000 }), principal: PRINCIPAL, adapterId: 'local-adapter', freeDiskBytes: 10 })).principalId, 'local-user')
  await t.exception(runtime.admit({ request: request({ publisherId: 'other' }), principal: PRINCIPAL, adapterId: 'local-adapter', freeDiskBytes: 10 }), /PUBLISHER_DENIED/)
  await t.exception(runtime.admit({ request: request(), principal: PRINCIPAL, adapterId: 'other', freeDiskBytes: 10 }), /ADAPTER_DENIED/)
  await t.exception(runtime.admit({ request: request({ retentionUntil: NOW + 120_000 }), principal: PRINCIPAL, adapterId: 'local-adapter', freeDiskBytes: 10 }), /RUNTIME_DENIED/)
})

test('accounting releases reservations but retains acquired-window charges', t => {
  const ledger = createAcquisitionAdmissionLedger({ now: () => NOW }); const policy = openPolicy({ maxQueuedJobs: 1, maxConcurrentJobs: 1, maxAcquireBytesPer24h: 16 })
  ledger.reserve({ acquisitionId: 'acq_one', principalId: 'local-user', expectedBytes: 8, policy })
  t.exception(() => ledger.reserve({ acquisitionId: 'acq_two', principalId: 'local-user', expectedBytes: 8, policy }), /QUEUE_FULL/)
  ledger.start({ acquisitionId: 'acq_one', policy }); ledger.record('acq_one', { sourceBytesRead: 8, sourceBytesAccepted: 8, verifiedBytes: 8, committedBytes: 8 }, { policy }); ledger.release('acq_one')
  t.alike(ledger.snapshot(), { queued: 0, active: 0, reservedBytes: 0, stagingBytes: 0, acquiredBytes24h: 8, tracked: 0 })
})

test('accounting restores rolling byte and public-request windows after restart', t => {
  const ledger = createAcquisitionAdmissionLedger({ now: () => NOW })
  const policy = openPolicy({ maxAcquireBytesPer24h: 16, publicRequestsPerMinute: 2 })
  ledger.restoreUsage({ at: NOW - 1000, bytes: 12 })
  t.exception(() => ledger.reserve({ acquisitionId: 'acq_budget', principalId: 'local-user', expectedBytes: 8, policy }), /DAILY_BUDGET/)
  t.is(ledger.snapshot().acquiredBytes24h, 12)

  const requests = createAcquisitionAdmissionLedger({ now: () => NOW })
  requests.restoreUsage({ at: NOW - 1000, publicRequestAt: NOW - 1000 })
  requests.restoreUsage({ at: NOW - 500, publicRequestAt: NOW - 500 })
  t.exception(() => requests.reserve({ acquisitionId: 'acq_remote', principalId: 'remote-user', expectedBytes: 1, policy: openPolicy(), isRemote: true }), /REQUEST_RATE/)
})

test('SourceGrantVault binds audience and TTL, resolves SourceReader, and revokes', async t => {
  let revoked = 0
  const vault = createSourceGrantVault({ now: () => NOW, resolver: { async resolve () { return createBufferSourceReader(new Uint8Array([1, 2, 3])) }, async revoke () { revoked++ } } })
  const grant = { token: 'private-token-00000001', adapterId: 'local-adapter', audience: { principalId: 'local-user', acquisitionId: 'acq_one' }, expiresAt: NOW + 1000 }
  await t.exception(vault.attach({ acquisitionId: 'acq_other', grant, principal: 'local-user', maxTtlMs: 2000 }), /AUDIENCE_MISMATCH/)
  await t.exception(vault.attach({ acquisitionId: 'acq_one', grant: { ...grant, expiresAt: NOW + 3000 }, principal: 'local-user', maxTtlMs: 2000 }), /TTL_EXCEEDED/)
  t.alike(await vault.attach({ acquisitionId: 'acq_one', grant, principal: 'local-user', maxTtlMs: 2000 }), { adapterId: 'local-adapter', expiresAt: NOW + 1000 })
  t.is((await (await vault.resolve({ acquisitionId: 'acq_one', principal: 'local-user' })).describe()).byteLength, 3)
  t.ok(await vault.revoke({ acquisitionId: 'acq_one', principal: 'local-user' })); t.is(revoked, 1)
  await t.exception(vault.resolve({ acquisitionId: 'acq_one', principal: 'local-user' }), /UNAVAILABLE/)
})

test('source grant revocation aborts an in-flight reader', async t => {
  const vault = createSourceGrantVault({
    resolver: {
      async resolve() {
        return createSourceReader({
          resumable: true,
          maxReadBytes: 1,
          async describe() { return { identity: { kind: 'etag', value: 'slow-source' }, byteLength: 1, mimeType: 'application/octet-stream' } },
          open() {
            return (async function * () {
              await new Promise(resolve => setTimeout(resolve, 100))
              yield new Uint8Array([1])
            })()
          },
          async close() {}
        })
      }
    }
  })
  const acquisitionId = 'acq_expiring'
  const grant = {
    token: 'private-token-expiring-0001',
    adapterId: 'local-adapter',
    audience: { principalId: 'local-user', acquisitionId },
    expiresAt: Date.now() + 1000
  }
  await vault.attach({ acquisitionId, grant, principal: 'local-user', maxTtlMs: 1000 })
  const reader = await vault.resolve({ acquisitionId, principal: 'local-user' })
  const reading = (async () => {
    for await (const chunk of reader.open({ offset: 0, length: 1 })) void chunk
  })()
  await new Promise(resolve => setTimeout(resolve, 20))
  t.is(await vault.revoke({ acquisitionId, principal: 'local-user' }), true)
  await t.exception(reading, /cancel|abort|expired/i)
  await vault.close()
})

test('source grant expiry revokes the adapter without another vault call', async t => {
  let revoked = 0
  const vault = createSourceGrantVault({
    resolver: {
      async resolve() { return createBufferSourceReader(new Uint8Array([1])) },
      async revoke() { revoked++ }
    }
  })
  const acquisitionId = 'acq_expiry_timer'
  await vault.attach({
    acquisitionId,
    principal: 'local-user',
    maxTtlMs: 1000,
    grant: {
      token: 'private-token-expiry-timer-0001',
      adapterId: 'local-adapter',
      audience: { principalId: 'local-user', acquisitionId },
      expiresAt: Date.now() + 20
    }
  })
  await new Promise(resolve => setTimeout(resolve, 60))
  t.is(vault.has({ acquisitionId, principal: 'local-user' }), false)
  t.is(revoked, 1)
  await vault.close()
})

test('source grant expiry aborts adapter resolution before a reader is returned', async t => {
  const vault = createSourceGrantVault({
    resolver: {
      resolve({ signal }) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(createBufferSourceReader(new Uint8Array([1]))), 100)
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(signal.reason)
          }, { once: true })
        })
      }
    }
  })
  const acquisitionId = 'acq_resolver_expiry'
  await vault.attach({
    acquisitionId,
    principal: 'local-user',
    maxTtlMs: 1000,
    grant: {
      token: 'private-token-resolver-expiry-0001',
      adapterId: 'local-adapter',
      audience: { principalId: 'local-user', acquisitionId },
      expiresAt: Date.now() + 20
    }
  })
  await t.exception(vault.resolve({ acquisitionId, principal: 'local-user' }), /expired/i)
  await vault.close()
})

test('atomic store enforces idempotency and every public transition', async t => {
  const store = createAcquisitionStore({ bee: fakeBee(), now: () => NOW }); const initial = durableJob()
  t.ok((await store.createOrReplay({ idempotencyDigest: initial.idempotencyDigest, requestFingerprint: initial.requestFingerprint, job: initial })).created)
  t.is((await store.countByState()).queued, 1)
  await t.exception(store.createOrReplay({ idempotencyDigest: initial.idempotencyDigest, requestFingerprint: 'x'.repeat(64), job: initial }), /IDEMPOTENCY_CONFLICT/)
  let job = (await store.transition(initial.acquisitionId, { expectedVersion: 0, from: 'queued', to: 'acquiring', patch: { attempts: 1 } })).job
  job = (await store.updateProgress(job.acquisitionId, { expectedVersion: job.version, state: 'acquiring', patch: { sourceBytesRead: 8, sourceBytesAccepted: 8, bytesAcquired: 8, verifiedPrefix: { byteLength: 8, identity: initial.expectedIdentity } } })).job
  job = (await store.transition(job.acquisitionId, { expectedVersion: job.version, from: 'acquiring', to: 'verifying' })).job
  job = (await store.transition(job.acquisitionId, { expectedVersion: job.version, from: 'verifying', to: 'publishing', patch: { verifiedBytes: 8, verifiedAsset: { assetId: 'asset-1', key: 'a'.repeat(64), treeHash: 'b'.repeat(64), length: 1, byteLength: 8, blockSize: 8 } } })).job
  job = (await store.complete(job.acquisitionId, { expectedVersion: job.version, publication: { publicationId: 'publication-1', manifestId: 'manifest-1', renditionId: 'rendition-1', assetId: 'asset-1' } })).job
  t.is(job.state, 'completed'); t.alike((await store.listEvents(job.acquisitionId)).map(event => event.state), ['queued', 'acquiring', 'acquiring', 'verifying', 'publishing', 'completed'])
  t.is((await store.countByState()).completed, 1)
  await t.exception(store.transition(job.acquisitionId, { expectedVersion: job.version, from: 'completed', to: 'cancelled' }), /TERMINAL/)
})

test('legacy migration copies only public state and is atomic and idempotent', async t => {
  const store = createAcquisitionStore({ bee: fakeBee(), now: () => NOW })
  const legacy = { async listJobs () { return [{ jobId: 'ing_legacy', state: 'acquiring', retentionClass: 'archive-pin', bytesReceived: 4, expectedBytes: 8, createdAt: NOW - 100, updatedAt: NOW, sourceCapability: 'must-not-migrate', spool: { path: '/private' } }] } }
  t.alike(await migrateLegacyIngest({ legacyStore: legacy, acquisitionStore: store, legacyPrincipalId: 'local-user', legacyPublisherId: 'publisher-1', now: () => NOW }), { migrated: 1, skipped: 0 })
  const migrated = await store.get('ing_legacy'); t.is(migrated.state, 'failed'); t.is(migrated.errorCode, 'LEGACY_SOURCE_GRANT_REQUIRED'); t.absent(JSON.stringify(migrated).includes('must-not-migrate'))
  t.alike(await migrateLegacyIngest({ legacyStore: legacy, acquisitionStore: store, legacyPrincipalId: 'local-user', legacyPublisherId: 'publisher-1', now: () => NOW }), { migrated: 0, skipped: 1 })
})

test('legacy migration carries the work identity and backfills a relay that already migrated', async t => {
  const store = createAcquisitionStore({ bee: fakeBee(), now: () => NOW })
  const bare = { jobId: 'ing_episode', state: 'completed', retentionClass: 'contribution-cache', bytesReceived: 8, expectedBytes: 8, createdAt: NOW - 10, updatedAt: NOW, publicationId: 'pub-1', manifestId: 'man-1', renditionId: 'ren-1', assetId: 'asset-1' }
  // The retired ingest wrote coordinates under archive-manager names and kept
  // the spool path, so the migration must map one and basename the other.
  const named = { ...bare, title: 'FUBAR', fileName: '/spool/uploads/Fubar.S02E07.2160p.mkv', mediaContext: { contentKind: 'episode', mediaProvider: 'tmdb', mediaId: '221300', seasonNumber: 2, episodeNumber: 7, sourceUrl: 'https://private.invalid/e7' } }

  t.alike(await migrateLegacyIngest({ legacyStore: { async listJobs () { return [bare] } }, acquisitionStore: store, legacyPrincipalId: 'local-user', legacyPublisherId: 'publisher-1', now: () => NOW }), { migrated: 1, skipped: 0 })
  t.is((await store.get('ing_episode')).publicationMetadata, null, 'a legacy record with no metadata names no work')

  t.alike(await migrateLegacyIngest({ legacyStore: { async listJobs () { return [named] } }, acquisitionStore: store, legacyPrincipalId: 'local-user', legacyPublisherId: 'publisher-1', now: () => NOW }), { migrated: 0, skipped: 1 })
  const backfilled = await store.get('ing_episode')
  t.is(backfilled.publicationMetadata.title, 'FUBAR', 'an already-migrated job gains the name of its work')
  t.is(backfilled.publicationMetadata.sourceFileName, 'Fubar.S02E07.2160p.mkv', 'the source file name is kept, its spool path is not')
  t.alike(backfilled.publicationMetadata.mediaContext, { kind: 'episode', namespace: 'tmdb', identifier: '221300', season: 2, episode: 7 })
  t.absent(JSON.stringify(backfilled).includes('private.invalid'), 'source material never rides in on the backfill')
  t.is(backfilled.state, 'completed', 'the backfill changes nothing but the work identity')
})

// Clearing a dead attempt is a durable delete an operator asked for. It has to
// take the whole record with it: a surviving idempotency index would point at a
// job that no longer exists, and the next replay of that request would read the
// store as corrupt.
test('forget removes a finished record, its events and its idempotency index', async t => {
  const store = createAcquisitionStore({ bee: fakeBee(), now: () => NOW })
  const initial = durableJob()
  await store.createOrReplay({ idempotencyDigest: initial.idempotencyDigest, requestFingerprint: initial.requestFingerprint, job: initial })
  const running = (await store.transition(initial.acquisitionId, { expectedVersion: 0, from: 'queued', to: 'acquiring' })).job

  await t.exception(store.forget(running.acquisitionId), /ACQUISITION_JOB_ACTIVE/)
  t.ok(await store.get(running.acquisitionId), 'a job still running is never deleted')

  const failed = (await store.transition(running.acquisitionId, { expectedVersion: running.version, from: 'acquiring', to: 'failed', patch: { errorCode: 'SOURCE_TIMEOUT', recoverable: true } })).job
  t.alike(await store.forget(failed.acquisitionId), { forgotten: true, state: 'failed' })
  t.is(await store.get(failed.acquisitionId), null, 'the record is gone')
  t.alike(await store.listEvents(failed.acquisitionId), [], 'and so is its history')
  t.is((await store.countByState()).failed, 0, 'the state counters follow the delete')
  t.is(await store.findByIdempotency(initial.idempotencyDigest), null, 'the idempotency index no longer names a missing job')

  t.alike(await store.forget(failed.acquisitionId), { forgotten: false, state: null }, 'clearing twice is not an error')

  // The same request may be submitted again once its record is cleared.
  t.ok((await store.createOrReplay({ idempotencyDigest: initial.idempotencyDigest, requestFingerprint: initial.requestFingerprint, job: initial })).created)
})

// Adapter gating is a two-step flow, and it is easy to misread. A request names
// a resolution, not an adapter, so admission at request time carries none. The
// adapter identity exists only once a source grant is attached or a resolution
// is dispatched, and both of those re-admit with it. What keeps the gate honest
// is that an open policy with no allowlisted adapter admits nothing at all.
test('an acquisition adapter is allowlisted where the adapter is actually known', async t => {
  const runtime = createAcquisitionPolicyRuntime({ now: () => NOW })
  await runtime.setPolicy(openPolicy({ allowedAdapterIds: ['granted-source'] }), { consent: true })
  const admission = { request: request(), principal: PRINCIPAL }

  t.ok(await runtime.admit({ ...admission, adapterId: null }), 'a request that has not chosen an adapter is admitted')
  t.ok(await runtime.admit({ ...admission, adapterId: 'granted-source' }), 'and the grant that names an allowlisted adapter is admitted')
  await t.exception(
    runtime.admit({ ...admission, adapterId: 'somebody-elses-adapter' }),
    /ACQUISITION_ADAPTER_DENIED/,
    'a grant naming an adapter the operator never allowlisted is refused'
  )

  const closed = createAcquisitionPolicyRuntime({ now: () => NOW })
  await closed.setPolicy(openPolicy({ allowedAdapterIds: [] }), { consent: true })
  await t.exception(
    closed.admit({ ...admission, adapterId: null }),
    /ACQUISITION_ADAPTER_DENIED/,
    'an open policy that allowlists no adapter admits nothing, so an unnamed adapter is never a way in'
  )
})

// Clearing one finished record must not touch its neighbours. The keys share a
// prefix and the event rows are deleted by range, so a scoping mistake here
// would quietly empty an operator's whole job history.
test('forget removes exactly one record and leaves every other job intact', async t => {
  const bee = fakeBee()
  const store = createAcquisitionStore({ bee, now: () => NOW })
  const ids = ['ing_a', 'ing_b', 'ing_c', 'ing_d']
  for (const acquisitionId of ids) {
    const job = durableJob({ acquisitionId, idempotencyDigest: acquisitionId.padEnd(64, '0'), requestFingerprint: acquisitionId.padEnd(64, 'f') })
    await store.createOrReplay({ idempotencyDigest: job.idempotencyDigest, requestFingerprint: job.requestFingerprint, job })
    const running = (await store.transition(acquisitionId, { expectedVersion: 0, from: 'queued', to: 'acquiring' })).job
    await store.transition(acquisitionId, { expectedVersion: running.version, from: 'acquiring', to: 'failed', patch: { errorCode: 'SOURCE_TIMEOUT', recoverable: true } })
  }
  t.is((await store.countByState()).failed, 4)

  t.alike(await store.forget('ing_b'), { forgotten: true, state: 'failed' })

  t.is(await store.get('ing_b'), null)
  for (const survivor of ['ing_a', 'ing_c', 'ing_d']) {
    t.ok(await store.get(survivor), `${survivor} survives its neighbour being cleared`)
    t.ok((await store.listEvents(survivor)).length > 0, `${survivor} keeps its history`)
  }
  t.is((await store.countByState()).failed, 3, 'the counter drops by exactly one')

  // A fresh store over the same storage sees the same thing, so the delete was
  // scoped on disk and not just in the counters this process happened to hold.
  const reopened = createAcquisitionStore({ bee, now: () => NOW })
  t.is((await reopened.countByState()).failed, 3)
  t.is(await reopened.get('ing_b'), null)
  t.ok(await reopened.get('ing_c'))
})
