import test from 'brittle'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createArchiveConsole, createArchiveHttpSurface } from '../src/archive-console.js'
import { isLoopbackHost } from '../src/archive-api.js'
import { createRelayService } from '../src/service.js'
import { resolveRelayConfig } from '../src/config.js'

// A relay's own console answers submissions with 303 redirects, which a program
// cannot read. These cover the machine-facing surface a MediaStorm backend
// drives: enqueue by upload, poll by job id, and read the published catalog as
// references that mean something on another machine.

function fakeMetaDb() {
  const map = new Map()
  return {
    async get(key) { return map.has(key) ? { value: map.get(key) } : null },
    async put(key, value) { map.set(key, value) }
  }
}

const CORE_KEY = 'ab'.repeat(32)

function catalogPage() {
  return {
    success: true,
    items: [{
      entityId: 'peartube:media-entity:v1:work:0123',
      entityKind: 'work',
      title: 'Wedding Crashers',
      releaseYear: 2005,
      sources: [{ publicationId: 'pub-1', publisherId: 'cd'.repeat(32), renditionId: 'rend-1' }],
      renditions: [{ renditionId: 'rend-1', coreKey: CORE_KEY, coreLength: 42, byteLength: 1024 }]
    }],
    nextCursor: null
  }
}

function fakeService(overrides = {}) {
  return {
    runtime: {
      ctx: { metaDb: fakeMetaDb() },
      api: { async getMediaCatalog(request) { return overrides.catalog ? overrides.catalog(request) : catalogPage() } }
    },
    catalog: { getChannels() { return [] } },
    getStatus() { return { runtime: {} } },
    creators: { getCreators() { return [] } },
    getCreatorTargets() { return [] },
    getTrustedClients() { return [] },
    async publishArchiveJob() {},
    ...overrides.service
  }
}

// `host` is the bind the gate reads: a relay on 0.0.0.0 is still reachable over
// 127.0.0.1, so a non-loopback bind is exercised for real rather than faked.
async function withRelay(fn, { service = fakeService(), consoleOptions = {}, host = '127.0.0.1' } = {}) {
  const uploadDir = mkdtempSync(join(tmpdir(), 'pt-api-upload-'))
  const relay = await createArchiveConsole({
    service,
    downloader: { async download() { throw new Error('not used') } },
    publisher: {},
    uploadDir,
    ...consoleOptions,
    host,
    port: 0
  })
  await relay.start()
  const { port } = relay.server.address()
  try {
    return await fn({ base: `http://127.0.0.1:${port}`, relay, uploadDir })
  } finally {
    await relay.close()
    rmSync(uploadDir, { recursive: true, force: true })
  }
}

async function settledJob(base, jobId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await (await fetch(`${base}/api/v1/archive/${jobId}`)).json()
    if (job.status === 'completed' || job.status === 'failed') return job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`archive job ${jobId} never settled`)
}

function upload(fields) {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) body.set(key, value)
  body.set('file', new Blob([Buffer.from('FAKE-MP4-BYTES')], { type: 'video/mp4' }), 'clip.mp4')
  return { method: 'POST', body }
}

test('POST /api/v1/archive accepts a movie upload and answers a job id', async function (t) {
  await withRelay(async ({ base }) => {
    const res = await fetch(`${base}/api/v1/archive`, upload({
      contentKind: 'movie',
      tmdbId: '9367',
      tmdbTitle: 'Wedding Crashers',
      tmdbYear: '2005'
    }))

    t.is(res.status, 202)
    t.is(res.headers.get('content-type'), 'application/json; charset=utf-8')
    const body = await res.json()
    t.ok(/^arch_[0-9a-f]{16}$/.test(body.jobId), 'the caller is handed a job id it can poll')
    t.is(body.status, 'queued')
    t.is(body.entityHint, 'movie:9367', 'the canonical work key lets the caller correlate the publication')

    const job = await (await fetch(`${base}/api/v1/archive/${body.jobId}`)).json()
    t.is(job.jobId, body.jobId)
    t.is(job.title, 'Wedding Crashers', 'the job is named after the catalogue title')
  })
})

test('POST /api/v1/archive derives the show:season:episode hint for an episode', async function (t) {
  // Refusing to ingest settles the job immediately, so the status/error contract
  // a caller polls is observed rather than raced.
  const service = fakeService({ service: { canArchive: () => false } })
  await withRelay(async ({ base }) => {
    const res = await fetch(`${base}/api/v1/archive`, upload({
      contentKind: 'episode',
      tmdbId: '95396',
      tmdbTitle: 'Severance',
      tmdbSeason: '2',
      tmdbEpisode: '4',
      title: 'Severance S2E4'
    }))

    t.is(res.status, 202)
    const body = await res.json()
    t.is(body.entityHint, 'show:95396:s2:e4')

    const job = await settledJob(base, body.jobId)
    t.is(job.jobId, body.jobId)
    t.is(job.status, 'failed')
    t.ok(job.error.includes('storage threshold'), 'a failure reaches the caller as text, not as a redirect')
    t.is(job.title, 'Severance S2E4', 'an episode keeps its own title over the series name')
    t.is(job.source, null, 'nothing was published, so no source is offered')
  }, { service })
})

