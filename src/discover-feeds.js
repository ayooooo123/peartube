// Pure parsers and normalizers for creator discovery (YouTube Atom RSS, SoundCloud tracks, Rumble HTML/RSS).
import { createHash } from 'node:crypto'
import b4a from 'b4a'

export const DISCOVER_SOURCES = ['youtube', 'soundcloud', 'rumble']
export const DISCOVER_SOURCE_SET = new Set(DISCOVER_SOURCES)
export const YT_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/
export const YT_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
export const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
}

const CLIENT_ID_PATTERNS = [
  /client_id\s*[:=]\s*["']([A-Za-z0-9_-]{16,64})["']/,
  /client_id=([A-Za-z0-9_-]{16,64})/
]

export const sha256Hex = s => createHash('sha256').update(String(s)).digest('hex')
export const asText = body => (typeof body === 'string' ? body : body ? b4a.toString(body, 'utf8') : '')
export const normText = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function decodeEntities (raw) {
  return String(raw || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const cp = Number(n)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => {
      const cp = parseInt(h, 16)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    })
}

export function xmlTag (block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const m = re.exec(block)
  return m ? decodeEntities(m[1]).trim() : ''
}

export function xmlAttr (block, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["'][^>]*>`, 'i')
  const m = re.exec(block)
  return m ? decodeEntities(m[1]).trim() : ''
}

export function metaContent (html, prop) {
  const p = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const a = new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']+)["']`, 'i').exec(html)
  if (a) return decodeEntities(a[1]).trim()
  const b = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${p}["']`, 'i').exec(html)
  return b ? decodeEntities(b[1]).trim() : ''
}

export function acquireIdFor (source, url) {
  const hash = sha256Hex(url)
  return source === 'soundcloud' ? `sc:${hash.slice(0, 12)}:s01e01` : `clip:${hash.slice(0, 16)}`
}

export function parseYoutubeFeedXml (xml, creator, registerThumb = null) {
  const text = String(xml || '')
  const feedTitle = xmlTag(text.split('<entry')[0] || '', 'title')
  const items = []
  const seen = new Set()
  for (const part of text.split(/<entry(?:\s[^>]*)?>/i).slice(1)) {
    const entry = part.split(/<\/entry>/i)[0] || ''
    const videoId = xmlTag(entry, 'yt:videoId')
    if (!YT_VIDEO_ID.test(videoId) || seen.has(videoId)) continue
    seen.add(videoId)
    const title = (xmlTag(entry, 'media:title') || xmlTag(entry, 'title') || videoId).slice(0, 300)
    const author = (xmlTag(entry, 'name') || creator?.name || feedTitle || 'YouTube creator').slice(0, 120)
    const pubRaw = xmlTag(entry, 'published') || xmlTag(entry, 'updated')
    const pubMs = pubRaw ? Date.parse(pubRaw) : NaN
    const url = `https://www.youtube.com/watch?v=${videoId}`
    const rawThumb = xmlAttr(entry, 'media:thumbnail', 'url') || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    const chanId = xmlTag(entry, 'yt:channelId') || creator?.channelId || ''
    items.push({
      id: `youtube:${videoId}`,
      source: 'youtube',
      kind: 'video',
      itemId: videoId,
      title,
      creatorId: creator?.id || (chanId ? `youtube:${chanId}` : ''),
      creatorName: author,
      creatorUrl: creator?.url || (chanId ? `https://www.youtube.com/channel/${chanId}` : ''),
      url,
      thumbnail: registerThumb ? registerThumb(rawThumb) : '',
      duration: null,
      publishedAt: Number.isFinite(pubMs) ? pubMs : 0,
      acquireId: acquireIdFor('youtube', url),
      audioOnly: false,
      music: null,
      inLibrary: false
    })
  }
  return { feedTitle, items }
}

