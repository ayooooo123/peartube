import b4a from 'b4a'
import Hyperbee2 from 'hyperbee2'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HEX64, ROLES, cleanText, parseUri } from '../protocol.js'
import {
  ART_MIMES, ART_MIME_CODES, MAX_ART_BYTES, artHashHex, decodeIndexBucket, decodeList,
  decodeMetaOp, decodeSearchSnapshot, decodeShardEntry, encodeIndexBucket, encodeList, foldText
} from '../meta-wire.js'
import { applied } from './channel.js'

const ART_MAGIC_0 = 0x50
const ART_MAGIC_1 = 0x41
const ART_HEADER_BYTES = 8

export const pad5 = n => String(n).padStart(5, '0')
export const isRemovableKey = k => k.startsWith('card/') || k.startsWith('detail/') || k.startsWith('art/') || k.startsWith('shard/')

export function withTimeout (promise, ms) {
  let timer = null
  const limit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Metadata read timed out')), ms)
    timer.unref?.()
  })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

export function asMimeCode (v) {
  if (typeof v === 'number' && ART_MIMES[v]) return v
  if (typeof v === 'string' && ART_MIME_CODES[v.toLowerCase()]) return ART_MIME_CODES[v.toLowerCase()]
  throw new Error(`Unsupported artwork mime: ${v}`)
}

export function parseMetaSpec (spec, opts = {}) {
  if (typeof spec === 'string') {
    const raw = spec.trim()
    const lower = raw.toLowerCase()
    if (HEX64.test(lower)) return { key: lower, alias: cleanText(opts.alias || '') }
    const parsed = parseUri(raw)
    if (parsed.action !== 'meta') throw new Error('Expected a peartube://meta/ URI or 64-hex key')
    return { key: parsed.key, alias: cleanText(opts.alias ?? parsed.alias) }
  }
  if (spec && typeof spec === 'object') {
    const base = parseMetaSpec(String(spec.uri || spec.key || ''), { alias: opts.alias ?? spec.alias })
    return { ...base, seedFull: opts.seedFull ?? spec.seedFull }
  }
  throw new Error('Metadata source URI or 64-hex key required')
}

function tryDecodeShardOwner (rec) {
  if (!rec) return null
  try {
    const dec = decodeShardEntry(rec.value)
    return { writer: dec.writer, coreKey: dec.coreKey }
  } catch (err) {
    void err
    return null
  }
}

