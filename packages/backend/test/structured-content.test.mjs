import test from 'brittle'
import {
  ARTWORK_ROLES,
  CONTENT_KINDS,
  PROFILE_KINDS,
  PUBLICATION_STATES,
  channelSourceIdentityKey,
  deriveImportClaimantId,
  importIdentityKey,
  normalizeArtworkRole,
  normalizeChannelArtwork,
  normalizeChannelProfile,
  normalizeChannelSource,
  normalizeContentDetails,
  normalizeContentKind,
  normalizeImportClaim,
  normalizeProfileKind,
  normalizePublicationState,
  resolveClaimWinner
} from '../src/channel/index.js'

const WRITER_A = 'ab'.repeat(32)
const WRITER_B = 'cd'.repeat(32)
const FINGERPRINT = `sha256:${'12'.repeat(32)}`

async function rejects (t, callback, pattern, message) {
  await t.exception(callback, pattern, message)
}

test('exports the structured content value sets', (t) => {
  t.alike([...PROFILE_KINDS], ['standard', 'tvShow', 'movie', 'creator'])
  t.alike([...CONTENT_KINDS], ['episode', 'movie', 'video', 'stream', 'trailer', 'extra', 'track', 'release'])
  t.alike([...PUBLICATION_STATES], ['replicationPending', 'commitUncertain', 'durabilityVerified', 'published'])
  t.alike([...ARTWORK_ROLES], ['avatar', 'poster', 'banner', 'backdrop'])
})

test('normalizes canonical profile and content kinds and the TV_SHOW alias', async (t) => {
  t.is(normalizeProfileKind('TV_SHOW'), 'tvShow')
  for (const kind of PROFILE_KINDS) t.is(normalizeProfileKind(kind), kind)
  for (const kind of CONTENT_KINDS) t.is(normalizeContentKind(kind), kind)
  for (const state of PUBLICATION_STATES) t.is(normalizePublicationState(state), state)
  for (const role of ARTWORK_ROLES) t.is(normalizeArtworkRole(role), role)

  await rejects(t, () => normalizeProfileKind('series'), /profile kind/, 'unknown profile kind is rejected')
  await rejects(t, () => normalizeContentKind('short'), /content kind/, 'unknown content kind is rejected')
  await rejects(t, () => normalizePublicationState('draft'), /publication state/, 'unknown publication state is rejected')
  await rejects(t, () => normalizeArtworkRole('thumbnail'), /artwork role/, 'unknown artwork role is rejected')
})

test('derives import identities in approved precedence order', (t) => {
  t.is(importIdentityKey({
    contentKind: 'episode',
    sourceProvider: 'tmdb',
    sourceVideoId: '62085'
  }), 'tmdb:episode:62085')
  t.is(importIdentityKey({
    contentKind: 'episode',
    sourceProvider: 'tmdb',
    sourceVideoId: '62085',
    mediaProvider: 'tmdb',
    mediaId: '1396',
    seasonNumber: 1,
    episodeNumber: 1
  }), 'tmdb:episode:62085', 'exact source identity precedes complete media coordinates')
  t.is(importIdentityKey({
    contentKind: 'video',
    sourceProvider: 'youtube',
    sourceVideoId: 'abc:part:1'
  }), 'youtube:video:abc:part:1')
  t.is(importIdentityKey({
    contentKind: 'episode',
    mediaProvider: 'tmdb',
    mediaId: '1396',
    seasonNumber: 1,
    episodeNumber: 1
  }), 'tmdb:episode:show:1396:s1:e1')
  t.is(importIdentityKey({
    contentKind: 'movie',
    mediaProvider: 'tmdb',
    mediaId: '550'
  }), 'tmdb:movie:550')
  t.is(importIdentityKey({
    contentKind: 'extra',
    contentFingerprint: FINGERPRINT
  }), `fingerprint:${FINGERPRINT}`)
  t.is(importIdentityKey({
    contentKind: 'movie',
    sourceProvider: 'imdb',
    sourceVideoId: 'tt0137523',
    contentFingerprint: FINGERPRINT
  }), 'imdb:movie:tt0137523', 'exact source identity precedes fingerprint')
})

