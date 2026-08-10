import HyperDB from 'hyperdb'

import { RECORD_LIMITS } from '../records/index.js'
import indexDbDefinition from './index-hyperdb-spec/hyperdb/index.js'

const PREFIX = '@peartubeIndex/'
export const CONTROL_PUBLISHER_ID = '0'.repeat(64)

export const COLLECTIONS = Object.freeze({
  sourceRecords: `${PREFIX}sourceRecords`,
  sourceCursors: `${PREFIX}sourceCursors`,
  externalReferenceProjections: `${PREFIX}externalReferenceProjections`,
  publicationProjections: `${PREFIX}publicationProjections`,
  renditionProjections: `${PREFIX}renditionProjections`,
  availabilityProjections: `${PREFIX}availabilityProjections`,
  relationshipEdges: `${PREFIX}relationshipEdges`,
  usageCounters: `${PREFIX}usageCounters`,
  admissionTombstones: `${PREFIX}admissionTombstones`,
})

export const DATA_COLLECTIONS = Object.freeze([
  COLLECTIONS.sourceRecords,
  COLLECTIONS.sourceCursors,
  COLLECTIONS.externalReferenceProjections,
  COLLECTIONS.publicationProjections,
  COLLECTIONS.renditionProjections,
  COLLECTIONS.availabilityProjections,
  COLLECTIONS.relationshipEdges,
])

export const INDEXES = Object.freeze({
  externalReferenceExact: `${PREFIX}external-reference-exact`,
  entityExact: `${PREFIX}entity-exact`,
  publicationExact: `${PREFIX}publication-exact`,
  publicationByWork: `${PREFIX}publication-by-work`,
  normalizedTitle: `${PREFIX}normalized-title`,
  assetExact: `${PREFIX}asset-exact`,
  renditionExact: `${PREFIX}rendition-exact`,
  availabilityByAsset: `${PREFIX}availability-by-asset`,
  relationshipByType: `${PREFIX}relationship-by-type`,
  relationshipByFrom: `${PREFIX}relationship-by-from`,
  relationshipByTo: `${PREFIX}relationship-by-to`,
  tokenPrefix: `${PREFIX}token-prefix`,
  usageByScope: `${PREFIX}usage-by-scope`,
  publisherPrefix: Object.freeze({
    sourceRecords: `${PREFIX}source-records-by-publisher`,
    sourceCursors: `${PREFIX}source-cursors-by-publisher`,
    externalReferenceProjections: `${PREFIX}external-references-by-publisher`,
    publicationProjections: `${PREFIX}publications-by-publisher`,
    renditionProjections: `${PREFIX}renditions-by-publisher`,
    availabilityProjections: `${PREFIX}availability-by-publisher`,
    relationshipEdges: `${PREFIX}relationships-by-publisher`,
  }),
})