// Deterministic ACL gate for multi-writer Metadata Autobees: founder is owner; every other writer
// must hold an explicit `writer/<hex>` grant (never an open-writer fallback).
export function makeMetaApply (getChHex) {
  return async function apply (nodes, view, host) {
    const chHex = getChHex()
    const roles = new Map()
    const seenArt = new Set()
    const deletedArt = new Set()
    const pendingShards = new Map() // shardKey -> { writer, coreKey }
    const ops = []
    async function resolveRole (writer) {
      if (writer === chHex) return 'owner'
      if (roles.has(writer)) return roles.get(writer)
      let role = ''
      const rec = await view.get(b4a.from(`writer/${writer}`))
      if (rec) {
        try { role = JSON.parse(b4a.toString(rec.value))?.role || '' } catch (err) { void err }
      }
      roles.set(writer, role)
      return role
    }
    for (const node of nodes) {
      const op = decodeMetaOp(node.value)
      if (!op) continue
      const writer = b4a.toString(node.key, 'hex')
      const role = await resolveRole(writer)
      if (!role) continue
      if (op.type === 'init') {
        if (writer !== chHex) continue
        roles.set(writer, 'owner')
        ops.push(['put', b4a.from(`writer/${writer}`), b4a.from(JSON.stringify({ role: 'owner', alias: op.alias || 'primary' }))])
        if (op.owner) ops.push(['put', b4a.from('meta/owner'), b4a.from(op.owner)])
        if (op.alias) ops.push(['put', b4a.from('meta/alias'), b4a.from(op.alias)])
      } else if (op.type === 'grant') {
        if (role !== 'owner') continue
        const nextRole = ROLES.has(op.role) ? op.role : 'writer'
        const isIndexer = nextRole === 'owner' && op.indexer === true
        roles.set(op.writer, nextRole)
        ops.push(['del', b4a.from(`revoked/${op.writer}`)])
        await host.addWriter(b4a.from(op.writer, 'hex'), { isIndexer })
        const rec = { role: nextRole, alias: cleanText(op.alias || '') }
        if (isIndexer) rec.indexer = true
        ops.push(['put', b4a.from(`writer/${op.writer}`), b4a.from(JSON.stringify(rec))])
      } else if (op.type === 'revoke') {
        if (role !== 'owner' || op.writer === chHex) continue
        await host.removeWriter(b4a.from(op.writer, 'hex'))
        roles.set(op.writer, '')
        ops.push(['del', b4a.from(`writer/${op.writer}`)])
        ops.push(['put', b4a.from(`revoked/${op.writer}`), b4a.from('1')])
      } else if (op.type === 'putShard') {
        if (op.shard.writer !== writer && role !== 'owner') continue
        const sk = `shard/${pad5(op.shard.shardId)}`
        const cur = pendingShards.get(sk) || tryDecodeShardOwner(await view.get(b4a.from(sk)))
        // Immutable shard ownership: once a shardId is claimed by (writer, coreKey), another writer
        // cannot hijack or overwrite it; only the same (writer, coreKey) may update `retired`.
        if (cur && (cur.writer !== op.shard.writer || cur.coreKey !== op.shard.coreKey)) continue
        pendingShards.set(sk, { writer: op.shard.writer, coreKey: op.shard.coreKey })
        ops.push(['put', b4a.from(sk), op.raw])
      } else if (op.type === 'putArt') {
        if (seenArt.has(op.hash)) continue
        const existing = deletedArt.has(op.hash) ? null : await view.get(b4a.from(`art/${op.hash}`))
        deletedArt.delete(op.hash)
        seenArt.add(op.hash)
        if (!existing) ops.push(['put', b4a.from(`art/${op.hash}`), op.raw])
      } else if (op.type === 'putCard') {
        ops.push(['put', b4a.from(`card/${op.card.id}`), op.raw])
      } else if (op.type === 'putDetail') {
        ops.push(['put', b4a.from(`detail/${op.detail.id}`), op.raw])
      } else if (op.type === 'setSnapshot') {
        if (role !== 'owner' && role !== 'mod') continue
        ops.push(['put', b4a.from('meta/searchSnapshot'), op.raw])
      } else if (op.type === 'remove') {
        if ((role === 'owner' || role === 'mod') && isRemovableKey(op.key)) {
          if (op.key.startsWith('art/')) {
            const h = op.key.slice(4)
            seenArt.delete(h)
            deletedArt.add(h)
          }
          ops.push(['del', b4a.from(op.key)])
        }
      }
    }
    if (!ops.length) return
    const w = view.write()
    for (const [kind, k, v] of ops) {
      if (kind === 'put') w.tryPut(k, v)
      else w.tryDelete(k)
    }
    await w.flush()
  }
}

