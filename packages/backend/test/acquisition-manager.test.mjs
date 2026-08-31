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
function fixture ({ acquisitionProvider = provider(), authority = () => true } = {}) {
  let publishes = 0
  let publishedInput = null
  const manager = createAcquisitionManager({
    store: createAcquisitionStore({ bee: fakeBee(), now: () => NOW }),
    policy: createAcquisitionPolicyRuntime({ policy: openPolicy(), now: () => NOW }),
    provider: acquisitionProvider,
    sourceGrants: vault(),
    publisher: {
      async hasAuthority () { return authority() },
      async publish (input) { publishedInput = input; publishes++; return { publicationId: 'publication-1', manifestId: 'manifest-1', renditionId: 'rendition-1', assetId: input.asset.assetId } }
    },
    freeDiskBytes: () => 1024,
    now: () => NOW
  })
  return { manager, publishes: () => publishes, publishedInput: () => publishedInput }
}

test('manager publishes only after exact verification and records every transition', async t => {
  const fixtureValue = fixture(); await fixtureValue.manager.start()
  const queued = await fixtureValue.manager.request({ idempotencyKey: 'request-1', request: REQUEST, principal: PRINCIPAL })
  const completed = await eventually(() => fixtureValue.manager.get({ acquisitionId: queued.acquisitionId, principal: PRINCIPAL }), job => job.state === 'completed')
  t.is(completed.bytesAcquired, BYTES.byteLength); t.is(completed.assetId, 'asset-1'); t.is(fixtureValue.publishes(), 1)
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
  const queued = await manager.acceptRemoteRequest({ idempotencyKey: 'remote-request-1', request: REQUEST, principal })
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
