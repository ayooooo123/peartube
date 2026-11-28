import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import b4a from 'b4a'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createApi } from '../src/http.js'
import { createSettings } from '../src/settings.js'

let metaHttp = null
try {
  metaHttp = await import('../src/meta-http.js')
} catch (err) {
  void err
}

const SOURCE_KEY = 'a'.repeat(64)
const SOURCE_KEY_2 = 'b'.repeat(64)
const POSTER_HASH = '1'.repeat(64)
const BACKDROP_HASH = '2'.repeat(64)
const MISSING_HASH = 'f'.repeat(64)
const WEBP_BYTES = b4a.from('RIFF\x12\x00\x00\x00WEBPVP8 mock-webp-bytes')
const THUMB_BYTES = b4a.from([0x11, 0x22, 0x33, 0x44, 0x55])

function makeMockMeta () {
  let p2pOnly = false
  let seedFull = false
  const sources = new Map([
    [SOURCE_KEY, {
      key: SOURCE_KEY,
      uri: `peartube://meta/${SOURCE_KEY}?name=Primary`,
      alias: 'Primary',
      writable: false,
      seedFull: false,
      active: true
    }]
  ])
  const cards = new Map([
    ['imdb:tt0133093', {
      id: 'imdb:tt0133093',
      kind: 'movie',
      title: 'The Matrix',
      subtitle: 'Welcome to the Real World',
      year: 1999,
      ratingX10: 87,
      genres: ['Action', 'Sci-Fi'],
      runtimeMin: 136,
      thumbHash: THUMB_BYTES,
      posterHash: POSTER_HASH,
      backdropHash: BACKDROP_HASH,
      updatedAt: 1700000000000
    }]
  ])
  const details = new Map([
    ['imdb:tt0133093', {
      id: 'imdb:tt0133093',
      synopsis: 'A computer hacker learns about the true nature of his reality.',
      cast: ['Keanu Reeves', 'Laurence Fishburne'],
      directors: ['Lana Wachowski', 'Lilly Wachowski'],
      tags: ['cyberpunk'],
      backdropHash: BACKDROP_HASH,
      items: [],
      externalIds: [{ key: 'imdb', value: 'tt0133093' }],
      updatedAt: 1700000000000
    }]
  ])
  const artStore = new Map([
    [POSTER_HASH, { bytes: WEBP_BYTES, mime: 'image/webp', width: 500, height: 750, hash: POSTER_HASH, cached: true, source: SOURCE_KEY }],
    [BACKDROP_HASH, { bytes: b4a.from('backdrop-webp'), mime: 'image/webp', width: 1280, height: 720, hash: BACKDROP_HASH, cached: true, source: SOURCE_KEY }]
  ])
  const lists = new Map([
    ['movie/popular', {
      kind: 'movie',
      slug: 'popular',
      title: 'Popular Movies',
      ids: ['imdb:tt0133093'],
      updatedAt: 1700000000000,
      cards: [{ ...cards.get('imdb:tt0133093'), source: SOURCE_KEY }],
      source: SOURCE_KEY
    }]
  ])
  const calls = { search: [] }

  return {
    calls,
    addSource (spec, opts = {}) {
      const match = String(spec).match(/([0-9a-f]{64})/i)
      if (!match) throw Object.assign(new Error('Invalid metadata source key'), { status: 400 })
      const key = match[1].toLowerCase()
      const alias = opts.alias || ''
      const entry = {
        key,
        uri: alias ? `peartube://meta/${key}?name=${encodeURIComponent(alias)}` : `peartube://meta/${key}`,
        alias,
        writable: false,
        seedFull: Boolean(opts.seedFull),
        active: true
      }
      sources.set(key, entry)
      return entry
    },
    removeSource (key) {
      const removed = sources.delete(String(key).toLowerCase())
      return { removed }
    },
    listSources () {
      return [...sources.values()]
    },
    async getCard (id) {
      const card = cards.get(id)
      return card ? { ...card, source: SOURCE_KEY } : null
    },
    async getDetail (id) {
      const detail = details.get(id)
      return detail ? { ...detail, source: SOURCE_KEY } : null
    },
    async getArt (hashHex) {
      return artStore.get(hashHex) || null
    },
    async getList (kind, slug) {
      return lists.get(`${kind}/${slug}`) || null
    },
    async searchIndex (kind, query, opts = {}) {
      calls.search.push({ kind, query, limit: opts.limit })
      if (!String(query).toLowerCase().includes('mat')) return []
      return [{
        id: 'imdb:tt0133093',
        kind: kind || 'movie',
        title: 'The Matrix',
        subtitle: '1999',
        year: 1999,
        score: 950,
        thumbHash: THUMB_BYTES,
        posterHash: POSTER_HASH,
        source: SOURCE_KEY
      }]
    },
    isP2pOnly: () => p2pOnly,
    setP2pOnly: val => { p2pOnly = Boolean(val) },
    isSeedFull: () => seedFull,
    setSeedFull: val => { seedFull = Boolean(val) }
  }
}