test('rejects insufficient, heuristic, partial, and ambiguous import identities', async (t) => {
  const invalid = [
    {},
    { contentKind: 'unknown', sourceProvider: 'tmdb', sourceVideoId: '1' },
    { contentKind: 'episode', identityUrl: 'https://example.test/watch/1' },
    { contentKind: 'episode', title: 'Pilot', sourcePublishedAt: 1 },
    { contentKind: 'episode', sourceProvider: 'tmdb' },
    { contentKind: 'episode', sourceVideoId: '62085' },
    { contentKind: 'episode', mediaProvider: 'tmdb', mediaId: '1396', seasonNumber: 1 },
    { contentKind: 'episode', mediaProvider: 'tmdb', mediaId: '1396', episodeNumber: 1 },
    { contentKind: 'track', mediaProvider: 'tmdb', mediaId: '81189' },
    { contentKind: 'track', mediaProvider: 'musicbrainz', mediaId: '81189', seasonNumber: 1 },
    { contentKind: 'release', mediaProvider: 'tvdb', mediaId: '81189' },
    { contentKind: 'movie', mediaProvider: 'tmdb' },
    { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '550', seasonNumber: 1 },
    { contentKind: 'video', mediaProvider: 'tmdb', mediaId: '550' },
    { contentKind: 'video', contentFingerprint: 'sha256:not-a-full-digest' },
    { contentKind: 'video', contentFingerprint: FINGERPRINT, sourceProvider: 'youtube' },
    { contentKind: 'video', sourceProvider: 'a:episode', sourceVideoId: 'x' },
    { contentKind: 'video', sourceProvider: 'YouTube', sourceVideoId: 'x' },
    { contentKind: 'episode', mediaProvider: 'TMDB', mediaId: '1', seasonNumber: 1, episodeNumber: 1 }
  ]

  for (const value of invalid) {
    await rejects(t, () => importIdentityKey(value), /import identity|content kind|sourceProvider|mediaProvider|seasonNumber|episodeNumber/, `rejects ${JSON.stringify(value)}`)
  }
})

test('channel source identity prefers source ID and hashes only an already-normalized identity URL', async (t) => {
  t.is(channelSourceIdentityKey({
    provider: 'youtube',
    sourceId: 'UC1',
    identityUrl: 'https://youtube.com/@changed'
  }), 'id:UC1')
  const key = channelSourceIdentityKey({ provider: 'web', identityUrl: 'https://example.test/creator' })
  t.is(key, 'url:sha256:9421ff3e47ebf551050d58e7f7d6bc81cb521592f86cf8017ffcd8b23b65e180',
    'URL identity key pins the SHA-256 algorithm and exact URL bytes')
  t.is(key, channelSourceIdentityKey({ provider: 'different', identityUrl: 'https://example.test/creator' }), 'provider is not duplicated into URL identity payload')
  t.not(key, channelSourceIdentityKey({ provider: 'web', identityUrl: 'https://example.test/creator/' }), 'raw URL variants are not canonicalized')
  await rejects(t, () => channelSourceIdentityKey({ provider: 'Bad:Provider', sourceId: 'creator-1' }), /provider/)
  await rejects(t, () => channelSourceIdentityKey({ provider: 'web' }), /sourceId or identityUrl/)
})

test('normalizes channel profiles with explicit fields and safe bounds', async (t) => {
  const input = Object.freeze({
    id: 'profile-1',
    profileKind: 'TV_SHOW',
    mediaProvider: 'tmdb',
    mediaId: '1396',
    originalLanguage: 'en',
    releaseDate: 1212537600000,
    releaseYear: 2008
  })
  t.alike(normalizeChannelProfile(input), {
    id: 'profile-1',
    profileKind: 'tvShow',
    mediaProvider: 'tmdb',
    mediaId: '1396',
    originalLanguage: 'en',
    releaseDate: 1212537600000,
    releaseYear: 2008
  })
  t.is(input.profileKind, 'TV_SHOW', 'caller input remains unchanged')

  await rejects(t, () => normalizeChannelProfile({ ...input, releaseDate: Number.MAX_SAFE_INTEGER + 1 }), /releaseDate/)
  await rejects(t, () => normalizeChannelProfile({ ...input, releaseDate: Number.MAX_SAFE_INTEGER }), /releaseDate/)
  await rejects(t, () => normalizeChannelProfile({ ...input, releaseYear: Number.MAX_SAFE_INTEGER }), /releaseYear/)
  await rejects(t, () => normalizeChannelProfile({ ...input, releaseYear: -1 }), /releaseYear/)
  await rejects(t, () => normalizeChannelProfile({ ...input, mediaProvider: 'p'.repeat(65) }), /mediaProvider/)
  await rejects(t, () => normalizeChannelProfile({ ...input, mediaProvider: 'TMDB' }), /mediaProvider/)
  await rejects(t, () => normalizeChannelProfile({ ...input, mediaId: 'i'.repeat(257) }), /mediaId/)
})

