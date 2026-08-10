/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path')
const Hyperschema = require('hyperschema')
const HyperDB = require('hyperdb/builder')

const ROOT = path.join(__dirname, 'channel-hyperdb-spec')
const SCHEMA_DIR = path.join(ROOT, 'hyperschema')
const DB_DIR = path.join(ROOT, 'hyperdb')

const schema = Hyperschema.from(SCHEMA_DIR)
const ns = schema.namespace('peartubeChannel')

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
    { name: 'banned', type: 'bool' },
    // Hyperswarm/Noise public key (hex) this device replicates under. Lets other
    // devices on the channel recognise it as a connected peer holding a full
    // copy (durable own-device offload anchor). Trailing optional field — keep
    // last to preserve wire compatibility of existing writer records.
    { name: 'swarmKeyHex', type: 'string' }
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
    { name: 'logicalClock', type: 'uint64' },
  ]
})

ns.register({
  name: 'channelProfile',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'profileKind', type: 'string' },
    { name: 'mediaProvider', type: 'string' },
    { name: 'mediaId', type: 'string' },
    { name: 'originalLanguage', type: 'string' },
    { name: 'releaseDate', type: 'uint64' },
    { name: 'releaseYear', type: 'uint64' }
  ]
})

ns.register({
  name: 'contentDetails',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'contentKind', type: 'string' },
    { name: 'sourceProvider', type: 'string' },
    { name: 'sourceVideoId', type: 'string' },
    { name: 'identityUrl', type: 'string' },
    { name: 'sourceCreatorId', type: 'string' },
    { name: 'sourceCreatorUrl', type: 'string' },
    { name: 'sourcePublishedAt', type: 'uint64' },
    { name: 'mediaProvider', type: 'string' },
    { name: 'mediaId', type: 'string' },
    { name: 'seasonNumber', type: 'uint64' },
    { name: 'episodeNumber', type: 'uint64' },
    { name: 'originalAirDate', type: 'uint64' },
    { name: 'thumbnailUrl', type: 'string' },
    { name: 'provenanceVersion', type: 'string' },
    { name: 'publicationState', type: 'string' },
    { name: 'contentFingerprint', type: 'string' },
    { name: 'importIdentityKey', type: 'string' },
    { name: 'importClaimantId', type: 'string' },
    { name: 'publicationId', type: 'string' },
    { name: 'manifestId', type: 'string' },
    { name: 'renditionId', type: 'string' },
    { name: 'assetId', type: 'string' },
    { name: 'coreKey', type: 'string' },
    { name: 'publisherId', type: 'string' },
    { name: 'publicationSequence', type: 'uint64' },
    { name: 'metadataClaimId', type: 'string' },
    { name: 'availabilityClaimId', type: 'string' },
    { name: 'publicationOperationId', type: 'string' },
    { name: 'metadataClaimOperationId', type: 'string' },
    { name: 'availabilityClaimOperationId', type: 'string' },
    { name: 'publicationManifestHex', type: 'string' },
  ]
})
ns.register({
  name: 'publicationOperationFrames',
  compact: true,
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'publicationOperationFramesHex', type: 'string', required: true }
  ]
})


ns.register({
  name: 'channelSource',
  compact: true,
  fields: [
    { name: 'provider', type: 'string', required: true },
    { name: 'identityKey', type: 'string', required: true },
    { name: 'sourceId', type: 'string' },
    { name: 'identityUrl', type: 'string' },
    { name: 'handle', type: 'string' },
    { name: 'displayName', type: 'string' },
    { name: 'createdAt', type: 'uint64' },
    { name: 'updatedAt', type: 'uint64' }
  ]
})

ns.register({
  name: 'channelArtwork',
  compact: true,
  fields: [
    { name: 'role', type: 'string', required: true },
    { name: 'blobId', type: 'string' },
    { name: 'blobsCoreKey', type: 'string' },
    { name: 'mimeType', type: 'string' },
    { name: 'remoteUrl', type: 'string' },
    { name: 'updatedAt', type: 'uint64' }
  ]
})

