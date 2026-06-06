import b4a from 'b4a'

import { decode, encode, normalize } from './archive-schema.js'

const archiveLocks = new WeakMap()

function toHashBuffer(fileHash) {
  if (!fileHash) throw new TypeError('fileHash is required')

  const buffer = b4a.isBuffer(fileHash)
    ? fileHash
    : typeof fileHash === 'string'
      ? b4a.from(fileHash, 'hex')
      : b4a.from(fileHash)

  if (buffer.byteLength !== 32) throw new RangeError('fileHash must be exactly 32 bytes')
  return buffer
}

export function archiveKey(fileHash) {
  return `/archives/${b4a.toString(toHashBuffer(fileHash), 'hex')}`
}

function getRawStore(db) {
  if (!db || typeof db !== 'object') throw new TypeError('db must be an active database instance')
  if (typeof db.put === 'function') return db
  if (db.engine?.db && typeof db.engine.db.put === 'function') return db.engine.db
  throw new TypeError('db must expose put(key, value) or a HyperDB engine.db raw store')
}

async function readExisting(db, key) {
  const raw = getRawStore(db)
  if (typeof raw.get !== 'function') return null

  const node = await raw.get(key)
  if (!node) return null
  return node.value ? decode(node.value) : null
}

function variantId(variant) {
  return `${variant.resolution}\0${b4a.toString(variant.coreKey, 'hex')}\0${variant.startBlock}`
}

function toCoreKeyBuffer(coreKey) {
  if (!coreKey) throw new TypeError('hypercoreKey is required')
  const buffer = b4a.isBuffer(coreKey)
    ? coreKey
    : typeof coreKey === 'string'
      ? b4a.from(coreKey, 'hex')
      : b4a.from(coreKey)
  if (buffer.byteLength !== 32) throw new RangeError('hypercoreKey must be exactly 32 bytes')
  return buffer
}

function mergeMappings(existing, next) {
  if (!existing) return next

  if (!b4a.equals(existing.hypercoreKey, next.hypercoreKey)) {
    throw new Error('archive mapping already has a canonical hypercore key for this content hash')
  }

  const variants = new Map()
  for (const variant of existing.variants) {
    if (b4a.equals(variant.coreKey, existing.hypercoreKey)) variants.set(variantId(variant), variant)
  }
  for (const variant of next.variants) variants.set(variantId(variant), variant)

  return normalize({
    fileHash: next.fileHash,
    hypercoreKey: existing.hypercoreKey,
    sourceId: next.sourceId || existing.sourceId,
    variants: [...variants.values()],
  })
}

function enforceCanonicalWrite(mapping) {
  for (const variant of mapping.variants) {
    if (!b4a.equals(variant.coreKey, mapping.hypercoreKey)) {
      throw new Error('archive writes must reference the canonical hypercoreKey')
    }
  }
  return mapping
}

function canonicalVariantFor(core, metadata = {}) {
  const key = toCoreKeyBuffer(core?.key || metadata.hypercoreKey || metadata.coreKey || metadata.variants?.[0]?.coreKey)
  const length = Number.isSafeInteger(core?.length) ? core.length : Number(metadata.endBlock || metadata.length || 0)
  return {
    resolution: metadata.resolution || metadata.variant || 'original',
    coreKey: key,
    startBlock: Number.isSafeInteger(metadata.startBlock) ? metadata.startBlock : 0,
    endBlock: Number.isSafeInteger(metadata.endBlock) ? metadata.endBlock : Math.max(0, length),
  }
}

async function readyCore(core) {
  if (core && typeof core.ready === 'function') await core.ready()
  return core
}

function archiveCoreName(fileHash) {
  return `archives/${b4a.toString(toHashBuffer(fileHash), 'hex')}`
}

function openCoreByKey(store, key) {
  if (!store || typeof store.get !== 'function') throw new TypeError('store with get() is required')
  return store.get({ key: toCoreKeyBuffer(key) })
}

function createCoreForHash(store, fileHash) {
  if (!store || typeof store.get !== 'function') throw new TypeError('store with get() is required')
  return store.get({ name: archiveCoreName(fileHash) })
}

async function joinCoreSwarm(swarm, core, opts = {}) {
  if (!swarm || typeof swarm.join !== 'function' || !core?.discoveryKey) return null
  const handle = swarm.join(core.discoveryKey, { server: true, client: true, ...opts })
  if (handle && typeof handle.flushed === 'function') await handle.flushed().catch(() => {})
  return handle
}

