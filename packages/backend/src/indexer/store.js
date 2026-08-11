import {
  COLLECTIONS,
  CONTROL_PUBLISHER_ID,
  DATA_COLLECTIONS,
  INDEXES,
  INDEX_KEY_FIELDS,
  INDEX_SCHEMA_LIMITS,
  measureEncodedIndexerRow,
  openIndexerDatabase,
  validateIndexerRecord,
} from './schema.js'
import {
  assertWithinBudget,
  invalidOperation,
  publisherMismatch,
  resolveAdmissionTime,
  resolvePublisherMembership,
  safeUsageAdd,
  tombstonedPublisher,
  validateAdmissionLimits,
  validateAdmissionPolicy,
  validateBoundedText,
  validatePublisherId,
} from './admission.js'
import {
  MAX_INDEX_QUERY_RESULTS,
  normalizeIndexQuerySelectors,
} from './query-codec.js'

export const INDEXER_CORE_NAME = 'peartube-index-v1'

const GLOBAL_BUCKET = 'global'
const PUBLISHER_BUCKET = 'usage'
const TOMBSTONE_BUCKET = 'count'
const MAX_TOMBSTONES = 65_536
const EMPTY_USAGE = Object.freeze({ retainedBytes: 0, rows: 0 })
const MAX_USAGE = Object.freeze({
  maxRetainedBytes: Number.MAX_SAFE_INTEGER,
  maxRows: Number.MAX_SAFE_INTEGER,
})
const MUTABLE_DATA_COLLECTIONS = new Set(DATA_COLLECTIONS.filter(collection => collection !== COLLECTIONS.sourceCursors))
const OPTION_FIELDS = new Set(['store', 'limits', 'policy'])
const REPLACEMENT_FIELDS = new Set(['publisherId', 'rows', 'cursor', 'expectedCursor'])
const CHANGE_FIELDS = new Set(['publisherId', 'operations', 'cursor', 'expectedCursor'])
const ROW_FIELDS = new Set(['collection', 'record'])
const OPERATION_FIELDS = new Set(['type', 'collection', 'record'])
const EVICTION_FIELDS = new Set(['publisherId', 'reason'])
const PUBLISHER_FIELDS = new Set(['publisherId'])
const SOURCE_CURSOR_FIELDS = new Set(['publisherId', 'catalogEpoch'])
const PUBLISHER_CURSOR_FIELDS = new Set(['publisherId'])
const QUERY_PAGE_FIELDS = new Set(['selectors', 'limit', 'continuation', 'sourceRevision', 'signal'])
const QUERY_CONTINUATION_FIELDS = new Set(['selectorIndex', 'after'])
const EXACT_CONTINUATION_FIELDS = new Set(['namespace', 'normalizedIdentifier', 'publisherId', 'sourceRecordRef', 'entityKind', 'entityId'])
const PUBLICATION_CONTINUATION_FIELDS = new Set(['workEntityId', 'publisherId', 'sourceRecordRef', 'publicationId'])
const RELATION_CONTINUATION_FIELDS = new Set(['relationType', 'fromId', 'publisherId', 'sourceRecordRef', 'toId'])
const SOURCE_REVISION = /^(0|[1-9]\d*):(0|[1-9]\d*)$/
const TOKEN_PREFIX_END = '\u{10ffff}'
const CURSOR_RECORD_FIELDS = Object.freeze([
  'publisherId',
  'catalogEpoch',
  'catalogBootstrapKey',
  'viewFork',
  'viewVersion',
  'sourceHead',
  'lastVerifiedDescriptor',
])
const PUBLISHER_COLLECTIONS = Object.freeze([
  [COLLECTIONS.sourceRecords, INDEXES.publisherPrefix.sourceRecords],
  [COLLECTIONS.sourceCursors, INDEXES.publisherPrefix.sourceCursors],
  [COLLECTIONS.externalReferenceProjections, INDEXES.publisherPrefix.externalReferenceProjections],
  [COLLECTIONS.publicationProjections, INDEXES.publisherPrefix.publicationProjections],
  [COLLECTIONS.renditionProjections, INDEXES.publisherPrefix.renditionProjections],
  [COLLECTIONS.availabilityProjections, INDEXES.publisherPrefix.availabilityProjections],
  [COLLECTIONS.relationshipEdges, INDEXES.publisherPrefix.relationshipEdges],
])

function rejected(error) {
  return Promise.reject(error)
}

function assertOnlyFields(value, allowed, label) {
  for (const name of Object.keys(value)) {
    if (!allowed.has(name)) throw invalidOperation(`${label} contains unsupported field ${name}`, {
      scope: 'operation',
      requested: name,
    })
  }
}

function safeLimit(value) {
  return value === Number.MAX_SAFE_INTEGER ? value : value + 1
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function validateRecord(collection, record) {
  try {
    return validateIndexerRecord(collection, record)
  } catch (error) {
    throw invalidOperation(error.message, { scope: 'record', collection })
  }
}

function snapshotRecord(collection, record) {
  const snapshot = { ...record }
  if (collection === COLLECTIONS.sourceRecords) {
    snapshot.canonicalEnvelope = Buffer.from(record.canonicalEnvelope)
  }
  return Object.freeze(snapshot)
}

function validateEntry(entry, publisherId, operationType, carriesType) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw invalidOperation('index row entry must be { collection, record }', { scope: 'operation' })
  }
  assertOnlyFields(entry, carriesType ? OPERATION_FIELDS : ROW_FIELDS, carriesType ? 'operation' : 'row')
  const collection = entry.collection
  if (!MUTABLE_DATA_COLLECTIONS.has(collection)) {
    throw invalidOperation('rows and operations may use only source/projection collections; supply the cursor separately', {
      scope: 'collection',
      requested: collection,
    })
  }
  const validated = validateRecord(collection, entry.record)
  if (validated.publisherId !== publisherId) throw publisherMismatch(publisherId, validated.publisherId, collection)
  const record = snapshotRecord(collection, validated)
  return {
    type: operationType,
    collection,
    record,
    charge: operationType === 'delete' ? null : measureEncodedIndexerRow(collection, record),
  }
}

