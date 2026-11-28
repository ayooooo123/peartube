import b4a from 'b4a'
import { canonicalMetaId } from './meta-wire.js'

const HEX64_LOWER = /^[0-9a-f]{64}$/
const ART_HASH_PATH = /^\/v1\/art\/([0-9a-f]{64})$/
const LEGACY_ART_PATH = /^\/v1\/(poster|backdrop)\/(tt\d{5,10})$/
const META_CARD_PATH = /^\/v1\/meta\/card\/(.+)$/
const META_DETAIL_PATH = /^\/v1\/meta\/detail\/(.+)$/
const META_LIST_PATH = /^\/v1\/meta\/list\/([^/]+)\/(.+)$/
const META_SOURCE_DEL_PATH = /^\/v1\/meta\/sources\/([0-9a-f]{64})$/i
const ART_CACHE_CONTROL = 'public, max-age=31536000, immutable'

function decodePart (raw, label) {
  try {
    return decodeURIComponent(raw)
  } catch (err) {
    void err
    throw Object.assign(new Error(`Invalid ${label}`), { status: 400 })
  }
}

export function serializeCard (card, source = undefined) {
  if (!card) return null
  return {
    ...card,
    thumbHash: card.thumbHash?.byteLength ? b4a.toString(card.thumbHash, 'base64') : '',
    posterUrl: card.posterHash ? `/v1/art/${card.posterHash}` : null,
    backdropUrl: card.backdropHash ? `/v1/art/${card.backdropHash}` : null,
    source: source !== undefined ? source : (card.source ?? null)
  }
}

export function serializeDetail (detail, source = undefined) {
  if (!detail) return null
  return {
    ...detail,
    backdropUrl: detail.backdropHash ? `/v1/art/${detail.backdropHash}` : null,
    source: source !== undefined ? source : (detail.source ?? null)
  }
}

export function isClearnetMetaBlocked (state) {
  if (state?.node?.privateRouting) return true
  if (state?.node?.meta?.isP2pOnly) return Boolean(state.node.meta.isP2pOnly())
  return Boolean(state?.p2pOnlyMetadata?.())
}

export async function handleArtRequest (req, res, url, state, cors) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const match = url.pathname.match(ART_HASH_PATH)
  if (!match) return false
  const hash = match[1]
  let art = null
  try {
    if (state.node?.meta?.getArt) art = await state.node.meta.getArt(hash)
  } catch (err) {
    void err
    art = null
  }
  if (!art?.bytes?.byteLength) {
    res.writeHead(404, cors)
    res.end()
    return true
  }
  const etag = `"${hash}"`
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ...cors, etag, 'cache-control': ART_CACHE_CONTROL })
    res.end()
    return true
  }
  res.writeHead(200, {
    ...cors,
    'content-type': art.mime || 'image/webp',
    'content-length': String(art.bytes.byteLength),
    'cache-control': ART_CACHE_CONTROL,
    etag
  })
  res.end(req.method === 'HEAD' ? undefined : art.bytes)
  return true
}

export async function handleLegacyArtRequest (req, res, url, state, cors) {
  if (req.method !== 'GET') return false
  const match = url.pathname.match(LEGACY_ART_PATH)
  if (!match) return false
  const [, kind, tt] = match
  let card = null
  try {
    if (state.node?.meta?.getCard) card = await state.node.meta.getCard(`imdb:${tt}`)
  } catch (err) {
    void err
    card = null
  }
  let hash = kind === 'poster' ? card?.posterHash : (card?.backdropHash || '')
  if (kind === 'backdrop' && !hash && state.node?.meta?.getDetail) {
    try {
      const detail = await state.node.meta.getDetail(`imdb:${tt}`)
      hash = detail?.backdropHash || ''
    } catch (err) {
      void err
    }
  }
  if (kind === 'backdrop' && !hash) hash = card?.posterHash || ''
  if (hash && HEX64_LOWER.test(hash)) {
    res.writeHead(302, { ...cors, location: `/v1/art/${hash}`, 'cache-control': 'public, max-age=86400' })
    res.end()
    return true
  }
  if (isClearnetMetaBlocked(state)) {
    res.writeHead(404, cors)
    res.end()
    return true
  }
  const lookup = kind === 'poster' ? state.posterUrl : state.backdropUrl
  let art = null
  if (lookup) {
    try {
      art = await lookup(tt)
    } catch (err) {
      void err
      art = null
    }
  }
  const headers = art ? { ...cors, location: art, 'cache-control': 'max-age=86400' } : cors
  res.writeHead(art ? 302 : 404, headers)
  res.end()
  return true
}

