import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import b4a from 'b4a'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { MAX_ART_BYTES } from '../src/meta-wire.js'
import { openPeerApi } from '../src/peer-api.js'

let metaMirror = null
try {
  metaMirror = await import('../src/meta-mirror.js')
} catch (err) {
  void err
}

function makeTmpDir (t) {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-meta-mirror-test-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

async function until (fn, ms = 45_000, label = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

function makeWebpVp8x (width, height, tag = 0) {
  const buf = b4a.alloc(32)
  buf.write('RIFF', 0, 'latin1')
  buf.writeUInt32LE(24, 4)
  buf.write('WEBPVP8X', 8, 'latin1')
  buf.writeUInt32LE(10, 16)
  const w1 = width - 1
  const h1 = height - 1
  buf[24] = w1 & 0xff
  buf[25] = (w1 >> 8) & 0xff
  buf[26] = (w1 >> 16) & 0xff
  buf[27] = h1 & 0xff
  buf[28] = (h1 >> 8) & 0xff
  buf[29] = (h1 >> 16) & 0xff
  buf[30] = tag & 0xff
  buf[31] = (tag >> 8) & 0xff
  return buf
}

function makeWebpVp8l (width, height) {
  const buf = b4a.alloc(28)
  buf.write('RIFF', 0, 'latin1')
  buf.writeUInt32LE(20, 4)
  buf.write('WEBPVP8L', 8, 'latin1')
  buf.writeUInt32LE(8, 16)
  buf[20] = 0x2f
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  buf.writeUInt32LE(bits >>> 0, 21)
  return buf
}

function makeWebpVp8 (width, height) {
  const buf = b4a.alloc(32)
  buf.write('RIFF', 0, 'latin1')
  buf.writeUInt32LE(24, 4)
  buf.write('WEBPVP8 ', 8, 'latin1')
  buf.writeUInt32LE(12, 16)
  buf[20] = 0x10 // keyframe (bit 0 = 0)
  buf[23] = 0x9d
  buf[24] = 0x01
  buf[25] = 0x2a
  buf.writeUInt16LE(width & 0x3fff, 26)
  buf.writeUInt16LE(height & 0x3fff, 28)
  return buf
}

function makePng (width, height, salt = 0) {
  const buf = b4a.alloc(33)
  b4a.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'latin1')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  buf[24] = 8
  buf[25] = 2
  buf[32] = salt & 0xff
  return buf
}

function makeJpeg (width, height, salt = 0) {
  const buf = b4a.alloc(24)
  buf[0] = 0xff
  buf[1] = 0xd8 // SOI
  buf[2] = 0xff
  buf[3] = 0xe0 // APP0
  buf.writeUInt16BE(4, 4)
  buf[6] = salt & 0xff
  buf[7] = 0x00
  buf[8] = 0xff
  buf[9] = 0xc0 // SOF0
  buf.writeUInt16BE(11, 10)
  buf[12] = 8
  buf.writeUInt16BE(height, 13)
  buf.writeUInt16BE(width, 15)
  buf[17] = 3
  buf[21] = 0xff
  buf[22] = 0xd9 // EOI
  return buf
}

async function startMockOrigin (t, routes) {
  const hits = []
  const server = createServer((req, res) => {
    hits.push(req.url)
    const entry = routes[req.url]
    if (!entry) {
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end('<html><body>Not Found</body></html>')
      return
    }
    res.writeHead(entry.status || 200, { 'content-type': entry.contentType || 'application/json' })
    res.end(entry.body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}`, hits }
}

test('sniffArtHeader extracts MIME + dimensions for WebP/PNG/JPEG and rejects invalid/oversized data', () => {
  assert.ok(metaMirror, 'src/meta-mirror.js must exist')
  const { sniffArtHeader } = metaMirror

  assert.deepEqual(sniffArtHeader(makeWebpVp8x(600, 900)), { mime: 'image/webp', width: 600, height: 900 })
  assert.deepEqual(sniffArtHeader(makeWebpVp8l(512, 512)), { mime: 'image/webp', width: 512, height: 512 })
  assert.deepEqual(sniffArtHeader(makeWebpVp8(1280, 720)), { mime: 'image/webp', width: 1280, height: 720 })
  assert.deepEqual(sniffArtHeader(makePng(800, 1200)), { mime: 'image/png', width: 800, height: 1200 })
  assert.deepEqual(sniffArtHeader(makeJpeg(1920, 1080)), { mime: 'image/jpeg', width: 1920, height: 1080 })

  assert.equal(sniffArtHeader(b4a.from('<!doctype html><html><body>502 Bad Gateway</body></html>')), null)
  assert.equal(sniffArtHeader(b4a.from('RIFF\x04\x00\x00\x00WEBP')), null)
  assert.equal(sniffArtHeader(b4a.alloc(4)), null)
  assert.equal(sniffArtHeader(null), null)

  const oversized = b4a.alloc(MAX_ART_BYTES + 1)
  makePng(100, 100).copy(oversized, 0)
  assert.equal(sniffArtHeader(oversized), null)
})

test('encodeThumbHash produces deterministic compact <=25-byte ThumbHashes', () => {
  assert.ok(metaMirror, 'src/meta-mirror.js must exist')
  const { encodeThumbHash } = metaMirror

  const opaque = b4a.alloc(4 * 4 * 4)
  for (let i = 0; i < 16; i++) {
    opaque[i * 4] = (i * 15) & 0xff
    opaque[i * 4 + 1] = 120
    opaque[i * 4 + 2] = 220
    opaque[i * 4 + 3] = 255
  }
  const h1 = encodeThumbHash(4, 4, opaque)
  const h2 = encodeThumbHash(4, 4, opaque)
  assert.ok(b4a.isBuffer(h1))
  assert.ok(h1.byteLength >= 5 && h1.byteLength <= 25, `expected 5..25 bytes, got ${h1.byteLength}`)
  assert.equal(b4a.equals(h1, h2), true, 'ThumbHash encoding must be deterministic')
  assert.equal((h1[2] & 0x80) !== 0, false, 'opaque image must clear hasAlpha flag')

  const alpha = b4a.from(opaque)
  alpha[3] = 128
  const hAlpha = encodeThumbHash(4, 4, alpha)
  assert.ok(hAlpha.byteLength >= 6 && hAlpha.byteLength <= 25)
  assert.equal((hAlpha[2] & 0x80) !== 0, true, 'semi-transparent image must set hasAlpha flag')

  assert.throws(() => encodeThumbHash(0, 4, opaque), /dimensions/)
  assert.throws(() => encodeThumbHash(4, 4, b4a.alloc(10)), /too short/)
})

test('end-to-end mirrorCinemetaTitle + mirrorMusicRelease + rebuildSnapshot + P2P sparse follower', { timeout: 90_000 }, async t => {
  assert.ok(metaMirror, 'src/meta-mirror.js must exist')
  const { createMetaMirror } = metaMirror

  const matrixPoster = makeWebpVp8x(600, 900, 1)
  const matrixBackdrop = makeJpeg(1280, 720, 2)
  const seriesPoster = makePng(500, 750, 3)
  const albumCover = makeJpeg(500, 500, 4)
  const albumUuid = '11111111-2222-3333-4444-555555555555'

  const routes = {}
  const origin = await startMockOrigin(t, routes)
  Object.assign(routes, {
    '/art/matrix-poster.webp': { contentType: 'image/webp', body: matrixPoster },
    '/art/matrix-backdrop.jpg': { contentType: 'image/jpeg', body: matrixBackdrop },
    '/art/bb-poster.png': { contentType: 'image/png', body: seriesPoster },
    [`/release/${albumUuid}/front-500`]: { contentType: 'image/jpeg', body: albumCover },
    '/meta/movie/tt0133093.json': {
      body: JSON.stringify({
        meta: {
          id: 'tt0133093',
          type: 'movie',
          name: 'The Matrix',
          year: '1999',
          imdbRating: '8.7',
          runtime: '136 min',
          genres: ['Action', 'Sci-Fi'],
          director: ['Lana Wachowski', 'Lilly Wachowski'],
          cast: ['Keanu Reeves', 'Laurence Fishburne'],
          description: 'A hacker discovers reality is a simulation.',
          poster: `${origin.baseUrl}/art/matrix-poster.webp`,
          background: `${origin.baseUrl}/art/matrix-backdrop.jpg`,
          moviedb_id: 603
        }
      })
    },
    '/meta/movie/tt0234215.json': {
      body: JSON.stringify({
        meta: {
          id: 'tt0234215',
          type: 'movie',
          name: 'The Matrix Reloaded',
          year: '2003',
          imdbRating: '7.2',
          runtime: '138 min',
          genres: ['Action', 'Sci-Fi'],
          poster: `${origin.baseUrl}/art/matrix-poster.webp`,
          description: 'Neo fights to save Zion.'
        }
      })
    },
    '/meta/series/tt0903747.json': {
      body: JSON.stringify({
        meta: {
          id: 'tt0903747',
          type: 'series',
          name: 'Breaking Bad',
          releaseInfo: '2008-2013',
          imdbRating: '9.5',
          runtime: '47 min',
          genres: ['Crime', 'Drama'],
          cast: ['Bryan Cranston', 'Aaron Paul'],
          description: 'A chemistry teacher turns to cooking meth.',
          poster: `${origin.baseUrl}/art/bb-poster.png`,
          videos: [
            { id: 'tt0903747:1:1', title: 'Pilot', season: 1, episode: 1, runtime: '58 min' },
            { id: 'tt0903747:1:2', title: "Cat's in the Bag...", season: 1, episode: 2, runtime: '48 min' }
          ]
        }
      })
    },
    [`/ws/2/release/${albumUuid}?inc=artists+recordings+release-groups&fmt=json`]: {
      body: JSON.stringify({
        id: albumUuid,
        title: 'Discovery',
        date: '2001-03-12',
        'artist-credit': [{ name: 'Daft Punk', joinphrase: '' }],
        'release-group': { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', tags: [{ name: 'Electronic' }] },
        media: [{
          position: 1,
          tracks: [
            { position: 1, title: 'One More Time', length: 320000 },
            { position: 2, title: 'Aerodynamic', length: 207000 }
          ]
        }]
      })
    }
  })

  const testnet = await createTestnet(3)
  const founder = await createNode({ storage: makeTmpDir(t), bootstrap: testnet.bootstrap })
  const follower = await createNode({ storage: makeTmpDir(t), bootstrap: testnet.bootstrap, worklet: true })
  t.after(async () => {
    await Promise.allSettled([follower.close(), founder.close()])
    await testnet.destroy()
  })

  const ch = await founder.meta.createChannel({ alias: 'Mirror Catalog' })
  const mirror = createMetaMirror({
    node: founder,
    metaKey: ch.key,
    cinemetaUrl: origin.baseUrl,
    mbUrl: origin.baseUrl,
    caaUrl: origin.baseUrl,
    allowPrivate: true
  })

  const m1 = await mirror.mirrorCinemetaTitle('tt0133093')
  assert.equal(m1.id, 'imdb:tt0133093')
  assert.equal(m1.artAdded, 2)
  assert.equal(m1.artDeduped, 0)
  assert.equal(m1.card.ratingX10, 87)

  // Second movie reuses matrix-poster.webp -> must deduplicate!
  const m2 = await mirror.mirrorCinemetaTitle('imdb:tt0234215')
  assert.equal(m2.artAdded, 0)
  assert.equal(m2.artDeduped, 1, 'shared poster must deduplicate via BLAKE2b hash')
  assert.equal(m2.card.posterHash, m1.card.posterHash)

  // Mirror series (movie 404 -> falls through to /meta/series/tt0903747.json)
  const s1 = await mirror.mirrorCinemetaTitle('tt0903747')
  assert.equal(s1.card.kind, 'series')
  assert.equal(s1.card.year, 2008)
  assert.equal(s1.detail.items.length, 2)
  assert.equal(s1.detail.items[0].subId, 'imdb:tt0903747:s01e01')

  // Mirror MusicBrainz release + Cover Art Archive cover
  const a1 = await mirror.mirrorMusicRelease(albumUuid)
  assert.equal(a1.id, `mb:${albumUuid}`)
  assert.equal(a1.card.kind, 'album')
  assert.equal(a1.card.subtitle, 'Daft Punk')
  assert.equal(a1.card.year, 2001)
  assert.equal(a1.artAdded, 1)
  assert.equal(a1.detail.items.length, 2)
  assert.equal(a1.detail.items[0].label, 'One More Time')

  const snap = await mirror.rebuildSnapshot()
  assert.equal(snap.titleCount, 4)
  assert.ok(snap.listCount >= 6, `expected popular + featured + genre shelves, got ${snap.listCount}`)
  assert.ok(snap.bucketCount >= 5)

  // Remote sparse follower reads everything strictly over P2P
  await follower.meta.addSource(ch.uri)
  const remCard = await until(() => follower.meta.getCard('imdb:tt0133093'), 30_000, 'follower reads Matrix card')
  assert.equal(remCard.title, 'The Matrix')
  assert.equal(remCard.posterHash, m1.card.posterHash)

  const remDetail = await until(() => follower.meta.getDetail('imdb:tt0903747'), 30_000, 'follower reads series detail')
  assert.equal(remDetail.items.length, 2)
  assert.equal(remDetail.items[0].label, 'Pilot')

  const remAlbum = await until(() => follower.meta.getDetail(`mb:${albumUuid}`), 30_000, 'follower reads album detail')
  assert.equal(remAlbum.items.length, 2)

  const remArt = await until(() => follower.meta.getArt(m1.card.posterHash), 30_000, 'follower verifies Matrix poster')
  assert.equal(remArt.mime, 'image/webp')
  assert.equal(remArt.width, 600)
  assert.equal(remArt.height, 900)
  assert.deepEqual(remArt.bytes, matrixPoster)

  const popularMovies = await until(() => follower.meta.getList('movie', 'popular'), 30_000, 'follower reads movie/popular')
  assert.deepEqual(popularMovies.ids, ['imdb:tt0133093', 'imdb:tt0234215'])

  const scifiMovies = await until(() => follower.meta.getList('movie', 'genre/sci-fi'), 30_000, 'follower reads movie/genre/sci-fi')
  assert.deepEqual(scifiMovies.ids, ['imdb:tt0133093', 'imdb:tt0234215'])

  const featuredAlbums = await until(() => follower.meta.getList('album', 'featured'), 30_000, 'follower reads album/featured')
  assert.deepEqual(featuredAlbums.ids, [`mb:${albumUuid}`])

  // Multi-word 3-char typeahead: "The Matrix" must be found by BOTH "the" and "mat"!
  const byThe = await follower.meta.searchIndex('movie', 'the')
  assert.ok(byThe.some(h => h.id === 'imdb:tt0133093'), 'The Matrix must match prefix "the"')
  const byMat = await follower.meta.searchIndex('movie', 'mat')
  assert.ok(byMat.some(h => h.id === 'imdb:tt0133093'), 'The Matrix must match word prefix "mat"')
  const byDaft = await follower.meta.searchIndex('album', 'daf')
  assert.ok(byDaft.some(h => h.id === `mb:${albumUuid}`), 'Album must match subtitle artist word prefix "daf"')
})

test('privacy fail-closed: p2pOnly blocks ALL clearnet HTTP requests in mirror methods', { timeout: 45_000 }, async t => {
  assert.ok(metaMirror, 'src/meta-mirror.js must exist')
  const { createMetaMirror } = metaMirror

  const origin = await startMockOrigin(t, {
    '/meta/movie/tt0133093.json': { body: JSON.stringify({ meta: { id: 'tt0133093', name: 'The Matrix' } }) }
  })
  const node = await createNode({ storage: makeTmpDir(t), bootstrap: [] })
  t.after(() => node.close())

  // Publish an entry into node's catalog so mirrorNodeCatalog would otherwise attempt to mirror it
  await node.publish({ id: 'imdb:tt0133093', title: 'The Matrix 1999' }, Readable.from([b4a.from('dummy-video-bytes')]))
  const ch = await node.meta.createChannel({ alias: 'Private Meta' })
  node.meta.setP2pOnly(true)

  const mirror = createMetaMirror({
    node,
    metaKey: ch.key,
    cinemetaUrl: origin.baseUrl,
    mbUrl: origin.baseUrl,
    caaUrl: origin.baseUrl,
    allowPrivate: true
  })

  const r1 = await mirror.mirrorCinemetaTitle('tt0133093')
  assert.equal(r1.skipped, true)
  assert.equal(r1.reason, 'p2p-only')

  const r2 = await mirror.mirrorMusicRelease('11111111-2222-3333-4444-555555555555')
  assert.equal(r2.skipped, true)
  assert.equal(r2.reason, 'p2p-only')

  const r3 = await mirror.mirrorNodeCatalog({ limit: 10 })
  assert.equal(r3.skipped, true)
  assert.equal(r3.reason, 'p2p-only')

  await assert.rejects(() => mirror.mirrorArt(`${origin.baseUrl}/art/x.webp`), /P2P-only|private routing/)
  assert.equal(origin.hits.length, 0, `expected ZERO HTTP requests when p2pOnly=true, got ${origin.hits.length}`)
})

test('ingestRecords bulk import + mirrorNodeCatalog + snapshot rebuild', { timeout: 45_000 }, async t => {
  assert.ok(metaMirror, 'src/meta-mirror.js must exist')
  const { createMetaMirror } = metaMirror

  const sharedPoster = makeWebpVp8l(400, 600)
  const backdrop = makePng(1280, 720, 9)
  const node = await createNode({ storage: makeTmpDir(t), bootstrap: [] })
  t.after(() => node.close())

  const ch = await node.meta.createChannel({ alias: 'Bulk Ingest' })
  const origin = await startMockOrigin(t, {
    '/meta/movie/tt0083658.json': {
      body: JSON.stringify({
        meta: {
          id: 'tt0083658',
          type: 'movie',
          name: 'Blade Runner',
          year: '1982',
          imdbRating: '8.1',
          genres: ['Sci-Fi', 'Thriller'],
          description: 'A blade runner hunts replicants.'
        }
      })
    }
  })

  const mirror = createMetaMirror({
    node,
    metaKey: ch.key,
    cinemetaUrl: origin.baseUrl,
    allowPrivate: true
  })

  async function * sampleStream () {
    yield {
      card: { id: 'imdb:tt0111161', kind: 'movie', title: 'The Shawshank Redemption', subtitle: 'Hope sets you free', year: 1994, ratingX10: 93, genres: ['Drama'] },
      detail: { id: 'imdb:tt0111161', synopsis: 'Two imprisoned men bond over years.' },
      posterBytes: sharedPoster,
      backdropBytes: backdrop
    }
    yield {
      card: { id: 'imdb:tt0068646', kind: 'movie', title: 'The Godfather', subtitle: 'Crime Saga', year: 1972, ratingX10: 92, genres: ['Crime', 'Drama'] },
      posterBytes: sharedPoster // duplicate bytes -> artDeduped++
    }
  }

  const bulk = await mirror.ingestRecords(sampleStream())
  assert.equal(bulk.cards, 2)
  assert.equal(bulk.details, 1)
  assert.equal(bulk.artAdded, 2)
  assert.equal(bulk.artDeduped, 1)

  // mirrorNodeCatalog discovers imdb:tt0083658 from node's catalog and skips already-mirrored imdb:tt0111161
  await node.publish({ id: 'imdb:tt0111161', title: 'The Shawshank Redemption 1994' }, Readable.from([b4a.from('a')]))
  await node.publish({ id: 'imdb:tt0083658', title: 'Blade Runner 1982' }, Readable.from([b4a.from('b')]))
  const cat = await mirror.mirrorNodeCatalog({ limit: 10 })
  assert.equal(cat.skipped, false)
  assert.equal(cat.mirrored, 1)
  assert.equal(cat.errors.length, 0)

  const snap = await mirror.rebuildSnapshot()
  assert.equal(snap.titleCount, 3)

  const popular = await node.meta.getList('movie', 'popular')
  assert.deepEqual(popular.ids, ['imdb:tt0111161', 'imdb:tt0068646', 'imdb:tt0083658'])
  const hits = await node.meta.searchIndex('movie', 'red')
  assert.ok(hits.some(h => h.id === 'imdb:tt0111161'), 'Redemption word prefix must find The Shawshank Redemption')
  const runnerHits = await node.meta.searchIndex('movie', 'run')
  assert.ok(runnerHits.some(h => h.id === 'imdb:tt0083658'), 'Runner word prefix must find Blade Runner')
})

test('openPeerApi preserves node.meta p2pOnlyMetadata and seedFullMetadata on startup', { timeout: 45_000 }, async t => {
  assert.ok(metaMirror, 'src/meta-mirror.js must exist')
  const storage = makeTmpDir(t)
  const node = await createNode({
    storage,
    bootstrap: [],
    p2pOnlyMetadata: true,
    seedFullMetadata: true
  })
  const api = await openPeerApi({ node, storage, preferredPort: 0 })
  t.after(async () => {
    await api.close()
    await node.close()
  })

  assert.equal(node.meta.isP2pOnly(), true, 'openPeerApi must not clobber p2pOnlyMetadata back to false')
  assert.equal(node.meta.isSeedFull(), true, 'openPeerApi must not clobber seedFullMetadata back to false')

  const getRes = await fetch(`${api.url}/v1/meta/sources`)
  assert.equal(getRes.status, 200)
  const status = await getRes.json()
  assert.equal(status.p2pOnlyMetadata, true)
  assert.equal(status.seedFullMetadata, true)

  // Explicit toggle off via POST /v1/meta/sources must still work cleanly
  const offRes = await fetch(`${api.url}/v1/meta/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ p2pOnlyMetadata: false })
  })
  assert.equal(offRes.status, 200)
  const offStatus = await offRes.json()
  assert.equal(offStatus.p2pOnlyMetadata, false)
  assert.equal(node.meta.isP2pOnly(), false)
})