function validateCursor(cursor, publisherId) {
  const validated = validateRecord(COLLECTIONS.sourceCursors, cursor)
  if (validated.publisherId !== publisherId) {
    throw publisherMismatch(publisherId, validated.publisherId, COLLECTIONS.sourceCursors)
  }
  const record = snapshotRecord(COLLECTIONS.sourceCursors, validated)
  return { record, charge: measureEncodedIndexerRow(COLLECTIONS.sourceCursors, record) }
}

function prepareExpectedCursor(input, publisherId) {
  if (!Object.hasOwn(input, 'expectedCursor')) return undefined
  if (input.expectedCursor === null) return null
  return validateCursor(input.expectedCursor, publisherId).record
}

function sameCursorRecord(left, right) {
  if (!left || !right) return left === right
  return CURSOR_RECORD_FIELDS.every(name => left[name] === right[name])
}

function prepareSourceCursorSelector(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidOperation('source cursor selector must be an object')
  }
  assertOnlyFields(input, SOURCE_CURSOR_FIELDS, 'source cursor selector')
  const publisherId = validatePublisherId(input.publisherId)
  if (!Number.isSafeInteger(input.catalogEpoch) || input.catalogEpoch < 0) {
    throw invalidOperation('catalogEpoch must be a non-negative safe integer', {
      scope: 'operation',
      requested: input.catalogEpoch,
    })
  }
  return { publisherId, catalogEpoch: input.catalogEpoch }
}

function preparePublisherCursorSelector(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidOperation('publisher cursor selector must be an object')
  }
  assertOnlyFields(input, PUBLISHER_CURSOR_FIELDS, 'publisher cursor selector')
  return { publisherId: validatePublisherId(input.publisherId) }
}

function rowKeyToken(collection, record) {
  return JSON.stringify([collection, ...INDEX_KEY_FIELDS[collection].map(name => record[name])])
}

function assertNoDuplicateKeys(entries) {
  const keys = new Set()
  for (const entry of entries) {
    const key = rowKeyToken(entry.collection, entry.record)
    if (keys.has(key)) {
      throw invalidOperation(`duplicate complete compound key in ${entry.collection}`, {
        scope: 'operation',
        collection: entry.collection,
      })
    }
    keys.add(key)
  }
}

function sumPrepared(entries, cursor) {
  let retainedBytes = cursor.charge
  for (const entry of entries) retainedBytes = safeUsageAdd(retainedBytes, entry.charge, 'preflight byte')
  return { retainedBytes, rows: entries.length + 1 }
}

function effectiveInputRowLimit(limits, publisherId) {
  if (limits.publisher.maxRows < limits.global.maxRows) {
    return { scope: 'publisher', scopeId: publisherId, limit: limits.publisher.maxRows }
  }
  return { scope: 'global', scopeId: GLOBAL_BUCKET, limit: limits.global.maxRows }
}

function prepareReplacement(input, limits, policy) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidOperation('replacement input must be an object')
  assertOnlyFields(input, REPLACEMENT_FIELDS, 'replacement')
  const publisherId = validatePublisherId(input.publisherId)
  if (!Array.isArray(input.rows)) throw invalidOperation('rows must be an array', { scope: 'operation' })
  const rowLimit = effectiveInputRowLimit(limits, publisherId)
  assertWithinBudget({
    scope: rowLimit.scope, scopeId: rowLimit.scopeId, resource: 'rows', current: 0,
    requested: input.rows.length + 1, limit: rowLimit.limit,
  })
  const membership = resolvePublisherMembership(policy, publisherId, limits.trustClasses)
  const rows = input.rows.map(entry => validateEntry(entry, publisherId, 'put', false))
  assertNoDuplicateKeys(rows)
  const cursor = validateCursor(input.cursor, publisherId)
  return {
    publisherId,
    rows,
    cursor,
    expectedCursor: prepareExpectedCursor(input, publisherId),
    membership,
    incoming: sumPrepared(rows, cursor),
  }
}

function prepareChanges(input, limits, policy) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidOperation('change input must be an object')
  assertOnlyFields(input, CHANGE_FIELDS, 'change')
  const publisherId = validatePublisherId(input.publisherId)
  if (!Array.isArray(input.operations)) throw invalidOperation('operations must be an array', { scope: 'operation' })
  const rowLimit = effectiveInputRowLimit(limits, publisherId)
  const maxOperations = rowLimit.limit > Math.floor(Number.MAX_SAFE_INTEGER / 2)
    ? Number.MAX_SAFE_INTEGER
    : rowLimit.limit * 2
  assertWithinBudget({
    scope: rowLimit.scope, scopeId: rowLimit.scopeId, resource: 'operations', current: 0,
    requested: input.operations.length, limit: maxOperations,
  })
  const membership = resolvePublisherMembership(policy, publisherId, limits.trustClasses)
  const operations = input.operations.map(operation => {
    if (!operation || (operation.type !== 'put' && operation.type !== 'delete')) {
      throw invalidOperation('operation type must be put or delete', { scope: 'operation', requested: operation?.type })
    }
    return validateEntry(operation, publisherId, operation.type, true)
  })
  assertNoDuplicateKeys(operations)
  const cursor = validateCursor(input.cursor, publisherId)
  return {
    publisherId,
    operations,
    cursor,
    expectedCursor: prepareExpectedCursor(input, publisherId),
    membership,
  }
}

