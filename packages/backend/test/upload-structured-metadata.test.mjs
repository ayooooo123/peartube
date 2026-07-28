import test from 'brittle'
import { mkdtempSync, rmSync, statSync, writeFileSync, createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import crypto from 'hypercore-crypto'

import { createUploadManager } from '../src/upload.js'
import { importIdentityKey, normalizeContentDetails } from '../src/channel/structured-content.js'

const FIXTURE_BYTES = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.from('webm tiny media fixture')
])

function mp4Box(type, payload = Buffer.alloc(0)) {
  const box = Buffer.alloc(8 + payload.length)
  box.writeUInt32BE(box.length, 0)
  box.write(type, 4, 'latin1')
  payload.copy(box, 8)
  return box
}

const MP4_FIXTURE_BYTES = Buffer.concat([
  mp4Box('ftyp', Buffer.from('isom')),
  mp4Box('moov'),
  mp4Box('mdat')
])
const BLOB = Object.freeze({
  blockOffset: 4,
  blockLength: 1,
  byteOffset: 0,
  byteLength: FIXTURE_BYTES.length
})
const BLOB_ID = `${BLOB.blockOffset}:${BLOB.blockLength}:${BLOB.byteOffset}:${BLOB.byteLength}`
const BLOBS_CORE_KEY = '22'.repeat(32)
const WRITER_KEY = '11'.repeat(32)

function makeFixture(t, bytes = FIXTURE_BYTES) {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-upload-'))
  const filePath = join(directory, 'tiny-media')
  writeFileSync(filePath, bytes)
  t.teardown(() => rmSync(directory, { recursive: true, force: true }))
  const fsCalls = { stat: 0, readStream: 0 }
  const fakeFs = {
    statSync(path) {
      fsCalls.stat++
      return statSync(path)
    },
    createReadStream(path, options) {
      fsCalls.readStream++
      return createReadStream(path, options)
    }
  }
  return { fakeFs, filePath, fsCalls }
}

function makeChannel() {
  const addVideoCalls = []
  const uploadActivity = { blobStreams: 0, putBlobs: 0 }
  return {
    addVideoCalls,
    uploadActivity,
    localWriterKeyHex: WRITER_KEY,
    blobsKeyHex: BLOBS_CORE_KEY,
    blobs: {
      createWriteStream() {
        uploadActivity.blobStreams++
        const writer = new Writable({
          write(_chunk, _encoding, done) {
            done()
          }
        })
        writer.id = BLOB
        return writer
      }
    },
    async putBlob() {
      uploadActivity.putBlobs++
      return { id: BLOB_ID }
    },
    async addVideo(metadata, options) {
      addVideoCalls.push({ metadata, options })
    }
  }
}

function richOptions() {
  const options = {
    title: 'Pilot',
    description: 'An original synopsis',
    mimeType: 'video/webm',
    duration: 1_234,
    thumbnail: 'legacy-thumbnail',
    thumbnailUrl: 'https://images.example/pilot.jpg',
    thumbnailBlobId: '8:1:0:64',
    thumbnailBlobsCoreKey: '33'.repeat(32),
    thumbnailMimeType: 'image/jpeg',
    category: 'Drama',
    width: 1_920,
    height: 1_080,
    contentKind: 'episode',
    sourceProvider: 'tmdb',
    sourceVideoId: '62085',
    identityUrl: 'https://source.example/item/62085',
    sourceCreatorId: 'creator-7',
    sourceCreatorUrl: 'https://source.example/creator/7',
    sourcePublishedAt: 1_721_174_400_000,
    mediaProvider: 'tmdb',
    mediaId: '1396',
    seasonNumber: 1,
    episodeNumber: 2,
    originalAirDate: 1_215_244_800_000,
    provenanceVersion: 'tmdb-v3',
    publicationState: 'replicationPending',
    contentFingerprint: `sha256:${'a'.repeat(64)}`,
    importClaimantId: 'bb'.repeat(32),

    fetchUrl: 'https://user:pass@source.example/watch?token=secret',
    displayUrl: 'https://source.example/watch?redacted=yes',
    cookies: 'session=secret',
    cookie: 'session=secret',
    token: 'secret-token',
    accessToken: 'secret-access-token',
    authorization: 'Bearer secret',
    apiToken: 'secret-token',
    credentials: { username: 'user', password: 'secret' },
    providerPayload: { diagnostics: { requestId: 'remote-123' }, token: 'nested-secret' },

    profileKind: 'tvShow',
    originalTitle: 'Original Pilot',
    originalLanguage: 'en',
    releaseDate: 1_215_244_800_000,
    releaseYear: 2008
  }
  options.importIdentityKey = importIdentityKey({
    contentKind: options.contentKind,
    sourceProvider: options.sourceProvider,
    sourceVideoId: options.sourceVideoId,
    mediaProvider: options.mediaProvider,
    mediaId: options.mediaId,
    seasonNumber: options.seasonNumber,
    episodeNumber: options.episodeNumber,
    contentFingerprint: options.contentFingerprint
  })
  return options
}

