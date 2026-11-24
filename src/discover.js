// Creator discovery and feed controller for PearTube peers and relays:
//   - Persists followed creators (YouTube, SoundCloud, Rumble) privately in `<storage>/discover.json` (0600)
//   - Fetches public feeds via injected SSRF-guarded `fetchBytes` and proxies thumbnails through `/v1/discover/thumb/:token`
//   - Supports on-demand browsing (`browse`) over YouTube, SoundCloud, and Rumble via the peer's mirror host
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseRumbleSearchHtml } from './providers/rumble.js'
import {
  BROWSER_HEADERS,
  DISCOVER_SOURCES,
  DISCOVER_SOURCE_SET,
  acquireIdFor,
  asText,
  browseRowToItem,
  buildLibraryMatcher,
  detectSourceFromInput,
  extractClientId,
  extractScScripts,
  extractYoutubeChannelId,
  metaContent,
  normText,
  parseRssItems,
  parseYoutubeFeedXml,
  scArtwork,
  sha256Hex
} from './discover-feeds.js'

export { DISCOVER_SOURCES, parseYoutubeFeedXml }

const MAX_CREATORS = 200
const FEED_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 12_000
const THUMB_MAX_BYTES = 512 * 1024
const THUMB_URLS_MAX = 512
const THUMB_CACHE_MAX = 256
const THUMB_TOKEN = /^[0-9a-f]{20}$/
const IMAGE_MIME = /^image\/(jpeg|png|webp|gif)\b/i

function loadSaved (file) {
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(parsed?.creators) ? parsed.creators : []
    return list.filter(c => c && DISCOVER_SOURCE_SET.has(c.source) && typeof c.id === 'string' && typeof c.url === 'string')
  } catch {
    return []
  }
}

