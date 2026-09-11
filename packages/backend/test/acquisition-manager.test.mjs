import test from 'brittle'

import {
  CLOSED_ACQUISITION_POLICY,
  createAcquisitionManager,
  createAcquisitionPolicyRuntime,
  createAcquisitionStore,
  createSourceGrantVault
} from '../src/acquisition/index.js'
import { createSourceReader } from '../src/assets/source-reader.js'

const NOW = 1_787_788_800_000
const REF = 'B'.repeat(43)
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
const PRINCIPAL = { principalId: 'local-user', isLocal: true, publisherIds: ['publisher-1'] }
const REQUEST = { schemaVersion: 1, resolutionRef: REF, publisherId: 'publisher-1', retentionClass: 'archive-pin' }

function fakeBee () {
  const map = new Map(); const clone = value => JSON.parse(JSON.stringify(value))
  return { async get (key) { return map.has(key) ? { value: clone(map.get(key)) } : null }, batch () { const operations = []; return { async put (key, value) { operations.push(['put', key, clone(value)]) }, async del (key) { operations.push(['del', key]) }, async flush () { for (const [operation, key, value] of operations) { if (operation === 'put') map.set(key, value); else map.delete(key) } } } }, async * createReadStream ({ gte, lt }) { for (const key of [...map.keys()].sort()) if (key >= gte && key < lt) yield { key, value: clone(map.get(key)) } } }
}
function openPolicy () {
  return { ...CLOSED_ACQUISITION_POLICY, migrationRequired: false, enabled: true, allowedPublisherIds: ['publisher-1'], allowedAdapterIds: ['local-adapter'], maxQueuedJobs: 8, maxConcurrentJobs: 1, maxConcurrentPerRequester: 1, maxRequestBytes: 4096, maxAcquireBytesPer24h: 1024, maxAcquireBytesPerSecond: 1024, maxStagingBytes: 1024, minFreeDiskBytes: 1, maxJobRuntimeMs: 60_000, sourceGrantTtlMs: 30_000, publicRequestsPerMinute: 2, maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 10 }
}
function reader () {
  return createSourceReader({ resumable: true, maxReadBytes: 1024, async describe () { return { identity: { kind: 'etag', value: 'asset-v1' }, byteLength: BYTES.byteLength, mimeType: 'video/mp4' } }, open ({ offset, length }) { return (async function * () { yield BYTES.subarray(offset, offset + length) })() }, async close () {} })
}
function provider ({ verified = true, block = null, expectedIdentity = true, metadata = false, waitForGrant = false, onOpen = null } = {}) {
  return {
    async resolve () {
      return {
        adapterId: 'local-adapter',
        expected: { byteLength: BYTES.byteLength, ...(expectedIdentity ? { identity: { kind: 'etag', value: 'asset-v1' } } : {}) },
        ...(metadata ? { title: 'Durable title', mediaContext: { kind: 'movie', namespace: 'catalog', identifier: 'title-1' } } : {}),
        ...((typeof waitForGrant === 'function' ? waitForGrant() : waitForGrant) ? { deferredInput: true } : {})
      }
    },
    canOpen () { return true },
    async open () { onOpen?.(); return reader() },
    async acquire ({ reader: source, signal, onProgress }) {
      if (block) await block(signal)
      let bytes = 0
      for await (const chunk of source.open({ offset: 0, length: BYTES.byteLength, signal })) bytes += chunk.byteLength
      await onProgress({ sourceBytesRead: bytes, sourceBytesAccepted: bytes, bytesAcquired: bytes, stagingBytes: 0 })
      return { descriptor: { assetId: 'asset-1', key: 'a'.repeat(64), treeHash: 'b'.repeat(64), length: 1, byteLength: bytes, blockSize: bytes }, stagingBytes: 0 }
    },
    async verify () { return verified ? { verified: true, byteLength: BYTES.byteLength } : { verified: false, byteLength: 0 } },
    async discard () {}
  }
}
function vault () { return createSourceGrantVault({ now: () => NOW, resolver: { async resolve () { return reader() }, async revoke () {} } }) }
async function eventually (read, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('condition was not reached')
}
function fixture ({ acquisitionProvider = provider(), authority = () => true, publisher: publisherOverride = null } = {}) {
  let publishes = 0
  let publishedInput = null
  const defaultPublisher = {
    async hasAuthority () { return authority() },
    async publish (input) {
      publishedInput = input
      publishes++
      return { publicationId: 'publication-1', manifestId: 'manifest-1', renditionId: 'rendition-1', assetId: input.asset.assetId }
    }
  }
  const sourceGrants = vault()
  const manager = createAcquisitionManager({
    store: createAcquisitionStore({ bee: fakeBee(), now: () => NOW }),
    policy: createAcquisitionPolicyRuntime({ policy: openPolicy(), now: () => NOW }),
    provider: acquisitionProvider,
    sourceGrants,
    publisher: publisherOverride || defaultPublisher,
    freeDiskBytes: () => 1024,
    now: () => NOW
  })
  return { manager, sourceGrants, publishes: () => publishes, publishedInput: () => publishedInput }
}

test('manager publishes only after exact verification and records every transition', async t => {
  const fixtureValue = fixture(); await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({ idempotencyKey: 'request-1', request: REQUEST, principal: PRINCIPAL })
  const completed = await eventually(() => fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL }), job => job.state === 'completed')
  t.is(completed.bytesAcquired, BYTES.byteLength); t.is(completed.assetId, 'asset-1'); t.is(fixtureValue.publishes(), 1)
  await fixtureValue.manager.close()
})

test('transferred results cannot replace the requester expected source identity', async t => {
  let imports = 0
  const acquisitionProvider = provider({ waitForGrant: true })
  acquisitionProvider.importAsset = async () => { imports++; throw new Error('unexpected transfer') }
  const fixtureValue = fixture({ acquisitionProvider })
  t.teardown(() => fixtureValue.manager.close())
  await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({
    idempotencyKey: 'changed-transferred-source',
    request: REQUEST,
    principal: PRINCIPAL
  })
  await t.exception(fixtureValue.manager.acceptTransferredResult({
    acquisitionId: queued.acquisitionId,
    sourceIdentity: { kind: 'etag', value: 'a'.repeat(64) },
    asset: null
  }), { code: 'SOURCE_IDENTITY_CHANGED' })
  t.is(imports, 0, 'rejects the substituted identity before transferring bytes')
  t.is(fixtureValue.publishes(), 0, 'a substituted source cannot be published')
})

test('publication repository recovery completes a job after the catalog commit succeeds', async t => {
  let committed = null
  const publisher = {
    async hasAuthority () { return true },
    async publish (input) {
      committed = {
        publicationId: 'publication-recovered',
        manifestId: 'manifest-recovered',
        renditionId: 'rendition-recovered',
        assetId: input.asset.assetId
      }
      throw new Error('repository write failed after publication commit')
    },
    async getPublication () {
      return committed
    }
  }
  const fixtureValue = fixture({ publisher })
  await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({
    idempotencyKey: 'request-publication-recovery',
    request: REQUEST,
    principal: PRINCIPAL
  })
  const completed = await eventually(
    () => fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL }),
    job => job.state === 'completed'
  )
  t.is(completed.publicationId, 'publication-recovered')
  await fixtureValue.manager.close()
})