const frozenKey = (...fields) => Object.freeze(fields)
export const INDEX_KEY_FIELDS = Object.freeze({
  [COLLECTIONS.sourceRecords]: frozenKey('publisherId', 'catalogEpoch', 'recordId'),
  [COLLECTIONS.sourceCursors]: frozenKey('publisherId', 'catalogEpoch'),
  [COLLECTIONS.externalReferenceProjections]: frozenKey('publisherId', 'sourceRecordRef', 'namespace', 'normalizedIdentifier', 'entityKind', 'entityId'),
  [COLLECTIONS.publicationProjections]: frozenKey('publisherId', 'sourceRecordRef', 'publicationId'),
  [COLLECTIONS.renditionProjections]: frozenKey('publisherId', 'sourceRecordRef', 'renditionId'),
  [COLLECTIONS.availabilityProjections]: frozenKey('publisherId', 'sourceRecordRef', 'assetId', 'observerId', 'observedAt'),
  [COLLECTIONS.relationshipEdges]: frozenKey('publisherId', 'sourceRecordRef', 'relationType', 'fromId', 'toId'),
  [COLLECTIONS.usageCounters]: frozenKey('publisherId', 'scope', 'bucketId'),
  [COLLECTIONS.admissionTombstones]: frozenKey('publisherId'),
  [INDEXES.externalReferenceExact]: frozenKey('namespace', 'normalizedIdentifier', 'publisherId', 'sourceRecordRef', 'entityKind', 'entityId'),
  [INDEXES.entityExact]: frozenKey('entityKind', 'entityId', 'publisherId', 'sourceRecordRef', 'namespace', 'normalizedIdentifier'),
  [INDEXES.publicationExact]: frozenKey('publicationId', 'publisherId', 'sourceRecordRef'),
  [INDEXES.publicationByWork]: frozenKey('workEntityId', 'publisherId', 'sourceRecordRef', 'publicationId'),
  [INDEXES.normalizedTitle]: frozenKey('normalizedTitle', 'publisherId', 'sourceRecordRef', 'publicationId'),
  [INDEXES.assetExact]: frozenKey('assetId', 'publisherId', 'sourceRecordRef', 'renditionId'),
  [INDEXES.renditionExact]: frozenKey('renditionId', 'publisherId', 'sourceRecordRef'),
  [INDEXES.availabilityByAsset]: frozenKey('assetId', 'publisherId', 'sourceRecordRef', 'observerId', 'observedAt'),
  [INDEXES.relationshipByType]: frozenKey('relationType', 'publisherId', 'sourceRecordRef', 'fromId', 'toId'),
  [INDEXES.relationshipByFrom]: frozenKey('relationType', 'fromId', 'publisherId', 'sourceRecordRef', 'toId'),
  [INDEXES.relationshipByTo]: frozenKey('relationType', 'toId', 'publisherId', 'sourceRecordRef', 'fromId'),
  [INDEXES.tokenPrefix]: frozenKey('relationType', 'fromId', 'publisherId', 'sourceRecordRef', 'toId'),
  [INDEXES.usageByScope]: frozenKey('scope', 'bucketId', 'publisherId'),
  [INDEXES.publisherPrefix.sourceRecords]: frozenKey('publisherId', 'catalogEpoch', 'recordId'),
  [INDEXES.publisherPrefix.sourceCursors]: frozenKey('publisherId', 'catalogEpoch'),
  [INDEXES.publisherPrefix.externalReferenceProjections]: frozenKey('publisherId', 'sourceRecordRef', 'namespace', 'normalizedIdentifier', 'entityKind', 'entityId'),
  [INDEXES.publisherPrefix.publicationProjections]: frozenKey('publisherId', 'sourceRecordRef', 'publicationId'),
  [INDEXES.publisherPrefix.renditionProjections]: frozenKey('publisherId', 'sourceRecordRef', 'renditionId'),
  [INDEXES.publisherPrefix.availabilityProjections]: frozenKey('publisherId', 'sourceRecordRef', 'assetId', 'observerId', 'observedAt'),
  [INDEXES.publisherPrefix.relationshipEdges]: frozenKey('publisherId', 'sourceRecordRef', 'relationType', 'fromId', 'toId'),
})

export const INDEX_SCHEMA_LIMITS = Object.freeze({
  maxEnvelopeBytes: RECORD_LIMITS.maxEnvelopeBytes,
  maxRecordTypeBytes: RECORD_LIMITS.maxRecordTypeBytes,
  maxRecordIdBytes: 256,
  maxSourceRecordRefBytes: 256,
  maxExternalNamespaceBytes: 64,
  maxExternalIdentifierBytes: 512,
  maxEntityKindBytes: 64,
  maxEntityIdBytes: 512,
  maxPublicationIdBytes: 512,
  maxManifestIdBytes: 512,
  maxNormalizedTitleBytes: 1024,
  maxProvenanceSummaryBytes: 2048,
  maxRenditionIdBytes: 512,
  maxAssetIdBytes: 512,
  maxMediaDescriptorBytes: 256,
  maxRelationshipTypeBytes: 64,
  maxRelationEndpointBytes: 512,
  maxDescriptorRefBytes: 512,
  maxControlIdBytes: 256,
  maxAdmissionReasonBytes: 512,
})

