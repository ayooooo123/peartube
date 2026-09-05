import test from 'brittle'
import { createArchiveConsole, queryReleases } from '../src/archive-console.js'
import { renderReleaseConsole, renderReleaseRows } from '../src/release-console-ui.js'

function row(overrides = {}) {
  return {
    id: 'pub-1',
    kind: 'release',
    file: 'Fubar.S02E07.2160p.mkv',
    work: 'FUBAR',
    coordinates: 'S02E07',
    catalogued: true,
    sizeBytes: 1024,
    bytesAcquired: 1024,
    progressPercent: 100,
    state: 'seeding',
    backups: 2,
    reach: null,
    reachDetail: null,
    residency: 'local',
    residencyDetail: 'This relay accepted 1024 bytes for this release.',
    retentionClass: 'archive-pin',
    updatedAt: 1000,
    candidateRef: null,
    publicationId: 'pub-1',
    renditionId: 'rend-1',
    acquisitionId: 'acq-1',
    errorCode: null,
    recoverable: false,
    ...overrides
  }
}

test('the default order puts work needing attention above finished releases', function (t) {
  const page = queryReleases([
    row({ id: 'done', state: 'seeding', updatedAt: 9000 }),
    row({ id: 'broken', state: 'failed', updatedAt: 1 }),
    row({ id: 'moving', state: 'acquiring', updatedAt: 2 }),
    row({ id: 'cancelled', state: 'cancelled', updatedAt: 8000 })
  ])
  t.alike(page.rows.map(entry => entry.id), ['moving', 'broken', 'done', 'cancelled'])
  t.is(page.total, 4)
  t.is(page.matched, 4)
})

test('search, state and retention narrow the table without changing the total', function (t) {
  const rows = [
    row({ id: 'a', file: 'Fubar.S02E07.2160p.mkv', state: 'seeding' }),
    row({ id: 'b', file: 'Lanterns.S01E01.mkv', work: 'Lanterns', state: 'failed', retentionClass: 'contribution-cache' })
  ]
  t.alike(queryReleases(rows, { query: 'lanterns' }).rows.map(entry => entry.id), ['b'])
  t.alike(queryReleases(rows, { states: ['failed'] }).rows.map(entry => entry.id), ['b'])
  t.alike(queryReleases(rows, { retention: 'archive-pin' }).rows.map(entry => entry.id), ['a'])
  t.is(queryReleases(rows, { query: 'lanterns' }).total, 2, 'total stays the size of the shelf, not of the filter')
  t.is(queryReleases(rows, { query: 'nothing-matches' }).matched, 0)
})

test('an explicit sort orders by that column and paging is bounded', function (t) {
  const rows = [row({ id: 'small', sizeBytes: 10 }), row({ id: 'large', sizeBytes: 900 })]
  t.alike(queryReleases(rows, { sort: 'size', direction: 'desc' }).rows.map(entry => entry.id), ['large', 'small'])
  t.alike(queryReleases(rows, { sort: 'size', direction: 'asc' }).rows.map(entry => entry.id), ['small', 'large'])
  const paged = queryReleases(rows, { sort: 'size', direction: 'asc', limit: 1, offset: 1 })
  t.alike(paged.rows.map(entry => entry.id), ['large'])
  t.is(paged.limit, 1)
})

test('grouping by work is a second key, not a replacement for the sort', function (t) {
  const page = queryReleases([
    row({ id: 'z-big', work: 'Zulu', sizeBytes: 900 }),
    row({ id: 'a-small', work: 'Alpha', sizeBytes: 10 }),
    row({ id: 'a-big', work: 'Alpha', sizeBytes: 500 })
  ], { group: 'work', sort: 'size', direction: 'desc' })
  t.alike(page.rows.map(entry => entry.id), ['a-big', 'a-small', 'z-big'])
  const html = renderReleaseRows(page)
  t.ok(html.includes('<tr class="group-head"><td colspan="10">Alpha</td></tr>'))
  t.ok(html.includes('<tr class="group-head"><td colspan="10">Zulu</td></tr>'))
})

