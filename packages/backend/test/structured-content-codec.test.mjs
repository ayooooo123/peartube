import test from 'brittle'
import b4a from 'b4a'
import { encode as encodePrivate, decode as decodePrivate } from '../src/channel/channel-hyperdb-spec/hyperdb/messages.js'
import { encode as encodePublic, decode as decodePublic } from '../src/channel/public-hyperdb-spec/hyperdb/messages.js'
import privateDb from '../src/channel/channel-hyperdb-spec/hyperdb/index.js'
import publicDb from '../src/channel/public-hyperdb-spec/hyperdb/index.js'

function assertRetains (t, actual, expected) {
  for (const [field, value] of Object.entries(expected)) {
    t.alike(actual[field], value, `${field} round-trips`)
  }
}

function roundTripPrivate (name, record) {
  return decodePrivate(name, encodePrivate(name, record))
}

function roundTripPublic (name, record) {
  return decodePublic(name, encodePublic(name, record))
}

function withoutField (record, field) {
  const value = { ...record }
  delete value[field]
  return value
}

function assertPinnedCodec (t, codec, { directName, valueName, record, keyField, directHex, valueHex }) {
  const valueRecord = withoutField(record, keyField)

  t.is(b4a.toString(codec.encode(directName, record), 'hex'), directHex, `${directName} wire bytes remain stable`)
  assertRetains(t, codec.decode(directName, b4a.from(directHex, 'hex')), record)

  t.is(b4a.toString(codec.encode(valueName, valueRecord), 'hex'), valueHex, `${valueName} wire bytes remain stable`)
  assertRetains(t, codec.decode(valueName, b4a.from(valueHex, 'hex')), valueRecord)
}

function assertPinnedCollection (t, database, { collectionName, record, keyHex, valueHex }) {
  const collection = database.resolveCollection(collectionName)

  t.ok(collection, `${collectionName} resolves`)
  t.is(b4a.toString(collection.encodeKey(record), 'hex'), keyHex, `${collectionName} key bytes remain stable`)
  t.is(b4a.toString(collection.encodeValue(1, 1, record), 'hex'), valueHex, `${collectionName} value envelope remains stable`)
  assertRetains(t, collection.reconstruct(1, b4a.from(keyHex, 'hex'), b4a.from(valueHex, 'hex')), record)
}

const profile = {
  id: 'profile',
  profileKind: 'tvShow',
  mediaProvider: 'tmdb',
  mediaId: '1399',
  originalLanguage: 'en',
  releaseDate: 1212537600000,
  releaseYear: 2008
}

const legacyVideo = {
  id: 'legacy-video',
  title: 'Legacy video',
  description: 'Existing compact record',
  path: '/videos/legacy.mp4',
  duration: 120,
  thumbnail: '/thumbnails/legacy.jpg',
  thumbnailBlobId: '1:2:0:20',
  thumbnailBlobsCoreKey: 'ab'.repeat(32),
  thumbnailMimeType: 'image/jpeg',
  blobId: '3:4:0:40',
  blobsCoreKey: 'bc'.repeat(32),
  blobDriveKey: 'cd'.repeat(32),
  mimeType: 'video/mp4',
  size: 4096,
  category: 'other',
  views: 7,
  uploadedAt: 1700000000000,
  uploadedBy: 'de'.repeat(32),
  updatedAt: 1700000001000,
  updatedBy: 'ef'.repeat(32)
}