ns.register({
  name: 'importClaim',
  compact: true,
  fields: [
    { name: 'identityKey', type: 'string', required: true },
    { name: 'claimantId', type: 'string', required: true },
    { name: 'jobId', type: 'string' },
    { name: 'writerKey', type: 'string' },
    { name: 'videoId', type: 'string' },
    { name: 'state', type: 'string' },
    { name: 'createdAt', type: 'uint64' },
    { name: 'updatedAt', type: 'uint64' },
    { name: 'releasedAt', type: 'uint64' }
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
ch.collections.register({ name: 'comments', schema: '@peartubeChannel/comment', key: ['videoId', 'commentId'] })
ch.collections.register({ name: 'reactions', schema: '@peartubeChannel/reaction', key: ['videoId', 'authorKeyHex'] })
ch.collections.register({ name: 'invites', schema: '@peartubeChannel/invite', key: ['idHex'] })
ch.collections.register({ name: 'watchEvents', schema: '@peartubeChannel/watchEvent', key: ['videoId', 'eventId'] })
ch.collections.register({ name: 'vectorIndexes', schema: '@peartubeChannel/vectorIndex', key: ['videoId'] })
ch.collections.register({ name: 'channelProfiles', schema: '@peartubeChannel/channelProfile', key: ['id'] })
ch.collections.register({
  name: 'publicationOperationFrames',
  schema: '@peartubeChannel/publicationOperationFrames',
  key: ['id']
})
ch.collections.register({ name: 'contentDetails', schema: '@peartubeChannel/contentDetails', key: ['id'] })
ch.collections.register({ name: 'channelSources', schema: '@peartubeChannel/channelSource', key: ['provider', 'identityKey'] })
ch.collections.register({ name: 'channelArtwork', schema: '@peartubeChannel/channelArtwork', key: ['role'] })
ch.collections.register({ name: 'importClaims', schema: '@peartubeChannel/importClaim', key: ['identityKey', 'claimantId'] })

ch.indexes.register({ name: 'writers-by-role', collection: '@peartubeChannel/writers', unique: false, key: ['role'] })
ch.indexes.register({ name: 'videos-by-uploaded-at', collection: '@peartubeChannel/videos', unique: false, key: ['uploadedAt'] })
ch.indexes.register({ name: 'comments-by-video-timestamp', collection: '@peartubeChannel/comments', unique: false, key: ['videoId', 'timestamp'] })
ch.indexes.register({ name: 'reactions-by-video-type', collection: '@peartubeChannel/reactions', unique: false, key: ['videoId', 'reactionType'] })
ch.indexes.register({ name: 'watch-events-by-video-timestamp', collection: '@peartubeChannel/watchEvents', unique: false, key: ['videoId', 'timestamp'] })
ch.indexes.register({ name: 'claims-by-writer', collection: '@peartubeChannel/importClaims', unique: false, key: ['identityKey', 'writerKey', 'claimantId'] })
ch.indexes.register({ name: 'claims-by-identity', collection: '@peartubeChannel/importClaims', unique: false, key: ['identityKey', 'claimantId'] })
ch.indexes.register({ name: 'videos-by-season-episode', collection: '@peartubeChannel/contentDetails', unique: false, key: ['seasonNumber', 'episodeNumber', 'id'] })
ch.indexes.register({ name: 'videos-by-source', collection: '@peartubeChannel/contentDetails', unique: false, key: ['sourceProvider', 'sourceVideoId', 'id'] })
ch.indexes.register({ name: 'videos-by-kind-published', collection: '@peartubeChannel/contentDetails', unique: false, key: ['contentKind', 'sourcePublishedAt', 'id'] })

HyperDB.toDisk(db, DB_DIR, { esm: true })