test('a malformed episode is refused with the field that is wrong, before anything is enqueued', async function (t) {
  await withRelay(async ({ base, uploadDir }) => {
    const res = await fetch(`${base}/api/v1/archive`, upload({
      contentKind: 'episode',
      tmdbId: '95396',
      tmdbTitle: 'Severance',
      tmdbEpisode: '4'
    }))

    t.is(res.status, 400)
    t.is(res.headers.get('content-type'), 'application/json; charset=utf-8')
    const body = await res.json()
    t.is(body.error.code, 'INVALID_SEASON')
    t.is(body.error.field, 'tmdbSeason', 'the caller is told which field to fix')
    t.ok(body.error.message.length > 0)

    const jobs = await (await fetch(`${base}/jobs`)).json()
    t.is(jobs.jobs.length, 0, 'a half-specified episode never reaches the pipeline')
    // A rejected upload must not leave its bytes on an unauthenticated relay.
    t.absent(readdirSync(join(uploadDir, 'uploads'), { withFileTypes: true }).length > 0, 'the staged upload is discarded')
  })
})

test('a movie upload cannot smuggle episode coordinates', async function (t) {
  await withRelay(async ({ base }) => {
    const res = await fetch(`${base}/api/v1/archive`, upload({
      contentKind: 'movie',
      tmdbId: '9367',
      tmdbTitle: 'Wedding Crashers',
      tmdbSeason: '1'
    }))

    t.is(res.status, 400)
    const body = await res.json()
    t.is(body.error.code, 'UNEXPECTED_FIELD')
    t.is(body.error.field, 'tmdbSeason')
  })
})

// A url seed hands the relay a source to fetch instead of bytes to receive.
// Resolution is stubbed to a public address only where the test's host has to
// be reachable in principle; every refusal below runs the real resolver.
const PUBLIC_LOOKUP = (host, opts, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }])

function seed(body) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }
}

// Records what the pipeline was actually asked to fetch, then fails the job so
// nothing tries to publish it.
function recordingDownloader(seen) {
  return {
    async download(input) {
      seen.push(input)
      throw new Error('download not attempted in this test')
    }
  }
}

test('POST /api/v1/archive accepts a movie url seed and enqueues the fetch', async function (t) {
  const seen = []
  await withRelay(async ({ base, uploadDir }) => {
    const res = await fetch(`${base}/api/v1/archive`, seed({
      url: 'https://cdn.example.com/wedding-crashers.mp4',
      contentKind: 'movie',
      // A typed client sends this as a number; the contract accepts both.
      tmdbId: 9367,
      tmdbTitle: 'Wedding Crashers',
      tmdbYear: '2005',
      tmdbGenres: ['Comedy', 'Romance']
    }))

    t.is(res.status, 202)
    const body = await res.json()
    t.ok(/^arch_[0-9a-f]{16}$/.test(body.jobId), 'a url seed is polled by job id like any other')
    t.is(body.status, 'queued')
    t.is(body.entityHint, 'movie:9367', 'a url seed collapses onto the same work key an upload would')

    await settledJob(base, body.jobId)
    t.is(seen.length, 1, 'the relay fetches the source itself')
    t.is(seen[0].url, 'https://cdn.example.com/wedding-crashers.mp4')
    t.ok(seen[0].requirePublicSource, 'the job is marked so the downloader re-checks every redirect hop')
    t.absent(seen[0].uploadPath, 'no bytes were staged for a url seed')
    t.is(readdirSync(uploadDir).length, 0, 'a url seed writes nothing to the upload directory')
  }, { consoleOptions: { sourceLookup: PUBLIC_LOOKUP, downloader: recordingDownloader(seen) } })
})

test('POST /api/v1/archive derives the show:season:episode hint for a url seed', async function (t) {
  const seen = []
  await withRelay(async ({ base }) => {
    const res = await fetch(`${base}/api/v1/archive`, seed({
      url: 'https://cdn.example.com/severance-s02e04.mkv',
      contentKind: 'episode',
      tmdbId: '95396',
      tmdbTitle: 'Severance',
      tmdbSeason: 2,
      tmdbEpisode: 4
    }))

    t.is(res.status, 202)
    t.is((await res.json()).entityHint, 'show:95396:s2:e4')
  }, { consoleOptions: { sourceLookup: PUBLIC_LOOKUP, downloader: recordingDownloader(seen) } })
})

test('a url seed is validated against the same coordinates an upload is', async function (t) {
  await withRelay(async ({ base }) => {
    const missingSeason = await fetch(`${base}/api/v1/archive`, seed({
      url: 'https://cdn.example.com/severance.mkv',
      contentKind: 'episode',
      tmdbId: '95396',
      tmdbTitle: 'Severance',
      tmdbEpisode: '4'
    }))
    t.is(missingSeason.status, 400)
    t.is((await missingSeason.json()).error.code, 'INVALID_SEASON')

    const badKind = await fetch(`${base}/api/v1/archive`, seed({
      url: 'https://cdn.example.com/x.mp4',
      contentKind: 'trailer',
      tmdbId: '9367',
      tmdbTitle: 'Wedding Crashers'
    }))
    t.is(badKind.status, 400)
    t.is((await badKind.json()).error.code, 'INVALID_CONTENT_KIND')
  }, { consoleOptions: { sourceLookup: PUBLIC_LOOKUP } })
})

