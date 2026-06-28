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
  const trustedClients = []
  const calls = { addCreator: [], setTmdb: [], authorize: [], revoke: [] }
  return {
    calls,
    getTrustedClients() { return trustedClients },
    getLinkDescriptor() { return { schema: 'peartube.relayLink', version: 1, relayMirrorKey: 'f'.repeat(64), blindPeerEnabled: true, trustedClients: trustedClients.length } },
    async authorizeClient(form) { calls.authorize.push(form); trustedClients.push({ key: form.key, label: form.label }); return { client: { key: form.key }, liveApplied: false } },
    async revokeClient(key) { calls.revoke.push(key); return { removed: true } },
    config: { classification: { tmdb: { baseUrl: 'https://api', language: 'en-US' } } },
    settings: {
      get(key, fallback = null) {
        if (key === 'tmdbApiKey') return tmdb.apiKey || fallback
        if (key === 'tmdbEnabled') return tmdb.enabled
        return fallback
      }
    },
    runtime: { ctx: { metaDb: fakeMetaDb() } },
    catalog: {
      getChannels() {
        return [{
          channelKey: 'drive-matrix',
          publicBeeKey: 'bee-matrix',
          source: 'archive-job',
          previewVideos: [{
            id: 'video-matrix',
            title: 'The Matrix',
            blobId: '0:4:0:99',
            blobsCoreKey: 'aa'.repeat(32),
            availability: 'playable',
            classification: { type: 'movie', tmdbId: 603, title: 'The Matrix', year: 1999 }
          }]
        }]
      }
    },
    getStatus() { return { runtime: { peers: 0, seeding: {} }, creators: { unseededTargets: [] } } },
    creators: { getCreators() { return creators } },
    getCreatorTargets() { return [{ creatorId: 'youtube:channel:UC1', name: 'One', videosArchived: 3, videosUnseeded: 2 }] },
    async discoverTmdb({ query, type }) {
      calls.discover = { query, type }
      return [
        { type: 'movie', tmdbId: 603, title: 'The Matrix', year: 1999, posterPath: '/matrix.jpg', overview: 'A hacker wakes up.', popularity: 99 },
        { type: 'movie', tmdbId: 999, title: 'Missing Movie', year: 2024, posterPath: '/missing.jpg', overview: 'Not here yet.', popularity: 80 }
      ]
    },
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



test('GET /discover.json annotates TMDB items with relay network status', async function (t) {
  const service = fakeService()
  await withConsole(service, async (base) => {
    const res = await fetch(`${base}/discover.json?type=movie&q=matrix`)
    t.is(res.status, 200)
    const body = await res.json()
    t.is(body.schema, 'peartube.relayDiscover')
    t.is(body.query, 'matrix')
    t.is(body.type, 'movie')
    t.is(body.items[0].title, 'The Matrix')
    t.is(body.items[0].networkStatus, 'seeding')
    t.is(body.items[0].seededCopies, 1)
    t.is(body.items[1].networkStatus, 'missing')
  })
})

test('GET / renders Discover section and TMDB archive forms', async function (t) {
  await withConsole(fakeService(), async (base) => {
    const res = await fetch(`${base}/?type=movie&q=matrix`)
    t.is(res.status, 200)
    const html = await res.text()
    t.ok(html.includes('Discover missing movies &amp; shows'))
    t.ok(html.includes('The Matrix'))
    t.ok(html.includes('name="tmdbId" value="603"'))
    t.ok(html.includes('Archive this title'))
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
    t.ok(html.includes('Linked creator devices'))
  })
})

test('GET /link.json returns the relay link descriptor', async function (t) {
  await withConsole(fakeService(), async (base) => {
    const res = await fetch(`${base}/link.json`)
    t.is(res.status, 200)
    const body = await res.json()
    t.is(body.schema, 'peartube.relayLink')
    t.is(body.relayMirrorKey, 'f'.repeat(64))
  })
})

test('POST /clients authorizes and GET /clients.json lists devices', async function (t) {
  const service = fakeService()
  const deviceKey = 'a'.repeat(64)
  await withConsole(service, async (base) => {
    const res = await fetch(`${base}/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: deviceKey, label: 'Phone' }).toString(),
      redirect: 'manual'
    })
    t.is(res.status, 303)
    const listed = await (await fetch(`${base}/clients.json`)).json()
    t.is(listed.schema, 'peartube.relayTrustedClients')
    t.is(listed.clients[0].key, deviceKey)
  })
  t.is(service.calls.authorize.length, 1)
  t.is(service.calls.authorize[0].key, deviceKey)
})

test('POST /clients/revoke forwards to revokeClient', async function (t) {
  const service = fakeService()
  const deviceKey = 'b'.repeat(64)
  await withConsole(service, async (base) => {
    const res = await fetch(`${base}/clients/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: deviceKey }).toString(),
      redirect: 'manual'
    })
    t.is(res.status, 303)
  })
  t.is(service.calls.revoke.length, 1)
  t.is(service.calls.revoke[0], deviceKey)
})
