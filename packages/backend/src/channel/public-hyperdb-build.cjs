/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path')
const Hyperschema = require('hyperschema')
const HyperDB = require('hyperdb/builder')

const ROOT = path.join(__dirname, 'public-hyperdb-spec')
const SCHEMA_DIR = path.join(ROOT, 'hyperschema')
const DB_DIR = path.join(ROOT, 'hyperdb')

const schema = Hyperschema.from(SCHEMA_DIR)
const publicSchema = schema.namespace('peartubePublic')

// Optional fields share one flags word that the generated encoder builds with
// a chain of bitwise `|` - a SIGNED 32-bit operation. The 32nd optional field
// contributes 2**31, turning the word negative and failing `c.uint` encoding
// at write time, so the struct silently cannot be persisted. Refuse it here.
const MAX_OPTIONAL_FIELDS = 31
const registerPublicStruct = publicSchema.register.bind(publicSchema)
publicSchema.register = (definition) => {
  const optional = (definition?.fields || []).filter((field) => field.required !== true)
  if (optional.length > MAX_OPTIONAL_FIELDS) {
    throw new Error(
      `struct '${definition?.name}' has ${optional.length} optional fields; ` +
      `at most ${MAX_OPTIONAL_FIELDS} can be encoded. Mark a field ` +
      'required, or split the struct.',
    )
  }
  return registerPublicStruct(definition)
}

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
  name: 'channelProfile',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'profileKind', type: 'string' },
    { name: 'mediaProvider', type: 'string' },
    { name: 'mediaId', type: 'string' },
    { name: 'originalLanguage', type: 'string' },
    { name: 'releaseDate', type: 'uint64' },
    { name: 'releaseYear', type: 'uint64' },
    { name: 'canonicalRevision', type: 'string' },
  ],
})

// Cover art has to survive a restart on the publisher as well as travel on a
// claim, so the content record carries the same role/locator shape the media
// graph publishes.
publicSchema.register({
  name: 'contentArtwork',
  compact: true,
  fields: [
    { name: 'role', type: 'string', required: true },
    { name: 'blobId', type: 'string' },
    { name: 'blobsCoreKey', type: 'string' },
    { name: 'mimeType', type: 'string' },
    { name: 'remoteUrl', type: 'string' }
  ]
})

publicSchema.register({
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
    { name: 'canonicalVisibility', type: 'string' },
    { name: 'duplicateOfClaimantId', type: 'string' },
    { name: 'artwork', type: '@peartubePublic/contentArtwork', array: true },
  ],
})

publicSchema.register({
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

publicSchema.register({
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
  name: 'channelProfiles',
  schema: '@peartubePublic/channelProfile',
  key: ['id'],
})

publicDb.collections.register({
  name: 'contentDetails',
  schema: '@peartubePublic/contentDetails',
  key: ['id'],
})

publicDb.collections.register({
  name: 'channelSources',
  schema: '@peartubePublic/channelSource',
  key: ['provider', 'identityKey'],
})

publicDb.collections.register({
  name: 'channelArtwork',
  schema: '@peartubePublic/channelArtwork',
  key: ['role'],
})


publicDb.indexes.register({
  name: 'videos-by-uploaded-at',
  collection: '@peartubePublic/videos',
  unique: false,
  key: ['uploadedAt'],
})
publicDb.indexes.register({
  name: 'videos-by-season-episode',
  collection: '@peartubePublic/contentDetails',
  unique: false,
  key: ['seasonNumber', 'episodeNumber', 'id'],
})

publicDb.indexes.register({
  name: 'videos-by-source',
  collection: '@peartubePublic/contentDetails',
  unique: false,
  key: ['sourceProvider', 'sourceVideoId', 'id'],
})

publicDb.indexes.register({
  name: 'videos-by-kind-published',
  collection: '@peartubePublic/contentDetails',
  unique: false,
  key: ['contentKind', 'sourcePublishedAt', 'id'],
})


HyperDB.toDisk(db, DB_DIR, { esm: true })
