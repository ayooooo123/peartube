import { createServer, request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import b4a from 'b4a'
import { page } from './ui.js'
import { receiverPage } from './cast-ui.js'

const MAX_BODY = 64 * 1024
// Loopback, RFC 1918, CGNAT/Tailscale (100.64/10), link-local, and IPv6 ULA/link-local, plain or IPv4-mapped.
const PRIVATE_ADDR = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)|^(::1$|f[cd][0-9a-f]{2}:|fe80:)/i
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, range',
  'access-control-expose-headers': 'content-length, content-range, accept-ranges'
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

function pearToStremioMeta (entry) {
  const ep = entry.id.match(/^imdb:(tt\d+):s\d{2}e\d{2,3}$/)
  if (ep) return { id: ep[1], type: 'series', name: entry.title }
  const mv = entry.id.match(/^imdb:(tt\d+)$/)
  return { id: mv ? mv[1] : entry.id, type: 'movie', name: entry.title }
}

// Single HTTP surface for relays AND local client daemons: /v1 API, SSE events, Stremio v3 addon, and M3U playlist.
export function createApi (state) {
  const sse = new Set()

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
      const id = url.searchParams.get('id')
      if (!id) throw Object.assign(new Error('id is required'), { status: 400 })
      const source = url.searchParams.get('source') || null
      return { results: node ? await node.search(id, { source }) : [] }
    }
    if (req.method === 'GET' && path === '/v1/entries') {
      const source = url.searchParams.get('source') || null
      return { results: node ? await node.search(null, { source }) : [] }
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
        if (meta.type === catMatch[1] && !seen.has(meta.id)) seen.set(meta.id, meta)
      }
      return { metas: [...seen.values()] }
    }
    const streamMatch = req.method === 'GET' && path.match(/^\/stream\/[^/]+\/(.+)\.json$/)
    if (streamMatch) {
      const entries = node ? await node.search(stremioToPearId(streamMatch[1])) : []
      return {
        streams: entries.map(e => ({
          name: e.local ? 'PearTube (Local)' : `PearTube (${e.sourceKind})`,
          title: `${e.title}\n${(e.size / 1048576).toFixed(1)} MB · ${e.source.slice(0, 8)}…`,
          url: e.streamUrl,
          behaviorHints: { bingeGroup: `peartube-${e.source}` }
        }))
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
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { ...CORS, 'content-type': 'text/html; charset=utf-8' })
      res.end(page)
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

  srv.notify = (event = 'update') => {
    const frame = `data: ${JSON.stringify({ event })}\n\n`
    for (const res of sse) res.write(frame)
  }
  srv.once('close', () => {
    for (const res of sse) res.end()
    sse.clear()
  })
  return srv
}