test('normalizes content details without retaining ephemeral fields', (t) => {
  const input = Object.freeze({
    id: 'episode-1',
    contentKind: 'episode',
    sourceProvider: 'tmdb',
    sourceVideoId: '62085',
    identityUrl: 'https://www.themoviedb.org/tv/1396/season/1/episode/1',
    sourceCreatorId: '1396',
    sourceCreatorUrl: 'https://www.themoviedb.org/tv/1396',
    sourcePublishedAt: 1212537600000,
    mediaProvider: 'tmdb',
    mediaId: '1396',
    seasonNumber: 1,
    episodeNumber: 1,
    originalAirDate: 1212537600000,
    thumbnailUrl: 'https://image.tmdb.org/pilot.jpg',
    provenanceVersion: 'tmdb-resolver@1',
    publicationState: 'replicationPending',
    contentFingerprint: FINGERPRINT,
    importIdentityKey: 'tmdb:episode:62085',
    importClaimantId: '01'.repeat(32)
  })
  t.alike(normalizeContentDetails(input), input)
  t.is(input.publicationState, 'replicationPending', 'caller input remains unchanged')
})

test('rejects invalid content coordinates, timestamps, states, claimant IDs, and bounds', async (t) => {
  const base = { id: 'episode-1', contentKind: 'episode' }
  const invalid = [
    [{ ...base, seasonNumber: -1 }, /seasonNumber/],
    [{ ...base, seasonNumber: 1.5 }, /seasonNumber/],
    [{ ...base, episodeNumber: -1 }, /episodeNumber/],
    [{ ...base, episodeNumber: 2.5 }, /episodeNumber/],
    [{ ...base, sourcePublishedAt: -1 }, /sourcePublishedAt/],
    [{ ...base, sourcePublishedAt: Number.MAX_SAFE_INTEGER }, /sourcePublishedAt/],
    [{ ...base, seasonNumber: Number.MAX_SAFE_INTEGER }, /seasonNumber/],
    [{ ...base, episodeNumber: Number.MAX_SAFE_INTEGER }, /episodeNumber/],
    [{ ...base, originalAirDate: Number.MAX_SAFE_INTEGER }, /originalAirDate/],
    [{ ...base, originalAirDate: Number.MAX_SAFE_INTEGER + 1 }, /originalAirDate/],
    [{ ...base, publicationState: 'queued' }, /publication state/],
    [{ ...base, importClaimantId: 'ABC'.repeat(22) }, /importClaimantId/],
    [{ ...base, sourceProvider: 'p'.repeat(65) }, /sourceProvider/],
    [{ ...base, sourceProvider: 'YouTube' }, /sourceProvider/],
    [{ ...base, mediaProvider: 'TMDB' }, /mediaProvider/],
    [{ ...base, sourceVideoId: 'i'.repeat(257) }, /sourceVideoId/],
    [{ ...base, identityUrl: 'https://example.test/' + 'u'.repeat(2030) }, /identityUrl/],
    [{ ...base, sourceCreatorUrl: 'https://example.test/' + 'u'.repeat(2030) }, /sourceCreatorUrl/],
    [{ ...base, thumbnailUrl: 'https://example.test/' + 'u'.repeat(2030) }, /thumbnailUrl/],
    [{ ...base, contentFingerprint: 'sha256:abc' }, /contentFingerprint/],
    [{ ...base, contentFingerprint: `sha256:${'AB'.repeat(32)}` }, /contentFingerprint/],
    [{ ...base, importIdentityKey: 'tmdb:episode:62085' }, /importIdentityKey.*importClaimantId/],
    [{ ...base, importClaimantId: '01'.repeat(32) }, /importIdentityKey.*importClaimantId/],
    [{
      ...base,
      sourceProvider: 'tmdb',
      sourceVideoId: '62085',
      importIdentityKey: 'tmdb:episode:wrong',
      importClaimantId: '01'.repeat(32)
    }, /importIdentityKey.*match/]
  ]
  for (const [value, pattern] of invalid) await rejects(t, () => normalizeContentDetails(value), pattern)
})

