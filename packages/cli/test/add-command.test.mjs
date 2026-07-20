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

function fakeExecutorDeps ({ jobStore, uploads, downloads, durable = { verified: true } }) {
  return {
    jobStore,
    resolveChannel: async () => CHANNEL,
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

function tmdbFake () {
  return {
    createTmdbProvider: () => ({
      async getShow () { return { name: 'Breaking Bad', mediaId: '1396', provider: 'tmdb', artwork: [] } },
      async getSeason () { return [{ seasonNumber: 1, episodeNumber: 1, title: 'Pilot', airDate: '2008-01-20', artwork: [] }] },
      async getMovie () { return { title: 'The Matrix', mediaId: '603', provider: 'tmdb', year: 1999, artwork: [] } }
    })
  }
}

function baseContext (overrides = {}) {
  const stdout = capture()
  const stderr = capture()
  const uploads = []
  const downloads = []
  const durable = overrides.durable || { verified: true }
  const bee = fakeBee()
  const deps = {
    ...tmdbFake(),
    openAddRuntime: async () => ({ metadataBee: bee, close: async () => {} }),
    createJobStore,
    createExecutor,
    buildExecutorDeps: ({ jobStore }) => fakeExecutorDeps({ jobStore, uploads, downloads, durable })
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
    downloads
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

test('a missing TMDB key for scripted metadata is an actionable usage error', async (t) => {
  const { context, stderr } = baseContext({
    context: { flags: { type: 'movie', provider: 'tmdb', movieId: '603', yes: true }, resolveConfig: async () => ({}) }
  })
  const code = await runAddCommand(context)
  t.is(code, 2)
  t.ok(stderr.text().includes('TMDB API key'))
})
