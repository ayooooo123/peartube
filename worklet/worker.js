// The app's P2P worker: a Bare worklet running the same core as the relay.
// The Rust app talks to it over Bare.IPC in newline-delimited JSON:
//   app -> worker  {id, method, params}   start | status | search | stop
//   worker -> app  {id, result} | {id, error} | {event: 'update'} | {event: 'fatal', error}
// Host events {event, ...} are dispatched on Bare's 'appEvent' channel; iOS
// uses this for the system Bonjour adapter without raw multicast sockets.
// 'update' means the tracker, the peer set or LAN discovery changed. start and
// status return the core's status plus `lan` (see lanNote). Stream URLs point
// at the core's blob server on 127.0.0.1, which the app plays.
// Some of LAN discovery's dependencies use the global `process`, which Bare
// only has once bare-process/global has run. Imports load in order.
import 'bare-process/global'
import b4a from 'b4a'
import os from 'bare-os'
import { createNode } from '../src/index.js'
import { createApi } from '../src/http.js'
// Artwork lookups without `ubit`: the app's own loopback API serves /v1/poster and /v1/backdrop.
import { posterUrl, backdropUrl } from '../src/art.js'

const CINEMETA = 'https://v3-cinemeta.strem.io'
import { createLan, interfaceAdapter, lanAddress } from '../src/lan.js'
import { createCastController, reclaimLowDiskReceiverStorage, resolvePeerStorage } from '../src/cast.js'

const ipc = Bare.IPC
let node = null
let api = null
let apiUrl = null
let cast = null
let castStorage = null
let castPeerStorage = null
let receiverNodeOwned = false
let lifecycle = Promise.resolve()

// Any peer can publish a title with a lone surrogate, which serde_json rejects.
const wellFormed = (key, value) => typeof value === 'string' ? value.toWellFormed() : value
const send = msg => ipc.write(JSON.stringify(msg, wellFormed) + '\n')
let updateTimer = null
let lastUpdateAt = 0
const update = () => {
  api?.notify('update')
  if (updateTimer) return
  const delay = Date.now() - lastUpdateAt < 3000 ? 1500 : 200
  updateTimer = setTimeout(() => {
    updateTimer = null
    lastUpdateAt = Date.now()
    send({ event: 'update' })
  }, delay)
}
const sendCast = () => {
  api?.notify('cast')
  if (cast) send({ event: 'cast', cast: cast.status() })
}
// start, stop and LAN moves run one at a time, so a quick settings change
// cannot leave two nodes open on the same storage.
function serial (fn) {
  const next = lifecycle.then(fn)
  lifecycle = next.catch(() => {})
  return next
}

// The old swarm's listener goes first: closing it fires 'update' per connection.
// A closed tracker stops calling onchange on its own.
async function close () {
  if (updateTimer) { clearTimeout(updateTimer); updateTimer = null }
  const open = node
  const openApi = api
  const openCast = cast
  node = null
  api = null
  apiUrl = null
  cast = null
  receiverNodeOwned = false
  lanHost = null
  lanError = null
  lanNote = null
  if (openCast) await openCast.close().catch(() => {})
  if (openApi) await new Promise(resolve => {
    openApi.close(() => resolve())
    openApi.closeAllConnections()
  }).catch(() => {})
  if (!open) return
  open.swarm.off('update', update)
  await open.close()
}

// LAN discovery (src/lan.js) binds to this device's Wi-Fi or Ethernet address,
// which changes as the device moves between networks. moveLan rebinds it to
// the current address, or stops it when there is none, when it is off, or
// while the app is in the background. It runs on start, on resume and every
// few seconds, inside serial. lanNote tells the status line what it is doing:
// on <address>, paused, failed on <address>, or found no Wi-Fi address (with
// the addresses it did see). It is null while LAN discovery is off.
let lanWanted = false
let lanHost = null
let lanError = null
let lanNote = null
let suspended = false

function currentDeviceIp () {
  if (suspended) return null
  try { return lanAddress(os.networkInterfaces()) } catch { return null }
}

