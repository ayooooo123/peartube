/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path')
const Hyperschema = require('hyperschema')
const HyperDB = require('hyperdb/builder')

const ROOT = path.join(__dirname, 'channel-hyperdb-spec')
const SCHEMA_DIR = path.join(ROOT, 'hyperschema')
const DB_DIR = path.join(ROOT, 'hyperdb')

const schema = Hyperschema.from(SCHEMA_DIR)
const ns = schema.namespace('peartubeChannel')

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

ns.register({
  name: 'metadata',
  compact: true,
  fields: [
    { name: 'key', type: 'string', required: true },
    { name: 'name', type: 'string' },
    { name: 'description', type: 'string' },
    { name: 'avatar', type: 'string' },
    { name: 'publicBeeKey', type: 'string' },
    { name: 'commentsDbKey', type: 'string' },
    { name: 'commentsAdminKey', type: 'string' },
    { name: 'createdAt', type: 'uint64' },
    { name: 'createdBy', type: 'string' },
    { name: 'updatedAt', type: 'uint64' },
    { name: 'updatedBy', type: 'string' },
    { name: 'schemaVersion', type: 'uint64' },
    { name: 'logicalClock', type: 'uint64' }
  ]
})

ns.register({
  name: 'writer',
  compact: true,
  fields: [
    { name: 'keyHex', type: 'string', required: true },
    { name: 'role', type: 'string' },
    { name: 'deviceName', type: 'string' },
    { name: 'blobDriveKey', type: 'string' },
    { name: 'addedAt', type: 'uint64' },
    { name: 'updatedAt', type: 'uint64' },
    { name: 'removedAt', type: 'uint64' },
    { name: 'banned', type: 'bool' }
  ]
})

ns.register({
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
    { name: 'schemaVersion', type: 'uint64' },
    { name: 'logicalClock', type: 'uint64' }
  ]
})

ns.register({
  name: 'videoSourceMetadata',
  compact: true,
  fields: [
    { name: 'videoId', type: 'string', required: true },
    ...SOURCE_METADATA_FIELDS
  ]
})

ns.register({
  name: 'comment',
  compact: true,
  fields: [
    { name: 'videoId', type: 'string', required: true },
    { name: 'commentId', type: 'string', required: true },
    { name: 'text', type: 'string' },
    { name: 'authorKeyHex', type: 'string' },
    { name: 'timestamp', type: 'uint64' },
    { name: 'parentId', type: 'string' },
    { name: 'hidden', type: 'bool' },
    { name: 'hiddenBy', type: 'string' },
    { name: 'hiddenAt', type: 'uint64' },
    { name: 'removed', type: 'bool' },
    { name: 'removedBy', type: 'string' },
    { name: 'removedAt', type: 'uint64' }
  ]
})

ns.register({
  name: 'reaction',
  compact: true,
  fields: [
    { name: 'videoId', type: 'string', required: true },
    { name: 'authorKeyHex', type: 'string', required: true },
    { name: 'reactionType', type: 'string' },
    { name: 'timestamp', type: 'uint64' }
  ]
})

ns.register({
  name: 'invite',
  compact: true,
  fields: [
    { name: 'idHex', type: 'string', required: true },
    { name: 'inviteZ32', type: 'string' },
    { name: 'publicKeyHex', type: 'string' },
    { name: 'expires', type: 'uint64' },
    { name: 'createdAt', type: 'uint64' },
    { name: 'current', type: 'bool' }
  ]
})

ns.register({
  name: 'watchEvent',
  compact: true,
  fields: [
    { name: 'videoId', type: 'string', required: true },
    { name: 'eventId', type: 'string', required: true },
    { name: 'channelKey', type: 'string' },
    { name: 'watcherKeyHex', type: 'string' },
    { name: 'duration', type: 'uint64' },
    { name: 'completed', type: 'bool' },
    { name: 'timestamp', type: 'uint64' }
  ]
})

ns.register({
  name: 'vectorIndex',
  compact: true,
  fields: [
    { name: 'videoId', type: 'string', required: true },
    { name: 'vector', type: 'string' },
    { name: 'text', type: 'string' },
    { name: 'metadata', type: 'string' },
    { name: 'indexedAt', type: 'uint64' }
  ]
})

Hyperschema.toDisk(schema)

const db = HyperDB.from(SCHEMA_DIR, DB_DIR)
const ch = db.namespace('peartubeChannel')

ch.collections.register({ name: 'metadata', schema: '@peartubeChannel/metadata', key: ['key'] })
ch.collections.register({ name: 'writers', schema: '@peartubeChannel/writer', key: ['keyHex'] })
ch.collections.register({ name: 'videos', schema: '@peartubeChannel/video', key: ['id'] })
ch.collections.register({ name: 'videoSourceMetadata', schema: '@peartubeChannel/videoSourceMetadata', key: ['videoId'] })
ch.collections.register({ name: 'comments', schema: '@peartubeChannel/comment', key: ['videoId', 'commentId'] })
ch.collections.register({ name: 'reactions', schema: '@peartubeChannel/reaction', key: ['videoId', 'authorKeyHex'] })
ch.collections.register({ name: 'invites', schema: '@peartubeChannel/invite', key: ['idHex'] })
ch.collections.register({ name: 'watchEvents', schema: '@peartubeChannel/watchEvent', key: ['videoId', 'eventId'] })
ch.collections.register({ name: 'vectorIndexes', schema: '@peartubeChannel/vectorIndex', key: ['videoId'] })

ch.indexes.register({ name: 'writers-by-role', collection: '@peartubeChannel/writers', unique: false, key: ['role'] })
ch.indexes.register({ name: 'videos-by-uploaded-at', collection: '@peartubeChannel/videos', unique: false, key: ['uploadedAt'] })
ch.indexes.register({ name: 'comments-by-video-timestamp', collection: '@peartubeChannel/comments', unique: false, key: ['videoId', 'timestamp'] })
ch.indexes.register({ name: 'reactions-by-video-type', collection: '@peartubeChannel/reactions', unique: false, key: ['videoId', 'reactionType'] })
ch.indexes.register({ name: 'watch-events-by-video-timestamp', collection: '@peartubeChannel/watchEvents', unique: false, key: ['videoId', 'timestamp'] })

HyperDB.toDisk(db, DB_DIR, { esm: true })
