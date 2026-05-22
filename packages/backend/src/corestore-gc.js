function describeError(error) {
  return error?.message || String(error)
}

/**
 * Flush and compact Corestore's backing storage after clearing cached blocks.
 *
 * Hypercore clear() deletes ranges from RocksDB, but the host filesystem keeps
 * the old SST files until compaction rewrites them. This helper is best-effort:
 * cache clearing should still succeed even if the runtime storage backend does
 * not expose flush/compact or one of those calls fails.
 *
 * @param {import('corestore')} store
 * @param {{ label?: string, log?: (...args: any[]) => void }} [options]
 * @returns {Promise<{ flushed: boolean, compacted: boolean, error: string | null }>}
 */
export async function collectCorestoreGarbage(store, options = {}) {
  const storage = store?.storage
  const log = typeof options.log === 'function' ? options.log : null
  const label = options.label || 'cache clear'
  const result = { flushed: false, compacted: false, error: null }

  if (!storage) return result

  if (typeof storage.flush === 'function') {
    try {
      await storage.flush()
      result.flushed = true
    } catch (error) {
      result.error = describeError(error)
      log?.('[CorestoreGC] Failed to flush storage after', label + ':', result.error)
    }
  }

  if (typeof storage.compact === 'function') {
    try {
      await storage.compact()
      result.compacted = true
    } catch (error) {
      result.error = describeError(error)
      log?.('[CorestoreGC] Failed to compact storage after', label + ':', result.error)
    }
  }

  return result
}
