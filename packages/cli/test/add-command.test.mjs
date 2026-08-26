import test from 'brittle'
import { runAddCommand } from '../src/add/index.js'
import { createJobStore } from '../src/add/job-store.js'
import { createExecutor } from '../src/add/executor.js'

function fakeBee () {
  const map = new Map()
  return {
    map,
    async get (k) { return map.has(k) ? { value: map.get(k) } : null },
    async put (k, v) { map.set(k, JSON.parse(JSON.stringify(v))) },
    async del (k) { map.delete(k) },
    batch () { const s = []; return { async put (k, v) { s.push([k, v]) }, async flush () { for (const [k, v] of s) map.set(k, JSON.parse(JSON.stringify(v))) } } },
    async * createReadStream ({ gte, lt } = {}) { for (const k of [...map.keys()].sort()) { if (gte !== undefined && k < gte) continue; if (lt !== undefined && k >= lt) continue; yield { key: k, value: map.get(k) } } }
  }
}

function capture () {
  const chunks = []
  return { chunks, write (text) { chunks.push(String(text)) }, text () { return chunks.join('') } }
}

const CHANNEL = { channelKey: 'chan-1', writerKeyHex: 'a'.repeat(64), publicBeeKey: 'b'.repeat(64) }

function fakeExecutorDeps ({ jobStore, uploads, downloads, channels = [], durable = { verified: true } }) {
  return {
    jobStore,
    resolveChannel: async ({ channelDraft }) => { channels.push(channelDraft); return CHANNEL },
    loadChannel: async () => CHANNEL,
    duplicateCheck: { check: async () => ({ status: 'ok', advisories: [] }) },
    deriveImportClaimantId: (w, j) => `claim:${j}`,
    writeClaim: async () => {},
    resolveClaimWinner: async () => null,
    downloadSource: async ({ row }) => { downloads.push(row.data.item); return { artifactPath: '/tmp/a.mkv', checksum: 'sha256:v' } },
    uploadFromPath: async (args) => { uploads.push(args); return { videoId: args.videoId, channelKey: CHANNEL.channelKey, blobKey: 'blob-1' } },
    requestPin: async () => {},
    awaitDurable: async () => durable,
    publication: {
      markDurabilityVerified: async () => {},
      project: async () => ({ channelKey: CHANNEL.channelKey, publicBeeKey: CHANNEL.publicBeeKey }),
      announce: async () => {},
      finalize: async () => {}
    }
  }
}

const RECORDING_MBID = 'b1a9c0e8-2f9d-4b3e-9a24-6f3c1d9a7b55'

// One fake per authority, shaped exactly like the real clients, behind the
// registry function `add` now injects instead of a single TMDB factory.
function metadataFake (calls) {
  const clients = {
    tmdb: {
      async getShow () { return { name: 'Breaking Bad', mediaId: '1396', provider: 'tmdb', artwork: [] } },
      async getSeason () { return [{ seasonNumber: 1, episodeNumber: 1, title: 'Pilot', airDate: '2008-01-20', artwork: [] }] },
      async getMovie () { return { title: 'The Matrix', mediaId: '603', provider: 'tmdb', year: 1999, artwork: [] } }
    },
    tvdb: {
      async getShow () { return { name: 'Breaking Bad', mediaId: '81189', provider: 'tvdb', artwork: [] } },
      async getSeason () { return [{ seasonNumber: 1, episodeNumber: 2, title: "Cat's in the Bag...", airDate: '2008-01-27', artwork: [] }] },
      async getMovie () { return { title: 'The Matrix', mediaId: '290434', provider: 'tvdb', year: 1999, artwork: [] } }
    },
    musicbrainz: {
      async getRecording () { return { title: 'Paranoid Android', artist: 'Radiohead', mediaId: RECORDING_MBID, provider: 'musicbrainz', firstReleaseDate: '1997-05-21', artwork: [] } },
      async getRelease () { return { title: 'OK Computer', artist: 'Radiohead', mediaId: '550e8400-e29b-41d4-a716-446655440000', provider: 'musicbrainz', date: '1997-05-21', artwork: [] } }
    }
  }
  return {
    createMetadataProvider: async (authority, options) => {
      calls.push({ authority, options })
      const client = clients[authority]
      if (!client) throw new Error(`no fake metadata client for ${authority}`)
      return client
    }
  }
}

function baseContext (overrides = {}) {
  const stdout = capture()
  const stderr = capture()
  const uploads = []
  const downloads = []
  const channels = []
  const providerCalls = []
  const durable = overrides.durable || { verified: true }
  const bee = fakeBee()
  const deps = {
    ...metadataFake(providerCalls),
    openAddRuntime: async () => ({ metadataBee: bee, close: async () => {} }),
    createJobStore,
    createExecutor,
    buildExecutorDeps: ({ jobStore }) => fakeExecutorDeps({ jobStore, uploads, downloads, channels, durable })
  }
  return {
    context: {
      command: 'add',
      mode: 'scripted',
      fetchUrl: 'https://youtube.com/watch?v=v1',
      stdout,
      stderr,
      env: {},
      resolveConfig: async () => ({ content: { tmdbApiKey: 'token' } }),
      deps,
      ...overrides.context
    },
    stdout,
    stderr,
    uploads,
    downloads,
    channels,
    providerCalls
  }
}

