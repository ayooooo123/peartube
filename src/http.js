import { createServer, request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import b4a from 'b4a'
import { page } from './ui.js'
import { mediaInfo, resolutionLabel } from './resolution.js'
import { MEDIA_FILE, ipv6Groups, mediaFormat, parseUri, safeEqual } from './protocol.js'

const MAX_BODY = 64 * 1024
// Loopback, RFC 1918, CGNAT/Tailscale (100.64/10), link-local, and IPv6 ULA/link-local, plain or IPv4-mapped.
const PRIVATE_ADDR = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)|^(::1$|f[cd][0-9a-f]{2}:|fe80:)/i
// bare-https wraps bare-tcp in HTTPSSocket without forwarding remoteAddress; unwrap .socket so LAN settings work over TLS.
const remoteAddr = req => req.socket?.remoteAddress || req.socket?.socket?.remoteAddress || ''
const reqProto = req => (req.socket?.encrypted || (PRIVATE_ADDR.test(remoteAddr(req)) && req.headers['x-forwarded-proto'] === 'https')) ? 'https' : 'http'
// Players, Stremio clients and M3U readers on other origins may read (GET/HEAD); nothing else crosses origins. Writes
// and the owner's routes (settings, identity) answer without Access-Control-Allow-Origin, and a preflight for any
// other method fails, so another site's page can neither drive the relay nor read those replies.
const CORP = { 'cross-origin-resource-policy': 'cross-origin' }
const CORS = {
  ...CORP,
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, range',
  'access-control-expose-headers': 'content-length, content-range, accept-ranges, content-disposition'
}
const ownerPath = path => path === '/v1/settings' || path === '/v1/restart' || path.startsWith('/v1/identity') || path.startsWith('/v1/discover')
const isWrite = req => req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE'
// On an open LAN relay (no token), a DNS-rebound page can send matching `Host` and `Origin` (`evil.example:8174`)
// to `127.0.0.1` or `10.x`. Only an IP literal, `localhost` or `.local` counts as the relay's own host without a token.
const ipv4Literal = h => {
  const p = h.split('.')
  return p.length === 4 && p.every(s => /^\d{1,3}$/.test(s) && Number(s) <= 255)
}
const localHost = raw => {
  if (!raw) return false
  try {
    const h = new URL(`http://${raw}`).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return h === 'localhost' || h.endsWith('.local') || ipv4Literal(h) || Boolean(ipv6Groups(h))
  } catch { return false }
}
// A request from no page (curl, apps) or from the relay's own page; anything else is another site's page.
const sameOrigin = req => {
  const origin = req.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}
const ISOLATION = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless' }

// Caches compiled WASM player flesh in memory on first lick so browser streams open instantly on relays and daemons.
// The ETag is the bytes' SHA-256, so a rebuilt asset of the same size never answers 304.
const webCache = new Map()
function readWebAsset (name) {
  if (webCache.has(name)) return webCache.get(name)
  const candidates = []
  try { candidates.push(decodeURIComponent(new URL('../web/assets/' + name, import.meta.url).pathname)) } catch {}
  candidates.push(join('web', 'assets', name))
  for (const file of candidates) {
    let buf
    try { buf = readFileSync(file) } catch { continue }
    const asset = { buf, etag: '"' + createHash('sha256').update(buf).digest('hex').slice(0, 32) + '"' }
    webCache.set(name, asset)
    return asset
  }
  return null
}

function stremioToPearId (raw) {
  const clean = decodeURIComponent(raw).replace(/\.json$/i, '')
  if (/^tt\d+$/i.test(clean)) return `imdb:${clean.toLowerCase()}`
  const ep = clean.match(/^(tt\d+):(\d+):(\d+)$/i)
  if (ep) return `imdb:${ep[1].toLowerCase()}:s${ep[2].padStart(2, '0')}e${ep[3].padStart(2, '0')}`
  return clean.toLowerCase()
}

// Catalog items must be ids another addon (Cinemeta) can describe: this addon serves no `meta`, so a `clip:` tile
// would not open. A series is named after its show, not the first episode found.
function pearToStremioMeta (entry) {
  const ep = entry.id.match(/^imdb:(tt\d+):s\d{2}e\d{2,3}$/)
  if (ep) return { id: ep[1], type: 'series', name: entry.title.replace(/\s+S\d{2}E\d{2,3}$/i, '') }
  const mv = entry.id.match(/^imdb:(tt\d+)$/)
  return mv ? { id: mv[1], type: 'movie', name: entry.title } : null
}

// Bytes start..end of a stream, through the node's own blob server. Only a 206 is accepted: a server that ignores
// the range would send the whole video.
function readStream (host, port, search, start, end) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => req.destroy(new Error('Stream read timed out')), 4000)
    const fail = err => { clearTimeout(timer); reject(err) }
    const req = httpRequest({ host, port, path: '/' + search, headers: { range: `bytes=${start}-${end}` } }, res => {
      if (res.statusCode !== 206) { res.destroy(); fail(new Error(`Stream read returned ${res.statusCode}`)); return }
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.once('end', () => { clearTimeout(timer); resolve(b4a.concat(chunks)) })
      res.once('error', fail)
      res.once('close', () => { if (!res.complete) fail(new Error('Stream closed early')) })
    })
    req.once('error', fail)
    req.end()
  })
}

