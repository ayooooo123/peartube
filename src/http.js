import { createServer, request as httpRequest } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { Readable } from 'streamx'
import b4a from 'b4a'
import { page } from './ui.js'
import { receiverPage } from './cast-ui.js'
import { videoSize, resolutionLabel } from './resolution.js'

const MAX_BODY = 64 * 1024
// Loopback, RFC 1918, CGNAT/Tailscale (100.64/10), link-local, and IPv6 ULA/link-local, plain or IPv4-mapped.
const PRIVATE_ADDR = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)|^(::1$|f[cd][0-9a-f]{2}:|fe80:)/i
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, range',
  'access-control-expose-headers': 'content-length, content-range, accept-ranges'
}
const MAX_CHUNK_BODY = 16 * 1024 * 1024
const UI_MIMES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
}

function tryServeCustomUi (req, res, pathname, uiDir) {
  if (!uiDir || (req.method !== 'GET' && req.method !== 'HEAD')) return false
  if (pathname === '/manifest.json' || pathname === '/tv' || /^\/(v1|web|cast|catalog|stream)(\/|$)/.test(pathname)) return false
  const root = resolve(uiDir)
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  let file = resolve(root, rel)
  if (file !== root && !file.startsWith(root + '/')) return false
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (extname(rel)) return false
    file = join(root, 'index.html')
    if (!existsSync(file) || !statSync(file).isFile()) return false
  }
  const data = readFileSync(file)
  const mime = UI_MIMES[extname(file).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { ...CORS, 'content-type': mime, 'content-length': String(data.byteLength), 'cache-control': 'no-cache' })
  res.end(req.method === 'HEAD' ? undefined : data)
  return true
}

// Caches compiled WASM player flesh in memory on first lick so browser streams open instantly on relays and daemons.
const webCache = new Map()
function readWebAsset (name) {
  if (webCache.has(name)) return webCache.get(name)
  const candidates = []
  try { candidates.push(decodeURIComponent(new URL('../web/assets/' + name, import.meta.url).pathname)) } catch {}
  candidates.push(join('web', 'assets', name))
  for (const file of candidates) {
    try {
      const buf = readFileSync(file)
      webCache.set(name, buf)
      return buf
    } catch {}
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
function readStream (port, search, start, end) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => req.destroy(new Error('Stream read timed out')), 4000)
    const fail = err => { clearTimeout(timer); reject(err) }
    const req = httpRequest({ host: '127.0.0.1', port, path: '/' + search, headers: { range: `bytes=${start}-${end}` } }, res => {
      if (res.statusCode !== 206) { res.destroy(); fail(new Error(`Stream read returned ${res.statusCode}`)); return }
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.once('end', () => { clearTimeout(timer); resolve(b4a.concat(chunks)) })
      res.once('error', fail)
    })
    req.once('error', fail)
    req.end()
  })
}

