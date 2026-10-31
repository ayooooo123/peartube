#!/usr/bin/env bare
import 'bare-process/global'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import b4a from 'b4a'
import { createNode } from '../src/index.js'
import { createLan, lanAddress } from '../src/lan.js'
import { createAcquirer } from '../src/acquire.js'
import { createApi } from '../src/http.js'
import { createMirrorHost } from '../src/mirror.js'
import { createCastController } from '../src/cast.js'
import { createSettings } from '../src/settings.js'
import { identify, posterUrl, backdropUrl } from '../src/identify.js'

const env = process.env

// Guard-only mode: the standalone Corestore-free forwarder (bin/private-relay.js, same env), never a content relay.
if (env.PEARTUBE_PRIVATE_RELAY || env.PEARTUBE_PRIVATE_RELAY_PORT) {
  if (env.PEARTUBE_TRACKER || env.PEARTUBE_SOURCES || env.PEARTUBE_PRIVATE_ROUTING || env.PEARTUBE_REPLICATE || env.PEARTUBE_WATCH_DIR || env.PEARTUBE_MIRROR_FEEDS) {
    throw new Error('PEARTUBE_PRIVATE_RELAY runs a standalone Corestore-free guard forwarder and cannot be combined with tracker or content flags; run peartube-private-relay separately')
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
    await node.publishSource({ sourceKey: s.key, kind: s.kind, title: s.alias || s.key.slice(0, 12) }, { target: 'both' })
    autoListed.add(s.key)
    saveAutoListed()
  }
}
function saveSources (list) {
  const keep = list.filter(s => !s.primary && !s.writable).map(({ key, kind, alias }) => ({ key, kind, alias }))
  writeFileSync(sourcesFile + '.tmp', JSON.stringify(keep), { mode: 0o600 })
  renameSync(sourcesFile + '.tmp', sourcesFile)
  syncDirectory(list).catch(() => {})
}
const emptyRoute = () => ({ peers: 0, rxBytes: 0, txBytes: 0, downBps: 0, upBps: 0 })
const state = {
  node: null,
  acquirer: null,
  mirror: null,
  cast: null,
  apiToken: env.PEARTUBE_API_TOKEN || null,
  settings,
  identify: link => identify(link, { cinemetaUrl: cfg('cinemetaUrl') }),
  posterUrl: imdb => posterUrl(cfg('cinemetaUrl'), imdb),
  backdropUrl: imdb => backdropUrl(cfg('cinemetaUrl'), imdb),
  onSourcesChanged: saveSources,
  fallbackStatus: { tracker: cfg('tracker'), channel: '', writer: '', blobs: '', blobBytes: 0, cachedBytes: 0, peers: 0, lanPeers: 0, downBps: 0, upBps: 0, rxBytes: 0, txBytes: 0, routes: { private: emptyRoute(), public: emptyRoute(), lan: emptyRoute() }, inflightBlocks: 0, rtt: 0, retransmits: 0, sources: [], reciprocity: { tier: 'leecher', seededBytes: 0, contributingPeers: 0, ratio: 0, inflightMax: 64 } },
  fallbackJobs () {
    try { return JSON.parse(readFileSync(jobsFile, 'utf8')).map(({ source, announce, ...j }) => j) } catch { return [] }
  }
}
const api = createApi(state)
const apiPort = Number(env.PEARTUBE_API_PORT || 8174)
api.listen(apiPort, env.PEARTUBE_API_HOST || '0.0.0.0')

let shuttingDown = false
let guard = null
let guardConfig = ''
// Opens, reopens and live changes run one at a time through `serial`.
let lifecycle = Promise.resolve()
let mirrorStarting = null
let mirrorHost = null
async function shutdown () {
  if (shuttingDown) return
  shuttingDown = true
  const kill = () => { try { os.kill?.(process.pid, 9) } catch {} process.exit(0) }
  setTimeout(kill, 3000).unref()
  api.close()
  const guardStopped = stopGuard()
  // Let an open or reopen in flight finish (bounded by the kill timer) so its node is closed, not cut off mid-open.
  await Promise.race([lifecycle, new Promise(resolve => setTimeout(resolve, 2000))])
  await stop()
  await guardStopped
  kill()
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, shutdown)
}

const stagger = env.PEARTUBE_LAN_HOST ? Math.max(0, (Number(env.PEARTUBE_LAN_HOST.split('.')[3]) - 111) * 3000) : 0
if (stagger > 0) await new Promise(resolve => setTimeout(resolve, stagger))
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
const mirrorConfig = () => ({
  watchDir: cfg('watchDir') || null,
  feeds: cfg('feeds'),
  replicate: replicateValue(),
  replicateMinFreeBytes: Math.max(0, cfg('replicateFreeGb')) * 1024 * 1024 * 1024,
  replicateMbps: Math.max(0, cfg('replicateMbps'))
})