test('a submission carries either a file or a url, never both and never neither', async function (t) {
  await withRelay(async ({ base, uploadDir }) => {
    const neither = new FormData()
    neither.set('contentKind', 'movie')
    neither.set('tmdbId', '9367')
    neither.set('tmdbTitle', 'Wedding Crashers')
    const noSource = await fetch(`${base}/api/v1/archive`, { method: 'POST', body: neither })
    t.is(noSource.status, 400)
    t.is((await noSource.json()).error.code, 'SOURCE_REQUIRED')

    const asJson = await fetch(`${base}/api/v1/archive`, seed({
      contentKind: 'movie',
      tmdbId: '9367',
      tmdbTitle: 'Wedding Crashers',
      // A caller still cannot name a path on the relay's disk: only `url` is
      // read, and a path is not a url.
      filePath: '/etc/passwd'
    }))
    t.is(asJson.status, 400)
    t.is((await asJson.json()).error.code, 'SOURCE_REQUIRED')

    const both = new FormData()
    both.set('contentKind', 'movie')
    both.set('tmdbId', '9367')
    both.set('tmdbTitle', 'Wedding Crashers')
    both.set('url', 'https://cdn.example.com/wedding-crashers.mp4')
    both.set('file', new Blob([Buffer.from('FAKE-MP4-BYTES')], { type: 'video/mp4' }), 'clip.mp4')
    const ambiguous = await fetch(`${base}/api/v1/archive`, { method: 'POST', body: both })
    t.is(ambiguous.status, 400)
    const body = await ambiguous.json()
    t.is(body.error.code, 'AMBIGUOUS_SOURCE')
    t.is(body.error.field, 'url', 'the caller is told which of the two to drop')
    t.absent(readdirSync(join(uploadDir, 'uploads'), { withFileTypes: true }).length > 0, 'the staged upload is discarded')
  })
})

test('the relay refuses to fetch a url that is not public http(s)', async function (t) {
  // No stubbed resolver here: these run the guard the relay actually ships.
  await withRelay(async ({ base }) => {
    const coordinates = { contentKind: 'movie', tmdbId: '9367', tmdbTitle: 'Wedding Crashers' }
    const refusals = [
      ['file:///etc/shadow', 'SOURCE_SCHEME_NOT_ALLOWED'],
      ['gopher://example.com/1', 'SOURCE_SCHEME_NOT_ALLOWED'],
      ['https://someone:secret@cdn.example.com/x.mp4', 'SOURCE_CREDENTIALS_NOT_ALLOWED'],
      // A literal in private space, and the same address written to look like
      // it is not one.
      ['http://10.0.0.5/x.mp4', 'SOURCE_HOST_NOT_PUBLIC'],
      ['http://192.168.1.1/x.mp4', 'SOURCE_HOST_NOT_PUBLIC'],
      ['http://169.254.169.254/latest/meta-data/', 'SOURCE_HOST_NOT_PUBLIC'],
      ['http://2130706433/x.mp4', 'SOURCE_HOST_NOT_PUBLIC'],
      ['http://[::1]/x.mp4', 'SOURCE_HOST_NOT_PUBLIC'],
      // Resolved, not pattern-matched: `localhost` is a name, and it is
      // refused because of what it points at.
      ['http://localhost:9/x.mp4', 'SOURCE_HOST_NOT_PUBLIC'],
      ['http://not-a-url', 'SOURCE_HOST_UNRESOLVABLE']
    ]

    for (const [url, code] of refusals) {
      const res = await fetch(`${base}/api/v1/archive`, seed({ ...coordinates, url }))
      t.is(res.status, 400, `${url} is refused`)
      const body = await res.json()
      t.is(body.error.code, code, `${url} names why`)
      t.is(body.error.field, 'url')
    }

    const jobs = await (await fetch(`${base}/jobs`)).json()
    t.is(jobs.jobs.length, 0, 'nothing the guard refused ever became a job')
  })
})

