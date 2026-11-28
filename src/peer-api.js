// Full-peer loopback HTTP API shared by the Bare worklet (and tests), mirroring
// peartube-native's LoopbackApi so JS and Rust app engines keep feature parity:
//   - private peer settings (<storage>/settings.json, 0600) with live Soulseek updates
//   - direct-URL and ubit link identification + durable acquisitions (<storage>/jobs.json)
//   - local mirror host (watch-dir staging, direct Soulseek, YouTube, SoundCloud, Rumble)
//   - Discover v2 creator feeds, browse, and owner-guarded thumbnail proxy (<storage>/discover.json)
import { join } from 'node:path'
import { createAcquirer } from './acquire.js'
import { CINEMETA_URL, send as fetchArt } from './art.js'
import { createDiscover } from './discover.js'
import { createApi } from './http.js'
import { downloadPage, identify, ubitInfo } from './identify.js'
import { createMirrorHost } from './mirror.js'
import { API_PORT } from './protocol.js'
import { createSettings } from './settings.js'

const metahub = (kind, size) => async imdb => `https://images.metahub.space/${kind}/${size}/${imdb}/img`

const SLSK_LIVE_KEYS = new Set(['slskUser', 'slskPass', 'slskServer'])

function listenLoopback (srv, preferredPort) {
  return new Promise(resolve => {
    const tryBind = port => {
      const onError = () => {
        srv.removeListener('listening', onListen)
        if (port !== 0) tryBind(0)
        else resolve(null)
      }
      const onListen = () => {
        srv.removeListener('error', onError)
        const addr = srv.address()
        resolve(addr?.port ? `http://127.0.0.1:${addr.port}` : null)
      }
      srv.once('error', onError)
      srv.once('listening', onListen)
      srv.listen(port, '127.0.0.1')
    }
    tryBind(preferredPort)
  })
}

export async function openPeerApi ({
  node,
  storage,
  preferredPort = API_PORT,
  getCast = () => null,
  extraStatus = null,
  onSourcesChanged = null,
  onchange = null,
  allowPrivateUrls = false
}) {
  const ubitConfigDir = join(storage, 'ubit')
  const jobsFile = join(storage, 'jobs.json')
  const settings = createSettings(storage, {})
  const cfg = key => settings.get(key)
  let server = null
  let url = null
  let mirrorHost = null

  const notify = (event = 'update') => {
    server?.notify(event)
  }
  const emitUpdate = () => {
    notify('update')
    onchange?.()
  }

  const acquirer = createAcquirer(node, jobsFile, {
    concurrency: 2,
    defaultChannel: true,
    ubitConfigDir,
    allowPrivate: allowPrivateUrls,
    onDone: emitUpdate
  })

  const state = {
    node,
    acquirer,
    mirror: null,
    settings,
    discover: null,
    identify: link => identify(link, { cinemetaUrl: cfg('cinemetaUrl') || CINEMETA_URL, configDir: ubitConfigDir }),
    posterUrl: metahub('poster', 'small'),
    backdropUrl: metahub('background', 'medium'),
    p2pOnlyMetadata: () => cfg('p2pOnlyMetadata'),
    get cast () { return getCast() },
    extraStatus: () => (extraStatus ? extraStatus(url) : {}),
    onSourcesChanged,
    onMetaSourcesChanged: list => {
      try { settings.update({ metaSources: list.map(s => s.key) }) } catch (err) { void err }
    },
    async applySettings (changed) {
      if (changed.includes('p2pOnlyMetadata')) node.meta?.setP2pOnly?.(cfg('p2pOnlyMetadata'))
      if (changed.includes('seedFullMetadata')) node.meta?.setSeedFull?.(cfg('seedFullMetadata'))
      if (changed.includes('metaSources') && node.meta) {
        const want = new Set(cfg('metaSources'))
        for (const s of node.meta.listSources()) {
          if (!want.has(s.key) && !s.writable) await node.meta.removeSource(s.key)
        }
        for (const key of want) await node.meta.addSource(key)
      }
      if (!changed.some(k => SLSK_LIVE_KEYS.has(k))) return
      state.mirror?.configure({
        slskUser: cfg('slskUser'),
        slskPass: cfg('slskPass'),
        slskServer: cfg('slskServer')
      })
    }
  }
  node.meta?.setP2pOnly?.(cfg('p2pOnlyMetadata'))
  node.meta?.setSeedFull?.(cfg('seedFullMetadata'))

  const fetchBytes = (targetUrl, opts = {}) => fetchArt(targetUrl, {
    binary: true,
    timeoutMs: opts.timeoutMs || 12_000,
    maxBytes: opts.maxBytes || 4 * 1024 * 1024,
    headers: opts.headers || {},
    allowPrivate: allowPrivateUrls
  })

  state.discover = createDiscover({
    storage,
    fetchBytes,
    getMirror: () => state.mirror,
    getEntries: () => state.node?.search(null) ?? [],
    onchange: emitUpdate
  })

  server = createApi(state)

  const mirrorStarting = createMirrorHost({
    node,
    storage,
    acquirer,
    mirrorChannel: false,
    rechunk: false,
    watchDir: null,
    feeds: [],
    replicate: false,
    mediaCheck: false,
    hiverelay: null,
    slskUser: cfg('slskUser'),
    slskPass: cfg('slskPass'),
    slskServer: cfg('slskServer'),
    slskListenPort: 0,
    slskShare: Boolean(cfg('slskShare')),
    slskShareMaxFiles: Number(cfg('slskShareMaxFiles')) || 2000,
    soulseekOpts: { persistJobs: true },
    youtube: {
      info: (query, opts) => ubitInfo(query, { configDir: ubitConfigDir, ...opts }),
      download: (pageUrl, dir, opts) => downloadPage(pageUrl, dir, { configDir: ubitConfigDir, ...opts })
    },
    pluginsDir: null,
    pollIntervalMs: 0,
    onchange: emitUpdate,
    onstarting: host => { mirrorHost = host }
  }).then(mirror => {
    state.mirror = mirror
    return mirror
  }, err => {
    console.error('peer-api mirror failed to start:', err?.message || String(err))
    return null
  })

  url = await listenLoopback(server, preferredPort)
  if (!url) {
    server.closeAllConnections()
    server = null
  }

  async function close () {
    const openServer = server
    server = null
    if (openServer) {
      await new Promise(resolve => {
        openServer.close(() => resolve())
        openServer.closeAllConnections()
      })
    }
    try {
      await mirrorHost?.close()
    } catch (err) {
      console.error('peer-api mirror close failed:', err?.message || String(err))
    }
    await mirrorStarting
    state.mirror = null
    mirrorHost = null
    acquirer.close()
    state.acquirer = null
    state.node = null
  }

  return {
    url,
    server,
    settings,
    acquirer,
    discover: state.discover,
    ready: mirrorStarting,
    notify,
    close
  }
}