test('normalizes channel sources, derives their keys, and rejects every source boundary', async (t) => {
  const source = Object.freeze({
    provider: 'youtube',
    sourceId: 'UC1',
    identityUrl: 'https://youtube.com/channel/UC1',
    handle: '@creator',
    displayName: 'Creator',
    createdAt: 1,
    updatedAt: 2
  })
  t.alike(normalizeChannelSource(source), {
    provider: 'youtube',
    identityKey: 'id:UC1',
    sourceId: 'UC1',
    identityUrl: 'https://youtube.com/channel/UC1',
    handle: '@creator',
    displayName: 'Creator',
    createdAt: 1,
    updatedAt: 2
  })
  t.absent(source.identityKey, 'caller input is not mutated')
  t.is(normalizeChannelSource({ provider: 'web', identityUrl: 'https://example.test/creator' }).identityKey,
    channelSourceIdentityKey({ identityUrl: 'https://example.test/creator' }))

  const invalid = [
    [{ sourceId: 'UC1' }, /provider/],
    [{ provider: 'web' }, /sourceId or identityUrl/],
    [{ provider: 'p'.repeat(65), sourceId: '1' }, /provider/],
    [{ provider: 'YouTube', sourceId: '1' }, /provider/],
    [{ provider: 'web', sourceId: 'i'.repeat(257) }, /sourceId/],
    [{ provider: 'web', identityUrl: 'u'.repeat(2049) }, /identityUrl/],
    [{ provider: 'web', sourceId: '1', handle: 'h'.repeat(257) }, /handle/],
    [{ provider: 'web', sourceId: '1', displayName: 'd'.repeat(257) }, /displayName/],
    [{ provider: 'web', sourceId: '1', createdAt: Number.MAX_SAFE_INTEGER + 1 }, /createdAt/],
    [{ provider: 'web', sourceId: '1', createdAt: Number.MAX_SAFE_INTEGER }, /createdAt/],
    [{ provider: 'web', sourceId: '1', updatedAt: Number.MAX_SAFE_INTEGER }, /updatedAt/],
    [{ provider: 'web', sourceId: '1', identityKey: 'id:wrong' }, /identityKey/]
  ]
  for (const [value, pattern] of invalid) await rejects(t, () => normalizeChannelSource(value), pattern)
})

test('normalizes artwork and rejects invalid roles, timestamps, and bounded fields', async (t) => {
  const input = Object.freeze({
    role: 'poster',
    blobId: '1:2:0:20',
    blobsCoreKey: WRITER_A,
    mimeType: 'image/jpeg',
    remoteUrl: 'https://image.tmdb.org/poster.jpg',
    updatedAt: 7
  })
  t.alike(normalizeChannelArtwork(input), input)
  t.is(input.role, 'poster', 'caller input remains unchanged')
  await rejects(t, () => normalizeChannelArtwork({ ...input, role: 'cover' }), /artwork role/)
  await rejects(t, () => normalizeChannelArtwork({ ...input, blobId: 'i'.repeat(257) }), /blobId/)
  await rejects(t, () => normalizeChannelArtwork({ ...input, blobsCoreKey: 'a'.repeat(257) }), /blobsCoreKey/)
  await rejects(t, () => normalizeChannelArtwork({ ...input, mimeType: 'm'.repeat(129) }), /mimeType/)
  await rejects(t, () => normalizeChannelArtwork({ ...input, remoteUrl: 'u'.repeat(2049) }), /remoteUrl/)
  await rejects(t, () => normalizeChannelArtwork({ ...input, updatedAt: -1 }), /updatedAt/)
  await rejects(t, () => normalizeChannelArtwork({ ...input, updatedAt: Number.MAX_SAFE_INTEGER }), /updatedAt/)
})

