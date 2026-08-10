/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path')
const Hyperschema = require('hyperschema')
const HyperDB = require('hyperdb/builder')

const ROOT = path.join(__dirname, 'index-hyperdb-spec')
const SCHEMA_DIR = path.join(ROOT, 'hyperschema')
const DB_DIR = path.join(ROOT, 'hyperdb')
const NAMESPACE = 'peartubeIndex'

const schema = Hyperschema.from(SCHEMA_DIR)
const indexSchema = schema.namespace(NAMESPACE)

const required = (name, type = 'string') => ({ name, type, required: true })
const optional = (name, type = 'string') => ({ name, type })

const models = {
  sourceRecord: [
    required('publisherId'), required('catalogEpoch', 'uint64'), required('recordId'),
    required('recordType'), required('sourceSequence', 'uint64'), required('canonicalEnvelope', 'buffer'),
    required('projectionState'), required('ingestedAt', 'uint64'),
  ],
  sourceCursor: [
    required('publisherId'), required('catalogEpoch', 'uint64'), required('catalogBootstrapKey'),
    required('viewFork', 'uint64'), required('viewVersion', 'uint64'), required('sourceHead', 'uint64'),
    required('lastVerifiedDescriptor'),
  ],
  externalReferenceProjection: [
    required('publisherId'), required('sourceRecordRef'), required('namespace'),
    required('normalizedIdentifier'), required('entityKind'), required('entityId'),
    optional('evidenceWeight', 'uint64'),
  ],
  publicationProjection: [
    required('publisherId'), required('sourceRecordRef'), required('publicationId'),
    required('workEntityId'), required('normalizedTitle'), optional('releaseYear', 'uint64'),
    required('manifestId'), optional('provenanceSummary'),
  ],
  renditionProjection: [
    required('publisherId'), required('sourceRecordRef'), required('renditionId'), required('assetId'),
    optional('format'), optional('codec'), optional('dimensions'), optional('mediaFeatures'),
    optional('byteLength', 'uint64'),
  ],
  availabilityProjection: [
    required('publisherId'), required('sourceRecordRef'), required('assetId'), required('observerId'),
    required('observedSeeders', 'uint64'), required('observedCompleteSeeders', 'uint64'),
    required('observedAt', 'uint64'), required('expiresAt', 'uint64'), required('availabilityState'),
  ],
  relationshipEdge: [
    required('publisherId'), required('sourceRecordRef'), required('relationType'),
    required('fromId'), required('toId'),
  ],
}

for (const [name, fields] of Object.entries(models)) {
  indexSchema.register({ name, compact: true, fields })
}
Hyperschema.toDisk(schema)

const db = HyperDB.from(SCHEMA_DIR, DB_DIR)
const indexDb = db.namespace(NAMESPACE)
const collections = [
  ['sourceRecords', 'sourceRecord', ['publisherId', 'catalogEpoch', 'recordId']],
  ['sourceCursors', 'sourceCursor', ['publisherId', 'catalogEpoch']],
  ['externalReferenceProjections', 'externalReferenceProjection', ['publisherId', 'sourceRecordRef', 'namespace', 'normalizedIdentifier', 'entityKind', 'entityId']],
  ['publicationProjections', 'publicationProjection', ['publisherId', 'sourceRecordRef', 'publicationId']],
  ['renditionProjections', 'renditionProjection', ['publisherId', 'sourceRecordRef', 'renditionId']],
  ['availabilityProjections', 'availabilityProjection', ['publisherId', 'sourceRecordRef', 'assetId', 'observerId', 'observedAt']],
  ['relationshipEdges', 'relationshipEdge', ['publisherId', 'sourceRecordRef', 'relationType', 'fromId', 'toId']],
]
for (const [name, model, key] of collections) {
  indexDb.collections.register({ name, schema: `@${NAMESPACE}/${model}`, key })
}

const indexes = [
  ['source-records-by-publisher', 'sourceRecords', ['publisherId', 'catalogEpoch', 'recordId']],
  ['source-cursors-by-publisher', 'sourceCursors', ['publisherId', 'catalogEpoch']],
  ['external-references-by-publisher', 'externalReferenceProjections', ['publisherId', 'sourceRecordRef', 'namespace', 'normalizedIdentifier', 'entityKind', 'entityId']],
  ['publications-by-publisher', 'publicationProjections', ['publisherId', 'sourceRecordRef', 'publicationId']],
  ['renditions-by-publisher', 'renditionProjections', ['publisherId', 'sourceRecordRef', 'renditionId']],
  ['availability-by-publisher', 'availabilityProjections', ['publisherId', 'sourceRecordRef', 'assetId', 'observerId', 'observedAt']],
  ['relationships-by-publisher', 'relationshipEdges', ['publisherId', 'sourceRecordRef', 'relationType', 'fromId', 'toId']],
  ['external-reference-exact', 'externalReferenceProjections', ['namespace', 'normalizedIdentifier', 'publisherId', 'sourceRecordRef', 'entityKind', 'entityId']],
  ['entity-exact', 'externalReferenceProjections', ['entityKind', 'entityId', 'publisherId', 'sourceRecordRef', 'namespace', 'normalizedIdentifier']],
  ['publication-exact', 'publicationProjections', ['publicationId', 'publisherId', 'sourceRecordRef']],
  ['publication-by-work', 'publicationProjections', ['workEntityId', 'publisherId', 'sourceRecordRef', 'publicationId']],
  ['normalized-title', 'publicationProjections', ['normalizedTitle', 'publisherId', 'sourceRecordRef', 'publicationId']],
  ['asset-exact', 'renditionProjections', ['assetId', 'publisherId', 'sourceRecordRef', 'renditionId']],
  ['rendition-exact', 'renditionProjections', ['renditionId', 'publisherId', 'sourceRecordRef']],
  ['availability-by-asset', 'availabilityProjections', ['assetId', 'publisherId', 'sourceRecordRef', 'observerId', 'observedAt']],
  ['relationship-by-type', 'relationshipEdges', ['relationType', 'publisherId', 'sourceRecordRef', 'fromId', 'toId']],
  ['relationship-by-from', 'relationshipEdges', ['relationType', 'fromId', 'publisherId', 'sourceRecordRef', 'toId']],
  ['relationship-by-to', 'relationshipEdges', ['relationType', 'toId', 'publisherId', 'sourceRecordRef', 'fromId']],
  ['token-prefix', 'relationshipEdges', ['relationType', 'fromId', 'publisherId', 'sourceRecordRef', 'toId']],
]
for (const [name, collection, key] of indexes) {
  indexDb.indexes.register({ name, collection: `@${NAMESPACE}/${collection}`, unique: false, key })
}

HyperDB.toDisk(db, DB_DIR, { esm: true })
