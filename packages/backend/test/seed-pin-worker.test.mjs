import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import b4a from 'b4a'
import c from 'compact-encoding'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import test from 'brittle'

import { createDurableManifest } from '../src/seed-pin/manifest.js'
import { SEED_PIN_ERROR_CODES } from '../src/seed-pin/protocol.js'
import {
  MAX_RESUMABLE_SEED_PINS,
  PinStore,
  createPinStore,
} from '../src/seed-pin/pin-store.js'
import {
  PinWorker,
  PinWorkerError,
  createPinWorker,
} from '../src/seed-pin/pin-worker.js'

const OWNER = Object.freeze({
  identityPublicKey: '11'.repeat(32),
  devicePublicKey: '22'.repeat(32),
})
const OTHER_OWNER = Object.freeze({
  identityPublicKey: '33'.repeat(32),
  devicePublicKey: '44'.repeat(32),
})
const CHANNEL_KEY = '55'.repeat(32)
const MEDIA_KEY = '66'.repeat(32)
const OTHER_MEDIA_KEY = '77'.repeat(32)
const START = 1_900_000_000_000

function makeTempDir (prefix = 'peartube-seed-pin-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function openMetadata (dir) {
  const corestore = new Corestore(dir)
  await corestore.ready()
  const core = corestore.get({ name: 'metadata' })
  const db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await db.ready()
  return { corestore, db }
}

async function closeMetadata (resources) {
  if (!resources) return
  await resources.db.close().catch(() => {})
  await resources.corestore.close().catch(() => {})
}

function manifestFor (rowId, refs = [{ coreKey: MEDIA_KEY, start: 0, end: 3, kind: 'media' }]) {
  return createDurableManifest({
    channelKey: CHANNEL_KEY,
    rowId,
    refs,
    assets: {
      media: refs.map((_, index) => index),
      thumbnail: null,
      artwork: { avatar: null, poster: null, banner: null, backdrop: null },
    },
  })
}

function requestFor (rowId, refs) {
  const manifest = manifestFor(rowId, refs)
  return {
    version: 1,
    manifest,
    requestId: manifest.requestId,
    expiresAt: START + 60_000,
    signedDescriptor: {
      schema: 'peartube/channel-root-signature/v1',
      descriptor: { channelId: CHANNEL_KEY, displayName: 'never persist me' },
      proof: 'aa'.repeat(32),
      attestation: 'bb'.repeat(32),
    },
    attestation: 'cc'.repeat(32),
  }
}

function claimInput (request, overrides = {}) {
  return {
    request,
    owner: OWNER,
    authorizationDigest: request.requestId,
    acceptedAt: START,
    claimedAt: START,
    ...overrides,
  }
}

async function acceptRequest (store, request, overrides = {}) {
  const claimed = await store.claimVerified(claimInput(request, overrides))
  assert.equal(claimed.outcome, 'claimed')
  const finalized = await store.finalizeAdmission({
    requestId: request.requestId,
    authorizationDigest: overrides.authorizationDigest || request.requestId,
    claimToken: claimed.claimToken,
    decision: {
      state: 'accepted',
      code: null,
      error: null,
      updatedAt: overrides.updatedAt || START + 1,
    },
  })
  assert.equal(finalized.outcome, 'finalized')
  return finalized.record
}

function requestKey (requestId) {
  return `seed-pin/v1/request/${requestId}`
}

function channelKey (manifest) {
  return `seed-pin/v1/channel/${manifest.channelKey}/${manifest.requestId}`
}

function activeKey (requestId) {
  return `seed-pin/v1/active/${requestId}`
}

async function rawValue (db, key) {
  const node = await db.get(key, { keyEncoding: 'utf-8', valueEncoding: c.raw })
  return node?.value || null
}