function expectedRichMetadata(result, options) {
  return {
    id: result.videoId,
    title: options.title,
    description: options.description,
    mimeType: options.mimeType,
    size: FIXTURE_BYTES.length,
    uploadedAt: result.metadata.uploadedAt,
    uploadedBy: WRITER_KEY,
    blobId: BLOB_ID,
    blobsCoreKey: BLOBS_CORE_KEY,
    duration: options.duration,
    thumbnail: options.thumbnail,
    thumbnailUrl: options.thumbnailUrl,
    thumbnailBlobId: options.thumbnailBlobId,
    thumbnailBlobsCoreKey: options.thumbnailBlobsCoreKey,
    thumbnailMimeType: options.thumbnailMimeType,
    category: options.category,
    width: options.width,
    height: options.height,
    availability: 'playable',
    playbackSupport: 'direct',
    contentKind: options.contentKind,
    sourceProvider: options.sourceProvider,
    sourceVideoId: options.sourceVideoId,
    identityUrl: options.identityUrl,
    sourceCreatorId: options.sourceCreatorId,
    sourceCreatorUrl: options.sourceCreatorUrl,
    sourcePublishedAt: options.sourcePublishedAt,
    mediaProvider: options.mediaProvider,
    mediaId: options.mediaId,
    seasonNumber: options.seasonNumber,
    episodeNumber: options.episodeNumber,
    originalAirDate: options.originalAirDate,
    provenanceVersion: options.provenanceVersion,
    publicationState: options.publicationState,
    contentFingerprint: options.contentFingerprint,
    importIdentityKey: options.importIdentityKey,
    importClaimantId: options.importClaimantId
  }
}

function assertRejectedFieldsAbsent(t, metadata) {
  for (const field of [
    'fetchUrl',
    'displayUrl',
    'cookies',
    'cookie',
    'token',
    'accessToken',
    'authorization',
    'apiToken',
    'credentials',
    'providerPayload',
    'profileKind',
    'originalTitle',
    'originalLanguage',
    'releaseDate',
    'releaseYear'
  ]) {
    t.absent(field in metadata, `${field} is not passed to persistence`)
  }
}

async function uploadBoth(t, optionsFactory) {
  const manager = createUploadManager({ ctx: {} })
  const { fakeFs, filePath } = makeFixture(t)
  const pathChannel = makeChannel()
  const bufferChannel = makeChannel()
  const pathOptions = optionsFactory()
  const bufferOptions = optionsFactory()

  const pathResult = await manager.uploadFromPath(pathChannel, filePath, pathOptions, fakeFs)
  const bufferResult = await manager.uploadFromBuffer(bufferChannel, FIXTURE_BYTES, bufferOptions)

  return {
    path: { channel: pathChannel, options: pathOptions, result: pathResult },
    buffer: { channel: bufferChannel, options: bufferOptions, result: bufferResult }
  }
}