test('a malformed JSON submission is named as JSON rather than as a bad upload', async function (t) {
  await withRelay(async ({ base }) => {
    const res = await fetch(`${base}/api/v1/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"url": '
    })
    t.is(res.status, 400)
    t.is((await res.json()).error.code, 'INVALID_JSON')
  })
})

test('an unknown job id answers 404 as JSON', async function (t) {
  await withRelay(async ({ base }) => {
    const res = await fetch(`${base}/api/v1/archive/arch_0000000000000000`)

    t.is(res.status, 404)
    t.is(res.headers.get('content-type'), 'application/json; charset=utf-8')
    const body = await res.json()
    t.is(body.error.code, 'JOB_NOT_FOUND')
    t.is(body.error.field, 'jobId')
  })
})

test('GET /api/v1/archive/:jobId reports portable references once a job has published', async function (t) {
  await withRelay(async ({ base, relay }) => {
    const jobId = 'arch_00000000000000ff'
    await relay.store.addJob({
      id: jobId,
      status: 'completed',
      title: 'Wedding Crashers',
      error: null,
      previewVideo: {
        id: 'video-1',
        immutablePublication: {
          publicationId: 'pub-1',
          manifestId: 'manifest-1',
          renditionId: 'rend-1',
          publisherId: 'cd'.repeat(32),
          entityRef: 'peartube:media-entity:v1:work:0123',
          manifest: { body: { renditions: [{ renditionId: 'rend-1', core: { key: CORE_KEY, length: 42, byteLength: 1024 } }] } }
        }
      }
    }, {})

    const res = await fetch(`${base}/api/v1/archive/${jobId}`)
    t.is(res.status, 200)
    const body = await res.json()
    t.is(body.status, 'completed')
    t.is(body.error, null)
    t.is(body.source.entityId, 'peartube:media-entity:v1:work:0123')
    t.is(body.source.publicationId, 'pub-1')
    t.is(body.source.renditionId, 'rend-1')
    t.is(body.source.coreKey, CORE_KEY, 'a remote node is told which core holds the bytes')
    t.is(body.source.byteLength, 1024)
    t.absent(JSON.stringify(body).includes('127.0.0.1'), 'no loopback URL is offered as a source')
  })
})

test('GET /api/v1/catalog publishes portable references and never a loopback URL', async function (t) {
  await withRelay(async ({ base }) => {
    const res = await fetch(`${base}/api/v1/catalog`)

    t.is(res.status, 200)
    t.is(res.headers.get('content-type'), 'application/json; charset=utf-8')
    const raw = await res.text()
    t.absent(raw.includes('127.0.0.1'), 'bytes are resolved by the caller\'s own node, not through this relay')

    const body = JSON.parse(raw)
    t.is(body.schema, 'peartube.relayMediaCatalog')
    t.is(body.nextCursor, null)
    t.is(body.entities.length, 1)
    const [entity] = body.entities
    t.is(entity.entityId, 'peartube:media-entity:v1:work:0123')
    t.is(entity.title, 'Wedding Crashers')
    t.is(entity.year, 2005)
    t.alike(entity.sources, [{
      publicationId: 'pub-1',
      publisherId: 'cd'.repeat(32),
      renditionId: 'rend-1',
      coreKey: CORE_KEY,
      coreLength: 42,
      byteLength: 1024
    }])
  })
})

test('the catalog resolves cores through the signed manifest when a page omits renditions', async function (t) {
  // The shape a real relay serves: every device reads the catalog through the
  // consumer projection, which lists publications but neither the rendition each
  // offers nor the core behind it. A publication a caller cannot resolve to
  // bytes is not a source, so the join happens here.
  const requested = []
  const service = fakeService({
    catalog: () => ({
      success: true,
      items: [{
        entityId: 'work-severance',
        entityKind: 'work',
        title: 'Severance',
        releaseYear: 2022,
        sources: [{ publicationId: 'pub-1', publisherId: 'ef'.repeat(32) }],
        renditions: []
      }],
      nextCursor: null
    })
  })
  service.runtime.api.getPublicationSources = async (request) => {
    requested.push(request)
    return { success: true, items: [{ publicationId: 'pub-1', publisherId: 'ef'.repeat(32), renditionId: 'rend-9' }], nextCursor: null }
  }
  service.runtime.ctx.assetManifestStore = {
    getManifest(publicationId) {
      if (publicationId !== 'pub-1') return null
      return {
        body: {
          renditions: [
            { renditionId: 'poster-1', purpose: 'poster', core: { key: '11'.repeat(32), length: 1, byteLength: 512 } },
            { renditionId: 'rend-9', purpose: 'source', core: { key: CORE_KEY, length: 7, byteLength: 2048 } }
          ]
        }
      }
    }
  }

  await withRelay(async ({ base }) => {
    const raw = await (await fetch(`${base}/api/v1/catalog`)).text()
    t.absent(raw.includes('127.0.0.1'), 'still no loopback URL')

    const [entity] = JSON.parse(raw).entities
    t.is(requested[0].entityId, 'work-severance', 'the source list is asked for the missing rendition')
    t.alike(entity.sources, [{
      publicationId: 'pub-1',
      publisherId: 'ef'.repeat(32),
      renditionId: 'rend-9',
      coreKey: CORE_KEY,
      coreLength: 7,
      byteLength: 2048
    }], 'the core named by the signed manifest reaches the caller')
  }, { service })
})

test('GET /api/v1/catalog passes pagination through to the media graph', async function (t) {
  const requests = []
  const service = fakeService({
    catalog(request) {
      requests.push(request)
      if (request.cursor === 'nope') return { success: false, errorCode: 'INVALID_CURSOR', error: 'Invalid media catalog cursor' }
      return { ...catalogPage(), nextCursor: 'entity-2' }
    }
  })
  await withRelay(async ({ base }) => {
    const page = await (await fetch(`${base}/api/v1/catalog?limit=1`)).json()
    t.is(page.nextCursor, 'entity-2')
    t.alike(requests[0], { limit: 1, limitProvided: true })

    const rejected = await fetch(`${base}/api/v1/catalog?cursor=nope`)
    t.is(rejected.status, 400, 'a cursor the media graph rejects is the caller\'s error, not a relay fault')
    t.is((await rejected.json()).error.field, 'cursor')

    const overLimit = await fetch(`${base}/api/v1/catalog?limit=999`)
    t.is(overLimit.status, 400, 'an out-of-range page is the caller\'s error, not a relay failure')
    t.is((await overLimit.json()).error.code, 'INVALID_LIMIT')
    t.is(requests.length, 2, 'a refused limit never reaches the media graph, unlike the cursor above')
  }, { service })
})

test('the catalog says so when the relay runtime has no media graph yet', async function (t) {
  const service = fakeService()
  service.runtime.api = {}
  await withRelay(async ({ base }) => {
    const res = await fetch(`${base}/api/v1/catalog`)
    t.is(res.status, 503)
    t.is((await res.json()).error.code, 'CATALOG_UNAVAILABLE')
  }, { service })
})

test('a media graph that never answers becomes a retryable 503, not a held connection', async function (t) {
  // Seen on a live relay: an unfinished publisher catalog walk blocks the
  // projection rebuild, and a catalog read behind it never returns.
  const service = fakeService({ catalog: () => new Promise(() => {}) })
  await withRelay(async ({ base }) => {
    const started = Date.now()
    const res = await fetch(`${base}/api/v1/catalog`)
    t.is(res.status, 503)
    t.is((await res.json()).error.code, 'CATALOG_TIMEOUT')
    t.ok(Date.now() - started < 30000, 'the caller is answered rather than held open')
  }, { service })
})

test('unknown /api/v1 paths and wrong methods answer JSON, never the HTML console', async function (t) {
  await withRelay(async ({ base }) => {
    const unknown = await fetch(`${base}/api/v1/nope`)
    t.is(unknown.status, 404)
    t.is(unknown.headers.get('content-type'), 'application/json; charset=utf-8')
    t.is((await unknown.json()).error.code, 'NOT_FOUND')

    const wrongMethod = await fetch(`${base}/api/v1/archive`)
    t.is(wrongMethod.status, 405)
    t.is(wrongMethod.headers.get('allow'), 'POST')
    t.is((await wrongMethod.json()).error.code, 'METHOD_NOT_ALLOWED')

    const wrongCatalogMethod = await fetch(`${base}/api/v1/catalog`, { method: 'POST' })
    t.is(wrongCatalogMethod.status, 405)
    t.is(wrongCatalogMethod.headers.get('allow'), 'GET')

    const root = await fetch(`${base}/api/v1`)
    t.is(root.status, 404)
    t.is((await root.json()).error.code, 'NOT_FOUND')
  })
})

// A catalog entry names a Hypercore, which only a PearTube node can resolve. The
// stream endpoint is what makes a published rendition readable by anything that
// speaks HTTP byte ranges, so these cover the exact shape a player - or a Go
// backend fronting one - depends on.

const RENDITION_BYTES = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251))

async function* chunked(bytes, size = 1500) {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.subarray(offset, Math.min(offset + size, bytes.byteLength))
  }
}

function renditionService({ bytes = RENDITION_BYTES, contentType = 'video/mp4', open = null } = {}) {
  const service = fakeService()
  const opens = []
  const closes = []
  service.runtime.api.openMediaRendition = async (request) => {
    opens.push(request)
    if (open) return open(request)
    if (request.publicationId !== 'pub-1') return { success: false, errorCode: 'MEDIA_PUBLICATION_NOT_FOUND', error: 'Media publication not found' }
    if (request.renditionId !== 'rend-1') return { success: false, errorCode: 'MEDIA_RENDITION_NOT_FOUND', error: 'Media rendition not found' }
    return {
      success: true,
      publicationId: request.publicationId,
      renditionId: request.renditionId,
      contentType,
      byteLength: bytes.byteLength,
      read({ start = 0, length = bytes.byteLength - start } = {}) {
        return chunked(bytes.subarray(start, start + length))
      },
      async close() { closes.push(true) }
    }
  }
  return { service, opens, closes }
}

test('GET /api/v1/stream/:publicationId/:renditionId serves the whole rendition', async function (t) {
  const { service, opens, closes } = renditionService()
  await withRelay(async ({ base }) => {
    const res = await fetch(`${base}/api/v1/stream/pub-1/rend-1`)

    t.is(res.status, 200)
    t.is(res.headers.get('content-type'), 'video/mp4', 'the rendition declares its own format')
    t.is(res.headers.get('content-length'), String(RENDITION_BYTES.byteLength))
    t.is(res.headers.get('accept-ranges'), 'bytes', 'a player must be told it may seek')
    t.is(res.headers.get('content-range'), null, 'a full response is not a partial one')
    t.alike(Buffer.from(await res.arrayBuffer()), RENDITION_BYTES, 'the bytes are served, not a reference to them')
    t.alike(opens, [{ publicationId: 'pub-1', renditionId: 'rend-1' }], 'the request is what asks the media graph for the bytes')
    t.is(closes.length, 1, 'the rendition is released once the response ends')
  }, { service })
})

test('a Range request answers 206 with exactly the window asked for', async function (t) {
  const { service } = renditionService()
  await withRelay(async ({ base }) => {
    const head = await fetch(`${base}/api/v1/stream/pub-1/rend-1`, { headers: { range: 'bytes=0-1023' } })
    t.is(head.status, 206)
    t.is(head.headers.get('content-range'), `bytes 0-1023/${RENDITION_BYTES.byteLength}`)
    t.is(head.headers.get('content-length'), '1024')
    t.is(head.headers.get('accept-ranges'), 'bytes')
    const headBody = Buffer.from(await head.arrayBuffer())
    t.is(headBody.byteLength, 1024, 'a seeking player gets the window it asked for and nothing more')
    t.alike(headBody, RENDITION_BYTES.subarray(0, 1024))

    // Mid-file: the offset arithmetic is the part a player breaks on.
    const middle = await fetch(`${base}/api/v1/stream/pub-1/rend-1`, { headers: { range: 'bytes=1024-2047' } })
    t.is(middle.status, 206)
    t.is(middle.headers.get('content-range'), `bytes 1024-2047/${RENDITION_BYTES.byteLength}`)
    t.alike(Buffer.from(await middle.arrayBuffer()), RENDITION_BYTES.subarray(1024, 2048))

    // An open-ended range is how a player streams the remainder.
    const tail = await fetch(`${base}/api/v1/stream/pub-1/rend-1`, { headers: { range: 'bytes=4000-' } })
    t.is(tail.status, 206)
    t.is(tail.headers.get('content-range'), `bytes 4000-4095/${RENDITION_BYTES.byteLength}`)
    t.alike(Buffer.from(await tail.arrayBuffer()), RENDITION_BYTES.subarray(4000))
  }, { service })
})

test('a range past the end of the rendition is refused with 416, never truncated bytes', async function (t) {
  const { service } = renditionService()
  await withRelay(async ({ base }) => {
    const res = await fetch(`${base}/api/v1/stream/pub-1/rend-1`, { headers: { range: 'bytes=9999-10999' } })
    t.is(res.status, 416)
    t.is(res.headers.get('content-range'), `bytes */${RENDITION_BYTES.byteLength}`, 'the client is told how long the rendition actually is')
    t.is(res.headers.get('accept-ranges'), 'bytes')
    t.is((await res.json()).error.code, 'RANGE_NOT_SATISFIABLE')
  }, { service })
})

test('an unknown publication or rendition answers 404 as JSON', async function (t) {
  const { service } = renditionService()
  await withRelay(async ({ base }) => {
    const unknownPublication = await fetch(`${base}/api/v1/stream/pub-missing/rend-1`)
    t.is(unknownPublication.status, 404)
    t.is(unknownPublication.headers.get('content-type'), 'application/json; charset=utf-8')
    t.is((await unknownPublication.json()).error.code, 'MEDIA_PUBLICATION_NOT_FOUND')

    const unknownRendition = await fetch(`${base}/api/v1/stream/pub-1/rend-missing`)
    t.is(unknownRendition.status, 404)
    t.is((await unknownRendition.json()).error.code, 'MEDIA_RENDITION_NOT_FOUND')

    const noRendition = await fetch(`${base}/api/v1/stream/pub-1`)
    t.is(noRendition.status, 404)
    t.is((await noRendition.json()).error.code, 'NOT_FOUND', 'both coordinates are required')
  }, { service })
})

test('the stream says so when the relay has no media graph bound yet', async function (t) {
  const service = fakeService()
  service.runtime.api = {}
  await withRelay(async ({ base }) => {
    const res = await fetch(`${base}/api/v1/stream/pub-1/rend-1`)
    t.is(res.status, 503, 'a relay that is not bound yet is a retry, not a missing title')
    t.is((await res.json()).error.code, 'MEDIA_GRAPH_UNAVAILABLE')

    const wrongMethod = await fetch(`${base}/api/v1/stream/pub-1/rend-1`, { method: 'POST' })
    t.is(wrongMethod.status, 405)
    t.is(wrongMethod.headers.get('allow'), 'GET')
  }, { service })
})

test('the browser console form still redirects exactly as before', async function (t) {
  await withRelay(async ({ base }) => {
    const body = new FormData()
    body.set('tmdbType', 'tv')
    body.set('tmdbId', '95396')
    body.set('tmdbTitle', 'Severance')
    body.set('tmdbSeason', '2')
    body.set('tmdbEpisode', '4')
    body.set('channelName', 'Severance')
    body.set('title', 'Severance S2E4')
    body.set('file', new Blob([Buffer.from('FAKE-MP4-BYTES')], { type: 'video/mp4' }), 'clip.mp4')
    const res = await fetch(`${base}/discover/archive`, { method: 'POST', body, redirect: 'manual' })

    t.is(res.status, 303, 'the form flow is untouched')
    t.is(res.headers.get('location'), '/#discover')

    const jobs = await (await fetch(`${base}/jobs`)).json()
    t.is(jobs.jobs.length, 1)
    t.is(jobs.jobs[0].title, 'Severance S2E4')
  })
})

test('an empty console submission still reports itself rather than redirecting to success', async function (t) {
  await withRelay(async ({ base }) => {
    const res = await fetch(`${base}/discover/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
      redirect: 'manual'
    })
    t.is(res.status, 303)
    t.is(res.headers.get('location'), '/?notice=empty-submission#discover')
  })
})

