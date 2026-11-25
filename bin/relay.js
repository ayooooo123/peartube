#!/usr/bin/env bare
import 'bare-process/global'
import { spawn } from 'node:child_process'
import { createServer as createHttpsServer } from 'node:https'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import b4a from 'b4a'
import { createNode, followedSources, idleStatus } from '../src/index.js'
import { createLan, lanAddress } from '../src/lan.js'
import { createAcquirer, publicJob } from '../src/acquire.js'
import { createApi } from '../src/http.js'
import { createMirrorHost } from '../src/mirror.js'
import { createCastController } from '../src/cast.js'
import { createSettings, relayKeyPair } from '../src/settings.js'
import { createDiscover } from '../src/discover.js'
import { send as fetchArt } from '../src/art.js'
import { identify, posterUrl, backdropUrl, ubitInfo, downloadPage } from '../src/identify.js'
import { API_PORT } from '../src/protocol.js'

const env = process.env
// A flag env var: unset, empty, `0` and `false` are off.
const on = s => Boolean(s) && s !== '0' && s !== 'false'

// Guard-only mode: the standalone Corestore-free forwarder (bin/private-relay.js, same env), never a content relay.
if (on(env.PEARTUBE_PRIVATE_RELAY) || env.PEARTUBE_PRIVATE_RELAY_PORT) {
  if (env.PEARTUBE_CHANNEL || env.PEARTUBE_SOURCES || on(env.PEARTUBE_PRIVATE_ROUTING) || on(env.PEARTUBE_REPLICATE) || env.PEARTUBE_WATCH_DIR || env.PEARTUBE_MIRROR_FEEDS) {
    throw new Error('PEARTUBE_PRIVATE_RELAY runs a standalone Corestore-free guard forwarder and cannot be combined with channel or content flags; run peartube-private-relay separately')
  }
  await import('./private-relay.js')
  await new Promise(() => {})
}
const storage = env.PEARTUBE_STORAGE || './peartube-data'
mkdirSync(storage, { recursive: true, mode: 0o700 })
// Everything below reads settings: settings.json (set from the UI) wins, then an env var, then the default.
const settings = createSettings(storage, env)
const cfg = settings.get
const jobsFile = join(storage, 'jobs.json')
const ubitConfigDir = env.UBIT_CONFIG_DIR || join(storage, 'ubit')
const sourcesFile = join(storage, 'sources.json')
function loadSavedSources () {
  const saved = (() => { try { return JSON.parse(readFileSync(sourcesFile, 'utf8')) } catch { return [] } })()
  const fromEnv = env.PEARTUBE_SOURCES ? env.PEARTUBE_SOURCES.split(',').map(s => s.trim()).filter(Boolean) : []
  return [...saved, ...fromEnv]
}
// Followed sources the `directory` setting listed on its own (private, beside jobs.json). Turning the setting off
// unlists exactly these, so sources listed by hand with "Add to directory" stay listed.
const directoryFile = join(storage, 'directory.json')
let autoListed = (() => { try { return new Set(JSON.parse(readFileSync(directoryFile, 'utf8'))) } catch { return null } })()
function saveAutoListed () {
  writeFileSync(directoryFile + '.tmp', JSON.stringify([...autoListed]), { mode: 0o600 })
  renameSync(directoryFile + '.tmp', directoryFile)
}
let directorySync = Promise.resolve()
function syncDirectory (list) {
  const run = directorySync.then(() => reconcileDirectory(list))
  directorySync = run.catch(() => {})
  return run
}
async function reconcileDirectory (list) {
  const node = state.node
  if (!node) return
  const published = new Set((await node.publishedSources()).map(p => p.key))
  if (!cfg('directory')) {
    // A relay that first runs this with the setting off listed nothing on its own: start an empty record, so turning
    // the setting on later never mistakes sources listed by hand for its own.
    if (!autoListed) {
      autoListed = new Set()
      saveAutoListed()
    }
    if (!autoListed.size) return
    for (const key of [...autoListed]) {
      if (published.has(key)) await node.unpublishSource(key)
      autoListed.delete(key)
      saveAutoListed()
    }
    return
  }
  // Before this file existed, a relay with the setting on listed every followed source itself.
  if (!autoListed) {
    autoListed = new Set(list.filter(s => !s.primary && published.has(s.key)).map(s => s.key))
    saveAutoListed()
  }
  for (const s of list) {
    if (s.primary || published.has(s.key)) continue
    await node.publishSource({ sourceKey: s.key, title: s.alias || s.key.slice(0, 12) })
    autoListed.add(s.key)
    saveAutoListed()
  }
}
function saveSources (list) {
  const keep = followedSources(list)
  writeFileSync(sourcesFile + '.tmp', JSON.stringify(keep), { mode: 0o600 })
  renameSync(sourcesFile + '.tmp', sourcesFile)
  syncDirectory(list).catch(() => {})
}
const readOpt = p => { try { return p ? readFileSync(p) : null } catch { return null } }
const tlsCert = readOpt(env.PEARTUBE_TLS_CERT || join(storage, 'tls.crt'))
const tlsKey = readOpt(env.PEARTUBE_TLS_KEY || join(storage, 'tls.key'))
const tlsCa = readOpt(env.PEARTUBE_TLS_CA || join(storage, 'ca.crt'))
const state = {
  node: null,
  tls: (tlsCert && tlsKey) ? { cert: tlsCert, key: tlsKey, ca: tlsCa } : (tlsCa ? { ca: tlsCa } : null),
  acquirer: null,
  mirror: null,
  cast: null,
  apiToken: env.PEARTUBE_API_TOKEN || null,
  settings,
  discover: null,
  identify: link => identify(link, { cinemetaUrl: cfg('cinemetaUrl'), configDir: ubitConfigDir }),
  posterUrl: imdb => posterUrl(cfg('cinemetaUrl'), imdb),
  backdropUrl: imdb => backdropUrl(cfg('cinemetaUrl'), imdb),
  onSourcesChanged: saveSources,
  fallbackStatus: { ...idleStatus(), tracker: cfg('channel') },
  fallbackJobs () {
    try { return JSON.parse(readFileSync(jobsFile, 'utf8')).map(publicJob) } catch { return [] }
  }
}
const api = createApi(state)
state.discover = createDiscover({
  storage,
  fetchBytes: (url, opts = {}) => fetchArt(url, {
    binary: true,
    timeoutMs: opts.timeoutMs || 12_000,
    maxBytes: opts.maxBytes || 4 * 1024 * 1024,
    headers: opts.headers || {}
  }),
  getMirror: () => state.mirror,
  getEntries: () => state.node?.search(null) ?? [],
  onchange: () => api.notify('update')
})
// The HTTPS listener lives here, not in http.js: the apps' worklet imports http.js and must not bundle TLS.
const apiHttps = state.tls?.cert && state.tls?.key ? createHttpsServer({ cert: state.tls.cert, key: state.tls.key }, (req, res) => api.emit('request', req, res)) : null
api.once('close', () => apiHttps?.close())
const apiPort = Number(env.PEARTUBE_API_PORT || API_PORT)
const httpsPort = Number(env.PEARTUBE_HTTPS_PORT ?? 8443)
const apiHost = env.PEARTUBE_API_HOST || '0.0.0.0'
api.listen(apiPort, apiHost)
if (apiHttps && httpsPort > 0) apiHttps.listen(httpsPort, apiHost)
let shuttingDown = false
let guard = null
let guardConfig = ''
// Opens, reopens and live changes run one at a time through `serial`.
let lifecycle = Promise.resolve()
let mirrorStarting = null
let mirrorHost = null
// The stop in flight, if any. A restart and a shutdown signal can both ask for one, and they share it.
let stopping = null
// Set once a node's close() has failed: that node may still hold the store open.
let closeFailure = null
async function shutdown () {
  if (shuttingDown) return
  shuttingDown = true
  // Only a shutdown that hangs is killed; a clean one exits 0, so service managers see a normal stop.
  setTimeout(() => { try { os.kill?.(process.pid, 9) } catch {} process.exit(1) }, 3000).unref()
  api.close()
  const guardStopped = stopGuard()
  // A step in flight gets 2 s to end by itself. An open that finishes in that time has its node closed below, not cut
  // off mid-open. A reopen ends with its stop, because `start` opens nothing from now on; if that stop takes longer,
  // the stop below is the same one. The kill timer bounds all of it.
  await Promise.race([lifecycle, new Promise(resolve => setTimeout(resolve, 2000))])
  // A stop that failed is not a clean exit: a node that did not close, in this stop or in an earlier restart, may
  // still hold the store open. Say why and exit 1.
  let failure = null
  try { await stop() } catch (err) { failure = reasonOf(err) }
  await guardStopped
  if (failure) console.error(JSON.stringify({ msg: 'relay did not stop cleanly', error: failure }))
  process.exit(failure ? 1 : 0)
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, shutdown)
}