const UINT_MAX = Number.MAX_SAFE_INTEGER
const HEX_32 = /^[0-9a-f]{64}$/
const PROJECTION_STATES = new Set(['active', 'retracted', 'superseded'])
const AVAILABILITY_STATES = new Set(['available', 'unavailable', 'unknown'])
const CONTROL_SCOPES = new Set(['global', 'shard', 'publisher', 'trustClass', 'tombstones'])
const RELATION_TYPES = new Set([
  'work-edition', 'work-rendition', 'publication-work', 'publication-edition',
  'publication-rendition', 'rendition-asset', 'source-projection', 'title-token',
])

const field = (limit, options = {}) => ({ kind: 'string', limit, required: options.required !== false, ...options })
const uint = (options = {}) => ({ kind: 'uint', required: options.required !== false, ...options })
const identity = (options = {}) => ({ kind: 'identity', required: options.required !== false, ...options })
const protocolId = (options = {}) => ({ kind: 'protocolId', required: options.required !== false, ...options })

const DEFINITIONS = Object.freeze({
  [COLLECTIONS.sourceRecords]: {
    key: ['publisherId', 'catalogEpoch', 'recordId'],
    fields: {
      publisherId: identity(), catalogEpoch: uint(), recordId: protocolId(),
      recordType: field(INDEX_SCHEMA_LIMITS.maxRecordTypeBytes), sourceSequence: uint(),
      canonicalEnvelope: { kind: 'buffer', limit: INDEX_SCHEMA_LIMITS.maxEnvelopeBytes, required: true },
      projectionState: { kind: 'enum', values: PROJECTION_STATES, required: true }, ingestedAt: uint(),
    },
  },
  [COLLECTIONS.sourceCursors]: {
    key: ['publisherId', 'catalogEpoch'],
    fields: {
      publisherId: identity(), catalogEpoch: uint(), catalogBootstrapKey: identity(),
      viewFork: uint(), viewVersion: uint(), sourceHead: uint(),
      lastVerifiedDescriptor: field(INDEX_SCHEMA_LIMITS.maxDescriptorRefBytes),
    },
  },
  [COLLECTIONS.externalReferenceProjections]: {
    key: ['publisherId', 'sourceRecordRef', 'namespace', 'normalizedIdentifier', 'entityKind', 'entityId'],
    fields: {
      publisherId: identity(), sourceRecordRef: field(INDEX_SCHEMA_LIMITS.maxSourceRecordRefBytes),
      namespace: field(INDEX_SCHEMA_LIMITS.maxExternalNamespaceBytes),
      normalizedIdentifier: field(INDEX_SCHEMA_LIMITS.maxExternalIdentifierBytes),
      entityKind: field(INDEX_SCHEMA_LIMITS.maxEntityKindBytes), entityId: field(INDEX_SCHEMA_LIMITS.maxEntityIdBytes),
      evidenceWeight: uint({ required: false }),
    },
  },
  [COLLECTIONS.publicationProjections]: {
    key: ['publisherId', 'sourceRecordRef', 'publicationId'],
    fields: {
      publisherId: identity(), sourceRecordRef: field(INDEX_SCHEMA_LIMITS.maxSourceRecordRefBytes),
      publicationId: protocolId(), workEntityId: field(INDEX_SCHEMA_LIMITS.maxEntityIdBytes),
      normalizedTitle: field(INDEX_SCHEMA_LIMITS.maxNormalizedTitleBytes), releaseYear: uint({ required: false, max: 9999 }),
      manifestId: protocolId(),
      provenanceSummary: field(INDEX_SCHEMA_LIMITS.maxProvenanceSummaryBytes, { required: false }),
    },
  },
  [COLLECTIONS.renditionProjections]: {
    key: ['publisherId', 'sourceRecordRef', 'renditionId'],
    fields: {
      publisherId: identity(), sourceRecordRef: field(INDEX_SCHEMA_LIMITS.maxSourceRecordRefBytes),
      renditionId: protocolId(), assetId: protocolId(),
      format: field(INDEX_SCHEMA_LIMITS.maxMediaDescriptorBytes, { required: false }),
      codec: field(INDEX_SCHEMA_LIMITS.maxMediaDescriptorBytes, { required: false }),
      dimensions: field(INDEX_SCHEMA_LIMITS.maxMediaDescriptorBytes, { required: false }),
      mediaFeatures: field(INDEX_SCHEMA_LIMITS.maxMediaDescriptorBytes, { required: false }),
      byteLength: uint({ required: false }),
    },
  },
  [COLLECTIONS.availabilityProjections]: {
    key: ['publisherId', 'sourceRecordRef', 'assetId', 'observerId', 'observedAt'],
    fields: {
      publisherId: identity(), sourceRecordRef: field(INDEX_SCHEMA_LIMITS.maxSourceRecordRefBytes),
      assetId: protocolId(), observerId: identity(),
      observedSeeders: uint(), observedCompleteSeeders: uint(), observedAt: uint(), expiresAt: uint(),
      availabilityState: { kind: 'enum', values: AVAILABILITY_STATES, required: true },
    },
  },
  [COLLECTIONS.relationshipEdges]: {
    key: ['publisherId', 'sourceRecordRef', 'relationType', 'fromId', 'toId'],
    fields: {
      publisherId: identity(), sourceRecordRef: field(INDEX_SCHEMA_LIMITS.maxSourceRecordRefBytes),
      relationType: { kind: 'enum', values: RELATION_TYPES, required: true },
      fromId: field(INDEX_SCHEMA_LIMITS.maxRelationEndpointBytes),
      toId: field(INDEX_SCHEMA_LIMITS.maxRelationEndpointBytes),
    },
  },
  [COLLECTIONS.usageCounters]: {
    key: ['publisherId', 'scope', 'bucketId'],
    fields: {
      publisherId: identity(),
      scope: { kind: 'enum', values: CONTROL_SCOPES, required: true },
      bucketId: field(INDEX_SCHEMA_LIMITS.maxControlIdBytes),
      retainedBytes: uint(),
      rows: uint(),
      shardId: field(INDEX_SCHEMA_LIMITS.maxControlIdBytes, { required: false }),
      trustClass: field(INDEX_SCHEMA_LIMITS.maxControlIdBytes, { required: false }),
    },
  },
  [COLLECTIONS.admissionTombstones]: {
    key: ['publisherId'],
    fields: {
      publisherId: identity(),
      reason: field(INDEX_SCHEMA_LIMITS.maxAdmissionReasonBytes),
      evictedAt: uint(),
    },
  },
})

