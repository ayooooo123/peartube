import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Corestore from 'corestore'

import {
  COLLECTIONS,
  createIndexerStore,
  IndexerAdmissionError,
  measureEncodedIndexerRow,
} from '../src/indexer/index.js'
import indexDbDefinition from '../src/indexer/index-hyperdb-spec/hyperdb/index.js'

const PUBLISHER_A = '11'.repeat(32)
const PUBLISHER_B = '22'.repeat(32)
const RECORD_ID = '33'.repeat(32)
const BOOTSTRAP_KEY = '44'.repeat(32)

const generousBudget = () => ({ maxRetainedBytes: 10_000_000, maxRows: 100 })

function limits(overrides = {}) {
  return {
    global: { ...generousBudget(), ...overrides.global },
    shard: { ...generousBudget(), ...overrides.shard },
    publisher: { ...generousBudget(), ...overrides.publisher },
    trustClasses: {
      untrusted: { ...generousBudget(), ...overrides.untrusted },
      trusted: { ...generousBudget(), ...overrides.trusted },
    },
  }
}

function sourceRecord(publisherId = PUBLISHER_A, overrides = {}) {
  return {
    publisherId,
    catalogEpoch: 1,
    recordId: RECORD_ID,
    recordType: 'publication',
    sourceSequence: 1,
    canonicalEnvelope: Buffer.from('signed-source-envelope'),
    projectionState: 'active',
    ingestedAt: 10,
    ...overrides,
  }
}