const contentDetails = {
  id: 'episode-1',
  contentKind: 'episode',
  sourceProvider: 'tmdb',
  sourceVideoId: '1399:1:1',
  identityUrl: 'https://example.test/pilot',
  sourceCreatorId: 'creator-7',
  sourceCreatorUrl: 'https://example.test/creators/7',
  sourcePublishedAt: 1212537600000,
  mediaProvider: 'tmdb',
  mediaId: '62085',
  seasonNumber: 1,
  episodeNumber: 1,
  originalAirDate: 1212537600000,
  thumbnailUrl: 'https://images.example.test/pilot.jpg',
  provenanceVersion: 'tmdb-resolver@1',
  publicationState: 'commitUncertain',
  contentFingerprint: 'sha256:abc',
  importIdentityKey: 'tmdb:episode:62085',
  importClaimantId: 'claimant-1',
  publication: {
    publicationId: '10'.repeat(32),
    manifestId: '11'.repeat(32),
    renditionId: '12'.repeat(32),
    assetId: '13'.repeat(32),
    coreKey: '13'.repeat(32),
    publisherId: '14'.repeat(32),
    sequence: 7,
    metadataClaimId: '15'.repeat(32),
    availabilityClaimId: '16'.repeat(32),
    publicationOperationId: '17'.repeat(32),
    metadataClaimOperationId: '18'.repeat(32),
    availabilityClaimOperationId: '19'.repeat(32),
    manifestHex: 'abcd'
  }
}

const channelSource = {
  provider: 'youtube',
  identityKey: 'id:UC1',
  sourceId: 'UC1',
  identityUrl: 'https://youtube.com/channel/UC1',
  handle: '@example',
  displayName: 'Example Creator',
  createdAt: 1700000000000,
  updatedAt: 1700000001000
}

const channelArtwork = {
  role: 'poster',
  blobId: '1:2:0:20',
  blobsCoreKey: 'ab'.repeat(32),
  mimeType: 'image/jpeg',
  remoteUrl: 'https://images.example.test/poster.jpg',
  updatedAt: 1700000001000
}

const importClaim = {
  identityKey: 'tmdb:episode:62085',
  claimantId: 'claimant-1',
  jobId: 'job-7',
  writerKey: 'cd'.repeat(32),
  videoId: 'episode-1',
  state: 'reserved',
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  releasedAt: 1700000002000
}

const legacyPrivateMetadata = {
  key: 'k',
  name: 'n',
  description: 'd',
  avatar: 'a',
  publicBeeKey: 'p',
  commentsDbKey: 'c',
  commentsAdminKey: 'x',
  createdAt: 1,
  createdBy: 'b',
  updatedAt: 2,
  updatedBy: 'u',
  schemaVersion: 3,
  logicalClock: 4
}

const legacyPublicMetadata = {
  key: 'k',
  name: 'n',
  description: 'd',
  avatar: 'a',
  publicBeeKey: 'p',
  commentsDbKey: 'c',
  createdAt: 1,
  createdBy: 'b',
  updatedAt: 2
}

const legacyPrivateVideo = {
  id: 'v',
  title: 't',
  description: 'd',
  path: 'p',
  duration: 1,
  thumbnail: 'h',
  thumbnailBlobId: 'i',
  thumbnailBlobsCoreKey: 'k',
  thumbnailMimeType: 'm',
  blobId: 'b',
  blobsCoreKey: 'c',
  blobDriveKey: 'r',
  mimeType: 'x',
  size: 2,
  category: 'g',
  views: 3,
  uploadedAt: 4,
  uploadedBy: 'u',
  updatedAt: 5,
  updatedBy: 'w',
  schemaVersion: 6,
  logicalClock: 7
}

const legacyPublicVideo = {
  id: 'v',
  title: 't',
  description: 'd',
  path: 'p',
  duration: 1,
  thumbnail: 'h',
  thumbnailBlobId: 'i',
  thumbnailBlobsCoreKey: 'k',
  thumbnailMimeType: 'm',
  blobId: 'b',
  blobsCoreKey: 'c',
  blobDriveKey: 'r',
  mimeType: 'x',
  size: 2,
  category: 'g',
  views: 3,
  uploadedAt: 4,
  uploadedBy: 'u',
  updatedAt: 5,
  updatedBy: 'w',
  syncedAt: 6
}