// The name and type a download is saved with, from the container its first bytes name (mediaFormat).
const DOWNLOAD_FORMATS = {
  mkv: { ext: '.mkv', mime: 'video/x-matroska' },
  webm: { ext: '.webm', mime: 'video/webm' },
  mp4: { ext: '.mp4', mime: 'video/mp4' },
  mov: { ext: '.mov', mime: 'video/quicktime' },
  avi: { ext: '.avi', mime: 'video/x-msvideo' },
  wav: { ext: '.wav', mime: 'audio/wav' },
  ogg: { ext: '.ogv', mime: 'video/ogg' },
  flac: { ext: '.flac', mime: 'audio/flac' },
  mp3: { ext: '.mp3', mime: 'audio/mpeg' },
  aac: { ext: '.aac', mime: 'audio/aac' },
  flv: { ext: '.flv', mime: 'video/x-flv' },
  wmv: { ext: '.wmv', mime: 'video/x-ms-wmv' },
  mpg: { ext: '.mpg', mime: 'video/mpeg' },
  ts: { ext: '.ts', mime: 'video/mp2t' },
  m2ts: { ext: '.m2ts', mime: 'video/mp2t' }
}
function sniffDownloadFormat (head) {
  return DOWNLOAD_FORMATS[mediaFormat(head)] || { ext: '.mkv', mime: 'application/octet-stream' }
}