test('progress is this relay\'s own accepted bytes, and never a rate', function (t) {
  const html = renderReleaseRows({
    rows: [row({ id: 'moving', state: 'acquiring', residency: 'transferring', sizeBytes: 1000, bytesAcquired: 250, progressPercent: 25 })],
    total: 1
  })
  t.ok(html.includes('25.0%'))
  t.ok(html.includes('title="0 KB accepted of 1 KB claimed"'), 'the byte split is a tooltip, not a column')
  t.absent(/MB\/s|ETA/.test(html), 'no rate and no ETA are invented')
})

test('a catalogued release this relay never fetched reports presence, not residency', function (t) {
  const html = renderReleaseRows({
    rows: [row({
      id: 'catalogued-only',
      residency: 'unproven',
      residencyDetail: 'Catalogued here, but this relay holds no acquisition record proving the bytes.',
      bytesAcquired: 0,
      progressPercent: 0,
      sizeBytes: 5 * 1024 ** 3,
      backups: 3,
      reach: '2/4',
      reachDetail: '2 complete seeder(s) of 4 peer(s).'
    })],
    total: 1
  })
  t.ok(html.includes('5.0 GB'), 'the signed manifest length is still shown as presence')
  t.ok(html.includes('Catalog presence, not local bytes.'), 'and it says which fact that is')
  t.absent(html.includes('100%'), 'catalog presence never renders as complete local progress')
  t.ok(html.includes('res-unproven') && html.includes('Unproven'), 'residency stands alone and says it is unproven')
  t.ok(html.includes('>2/4<'), 'reachability is its own column, from the availability observation')
  t.absent(html.includes('class="backups risk"'), 'durability is not flagged for bytes this relay does not hold')
})

test('an unbacked seeding release is marked, an unnamed work renders as absent', function (t) {
  const html = renderReleaseRows({ rows: [row({ backups: 0, work: null })], total: 1 })
  t.ok(html.includes('class="backups risk"'))
  t.ok(html.includes('No publisher metadata named this work'))
})

test('a row links playback by stable publication ids first, candidate ref as fallback', function (t) {
  const verified = 'V'.repeat(43)
  const html = renderReleaseRows({
    rows: [
      row({ id: 'playable', playable: true }),
      row({ id: 'ref-only', publicationId: null, renditionId: null, candidateRef: verified, playable: true }),
      row({ id: 'metadata-only', publicationId: null, renditionId: null, candidateRef: null, playable: true }),
      row({ id: 'lan-client', publicationId: 'pub-1', renditionId: 'rend-1', playable: false })
    ],
    total: 4
  })
  t.ok(html.includes('/play/pub/pub-1/rend-1'), 'a catalogued row links by stable ids')
  t.ok(html.includes(`/play/${verified}`), 'a row without ids falls back to its candidate reference')
  t.is(html.split('/play/').length - 1, 2, 'a LAN client row stays unlinked alongside the unlinked row')
})

test('a hostile file name cannot close the bootstrap script or reach the DOM as markup', function (t) {
  const hostile = '</script><img src=x onerror=alert(1)>.mkv'
  const html = renderReleaseConsole({
    status: { network: { peers: 0 } },
    releases: [row({ file: hostile })],
    page: { rows: [row({ file: hostile })], total: 1, matched: 1, sort: 'attention', direction: 'desc' }
  })
  t.absent(html.includes('</script><img'), 'the bootstrap JSON escapes every < so no name can close the script tag')
  t.ok(html.includes('\\u003c/script>'), 'the name survives as escaped data')
  t.ok(html.includes('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;.mkv'), 'the table cell renders the name as text')
})