// These vectors were encoded with the generated codecs from cd4d98d^.
const legacyWireVectors = {
  privateMetadataDirect: '016bff0f016e01640161017001630178010000000000000001620200000000000000017503000000000000000400000000000000',
  privateMetadataValue: 'ff0f016e01640161017001630178010000000000000001620200000000000000017503000000000000000400000000000000',
  privateVideoDirect: '0176ffff1f017401640170010000000000000001680169016b016d0162016301720178020000000000000001670300000000000000040000000000000001750500000000000000017706000000000000000700000000000000',
  privateVideoValue: 'ffff1f017401640170010000000000000001680169016b016d0162016301720178020000000000000001670300000000000000040000000000000001750500000000000000017706000000000000000700000000000000',
  publicMetadataDirect: '016bff016e0164016101700163010000000000000001620200000000000000',
  publicMetadataValue: 'ff016e0164016101700163010000000000000001620200000000000000',
  publicVideoDirect: '0176ffff0f017401640170010000000000000001680169016b016d016201630172017802000000000000000167030000000000000004000000000000000175050000000000000001770600000000000000',
  publicVideoValue: 'ffff0f017401640170010000000000000001680169016b016d016201630172017802000000000000000167030000000000000004000000000000000175050000000000000001770600000000000000'
}

// These key/value envelope vectors were encoded with the generated HyperDB collections from cd4d98d^.
const legacyCollectionVectors = {
  privateMetadata: {
    key: '00006b0001',
    value: '0001ff0f016e01640161017001630178010000000000000001620200000000000000017503000000000000000400000000000000'
  },
  privateVideo: {
    key: '0200760001',
    value: '0001ffff1f017401640170010000000000000001680169016b016d0162016301720178020000000000000001670300000000000000040000000000000001750500000000000000017706000000000000000700000000000000'
  },
  publicMetadata: {
    key: '00006b0001',
    value: '0001ff016e0164016101700163010000000000000001620200000000000000'
  },
  publicVideo: {
    key: '0100760001',
    value: '0001ffff0f017401640170010000000000000001680169016b016d016201630172017802000000000000000167030000000000000004000000000000000175050000000000000001770600000000000000'
  }
}

test('private metadata message codecs retain pre-sidecar direct and key-elided bytes', (t) => {
  assertPinnedCodec(t, { encode: encodePrivate, decode: decodePrivate }, {
    directName: '@peartubeChannel/metadata',
    valueName: '@peartubeChannel/metadata/hyperdb#0',
    record: legacyPrivateMetadata,
    keyField: 'key',
    directHex: legacyWireVectors.privateMetadataDirect,
    valueHex: legacyWireVectors.privateMetadataValue
  })
})

test('public metadata message codecs retain pre-sidecar direct and key-elided bytes', (t) => {
  assertPinnedCodec(t, { encode: encodePublic, decode: decodePublic }, {
    directName: '@peartubePublic/metadata',
    valueName: '@peartubePublic/metadata/hyperdb#0',
    record: legacyPublicMetadata,
    keyField: 'key',
    directHex: legacyWireVectors.publicMetadataDirect,
    valueHex: legacyWireVectors.publicMetadataValue
  })
})

test('private video message codecs retain pre-sidecar direct and key-elided bytes', (t) => {
  assertPinnedCodec(t, { encode: encodePrivate, decode: decodePrivate }, {
    directName: '@peartubeChannel/video',
    valueName: '@peartubeChannel/video/hyperdb#2',
    record: legacyPrivateVideo,
    keyField: 'id',
    directHex: legacyWireVectors.privateVideoDirect,
    valueHex: legacyWireVectors.privateVideoValue
  })
})

test('public video message codecs retain pre-sidecar direct and key-elided bytes', (t) => {
  assertPinnedCodec(t, { encode: encodePublic, decode: decodePublic }, {
    directName: '@peartubePublic/video',
    valueName: '@peartubePublic/video/hyperdb#1',
    record: legacyPublicVideo,
    keyField: 'id',
    directHex: legacyWireVectors.publicVideoDirect,
    valueHex: legacyWireVectors.publicVideoValue
  })
})