test('a private local resolution stays queued until its source grant is attached', async t => {
  let opens = 0
  const fixtureValue = fixture({
    acquisitionProvider: provider({ waitForGrant: true, onOpen: () => { opens++ } })
  })
  await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({
    idempotencyKey: 'request-awaiting-grant',
    request: REQUEST,
    principal: PRINCIPAL
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  const waiting = await fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL })
  t.is(waiting.state, 'queued')
  t.is(opens, 0, 'the source is not opened before a grant exists')
  await fixtureValue.manager.close()
})

test('replaying a failed deferred acquisition waits for its replacement source grant', async t => {
  let failFirstAttempt = true
  const fixtureValue = fixture({
    acquisitionProvider: provider({
      waitForGrant: true,
      block: async () => {
        if (!failFirstAttempt) return
        failFirstAttempt = false
        throw Object.assign(new Error('temporary S3 timeout'), { code: 'S3_REQUEST_TIMEOUT' })
      }
    })
  })
  await fixtureValue.manager.start()
  const input = { idempotencyKey: 'request-replacement-grant', request: REQUEST, principal: PRINCIPAL }
  const queued = await fixtureValue.manager.request(input)
  await fixtureValue.manager.attachGrant({
    acquisitionId: queued.acquisitionId,
    principal: PRINCIPAL,
    grant: {
      token: 'initial-source-grant-0001',
      adapterId: 'local-adapter',
      audience: { principalId: PRINCIPAL.principalId, acquisitionId: queued.acquisitionId },
      expiresAt: NOW + 1000
    }
  })
  const failed = await eventually(
    () => fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL }),
    job => job.state === 'failed'
  )
  t.is(failed.errorCode, 'S3_REQUEST_TIMEOUT')
  t.is(failed.recoverable, true)

  const replayed = await fixtureValue.manager.request(input)
  t.is(replayed.state, 'queued')
  await new Promise(resolve => setTimeout(resolve, 0))
  t.is(
    (await fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL })).state,
    'queued',
    'the stale grant cannot start the retry before the replacement is attached'
  )

  await fixtureValue.manager.attachGrant({
    acquisitionId: queued.acquisitionId,
    principal: PRINCIPAL,
    grant: {
      token: 'replacement-source-grant-0002',
      adapterId: 'local-adapter',
      audience: { principalId: PRINCIPAL.principalId, acquisitionId: queued.acquisitionId },
      expiresAt: NOW + 1000
    }
  })
  const completed = await eventually(
    () => fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL }),
    job => job.state === 'completed'
  )
  t.is(completed.bytesAcquired, BYTES.byteLength)
  await fixtureValue.manager.close()
})

test('a stale failed acquisition is replaced when its resolution now waits for a grant', async t => {
  let deferred = false
  let opens = 0
  const fixtureValue = fixture({
    acquisitionProvider: provider({
      waitForGrant: () => deferred,
      onOpen: () => {
        opens++
        throw Object.assign(new Error('source grant missing'), { code: 'SOURCE_UNAVAILABLE' })
      }
    })
  })
  await fixtureValue.manager.start()
  const failedRequest = await fixtureValue.manager.request({
    idempotencyKey: 'request-migrated-to-grant',
    request: REQUEST,
    principal: PRINCIPAL
  })
  await eventually(
    () => fixtureValue.manager.get({ acquisitionId: failedRequest.acquisitionId, principal: PRINCIPAL }),
    job => job.state === 'failed'
  )

  deferred = true
  const replacement = await fixtureValue.manager.request({
    idempotencyKey: 'request-migrated-to-grant',
    request: REQUEST,
    principal: PRINCIPAL
  })
  t.is(replacement.state, 'queued')
  t.is(opens, 1, 'replacement waits for the source grant instead of reopening the source')
  await fixtureValue.manager.close()
})

test('verification failure never reaches publisher', async t => {
  const fixtureValue = fixture({ acquisitionProvider: provider({ verified: false }) }); await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({ idempotencyKey: 'request-2', request: REQUEST, principal: PRINCIPAL })
  const failed = await eventually(() => fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL }), job => job.state === 'failed')
  t.is(failed.errorCode, 'VERIFICATION_FAILED'); t.is(fixtureValue.publishes(), 0)
  await fixtureValue.manager.close()
})

test('publisher authority loss after verification prevents publication', async t => {
  let checks = 0
  const fixtureValue = fixture({ authority: () => ++checks === 1 }); await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({ idempotencyKey: 'request-3', request: REQUEST, principal: PRINCIPAL })
  const failed = await eventually(() => fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL }), job => job.state === 'failed')
  t.is(failed.errorCode, 'PUBLISHER_AUTHORITY_LOST'); t.is(fixtureValue.publishes(), 0)
  await fixtureValue.manager.close()
})

test('manager binds an unknown source identity before bytes and keeps public publication metadata', async t => {
  const fixtureValue = fixture({ acquisitionProvider: provider({ expectedIdentity: false, metadata: true }) })
  await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({ idempotencyKey: 'request-with-private-grant', request: REQUEST, principal: PRINCIPAL })
  const completed = await eventually(() => fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL }), job => job.state === 'completed')
  t.is(completed.state, 'completed')
  t.alike(fixtureValue.publishedInput().resolution, {
    title: 'Durable title',
    sourceFileName: null,
    mediaContext: { kind: 'movie', namespace: 'catalog', identifier: 'title-1' }
  })
  await fixtureValue.manager.close()
})

test('concurrency limits keep excess acquisitions queued and dispatch the next job', async t => {
  const blockedProvider = provider({ block: signal => new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('aborted'), { code: 'ASSET_WRITE_CANCELLED' }))
    signal.addEventListener('abort', abort, { once: true })
  }) })
  const fixtureValue = fixture({ acquisitionProvider: blockedProvider })
  await fixtureValue.manager.start()
  const first = await fixtureValue.manager.request({ idempotencyKey: 'concurrent-1', request: REQUEST, principal: PRINCIPAL })
  const second = await fixtureValue.manager.request({ idempotencyKey: 'concurrent-2', request: REQUEST, principal: PRINCIPAL })
  await eventually(() => fixtureValue.manager.get({ acquisitionId: first.acquisitionId, principal: PRINCIPAL }), job => job.state === 'acquiring')
  t.is((await fixtureValue.manager.get({ acquisitionId: second.acquisitionId, principal: PRINCIPAL })).state, 'queued')
  await fixtureValue.manager.cancel({ acquisitionId: first.acquisitionId, principal: PRINCIPAL })
  await eventually(() => fixtureValue.manager.get({ acquisitionId: second.acquisitionId, principal: PRINCIPAL }), job => job.state === 'acquiring')
  await fixtureValue.manager.cancel({ acquisitionId: second.acquisitionId, principal: PRINCIPAL })
  await fixtureValue.manager.close()
  t.pass('queued acquisition used the released slot')
})

test('public remote jobs do not self-authorize after policy tightens to allowlisted', async t => {
  const policyRuntime = createAcquisitionPolicyRuntime({
    policy: { ...openPolicy(), requesterMode: 'public', acceptPublicRequests: true },
    now: () => NOW
  })
  const acquisitionProvider = { ...provider(), canOpen () { return false } }
  const manager = createAcquisitionManager({
    store: createAcquisitionStore({ bee: fakeBee(), now: () => NOW }),
    policy: policyRuntime,
    provider: acquisitionProvider,
    sourceGrants: vault(),
    publisher: {
      async hasAuthority () { return true },
      async publish () { throw new Error('not used') }
    },
    freeDiskBytes: () => 1024,
    now: () => NOW
  })
  await manager.start()
  const principal = { principalId: 'remote-user' }
  const prepared = await manager.acceptRemoteRequest({ idempotencyKey: 'remote-request-1', request: REQUEST, principal })
  const queued = await manager.commitPreparedRequest({ prepared, isRemote: true, publishNetwork: false })
  t.is(queued.state, 'queued')
  await policyRuntime.setPolicy({ ...openPolicy(), requesterMode: 'allowlisted', acceptPublicRequests: false }, { consent: true })
  const cancelled = await eventually(
    () => manager.get({ acquisitionId: queued.acquisitionId, principal }),
    job => job.state === 'cancelled'
  )
  t.is(cancelled.state, 'cancelled')
  await manager.close()
})