async function startServer (t, overrides = {}) {
  const meta = makeMockMeta()
  const clearnetCalls = { poster: [], backdrop: [] }
  let p2pOnlySetting = false
  const state = {
    node: {
      privateRouting: false,
      meta,
      status: () => ({ tracker: SOURCE_KEY, channel: SOURCE_KEY }),
      listSources: () => [],
      openUri: async uri => ({ action: 'meta', key: SOURCE_KEY_2, uri })
    },
    apiToken: null,
    p2pOnlyMetadata: () => p2pOnlySetting,
    posterUrl: async tt => {
      clearnetCalls.poster.push(tt)
      return `https://images.metahub.space/poster/medium/${tt}/img`
    },
    backdropUrl: async tt => {
      clearnetCalls.backdrop.push(tt)
      return `https://images.metahub.space/background/medium/${tt}/img`
    },
    ...overrides
  }
  const srv = createApi(state)
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => srv.close(resolve)))
  const base = `http://127.0.0.1:${srv.address().port}`
  return {
    base,
    state,
    meta,
    clearnetCalls,
    setP2pOnlySetting: val => { p2pOnlySetting = Boolean(val) }
  }
}

test('meta API serves card, detail, list, and search endpoints', async t => {
  assert.ok(metaHttp, 'src/meta-http.js must exist')
  const { base, meta } = await startServer(t)

  const cardRes = await fetch(`${base}/v1/meta/card/imdb:tt0133093`)
  assert.equal(cardRes.status, 200)
  const card = await cardRes.json()
  assert.equal(card.id, 'imdb:tt0133093')
  assert.equal(card.title, 'The Matrix')
  assert.equal(card.thumbHash, b4a.toString(THUMB_BYTES, 'base64'))
  assert.equal(card.posterUrl, `/v1/art/${POSTER_HASH}`)
  assert.equal(card.backdropUrl, `/v1/art/${BACKDROP_HASH}`)
  assert.equal(card.source, SOURCE_KEY)

  const bareCardRes = await fetch(`${base}/v1/meta/card/tt0133093`)
  assert.equal(bareCardRes.status, 200)
  assert.equal((await bareCardRes.json()).id, 'imdb:tt0133093')

  const missCardRes = await fetch(`${base}/v1/meta/card/imdb:tt9999999`)
  assert.equal(missCardRes.status, 404)

  const detailRes = await fetch(`${base}/v1/meta/detail/imdb%3Att0133093`)
  assert.equal(detailRes.status, 200)
  const detail = await detailRes.json()
  assert.equal(detail.id, 'imdb:tt0133093')
  assert.equal(detail.backdropUrl, `/v1/art/${BACKDROP_HASH}`)
  assert.equal(detail.source, SOURCE_KEY)
  assert.deepEqual(detail.cast, ['Keanu Reeves', 'Laurence Fishburne'])

  const listRes = await fetch(`${base}/v1/meta/list/movie/popular`)
  assert.equal(listRes.status, 200)
  const list = await listRes.json()
  assert.equal(list.slug, 'popular')
  assert.equal(list.source, SOURCE_KEY)
  assert.equal(list.cards.length, 1)
  assert.equal(list.cards[0].posterUrl, `/v1/art/${POSTER_HASH}`)
  assert.equal(list.cards[0].thumbHash, b4a.toString(THUMB_BYTES, 'base64'))

  const searchRes = await fetch(`${base}/v1/meta/search?kind=movie&q=mat&limit=200`)
  assert.equal(searchRes.status, 200)
  const search = await searchRes.json()
  assert.equal(search.source, SOURCE_KEY)
  assert.equal(search.hits.length, 1)
  assert.equal(search.hits[0].posterUrl, `/v1/art/${POSTER_HASH}`)
  assert.equal(search.hits[0].thumbHash, b4a.toString(THUMB_BYTES, 'base64'))
  assert.equal(meta.calls.search[0].limit, 64, 'limit is capped at 64')
})