test('private metadata collection codec retains pre-sidecar key/value envelopes', (t) => {
  assertPinnedCollection(t, privateDb, {
    collectionName: '@peartubeChannel/metadata',
    record: legacyPrivateMetadata,
    keyHex: legacyCollectionVectors.privateMetadata.key,
    valueHex: legacyCollectionVectors.privateMetadata.value
  })
})

test('public metadata collection codec retains pre-sidecar key/value envelopes', (t) => {
  assertPinnedCollection(t, publicDb, {
    collectionName: '@peartubePublic/metadata',
    record: legacyPublicMetadata,
    keyHex: legacyCollectionVectors.publicMetadata.key,
    valueHex: legacyCollectionVectors.publicMetadata.value
  })
})

test('private video collection codec retains pre-sidecar key/value envelopes', (t) => {
  assertPinnedCollection(t, privateDb, {
    collectionName: '@peartubeChannel/videos',
    record: legacyPrivateVideo,
    keyHex: legacyCollectionVectors.privateVideo.key,
    valueHex: legacyCollectionVectors.privateVideo.value
  })
})

test('public video collection codec retains pre-sidecar key/value envelopes', (t) => {
  assertPinnedCollection(t, publicDb, {
    collectionName: '@peartubePublic/videos',
    record: legacyPublicVideo,
    keyHex: legacyCollectionVectors.publicVideo.key,
    valueHex: legacyCollectionVectors.publicVideo.value
  })
})

test('existing private and public video codecs retain the legacy compact record', (t) => {
  assertRetains(t, roundTripPrivate('@peartubeChannel/video', legacyVideo), legacyVideo)
  assertRetains(t, roundTripPublic('@peartubePublic/video', legacyVideo), legacyVideo)
})
test('signed upload frames round-trip only through the private sidecar codec', async (t) => {
  const record = {
    id: 'publication-private',
    publicationOperationFramesHex: '00112233'
  }
  assertRetains(
    t,
    roundTripPrivate('@peartubeChannel/publicationOperationFrames', record),
    record
  )
  await t.exception(
    () => encodePublic('@peartubePublic/publicationOperationFrames', record),
    /Encoder not found/,
    'replay frames have no public codec'
  )
})


test('private and public channel profile sidecars retain structured fields', (t) => {
  assertRetains(t, roundTripPrivate('@peartubeChannel/channelProfile', profile), profile)

  const publicProfile = { ...profile, canonicalRevision: 'sha256:revision-1' }
  assertRetains(t, roundTripPublic('@peartubePublic/channelProfile', publicProfile), publicProfile)
})

test('private and public content detail sidecars retain structured and reconciliation fields', (t) => {
  t.is(
    Object.keys(contentDetails.publication).length,
    13,
    'the fixture carries the whole publication cluster'
  )
  assertRetains(t, roundTripPrivate('@peartubeChannel/contentDetails', contentDetails), contentDetails)

  const { publication, ...publicContentDetails } = contentDetails
  const publicDetails = {
    ...publicContentDetails,
    publicationState: 'replicationPending',
    canonicalVisibility: 'suppressed',
    duplicateOfClaimantId: 'claimant-0'
  }
  assertRetains(t, roundTripPublic('@peartubePublic/contentDetails', publicDetails), publicDetails)
})

test('private and public channel source codecs retain source identity', (t) => {
  assertRetains(t, roundTripPrivate('@peartubeChannel/channelSource', channelSource), channelSource)
  assertRetains(t, roundTripPublic('@peartubePublic/channelSource', channelSource), channelSource)
})

test('private and public channel artwork codecs retain blob provenance', (t) => {
  assertRetains(t, roundTripPrivate('@peartubeChannel/channelArtwork', channelArtwork), channelArtwork)
  assertRetains(t, roundTripPublic('@peartubePublic/channelArtwork', channelArtwork), channelArtwork)
})

test('import claim records exist only in the private schema', async (t) => {
  assertRetains(t, roundTripPrivate('@peartubeChannel/importClaim', importClaim), importClaim)
  await t.exception(
    () => encodePublic('@peartubePublic/importClaim', importClaim),
    /Encoder not found/,
    'public schema does not expose private import claims'
  )
})
