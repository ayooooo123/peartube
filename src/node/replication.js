import Hypercore from 'hypercore'
import ProtomuxWakeup from 'protomux-wakeup'
import hypercoreCrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { HEX64, str } from '../protocol.js'

const STRICT_SCOPES = new Set(['search'])
const isStrictScope = scopeId => STRICT_SCOPES.has(scopeId) || scopeId.startsWith('meta:')
const toHex = buf => (typeof buf === 'string' ? buf.toLowerCase() : b4a.toString(buf, 'hex'))

// Single-Corestore scoped replication: keeps ONE RocksDB Corestore while tracking which Hypercores and
// ProtomuxWakeup topics belong to each scope (`channel:<hex>`, `watch:<hex>`, `meta:<hex>`, `search`).
// Unlike `store.replicate(conn)` (which broadcasts every open `active: true` core to every peer), each
// connection only receives proactive opens for scopes it actually shares, and strict scopes (`search`,
// `meta:*`) refuse discovery-key probes for cores outside their allowed boundary.
export function createReplication (ctx) {
  const topicScopes = new Map() // topicHex -> Set<scopeId>
  const scopeCores = new Map() // scopeId -> Map<discHex, Set<Hypercore>>
  const coreScopes = new Map() // discHex -> Set<scopeId>
  const scopeWakeups = new Map() // scopeId -> ProtomuxWakeup
  const scopeAliases = new Map() // oldScopeId -> currentScopeId
  const conns = new Map() // conn -> ConnState

  function resolveScope (scopeId) {
    let cur = scopeId
    while (scopeAliases.has(cur)) cur = scopeAliases.get(cur)
    return cur
  }

  function addMapSet (map, key, val) {
    let set = map.get(key)
    if (!set) { set = new Set(); map.set(key, set) }
    set.add(val)
  }

  function delMapSet (map, key, val) {
    const set = map.get(key)
    if (!set) return
    set.delete(val)
    if (set.size === 0) map.delete(key)
  }

  function registerTopic (topic, scopeId) {
    if (!topic || !scopeId) return
    const hex = toHex(topic)
    addMapSet(topicScopes, hex, scopeId)
  }

  function unregisterTopic (topic, scopeId) {
    if (!topic || !scopeId) return
    delMapSet(topicScopes, toHex(topic), scopeId)
  }

  function registerDiscoveryKey (discKey, scopeId) {
    if (!discKey || !scopeId) return
    addMapSet(coreScopes, toHex(discKey), scopeId)
  }

  function registerKey (keyHex, scopeId) {
    if (!str(keyHex, HEX64) || !scopeId) return
    const dk = hypercoreCrypto.discoveryKey(b4a.from(keyHex, 'hex'))
    registerDiscoveryKey(dk, scopeId)
  }

  function attachCoreToConn (state, core) {
    if (state.closed || state.conn.destroyed || core.closed || core.closing) return
    core.replicate(state.stream)
  }

  function trackReadyCore (core, scopeId) {
    if (ctx.life.closing || core.closed || core.closing || !core.discoveryKey) return
    const discHex = toHex(core.discoveryKey)
    addMapSet(coreScopes, discHex, scopeId)
    let byDisc = scopeCores.get(scopeId)
    if (!byDisc) { byDisc = new Map(); scopeCores.set(scopeId, byDisc) }
    let sessions = byDisc.get(discHex)
    if (!sessions) { sessions = new Set(); byDisc.set(discHex, sessions) }
    sessions.add(core)
    core.once('close', () => {
      sessions.delete(core)
      if (sessions.size === 0) byDisc.delete(discHex)
      if (byDisc.size === 0) scopeCores.delete(scopeId)
    })
    for (const state of conns.values()) {
      if (state.scopes.has(scopeId) || state.allowedDisc.has(discHex)) {
        attachCoreToConn(state, core)
      }
    }
  }

  function registerBlobCore (core, keyHex) {
    if (!core || !str(keyHex, HEX64)) return core
    const discHex = toHex(hypercoreCrypto.discoveryKey(b4a.from(keyHex, 'hex')))
    const scopes = new Set([`watch:${keyHex}`])
    const known = coreScopes.get(discHex)
    if (known) for (const s of known) scopes.add(s)
    for (const s of scopes) registerCore(core, s)
    return core
  }

  function renameScope (oldId, newId) {
    if (!oldId || !newId || oldId === newId) return
    scopeAliases.set(oldId, newId)
    for (const set of topicScopes.values()) {
      if (set.delete(oldId)) set.add(newId)
    }
    const oldCores = scopeCores.get(oldId)
    if (oldCores) {
      scopeCores.delete(oldId)
      let dest = scopeCores.get(newId)
      if (!dest) { dest = new Map(); scopeCores.set(newId, dest) }
      for (const [dHex, sessions] of oldCores) {
        let ds = dest.get(dHex)
        if (!ds) { ds = new Set(); dest.set(dHex, ds) }
        for (const c of sessions) ds.add(c)
      }
    }
    for (const set of coreScopes.values()) {
      if (set.delete(oldId)) set.add(newId)
    }
    const w = scopeWakeups.get(oldId)
    if (w) {
      scopeWakeups.delete(oldId)
      scopeWakeups.set(newId, w)
    }
    for (const state of conns.values()) {
      if (state.scopes.delete(oldId)) state.scopes.add(newId)
      if (state.wakeupScopes.delete(oldId)) state.wakeupScopes.add(newId)
    }
  }

  function markStrictIfUnscoped (conn, scopeId) {
    const state = conns.get(conn)
    if (!state || state.closed) return
    if (state.scopes.size === 0) {
      state.strict = true
      state.scopes.add(scopeId)
    }
  }

  function registerCore (core, scopeId) {
    if (!core || !scopeId) return core
    const targetScope = resolveScope(scopeId)
    if (core.discoveryKey) {
      trackReadyCore(core, targetScope)
    } else {
      core.ready().then(() => trackReadyCore(core, resolveScope(scopeId)), () => {})
    }
    return core
  }

  // Wraps a Corestore namespace so every Hypercore opened by Autobee (bootstrap, local, system, view,
  // remote writers, fast-forward landings) is automatically registered under `scopeId`.
  function scopeStore (storeSession, scopeId) {
    const wrap = {
      get ns () { return storeSession.ns },
      get storage () { return storeSession.storage },
      get primaryKey () { return storeSession.primaryKey },
      get readOnly () { return storeSession.readOnly },
      get manifestVersion () { return storeSession.manifestVersion },
      ready: () => storeSession.ready(),
      close: () => storeSession.close(),
      findingPeers: () => storeSession.findingPeers(),
      createKeyPair: (name, ns) => storeSession.createKeyPair(name, ns),
      getAuth: dk => storeSession.getAuth(dk),
      list: ns => storeSession.list(ns),
      purge: (keys, opts) => storeSession.purge(keys, opts),
      watch: fn => storeSession.watch(fn),
      unwatch: fn => storeSession.unwatch(fn),
      notifyGroup: topic => storeSession.notifyGroup(topic),
      session: opts => scopeStore(storeSession.session(opts), scopeId),
      namespace: (name, opts) => scopeStore(storeSession.namespace(name, opts), scopeId),
      get: opts => registerCore(storeSession.get(opts), scopeId)
    }
    return wrap
  }

  function installWakeupRouter (state) {
    if (state.closed || state.conn.destroyed) return
    state.muxer.pair({ protocol: 'wakeup' }, id => onIncomingWakeup(state, id))
  }

  function attachWakeupScope (state, scopeId) {
    if (state.closed || state.conn.destroyed || state.wakeupScopes.has(scopeId)) return
    const wakeup = scopeWakeups.get(scopeId)
    if (!wakeup) return
    state.wakeupScopes.add(scopeId)
    const wire = () => {
      if (state.closed || state.conn.destroyed) return
      wakeup.addStream(state.stream)
      installWakeupRouter(state)
    }
    if (state.conn.connected) wire()
    else state.conn.once('open', wire)
  }

  function wakeupFor (scopeId) {
    let w = scopeWakeups.get(scopeId)
    if (w) return w
    w = new ProtomuxWakeup()
    scopeWakeups.set(scopeId, w)
    for (const state of conns.values()) {
      if (state.scopes.has(scopeId)) attachWakeupScope(state, scopeId)
    }
    return w
  }

  function getWakeupSessions (scopeId, key, opts) {
    const w = scopeWakeups.get(scopeId)
    return w ? w.getSessions(key, opts) : []
  }

  function destroyWakeup (scopeId) {
    const w = scopeWakeups.get(scopeId)
    if (!w) return
    scopeWakeups.delete(scopeId)
    w.destroy()
  }

  function grantScope (state, scopeId) {
    if (!state || state.closed || state.conn.destroyed || !scopeId) return
    if (state.scopes.has(scopeId)) return
    state.scopes.add(scopeId)
    attachWakeupScope(state, scopeId)
    const byDisc = scopeCores.get(scopeId)
    if (!byDisc) return
    for (const [, sessions] of byDisc) {
      for (const core of sessions) {
        if (!core.closed && !core.closing) {
          attachCoreToConn(state, core)
          break
        }
      }
    }
  }

  function onIncomingWakeup (state, id) {
    if (state.closed || state.conn.destroyed || !id) return
    const scopes = topicScopes.get(toHex(id))
    if (!scopes || scopes.size === 0) return
    for (const scopeId of scopes) {
      if (state.strict && !state.scopes.has(scopeId)) continue
      grantScope(state, scopeId)
    }
  }

  function findLiveCore (discHex) {
    const scopes = coreScopes.get(discHex)
    if (scopes) {
      for (const scopeId of scopes) {
        const sessions = scopeCores.get(scopeId)?.get(discHex)
        if (!sessions) continue
        for (const c of sessions) {
          if (!c.closed && !c.closing) return c
        }
      }
    }
    return null
  }

  function isDiscAuthorized (state, discHex) {
    if (state.allowedDisc.has(discHex)) return true
    const scopes = coreScopes.get(discHex)
    if (scopes) {
      for (const scopeId of scopes) {
        if (state.scopes.has(scopeId)) return true
      }
      if (state.strict) return false
      // Non-strict connection: peer proved knowledge of a 256-bit discoveryKey belonging to a local scope.
      // Admit only the matching non-strict scope(s) without exposing any other scope.
      let admitted = false
      for (const scopeId of scopes) {
        if (isStrictScope(scopeId)) continue
        grantScope(state, scopeId)
        admitted = true
      }
      return admitted
    }
    return !state.strict
  }

  async function onDiscoveryKey (state, discoveryKey) {
    if (ctx.life.closing || state.closed || state.conn.destroyed) return
    const discHex = toHex(discoveryKey)
    if (!isDiscAuthorized(state, discHex)) return

    const live = findLiveCore(discHex)
    if (live) {
      attachCoreToConn(state, live)
      return
    }

    // Core is closed at rest (e.g. owned 1-per-video Hypercore): open a weak inactive session only if stored locally.
    const core = ctx.storage.store.get({ discoveryKey, active: false, weak: true })
    try {
      await core.ready()
    } catch {
      await core.close().catch(() => {})
      return
    }
    if (ctx.life.closing || state.closed || state.conn.destroyed) {
      await core.close().catch(() => {})
      return
    }
    attachCoreToConn(state, core)
    state.weakCores.add(core)
    core.once('close', () => state.weakCores.delete(core))
  }

  function scopesFromTopics (topics) {
    const out = new Set()
    if (!Array.isArray(topics)) return out
    for (const t of topics) {
      const scopes = topicScopes.get(toHex(t))
      if (!scopes) continue
      for (const s of scopes) out.add(s)
    }
    return out
  }

  function attach (conn, peerInfo = null) {
    const existing = conns.get(conn)
    if (existing) {
      const extra = scopesFromTopics(peerInfo?.topics)
      for (const s of extra) {
        if (!existing.strict || existing.scopes.has(s)) grantScope(existing, s)
      }
      return existing.stream
    }
    const state = {
      conn,
      stream: null,
      muxer: null,
      scopes: new Set(),
      allowedDisc: new Set(),
      wakeupScopes: new Set(),
      weakCores: new Set(),
      strict: false,
      closed: false
    }
    state.stream = Hypercore.createProtocolStream(conn, {
      ondiscoverykey: dk => {
        onDiscoveryKey(state, dk).catch(() => {})
      }
    })
    state.muxer = Hypercore.getProtocolMuxer(state.stream)
    conns.set(conn, state)

    const initial = scopesFromTopics(peerInfo?.topics)
    if (initial.size > 0 && [...initial].every(isStrictScope)) {
      state.strict = true
    }
    installWakeupRouter(state)
    for (const scopeId of initial) grantScope(state, scopeId)

    conn.once('close', () => {
      state.closed = true
      conns.delete(conn)
      for (const c of state.weakCores) c.close().catch(() => {})
      state.weakCores.clear()
    })
    return state.stream
  }

  function grantTopicsOnConn (conn, topics) {
    const state = conns.get(conn)
    if (!state || state.closed) return
    for (const scopeId of scopesFromTopics(topics)) {
      if (state.strict && !state.scopes.has(scopeId)) continue
      grantScope(state, scopeId)
    }
  }

  // Grants a single blob core on a specific connection (e.g. a public global-search hit returned on a strict `search` conn).
  function allowCoreOnConn (conn, keyOrDisc) {
    const state = conns.get(conn)
    if (!state || state.closed || !keyOrDisc) return
    const dk = typeof keyOrDisc === 'string' && HEX64.test(keyOrDisc)
      ? hypercoreCrypto.discoveryKey(b4a.from(keyOrDisc, 'hex'))
      : keyOrDisc
    const discHex = toHex(dk)
    state.allowedDisc.add(discHex)
    const live = findLiveCore(discHex)
    if (live) attachCoreToConn(state, live)
  }

  function grantScopeOnPeerTopics (conn, peerInfo) {
    grantTopicsOnConn(conn, peerInfo?.topics)
  }

  // Ad-hoc cores opened directly on `node.store.get(key)` (outside channel/blob helpers, e.g. plugins or
  // direct `joinPeer` links) replicate only on unscoped, non-strict direct connections — never onto channel,
  // search, or metadata connections.
  const adHocCores = new Map() // discHex -> Hypercore
  function onStoreWatch (raw) {
    if (ctx.life.closing || !raw?.discoveryKey) return
    const discHex = toHex(raw.discoveryKey)
    if (coreScopes.has(discHex)) return
    queueMicrotask(() => {
      if (ctx.life.closing || coreScopes.has(discHex) || adHocCores.has(discHex)) return
      const direct = [...conns.values()].filter(s => !s.closed && !s.strict && s.scopes.size === 0)
      if (direct.length === 0) return
      const openOpts = raw.key ? { key: raw.key, active: false, weak: true } : { discoveryKey: raw.discoveryKey, active: false, weak: true }
      const sess = ctx.storage.store.get(openOpts)
      adHocCores.set(discHex, sess)
      sess.once('close', () => { if (adHocCores.get(discHex) === sess) adHocCores.delete(discHex) })
      sess.ready().then(() => {
        if (ctx.life.closing || sess.closed || coreScopes.has(discHex)) { sess.close().catch(() => {}); return }
        for (const state of conns.values()) {
          if (!state.closed && !state.strict && state.scopes.size === 0) attachCoreToConn(state, sess)
        }
      }, () => { sess.close().catch(() => {}) })
    })
  }
  ctx.storage.store.watch(onStoreWatch)

  function destroy () {
    ctx.storage.store.unwatch(onStoreWatch)
    for (const c of adHocCores.values()) c.close().catch(() => {})
    adHocCores.clear()
    for (const w of scopeWakeups.values()) w.destroy()
    scopeWakeups.clear()
    for (const state of conns.values()) {
      state.closed = true
      for (const c of state.weakCores) c.close().catch(() => {})
      state.weakCores.clear()
    }
    conns.clear()
  }

  return {
    registerTopic,
    unregisterTopic,
    registerDiscoveryKey,
    registerKey,
    registerCore,
    registerBlobCore,
    renameScope,
    markStrictIfUnscoped,
    scopeStore,
    wakeupFor,
    getWakeupSessions,
    destroyWakeup,
    attach,
    grantScope: (conn, scopeId) => grantScope(conns.get(conn), scopeId),
    grantTopicsOnConn,
    grantScopeOnPeerTopics,
    allowCoreOnConn,
    destroy
  }
}
