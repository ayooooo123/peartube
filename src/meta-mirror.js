import b4a from 'b4a'
import { CINEMETA_URL, send } from './art.js'
import { MAX_ART_BYTES, canonicalMetaId, foldPrefix3, foldText } from './meta-wire.js'
import { cleanText } from './protocol.js'
import { encodeThumbHash, sniffArtHeader } from './meta-image.js'

export { encodeThumbHash, sniffArtHeader }

const DEFAULT_MB_URL = 'https://musicbrainz.org'
const DEFAULT_CAA_URL = 'https://coverartarchive.org'
const MB_USER_AGENT = 'PearTube/0.5 (https://github.com/ayooooo123/peartube)'
const MAX_JSON_BYTES = 8 * 1024 * 1024
const MAX_LIST_IDS = 256
const MAX_BUCKET_CAP = 48

const SHELF_SPECS = Object.freeze({
  movie: { slug: 'popular', title: 'Popular Movies' },
  series: { slug: 'popular', title: 'Popular Series' },
  album: { slug: 'featured', title: 'Featured Albums' },
  artist: { slug: 'featured', title: 'Featured Artists' }
})

const trimSlash = url => String(url || '').replace(/\/+$/, '')
const pad2 = n => String(Math.max(0, Number(n) || 0)).padStart(2, '0')

function parseYear (raw) {
  const m = String(raw || '').match(/\b(1[89]\d{2}|20\d{2})\b/)
  return m ? Number(m[1]) : 0
}

function parseRuntimeMin (raw) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.min(0xffff, Math.round(raw))
  const m = String(raw || '').match(/(\d+)/)
  return m ? Math.min(0xffff, Number(m[1])) : 0
}

function parseRatingX10 (raw) {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.max(0, Math.round(n * 10))) : 0
}

function toBytes (raw) {
  if (b4a.isBuffer(raw)) return raw
  if (raw instanceof Uint8Array) return b4a.from(raw.buffer, raw.byteOffset, raw.byteLength)
  if (typeof raw === 'string' && raw.length > 0) return b4a.from(raw, 'base64')
  return null
}

function normalizeImdb (raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/^imdb:/, '').replace(/:s\d{2}e\d{2,3}$/, '')
  if (!/^tt\d{5,10}$/.test(s)) throw new Error(`Invalid IMDb ID: ${raw}`)
  return { tt: s, id: `imdb:${s}` }
}

function normalizeMbid (raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/^mb:/, '').replace(/:s\d{2}e\d{2,3}$/, '')
  const id = canonicalMetaId(`mb:${s}`)
  if (!id || !id.startsWith('mb:')) throw new Error(`Invalid MusicBrainz ID: ${raw}`)
  return { uuid: id.slice(3), id }
}

function extractBaseCatalogId (entryId) {
  const base = String(entryId || '').trim().toLowerCase().replace(/:s\d{2}e\d{2,3}$/, '')
  const cid = canonicalMetaId(base)
  return cid && (cid.startsWith('imdb:') || cid.startsWith('mb:')) ? cid : null
}

function compareCards (a, b) {
  return (b.ratingX10 - a.ratingX10) || (b.year - a.year) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
}

function cardScore (card) {
  const ratingPart = (card.ratingX10 || 0) * 10
  const yearPart = card.year > 1950 ? Math.min(100, card.year - 1950) : 0
  return Math.min(0xffff, ratingPart + yearPart + (card.posterHash ? 50 : 0))
}

function prefixesForCard (card) {
  const set = new Set()
  const titlePfx = foldPrefix3(card.title)
  if (titlePfx) set.add(titlePfx)
  for (const field of [card.title, card.subtitle]) {
    const folded = foldText(field)
    if (!folded) continue
    for (const word of folded.split(' ')) {
      if (word.length < 3) continue
      const pfx = foldPrefix3(word)
      if (pfx) set.add(pfx)
    }
  }
  return set
}

function genreSlug (name) {
  const slug = foldText(name).replace(/\s+/g, '-').slice(0, 48)
  return slug ? `genre/${slug}` : ''
}