test('held counts only bytes this relay proved it accepted', function (t) {
  const html = renderReleaseConsole({
    status: { network: { peers: 1 } },
    releases: [
      row({ id: 'held', state: 'seeding', residency: 'local', sizeBytes: 4 * 1024 ** 3, bytesAcquired: 4 * 1024 ** 3, backups: 0 }),
      row({ id: 'moving', state: 'acquiring', residency: 'transferring', sizeBytes: 90 * 1024 ** 3, bytesAcquired: 1024 ** 3 }),
      row({ id: 'lost', state: 'failed', residency: 'none', sizeBytes: 500 * 1024 ** 3, bytesAcquired: 0 }),
      row({ id: 'catalogued-only', state: 'seeding', residency: 'unproven', sizeBytes: 800 * 1024 ** 3, bytesAcquired: 0, backups: 0 })
    ],
    page: { rows: [], total: 4, matched: 0, sort: 'attention', direction: 'desc' }
  })
  t.ok(html.includes('<b>5.0 GB</b><span>Held</span>'), 'a failed attempt and a catalogue entry never count as bytes held')
  t.ok(html.includes('<b>1</b><span>Failed</span>'))
  t.ok(html.includes('<b>1</b><span>Unbacked</span>'), 'only a release with proven local bytes can be unbacked')
  t.ok(html.includes('<b>4</b><span>Catalogued</span>'), 'catalog presence is counted as its own fact')
  t.ok(html.includes('<b>1</b><span>Unproven</span>'), 'a catalogued release with no local proof is counted as unproven')
})

test('a dead attempt keeps its partial bytes out of the held total', function (t) {
  const html = renderReleaseConsole({
    status: { network: { peers: 0 } },
    releases: [row({ id: 'dead', state: 'failed', residency: 'partial', sizeBytes: 40 * 1024 ** 3, bytesAcquired: 12 * 1024 ** 3 })],
    page: { rows: [], total: 1, matched: 0, sort: 'attention', direction: 'desc' }
  })
  t.ok(html.includes('<b>0 KB</b><span>Held</span>'), 'the relay does not report how much of a dead attempt it kept, so it claims none')
})

test('the projection keeps catalog presence, reachability and local residency apart', async function (t) {
  const service = consoleService([], {
    async getVerifiedMediaCatalog() {
      return {
        success: true,
        nextCursor: null,
        items: [{
          entityId: '1'.repeat(64),
          entityKind: 'movie',
          title: 'Catalogued Elsewhere',
          sources: [{
            publicationId: 'pub-remote',
            renditionId: 'rend-remote',
            availability: { state: 'healthy', completePeerCount: 2, independentPeerCount: 4, observedAt: 1787000000000, expiresAt: 1787003600000, reasonCodes: [] },
            mediaCoordinates: { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '603' }
          }]
        }]
      }
    },
    async getVerifiedManifest() {
      return { body: { renditions: [{ renditionId: 'rend-remote', core: { byteLength: 7 * 1024 ** 3 } }] } }
    }
  })
  await withConsole(service, async (base) => {
    const body = await (await fetch(`${base}/releases.json`)).json()
    t.is(body.rows.length, 1)
    const release = body.rows[0]
    t.is(release.catalogued, true, 'the signed catalog entry proves presence')
    t.is(release.sizeBytes, 7 * 1024 ** 3, 'presence carries the manifest length')
    t.is(release.reach, '2/4', 'the availability assessment is reachability, kept separate')
    t.ok(release.reachDetail.includes('state healthy') && release.reachDetail.includes('complete peer'),
      'reach carries the evidence it came from, not a bare number')
    t.is(release.residency, 'unproven', 'no acquisition record on this relay means residency is unproven')
    t.is(release.bytesAcquired, 0, 'a manifest length is never counted as bytes this relay accepted')
  })
})