function counterKey(publisherId, scope, bucketId) {
  return { publisherId, scope, bucketId }
}

function scopedCounterKey(scope, bucketId) {
  return counterKey(CONTROL_PUBLISHER_ID, scope, bucketId)
}

async function getCounter(tx, publisherId, scope, bucketId) {
  return tx.get(COLLECTIONS.usageCounters, counterKey(publisherId, scope, bucketId))
}

async function getPublisherCounter(tx, publisherId) {
  return getCounter(tx, publisherId, 'publisher', PUBLISHER_BUCKET)
}

function usageOf(counter) {
  return counter || EMPTY_USAGE
}

function assertCounterCoherence(publisherId, counter, measured) {
  const current = usageOf(counter)
  if (current.retainedBytes !== measured.retainedBytes || current.rows !== measured.rows) {
    throw invalidOperation(
      `persisted publisher accounting for ${publisherId} does not match stored rows`,
      { scope: 'accounting', scopeId: publisherId, current: { retainedBytes: current.retainedBytes, rows: current.rows }, requested: measured },
    )
  }
}

async function collectPublisherRows(tx, publisherId, expectedRows) {
  const collected = []
  const maximum = Math.max(expectedRows, 0)
  for (const [collection, index] of PUBLISHER_COLLECTIONS) {
    const remaining = maximum - collected.length
    const records = await tx.find(index, { publisherId }, {
      limit: safeLimit(Math.max(remaining, 0)),
    }).toArray()
    if (records.length > remaining) {
      throw invalidOperation(`publisher ${publisherId} stored row count exceeds persisted accounting`, {
        scope: 'accounting',
        scopeId: publisherId,
        current: maximum,
        requested: collected.length + records.length,
      })
    }
    for (const record of records) collected.push({ collection, record })
  }
  return collected
}

function measureStoredRows(entries) {
  let retainedBytes = 0
  for (const entry of entries) {
    retainedBytes = safeUsageAdd(retainedBytes, measureEncodedIndexerRow(entry.collection, entry.record), 'stored byte')
  }
  return { retainedBytes, rows: entries.length }
}

function safeSignedAdd(current, delta, label) {
  const next = current + delta
  if (!Number.isSafeInteger(next)) {
    throw invalidOperation(`${label} exceeds the safe integer range`, {
      scope: 'accounting',
      current,
      requested: next,
    })
  }
  return next
}

function addDelta(deltas, scope, bucketId, retainedBytes, rows) {
  const key = `${scope}\0${bucketId}`
  const current = deltas.get(key)
  if (current) {
    current.retainedBytes = safeSignedAdd(current.retainedBytes, retainedBytes, `${scope} byte delta`)
    current.rows = safeSignedAdd(current.rows, rows, `${scope} row delta`)
  } else {
    deltas.set(key, { scope, bucketId, retainedBytes, rows })
  }
}

function limitForScope(limits, scope, bucketId) {
  if (scope === 'global') return limits.global
  if (scope === 'shard') return limits.shard
  if (scope === 'trustClass') return limits.trustClasses[bucketId] || MAX_USAGE
  throw invalidOperation(`unknown accounting scope ${scope}`, { scope: 'accounting', requested: scope })
}

async function updateAccounting(tx, limits, publisherId, currentPublisher, membership, next) {
  const current = usageOf(currentPublisher)
  assertWithinBudget({
    scope: 'publisher', scopeId: publisherId, resource: 'rows', current: current.rows,
    requested: next.rows, limit: limits.publisher.maxRows,
  })
  assertWithinBudget({
    scope: 'publisher', scopeId: publisherId, resource: 'retainedBytes', current: current.retainedBytes,
    requested: next.retainedBytes, limit: limits.publisher.maxRetainedBytes,
  })

  const deltas = new Map()
  addDelta(deltas, 'global', GLOBAL_BUCKET, next.retainedBytes - current.retainedBytes, next.rows - current.rows)
  if (current.rows > 0 || current.retainedBytes > 0) {
    if (!currentPublisher.shardId || !currentPublisher.trustClass) {
      throw invalidOperation(`publisher ${publisherId} accounting is missing shard/trust membership`, {
        scope: 'accounting', scopeId: publisherId,
      })
    }
    addDelta(deltas, 'shard', currentPublisher.shardId, -current.retainedBytes, -current.rows)
    addDelta(deltas, 'trustClass', currentPublisher.trustClass, -current.retainedBytes, -current.rows)
  }
  if (next.rows > 0 || next.retainedBytes > 0) {
    addDelta(deltas, 'shard', membership.shardId, next.retainedBytes, next.rows)
    addDelta(deltas, 'trustClass', membership.trustClass, next.retainedBytes, next.rows)
  }

  const updates = []
  for (const delta of deltas.values()) {
    const key = scopedCounterKey(delta.scope, delta.bucketId)
    const stored = await tx.get(COLLECTIONS.usageCounters, key)
    const before = usageOf(stored)
    const requested = {
      retainedBytes: safeUsageAdd(before.retainedBytes, delta.retainedBytes, `${delta.scope} retained bytes`),
      rows: safeUsageAdd(before.rows, delta.rows, `${delta.scope} rows`),
    }
    const limit = limitForScope(limits, delta.scope, delta.bucketId)
    assertWithinBudget({
      scope: delta.scope, scopeId: delta.bucketId, resource: 'rows', current: before.rows,
      requested: requested.rows, limit: limit.maxRows,
    })
    assertWithinBudget({
      scope: delta.scope, scopeId: delta.bucketId, resource: 'retainedBytes', current: before.retainedBytes,
      requested: requested.retainedBytes, limit: limit.maxRetainedBytes,
    })
    updates.push({ stored, key, ...requested })
  }

  for (const update of updates) {
    if (update.rows === 0 && update.retainedBytes === 0) {
      if (update.stored) await tx.delete(COLLECTIONS.usageCounters, update.stored)
    } else {
      await tx.upsert(COLLECTIONS.usageCounters, {
        ...update.key,
        retainedBytes: update.retainedBytes,
        rows: update.rows,
      })
    }
  }

  if (next.rows === 0 && next.retainedBytes === 0) {
    if (currentPublisher) await tx.delete(COLLECTIONS.usageCounters, currentPublisher)
  } else {
    await tx.upsert(COLLECTIONS.usageCounters, {
      ...counterKey(publisherId, 'publisher', PUBLISHER_BUCKET),
      retainedBytes: next.retainedBytes,
      rows: next.rows,
      shardId: membership.shardId,
      trustClass: membership.trustClass,
    })
  }
}