// The node, its jobs, plugins and cast stack open from the current settings; a reopen closes them and opens them
// again in this process, so settings that shape the node apply without restarting the relay. The API stays up.
async function start () {
  const using = settings.snapshot()
  const node = await createNode({
    storage,
    tracker: cfg('tracker') || null,
    sources: loadSavedSources(),
    allowedPeers: list(cfg('allowedPeers')),
    streamHost: cfg('streamHost'),
    streamPort: cfg('streamPort'),
    bootstrap: list(cfg('bootstrap')) || undefined,
    dhtPort: cfg('dhtPort') || undefined,
    privateRouting: cfg('privateRouting'),
    relayThrough: list(cfg('relayThrough')),
    lan: lanFactory(),
    onchange: () => {
      api.notify('update')
      scheduleReplicate()
    }
  })
  settings.markApplied(using)
  // A relay started without a tracker founds its own, keyed by its writer. Saved sources would otherwise replace it as
  // the primary catalog on the next start (createNode only keeps its own tracker when told the key), hiding its library.
  if (!cfg('tracker')) {
    const { tracker, writer } = node.status()
    if (tracker === writer) settings.remember('tracker', writer)
    // Followed something before this fix: the founded tracker comes back on the next reopen, which the UI offers.
    else settings.update({ tracker: writer })
  }
  state.fallbackStatus.tracker = node.status().tracker
  state.node = node
  await syncDirectory(node.listSources()).catch(err => console.error(JSON.stringify({ msg: 'directory sync failed', error: err.message })))
  state.acquirer = createAcquirer(node, jobsFile, {
    concurrency: cfg('acquireConcurrency'),
    defaultChannel: cfg('publishChannel'),
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
    ...mirrorConfig(),
    hiverelay,
    pluginsDir: env.PEARTUBE_PLUGINS_DIR || join(storage, 'plugins'),
    onchange: () => api.notify('update'),
    onstarting: host => { mirrorHost = host }
  }).then(mirror => { state.mirror = mirror }, err => {
    console.error(JSON.stringify({ msg: 'plugins failed to start', error: err?.message || String(err) }))
  })
  api.notify('update')
}

// The node keeps serving until the plugins have stopped: closing the plugin host first ends a folder import between
// files, so a reopen waits for one file, not the whole import.
async function stop () {
  await mirrorHost?.close().catch(() => {})
  await mirrorStarting
  const { node, acquirer, cast } = state
  state.node = state.acquirer = state.cast = state.mirror = null
  mirrorHost = null
  await cast?.close().catch(() => {})
  acquirer?.close()
  await node?.close().catch(() => {})
  api.notify('update')
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

function serial (fn) {
  if (shuttingDown) return Promise.reject(new Error('The relay is shutting down'))
  const run = lifecycle.then(fn)
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
state.applySettings = changed => serial(async () => {
  const has = (...keys) => keys.some(k => changed.includes(k))
  if (!state.node || changed.some(k => !settings.isLive(k))) {
    await reopen()
  } else {
    const { node } = state
    if (has('allowedPeers')) node.setAllowedPeers(list(cfg('allowedPeers')))
    if (has('acquireConcurrency')) state.acquirer.setConcurrency(cfg('acquireConcurrency'))
    if (has('directory')) await syncDirectory(node.listSources())
    // "Convert at every start": turning it on converts now, as a start would. Off only skips later starts.
    if (has('rechunk') && cfg('rechunk')) {
      await mirrorStarting
      state.mirror?.run('blob-rechunk').catch(() => {})
    }
    if (has('watchDir', 'feeds', 'replicate', 'replicateSources', 'replicateFreeGb', 'replicateMbps')) {
      await mirrorStarting
      state.mirror?.configure(mirrorConfig())
    }
    if (has('lan', 'lanHost')) {
      await state.cast.setLanHost(lanHost()).catch(() => {})
      await node.setLan(lanFactory())
    }
  }
  await applyGuard()
  api.notify('update')
})
// Reopens the node, then brings back an opted-in guard whose process has gone.
state.restart = () => serial(async () => {
  await reopen()
  await applyGuard()
  api.notify('update')
})
await serial(start)
await mirrorStarting
await serial(applyGuard).catch(err => console.error(JSON.stringify({ msg: 'private guard failed to start', error: err.message })))
console.log(JSON.stringify({ msg: 'relay ready', api: apiPort, ...state.node.status() }))
setInterval(() => { if (state.node) console.log(JSON.stringify({ msg: 'heartbeat', ...state.node.status() })) }, 60_000).unref()