// Single HTTP surface for relays AND local client daemons: /v1 API, SSE events, Stremio v3 addon, and M3U playlist.
export function createApi (state) {
  const sse = new Set()
  // Resolution labels by stream, read once from each file's header. A file that gave none is tried again after
  // 10 minutes: its header may not have been reachable yet.
  const resolutions = new Map()
  function resolutionOf (entry) {
    const port = state.node?.blobServer?.port
    if (!port) return null
    const search = new URL(entry.streamUrl).search
    const known = resolutions.get(search)
    if (known && (known.label !== null || Date.now() - known.at < 600000)) return known.promise
    const record = { at: Date.now(), label: undefined }
    record.promise = videoSize((start, end) => readStream(port, search, start, end))
      .then(size => size && resolutionLabel(size), () => null)
      .then(label => { record.label = label; return label })
    resolutions.set(search, record)
    return record.promise
  }

  async function rawBody (req, limit = MAX_CHUNK_BODY) {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      const buf = b4a.isBuffer(chunk) ? chunk : b4a.from(chunk)
      size += buf.byteLength
      if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 })
      chunks.push(buf)
    }
    return b4a.concat(chunks, size)
  }

  async function body (req, limit = MAX_BODY) {
    const buf = await rawBody(req, limit)
    if (buf.byteLength === 0) return {}
    try { return JSON.parse(b4a.toString(buf)) } catch { throw Object.assign(new Error('Body must be JSON'), { status: 400 }) }
  }

  async function binaryOrBase64 (req) {
    const ct = String(req.headers['content-type'] || '').toLowerCase()
    if (ct.includes('application/json')) {
      const payload = await body(req, MAX_CHUNK_BODY)
      if (typeof payload.dataBase64 !== 'string') throw Object.assign(new Error('dataBase64 required in JSON payload'), { status: 400 })
      return { buf: b4a.from(payload.dataBase64, 'base64'), meta: payload }
    }
    return { buf: await rawBody(req), meta: {} }
  }

  function searchOpts (url) {
    return {
      source: url.searchParams.get('source') || null,
      query: url.searchParams.get('q') || null,
      kind: url.searchParams.get('kind') || null,
      tag: url.searchParams.get('tag') || null,
      groupVariants: url.searchParams.get('variants') === '1',
      includeMuted: url.searchParams.get('muted') === '1'
    }
  }

  // Streams block 0 (CMAF/WebM init header) then tails live blocks as they arrive, ending cleanly once sealed.
  async function serveLiveStream (req, res, url, blobsHex) {
    const n = state.node
    if (!n || !/^[0-9a-f]{64}$/i.test(blobsHex)) { res.writeHead(404, CORS); res.end('not found'); return }
    const hex = blobsHex.toLowerCase()
    n.joinContentSwarm?.(hex)
    const core = await n.blobCore(hex)
    let closed = false
    req.once('close', () => { closed = true })
    res.once('close', () => { closed = true })
    const waitBlock = async idx => {
      while (!closed && core.length <= idx) {
        const end = n.sealedBlockLength?.(hex)
        if (end !== null && idx >= end) return false
        await new Promise(resolve => {
          const t = setTimeout(resolve, 600)
          t.unref?.()
          const onAppend = () => { clearTimeout(t); resolve() }
          core.once('append', onAppend)
          req.once('close', () => { core.off?.('append', onAppend); clearTimeout(t); resolve() })
          core.update?.().catch(() => {})
        })
        if (!n.isLiveBlob?.(hex) && n.sealedBlockLength?.(hex) === null) await n.search(null).catch(() => {})
      }
      return !closed
    }
    if (!(await waitBlock(0))) { if (!res.headersSent) res.writeHead(404, CORS); res.end(); return }
    const mime = url.searchParams.get('mime') || n.getLive?.(hex)?.mime || 'video/mp4'
    res.writeHead(200, { ...CORS, 'content-type': mime, 'cache-control': 'no-store' })
    if (req.method === 'HEAD') { res.end(); return }
    const writeBuf = buf => res.write(buf) ? Promise.resolve() : new Promise(resolve => res.once('drain', resolve))
    const init = await core.get(0)
    if (closed || !init) { res.end(); return }
    await writeBuf(init)
    let i = url.searchParams.get('dvr') === '1' ? 1 : Math.max(1, core.length - 3)
    for (; !closed; i++) {
      const end = n.sealedBlockLength?.(hex)
      if (end !== null && i >= end) break
      if (!(await waitBlock(i))) break
      const endAfter = n.sealedBlockLength?.(hex)
      if (endAfter !== null && i >= endAfter) break
      const blk = await core.get(i)
      if (closed || !blk) break
      await writeBuf(blk)
    }
    if (!closed) res.end()
  }

  function requireNode (node) {
    if (!node) throw Object.assign(new Error('Node still starting'), { status: 503 })
    return node
  }

  async function route (req, url) {
    const { node, acquirer } = state
    const path = url.pathname
    if (state.cast && req.method === 'POST' && path === '/v1/cast/web-register') return state.cast.registerWebReceiver(await body(req))
    if (state.cast && req.method === 'POST' && path === '/v1/cast/web-state') return state.cast.updateWebReceiverState(await body(req))
    // Writes, and the settings themselves, need the token; reads of public state do not.
    if (state.apiToken && (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE' || path === '/v1/settings')) {
      if (req.headers.authorization !== `Bearer ${state.apiToken}`) {
        throw Object.assign(new Error('Unauthorized'), { status: 401 })
      }
    }
    // An open relay already trusts its local network (anyone there can queue downloads), so its settings do too.
    // Clients from public addresses need the token: settings can point the relay at folders on its disk.
    const settingsOpen = Boolean(state.apiToken) || PRIVATE_ADDR.test(req.socket?.remoteAddress || '')
    if (req.method === 'GET' && path === '/v1/status') {
      const st = node ? { ...node.status(), ...(state.extraStatus?.() || {}) } : state.fallbackStatus
      return { ...st, tokenRequired: Boolean(state.apiToken), settingsOpen }
    }
    if (state.settings && (path === '/v1/settings' || path === '/v1/restart')) {
      if (!settingsOpen) throw Object.assign(new Error('Set PEARTUBE_API_TOKEN to change settings over the internet'), { status: 403 })
      // Other websites can reach a LAN relay through the visitor's browser (CORS is open for players); settings only from its own page.
      const origin = req.headers.origin
      if (origin && (() => { try { return new URL(origin).host !== req.headers.host } catch { return true } })()) {
        throw Object.assign(new Error('Settings can only be changed from the relay’s own page'), { status: 403 })
      }
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
    if (req.method === 'POST' && path === '/v1/identify' && state.identify) {
      const { url: link } = await body(req)
      if (typeof link !== 'string' || !/^https?:\/\//i.test(link.trim())) throw Object.assign(new Error('Paste an http(s) link'), { status: 400 })
      return state.identify(link.trim())
    }
    if (req.method === 'GET' && path === '/v1/search') {
      const id = url.searchParams.get('id') || null
      const opts = searchOpts(url)
      if (!id && !opts.query && !opts.kind && !opts.tag) throw Object.assign(new Error('id or q is required'), { status: 400 })
      return { results: node ? await node.search(id, opts) : [] }
    }
    if (req.method === 'GET' && path === '/v1/entries') {
      return { results: node ? await node.search(null, searchOpts(url)) : [] }
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
        return n.publishSource(payload, { target: payload.target || 'channel' })
      }
      return n.publishChannel(payload)
    }
    const unpubMatch = path.match(/^\/v1\/channel\/sources\/([0-9a-f]{64})$/i)
    if (unpubMatch && req.method === 'DELETE') {
      return requireNode(node).unpublishSource(unpubMatch[1])
    }
    if (req.method === 'POST' && path === '/v1/channel/move') {
      const n = requireNode(node)
      const payload = await body(req)
      const cert = payload.sig ? payload : n.signChannelMove(payload.to)
      if (payload.signOnly) return cert
      const applied = await n.applyChannelMove(cert, { target: payload.target || 'both' })
      await state.onSourcesChanged?.(n.listSources())
      return applied
    }
    if (req.method === 'POST' && path === '/v1/art') {
      const n = requireNode(node)
      const { buf, meta } = await binaryOrBase64(req)
      const mime = url.searchParams.get('mime') || meta.mime || req.headers['content-type'] || 'image/jpeg'
      const art = await n.putArt(Readable.from([buf]), { mime })
      return { art, artUrl: n.streamUrl({ blobs: art.blobs, blob: art.blob, mime: art.mime }) }
    }
    if (req.method === 'POST' && path === '/v1/packs') {
      const n = requireNode(node)
      const { items = [], blockSize = 65536, channel = false, tracker = true } = await body(req, MAX_CHUNK_BODY)
      if (!Array.isArray(items) || items.length === 0) throw Object.assign(new Error('items array required'), { status: 400 })
      const prepared = items.map(({ dataBase64, ...rest }) => ({
        ...rest,
        source: Readable.from([b4a.from(String(dataBase64 || ''), 'base64')])
      }))
      return n.putPack(prepared, { blockSize, channel, tracker })
    }
    if (req.method === 'POST' && path === '/v1/live/start') {
      const n = requireNode(node)
      const payload = await body(req)
      const live = await n.createLive(payload)
      const host = req.headers.host ? `http://${req.headers.host}` : ''
      return { blobs: live.blobs, id: live.id, mime: live.mime, liveUrl: `${host}/v1/live/${live.blobs}?mime=${encodeURIComponent(live.mime)}` }
    }
    const liveChunkMatch = req.method === 'POST' && path.match(/^\/v1\/live\/([0-9a-f]{64})\/(chunk|seal)$/i)
    if (liveChunkMatch) {
      const n = requireNode(node)
      const live = n.getLive(liveChunkMatch[1])
      if (!live) throw Object.assign(new Error('Unknown or already sealed live stream'), { status: 404 })
      if (liveChunkMatch[2].toLowerCase() === 'seal') return live.seal()
      const { buf } = await binaryOrBase64(req)
      return live.write(buf)
    }
    const chatMatch = path.match(/^\/v1\/chat\/([a-z0-9:._-]{1,128})$/i)
    if (chatMatch) {
      if (!state.chat) throw Object.assign(new Error('Chat unavailable'), { status: 503 })
      const room = decodeURIComponent(chatMatch[1])
      if (req.method === 'GET') {
        const since = Number(url.searchParams.get('since') || 0)
        const limit = Number(url.searchParams.get('limit') || 100)
        return { room: room.toLowerCase(), messages: state.chat.history(room, { since, limit }), peers: state.chat.peers() }
      }
      if (req.method === 'POST') {
        const payload = await body(req)
        return { message: state.chat.post({ room, text: payload.text, nick: payload.nick, signed: payload.signed || null }) }
      }
    }
    if ((req.method === 'POST' && path === '/v1/open') || (req.method === 'GET' && path === '/v1/resolve')) {
      const uri = req.method === 'GET' ? url.searchParams.get('uri') : (await body(req)).uri
      if (uri && /^peartube:(?:\/\/)?(?:receiver|cast)\//i.test(uri) && state.cast) {
        return { action: 'receiver', receiver: await state.cast.pairReceiver({ uri }) }
      }
      const n = requireNode(node)
      const res = await n.openUri(uri)
      if (res.action === 'source') await state.onSourcesChanged?.(n.listSources())
      return res
    }
    if (req.method === 'POST' && path === '/v1/cache/clear') {
      const n = requireNode(node)
      const { key = null } = await body(req).catch(() => ({}))
      return n.clearCache(key)
    }
    if (req.method === 'POST' && path === '/v1/acquire') {
      if (!acquirer) throw Object.assign(new Error('Acquire unavailable on read-only peer'), { status: 404 })
      const { id, title, source, channel } = await body(req)
      return acquirer.add({ id, title, source, channel })
    }
    if (req.method === 'GET' && path === '/v1/jobs') return { jobs: acquirer ? acquirer.list() : (state.fallbackJobs?.() || []) }
    const match = path.match(/^\/v1\/jobs\/([0-9a-f-]{36})$/)
    if (match && req.method === 'GET') return acquirer ? acquirer.get(match[1]) : (state.fallbackJobs?.().find(j => j.jobId === match[1]) || null)
    if (match && req.method === 'DELETE') return acquirer ? acquirer.cancel(match[1]) : null
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

    if (state.cast && path.startsWith('/cast/v1/')) {
      return state.cast.handleHubCastJson(req, url)
    }
    if (state.cast && path.startsWith('/v1/cast/')) {
      if (req.method === 'GET' && path === '/v1/cast/status') {
        const st = state.cast.status()
        return { ...st, webReceiverQrSvg: st.webReceiverUrl ? state.cast.webSetupQrSvg(st.webReceiverUrl) : '' }
      }
      if (req.method === 'POST' && path === '/v1/cast/web-register') return state.cast.registerWebReceiver(await body(req))
      if (req.method === 'POST' && path === '/v1/cast/web-state') return state.cast.updateWebReceiverState(await body(req))
      if (req.method === 'POST' && path === '/v1/cast/pair') return state.cast.pairReceiver(await body(req))
      const recDel = req.method === 'DELETE' && path.match(/^\/v1\/cast\/receivers\/([^/]+)$/)
      if (recDel) return state.cast.removeReceiver(decodeURIComponent(recDel[1]))
      if (req.method === 'POST' && path === '/v1/cast/play') return state.cast.castPlay(await body(req))
      if (req.method === 'POST' && path === '/v1/cast/attach') return state.cast.castAttach(await body(req))
      if (req.method === 'POST' && path === '/v1/cast/control') return state.cast.castControl(await body(req))
      if (req.method === 'POST' && path === '/v1/cast/stop') return state.cast.castStop(await body(req))
      if (req.method === 'POST' && path === '/v1/cast/receiver/start') return state.cast.startLocalReceiver(await body(req))
      if (req.method === 'POST' && path === '/v1/cast/receiver/stop') { await state.cast.stopLocalReceiver(); return { stopped: true } }
      if (req.method === 'POST' && path === '/v1/cast/receiver/rotate') return state.cast.rotateLocalReceiverCode()
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
      if (state.posterUrl && host) for (const meta of seen.values()) meta.poster = `http://${host}/v1/poster/${meta.id}`
      return { metas: [...seen.values()] }
    }
    const streamMatch = req.method === 'GET' && path.match(/^\/stream\/[^/]+\/(.+)\.json$/)
    if (streamMatch) {
      const entries = node ? await node.search(stremioToPearId(streamMatch[1])) : []
      // Clients rank by resolution (MediaStorm puts an unknown one below every 480p source); release names say it.
      const resolutions = await Promise.all(entries.map(resolutionOf))
      // Streams go through /v1/blob on the address the client reached the add-on at. Clients that admit private
      // addresses only for their configured add-on (MediaStorm refuses the blob server's own port) can then play them.
      const origin = req.headers.host && node?.blobServer ? `http://${req.headers.host}/v1/blob` : null
      return {
        streams: entries.map((e, i) => {
          // Release-name matchers read the episode from the title, as they do from other add-ons' release names.
          const ep = e.id.match(/:(s\d{2}e\d{2,3})$/)
          const label = ep && !/\bS\d{2}E\d{2,3}\b/i.test(e.title) ? `${e.title} ${ep[1].toUpperCase()}` : e.title
          const name = e.local ? 'PearTube (Local)' : `PearTube (${e.sourceKind})`
          return {
            name: resolutions[i] ? `${name}\n${resolutions[i]}` : name,
            title: `${label}\n${(e.size / 1048576).toFixed(1)} MB · ${e.source.slice(0, 8)}…`,
            url: origin ? origin + new URL(e.streamUrl).search : e.streamUrl,
            // Plain http and mostly MKV: Stremio must route it through its streaming server rather than a web <video>.
            behaviorHints: { bingeGroup: `peartube-${e.source}`, notWebReady: true, videoSize: e.size }
          }
        })
      }
    }
    return undefined
  }

  const srv = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }
    const url = new URL(req.url, 'http://127.0.0.1')
    if (tryServeCustomUi(req, res, url.pathname, state.uiDir)) return
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { ...CORS, 'content-type': 'text/html; charset=utf-8' })
      res.end(page)
      return
    }
    const liveGetMatch = (req.method === 'GET' || req.method === 'HEAD') && url.pathname.match(/^\/v1\/live\/([0-9a-f]{64})$/i)
    if (liveGetMatch) {
      await serveLiveStream(req, res, url, liveGetMatch[1]).catch(() => { if (!res.headersSent) res.writeHead(502, CORS); res.end() })
      return
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/v1/blob' && url.searchParams.get('live') === '1' && url.searchParams.get('blobs')) {
      await serveLiveStream(req, res, url, url.searchParams.get('blobs')).catch(() => { if (!res.headersSent) res.writeHead(502, CORS); res.end() })
      return
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/web/peartube_web.wasm' || url.pathname === '/web/player-worker.js')) {
      const name = url.pathname.slice(5)
      const acceptsGzip = name.endsWith('.wasm') && String(req.headers['accept-encoding'] || '').includes('gzip')
      const gzAsset = acceptsGzip ? readWebAsset(name + '.gz') : null
      const asset = gzAsset || readWebAsset(name)
      if (!asset) { res.writeHead(404, CORS); res.end('not found'); return }
      const etag = '"' + asset.byteLength + '-' + asset[0] + '-' + asset[asset.byteLength - 1] + (gzAsset ? '-gz' : '') + '"'
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ...CORS, etag, 'cache-control': 'no-cache' })
        res.end()
        return
      }
      const mime = name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8'
      const headers = { ...CORS, 'content-type': mime, 'content-length': String(asset.byteLength), 'cache-control': 'no-cache', vary: 'accept-encoding', etag }
      if (gzAsset) headers['content-encoding'] = 'gzip'
      res.writeHead(200, headers)
      res.end(req.method === 'HEAD' ? undefined : asset)
      return
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/v1/blob' && state.node?.blobServer) {
      // Same-origin path to the node's hypercore-blob-server for the web player: forward the Range request over loopback.
      const headers = req.headers.range ? { range: req.headers.range } : {}
      const up = httpRequest({ host: '127.0.0.1', port: state.node.blobServer.port, path: '/' + url.search, method: req.method, headers }, upRes => {
        const out = { ...CORS }
        for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          if (upRes.headers[h] !== undefined) out[h] = upRes.headers[h]
        }
        res.writeHead(upRes.statusCode || 502, out)
        // A player that drops a Range read closes `res` first; the pipe then destroys `upRes` with an error that would
        // otherwise go uncaught and take the whole relay down.
        upRes.once('error', () => res.destroy())
        upRes.pipe(res)
      })
      up.once('error', () => { if (!res.headersSent) res.writeHead(502, CORS); res.end() })
      res.once('close', () => up.destroy())
      up.end()
      return
    }
    if (req.method === 'GET' && (url.pathname === '/tv' || url.pathname === '/cast/receiver') && state.cast) {
      res.writeHead(200, { ...CORS, 'content-type': 'text/html; charset=utf-8' })
      res.end(receiverPage({ mode: 'hub', defaultName: 'PearTube Smart TV' }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/cast/web-events' && state.cast) {
      state.cast.handleWebEvents(req, res, url)
      return
    }
    if (req.method === 'GET' && url.pathname === '/cast/v1/events' && state.cast) {
      state.cast.handleHubSenderEvents(req, res, url)
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
      const entries = state.node ? await state.node.search() : []
      const lines = ['#EXTM3U']
      for (const e of entries) {
        const safeTitle = e.title.replace(/[\r\n,]/g, ' ')
        lines.push(`#EXTINF:-1 tvg-id="${e.id}" group-title="${e.sourceKind}:${e.source.slice(0, 8)}",${safeTitle} (${e.id})`, e.streamUrl)
      }
      res.writeHead(200, { ...CORS, 'content-type': 'audio/x-mpegurl; charset=utf-8' })
      res.end(lines.join('\n') + '\n')
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
    res.writeHead(status, { ...CORS, 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  })

  srv.notify = (event = 'update', extra = null) => {
    const frame = `data: ${JSON.stringify(extra ? { event, ...extra } : { event })}\n\n`
    for (const res of sse) res.write(frame)
  }
  srv.once('close', () => {
    for (const res of sse) res.end()
    sse.clear()
  })
  return srv
}
