import b4a from 'b4a'

import { PUBLISHER_LIMITS } from '../publisher/canonical.js'
import { createCatalogIngestor } from './catalog-ingestor.js'
import { createLocalIndexService } from './local-service.js'
import { createIndexerStore } from './store.js'

const LOCAL_INDEX_CORE_NAME = 'peartube-local-catalog-index-v3'

const AGGREGATE_LIMIT = Object.freeze({
  maxRetainedBytes: Number.MAX_SAFE_INTEGER - 1,
  maxRows: Number.MAX_SAFE_INTEGER - 1,
})
const PUBLISHER_LIMIT = Object.freeze({
  maxRetainedBytes: PUBLISHER_LIMITS.maxSnapshotBytes,
  maxRows: PUBLISHER_LIMITS.maxJournalOperations,
})
const LOCAL_INDEX_LIMITS = Object.freeze({
  global: AGGREGATE_LIMIT,
  shard: AGGREGATE_LIMIT,
  publisher: PUBLISHER_LIMIT,
  trustClasses: Object.freeze({ untrusted: PUBLISHER_LIMIT }),
})

export async function createLocalCatalogIndex({ store, catalogRegistry, onError = null } = {}) {
  if (!store || typeof store.get !== 'function') throw new TypeError('local catalog index requires Corestore')
  if (!catalogRegistry || typeof catalogRegistry.listBindings !== 'function') {
    throw new TypeError('local catalog index requires catalogRegistry.listBindings')
  }
  if (onError !== null && typeof onError !== 'function') throw new TypeError('local catalog index onError must be a function')

  const index = await createIndexerStore({ store, limits: LOCAL_INDEX_LIMITS, name: LOCAL_INDEX_CORE_NAME })
  const ingestor = createCatalogIngestor({ index })
  const service = createLocalIndexService({ index })
  let closed = false
  let refreshing = Promise.resolve({ indexed: 0, failed: 0 })

  async function performRefresh(signal) {
    const bindings = await catalogRegistry.listBindings()
    let indexed = 0
    let failed = 0
    for (const binding of bindings) {
      if (signal?.aborted) throw signal.reason || new Error('local catalog index refresh aborted')
      const publisherId = b4a.isBuffer(binding?.publisherId)
        ? b4a.toString(binding.publisherId, 'hex')
        : null
      try {
        // Read the descriptor from the same verified local view the ingestor
        // will pin. A network announcement may be newer than the persisted
        // page view and must not be paired with older local rows.
        const descriptor = await binding?.catalog?.getNamespaceDescriptor?.() || binding?.namespaceDescriptor
        if (!publisherId || !descriptor || !binding?.catalog) continue
        await ingestor.ingest({ publisherId, descriptor, catalog: binding.catalog, ...(signal ? { signal } : {}) })
        indexed++
      } catch (error) {
        failed++
        try { onError?.(error, { publisherId }) } catch { /* Error reporting must not stop indexing. */ }
      }
    }
    return { indexed, failed }
  }

  const resource = {
    index,
    service,
    refresh({ signal = undefined } = {}) {
      if (closed) return Promise.reject(new Error('local catalog index is closed'))
      const next = refreshing.then(() => performRefresh(signal), () => performRefresh(signal))
      refreshing = next.catch(() => ({ indexed: 0, failed: 1 }))
      return next
    },
    async close() {
      if (closed) return false
      closed = true
      await refreshing.catch(() => {})
      service.close()
      await index.close()
      return true
    },
  }
  return Object.freeze(resource)
}