export function createArtDiskCache (dir, maxBytes) {
  const index = new Map() // hashHex -> size (insertion order = LRU, oldest first)
  let totalBytes = 0
  let tmpSeq = 0
  const fileFor = h => join(dir, `${h}.art`)

  function evict () {
    while (totalBytes > maxBytes && index.size > 0) {
      const oldest = index.keys().next().value
      const sz = index.get(oldest) || 0
      index.delete(oldest)
      totalBytes = Math.max(0, totalBytes - sz)
      try { unlinkSync(fileFor(oldest)) } catch (err) { void err }
    }
  }

  try {
    const entries = []
    for (const name of readdirSync(dir)) {
      if (name.includes('.tmp.')) {
        try { unlinkSync(join(dir, name)) } catch (err) { void err }
        continue
      }
      if (!name.endsWith('.art')) continue
      const h = name.slice(0, -4).toLowerCase()
      if (!HEX64.test(h)) continue
      try {
        const st = statSync(join(dir, name))
        if (st.isFile()) entries.push({ h, size: st.size, mtimeMs: st.mtimeMs })
      } catch (err) { void err }
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const e of entries) { index.set(e.h, e.size); totalBytes += e.size }
    evict()
  } catch (err) { void err }

  function remove (hashHex) {
    const sz = index.get(hashHex) || 0
    index.delete(hashHex)
    totalBytes = Math.max(0, totalBytes - sz)
    try { unlinkSync(fileFor(hashHex)) } catch (err) { void err }
  }

  function get (hashHex) {
    let raw
    try { raw = readFileSync(fileFor(hashHex)) } catch (err) { void err; return null }
    if (
      raw.byteLength <= ART_HEADER_BYTES ||
      raw.byteLength > ART_HEADER_BYTES + MAX_ART_BYTES ||
      raw[0] !== ART_MAGIC_0 ||
      raw[1] !== ART_MAGIC_1
    ) {
      remove(hashHex)
      return null
    }
    const mime = ART_MIMES[raw[2]]
    const width = (raw[4] << 8) | raw[5]
    const height = (raw[6] << 8) | raw[7]
    const bytes = b4a.from(raw.subarray(ART_HEADER_BYTES))
    if (!mime || artHashHex(bytes) !== hashHex) {
      remove(hashHex)
      return null
    }
    const sz = raw.byteLength
    if (index.has(hashHex)) {
      totalBytes = Math.max(0, totalBytes - index.get(hashHex))
      index.delete(hashHex)
    }
    index.set(hashHex, sz)
    totalBytes += sz
    return { bytes, mime, width, height, hash: hashHex, cached: true }
  }

  function put (hashHex, bytes, { mimeCode, width = 0, height = 0 }) {
    const totalLen = ART_HEADER_BYTES + bytes.byteLength
    if (totalLen > maxBytes) return
    const hdr = b4a.alloc(ART_HEADER_BYTES)
    hdr[0] = ART_MAGIC_0
    hdr[1] = ART_MAGIC_1
    hdr[2] = mimeCode
    hdr[4] = (width >> 8) & 0xff
    hdr[5] = width & 0xff
    hdr[6] = (height >> 8) & 0xff
    hdr[7] = height & 0xff
    const payload = b4a.concat([hdr, bytes])
    const tmpPath = join(dir, `${hashHex}.tmp.${process.pid}.${++tmpSeq}`)
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(tmpPath, payload, { mode: 0o600 })
      renameSync(tmpPath, fileFor(hashHex))
      if (index.has(hashHex)) {
        totalBytes = Math.max(0, totalBytes - index.get(hashHex))
        index.delete(hashHex)
      }
      index.set(hashHex, payload.byteLength)
      totalBytes += payload.byteLength
      evict()
    } catch (err) {
      void err
      try { unlinkSync(tmpPath) } catch (e) { void e }
    }
  }

  return { get, put, remove }
}

export function mirrorMetaLanding (ctx, src, changes, globalSeedFull) {
  if (src.closed) return
  const scopeId = `meta:${src.key}`
  for (const name of ['system', 'view']) {
    const c = changes?.get(name)
    if (!c?.to?.key || c.incremental) continue
    const hex = b4a.toString(c.to.key, 'hex')
    ctx.replication.registerKey(hex, scopeId)
    if (!(src.seedFull || globalSeedFull)) continue
    const prev = src.landedCores.get(name)
    if (prev?.hex === hex) continue
    const core = src.scopedNs.get({ key: b4a.from(hex, 'hex') })
    src.landedCores.set(name, { hex, core })
    if (prev) prev.core.close().catch(err => { void err })
    core.ready().then(() => core.download({ start: 0, end: -1 })).catch(err => { void err })
  }
}

export async function registerKnownMetaCores (ctx, src) {
  if (ctx.life.closing || src.closed || !src.bee?.view?.head()?.length) return
  const scopeId = `meta:${src.key}`
  try {
    for await (const n of src.bee.view.createReadStream({ gte: b4a.from('shard/'), lt: b4a.from('shard/\xff'), timeout: 500 })) {
      if (ctx.life.closing || src.closed) return
      ctx.replication.registerKey(decodeShardEntry(n.value).coreKey, scopeId)
    }
    const snapNode = await src.bee.view.get(b4a.from('meta/searchSnapshot'), { timeout: 500 }).catch(() => null)
    if (snapNode && !ctx.life.closing && !src.closed) {
      ctx.replication.registerKey(decodeSearchSnapshot(snapNode.value).coreKey, scopeId)
    }
  } catch (err) { void err }
}