test('a local range probe, not catalog availability, is what proves residency', async function (t) {
  const probed = []
  const catalogue = (availability) => ({
    async getVerifiedMediaCatalog() {
      return {
        success: true,
        nextCursor: null,
        items: [{
          entityId: '2'.repeat(64),
          entityKind: 'movie',
          title: 'Held Here',
          sources: [{ publicationId: 'pub-local', renditionId: 'rend-local', availability, mediaCoordinates: { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '604' } }]
        }]
      }
    },
    async getVerifiedManifest() {
      return { body: { renditions: [{ renditionId: 'rend-local', core: { byteLength: 2 * 1024 ** 3 } }] } }
    }
  })

  // Catalog evidence says a peer could serve every byte, and the relay itself
  // holds none of it. Only the probe may decide.
  const peerEvidence = { state: 'healthy', completePeerCount: 3, independentPeerCount: 3, offlinePlayable: true, observedAt: 1787000000000 }
  const absent = consoleService([], {
    ...catalogue(peerEvidence),
    async getLocalResidency(request) {
      probed.push(request.publicationId)
      return { success: true, requiredRangeCount: 1, localRangeCount: 0, complete: false }
    }
  })
  await withConsole(absent, async (base) => {
    const release = (await (await fetch(`${base}/releases.json`)).json()).rows[0]
    t.is(release.residency, 'unproven', 'peer availability never promotes a row to local')
    t.ok(release.residencyDetail.includes('0 of 1 required range'), 'the row reports what the probe actually found')
  })
  t.alike(probed, ['pub-local'], 'the probe ran for the catalogued row with no acquisition record')

  const present = consoleService([], {
    ...catalogue(null),
    async getLocalResidency() {
      return { success: true, requiredRangeCount: 1, localRangeCount: 1, complete: true }
    }
  })
  await withConsole(present, async (base) => {
    const release = (await (await fetch(`${base}/releases.json`)).json()).rows[0]
    t.is(release.residency, 'local', 'a complete local range probe is proof')
    t.ok(release.residencyDetail.includes('all 1 required range'), 'and the row says which proof it used')
  })
})

test('a local miss on an offload-backed relay is reported as unmeasured, not as loss', async function (t) {
  const service = consoleService([], {
    getStatus() { return { network: { peers: 0 }, blockOffload: { enabled: true } } },
    async getVerifiedMediaCatalog() {
      return {
        success: true,
        nextCursor: null,
        items: [{
          entityId: '3'.repeat(64),
          entityKind: 'movie',
          title: 'Offloaded',
          sources: [{ publicationId: 'pub-offloaded', renditionId: 'rend-offloaded', mediaCoordinates: { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '605' } }]
        }]
      }
    },
    async getVerifiedManifest() {
      return { body: { renditions: [{ renditionId: 'rend-offloaded', core: { byteLength: 1024 } }] } }
    },
    async getLocalResidency() {
      return { success: true, requiredRangeCount: 1, localRangeCount: 0, complete: false }
    }
  })
  await withConsole(service, async (base) => {
    const release = (await (await fetch(`${base}/releases.json`)).json()).rows[0]
    t.is(release.residency, 'unproven')
    t.ok(release.residencyDetail.includes('on this volume'), 'the probe result is scoped to the volume it read')
    t.ok(release.residencyDetail.includes('offload residency is not measured yet'),
      'and the row refuses to read a local miss as a lost release')
  })
})