test('GET and HEAD /v1/art/:hash serve immutable bytes with ETag and 304 support', async t => {
  assert.ok(metaHttp, 'src/meta-http.js must exist')
  const { base } = await startServer(t)

  const res = await fetch(`${base}/v1/art/${POSTER_HASH}`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/webp')
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(res.headers.get('etag'), `"${POSTER_HASH}"`)
  assert.equal(res.headers.get('content-length'), String(WEBP_BYTES.byteLength))
  assert.deepEqual(b4a.from(await res.arrayBuffer()), WEBP_BYTES)

  const headRes = await fetch(`${base}/v1/art/${POSTER_HASH}`, { method: 'HEAD' })
  assert.equal(headRes.status, 200)
  assert.equal(headRes.headers.get('content-length'), String(WEBP_BYTES.byteLength))
  assert.equal((await headRes.arrayBuffer()).byteLength, 0)

  const notMod = await fetch(`${base}/v1/art/${POSTER_HASH}`, {
    headers: { 'if-none-match': `"${POSTER_HASH}"` }
  })
  assert.equal(notMod.status, 304)
  assert.equal(notMod.headers.get('etag'), `"${POSTER_HASH}"`)

  const missing = await fetch(`${base}/v1/art/${MISSING_HASH}`)
  assert.equal(missing.status, 404)
})

test('legacy /v1/poster and /v1/backdrop prefer P2P and fail closed under privacy modes', async t => {
  assert.ok(metaHttp, 'src/meta-http.js must exist')
  const { base, state, meta, clearnetCalls, setP2pOnlySetting } = await startServer(t)

  // 1. P2P hit redirects to /v1/art/:hash with zero clearnet lookups.
  const p2pPoster = await fetch(`${base}/v1/poster/tt0133093`, { redirect: 'manual' })
  assert.equal(p2pPoster.status, 302)
  assert.equal(p2pPoster.headers.get('location'), `/v1/art/${POSTER_HASH}`)
  assert.equal(p2pPoster.headers.get('cache-control'), 'public, max-age=86400')

  const p2pBackdrop = await fetch(`${base}/v1/backdrop/tt0133093`, { redirect: 'manual' })
  assert.equal(p2pBackdrop.status, 302)
  assert.equal(p2pBackdrop.headers.get('location'), `/v1/art/${BACKDROP_HASH}`)
  assert.deepEqual(clearnetCalls.poster, [], 'zero clearnet poster calls on P2P hit')
  assert.deepEqual(clearnetCalls.backdrop, [], 'zero clearnet backdrop calls on P2P hit')

  // 2. Public routing + P2P miss falls back to clearnet.
  const fallbackPoster = await fetch(`${base}/v1/poster/tt0068646`, { redirect: 'manual' })
  assert.equal(fallbackPoster.status, 302)
  assert.equal(fallbackPoster.headers.get('location'), 'https://images.metahub.space/poster/medium/tt0068646/img')
  assert.deepEqual(clearnetCalls.poster, ['tt0068646'])

  const fallbackBackdrop = await fetch(`${base}/v1/backdrop/tt0068646`, { redirect: 'manual' })
  assert.equal(fallbackBackdrop.status, 302)
  assert.equal(fallbackBackdrop.headers.get('location'), 'https://images.metahub.space/background/medium/tt0068646/img')
  assert.deepEqual(clearnetCalls.backdrop, ['tt0068646'])

  // 3. privateRouting === true fails closed with 404 and zero clearnet calls.
  state.node.privateRouting = true
  const privPoster = await fetch(`${base}/v1/poster/tt0468569`, { redirect: 'manual' })
  assert.equal(privPoster.status, 404)
  const privBackdrop = await fetch(`${base}/v1/backdrop/tt0468569`, { redirect: 'manual' })
  assert.equal(privBackdrop.status, 404)
  assert.deepEqual(clearnetCalls.poster, ['tt0068646'], 'privateRouting blocks clearnet poster calls')
  assert.deepEqual(clearnetCalls.backdrop, ['tt0068646'], 'privateRouting blocks clearnet backdrop calls')

  // P2P hits still succeed under privateRouting!
  const privP2p = await fetch(`${base}/v1/poster/tt0133093`, { redirect: 'manual' })
  assert.equal(privP2p.status, 302)
  assert.equal(privP2p.headers.get('location'), `/v1/art/${POSTER_HASH}`)
  state.node.privateRouting = false

  // 4. p2pOnlyMetadata fallback setting (when node.meta is absent) fails closed with 404 and zero clearnet calls.
  const savedMeta = state.node.meta
  state.node.meta = null
  setP2pOnlySetting(true)
  const p2pOnlyPoster = await fetch(`${base}/v1/poster/tt0816692`, { redirect: 'manual' })
  assert.equal(p2pOnlyPoster.status, 404)
  const p2pOnlyBackdrop = await fetch(`${base}/v1/backdrop/tt0816692`, { redirect: 'manual' })
  assert.equal(p2pOnlyBackdrop.status, 404)
  assert.deepEqual(clearnetCalls.poster, ['tt0068646'], 'p2pOnlyMetadata setting blocks clearnet poster calls')
  assert.deepEqual(clearnetCalls.backdrop, ['tt0068646'], 'p2pOnlyMetadata setting blocks clearnet backdrop calls')
  setP2pOnlySetting(false)
  state.node.meta = savedMeta

  // 5. node.meta.isP2pOnly() === true also fails closed, and turning it off re-enables clearnet fallback.
  meta.setP2pOnly(true)
  const nodeP2pOnly = await fetch(`${base}/v1/poster/tt0111161`, { redirect: 'manual' })
  assert.equal(nodeP2pOnly.status, 404)
  assert.deepEqual(clearnetCalls.poster, ['tt0068646'], 'node.meta.isP2pOnly blocks clearnet poster calls')
})

test('GET / POST / DELETE /v1/meta/sources enforce requireOwner and manage sources & toggles', async t => {
  assert.ok(metaHttp, 'src/meta-http.js must exist')
  const token = 'secret-owner-token'
  const { base } = await startServer(t, { apiToken: token })
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  const initialRes = await fetch(`${base}/v1/meta/sources`)
  assert.equal(initialRes.status, 200)
  const initial = await initialRes.json()
  assert.equal(initial.sources.length, 1)
  assert.equal(initial.sources[0].key, SOURCE_KEY)
  assert.equal(initial.p2pOnlyMetadata, false)
  assert.equal(initial.seedFullMetadata, false)

  // Writes without token must fail with 401.
  const unauthPost = await fetch(`${base}/v1/meta/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: SOURCE_KEY_2, alias: 'Community' })
  })
  assert.equal(unauthPost.status, 401)

  const unauthDel = await fetch(`${base}/v1/meta/sources/${SOURCE_KEY}`, { method: 'DELETE' })
  assert.equal(unauthDel.status, 401)

  // Authorized POST adds a source and flips toggles.
  const addRes = await fetch(`${base}/v1/meta/sources`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      uri: `peartube://meta/${SOURCE_KEY_2}`,
      alias: 'Community',
      seedFull: true,
      p2pOnlyMetadata: true,
      seedFullMetadata: true
    })
  })
  assert.equal(addRes.status, 200)
  const added = await addRes.json()
  assert.equal(added.source.key, SOURCE_KEY_2)
  assert.equal(added.source.alias, 'Community')
  assert.equal(added.source.seedFull, true)
  assert.equal(added.sources.length, 2)
  assert.equal(added.p2pOnlyMetadata, true)
  assert.equal(added.seedFullMetadata, true)

  // Authorized DELETE removes the source.
  const delRes = await fetch(`${base}/v1/meta/sources/${SOURCE_KEY_2}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` }
  })
  assert.equal(delRes.status, 200)
  const deleted = await delRes.json()
  assert.equal(deleted.removed, true)
  assert.equal(deleted.sources.length, 1)
  assert.equal(deleted.sources[0].key, SOURCE_KEY)
})