function invalid(name, reason) {
  throw new TypeError(`${name} ${reason}`)
}

function validateField(name, value, spec) {
  if (value === undefined || value === null) {
    if (spec.required) invalid(name, 'is required')
    return
  }
  if (spec.kind === 'identity') {
    if (typeof value !== 'string' || !HEX_32.test(value)) invalid(name, 'must be canonical lowercase 64-hex')
    return
  }
  if (spec.kind === 'protocolId') {
    if (typeof value !== 'string' || !HEX_32.test(value)) invalid(name, 'must be a canonical lowercase 32-byte protocol ID')
    return
  }
  if (spec.kind === 'string') {
    if (typeof value !== 'string' || value.length === 0) invalid(name, 'must be a non-empty string')
    if (Buffer.byteLength(value, 'utf8') > spec.limit) invalid(name, 'exceeds its UTF-8 byte limit')
    return
  }
  if (spec.kind === 'uint') {
    const max = spec.max ?? UINT_MAX
    if (!Number.isSafeInteger(value) || value < 0 || value > max) invalid(name, 'must be a bounded unsigned integer')
    return
  }
  if (spec.kind === 'buffer') {
    if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) invalid(name, 'must be bytes')
    if (value.byteLength > spec.limit) invalid(name, 'exceeds its byte limit')
    return
  }
  if (spec.kind === 'enum' && !spec.values.has(value)) invalid(name, 'has an invalid state')
}