test('residency is proven before the query, so sorting and the header see the same values', async function (t) {
  const held = new Set(['pub-2'])
  const service = consoleService([], {
    async getVerifiedMediaCatalog() {
      return {
        success: true,
        nextCursor: null,
        items: ['pub-1', 'pub-2', 'pub-3'].map((publicationId, index) => ({
          entityId: String(index + 1).repeat(64),
          entityKind: 'movie',
          title: `Work ${index + 1}`,
          sources: [{ publicationId, renditionId: `rend-${index + 1}`, mediaCoordinates: { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: String(600 + index) } }]
        }))
      }
    },
    async getVerifiedManifest(publicationId) {
      const index = Number(publicationId.split('-')[1])
      return { body: { renditions: [{ renditionId: `rend-${index}`, core: { byteLength: index * 1024 } }] } }
    },
    async getLocalResidency({ publicationId }) {
      const complete = held.has(publicationId)
      return { success: true, requiredRangeCount: 1, localRangeCount: complete ? 1 : 0, complete }
    }
  })
  await withConsole(service, async (base) => {
    // Only the second release is held here, and it is neither first nor last in
    // the projection: a residency sort can only put it on top if every row was
    // probed before the sort ran.
    const sorted = await (await fetch(`${base}/releases.json?sort=residency&dir=desc`)).json()
    t.is(sorted.rows[0].publicationId, 'pub-2', 'the proven row sorts first')
    t.alike(sorted.rows.map(row => row.residency), ['local', 'unproven', 'unproven'])

    // A page of one still reports the whole shelf's proof state to the header.
    const paged = await (await fetch(`${base}/releases.json?sort=residency&dir=desc&limit=1`)).json()
    t.is(paged.rows.length, 1)
    t.is(paged.rows[0].residency, 'local')
    t.is(paged.total, 3)

    const home = await (await fetch(`${base}/`)).text()
    t.ok(home.includes('<b>2</b><span>Unproven</span>'), 'the header counts every unproven row, not just the page')
    t.ok(home.includes('<b>2 KB</b><span>Held</span>'), 'and held counts the proven row wherever it lands in the table')
  })
})

test('two renditions of one publication are two rows with their own probes', async function (t) {
  const probed = []
  const service = consoleService([], {
    async getVerifiedMediaCatalog() {
      return {
        success: true,
        nextCursor: null,
        items: [{
          entityId: '4'.repeat(64),
          entityKind: 'movie',
          title: 'Two Cuts',
          sources: [
            { publicationId: 'pub-two', renditionId: 'rend-2160p', mediaCoordinates: { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '606' } },
            { publicationId: 'pub-two', renditionId: 'rend-1080p', mediaCoordinates: { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '606' } }
          ]
        }]
      }
    },
    async getVerifiedManifest() {
      return {
        body: {
          renditions: [
            { renditionId: 'rend-2160p', core: { byteLength: 8 * 1024 } },
            { renditionId: 'rend-1080p', core: { byteLength: 4 * 1024 } }
          ]
        }
      }
    },
    // Only the smaller cut is held here. A cache keyed by publication alone
    // would answer the second row with the first row's result.
    async getLocalResidency({ publicationId, renditionId }) {
      probed.push(`${publicationId}:${renditionId}`)
      const complete = renditionId === 'rend-1080p'
      return { success: true, requiredRangeCount: 1, localRangeCount: complete ? 1 : 0, complete }
    }
  })
  await withConsole(service, async (base) => {
    const rows = (await (await fetch(`${base}/releases.json`)).json()).rows
    t.is(rows.length, 2, 'each rendition is its own release row')
    t.is(new Set(rows.map(row => row.id)).size, 2, 'and the rows carry distinct ids')
    const byRendition = new Map(rows.map(row => [row.renditionId, row]))
    t.is(byRendition.get('rend-1080p').residency, 'local')
    t.is(byRendition.get('rend-2160p').residency, 'unproven', 'the held cut never proves the one that is missing')
  })
  t.alike(probed.sort(), ['pub-two:rend-1080p', 'pub-two:rend-2160p'], 'both renditions were probed on their own key')
})

function consoleService(jobs, overrides = {}) {
  const cancelled = []
  return {
    cancelled,
    getStatus() { return { network: { peers: 3 }, budgets: { archive: { configuredBytes: 1024 ** 3 } } } },
    getTrustedClients() { return [] },
    getLinkDescriptor() { return null },
    settings: { get(key, fallback = null) { return fallback } },
    config: { classification: { tmdb: { baseUrl: 'https://api', language: 'en-US' } } },
    runtime: { ctx: { metaDb: { async get() { return null }, async put() {} } } },
    async getVerifiedMediaCatalog() { return { success: true, items: [], nextCursor: null } },
    async getVerifiedEntityArtwork() { return null },
    getArchiveMirrorRequests() { return [] },
    creators: { getCreators() { return [] } },
    getCreatorTargets() { return [] },
    async requestLocalFileAcquisition() { throw new Error('not used') },
    async listAcquisitions() { return jobs },
    async cancelAcquisition(acquisitionId) { cancelled.push(acquisitionId); return { acquisitionId, state: 'cancelled' } },
    ...overrides
  }
}

