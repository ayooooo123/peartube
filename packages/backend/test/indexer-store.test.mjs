import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Corestore from 'corestore'

import {
  COLLECTIONS,
  CONTROL_PUBLISHER_ID,
  INDEXER_CORE_NAME,
  INDEXES,
  createIndexerStore,
  measureEncodedIndexerRow,
  openIndexerDatabase,
} from '../src/indexer/index.js'

const PUBLISHER_A = '11'.repeat(32)
const PUBLISHER_B = '22'.repeat(32)
const PUBLISHER_C = '33'.repeat(32)
const BOOTSTRAP_KEY = '44'.repeat(32)
const RECORD_A = '55'.repeat(32)
const RECORD_B = '66'.repeat(32)

const high = () => ({ maxRetainedBytes: 20_000_000, maxRows: 200 })

function limits(overrides = {}) {
  return {
    global: { ...high(), ...overrides.global },
    shard: { ...high(), ...overrides.shard },
    publisher: { ...high(), ...overrides.publisher },
    trustClasses: {
      untrusted: { ...high(), ...overrides.untrusted },
      trusted: { ...high(), ...overrides.trusted },
    },
  }
}

function sourceRecord(publisherId, overrides = {}) {
  return {
    publisherId,
    catalogEpoch: 1,
    recordId: RECORD_A,
    recordType: 'publication',
    sourceSequence: 1,
    canonicalEnvelope: Buffer.from(`signed:${publisherId}`),
    projectionState: 'active',
    ingestedAt: 10,
    ...overrides,
  }
}

function cursor(publisherId, overrides = {}) {
  return {
    publisherId,
    catalogEpoch: 1,
    catalogBootstrapKey: BOOTSTRAP_KEY,
    viewFork: 0,
    viewVersion: 1,
    sourceHead: 1,
    lastVerifiedDescriptor: 'descriptor-1',
    ...overrides,
  }
}

function externalReference(publisherId, identifier = 'tt123', overrides = {}) {
  return {
    publisherId,
    sourceRecordRef: 'source-1',
    namespace: 'imdb',
    normalizedIdentifier: identifier,
    entityKind: 'work',
    entityId: `work-${publisherId.slice(0, 4)}`,
    evidenceWeight: 1,
    ...overrides,
  }
}

function relationship(publisherId, suffix = 'one') {
  return {
    publisherId,
    sourceRecordRef: `source-${suffix}`,
    relationType: 'publication-work',
    fromId: `publication-${suffix}`,
    toId: `work-${suffix}`,
  }
}

function row(collection, record) {
  return { collection, record }
}

function fullSlice(publisherId, identifier = 'tt123') {
  return {
    publisherId,
    rows: [
      row(COLLECTIONS.sourceRecords, sourceRecord(publisherId)),
      row(COLLECTIONS.externalReferenceProjections, externalReference(publisherId, identifier)),
    ],
    cursor: cursor(publisherId),
  }
}

