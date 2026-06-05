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

function mergeMappings(existing, next) {
  if (!existing) return next

  const variants = new Map()
  for (const variant of existing.variants) variants.set(variantId(variant), variant)
  for (const variant of next.variants) variants.set(variantId(variant), variant)

  return normalize({
    fileHash: next.fileHash,
    sourceId: next.sourceId || existing.sourceId,
    variants: [...variants.values()],
  })
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

      const mapping = merge ? mergeMappings(await readExisting(tx, key), next) : next
      const value = encode(mapping)

      await putRaw(tx, key, value)
      if (typeof tx.close === 'function') await tx.close()

      return { mapping, value }
    } catch (error) {
      if (typeof tx.close === 'function') await tx.close().catch(() => {})
      throw error
    }
  }

  const mapping = merge ? mergeMappings(await readExisting(db, key), next) : next
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
    const next = normalize({ ...metadata, fileHash: fileHashBuffer })
    const { mapping, value } = await writeWithTransaction(db, key, next, merge)

    return { key, mapping, value }
  })
}

export async function readArchiveMapping(db, fileHash) {
  return readExisting(db, archiveKey(fileHash))
}

export default writeArchiveMapping