async function withConsole(service, fn, options = {}) {
  const surface = await createArchiveConsole({
    service,
    downloader: { async download() { throw new Error('not used') } },
    publisher: {},
    ...options,
    host: options.host || '127.0.0.1',
    port: options.port ?? 0
  })
  await surface.start()
  const { port } = surface.server.address()
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await surface.close()
  }
}

test('the console home is the release table and the fragment matches the JSON', async function (t) {
  const jobs = [
    { acquisitionId: 'acq-live', state: 'acquiring', title: 'Lanterns', sourceFileName: 'Lanterns.S01E01.mkv', bytesAcquired: 500, expectedBytes: 1000, progressPercent: 50, retentionClass: 'archive-pin', updatedAt: 20, errorCode: null, recoverable: false },
    { acquisitionId: 'acq-dead', state: 'failed', title: 'Spider-Man', sourceFileName: 'Spidey.mkv', bytesAcquired: 0, expectedBytes: 0, retentionClass: 'contribution-cache', updatedAt: 10, errorCode: 'SOURCE_TIMEOUT', recoverable: true }
  ]
  await withConsole(consoleService(jobs), async (base) => {
    const home = await (await fetch(`${base}/`)).text()
    t.ok(home.includes('Lanterns.S01E01.mkv'), 'the row is the file, not the title')
    t.ok(home.includes('Spidey.mkv'))
    t.ok(home.includes('id="releases"'))

    const json = await (await fetch(`${base}/releases.json`)).json()
    t.is(json.schema, 'peartube.relayReleases')
    t.is(json.total, 2)
    t.alike(json.rows.map(entry => entry.state), ['acquiring', 'failed'])

    const fragment = await (await fetch(`${base}/releases.html`)).text()
    t.ok(fragment.startsWith('<tr'), 'the poll fetches rows, not a whole page')
    t.absent(fragment.includes('<html'))

    const filtered = await (await fetch(`${base}/releases.json?state=failed`)).json()
    t.is(filtered.matched, 1)
    t.is(filtered.rows[0].file, 'Spidey.mkv')
  })
})

test('cancel reports what the relay did, and refuses a job that already finished', async function (t) {
  const service = consoleService([
    { acquisitionId: 'acq-1', state: 'acquiring', title: 'One', bytesAcquired: 1, expectedBytes: 2, updatedAt: 1 },
    { acquisitionId: 'acq-dead', state: 'failed', title: 'Dead', bytesAcquired: 0, expectedBytes: 2, updatedAt: 2 }
  ], {
    // The manager returns the job untouched when it is already terminal, which
    // is exactly the silence the console has to translate.
    async cancelAcquisition(acquisitionId) {
      service.cancelled.push(acquisitionId)
      return acquisitionId === 'acq-dead'
        ? { acquisitionId, state: 'failed' }
        : { acquisitionId, state: 'cancelled' }
    }
  })
  await withConsole(service, async (base) => {
    const res = await fetch(`${base}/releases/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'ids=acq-1,acq-dead'
    })
    t.is(res.status, 200)
    const body = await res.json()
    t.is(body.verb, 'cancel')
    t.alike(body.done, ['acq-1'])
    t.alike(body.refused, [{ acquisitionId: 'acq-dead', done: false, state: 'failed', reason: 'already failed' }])
  })
  t.alike(service.cancelled, ['acq-1', 'acq-dead'])
})

test('clear forgets a finished record and says when there was nothing to forget', async function (t) {
  const forgotten = []
  const service = consoleService([
    { acquisitionId: 'acq-dead', state: 'failed', title: 'Dead', bytesAcquired: 0, expectedBytes: 2, updatedAt: 2 }
  ], {
    async forgetAcquisition(acquisitionId) {
      forgotten.push(acquisitionId)
      return acquisitionId === 'acq-dead'
        ? { acquisitionId, forgotten: true, state: 'failed' }
        : { acquisitionId, forgotten: false, state: null }
    }
  })
  await withConsole(service, async (base) => {
    const res = await fetch(`${base}/releases/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'ids=acq-dead,acq-ghost'
    })
    const body = await res.json()
    t.is(body.verb, 'clear')
    t.alike(body.done, ['acq-dead'])
    t.alike(body.refused, [{ acquisitionId: 'acq-ghost', done: false, reason: 'nothing to clear' }])
  })
  t.alike(forgotten, ['acq-dead', 'acq-ghost'])
})