test('retry exhaustion clears recoverable so a new idempotency key can be used', async t => {
  const transientProvider = provider({ block: async () => {
    const error = new Error('temporary source failure')
    error.code = 'SOURCE_TEMPORARY'
    throw error
  } })
  const fixtureValue = fixture({ acquisitionProvider: transientProvider })
  await fixtureValue.manager.start()
  const input = { idempotencyKey: 'retry-exhaustion-1', request: REQUEST, principal: PRINCIPAL }
  let job = await fixtureValue.manager.request(input)
  job = await eventually(() => fixtureValue.manager.get({ acquisitionId: job.acquisitionId, principal: PRINCIPAL }), value => value.state === 'failed')
  t.is(job.recoverable, true)
  await fixtureValue.manager.request(input)
  job = await eventually(() => fixtureValue.manager.get({ acquisitionId: job.acquisitionId, principal: PRINCIPAL }), value => value.state === 'failed' && value.updatedAt >= job.updatedAt)
  const exhausted = await fixtureValue.manager.request(input)
  t.is(exhausted.recoverable, false)
  await fixtureValue.manager.close()
})

test('manager.retry restarts a recoverable failed acquisition and rejects non-failed/exhausted jobs', async t => {
  let failFirst = true
  const failOnceProvider = provider({ block: async () => {
    if (failFirst) {
      failFirst = false
      const error = new Error('temporary network failure')
      error.code = 'SOURCE_TEMPORARY'
      throw error
    }
  } })
  const events = []
  const fixtureValue = fixture({ acquisitionProvider: failOnceProvider })
  fixtureValue.manager.subscribe(event => events.push(event))
  await fixtureValue.manager.start()
  const input = { idempotencyKey: 'retry-direct-1', request: REQUEST, principal: PRINCIPAL }
  let job = await fixtureValue.manager.request(input)
  job = await eventually(() => fixtureValue.manager.get({ acquisitionId: job.acquisitionId, principal: PRINCIPAL }), value => value.state === 'failed')
  t.is(job.recoverable, true)

  const retried = await fixtureValue.manager.retry({ acquisitionId: job.acquisitionId, principal: PRINCIPAL })
  t.is(retried.state, 'queued')
  t.ok(events.some(event => event.type === 'acquisition.restarted'), 'acquisition.restarted event emitted')
  const completed = await eventually(() => fixtureValue.manager.get({ acquisitionId: job.acquisitionId, principal: PRINCIPAL }), value => value.state === 'completed')
  t.is(completed.state, 'completed')

  await t.exception(
    () => fixtureValue.manager.retry({ acquisitionId: job.acquisitionId, principal: PRINCIPAL }),
    /only failed acquisitions can be retried/
  )
  await fixtureValue.manager.close()
})

test('explicit cancellation is terminal while shutdown leaves interrupted work restartable', async t => {
  const blockedProvider = provider({ block: signal => new Promise((resolve, reject) => { const abort = () => reject(Object.assign(new Error('aborted'), { code: 'ASSET_WRITE_CANCELLED' })); signal.addEventListener('abort', abort, { once: true }) }) })
  const fixtureValue = fixture({ acquisitionProvider: blockedProvider }); await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({ idempotencyKey: 'request-4', request: REQUEST, principal: PRINCIPAL })
  await eventually(() => fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL }), job => job.state === 'acquiring')
  await t.exception(fixtureValue.manager.attachGrant({
    acquisitionId: queued.acquisitionId,
    principal: PRINCIPAL,
    grant: {
      token: 'replacement-source-grant-0001',
      adapterId: 'local-adapter',
      audience: { principalId: PRINCIPAL.principalId, acquisitionId: queued.acquisitionId },
      expiresAt: NOW + 1000
    }
  }), /ACQUISITION_NOT_QUEUED/)
  const cancelled = await fixtureValue.manager.cancel({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL })
  t.is(cancelled.state, 'cancelled'); t.is(cancelled.recoverable, false)
  await fixtureValue.manager.close()
})

// `allowedAdapterIds` is the operator saying which sources this node may fetch
// through. Admission skips that list when a resolution names no adapter, which
// is correct at request time - nothing has been chosen yet - and would be a way
// past the allowlist at the moment bytes start moving.
test('a source that reaches the fetch without naming its adapter is refused, and nothing is read', async t => {
  let opened = 0
  const anonymous = provider()
  const fixtureValue = fixture({
    acquisitionProvider: {
      ...anonymous,
      async resolve () { const resolved = await anonymous.resolve(); return { ...resolved, adapterId: null } },
      async open (input) { opened++; return anonymous.open(input) }
    }
  })
  await fixtureValue.manager.start()

  const queued = await fixtureValue.manager.request({ idempotencyKey: 'request-anonymous-adapter', request: REQUEST, principal: PRINCIPAL })
  t.is(queued.state, 'queued', 'the request is admitted, because a request names a resolution and not an adapter')

  const failed = await eventually(
    () => fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL }),
    job => job.state === 'failed'
  )
  t.is(failed.errorCode, 'ACQUISITION_ADAPTER_DENIED', 'the fetch is refused by the allowlist it could not be checked against')
  t.is(opened, 0, 'and the source was never opened')
  t.is(fixtureValue.publishes(), 0)
  await fixtureValue.manager.close()
})

test('deferred replay accepts a source filename refinement but rejects semantic changes', async t => {
  const fixtureValue = fixture({ acquisitionProvider: provider({ waitForGrant: true }) })
  await fixtureValue.manager.start()
  const first = await fixtureValue.manager.request({
    idempotencyKey: 'request-filename-refinement',
    request: { ...REQUEST, sourceFileName: 'Constantine: City of Demons.2018.1080p.mkv' },
    principal: PRINCIPAL
  })
  const replay = await fixtureValue.manager.request({
    idempotencyKey: 'request-filename-refinement',
    request: { ...REQUEST, sourceFileName: 'Movie.2026.1080p.WEB-DL.mkv' },
    principal: PRINCIPAL
  })
  t.is(replay.acquisitionId, first.acquisitionId)
  await t.exception(fixtureValue.manager.request({
    idempotencyKey: 'request-filename-refinement',
    request: { ...REQUEST, retentionClass: 'contribution-cache' },
    principal: PRINCIPAL
  }), /IDEMPOTENCY_CONFLICT/)
  await fixtureValue.manager.close()
})