export function validateIndexerRecord(collection, record) {
  const definition = DEFINITIONS[collection]
  if (!definition) throw new TypeError(`unknown index collection ${collection}`)
  if (!record || typeof record !== 'object' || Array.isArray(record)) invalid('record', 'must be an object')
  for (const name of Object.keys(record)) {
    if (!definition.fields[name]) invalid(name, 'is not a schema field')
  }
  for (const [name, spec] of Object.entries(definition.fields)) validateField(name, record[name], spec)
  return record
}

const DATA_COLLECTION_SET = new Set(DATA_COLLECTIONS)

export function measureEncodedIndexerRow(collection, record) {
  if (!DATA_COLLECTION_SET.has(collection)) throw new TypeError('encoded charge requires a data collection')
  validateIndexerRecord(collection, record)
  const generated = indexDbDefinition.resolveCollection(collection)
  const collectionVersion = Math.min(indexDbDefinition.versions.db, generated.version)
  let bytes = generated.encodeKey(record).byteLength
    + generated.encodeValue(indexDbDefinition.versions.schema, collectionVersion, record).byteLength
  for (const index of generated.indexes) {
    const pointer = index.encodeValue(record)
    for (const key of index.encodeIndexKeys(record, null)) {
      bytes += key.byteLength + pointer.byteLength
      if (!Number.isSafeInteger(bytes)) throw new RangeError('encoded row charge exceeds the safe integer range')
    }
  }
  return bytes
}

const RANGE_KEYS = new Set(['gt', 'gte', 'lt', 'lte'])
const QUERY_OPTION_KEYS = new Set(['limit', 'reverse', 'checkout'])

function exactPrefixRange(index, query = {}, options) {
  const keyFields = INDEX_KEY_FIELDS[index]
  if (!keyFields) throw new TypeError(`unknown index ${index}`)
  const combined = options ? { ...query, ...options } : query
  const selector = {}
  const controls = {}
  let hasRange = false
  for (const [name, value] of Object.entries(combined)) {
    if (RANGE_KEYS.has(name)) {
      hasRange = true
      controls[name] = value
    } else if (QUERY_OPTION_KEYS.has(name)) {
      controls[name] = value
    } else {
      selector[name] = value
    }
  }
  const selectorNames = Object.keys(selector)
  if (hasRange && selectorNames.length > 0) {
    throw new TypeError('direct compound selector cannot be mixed with explicit range bounds')
  }
  if (hasRange) return combined
  if (selectorNames.length === 0) {
    throw new TypeError('direct compound selector must include a non-empty index prefix')
  }
  if (selectorNames.length > keyFields.length) {
    throw new TypeError('direct compound selector is not a contiguous index prefix')
  }
  const firstKeyField = keyFields[0]
  for (let i = 0; i < selectorNames.length; i++) {
    const expected = keyFields[i]
    if (!Object.hasOwn(selector, expected) || selector[expected] === undefined) {
      throw new TypeError(`direct compound selector is not a contiguous index prefix beginning with ${firstKeyField}`)
    }
  }
  return { ...controls, gte: selector, lte: selector }
}

function findWithExactPrefix(database, index, query, options) {
  return database.find(index, exactPrefixRange(index, query, options))
}

function findOneWithExactPrefix(database, index, query, options) {
  return database.findOne(index, exactPrefixRange(index, query, options))
}

