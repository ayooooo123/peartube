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
  t.alike(Object.keys(job), ['schemaVersion', 'acquisitionId', 'state', 'retentionClass', 'bytesAcquired', 'expectedBytes', 'publicationId', 'manifestId', 'renditionId', 'assetId', 'errorCode', 'recoverable', 'createdAt', 'updatedAt'])
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