async function moveLan () {
  let host = null
  let seen = ''
  const liveIp = currentDeviceIp()
  if (node && lanWanted && !suspended) {
    try {
      const interfaces = os.networkInterfaces()
      host = lanAddress(interfaces)
      seen = ipv4s(interfaces)
    } catch (err) {
      seen = `cannot list interfaces (${err.message})`
    }
  }
  if (host !== lanHost) {
    lanHost = host
    lanError = null
    try {
      await node.setLan(host && (keyPair => createLan({ host, keyPair, adapter: interfaceAdapter(host) })))
    } catch (err) {
      lanError = err.message
    }
  }
  if (cast) await cast.setLanHost(liveIp).catch(() => {})
  const note = noteFor(seen)
  if (note !== lanNote) {
    lanNote = note
    update()
  }
}

async function ensureCast (storageHint = null, peerStorageHint = null) {
  if (storageHint) castStorage = storageHint
  if (peerStorageHint) castPeerStorage = peerStorageHint
  if (!castStorage) throw new Error('Storage path required before initializing Cast')
  if (!cast) {
    cast = createCastController({
      storage: castStorage,
      getNode: () => node,
      ensureNode: async () => {
        if (node) return node
        receiverNodeOwned = true
        const peerDir = await resolvePeerStorage(castPeerStorage, castStorage)
        reclaimLowDiskReceiverStorage(peerDir)
        node = await createNode({ storage: peerDir, onchange: update, worklet: true })
        node.swarm.on('update', update)
        lanWanted = true
        await moveLan()
        return node
      },
      getLanHost: currentDeviceIp,
      onchange: sendCast,
      worklet: true
    })
    await cast.initHub().catch(() => {})
    await cast.setLanHost(currentDeviceIp()).catch(() => {})
  }
  return cast
}

function noteFor (seen) {
  if (!node || !lanWanted) return null
  if (suspended) return 'paused'
  if (!lanHost) return `found no Wi-Fi address; this device has ${seen || 'no IPv4 address'}`
  return lanError ? `failed on ${lanHost}: ${lanError}` : `on ${lanHost}`
}

// Every interface's own IPv4 addresses, as "wlan0 10.0.0.5, rmnet0 100.64.0.2".
function ipv4s (interfaces) {
  return Object.entries(interfaces)
    .flatMap(([name, entries]) => entries.filter(e => (e.family === 'IPv4' || e.family === 4) && !e.internal).map(e => `${name} ${e.address}`))
    .join(', ')
}

const report = () => ({ ...node.status(), lan: lanNote, apiUrl })

// Reads wait for a queued start or stop, so they never see the node being replaced.
async function current () {
  await lifecycle
  if (!node) throw new Error('Not started')
  return node
}

function hostPort (address) {
  const i = address.lastIndexOf(':')
  return { host: address.slice(0, i), port: Number(address.slice(i + 1)) }
}

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