async function withWriteLock(db, key, fn) {
  const locks = archiveLocks.get(db) || new Map()
  if (!archiveLocks.has(db)) archiveLocks.set(db, locks)

  const previous = locks.get(key) || Promise.resolve()
  let release
  const current = new Promise((resolve) => { release = resolve })
  const next = previous.then(() => current, () => current)
  locks.set(key, next)

  await previous
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(key) === next) locks.delete(key)
  }
}

async function putRaw(db, key, value) {
  const raw = getRawStore(db)

  if (typeof raw.batch === 'function') {
    const batch = raw.batch()
    await batch.put(key, value)
    await batch.flush()
    return
  }

  await raw.put(key, value)
}

function hasPendingHyperDbUpdates(db) {
  return Boolean(
    (typeof db.updated === 'function' && db.updated()) ||
    (Number.isSafeInteger(db.updates?.mutating) && db.updates.mutating > 0)
  )
}

async function writeWithTransaction(db, key, next, merge) {
  if (typeof db.exclusiveTransaction === 'function') {
    if (hasPendingHyperDbUpdates(db)) {
      throw new Error('Cannot write archive mapping while HyperDB has pending updates; flush or discard them first')
    }

    const tx = await db.exclusiveTransaction()
    try {
      if (hasPendingHyperDbUpdates(db)) {
        throw new Error('Cannot write archive mapping while HyperDB has pending updates; flush or discard them first')
      }

      const existing = await readExisting(tx, key)
      if (existing && !b4a.equals(existing.hypercoreKey, next.hypercoreKey)) {
        throw new Error('archive mapping already has a canonical hypercore key for this content hash')
      }
      const mapping = existing && merge ? mergeMappings(existing, next) : next
      const value = encode(mapping)

      await putRaw(tx, key, value)
      if (typeof tx.close === 'function') await tx.close()

      return { mapping, value }
    } catch (error) {
      if (typeof tx.close === 'function') await tx.close().catch(() => {})
      throw error
    }
  }

  const existing = await readExisting(db, key)
  if (existing && !b4a.equals(existing.hypercoreKey, next.hypercoreKey)) {
    throw new Error('archive mapping already has a canonical hypercore key for this content hash')
  }
  const mapping = existing && merge ? mergeMappings(existing, next) : next
  const value = encode(mapping)

  await putRaw(db, key, value)
  if (typeof db.flush === 'function') await db.flush()

  return { mapping, value }
}

export async function writeArchiveMapping(db, fileHash, metadata, opts = {}) {
  const fileHashBuffer = toHashBuffer(fileHash)
  const key = archiveKey(fileHashBuffer)
  const merge = opts.merge !== false

  if (!metadata || typeof metadata !== 'object') {
    throw new TypeError('metadata must be an object')
  }

  return withWriteLock(db, key, async () => {
    const next = enforceCanonicalWrite(normalize({ ...metadata, fileHash: fileHashBuffer }))
    const { mapping, value } = await writeWithTransaction(db, key, next, merge)

    return { key, mapping, value }
  })
}

export async function ensureCanonicalArchiveCore(db, fileHash, options = {}) {
  const fileHashBuffer = toHashBuffer(fileHash)
  const key = archiveKey(fileHashBuffer)
  const store = options.store
  const swarm = options.swarm
  const metadata = options.metadata || {}

  return withWriteLock(db, key, async () => {
    const existing = await readExisting(db, key)
    if (existing?.hypercoreKey) {
      const core = await readyCore(openCoreByKey(store, existing.hypercoreKey))
      const discoveryHandle = await joinCoreSwarm(swarm, core, options.swarmOptions)
      return { key, mapping: existing, core, discoveryHandle, created: false }
    }

    const core = await readyCore(
      typeof options.createCore === 'function'
        ? await options.createCore({ fileHash: fileHashBuffer, name: archiveCoreName(fileHashBuffer) })
        : createCoreForHash(store, fileHashBuffer)
    )
    const hypercoreKey = toCoreKeyBuffer(core.key)
    const next = normalize({
      fileHash: fileHashBuffer,
      hypercoreKey,
      sourceId: metadata.sourceId || options.sourceId || 'archive:unknown',
      variants: Array.isArray(metadata.variants) && metadata.variants.length > 0
        ? metadata.variants.map((variant) => ({ ...variant, coreKey: hypercoreKey }))
        : [canonicalVariantFor(core, { ...metadata, hypercoreKey })],
    })
    const { mapping, value } = await writeWithTransaction(db, key, next, false)
    const discoveryHandle = await joinCoreSwarm(swarm, core, options.swarmOptions)
    return { key, mapping, value, core, discoveryHandle, created: true }
  })
}

export async function readArchiveMapping(db, fileHash) {
  return readExisting(db, archiveKey(fileHash))
}

export default writeArchiveMapping