function extractDirectors (meta) {
  if (Array.isArray(meta.director)) return meta.director.slice(0, 64)
  if (Array.isArray(meta.directors)) return meta.directors.slice(0, 64)
  if (typeof meta.director === 'string' && meta.director.trim()) return [meta.director.trim()]
  return []
}

function buildCinemetaRecords ({ id, tt, kind, meta, posterHash, backdropHash }) {
  const genres = Array.isArray(meta.genres) ? meta.genres.map(g => cleanText(g)).filter(Boolean).slice(0, 16) : []
  const now = Date.now()
  const card = {
    id,
    kind,
    title: cleanText(meta.name || meta.title || tt),
    subtitle: cleanText(meta.tagline || genres.slice(0, 2).join(' · ')),
    year: parseYear(meta.year || meta.releaseInfo),
    ratingX10: parseRatingX10(meta.imdbRating),
    genres,
    runtimeMin: parseRuntimeMin(meta.runtime),
    posterHash: posterHash || '',
    backdropHash: backdropHash || '',
    updatedAt: now
  }
  const videos = Array.isArray(meta.videos) ? meta.videos.slice(0, 512) : []
  const items = videos.map((v, idx) => {
    const season = Math.max(0, Math.min(0xffff, Number(v?.season) || 0))
    const number = Math.max(0, Math.min(0xffff, Number(v?.episode ?? v?.number) || (idx + 1)))
    const subId = season > 0 && number > 0 ? `${id}:s${pad2(season)}e${pad2(number)}` : cleanText(v?.id || '')
    return { label: cleanText(v?.title || v?.name || `Episode ${number}`), subId, season, number, runtimeMin: parseRuntimeMin(v?.runtime) }
  })
  const externalIds = [{ key: 'imdb', value: tt }]
  const tmdb = meta.moviedb_id ?? meta.tmdb_id
  if (tmdb !== undefined && tmdb !== null && String(tmdb).trim()) {
    externalIds.push({ key: 'tmdb', value: String(tmdb).trim() })
  }
  const detail = {
    id,
    synopsis: String(meta.description || meta.synopsis || ''),
    cast: Array.isArray(meta.cast) ? meta.cast.slice(0, 64) : [],
    directors: extractDirectors(meta),
    tags: genres.slice(0, 32),
    backdropHash: backdropHash || '',
    items,
    externalIds,
    updatedAt: now
  }
  return { card, detail }
}

function buildMusicRecords ({ id, uuid, rel, posterHash }) {
  const credits = Array.isArray(rel['artist-credit']) ? rel['artist-credit'] : []
  const artist = cleanText(credits.map(c => `${c?.name || c?.artist?.name || ''}${c?.joinphrase || ''}`).join('').trim())
  const rawTags = [...(rel.genres || []), ...(rel.tags || []), ...(rel['release-group']?.tags || [])]
  const genres = [...new Set(rawTags.map(t => cleanText(typeof t === 'string' ? t : t?.name)).filter(Boolean))].slice(0, 16)
  const items = []
  let totalMs = 0
  const media = Array.isArray(rel.media) ? rel.media : []
  for (let mIdx = 0; mIdx < media.length; mIdx++) {
    const disc = Math.max(1, Math.min(0xffff, Number(media[mIdx]?.position) || (mIdx + 1)))
    const tracks = Array.isArray(media[mIdx]?.tracks) ? media[mIdx].tracks : []
    for (let tIdx = 0; tIdx < tracks.length && items.length < 512; tIdx++) {
      const tr = tracks[tIdx]
      const num = Math.max(1, Math.min(0xffff, Number(tr?.position ?? tr?.number) || (tIdx + 1)))
      const ms = Number(tr?.length ?? tr?.recording?.length) || 0
      totalMs += ms
      items.push({
        label: cleanText(tr?.title || tr?.recording?.title || `Track ${num}`),
        subId: `${id}:s${pad2(disc)}e${pad2(num)}`,
        season: disc,
        number: num,
        runtimeMin: ms > 0 ? Math.min(0xffff, Math.max(1, Math.round(ms / 60_000))) : 0
      })
    }
  }
  const now = Date.now()
  const card = {
    id,
    kind: 'album',
    title: cleanText(rel.title || uuid),
    subtitle: artist,
    year: parseYear(rel.date || rel['release-group']?.['first-release-date']),
    ratingX10: 0,
    genres,
    runtimeMin: totalMs > 0 ? Math.min(0xffff, Math.max(1, Math.round(totalMs / 60_000))) : 0,
    posterHash: posterHash || '',
    backdropHash: '',
    updatedAt: now
  }
  const externalIds = [{ key: 'musicbrainz', value: uuid }]
  if (rel['release-group']?.id) externalIds.push({ key: 'mb-release-group', value: String(rel['release-group'].id) })
  const detail = {
    id,
    synopsis: cleanText(rel.disambiguation || ''),
    cast: artist ? [artist] : [],
    directors: [],
    tags: genres.slice(0, 32),
    backdropHash: '',
    items,
    externalIds,
    updatedAt: now
  }
  return { card, detail }
}