export async function seedMetaSource (ctx, src, globalSeedFull) {
  if (ctx.life.closing || src.closed || !(src.seedFull || globalSeedFull)) return
  const seedCore = coreKey => {
    if (ctx.life.closing || src.closed) return
    ctx.replication.registerKey(coreKey, `meta:${src.key}`)
    if (src.seedCores.has(coreKey)) return
    const c = src.scopedNs.get({ key: b4a.from(coreKey, 'hex') })
    src.seedCores.set(coreKey, c)
    c.ready().then(() => { if (!src.closed) return c.download({ start: 0, end: -1 }) }).catch(err => { void err })
  }
  try {
    for await (const n of src.bee.view.createReadStream({ gte: b4a.from('shard/'), lt: b4a.from('shard/\xff') })) {
      if (ctx.life.closing || src.closed) return
      seedCore(decodeShardEntry(n.value).coreKey)
    }
    const snapNode = await src.bee.view.get(b4a.from('meta/searchSnapshot'))
    if (snapNode && !ctx.life.closing && !src.closed) seedCore(decodeSearchSnapshot(snapNode.value).coreKey)
  } catch (err) { void err }
}

export function matchBucketHit (hit, qFold, qWords) {
  const hay = foldText(`${hit.title} ${hit.subtitle}`)
  if (!qWords.every(w => hay.includes(w))) return -1
  const titleFold = foldText(hit.title)
  if (titleFold === qFold) return hit.score + 20_000
  if (titleFold.startsWith(qFold)) return hit.score + 10_000
  return hit.score
}

export async function buildAndPublishSnapshot (ctx, src, appendMeta, { lists = [], buckets = [], titleCount = 0 } = {}) {
  await src.bee.update()
  if (!src.bee.writable) throw new Error('Metadata channel is not writable by this node')
  const prevNode = await src.bee.view.get(b4a.from('meta/searchSnapshot'))
  const generation = (prevNode ? decodeSearchSnapshot(prevNode.value).generation : 0) + 1
  const snapStore = src.scopedNs.session()
  const core = snapStore.get({ name: `search-snap-${generation}` })
  await core.ready()
  const snapBee = new Hyperbee2(snapStore, { core, writable: true, autoUpdate: false })
  try {
    await snapBee.ready()
    const coreKey = b4a.toString(core.key, 'hex')
    ctx.replication.registerKey(coreKey, `meta:${src.key}`)
    const batch = snapBee.write()
    for (const l of lists) {
      const encoded = encodeList(l)
      const dec = decodeList(encoded)
      batch.tryPut(b4a.from(`list/${dec.kind}/${dec.slug}`), encoded)
    }
    for (const b of buckets) {
      const encoded = encodeIndexBucket(b)
      const dec = decodeIndexBucket(encoded)
      batch.tryPut(b4a.from(`idx/${dec.kind}/${dec.prefix}`), encoded)
    }
    await batch.flush()
    const snapshot = { coreKey, generation, updatedAt: Date.now(), titleCount }
    await appendMeta(src, { type: 'setSnapshot', snapshot })
    const prevSnap = src.snapCache
    src.snapCache = { coreKey, bee: snapBee }
    if (prevSnap && prevSnap.bee !== snapBee) prevSnap.bee.close().catch(err => { void err })
    return snapshot
  } catch (err) {
    await snapBee.close().catch(e => { void e })
    throw err
  }
}

export async function openSnapshotBee (ctx, src, timeoutMs) {
  await applied(src.bee)
  const node = await src.bee.view.get(b4a.from('meta/searchSnapshot'), { timeout: timeoutMs }).catch(() => null)
  if (!node) return null
  const snap = decodeSearchSnapshot(node.value)
  ctx.replication.registerKey(snap.coreKey, `meta:${src.key}`)
  if (!src.snapCache || src.snapCache.coreKey !== snap.coreKey) {
    if (!src.snapOpening || src.snapOpening.coreKey !== snap.coreKey) {
      const promise = (async () => {
        const snapStore = src.scopedNs.session()
        const bee = new Hyperbee2(snapStore, { key: b4a.from(snap.coreKey, 'hex'), writable: false, autoUpdate: true })
        await bee.ready()
        if (src.closed || ctx.life.closing) {
          await bee.close().catch(err => { void err })
          return null
        }
        const prev = src.snapCache
        src.snapCache = { coreKey: snap.coreKey, bee }
        if (prev && prev.bee !== bee) prev.bee.close().catch(err => { void err })
        return bee
      })()
      src.snapOpening = { coreKey: snap.coreKey, promise }
      promise.finally(() => { if (src.snapOpening?.promise === promise) src.snapOpening = null })
    }
    await src.snapOpening.promise
  }
  const bee = src.snapCache?.bee
  if (!bee) return null
  if (bee.core.length === 0) {
    await withTimeout(bee.core.update({ wait: true }), timeoutMs).catch(err => { void err })
    bee.update()
  }
  return bee.core.length > 0 ? bee : null
}