export function parseRssItems (xml, creator, registerThumb) {
  const items = []
  for (const part of String(xml || '').split(/<item(?:\s[^>]*)?>/i).slice(1)) {
    const chunk = part.split(/<\/item>/i)[0] || ''
    const url = xmlTag(chunk, 'link')
    if (!/^https?:\/\//i.test(url)) continue
    const title = (xmlTag(chunk, 'title') || url).slice(0, 300)
    const pubRaw = xmlTag(chunk, 'pubDate')
    const pubMs = pubRaw ? Date.parse(pubRaw) : NaN
    const thumbRaw = xmlAttr(chunk, 'media:thumbnail', 'url') || xmlAttr(chunk, 'enclosure', 'url')
    const itemId = sha256Hex(url).slice(0, 12)
    items.push({
      id: `${creator.source}:${itemId}`,
      source: creator.source,
      kind: 'video',
      itemId,
      title,
      creatorId: creator.id,
      creatorName: creator.name,
      creatorUrl: creator.url,
      url,
      thumbnail: thumbRaw && /^https?:\/\//i.test(thumbRaw) ? registerThumb(thumbRaw) : '',
      duration: null,
      publishedAt: Number.isFinite(pubMs) ? pubMs : 0,
      acquireId: acquireIdFor(creator.source, url),
      audioOnly: false,
      music: null,
      inLibrary: false
    })
  }
  return items
}

export function detectSourceFromInput (rawInput) {
  const trimmed = String(rawInput || '').trim()
  if (!trimmed) return null
  if (trimmed.startsWith('@') && !/\s/.test(trimmed)) {
    return { source: 'youtube', url: `https://www.youtube.com/${trimmed}`, handle: trimmed }
  }
  if (YT_CHANNEL_ID.test(trimmed)) {
    return { source: 'youtube', url: `https://www.youtube.com/channel/${trimmed}`, channelId: trimmed }
  }
  let u
  try { u = new URL(trimmed) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '')
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') return { source: 'youtube', url: u.href, parsed: u }
  if (host === 'soundcloud.com' || host === 'on.soundcloud.com') return { source: 'soundcloud', url: u.href, parsed: u }
  if (host === 'rumble.com') return { source: 'rumble', url: u.href, parsed: u }
  return null
}

export function extractYoutubeChannelId (html, isWatchPage) {
  if (!isWatchPage) {
    const canonical = /<link[^>]+rel=["']canonical["'][^>]+href=["']https?:\/\/(?:www\.)?youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})["']/i.exec(html)
    if (canonical) return canonical[1]
    const linkChan = /youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/i.exec(html)
    if (linkChan) return linkChan[1]
    const ext = /"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/.exec(html)
    if (ext) return ext[1]
  }
  const vidChan = /"videoDetails"\s*:\s*\{[^}]{0,1200}?"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/.exec(html)
  if (vidChan) return vidChan[1]
  const chan = /"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/.exec(html)
  if (chan) return chan[1]
  const browse = /"browseId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/.exec(html)
  return browse ? browse[1] : ''
}

export function extractClientId (text) {
  for (const re of CLIENT_ID_PATTERNS) {
    const m = re.exec(text)
    if (m && m[1]) return m[1]
  }
  return null
}

export function extractScScripts (html, siteBase) {
  const urls = []
  const seen = new Set()
  const re = /<script[^>]+src=["']([^"']+\.js(?:\?[^"']*)?)["']/gi
  let m
  while ((m = re.exec(html)) !== null) {
    let resolved
    try { resolved = new URL(m[1], siteBase).href } catch { continue }
    if (!/sndcdn\.com\/assets\/|\/assets\/[^/]+\.js/i.test(resolved) || seen.has(resolved)) continue
    seen.add(resolved)
    urls.push(resolved)
  }
  return urls
}

export function scArtwork (raw) {
  if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw)) return ''
  return /sndcdn\.com/i.test(raw) ? raw.replace(/-large\.(jpg|jpeg|png|webp)$/i, '-t300x300.$1') : raw
}

export function buildLibraryMatcher (entries) {
  const ids = new Set()
  const titles = new Set()
  for (const e of Array.isArray(entries) ? entries : []) {
    if (typeof e?.id === 'string' && e.id) ids.add(e.id.toLowerCase())
    const title = normText(e?.music?.title || e?.title)
    if (title) titles.add(title)
  }
  return item => {
    if (item.acquireId && ids.has(item.acquireId.toLowerCase())) return true
    const t = normText(item.title)
    return Boolean(t && titles.has(t))
  }
}

export function browseRowToItem (row, inLib, soundcloudSiteBase) {
  const source = row.source
  const url = String(row.url || '')
  const itemId = String(row.videoId || row.trackId || row.rumbleId || sha256Hex(url).slice(0, 12))
  const title = String(row.title || itemId).trim().slice(0, 300)
  const isAudio = source === 'soundcloud'
  let creatorName = String(row.artist || row.channel || '').trim().slice(0, 120)
  let creatorUrl = ''
  if (source === 'soundcloud') {
    try {
      const seg = new URL(url).pathname.split('/').filter(Boolean)[0]
      if (seg) {
        creatorUrl = `${soundcloudSiteBase.replace(/\/+$/, '')}/${seg}`
        if (!creatorName) creatorName = seg
      }
    } catch {
      // Ignore malformed URLs when deriving creator profile path.
    }
  } else if (source === 'youtube' && url) {
    creatorUrl = url
  }
  const fallbackName = source === 'youtube' ? 'YouTube' : source === 'soundcloud' ? 'SoundCloud' : 'Rumble'
  const item = {
    id: `${source}:${itemId}`,
    source,
    kind: isAudio ? 'audio' : 'video',
    itemId,
    title,
    creatorId: creatorUrl ? `${source}:${sha256Hex(creatorUrl).slice(0, 12)}` : '',
    creatorName: creatorName || fallbackName,
    creatorUrl,
    url,
    thumbnail: String(row.thumbnail || ''),
    duration: Number.isFinite(Number(row.length)) ? Number(row.length) : null,
    publishedAt: 0,
    acquireId: acquireIdFor(source, url),
    audioOnly: isAudio,
    music: isAudio ? { title, artist: creatorName || 'SoundCloud' } : null,
    inLibrary: false
  }
  item.inLibrary = inLib(item)
  return item
}