async function postMetaSources (req, state, { body, requireNode, srv }) {
  const n = requireNode(state.node)
  if (!n.meta) throw Object.assign(new Error('Metadata subsystem unavailable'), { status: 503 })
  const payload = await body(req)
  const hasSource = Boolean(payload?.uri || payload?.key)
  const hasP2p = typeof payload?.p2pOnlyMetadata === 'boolean'
  const hasSeed = typeof payload?.seedFullMetadata === 'boolean'
  if (!hasSource && !hasP2p && !hasSeed) {
    throw Object.assign(new Error('uri, key, p2pOnlyMetadata, or seedFullMetadata is required'), { status: 400 })
  }
  let source = null
  if (hasSource) {
    const spec = payload.uri || payload.key
    const opts = {}
    if (payload.alias !== undefined) opts.alias = payload.alias
    if (payload.seedFull !== undefined) opts.seedFull = Boolean(payload.seedFull)
    source = await n.meta.addSource(spec, opts)
  }
  if (hasP2p) n.meta.setP2pOnly?.(payload.p2pOnlyMetadata)
  if (hasSeed) n.meta.setSeedFull?.(payload.seedFullMetadata)
  const sources = n.meta.listSources()
  if (hasSource) await state.onMetaSourcesChanged?.(sources)
  if (state.settings && (hasP2p || hasSeed)) {
    const patch = {}
    if (hasP2p) patch.p2pOnlyMetadata = payload.p2pOnlyMetadata
    if (hasSeed) patch.seedFullMetadata = payload.seedFullMetadata
    try { state.settings.update(patch) } catch (err) { void err }
  }
  srv.notify('update')
  return {
    ...(source ? { source } : {}),
    sources,
    p2pOnlyMetadata: isClearnetMetaBlocked(state),
    seedFullMetadata: Boolean(n.meta.isSeedFull?.())
  }
}

export async function handleMetaApiRoute (req, url, state, { body, requireNode, srv }) {
  const path = url.pathname
  if (!path.startsWith('/v1/meta/')) return undefined
  const meta = state.node?.meta

  if (req.method === 'GET' && path === '/v1/meta/sources') {
    return {
      sources: meta?.listSources?.() || [],
      p2pOnlyMetadata: isClearnetMetaBlocked(state),
      seedFullMetadata: Boolean(meta?.isSeedFull?.())
    }
  }
  if (req.method === 'POST' && path === '/v1/meta/sources') {
    return postMetaSources(req, state, { body, requireNode, srv })
  }
  const delMatch = req.method === 'DELETE' && path.match(META_SOURCE_DEL_PATH)
  if (delMatch) {
    const n = requireNode(state.node)
    if (!n.meta) throw Object.assign(new Error('Metadata subsystem unavailable'), { status: 503 })
    const res = await n.meta.removeSource(delMatch[1].toLowerCase())
    const sources = n.meta.listSources()
    await state.onMetaSourcesChanged?.(sources)
    srv.notify('update')
    return { ...res, sources }
  }
  if (req.method === 'GET' && path === '/v1/meta/search') {
    const kind = (url.searchParams.get('kind') || '').trim().toLowerCase()
    const q = url.searchParams.get('q') || ''
    const rawLimit = Number(url.searchParams.get('limit'))
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 64) : 20
    const raw = meta?.searchIndex ? await meta.searchIndex(kind, q, { limit }) : []
    const list = Array.isArray(raw) ? raw : (raw?.hits || [])
    const hits = list.map(h => ({
      ...h,
      thumbHash: h.thumbHash?.byteLength ? b4a.toString(h.thumbHash, 'base64') : '',
      posterUrl: h.posterHash ? `/v1/art/${h.posterHash}` : null
    }))
    return { hits, source: list[0]?.source ?? raw?.source ?? null }
  }
  const cardMatch = req.method === 'GET' && path.match(META_CARD_PATH)
  if (cardMatch) {
    const id = canonicalMetaId(decodePart(cardMatch[1], 'metadata id'))
    if (!id || !meta?.getCard) return null
    const card = await meta.getCard(id)
    return card ? serializeCard(card) : null
  }
  const detailMatch = req.method === 'GET' && path.match(META_DETAIL_PATH)
  if (detailMatch) {
    const id = canonicalMetaId(decodePart(detailMatch[1], 'metadata id'))
    if (!id || !meta?.getDetail) return null
    const detail = await meta.getDetail(id)
    return detail ? serializeDetail(detail) : null
  }
  const listMatch = req.method === 'GET' && path.match(META_LIST_PATH)
  if (listMatch) {
    const kind = decodePart(listMatch[1], 'metadata kind').trim().toLowerCase()
    const slug = decodePart(listMatch[2], 'metadata slug').trim().toLowerCase()
    if (!kind || !slug || !meta?.getList) return null
    const list = await meta.getList(kind, slug)
    if (!list) return null
    return {
      ...list,
      cards: (list.cards || []).map(c => serializeCard(c, c.source ?? list.source ?? null)),
      source: list.source ?? null
    }
  }
  return undefined
}