async function assertNotTombstoned(tx, publisherId) {
  const tombstone = await tx.get(COLLECTIONS.admissionTombstones, { publisherId })
  if (tombstone) throw tombstonedPublisher(tombstone)
}


async function getPublisherCursor(tx, publisherId) {
  const records = await tx.find(INDEXES.publisherPrefix.sourceCursors, { publisherId }, { limit: 2 }).toArray()
  if (records.length > 1) {
    throw invalidOperation(`publisher ${publisherId} has multiple source cursors`, {
      scope: 'cursor',
      scopeId: publisherId,
    })
  }
  return records[0] || null
}

async function assertExpectedCursor(tx, prepared) {
  if (prepared.expectedCursor === undefined) return
  const stored = await getPublisherCursor(tx, prepared.publisherId)
  if (!sameCursorRecord(stored, prepared.expectedCursor)) {
    throw invalidOperation('source cursor changed since ingestion preparation', {
      scope: 'cursor',
      scopeId: prepared.publisherId,
    })
  }
}

async function assertIncrementalCursorIdentity(tx, prepared) {
  const previous = await getPublisherCursor(tx, prepared.publisherId)
  if (!previous) return
  const next = prepared.cursor.record
  if (previous.catalogEpoch !== next.catalogEpoch ||
      previous.catalogBootstrapKey !== next.catalogBootstrapKey ||
      previous.lastVerifiedDescriptor !== next.lastVerifiedDescriptor) {
    throw invalidOperation('incremental source identity change requires publisher replacement', {
      scope: 'cursor',
      scopeId: prepared.publisherId,
    })
  }
}
async function replaceSlice(tx, prepared, limits) {
  await assertNotTombstoned(tx, prepared.publisherId)
  await assertExpectedCursor(tx, prepared)
  const currentPublisher = await getPublisherCounter(tx, prepared.publisherId)
  const oldRows = await collectPublisherRows(tx, prepared.publisherId, usageOf(currentPublisher).rows)
  assertCounterCoherence(prepared.publisherId, currentPublisher, measureStoredRows(oldRows))
  await updateAccounting(tx, limits, prepared.publisherId, currentPublisher, prepared.membership, prepared.incoming)
  for (const old of oldRows) await tx.delete(old.collection, old.record)
  for (const entry of prepared.rows) await tx.upsert(entry.collection, entry.record)
  await tx.upsert(COLLECTIONS.sourceCursors, prepared.cursor.record)
}

async function applyChanges(tx, prepared, limits) {
  await assertNotTombstoned(tx, prepared.publisherId)
  await assertExpectedCursor(tx, prepared)
  await assertIncrementalCursorIdentity(tx, prepared)
  const currentPublisher = await getPublisherCounter(tx, prepared.publisherId)
  if (!currentPublisher) await collectPublisherRows(tx, prepared.publisherId, 0)
  const current = usageOf(currentPublisher)
  let retainedBytes = current.retainedBytes
  let rows = current.rows
  const writes = []

  for (const operation of prepared.operations) {
    const stored = await tx.get(operation.collection, operation.record)
    if (operation.type === 'put') {
      if (stored) retainedBytes = safeUsageAdd(retainedBytes, -measureEncodedIndexerRow(operation.collection, stored), 'put replacement byte')
      else rows = safeUsageAdd(rows, 1, 'put row')
      retainedBytes = safeUsageAdd(retainedBytes, operation.charge, 'put byte')
      writes.push(operation)
    } else if (stored) {
      retainedBytes = safeUsageAdd(retainedBytes, -measureEncodedIndexerRow(operation.collection, stored), 'delete byte')
      rows = safeUsageAdd(rows, -1, 'delete row')
      writes.push({ ...operation, record: stored })
    }
  }

  const storedCursor = await tx.get(COLLECTIONS.sourceCursors, prepared.cursor.record)
  if (storedCursor) retainedBytes = safeUsageAdd(retainedBytes, -measureEncodedIndexerRow(COLLECTIONS.sourceCursors, storedCursor), 'cursor replacement byte')
  else rows = safeUsageAdd(rows, 1, 'cursor row')
  retainedBytes = safeUsageAdd(retainedBytes, prepared.cursor.charge, 'cursor byte')

  await updateAccounting(tx, limits, prepared.publisherId, currentPublisher, prepared.membership, { retainedBytes, rows })
  for (const operation of writes) {
    if (operation.type === 'put') await tx.upsert(operation.collection, operation.record)
    else await tx.delete(operation.collection, operation.record)
  }
  await tx.upsert(COLLECTIONS.sourceCursors, prepared.cursor.record)
}

async function getTombstoneCounter(tx) {
  return getCounter(tx, CONTROL_PUBLISHER_ID, 'tombstones', TOMBSTONE_BUCKET)
}

