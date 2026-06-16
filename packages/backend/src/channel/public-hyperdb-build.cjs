/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path')
const Hyperschema = require('hyperschema')
const HyperDB = require('hyperdb/builder')

const ROOT = path.join(__dirname, 'public-hyperdb-spec')
const SCHEMA_DIR = path.join(ROOT, 'hyperschema')
const DB_DIR = path.join(ROOT, 'hyperdb')

const schema = Hyperschema.from(SCHEMA_DIR)
const publicSchema = schema.namespace('peartubePublic')

const SOURCE_METADATA_FIELDS = [
  { name: 'sourcePlatform', type: 'string' },
  { name: 'sourcePlatformLabel', type: 'string' },
  { name: 'sourceUrl', type: 'string' },
  { name: 'sourceId', type: 'string' },
  { name: 'sourceCreatorName', type: 'string' },
  { name: 'sourceCreatorHandle', type: 'string' },
  { name: 'sourceCreatorUrl', type: 'string' },
  { name: 'sourcePublishedAt', type: 'uint64' },
  { name: 'sourceViewCount', type: 'uint64' },
  { name: 'sourceLikeCount', type: 'uint64' },
  { name: 'sourceCommentCount', type: 'uint64' },
  { name: 'sourceArchivedAt', type: 'uint64' },
  { name: 'sourceRelayId', type: 'string' },
  { name: 'sourceMetadataJson', type: 'string' },
]

publicSchema.register({
  name: 'metadata',
  compact: true,
  fields: [
    { name: 'key', type: 'string', required: true },
    { name: 'name', type: 'string' },
    { name: 'description', type: 'string' },
    { name: 'avatar', type: 'string' },
    { name: 'publicBeeKey', type: 'string' },
    { name: 'commentsDbKey', type: 'string' },
    { name: 'createdAt', type: 'uint64' },
    { name: 'createdBy', type: 'string' },
    { name: 'updatedAt', type: 'uint64' },
  ],
})

publicSchema.register({
  name: 'video',
  compact: true,
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'title', type: 'string' },
    { name: 'description', type: 'string' },
    { name: 'path', type: 'string' },
    { name: 'duration', type: 'uint64' },
    { name: 'thumbnail', type: 'string' },
    { name: 'thumbnailBlobId', type: 'string' },
    { name: 'thumbnailBlobsCoreKey', type: 'string' },
    { name: 'thumbnailMimeType', type: 'string' },
    { name: 'blobId', type: 'string' },
    { name: 'blobsCoreKey', type: 'string' },
    { name: 'blobDriveKey', type: 'string' },
    { name: 'mimeType', type: 'string' },
    { name: 'size', type: 'uint64' },
    { name: 'category', type: 'string' },
    { name: 'views', type: 'uint64' },
    { name: 'uploadedAt', type: 'uint64' },
    { name: 'uploadedBy', type: 'string' },
    { name: 'updatedAt', type: 'uint64' },
    { name: 'updatedBy', type: 'string' },
    { name: 'syncedAt', type: 'uint64' },
  ],
})

publicSchema.register({
  name: 'videoSourceMetadata',
  compact: true,
  fields: [
    { name: 'videoId', type: 'string', required: true },
    ...SOURCE_METADATA_FIELDS
  ],
})

Hyperschema.toDisk(schema)

const db = HyperDB.from(SCHEMA_DIR, DB_DIR)
const publicDb = db.namespace('peartubePublic')

publicDb.collections.register({
  name: 'metadata',
  schema: '@peartubePublic/metadata',
  key: ['key'],
})

publicDb.collections.register({
  name: 'videos',
  schema: '@peartubePublic/video',
  key: ['id'],
})

publicDb.collections.register({
  name: 'videoSourceMetadata',
  schema: '@peartubePublic/videoSourceMetadata',
  key: ['videoId'],
})

publicDb.indexes.register({
  name: 'videos-by-uploaded-at',
  collection: '@peartubePublic/videos',
  unique: false,
  key: ['uploadedAt'],
})

HyperDB.toDisk(db, DB_DIR, { esm: true })