test('scripted episode publishes and writes one human stdout line with progress on stderr', async (t) => {
  const { context, stdout, uploads } = baseContext({
    context: { flags: { type: 'episode', provider: 'tmdb', showId: '1396', season: 1, episode: 1, yes: true } }
  })
  const code = await runAddCommand(context)
  t.is(code, 0)
  t.is(uploads.length, 1)
  t.ok(stdout.text().startsWith('Published peartube://channel/chan-1/video/'))
  t.is(stdout.chunks.filter((c) => c.includes('Published')).length, 1, 'exactly one final stdout line')
})

test('scripted movie with --json emits exactly one JSON object to stdout', async (t) => {
  const { context, stdout } = baseContext({
    context: { flags: { type: 'movie', provider: 'tmdb', movieId: '603', yes: true, json: true } }
  })
  const code = await runAddCommand(context)
  t.is(code, 0)
  const parsed = JSON.parse(stdout.text())
  t.is(parsed.status, 'published')
  t.is(parsed.channelKey, 'chan-1')
  t.ok(parsed.videoId)
})

test('already-exists is a success that reports stable identifiers', async (t) => {
  const { context, stdout, downloads } = baseContext({
    context: { flags: { type: 'movie', provider: 'tmdb', movieId: '603', yes: true, json: true } }
  })
  context.deps.buildExecutorDeps = ({ jobStore }) => ({
    ...fakeExecutorDeps({ jobStore, uploads: [], downloads }),
    duplicateCheck: { check: async () => ({ status: 'already-exists', existing: { channelKey: 'chan-1', videoId: 'existing-9', availability: 'published' } }) }
  })
  const code = await runAddCommand(context)
  t.is(code, 0)
  const parsed = JSON.parse(stdout.text())
  t.is(parsed.status, 'already-exists')
  t.is(parsed.videoId, 'existing-9')
  t.is(downloads.length, 0)
})

test('unavailable provider is a usage error and never opens the backend', async (t) => {
  let opened = false
  const { context, stderr } = baseContext({
    context: { flags: { type: 'movie', provider: 'vimeo', movieId: '1', yes: true } }
  })
  context.deps.openAddRuntime = async () => { opened = true; return { metadataBee: fakeBee(), close: async () => {} } }
  const code = await runAddCommand(context)
  t.is(code, 2)
  t.absent(opened, 'backend is not opened for an invalid provider')
  t.ok(stderr.text().includes('not available'))
})

test('no eligible durable peer keeps the job pending and retains local bytes', async (t) => {
  const { context, stdout, stderr } = baseContext({
    durable: { verified: false },
    context: { flags: { type: 'movie', provider: 'tmdb', movieId: '603', yes: true, json: true } }
  })
  const code = await runAddCommand(context)
  t.is(code, 0)
  const parsed = JSON.parse(stdout.text())
  t.is(parsed.status, 'replicationPending')
  t.ok(stderr.text().includes('Local bytes retained') || stderr.text().includes('retained'))
})

test('a missing TMDB key for scripted metadata names the variable and the --title escape', async (t) => {
  const { context, stderr, providerCalls } = baseContext({
    context: { flags: { type: 'movie', provider: 'tmdb', movieId: '603', yes: true }, resolveConfig: async () => ({}) }
  })
  const code = await runAddCommand(context)
  t.is(code, 2)
  t.ok(stderr.text().includes('TMDB_API_KEY'))
  t.ok(stderr.text().includes('--title'))
  t.is(providerCalls.length, 0, 'no client is built for an authority that cannot be read')
})

test('a TVDB movie with a configured key needs no --title and enriches from the provider', async (t) => {
  const { context, stdout, downloads, channels, providerCalls } = baseContext({
    context: {
      flags: { type: 'movie', provider: 'tvdb', movieId: '290434', yes: true, json: true },
      resolveConfig: async () => ({ content: { tvdbApiKey: 'tvdb-token' } })
    }
  })
  const code = await runAddCommand(context)
  t.is(code, 0)
  t.is(JSON.parse(stdout.text()).status, 'published')
  t.is(providerCalls[0].authority, 'tvdb')
  t.is(downloads[0].title, 'The Matrix', 'title comes from the TVDB lookup, not a flag')
  t.is(downloads[0].mediaProvider, 'tvdb')
  t.is(downloads[0].mediaId, '290434')
  t.is(channels[0].name, 'The Matrix')
})