function sliceCharge(slice) {
  let retainedBytes = measureEncodedIndexerRow(COLLECTIONS.sourceCursors, slice.cursor)
  for (const entry of slice.rows) retainedBytes += measureEncodedIndexerRow(entry.collection, entry.record)
  return { retainedBytes, rows: slice.rows.length + 1 }
}

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-index-store-'))
  const store = new Corestore(directory)
  await store.ready()
  let index = null
  t.after(async () => {
    if (index) await index.close()
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  index = await createIndexerStore({ store, limits: options.limits || limits(), policy: options.policy })
  return { directory, store, index }
}

async function publisherRows(store, publisherId) {
  const db = await openIndexerDatabase(store, { name: INDEXER_CORE_NAME })
  try {
    const found = {}
    for (const [shortName, publisherIndex] of Object.entries(INDEXES.publisherPrefix)) {
      if (!Object.hasOwn(COLLECTIONS, shortName) || shortName === 'usageCounters' || shortName === 'admissionTombstones') continue
      found[shortName] = await db.find(publisherIndex, { publisherId }).toArray()
    }
    return found
  } finally {
    await db.close()
  }
}

test('publisher replacement atomically repairs its full raw cursor and projection slice without touching another publisher', async (t) => {
  const { index, store } = await fixture(t)
  await index.replacePublisherSlice(fullSlice(PUBLISHER_A))
  await index.replacePublisherSlice(fullSlice(PUBLISHER_B))

  const repaired = {
    publisherId: PUBLISHER_A,
    rows: [
      row(COLLECTIONS.sourceRecords, sourceRecord(PUBLISHER_A, {
        recordId: RECORD_B,
        sourceSequence: 2,
        canonicalEnvelope: Buffer.from('replacement-signed-envelope'),
      })),
      row(COLLECTIONS.relationshipEdges, relationship(PUBLISHER_A, 'replacement')),
    ],
    cursor: cursor(PUBLISHER_A, { viewVersion: 2, sourceHead: 2, lastVerifiedDescriptor: 'descriptor-2' }),
  }
  await index.replacePublisherSlice(repaired)

  const a = await publisherRows(store, PUBLISHER_A)
  assert.deepEqual(a.sourceRecords, [repaired.rows[0].record])
  assert.deepEqual(a.sourceCursors, [repaired.cursor])
  assert.deepEqual(a.externalReferenceProjections, [])
  assert.deepEqual(a.relationshipEdges, [repaired.rows[1].record])

  const b = await publisherRows(store, PUBLISHER_B)
  assert.deepEqual(b.sourceRecords, [fullSlice(PUBLISHER_B).rows[0].record])
  assert.deepEqual(b.externalReferenceProjections, [fullSlice(PUBLISHER_B).rows[1].record])
  assert.deepEqual(b.sourceCursors, [fullSlice(PUBLISHER_B).cursor])

  const expectedA = sliceCharge(repaired)
  const expectedB = sliceCharge(fullSlice(PUBLISHER_B))
  const usage = await index.snapshotUsage()
  assert.deepEqual(usage.global, {
    retainedBytes: expectedA.retainedBytes + expectedB.retainedBytes,
    rows: expectedA.rows + expectedB.rows,
  })
  assert.deepEqual(usage.publishers.map(({ publisherId, retainedBytes, rows }) => ({ publisherId, retainedBytes, rows })), [
    { publisherId: PUBLISHER_A, ...expectedA },
    { publisherId: PUBLISHER_B, ...expectedB },
  ])
})

test('accepted rows and cursor are snapshotted before queued caller mutation', async (t) => {
  const { index, store } = await fixture(t)
  const slice = fullSlice(PUBLISHER_A)
  const expectedEnvelope = Buffer.from(slice.rows[0].record.canonicalEnvelope)
  const accepted = index.replacePublisherSlice(slice)
  slice.rows[0].record.canonicalEnvelope.fill(0)
  slice.rows[0].record.sourceSequence = 99
  slice.cursor.viewVersion = 99
  await accepted

  const stored = await publisherRows(store, PUBLISHER_A)
  assert.deepEqual(stored.sourceRecords[0].canonicalEnvelope, expectedEnvelope)
  assert.equal(stored.sourceRecords[0].sourceSequence, 1)
  assert.equal(stored.sourceCursors[0].viewVersion, 1)
})

test('incremental put delete and cursor deltas are exact and replay idempotently', async (t) => {
  const { index } = await fixture(t)
  const initial = {
    publisherId: PUBLISHER_A,
    rows: [row(COLLECTIONS.sourceRecords, sourceRecord(PUBLISHER_A))],
    cursor: cursor(PUBLISHER_A),
  }
  await index.replacePublisherSlice(initial)

  const projection = externalReference(PUBLISHER_A)
  const nextCursor = cursor(PUBLISHER_A, { viewVersion: 2, sourceHead: 2 })
  const put = {
    publisherId: PUBLISHER_A,
    operations: [{ type: 'put', collection: COLLECTIONS.externalReferenceProjections, record: projection }],
    cursor: nextCursor,
  }
  await index.applyPublisherChanges(put)
  const afterPut = await index.snapshotUsage()
  assert.deepEqual(afterPut.global, sliceCharge({ ...initial, rows: [...initial.rows, row(COLLECTIONS.externalReferenceProjections, projection)], cursor: nextCursor }))

  await index.applyPublisherChanges(put)
  assert.deepEqual(await index.snapshotUsage(), afterPut)

  const deletedCursor = cursor(PUBLISHER_A, { viewVersion: 3, sourceHead: 3 })
  const deletion = {
    publisherId: PUBLISHER_A,
    operations: [{ type: 'delete', collection: COLLECTIONS.externalReferenceProjections, record: projection }],
    cursor: deletedCursor,
  }
  await index.applyPublisherChanges(deletion)
  const afterDelete = await index.snapshotUsage()
  assert.deepEqual(afterDelete.global, sliceCharge({ ...initial, cursor: deletedCursor }))

  await index.applyPublisherChanges(deletion)
  assert.deepEqual(await index.snapshotUsage(), afterDelete)
})

test('oversized apply and replacement leave data cursor counters and tombstones byte-for-byte unchanged', async (t) => {
  const configured = limits({ global: { maxRows: 3 } })
  const { index, store } = await fixture(t, { limits: configured })
  const initial = {
    publisherId: PUBLISHER_A,
    rows: [row(COLLECTIONS.sourceRecords, sourceRecord(PUBLISHER_A))],
    cursor: cursor(PUBLISHER_A),
  }
  await index.replacePublisherSlice(initial)
  const beforeUsage = await index.snapshotUsage()
  const beforeRows = await publisherRows(store, PUBLISHER_A)

  await assert.rejects(index.applyPublisherChanges({
    publisherId: PUBLISHER_A,
    operations: [
      { type: 'put', collection: COLLECTIONS.relationshipEdges, record: relationship(PUBLISHER_A, 'apply-a') },
      { type: 'put', collection: COLLECTIONS.relationshipEdges, record: relationship(PUBLISHER_A, 'apply-b') },
    ],
    cursor: cursor(PUBLISHER_A, { viewVersion: 2, sourceHead: 2 }),
  }), error => error.code === 'INDEX_ADMISSION_LIMIT_EXCEEDED')
  assert.deepEqual(await index.snapshotUsage(), beforeUsage)
  assert.deepEqual(await publisherRows(store, PUBLISHER_A), beforeRows)

  await assert.rejects(index.replacePublisherSlice({
    publisherId: PUBLISHER_A,
    rows: [
      row(COLLECTIONS.sourceRecords, sourceRecord(PUBLISHER_A, { recordId: RECORD_B })),
      row(COLLECTIONS.relationshipEdges, relationship(PUBLISHER_A, 'replace-a')),
      row(COLLECTIONS.relationshipEdges, relationship(PUBLISHER_A, 'replace-b')),
    ],
    cursor: cursor(PUBLISHER_A, { viewVersion: 2, sourceHead: 2 }),
  }), error => error.code === 'INDEX_ADMISSION_LIMIT_EXCEEDED')
  assert.deepEqual(await index.snapshotUsage(), beforeUsage)
  assert.deepEqual(await publisherRows(store, PUBLISHER_A), beforeRows)
})

test('persisted counters cursor and source rows recover coherently after a real Corestore restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-index-restart-'))
  let store = new Corestore(directory)
  await store.ready()
  let index = await createIndexerStore({ store, limits: limits() })
  const slice = fullSlice(PUBLISHER_A)
  await index.replacePublisherSlice(slice)
  const before = await index.snapshotUsage()
  await index.close()
  await store.close()

  store = new Corestore(directory)
  await store.ready()
  index = await createIndexerStore({ store, limits: limits() })
  try {
    assert.deepEqual(await index.snapshotUsage(), before)
    const restored = await publisherRows(store, PUBLISHER_A)
    assert.deepEqual(restored.sourceRecords, [slice.rows[0].record])
    assert.deepEqual(restored.sourceCursors, [slice.cursor])
    assert.deepEqual(restored.externalReferenceProjections, [slice.rows[1].record])
  } finally {
    await index.close()
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('independent root and session stores serialize one remaining global budget', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-index-race-'))
  const store = new Corestore(directory)
  await store.ready()
  const session = store.session()
  await session.ready()
  const configured = limits({ global: { maxRows: 2 } })
  const first = await createIndexerStore({ store, limits: configured })
  const second = await createIndexerStore({ store: session, limits: configured })
  try {
    const race = await Promise.allSettled([
      first.replacePublisherSlice({
        publisherId: PUBLISHER_A,
        rows: [row(COLLECTIONS.sourceRecords, sourceRecord(PUBLISHER_A))],
        cursor: cursor(PUBLISHER_A),
      }),
      second.replacePublisherSlice({
        publisherId: PUBLISHER_B,
        rows: [row(COLLECTIONS.sourceRecords, sourceRecord(PUBLISHER_B))],
        cursor: cursor(PUBLISHER_B),
      }),
    ])
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = race.find(result => result.status === 'rejected')
    assert.equal(rejected.reason.code, 'INDEX_ADMISSION_LIMIT_EXCEEDED')
    const snapshot = await first.snapshotUsage()
    assert.deepEqual(snapshot.global, { retainedBytes: snapshot.publishers[0].retainedBytes, rows: 2 })
    assert.equal(snapshot.publishers.length, 1)
    assert.deepEqual(await second.snapshotUsage(), snapshot)
  } finally {
    await Promise.all([first.close(), second.close()])
    await session.close()
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('policy reclassification atomically debits old shard and trust buckets and credits new membership', async (t) => {
  let membership = { shardId: 'shard-a', trustClass: 'untrusted' }
  const policy = { resolvePublisher: () => membership, now: () => 123 }
  const { index } = await fixture(t, { policy })
  const slice = fullSlice(PUBLISHER_A)
  await index.replacePublisherSlice(slice)
  const charge = sliceCharge(slice)

  membership = { shardId: 'shard-b', trustClass: 'trusted' }
  await index.applyPublisherChanges({ publisherId: PUBLISHER_A, operations: [], cursor: slice.cursor })
  const snapshot = await index.snapshotUsage()
  assert.deepEqual(snapshot.global, charge)
  assert.deepEqual(snapshot.shards, [{ shardId: 'shard-b', ...charge }])
  assert.deepEqual(snapshot.trustClasses, [{ trustClass: 'trusted', ...charge }])
  assert.deepEqual(snapshot.publishers, [{
    publisherId: PUBLISHER_A,
    shardId: 'shard-b',
    trustClass: 'trusted',
    ...charge,
  }])
})

test('exact external-reference query federates admitted publishers and local eviction suppresses reinsertion until explicit clear', async (t) => {
  const policy = { now: () => 456 }
  const { index } = await fixture(t, { policy })
  await index.replacePublisherSlice(fullSlice(PUBLISHER_A))
  await index.replacePublisherSlice(fullSlice(PUBLISHER_B))
  await index.replacePublisherSlice(fullSlice(PUBLISHER_C, 'tt999'))

  const matches = await index.queryExactExternalRef({ namespace: 'imdb', normalizedIdentifier: 'tt123' })
  assert.deepEqual(matches.map(result => result.publisherId), [PUBLISHER_A, PUBLISHER_B])

  await index.evictPublisherSlice({ publisherId: PUBLISHER_A, reason: 'local capacity pressure' })
  const afterEviction = await index.snapshotUsage()
  assert.deepEqual(afterEviction.tombstones, [{
    publisherId: PUBLISHER_A,
    reason: 'local capacity pressure',
    evictedAt: 456,
  }])
  assert.equal(afterEviction.publishers.some(entry => entry.publisherId === PUBLISHER_A), false)
  assert.deepEqual(
    (await index.queryExactExternalRef({ namespace: 'imdb', normalizedIdentifier: 'tt123' })).map(result => result.publisherId),
    [PUBLISHER_B],
  )

  await assert.rejects(index.replacePublisherSlice(fullSlice(PUBLISHER_A)), error => {
    assert.equal(error.code, 'INDEX_ADMISSION_TOMBSTONED')
    assert.equal(error.scope, 'publisher')
    assert.equal(error.scopeId, PUBLISHER_A)
    assert.equal(error.reason, 'local capacity pressure')
    return true
  })
  assert.deepEqual((await index.snapshotUsage()).tombstones, afterEviction.tombstones)

  await index.clearPublisherTombstone({ publisherId: PUBLISHER_A })
  await index.replacePublisherSlice(fullSlice(PUBLISHER_A))
  assert.deepEqual((await index.snapshotUsage()).tombstones, [])
  assert.deepEqual(
    (await index.queryExactExternalRef({ namespace: 'imdb', normalizedIdentifier: 'tt123' })).map(result => result.publisherId),
    [PUBLISHER_A, PUBLISHER_B],
  )
})

test('over-limit restart permits only equal or decreasing usage until eviction repairs every scope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-index-over-limit-repair-'))
  const store = new Corestore(directory)
  await store.ready()
  let index = await createIndexerStore({ store, limits: limits() })
  await index.replacePublisherSlice(fullSlice(PUBLISHER_A))
  await index.replacePublisherSlice(fullSlice(PUBLISHER_B))
  await index.close()

  const lowLimits = limits({
    global: { maxRetainedBytes: 1, maxRows: 5 },
    shard: { maxRetainedBytes: 1, maxRows: 5 },
    publisher: { maxRetainedBytes: 1, maxRows: 3 },
    untrusted: { maxRetainedBytes: 1, maxRows: 5 },
  })
  index = await createIndexerStore({ store, limits: lowLimits })
  try {
    await index.applyPublisherChanges({
      publisherId: PUBLISHER_A,
      operations: [],
      cursor: cursor(PUBLISHER_A),
    })
    await assert.rejects(index.applyPublisherChanges({
      publisherId: PUBLISHER_A,
      operations: [{
        type: 'put',
        collection: COLLECTIONS.relationshipEdges,
        record: relationship(PUBLISHER_A, 'growth'),
      }],
      cursor: cursor(PUBLISHER_A),
    }), error => error.code === 'INDEX_ADMISSION_LIMIT_EXCEEDED')

    await index.replacePublisherSlice({
      publisherId: PUBLISHER_A,
      rows: [row(COLLECTIONS.sourceRecords, sourceRecord(PUBLISHER_A))],
      cursor: cursor(PUBLISHER_A),
    })
    let usage = await index.snapshotUsage()
    assert.equal(usage.global.rows, 5)
    assert.equal(usage.publishers.find(entry => entry.publisherId === PUBLISHER_A).rows, 2)

    await index.evictPublisherSlice({ publisherId: PUBLISHER_A, reason: 'monotonic quota repair' })
    usage = await index.snapshotUsage()
    assert.equal(usage.global.rows, 3)
    assert.deepEqual(usage.publishers.map(entry => entry.publisherId), [PUBLISHER_B])

    await index.evictPublisherSlice({ publisherId: PUBLISHER_B, reason: 'complete quota repair' })
    assert.deepEqual((await index.snapshotUsage()).global, { retainedBytes: 0, rows: 0 })
  } finally {
    await index.close()
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('orphan rows in a later publisher collection fail apply replacement and eviction closed without mutation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-index-orphan-accounting-'))
  const store = new Corestore(directory)
  await store.ready()
  const raw = await openIndexerDatabase(store, { name: INDEXER_CORE_NAME })
  const orphan = relationship(PUBLISHER_A, 'orphan')
  await raw.insert(COLLECTIONS.relationshipEdges, orphan)
  await raw.close()

  const index = await createIndexerStore({ store, limits: limits() })
  try {
    const calls = [
      index.applyPublisherChanges({
        publisherId: PUBLISHER_A,
        operations: [],
        cursor: cursor(PUBLISHER_A),
      }),
      index.replacePublisherSlice(fullSlice(PUBLISHER_A)),
      index.evictPublisherSlice({ publisherId: PUBLISHER_A, reason: 'must not hide corruption' }),
    ]
    for (const call of calls) {
      await assert.rejects(call, error => {
        assert.equal(error.code, 'INDEX_INVALID_OPERATION')
        assert.equal(error.scope, 'accounting')
        assert.equal(error.scopeId, PUBLISHER_A)
        return true
      })
    }
    const stored = await publisherRows(store, PUBLISHER_A)
    assert.deepEqual(stored.relationshipEdges, [orphan])
    assert.deepEqual(stored.sourceCursors, [])
    assert.deepEqual(await index.snapshotUsage(), {
      global: { retainedBytes: 0, rows: 0 },
      shards: [],
      publishers: [],
      trustClasses: [],
      tombstones: [],
    })
  } finally {
    await index.close()
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('snapshot rejects global shard and trust counters that disagree with bounded publisher aggregates', async (t) => {
  const { index, store } = await fixture(t)
  await index.replacePublisherSlice(fullSlice(PUBLISHER_A))
  const raw = await openIndexerDatabase(store, { name: INDEXER_CORE_NAME })
  t.after(() => raw.close())

  const globalKey = { publisherId: CONTROL_PUBLISHER_ID, scope: 'global', bucketId: 'global' }
  const shardKey = { publisherId: CONTROL_PUBLISHER_ID, scope: 'shard', bucketId: 'default' }
  const trustKey = { publisherId: CONTROL_PUBLISHER_ID, scope: 'trustClass', bucketId: 'untrusted' }
  const global = await raw.get(COLLECTIONS.usageCounters, globalKey)
  const shard = await raw.get(COLLECTIONS.usageCounters, shardKey)
  const trust = await raw.get(COLLECTIONS.usageCounters, trustKey)

  await raw.validatedTransaction(tx => tx.upsert(COLLECTIONS.usageCounters, { ...global, rows: global.rows + 1 }))
  await assert.rejects(index.snapshotUsage(), /global accounting does not match publisher counters/)
  await raw.validatedTransaction(tx => tx.upsert(COLLECTIONS.usageCounters, global))

  await raw.validatedTransaction(tx => tx.upsert(COLLECTIONS.usageCounters, { ...shard, retainedBytes: shard.retainedBytes + 1 }))
  await assert.rejects(index.snapshotUsage(), /shard accounting does not match publisher counters/)
  await raw.validatedTransaction(tx => tx.upsert(COLLECTIONS.usageCounters, shard))

  await raw.validatedTransaction(tx => tx.delete(COLLECTIONS.usageCounters, trust))
  await assert.rejects(index.snapshotUsage(), /trustClass accounting does not match publisher counters/)
})

test('publisher-effective input bounds reject before reading poisoned row or operation entries', async (t) => {
  const { index } = await fixture(t, {
    limits: limits({ publisher: { maxRows: 1 } }),
  })
  const poisonedRows = new Array(1)
  Object.defineProperty(poisonedRows, 0, {
    get() { throw new Error('replacement bound read poisoned row') },
  })
  await assert.rejects(index.replacePublisherSlice({
    publisherId: PUBLISHER_A,
    rows: poisonedRows,
    cursor: cursor(PUBLISHER_A),
  }), error => {
    assert.equal(error.code, 'INDEX_ADMISSION_LIMIT_EXCEEDED')
    assert.equal(error.scope, 'publisher')
    assert.equal(error.resource, 'rows')
    assert.equal(error.limit, 1)
    assert.equal(error.current, 0)
    assert.equal(error.requested, 2)
    return true
  })

  const poisonedOperations = new Array(3)
  Object.defineProperty(poisonedOperations, 0, {
    get() { throw new Error('operation bound read poisoned entry') },
  })
  await assert.rejects(index.applyPublisherChanges({
    publisherId: PUBLISHER_A,
    operations: poisonedOperations,
    cursor: cursor(PUBLISHER_A),
  }), error => {
    assert.equal(error.code, 'INDEX_ADMISSION_LIMIT_EXCEEDED')
    assert.equal(error.scope, 'publisher')
    assert.equal(error.resource, 'operations')
    assert.equal(error.limit, 2)
    assert.equal(error.current, 0)
    assert.equal(error.requested, 3)
    return true
  })
  assert.deepEqual((await index.snapshotUsage()).global, { retainedBytes: 0, rows: 0 })
})

test('a forced transaction flush failure commits neither data nor accounting and a retry remains possible', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-index-flush-failure-'))
  const store = new Corestore(directory)
  await store.ready()
  let failNextAppend = false
  const injectedStore = {
    root: store,
    get(options) {
      const core = store.get(options)
      const append = core.append.bind(core)
      core.append = async (...args) => {
        if (failNextAppend) {
          failNextAppend = false
          throw new Error('forced index flush failure')
        }
        return append(...args)
      }
      return core
    },
  }
  const index = await createIndexerStore({ store: injectedStore, limits: limits() })
  try {
    const initial = fullSlice(PUBLISHER_A)
    await index.replacePublisherSlice(initial)
    const before = await index.snapshotUsage()
    failNextAppend = true
    await assert.rejects(index.applyPublisherChanges({
      publisherId: PUBLISHER_A,
      operations: [{ type: 'put', collection: COLLECTIONS.relationshipEdges, record: relationship(PUBLISHER_A) }],
      cursor: cursor(PUBLISHER_A, { viewVersion: 2, sourceHead: 2 }),
    }), /forced index flush failure/)
    assert.deepEqual(await index.snapshotUsage(), before)
    assert.deepEqual(await publisherRows(store, PUBLISHER_A), {
      sourceRecords: [initial.rows[0].record],
      sourceCursors: [initial.cursor],
      externalReferenceProjections: [initial.rows[1].record],
      publicationProjections: [],
      renditionProjections: [],
      availabilityProjections: [],
      relationshipEdges: [],
    })

    await index.applyPublisherChanges({
      publisherId: PUBLISHER_A,
      operations: [{ type: 'put', collection: COLLECTIONS.relationshipEdges, record: relationship(PUBLISHER_A) }],
      cursor: cursor(PUBLISHER_A, { viewVersion: 2, sourceHead: 2 }),
    })
    assert.equal((await publisherRows(store, PUBLISHER_A)).relationshipEdges.length, 1)
  } finally {
    await index.close()
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('close is drain-safe idempotent rejects late work and preserves caller Corestore ownership', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-index-close-'))
  const store = new Corestore(directory)
  await store.ready()
  const index = await createIndexerStore({ store, limits: limits() })
  const accepted = index.replacePublisherSlice(fullSlice(PUBLISHER_A))
  const closeA = index.close()
  const closeB = index.close()
  assert.strictEqual(closeA, closeB)
  await assert.rejects(index.replacePublisherSlice(fullSlice(PUBLISHER_B)), /closed/)
  await accepted
  await closeA

  const reopened = await createIndexerStore({ store, limits: limits() })
  assert.deepEqual((await reopened.snapshotUsage()).publishers.map(entry => entry.publisherId), [PUBLISHER_A])
  await reopened.close()

  const owned = store.get({ name: 'caller-still-owns-corestore' })
  await owned.ready()
  assert.ok(owned.key)
  await owned.close()
  await store.close()
  rmSync(directory, { recursive: true, force: true })
})