test('a 100% staged complete acquisition completes and publishes without re-attached grant', async t => {
  const bee = fakeBee()
  const store = createAcquisitionStore({ bee, now: () => NOW })
  const policyRuntime = createAcquisitionPolicyRuntime({ policy: openPolicy(), now: () => NOW })

  const job = {
    schemaVersion: 1,
    acquisitionId: 'acq_staged_complete',
    state: 'queued',
    version: 0,
    principalId: 'local-user',
    publisherId: 'publisher-1',
    requesterPublisherIds: ['publisher-1'],
    isRemote: false,
    deferredInput: true,
    idempotencyDigest: 'd'.repeat(64),
    requestFingerprint: 'f'.repeat(64),
    request: REQUEST,
    retentionClass: 'archive-pin',
    publicationMetadata: { title: 'Staged Movie', sourceFileName: 'staged.mkv', mediaContext: null },
    expectedBytes: BYTES.byteLength,
    expectedIdentity: { kind: 'etag', value: 'etag-asset-v1' },
    sourceBytesRead: BYTES.byteLength,
    sourceBytesAccepted: BYTES.byteLength,
    bytesAcquired: BYTES.byteLength,
    verifiedBytes: 0,
    committedBytes: 0,
    retainedBytes: 0,
    stagingBytes: BYTES.byteLength,
    stagingPeakBytes: BYTES.byteLength,
    attempts: 0,
    startedAt: NOW,
    finishedAt: null,
    verifiedPrefix: { byteLength: BYTES.byteLength, identity: { kind: 'etag', value: 'etag-asset-v1' } },
    verifiedAsset: null,
    publication: null,
    errorCode: null,
    recoverable: false,
    createdAt: NOW,
    updatedAt: NOW
  }
  await store.createOrReplay({
    idempotencyDigest: job.idempotencyDigest,
    requestFingerprint: job.requestFingerprint,
    job
  })

  let publishes = 0
  const manager = createAcquisitionManager({
    store,
    policy: policyRuntime,
    provider: {
      ...provider({ expectedIdentity: true }),
      async acquire ({ resume, signal, onProgress }) {
        const bytes = BYTES.byteLength
        await onProgress({ sourceBytesRead: bytes, sourceBytesAccepted: bytes, bytesAcquired: bytes, stagingBytes: bytes })
        return {
          descriptor: { assetId: 'asset-1', key: 'a'.repeat(64), treeHash: 'b'.repeat(64), length: 1, byteLength: bytes, blockSize: bytes },
          stagingBytes: bytes
        }
      }
    },
    sourceGrants: vault(),
    publisher: {
      hasAuthority: () => true,
      async publish () { publishes++; return { assetId: 'asset-1', manifestId: 'm'.repeat(64), renditionId: 'r'.repeat(64), publicationId: 'p'.repeat(64) } }
    },
    now: () => NOW
  })

  await manager.start()

  const completed = await eventually(
    () => manager.get({ acquisitionId: job.acquisitionId, principal: PRINCIPAL }),
    j => j?.state === 'completed'
  )
  t.is(completed.state, 'completed')
  t.is(completed.bytesAcquired, BYTES.byteLength)
  t.is(publishes, 1, 'published successfully from staged bytes with no active source grant')
  await manager.close()
})


test('manager.start transitions unschedulable in-flight and queued jobs with deferredInput to failed/recoverable', async t => {
  const bee = fakeBee()
  const store = createAcquisitionStore({ bee })
  const sourceGrants = vault()
  const policyRuntime = createAcquisitionPolicyRuntime({ policy: openPolicy(), now: () => NOW })

  // Seed an in-flight job that was interrupted mid-stream and cannot be scheduled without grant
  const inFlightJob = {
    schemaVersion: 1,
    acquisitionId: 'acq_interrupted_1',
    state: 'acquiring',
    version: 1,
    principalId: 'local-user',
    publisherId: 'publisher-1',
    requesterPublisherIds: ['publisher-1'],
    isRemote: false,
    deferredInput: true,
    idempotencyDigest: 'd'.repeat(64),
    requestFingerprint: 'f'.repeat(64),
    request: REQUEST,
    retentionClass: 'archive-pin',
    publicationMetadata: null,
    expectedBytes: 1000,
    expectedIdentity: null,
    sourceBytesRead: 500,
    sourceBytesAccepted: 500,
    bytesAcquired: 500,
    verifiedBytes: 0,
    committedBytes: 0,
    retainedBytes: 0,
    stagingBytes: 0,
    stagingPeakBytes: 0,
    attempts: 1,
    startedAt: NOW - 5000,
    finishedAt: null,
    errorCode: null,
    recoverable: false,
    verifiedPrefix: null,
    verifiedAsset: null,
    publication: null,
    createdAt: NOW - 10000,
    updatedAt: NOW - 5000
  }

  // Seed a queued job with deferredInput that has no grant
  const queuedJob = {
    ...inFlightJob,
    acquisitionId: 'acq_queued_stuck_1',
    idempotencyDigest: 'e'.repeat(64),
    requestFingerprint: 'g'.repeat(64),
    state: 'queued'
  }

  const batch = bee.batch()
  await batch.put('acquisition/v1/job/acq_interrupted_1', inFlightJob)
  await batch.put('acquisition/v1/active/acq_interrupted_1', { acquisitionId: 'acq_interrupted_1' })
  await batch.put('acquisition/v1/job/acq_queued_stuck_1', queuedJob)
  await batch.put('acquisition/v1/active/acq_queued_stuck_1', { acquisitionId: 'acq_queued_stuck_1' })
  await batch.flush()

  const manager = createAcquisitionManager({
    store,
    policy: policyRuntime,
    provider: provider(),
    sourceGrants,
    publisher: { hasAuthority: () => true, async publish () {} },
    now: () => NOW
  })

  await manager.start()

  const recoveredInFlight = await manager.get({ acquisitionId: 'acq_interrupted_1', principal: PRINCIPAL })
  t.is(recoveredInFlight.state, 'failed')
  t.is(recoveredInFlight.errorCode, 'RESTART_INTERRUPTED')
  t.is(recoveredInFlight.recoverable, true)
  t.is(recoveredInFlight.bytesAcquired, 500, 'preserves confirmed byte progress')

  const recoveredQueued = await manager.get({ acquisitionId: 'acq_queued_stuck_1', principal: PRINCIPAL })
  t.is(recoveredQueued.state, 'failed')
  t.is(recoveredQueued.errorCode, 'SOURCE_GRANT_REQUIRED')
  t.is(recoveredQueued.recoverable, true)

  await manager.close()
})