function contentDispositionFor (rawTitle, ext) {
  const base = String(rawTitle || 'video').replace(/[/\\:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || 'video'
  const hasExt = MEDIA_FILE.test(base)
  const full = hasExt ? base : base + ext
  const ascii = full.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(full)}`
}

// Single HTTP surface for relays AND local client daemons: /v1 API, SSE events, Stremio v3 addon, and M3U playlist.
export function createApi (state) {
  const sse = new Set()
  // What each stream holds (container, duration, tracks), read once from its header. A header that could not be
  // read is tried again after 10 minutes: it may not have been reachable yet. At most 512 streams; the oldest goes.
  const mediaInfos = new Map()
  const downloadFormats = new Map()
  const globalSearches = new Map() // client address -> { key, at } of its newest global search
  // The blob server binds the interface the node gave it (loopback on a relay), so the /v1/blob proxy dials that.
  const blobHost = () => {
    const h = state.node?.blobServer?.host
    return !h || h === '0.0.0.0' || h === '::' ? '127.0.0.1' : h
  }
  // Every stream URL the API hands out goes through /v1/blob on the address the client reached: one port for
  // the relay, and clients that admit private addresses only for their configured add-on (MediaStorm) can play.
  const viaApi = (req, e) => req.headers.host && state.node?.blobServer && e.streamUrl
    ? { ...e, streamUrl: `${reqProto(req)}://${req.headers.host}/v1/blob${new URL(e.streamUrl).search}` }
    : e
  function mediaOf (streamUrl) {
    const port = state.node?.blobServer?.port
    if (!port) return Promise.resolve(null)
    const search = new URL(streamUrl).search
    const known = mediaInfos.get(search)
    if (known && (known.info || Date.now() - known.at < 600000)) return known.promise
    const record = { at: Date.now(), info: undefined }
    record.promise = mediaInfo((start, end) => readStream(blobHost(), port, search, start, end))
      .catch(() => null)
      .then(info => { record.info = info; return info })
    if (mediaInfos.size >= 512) mediaInfos.delete(mediaInfos.keys().next().value)
    mediaInfos.set(search, record)
    return record.promise
  }
  async function resolutionOf (entry) {
    const picture = (await mediaOf(entry.streamUrl))?.video.find(v => v.width && v.height)
    return picture ? resolutionLabel(picture) : null
  }

  async function body (req) {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 })
      chunks.push(chunk)
    }
    if (size === 0) return {}
    try { return JSON.parse(b4a.toString(b4a.concat(chunks))) } catch { throw Object.assign(new Error('Body must be JSON'), { status: 400 }) }
  }

  function requireNode (node) {
    if (!node) throw Object.assign(new Error('Node still starting'), { status: 503 })
    return node
  }

  const hasToken = req => safeEqual(req.headers.authorization, `Bearer ${state.apiToken}`)
  const isOwner = req => sameOrigin(req) && (
    state.apiToken
      ? hasToken(req)
      : PRIVATE_ADDR.test(remoteAddr(req)) && localHost(req.headers.host)
  )
  // The owner's routes: every write, plus settings and identity. With a token set, the token; without one, a private
  // address whose `Host` is local (`localhost`, `.local`, or an IP literal, never a DNS-rebound public domain). Either
  // way only from no page or the relay's own page: reads are open to players on other origins, writes never are.
  function requireOwner (req) {
    if (state.apiToken) {
      if (!hasToken(req)) throw Object.assign(new Error('Unauthorized'), { status: 401 })
    } else if (!PRIVATE_ADDR.test(remoteAddr(req))) {
      throw Object.assign(new Error('Set PEARTUBE_API_TOKEN to change this relay over the internet'), { status: 403 })
    } else if (!localHost(req.headers.host)) {
      throw Object.assign(new Error('Open this relay by its IP address or .local name, or set PEARTUBE_API_TOKEN'), { status: 403 })
    }
    if (!sameOrigin(req)) throw Object.assign(new Error('This relay can only be changed from its own page'), { status: 403 })
  }

  async function route (req, url) {
    const { node, acquirer } = state
    const path = url.pathname
    if (isWrite(req) || ownerPath(path)) requireOwner(req)
    // Whether this client may manage the relay without a token (the UI asks before showing settings).
    const settingsOpen = Boolean(state.apiToken) || (PRIVATE_ADDR.test(remoteAddr(req)) && localHost(req.headers.host))
    if (req.method === 'GET' && path === '/v1/status') {
      const st = node ? { ...node.status(), ...state.extraStatus?.() } : state.fallbackStatus
      return { ...st, tokenRequired: Boolean(state.apiToken), settingsOpen }
    }
    if (state.settings && (path === '/v1/settings' || path === '/v1/restart')) {
      if (req.method === 'GET' && path === '/v1/settings') return state.settings.view()
      // Changes apply before the reply: live ones in place, the rest by reopening the node in this process.
      if (req.method === 'PUT' && path === '/v1/settings') {
        const { changed } = state.settings.update(await body(req))
        let warning
        if (changed.length) {
          try { await state.applySettings?.(changed) } catch (err) { warning = err.message }
        }
        return { changed, ...state.settings.view(), ...(warning ? { warning } : {}) }
      }
      if (req.method === 'POST' && path === '/v1/restart' && state.restart) {
        await state.restart()
        return state.settings.view()
      }
    }
    if (path === '/v1/identity' || path.startsWith('/v1/identity/')) {
      const n = requireNode(node)
      if (req.method === 'GET' && path === '/v1/identity') {
        return n.identity({ revealMnemonic: url.searchParams.get('reveal') === '1' })
      }
      if (req.method === 'POST' && path === '/v1/identity/writers') {
        const { writer, role = 'writer', alias = '' } = await body(req)
        const res = await n.grantWriter(writer, { role, alias })
        srv.notify('update')
        return { ...res, ...(await n.identity()) }
      }
      const writerDel = path.match(/^\/v1\/identity\/writers\/([0-9a-f]{64})$/i)
      if (writerDel && req.method === 'DELETE') {
        const res = await n.revokeWriter(writerDel[1], { purgeEntries: url.searchParams.get('purge') === '1' })
        srv.notify('update')
        return { ...res, ...(await n.identity()) }
      }
      if (req.method === 'POST' && path === '/v1/identity/epoch') {
        const res = await n.rotateEpoch()
        srv.notify('update')
        return { ...res, ...(await n.identity()) }
      }
      if (req.method === 'POST' && path === '/v1/identity/recover') {
        const { mnemonic, alias = '' } = await body(req)
        if (state.recoverMnemonic) return state.recoverMnemonic(mnemonic, alias)
        const res = await n.claimWithMnemonic(mnemonic, { alias })
        srv.notify('update')
        return { ...res, ...(await n.identity()) }
      }
    }
    if (path.startsWith('/v1/discover')) {
      if (!state.discover) throw Object.assign(new Error('Discover unavailable on this peer'), { status: 404 })
      if (req.method === 'GET' && path === '/v1/discover/creators') return state.discover.listCreators()
      if (req.method === 'POST' && path === '/v1/discover/creators') {
        const res = await state.discover.followCreator(await body(req))
        srv.notify('update')
        return res
      }
      const delCreator = path.match(/^\/v1\/discover\/creators\/(.+)$/)
      if (delCreator && req.method === 'DELETE') {
        const res = state.discover.unfollowCreator(delCreator[1])
        srv.notify('update')
        return res
      }
      if (req.method === 'GET' && path === '/v1/discover/feed') {
        return state.discover.feed({
          source: url.searchParams.get('source') || '',
          creator: url.searchParams.get('creator') || '',
          refresh: url.searchParams.get('refresh') === '1',
          limit: url.searchParams.get('limit') || 40
        })
      }
      if (req.method === 'POST' && path === '/v1/discover/browse') {
        return state.discover.browse(await body(req))
      }
    }
    if (req.method === 'POST' && path === '/v1/identify' && state.identify) {
      const { url: link } = await body(req)
      if (typeof link !== 'string' || !/^https?:\/\//i.test(link.trim())) throw Object.assign(new Error('Paste an http(s) link'), { status: 400 })
      return state.identify(link.trim())
    }
    // Global search asks relays across the network (src/search.js), so only the relay's owner starts one
    // (requireOwner). A new query at most every 3 s per address; the same query again within 10 s returns the
    // answers that arrived since, and after that asks again.
    if (req.method === 'POST' && path === '/v1/search/global') {
      const n = requireNode(node)
      const { query = '', id = null, limit = 0 } = await body(req)
      const addr = remoteAddr(req)
      const key = `${query}\n${id || ''}`
      const last = globalSearches.get(addr)
      if (last && last.key !== key && Date.now() - last.at < 3000) throw Object.assign(new Error('Wait a moment before the next search'), { status: 429 })
      if (globalSearches.size >= 256) globalSearches.clear()
      globalSearches.set(addr, { key, at: last?.key === key ? last.at : Date.now() })
      try {
        return { results: await n.searchGlobal({ query, id, limit }) }
      } catch (err) {
        throw Object.assign(err, { status: err.status || 400 })
      }
    }
    if (req.method === 'GET' && path === '/v1/search') {
      const id = url.searchParams.get('id')
      if (!id) throw Object.assign(new Error('id is required'), { status: 400 })
      const source = url.searchParams.get('source') || null
      const limit = Number(url.searchParams.get('limit')) || 0
      const offset = Number(url.searchParams.get('offset')) || 0
      return { results: node ? (await node.search(id, { source, limit, offset })).map(e => viaApi(req, e)) : [] }
    }
    if (req.method === 'GET' && path === '/v1/entries') {
      const source = url.searchParams.get('source') || null
      const query = url.searchParams.get('q') || null
      const limit = Number(url.searchParams.get('limit')) || 0
      const offset = Number(url.searchParams.get('offset')) || 0
      return { results: node ? (await node.search(null, { source, query, limit, offset })).map(e => viaApi(req, e)) : [] }
    }
    // What a file holds (container, duration, tracks) and how well it streams here now. Privacy rules:
    // - The header is read only when this node holds the whole file, already has its core open (it is playing or
    //   being served), or read it before. Otherwise reading it would open the core, which tells every connected peer
    //   and the DHT that this node wants the title, so `mediaDeferred` says so and `read=1` does it on purpose.
    // - Live numbers (`health`) and `read=1` only for the relay's owner: the token when one is set, else a LAN
    //   address, and never a request from another site's page. They are counts, never peer keys.
    // A header still on its way over the network after 3 s leaves `media` out; the next call finds it.
    if (req.method === 'GET' && path === '/v1/entries/info') {
      const n = requireNode(node)
      const key = url.searchParams.get('key') || ''
      const entry = key ? await n.findEntry(key) : null
      if (!entry?.blobs || !entry.blob) throw Object.assign(new Error('No such entry'), { status: 404 })
      const trusted = isOwner(req)
      const health = n.entryHealth(entry)
      const streamUrl = n.streamUrl(entry)
      const readable = health.open || Boolean(mediaInfos.get(new URL(streamUrl).search)?.info) ||
        (await n.heldBytes(entry)) >= entry.size || (trusted && url.searchParams.get('read') === '1')
      let media
      if (readable) {
        let timer
        media = await Promise.race([mediaOf(streamUrl), new Promise(resolve => { timer = setTimeout(resolve, 3000) })])
        clearTimeout(timer)
      }
      return { media, mediaDeferred: !readable, ...(trusted ? { health: n.entryHealth(entry) } : {}) }
    }
    // One entry by `key`, every track of an album by `seriesKey`, or a list of `ids`, in one request (owner only:
    // every write is). Each file matched loses every announce this relay's channel holds for it, so a second copy of
    // the same file does not take its place; the node then reclaims the file's blocks unless another announce still
    // points at them. A file this relay mirrored into its import folder or staging is deleted, with its
    // mirror-watch.json row, so no later scan imports it again (`file: 'deleted'`); one the owner put in the import
    // folder stays (`file: 'kept'`). An entry from another channel is that channel's to remove: it is listed in
    // `notRemoved`, never touched.
    if (req.method === 'POST' && path === '/v1/entries/remove') {
      return removeEntries(requireNode(node), state, srv, await body(req))
    }
    if (req.method === 'GET' && path === '/v1/sources') {
      if (!node) return { tracker: state.fallbackStatus?.tracker || '', channel: '', sources: [], discovered: [], published: [] }
      const st = node.status()
      return { tracker: st.tracker, channel: st.channel, sources: node.listSources(), discovered: await node.discoveredSources(), published: await node.publishedSources() }
    }
    if (req.method === 'POST' && path === '/v1/sources') {
      const n = requireNode(node)
      const payload = await body(req)
      const source = await n.addSource(payload)
      await state.onSourcesChanged?.(n.listSources())
      return { source, sources: n.listSources() }
    }
    const srcMatch = path.match(/^\/v1\/sources\/([0-9a-f]{64})$/i)
    if (srcMatch && req.method === 'DELETE') {
      const n = requireNode(node)
      const res = await n.removeSource(srcMatch[1])
      await state.onSourcesChanged?.(n.listSources())
      return { ...res, sources: n.listSources() }
    }
    if (req.method === 'POST' && path === '/v1/channel/publish') {
      const n = requireNode(node)
      const payload = await body(req)
      if (payload.type === 'source' || payload.sourceKey) {
        return n.publishSource(payload)
      }
      return n.publishChannel(payload)
    }
    const unpubMatch = path.match(/^\/v1\/channel\/sources\/([0-9a-f]{64})$/i)
    if (unpubMatch && req.method === 'DELETE') {
      return requireNode(node).unpublishSource(unpubMatch[1])
    }
    // What a link asks for, without doing it: no follow, no pairing, no pass saved, no warmup. Opening is POST /v1/open.
    if (req.method === 'GET' && path === '/v1/resolve') return parseUri(url.searchParams.get('uri'))
    if (req.method === 'POST' && path === '/v1/open') {
      const { uri } = await body(req)
      if (state.cast && parseUri(uri).action === 'receiver') {
        return { action: 'receiver', receiver: await state.cast.pairReceiver({ uri }) }
      }
      const n = requireNode(node)
      const res = await n.openUri(uri)
      if (res.action === 'source' || res.action === 'access') await state.onSourcesChanged?.(n.listSources())
      return res
    }
    if (req.method === 'POST' && path === '/v1/cache/clear') {
      const n = requireNode(node)
      const { key = null } = await body(req).catch(() => ({}))
      return n.clearCache(key)
    }
    if (req.method === 'POST' && path === '/v1/acquire') {
      if (!acquirer) throw Object.assign(new Error('Acquire unavailable on read-only peer'), { status: 404 })
      const { id, title, source, channel, private: isPrivate = false, music = null } = await body(req)
      return acquirer.add({ id, title, source, channel, private: isPrivate, music })
    }
    if (req.method === 'GET' && path === '/v1/jobs') {
      const base = acquirer ? acquirer.list() : (state.fallbackJobs?.() || [])
      const extra = state.mirror?.listProviderJobs?.() || []
      return { jobs: extra.length ? [...base, ...extra] : base }
    }
    const match = path.match(/^\/v1\/jobs\/([0-9a-f-]{36})$/)
    if (match && req.method === 'GET') {
      return (acquirer ? acquirer.get(match[1]) : (state.fallbackJobs?.().find(j => j.jobId === match[1]) || null)) ||
        state.mirror?.getProviderJob?.(match[1]) || null
    }
    if (match && req.method === 'DELETE') {
      return (acquirer ? acquirer.cancel(match[1]) : null) || state.mirror?.cancelProviderJob?.(match[1]) || null
    }
    if (req.method === 'POST' && path === '/v1/jobs/resume') {
      const resumed = state.mirror?.wakeProviderJobs?.() || 0
      return { resumed }
    }
    const retryMatch = path.match(/^\/v1\/jobs\/([0-9a-f-]{36})\/retry$/)
    if (retryMatch && req.method === 'POST') {
      return state.mirror?.retryProviderJob?.(retryMatch[1]) || null
    }
    if (req.method === 'GET' && path === '/v1/plugins') {
      return { plugins: state.mirror ? state.mirror.list() : [] }
    }
    const plugMatch = req.method === 'POST' && path.match(/^\/v1\/plugins\/([^/]+)\/run$/)
    if (plugMatch) {
      if (!state.mirror) throw Object.assign(new Error('Mirror host unavailable on read-only peer'), { status: 404 })
      return state.mirror.run(decodeURIComponent(plugMatch[1]), await body(req))
    }
    if (req.method === 'POST' && path === '/v1/mirror') {
      if (!state.mirror) throw Object.assign(new Error('Mirror host unavailable on read-only peer'), { status: 404 })
      const { plugin = 'http-acquire', ...payload } = await body(req)
      return state.mirror.run(plugin, payload)
    }
    const provMatch = req.method === 'POST' && path.match(/^\/v1\/providers\/([^/]+)\/(search|browse|mirror)$/)
    if (provMatch) {
      if (!state.mirror) throw Object.assign(new Error('Mirror host unavailable on read-only peer'), { status: 404 })
      const name = decodeURIComponent(provMatch[1])
      const action = provMatch[2]
      const payload = await body(req)
      if (action === 'search') return state.mirror.searchProvider(name, payload)
      if (action === 'browse') return state.mirror.browseProvider(name, payload)
      return state.mirror.mirrorProvider(name, payload)
    }

    if (state.cast && path.startsWith('/v1/cast/')) {
      if (req.method === 'GET' && path === '/v1/cast/status') return state.cast.status()
      if (req.method === 'POST' && path === '/v1/cast/pair') return state.cast.pairReceiver(await body(req))
      const recDel = req.method === 'DELETE' && path.match(/^\/v1\/cast\/receivers\/([^/]+)$/)
      if (recDel) return state.cast.removeReceiver(decodeURIComponent(recDel[1]))
      if (req.method === 'POST' && path === '/v1/cast/play') return state.cast.castPlay(await body(req))
      if (req.method === 'POST' && path === '/v1/cast/control') return state.cast.castControl(await body(req))
      if (req.method === 'POST' && path === '/v1/cast/stop') return state.cast.castStop(await body(req))
    }
    // Stremio v3 Addon endpoints: zero-account plug-and-play P2P streams for Stremio, Omni, and Fusion.
    if (req.method === 'GET' && path === '/manifest.json') {
      return {
        id: 'org.peartube.p2p',
        version: '1.0.0',
        name: 'PearTube P2P',
        description: 'Decentralized Holepunch P2P channels & trackers',
        resources: ['catalog', 'stream'],
        types: ['movie', 'series'],
        idPrefixes: ['tt', 'imdb:', 'clip:'],
        catalogs: [
          { type: 'movie', id: 'peartube-movies', name: 'PearTube Movies' },
          { type: 'series', id: 'peartube-series', name: 'PearTube Series' }
        ]
      }
    }
    const catMatch = req.method === 'GET' && path.match(/^\/catalog\/(movie|series)\/[^/]+\.json$/)
    if (catMatch) {
      const entries = node ? await node.search() : []
      const seen = new Map()
      for (const e of entries) {
        const meta = pearToStremioMeta(e)
        if (meta?.type === catMatch[1] && !seen.has(meta.id)) seen.set(meta.id, meta)
      }
      // Stremio requires a poster on every catalog item; /v1/poster redirects to Cinemeta's.
      const host = req.headers.host
      if (state.posterUrl && host) for (const meta of seen.values()) meta.poster = `${reqProto(req)}://${host}/v1/poster/${meta.id}`
      return { metas: [...seen.values()] }
    }
    const streamMatch = req.method === 'GET' && path.match(/^\/stream\/[^/]+\/(.+)\.json$/)
    if (streamMatch) {
      const entries = (node ? await node.search(stremioToPearId(streamMatch[1])) : []).map(e => viaApi(req, e))
      // Clients rank by resolution (MediaStorm puts an unknown one below every 480p source); release names say it.
      const resolutions = await Promise.all(entries.map(resolutionOf))
      return {
        streams: entries.map((e, i) => {
          // Release-name matchers read the episode from the title, as they do from other add-ons' release names.
          const ep = e.id.match(/:(s\d{2}e\d{2,3})$/)
          const label = ep && !/\bS\d{2}E\d{2,3}\b/i.test(e.title) ? `${e.title} ${ep[1].toUpperCase()}` : e.title
          const name = e.local ? 'PearTube (Local)' : `PearTube (${e.sourceKind})`
          return {
            name: resolutions[i] ? `${name}\n${resolutions[i]}` : name,
            title: `${label}\n${(e.size / 1048576).toFixed(1)} MB · ${e.source.slice(0, 8)}…`,
            url: e.streamUrl,
            // Plain http and mostly MKV: Stremio must route it through its streaming server rather than a web <video>.
            behaviorHints: { bingeGroup: `peartube-${e.source.slice(0, 12)}`, notWebReady: true, videoSize: e.size }
          }
        })
      }
    }
    return undefined
  }

  async function handle (req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { ...CORS, ...ISOLATION, 'cache-control': 'no-cache', 'content-type': 'text/html; charset=utf-8' })
      res.end(page)
      return
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/ca.crt' && state.tls?.ca) {
      res.writeHead(200, { ...CORS, 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="peartube-ca.crt"', 'content-length': String(state.tls.ca.byteLength) })
      res.end(req.method === 'HEAD' ? undefined : state.tls.ca)
      return
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/web/peartube_web.wasm' || url.pathname === '/web/player-worker.js')) {
      const name = url.pathname.slice(5)
      const acceptsGzip = name.endsWith('.wasm') && String(req.headers['accept-encoding'] || '').includes('gzip')
      const gzAsset = acceptsGzip ? readWebAsset(name + '.gz') : null
      const asset = gzAsset || readWebAsset(name)
      if (!asset) { res.writeHead(404, CORS); res.end('not found'); return }
      const { buf, etag } = asset
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ...CORS, ...ISOLATION, etag, 'cache-control': 'no-cache' })
        res.end()
        return
      }
      const mime = name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8'
      const headers = { ...CORS, ...ISOLATION, 'content-type': mime, 'content-length': String(buf.byteLength), 'cache-control': 'no-cache', vary: 'accept-encoding', etag }
      if (gzAsset) headers['content-encoding'] = 'gzip'
      res.writeHead(200, headers)
      res.end(req.method === 'HEAD' ? undefined : buf)
      return
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/v1/blob' && state.node?.blobServer) {
      // Same-origin path to the node's hypercore-blob-server for the web player and direct file downloads.
      const dlTitle = url.searchParams.get('download')
      const upUrl = new URL(url.href)
      upUrl.searchParams.delete('download')
      let dlMeta = null
      if (dlTitle !== null) {
        let fmt = downloadFormats.get(upUrl.search)
        if (!fmt) {
          const head = await readStream(blobHost(), state.node.blobServer.port, upUrl.search, 0, 255).catch(() => null)
          fmt = sniffDownloadFormat(head)
          if (head && head.length >= 4) {
            if (downloadFormats.size >= 512) downloadFormats.clear()
            downloadFormats.set(upUrl.search, fmt)
          }
        }
        dlMeta = { mime: fmt.mime, disposition: contentDispositionFor(dlTitle, fmt.ext) }
      }
      if (res.destroyed) return
      const headers = req.headers.range ? { range: req.headers.range } : {}
      const up = httpRequest({ host: blobHost(), port: state.node.blobServer.port, path: '/' + upUrl.search, method: req.method, headers }, upRes => {
        const out = { ...CORS }
        for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          if (upRes.headers[h] !== undefined) out[h] = upRes.headers[h]
        }
        if (dlMeta) {
          out['content-type'] = dlMeta.mime
          out['content-disposition'] = dlMeta.disposition
        }
        res.writeHead(upRes.statusCode || 502, out)
        // A player that drops a Range read closes `res` first; if upstream aborts mid-body (`clearCache`), tear `res` down too so it never hangs.
        upRes.once('error', () => res.destroy())
        upRes.once('close', () => { if (!upRes.complete && !res.writableEnded && !res.destroyed) res.destroy() })
        upRes.pipe(res)
      })
      up.once('error', () => {
        if (!res.headersSent) { res.writeHead(502, CORS); res.end() }
        else if (!res.destroyed) res.destroy()
      })
      res.once('close', () => up.destroy())
      up.end()
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      res.writeHead(200, { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(': connected\n\n')
      sse.add(res)
      req.once('close', () => sse.delete(res))
      return
    }
    const artMatch = req.method === 'GET' && url.pathname.match(/^\/v1\/(poster|backdrop)\/(tt\d{5,10})$/)
    if (artMatch && (state.posterUrl || state.backdropUrl)) {
      // Cinemeta's art for an identified entry; a redirect keeps image bytes off the relay.
      const lookup = artMatch[1] === 'poster' ? state.posterUrl : state.backdropUrl
      const art = lookup ? await lookup(artMatch[2]).catch(() => null) : null
      res.writeHead(art ? 302 : 404, art ? { ...CORS, location: art, 'cache-control': 'max-age=86400' } : CORS)
      res.end()
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/playlist.m3u') {
      const entries = state.node ? (await state.node.search()).map(e => viaApi(req, e)) : []
      const lines = ['#EXTM3U']
      for (const e of entries) {
        const safeTitle = e.title.replace(/[\r\n,]/g, ' ')
        lines.push(`#EXTINF:-1 tvg-id="${e.id}" group-title="${e.sourceKind}:${e.source.slice(0, 8)}",${safeTitle} (${e.id})`, e.streamUrl)
      }
      res.writeHead(200, { ...CORS, 'content-type': 'audio/x-mpegurl; charset=utf-8' })
      res.end(lines.join('\n') + '\n')
      return
    }
    const discoverThumbMatch = req.method === 'GET' && url.pathname.match(/^\/v1\/discover\/thumb\/([0-9a-f]{20})$/)
    if (discoverThumbMatch) {
      let thumb = null
      try {
        requireOwner(req)
        thumb = await state.discover?.thumb(discoverThumbMatch[1])
      } catch (err) {
        res.writeHead(err.status || 400, { ...CORP, 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
        return
      }
      res.writeHead(thumb ? 200 : 204, thumb ? { ...CORP, 'content-type': thumb.type, 'content-length': String(thumb.bytes.byteLength), 'cache-control': 'private, max-age=86400' } : CORP)
      res.end(thumb ? thumb.bytes : undefined)
      return
    }
    // A source result's picture, through the relay: the owner's browser never asks the source's image host. 204 when
    // there is none, so a missing picture is not a console error.
    const thumbMatch = req.method === 'GET' && url.pathname.match(/^\/v1\/providers\/([a-z0-9-]+)\/thumb\/([\w-]{1,64})$/)
    if (thumbMatch) {
      let thumb = null
      try {
        requireOwner(req)
        thumb = await state.mirror?.providerThumb(thumbMatch[1], thumbMatch[2])
      } catch (err) {
        res.writeHead(err.status || 400, { ...CORP, 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
        return
      }
      res.writeHead(thumb ? 200 : 204, thumb ? { ...CORP, 'content-type': thumb.type, 'content-length': String(thumb.bytes.byteLength), 'cache-control': 'private, max-age=86400' } : CORP)
      res.end(thumb ? thumb.bytes : undefined)
      return
    }
    // One search over the owner's chosen sources. `stream: true` answers as server-sent events, one `source` event
    // per source as it finishes (the fastest shows first; a peer network takes 15-25 s), then `done` with the totals.
    if (req.method === 'POST' && url.pathname === '/v1/search/sources') {
      let streaming = false
      const frame = (event, data) => {
        if (res.destroyed || res.writableEnded) return
        if (!streaming) {
          streaming = true
          res.writeHead(200, { ...CORP, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        }
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      try {
        requireOwner(req)
        if (!state.mirror) throw Object.assign(new Error('Mirror host unavailable on read-only peer'), { status: 404 })
        const { stream = false, ...query } = await body(req)
        const all = await state.mirror.searchSources(query, stream ? part => frame('source', part) : null)
        if (stream) {
          frame('done', { query: all.query, sources: all.sources, bySource: all.bySource, truncated: all.truncated, errors: all.errors })
          res.end()
        } else {
          res.writeHead(200, { ...CORP, 'content-type': 'application/json' })
          res.end(JSON.stringify(all))
        }
      } catch (err) {
        if (streaming) { if (!res.destroyed) res.end(); return }
        res.writeHead(err.status || 400, { ...CORP, 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }
    let status = 200
    let payload
    try {
      payload = await route(req, url)
      if (payload === undefined || payload === null) { status = 404; payload = { error: 'not found' } }
    } catch (err) {
      status = err.status || 400
      payload = { error: err.message }
    }
    // Reads of public state are open to players on other origins; writes and the owner's routes are not.
    const cors = isWrite(req) || ownerPath(url.pathname) ? CORP : CORS
    res.writeHead(status, { ...cors, 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  const srv = createServer(handle)

  // One closed or broken client must not stop the others' notifications.
  srv.notify = (event = 'update') => {
    const frame = `data: ${JSON.stringify({ event })}\n\n`
    for (const res of sse) {
      if (res.destroyed || res.writableEnded) { sse.delete(res); continue }
      try { res.write(frame) } catch { sse.delete(res) }
    }
  }
  srv.once('close', () => {
    for (const res of sse) res.end()
    sse.clear()
  })
  return srv
}

// Removing entries is the owner's one destructive action, and it is shared by three call shapes (`key`,
// `seriesKey`, a list of `ids`, or a list of whole announce `keys`). Exported so a test can drive the real code
// rather than a copy of it.
export async function removeEntries (node, state, srv, body) {
  const n = node
  const { key, seriesKey, ids, keys } = body || {}
  const clean = s => (typeof s === 'string' ? s.trim() : '')
  const idList = Array.isArray(ids) ? ids.map(clean).filter(Boolean).slice(0, 2000) : []
  const keyList = Array.isArray(keys) ? keys.map(clean).filter(Boolean).slice(0, 2000) : []
  if (!clean(key) && !clean(seriesKey) && !idList.length && !keyList.length) throw Object.assign(new Error('key, seriesKey, ids or keys is required'), { status: 400 })
  const own = n.status().channel
  const rows = await n.search(null)
  const picked = rows.filter(r => r.key === clean(key) || (clean(seriesKey) && r.seriesKey === clean(seriesKey).toLowerCase()) || idList.includes(r.id) || keyList.includes(r.key))
  // A key the listing does not show (a duplicate announce, or one written before it) is still removed as asked.
  if (clean(key) && !picked.length) {
    await n.remove(clean(key))
    srv.notify('update')
    return { removed: [{ key: clean(key) }], notRemoved: [], filesDeleted: 0 }
  }
  // A key the listing collapses away — a sibling announce for the same id+sha256, which `catalog.search` dedupes
  // to one record per file — is still removed when the caller names it. Without this, a merged album's delete
  // leaves such an announce behind and the tile regroups from it: the resurrection `keys` exists to prevent.
  const unseen = keyList.filter(k => !picked.some(r => r.key === k))
  const notRemoved = picked.filter(r => r.source !== own).map(r => ({ key: r.key, id: r.id, reason: 'Published by another channel' }))
  // Keyed by id+sha256, so one release's copy of a track is removed without taking a sibling release's copy of a
  // different file that happens to carry the same id.
  const files = new Map(picked.filter(r => r.source === own).map(r => [`${r.id}/${r.sha256}`, r]))
  const removed = []
  // Every announce actually removed, one row each, so the count the caller reports is the count we did. A file
  // held under two of this channel's announces is two removals, and the toast must not say one.
  const removedKeys = new Set()
  // `catalog.search` returns one record per id+sha256, so a sibling announce for the same file can never appear
  // here; the caller's own `keys` is what reaches those, below. The second pass exists only to catch the window
  // where a just-removed announce is still visible in the listing.
  for (let pass = 0; pass < 4 && files.size; pass++) {
    const left = (pass ? await n.search(null) : picked).filter(r => r.source === own && files.has(`${r.id}/${r.sha256}`) && !removedKeys.has(r.key))
    if (!left.length) break
    for (const r of left) {
      try {
        await n.remove(r.key)
        removedKeys.add(r.key)
        removed.push({ key: r.key, id: r.id, sha256: r.sha256, title: r.music?.title || r.title })
        // This file is done: without dropping it from `files` every later pass re-selected the same rows and
        // called remove on keys that no longer existed.
        files.delete(`${r.id}/${r.sha256}`)
      } catch (err) {
        files.delete(`${r.id}/${r.sha256}`)
        notRemoved.push({ key: r.key, id: r.id, reason: err?.message || 'Remove failed' })
      }
    }
  }
  for (const k of unseen) {
    try {
      await n.remove(k)
      removed.push({ key: k, id: null, sha256: null, title: null })
    } catch (err) {
      notRemoved.push({ key: k, id: null, reason: err?.message || 'Remove failed' })
    }
  }
  const fate = state.mirror?.forgetImported ? await state.mirror.forgetImported(removed) : new Map()
  for (const r of removed) r.file = fate.get(`${r.id}/${r.sha256}`) || null
  srv.notify('update')
  return { removed, notRemoved, filesDeleted: removed.filter(r => r.file === 'deleted').length }
}
