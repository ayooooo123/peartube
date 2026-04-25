import { randomBytes } from 'node:crypto'

import { createBackendContext } from '@peartube/backend/orchestrator'
import { shutdownBackend } from '@peartube/backend/storage'
import { CacheManager } from './cache-manager.js'
import { readPrimaryKeyFile, writePrimaryKeyFile } from '../../backend/src/identity-key-file.js'

export async function createRelayRuntime({ config, logger }) {
  const storageRoot = config.storage.path

  let primaryKey = null
  try {
    primaryKey = await readPrimaryKeyFile(storageRoot)
  } catch (err) {
    logger.runtime?.warn('Failed to read relay primary-key file', {
      error: err?.message || String(err),
      storageRoot,
    })
  }

  if (!primaryKey) {
    primaryKey = randomBytes(32)
    try {
      await writePrimaryKeyFile(storageRoot, primaryKey)
      logger.runtime?.info('Persisted relay runtime key', { storageRoot })
    } catch (err) {
      logger.runtime?.warn('Failed to persist relay runtime key', {
        error: err?.message || String(err),
        storageRoot,
      })
    }
  }

  const backend = await createBackendContext({ storagePath: storageRoot })
  const ctx = backend.ctx
  ctx.store = createRelayStoreFacade(primaryKey)

  const publicFeed = createRelayFeedFacade()
  const cacheManager = new CacheManager(ctx.store, ctx.metaDb, config?.storage?.maxBytes || 0)
  let candidateHandler = null

  function emitConfiguredCandidates() {
    if (typeof candidateHandler !== 'function') return
    for (const channelKey of config.admission?.channels || []) {
      if (!channelKey) continue
      candidateHandler({ channelKey, source: 'config' })
    }
  }

  return {
    ctx,
    publicFeed,
    cacheManager,
    backend,
    setCandidateHandler(handler) {
      candidateHandler = handler
    },
    async start() {
      logger.runtime?.info('Initializing engine relay runtime', {
        storagePath: config.storage.path,
        storageRoot,
        mode: config.mode,
        policy: config.policy
      })
      await cacheManager.init()
      emitConfiguredCandidates()
      logger.runtime?.info('Relay runtime started', this.getNetworkStats())
    },
    requestFeedSync() {
      return 0
    },
    async resolveCandidate(candidate) {
      const channelKey = candidate?.channelKey || candidate?.driveKey
      const resolved = {
        ...candidate,
        channelKey,
        publicBeeKey: candidate?.publicBeeKey || null,
        ownerKey: candidate?.ownerKey || null
      }

      if (channelKey) {
        try {
          await backend.engineAdapter?.ensureEngineForUiChannel?.(channelKey, { name: candidate?.channelName })
        } catch (err) {
          logger.runtime?.debug('Engine candidate open failed', {
            channelKey,
            error: err?.message || String(err)
          })
        }
      }

      return resolved
    },
    getNetworkStats() {
      return {
        peers: 0,
        connections: 0,
        feedPeers: 0,
        feedConnections: 0,
        feedEntries: 0
      }
    },
    async close() {
      try { publicFeed.stop() } catch {}
      await shutdownBackend(ctx)
      ctx.store.closed = true
    }
  }
}

function createRelayStoreFacade(primaryKey) {
  return {
    primaryKey,
    closed: false,
    get() {
      throw new Error('Legacy Corestore access removed from relay runtime; use @peartube/engine')
    },
    async close() {
      this.closed = true
    }
  }
}

function createRelayFeedFacade() {
  return {
    entries: new Map(),
    feedConnections: new Set(),
    setOnFeedUpdate() {},
    async start() {},
    stop() {},
    handleConnection() {},
    async submitChannel(channelKey, publicBeeKey = null) {
      if (channelKey) this.entries.set(channelKey, { driveKey: channelKey, publicBeeKey })
      return true
    },
    requestFeedsFromPeers() { return 0 },
    getStats() { return { totalEntries: this.entries.size, peerCount: 0 } }
  }
}