test('manager.start repairs falsely exhausted rate budget and prefix mismatch jobs', async t => {
  const bee = fakeBee()
  const store = createAcquisitionStore({ bee })
  const policyRuntime = createAcquisitionPolicyRuntime({ policy: openPolicy(), now: () => NOW })

  // Seed an exhausted rate-budget failure
  const rateExhausted = {
    schemaVersion: 1,
    acquisitionId: 'acq_rate_exhausted_1',
    state: 'failed',
    version: 3,
    principalId: 'local-user',
    publisherId: 'publisher-1',
    requesterPublisherIds: ['publisher-1'],
    isRemote: false,
    deferredInput: true,
    idempotencyDigest: 'a'.repeat(64),
    requestFingerprint: 'b'.repeat(64),
    request: REQUEST,
    retentionClass: 'archive-pin',
    publicationMetadata: null,
    expectedBytes: 10000,
    expectedIdentity: null,
    sourceBytesRead: 5000,
    sourceBytesAccepted: 5000,
    bytesAcquired: 5000,
    verifiedBytes: 0,
    committedBytes: 0,
    retainedBytes: 0,
    stagingBytes: 0,
    stagingPeakBytes: 0,
    attempts: 2,
    startedAt: NOW - 5000,
    finishedAt: NOW - 1000,
    errorCode: 'ACQUISITION_RATE_BUDGET_EXCEEDED',
    recoverable: false,
    verifiedPrefix: null,
    verifiedAsset: null,
    publication: null,
    createdAt: NOW - 10000,
    updatedAt: NOW - 1000
  }

  // Seed an exhausted prefix-mismatch failure
  const prefixExhausted = {
    ...rateExhausted,
    acquisitionId: 'acq_prefix_exhausted_1',
    idempotencyDigest: 'c'.repeat(64),
    requestFingerprint: 'd'.repeat(64),
    errorCode: 'ASSET_SOURCE_IDENTITY_CHANGED',
    recoverable: false
  }

  const batch = bee.batch()
  await batch.put('acquisition/v1/job/acq_rate_exhausted_1', rateExhausted)
  await batch.put('acquisition/v1/job/acq_prefix_exhausted_1', prefixExhausted)
  await batch.flush()

  const manager = createAcquisitionManager({
    store,
    policy: policyRuntime,
    provider: provider(),
    sourceGrants: vault(),
    publisher: { hasAuthority: () => true, async publish () {} },
    now: () => NOW
  })

  await manager.start()

  const repairedRate = await manager.get({ acquisitionId: 'acq_rate_exhausted_1', principal: PRINCIPAL })
  t.is(repairedRate.state, 'failed')
  t.is(repairedRate.recoverable, true, 'repaired rate exhausted job to recoverable')

  const repairedPrefix = await manager.get({ acquisitionId: 'acq_prefix_exhausted_1', principal: PRINCIPAL })
  t.is(repairedPrefix.state, 'failed')
  t.is(repairedPrefix.recoverable, true, 'repaired prefix mismatch job to recoverable')

  await manager.close()
})

test('getPublicProjection returns only narrow public projection fields without principal checks', async t => {
  const fixtureValue = fixture()
  const requested = await fixtureValue.manager.request({
    idempotencyKey: 'public-projection-test-1',
    request: REQUEST,
    principal: PRINCIPAL
  })

  // Check public projection while queued/in-flight without providing a principal
  const inFlightProjection = await fixtureValue.manager.getPublicProjection({
    acquisitionId: requested.acquisitionId
  })
  t.ok(inFlightProjection)
  t.is(inFlightProjection.acquisitionId, requested.acquisitionId)
  t.is(inFlightProjection.state, 'queued')
  t.is(inFlightProjection.publisherId, 'publisher-1')
  t.is(inFlightProjection.publicationId, null)
  t.is(inFlightProjection.renditionId, null)
  t.is(inFlightProjection.expectedBytes, BYTES.byteLength)

  // Assert strict field boundary: ONLY the 6 specified keys exist
  const allowedKeys = new Set(['acquisitionId', 'state', 'publisherId', 'publicationId', 'renditionId', 'expectedBytes'])
  t.alike(new Set(Object.keys(inFlightProjection)), allowedKeys)
  t.absent(inFlightProjection.principalId)
  t.absent(inFlightProjection.resolutionRef)
  t.absent(inFlightProjection.sourceFileName)
  t.absent(inFlightProjection.mediaContext)
  t.absent(inFlightProjection.verifiedAsset)

  // Non-existent ID returns null
  const missingProjection = await fixtureValue.manager.getPublicProjection({
    acquisitionId: 'acq_nonexistent_99'
  })
  t.is(missingProjection, null)
  const nullProjection = await fixtureValue.manager.getPublicProjection({})
  t.is(nullProjection, null)

  await fixtureValue.manager.start()
  // Wait for acquisition to finish and re-check projection
  const finished = await eventually(
    async () => fixtureValue.manager.get({ acquisitionId: requested.acquisitionId, principal: PRINCIPAL }),
    job => job?.state === 'completed'
  )
  t.is(finished.state, 'completed')

  const completedProjection = await fixtureValue.manager.getPublicProjection({
    acquisitionId: requested.acquisitionId
  })
  t.is(completedProjection.state, 'completed')
  t.is(completedProjection.publicationId, 'publication-1')
  t.is(completedProjection.renditionId, 'rendition-1')
  t.is(completedProjection.publisherId, 'publisher-1')
  t.is(completedProjection.expectedBytes, BYTES.byteLength)
  t.alike(new Set(Object.keys(completedProjection)), allowedKeys)

  await fixtureValue.manager.close()
})

test('rejected grant admission leaves no live capability and preserves an accepted replacement', async t => {
  const { manager, sourceGrants } = fixture({ acquisitionProvider: provider({ waitForGrant: true }) })
  t.teardown(() => manager.close())
  const job = await manager.request({ idempotencyKey: 'grant-admission-rollback', request: REQUEST, principal: PRINCIPAL })
  const grant = {
    token: 'rejected-private-source-grant-0001',
    adapterId: 'forbidden-adapter',
    audience: { principalId: PRINCIPAL.principalId, acquisitionId: job.acquisitionId },
    expiresAt: NOW + 1000,
  }
  await t.exception(manager.attachGrant({ acquisitionId: job.acquisitionId, principal: PRINCIPAL, grant }), /ADAPTER/)
  t.is(sourceGrants.has({ acquisitionId: job.acquisitionId, principal: PRINCIPAL }), false)
  await manager.attachGrant({ acquisitionId: job.acquisitionId, principal: PRINCIPAL, grant: { ...grant, adapterId: 'local-adapter' } })
  await t.exception(manager.attachGrant({ acquisitionId: job.acquisitionId, principal: PRINCIPAL, grant }), /ADAPTER/)
  t.is(sourceGrants.inspect({ acquisitionId: job.acquisitionId, principal: PRINCIPAL }).adapterId, 'local-adapter')
})

test('a rejected source describe closes its own reader and durably keeps the original recoverable error', async t => {
  let closes = 0
  const base = provider()
  const fixtureValue = fixture({
    acquisitionProvider: {
      ...base,
      async open () {
        return {
          resumable: true,
          maxReadBytes: 1024,
          async describe () { throw Object.assign(new Error('temporary metadata timeout'), { code: 'SOURCE_TEMPORARY' }) },
          async * open () {},
          async close () { closes++ }
        }
      }
    }
  })
  await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({
    idempotencyKey: 'describe-rejection-leak',
    request: REQUEST,
    principal: PRINCIPAL
  })
  const failed = await eventually(
    () => fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL }),
    job => job.state === 'failed'
  )
  t.is(failed.errorCode, 'SOURCE_TEMPORARY', 'the original describe error reaches the durable record')
  t.is(failed.recoverable, true, 'the failure stays recoverable instead of revoking access state to clean up the leak')
  t.is(closes, 1, 'the helper closes the exact reader it acquired before any ownership handoff')
  await fixtureValue.manager.close()
})

test('an invalid source description closes its own reader before the durable failure', async t => {
  let closes = 0
  const base = provider()
  const fixtureValue = fixture({
    acquisitionProvider: {
      ...base,
      async open () {
        return {
          resumable: true,
          maxReadBytes: 1024,
          async describe () { return { identity: { kind: 'etag', value: 'asset-v1' }, byteLength: BYTES.byteLength + 1, mimeType: 'video/mp4' } },
          async * open () {},
          async close () { closes++ }
        }
      }
    }
  })
  await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({
    idempotencyKey: 'describe-length-mismatch-leak',
    request: REQUEST,
    principal: PRINCIPAL
  })
  const failed = await eventually(
    () => fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL }),
    job => job.state === 'failed'
  )
  t.is(failed.errorCode, 'SOURCE_LENGTH_MISMATCH', 'the validation verdict is the durable error, not a leaked-reader side effect')
  t.is(closes, 1, 'the helper closes the exact reader it acquired before any ownership handoff')
  t.is(fixtureValue.publishes(), 0)
  await fixtureValue.manager.close()
})

