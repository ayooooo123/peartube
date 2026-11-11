import b4a from 'b4a'
import hypercoreCrypto from 'hypercore-crypto'
import { cleanText, decodeOp, describeEntry, formatWatchUri, isSystemViewKey, parseUri } from '../protocol.js'
import { applied } from './channel.js'

export function createCatalog (ctx) {
  const ephemeralWatches = new Map()

  async function search (id = null, { source: filterSource = null, query = null, limit = 0, offset = 0 } = {}) {
    if (filterSource && ctx.sources.extraSources.has(filterSource)) {
      await ctx.sources.wakeSource(filterSource, { touch: true })
    }
    const activeRefresh = []
    // An id lookup never walks the whole view: a full scan blocks on regions the view has not
    // downloaded yet, and that delay is exactly what made a co-writer's publish read as absent.
    // `applied()` catches the oplog up; the range read below fetches the key it wants.
    if (id) {
      if (ctx.channel.usePrimary() || ctx.channel.hasEntries()) await applied(ctx.channel.channel)
      for (const s of ctx.sources.extraSources.values()) {
        if (filterSource && filterSource !== s.key) continue
        if (s.bee) await applied(s.bee)
      }
    } else {
      if ((ctx.channel.usePrimary() || ctx.channel.hasEntries()) && (!filterSource || filterSource === ctx.channel.primaryKey)) {
        activeRefresh.push(ctx.channel.refreshPrimaryCache())
      }
      for (const s of ctx.sources.extraSources.values()) {
        if (filterSource && filterSource !== s.key) continue
        if (s.bee) activeRefresh.push(ctx.sources.refreshSourceCache(s))
      }
      if (activeRefresh.length > 0) await Promise.all(activeRefresh)
    }

    // A listing unions two sources of truth, but never both at once for the same channel: an awake
    // channel's view is authoritative (a deleted announce is really gone), and the hibernated
    // snapshot is all there is for a channel that is asleep. Merging them kept deleted titles on
    // screen forever — the cache only ever added.
    const raw = []
    const pushRaw = new Map()
    const addRaw = rec => { if (!pushRaw.has(rec.key)) pushRaw.set(rec.key, rec) }
    const readView = async (view, viaKey, prefix) => {
      const range = id ? { gte: b4a.from(`${id}/`), lt: b4a.from(`${id}/\xff`) } : {}
      for await (const node of view.createReadStream(range)) {
        const sub = b4a.toString(node.key)
        if (isSystemViewKey(sub)) continue
        const op = decodeOp(node.value)
        if (op?.type === 'announce') addRaw({ key: prefix ? `${prefix}${sub}` : sub, entry: op, source: viaKey, sourceKind: 'channel' })
      }
    }
    if ((ctx.channel.usePrimary() || ctx.channel.hasEntries()) && (!filterSource || filterSource === ctx.channel.primaryKey)) {
      await readView(ctx.channel.channel.view, ctx.channel.primaryKey, null)
    }
    for (const s of ctx.sources.extraSources.values()) {
      if (filterSource && filterSource !== s.key) continue
      if (s.bee) {
        await readView(s.bee.view, s.key, `channel:${s.key}/`)
        continue
      }
      for (const { sub, entry } of s.entries) {
        if (id && entry.id !== id) continue
        addRaw({ key: `channel:${s.key}/${sub}`, entry, source: s.key, sourceKind: 'channel' })
      }
    }
    raw.push(...pushRaw.values())
    for (const [key, item] of ephemeralWatches) {
      if ((!id || item.entry.id === id) && (!filterSource || filterSource === 'direct')) raw.push({ key, ...item })
    }

    // Batch-probe unindexed candidate discovery keys straight out of RocksDB in one `getInfos` pass,
    // negative-caching absent keys in `absentDisc` so repeat catalog searches touch zero disk.
    const openToProbe = []
    const diskToProbe = []
    const seenBlobs = new Set()
    for (const r of raw) {
      const h = r.entry.blobs
      if (seenBlobs.has(h) || ctx.blobs.ownedBlobs.has(h)) continue
      seenBlobs.add(h)
      if (ctx.blobs.slotSet.has(h) || ctx.blobs.blobCores.has(h)) { openToProbe.push(h); continue }
      if (ctx.blobs.cachedBlobs.has(h)) continue
      const d = ctx.blobs.blobDisc(h)
      if (ctx.blobs.absentDisc.has(d.hex)) continue
      diskToProbe.push(h)
    }
    for (let i = 0; i < openToProbe.length; i += 16) {
      await Promise.all(openToProbe.slice(i, i + 16).map(h => ctx.blobs.blobCore(h)))
    }
    for (let i = 0; i < diskToProbe.length; i += 256) {
      const batch = diskToProbe.slice(i, i + 256)
      const infos = await ctx.storage.coreStorage.getInfos(
        batch.map(h => ctx.blobs.blobDisc(h).buf),
        { auth: false, head: true, hints: false }
      ).catch(() => null)
      // A failed probe says nothing about its batch: skipping it leaves those keys uncached for the next search,
      // where an empty answer would have recorded every one of them as absent.
      if (!infos) continue
      const withData = []
      for (let j = 0; j < batch.length; j++) {
        const h = batch[j]
        const info = infos[j]
        if (!info) {
          ctx.blobs.absentDisc.add(ctx.blobs.blobDisc(h).hex)
        } else if (!info.head || info.head.length === 0) {
          ctx.blobs.recordCached(h, 0, 0, 0)
        } else {
          withData.push(h)
        }
      }
      for (let k = 0; k < withData.length; k += 16) {
        await Promise.all(withData.slice(k, k + 16).map(async h => {
          if (ctx.blobs.cachedBlobs.has(h)) return
          const tmp = ctx.storage.store.get({ key: b4a.from(h, 'hex'), active: false })
          try {
            await tmp.ready()
            const blocks = tmp.length > 0 ? await tmp.count(0, tmp.length) : 0
            ctx.blobs.recordCached(h, tmp.length, tmp.byteLength, blocks)
          } finally {
            await tmp.close().catch(() => {})
          }
        }))
      }
    }

    // Deduplicate across channels/writers synchronously for the 99.9% uncached/per-video fast path,
    // only awaiting legacy shared-slot slice counts when actually present on disk.
    const files = new Map()
    const rank = r => {
      const p = r.key.split('/')
      return [!r.locked ? 1 : 0, r.local ? 1 : 0, r.cachedBytes, r.key.endsWith(':0') ? 1 : 0, p[p.length - 2] === r.source ? 1 : 0]
    }
    const better = (a, b) => {
      const x = rank(a)
      const y = rank(b)
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i]
      return false
    }
    for (const { key, entry, source, sourceKind } of raw) {
      const isPrivateEntry = Boolean(entry.wrappedKey)
      const vk = isPrivateEntry ? ctx.blobs.resolveVideoKey(entry, source) : null
      const locked = Boolean(isPrivateEntry && !vk)
      const owned = ctx.blobs.ownedBlobs.get(entry.blobs)
      let cached = 0
      if (owned) {
        cached = entry.size
      } else {
        const core = ctx.blobs.blobCores.get(entry.blobs)
        const meta = ctx.blobs.cachedBlobs.get(entry.blobs)
        if (core?.opened || (meta && meta.blocks > 0)) {
          cached = await ctx.blobs.entryCachedBytes(core, entry)
        }
      }
      if (!owned && cached > 0 && cached >= entry.size) ctx.net.offerCopy(entry.blobs)
      const rec = {
        key,
        entry,
        id: entry.id,
        title: cleanText(entry.title, entry.id),
        size: entry.size,
        sha256: entry.sha256,
        local: Boolean(owned) || (ctx.blobs.slotSet.has(entry.blobs) && cached >= entry.size),
        cachedBytes: cached,
        private: isPrivateEntry,
        epoch: entry.epoch || 0,
        locked,
        source,
        sourceKind
      }
      const fk = `${rec.id}/${rec.sha256}`
      if (!files.has(fk) || better(rec, files.get(fk))) files.set(fk, rec)
    }

    let list = [...files.values()]
    const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
    if (q) {
      list = list.filter(r => r.title.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
    }
    const off = Math.max(0, Number(offset) || 0)
    const lim = Math.max(0, Number(limit) || 0)
    if (off > 0 || lim > 0) {
      list = lim > 0 ? list.slice(off, off + lim) : list.slice(off)
    }
    return list.map(entryView)
  }

  // A catalog record as every view shows it: its fields, what the title/id say it is, and how to play or share it.
  // The watch link names the channel it was found in: whoever opens it joins that channel's swarm, where the peers
  // that cached the video serve it, since only its publisher and relays announce the video itself.
  function entryView ({ entry, ...rest }) {
    return { ...rest, ...describeEntry(rest.id, rest.title), streamUrl: ctx.blobs.streamUrl(entry), magnetUrl: formatWatchUri(entry, rest.source, 'channel') }
  }

  // Channels whose swarm a watch link joined without following them, oldest first.
  const linkSwarms = []

  let discoveredCache = null
  let discoveredAtEpoch = 0
  async function discoveredSources () {
    if (discoveredCache && discoveredAtEpoch === ctx.channel.viewEpoch()) return discoveredCache
    const epochSnap = ctx.channel.viewEpoch()
    if (ctx.channel.usePrimary() || ctx.channel.hasEntries()) await ctx.channel.refreshPrimaryCache()
    await Promise.all([...ctx.sources.extraSources.values()].filter(s => s.bee).map(s => ctx.sources.refreshSourceCache(s)))
    const active = new Set(ctx.sources.listSources().map(s => s.key))
    const found = new Map()
    const collect = list => {
      for (const item of list) {
        if (!active.has(item.key) && !found.has(item.key)) found.set(item.key, item)
      }
    }
    if (ctx.channel.usePrimary() || ctx.channel.hasEntries()) collect(ctx.channel.primaryCache.discovered)
    for (const s of ctx.sources.extraSources.values()) collect(s.discovered)
    const list = [...found.values()]
    discoveredCache = list
    discoveredAtEpoch = epochSnap
    return list
  }

  async function findEntry (key) {
    if (ephemeralWatches.has(key)) return ephemeralWatches.get(key).entry
    const subMatch = key.match(/^(?:channel|tracker):([0-9a-f]{64})\/(.+)$/)
    if (subMatch) {
      if (subMatch[1] === ctx.channel.primaryKey) {
        await applied(ctx.channel.channel)
        const n = await ctx.channel.channel.view.get(b4a.from(subMatch[2]))
        const op = n ? decodeOp(n.value) : null
        if (op?.wrappedKey) ctx.blobs.resolveVideoKey(op, ctx.channel.primaryKey)
        return op
      }
      const src = ctx.sources.extraSources.get(subMatch[1])
      if (!src) return null
      if (!src.bee && src.hydrated && src.bySub.has(subMatch[2])) {
        const cachedOp = src.bySub.get(subMatch[2])
        if (cachedOp?.wrappedKey) ctx.blobs.resolveVideoKey(cachedOp, src.key)
        return cachedOp
      }
      const bee = await ctx.sources.wakeSource(src.key, { touch: true })
      if (!bee) return null
      await applied(bee)
      const n = await bee.view.get(b4a.from(subMatch[2]))
      const op = n ? decodeOp(n.value) : null
      if (op?.wrappedKey) ctx.blobs.resolveVideoKey(op, src.key)
      return op
    }
    await applied(ctx.channel.channel)
    const n = await ctx.channel.channel.view.get(b4a.from(key))
    const op = n ? decodeOp(n.value) : null
    if (op?.wrappedKey) ctx.blobs.resolveVideoKey(op, ctx.channel.primaryKey)
    return op
  }

  async function openUri (uri) {
    const parsed = parseUri(uri)
    if (parsed.action === 'receiver') throw new Error('A TV receiver link pairs through casting, not the catalog')
    if (parsed.action === 'access') {
      const source = await ctx.sources.addSource(uri)
      return { action: 'access', channel: parsed.channel, epoch: parsed.epoch, source }
    }
    if (parsed.action === 'source') return { action: 'source', source: await ctx.sources.addSource(parsed) }
    // A watch link's channel is where the video's peers are. Private routing only reaches the channels it follows;
    // otherwise joining the channel's swarm is enough, and the link does not add the channel to the library.
    if (parsed.sourceKey && ctx.net.dht) {
      await ctx.sources.addSource({ key: parsed.sourceKey, kind: 'channel' }).catch(() => {})
    } else if (parsed.sourceKey && !linkSwarms.includes(parsed.sourceKey)) {
      const sk = b4a.from(parsed.sourceKey, 'hex')
      ctx.net.joinOverlayTopic(`source-swarm:${parsed.sourceKey}`, sk, hypercoreCrypto.discoveryKey(sk))
      linkSwarms.push(parsed.sourceKey)
      if (linkSwarms.length > 4) ctx.net.leaveOverlayTopic(`source-swarm:${linkSwarms.shift()}`).catch(() => {})
    }
    const { entry } = parsed
    const key = `watch/${entry.blobs}:${entry.blob.blockOffset}`
    ephemeralWatches.set(key, { entry, source: parsed.sourceKey || 'direct', sourceKind: 'watch' })
    await ctx.blobs.warm(entry)
    ctx.update()
    return {
      action: 'watch',
      entry: entryView({
        key,
        id: entry.id,
        title: entry.title,
        size: entry.size,
        sha256: entry.sha256,
        local: ctx.blobs.isOwnedBlob(entry.blobs),
        cachedBytes: await ctx.blobs.entryCachedBytes(ctx.blobs.blobCores.get(entry.blobs), entry),
        private: false,
        epoch: 0,
        locked: false,
        source: parsed.sourceKey || 'direct',
        sourceKind: 'watch',
        entry
      })
    }
  }

  return {
    ephemeralWatches,
    search,
    discoveredSources,
    findEntry,
    openUri
  }
}
