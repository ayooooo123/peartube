import { createCliLogger } from './cli-logger.js'
import { resolveRelayConfig } from './config.js'
import { downloadChannelBlobs } from './blob-downloader.js'
import { createRelayRuntime } from './runtime.js'
import { createRelayService } from './service.js'

export async function startRelay({ config, logger = null } = {}) {
  if (!config) {
    throw new Error('startRelay requires a resolved config')
  }

  const relayLogger = logger || createCliLogger(config.logging?.level || 'info')

  const service = await createRelayService({
    config,
    logger: relayLogger,
    runtimeFactory: async () => createRelayRuntime({ config, logger: relayLogger }),
    mirrorChannel: async (candidate, { runtime, logger: serviceLogger }) => {
      const resolved = candidate.publicBeeKey
        ? candidate
        : await runtime.resolveCandidate(candidate)

      if (!resolved.publicBeeKey) {
        serviceLogger.mirror.warn('Skipping mirror: missing publicBeeKey', {
          channelKey: resolved.channelKey,
          ownerKey: resolved.ownerKey || null
        })
        return {
          bytesDownloaded: 0,
          videosFound: 0,
          videosDownloaded: 0
        }
      }

      return downloadChannelBlobs(
        runtime.ctx,
        resolved.publicBeeKey,
        resolved.channelKey,
        serviceLogger.download
      )
    }
  })

  await service.start()
  return service
}

export async function startPeer({ storagePath, maxStorageMB, pinnedChannels = [], debug = false }) {
  const config = resolveRelayConfig({
    mode: 'private',
    policy: 'allowlist',
    storage: {
      path: storagePath,
      maxBytes: Number(maxStorageMB) * 1024 * 1024
    },
    admission: {
      channels: pinnedChannels,
      owners: []
    },
    logging: {
      level: debug ? 'debug' : 'info'
    }
  }, { env: {} })

  return startRelay({ config })
}
