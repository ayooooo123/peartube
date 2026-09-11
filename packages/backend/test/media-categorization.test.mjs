import test from 'brittle'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MEDIA_COORDINATE_SHAPES, importIdentityKey } from '../src/channel/structured-content.js'
import { createEntityReference } from '../src/media-graph/index.js'
import { parsePeartubeArgv } from '../../cli/src/add/argv.js'
import { runAddCommand } from '../../cli/src/add/index.js'

import {
  buildEpisodeItemDraft,
  buildMovieItemDraft,
  buildReleaseItemDraft,
  buildTrackItemDraft
} from '../../cli/src/add/content-model.js'

const RECORDING_MBID = 'b1a9c0e8-2f9d-4b3e-9a24-6f3c1d9a7b55'
const RELEASE_MBID = '550e8400-e29b-41d4-a716-446655440000'
const SOURCE = { provider: 'youtube', sourceVideoId: 'v1', identityUrl: 'https://youtube.com/watch?v=v1' }


const CHANNEL = { channelKey: 'chan-1', writerKeyHex: 'a'.repeat(64), publicBeeKey: 'b'.repeat(64) }

// Drives argv and metadata resolution through the canonical acquisition input.
// The staged file belongs to this invocation; acquisition itself is recorded.
async function addWithCli (argv) {
  const parsed = parsePeartubeArgv(['add', 'https://youtube.com/watch?v=v1', ...argv], { stdin: {}, stderr: {} })
  const uploads = []
  const stderr = []
  const code = await runAddCommand({
    ...parsed,
    stdout: { write () {} },
    stderr: { write (text) { stderr.push(String(text)) } },
    env: {},
    resolveConfig: async () => ({ content: { tmdbApiKey: 'token' } }),
    deps: {
      openAddRuntime: async () => ({
        ensureLocalPublisher: async () => ({ publisherId: 'c'.repeat(64) }),
        close: async () => {}
      }),
      ensureLocalPublisher: async () => ({ publisherId: 'c'.repeat(64) }),
      resolveChannel: async () => CHANNEL,
      duplicateCheck: { check: async () => ({ status: 'ok', advisories: [] }) },
      arbitrateImportClaim: async () => ({ ok: true }),
      stageSource: async () => {
        const directory = mkdtempSync(join(tmpdir(), 'peartube-categorization-'))
        const artifactPath = join(directory, 'a.mkv')
        writeFileSync(artifactPath, 'coordinate-fixture')
        return { artifactPath, dispose: () => rmSync(directory, { recursive: true, force: true }) }
      },
      executeLocalFileAcquisition: async (args) => {
        uploads.push(args)
        return {
          acquisitionId: 'acq-1',
          state: 'completed',
          publicationId: 'pub-1',
          manifestId: 'manifest-1',
          renditionId: 'rendition-1',
          assetId: 'asset-1'
        }
      },
      createMetadataProvider: async (authority) => {
        if (authority === 'tmdb') {
          return {
            async getShow () { return { name: 'Breaking Bad', mediaId: '1396', provider: 'tmdb', artwork: [] } },
            async getSeason () { return [{ seasonNumber: 1, episodeNumber: 1, title: 'Pilot', airDate: '2008-01-20', artwork: [] }] },
            async getMovie () { return { title: 'The Matrix', mediaId: '603', provider: 'tmdb', artwork: [] } }
          }
        }
        if (authority === 'tvdb') {
          return {
            async getShow (id) { return { name: 'Breaking Bad', mediaId: String(id), provider: 'tvdb', artwork: [] } },
            async getSeason (id, season) { return [{ seasonNumber: 1, episodeNumber: 2, title: "Cat's in the Bag...", airDate: '2008-01-27', artwork: [] }] },
            async getMovie (id) { return { title: 'The Matrix', mediaId: String(id), provider: 'tvdb', artwork: [] } }
          }
        }
        if (authority === 'musicbrainz') {
          return {
            async getRecording (id) { return { title: 'Paranoid Android', mediaId: String(id), provider: 'musicbrainz', artwork: [] } },
            async getRelease (id) { return { title: 'OK Computer', mediaId: String(id), provider: 'musicbrainz', artwork: [] } }
          }
        }
      },
    }
  })
  return { code, uploads, stderr: stderr.join(''), parsed }
}

function usageFailure (argv) {
  try {
    parsePeartubeArgv(['add', 'https://youtube.com/watch?v=v1', ...argv], { stdin: {}, stderr: {} })
  } catch (error) {
    return error.message
  }
  return null
}