test('listCards and rebuildSnapshot work on a multi-writer synced metadata channel', { timeout: 90_000 }, async t => {
  assert.ok(metaMirror, 'src/meta-mirror.js must exist')
  const { createMetaMirror } = metaMirror

  const testnet = await createTestnet(3)
  const founder = await createNode({ storage: makeTmpDir(t), bootstrap: testnet.bootstrap })
  const writer2 = await createNode({ storage: makeTmpDir(t), bootstrap: testnet.bootstrap })
  t.after(async () => {
    await Promise.allSettled([writer2.close(), founder.close()])
    await testnet.destroy()
  })

  assert.equal(typeof founder.meta.listCards, 'function', 'node.meta.listCards must be exposed')
  const ch = await founder.meta.createChannel({ alias: 'Multi-Writer Meta' })
  await founder.meta.putCard(ch.key, {
    id: 'imdb:tt0133093',
    kind: 'movie',
    title: 'The Matrix',
    subtitle: 'Sci-Fi',
    year: 1999,
    ratingX10: 87,
    genres: ['Sci-Fi']
  })

  const added = await writer2.meta.addSource(ch.uri)
  await founder.meta.grantWriter(ch.key, added.writerKey, { role: 'mod', alias: 'Co-Curator' })

  await until(async () => {
    await writer2.meta.getCard('imdb:tt0133093')
    return writer2.meta.listSources().find(s => s.key === ch.key)?.writable
  }, 30_000, 'writer2 becomes writable mod')

  await writer2.meta.putCard(ch.key, {
    id: 'imdb:tt0083658',
    kind: 'movie',
    title: 'Blade Runner',
    subtitle: 'Neo-noir',
    year: 1982,
    ratingX10: 81,
    genres: ['Sci-Fi']
  })

  const writerCards = await writer2.meta.listCards(ch.key)
  assert.deepEqual(writerCards.map(c => c.id).sort(), ['imdb:tt0083658', 'imdb:tt0133093'])

  const writerMirror = createMetaMirror({ node: writer2, metaKey: ch.key })
  const snap = await writerMirror.rebuildSnapshot()
  assert.equal(snap.titleCount, 2)

  await until(() => founder.meta.getCard('imdb:tt0083658'), 30_000, 'founder syncs writer2 card')
  const founderCards = await founder.meta.listCards(ch.key)
  assert.deepEqual(founderCards.map(c => c.id).sort(), ['imdb:tt0083658', 'imdb:tt0133093'])

  const popular = await until(() => founder.meta.getList('movie', 'popular'), 30_000, 'founder reads writer2 snapshot list')
  assert.deepEqual(popular.ids, ['imdb:tt0133093', 'imdb:tt0083658'])
  const hits = await founder.meta.searchIndex('movie', 'bla')
  assert.ok(hits.some(h => h.id === 'imdb:tt0083658'), 'founder searchIndex must find writer2 card')
})
