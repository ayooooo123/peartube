import Hyperbee from 'hyperbee'

import { createIdentityManager } from './identity.js'
import { readIdentityKeyFile } from './identity-key-file.js'
import {
  createCorestoreInstance,
  openDeterministicNamedCore,
} from './storage.js'

const activePreflights = new Map()

function boundedCount (value) {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value))
}

function countLegacyRoots (identities) {
  if (!Array.isArray(identities)) return 0

  let count = 0
  for (const identity of identities) {
    if (identity && Object.prototype.hasOwnProperty.call(identity, 'secretKey')) {
      count = boundedCount(count + 1)
    }
  }
  return count
}

function result (status, scanned, migrated, remaining, errorCode) {
  const summary = {
    status,
    scanned: boundedCount(scanned),
    migrated: boundedCount(migrated),
    remaining: boundedCount(remaining),
  }
  if (errorCode) summary.errorCode = errorCode
  return summary
}

function unavailable (errorCode) {
  return result('unavailable', 0, 0, 0, errorCode)
}

function isStorageLockError (error) {
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : ''
  if (code === 'ELOCKED' || code === 'LOCKED' || code === 'EBUSY') return true

  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : ''
  return message.includes('lock') && (
    message.includes('already') ||
    message.includes('busy') ||
    message.includes('held') ||
    message.includes('resource temporarily unavailable') ||
    message.includes('could not acquire') ||
    message.includes('could not be locked')
  )
}

async function closeResource (resource) {
  try {
    await resource?.close?.()
  } catch {}
}

/**
 * Run the identity migration state machine against an already-open metadata bee.
 * The returned summary contains counts only; identity records and secret material
 * never leave the migration callback.
 */
export async function migrateLegacyPublisherRootsInMetaDb ({
  metaDb,
  migrateLegacyPublisherRoot,
} = {}) {
  if (!metaDb || typeof metaDb.get !== 'function' || typeof metaDb.put !== 'function') {
    return unavailable('MIGRATION_UNAVAILABLE')
  }

  try {
    const beforeRecord = await metaDb.get('identities')
    const before = Array.isArray(beforeRecord?.value) ? beforeRecord.value : []
    const scanned = boundedCount(before.length)
    const legacyBefore = countLegacyRoots(before)

    if (legacyBefore === 0) {
      return result('no-legacy-roots', scanned, 0, 0)
    }

    const manager = createIdentityManager({
      ctx: { metaDb },
      migrateLegacyPublisherRoot,
    })
    await manager.loadIdentities()

    const afterRecord = await metaDb.get('identities')
    const after = Array.isArray(afterRecord?.value) ? afterRecord.value : []
    const remaining = countLegacyRoots(after)
    const migrated = boundedCount(Math.max(0, legacyBefore - remaining))

    return result(
      remaining === 0 ? 'complete' : 'pending',
      scanned,
      migrated,
      remaining
    )
  } catch {
    return unavailable('MIGRATION_UNAVAILABLE')
  }
}

async function executePreflight ({
  storagePath,
  migrateLegacyPublisherRoot,
  waitForLock = false,
}) {
  let store = null
  let core = null
  let metaDb = null

  try {
    if (typeof storagePath !== 'string' || storagePath.length === 0) {
      return unavailable('STORAGE_UNAVAILABLE')
    }

    const identityKey = await readIdentityKeyFile(storagePath)
    if (!identityKey?.primaryKey) return unavailable('STORAGE_UNAVAILABLE')

    store = await createCorestoreInstance(storagePath, {
      primaryKey: identityKey.primaryKey,
      unsafe: true,
      wait: waitForLock === true,
      allowBackup: false,
    })
    await store.ready()

    core = await openDeterministicNamedCore(store, 'peartube-meta')
    await core.ready()

    metaDb = new Hyperbee(core, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json',
    })
    await metaDb.ready()

    return await migrateLegacyPublisherRootsInMetaDb({
      metaDb,
      migrateLegacyPublisherRoot,
    })
  } catch (error) {
    return unavailable(isStorageLockError(error) ? 'STORAGE_LOCKED' : 'STORAGE_UNAVAILABLE')
  } finally {
    await closeResource(metaDb)
    await closeResource(core)
    await closeResource(store)
  }
}

/**
 * Open only the deterministic metadata Corestore/Hyperbee and migrate legacy
 * publisher roots. Concurrent callers for one storage path join the same run.
 */
export function runLegacyPublisherRootPreflight (options = {}) {
  const storagePath = options?.storagePath
  const lockKey = typeof storagePath === 'string' ? storagePath : ''
  const active = activePreflights.get(lockKey)
  if (active) return active

  const preflight = executePreflight(options)
  activePreflights.set(lockKey, preflight)

  const clear = () => {
    if (activePreflights.get(lockKey) === preflight) activePreflights.delete(lockKey)
  }
  preflight.then(clear, clear)

  return preflight
}