// Why something failed, as text for the owner. A value that cannot be read still leaves a failure to report.
function reasonOf (err) {
  let text = ''
  try { text = String(err?.message || err) } catch {}
  return text || 'the reason could not be read'
}
const list = value => value.length ? value : null
const replicateValue = () => cfg('replicate') ? (cfg('replicateSources').length ? cfg('replicateSources') : true) : false
const lanHost = () => cfg('lanHost') || lanAddress(os.networkInterfaces())
// LAN discovery is a live setting: on with an address, off without one.
function lanFactory () {
  const host = cfg('lan') ? lanHost() : null
  return host ? keyPair => createLan({ host, keyPair }) : null
}
const hiverelayOpt = () => ({
  relays: cfg('hiverelays').join(','),
  apiKey: cfg('hiverelayApiKey') || null,
  discover: cfg('hiverelayDiscover') || env.PEARTUBE_HIVERELAY === '1' || env.PEARTUBE_HIVERELAY === 'true',
  replicas: cfg('hiverelayReplicas'),
  includeCached: Boolean(replicateValue()),
  uploadMbps: Math.max(0, cfg('hiverelayUploadMbps'))
})
let hiverelayEnabled = false
let replicateDebounce = null
function scheduleReplicate () {
  if ((!cfg('replicate') && !hiverelayEnabled) || shuttingDown || replicateDebounce) return
  replicateDebounce = setTimeout(() => {
    replicateDebounce = null
    if (shuttingDown) return
    if (cfg('replicate')) state.mirror?.run('p2p-replicate').catch(() => {})
    if (hiverelayEnabled) state.mirror?.run('hiverelay-seed').catch(() => {})
  }, 2000)
  replicateDebounce.unref?.()
}
// The import folder is env-only, like the storage and plugins folders: the host chooses folders on its disk.
const watchDir = env.PEARTUBE_WATCH_DIR || null
const mirrorConfig = () => ({
  feeds: cfg('feeds'),
  replicate: replicateValue(),
  replicateMinFreeBytes: Math.max(0, cfg('replicateFreeGb')) * 1024 * 1024 * 1024,
  replicateMbps: Math.max(0, cfg('replicateMbps')),
  mediaCheck: cfg('globalSearch'),
  slskUser: cfg('slskUser'),
  slskPass: cfg('slskPass'),
  slskServer: cfg('slskServer')
})
// Global search answers (src/search.js) offer only files the `media-check` plugin found to be media.
const searchServe = () => cfg('globalSearch') ? { isMedia: key => Boolean(state.mirror?.isMedia(key)) } : null