test('a TVDB episode with a configured key resolves the season without --title', async (t) => {
  const { context, downloads, channels } = baseContext({
    context: {
      flags: { type: 'episode', provider: 'tvdb', showId: '81189', season: 1, episode: 2, yes: true },
      resolveConfig: async () => ({ content: { tvdbApiKey: 'tvdb-token' } })
    }
  })
  t.is(await runAddCommand(context), 0)
  t.is(downloads[0].title, "Cat's in the Bag...")
  t.is(downloads[0].episodeNumber, 2)
  t.is(channels[0].name, 'Breaking Bad')
  t.is(channels[0].mediaProvider, 'tvdb')
})

test('a TVDB movie with no key is refused by a message naming the variable and --title', async (t) => {
  const { context, stderr, providerCalls } = baseContext({
    context: {
      flags: { type: 'movie', provider: 'tvdb', movieId: '290434', yes: true },
      resolveConfig: async () => ({})
    }
  })
  const code = await runAddCommand(context)
  t.is(code, 2)
  t.ok(stderr.text().includes('PEARTUBE_TVDB_API_KEY'), 'names the exact variable to set')
  t.ok(stderr.text().includes('--title'), 'offers the escape hatch')
  t.is(providerCalls.length, 0)
})

test('a TVDB movie with no key still publishes when --title supplies the name', async (t) => {
  const { context, downloads, providerCalls } = baseContext({
    context: {
      flags: { type: 'movie', provider: 'tvdb', movieId: '290434', title: 'The Matrix', yes: true },
      resolveConfig: async () => ({})
    }
  })
  t.is(await runAddCommand(context), 0)
  t.is(downloads[0].title, 'The Matrix')
  t.is(providerCalls.length, 0, 'an unreadable authority is never asked')
})

test('a MusicBrainz track needs neither a key nor a --title', async (t) => {
  const { context, downloads, channels, providerCalls } = baseContext({
    context: {
      flags: { type: 'track', provider: 'musicbrainz', recordingId: RECORDING_MBID, yes: true },
      resolveConfig: async () => ({})
    }
  })
  t.is(await runAddCommand(context), 0)
  t.is(providerCalls[0].authority, 'musicbrainz')
  t.is(downloads[0].title, 'Paranoid Android')
  t.is(downloads[0].mediaProvider, 'musicbrainz')
  t.is(downloads[0].mediaId, RECORDING_MBID)
  t.is(channels[0].name, 'Radiohead', 'the artist credit names the channel')
  t.is(downloads[0].sourcePublishedAt, '1997-05-21', 'the first release date carries through')
})

test('a MusicBrainz release enriches the same way', async (t) => {
  const { context, downloads, channels } = baseContext({
    context: {
      flags: { type: 'release', provider: 'musicbrainz', releaseId: '550e8400-e29b-41d4-a716-446655440000', yes: true },
      resolveConfig: async () => ({})
    }
  })
  t.is(await runAddCommand(context), 0)
  t.is(downloads[0].title, 'OK Computer')
  t.is(channels[0].name, 'Radiohead')
  t.is(downloads[0].sourcePublishedAt, '1997-05-21')
})

test('--title wins over looked-up metadata when both exist', async (t) => {
  const { context, downloads, channels, providerCalls } = baseContext({
    context: {
      flags: { type: 'movie', provider: 'tvdb', movieId: '290434', title: 'The Matrix (1999 remaster)', yes: true },
      resolveConfig: async () => ({ content: { tvdbApiKey: 'tvdb-token' } })
    }
  })
  t.is(await runAddCommand(context), 0)
  t.is(providerCalls.length, 1, 'the authority is still read for description and artwork')
  t.is(downloads[0].title, 'The Matrix (1999 remaster)')
  t.is(channels[0].name, 'The Matrix (1999 remaster)')
})

test('--channel-name overrides the looked-up channel without touching the item title', async (t) => {
  const { context, downloads, channels } = baseContext({
    context: {
      flags: { type: 'episode', provider: 'tvdb', showId: '81189', season: 1, episode: 2, channelName: 'Breaking Bad (AMC)', yes: true },
      resolveConfig: async () => ({ content: { tvdbApiKey: 'tvdb-token' } })
    }
  })
  t.is(await runAddCommand(context), 0)
  t.is(channels[0].name, 'Breaking Bad (AMC)')
  t.is(downloads[0].title, "Cat's in the Bag...")
})

test('the TVDB PIN reaches the provider beside its key', async (t) => {
  const { context, providerCalls } = baseContext({
    context: {
      flags: { type: 'movie', provider: 'tvdb', movieId: '290434', yes: true },
      resolveConfig: async () => ({ content: { tvdbApiKey: 'tvdb-token', tvdbPin: '4321' } })
    }
  })
  t.is(await runAddCommand(context), 0)
  t.is(providerCalls[0].options.pin, '4321')
  t.is(providerCalls[0].options.preferences.tvdbApiKey, 'tvdb-token', 'the registry reads the key from preferences')
})