async function waitFor (predicate, message, timeout = 1_000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

class FakeDownload {
  constructor (done) {
    this.destroyed = 0
    this._reject = null
    this._done = new Promise((resolve, reject) => {
      this._reject = reject
      Promise.resolve().then(done).then(resolve, reject)
    })
  }

  done () {
    return this._done
  }

  destroy () {
    if (this.destroyed++) return
    this._reject(Object.assign(new Error('download cancelled'), { code: 'REQUEST_CANCELLED' }))
  }
}

class FakeCore {
  constructor (key, blocks, options = {}) {
    this.key = key
    this.blocks = blocks.map(block => b4a.from(block))
    this.length = options.length ?? this.blocks.length
    this.local = new Set(options.local || [])
    this.downloadCalls = []
    this.readyError = options.readyError || null
    this.readyGate = options.readyGate || null
    this.onReadyStart = options.onReadyStart || null
    this.hasGate = options.hasGate || null
    this.onHasStart = options.onHasStart || null
    this.getGate = options.getGate || null
    this.onGetStart = options.onGetStart || null
    this.downloadError = options.downloadError || null
    this.localize = options.localize !== false
    this.gate = options.gate || null
    this.onDownloadStart = options.onDownloadStart || null
    this.byteRangeUnavailable = options.byteRangeUnavailable === true
    this.onDownloadEnd = options.onDownloadEnd || null
    this.downloads = []
  }

  async ready () {
    this.onReadyStart?.()
    if (this.readyGate) await this.readyGate.promise
    if (this.readyError) throw this.readyError
  }

  async update () {}

  async has (start, end) {
    this.onHasStart?.(start, end)
    if (this.hasGate) await this.hasGate.promise
    if (end === undefined) return this.local.has(start)
    for (let index = start; index < end; index++) {
      if (!this.local.has(index)) return false
    }
    return true
  }

  async get (index, options = {}) {
    this.onGetStart?.(index, options)
    if (this.getGate) await this.getGate.promise
    if (!this.local.has(index) && options.wait === false) return null
    return this.local.has(index) ? this.blocks[index] : null
  }

  async byteRange (start, end) {
    if (this.byteRangeUnavailable) throw new Error('tree byte metadata unavailable')
    let byteLength = 0
    for (let index = start; index < end; index++) byteLength += this.blocks[index].byteLength
    return { byteLength }
  }

  download (range) {
    this.downloadCalls.push({ ...range })
    this.onDownloadStart?.()
    const download = new FakeDownload(async () => {
      try {
        if (this.gate) await this.gate.promise
        if (this.downloadError) throw this.downloadError
        if (this.localize) {
          for (let index = range.start; index < range.end; index++) this.local.add(index)
        }
      } finally {
        this.onDownloadEnd?.()
      }
    })
    this.downloads.push(download)
    return download
  }
}

function deferred () {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class FakeCorestore {
  constructor (cores, options = {}) {
    this.cores = new Map(cores.map(core => [core.key, core]))
    this.sessions = []
    this.openError = options.openError || null
  }

  session () {
    const parent = this
    const session = {
      closed: 0,
      get ({ key }) {
        if (parent.openError) throw parent.openError
        const core = parent.cores.get(b4a.toString(key, 'hex'))
        if (!core) throw new Error('unknown core')
        return core
      },
      async close () {
        session.closed++
      },
    }
    this.sessions.push(session)
    return session
  }
}

async function createStoreHarness (t, options = {}) {
  const dir = makeTempDir()
  const resources = await openMetadata(dir)
  const store = createPinStore({ db: resources.db, ...options })
  t.teardown(async () => {
    await closeMetadata(resources)
    rmSync(dir, { recursive: true, force: true })
  })
  return { ...resources, store, dir }
}

test('PinStore factories validate and construct the documented API', async (t) => {
  const harness = await createStoreHarness(t)
  assert.ok(harness.store instanceof PinStore)
  assert.ok(createPinStore({ db: harness.db }) instanceof PinStore)
  assert.throws(() => new PinStore({}), /db/)
  assert.throws(() => new PinStore({ db: harness.db, leaseDuration: 0 }), /leaseDuration/)
  assert.throws(() => new PinStore({ db: harness.db, maxResumable: MAX_RESUMABLE_SEED_PINS + 1 }), /maxResumable/)
})

test('PinStore persists binary versioned records and strips authorization secrets and aliases', async (t) => {
  const { store, db } = await createStoreHarness(t)
  const request = requestFor('store/no-secrets')
  await acceptRequest(store, request)

  const primary = await rawValue(db, requestKey(request.requestId))
  const secondary = await rawValue(db, channelKey(request.manifest))
  assert.ok(primary instanceof Uint8Array)
  assert.deepEqual(primary, secondary)
  assert.equal(primary[0], 0x50)
  assert.equal(primary[1], 0x53)
  const serialized = b4a.toString(primary)
  assert.equal(serialized.includes('never persist me'), false)
  assert.equal(serialized.includes(request.signedDescriptor.proof), false)
  assert.equal(serialized.includes(request.signedDescriptor.attestation), false)
  assert.equal(serialized.includes(request.attestation), false)

  const record = await store.getByRequestId(request.requestId)
  assert.deepEqual(Object.keys(record.manifest), ['version', 'channelKey', 'rowId', 'refs', 'assets', 'requestId'])
  assert.equal('request' in record, false)
  assert.equal('signedDescriptor' in record, false)
  assert.equal('attestation' in record, false)
})

test('PinStore records survive real Corestore and Hyperbee close/reopen', async () => {
  const dir = makeTempDir('peartube-seed-pin-reopen-')
  let resources = await openMetadata(dir)
  const request = requestFor('store/reopen')
  try {
    const store = new PinStore({ db: resources.db })
    await acceptRequest(store, request)
    await closeMetadata(resources)
    resources = await openMetadata(dir)
    const reopened = new PinStore({ db: resources.db })
    const record = await reopened.getByRequestId(request.requestId)
    assert.equal(record.requestId, request.requestId)
    assert.equal(record.status.state, 'accepted')
    assert.equal(record.owner.identityPublicKey, OWNER.identityPublicKey)
    assert.equal(record.manifest.rowId, 'store/reopen')
  } finally {
    await closeMetadata(resources)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent wrappers atomically claim exact replay once and conflict on owner, digest, or body', async (t) => {
  const { db } = await createStoreHarness(t)
  const left = new PinStore({ db })
  const right = new PinStore({ db })
  const request = requestFor('store/race')
  const results = await Promise.all([
    left.claimVerified(claimInput(request)),
    right.claimVerified(claimInput(request)),
  ])
  assert.deepEqual(results.map(result => result.outcome).sort(), ['claimed', 'matched'])
  assert.equal(results.filter(result => result.claimToken !== null).length, 1)

  const changedBody = { ...request, expiresAt: request.expiresAt + 1 }
  const conflicts = await Promise.all([
    left.claimVerified(claimInput(request, { owner: OTHER_OWNER })),
    right.claimVerified(claimInput(request, { authorizationDigest: '99'.repeat(32) })),
    left.claimVerified(claimInput(changedBody)),
  ])
  assert.deepEqual(conflicts.map(result => result.outcome), ['conflict', 'conflict', 'conflict'])
  assert.ok(conflicts.every(result => result.claimToken === null))
})

test('distinct Hyperbee sessions over one metadata feed serialize exact claim races', async (t) => {
  const { db } = await createStoreHarness(t)
  const siblingCore = db.core.session()
  const siblingDb = new Hyperbee(siblingCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await siblingDb.ready()
  t.teardown(() => siblingDb.close())
  assert.notEqual(siblingDb.core, db.core)
  assert.deepEqual(siblingDb.core.key, db.core.key)

  const request = requestFor('store/distinct-feed-wrappers')
  const firstRead = deferred()
  const releaseFirst = deferred()
  const originalGet = db.get.bind(db)
  db.get = async (...args) => {
    const node = await originalGet(...args)
    if (args[0] === requestKey(request.requestId)) {
      firstRead.resolve()
      await releaseFirst.promise
    }
    return node
  }
  const left = new PinStore({ db })
  const right = new PinStore({ db: siblingDb })
  const first = left.claimVerified(claimInput(request))
  await firstRead.promise
  const second = right.claimVerified(claimInput(request))
  await new Promise(resolve => setTimeout(resolve, 20))
  releaseFirst.resolve()
  const results = await Promise.all([first, second])

  assert.deepEqual(results.map(result => result.outcome), ['claimed', 'matched'])
  const persisted = await right.getByRequestId(request.requestId)
  assert.equal(persisted.claimToken, results[0].claimToken)
})

test('finite float descriptor values digest deterministically across reopen and body changes conflict', async () => {
  const dir = makeTempDir('peartube-seed-pin-float-')
  let resources = await openMetadata(dir)
  const request = requestFor('store/float-body')
  request.signedDescriptor.descriptor.score = 1.5
  request.signedDescriptor.descriptor.signedZero = -0
  const firstStore = new PinStore({ db: resources.db })
  const claimed = await firstStore.claimVerified(claimInput(request))
  assert.equal(claimed.outcome, 'claimed')
  await closeMetadata(resources)

  resources = await openMetadata(dir)
  try {
    const reopened = new PinStore({ db: resources.db })
    const equivalent = structuredClone(request)
    equivalent.signedDescriptor.descriptor.signedZero = 0
    assert.equal((await reopened.claimVerified(claimInput(equivalent))).outcome, 'matched')
    const changed = structuredClone(equivalent)
    changed.signedDescriptor.descriptor.score = 2.5
    assert.equal((await reopened.claimVerified(claimInput(changed))).outcome, 'conflict')
    const invalid = structuredClone(equivalent)
    invalid.signedDescriptor.descriptor.score = Number.NaN
    await assert.rejects(() => reopened.claimVerified(claimInput(invalid)), /finite/i)
  } finally {
    await closeMetadata(resources)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('leases reclaim strictly at expiry and stale, wrong, and swapped finalizers conflict', async (t) => {
  const { db } = await createStoreHarness(t)
  const storeA = new PinStore({ db, leaseDuration: 10 })
  const storeB = new PinStore({ db, leaseDuration: 10 })
  const firstRequest = requestFor('store/lease-a')
  const secondRequest = requestFor('store/lease-b', [{ coreKey: OTHER_MEDIA_KEY, start: 0, end: 1, kind: 'media' }])

  const first = await storeA.claimVerified(claimInput(firstRequest))
  const beforeExpiry = await storeB.claimVerified(claimInput(firstRequest, { claimedAt: START + 9 }))
  assert.equal(beforeExpiry.outcome, 'matched')
  const reclaimed = await storeB.claimVerified(claimInput(firstRequest, { claimedAt: START + 10 }))
  assert.equal(reclaimed.outcome, 'claimed')
  assert.notEqual(reclaimed.claimToken, first.claimToken)
  assert.equal(reclaimed.record.claimExpiresAt, START + 20)

  const second = await storeA.claimVerified(claimInput(secondRequest, {
    authorizationDigest: '88'.repeat(32),
    claimedAt: START + 10,
  }))
  const decision = { state: 'accepted', code: null, error: null, updatedAt: START + 11 }
  assert.equal((await storeA.finalizeAdmission({
    requestId: firstRequest.requestId,
    authorizationDigest: firstRequest.requestId,
    claimToken: first.claimToken,
    decision,
  })).outcome, 'conflict')
  assert.equal((await storeA.finalizeAdmission({
    requestId: firstRequest.requestId,
    authorizationDigest: firstRequest.requestId,
    claimToken: '00'.repeat(32),
    decision,
  })).outcome, 'conflict')
  assert.equal((await storeA.finalizeAdmission({
    requestId: firstRequest.requestId,
    authorizationDigest: firstRequest.requestId,
    claimToken: second.claimToken,
    decision,
  })).outcome, 'conflict')
  assert.equal((await storeB.finalizeAdmission({
    requestId: firstRequest.requestId,
    authorizationDigest: firstRequest.requestId,
    claimToken: reclaimed.claimToken,
    decision,
  })).outcome, 'finalized')
})

test('retryable admission is reclaimable and decision/status shapes match SeedPinServer', async (t) => {
  const { store } = await createStoreHarness(t, { leaseDuration: 1_000 })
  const request = requestFor('store/retry-admission')
  const claim = await store.claimVerified(claimInput(request))
  const retryable = await store.finalizeAdmission({
    requestId: request.requestId,
    authorizationDigest: request.requestId,
    claimToken: claim.claimToken,
    decision: {
      state: 'retryable-admission',
      code: SEED_PIN_ERROR_CODES.CAPACITY_EXCEEDED,
      error: null,
      updatedAt: START + 1,
    },
  })
  assert.equal(retryable.record.status.state, 'retryable-admission')
  assert.equal(retryable.record.status.errorCode, SEED_PIN_ERROR_CODES.CAPACITY_EXCEEDED)
  const reclaimed = await store.claimVerified(claimInput(request, { claimedAt: START + 2 }))
  assert.equal(reclaimed.outcome, 'claimed')
  assert.notEqual(reclaimed.claimToken, claim.claimToken)
})

test('channel index changes in the same batch and malformed persisted records fail closed', async (t) => {
  const { store, db } = await createStoreHarness(t)
  const request = requestFor('store/index')
  const record = await acceptRequest(store, request)
  assert.deepEqual(await rawValue(db, requestKey(request.requestId)), await rawValue(db, channelKey(request.manifest)))

  await store.updateWorkerStatus({
    requestId: request.requestId,
    state: 'pinning',
    refs: record.status.refs,
    errorCode: null,
    error: null,
    completedAt: null,
    downloadedBlocks: 0,
    downloadedBytes: 0,
    updatedAt: START + 2,
  })
  assert.deepEqual(await rawValue(db, requestKey(request.requestId)), await rawValue(db, channelKey(request.manifest)))

  await db.put(requestKey(request.requestId), b4a.from('not-a-seed-pin-record'), {
    keyEncoding: 'utf-8',
    valueEncoding: c.raw,
  })
  await assert.rejects(() => store.getByRequestId(request.requestId), /malformed|version|record/i)
  await assert.rejects(() => store.claimVerified(claimInput(request)), /malformed|version|record/i)
})

test('oversized records fail before parse and expose a cursor past corrupt active entries', async (t) => {
  const { store, db } = await createStoreHarness(t)
  const request = requestFor('store/after-corrupt-index')
  await acceptRequest(store, request)
  const corruptId = '00'.repeat(32)
  const oversized = b4a.alloc(512 * 1024 + 1, 0x20)
  await db.put(requestKey(corruptId), oversized, { keyEncoding: 'utf-8', valueEncoding: c.raw })
  await db.put(activeKey(corruptId), oversized, { keyEncoding: 'utf-8', valueEncoding: c.raw })

  await assert.rejects(() => store.getByRequestId(corruptId), /record.*large/i)
  const corruptPage = await store.listActive({ limit: 2 })
  assert.match(corruptPage.error?.message || '', /record.*large/i)
  assert.equal(corruptPage.cursor, corruptId)
  assert.deepEqual(corruptPage.records, [])
  const later = await store.listActive({ limit: 2, cursor: corruptPage.cursor })
  assert.deepEqual(later.records.map(record => record.requestId), [request.requestId])
})

test('owned status is exact, detached, bounded, and timestamps/progress never regress', async (t) => {
  const { store } = await createStoreHarness(t, { now: () => START - 50 })
  const request = requestFor('store/status')
  const initial = await acceptRequest(store, request, { updatedAt: START - 100 })
  assert.equal(initial.status.acceptedAt, START)
  assert.equal(initial.status.updatedAt, START)
  assert.equal(await store.getOwnedStatus({ requestId: request.requestId, ...OTHER_OWNER }), null)

  const refs = initial.status.refs.map(ref => ({ ...ref, state: 'pinning', bytesPinned: 12 }))
  const progressed = await store.updateWorkerStatus({
    requestId: request.requestId,
    state: 'pinning',
    refs,
    errorCode: null,
    error: null,
    completedAt: null,
    downloadedBlocks: 2,
    downloadedBytes: 12,
    updatedAt: START - 1,
  })
  assert.equal(progressed.status.updatedAt, START)
  const regressed = await store.updateWorkerStatus({
    requestId: request.requestId,
    state: 'pinning',
    refs: initial.status.refs,
    errorCode: null,
    error: null,
    completedAt: null,
    downloadedBlocks: 0,
    downloadedBytes: 0,
    updatedAt: START - 2,
  })
  assert.equal(regressed.progress.downloadedBlocks, 2)
  assert.equal(regressed.progress.downloadedBytes, 12)
  assert.equal(regressed.status.refs[0].bytesPinned, 12)

  const status = await store.getOwnedStatus({ requestId: request.requestId, ...OWNER })
  status.refs[0].bytesPinned = 999
  assert.equal((await store.getOwnedStatus({ requestId: request.requestId, ...OWNER })).refs[0].bytesPinned, 12)
  assert.deepEqual(Object.keys(status), [
    'requestId', 'state', 'acceptedAt', 'updatedAt', 'completedAt', 'errorCode', 'error', 'refs',
  ])
})

test('failed, complete, cancelled, and rejected transitions cannot regress generically', async (t) => {
  const { store } = await createStoreHarness(t)
  const request = requestFor('store/explicit-transitions')
  const accepted = await acceptRequest(store, request)
  const failed = await store.updateWorkerStatus({
    requestId: request.requestId,
    state: 'failed',
    refs: accepted.status.refs,
    errorCode: SEED_PIN_ERROR_CODES.WORKER_UNAVAILABLE,
    error: 'download',
    completedAt: null,
    downloadedBlocks: 0,
    downloadedBytes: 0,
    updatedAt: START + 2,
  })
  const ignoredRetry = await store.updateWorkerStatus({
    requestId: request.requestId,
    state: 'pinning',
    refs: failed.status.refs,
    errorCode: null,
    error: null,
    completedAt: null,
    downloadedBlocks: 0,
    downloadedBytes: 0,
    updatedAt: START + 3,
  })
  assert.equal(ignoredRetry.status.state, 'failed')

  const cancelled = await store.updateWorkerStatus({
    requestId: request.requestId,
    state: 'cancelled',
    refs: failed.status.refs,
    errorCode: null,
    error: null,
    completedAt: null,
    downloadedBlocks: 0,
    downloadedBytes: 0,
    updatedAt: START + 4,
  })
  const ignoredComplete = await store.updateWorkerStatus({
    requestId: request.requestId,
    state: 'complete',
    refs: cancelled.status.refs,
    errorCode: null,
    error: null,
    completedAt: START + 5,
    downloadedBlocks: 3,
    downloadedBytes: 3,
    updatedAt: START + 5,
  })
  assert.equal(ignoredComplete.status.state, 'cancelled')

  const rejectedRequest = requestFor('store/rejected-terminal')
  const claim = await store.claimVerified(claimInput(rejectedRequest))
  await store.finalizeAdmission({
    requestId: rejectedRequest.requestId,
    authorizationDigest: rejectedRequest.requestId,
    claimToken: claim.claimToken,
    decision: {
      state: 'rejected',
      code: SEED_PIN_ERROR_CODES.POLICY_REJECTED,
      error: null,
      updatedAt: START + 1,
    },
  })
  await assert.rejects(() => store.updateWorkerStatus({
    requestId: rejectedRequest.requestId,
    state: 'pinning',
    refs: claim.record.status.refs,
    errorCode: null,
    error: null,
    completedAt: null,
    downloadedBlocks: 0,
    downloadedBytes: 0,
    updatedAt: START + 2,
  }), /not admitted.*rejected/i)
})

test('listResumable returns only a bounded deterministic accepted/pinning/retryable set', async (t) => {
  const { store } = await createStoreHarness(t, { maxResumable: 2 })
  const requests = [0, 1, 2].map(index => requestFor(`store/resume-${index}`))
  for (const request of requests) await acceptRequest(store, request)
  await store.updateWorkerStatus({
    requestId: requests[1].requestId,
    state: 'retryable',
    refs: (await store.getByRequestId(requests[1].requestId)).status.refs,
    errorCode: SEED_PIN_ERROR_CODES.WORKER_UNAVAILABLE,
    error: 'download',
    completedAt: null,
    downloadedBlocks: 0,
    downloadedBytes: 0,
    updatedAt: START + 2,
  })
  await store.updateWorkerStatus({
    requestId: requests[2].requestId,
    state: 'failed',
    refs: (await store.getByRequestId(requests[2].requestId)).status.refs,
    errorCode: SEED_PIN_ERROR_CODES.INTERNAL,
    error: 'corrupt',
    completedAt: null,
    downloadedBlocks: 0,
    downloadedBytes: 0,
    updatedAt: START + 2,
  })
  const resumable = await store.listResumable({ limit: 99 })
  assert.equal(resumable.length, 2)
  assert.deepEqual(resumable.map(record => record.requestId), resumable.map(record => record.requestId).sort())
  assert.ok(resumable.every(record => ['accepted', 'pinning', 'retryable'].includes(record.status.state)))
})

test('terminal history cannot hide a later resumable request behind the bounded scan', async (t) => {
  const { store } = await createStoreHarness(t)
  const requests = Array.from({ length: MAX_RESUMABLE_SEED_PINS + 1 }, (_, index) =>
    requestFor(`store/history-${index}`))
  const survivor = [...requests].sort((left, right) =>
    left.requestId.localeCompare(right.requestId)).at(-1)
  for (const request of requests) {
    const claim = await store.claimVerified(claimInput(request))
    const accepted = request.requestId === survivor.requestId
    await store.finalizeAdmission({
      requestId: request.requestId,
      authorizationDigest: request.requestId,
      claimToken: claim.claimToken,
      decision: {
        state: accepted ? 'accepted' : 'rejected',
        code: accepted ? null : SEED_PIN_ERROR_CODES.POLICY_REJECTED,
        error: null,
        updatedAt: START + 1,
      },
    })
  }
  const resumable = await store.listResumable({ limit: 1 })
  assert.deepEqual(resumable.map(record => record.requestId), [survivor.requestId])
})

test('PinWorker factory uses real Corestore cores, requests exact ranges, verifies local blocks, and counts actual bytes', async (t) => {
  const harness = await createStoreHarness(t)
  const media = harness.corestore.get({ name: 'seed-pin-media' })
  await media.ready()
  await media.append([b4a.from('a'), b4a.from('bb'), b4a.from('ccc')])
  const coreKey = b4a.toString(media.key, 'hex')
  const request = requestFor('worker/real', [{ coreKey, start: 0, end: 3, kind: 'media' }])
  await acceptRequest(harness.store, request)

  const calls = []
  let sessionCloses = 0
  const instrumentedCorestore = {
    session () {
      const session = harness.corestore.session()
      return {
        get (options) {
          const core = session.get(options)
          return new Proxy(core, {
            get (target, property) {
              if (property === 'download') {
                return (range) => {
                  calls.push({ ...range })
                  return target.download(range)
                }
              }
              const value = target[property]
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        },
        async close () {
          sessionCloses++
          await session.close()
        },
      }
    },
  }
  const worker = createPinWorker({
    corestore: instrumentedCorestore,
    pinStore: harness.store,
    concurrency: 1,
    downloadTimeout: 1_000,
  })
  assert.ok(worker instanceof PinWorker)
  t.teardown(() => worker.stop())
  await worker.start(request.requestId)
  await worker.waitForIdle()

  assert.deepEqual(calls, [{ start: 0, end: 3, linear: true }])
  const record = await harness.store.getByRequestId(request.requestId)
  assert.equal(record.status.state, 'complete')
  assert.equal(record.status.refs[0].bytesPinned, 6)
  assert.equal(record.progress.downloadedBlocks, 3)
  assert.equal(record.progress.downloadedBytes, 6)
  assert.equal(sessionCloses, 0, 'complete pins remain retained until stop/release')
})

test('complete pins survive Corestore reopen and resume reopens/verifies retention without redownload', async () => {
  const dir = makeTempDir('peartube-seed-pin-complete-reopen-')
  let resources = null
  let firstWorker = null
  let resumedWorker = null
  try {
    resources = await openMetadata(dir)
    const media = resources.corestore.get({ name: 'complete-reopen-media' })
    await media.ready()
    await media.append([b4a.from('one'), b4a.from('two')])
    const coreKey = b4a.toString(media.key, 'hex')
    const request = requestFor('worker/complete-reopen', [
      { coreKey, start: 0, end: 2, kind: 'media' },
    ])
    const firstStore = new PinStore({ db: resources.db })
    await acceptRequest(firstStore, request)
    firstWorker = new PinWorker({ corestore: resources.corestore, pinStore: firstStore })
    await firstWorker.start(request.requestId)
    await firstWorker.waitForIdle()
    assert.equal((await firstStore.getByRequestId(request.requestId)).status.state, 'complete')
    await firstWorker.stop()
    firstWorker = null
    await closeMetadata(resources)
    resources = null

    resources = await openMetadata(dir)
    const reopenedStore = new PinStore({ db: resources.db })
    const downloadCalls = []
    const retainedCorestore = {
      session () {
        const session = resources.corestore.session()
        return {
          get (options) {
            const core = session.get(options)
            return new Proxy(core, {
              get (target, property) {
                if (property === 'download') {
                  return (range) => {
                    downloadCalls.push({ ...range })
                    return target.download(range)
                  }
                }
                const value = target[property]
                return typeof value === 'function' ? value.bind(target) : value
              },
            })
          },
          close: () => session.close(),
        }
      },
    }
    resumedWorker = new PinWorker({ corestore: retainedCorestore, pinStore: reopenedStore })
    const resumed = await resumedWorker.resume()
    assert.equal(resumed.scheduled, 1)
    assert.equal(resumed.busy, 0)
    await resumedWorker.waitForIdle()
    assert.equal(downloadCalls.length, 0)
    assert.equal(resumedWorker.retentions.size, 1)
    const reopenedMedia = resources.corestore.get({ key: b4a.from(coreKey, 'hex') })
    await reopenedMedia.ready()
    assert.equal(await reopenedMedia.has(0, 2), true)
    assert.equal((await reopenedStore.getByRequestId(request.requestId)).status.state, 'complete')
  } finally {
    await resumedWorker?.stop().catch(() => {})
    await firstWorker?.stop().catch(() => {})
    await closeMetadata(resources)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resume repairs a complete record with missing local evidence using one exact range', async (t) => {
  const { store } = await createStoreHarness(t)
  const request = requestFor('worker/repair-complete', [
    { coreKey: MEDIA_KEY, start: 0, end: 2, kind: 'media' },
  ])
  await acceptRequest(store, request)
  const originalCore = new FakeCore(MEDIA_KEY, ['aa', 'bbb'])
  const originalWorker = new PinWorker({
    corestore: new FakeCorestore([originalCore]),
    pinStore: store,
  })
  await originalWorker.start(request.requestId)
  await originalWorker.waitForIdle()
  await originalWorker.stop()
  assert.equal((await store.getByRequestId(request.requestId)).status.state, 'complete')

  const repairCore = new FakeCore(MEDIA_KEY, ['aa', 'bbb'])
  const repairWorker = new PinWorker({
    corestore: new FakeCorestore([repairCore]),
    pinStore: store,
  })
  t.teardown(() => repairWorker.stop())
  const resumed = await repairWorker.resume()
  assert.equal(resumed.scheduled, 1)
  await repairWorker.waitForIdle()
  assert.deepEqual(repairCore.downloadCalls, [{ start: 0, end: 2, linear: true }])
  assert.equal((await store.getByRequestId(request.requestId)).status.state, 'complete')
  assert.equal(repairWorker.retentions.size, 1)
})

test('PinWorker handles multiple cores, idempotent starts, replay, and resume without duplicate ranges', async (t) => {
  const { store } = await createStoreHarness(t)
  const coreA = new FakeCore(MEDIA_KEY, ['aa', 'bbb'])
  const coreB = new FakeCore(OTHER_MEDIA_KEY, ['c', 'dddd'])
  const fakeCorestore = new FakeCorestore([coreA, coreB])
  const request = requestFor('worker/multi', [
    { coreKey: MEDIA_KEY, start: 0, end: 2, kind: 'media' },
    { coreKey: OTHER_MEDIA_KEY, start: 1, end: 2, kind: 'media' },
  ])
  await acceptRequest(store, request)
  const worker = new PinWorker({ corestore: fakeCorestore, pinStore: store, concurrency: 1 })
  t.teardown(() => worker.stop())

  const starts = await Promise.all([worker.start(request.requestId), worker.start(request.requestId)])
  assert.deepEqual(starts.map(result => result.outcome).sort(), ['matched', 'scheduled'])
  await worker.waitForIdle()
  assert.deepEqual(coreA.downloadCalls, [{ start: 0, end: 2, linear: true }])
  assert.deepEqual(coreB.downloadCalls, [{ start: 1, end: 2, linear: true }])
  assert.equal((await worker.start(request.requestId)).outcome, 'complete')
  assert.equal(coreA.downloadCalls.length, 1)

  const resumable = requestFor('worker/resume', [{ coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' }])
  await acceptRequest(store, resumable)
  const resumed = await worker.resume()
  assert.equal(resumed.scheduled, 1)
  await worker.waitForIdle()
  assert.equal((await store.getByRequestId(resumable.requestId)).status.state, 'complete')
})

test('complete is sticky when a second worker faults after another finishes', async (t) => {
  const { store } = await createStoreHarness(t)
  const request = requestFor('worker/complete-sticky', [
    { coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' },
  ])
  await acceptRequest(store, request)
  const losingGate = deferred()
  const losingCore = new FakeCore(MEDIA_KEY, ['x'], {
    gate: losingGate,
    downloadError: new Error('late peer failure'),
  })
  const winningCore = new FakeCore(MEDIA_KEY, ['x'])
  const loser = new PinWorker({ corestore: new FakeCorestore([losingCore]), pinStore: store })
  const winner = new PinWorker({ corestore: new FakeCorestore([winningCore]), pinStore: store })
  t.teardown(() => Promise.all([loser.stop(), winner.stop()]))

  await loser.start(request.requestId)
  await waitFor(() => losingCore.downloads.length === 1, 'losing worker did not start')
  await winner.start(request.requestId)
  await winner.waitForIdle()
  assert.equal((await store.getByRequestId(request.requestId)).status.state, 'complete')

  losingGate.resolve()
  await loser.waitForIdle()
  const record = await store.getByRequestId(request.requestId)
  assert.equal(record.status.state, 'complete')
  assert.equal(loser.retentions.size, 0)
})

test('resume feeds cursor pages under queue backpressure without a shorter idle deadline or omissions', async (t) => {
  const { store } = await createStoreHarness(t)
  const gate = deferred()
  const core = new FakeCore(MEDIA_KEY, ['x'], { gate })
  const requests = Array.from({ length: 5 }, (_, index) => requestFor(`worker/page-${index}`, [
    { coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' },
  ]))
  for (const request of requests) await acceptRequest(store, request)
  const worker = new PinWorker({
    corestore: new FakeCorestore([core]),
    pinStore: store,
    concurrency: 1,
    queueLimit: 1,
  })
  t.teardown(() => worker.stop())
  const waitForRealIdle = worker.waitForIdle.bind(worker)
  worker.waitForIdle = async () => {
    throw new Error('obsolete shorter idle deadline')
  }
  const result = await worker.resume()
  assert.deepEqual(result, { scheduled: 2, matched: 0, busy: 0 })
  await waitFor(() => core.downloadCalls.length === 1, 'first resumed range did not start')
  assert.equal(core.downloadCalls.length, 1)
  gate.resolve()
  await waitForRealIdle()
  for (const request of requests) {
    assert.equal((await store.getByRequestId(request.requestId)).status.state, 'complete')
  }
  assert.equal(core.downloadCalls.length, 5)
  assert.equal(worker.resumeTask, null)
})

test('resume schedules records after a corrupt active index and reports the corruption', async (t) => {
  const { store, db } = await createStoreHarness(t)
  const request = requestFor('worker/resume-after-corrupt', [
    { coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' },
  ])
  await acceptRequest(store, request)
  const corruptId = '00'.repeat(32)
  await db.put(activeKey(corruptId), b4a.alloc(512 * 1024 + 1), {
    keyEncoding: 'utf-8',
    valueEncoding: c.raw,
  })
  const core = new FakeCore(MEDIA_KEY, ['x'])
  const worker = new PinWorker({ corestore: new FakeCorestore([core]), pinStore: store })
  t.teardown(() => worker.stop())
  const resumed = await worker.resume()
  assert.equal(resumed.scheduled, 0)
  await assert.rejects(() => worker.waitForIdle(), /record.*large/i)
  assert.equal((await store.getByRequestId(request.requestId)).status.state, 'complete')
  assert.equal(core.downloadCalls.length, 1)
})

test('resume preserves a valid page prefix before an oversized middle index record', async (t) => {
  const { store, db } = await createStoreHarness(t)
  const requests = [0, 1, 2]
    .map(index => requestFor(`worker/corrupt-middle-${index}`, [
      { coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' },
    ]))
    .sort((left, right) => left.requestId.localeCompare(right.requestId))
  for (const request of requests) await acceptRequest(store, request)
  await db.put(activeKey(requests[1].requestId), b4a.alloc(512 * 1024 + 1), {
    keyEncoding: 'utf-8',
    valueEncoding: c.raw,
  })
  const core = new FakeCore(MEDIA_KEY, ['x'])
  const worker = new PinWorker({
    corestore: new FakeCorestore([core]),
    pinStore: store,
    concurrency: 1,
    queueLimit: 2,
  })
  t.teardown(() => worker.stop())

  const resumed = await worker.resume()
  assert.equal(resumed.scheduled, 1)
  await assert.rejects(() => worker.waitForIdle(), /record.*large/i)
  assert.equal((await store.getByRequestId(requests[0].requestId)).status.state, 'complete')
  assert.equal((await store.getByRequestId(requests[1].requestId)).status.state, 'accepted')
  assert.equal((await store.getByRequestId(requests[2].requestId)).status.state, 'complete')
  assert.equal(core.downloadCalls.length, 2)
  await assert.rejects(() => worker.resume(), /record.*large/i)
  assert.equal(core.downloadCalls.length, 2)
})

test('resume returns after a corrupt first-page prefix even when the queue becomes full', async (t) => {
  const { store, db } = await createStoreHarness(t)
  const gate = deferred()
  const core = new FakeCore(MEDIA_KEY, ['x'], { gate })
  const blocker = requestFor('worker/corrupt-prefix-blocker', [
    { coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' },
  ])
  const requests = [0, 1, 2]
    .map(index => requestFor(`worker/corrupt-prefix-${index}`, [
      { coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' },
    ]))
    .sort((left, right) => left.requestId.localeCompare(right.requestId))
  await acceptRequest(store, blocker)
  for (const request of requests) await acceptRequest(store, request)
  const worker = new PinWorker({
    corestore: new FakeCorestore([core]),
    pinStore: store,
    concurrency: 1,
    queueLimit: 1,
  })
  t.teardown(() => worker.stop())
  await worker.start(blocker.requestId)
  await waitFor(() => core.downloads.length === 1, 'blocking download did not start')
  await db.del(activeKey(blocker.requestId), { keyEncoding: 'utf-8' })
  await db.put(activeKey(requests[1].requestId), b4a.alloc(512 * 1024 + 1), {
    keyEncoding: 'utf-8',
    valueEncoding: c.raw,
  })

  let resumedPromptly = false
  const resuming = worker.resume().then(result => {
    resumedPromptly = true
    return result
  })
  await Promise.race([resuming, new Promise(resolve => setTimeout(resolve, 50))])
  const returnedBeforeRelease = resumedPromptly
  if (!resumedPromptly) gate.resolve()
  const resumed = await resuming
  assert.equal(returnedBeforeRelease, true)
  assert.equal(resumed.scheduled, 1)

  gate.resolve()
  await assert.rejects(() => worker.waitForIdle(), /record.*large/i)
  assert.equal((await store.getByRequestId(blocker.requestId)).status.state, 'complete')
  assert.equal((await store.getByRequestId(requests[0].requestId)).status.state, 'complete')
  assert.equal((await store.getByRequestId(requests[1].requestId)).status.state, 'accepted')
  assert.equal((await store.getByRequestId(requests[2].requestId)).status.state, 'complete')
  assert.equal(core.downloadCalls.length, 3)
})

test('resume skips a bounded malformed middle index key without dropping valid neighbors', async (t) => {
  const { store, db } = await createStoreHarness(t)
  const requests = [0, 1]
    .map(index => requestFor(`worker/malformed-middle-${index}`, [
      { coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' },
    ]))
    .sort((left, right) => left.requestId.localeCompare(right.requestId))
  for (const request of requests) await acceptRequest(store, request)
  const malformedKey = `${activeKey(requests[0].requestId)}x`
  await db.put(malformedKey, b4a.from('malformed'), {
    keyEncoding: 'utf-8',
    valueEncoding: c.raw,
  })
  const core = new FakeCore(MEDIA_KEY, ['x'])
  const worker = new PinWorker({
    corestore: new FakeCorestore([core]),
    pinStore: store,
    concurrency: 1,
    queueLimit: 2,
  })
  t.teardown(() => worker.stop())

  const resumed = await worker.resume()
  assert.equal(resumed.scheduled, 1)
  await assert.rejects(() => worker.waitForIdle(), /index key/i)
  assert.deepEqual(
    await Promise.all(requests.map(async request => (await store.getByRequestId(request.requestId)).status.state)),
    ['complete', 'complete'],
  )
  assert.equal(core.downloadCalls.length, 2)
  await assert.rejects(() => worker.resume(), /index key/i)
  assert.equal(core.downloadCalls.length, 2)
})

test('stop settles a resume feeder blocked on queue capacity without leaking jobs or rejection', async (t) => {
  const { store } = await createStoreHarness(t)
  const gate = deferred()
  const core = new FakeCore(MEDIA_KEY, ['x'], { gate })
  const requests = Array.from({ length: 3 }, (_, index) => requestFor(`worker/stop-page-${index}`, [
    { coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' },
  ]))
  for (const request of requests) await acceptRequest(store, request)
  const worker = new PinWorker({
    corestore: new FakeCorestore([core]),
    pinStore: store,
    concurrency: 1,
    queueLimit: 1,
  })
  const result = await worker.resume()
  assert.deepEqual(result, { scheduled: 2, matched: 0, busy: 0 })
  await waitFor(() => core.downloads.length === 1, 'first resumed download did not start')
  await worker.stop()
  gate.resolve()
  assert.equal(worker.resumeTask, null)
  assert.equal(worker.jobs.size, 0)
  assert.equal(worker.queue.length, 0)
  assert.equal(worker.retentions.size, 0)
})

test('PinWorker enforces global concurrency and a finite BUSY queue', async (t) => {
  const { store } = await createStoreHarness(t)
  const gates = [deferred(), deferred(), deferred()]
  let active = 0
  let maximum = 0
  const cores = gates.map((gate, index) => new FakeCore(
    index === 0 ? MEDIA_KEY : index === 1 ? OTHER_MEDIA_KEY : '88'.repeat(32),
    ['x'],
    {
      gate,
      onDownloadStart: () => { active++; maximum = Math.max(maximum, active) },
      onDownloadEnd: () => { active-- },
    },
  ))
  const requests = cores.map((core, index) => requestFor(`worker/concurrency-${index}`, [
    { coreKey: core.key, start: 0, end: 1, kind: 'media' },
  ]))
  for (const request of requests) await acceptRequest(store, request)
  const worker = new PinWorker({
    corestore: new FakeCorestore(cores),
    pinStore: store,
    concurrency: 2,
    queueLimit: 1,
  })
  t.teardown(() => worker.stop())
  await worker.start(requests[0].requestId)
  await worker.start(requests[1].requestId)
  await waitFor(() => active === 2, 'two concurrent pins did not start')
  await worker.start(requests[2].requestId)

  const overflow = requestFor('worker/overflow', [{ coreKey: '99'.repeat(32), start: 0, end: 1, kind: 'media' }])
  await acceptRequest(store, overflow)
  await assert.rejects(
    () => worker.start(overflow.requestId),
    error => error instanceof PinWorkerError && error.code === SEED_PIN_ERROR_CODES.BUSY,
  )
  gates[0].resolve()
  await waitFor(() => cores[2].downloadCalls.length === 1, 'queued pin did not start')
  gates[1].resolve()
  gates[2].resolve()
  await worker.waitForIdle()
  assert.equal(maximum, 2)
})

test('remote completion without LOCAL bitfield evidence is retryable and never complete', async (t) => {
  const { store } = await createStoreHarness(t)
  const core = new FakeCore(MEDIA_KEY, ['remote', 'blocks'], { localize: false })
  const request = requestFor('worker/local-evidence', [{ coreKey: MEDIA_KEY, start: 0, end: 2, kind: 'media' }])
  const fakeCorestore = new FakeCorestore([core])
  await acceptRequest(store, request)
  const worker = new PinWorker({ corestore: fakeCorestore, pinStore: store })
  t.teardown(() => worker.stop())
  await worker.start(request.requestId)
  await worker.waitForIdle()
  const record = await store.getByRequestId(request.requestId)
  assert.equal(record.status.state, 'retryable')
  assert.equal(record.status.error, 'local-missing')
  assert.notEqual(record.status.state, 'complete')
  assert.equal(fakeCorestore.sessions[0].closed, 1)
})

test('network, unavailable range, and ready/open errors persist explicit states and clean failed sessions', async (t) => {
  const { store } = await createStoreHarness(t)
  const network = new FakeCore(MEDIA_KEY, ['x'], { downloadError: new Error('network down') })
  const unavailable = new FakeCore(OTHER_MEDIA_KEY, ['x'], { length: 1 })
  const ready = new FakeCore('88'.repeat(32), ['x'], { readyError: new Error('ready failed') })
  const specs = [
    ['worker/network', network, 0, 1, 'download'],
    ['worker/unavailable', unavailable, 0, 2, 'range-unavailable'],
    ['worker/ready', ready, 0, 1, 'open'],
  ]
  for (const [rowId, core, start, end] of specs) {
    await acceptRequest(store, requestFor(rowId, [{ coreKey: core.key, start, end, kind: 'media' }]))
  }
  const fakeCorestore = new FakeCorestore([network, unavailable, ready])
  const worker = new PinWorker({
    corestore: fakeCorestore,
    pinStore: store,
    rangeTimeout: 10,
    downloadTimeout: 50,
  })
  t.teardown(() => worker.stop())
  for (const [rowId] of specs) await worker.start(manifestFor(rowId, [{ coreKey: specs.find(spec => spec[0] === rowId)[1].key, start: specs.find(spec => spec[0] === rowId)[2], end: specs.find(spec => spec[0] === rowId)[3], kind: 'media' }]).requestId)
  await worker.waitForIdle()

  for (const [rowId, core, start, end, error] of specs) {
    const requestId = manifestFor(rowId, [{ coreKey: core.key, start, end, kind: 'media' }]).requestId
    const record = await store.getByRequestId(requestId)
    assert.equal(record.status.state, 'retryable')
    assert.equal(record.status.error, error)
  }
  assert.equal(fakeCorestore.sessions.length, 3)
  assert.ok(fakeCorestore.sessions.every(session => session.closed === 1), 'every failed job closes its session')
})

test('a stalled core.ready is bounded, retryable, and closes its session without waiting for readiness', async (t) => {
  const { store } = await createStoreHarness(t)
  const readyGate = deferred()
  const core = new FakeCore(MEDIA_KEY, ['x'], { readyGate })
  const request = requestFor('worker/ready-timeout', [
    { coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' },
  ])
  await acceptRequest(store, request)
  const fakeCorestore = new FakeCorestore([core])
  const worker = new PinWorker({
    corestore: fakeCorestore,
    pinStore: store,
    rangeTimeout: 10,
  })
  t.teardown(async () => {
    readyGate.resolve()
    await worker.stop()
  })
  await worker.start(request.requestId)
  await worker.waitForIdle({ timeout: 250 })
  const record = await store.getByRequestId(request.requestId)
  assert.equal(record.status.state, 'retryable')
  assert.equal(record.status.error, 'open')
  assert.equal(fakeCorestore.sessions[0].closed, 1)
  assert.equal(worker.retentions.size, 0)
})

test('capacity policy rejects overflow estimates and actual quota progression without completion', async (t) => {
  const { store } = await createStoreHarness(t)
  const core = new FakeCore(MEDIA_KEY, ['aa', 'bb', 'cc'])
  const request = requestFor('worker/quota', [{ coreKey: MEDIA_KEY, start: 0, end: 3, kind: 'media' }])
  await acceptRequest(store, request)
  const phases = []
  const worker = new PinWorker({
    corestore: new FakeCorestore([core]),
    pinStore: store,
    capacityPolicy: (context) => {
      phases.push({ phase: context.phase, bytes: context.downloadedBytes })
      return context.phase !== 'progress' || context.downloadedBytes <= 3
    },
    progressChunkBlocks: 1,
  })
  t.teardown(() => worker.stop())
  await worker.start(request.requestId)
  await worker.waitForIdle()
  const quota = await store.getByRequestId(request.requestId)
  assert.equal(quota.status.state, 'failed')
  assert.equal(quota.status.errorCode, SEED_PIN_ERROR_CODES.CAPACITY_EXCEEDED)
  assert.equal(quota.status.error, 'quota')
  assert.notEqual(quota.status.state, 'complete')
  assert.ok(phases.some(entry => entry.phase === 'estimate'))
  assert.ok(phases.some(entry => entry.phase === 'progress'))

  const boundedRequest = requestFor('worker/block-bound', [
    { coreKey: OTHER_MEDIA_KEY, start: 0, end: 4, kind: 'media' },
  ])
  await acceptRequest(store, boundedRequest)
  const boundedCorestore = new FakeCorestore([
    new FakeCore(OTHER_MEDIA_KEY, ['a', 'b', 'c', 'd']),
  ])
  const boundedWorker = new PinWorker({
    corestore: boundedCorestore,
    pinStore: store,
    maxBlocksPerRequest: 3,
  })
  t.teardown(() => boundedWorker.stop())
  await boundedWorker.start(boundedRequest.requestId)
  await boundedWorker.waitForIdle()
  const bounded = await store.getByRequestId(boundedRequest.requestId)
  assert.equal(bounded.status.state, 'failed')
  assert.equal(bounded.status.error, 'capacity')
  assert.equal(boundedCorestore.sessions.length, 0)

  const hugeRefs = Array.from({ length: 2 }, (_, index) => ({
    coreKey: (index ? 'ab' : 'aa').repeat(32),
    start: 0,
    end: Number.MAX_SAFE_INTEGER,
    kind: 'media',
  }))
  const overflow = requestFor('worker/overflow-bounds', hugeRefs)
  await acceptRequest(store, overflow)
  const overflowWorker = new PinWorker({
    corestore: new FakeCorestore([]),
    pinStore: store,
  })
  t.teardown(() => overflowWorker.stop())
  await overflowWorker.start(overflow.requestId)
  await overflowWorker.waitForIdle()
  const overflowRecord = await store.getByRequestId(overflow.requestId)
  assert.equal(overflowRecord.status.state, 'failed')
  assert.equal(overflowRecord.status.error, 'capacity')
})

test('exact byte reservation rejects quota before downloads and missing tree sizes fail closed', async (t) => {
  const { store } = await createStoreHarness(t)
  const large = new FakeCore(MEDIA_KEY, ['x'.repeat(16 * 1024)])
  const request = requestFor('worker/preflight-quota', [
    { coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' },
  ])
  await acceptRequest(store, request)
  const phases = []
  const worker = new PinWorker({
    corestore: new FakeCorestore([large]),
    pinStore: store,
    capacityPolicy: context => {
      phases.push({ phase: context.phase, reservedBytes: context.reservedBytes })
      return context.phase !== 'reserve' || context.reservedBytes <= 8
    },
  })
  t.teardown(() => worker.stop())
  await worker.start(request.requestId)
  await worker.waitForIdle()
  assert.deepEqual(phases.map(entry => entry.phase), ['estimate', 'reserve'])
  assert.equal(large.downloadCalls.length, 0)
  assert.equal(large.local.size, 0)
  assert.equal((await store.getByRequestId(request.requestId)).status.state, 'failed')

  const unavailable = new FakeCore(OTHER_MEDIA_KEY, ['y'], { byteRangeUnavailable: true })
  const unavailableRequest = requestFor('worker/missing-byte-metadata', [
    { coreKey: OTHER_MEDIA_KEY, start: 0, end: 1, kind: 'media' },
  ])
  await acceptRequest(store, unavailableRequest)
  const unavailableWorker = new PinWorker({
    corestore: new FakeCorestore([unavailable]),
    pinStore: store,
  })
  t.teardown(() => unavailableWorker.stop())
  await unavailableWorker.start(unavailableRequest.requestId)
  await unavailableWorker.waitForIdle()
  assert.equal(unavailable.downloadCalls.length, 0)
  const unavailableRecord = await store.getByRequestId(unavailableRequest.requestId)
  assert.equal(unavailableRecord.status.state, 'failed')
  assert.equal(unavailableRecord.status.error, 'capacity')
})

test('summed overlapping ref traversal is bounded before opening a session', async (t) => {
  const { store } = await createStoreHarness(t)
  const refs = [
    { coreKey: MEDIA_KEY, start: 0, end: 4, kind: 'media' },
    { coreKey: MEDIA_KEY, start: 1, end: 4, kind: 'media' },
  ]
  const request = requestFor('worker/traversal-bound', refs)
  await acceptRequest(store, request)
  const fakeCorestore = new FakeCorestore([new FakeCore(MEDIA_KEY, ['a', 'b', 'c', 'd'])])
  const worker = new PinWorker({
    corestore: fakeCorestore,
    pinStore: store,
    maxBlocksPerRequest: 5,
  })
  t.teardown(() => worker.stop())
  await worker.start(request.requestId)
  await worker.waitForIdle()
  assert.equal((await store.getByRequestId(request.requestId)).status.state, 'failed')
  assert.equal(fakeCorestore.sessions.length, 0)
})

test('release refusal is explicit and unchanged; allowed cancel destroys once, closes once, and persists state', async (t) => {
  const { store } = await createStoreHarness(t)
  const gate = deferred()
  const core = new FakeCore(MEDIA_KEY, ['x'], { gate })
  const request = requestFor('worker/release', [{ coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' }])
  await acceptRequest(store, request)
  let permitted = false
  const fakeCorestore = new FakeCorestore([core])
  const worker = new PinWorker({
    corestore: fakeCorestore,
    pinStore: store,
    releasePolicy: () => permitted,
  })
  t.teardown(() => worker.stop())
  await worker.start(request.requestId)
  await waitFor(() => core.downloads.length === 1, 'download did not start')
  const before = await store.getByRequestId(request.requestId)
  await assert.rejects(() => worker.release(request.requestId, { reason: 'test' }), /release.*refused/i)
  const unchanged = await store.getByRequestId(request.requestId)
  assert.deepEqual(unchanged, before)
  assert.equal(core.downloads[0].destroyed, 0)
  assert.equal(fakeCorestore.sessions[0].closed, 0)

  permitted = true
  const released = await worker.cancel(request.requestId, { reason: 'owner' })
  assert.equal(released.status.state, 'cancelled')
  assert.equal(core.downloads[0].destroyed, 1)
  assert.equal(fakeCorestore.sessions[0].closed, 1)
  assert.equal((await store.getByRequestId(request.requestId)).status.state, 'cancelled')
})

test('release policy timeout is unchanged and stop interrupts a pending policy callback', async (t) => {
  const { store } = await createStoreHarness(t)
  const downloadGate = deferred()
  const core = new FakeCore(MEDIA_KEY, ['x'], { gate: downloadGate })
  const request = requestFor('worker/release-policy-timeout', [
    { coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' },
  ])
  await acceptRequest(store, request)
  const policyGate = deferred()
  let allowRelease = false
  const fakeCorestore = new FakeCorestore([core])
  const worker = new PinWorker({
    corestore: fakeCorestore,
    pinStore: store,
    releaseTimeout: 20,
    releasePolicy: () => allowRelease ? true : policyGate.promise,
  })
  t.teardown(() => worker.stop())
  await worker.start(request.requestId)
  await waitFor(() => core.downloads.length === 1, 'download did not start')
  await assert.rejects(() => worker.cancel(request.requestId), /policy.*timed out/i)
  assert.equal(worker.jobs.get(request.requestId).cancelled, false)
  assert.equal(worker.retentions.has(request.requestId), true)
  assert.equal(core.downloads[0].destroyed, 0)
  assert.equal(fakeCorestore.sessions[0].closed, 0)
  assert.equal((await store.getByRequestId(request.requestId)).status.state, 'pinning')

  allowRelease = true
  await worker.cancel(request.requestId)
  assert.equal((await store.getByRequestId(request.requestId)).status.state, 'cancelled')
  assert.equal(core.downloads[0].destroyed, 1)
  assert.equal(fakeCorestore.sessions[0].closed, 1)
  policyGate.resolve()

  const stopDownloadGate = deferred()
  const stopPolicyGate = deferred()
  const policyEntered = deferred()
  const stopCore = new FakeCore(OTHER_MEDIA_KEY, ['y'], { gate: stopDownloadGate })
  const stopRequest = requestFor('worker/stop-release-policy', [
    { coreKey: OTHER_MEDIA_KEY, start: 0, end: 1, kind: 'media' },
  ])
  await acceptRequest(store, stopRequest)
  const stopWorker = new PinWorker({
    corestore: new FakeCorestore([stopCore]),
    pinStore: store,
    releaseTimeout: 5_000,
    releasePolicy: async () => {
      policyEntered.resolve()
      return stopPolicyGate.promise
    },
  })
  await stopWorker.start(stopRequest.requestId)
  await waitFor(() => stopCore.downloads.length === 1, 'stop download did not start')
  const releasing = stopWorker.release(stopRequest.requestId).catch(error => error)
  await policyEntered.promise
  let stoppedPromptly = false
  const stopping = stopWorker.stop().then(() => { stoppedPromptly = true })
  await Promise.race([stopping, new Promise(resolve => setTimeout(resolve, 50))])
  if (!stoppedPromptly) stopPolicyGate.resolve()
  await stopping
  stopPolicyGate.resolve()
  stopDownloadGate.resolve()
  const releaseError = await releasing
  assert.equal(stoppedPromptly, true)
  assert.match(releaseError.message, /worker.*stopped/i)
  assert.equal((await store.getByRequestId(stopRequest.requestId)).status.state, 'retryable')
})

test('stalled LOCAL has is interruptible by cancel and closes retained resources once', async (t) => {
  const { store } = await createStoreHarness(t)
  const hasGate = deferred()
  const hasEntered = deferred()
  const core = new FakeCore(MEDIA_KEY, ['x'], {
    hasGate,
    onHasStart: () => hasEntered.resolve(),
  })
  const request = requestFor('worker/cancel-stalled-has', [
    { coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' },
  ])
  await acceptRequest(store, request)
  const fakeCorestore = new FakeCorestore([core])
  const worker = new PinWorker({
    corestore: fakeCorestore,
    pinStore: store,
    releasePolicy: () => true,
    rangeTimeout: 5_000,
  })
  t.teardown(() => worker.stop())
  await worker.start(request.requestId)
  await hasEntered.promise
  await worker.cancel(request.requestId)

  let idleError = null
  try {
    await worker.waitForIdle({ timeout: 50 })
  } catch (error) {
    idleError = error
  } finally {
    hasGate.resolve()
    await worker.waitForIdle()
  }
  assert.equal(idleError, null)
  assert.equal((await store.getByRequestId(request.requestId)).status.state, 'cancelled')
  assert.equal(core.downloads[0].destroyed, 1)
  assert.equal(fakeCorestore.sessions[0].closed, 1)
})

test('stalled LOCAL get is interruptible by stop and leaves retryable work without leaks', async (t) => {
  const { store } = await createStoreHarness(t)
  const getGate = deferred()
  const getEntered = deferred()
  const core = new FakeCore(MEDIA_KEY, ['x'], {
    getGate,
    onGetStart: () => getEntered.resolve(),
  })
  const request = requestFor('worker/stop-stalled-get', [
    { coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' },
  ])
  await acceptRequest(store, request)
  const fakeCorestore = new FakeCorestore([core])
  const worker = new PinWorker({
    corestore: fakeCorestore,
    pinStore: store,
    rangeTimeout: 5_000,
  })
  await worker.start(request.requestId)
  await getEntered.promise

  let settledPromptly = false
  const stopping = worker.stop().then(() => { settledPromptly = true })
  await Promise.race([stopping, new Promise(resolve => setTimeout(resolve, 50))])
  if (!settledPromptly) getGate.resolve()
  await stopping
  getGate.resolve()
  const record = await store.getByRequestId(request.requestId)

  assert.equal(settledPromptly, true)
  assert.equal(record.status.state, 'retryable')
  assert.equal(core.downloads[0].destroyed, 1)
  assert.equal(fakeCorestore.sessions[0].closed, 1)
  assert.equal(worker.retentions.size, 0)
  assert.equal(worker.jobs.size, 0)
})

test('failed terminal persistence leaves a running pin live and able to finish', async (t) => {
  const { store } = await createStoreHarness(t)
  const gate = deferred()
  const core = new FakeCore(MEDIA_KEY, ['x'], { gate })
  const request = requestFor('worker/release-write-failure', [
    { coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' },
  ])
  await acceptRequest(store, request)
  let failNextBatch = false
  const originalBatch = store.db.batch.bind(store.db)
  store.db.batch = (...args) => {
    const batch = originalBatch(...args)
    const originalFlush = batch.flush.bind(batch)
    batch.flush = async () => {
      if (failNextBatch) {
        failNextBatch = false
        throw new Error('metadata write failed')
      }
      return originalFlush()
    }
    return batch
  }
  const fakeCorestore = new FakeCorestore([core])
  const worker = new PinWorker({
    corestore: fakeCorestore,
    pinStore: store,
    releasePolicy: () => true,
  })
  t.teardown(() => worker.stop())
  await worker.start(request.requestId)
  await waitFor(() => core.downloads.length === 1, 'download did not start')

  failNextBatch = true
  await assert.rejects(() => worker.cancel(request.requestId), /metadata write failed/)
  assert.equal(worker.jobs.has(request.requestId), true)
  assert.equal(worker.jobs.get(request.requestId).cancelled, false)
  assert.equal(worker.retentions.has(request.requestId), true)
  assert.equal(core.downloads[0].destroyed, 0)
  assert.equal(fakeCorestore.sessions[0].closed, 0)
  assert.equal((await store.getByRequestId(request.requestId)).status.state, 'pinning')

  gate.resolve()
  await worker.waitForIdle()
  assert.equal((await store.getByRequestId(request.requestId)).status.state, 'complete')
  assert.equal(worker.retentions.has(request.requestId), true)

  const cancelled = await worker.cancel(request.requestId)
  assert.equal(cancelled.status.state, 'cancelled')
  assert.equal(core.downloads[0].destroyed, 1)
  assert.equal(fakeCorestore.sessions[0].closed, 1)
})

test('cancel while capacity/open is paused cannot create or leak retention after terminal persistence', async (t) => {
  const { store } = await createStoreHarness(t)
  const capacityGate = deferred()
  const capacityEntered = deferred()
  const capacityCore = new FakeCore(MEDIA_KEY, ['x'])
  const capacityRequest = requestFor('worker/cancel-before-retention', [
    { coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' },
  ])
  await acceptRequest(store, capacityRequest)
  const capacityCorestore = new FakeCorestore([capacityCore])
  const capacityWorker = new PinWorker({
    corestore: capacityCorestore,
    pinStore: store,
    capacityPolicy: async ({ phase }) => {
      if (phase === 'estimate') {
        capacityEntered.resolve()
        await capacityGate.promise
      }
      return true
    },
    releasePolicy: () => true,
  })
  t.teardown(() => capacityWorker.stop())
  await capacityWorker.start(capacityRequest.requestId)
  await capacityEntered.promise
  await capacityWorker.cancel(capacityRequest.requestId)
  capacityGate.resolve()
  await capacityWorker.waitForIdle()
  assert.equal(capacityCorestore.sessions.length, 0)
  assert.equal(capacityCore.downloads.length, 0)
  assert.equal(capacityWorker.retentions.size, 0)
  assert.equal(capacityWorker.jobs.size, 0)
  assert.equal((await store.getByRequestId(capacityRequest.requestId)).status.state, 'cancelled')

  const readyGate = deferred()
  const readyEntered = deferred()
  const readyCore = new FakeCore(OTHER_MEDIA_KEY, ['y'], {
    readyGate,
    onReadyStart: () => readyEntered.resolve(),
  })
  const readyRequest = requestFor('worker/cancel-during-open', [
    { coreKey: OTHER_MEDIA_KEY, start: 0, end: 1, kind: 'media' },
  ])
  await acceptRequest(store, readyRequest)
  const readyCorestore = new FakeCorestore([readyCore])
  const readyWorker = new PinWorker({
    corestore: readyCorestore,
    pinStore: store,
    releasePolicy: () => true,
  })
  t.teardown(() => readyWorker.stop())
  await readyWorker.start(readyRequest.requestId)
  await readyEntered.promise
  await readyWorker.release(readyRequest.requestId)
  readyGate.resolve()
  await readyWorker.waitForIdle()
  assert.equal(readyCorestore.sessions.length, 1)
  assert.equal(readyCorestore.sessions[0].closed, 1)
  assert.equal(readyCore.downloads.length, 0)
  assert.equal(readyWorker.retentions.size, 0)
  assert.equal(readyWorker.jobs.size, 0)
  assert.equal((await store.getByRequestId(readyRequest.requestId)).status.state, 'released')
})

test('allowed cancel of a complete retained pin persists cancelled before releasing retention', async (t) => {
  const { store } = await createStoreHarness(t)
  const core = new FakeCore(MEDIA_KEY, ['x'])
  const request = requestFor('worker/cancel-complete', [
    { coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' },
  ])
  await acceptRequest(store, request)
  const fakeCorestore = new FakeCorestore([core])
  const worker = new PinWorker({
    corestore: fakeCorestore,
    pinStore: store,
    releasePolicy: () => true,
  })
  t.teardown(() => worker.stop())
  await worker.start(request.requestId)
  await worker.waitForIdle()
  assert.equal((await store.getByRequestId(request.requestId)).status.state, 'complete')
  const cancelled = await worker.cancel(request.requestId)
  assert.equal(cancelled.status.state, 'cancelled')
  assert.equal((await store.getByRequestId(request.requestId)).status.state, 'cancelled')
  assert.equal(fakeCorestore.sessions[0].closed, 1)
  assert.equal(core.downloads[0].destroyed, 1)
  assert.equal(worker.retentions.size, 0)
})

test('stop cancels handles, closes sessions once, and leaves incomplete work resumable with no timers', async (t) => {
  const { store } = await createStoreHarness(t)
  const gate = deferred()
  const core = new FakeCore(MEDIA_KEY, ['x'], { gate })
  const request = requestFor('worker/stop', [{ coreKey: MEDIA_KEY, start: 0, end: 1, kind: 'media' }])
  await acceptRequest(store, request)
  const fakeCorestore = new FakeCorestore([core])
  const worker = new PinWorker({ corestore: fakeCorestore, pinStore: store })
  await worker.start(request.requestId)
  await waitFor(() => core.downloads.length === 1, 'download did not start')
  await worker.stop()
  assert.equal(core.downloads[0].destroyed, 1)
  assert.equal(fakeCorestore.sessions[0].closed, 1)
  const record = await store.getByRequestId(request.requestId)
  assert.equal(record.status.state, 'retryable')
  assert.equal((await store.listResumable()).some(item => item.requestId === request.requestId), true)
})