// How the relay is bound is the only thing standing in front of an
// unauthenticated API, so it decides what the enumerating and byte-serving half
// of it answers. A MediaStorm backend in Docker reaches the relay over a
// non-loopback address, which is exactly the case that has to be opted into
// rather than assumed.

// Every route the gate touches or deliberately does not, driven in one pass so
// each mode is asserted as a whole surface instead of one endpoint at a time.
async function driveApi(base) {
  const catalog = await fetch(`${base}/api/v1/catalog`)
  const catalogBody = await catalog.json()
  const stream = await fetch(`${base}/api/v1/stream/pub-1/rend-1`)
  const streamBody = /json/.test(stream.headers.get('content-type') || '')
    ? await stream.json()
    : Buffer.from(await stream.arrayBuffer())
  const posted = await fetch(`${base}/api/v1/archive`, upload({
    contentKind: 'movie',
    tmdbId: '9367',
    tmdbTitle: 'Wedding Crashers'
  }))
  const postedBody = await posted.json()
  const job = await fetch(`${base}/api/v1/archive/${postedBody.jobId}`)
  return { catalog, catalogBody, stream, streamBody, posted, postedBody, job, jobBody: await job.json() }
}

test('a relay bound to loopback serves catalog and stream with no configuration at all', async function (t) {
  const { service, opens } = renditionService()
  await withRelay(async ({ base }) => {
    const api = await driveApi(base)

    t.is(api.catalog.status, 200, 'a local integration test needs no switch')
    t.is(api.catalogBody.entities.length, 1)
    t.is(api.stream.status, 200)
    t.alike(api.streamBody, RENDITION_BYTES, 'bytes are served on the interface only this machine can reach')
    t.is(opens.length, 1)
    t.is(api.posted.status, 202)
    t.is(api.job.status, 200)
  }, { service })
})