const methods = {
  start: ({ storage, channel = null, tracker = null, mnemonic = null, join = false, sources = [], relayThrough = null, bootstrap = null, lan = false, privateRouting = false, apiPort = 8174, apiToken = null, cacheMaxGb = 10 }) => serial(async () => {
    await close()
    castStorage = storage
    node = await createNode({
      storage,
      channel: channel || null,
      tracker: tracker || null,
      mnemonic: mnemonic || null,
      join: Boolean(join),
      sources,
      relayThrough,
      bootstrap: bootstrap ? bootstrap.map(hostPort) : undefined,
      privateRouting,
      worklet: true,
      onchange: update
    })
    node.swarm.on('update', update)
    // Bound playback caching: one watched 4K remux used to fill the disk.
    node.setCacheMaxBytes(Math.max(0, Number(cacheMaxGb) || 0) * 1e9)
    lanWanted = lan
    await moveLan()
    if (apiPort !== false) {
      const srv = createApi({
        node,
        acquirer: null,
        posterUrl: imdb => posterUrl(CINEMETA, imdb),
        backdropUrl: imdb => backdropUrl(CINEMETA, imdb),
        get cast () { return cast },
        apiToken,
        extraStatus: () => ({ lan: lanNote, apiUrl, lanStats: node?.lanStats?.() ?? null }),
        onSourcesChanged: list => send({ event: 'sources', sources: list })
      })
      apiUrl = await listenLoopback(srv, Number(apiPort) || 8174)
      api = apiUrl ? srv : null
    }
    const discovered = await node.discoveredSources()
    return { ...report(), discoveredSources: discovered }
  }),
  status: async () => {
    const n = await current()
    return { ...report(), discoveredSources: await n.discoveredSources() }
  },
  search: async ({ id = null, source = null, query = null, limit = 0, offset = 0 } = {}) => (await current()).search(id, { source, query, limit, offset }),
  focusSource: async ({ key }) => ({ ok: await (await current()).focusSource(key) }),
  setPlayerActive: async ({ active }) => (await current()).setPlayerActive(active),
  warm: async ({ key }) => {
    const n = await current()
    const entry = await n.findEntry(key)
    if (entry) await n.warm(entry)
    return { ok: Boolean(entry) }
  },
  sources: async () => {
    const n = await current()
    return { sources: n.listSources(), discovered: await n.discoveredSources(), channel: n.status().channel }
  },
  addSource: async params => {
    const n = await current()
    const source = await n.addSource(params)
    return { source, sources: n.listSources(), discovered: await n.discoveredSources() }
  },
  removeSource: async ({ key }) => {
    const n = await current()
    const res = await n.removeSource(key)
    return { ...res, sources: n.listSources(), discovered: await n.discoveredSources() }
  },
  openUri: async ({ uri, storage = null }) => {
    if (typeof uri === 'string' && /^peartube:(?:\/\/)?(?:receiver|cast)\//i.test(uri.trim())) {
      const c = await ensureCast(storage)
      const receiver = await c.pairReceiver({ uri: uri.trim() })
      return { action: 'receiver', receiver }
    }
    return (await current()).openUri(uri)
  },
  publishSource: async params => (await current()).publishSource(params),
  remove: async ({ key }) => { await (await current()).remove(key); update(); return { removed: true, key } },
  identity: async ({ revealMnemonic = false } = {}) => (await current()).identity({ revealMnemonic }),
  grantWriter: async ({ writer, role = 'writer', alias = '' }) => { const res = await (await current()).grantWriter(writer, { role, alias }); update(); return res },
  revokeWriter: async ({ writer, purgeEntries = false }) => { const res = await (await current()).revokeWriter(writer, { purgeEntries }); update(); return res },
  rotateEpoch: async () => { const res = await (await current()).rotateEpoch(); update(); return res },
  claimWithMnemonic: async ({ mnemonic, alias = '' }) => { const res = await (await current()).claimWithMnemonic(mnemonic, { alias }); update(); return res },
  addAccessKey: async params => { const res = await (await current()).addAccessKey(params); update(); return res },
  removeAccessKey: async ({ channel, epoch = null }) => { const res = await (await current()).removeAccessKey(channel, epoch); update(); return res },
  clearCache: async ({ key = null } = {}) => { const res = await (await current()).clearCache(key); update(); return res },
  setCacheMax: async ({ maxBytes = 0 } = {}) => { const cacheMaxBytes = (await current()).setCacheMaxBytes(maxBytes); update(); return { cacheMaxBytes } },
  castStatus: async ({ storage = null } = {}) => (await ensureCast(storage)).status(),
  castPair: async params => { const c = await ensureCast(params.storage); await c.pairReceiver(params); return c.status() },
  castRemove: async ({ id, storage = null }) => { const c = await ensureCast(storage); c.removeReceiver(id); return c.status() },
  castPlay: async params => {
    const c = await ensureCast(params.storage)
    if (node && !node.privateRouting && !lanWanted) {
      lanWanted = true
      await serial(moveLan).catch(() => {})
    } else {
      await c.setLanHost(currentDeviceIp()).catch(() => {})
    }
    return c.castPlay(params)
  },
  castAttach: async params => (await ensureCast(params.storage)).castAttach(params),
  castControl: async params => (await ensureCast(params.storage)).castControl(params),
  castStop: async params => (await ensureCast(params.storage)).castStop(params),
  receiverStart: ({ storage = null, peerStorage = null, name = 'PearTube TV', port = 8176, openAuth = false } = {}) => serial(async () => {
    const nextPeer = peerStorage || castPeerStorage
    if (cast && nextPeer && nextPeer !== castPeerStorage && receiverNodeOwned && cast.status().receiverMode?.state?.status === 'idle') {
      await close()
    }
    if (nextPeer) castPeerStorage = nextPeer
    const c = await ensureCast(storage, castPeerStorage)
    return c.startLocalReceiver({
      name,
      port,
      openAuth,
      peerStorage: castPeerStorage,
      onCommand: async command => { send({ event: 'receiverCommand', command }) }
    })
  }),
  receiverStop: () => serial(async () => {
    if (cast) await cast.stopLocalReceiver()
    if (receiverNodeOwned && node) {
      const open = node
      node = null
      receiverNodeOwned = false
      open.swarm.off('update', update)
      await open.close().catch(() => {})
    }
    return cast ? cast.status() : null
  }),
  receiverRotateCode: async ({ storage = null } = {}) => (await ensureCast(storage)).rotateLocalReceiverCode(),
  receiverReportState: async params => (await ensureCast(params.storage)).reportLocalReceiverState(params.state || params),
  stop: () => serial(close)
}

