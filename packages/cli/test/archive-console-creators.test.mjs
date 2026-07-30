import test from 'brittle'
import { annotateTmdbDiscoverItems, buildTmdbNetworkIndex, createArchiveConsole } from '../src/archive-console.js'
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs'
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
    ...overrides
  }
}

async function withConsole(service, fn, consoleOptions = {}) {
  const console = await createArchiveConsole({
    service,
    downloader: { async download() { throw new Error('not used') } },
    publisher: {},
    ...consoleOptions,
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

test('GET / renders the creators and TMDB sections', async function (t) {
  await withConsole(fakeService(), async (base) => {
    const res = await fetch(`${base}/`)
    const html = await res.text()
    t.ok(html.includes('Tracked creators'))
    t.ok(html.includes('Unseeded targets'))
    t.ok(html.includes('Contribute a creator'))
    t.ok(html.includes('Content classification (TMDB)'))
    t.ok(html.includes('Authorized creator devices'))
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


test('TMDB network status distinguishes TV episodes from show-level matches', function (t) {
  const index = buildTmdbNetworkIndex([{
    channelKey: 'drive-tv',
    publicBeeKey: 'bee-tv',
    previewVideos: [{
      id: 'severance-s2e4',
      title: 'Severance S2E4',
      blobId: '0:4:0:99',
      blobsCoreKey: 'aa'.repeat(32),
      availability: 'playable',
      classification: { type: 'tv', tmdbId: 95396, title: 'Severance', season: 2, episode: 4 }
    }],
    unavailableVideos: [{
      id: 'severance-s2e5',
      title: 'Severance S2E5',
      availability: 'unavailable',
      classification: { type: 'tv', tmdbId: 95396, title: 'Severance', season: 2, episode: 5 }
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

test('POST /discover/archive builds episode-aware TMDB source ids when no hidden source id is supplied', async function (t) {
  const downloads = []
  const service = fakeService({
    async publishArchiveJob() {}
  })
  await withConsole(service, async (base) => {
    const res = await fetch(`${base}/discover/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        url: 'https://source.example/severance-s2e4.mp4',
        channelName: 'Severance',
        title: 'Severance S2E4',
        tmdbType: 'tv',
        tmdbId: '95396',
        tmdbSeason: '2',
        tmdbEpisode: '4',
        tmdbTitle: 'Severance'
      }).toString(),
      redirect: 'manual'
    })
    t.is(res.status, 303)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }, {
    downloader: {
      async download(input) {
        downloads.push(input)
        return { filePath: '/tmp/severance.mp4', title: input.title, description: '', mimeType: 'video/mp4' }
      }
    }
  })

  t.is(downloads[0].sourceVideoId, 'tmdb:tv:95396:s2:e4')
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

test('POST /archive reserves staged uploads against later multipart requests', async function (t) {
  const uploadDir = mkdtempSync(join(tmpdir(), 'pt-console-upload-reserve-'))
  let firstImportStartedResolve
  let releaseFirstImport
  const firstImportStarted = new Promise((resolve) => { firstImportStartedResolve = resolve })
  const releaseFirst = new Promise((resolve) => { releaseFirstImport = resolve })
  const publisher = {
    async ensureAnonymousChannel() {
      firstImportStartedResolve()
      await releaseFirst
      throw new Error('stop-after-reservation-check')
    }
  }
  const headroom = () => {
    const free = Math.max(0, 1000 - directoryBytes(uploadDir))
    return { tmp: free, storage: free, sharedVolume: true }
  }
  try {
    await withConsole(fakeService(), async (base) => {
      const first = new FormData()
      first.set('channelName', 'Reservation')
      first.set('title', 'Large staged upload')
      first.set('publish', 'false')
      first.set('file', new Blob([Buffer.alloc(400, 0x61)], { type: 'video/mp4' }), 'large.mp4')
      const firstRes = await fetch(`${base}/archive`, { method: 'POST', body: first, redirect: 'manual' })
      t.is(firstRes.status, 303, 'the first upload stages and enqueues')
      await firstImportStarted

      const second = new FormData()
      second.set('channelName', 'Reservation')
      second.set('title', 'Second staged upload')
      second.set('publish', 'false')
      second.set('file', new Blob([Buffer.alloc(300, 0x62)], { type: 'video/mp4' }), 'second.mp4')
      const secondRes = await fetch(`${base}/archive`, { method: 'POST', body: second, redirect: 'manual' })
      t.is(secondRes.status, 500, 'the second upload is refused before overbooking the shared-volume peak')
      t.ok(/storage headroom/.test(await secondRes.text()), 'the refusal names storage headroom')

      releaseFirstImport()
      for (let i = 0; i < 50 && directoryBytes(uploadDir) !== 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      t.is(directoryBytes(uploadDir), 0, 'completed job cleanup releases the staged upload reservation')

      const third = new FormData()
      third.set('channelName', 'Reservation')
      third.set('title', 'Upload after cleanup')
      third.set('publish', 'false')
      third.set('file', new Blob([Buffer.alloc(400, 0x63)], { type: 'video/mp4' }), 'after-cleanup.mp4')
      const thirdRes = await fetch(`${base}/archive`, { method: 'POST', body: third, redirect: 'manual' })
      t.is(thirdRes.status, 303, 'a new upload succeeds after the prior reservation is released')
      for (let i = 0; i < 50 && directoryBytes(uploadDir) !== 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      t.is(directoryBytes(uploadDir), 0, 'third upload cleanup also releases before the mixed reservation check')

      const directReservations = { bytes: 400 }
      await withConsole(fakeService(), async (secondBase) => {
        const mixed = new FormData()
        mixed.set('channelName', 'Reservation')
        mixed.set('title', 'Upload beside direct')
        mixed.set('publish', 'false')
        mixed.set('file', new Blob([Buffer.alloc(250, 0x64)], { type: 'video/mp4' }), 'beside-direct.mp4')
        const mixedRes = await fetch(`${secondBase}/archive`, { method: 'POST', body: mixed, redirect: 'manual' })
        t.is(mixedRes.status, 500, 'multipart staging subtracts active direct download reservations')
        t.ok(/storage headroom/.test(await mixedRes.text()), 'mixed direct/upload overbooking is refused by headroom')
        directReservations.bytes = 0
        const afterDirect = new FormData()
        afterDirect.set('channelName', 'Reservation')
        afterDirect.set('title', 'Upload after direct')
        afterDirect.set('publish', 'false')
        afterDirect.set('file', new Blob([Buffer.alloc(250, 0x65)], { type: 'video/mp4' }), 'after-direct.mp4')
        const afterRes = await fetch(`${secondBase}/archive`, { method: 'POST', body: afterDirect, redirect: 'manual' })
        t.is(afterRes.status, 303, 'multipart staging succeeds once the direct reservation is gone')
      }, {
        uploadDir,
        uploadStorageHeadroom: () => {
          const free = Math.max(0, 600 - directoryBytes(uploadDir))
          return { tmp: free, storage: free, sharedVolume: true }
        },
        storageReservations: directReservations,
        publisher
      })
    }, { uploadDir, uploadStorageHeadroom: headroom, publisher })
  } finally {
    releaseFirstImport?.()
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