const TRANSFER_DESCRIPTOR = {
  assetId: 'asset-1',
  key: 'a'.repeat(64),
  treeHash: 'b'.repeat(64),
  length: 1,
  byteLength: BYTES.byteLength,
  blockSize: BYTES.byteLength
}
const TRANSFER_IDENTITY = { kind: 'sha256', value: 'c'.repeat(64) }

function transferringProvider (importAsset) {
  const acquisitionProvider = provider({ expectedIdentity: false, waitForGrant: true })
  acquisitionProvider.importAsset = importAsset
  return acquisitionProvider
}
function cooperativeTransferHook () {
  const state = { calls: 0, aborted: false, signal: null, storeClosedAtAbort: false, settled: false }
  let release
  let storeWasClosed = () => false
  const hook = async function importAsset ({ signal }) {
    state.calls++
    state.signal = signal
    return new Promise((resolve, reject) => {
      const abort = () => {
        state.aborted = true
        state.storeClosedAtAbort = storeWasClosed()
        reject(Object.assign(new Error('transfer aborted'), { code: 'TRANSFER_ABORTED' }))
      }
      if (signal?.aborted) abort()
      else if (signal?.addEventListener) signal.addEventListener('abort', abort, { once: true })
      release = () => {
        state.settled = true
        resolve({ imported: true, byteLength: BYTES.byteLength, descriptor: { ...TRANSFER_DESCRIPTOR } })
      }
    })
  }
  return { hook, state, release: () => release?.(), observeStoreClosed: read => { storeWasClosed = read } }
}
function disposedStoreFixture ({ acquisitionProvider, publisher: publisherOverride = null } = {}) {
  let publishes = 0
  let disposed = false
  const inner = createAcquisitionStore({ bee: fakeBee(), now: () => NOW })
  const store = { ...inner, async close () { disposed = true; return inner.close() } }
  const manager = createAcquisitionManager({
    store,
    policy: createAcquisitionPolicyRuntime({ policy: openPolicy(), now: () => NOW }),
    provider: acquisitionProvider,
    sourceGrants: vault(),
    publisher: publisherOverride || {
      async hasAuthority () { return true },
      async publish (input) {
        publishes++
        return { publicationId: 'publication-1', manifestId: 'manifest-1', renditionId: 'rendition-1', assetId: input.asset.assetId }
      }
    },
    freeDiskBytes: () => 1024,
    now: () => NOW
  })
  return { manager, publishes: () => publishes, storeDisposed: () => disposed }
}
function manualAbortSignal () {
  const listeners = new Set()
  return {
    aborted: false,
    get listenerCount () { return listeners.size },
    addEventListener (_type, listener) { listeners.add(listener) },
    removeEventListener (_type, listener) { listeners.delete(listener) },
    emitAbort () {
      this.aborted = true
      for (const listener of [...listeners]) listener()
    }
  }
}

test('a transferred import hook reads provider-owned transfer state through its receiver', async t => {
  const receiverProvider = provider({ expectedIdentity: false, waitForGrant: true })
  // Provider-owned staging state: the only way the hook sees these values is
  // through a provider receiver, so a detached call destroys the acquisition.
  receiverProvider.stagedTransfer = { byteLength: BYTES.byteLength, descriptor: { ...TRANSFER_DESCRIPTOR } }
  receiverProvider.importAsset = async function importAsset () {
    const { stagedTransfer } = this
    return { imported: true, byteLength: stagedTransfer.byteLength, descriptor: { ...stagedTransfer.descriptor } }
  }
  const fixtureValue = fixture({ acquisitionProvider: receiverProvider })
  await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({
    idempotencyKey: 'receiver-dependent-transfer',
    request: REQUEST,
    principal: PRINCIPAL
  })
  const completed = await fixtureValue.manager.acceptTransferredResult({
    acquisitionId: queued.acquisitionId,
    sourceIdentity: TRANSFER_IDENTITY,
    asset: null
  })
  t.is(completed.state, 'completed', 'the acquisition completes on data the hook read through this')
  t.is(completed.bytesAcquired, BYTES.byteLength, 'the receiver-read byte count gates the transfer')
  t.is(fixtureValue.publishedInput().asset.key, 'a'.repeat(64), 'the publication carries the provider-owned descriptor')
  t.is(fixtureValue.publishedInput().asset.treeHash, 'b'.repeat(64))
  await fixtureValue.manager.close()
})

test('manager close aborts a stalled transferred import before disposing its store', async t => {
  const transfer = cooperativeTransferHook()
  const fixtureValue = disposedStoreFixture({ acquisitionProvider: transferringProvider(transfer.hook) })
  transfer.observeStoreClosed(fixtureValue.storeDisposed)
  t.teardown(transfer.release)
  await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({
    idempotencyKey: 'close-abort-transfer',
    request: REQUEST,
    principal: PRINCIPAL
  })
  let outcome = 'pending'
  const settled = fixtureValue.manager.acceptTransferredResult({
    acquisitionId: queued.acquisitionId,
    sourceIdentity: TRANSFER_IDENTITY,
    asset: null
  }).then(job => { outcome = job }, error => { outcome = 'rejected:' + error?.code })
  await eventually(() => transfer.state.calls, calls => calls === 1)
  await fixtureValue.manager.close()
  t.is(transfer.state.aborted, true, 'shutdown aborts the cooperative transfer')
  t.is(transfer.state.storeClosedAtAbort, false, 'the transfer settles before the store is disposed')
  await settled
  t.alike(outcome, queued, 'the interrupted transfer leaves a restartable queued job')
})

test('manager cancel aborts an in-flight transferred import and durably cancels the job', async t => {
  const transfer = cooperativeTransferHook()
  const fixtureValue = fixture({ acquisitionProvider: transferringProvider(transfer.hook) })
  t.teardown(transfer.release)
  await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({
    idempotencyKey: 'cancel-abort-transfer',
    request: REQUEST,
    principal: PRINCIPAL
  })
  const settled = fixtureValue.manager.acceptTransferredResult({
    acquisitionId: queued.acquisitionId,
    sourceIdentity: TRANSFER_IDENTITY,
    asset: null
  }).catch(error => 'rejected:' + error?.code)
  await eventually(() => transfer.state.calls, calls => calls === 1)
  const cancelled = await fixtureValue.manager.cancel({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL })
  t.is(cancelled.state, 'cancelled')
  t.is(transfer.state.aborted, true, 'cancellation aborts the cooperative transfer instead of letting it outlive the cancel')
  t.is(fixtureValue.publishes(), 0)
  await settled
})