test('the coordinate table, not a provider name, decides what the CLI accepts', (t) => {
  t.alike(Object.keys(MEDIA_COORDINATE_SHAPES).sort(), ['episode', 'movie', 'release', 'track'])

  for (const [kind, argv] of [
    ['episode', ['--type', 'episode', '--provider', 'tvdb', '--show-id', '81189', '--season', '1', '--episode', '2', '--title', 'Pilot', '--yes']],
    ['movie', ['--type', 'movie', '--provider', 'tvdb', '--movie-id', '603', '--title', 'The Matrix', '--yes']],
    ['track', ['--type', 'track', '--provider', 'musicbrainz', '--recording-id', RECORDING_MBID, '--title', 'Paranoid Android', '--yes']],
    ['release', ['--type', 'release', '--provider', 'musicbrainz', '--release-id', RELEASE_MBID, '--title', 'OK Computer', '--yes']]
  ]) {
    const parsed = parsePeartubeArgv(['add', 'https://youtube.com/watch?v=v1', ...argv], { stdin: {}, stderr: {} })
    t.is(parsed.mode, 'scripted', `${kind} coordinates are a complete scripted add`)
    t.is(parsed.flags.type, kind)
  }
})

test('a TVDB episode and a TVDB movie publish with TVDB coordinates', async (t) => {
  const episode = await addWithCli(['--type', 'episode', '--provider', 'tvdb', '--show-id', '81189', '--season', '1', '--episode', '2', '--title', 'Cat\'s in the Bag...', '--yes'])
  t.is(episode.code, 0, episode.stderr)
  t.is(episode.uploads.length, 1)
  t.alike(episode.uploads[0].input.selector, {
    kind: 'episode',
    namespace: 'tvdb',
    identifier: '81189',
    season: 1,
    episode: 2
  })
  t.is(episode.uploads[0].input.title, 'Cat\'s in the Bag...', 'the publisher names the work the CLI cannot look up')

  const movie = await addWithCli(['--type', 'movie', '--provider', 'tvdb', '--movie-id', '603', '--title', 'The Matrix', '--yes'])
  t.is(movie.code, 0, movie.stderr)
  t.alike(movie.uploads[0].input.selector, {
    kind: 'movie',
    namespace: 'tvdb',
    identifier: '603'
  })
})

test('a MusicBrainz recording and release publish with MusicBrainz coordinates', async (t) => {
  const track = await addWithCli(['--type', 'track', '--provider', 'musicbrainz', '--recording-id', RECORDING_MBID, '--title', 'Paranoid Android', '--yes'])
  t.is(track.code, 0, track.stderr)
  t.alike(track.uploads[0].input.selector, {
    kind: 'track',
    namespace: 'musicbrainz',
    identifier: RECORDING_MBID
  })

  const release = await addWithCli(['--type', 'release', '--provider', 'musicbrainz', '--release-id', RELEASE_MBID, '--title', 'OK Computer', '--yes'])
  t.is(release.code, 0, release.stderr)
  t.alike(release.uploads[0].input.selector, {
    kind: 'release',
    namespace: 'musicbrainz',
    identifier: RELEASE_MBID
  })
})

test('drafts carry the caller-supplied authority, never a default one', (t) => {
  const episode = buildEpisodeItemDraft({ title: 'Pilot', seasonNumber: 1, episodeNumber: 2 }, SOURCE, { mediaProvider: 'tvdb', mediaId: '81189' })
  t.is(episode.mediaProvider, 'tvdb')
  t.is(episode.mediaId, '81189')

  const movie = buildMovieItemDraft({ title: 'The Matrix' }, SOURCE, { mediaProvider: 'tvdb', mediaId: 603 })
  t.is(movie.mediaProvider, 'tvdb')
  t.is(movie.mediaId, '603')
  t.is(movie.seasonNumber, null)

  const track = buildTrackItemDraft({ title: 'Paranoid Android' }, SOURCE, { mediaProvider: 'musicbrainz', mediaId: RECORDING_MBID })
  t.is(track.contentKind, 'track')
  t.is(track.mediaProvider, 'musicbrainz')
  t.is(track.mediaId, RECORDING_MBID)
  t.is(track.seasonNumber, null)
  t.is(track.episodeNumber, null)
  t.absent('fetchUrl' in track)

  const release = buildReleaseItemDraft({ title: 'OK Computer' }, SOURCE, { mediaProvider: 'musicbrainz', mediaId: RELEASE_MBID })
  t.is(release.contentKind, 'release')
  t.is(release.mediaProvider, 'musicbrainz')
  t.is(release.mediaId, RELEASE_MBID)

  // A coordinate nobody supplied is absent, not invented.
  const unknown = buildMovieItemDraft({ title: 'Untitled' }, SOURCE)
  t.is(unknown.mediaProvider, null)
  t.is(unknown.mediaId, null)
})

test('provider, kind and id are three independent axes of one identity', (t) => {
  const keys = [
    importIdentityKey({ contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '603' }),
    importIdentityKey({ contentKind: 'movie', mediaProvider: 'tvdb', mediaId: '603' }),
    importIdentityKey({ contentKind: 'release', mediaProvider: 'musicbrainz', mediaId: '603' })
  ]
  t.alike(keys, ['tmdb:movie:603', 'tvdb:movie:603', 'musicbrainz:release:603'])
  t.is(new Set(keys).size, 3, 'same id under a different authority or kind is a different work')
})

