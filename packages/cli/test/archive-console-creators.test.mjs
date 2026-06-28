import test from 'brittle'
import { createArchiveConsole } from '../src/archive-console.js'

function fakeMetaDb() {
  const map = new Map()
  return {
    async get(key) { return map.has(key) ? { value: map.get(key) } : null },
    async put(key, value) { map.set(key, value) }
  }
}

function fakeService(overrides = {}) {
  const tmdb = { apiKey: '', enabled: false }
  const creators = [
    { creatorId: 'youtube:channel:UC1', name: 'One', videosArchived: 3, videosUnseeded: 2, classification: { movie: 1, tv: 0, unknown: 2 } },
    { creatorId: 'youtube:creator:solo', name: 'Solo', videosArchived: 1, videosUnseeded: 0, classification: { movie: 0, tv: 1, unknown: 0 } }
  ]
  const calls = { addCreator: [], setTmdb: [] }
  return {
    calls,
    config: { classification: { tmdb: { baseUrl: 'https://api', language: 'en-US' } } },
    settings: {
      get(key, fallback = null) {
        if (key === 'tmdbApiKey') return tmdb.apiKey || fallback
        if (key === 'tmdbEnabled') return tmdb.enabled
        return fallback
      }
    },
    runtime: { ctx: { metaDb: fakeMetaDb() } },
    getStatus() { return { runtime: { peers: 0, seeding: {} }, creators: { unseededTargets: [] } } },
    creators: { getCreators() { return creators } },
    getCreatorTargets() { return [{ creatorId: 'youtube:channel:UC1', name: 'One', videosArchived: 3, videosUnseeded: 2 }] },
    async setTmdbSettings(form) { calls.setTmdb.push(form); tmdb.apiKey = form.apiKey; tmdb.enabled = form.enabled; return { enabled: form.enabled } },
    async addCreatorSource(form) { calls.addCreator.push(form); return { creator: {}, job: {} } },
    ...overrides
  }
}

async function withConsole(service, fn) {
  const console = await createArchiveConsole({
    service,
    downloader: { async download() { throw new Error('not used') } },
    publisher: {},
    host: '127.0.0.1',
    port: 0
  })
  await console.start()
  const { port } = console.server.address()
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await console.close()
  }
}

test('GET /creators.json returns tracked creators', async function (t) {
  await withConsole(fakeService(), async (base) => {
    const res = await fetch(`${base}/creators.json`)
    t.is(res.status, 200)
    const body = await res.json()
    t.is(body.schema, 'peartube.relayCreators')
    t.is(body.creators.length, 2)
    // Sorted by unseeded desc — the creator with unseeded videos comes first.
    t.is(body.creators[0].creatorId, 'youtube:channel:UC1')
  })
})

test('GET /unseeded.json returns ranked targets', async function (t) {
  await withConsole(fakeService(), async (base) => {
    const res = await fetch(`${base}/unseeded.json`)
    t.is(res.status, 200)
    const body = await res.json()
    t.is(body.schema, 'peartube.relayUnseededTargets')
    t.is(body.targets[0].creatorId, 'youtube:channel:UC1')
  })
})

test('POST /creators forwards to addCreatorSource', async function (t) {
  const service = fakeService()
  await withConsole(service, async (base) => {
    const res = await fetch(`${base}/creators`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ url: 'https://www.youtube.com/@chan', label: 'Chan' }).toString(),
      redirect: 'manual'
    })
    t.is(res.status, 303)
  })
  // addCreatorSource is fire-and-forget; allow the microtask to flush.
  await new Promise((resolve) => setTimeout(resolve, 10))
  t.is(service.calls.addCreator.length, 1)
  t.is(service.calls.addCreator[0].url, 'https://www.youtube.com/@chan')
  t.is(service.calls.addCreator[0].label, 'Chan')
})

test('POST /settings/tmdb forwards to setTmdbSettings', async function (t) {
  const service = fakeService()
  await withConsole(service, async (base) => {
    const res = await fetch(`${base}/settings/tmdb`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ apiKey: 'secret', enabled: 'true' }).toString(),
      redirect: 'manual'
    })
    t.is(res.status, 303)
  })
  t.is(service.calls.setTmdb.length, 1)
  t.is(service.calls.setTmdb[0].apiKey, 'secret')
  t.is(service.calls.setTmdb[0].enabled, true)
})

test('GET / renders the creators and TMDB sections', async function (t) {
  await withConsole(fakeService(), async (base) => {
    const res = await fetch(`${base}/`)
    const html = await res.text()
    t.ok(html.includes('Tracked creators'))
    t.ok(html.includes('Unseeded targets'))
    t.ok(html.includes('Contribute a creator'))
    t.ok(html.includes('Content classification (TMDB)'))
  })
})