function saveCreators (file, creators) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, JSON.stringify({ version: 1, creators }, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

async function runPool (items, concurrency, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return results
}

export function createDiscover ({
  storage,
  fetchBytes = null,
  getMirror = null,
  getEntries = null,
  youtubeSiteBase = 'https://www.youtube.com',
  youtubeFeedBase = 'https://www.youtube.com/feeds/videos.xml',
  soundcloudSiteBase = 'https://soundcloud.com',
  soundcloudApiBase = 'https://api-v2.soundcloud.com',
  rumbleSiteOrigin = 'https://rumble.com',
  now = () => Date.now(),
  onchange = null
}) {
  const file = join(storage, 'discover.json')
  const thumbUrls = new Map()
  const thumbCache = new Map()
  const feedCache = new Map()
  let scClientId = null

  function registerThumb (rawUrl) {
    if (typeof rawUrl !== 'string' || !/^https?:\/\//i.test(rawUrl)) return ''
    const token = sha256Hex(rawUrl).slice(0, 20)
    thumbUrls.set(token, rawUrl)
    while (thumbUrls.size > THUMB_URLS_MAX) thumbUrls.delete(thumbUrls.keys().next().value)
    return `/v1/discover/thumb/${token}`
  }

  function hydrateCreator (c) {
    return {
      id: c.id,
      source: c.source,
      handle: c.handle || '',
      name: c.name || c.handle || c.id,
      url: c.url,
      channelId: c.channelId || '',
      avatar: c.avatarUrl ? registerThumb(c.avatarUrl) : (c.avatar || ''),
      followedAt: Number(c.followedAt) || 0
    }
  }

  let creators = loadSaved(file)
  for (const c of creators) {
    if (c.avatarUrl) registerThumb(c.avatarUrl)
  }

  const persist = () => { saveCreators(file, creators); onchange?.() }
  const requireFetch = () => {
    if (typeof fetchBytes !== 'function') {
      throw Object.assign(new Error('Network fetch is not available on this device'), { status: 503 })
    }
    return fetchBytes
  }

  async function ensureScClientId (forceRefresh = false) {
    if (scClientId && !forceRefresh) return scClientId
    const fetch = requireFetch()
    const res = await fetch(soundcloudSiteBase, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024, headers: { accept: 'text/html' } })
    if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`SoundCloud homepage answered ${res.status}`), { status: 502 })
    const html = asText(res.body)
    const inline = extractClientId(html)
    if (inline) { scClientId = inline; return inline }
    for (const src of extractScScripts(html, soundcloudSiteBase).slice(-8).reverse()) {
      try {
        const sRes = await fetch(src, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: 6 * 1024 * 1024 })
        if (sRes.status !== 200) continue
        const found = extractClientId(asText(sRes.body))
        if (found) { scClientId = found; return found }
      } catch {
        continue
      }
    }
    throw Object.assign(new Error('Could not find a SoundCloud client_id'), { status: 502 })
  }

  async function scApiGet (pathAndQuery) {
    const fetch = requireFetch()
    const base = soundcloudApiBase.replace(/\/+$/, '')
    for (let attempt = 0; attempt < 2; attempt++) {
      const cid = await ensureScClientId(attempt > 0)
      const sep = pathAndQuery.includes('?') ? '&' : '?'
      const url = `${base}${pathAndQuery}${sep}client_id=${encodeURIComponent(cid)}`
      const res = await fetch(url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: 2 * 1024 * 1024, headers: { accept: 'application/json' } })
      if ((res.status === 401 || res.status === 403) && attempt === 0) { scClientId = null; continue }
      if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`SoundCloud answered ${res.status}`), { status: 502 })
      try { return JSON.parse(asText(res.body)) } catch {
        throw Object.assign(new Error('SoundCloud returned invalid JSON'), { status: 502 })
      }
    }
    throw Object.assign(new Error('SoundCloud authorization failed'), { status: 502 })
  }

  async function resolveYoutubeCreator (info, fallbackName) {
    const fetch = requireFetch()
    let channelId = info.channelId || ''
    let handle = info.handle || ''
    let name = fallbackName || ''
    let avatarUrl = ''
    const pathMatch = info.parsed?.pathname?.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})/)
    if (pathMatch) channelId = pathMatch[1]
    const handleMatch = info.parsed?.pathname?.match(/^\/(@[^/?#]+)/)
    if (handleMatch) handle = handleMatch[1]

    if (!channelId) {
      const target = info.url.startsWith('http') ? info.url : `${youtubeSiteBase.replace(/\/+$/, '')}/${handle}`
      const isWatch = /\/watch\b|youtu\.be\//i.test(target)
      const res = await fetch(target, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024, headers: BROWSER_HEADERS })
      if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`YouTube answered ${res.status}`), { status: 502 })
      const html = asText(res.body)
      channelId = extractYoutubeChannelId(html, isWatch)
      if (!channelId) throw Object.assign(new Error('Could not find a YouTube channel ID for that link'), { status: 400 })
      if (!isWatch) {
        name = metaContent(html, 'og:title') || name
        avatarUrl = metaContent(html, 'og:image') || avatarUrl
      } else {
        const authorMatch = /"videoDetails"\s*:\s*\{[^}]{0,1200}?"author"\s*:\s*"([^"]+)"/.exec(html)
        if (authorMatch) name = authorMatch[1]
      }
    }
    if (!name) {
      try {
        const res = await fetch(`${youtubeFeedBase}?channel_id=${encodeURIComponent(channelId)}`, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: 1024 * 1024 })
        if (res.status >= 200 && res.status < 300) {
          const parsed = parseYoutubeFeedXml(asText(res.body), null, null)
          if (parsed.feedTitle) name = parsed.feedTitle
        }
      } catch {
        name = handle || channelId
      }
    }
    return {
      id: `youtube:${channelId}`,
      source: 'youtube',
      handle,
      name: (name || handle || channelId).slice(0, 120),
      url: `${youtubeSiteBase.replace(/\/+$/, '')}/channel/${channelId}`,
      channelId,
      avatarUrl,
      followedAt: now()
    }
  }

  async function resolveSoundcloudCreator (info, fallbackName) {
    const resolved = await scApiGet(`/resolve?url=${encodeURIComponent(info.url)}`)
    const user = resolved?.kind === 'user' ? resolved : resolved?.user
    const uid = String(user?.id ?? '').trim()
    if (!uid) throw Object.assign(new Error('Could not resolve a SoundCloud artist from that link'), { status: 400 })
    const permalink = String(user?.permalink || '').trim()
    const url = typeof user?.permalink_url === 'string' && /^https?:\/\//i.test(user.permalink_url)
      ? user.permalink_url
      : `${soundcloudSiteBase.replace(/\/+$/, '')}/${permalink || uid}`
    return {
      id: `soundcloud:${uid}`,
      source: 'soundcloud',
      handle: permalink ? `@${permalink}` : '',
      name: String(user?.username || user?.full_name || fallbackName || uid).trim().slice(0, 120),
      url,
      channelId: uid,
      avatarUrl: scArtwork(user?.avatar_url),
      followedAt: now()
    }
  }

  async function resolveRumbleCreator (info, fallbackName) {
    const m = /^\/(c|user)\/([^/?#]+)/i.exec(info.parsed?.pathname || '')
    if (!m) throw Object.assign(new Error('Use a Rumble channel link like https://rumble.com/c/<channel>'), { status: 400 })
    const kind = m[1].toLowerCase()
    const slug = m[2]
    const canonical = `${rumbleSiteOrigin.replace(/\/+$/, '')}/${kind}/${slug}`
    let name = fallbackName || slug
    let avatarUrl = ''
    if (typeof fetchBytes === 'function') {
      try {
        const res = await fetchBytes(canonical, { timeoutMs: 8000, maxBytes: 2 * 1024 * 1024, headers: BROWSER_HEADERS })
        if (res.status >= 200 && res.status < 300) {
          const html = asText(res.body)
          const og = metaContent(html, 'og:title')
          if (og) name = og.replace(/\s*-\s*Rumble$/i, '').trim() || name
          avatarUrl = metaContent(html, 'og:image') || ''
        }
      } catch {
        avatarUrl = ''
      }
    }
    return {
      id: `rumble:${kind}/${slug.toLowerCase()}`,
      source: 'rumble',
      handle: slug,
      name: name.slice(0, 120),
      url: canonical,
      channelId: `${kind}/${slug}`,
      avatarUrl,
      followedAt: now()
    }
  }

  function listCreators () {
    return { creators: creators.map(hydrateCreator) }
  }

  async function followCreator (payload = {}) {
    const rawUrl = String(payload.url || payload.handle || '').trim()
    const explicitSource = String(payload.source || '').trim().toLowerCase()
    const fallbackName = String(payload.name || '').trim().slice(0, 120)
    let record
    if (explicitSource && DISCOVER_SOURCE_SET.has(explicitSource) && payload.channelId && rawUrl) {
      const cid = String(payload.channelId).trim()
      record = {
        id: `${explicitSource}:${cid}`,
        source: explicitSource,
        handle: String(payload.handle || '').trim().slice(0, 80),
        name: (fallbackName || cid).slice(0, 120),
        url: rawUrl,
        channelId: cid,
        avatarUrl: typeof payload.avatarUrl === 'string' ? payload.avatarUrl : '',
        followedAt: now()
      }
    } else {
      const detected = detectSourceFromInput(rawUrl)
      if (!detected) throw Object.assign(new Error('Paste a YouTube (@handle or channel link), SoundCloud artist link, or Rumble channel link'), { status: 400 })
      if (detected.source === 'youtube') record = await resolveYoutubeCreator(detected, fallbackName)
      else if (detected.source === 'soundcloud') record = await resolveSoundcloudCreator(detected, fallbackName)
      else record = await resolveRumbleCreator(detected, fallbackName)
    }
    const idx = creators.findIndex(c => c.id === record.id)
    if (idx >= 0) {
      record.followedAt = creators[idx].followedAt || record.followedAt
      creators[idx] = record
    } else {
      if (creators.length >= MAX_CREATORS) throw Object.assign(new Error(`You can follow at most ${MAX_CREATORS} creators`), { status: 400 })
      creators.unshift(record)
    }
    feedCache.delete(record.id)
    persist()
    return { creator: hydrateCreator(record), creators: listCreators().creators }
  }

  function unfollowCreator (rawId) {
    const id = decodeURIComponent(String(rawId || '')).trim()
    const before = creators.length
    creators = creators.filter(c => c.id !== id)
    feedCache.delete(id)
    if (creators.length !== before) persist()
    return { removed: creators.length !== before, creators: listCreators().creators }
  }

  async function fetchSoundcloudItems (creator) {
    const data = await scApiGet(`/users/${encodeURIComponent(creator.channelId)}/tracks?limit=12`)
    let list = []
    if (Array.isArray(data?.collection)) list = data.collection
    else if (Array.isArray(data)) list = data
    const items = []
    for (const e of list) {
      const trackId = String(e?.id ?? '').trim()
      const url = typeof e?.permalink_url === 'string' ? e.permalink_url : ''
      if (!trackId || !/^https?:\/\//i.test(url)) continue
      const title = String(e?.title || trackId).trim().slice(0, 300)
      const artist = String(e?.user?.username || creator.name).trim().slice(0, 120)
      const durMs = Number(e?.duration ?? e?.full_duration)
      const pubMs = e?.created_at ? Date.parse(e.created_at) : NaN
      const rawArt = scArtwork(e?.artwork_url || e?.user?.avatar_url)
      items.push({
        id: `soundcloud:${trackId}`,
        source: 'soundcloud',
        kind: 'audio',
        itemId: trackId,
        title,
        creatorId: creator.id,
        creatorName: artist,
        creatorUrl: creator.url,
        url,
        thumbnail: rawArt ? registerThumb(rawArt) : '',
        duration: Number.isFinite(durMs) && durMs > 0 ? Math.round(durMs / 1000) : null,
        publishedAt: Number.isFinite(pubMs) ? pubMs : 0,
        acquireId: acquireIdFor('soundcloud', url),
        audioOnly: true,
        music: { title, artist },
        inLibrary: false
      })
    }
    return items
  }

  async function fetchCreatorItems (creator) {
    const fetch = requireFetch()
    if (creator.source === 'youtube') {
      const res = await fetch(`${youtubeFeedBase}?channel_id=${encodeURIComponent(creator.channelId)}`, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: 1024 * 1024 })
      if (res.status < 200 || res.status >= 300) throw new Error(`YouTube feed answered ${res.status}`)
      return parseYoutubeFeedXml(asText(res.body), creator, registerThumb).items
    }
    if (creator.source === 'soundcloud') return fetchSoundcloudItems(creator)
    const res = await fetch(creator.url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: 2 * 1024 * 1024, headers: BROWSER_HEADERS })
    if (res.status < 200 || res.status >= 300) throw new Error(`Rumble answered ${res.status}`)
    const body = asText(res.body)
    if (/^\s*<\?xml|^\s*<rss\b/i.test(body)) return parseRssItems(body, creator, registerThumb)
    const thumbs = new Map()
    const rows = parseRumbleSearchHtml(body, { limit: 15, siteOrigin: rumbleSiteOrigin, thumbUrls: thumbs })
    return rows.map(row => ({
      id: `rumble:${row.rumbleId}`,
      source: 'rumble',
      kind: 'video',
      itemId: row.rumbleId,
      title: row.title,
      creatorId: creator.id,
      creatorName: row.channel || creator.name,
      creatorUrl: creator.url,
      url: row.url,
      thumbnail: thumbs.has(row.rumbleId) ? registerThumb(thumbs.get(row.rumbleId)) : '',
      duration: row.length ?? null,
      publishedAt: 0,
      acquireId: acquireIdFor('rumble', row.url),
      audioOnly: false,
      music: null,
      inLibrary: false
    }))
  }

  async function feed ({ source = '', creator: creatorFilter = '', refresh = false, limit = 40 } = {}) {
    const srcFilter = String(source || '').trim().toLowerCase()
    const cidFilter = String(creatorFilter || '').trim()
    const cap = Math.max(1, Math.min(100, Math.trunc(Number(limit)) || 40))
    const selected = creators.filter(c => (!srcFilter || c.source === srcFilter) && (!cidFilter || c.id === cidFilter))
    const errors = []
    const tNow = now()
    const batches = await runPool(selected, 4, async c => {
      const cached = feedCache.get(c.id)
      if (!refresh && cached && (tNow - cached.at) < FEED_TTL_MS) return cached.items
      try {
        const items = await fetchCreatorItems(c)
        feedCache.set(c.id, { at: tNow, items })
        return items
      } catch (err) {
        errors.push({ creatorId: c.id, source: c.source, name: c.name, message: String(err?.message || err).slice(0, 200) })
        return cached ? cached.items : []
      }
    })
    const entries = typeof getEntries === 'function' ? await Promise.resolve(getEntries()).catch(() => []) : []
    const inLib = buildLibraryMatcher(entries)
    const merged = []
    const seen = new Set()
    for (const batch of batches) {
      for (const item of batch) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        merged.push({ ...item, inLibrary: inLib(item) })
      }
    }
    merged.sort((a, b) => (b.publishedAt - a.publishedAt) || a.title.localeCompare(b.title))
    return { creators: creators.map(hydrateCreator), items: merged.slice(0, cap), errors, updatedAt: tNow }
  }

  async function browse ({ query = '', sources = DISCOVER_SOURCES, limit = 12 } = {}) {
    const q = String(query || '').trim().slice(0, 200)
    if (!q) throw Object.assign(new Error('query is required'), { status: 400 })
    const mirror = typeof getMirror === 'function' ? getMirror() : null
    if (!mirror || typeof mirror.searchSources !== 'function') {
      throw Object.assign(new Error('Source search is not available on this device'), { status: 503 })
    }
    const picked = (Array.isArray(sources) ? sources : DISCOVER_SOURCES)
      .map(s => String(s || '').trim().toLowerCase())
      .filter(s => DISCOVER_SOURCE_SET.has(s))
    const activeSources = picked.length ? picked : DISCOVER_SOURCES
    const cap = Math.max(1, Math.min(20, Math.trunc(Number(limit)) || 12))
    const res = await mirror.searchSources({ query: q, sources: activeSources, limit: cap })
    const entries = typeof getEntries === 'function' ? await Promise.resolve(getEntries()).catch(() => []) : []
    const inLib = buildLibraryMatcher(entries)
    const items = []
    const creatorMap = new Map()
    const followedUrls = new Set(creators.map(c => c.url.toLowerCase()))
    const followedNames = new Set(creators.map(c => `${c.source}:${normText(c.name)}`))
    for (const row of Array.isArray(res?.results) ? res.results : []) {
      if (!DISCOVER_SOURCE_SET.has(row?.source) || !row?.url) continue
      const item = browseRowToItem(row, inLib, soundcloudSiteBase)
      items.push(item)
      const cKey = `${item.source}:${normText(item.creatorName)}`
      if (item.creatorUrl && !creatorMap.has(cKey) && item.creatorName !== 'YouTube' && item.creatorName !== 'Rumble') {
        creatorMap.set(cKey, {
          id: item.creatorId,
          source: item.source,
          handle: '',
          name: item.creatorName,
          url: item.creatorUrl,
          channelId: '',
          avatar: item.thumbnail,
          followedAt: 0,
          followed: followedUrls.has(item.creatorUrl.toLowerCase()) || followedNames.has(cKey)
        })
      }
    }
    return { query: q, sources: activeSources, creators: [...creatorMap.values()].slice(0, 12), items, errors: Array.isArray(res?.errors) ? res.errors : [] }
  }

  async function thumb (token) {
    if (!THUMB_TOKEN.test(String(token || ''))) return null
    const cached = thumbCache.get(token)
    if (cached) return cached
    const url = thumbUrls.get(token)
    if (!url || typeof fetchBytes !== 'function') return null
    let res
    try { res = await fetchBytes(url, { timeoutMs: 8000, maxBytes: THUMB_MAX_BYTES }) } catch { return null }
    if (!res || res.status !== 200 || !res.body || res.body.byteLength === 0 || res.body.byteLength > THUMB_MAX_BYTES) return null
    const rawType = String(res.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (!IMAGE_MIME.test(rawType)) return null
    const entry = { type: rawType, bytes: res.body }
    thumbCache.set(token, entry)
    while (thumbCache.size > THUMB_CACHE_MAX) thumbCache.delete(thumbCache.keys().next().value)
    return entry
  }

  return { listCreators, followCreator, unfollowCreator, feed, browse, thumb }
}
