import test from 'brittle'
import { annotateTmdbDiscoverItems, buildTmdbNetworkIndex, createArchiveConsole, createArchiveHttpSurface } from '../src/archive-console.js'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fakeMetaDb() {
  const map = new Map()
  return {
    async get(key) { return map.has(key) ? { value: map.get(key) } : null },
    async put(key, value) { map.set(key, value) }
  }
}
function directoryBytes(path) {
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += directoryBytes(child)
    else if (entry.isFile()) total += statSync(child).size
  }
  return total
}


function fakeService(overrides = {}) {
  const tmdb = { apiKey: '', enabled: false }
  const creators = [
    { creatorId: 'youtube:channel:UC1', name: 'One', videosArchived: 3, videosUnseeded: 2, classification: { movie: 1, tv: 0, unknown: 2 } },
    { creatorId: 'youtube:creator:solo', name: 'Solo', videosArchived: 1, videosUnseeded: 0, classification: { movie: 0, tv: 1, unknown: 0 } }
  ]
  const trustedClients = []
  const calls = { addCreator: [], setTmdb: [], authorize: [], revoke: [] }
  const jobs = []
  return {
    calls,
    getTrustedClients() { return trustedClients },
    getLinkDescriptor() { return { schema: 'peartube.relayLink', version: 2, seedPin: { enabled: true, authorizedClients: trustedClients.length } } },
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
    async getVerifiedMediaCatalog() {
      return {
        success: true,
        nextCursor: null,
        items: [{
          entityId: '1'.repeat(64),
          entityKind: 'movie',
          title: 'The Matrix',
          releaseYear: 1999,
          sources: [{
            publicationId: 'pub-matrix',
            renditionId: 'rend-matrix',
            candidateRef: 'M'.repeat(43),
            availability: 'playable',
            mediaCoordinates: { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '603' }
          }]
        }]
      }
    },
    async getVerifiedManifest() { return null },
    async getVerifiedEntityArtwork() { return null },
    getArchiveMirrorRequests() { return [] },
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
    async discoverTmdbSeasons({ tmdbId }) {
      calls.seasons = { tmdbId }
      return [{ season: 1, name: 'Season 1', episodeCount: 9, airDate: '2022-01-01' }]
    },
    async discoverTmdbEpisodes({ tmdbId, season }) {
      calls.episodes = { tmdbId, season }
      return [{ season: Number(season), episode: 1, title: 'Pilot', overview: '', airDate: '2022-01-01' }]
    },
    async setTmdbSettings(form) { calls.setTmdb.push(form); tmdb.apiKey = form.apiKey; tmdb.enabled = form.enabled; return { enabled: form.enabled } },
    async addCreatorSource(form) { calls.addCreator.push(form); return { creator: {}, job: {} } },
    async requestLocalFileAcquisition(input) {
      const job = {
        acquisitionId: `acq-ui-${jobs.length + 1}`,
        state: 'queued',
        title: input.title,
        errorCode: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sourceAccepted: true
      }
      jobs.push(job)
      return job
    },
    async listAcquisitions() { return jobs },
    ...overrides
  }
}