test('a caller abort at the transfer boundary stops the import before durable admission', async t => {
  const callerSignal = manualAbortSignal()
  let imports = 0
  const importAsset = async function importAsset () {
    imports++
    callerSignal.emitAbort()
    return { imported: true, byteLength: BYTES.byteLength, descriptor: { ...TRANSFER_DESCRIPTOR } }
  }
  const fixtureValue = fixture({ acquisitionProvider: transferringProvider(importAsset) })
  await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({
    idempotencyKey: 'caller-abort-transfer',
    request: REQUEST,
    principal: PRINCIPAL
  })
  await t.exception(fixtureValue.manager.acceptTransferredResult({
    acquisitionId: queued.acquisitionId,
    sourceIdentity: TRANSFER_IDENTITY,
    asset: null,
    signal: callerSignal
  }), { code: 'ACQUISITION_CANCELLED' })
  t.is(imports, 1)
  t.is(fixtureValue.publishes(), 0, 'an aborted caller cannot publish transferred bytes')
  t.is(callerSignal.listenerCount, 0, 'the composed abort listener is removed on every outcome')
  const waiting = await fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL })
  t.is(waiting.state, 'queued', 'a pre-admission caller abort is not persisted as a durable job failure')
  await fixtureValue.manager.close()
})

test('a caller disconnect during gated verification rejects the import without terminalizing the durable job', async t => {
  const callerSignal = manualAbortSignal()
  let verifies = 0
  const acquisitionProvider = transferringProvider(async function importAsset () {
    return { imported: true, byteLength: BYTES.byteLength, descriptor: { ...TRANSFER_DESCRIPTOR } }
  })
  acquisitionProvider.verify = ({ signal }) => {
    verifies++
    if (verifies > 1) return Promise.resolve({ verified: true, byteLength: BYTES.byteLength })
    return new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('verification interrupted by a caller disconnect'), { code: 'SOURCE_VERIFY_INTERRUPTED' }))
      if (signal?.aborted) abort()
      else signal?.addEventListener?.('abort', abort, { once: true })
    })
  }
  const fixtureValue = fixture({ acquisitionProvider })
  await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({
    idempotencyKey: 'caller-abort-verifying',
    request: REQUEST,
    principal: PRINCIPAL
  })
  const settled = fixtureValue.manager.acceptTransferredResult({
    acquisitionId: queued.acquisitionId,
    sourceIdentity: TRANSFER_IDENTITY,
    asset: null,
    signal: callerSignal
  }).then(job => 'resolved:' + job.state, error => 'rejected:' + (error?.code || error?.message))
  await eventually(() => verifies, count => count === 1)
  callerSignal.emitAbort()
  t.is(await settled, 'rejected:SOURCE_VERIFY_INTERRUPTED')
  t.is(callerSignal.listenerCount, 0, 'the composed abort listener is removed on every outcome')
  const resumable = await fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL })
  t.is(resumable.state, 'verifying', 'a transport-lifetime disconnect is not a user cancellation and stays resumable')
  t.absent(resumable.errorCode)
  t.is(fixtureValue.publishes(), 0)

  const completed = await fixtureValue.manager.acceptTransferredResult({
    acquisitionId: queued.acquisitionId,
    sourceIdentity: TRANSFER_IDENTITY,
    asset: null
  })
  t.is(completed.state, 'completed')
  t.is(completed.bytesAcquired, BYTES.byteLength, 'the re-drive reuses the admitted counters without a cumulative charge')
  t.is(fixtureValue.publishes(), 1, 'abort then re-drive publishes exactly once')
  t.is(verifies, 2)
  await fixtureValue.manager.close()
})

test('a duplicate transferred import joins the owner outcome instead of reading the store after it', async t => {
  const callerSignal = manualAbortSignal()
  const transfer = cooperativeTransferHook()
  const anonymous = provider({ waitForGrant: true })
  const boundProvider = {
    ...anonymous,
    async resolve () {
      const resolution = await anonymous.resolve()
      return { ...resolution, expected: { byteLength: BYTES.byteLength, sha256: TRANSFER_IDENTITY.value } }
    },
    importAsset: transfer.hook
  }
  const fixtureValue = fixture({ acquisitionProvider: boundProvider })
  t.teardown(transfer.release)
  await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({
    idempotencyKey: 'duplicate-owner-outcome',
    request: REQUEST,
    principal: PRINCIPAL
  })
  const args = { acquisitionId: queued.acquisitionId, sourceIdentity: TRANSFER_IDENTITY, asset: null }
  const owner = fixtureValue.manager.acceptTransferredResult({ ...args, signal: callerSignal })
  await eventually(() => transfer.state.calls, calls => calls === 1)
  const joined = fixtureValue.manager.acceptTransferredResult(args)
  const substituted = await fixtureValue.manager.acceptTransferredResult({
    ...args,
    sourceIdentity: { kind: 'sha256', value: 'd'.repeat(64) }
  }).then(job => 'resolved:' + job.state, error => 'rejected:' + (error?.code || error?.message))
  t.is(substituted, 'rejected:SOURCE_IDENTITY_CHANGED', 'identity rejection still precedes joining the in-flight owner')
  callerSignal.emitAbort()
  const outcomes = await Promise.all([
    owner.then(job => 'resolved:' + job.state, error => 'rejected:' + (error?.code || error?.message)),
    joined.then(job => 'resolved:' + job.state, error => 'rejected:' + (error?.code || error?.message))
  ])
  t.alike(outcomes, ['rejected:TRANSFER_ABORTED', 'rejected:TRANSFER_ABORTED'], 'the duplicate mirrors the owner rejection instead of swallowing it')
  t.is(transfer.state.calls, 1, 'the duplicate never started a second transfer')
  t.is(fixtureValue.publishes(), 0)
  const waiting = await fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL })
  t.is(waiting.state, 'queued', 'the pre-admission owner rejection leaves the durable job resumable')
  await fixtureValue.manager.close()
})

test('concurrent duplicate transferred imports transfer, publish, and charge exactly once', async t => {
  let imports = 0
  const importAsset = async function importAsset () {
    imports++
    await new Promise(resolve => setTimeout(resolve, 5))
    return { imported: true, byteLength: BYTES.byteLength, descriptor: { ...TRANSFER_DESCRIPTOR } }
  }
  const fixtureValue = fixture({ acquisitionProvider: transferringProvider(importAsset) })
  await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({
    idempotencyKey: 'duplicate-transfer',
    request: REQUEST,
    principal: PRINCIPAL
  })
  const args = { acquisitionId: queued.acquisitionId, sourceIdentity: TRANSFER_IDENTITY, asset: null }
  const results = await Promise.allSettled([
    fixtureValue.manager.acceptTransferredResult(args),
    fixtureValue.manager.acceptTransferredResult(args)
  ])
  t.is(results[0].status, 'fulfilled', 'the owner completes: ' + (results[0].reason?.code || ''))
  t.is(results[1].status, 'fulfilled', 'the duplicate serialized on the owner instead of racing it')
  t.is(imports, 1, 'the transferred bytes are pulled exactly once')
  t.is(fixtureValue.publishes(), 1, 'the publication happens exactly once')
  t.is(results[0].value.state, 'completed')
  t.is(results[1].value.state, 'completed')
  t.is(results[0].value.bytesAcquired, BYTES.byteLength, 'one import charges the ledger once')
  await fixtureValue.manager.close()
})

