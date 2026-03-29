import { createCliLogger } from './cli-logger.js'
import { evaluateCandidate } from './admission.js'
import { RelayCatalog } from './catalog.js'
import { buildRelayStatus, writeRelayStatus } from './status.js'

export async function createRelayService({
  config,
  runtimeFactory,
  mirrorChannel,
  writeStatusFile = writeRelayStatus,
  logger = createCliLogger(config?.logging?.level || 'info'),
  catalog = null
}) {
  if (!config) throw new Error('config is required')
  if (typeof runtimeFactory !== 'function') throw new Error('runtimeFactory is required')
  if (typeof mirrorChannel !== 'function') throw new Error('mirrorChannel is required')

  const relayCatalog = catalog || await RelayCatalog.open({
    storagePath: config.storage.path,
    catalogPath: config.paths.catalog
  })
  const runtime = await runtimeFactory({ config, logger })

  let closed = false
  let currentStatus = null
  let queue = Promise.resolve()

  async function persistStatus() {
    currentStatus = buildRelayStatus({
      config,
      catalog: relayCatalog,
      runtimeStats: runtime.getNetworkStats?.() || {}
    })

    await Promise.resolve(writeStatusFile(config.paths.status, currentStatus))
    return currentStatus
  }

  async function processCandidate(candidate) {
    if (closed) {
      return { accepted: false, reason: 'closed' }
    }

    const resolved = runtime.resolveCandidate
      ? await runtime.resolveCandidate(candidate)
      : candidate

    const decision = evaluateCandidate({
      candidate: resolved,
      config,
      acceptedChannels: new Set(relayCatalog.getChannels().map((channel) => channel.channelKey)),
      ownerCounts: relayCatalog.getOwnerCounts()
    })

    if (!decision.accepted) {
      logger.admission.info('Candidate rejected', {
        channelKey: resolved.channelKey,
        ownerKey: resolved.ownerKey || null,
        source: resolved.source || 'discovered',
        reason: decision.reason
      })
      await persistStatus()
      return decision
    }

    const baseRecord = {
      channelKey: resolved.channelKey,
      ownerKey: resolved.ownerKey || null,
      publicBeeKey: resolved.publicBeeKey || null,
      source: resolved.source || 'discovered',
      retentionClass: decision.retentionClass,
      lastDecisionReason: decision.reason,
      lastSeenAt: Date.now()
    }

    await relayCatalog.upsertChannel(baseRecord)

    try {
      logger.admission.info('Candidate accepted', {
        channelKey: resolved.channelKey,
        ownerKey: resolved.ownerKey || null,
        source: resolved.source || 'discovered',
        retentionClass: decision.retentionClass,
        reason: decision.reason
      })

      const mirrorStats = await mirrorChannel(resolved, {
        config,
        runtime,
        logger,
        catalog: relayCatalog,
        decision
      })

      await relayCatalog.upsertChannel({
        ...baseRecord,
        bytes: mirrorStats?.bytesDownloaded || 0,
        videosFound: mirrorStats?.videosFound || 0,
        videosDownloaded: mirrorStats?.videosDownloaded || 0,
        mirroredAt: Date.now(),
        lastError: null
      })

      logger.mirror.info('Channel mirrored', {
        channelKey: resolved.channelKey,
        ownerKey: resolved.ownerKey || null,
        retentionClass: decision.retentionClass,
        bytesDownloaded: mirrorStats?.bytesDownloaded || 0,
        videosFound: mirrorStats?.videosFound || 0,
        videosDownloaded: mirrorStats?.videosDownloaded || 0
      })
    } catch (err) {
      await relayCatalog.upsertChannel({
        ...baseRecord,
        lastError: err?.message || String(err)
      })

      logger.mirror.error('Channel mirror failed', {
        channelKey: resolved.channelKey,
        ownerKey: resolved.ownerKey || null,
        retentionClass: decision.retentionClass,
        error: err?.message || String(err)
      })
    }

    await persistStatus()
    return { accepted: true, retentionClass: decision.retentionClass, reason: decision.reason }
  }

  function scheduleCandidate(candidate) {
    queue = queue.then(() => processCandidate(candidate))
    return queue
  }

  const service = {
    config,
    logger,
    runtime,
    catalog: relayCatalog,
    async start() {
      logger.relay.info('Relay starting', {
        mode: config.mode,
        policy: config.policy,
        storagePath: config.storage.path,
        maxBytes: config.storage.maxBytes,
        configuredChannels: config.admission.channels?.length || 0,
        configuredOwners: config.admission.owners?.length || 0
      })

      runtime.setCandidateHandler?.((candidate) => scheduleCandidate({
        source: 'discovered',
        ...candidate
      }))

      await runtime.start?.()

      if (typeof runtime.requestFeedSync === 'function') {
        const peersContacted = await runtime.requestFeedSync()
        logger.feed.info('Requested feed sync from peers', { peersContacted })
      }

      for (const channelKey of config.admission.channels || []) {
        await scheduleCandidate({
          channelKey,
          source: 'config'
        })
      }

      const status = await persistStatus()
      logger.relay.info('Relay started', {
        peers: status.runtime.peers,
        connections: status.runtime.connections,
        feedPeers: status.runtime.feedPeers,
        feedConnections: status.runtime.feedConnections,
        feedEntries: status.runtime.feedEntries,
        mirroredChannels: status.summary.totalChannels
      })
      return service
    },
    async processCandidate(candidate) {
      return scheduleCandidate(candidate)
    },
    getStatus() {
      return currentStatus || buildRelayStatus({
        config,
        catalog: relayCatalog,
        runtimeStats: runtime.getNetworkStats?.() || {}
      })
    },
    async close() {
      closed = true
      await queue.catch(() => {})
      await runtime.close?.()
      await persistStatus()
    }
  }

  return service
}