async function writeTombstoneCounter(tx, stored, rows) {
  if (rows === 0) {
    if (stored) await tx.delete(COLLECTIONS.usageCounters, stored)
    return
  }
  await tx.upsert(COLLECTIONS.usageCounters, {
    ...scopedCounterKey('tombstones', TOMBSTONE_BUCKET),
    retainedBytes: 0,
    rows,
  })
}

async function evictSlice(tx, prepared, limits) {
  const currentPublisher = await getPublisherCounter(tx, prepared.publisherId)
  const oldRows = await collectPublisherRows(tx, prepared.publisherId, usageOf(currentPublisher).rows)
  assertCounterCoherence(prepared.publisherId, currentPublisher, measureStoredRows(oldRows))
  const existingTombstone = await tx.get(COLLECTIONS.admissionTombstones, { publisherId: prepared.publisherId })
  const tombstoneCounter = await getTombstoneCounter(tx)
  const currentTombstones = usageOf(tombstoneCounter).rows
  const nextTombstones = existingTombstone ? currentTombstones : safeUsageAdd(currentTombstones, 1, 'tombstone row')
  assertWithinBudget({
    scope: 'tombstones', scopeId: TOMBSTONE_BUCKET, resource: 'rows', current: currentTombstones,
    requested: nextTombstones, limit: MAX_TOMBSTONES,
  })

  for (const old of oldRows) await tx.delete(old.collection, old.record)
  if (currentPublisher) {
    await updateAccounting(tx, limits, prepared.publisherId, currentPublisher, null, EMPTY_USAGE)
  }
  await tx.upsert(COLLECTIONS.admissionTombstones, {
    publisherId: prepared.publisherId,
    reason: prepared.reason,
    evictedAt: prepared.evictedAt,
  })
  await writeTombstoneCounter(tx, tombstoneCounter, nextTombstones)
}

async function clearTombstone(tx, publisherId) {
  const tombstone = await tx.get(COLLECTIONS.admissionTombstones, { publisherId })
  if (!tombstone) return
  const counter = await getTombstoneCounter(tx)
  if (!counter || counter.rows === 0) {
    throw invalidOperation('tombstone accounting is missing', { scope: 'accounting', scopeId: publisherId })
  }
  await tx.delete(COLLECTIONS.admissionTombstones, tombstone)
  await writeTombstoneCounter(tx, counter, counter.rows - 1)
}

function usageSnapshotRow(record, idName) {
  return {
    [idName]: record.bucketId,
    retainedBytes: record.retainedBytes,
    rows: record.rows,
  }
}

function validateQuery(selector, limits) {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) {
    throw invalidOperation('exact external-reference selector must be an object', { scope: 'query' })
  }
  const allowed = new Set(['namespace', 'normalizedIdentifier', 'limit', 'reverse', 'checkout'])
  for (const name of Object.keys(selector)) {
    if (!allowed.has(name)) throw invalidOperation(`unsupported exact-reference query control ${name}`, { scope: 'query', requested: name })
  }
  validateBoundedText('namespace', selector.namespace, INDEX_SCHEMA_LIMITS.maxExternalNamespaceBytes)
  validateBoundedText('normalizedIdentifier', selector.normalizedIdentifier, INDEX_SCHEMA_LIMITS.maxExternalIdentifierBytes)
  const query = { namespace: selector.namespace, normalizedIdentifier: selector.normalizedIdentifier }
  if (selector.limit !== undefined) {
    if (!Number.isSafeInteger(selector.limit) || selector.limit < 0 || selector.limit > limits.global.maxRows) {
      throw invalidOperation('query limit must be a bounded unsigned integer within the global row limit', {
        scope: 'query', limit: limits.global.maxRows, requested: selector.limit,
      })
    }
    query.limit = selector.limit
  }
  if (selector.reverse !== undefined) {
    if (typeof selector.reverse !== 'boolean') throw invalidOperation('query reverse control must be boolean', { scope: 'query' })
    query.reverse = selector.reverse
  }
  if (selector.checkout !== undefined) {
    if (!Number.isSafeInteger(selector.checkout) || selector.checkout < -1) {
      throw invalidOperation('query checkout must be -1 or a bounded unsigned integer', { scope: 'query', requested: selector.checkout })
    }
    query.checkout = selector.checkout
  }
  return query
}

function staleRevision() {
  const error = new Error('index query source revision changed')
  error.code = 'INDEX_QUERY_STALE_REVISION'
  throw error
}

function parseSourceRevision(value) {
  if (value === undefined) return null
  if (typeof value !== 'string' || !SOURCE_REVISION.test(value)) {
    throw invalidOperation('query sourceRevision is invalid', { scope: 'query' })
  }
  const [fork, checkout] = value.split(':').map(Number)
  if (!Number.isSafeInteger(fork) || !Number.isSafeInteger(checkout)) {
    throw invalidOperation('query sourceRevision is outside safe integer bounds', { scope: 'query' })
  }
  return { value, fork, checkout }
}

