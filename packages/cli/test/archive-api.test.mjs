import test from 'brittle'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createArchiveConsole } from '../src/archive-console.js'

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

async function withRelay(fn, { service = fakeService(), consoleOptions = {} } = {}) {
  const uploadDir = mkdtempSync(join(tmpdir(), 'pt-api-upload-'))
  const relay = await createArchiveConsole({
    service,
    downloader: { async download() { throw new Error('not used') } },
    publisher: {},
    uploadDir,
    ...consoleOptions,
    host: '127.0.0.1',
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

test('an upload with no file part is refused rather than enqueued as a URL job', async function (t) {
  await withRelay(async ({ base }) => {
    const body = new FormData()
    body.set('contentKind', 'movie')
    body.set('tmdbId', '9367')
    body.set('tmdbTitle', 'Wedding Crashers')
    const res = await fetch(`${base}/api/v1/archive`, { method: 'POST', body })

    t.is(res.status, 400)
    t.is((await res.json()).error.code, 'FILE_REQUIRED')

    // A client that sends JSON instead of the bytes gets the same answer: this
    // endpoint publishes what the caller uploads, and nothing else.
    const asJson = await fetch(`${base}/api/v1/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentKind: 'movie', tmdbId: '9367', tmdbTitle: 'Wedding Crashers', filePath: '/etc/passwd' })
    })
    t.is(asJson.status, 400)
    t.is((await asJson.json()).error.code, 'FILE_REQUIRED')
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