test('both upload paths persist every supported structured field and keep pending records private', async (t) => {
  const uploads = await uploadBoth(t, richOptions)

  for (const [name, upload] of Object.entries(uploads)) {
    t.is(upload.result.success, true, `${name} upload succeeds`)
    t.is(upload.channel.addVideoCalls.length, 1, `${name} writes one logical record`)
    t.alike(
      upload.channel.addVideoCalls[0],
      {
        metadata: expectedRichMetadata(upload.result, upload.options),
        options: { syncPublic: false }
      },
      `${name} passes the exact normalized logical record`
    )
    t.alike(upload.result.metadata, expectedRichMetadata(upload.result, upload.options), `${name} returns the persisted metadata`)
    assertRejectedFieldsAbsent(t, upload.channel.addVideoCalls[0].metadata)
  }
})

test('sparse legacy uploads keep legacy defaults and sync publicly through both paths', async (t) => {
  const uploads = await uploadBoth(t, () => ({ title: 'Legacy clip', mimeType: 'video/webm' }))

  for (const [name, upload] of Object.entries(uploads)) {
    const call = upload.channel.addVideoCalls[0]
    t.is(upload.result.success, true, `${name} upload succeeds`)
    t.alike(call.options, { syncPublic: true }, `${name} retains legacy public sync`)
    t.is(call.metadata.title, 'Legacy clip')
    t.is(call.metadata.description, '')
    t.is(call.metadata.category, '')
    t.is(call.metadata.width, 0)
    t.is(call.metadata.height, 0)
    t.absent('publicationState' in call.metadata, `${name} does not invent a publication state`)
    t.alike(upload.result.metadata, call.metadata, `${name} returns the same logical record it persisted`)
  }
})

test('durable and published structured uploads sync publicly', async (t) => {
  const manager = createUploadManager({ ctx: {} })

  for (const publicationState of ['durabilityVerified', 'published']) {
    const channel = makeChannel()
    const result = await manager.uploadFromBuffer(channel, FIXTURE_BYTES, {
      title: publicationState,
      mimeType: 'video/webm',
      publicationState
    })

    t.is(result.success, true)
    t.is(channel.addVideoCalls[0].metadata.publicationState, publicationState)
    t.alike(channel.addVideoCalls[0].options, { syncPublic: true })
  }
})

test('invalid structured values and incomplete import identities never reach addVideo', async (t) => {
  const manager = createUploadManager({ ctx: {} })
  const cases = [
    {
      options: { title: 'Invalid state', mimeType: 'video/webm', publicationState: 'draft' },
      error: /publication state/
    },
    {
      options: {
        title: 'Incomplete claim',
        mimeType: 'video/webm',
        contentKind: 'episode',
        sourceProvider: 'tmdb',
        sourceVideoId: '62085',
        importIdentityKey: 'tmdb:episode:62085'
      },
      error: /must be supplied together/
    },
    {
      options: {
        title: 'Mismatched claim',
        mimeType: 'video/webm',
        contentKind: 'movie',
        mediaProvider: 'tmdb',
        mediaId: '550',
        importIdentityKey: 'tmdb:movie:wrong',
        importClaimantId: 'cc'.repeat(32)
      },
      error: /must match normalized content identity/
    }
  ]

  for (const contractCase of cases) {
    const channel = makeChannel()
    const result = await manager.uploadFromBuffer(channel, FIXTURE_BYTES, contractCase.options)
    t.is(result.success, false)
    t.ok(contractCase.error.test(result.error), result.error)
    t.is(channel.addVideoCalls.length, 0, 'invalid metadata is not persisted')
  }
})