async function readChannelCards (node, metaKey) {
  return await node.meta.listCards(metaKey)
}

function addCardToBuckets (card, bucketMap) {
  const hit = {
    id: card.id,
    title: card.title,
    subtitle: card.subtitle,
    year: card.year,
    score: cardScore(card),
    thumbHash: card.thumbHash,
    posterHash: card.posterHash
  }
  for (const prefix of prefixesForCard(card)) {
    const bKey = `${card.kind}/${prefix}`
    let byId = bucketMap.get(bKey)
    if (!byId) {
      byId = new Map()
      bucketMap.set(bKey, byId)
    }
    if (!byId.has(card.id)) byId.set(card.id, hit)
  }
}

function buildListsAndBuckets (cards, { extraLists = [], maxHitsPerBucket = MAX_BUCKET_CAP } = {}) {
  const now = Date.now()
  const sorted = [...cards].sort(compareCards)
  const cap = Math.max(1, Math.min(MAX_BUCKET_CAP, Number(maxHitsPerBucket) || MAX_BUCKET_CAP))
  const byKind = new Map()
  const byGenre = new Map()
  const bucketMap = new Map()

  for (const card of sorted) {
    if (!byKind.has(card.kind)) byKind.set(card.kind, [])
    byKind.get(card.kind).push(card.id)
    if (card.kind === 'movie' || card.kind === 'series') {
      for (const genre of card.genres) {
        const slug = genreSlug(genre)
        if (!slug) continue
        const key = `${card.kind}/${slug}`
        if (!byGenre.has(key)) byGenre.set(key, { kind: card.kind, slug, title: genre, ids: [] })
        byGenre.get(key).ids.push(card.id)
      }
    }
    addCardToBuckets(card, bucketMap)
  }

  const listMap = new Map()
  for (const [kind, ids] of byKind) {
    const spec = SHELF_SPECS[kind]
    if (spec && ids.length > 0) {
      listMap.set(`${kind}/${spec.slug}`, { kind, slug: spec.slug, title: spec.title, ids: ids.slice(0, MAX_LIST_IDS), updatedAt: now })
    }
  }
  for (const [key, g] of byGenre) {
    if (g.ids.length > 0) {
      listMap.set(key, { kind: g.kind, slug: g.slug, title: g.title, ids: g.ids.slice(0, MAX_LIST_IDS), updatedAt: now })
    }
  }
  for (const extra of extraLists) {
    if (!extra?.kind || !extra?.slug) continue
    listMap.set(`${String(extra.kind).toLowerCase()}/${String(extra.slug).toLowerCase()}`, { ...extra, updatedAt: extra.updatedAt ?? now })
  }

  const buckets = []
  for (const [bKey, byId] of bucketMap) {
    const slash = bKey.indexOf('/')
    const hits = [...byId.values()]
      .sort((a, b) => (b.score - a.score) || (b.year - a.year) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
      .slice(0, cap)
    buckets.push({ kind: bKey.slice(0, slash), prefix: bKey.slice(slash + 1), hits, updatedAt: now })
  }
  return { lists: [...listMap.values()], buckets }
}

export function createMetaMirror ({
  node,
  metaKey,
  fetchBytes = null,
  cinemetaUrl = CINEMETA_URL,
  mbUrl = DEFAULT_MB_URL,
  caaUrl = DEFAULT_CAA_URL,
  allowPrivate = false
} = {}) {
  if (!node?.meta) throw new Error('createMetaMirror requires a node with node.meta')
  const key = String(metaKey || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('createMetaMirror requires a 64-hex metaKey')
  const cinemetaBase = trimSlash(cinemetaUrl)
  const mbBase = trimSlash(mbUrl)
  const caaBase = trimSlash(caaUrl)

  const isClearnetBlocked = () => Boolean(node.privateRouting || node.meta.isP2pOnly?.())

  async function requestBytes (url, { maxBytes = MAX_ART_BYTES, headers = {}, timeoutMs = 10_000 } = {}) {
    if (isClearnetBlocked()) {
      throw Object.assign(new Error('Clearnet metadata fetch refused in P2P-only or private routing mode'), { code: 'P2P_ONLY' })
    }
    if (typeof fetchBytes === 'function') {
      const res = await fetchBytes(url, { maxBytes, headers, timeoutMs, allowPrivate })
      if (res && typeof res === 'object' && 'body' in res) {
        if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} fetching ${url}`)
        return toBytes(res.body) || b4a.from(String(res.body || ''))
      }
      return toBytes(res)
    }
    const res = await send(url, { binary: true, maxBytes, allowPrivate, headers, timeoutMs })
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} fetching ${url}`)
    return res.body
  }

  async function requestJson (url, headers = {}) {
    try {
      const buf = await requestBytes(url, { maxBytes: MAX_JSON_BYTES, headers })
      return buf ? JSON.parse(b4a.toString(buf, 'utf8')) : null
    } catch (err) {
      if (err?.code === 'P2P_ONLY') throw err
      return null
    }
  }

  async function storeArtBytes (rawBytes, { thumbHash = null } = {}) {
    const bytes = toBytes(rawBytes)
    const info = sniffArtHeader(bytes)
    if (!info) throw new Error('Invalid or unsupported artwork bytes')
    const put = await node.meta.putArt(key, bytes, { mime: info.mime, width: info.width, height: info.height })
    return { ...put, mime: info.mime, width: info.width, height: info.height, ...(thumbHash ? { thumbHash } : {}) }
  }

  async function mirrorArt (url, { thumbHash = null } = {}) {
    const bytes = await requestBytes(url, { maxBytes: MAX_ART_BYTES })
    return storeArtBytes(bytes, { thumbHash })
  }

  async function tryMirrorArt (url, counts) {
    if (!url || typeof url !== 'string') return ''
    try {
      const art = await mirrorArt(url)
      if (art.deduplicated) counts.artDeduped++
      else counts.artAdded++
      return art.hash
    } catch (err) {
      if (err?.code === 'P2P_ONLY') throw err
      return ''
    }
  }

  async function mirrorCinemetaTitle (imdbId) {
    const { tt, id } = normalizeImdb(imdbId)
    if (isClearnetBlocked()) return { skipped: true, reason: 'p2p-only', id }
    let meta = null
    let kind = 'movie'
    for (const type of ['movie', 'series']) {
      const data = await requestJson(`${cinemetaBase}/meta/${type}/${tt}.json`)
      const m = data?.meta
      if (!m || typeof m !== 'object' || (!m.name && !m.title)) continue
      meta = m
      kind = m.type === 'series' || type === 'series' ? 'series' : 'movie'
      if (m.poster || Array.isArray(m.videos)) break
    }
    if (!meta) throw new Error(`Cinemeta metadata not found for ${id}`)
    const counts = { artAdded: 0, artDeduped: 0 }
    const posterHash = await tryMirrorArt(meta.poster, counts)
    const backdropHash = await tryMirrorArt(meta.background || meta.backdrop, counts)
    const { card, detail } = buildCinemetaRecords({ id, tt, kind, meta, posterHash, backdropHash })
    const savedCard = await node.meta.putCard(key, card)
    const savedDetail = await node.meta.putDetail(key, detail)
    return { skipped: false, id, card: savedCard, detail: savedDetail, ...counts }
  }

  async function mirrorMusicRelease (mbid) {
    const { uuid, id } = normalizeMbid(mbid)
    if (isClearnetBlocked()) return { skipped: true, reason: 'p2p-only', id }
    const rel = await requestJson(
      `${mbBase}/ws/2/release/${uuid}?inc=artists+recordings+release-groups&fmt=json`,
      { 'user-agent': MB_USER_AGENT, accept: 'application/json' }
    )
    if (!rel || typeof rel !== 'object' || !rel.title) throw new Error(`MusicBrainz release not found for ${id}`)
    const counts = { artAdded: 0, artDeduped: 0 }
    const posterHash = await tryMirrorArt(`${caaBase}/release/${uuid}/front-500`, counts)
    const { card, detail } = buildMusicRecords({ id, uuid, rel, posterHash })
    const savedCard = await node.meta.putCard(key, card)
    const savedDetail = await node.meta.putDetail(key, detail)
    return { skipped: false, id, card: savedCard, detail: savedDetail, ...counts }
  }

  async function mirrorNodeCatalog ({ limit = 50 } = {}) {
    if (isClearnetBlocked()) {
      return { skipped: true, reason: 'p2p-only', scanned: 0, mirrored: 0, artAdded: 0, artDeduped: 0, errors: [] }
    }
    const maxCount = Math.max(0, Number(limit) || 0)
    const entries = await node.search(null)
    const uniqueIds = new Set()
    for (const entry of entries) {
      const cid = extractBaseCatalogId(entry?.id)
      if (cid) uniqueIds.add(cid)
    }
    let mirrored = 0
    let artAdded = 0
    let artDeduped = 0
    const errors = []
    for (const id of uniqueIds) {
      if (mirrored >= maxCount) break
      if (await node.meta.getCard(id)) continue
      try {
        const res = id.startsWith('imdb:') ? await mirrorCinemetaTitle(id) : await mirrorMusicRelease(id)
        if (!res.skipped) {
          mirrored++
          artAdded += res.artAdded
          artDeduped += res.artDeduped
        }
      } catch (err) {
        errors.push({ id, error: err?.message || String(err) })
      }
    }
    return { skipped: false, scanned: uniqueIds.size, mirrored, artAdded, artDeduped, errors }
  }

  async function ingestArtSlot (bytes, url, fallback, counts) {
    if (bytes) {
      const art = await storeArtBytes(bytes)
      if (art.deduplicated) counts.artDeduped++
      else counts.artAdded++
      return art.hash
    }
    if (url && !isClearnetBlocked()) return (await tryMirrorArt(url, counts)) || fallback
    return fallback
  }

  async function ingestRecords (records) {
    const counts = { cards: 0, details: 0, artAdded: 0, artDeduped: 0 }
    for await (const rec of records) {
      if (!rec?.card) continue
      const posterHash = await ingestArtSlot(rec.posterBytes, rec.posterUrl, rec.card.posterHash || '', counts)
      const backdropHash = await ingestArtSlot(rec.backdropBytes, rec.backdropUrl, rec.card.backdropHash || rec.detail?.backdropHash || '', counts)
      const card = await node.meta.putCard(key, { ...rec.card, posterHash, backdropHash })
      counts.cards++
      if (rec.detail) {
        await node.meta.putDetail(key, { ...rec.detail, id: rec.detail.id || card.id, backdropHash })
        counts.details++
      }
    }
    return counts
  }

  async function rebuildSnapshot ({ extraLists = [], maxHitsPerBucket = MAX_BUCKET_CAP } = {}) {
    const cards = await readChannelCards(node, key)
    const { lists, buckets } = buildListsAndBuckets(cards, { extraLists, maxHitsPerBucket })
    const snapshot = await node.meta.publishSearchSnapshot(key, { lists, buckets, titleCount: cards.length })
    return { snapshot, listCount: lists.length, bucketCount: buckets.length, titleCount: cards.length }
  }

  return { mirrorArt, mirrorCinemetaTitle, mirrorMusicRelease, mirrorNodeCatalog, ingestRecords, rebuildSnapshot }
}