test('a relay bound to 0.0.0.0 refuses catalog and stream until the operator opts in', async function (t) {
  const { service, opens } = renditionService()
  await withRelay(async ({ base }) => {
    const api = await driveApi(base)

    t.is(api.catalog.status, 403)
    t.is(api.catalog.headers.get('content-type'), 'application/json; charset=utf-8')
    t.is(api.catalogBody.error.code, 'OPEN_ACCESS_NOT_ENABLED')
    t.ok(api.catalogBody.error.message.includes('--api-open'), 'the refusal names the flag that lifts it')
    t.ok(api.catalogBody.error.message.includes('PEARTUBE_ARCHIVE_API_OPEN=1'), 'and the env var, for a relay in a container')
    t.ok(api.catalogBody.error.message.includes('0.0.0.0'), 'and the bind that triggered it')

    t.is(api.stream.status, 403)
    t.is(api.streamBody.error.code, 'OPEN_ACCESS_NOT_ENABLED')
    t.is(opens.length, 0, 'a refused stream never asks the media graph to open anything')

    // Submission was already reachable through the console form on this same
    // interface, so gating it would break the archive flow and close nothing.
    t.is(api.posted.status, 202)
    t.is(api.job.status, 200)
    t.is(api.jobBody.jobId, api.postedBody.jobId)
  }, { service, host: '0.0.0.0' })
})