const STORE_SERIALIZERS = new WeakMap()

function acquireSerializer(owner, id) {
  let serializers = STORE_SERIALIZERS.get(owner)
  if (!serializers) {
    serializers = new Map()
    STORE_SERIALIZERS.set(owner, serializers)
  }
  let state = serializers.get(id)
  if (!state) {
    state = { tail: Promise.resolve(), refs: 0 }
    serializers.set(id, state)
  }
  state.refs++
  return {
    state,
    release() {
      if (--state.refs === 0) serializers.delete(id)
      if (serializers.size === 0) STORE_SERIALIZERS.delete(owner)
    },
  }
}

function createSurface(db, serializer) {
  let accepting = true
  let closePromise = null
  const pending = new Set()
  const assertAccepting = () => {
    if (!accepting) throw new Error('index database is closed')
  }
  const enqueue = (fn) => {
    assertAccepting()
    const next = serializer.state.tail.then(fn, fn)
    serializer.state.tail = next.catch(() => {})
    pending.add(next)
    next.then(() => pending.delete(next), () => pending.delete(next))
    return next
  }

  return Object.freeze({
    async insert(collection, record) {
      validateIndexerRecord(collection, record)
      return enqueue(async () => {
        const tx = await db.exclusiveTransaction()
        try {
          if (await tx.get(collection, record)) throw new Error('complete compound key already exists')
          await tx.insert(collection, record)
          await tx.flush()
        } finally {
          await tx.close()
        }
      })
    },
    find(index, query, options) { assertAccepting(); return findWithExactPrefix(db, index, query, options) },
    async findOne(index, query, options) { assertAccepting(); return findOneWithExactPrefix(db, index, query, options) },
    async get(collection, record, options) { assertAccepting(); return db.get(collection, record, options) },
    async flush() { return enqueue(() => db.flush()) },
    async validatedTransaction(run) {
      if (typeof run !== 'function') throw new TypeError('transaction callback is required')
      return enqueue(async () => {
        const tx = await db.exclusiveTransaction()
        try {
          const api = Object.freeze({
            async upsert(collection, record) {
              validateIndexerRecord(collection, record)
              await tx.insert(collection, record)
            },
            async delete(collection, record) {
              validateIndexerRecord(collection, record)
              await tx.delete(collection, record)
            },
            find(index, query, options) { return findWithExactPrefix(tx, index, query, options) },
            async findOne(index, query, options) { return findOneWithExactPrefix(tx, index, query, options) },
            get: tx.get.bind(tx),
          })
          const result = await run(api)
          await tx.flush()
          return result
        } finally {
          await tx.close()
        }
      })
    },
    close() {
      if (closePromise) return closePromise
      accepting = false
      closePromise = Promise.allSettled([...pending])
        .then(() => db.close())
        .finally(serializer.release)
      return closePromise
    },
  })
}

export async function openIndexerDatabase(store, options = {}) {
  if (!store || typeof store.get !== 'function') throw new TypeError('caller-owned Corestore is required')
  const hasName = typeof options.name === 'string' && options.name.length > 0
  const hasKey = options.key !== undefined && options.key !== null
  if (hasName === hasKey) throw new TypeError('exactly one index core name or key is required')
  const core = hasName ? store.get({ name: options.name }) : store.get({ key: options.key })
  try {
    await core.ready()
  } catch (error) {
    await core.close()
    throw error
  }
  const owner = store.root || store
  const serializer = acquireSerializer(owner, Buffer.from(core.key).toString('hex'))
  let db
  try {
    db = HyperDB.bee(core, indexDbDefinition, {
      autoUpdate: true,
      writable: core.writable !== false,
      extension: false,
    })
    await db.ready()
  } catch (error) {
    serializer.release()
    if (db) await db.close()
    else await core.close()
    throw error
  }
  return createSurface(db, serializer)
}