test('settings.js validates and persists metaSources, p2pOnlyMetadata, and seedFullMetadata', t => {
  assert.ok(metaHttp, 'src/meta-http.js must exist')
  const dir = mkdtempSync(join(tmpdir(), 'peartube-meta-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const env = {
    PEARTUBE_META_SOURCES: `${SOURCE_KEY}, ${SOURCE_KEY_2}`,
    PEARTUBE_P2P_ONLY_METADATA: '1',
    PEARTUBE_SEED_FULL_METADATA: 'true'
  }
  const s1 = createSettings(dir, env)
  assert.deepEqual(s1.get('metaSources'), [SOURCE_KEY, SOURCE_KEY_2])
  assert.equal(s1.get('p2pOnlyMetadata'), true)
  assert.equal(s1.get('seedFullMetadata'), true)
  assert.equal(s1.isLive('metaSources'), true)
  assert.equal(s1.isLive('p2pOnlyMetadata'), true)
  assert.equal(s1.isLive('seedFullMetadata'), true)

  // Validation rejects malformed keys and non-boolean flags.
  assert.throws(() => s1.update({ metaSources: ['not-a-key'] }), /metaSources/)
  assert.throws(() => s1.update({ p2pOnlyMetadata: 'yes' }), /p2pOnlyMetadata/)
  assert.throws(() => s1.update({ seedFullMetadata: 1 }), /seedFullMetadata/)

  // Valid update persists to settings.json and survives reload.
  const upperKey = 'C'.repeat(64)
  const updated = s1.update({
    metaSources: [upperKey],
    p2pOnlyMetadata: false,
    seedFullMetadata: false
  })
  assert.deepEqual(updated.changed.sort(), ['metaSources', 'p2pOnlyMetadata', 'seedFullMetadata'])
  assert.deepEqual(updated.restartNeeded, [])

  const persisted = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  assert.deepEqual(persisted.metaSources, ['c'.repeat(64)])
  assert.equal(persisted.p2pOnlyMetadata, false)
  assert.equal(persisted.seedFullMetadata, false)

  const s2 = createSettings(dir, env)
  assert.deepEqual(s2.get('metaSources'), ['c'.repeat(64)])
  assert.equal(s2.get('p2pOnlyMetadata'), false)
  assert.equal(s2.get('seedFullMetadata'), false)

  // Setting to null reverts to env values.
  s2.update({ metaSources: null, p2pOnlyMetadata: null, seedFullMetadata: null })
  assert.deepEqual(s2.get('metaSources'), [SOURCE_KEY, SOURCE_KEY_2])
  assert.equal(s2.get('p2pOnlyMetadata'), true)
  assert.equal(s2.get('seedFullMetadata'), true)
})

test('real createNode + createApi end-to-end metadata HTTP integration (no mocks)', async t => {
  assert.ok(metaHttp, 'src/meta-http.js must exist')
  const testnet = await createTestnet(2)
  const dir = mkdtempSync(join(tmpdir(), 'peartube-meta-e2e-http-'))
  const node = await createNode({ storage: dir, bootstrap: testnet.bootstrap })
  assert.equal(typeof node.meta, 'object', 'createNode must expose node.meta')

  const clearnetHits = []
  const settings = createSettings(dir, {})
  const state = {
    node,
    settings,
    p2pOnlyMetadata: () => settings.get('p2pOnlyMetadata'),
    posterUrl: async tt => { clearnetHits.push(`poster:${tt}`); return `https://images.metahub.space/poster/small/${tt}/img` },
    backdropUrl: async tt => { clearnetHits.push(`backdrop:${tt}`); return `https://images.metahub.space/background/medium/${tt}/img` }
  }
  const srv = createApi(state)
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => srv.close(resolve))
    await node.close()
    await testnet.destroy()
    rmSync(dir, { recursive: true, force: true })
  })

  const ch = await node.meta.createChannel({ alias: 'E2E Meta' })
  const posterBytes = b4a.from('RIFF\x24\x00\x00\x00WEBPVP8 real-e2e-poster-bytes')
  const backdropBytes = b4a.from('RIFF\x26\x00\x00\x00WEBPVP8 real-e2e-backdrop-bytes')
  const posterArt = await node.meta.putArt(ch.key, posterBytes, { mime: 'image/webp', width: 300, height: 450 })
  const backdropArt = await node.meta.putArt(ch.key, backdropBytes, { mime: 'image/webp', width: 1280, height: 720 })

  await node.meta.putCard(ch.key, {
    id: 'imdb:tt0133093',
    kind: 'movie',
    title: 'The Matrix',
    subtitle: 'Free your mind',
    year: 1999,
    ratingX10: 87,
    genres: ['Sci-Fi'],
    runtimeMin: 136,
    thumbHash: THUMB_BYTES,
    posterHash: posterArt.hash,
    backdropHash: ''
  })
  await node.meta.putDetail(ch.key, {
    id: 'imdb:tt0133093',
    synopsis: 'Simulation awakening.',
    cast: ['Keanu Reeves'],
    directors: ['Lana Wachowski'],
    tags: ['cyberpunk'],
    backdropHash: backdropArt.hash,
    items: [],
    externalIds: [{ key: 'imdb', value: 'tt0133093' }]
  })
  await node.meta.publishSearchSnapshot(ch.key, {
    lists: [{ kind: 'movie', slug: 'popular', title: 'Popular', ids: ['imdb:tt0133093'], updatedAt: Date.now() }],
    buckets: [{
      kind: 'movie',
      prefix: 'mat',
      hits: [{ id: 'imdb:tt0133093', title: 'The Matrix', subtitle: '1999', year: 1999, score: 900, thumbHash: THUMB_BYTES, posterHash: posterArt.hash }],
      updatedAt: Date.now()
    }],
    titleCount: 1
  })

  const base = `http://127.0.0.1:${srv.address().port}`

  const card = await (await fetch(`${base}/v1/meta/card/imdb:tt0133093`)).json()
  assert.equal(card.id, 'imdb:tt0133093')
  assert.equal(card.source, ch.key)
  assert.equal(card.posterUrl, `/v1/art/${posterArt.hash}`)

  const detail = await (await fetch(`${base}/v1/meta/detail/imdb:tt0133093`)).json()
  assert.equal(detail.synopsis, 'Simulation awakening.')
  assert.equal(detail.backdropUrl, `/v1/art/${backdropArt.hash}`)
  assert.equal(detail.source, ch.key)

  const list = await (await fetch(`${base}/v1/meta/list/movie/popular`)).json()
  assert.equal(list.slug, 'popular')
  assert.equal(list.cards.length, 1)
  assert.equal(list.cards[0].posterUrl, `/v1/art/${posterArt.hash}`)

  // Cross-kind search (no kind param) finds the indexed movie.
  const search = await (await fetch(`${base}/v1/meta/search?q=mat`)).json()
  assert.equal(search.hits.length, 1)
  assert.equal(search.hits[0].id, 'imdb:tt0133093')
  assert.equal(search.hits[0].posterUrl, `/v1/art/${posterArt.hash}`)

  // /v1/poster resolves P2P first -> /v1/art/:hash serves exact verified bytes; /v1/backdrop reads detail.backdropHash!
  const posterRedir = await fetch(`${base}/v1/poster/tt0133093`, { redirect: 'manual' })
  assert.equal(posterRedir.status, 302)
  assert.equal(posterRedir.headers.get('location'), `/v1/art/${posterArt.hash}`)
  const artBytes = b4a.from(await (await fetch(`${base}${posterRedir.headers.get('location')}`)).arrayBuffer())
  assert.deepEqual(artBytes, posterBytes)

  const backdropRedir = await fetch(`${base}/v1/backdrop/tt0133093`, { redirect: 'manual' })
  assert.equal(backdropRedir.status, 302)
  assert.equal(backdropRedir.headers.get('location'), `/v1/art/${backdropArt.hash}`)
  assert.deepEqual(clearnetHits, [], 'zero clearnet calls when P2P metadata serves poster and backdrop')

  // Toggling p2pOnlyMetadata on blocks clearnet misses, and toggling it back off re-enables clearnet fallback.
  const onRes = await fetch(`${base}/v1/meta/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ p2pOnlyMetadata: true })
  })
  assert.equal(onRes.status, 200)
  assert.equal((await onRes.json()).p2pOnlyMetadata, true)
  assert.equal((await fetch(`${base}/v1/poster/tt9999999`, { redirect: 'manual' })).status, 404)
  assert.deepEqual(clearnetHits, [], 'p2pOnlyMetadata=true blocks clearnet fallback')

  const offRes = await fetch(`${base}/v1/meta/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ p2pOnlyMetadata: false })
  })
  assert.equal(offRes.status, 200)
  assert.equal((await offRes.json()).p2pOnlyMetadata, false)
  assert.equal((await fetch(`${base}/v1/poster/tt9999999`, { redirect: 'manual' })).status, 302)
  assert.deepEqual(clearnetHits, ['poster:tt9999999'], 'toggling p2pOnlyMetadata back off re-enables clearnet fallback')
})