test('the same relay serves catalog and stream once the operator sets the switch', async function (t) {
  const { service, opens } = renditionService()
  await withRelay(async ({ base }) => {
    const api = await driveApi(base)

    t.is(api.catalog.status, 200)
    t.is(api.catalogBody.entities.length, 1, 'the MediaStorm integration test can enumerate again')
    t.is(api.stream.status, 200)
    t.alike(api.streamBody, RENDITION_BYTES, 'and read the bytes over HTTP')
    t.is(opens.length, 1)
    t.is(api.posted.status, 202)
    t.is(api.job.status, 200)
  }, { service, host: '0.0.0.0', consoleOptions: { apiOpen: true } })
})

test('the relay states which mode its API is in at startup', async function (t) {
  const warnings = []
  const logger = { archive: { info() {}, warn: (msg) => warnings.push(msg), error() {} } }
  const { service } = renditionService()

  await withRelay(async () => {}, { service, host: '0.0.0.0', consoleOptions: { logger } })
  t.is(warnings.length, 1, 'an exposed relay says so once, not per request')
  t.ok(warnings[0].includes('OPEN_ACCESS_NOT_ENABLED'), 'the operator is told what callers will see')
  t.ok(warnings[0].includes('--api-open'), 'and how to change it')

  warnings.length = 0
  await withRelay(async () => {}, { service, host: '0.0.0.0', consoleOptions: { logger, apiOpen: true } })
  t.is(warnings.length, 1)
  t.ok(warnings[0].includes('serves media bytes'), 'opting in is stated as what it is')
  t.ok(warnings[0].includes('network'))

  warnings.length = 0
  await withRelay(async () => {}, { service, consoleOptions: { logger } })
  t.is(warnings.length, 0, 'a loopback relay has nothing to warn about')
})

test('only an address that means this machine counts as loopback', async function (t) {
  for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', ' 127.0.0.1 ', '::1', '[::1]', '::ffff:127.0.0.1']) {
    t.ok(isLoopbackHost(host), `${host} reaches nothing but this machine`)
  }
  // An unreadable bind is a network: guessing loopback here is the one mistake
  // that would serve media to an interface nobody meant to expose.
  for (const host of ['0.0.0.0', '::', '192.168.1.20', '10.0.0.5', 'relay.example.com', '', '   ', null, undefined]) {
    t.absent(isLoopbackHost(host), `${JSON.stringify(host)} is treated as a network`)
  }
})

// A relay's HTTP surface must not wait on its store.
//
// Observed on a 46 GB relay: the universal backend's bring-up runs before
// anything binds, so the P2P side came up with three peers while the console
// port stayed closed indefinitely — a live process indistinguishable from a
// dead one. These cover the shape of the fix: bind first, degrade the routes
// that genuinely need the store, and upgrade in place on the same socket.

const silentLogger = Object.fromEntries(
  ['relay', 'runtime', 'status', 'archive', 'admission', 'discovery', 'mirror', 'storage'].map((scope) => [
    scope,
    { info() {}, warn() {}, error() {}, debug() {} }
  ])
)

