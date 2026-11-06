import Autobee from 'autobee'
import b4a from 'b4a'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanText, decodeOp, isSystemViewKey, parseUri } from '../protocol.js'
import { makeApply, makeIsTrusted } from '../apply.js'
import { applied } from './channel.js'

export async function createSources (ctx) {
  const { storage, worklet: isWorklet, maxActiveSources, sources: initialSources = [] } = ctx.opts

  // O(1) active channel pool: even with 1,000+ followed channels, keep at most `activeSourceCap` Autobees
  // and overlay topics open in RAM while hibernated channels serve instant cached views and rotate smoothly.
  const activeSourceCap = Math.max(1, Number(maxActiveSources) || (isWorklet ? 8 : 24))
  const extraSources = new Map()
  const activeSources = new Set()
  let primaryAlias = ''
  let touchClock = 0

  const catalogCacheFile = join(storage, 'catalog-cache.json')
  let savedCatalog = {}
  try { savedCatalog = JSON.parse(readFileSync(catalogCacheFile, 'utf8'))?.channels || {} } catch {}
  let catalogSaveTimer = null
  let catalogCacheDirty = false

  function flushCatalogCache () {
    if (catalogSaveTimer) { clearTimeout(catalogSaveTimer); catalogSaveTimer = null }
    if (!catalogCacheDirty) return
    catalogCacheDirty = false
    try {
      const channels = {}
      for (const [k, s] of extraSources) {
        if (!s.hydrated) continue
        channels[k] = {
          syncedAt: s.syncedAt || 0,
          entries: s.entries.map(it => [it.sub, it.entry]),
          discovered: s.discovered
        }
      }
      const tmp = `${catalogCacheFile}.tmp.${process.pid}`
      writeFileSync(tmp, JSON.stringify({ version: 1, channels }), { mode: 0o600 })
      renameSync(tmp, catalogCacheFile)
    } catch {}
  }

  function scheduleCatalogSave () {
    catalogCacheDirty = true
    if (ctx.life.closing || catalogSaveTimer) return
    catalogSaveTimer = setTimeout(flushCatalogCache, 5_000)
    catalogSaveTimer.unref?.()
  }

  let lastSwarmFlushAt = 0

  function indexChannelRecords (target, entriesList, discoveredList, { merge = false } = {}) {
    // A view can be read while it is still catching up, and a follower's scan then holds fewer
    // announces than the library already knows. Replacing wholesale let one partial read wipe the
    // catalog down to a single title; merging keeps what was already proven and adds what is new.
    const byId = merge ? new Map(target.byId) : new Map()
    const bySub = merge ? new Map(target.bySub) : new Map()
    const entries = merge ? new Map(target.entries.map(it => [it.sub, it])) : new Map()
    for (const item of entriesList) {
      if (!bySub.has(item.sub)) {
        let bucket = byId.get(item.entry.id)
        if (!bucket) { bucket = []; byId.set(item.entry.id, bucket) }
        bucket.push(item)
      }
      bySub.set(item.sub, item.entry)
      entries.set(item.sub, item)
    }
    target.entries = [...entries.values()]
    target.byId = byId
    target.bySub = bySub
    target.discovered = discoveredList
  }

  async function scanChannelView (view, viaKey) {
    const entriesList = []
    const discoveredList = []
    for await (const node of view.createReadStream()) {
      const sub = b4a.toString(node.key)
      if (sub.startsWith('source/')) {
        const op = decodeOp(node.value)
        if (op?.type === 'source') {
          discoveredList.push({ key: op.sourceKey, kind: 'channel', title: cleanText(op.title, op.sourceKey.slice(0, 12)), via: viaKey })
        }
      } else if (!isSystemViewKey(sub)) {
        const op = decodeOp(node.value)
        if (op?.type === 'announce') entriesList.push({ sub, entry: op })
      }
    }
    return { entriesList, discoveredList }
  }

  async function refreshSourceCache (src, { waitSync = true, force = false } = {}) {
    if (!src?.bee || ctx.life.closing) return
    // A forced tick is the background's own read: it gives the linearizer room to fetch (the 1 s
    // cap `applied()` uses is for foreground reads that must not hang the UI), then walks the view.
    if (force) {
      // A channel we already hold is a refresh: let the topic lookups answer first, or `update()`
      // returns at once against whatever peer spoke last. This is throttled across the node —
      // paying it per channel would stall rotating a large library for no extra truth.
      if (src.hydrated && Date.now() - lastSwarmFlushAt > 10_000) {
        lastSwarmFlushAt = Date.now()
        await Promise.race([ctx.net.swarm.flush().catch(() => {}), new Promise(r => setTimeout(r, 3_000))])
      }
      // Autobee goes quiet once a writer looks whole against the first hint it heard, and the
      // publisher's coupler skips announcing a core this peer already has open — so a follower
      // that met a partial peer first stays partial forever. Asking again makes the publisher
      // answer with its real length, which reactivates the writer and resumes the download.
      for (const session of ctx.channel.wakeup.getSessions(src.bee.key, { discoveryKey: src.bee.discoveryKey })) {
        try { session.broadcastLookup() } catch {}
      }
      await Promise.race([src.bee.update().catch(() => {}), new Promise(r => setTimeout(r, 2_000))])
    } else if (waitSync) await applied(src.bee)
    if (!src.bee || ctx.life.closing) return
    const version = src.bee.view.version
    // `force` is the background tick's read: walking the view is what makes Autobase fetch the
    // blocks it linearizes next, so a view that still owes announces gets them. Gating every read
    // on `version` alone deadlocks — no read, no progress, no new version.
    // A rescan is due when the view moved, a change landed since the last scan (rev), or the record was (re)opened (cachedRev -1).
    if (!force && src.hydrated && src.cachedRev === src.rev && src.viewVersion === version) return
    const revSnap = src.rev
    const previousVersion = src.viewVersion
    // A follower's view grows only while something walks it. One pass can leave the linearizer
    // parked on a block nobody asked for, so the background tick keeps reading until the count
    // stops moving (bounded); that is exactly the scanning `search()` used to do on every call.
    let scan = await scanChannelView(src.bee.view, src.key)
    if (force) {
      for (let pass = 0; pass < 5 && !ctx.life.closing; pass++) {
        const next = await scanChannelView(src.bee.view, src.key)
        if (next.entriesList.length <= scan.entriesList.length) break
        scan = next
        await new Promise(resolve => setTimeout(resolve, 400))
      }
    }
    const { entriesList, discoveredList } = scan
    const prevCount = src.entries.length
    indexChannelRecords(src, entriesList, discoveredList, { merge: true })
    src.cachedRev = revSnap
    src.viewVersion = version
    if (revSnap > 0 || entriesList.length > 0 || discoveredList.length > 0) {
      src.hydrated = true
    }
    src.syncedAt = Date.now()
    if (src.hydrated) scheduleCatalogSave()
    if (entriesList.length !== prevCount) ctx.channel.bumpView()
    if (previousVersion >= 0 && previousVersion !== version) ctx.update()
  }

  function ensureSourceRecord (key, alias = '') {
    let src = extraSources.get(key)
    if (src) {
      if (alias) src.alias = alias
      return { src, existed: true }
    }
    src = {
      key,
      kind: 'channel',
      alias,
      bee: null,
      opening: null,
      closing: null,
      rev: 0,
      cachedRev: -1,
      viewVersion: -1,
      hydrated: false,
      touchedAt: 0,
      syncedAt: 0,
      entries: [],
      byId: new Map(),
      bySub: new Map(),
      discovered: []
    }
    const cached = savedCatalog[key]
    if (cached && Array.isArray(cached.entries)) {
      const entriesList = []
      for (const pair of cached.entries) {
        if (Array.isArray(pair) && typeof pair[0] === 'string' && pair[1]?.type === 'announce') {
          entriesList.push({ sub: pair[0], entry: pair[1] })
        }
      }
      indexChannelRecords(src, entriesList, Array.isArray(cached.discovered) ? cached.discovered : [])
      src.hydrated = true
      src.cachedRev = 0
      src.syncedAt = Number(cached.syncedAt) || 0
    }
    extraSources.set(key, src)
    return { src, existed: false }
  }

  async function hibernateSource (src) {
    if (!src?.bee) return
    if (src.closing) return src.closing
    src.closing = (async () => {
      try {
        if (!ctx.life.closing && (src.rev !== src.cachedRev || src.viewVersion !== src.bee.view.version)) {
          await refreshSourceCache(src, { waitSync: false }).catch(() => {})
        }
      } finally {
        const oldBee = src.bee
        src.bee = null
        activeSources.delete(src.key)
        ctx.net.leaveOverlayTopic(`channel:${src.key}`).catch(() => {})
        if (oldBee) await oldBee.close().catch(() => {})
        src.closing = null
      }
    })()
    return src.closing
  }

  let poolGate = Promise.resolve()
  const withPoolLock = fn => {
    const next = poolGate.then(fn, fn)
    poolGate = next.catch(() => {})
    return next
  }

  async function wakeSource (key, { touch = true } = {}) {
    const k = String(key || '').trim().toLowerCase()
    const src = extraSources.get(k)
    if (!src || ctx.life.closing) return null
    if (src.closing) await src.closing
    if (ctx.life.closing || extraSources.get(k) !== src) return null
    if (src.bee) {
      if (touch) src.touchedAt = ++touchClock
      return src.bee
    }
    if (src.opening) {
      const b = await src.opening
      if (b && touch) src.touchedAt = ++touchClock
      return b
    }
    src.opening = withPoolLock(async () => {
      try {
        if (src.closing) await src.closing
        if (src.bee) {
          if (touch) src.touchedAt = ++touchClock
          return src.bee
        }
        while (!ctx.life.closing && activeSources.size >= activeSourceCap) {
          let victim = null
          for (const ak of activeSources) {
            if (ak === k) continue
            const cand = extraSources.get(ak)
            if (!cand?.bee || cand.closing) continue
            if (!victim || cand.touchedAt < victim.touchedAt) victim = cand
          }
          if (!victim) break
          await hibernateSource(victim)
        }
        if (ctx.life.closing || extraSources.get(k) !== src) return null
        let bee = null
        const subApply = makeApply(() => b4a.toString(bee.key, 'hex'))
        bee = new Autobee(ctx.storage.store.namespace(`channel:${k}`), b4a.from(k, 'hex'), {
          apply: subApply,
          update: (view, changes) => { ctx.channel.mirrorLanding(changes); src.rev++; ctx.update() },
          optimistic: true,
          isTrusted: makeIsTrusted(() => b4a.toString(bee.key, 'hex')),
          wakeup: ctx.channel.wakeup
        })
        await bee.ready()
        if (ctx.life.closing || extraSources.get(k) !== src) {
          await bee.close().catch(() => {})
          return null
        }
        src.bee = bee
        src.conns = new WeakSet()
        src.cachedRev = -1
        src.touchedAt = touch ? ++touchClock : 0
        activeSources.add(k)
        ctx.net.joinOverlayTopic(`channel:${k}`, bee.key, bee.discoveryKey)
        for (const conn of ctx.net.peerConns) ctx.net.attachSource(src, conn)
        bee.update().then(() => {
          if (!ctx.life.closing && src.bee === bee) {
            src.cachedRev = -1
            refreshSourceCache(src).then(() => ctx.update()).catch(() => {})
          }
        }).catch(() => {})
        return bee
      } finally {
        src.opening = null
      }
    })
    return src.opening
  }

  async function addSource (spec, { wake = true } = {}) {
    const parsed = parseUri(typeof spec === 'string' ? spec : (spec.uri || spec.key))
    if (parsed.action === 'access') {
      await ctx.identity.addAccessKey({ channel: parsed.channel, epoch: parsed.epoch, key: parsed.epochKey })
      return addSource({ key: parsed.channel, kind: 'channel', alias: spec?.alias ?? parsed.alias }, { wake })
    }
    if (parsed.action !== 'source') throw new Error('Expected a channel source, not a watch URI')
    const { key } = parsed
    const alias = cleanText(spec?.alias ?? parsed.alias)
    if (key === ctx.channel.primaryKey) {
      if (alias) primaryAlias = alias
      ctx.channel.markUsePrimary()
      ctx.net.joinOverlayTopic(`channel:${ctx.channel.primaryKey}`, ctx.channel.channel.key, ctx.channel.channel.discoveryKey)
      ctx.update()
      return { key, kind: 'channel', alias: primaryAlias, primary: true, writable: Boolean(ctx.channel.channel.writable || (ctx.identity.idVault && ctx.identity.idVault.channelKey === ctx.channel.primaryKey)) }
    }
    const { src, existed } = ensureSourceRecord(key, alias)
    if (wake) await wakeSource(key, { touch: true })
    if (!existed || alias) ctx.update()
    return { key, kind: 'channel', alias: src.alias, primary: false, writable: false }
  }

  async function removeSource (key) {
    const k = String(key || '').trim().toLowerCase()
    const src = extraSources.get(k)
    if (!src) return { removed: false }
    extraSources.delete(k)
    delete savedCatalog[k]
    scheduleCatalogSave()
    if (src.opening) await src.opening.catch(() => {})
    await hibernateSource(src)
    await ctx.net.leaveOverlayTopic(`channel:${k}`)
    ctx.update()
    return { removed: true }
  }

  function listSources () {
    const list = []
    if (ctx.channel.usePrimary() || ctx.channel.hasEntries() || primaryAlias) {
      list.push({
        key: ctx.channel.primaryKey,
        kind: 'channel',
        alias: primaryAlias,
        primary: true,
        writable: Boolean(ctx.channel.channel.writable || (ctx.identity.idVault && ctx.identity.idVault.channelKey === ctx.channel.primaryKey))
      })
    }
    for (const s of extraSources.values()) {
      list.push({
        key: s.key,
        kind: 'channel',
        alias: s.alias,
        primary: false,
        writable: false,
        // What this follower actually holds right now: the app can show "390 videos,
        // syncing" instead of pretending a hibernated snapshot is the whole channel.
        entries: s.entries.length,
        active: Boolean(s.bee),
        hydrated: s.hydrated
      })
    }
    return list
  }

  // Register every saved channel in O(1) memory, waking only the first `activeSourceCap` at boot.
  let bootWoken = 0
  for (const s of initialSources) {
    await addSource(s, { wake: bootWoken < activeSourceCap })
    if (extraSources.size > bootWoken) bootWoken = Math.min(activeSourceCap, extraSources.size)
  }

  let rotatingSources = false
  let sourceRotateTimer = null
  function armSourceRotator () {
    if (ctx.life.closing) return
    let unhydrated = false
    for (const s of extraSources.values()) { if (!s.hydrated) { unhydrated = true; break } }
    const delay = unhydrated ? 1_500 : 15_000
    sourceRotateTimer = setTimeout(async () => {
      sourceRotateTimer = null
      if (ctx.life.closing) return
      if (!rotatingSources) {
        rotatingSources = true
        try {
          const prevEpoch = ctx.channel.viewEpoch()
          // An awake channel nobody asks again keeps the view it woke with, and a frozen view
          // serves blob keys its publisher already repointed (a video that never loads).
          for (const s of [...extraSources.values()]) {
            if (ctx.life.closing) break
            if (s.bee && !s.closing) await refreshSourceCache(s, { force: true }).catch(() => {})
          }
          // Dormant channels take their turn even under the cap: a phone follows one channel,
          // so the cap is never reached there and this was the only path that ever woke it.
          const dormant = []
          for (const s of extraSources.values()) {
            if (!s.bee && !s.opening && !s.closing) dormant.push(s)
          }
          dormant.sort((a, b) => (a.hydrated === b.hydrated ? a.syncedAt - b.syncedAt : (a.hydrated ? 1 : -1)))
          const budget = extraSources.size > activeSourceCap ? Math.min(2, activeSourceCap) : dormant.length
          for (const s of dormant.slice(0, budget)) {
            if (ctx.life.closing) break
            const bee = await wakeSource(s.key, { touch: false })
            if (bee) await refreshSourceCache(s).catch(() => {})
          }
          if (ctx.channel.viewEpoch() !== prevEpoch && !ctx.life.closing) ctx.update()
        } finally {
          rotatingSources = false
        }
      }
      armSourceRotator()
    }, delay)
    sourceRotateTimer.unref?.()
  }
  armSourceRotator()
  ctx.undo.push(() => clearTimeout(sourceRotateTimer))

  return {
    extraSources,
    activeSources,
    flushCatalogCache,
    indexChannelRecords,
    scanChannelView,
    refreshSourceCache,
    wakeSource,
    addSource,
    removeSource,
    listSources,
    get sourceRotateTimer () { return sourceRotateTimer },
    set sourceRotateTimer (t) { sourceRotateTimer = t }
  }
}