test('retry restarts a failed acquisition and refuses non-failed or unretryable jobs', async function (t) {
  const retried = []
  const service = consoleService([
    { acquisitionId: 'acq-failed', state: 'failed', title: 'Dead', bytesAcquired: 0, expectedBytes: 2, updatedAt: 2 },
    { acquisitionId: 'acq-exhausted', state: 'failed', title: 'Exhausted', bytesAcquired: 0, expectedBytes: 2, updatedAt: 3 }
  ], {
    async retryAcquisition(acquisitionId) {
      retried.push(acquisitionId)
      if (acquisitionId === 'acq-failed') {
        return { acquisitionId, state: 'queued' }
      }
      if (acquisitionId === 'acq-exhausted') {
        return { acquisitionId, state: 'failed', errorCode: 'ACQUISITION_RETRY_LIMIT_EXCEEDED' }
      }
      return null
    }
  })
  await withConsole(service, async (base) => {
    const res = await fetch(`${base}/releases/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'ids=acq-failed,acq-exhausted,acq-ghost'
    })
    t.is(res.status, 200)
    const body = await res.json()
    t.is(body.verb, 'retry')
    t.alike(body.done, ['acq-failed'])
    t.alike(body.refused, [
      { acquisitionId: 'acq-exhausted', done: false, state: 'failed', reason: 'ACQUISITION_RETRY_LIMIT_EXCEEDED (retry limit reached)' },
      { acquisitionId: 'acq-ghost', done: false, reason: 'the relay reported no job to retry' }
    ])
    const html = await (await fetch(`${base}/`)).text()
    t.ok(html.includes('id="bulk-retry"'))
    t.ok(html.includes('Retry failed'))
  })
  t.alike(retried, ['acq-failed', 'acq-exhausted', 'acq-ghost'])
})

test('a verb never reports success the relay did not give it', async function (t) {
  // A relay whose publisher shell is not up answers null, and a relay too old
  // to clear records has no method at all. Neither may read as done, and
  // neither may take the route down.
  const service = consoleService([
    { acquisitionId: 'acq-1', state: 'acquiring', title: 'One', bytesAcquired: 1, expectedBytes: 2, updatedAt: 1 }
  ], { async cancelAcquisition() { return null } })
  delete service.forgetAcquisition

  await withConsole(service, async (base) => {
    const cancelRes = await fetch(`${base}/releases/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'ids=acq-1'
    })
    t.is(cancelRes.status, 200)
    const cancelBody = await cancelRes.json()
    t.alike(cancelBody.done, [], 'a null answer is not a cancelled job')
    t.alike(cancelBody.refused, [{ acquisitionId: 'acq-1', done: false, reason: 'the relay reported no job to cancel' }])

    const clearRes = await fetch(`${base}/releases/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'ids=acq-1'
    })
    t.is(clearRes.status, 200, 'a relay without the capability still answers')
    const clearBody = await clearRes.json()
    t.alike(clearBody.done, [])
    t.alike(clearBody.refused, [{ acquisitionId: 'acq-1', done: false, reason: 'this relay cannot clear finished records' }])
  })
})

test('cancel refuses a job the relay left running', async function (t) {
  const service = consoleService([
    { acquisitionId: 'acq-1', state: 'acquiring', title: 'One', bytesAcquired: 1, expectedBytes: 2, updatedAt: 1 }
  ], { async cancelAcquisition(acquisitionId) { return { acquisitionId, state: 'acquiring' } } })
  await withConsole(service, async (base) => {
    const body = await (await fetch(`${base}/releases/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'ids=acq-1'
    })).json()
    t.alike(body.done, [], 'a job still acquiring was not cancelled')
    t.alike(body.refused, [{ acquisitionId: 'acq-1', done: false, state: 'acquiring', reason: 'still acquiring' }])
  })
})