test('the tmdb identity spelling is byte-identical to the pre-change one', (t) => {
  t.is(
    importIdentityKey({ contentKind: 'episode', mediaProvider: 'tmdb', mediaId: '1399', seasonNumber: 1, episodeNumber: 2 }),
    'tmdb:episode:show:1399:s1:e2'
  )
  t.is(importIdentityKey({ contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '603' }), 'tmdb:movie:603')
  t.is(
    importIdentityKey({ contentKind: 'episode', mediaProvider: 'tvdb', mediaId: '1399', seasonNumber: 1, episodeNumber: 2 }),
    'tvdb:episode:show:1399:s1:e2'
  )
})

test('an authority a kind cannot carry is refused by naming the ones it can', (t) => {
  const trackUnderTmdb = usageFailure(['--type', 'track', '--provider', 'tmdb', '--recording-id', RECORDING_MBID, '--yes'])
  t.ok(trackUnderTmdb, 'tmdb cannot categorize a track')
  t.ok(/musicbrainz/.test(trackUnderTmdb), trackUnderTmdb)
  t.ok(/--recording-id/.test(trackUnderTmdb), trackUnderTmdb)

  const movieUnderMusicbrainz = usageFailure(['--type', 'movie', '--provider', 'musicbrainz', '--movie-id', '603', '--yes'])
  t.ok(movieUnderMusicbrainz, 'musicbrainz cannot categorize a movie')
  t.ok(/tmdb\|tvdb/.test(movieUnderMusicbrainz), movieUnderMusicbrainz)

  const unknownProvider = usageFailure(['--type', 'movie', '--provider', 'vimeo', '--movie-id', '603', '--yes'])
  t.ok(/tmdb\|tvdb/.test(unknownProvider), unknownProvider)

  t.exception(
    () => importIdentityKey({ contentKind: 'track', mediaProvider: 'tvdb', mediaId: '603' }),
    /musicbrainz/
  )
})

test('an ordinal a kind does not have is refused by naming the shape it does', (t) => {
  const trackWithSeason = usageFailure(['--type', 'track', '--provider', 'musicbrainz', '--recording-id', RECORDING_MBID, '--season', '1', '--yes'])
  t.ok(trackWithSeason, 'a track has no season')
  t.ok(/--season/.test(trackWithSeason), trackWithSeason)
  t.ok(/--provider musicbrainz and --recording-id/.test(trackWithSeason), trackWithSeason)

  const movieWithEpisode = usageFailure(['--type', 'movie', '--provider', 'tmdb', '--movie-id', '603', '--episode', '2', '--yes'])
  t.ok(/--episode/.test(movieWithEpisode), movieWithEpisode)
  t.ok(/--provider tmdb\|tvdb and --movie-id/.test(movieWithEpisode), movieWithEpisode)

  const releaseWithShow = usageFailure(['--type', 'release', '--provider', 'musicbrainz', '--release-id', RELEASE_MBID, '--show-id', '81189', '--yes'])
  t.ok(/--show-id/.test(releaseWithShow), releaseWithShow)

  t.exception(
    () => importIdentityKey({ contentKind: 'track', mediaProvider: 'musicbrainz', mediaId: RECORDING_MBID, seasonNumber: 1 }),
    /cannot carry seasonNumber/
  )
})

test('provider namespaces canonicalize the identifiers publications carry', (t) => {
  const mixed = createEntityReference({ entityKind: 'recording', namespace: 'musicbrainz', normalizedIdentifier: `track:${RECORDING_MBID.toUpperCase()}` })
  const lower = createEntityReference({ entityKind: 'recording', namespace: 'musicbrainz', normalizedIdentifier: `track:${RECORDING_MBID}` })
  t.is(mixed.normalizedIdentifier, `track:${RECORDING_MBID}`, 'an MBID is hex; case must not mint a second entity')
  t.is(mixed.entityId, lower.entityId)

  // tmdb spellings are already lowercase, so canonicalization is a no-op there
  // and no existing entity id moves.
  const tmdb = createEntityReference({ entityKind: 'work', namespace: 'tmdb', normalizedIdentifier: 'show:1399:s1:e2' })
  t.is(tmdb.normalizedIdentifier, 'show:1399:s1:e2')
  const tvdb = createEntityReference({ entityKind: 'work', namespace: 'tvdb', normalizedIdentifier: 'show:81189:s1:e2' })
  t.is(tvdb.normalizedIdentifier, 'show:81189:s1:e2')
  t.not(tmdb.entityId, tvdb.entityId, 'the authority is part of the entity identity')
})