// The node, its jobs, plugins and cast stack open from the current settings; a reopen closes them and opens them
// again in this process, so settings that shape the node apply without restarting the relay. The API stays up.
async function start () {
  // A reopen whose stop ended after a shutdown signal gets no replacement node.
  assertRunning()
  const using = settings.snapshot()
  const node = await createNode({
    storage,
    keyPair: relayKeyPair(storage),
    tracker: cfg('channel') || null,
    sources: loadSavedSources(),
    allowedPeers: list(cfg('allowedPeers')),
    // The blob server stays on loopback; clients stream through /v1/blob on the API port.
    bootstrap: list(cfg('bootstrap')) || undefined,
    dhtPort: cfg('dhtPort') || undefined,
    privateRouting: cfg('privateRouting'),
    relayThrough: list(cfg('relayThrough')),
    lan: lanFactory(),
    announceCache: true,
    onchange: () => {
      api.notify('update')
      scheduleReplicate()
    }
  })
  settings.markApplied(using)
  // A relay started without a channel founds its own, keyed by its writer. Saved sources would otherwise replace it as
  // the primary catalog on the next start (createNode only keeps its own catalog when told the key), hiding its library.
  if (!cfg('channel')) {
    const { tracker, writer } = node.status()
    if (tracker === writer) settings.remember('channel', writer)
    // Followed something before this fix: the founded channel comes back on the next reopen, which the UI offers.
    else settings.update({ channel: writer })
  }
  state.fallbackStatus.tracker = node.status().tracker
  state.node = node
  node.serveSearch(searchServe())
  await syncDirectory(node.listSources()).catch(err => console.error(JSON.stringify({ msg: 'directory sync failed', error: err.message })))
  state.acquirer = createAcquirer(node, jobsFile, {
    concurrency: cfg('acquireConcurrency'),
    defaultChannel: cfg('publishChannel'),
    ubitConfigDir,
    onDone: () => {
      api.notify('update')
      scheduleReplicate()
    }
  })
  state.cast = createCastController({
    storage,
    getNode: () => state.node,
    getLanHost: lanHost,
    onchange: () => api.notify('cast')
  })
  await state.cast.setLanHost(lanHost()).catch(() => {})
  const hiverelay = hiverelayOpt()
  hiverelayEnabled = Boolean(hiverelay.relays || hiverelay.discover)
  // Plugins start after the node answers: the channel backfill and folder scan can take a while on a large library.
  mirrorStarting = createMirrorHost({
    node,
    storage,
    acquirer: state.acquirer,
    mirrorChannel: cfg('publishChannel'),
    rechunk: cfg('rechunk'),
    watchDir,
    ...mirrorConfig(),
    slskListenPort: cfg('slskListenPort'),
    slskShare: cfg('slskShare'),
    slskShareMaxFiles: cfg('slskShareMaxFiles'),
    soulseekOpts: { persistJobs: true },
    youtube: {
      info: (query, opts) => ubitInfo(query, { configDir: ubitConfigDir, ...opts }),
      download: (url, dir, opts) => downloadPage(url, dir, { configDir: ubitConfigDir, ...opts })
    },
    hiverelay,
    pluginsDir: env.PEARTUBE_PLUGINS_DIR || join(storage, 'plugins'),
    onchange: () => api.notify('update'),
    onstarting: host => {
      mirrorHost = host
      // A stop that began while the plugins were still loading closes the host now, before it starts any work. So
      // does a shutdown signal: shutdown may still be waiting for a step in flight, and then no stop has begun yet.
      // ast-grep-ignore: close-error-dropped -- starts close early while closeAll awaits the same shared promise
      if (stopping || shuttingDown) host.close().catch(() => {})
    }
  }).then(mirror => { state.mirror = mirror }, err => {
    console.error(JSON.stringify({ msg: 'plugins failed to start', error: err?.message || String(err) }))
  })
  api.notify('update')
}