function validateContinuation(value, selectors) {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidOperation('query continuation must be an object', { scope: 'query' })
  }
  assertOnlyFields(value, QUERY_CONTINUATION_FIELDS, 'query continuation')
  if (!Number.isSafeInteger(value.selectorIndex) || value.selectorIndex < 0 || value.selectorIndex >= selectors.length) {
    throw invalidOperation('query continuation selectorIndex is invalid', { scope: 'query' })
  }
  const selector = selectors[value.selectorIndex]
  if (value.after === null) return { selectorIndex: value.selectorIndex, after: null }
  if (!value.after || typeof value.after !== 'object' || Array.isArray(value.after)) {
    throw invalidOperation('query continuation key must be an object', { scope: 'query' })
  }
  if (selector.type === 'exact-external-ref') {
    assertOnlyFields(value.after, EXACT_CONTINUATION_FIELDS, 'exact query continuation')
    if (value.after.namespace !== selector.namespace || value.after.normalizedIdentifier !== selector.identifier) {
      throw invalidOperation('exact query continuation does not match its selector', { scope: 'query' })
    }
    validatePublisherId(value.after.publisherId)
    validateBoundedText('sourceRecordRef', value.after.sourceRecordRef, INDEX_SCHEMA_LIMITS.maxSourceRecordRefBytes)
    validateBoundedText('entityKind', value.after.entityKind, INDEX_SCHEMA_LIMITS.maxEntityKindBytes)
    validateBoundedText('entityId', value.after.entityId, INDEX_SCHEMA_LIMITS.maxEntityIdBytes)
    return { selectorIndex: value.selectorIndex, after: { ...value.after } }
  }
  if (selector.type === 'publication-by-work') {
    assertOnlyFields(value.after, PUBLICATION_CONTINUATION_FIELDS, 'publication query continuation')
    if (value.after.workEntityId !== selector.workEntityId || value.after.publisherId !== selector.publisherId) {
      throw invalidOperation('publication query continuation does not match its selector', { scope: 'query' })
    }
    validateBoundedText('sourceRecordRef', value.after.sourceRecordRef, INDEX_SCHEMA_LIMITS.maxSourceRecordRefBytes)
    validateBoundedText('publicationId', value.after.publicationId, INDEX_SCHEMA_LIMITS.maxRelationEndpointBytes)
    return { selectorIndex: value.selectorIndex, after: { ...value.after } }
  }
  assertOnlyFields(value.after, RELATION_CONTINUATION_FIELDS, 'relation query continuation')
  const expectedType = selector.type === 'title-token-prefix' ? 'title-token' : 'publication-rendition'
  const expectedFrom = selector.type === 'title-token-prefix' ? null : selector.publicationId
  if (
    value.after.relationType !== expectedType ||
    (expectedFrom === null ? !value.after.fromId.startsWith(selector.prefix) : value.after.fromId !== expectedFrom) ||
    (selector.publisherId !== undefined && value.after.publisherId !== selector.publisherId)
  ) {
    throw invalidOperation('relation query continuation does not match its selector', { scope: 'query' })
  }
  validatePublisherId(value.after.publisherId)
  validateBoundedText('fromId', value.after.fromId, INDEX_SCHEMA_LIMITS.maxRelationEndpointBytes)
  validateBoundedText('sourceRecordRef', value.after.sourceRecordRef, INDEX_SCHEMA_LIMITS.maxSourceRecordRefBytes)
  validateBoundedText('toId', value.after.toId, INDEX_SCHEMA_LIMITS.maxRelationEndpointBytes)
  return { selectorIndex: value.selectorIndex, after: { ...value.after } }
}

function querySignal(value) {
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || typeof value.aborted !== 'boolean') {
    throw invalidOperation('query signal is invalid', { scope: 'query' })
  }
  return value
}

function checkQueryAbort(signal) {
  if (!signal?.aborted) return
  const error = new Error('index query aborted')
  error.name = 'AbortError'
  error.code = 'INDEX_QUERY_ABORTED'
  throw error
}

function prepareQueryPage(input, limits) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidOperation('index query page input must be an object', { scope: 'query' })
  }
  assertOnlyFields(input, QUERY_PAGE_FIELDS, 'index query page input')
  const selectors = normalizeIndexQuerySelectors(input.selectors)
  const maximum = Math.min(MAX_INDEX_QUERY_RESULTS, limits.global.maxRows)
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > maximum) {
    throw invalidOperation('index query page limit is outside its bound', { scope: 'query', limit: maximum, requested: input.limit })
  }
  const sourceRevision = parseSourceRevision(input.sourceRevision)
  const continuation = validateContinuation(input.continuation, selectors)
  if (continuation && sourceRevision === null) {
    throw invalidOperation('query continuation requires sourceRevision', { scope: 'query' })
  }
  return { selectors, limit: input.limit, continuation, sourceRevision, signal: querySignal(input.signal) }
}

function exactContinuation(row) {
  return {
    namespace: row.namespace,
    normalizedIdentifier: row.normalizedIdentifier,
    publisherId: row.publisherId,
    sourceRecordRef: row.sourceRecordRef,
    entityKind: row.entityKind,
    entityId: row.entityId,
  }
}

function relationContinuation(row) {
  return {
    relationType: row.relationType,
    fromId: row.fromId,
    publisherId: row.publisherId,
    sourceRecordRef: row.sourceRecordRef,
    toId: row.toId,
  }
}

function publicationContinuation(row) {
  return {
    workEntityId: row.workEntityId,
    publisherId: row.publisherId,
    sourceRecordRef: row.sourceRecordRef,
    publicationId: row.publicationId,
  }
}