test('a show release carries its season and episode, a film carries its year', async function (t) {
  const service = consoleService([], {
    async getVerifiedMediaCatalog() {
      return {
        success: true,
        nextCursor: null,
        items: [{
          entityId: '5'.repeat(64),
          entityKind: 'series',
          title: 'Severance',
          sources: [{
            publicationId: 'pub-ep',
            renditionId: 'rend-ep',
            mediaCoordinates: { contentKind: 'episode', mediaProvider: 'tmdb', mediaId: '95396', seasonNumber: 1, episodeNumber: 2 }
          }]
        }, {
          entityId: '6'.repeat(64),
          entityKind: 'movie',
          title: 'The Matrix',
          sources: [{
            publicationId: 'pub-film',
            renditionId: 'rend-film',
            mediaCoordinates: { contentKind: 'movie', mediaProvider: 'tmdb', mediaId: '603', releaseYear: 1999 }
          }]
        }]
      }
    },
    async getVerifiedManifest(publicationId) {
      const renditionId = publicationId === 'pub-ep' ? 'rend-ep' : 'rend-film'
      return { body: { renditions: [{ renditionId, core: { byteLength: 1024 } }] } }
    }
  })
  await withConsole(service, async (base) => {
    const rows = (await (await fetch(`${base}/releases.json`)).json()).rows
    const episode = rows.find(row => row.publicationId === 'pub-ep')
    const film = rows.find(row => row.publicationId === 'pub-film')
    t.is(episode.workLabel, 'S01E02', 'a show release is named by its season and episode')
    t.is(episode.coordinates, 'S01E02 · tmdb:95396', 'and search still matches the authority that named it')
    t.is(film.workLabel, '1999', 'a film is named by its year')

    const home = await (await fetch(`${base}/`)).text()
    t.ok(home.includes('Severance<span class="coords">S01E02</span>'), 'the Work column shows the show and the episode together')
    t.ok(home.includes('The Matrix<span class="coords">1999</span>'))
  })
})

test('a LAN client of an externally bound console renders no playback path at all', async function (t) {
  const jobs = [{ acquisitionId: 'acq-1', state: 'acquiring', title: 'One', sourceFileName: 'one.mkv', bytesAcquired: 1, expectedBytes: 2, updatedAt: 1 }]
  // The console is bound wide, but this client arrives from off-machine, so
  // the loopback-only playback capability must be absent from every byte.
  await withConsole(consoleService(jobs), async (base) => {
    const home = await (await fetch(`${base}/`)).text()
    // The rendered page must carry no play anchors in markup. The player
    // script ships a guarded verb template, but it only fires for rows the
    // per-request gate marked playable - none exist here.
    const markup = home.slice(0, home.indexOf('<script>'))
    t.absent(markup.includes('js-play'), 'an off-machine console renders no play anchors')
    t.absent(markup.includes('/play/pub/'), 'and no stable-id hrefs either')
  }, { host: '0.0.0.0', allowsPlaybackRequest: () => false })
})