// The node keeps serving until the plugins have stopped: closing the plugin host first ends a folder import between
// files, so a reopen waits for one file, not the whole import. One stop runs at a time: a second caller (a shutdown
// signal during a restart) gets the stop in flight, and returns only when that stop has closed the node.
// A node whose close() fails (it rejects, or it throws before it returns its promise) may still hold the store open,
// and no later close can reach it. `stop` rejects with that failure, then and on every later call: a reopen opens no
// node on the same storage in this process (the caller gets the reason), and shutdown does not exit 0.
function stop () {
  if (stopping) return stopping
  const { promise, resolve } = Promise.withResolvers()
  stopping = promise
  resolve(closeAll().finally(() => { stopping = null }))
  return promise
}
async function closeAll () {
  // ast-grep-ignore: close-error-dropped -- plugin stop failures must not block closing the node (PR #585)
  await mirrorHost?.close().catch(() => {})
  // Plugins that are still loading have no host to close yet: `onstarting` closes it, and the second close waits
  // for its stops.
  await mirrorStarting
  // ast-grep-ignore: close-error-dropped -- plugin stop failures must not block closing the node (PR #585)
  await mirrorHost?.close().catch(() => {})
  const { node, acquirer, cast } = state
  state.node = state.acquirer = state.cast = state.mirror = null
  mirrorHost = null
  await cast?.close().catch(() => {})
  acquirer?.close()
  try {
    await node?.close()
  } catch (err) {
    closeFailure = Object.assign(new Error(`The node did not close: ${reasonOf(err)}. Stop the relay process and start it again.`), { status: 500 })
  }
  api.notify('update')
  if (closeFailure) throw closeFailure
}