async function withConsole(service, fn, consoleOptions = {}) {
  const console = await createArchiveConsole({
    service,
    downloader: { async download() { throw new Error('not used') } },
    publisher: {},
    ...consoleOptions,
    host: consoleOptions.host || '127.0.0.1',
    port: consoleOptions.port ?? 0
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

test('GET /jobs exposes bounded acquisition progress and durable result ids', async function (t) {
  const service = fakeService({
    async listAcquisitions() {
      return [{
        acquisitionId: 'acq-progress',
        state: 'acquiring',
        title: 'Eagle Eye',
        mediaContext: { kind: 'movie', identifier: '13027' },
        retentionClass: 'contribution-cache',
        bytesAcquired: 425,
        expectedBytes: 1000,
        publicationId: 'pub-eagle',
        manifestId: 'manifest-eagle',
        renditionId: 'rendition-eagle',
        assetId: 'asset-eagle',
        recoverable: true,
        errorCode: null,
        createdAt: 100,
        updatedAt: 200
      }]
    }
  })

  await withConsole(service, async (base) => {
    const res = await fetch(`${base}/jobs`)
    t.is(res.status, 200)
    const body = await res.json()
    const job = body.jobs[0]
    t.is(job.status, 'running')
    t.is(job.progressPercent, 42.5)
    t.is(job.bytesAcquired, 425)
    t.is(job.expectedBytes, 1000)
    t.is(job.retentionClass, 'contribution-cache')
    t.is(job.entityHint, 'movie:13027')
    t.is(job.publicationId, 'pub-eagle')
    t.is(job.assetId, 'asset-eagle')
    t.ok(job.recoverable)
  })
})

test('GET /jobs names the work an acquisition is fetching from signed publisher metadata', async function (t) {
  const service = fakeService({
    async listAcquisitions() {
      return [{
        acquisitionId: 'acq-episode',
        state: 'publishing',
        title: 'FUBAR',
        mediaContext: { kind: 'episode', namespace: 'tmdb', identifier: '221300', season: 2, episode: 7 },
        retentionClass: 'contribution-cache',
        bytesAcquired: 10,
        expectedBytes: 10,
        errorCode: null,
        recoverable: false,
        createdAt: 1,
        updatedAt: 2
      }]
    }
  })

  await withConsole(service, async (base) => {
    const job = (await (await fetch(`${base}/jobs`)).json()).jobs[0]
    t.is(job.title, 'FUBAR', 'the transfer is named by its work, not by its acquisition id')
    t.is(job.entityHint, 'show:221300:s2:e7')
    t.alike(job.mediaContext, { kind: 'episode', namespace: 'tmdb', identifier: '221300', season: 2, episode: 7 })

    const home = await (await fetch(`${base}/`)).text()
    t.ok(home.includes('FUBAR'), 'the console renders the work title')
    t.ok(home.includes('S02E07'), 'episode coordinates reach the transfer row')
  })
})

test('the shelf lists one release per publication and keeps each source file name', async function (t) {
  const service = fakeService({
    async getVerifiedMediaCatalog() {
      return {
        success: true,
        nextCursor: null,
        items: [{
          entityId: '2'.repeat(64),
          entityKind: 'movie',
          title: 'FUBAR',
          sources: [
            { publicationId: 'pub-2160p', renditionId: 'rend-a', mediaCoordinates: { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '221300' } },
            { publicationId: 'pub-1080p', renditionId: 'rend-b', mediaCoordinates: { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '221300' } }
          ]
        }]
      }
    },
    async listAcquisitions() {
      return [
        { acquisitionId: 'acq-2160p', state: 'completed', title: 'FUBAR', sourceFileName: 'Fubar.S02E07.2160p.mkv', retentionClass: 'archive-pin', bytesAcquired: 6, expectedBytes: 6, publicationId: 'pub-2160p', recoverable: false, errorCode: null, createdAt: 1, updatedAt: 2 },
        { acquisitionId: 'acq-1080p', state: 'completed', title: 'FUBAR', sourceFileName: 'FUBAR.S02E07.1080p.mkv', retentionClass: 'archive-pin', bytesAcquired: 3, expectedBytes: 3, publicationId: 'pub-1080p', recoverable: false, errorCode: null, createdAt: 3, updatedAt: 4 }
      ]
    }
  })

  await withConsole(service, async (base) => {
    const home = await (await fetch(`${base}/`)).text()
    t.ok(home.includes('Fubar.S02E07.2160p.mkv'), 'the console lists each release by the file its source named')
    t.ok(home.includes('FUBAR.S02E07.1080p.mkv'))
    t.ok(home.includes('>FUBAR<'), 'both releases name the work they belong to')

    const jobs = (await (await fetch(`${base}/jobs`)).json()).jobs
    t.alike(jobs.map(job => job.sourceFileName).sort(), ['FUBAR.S02E07.1080p.mkv', 'Fubar.S02E07.2160p.mkv'])
  })
})

test('a published release uses the manifest source filename when no acquisition row remains', async function (t) {
  const service = fakeService({
    async getVerifiedMediaCatalog() {
      return {
        success: true,
        nextCursor: null,
        items: [{
          entityId: '3'.repeat(64),
          entityKind: 'movie',
          title: 'Wrath of Man',
          sources: [{ publicationId: 'pub-wrath', renditionId: 'rend-wrath' }]
        }]
      }
    },
    async getVerifiedManifest() {
      return {
        body: {
          title: 'Wrath of Man',
          sourceFileName: 'Wrath.of.Man.2021.1080p.BluRay.H264.AAC.mp4',
          renditions: [{ renditionId: 'rend-wrath', core: { byteLength: 12 } }]
        }
      }
    },
    async listAcquisitions() {
      return []
    }
  })

  await withConsole(service, async (base) => {
    const home = await (await fetch(`${base}/`)).text()
    t.ok(home.includes('Wrath.of.Man.2021.1080p.BluRay.H264.AAC.mp4'))
  })
})

test('a local release filename override labels publications created before filename manifests', async function (t) {
  const service = fakeService({
    settings: {
      get(key, fallback) {
        if (key === 'releaseFileNames') return { 'pub-legacy': 'Justice.League.Dark.2017.1080p.BluRay.x265-RARBG.mp4' }
        return fallback
      }
    },
    async getVerifiedMediaCatalog() {
      return {
        success: true,
        nextCursor: null,
        items: [{
          entityId: '4'.repeat(64),
          entityKind: 'movie',
          title: 'Justice League Dark',
          sources: [{ publicationId: 'pub-legacy', renditionId: 'rend-legacy' }]
        }]
      }
    },
    async getVerifiedManifest() {
      return {
        body: {
          title: 'Justice League Dark',
          renditions: [{ renditionId: 'rend-legacy', core: { byteLength: 12 } }]
        }
      }
    },
    async listAcquisitions() {
      return []
    }
  })

  await withConsole(service, async (base) => {
    const home = await (await fetch(`${base}/`)).text()
    t.ok(home.includes('Justice.League.Dark.2017.1080p.BluRay.x265-RARBG.mp4'))
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

test('GET /discover renders the Discover section and TMDB archive forms', async function (t) {
  await withConsole(fakeService(), async (base) => {
    const res = await fetch(`${base}/discover?type=movie&q=matrix`)
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

test('POST /settings/tmdb with a blank key toggles enabled without wiping the stored key', async function (t) {
  const service = fakeService()
  await withConsole(service, async (base) => {
    const res = await fetch(`${base}/settings/tmdb`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ apiKey: '   ', enabled: 'true' }).toString(),
      redirect: 'manual'
    })
    t.is(res.status, 303)
  })
  t.is(service.calls.setTmdb.length, 1)
  t.absent('apiKey' in service.calls.setTmdb[0], 'blank key is omitted so setTmdbSettings keeps the stored key')
  t.is(service.calls.setTmdb[0].enabled, true)
})

test('the creators and settings routes carry their own sections', async function (t) {
  await withConsole(fakeService(), async (base) => {
    const creators = await (await fetch(`${base}/creators`)).text()
    t.ok(creators.includes('Tracked creators'))
    t.ok(creators.includes('Unseeded targets'))
    t.ok(creators.includes('Contribute a creator'))
    t.absent(creators.includes('Content classification (TMDB)'), 'settings stay on the settings route')

    const settings = await (await fetch(`${base}/settings`)).text()
    t.ok(settings.includes('Content classification (TMDB)'))
    t.ok(settings.includes('Authorized creator devices'))
    t.ok(settings.includes('S3 block store'))
    t.absent(settings.includes('Tracked creators'), 'creators stay on the creators route')
  })
})

test('GET /link.json returns the relay link descriptor', async function (t) {
  await withConsole(fakeService(), async (base) => {
    const res = await fetch(`${base}/link.json`)
    t.is(res.status, 200)
    const body = await res.json()
    t.is(body.schema, 'peartube.relayLink')
    t.is(body.version, 2)
    t.is(body.seedPin.enabled, true)
    t.is(body.seedPin.authorizedClients, 0)
    t.absent(body.relayMirrorKey, 'permissionless relay descriptors expose policy, not a trusted mirror key')
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

test('archive UI binds while storage warms and adopts the same listener when verified service facts arrive', async function (t) {
  const surface = createArchiveHttpSurface({ host: '127.0.0.1', port: 0 })
  t.teardown(() => surface.close().catch(() => {}))
  const port = await surface.listen()
  const base = `http://127.0.0.1:${port}`
  const warming = await (await fetch(`${base}/health`)).json()
  t.alike(warming, { ok: true, ready: false, waitingFor: 'relay-storage' })

  const console = await createArchiveConsole({
    service: fakeService(),
    downloader: { async download() { throw new Error('not used') } },
    host: '127.0.0.1',
    port,
    httpSurface: surface
  })
  await console.start()
  t.alike(await (await fetch(`${base}/health`)).json(), { ok: true, ready: true })
  await console.close()
})

test('archive UI playback opens catalogued rows by stable ids and legacy machine routes stay absent', async function (t) {
  const opened = []
  const service = fakeService({
    async openPublicationPlayback(publicationId, renditionId) {
      opened.push([publicationId, renditionId])
      return {
        transport: 'tcp',
        host: '127.0.0.1',
        port: 8175,
        url: `http://127.0.0.1:8175/?key=${'K'.repeat(52)}&blob=${'B'.repeat(10)}&type=video%2Fmp4&token=${'C'.repeat(43)}`
      }
    }
  })
  await withConsole(service, async (base) => {
    const home = await (await fetch(base)).text()
    t.ok(home.includes('/play/pub/pub-matrix/rend-matrix'), 'a catalogued row links playback by stable ids')

    const play = await fetch(`${base}/play/pub/pub-matrix/rend-matrix`, { redirect: 'manual' })
    t.is(play.status, 303)
    t.is(play.headers.get('location'), `http://127.0.0.1:8175/?key=${'K'.repeat(52)}&blob=${'B'.repeat(10)}&type=video%2Fmp4&token=${'C'.repeat(43)}`)
    t.alike(opened, [['pub-matrix', 'rend-matrix']])

    const legacy = await fetch(`${base}/api/v1/catalog`)
    t.is(legacy.status, 404)
    t.ok((legacy.headers.get('content-type') || '').startsWith('text/plain'), 'retired machine paths do not fall through to JSON')

    const duplicateCatalog = await fetch(`${base}/catalog.json`)
    t.is(duplicateCatalog.status, 404, 'the duplicate unauthenticated catalog projection is gone')
  })
})

test('archive UI playback still redirects a candidate reference open', async function (t) {
  const opened = []
  const service = fakeService({
    async openVerifiedPlayback(candidateRef) {
      opened.push(candidateRef)
      return {
        transport: 'tcp',
        host: '127.0.0.1',
        port: 8175,
        url: `http://127.0.0.1:8175/?key=${'K'.repeat(52)}&blob=${'B'.repeat(10)}&type=video%2Fmp4&token=${'C'.repeat(43)}`
      }
    }
  })
  await withConsole(service, async (base) => {

    const play = await fetch(`${base}/play/${'M'.repeat(43)}`, { redirect: 'manual' })
    t.is(play.status, 303)
    t.is(play.headers.get('location'), `http://127.0.0.1:8175/?key=${'K'.repeat(52)}&blob=${'B'.repeat(10)}&type=video%2Fmp4&token=${'C'.repeat(43)}`)
    t.alike(opened, ['M'.repeat(43)])
  })
})

test('playback refuses any open that is not the blob server link shape', async function (t) {
  for (const url of [
    'https://127.0.0.1:8175/?key=K&blob=B',
    'http://10.0.0.5:8175/?key=K&blob=B',
    'http://127.0.0.1:8175/api/v2/stream/pub/rend?cap=C',
    'http://127.0.0.1:8175/other?key=K&blob=B',
    'http://127.0.0.1:8175/?type=video%2Fmp4',
    'http://127.0.0.1:8175/?key=K&blob=B#frag'
  ]) {
    const service = fakeService({
      async openVerifiedPlayback() {
        return { transport: 'tcp', host: '127.0.0.1', port: 8175, url }
      }
    })
    await withConsole(service, async (base) => {
      const play = await fetch(`${base}/play/${'M'.repeat(43)}`, { redirect: 'manual' })
      t.is(play.status, 404, `${url} must not become a redirect target`)
    })
  }
})

test('a non-local client to an externally bound relay gets no playback capability', async function (t) {
  const opened = []
  const service = fakeService({
    async openVerifiedPlayback(candidateRef) {
      opened.push(candidateRef)
      return { transport: 'tcp', host: '127.0.0.1', port: 8175, url: '/api/v2/stream/forbidden' }
    }
  })
  // The socket peer says LAN, no matter which interface the console bound.
  await withConsole(service, async (base) => {
    const home = await fetch(base).then(r => r.text())
    t.absent(home.includes('/play/'), 'a LAN client renders no play links')
    const play = await fetch(`${base}/play/${'M'.repeat(43)}`, { redirect: 'manual' })
    t.is(play.status, 403)
    t.alike(opened, [], 'a LAN client never reaches the in-process companion identity')
  }, {
    host: '0.0.0.0',
    allowsPlaybackRequest: () => false
  })
})

test('a local browser on an externally bound relay still gets playback', async function (t) {
  const opened = []
  const service = fakeService({
    async openPublicationPlayback(publicationId, renditionId) {
      opened.push([publicationId, renditionId])
      return {
        transport: 'tcp',
        host: '127.0.0.1',
        port: 8175,
        url: `http://127.0.0.1:8175/?key=${'K'.repeat(52)}&blob=${'B'.repeat(10)}&type=video%2Fmp4&token=${'C'.repeat(43)}`
      }
    }
  })
  // Bound wide, called from this machine: the socket peer is loopback, so the
  // stable-id play link renders and the redirect mints.
  await withConsole(service, async (base) => {
    const home = await fetch(base).then(r => r.text())
    t.ok(home.includes('/play/pub/pub-matrix/rend-matrix'), 'a loopback client of a 0.0.0.0 relay sees play links')
    const play = await fetch(`${base}/play/pub/pub-matrix/rend-matrix`, { redirect: 'manual' })
    t.is(play.status, 303)
    t.alike(opened, [['pub-matrix', 'rend-matrix']])
  }, { host: '0.0.0.0' })
})


test('TMDB network status distinguishes TV episodes from show-level matches', function (t) {
  const index = buildTmdbNetworkIndex([{
    entityId: '2'.repeat(64),
    entityKind: 'series',
    title: 'Severance',
    sources: [{
      publicationId: 'severance-s2e4',
      renditionId: 'video',
      candidateRef: 'S'.repeat(43),
      mediaCoordinates: {
        contentKind: 'episode',
        mediaProvider: 'tmdb',
        mediaId: '95396',
        seasonNumber: 2,
        episodeNumber: 4
      }
    }, {
      publicationId: 'severance-s2e5',
      renditionId: 'video',
      availability: 'unavailable',
      mediaCoordinates: {
        contentKind: 'episode',
        mediaProvider: 'tmdb',
        mediaId: '95396',
        seasonNumber: 2,
        episodeNumber: 5
      }
    }]
  }])
  const annotated = annotateTmdbDiscoverItems([
    { type: 'tv', tmdbId: 95396, title: 'Severance', season: 2, episode: 4 },
    { type: 'tv', tmdbId: 95396, title: 'Severance', season: 2, episode: 5 },
    { type: 'tv', tmdbId: 95396, title: 'Severance', season: 2, episode: 6 },
    { type: 'tv', tmdbId: 95396, title: 'Severance' }
  ], index)

  t.is(annotated[0].networkStatus, 'seeding')
  t.is(annotated[1].networkStatus, 'in-network')
  t.is(annotated[2].networkStatus, 'missing')
  t.is(annotated[3].networkStatus, 'missing', 'show-level item does not inherit episode availability')
})


test('POST /archive accepts a multipart file upload and enqueues an upload job', async function (t) {
  const uploadDir = mkdtempSync(join(tmpdir(), 'pt-console-upload-'))
  try {
    await withConsole(fakeService(), async (base) => {
      const fd = new FormData()
      fd.set('channelName', 'Severance')
      fd.set('title', 'Severance S01E02')
      fd.set('tmdbType', 'tv')
      fd.set('tmdbId', '95396')
      fd.set('publish', 'false')
      fd.set('file', new Blob([Buffer.from('FAKE-MP4-BYTES')], { type: 'video/mp4' }), 'clip.mp4')
      const res = await fetch(`${base}/archive`, { method: 'POST', body: fd, redirect: 'manual' })
      t.is(res.status, 303, 'multipart upload is accepted')

      const jobs = await (await fetch(`${base}/jobs`)).json()
      t.ok(jobs.jobs.length >= 1, 'an archive job was enqueued from the upload')
      t.ok(jobs.jobs.some((job) => job.title === 'Severance S01E02'), 'job carries the submitted title')
    }, { uploadDir })
  } finally {
    rmSync(uploadDir, { recursive: true, force: true })
  }
})


test('GET /discover/seasons.json returns TMDB seasons for a show', async function (t) {
  await withConsole(fakeService(), async (base) => {
    const res = await fetch(`${base}/discover/seasons.json?tmdbId=95396`)
    t.is(res.status, 200)
    const body = await res.json()
    t.is(body.schema, 'peartube.relayTmdbSeasons')
    t.is(body.seasons.length, 1)
    t.is(body.seasons[0].season, 1)
    t.is(body.seasons[0].episodeCount, 9)
  })
})

test('GET /discover/episodes.json returns TMDB episodes for a season', async function (t) {
  const service = fakeService()
  await withConsole(service, async (base) => {
    const res = await fetch(`${base}/discover/episodes.json?tmdbId=95396&season=1`)
    t.is(res.status, 200)
    const body = await res.json()
    t.is(body.schema, 'peartube.relayTmdbEpisodes')
    t.is(body.episodes.length, 1)
    t.is(body.episodes[0].episode, 1)
    t.is(body.episodes[0].title, 'Pilot')
  })
  t.is(service.calls.episodes.season, '1', 'season passed through from the query string')
})