test('invalid structured metadata is rejected before media or playback side effects on both paths', async (t) => {
  const playbackProfileWrites = []
  const manager = createUploadManager({
    ctx: {
      metaSubspaces: {
        playbackProfiles: {
          async put(key, profile) {
            playbackProfileWrites.push({ key, profile })
          }
        }
      }
    }
  })
  const { fakeFs, filePath, fsCalls } = makeFixture(t, MP4_FIXTURE_BYTES)
  const invalidOptions = [
    { title: 'Invalid state', publicationState: 'draft' },
    {
      title: 'Incomplete claim',
      contentKind: 'episode',
      sourceProvider: 'tmdb',
      sourceVideoId: '62085',
      importIdentityKey: 'tmdb:episode:62085'
    }
  ]

  for (const options of invalidOptions) {
    const pathChannel = makeChannel()
    const pathProgress = []
    const pathResult = await manager.uploadFromPath(
      pathChannel,
      filePath,
      options,
      fakeFs,
      (...progress) => pathProgress.push(progress)
    )
    t.is(pathResult.success, false)
    t.alike(pathChannel.uploadActivity, { blobStreams: 0, putBlobs: 0 })
    t.alike(pathProgress, [], 'invalid path upload reports no completed progress')
    t.is(pathChannel.addVideoCalls.length, 0)

    const bufferChannel = makeChannel()
    const bufferProgress = []
    const bufferResult = await manager.uploadFromBuffer(
      bufferChannel,
      MP4_FIXTURE_BYTES,
      options,
      (...progress) => bufferProgress.push(progress)
    )
    t.is(bufferResult.success, false)
    t.alike(bufferChannel.uploadActivity, { blobStreams: 0, putBlobs: 0 })
    t.alike(bufferProgress, [], 'invalid buffer upload reports no completed progress')
    t.is(bufferChannel.addVideoCalls.length, 0)
  }

  t.alike(fsCalls, { stat: 0, readStream: 0 }, 'invalid path metadata is rejected before media inspection')
  t.alike(playbackProfileWrites, [], 'invalid uploads never persist playback profiles')
})

const ALLOWLISTED_UPLOAD_FIELDS = [
  'title',
  'description',
  'mimeType',
  'duration',
  'thumbnail',
  'thumbnailUrl',
  'thumbnailBlobId',
  'thumbnailBlobsCoreKey',
  'thumbnailMimeType',
  'category',
  'width',
  'height',
  'contentKind',
  'sourceProvider',
  'sourceVideoId',
  'identityUrl',
  'sourceCreatorId',
  'sourceCreatorUrl',
  'sourcePublishedAt',
  'mediaProvider',
  'mediaId',
  'seasonNumber',
  'episodeNumber',
  'originalAirDate',
  'provenanceVersion',
  'publicationState',
  'contentFingerprint',
  'importIdentityKey',
  'importClaimantId'
]

function statefulUploadOptions() {
  const values = richOptions()
  const reads = {}
  const options = {}
  for (const field of ALLOWLISTED_UPLOAD_FIELDS) {
    reads[field] = 0
    Object.defineProperty(options, field, {
      enumerable: true,
      get() {
        reads[field]++
        if (field === 'thumbnailUrl' && reads[field] > 1) return ' invalid late thumbnail URL '
        return values[field]
      }
    })
  }
  Object.defineProperty(options, 'fetchUrl', {
    get() {
      throw new Error('secret fetchUrl getter must not be read')
    }
  })
  return { options, reads, values }
}

function expectedOptionReads() {
  return Object.fromEntries(ALLOWLISTED_UPLOAD_FIELDS.map((field) => [field, 1]))
}

function validateThumbnailAtAddVideo(channel) {
  const addVideo = channel.addVideo.bind(channel)
  channel.addVideo = async (metadata, options) => {
    normalizeContentDetails({ id: metadata.id, thumbnailUrl: metadata.thumbnailUrl })
    return addVideo(metadata, options)
  }
}