// Guard forwarder for other peers' 2-hop private routing: bin/private-relay.js in its own process, so it never shares
// this Corestore's process, with its own HyperDHT, port and a fresh key each start. This relay's connections stay direct.
const guardScript = decodeURIComponent(new URL('./private-relay.js', import.meta.url).pathname)
function spawnGuard (port, bootstrap) {
  const childEnv = { PATH: env.PATH || '', PEARTUBE_PRIVATE_RELAY_PORT: String(port), PEARTUBE_GUARD_FOLLOW_PARENT: '1' }
  if (bootstrap.length) childEnv.PEARTUBE_BOOTSTRAP = bootstrap.join(',')
  if (env.PEARTUBE_PRIVATE_HOST) childEnv.PEARTUBE_PRIVATE_HOST = env.PEARTUBE_PRIVATE_HOST
  const child = spawn(process.execPath, [guardScript], { env: childEnv, stdio: ['ignore', 'pipe', 'inherit'] })
  const g = { child, publicKey: '', port: 0, stats: {}, exited: new Promise(resolve => { child.once('exit', resolve); child.once('error', () => resolve(null)) }) }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('privateGuard: the guard did not start within 30 s')) }, 30_000)
    let buf = ''
    child.stdout.on('data', chunk => {
      buf += b4a.toString(chunk)
      for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let msg = null
        try { msg = JSON.parse(line) } catch {}
        if (msg?.msg === 'private-guard ready') {
          Object.assign(g, { publicKey: msg.publicKey, port: msg.port })
          console.log(line)
          clearTimeout(timer)
          resolve(g)
        } else if (msg?.msg === 'private-guard heartbeat') {
          const { msg: _, publicKey, ...stats } = msg
          g.stats = stats
        }
      }
    })
    g.exited.then(code => {
      clearTimeout(timer)
      reject(new Error(`privateGuard: the guard exited (${code})`))
      if (guard === g) {
        guard = null
        guardConfig = ''
        console.error(JSON.stringify({ msg: 'private guard stopped', code }))
        api.notify('update')
      }
    })
  })
}
async function stopGuard () {
  const g = guard
  guard = null
  guardConfig = ''
  if (!g) return
  g.child.kill()
  const t = setTimeout(() => g.child.kill(9), 3000)
  await g.exited
  clearTimeout(t)
}
async function applyGuard () {
  const want = cfg('privateGuard') ? JSON.stringify([cfg('privateGuardPort'), cfg('bootstrap')]) : ''
  if (want === guardConfig) return
  await stopGuard()
  if (!want) return
  const port = cfg('privateGuardPort')
  if (port && port === cfg('dhtPort')) throw new Error('privateGuardPort: use a different port from the peer port')
  guard = await spawnGuard(port, cfg('bootstrap'))
  guardConfig = want
}

// A step that is refused because shutdown has begun fails with this code. Nothing was started for it.
const SHUTTING_DOWN = 'RELAY_SHUTTING_DOWN'
const refusal = () => Object.assign(new Error('The relay is shutting down'), { code: SHUTTING_DOWN })