async function queryIndexPage(tx, prepared) {
  checkQueryAbort(prepared.signal)
  const currentRevision = tx.sourceRevision
  if (prepared.sourceRevision && prepared.sourceRevision.value !== currentRevision) staleRevision()
  const checkout = Number(currentRevision.slice(currentRevision.indexOf(':') + 1))
  const results = []
  let selectorIndex = prepared.continuation?.selectorIndex ?? 0
  let after = prepared.continuation?.after ?? null

  while (selectorIndex < prepared.selectors.length && results.length < prepared.limit) {
    checkQueryAbort(prepared.signal)
    const selector = prepared.selectors[selectorIndex]
    const remaining = prepared.limit - results.length
    let index
    let range
    if (selector.type === 'exact-external-ref') {
      index = INDEXES.externalReferenceExact
      const exact = { namespace: selector.namespace, normalizedIdentifier: selector.identifier }
      range = after === null
        ? { gte: exact, lte: exact, checkout, limit: remaining + 1 }
        : { gt: after, lte: exact, checkout, limit: remaining + 1 }
    } else if (selector.type === 'title-token-prefix') {
      index = INDEXES.tokenPrefix
      const lower = { relationType: 'title-token', fromId: selector.prefix }
      const upper = { relationType: 'title-token', fromId: `${selector.prefix}${TOKEN_PREFIX_END}` }
      range = after === null
        ? { gte: lower, lte: upper, checkout, limit: remaining + 1 }
        : { gt: after, lte: upper, checkout, limit: remaining + 1 }
    } else if (selector.type === 'publication-by-work') {
      index = INDEXES.publicationByWork
      const exact = { workEntityId: selector.workEntityId, publisherId: selector.publisherId }
      range = after === null
        ? { gte: exact, lte: exact, checkout, limit: remaining + 1 }
        : { gt: after, lte: exact, checkout, limit: remaining + 1 }
    } else {
      index = INDEXES.relationshipByFrom
      const exact = {
        relationType: 'publication-rendition',
        fromId: selector.publicationId,
        publisherId: selector.publisherId,
      }
      range = after === null
        ? { gte: exact, lte: exact, checkout, limit: remaining + 1 }
        : { gt: after, lte: exact, checkout, limit: remaining + 1 }
    }
    const found = await tx.find(index, range).toArray()
    checkQueryAbort(prepared.signal)
    const pageRows = found.slice(0, remaining)
    if (selector.type === 'rendition-by-publication') {
      for (const edge of pageRows) {
        checkQueryAbort(prepared.signal)
        const exact = {
          renditionId: edge.toId,
          publisherId: selector.publisherId,
          sourceRecordRef: edge.sourceRecordRef,
        }
        const renditions = await tx.find(INDEXES.renditionExact, {
          gte: exact,
          lte: exact,
          checkout,
          limit: 2,
        }).toArray()
        if (renditions.length !== 1) {
          throw invalidOperation('publication rendition relation does not resolve exactly', {
            scope: 'query',
            scopeId: edge.toId,
            requested: renditions.length,
          })
        }
        results.push({ ...renditions[0], publicationId: selector.publicationId })
      }
    } else {
      results.push(...pageRows)
    }
    if (found.length > remaining) {
      const last = pageRows[pageRows.length - 1]
      const continuation = selector.type === 'exact-external-ref'
        ? exactContinuation(last)
        : selector.type === 'publication-by-work'
          ? publicationContinuation(last)
          : relationContinuation(last)
      return {
        results,
        continuation: { selectorIndex, after: continuation },
        sourceRevision: currentRevision,
      }
    }
    selectorIndex++
    after = null
  }

  return {
    results,
    continuation: selectorIndex < prepared.selectors.length ? { selectorIndex, after: null } : null,
    sourceRevision: currentRevision,
  }
}

async function readScope(tx, scope, maximum) {
  const rows = await tx.find(INDEXES.usageByScope, { scope }, { limit: safeLimit(maximum) }).toArray()
  if (rows.length > maximum) {
    throw invalidOperation(`${scope} counter count exceeds its persisted bound`, {
      scope: 'accounting', scopeId: scope, current: maximum, requested: rows.length,
    })
  }
  return rows
}

function accountingMismatch(scope, current, requested) {
  throw invalidOperation(`${scope} accounting does not match publisher counters`, {
    scope: 'accounting',
    scopeId: scope,
    current,
    requested,
  })
}

function addUsageAggregate(aggregate, record, label) {
  aggregate.retainedBytes = safeUsageAdd(aggregate.retainedBytes, record.retainedBytes, `${label} retained bytes`)
  aggregate.rows = safeUsageAdd(aggregate.rows, record.rows, `${label} rows`)
}

function assertScopeAccounting(scope, records, expected) {
  if (records.length !== expected.size) accountingMismatch(scope, records.length, expected.size)
  for (const record of records) {
    const aggregate = expected.get(record.bucketId)
    if (!aggregate
      || aggregate.retainedBytes !== record.retainedBytes
      || aggregate.rows !== record.rows) {
      accountingMismatch(scope, record, aggregate || null)
    }
  }
}

function assertSnapshotAccounting(global, publisherRows, shardRows, trustRows) {
  const publisherTotal = { retainedBytes: 0, rows: 0 }
  const shards = new Map()
  const trustClasses = new Map()
  for (const publisher of publisherRows) {
    if (!publisher.shardId || !publisher.trustClass) {
      accountingMismatch('publisher membership', publisher, null)
    }
    addUsageAggregate(publisherTotal, publisher, 'publisher aggregate')
    let shard = shards.get(publisher.shardId)
    if (!shard) {
      shard = { retainedBytes: 0, rows: 0 }
      shards.set(publisher.shardId, shard)
    }
    addUsageAggregate(shard, publisher, `shard ${publisher.shardId}`)
    let trustClass = trustClasses.get(publisher.trustClass)
    if (!trustClass) {
      trustClass = { retainedBytes: 0, rows: 0 }
      trustClasses.set(publisher.trustClass, trustClass)
    }
    addUsageAggregate(trustClass, publisher, `trust class ${publisher.trustClass}`)
  }
  if (publisherTotal.retainedBytes !== global.retainedBytes || publisherTotal.rows !== global.rows) {
    accountingMismatch('global', global, publisherTotal)
  }
  assertScopeAccounting('shard', shardRows, shards)
  assertScopeAccounting('trustClass', trustRows, trustClasses)
}