async function handle (line) {
  let msg
  try { msg = JSON.parse(line) } catch { return send({ event: 'fatal', error: 'Malformed message from app' }) }
  try {
    if (typeof msg.event === 'string') {
      Bare.emit('appEvent', msg)
      return
    }
    const method = methods[msg.method]
    if (!method) throw new Error(`Unknown method ${msg.method}`)
    send({ id: msg.id, result: (await method(msg.params || {})) ?? null })
  } catch (err) {
    send({ id: msg.id, error: err?.message || String(err) })
  }
}

let pending = b4a.alloc(0)
ipc.on('data', chunk => {
  pending = b4a.concat([pending, chunk])
  for (let i = b4a.indexOf(pending, 10); i !== -1; i = b4a.indexOf(pending, 10)) {
    const line = b4a.toString(pending.subarray(0, i))
    pending = pending.subarray(i + 1)
    if (line) handle(line)
  }
})

// A worklet error aborts the whole app unless handled here; report it instead. The stack goes to
// the system log (logcat, Console.app), where the app's one-line message can be traced from.
const fatal = err => {
  console.error('worker fatal:', err?.stack || err)
  send({ event: 'fatal', error: String(err?.message || err) })
}
Bare.on('uncaughtException', fatal).on('unhandledRejection', fatal)

// The app suspends the worklet in the background, and the OS grants `linger` ms
// before Bare stops. A short trip out of the app (the app switcher, a system
// sheet) suspends it too, so peers are dropped only if it lasts. LAN discovery
// stops with them; back in front it binds to whatever network the device is
// on by then.
let suspending = null
Bare.on('suspend', linger => {
  // A second suspend before the resume must not leave the first timer behind.
  clearTimeout(suspending)
  suspending = setTimeout(() => {
    suspended = true
    node?.swarm.suspend().catch(fatal)
    serial(moveLan).catch(fatal)
  }, Math.min(linger, 5000))
})
Bare.on('resume', () => {
  clearTimeout(suspending)
  suspended = false
  node?.swarm.resume().catch(fatal)
  serial(moveLan).catch(fatal)
})

// Joining or leaving a network does not suspend the app.
setInterval(() => serial(moveLan).catch(fatal), 10_000)
let wasTransferring = false
setInterval(() => {
  if (!node || suspended) return
  const st = node.status()
  const active = st.downBps > 0 || st.upBps > 0 || st.inflightBlocks > 0
  if (active || wasTransferring) { wasTransferring = active; update() }
}, 2000)