// Once shutdown has begun, a lifecycle step starts nothing more. `start` and every step that waited its turn call
// this when they begin, and a live settings change calls it after each wait.
function assertRunning () {
  if (shuttingDown) throw refusal()
}
function serial (fn) {
  if (shuttingDown) return Promise.reject(refusal())
  const run = lifecycle.then(() => {
    assertRunning()
    return fn()
  })
  lifecycle = run.catch(() => {})
  return run
}
async function reopen () {
  await stop()
  await start()
}

state.extraStatus = () => {
  const lan = state.node?.lanEndpoint()
  return {
    lan: lan ? { host: lan.host, port: lan.port } : null,
    privateRouting: Boolean(state.node?.privateRouting),
    privateGuard: guard ? { publicKey: guard.publicKey, port: guard.port, ...guard.stats } : null
  }
}
// Live settings apply in place; any other change reopens the node. A failed reopen leaves its keys in `restartNeeded`.
// A live change that had to wait (for the plugins to load, for the directory, for LAN discovery) and goes on after a
// shutdown signal ends there: it starts no plugin run and nothing else, and the saved value applies at the next start.
state.applySettings = changed => serial(async () => {
  const has = (...keys) => keys.some(k => changed.includes(k))
  if (!state.node || changed.some(k => !settings.isLive(k))) {
    await reopen()
  } else {
    const { node } = state
    if (has('allowedPeers')) node.setAllowedPeers(list(cfg('allowedPeers')))
    if (has('acquireConcurrency')) state.acquirer.setConcurrency(cfg('acquireConcurrency'))
    if (has('cacheMaxGb')) state.node.setCacheMaxBytes(cfg('cacheMaxGb') * 1e9)
    if (has('directory')) {
      await syncDirectory(node.listSources())
      assertRunning()
    }
    // "Convert at every start": turning it on converts now, as a start would. Off only skips later starts.
    if (has('rechunk') && cfg('rechunk')) {
      await mirrorStarting
      assertRunning()
      state.mirror?.run('blob-rechunk').catch(() => {})
    }
    if (has('feeds', 'replicate', 'replicateSources', 'replicateFreeGb', 'replicateMbps', 'globalSearch', 'slskUser', 'slskPass', 'slskServer')) {
      await mirrorStarting
      assertRunning()
      state.mirror?.configure(mirrorConfig())
    }
    if (has('globalSearch')) node.serveSearch(searchServe())
    if (has('lan', 'lanHost')) {
      await state.cast.setLanHost(lanHost()).catch(() => {})
      assertRunning()
      await node.setLan(lanFactory())
      assertRunning()
    }
  }
  await applyGuard()
  api.notify('update')
})
state.recoverMnemonic = (mnemonic, alias = '') => serial(async () => {
  if (!state.node) throw new Error('Node still starting')
  const res = await state.node.claimWithMnemonic(mnemonic, { alias })
  if (res.reopenNeeded) {
    settings.update({ channel: res.channel })
    await reopen()
    if (state.node) await state.node.claimWithMnemonic(mnemonic, { alias })
  }
  api.notify('update')
  return state.node ? state.node.identity() : res
})
// Reopens the node, then brings back an opted-in guard whose process has gone.
state.restart = () => serial(async () => {
  await reopen()
  await applyGuard()
  api.notify('update')
})
await serial(start)
await mirrorStarting
// After a shutdown signal there is no node to announce: `shutdown` ends the process. A step that was refused because
// of the signal is a guard that the relay never tried to start, and is not reported. Every other failure is reported,
// also after the signal: a guard that did start and then exited is a failure the owner has to see.
if (!shuttingDown) await serial(applyGuard).catch(err => { if (err?.code !== SHUTTING_DOWN) console.error(JSON.stringify({ msg: 'private guard failed to start', error: err.message })) })
if (!shuttingDown) console.log(JSON.stringify({ msg: 'relay ready', api: apiPort, ...(apiHttps && httpsPort > 0 ? { https: httpsPort } : {}), ...state.node.status() }))
setInterval(() => { if (state.node) console.log(JSON.stringify({ msg: 'heartbeat', ...state.node.status() })) }, 60_000).unref()