test('the relay answers before its store-dependent side exists, then upgrades on the same socket', async function (t) {
  const surface = createArchiveHttpSurface({ host: '127.0.0.1', port: 0 })
  const uploadDir = mkdtempSync(join(tmpdir(), 'pt-api-warm-'))
  t.teardown(async () => {
    await surface.close()
    rmSync(uploadDir, { recursive: true, force: true })
  })

  const base = `http://127.0.0.1:${await surface.listen()}`

  const warmHealth = await fetch(`${base}/health`)
  t.is(warmHealth.status, 200, 'an operator can tell the process is alive')
  t.alike(await warmHealth.json(), { ok: true, ready: false, waitingFor: 'relay-storage' })

  const warmCatalog = await fetch(`${base}/api/v1/catalog`)
  t.is(warmCatalog.status, 503, 'a poller is told to retry rather than met with a dead socket')
  t.is(warmCatalog.headers.get('content-type'), 'application/json; charset=utf-8')
  t.is((await warmCatalog.json()).error.code, 'CATALOG_UNAVAILABLE', 'a code the client already retries on')

  const warmPage = await fetch(`${base}/`)
  t.is(warmPage.status, 200, 'the browser console is reachable while the store opens')
  t.ok((await warmPage.text()).includes('starting'), 'and says what it is waiting for')

  // The store-dependent side arrives. Nothing rebinds.
  const relay = await createArchiveConsole({
    service: fakeService(),
    downloader: { async download() { throw new Error('not used') } },
    publisher: {},
    uploadDir,
    httpSurface: surface,
    host: '127.0.0.1',
    port: 0
  })
  await relay.start()

  const readyCatalog = await fetch(`${base}/api/v1/catalog`)
  t.is(readyCatalog.status, 200, '503 then 200, on one uninterrupted socket')
  t.is((await readyCatalog.json()).entities.length, 1)
  t.alike(await (await fetch(`${base}/health`)).json(), { ok: true, ready: true })
})

test('a relay whose backend never comes up still binds, and its catalog stays retryable', async function (t) {
  // The real failure: everything the console reads lives behind a backend
  // bring-up that walks the whole store, and on a populated one it can stall
  // without ever failing. The bind must not be behind it.
  const storagePath = mkdtempSync(join(tmpdir(), 'pt-api-stalled-'))
  const surface = createArchiveHttpSurface({ host: '127.0.0.1', port: 0 })
  t.teardown(async () => {
    await surface.close()
    rmSync(storagePath, { recursive: true, force: true })
  })

  const config = resolveRelayConfig({
    storage: { path: storagePath, maxBytes: 4096, minFreeBytes: 0 },
    archive: { enabled: false, uiEnabled: true, uiHost: '127.0.0.1', uiPort: 8174, localMirror: { enabled: false } },
    classification: { tmdb: { enabled: false } },
    discovery: { enabled: false, seedDiscovered: false }
  }, { env: {} })

  let runtimeAsked = false
  const stalled = createRelayService({
    config,
    logger: silentLogger,
    archiveHttp: surface,
    writeStatusFile: async () => {},
    runtimeFactory: () => {
      runtimeAsked = true
      return new Promise(() => {})
    }
  })
  // It never resolves; the point is that nothing below waits for it.
  stalled.catch(() => {})

  const base = `http://127.0.0.1:${await surface.listen()}`
  const health = await fetch(`${base}/health`)
  t.is(health.status, 200, 'the relay is reachable while its backend is still coming up')
  t.is((await health.json()).ready, false)

  const catalog = await fetch(`${base}/api/v1/catalog`)
  t.is(catalog.status, 503, 'not a refused connection and not a held one')
  t.is((await catalog.json()).error.code, 'CATALOG_UNAVAILABLE')
  t.ok(runtimeAsked, 'the backend bring-up was started, just not waited on to bind')
})

test('the access gate holds while the relay is still warming', async function (t) {
  // A relay that is not ready yet must never be the easier way in: the switch is
  // read off the bind, which readiness cannot change.
  const exposed = createArchiveHttpSurface({ host: '0.0.0.0', port: 0 })
  const opened = createArchiveHttpSurface({ host: '0.0.0.0', port: 0, apiOpen: true })
  t.teardown(async () => {
    await exposed.close()
    await opened.close()
  })

  const refused = await fetch(`http://127.0.0.1:${await exposed.listen()}/api/v1/catalog`)
  t.is(refused.status, 403, 'a non-loopback bind refuses enumeration exactly as a started relay does')
  const refusedBody = await refused.json()
  t.is(refusedBody.error.code, 'OPEN_ACCESS_NOT_ENABLED')
  t.ok(refusedBody.error.message.includes('--api-open'), 'and still names the switch that lifts it')

  const warming = await fetch(`http://127.0.0.1:${await opened.listen()}/api/v1/catalog`)
  t.is(warming.status, 503, 'with the switch set, the answer is the retryable one')
  t.is((await warming.json()).error.code, 'CATALOG_UNAVAILABLE')

  const submit = await fetch(`http://127.0.0.1:${exposed.port}/api/v1/archive`, { method: 'POST' })
  t.is(submit.status, 503, 'submission was never gated, so it degrades rather than refusing')
  t.is((await submit.json()).error.code, 'MEDIA_GRAPH_UNAVAILABLE')
})

test('a media graph that stalls after answering once serves its last catalog rather than 503 forever', async function (t) {
  // A relay that has answered can always answer again. Riding the deadline into
  // a permanent 503 tells a caller nothing it can act on.
  let reads = 0
  const service = fakeService({
    catalog: () => {
      reads += 1
      return reads === 1 ? catalogPage() : new Promise(() => {})
    }
  })

  await withRelay(async ({ base }) => {
    const live = await fetch(`${base}/api/v1/catalog`)
    t.is(live.status, 200)
    t.absent((await live.json()).stale, 'a live read is not marked stale')

    const stalled = await fetch(`${base}/api/v1/catalog`)
    t.is(stalled.status, 200, 'the stall is survivable for a caller that only needs to know what exists')
    const body = await stalled.json()
    t.is(body.entities.length, 1)
    t.is(body.stale, true, 'and is honest that the graph did not answer this time')
    t.ok(Number.isFinite(body.staleForMs), 'with how long ago it last did')
  }, { service })
})