async function buildSnapshot(tx) {
  const globalCounter = await tx.get(COLLECTIONS.usageCounters, scopedCounterKey('global', GLOBAL_BUCKET))
  const global = usageOf(globalCounter)
  const maximumPublishers = global.rows
  const publisherRows = await readScope(tx, 'publisher', maximumPublishers)
  const shardRows = await readScope(tx, 'shard', maximumPublishers)
  const trustRows = await readScope(tx, 'trustClass', maximumPublishers)
  assertSnapshotAccounting(global, publisherRows, shardRows, trustRows)
  const tombstoneCounter = await getTombstoneCounter(tx)
  const tombstoneCount = usageOf(tombstoneCounter).rows
  const tombstones = await tx.find(COLLECTIONS.admissionTombstones, {
    gte: { publisherId: CONTROL_PUBLISHER_ID },
    lte: { publisherId: 'f'.repeat(64) },
  }, { limit: safeLimit(tombstoneCount) }).toArray()
  if (tombstones.length !== tombstoneCount) {
    throw invalidOperation('tombstone accounting does not match stored tombstones', {
      scope: 'accounting', scopeId: 'tombstones', current: tombstoneCount, requested: tombstones.length,
    })
  }

  const shards = shardRows.map(record => usageSnapshotRow(record, 'shardId'))
    .sort((a, b) => compareText(a.shardId, b.shardId))
  const publishers = publisherRows.map(record => ({
    publisherId: record.publisherId,
    shardId: record.shardId,
    trustClass: record.trustClass,
    retainedBytes: record.retainedBytes,
    rows: record.rows,
  })).sort((a, b) => compareText(a.publisherId, b.publisherId))
  const trustClasses = trustRows.map(record => usageSnapshotRow(record, 'trustClass'))
    .sort((a, b) => compareText(a.trustClass, b.trustClass))
  tombstones.sort((a, b) => compareText(a.publisherId, b.publisherId))
  return {
    global: { retainedBytes: global.retainedBytes, rows: global.rows },
    shards,
    publishers,
    trustClasses,
    tombstones,
  }
}

export async function createIndexerStore(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('indexer options are required')
  assertOnlyFields(options, OPTION_FIELDS, 'indexer options')
  const limits = validateAdmissionLimits(options.limits)
  const policy = validateAdmissionPolicy(options.policy)
  const db = await openIndexerDatabase(options.store, { name: INDEXER_CORE_NAME })
  let accepting = true
  let closePromise = null

  const accept = (prepare, run) => {
    if (!accepting) return rejected(new Error('indexer store is closed'))
    try {
      const prepared = prepare()
      return db.validatedTransaction(tx => run(tx, prepared))
    } catch (error) {
      return rejected(error)
    }
  }


  const admissionLimitsFor = (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw invalidOperation('publisher limit selector must be an object')
    }
    assertOnlyFields(input, PUBLISHER_FIELDS, 'publisher limit selector')
    const publisherId = validatePublisherId(input.publisherId)
    const membership = resolvePublisherMembership(policy, publisherId, limits.trustClasses)
    const trust = limits.trustClasses[membership.trustClass]
    return Object.freeze({
      maxRetainedBytes: Math.min(
        limits.global.maxRetainedBytes,
        limits.shard.maxRetainedBytes,
        limits.publisher.maxRetainedBytes,
        trust.maxRetainedBytes,
      ),
      maxRows: Math.min(
        limits.global.maxRows,
        limits.shard.maxRows,
        limits.publisher.maxRows,
        trust.maxRows,
      ),
    })
  }
  return Object.freeze({
    replacePublisherSlice(input) {
      return accept(() => prepareReplacement(input, limits, policy), (tx, prepared) => replaceSlice(tx, prepared, limits))
    },
    applyPublisherChanges(input) {
      return accept(() => prepareChanges(input, limits, policy), (tx, prepared) => applyChanges(tx, prepared, limits))
    },
    getSourceCursor(input) {
      return accept(() => prepareSourceCursorSelector(input), async (tx, selector) => {
        const record = await tx.get(COLLECTIONS.sourceCursors, selector)
        return record ? snapshotRecord(COLLECTIONS.sourceCursors, record) : null
      })
    },
    getPublisherSourceCursor(input) {
      return accept(() => preparePublisherCursorSelector(input), async (tx, selector) => {
        const record = await getPublisherCursor(tx, selector.publisherId)
        return record ? snapshotRecord(COLLECTIONS.sourceCursors, record) : null
      })
    },
    async getPublisherAdmissionLimits(input) {
      return admissionLimitsFor(input)
    },
    queryExactExternalRef(selector) {
      return accept(() => validateQuery(selector, limits), async (tx, query) => {
        return tx.find(INDEXES.externalReferenceExact, query).toArray()
      })
    },
    queryIndexPage(input) {
      return accept(() => prepareQueryPage(input, limits), (tx, prepared) => queryIndexPage(tx, prepared))
    },
    snapshotUsage() {
      return accept(() => null, tx => buildSnapshot(tx))
    },
    evictPublisherSlice(input) {
      return accept(() => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidOperation('eviction input must be an object')
        assertOnlyFields(input, EVICTION_FIELDS, 'eviction')
        const publisherId = validatePublisherId(input.publisherId)
        const reason = validateBoundedText('eviction reason', input.reason, INDEX_SCHEMA_LIMITS.maxAdmissionReasonBytes)
        return { publisherId, reason, evictedAt: resolveAdmissionTime(policy) }
      }, (tx, prepared) => evictSlice(tx, prepared, limits))
    },
    clearPublisherTombstone(input) {
      return accept(() => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidOperation('clear tombstone input must be an object')
        assertOnlyFields(input, PUBLISHER_FIELDS, 'clear tombstone')
        return validatePublisherId(input.publisherId)
      }, (tx, publisherId) => clearTombstone(tx, publisherId))
    },
    close() {
      if (closePromise) return closePromise
      accepting = false
      closePromise = db.close()
      return closePromise
    },
  })
}