function cursor(publisherId = PUBLISHER_A, overrides = {}) {
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

function replacement(publisherId = PUBLISHER_A) {
  return {
    publisherId,
    rows: [{ collection: COLLECTIONS.sourceRecords, record: sourceRecord(publisherId) }],
    cursor: cursor(publisherId),
  }
}

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-index-admission-'))
  const store = new Corestore(directory)
  await store.ready()
  let index = null
  t.after(async () => {
    if (index) await index.close()
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  index = await createIndexerStore({ store, limits: options.limits || limits(), policy: options.policy })
  return { index, store }
}

function manualEncodedCharge(collectionName, record) {
  const collection = indexDbDefinition.resolveCollection(collectionName)
  const collectionVersion = Math.min(indexDbDefinition.versions.db, collection.version)
  let bytes = collection.encodeKey(record).byteLength
  bytes += collection.encodeValue(indexDbDefinition.versions.schema, collectionVersion, record).byteLength
  for (const index of collection.indexes) {
    const pointer = index.encodeValue(record)
    for (const key of index.encodeIndexKeys(record, null)) bytes += key.byteLength + pointer.byteLength
  }
  return bytes
}

test('encoded row measurement charges the generated primary value and every secondary key pointer', () => {
  const record = sourceRecord()
  const generated = indexDbDefinition.resolveCollection(COLLECTIONS.sourceRecords)
  assert.ok(generated.indexes.length > 0)
  assert.equal(measureEncodedIndexerRow(COLLECTIONS.sourceRecords, record), manualEncodedCharge(COLLECTIONS.sourceRecords, record))
})

test('exact retained-byte and row boundaries admit equality and reject one byte below without mutation', async (t) => {
  const exactBytes = manualEncodedCharge(COLLECTIONS.sourceRecords, sourceRecord())
    + manualEncodedCharge(COLLECTIONS.sourceCursors, cursor())

  const admitted = await fixture(t, {
    limits: limits({ global: { maxRetainedBytes: exactBytes, maxRows: 2 } }),
  })
  await admitted.index.replacePublisherSlice(replacement())
  assert.deepEqual((await admitted.index.snapshotUsage()).global, { retainedBytes: exactBytes, rows: 2 })

  const directory = mkdtempSync(join(tmpdir(), 'peartube-index-admission-under-'))
  const store = new Corestore(directory)
  await store.ready()
  const rejected = await createIndexerStore({
    store,
    limits: limits({ global: { maxRetainedBytes: exactBytes - 1, maxRows: 2 } }),
  })
  try {
    const error = await rejected.replacePublisherSlice(replacement()).then(
      () => null,
      reason => reason,
    )
    assert.ok(error instanceof IndexerAdmissionError)
    assert.equal(error.code, 'INDEX_ADMISSION_LIMIT_EXCEEDED')
    assert.equal(error.scope, 'global')
    assert.equal(error.resource, 'retainedBytes')
    assert.equal(error.limit, exactBytes - 1)
    assert.equal(error.current, 0)
    assert.equal(error.requested, exactBytes)
    assert.match(error.message, new RegExp(`global.*${exactBytes - 1}.*${exactBytes}`))
    assert.deepEqual(await rejected.snapshotUsage(), {
      global: { retainedBytes: 0, rows: 0 },
      shards: [],
      publishers: [],
      trustClasses: [],
      tombstones: [],
    })
  } finally {
    await rejected.close()
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('global shard publisher and untrusted row ceilings each fail closed with actionable scope details', async (t) => {
  const cases = [
    ['global', limits({ global: { maxRows: 1 } }), 'global', 'global'],
    ['shard', limits({ shard: { maxRows: 1 } }), 'shard', 'default'],
    ['publisher', limits({ publisher: { maxRows: 1 } }), 'publisher', PUBLISHER_A],
    ['untrusted', limits({ untrusted: { maxRows: 1 } }), 'trustClass', 'untrusted'],
  ]

  for (const [label, configuredLimits, expectedScope, expectedScopeId] of cases) {
    await t.test(label, async (subtest) => {
      const { index } = await fixture(subtest, { limits: configuredLimits })
      const error = await index.replacePublisherSlice(replacement()).then(
        () => null,
        reason => reason,
      )
      assert.ok(error instanceof IndexerAdmissionError)
      assert.equal(error.code, 'INDEX_ADMISSION_LIMIT_EXCEEDED')
      assert.equal(error.scope, expectedScope)
      assert.equal(error.scopeId, expectedScopeId)
      assert.equal(error.resource, 'rows')
      assert.equal(error.limit, 1)
      assert.equal(error.current, 0)
      assert.equal(error.requested, 2)
      assert.deepEqual((await index.snapshotUsage()).global, { retainedBytes: 0, rows: 0 })
    })
  }
})

test('limits and synchronous policy results must be finite bounded and explicitly configured', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-index-options-'))
  const store = new Corestore(directory)
  await store.ready()
  t.after(async () => {
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  await assert.rejects(createIndexerStore({ store }), /limits\.global/)
  await assert.rejects(createIndexerStore({
    store,
    limits: limits({ global: { maxRetainedBytes: Number.POSITIVE_INFINITY } }),
  }), /finite bounded unsigned integer/)
  await assert.rejects(createIndexerStore({
    store,
    limits: { ...limits(), trustClasses: { trusted: generousBudget() } },
  }), /untrusted/)

  const asyncPolicy = await createIndexerStore({
    store,
    limits: limits(),
    policy: { resolvePublisher: async () => ({ shardId: 'default', trustClass: 'untrusted' }) },
  })
  try {
    await assert.rejects(asyncPolicy.replacePublisherSlice(replacement()), error => {
      assert.equal(error.code, 'INDEX_INVALID_OPERATION')
      assert.equal(error.scope, 'policy')
      return true
    })
  } finally {
    await asyncPolicy.close()
  }

  const unknownClass = await createIndexerStore({
    store,
    limits: limits(),
    policy: { resolvePublisher: () => ({ shardId: 'default', trustClass: 'unknown' }) },
  })
  try {
    await assert.rejects(unknownClass.replacePublisherSlice(replacement()), error => {
      assert.equal(error.code, 'INDEX_INVALID_OPERATION')
      assert.equal(error.scope, 'trustClass')
      assert.equal(error.requested, 'unknown')
      return true
    })
  } finally {
    await unknownClass.close()
  }
})

test('publisher mismatches malformed operations and duplicate compound keys are validation no-ops', async (t) => {
  const { index } = await fixture(t)
  const before = await index.snapshotUsage()
  const invalidCalls = [
    [index.replacePublisherSlice({
      publisherId: PUBLISHER_A,
      rows: [{ collection: COLLECTIONS.sourceRecords, record: sourceRecord(PUBLISHER_B) }],
      cursor: cursor(PUBLISHER_A),
    }), 'INDEX_PUBLISHER_MISMATCH'],
    [index.replacePublisherSlice({
      publisherId: PUBLISHER_A,
      rows: [
        { collection: COLLECTIONS.sourceRecords, record: sourceRecord() },
        { collection: COLLECTIONS.sourceRecords, record: sourceRecord(undefined, { sourceSequence: 2 }) },
      ],
      cursor: cursor(PUBLISHER_A),
    }), 'INDEX_INVALID_OPERATION'],
    [index.applyPublisherChanges({
      publisherId: PUBLISHER_A,
      operations: [{ type: 'remove', collection: COLLECTIONS.sourceRecords, record: sourceRecord() }],
      cursor: cursor(PUBLISHER_A),
    }), 'INDEX_INVALID_OPERATION'],
    [index.applyPublisherChanges({
      publisherId: PUBLISHER_A,
      operations: [{ type: 'put', collection: COLLECTIONS.sourceCursors, record: cursor() }],
      cursor: cursor(PUBLISHER_A),
    }), 'INDEX_INVALID_OPERATION'],
  ]

  for (const [call, code] of invalidCalls) {
    await assert.rejects(call, error => {
      assert.ok(error instanceof IndexerAdmissionError)
      assert.equal(error.code, code)
      return true
    })
    assert.deepEqual(await index.snapshotUsage(), before)
  }
})