test('both paths snapshot allowlisted options once before caller mutation or upload side effects', async (t) => {
  const manager = createUploadManager({ ctx: {} })
  const { fakeFs, filePath } = makeFixture(t)

  const pathState = statefulUploadOptions()
  const pathChannel = makeChannel()
  validateThumbnailAtAddVideo(pathChannel)
  const stat = fakeFs.statSync.bind(fakeFs)
  fakeFs.statSync = (path) => {
    t.alike(pathState.reads, expectedOptionReads(), 'path options are snapshotted before filesystem access')
    pathState.values.title = 'Mutated path title'
    return stat(path)
  }
  const pathResult = await manager.uploadFromPath(pathChannel, filePath, pathState.options, fakeFs)
  t.is(pathResult.success, true)
  t.is(pathResult.metadata?.title, 'Pilot', 'path persists the captured legacy value')
  t.is(pathResult.metadata?.thumbnailUrl, 'https://images.example/pilot.jpg', 'path persists the captured normalized value')
  t.alike(pathState.reads, expectedOptionReads(), 'path reads each allowlisted field exactly once')
  t.is(pathChannel.addVideoCalls.length, 1, 'path has no late validation failure')

  const bufferState = statefulUploadOptions()
  const bufferChannel = makeChannel()
  validateThumbnailAtAddVideo(bufferChannel)
  const putBlob = bufferChannel.putBlob.bind(bufferChannel)
  bufferChannel.putBlob = async (buffer) => {
    t.alike(bufferState.reads, expectedOptionReads(), 'buffer options are snapshotted before blob persistence')
    bufferState.values.title = 'Mutated buffer title'
    return putBlob(buffer)
  }
  const bufferResult = await manager.uploadFromBuffer(bufferChannel, FIXTURE_BYTES, bufferState.options)
  t.is(bufferResult.success, true)
  t.is(bufferResult.metadata?.title, 'Pilot', 'buffer persists the captured legacy value')
  t.is(bufferResult.metadata?.thumbnailUrl, 'https://images.example/pilot.jpg', 'buffer persists the captured normalized value')
  t.alike(bufferState.reads, expectedOptionReads(), 'buffer reads each allowlisted field exactly once')
  t.is(bufferChannel.addVideoCalls.length, 1, 'buffer has no late validation failure')
})

// A consumer holds no metadata-provider credentials. Cover art reaches it only
// if the publisher's upload carries it into the record it persists, so a drop
// anywhere along this path renders every catalog as blank placeholders.
test('uploads carry validated cover art into the persisted record', async (t) => {
  const manager = createUploadManager({ ctx: {} })
  const channel = makeChannel()

  const result = await manager.uploadFromBuffer(channel, FIXTURE_BYTES, {
    title: 'Cover art',
    mimeType: 'video/webm',
    artwork: [
      { role: 'poster', remoteUrl: 'https://image.example/poster.jpg' },
      { role: 'thumbnail', remoteUrl: 'https://image.example/thumb.jpg' }
    ]
  })

  t.is(result.success, true)
  t.alike(
    channel.addVideoCalls[0].metadata.artwork,
    [
      { role: 'poster', remoteUrl: 'https://image.example/poster.jpg' },
      { role: 'thumbnail', remoteUrl: 'https://image.example/thumb.jpg' }
    ],
    'the persisted record keeps every claimed role and locator'
  )
})

test('malformed cover art is rejected before anything is persisted', async (t) => {
  const manager = createUploadManager({ ctx: {} })
  const cases = [
    { artwork: [{ role: 'nope', remoteUrl: 'https://image.example/x.jpg' }], error: /artwork role/ },
    { artwork: [{ role: 'poster' }], error: /blobId or remoteUrl/ },
    {
      artwork: [
        { role: 'poster', remoteUrl: 'https://image.example/a.jpg' },
        { role: 'poster', remoteUrl: 'https://image.example/b.jpg' }
      ],
      error: /duplicated/
    },
    { artwork: [{ role: 'poster', remoteUrl: 'https://image.example/a.jpg', bogus: 'x' }], error: /channel artwork/ }
  ]

  for (const { artwork, error } of cases) {
    const channel = makeChannel()
    const result = await manager.uploadFromBuffer(channel, FIXTURE_BYTES, { title: 'Bad art', mimeType: 'video/webm', artwork })
    t.is(result.success, false, 'the upload reports failure rather than publishing unvalidated art')
    t.ok(error.test(String(result.error)), `the failure names the problem: ${result.error}`)
    t.is(channel.addVideoCalls.length, 0, 'nothing is persisted when cover art does not validate')
  }
})