test('a transferred publication that commits then throws completes through repository recovery', async t => {
  let committed = null
  let publishes = 0
  let recoveryCalls = 0
  let releaseRecovery
  const recoveryGate = new Promise(resolve => { releaseRecovery = resolve })
  t.teardown(() => releaseRecovery())
  const publisher = {
    async hasAuthority () { return true },
    async publish (input) {
      publishes++
      committed = {
        publicationId: 'publication-transfer-recovered',
        manifestId: 'manifest-transfer-recovered',
        renditionId: 'rendition-transfer-recovered',
        assetId: input.asset.assetId
      }
      throw new Error('repository write failed after the transferred publication commit')
    },
    async getPublication () {
      recoveryCalls++
      await recoveryGate
      return committed
    }
  }
  const fixtureValue = fixture({
    acquisitionProvider: transferringProvider(async function importAsset () {
      return { imported: true, byteLength: BYTES.byteLength, descriptor: { ...TRANSFER_DESCRIPTOR } }
    }),
    publisher
  })
  await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({
    idempotencyKey: 'transfer-publish-then-throw',
    request: REQUEST,
    principal: PRINCIPAL
  })
  const original = fixtureValue.manager.acceptTransferredResult({
    acquisitionId: queued.acquisitionId,
    sourceIdentity: TRANSFER_IDENTITY,
    asset: null
  })
  await eventually(() => recoveryCalls, calls => calls === 1)
  const parked = await fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL })
  t.is(parked.state, 'publishing', 'the committed publication parks the durable job while the gated recovery reads it')
  let shutdownState = 'pending'
  const shutdown = fixtureValue.manager.close().then(() => { shutdownState = 'closed' }, error => { shutdownState = 'failed:' + (error?.code || error?.message) })
  await new Promise(resolve => setTimeout(resolve, 0))
  t.is(shutdownState, 'pending', 'close cannot dispose the store while the active transfer still awaits publication recovery')
  t.is(publishes, 1, 'no re-publish attempt was made while recovery was in flight')
  releaseRecovery()
  const completed = await original
  t.is(completed.state, 'completed')
  t.is(completed.publicationId, 'publication-transfer-recovered')
  t.is(publishes, 1, 'recovery completes the committed publication without publishing again')
  t.is(recoveryCalls, 1, 'the original transfer drains through exactly one recovery read of the committed publication')
  await shutdown
  t.is(shutdownState, 'closed', 'shutdown drains after the awaited recovery finishes, not before')
})

test('manager close re-entered synchronously from the import hook drains the real active entry promise', async t => {
  let managerHandle = null
  let shutdown
  const importAsset = function importAsset () {
    // Re-enter shutdown during the synchronous scheduling window of this very
    // transfer: the active entry must already carry its real drain promise, and
    // close is captured with handlers immediately so a rejection surfaces as an
    // observable outcome instead of an unhandled crash.
    shutdown = managerHandle.close().then(() => 'closed', error => 'rejected:' + (error?.code || error?.message))
    return { imported: true, byteLength: BYTES.byteLength, descriptor: { ...TRANSFER_DESCRIPTOR } }
  }
  const fixtureValue = fixture({ acquisitionProvider: transferringProvider(importAsset) })
  managerHandle = fixtureValue.manager
  t.teardown(() => fixtureValue.manager.close())
  await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({
    idempotencyKey: 'sync-close-reentry',
    request: REQUEST,
    principal: PRINCIPAL
  })
  const outcome = await fixtureValue.manager.acceptTransferredResult({
    acquisitionId: queued.acquisitionId,
    sourceIdentity: TRANSFER_IDENTITY,
    asset: null
  })
  t.is(await shutdown, 'closed', 'synchronous shutdown re-entry drains the active import instead of failing on a missing entry promise')
  t.is(fixtureValue.publishes(), 0, 'the shutdown-interrupted import never publishes')
  t.alike(outcome, queued, 'the durable job stays queued and restartable after the interrupted transfer')
})

async function seededPublishingFixture (t, { publisher, imports }) {
  const importAsset = async function importAsset () {
    imports.calls++
    throw new Error('a publishing job must attempt durable recovery before transferring again')
  }
  const bee = fakeBee()
  const store = createAcquisitionStore({ bee, now: () => NOW })
  const job = {
    schemaVersion: 1,
    acquisitionId: 'acq_publishing_transfer',
    state: 'publishing',
    version: 4,
    principalId: 'local-user',
    publisherId: 'publisher-1',
    requesterPublisherIds: ['publisher-1'],
    isRemote: false,
    deferredInput: true,
    idempotencyDigest: 'h'.repeat(64),
    requestFingerprint: 'i'.repeat(64),
    request: REQUEST,
    retentionClass: 'archive-pin',
    publicationMetadata: null,
    expectedBytes: BYTES.byteLength,
    expectedIdentity: null,
    sourceBytesRead: BYTES.byteLength,
    sourceBytesAccepted: BYTES.byteLength,
    bytesAcquired: BYTES.byteLength,
    verifiedBytes: BYTES.byteLength,
    committedBytes: 0,
    retainedBytes: 0,
    stagingBytes: 0,
    stagingPeakBytes: 0,
    attempts: 1,
    startedAt: NOW,
    finishedAt: null,
    verifiedPrefix: { byteLength: BYTES.byteLength, identity: { kind: 'sha256', value: 'c'.repeat(64) } },
    verifiedAsset: { ...TRANSFER_DESCRIPTOR },
    publication: null,
    errorCode: null,
    recoverable: false,
    createdAt: NOW,
    updatedAt: NOW
  }
  const batch = bee.batch()
  await batch.put('acquisition/v1/job/acq_publishing_transfer', job)
  await batch.put('acquisition/v1/active/acq_publishing_transfer', { acquisitionId: 'acq_publishing_transfer' })
  await batch.flush()
  const manager = createAcquisitionManager({
    store,
    policy: createAcquisitionPolicyRuntime({ policy: openPolicy(), now: () => NOW }),
    provider: transferringProvider(importAsset),
    sourceGrants: vault(),
    publisher,
    freeDiskBytes: () => 1024,
    now: () => NOW
  })
  t.teardown(() => manager.close())
  return manager
}

test('a supplied publishing job completes from the committed publication repository without re-transfer', async t => {
  const imports = { calls: 0 }
  const manager = await seededPublishingFixture(t, {
    imports,
    publisher: {
      async hasAuthority () { return true },
      async publish () { throw new Error('must not publish twice') },
      async getPublication () {
        return {
          publicationId: 'publication-preexisting',
          manifestId: 'manifest-preexisting',
          renditionId: 'rendition-preexisting',
          assetId: TRANSFER_DESCRIPTOR.assetId
        }
      }
    }
  })
  const completed = await manager.acceptTransferredResult({
    acquisitionId: 'acq_publishing_transfer',
    sourceIdentity: TRANSFER_IDENTITY,
    asset: { ...TRANSFER_DESCRIPTOR }
  })
  t.is(completed.state, 'completed')
  t.is(completed.publicationId, 'publication-preexisting')
  t.is(imports.calls, 0, 'durable recovery is attempted before transferring any bytes again')
})

test('a supplied publishing job without a committed publication fails recoverably without re-transfer', async t => {
  const imports = { calls: 0 }
  const manager = await seededPublishingFixture(t, {
    imports,
    publisher: {
      async hasAuthority () { return true },
      async publish () { throw new Error('must not publish without authority to re-transfer') },
      async getPublication () { return null }
    }
  })
  const failed = await manager.acceptTransferredResult({
    acquisitionId: 'acq_publishing_transfer',
    sourceIdentity: TRANSFER_IDENTITY,
    asset: { ...TRANSFER_DESCRIPTOR }
  })
  t.is(failed.state, 'failed')
  t.is(failed.errorCode, 'PUBLICATION_RECOVERY_REQUIRED')
  t.is(failed.recoverable, true, 'the recovery contract stays retryable instead of wedging publishing')
  t.is(imports.calls, 0, 'an uncommitted publishing job never illegally transfers again')
})