test('derives stable domain-separated claimant IDs from exact writer and job bytes', async (t) => {
  const claimant = deriveImportClaimantId(WRITER_A, 'job-7')
  t.is(claimant, 'a89dffb7b9619675a814843c56dfe227e1ced64c8a9c93798b62a3cef4fb14d4',
    'claimant digest pins SHA-256, the v1 domain, and byte framing')
  t.is(claimant, deriveImportClaimantId(WRITER_A, 'job-7'))
  t.not(claimant, deriveImportClaimantId(WRITER_B, 'job-7'))
  t.not(claimant, deriveImportClaimantId(WRITER_A, 'job-8'))
  t.ok(/^[0-9a-f]{64}$/.test(claimant))
  t.is(claimant, deriveImportClaimantId(WRITER_A.toUpperCase(), 'job-7'), 'hex case decodes to identical writer bytes')

  const invalidWriters = ['', 'ab', 'zz'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33)]
  for (const writer of invalidWriters) await rejects(t, () => deriveImportClaimantId(writer, 'job-7'), /writerKeyHex/)
  const invalidJobs = ['', ' job', 'job ', 'job\0id', 'job id', 'j'.repeat(257)]
  for (const job of invalidJobs) await rejects(t, () => deriveImportClaimantId(WRITER_A, job), /durableJobId/)
})

test('normalizes authenticated import claims and rejects malformed or mismatched IDs', async (t) => {
  const claimantId = deriveImportClaimantId(WRITER_A, 'job-7')
  const claim = Object.freeze({
    identityKey: 'tmdb:episode:62085',
    claimantId,
    jobId: 'job-7',
    writerKey: WRITER_A,
    videoId: 'episode-1',
    state: 'reserved',
    createdAt: 1,
    updatedAt: 2
  })
  t.alike(normalizeImportClaim(claim), claim)
  t.is(claim.claimantId, claimantId, 'caller input remains unchanged')
  await rejects(t, () => normalizeImportClaim({ ...claim, claimantId: 'a'.repeat(64) }), /claimantId.*match/)
  await rejects(t, () => normalizeImportClaim({ ...claim, claimantId: claimantId.toUpperCase() }), /claimantId/)
  await rejects(t, () => normalizeImportClaim({ ...claim, writerKey: 'ab' }), /writerKey/)
  await rejects(t, () => normalizeImportClaim({ ...claim, jobId: 'bad job' }), /jobId/)
  await rejects(t, () => normalizeImportClaim({ ...claim, jobId: 'j'.repeat(257) }), /jobId/)
  await rejects(t, () => normalizeImportClaim({ ...claim, state: 'expired' }), /state/)
  await rejects(t, () => normalizeImportClaim({ ...claim, releasedAt: Number.MAX_SAFE_INTEGER + 1 }), /releasedAt/)
  await rejects(t, () => normalizeImportClaim({ ...claim, state: 'released' }), /releasedAt/)
})

test('all persistence normalizers reject ephemeral, secret, and arbitrary keys', async (t) => {
  const claimantId = deriveImportClaimantId(WRITER_A, 'job-7')
  const cases = [
    [normalizeChannelProfile, { id: 'profile-1' }],
    [normalizeContentDetails, { id: 'video-1' }],
    [normalizeChannelSource, { provider: 'web', sourceId: 'creator-1' }],
    [normalizeChannelArtwork, { role: 'poster' }],
    [normalizeImportClaim, { identityKey: 'fingerprint:x', claimantId, jobId: 'job-7', writerKey: WRITER_A }]
  ]
  const forbidden = ['fetchUrl', 'displayUrl', 'credentials', 'cookies', 'token', 'providerData', 'unexpected']

  for (const [normalize, base] of cases) {
    for (const key of forbidden) {
      await rejects(t, () => normalize({ ...base, [key]: 'secret' }), /unknown field/, `${normalize.name} rejects ${key}`)
    }
  }
})

test('resolves the lexicographically lowest non-released claim without mutation', (t) => {
  const claims = [
    { claimantId: 'b', state: 'reserved' },
    { claimantId: 'a', state: 'published' },
    { claimantId: '0', state: 'released' }
  ]
  const snapshot = JSON.stringify(claims)
  t.is(resolveClaimWinner(claims), claims[1])
  t.is(JSON.stringify(claims), snapshot)
  t.is(resolveClaimWinner([...claims].reverse()), claims[1], 'winner is order-independent')
  t.is(resolveClaimWinner([{ claimantId: '0', state: 'released' }]), null)
  t.is(resolveClaimWinner(), null)
})
