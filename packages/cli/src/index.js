import * as fs from '#fs'
import { createCliLogger } from './cli-logger.js'
import { resolveRelayConfig } from './config.js'
import { downloadChannelBlobs } from './blob-downloader.js'
import { createRelayRuntime } from './runtime.js'
import { createRelayService } from './service.js'
import { createArchiver } from './archive/index.js'

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
        serviceLogger.download,
        resolved
      )
    }
  })

  await service.start()

  let archiver = null
  if (config.archive?.enabled && Array.isArray(config.archive.sources) && config.archive.sources.length) {
    try {
      archiver = createArchiver({
        config,
        runtime: service.runtime,
        logger: relayLogger,
        fs
      })
      await archiver.start()
    } catch (err) {
      relayLogger.archive.error('Archive failed to start', { error: err?.message || String(err) })
      archiver = null
    }
  }

  const baseClose = service.close.bind(service)
  service.close = async () => {
    if (archiver) {
      try { await archiver.stop() } catch (err) {
        relayLogger.archive.warn('Archive stop failed', { error: err?.message || String(err) })
      }
    }
    await baseClose()
  }
  service.archiver = archiver

  return service
}
