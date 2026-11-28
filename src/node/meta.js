import Autobee from 'autobee'
import Hyperblobs from 'hyperblobs'
import Hypercore from 'hypercore'
import hypercoreCrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { join } from 'node:path'
import { HEX64, ROLES, cleanText, formatMetaUri, str } from '../protocol.js'
import {
  ART_BLOB_BLOCK_SIZE, ART_MIMES, META_KINDS,
  artHashHex, canonicalMetaId, decodeArtPtr, decodeCard, decodeDetail,
  decodeIndexBucket, decodeList, decodeShardEntry,
  encodeCard, encodeDetail, encodeMetaOp,
  foldPrefix3, foldText, metaDiscoveryTopic, shardIndexForHash
} from '../meta-wire.js'
import { makeIsTrusted } from '../apply.js'
import { applied } from './channel.js'
import {
  asMimeCode, buildAndPublishSnapshot, createArtDiskCache, isRemovableKey, makeMetaApply,
  matchBucketHit, mirrorMetaLanding, openSnapshotBee, pad5, parseMetaSpec, registerKnownMetaCores,
  seedMetaSource
} from './meta-helpers.js'

export { makeMetaApply } from './meta-helpers.js'

const READ_TIMEOUT_MS = 10_000

export async function createMeta (ctx) {
  const isWorklet = Boolean(ctx.opts.worklet)
  const maxOpenShards = isWorklet ? 4 : 16
  const defaultCacheBytes = isWorklet ? 64 * 1024 * 1024 : 256 * 1024 * 1024
  const artCacheMax = Math.max(1024, Number(ctx.opts.artCacheMaxBytes) || defaultCacheBytes)
  const artCache = createArtDiskCache(join(ctx.opts.storage, 'art-cache'), artCacheMax)

  let p2pOnly = Boolean(ctx.opts.p2pOnlyMetadata)
  let globalSeedFull = Boolean(ctx.opts.seedFullMetadata)
  const sources = new Map() // metaKeyHex -> SourceState
  const openShards = new Map() // `${metaKey}:${coreKey}` -> { core, refs }
  const pendingShards = new Map() // `${metaKey}:${coreKey}` -> Promise<{ core, refs }>

  function sourceView (src) {
    return {
      key: src.key,
      uri: formatMetaUri(src.key, src.alias),
      alias: src.alias,
      writable: Boolean(src.bee.writable),
      writerKey: b4a.toString(src.bee.local.key, 'hex'),
      seedFull: Boolean(src.seedFull || globalSeedFull),
      active: true
    }
  }

  function requireSource (metaKey) {
    const k = String(metaKey || '').trim().toLowerCase()
    const src = sources.get(k)
    if (!src) throw new Error(`Unknown metadata channel: ${metaKey}`)
    return src
  }

  async function openMetaSource ({ key, keyPair = null, alias = '', seedFull = false }) {
    const initScope = `meta:${key}`
    const ns = ctx.storage.store.namespace(initScope)
    const scopedNs = ctx.replication.scopeStore(ns, initScope)
    const wakeup = ctx.replication.wakeupFor(initScope)
    const src = {
      key,
      alias: cleanText(alias),
      seedFull: Boolean(seedFull),
      closed: false,
      ns,
      scopedNs,
      bee: null,
      ownShards: new Map(),
      shardGate: Promise.resolve(),
      landedCores: new Map(),
      seedCores: new Map(),
      snapCache: null,
      snapOpening: null
    }
    const bee = new Autobee(scopedNs, keyPair ? null : b4a.from(key, 'hex'), {
      ...(keyPair ? { keyPair } : {}),
      apply: makeMetaApply(() => b4a.toString(bee.key, 'hex')),
      update: (_view, changes) => {
        mirrorMetaLanding(ctx, src, changes, globalSeedFull)
        if (src.seedFull || globalSeedFull) seedMetaSource(ctx, src, globalSeedFull).catch(err => { void err })
        ctx.update()
      },
      optimistic: false,
      fastForward: true,
      isTrusted: makeIsTrusted(() => b4a.toString(bee.key, 'hex')),
      wakeup
    })
    src.bee = bee
    await bee.ready()
    const actualKey = b4a.toString(bee.key, 'hex')
    src.key = actualKey
    const scopeId = `meta:${actualKey}`
    if (scopeId !== initScope) ctx.replication.renameScope(initScope, scopeId)
    const topic = metaDiscoveryTopic(bee.key)
    ctx.replication.registerTopic(bee.discoveryKey, scopeId)
    ctx.replication.registerTopic(topic, scopeId)
    await registerKnownMetaCores(ctx, src)
    ctx.net.joinOverlayTopic(scopeId, bee.key, topic)
    if (!ctx.net.dht) {
      const done = ns.findingPeers()
      const t = setTimeout(done, 3_000)
      t.unref?.()
      ctx.net.swarm.flush().then(done, done).finally(() => clearTimeout(t))
    }
    sources.set(actualKey, src)
    if (src.seedFull || globalSeedFull) seedMetaSource(ctx, src, globalSeedFull).catch(err => { void err })
    return src
  }

  const onConn = () => {
    if (!ctx.net.dht || ctx.life.closing) return
    for (const src of sources.values()) src.bee.update().catch(err => { void err })
  }
  ctx.net.connListeners.add(onConn)

  async function appendMeta (src, op) {
    await src.bee.update()
    if (!src.bee.writable) throw new Error('Metadata channel is not writable by this node')
    await src.bee.append(encodeMetaOp(op))
    await src.bee.updated()
    ctx.update()
  }

  async function createChannel ({ alias = '', seedFull = false } = {}) {
    const keyPair = hypercoreCrypto.keyPair()
    const key = b4a.toString(
      Hypercore.key({ version: ctx.storage.store.manifestVersion, signers: [{ publicKey: keyPair.publicKey }] }),
      'hex'
    )
    const cleanAlias = cleanText(alias)
    const src = await openMetaSource({ key, keyPair, alias: cleanAlias, seedFull: Boolean(seedFull) })
    await appendMeta(src, { type: 'init', owner: ctx.identity.idVault?.ownerPublicKey || '', alias: cleanAlias })
    return sourceView(src)
  }

  async function addSource (spec, opts = {}) {
    const parsed = parseMetaSpec(spec, opts)
    const existing = sources.get(parsed.key)
    if (existing) {
      if (parsed.alias) existing.alias = parsed.alias
      if (parsed.seedFull !== undefined) {
        existing.seedFull = Boolean(parsed.seedFull)
        if (existing.seedFull || globalSeedFull) seedMetaSource(ctx, existing, globalSeedFull).catch(err => { void err })
      }
      return sourceView(existing)
    }
    const src = await openMetaSource({
      key: parsed.key,
      alias: parsed.alias,
      seedFull: Boolean(parsed.seedFull)
    })
    return sourceView(src)
  }

  async function closeSourceRecord (src) {
    src.closed = true
    const scopeId = `meta:${src.key}`
    const topic = metaDiscoveryTopic(src.bee.key)
    const tasks = [
      () => ctx.net.leaveOverlayTopic(scopeId),
      () => { ctx.replication.unregisterTopic(src.bee.discoveryKey, scopeId); ctx.replication.unregisterTopic(topic, scopeId) },
      () => src.snapCache?.bee?.close(),
      ...[...src.ownShards.values()].map(s => () => s.core.close()),
      ...[...src.landedCores.values()].map(l => () => l.core.close()),
      ...[...src.seedCores.values()].map(c => () => c.close())
    ]
    for (const [ck, rec] of [...openShards]) {
      if (ck.startsWith(`${src.key}:`)) {
        openShards.delete(ck)
        tasks.push(() => rec.core.close())
      }
    }
    src.snapCache = null
    src.ownShards.clear()
    src.landedCores.clear()
    src.seedCores.clear()
    await Promise.allSettled(tasks.map(async fn => fn()))
    await src.bee.close().catch(err => { void err })
    ctx.replication.destroyWakeup(scopeId)
  }

  async function removeSource (key) {
    const k = String(key || '').trim().toLowerCase()
    const src = sources.get(k)
    if (!src) return { removed: false }
    sources.delete(k)
    await closeSourceRecord(src)
    ctx.update()
    return { removed: true }
  }

  function listSources () {
    return [...sources.values()].map(sourceView)
  }

  async function grantWriter (metaKey, writerHex, { role = 'writer', alias = '', indexer = false } = {}) {
    const src = requireSource(metaKey)
    const wHex = String(writerHex || '').trim().toLowerCase()
    if (!HEX64.test(wHex)) throw new Error('Writer key must be 64 hex characters')
    if (!ROLES.has(role)) throw new Error('Role must be owner, mod, or writer')
    const promoteIndexer = role === 'owner' && Boolean(indexer)
    const cleanAlias = cleanText(alias)
    await appendMeta(src, { type: 'grant', writer: wHex, role, alias: cleanAlias, indexer: promoteIndexer })
    return { granted: true, writer: wHex, role, alias: cleanAlias, indexer: promoteIndexer }
  }

  async function revokeWriter (metaKey, writerHex) {
    const src = requireSource(metaKey)
    const wHex = String(writerHex || '').trim().toLowerCase()
    if (!HEX64.test(wHex)) throw new Error('Writer key must be 64 hex characters')
    if (wHex === src.key) throw new Error('Cannot revoke the metadata channel founder')
    await appendMeta(src, { type: 'revoke', writer: wHex })
    return { revoked: true, writer: wHex }
  }

  function ensureOwnShard (src, shardIdx) {
    const run = async () => {
      const cached = src.ownShards.get(shardIdx)
      if (cached && !cached.core.closed) return cached
      const writerHex = b4a.toString(src.bee.local.key, 'hex')
      const core = src.scopedNs.get({ name: `shard-0-${shardIdx}` })
      await core.ready()
      const coreKey = b4a.toString(core.key, 'hex')
      ctx.replication.registerKey(coreKey, `meta:${src.key}`)
      for (let attempt = 0; attempt < 5; attempt++) {
        let foundId = null
        let maxId = 0
        for await (const n of src.bee.view.createReadStream({ gte: b4a.from('shard/'), lt: b4a.from('shard/\xff') })) {
          const entry = decodeShardEntry(n.value)
          if (entry.shardId > maxId) maxId = entry.shardId
          if (entry.writer === writerHex && entry.shardIdx === shardIdx && entry.generation === 0 && !entry.retired && entry.coreKey === coreKey) {
            foundId = entry.shardId
          }
        }
        const shardId = foundId ?? (maxId + 1)
        if (foundId !== null) {
          const rec = { core, coreKey, shardId }
          src.ownShards.set(shardIdx, rec)
          return rec
        }
        await appendMeta(src, {
          type: 'putShard',
          shard: { shardId, writer: writerHex, shardIdx, generation: 0, coreKey, retired: false }
        })
        const check = await src.bee.view.get(b4a.from(`shard/${pad5(shardId)}`))
        if (check && decodeShardEntry(check.value).coreKey === coreKey) {
          const rec = { core, coreKey, shardId }
          src.ownShards.set(shardIdx, rec)
          return rec
        }
      }
      await core.close().catch(err => { void err })
      throw new Error('Could not allocate shard ID after concurrent writer retries')
    }
    const next = src.shardGate.then(run, run)
    src.shardGate = next.catch(() => {})
    return next
  }

  async function putArt (metaKey, bytes, { mime = 'image/webp', width = 0, height = 0 } = {}) {
    const src = requireSource(metaKey)
    const buf = b4a.isBuffer(bytes) ? bytes : b4a.from(bytes)
    const hash = artHashHex(buf)
    const mimeCode = asMimeCode(mime)
    await src.bee.update()
    if (!src.bee.writable) throw new Error('Metadata channel is not writable by this node')
    const existing = await src.bee.view.get(b4a.from(`art/${hash}`))
    if (existing) return { hash, ptr: decodeArtPtr(existing.value), deduplicated: true }
    const shard = await ensureOwnShard(src, shardIndexForHash(hash))
    const blobs = new Hyperblobs(shard.core, { blockSize: ART_BLOB_BLOCK_SIZE })
    const blob = await blobs.put(buf)
    const ptr = {
      shardId: shard.shardId,
      blockOffset: blob.blockOffset,
      blockLength: blob.blockLength,
      byteOffset: blob.byteOffset,
      byteLength: blob.byteLength,
      width,
      height,
      mime: mimeCode
    }
    await appendMeta(src, { type: 'putArt', hash, ptr })
    return { hash, ptr, deduplicated: false }
  }

  function evictIdleShards () {
    for (const [ck, rec] of [...openShards]) {
      if (openShards.size <= maxOpenShards) break
      if (rec.refs > 0) continue
      openShards.delete(ck)
      rec.core.close().catch(err => { void err })
    }
  }

  async function acquireShard (src, ck, coreKey) {
    let rec = openShards.get(ck)
    if (rec && !rec.core.closed) {
      openShards.delete(ck)
      openShards.set(ck, rec)
      return rec
    }
    if (pendingShards.has(ck)) return pendingShards.get(ck)
    const opening = (async () => {
      ctx.replication.registerKey(coreKey, `meta:${src.key}`)
      const core = src.scopedNs.get({ key: b4a.from(coreKey, 'hex') })
      await core.ready()
      if (src.closed || ctx.life.closing) {
        await core.close().catch(err => { void err })
        throw new Error('Metadata source closed')
      }
      const next = { core, refs: 0 }
      openShards.set(ck, next)
      return next
    })()
    pendingShards.set(ck, opening)
    try { return await opening } finally { pendingShards.delete(ck) }
  }

  async function withShardCore (src, coreKey, fn) {
    for (const own of src.ownShards.values()) {
      if (own.coreKey === coreKey && !own.core.closed) return fn(own.core)
    }
    const rec = await acquireShard(src, `${src.key}:${coreKey}`, coreKey)
    rec.refs++
    evictIdleShards()
    try {
      return await fn(rec.core)
    } finally {
      rec.refs = Math.max(0, rec.refs - 1)
      evictIdleShards()
    }
  }

  async function getArt (hashHex) {
    const hash = String(hashHex || '').trim().toLowerCase()
    if (!str(hash, HEX64)) throw new Error('Artwork hash must be 64 hex characters')
    const diskHit = artCache.get(hash)
    if (diskHit) return diskHit
    let mismatchErr = null
    for (const src of sources.values()) {
      await applied(src.bee)
      const artNode = await src.bee.view.get(b4a.from(`art/${hash}`), { timeout: READ_TIMEOUT_MS }).catch(() => null)
      if (!artNode) continue
      const ptr = decodeArtPtr(artNode.value)
      const shardNode = await src.bee.view.get(b4a.from(`shard/${pad5(ptr.shardId)}`), { timeout: READ_TIMEOUT_MS }).catch(() => null)
      if (!shardNode) continue
      const shardEntry = decodeShardEntry(shardNode.value)
      const bytes = await withShardCore(src, shardEntry.coreKey, core => {
        const blobs = new Hyperblobs(core, { blockSize: ART_BLOB_BLOCK_SIZE })
        return blobs.get(ptr, { timeout: READ_TIMEOUT_MS })
      }).catch(() => null)
      if (!bytes || bytes.byteLength === 0) continue
      if (artHashHex(bytes) !== hash) {
        mismatchErr = new Error(`Artwork hash verification failed for ${hash}`)
        continue
      }
      artCache.put(hash, bytes, { mimeCode: ptr.mime, width: ptr.width, height: ptr.height })
      return { bytes, mime: ART_MIMES[ptr.mime], width: ptr.width, height: ptr.height, hash, cached: false, source: src.key }
    }
    if (mismatchErr) throw mismatchErr
    return null
  }

  async function putCard (metaKey, card) {
    const src = requireSource(metaKey)
    const next = { ...card, updatedAt: card?.updatedAt ?? Date.now() }
    const encoded = encodeCard(next)
    await appendMeta(src, { type: 'putCard', card: next })
    return decodeCard(encoded)
  }

  async function putDetail (metaKey, detail) {
    const src = requireSource(metaKey)
    const next = { ...detail, updatedAt: detail?.updatedAt ?? Date.now() }
    const encoded = encodeDetail(next)
    await appendMeta(src, { type: 'putDetail', detail: next })
    return decodeDetail(encoded)
  }

  async function removeKey (metaKey, viewKey) {
    const src = requireSource(metaKey)
    const key = String(viewKey || '').trim()
    if (!isRemovableKey(key)) throw new Error('Key must start with card/, detail/, art/, or shard/')
    await appendMeta(src, { type: 'remove', key })
    return { removed: true, key }
  }

  async function getCard (id) {
    const cid = canonicalMetaId(id)
    if (!cid) return null
    for (const src of sources.values()) {
      await applied(src.bee)
      const n = await src.bee.view.get(b4a.from(`card/${cid}`), { timeout: READ_TIMEOUT_MS }).catch(() => null)
      if (n) return { ...decodeCard(n.value), source: src.key }
    }
    return null
  }

  async function getDetail (id) {
    const cid = canonicalMetaId(id)
    if (!cid) return null
    for (const src of sources.values()) {
      await applied(src.bee)
      const n = await src.bee.view.get(b4a.from(`detail/${cid}`), { timeout: READ_TIMEOUT_MS }).catch(() => null)
      if (n) return { ...decodeDetail(n.value), source: src.key }
    }
    return null
  }

  async function listCards (metaKey) {
    const src = requireSource(metaKey)
    await applied(src.bee)
    const out = []
    for await (const n of src.bee.view.createReadStream({ gte: b4a.from('card/'), lt: b4a.from('card/\xff') })) {
      try { out.push(decodeCard(n.value)) } catch (err) { void err }
    }
    return out
  }

  async function publishSearchSnapshot (metaKey, opts = {}) {
    return buildAndPublishSnapshot(ctx, requireSource(metaKey), appendMeta, opts)
  }

  async function getList (kind, slug) {
    const k = String(kind || '').trim().toLowerCase()
    const s = String(slug || '').trim().toLowerCase()
    for (const src of sources.values()) {
      const snapBee = await openSnapshotBee(ctx, src, READ_TIMEOUT_MS)
      if (!snapBee) continue
      const node = await snapBee.get(b4a.from(`list/${k}/${s}`), { timeout: READ_TIMEOUT_MS }).catch(() => null)
      if (!node) continue
      const list = decodeList(node.value)
      const cards = []
      for (let i = 0; i < list.ids.length; i += 16) {
        const chunk = list.ids.slice(i, i + 16)
        const got = await Promise.all(chunk.map(async id => {
          const n = await src.bee.view.get(b4a.from(`card/${id}`), { timeout: READ_TIMEOUT_MS }).catch(() => null)
          return n ? { ...decodeCard(n.value), source: src.key } : null
        }))
        for (const c of got) if (c) cards.push(c)
      }
      return { ...list, cards, source: src.key }
    }
    return null
  }

  async function searchIndex (kind, query, { limit = 20 } = {}) {
    const pfx = foldPrefix3(query)
    if (!pfx) return []
    const qFold = foldText(query)
    const qWords = qFold.split(' ').filter(Boolean)
    const lim = Math.max(1, Math.min(200, Number(limit) || 20))
    const kNorm = typeof kind === 'string' && kind.trim() ? kind.trim().toLowerCase() : ''
    const kinds = kNorm ? [kNorm] : META_KINDS
    const byId = new Map()
    for (const src of sources.values()) {
      const snapBee = await openSnapshotBee(ctx, src, READ_TIMEOUT_MS)
      if (!snapBee) continue
      for (const curKind of kinds) {
        const node = await snapBee.get(b4a.from(`idx/${curKind}/${pfx}`), { timeout: READ_TIMEOUT_MS }).catch(() => null)
        if (!node) continue
        const bucket = decodeIndexBucket(node.value)
        for (const hit of bucket.hits) {
          const rank = matchBucketHit(hit, qFold, qWords)
          if (rank < 0) continue
          const prev = byId.get(hit.id)
          if (!prev || rank > prev._rank) byId.set(hit.id, { ...hit, kind: curKind, source: src.key, _rank: rank })
        }
      }
    }
    return [...byId.values()]
      .sort((a, b) => (b._rank - a._rank) || (b.score - a.score) || a.title.localeCompare(b.title))
      .slice(0, lim)
      .map(({ _rank, ...rest }) => rest)
  }

  for (const spec of (Array.isArray(ctx.opts.metaSources) ? ctx.opts.metaSources : [])) {
    await addSource(spec)
  }

  let closed = false
  async function close () {
    if (closed) return
    closed = true
    ctx.net.connListeners.delete(onConn)
    const shardList = [...openShards.values()]
    openShards.clear()
    await Promise.allSettled(shardList.map(async rec => rec.core.close()))
    const srcList = [...sources.values()]
    sources.clear()
    await Promise.allSettled(srcList.map(async src => closeSourceRecord(src)))
  }

  ctx.undo.push(() => close())

  return {
    createChannel, addSource, removeSource, listSources, grantWriter, revokeWriter,
    putArt, putCard, putDetail, removeKey, publishSearchSnapshot,
    getCard, getDetail, getArt, getList, listCards, searchIndex,
    isP2pOnly: () => p2pOnly,
    setP2pOnly: on => { p2pOnly = Boolean(on); return p2pOnly },
    isSeedFull: () => globalSeedFull,
    setSeedFull: on => {
      globalSeedFull = Boolean(on)
      for (const src of sources.values()) {
        if (src.seedFull || globalSeedFull) {
          seedMetaSource(ctx, src, globalSeedFull).catch(err => { void err })
        } else {
          for (const c of src.seedCores.values()) c.close().catch(err => { void err })
          src.seedCores.clear()
        }
      }
      return globalSeedFull
    },
    close
  }
}
