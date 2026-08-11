import { createCliLogger } from './cli-logger.js'
import { resolveRelayConfig } from './config.js'
import { createRelayRuntime } from './runtime.js'
import { createRelayService } from './service.js'

export { createCompanionServer } from './companion/server.js'
export { createCompanionRouter } from './companion/routes.js'
export {
  CompanionContractError,
  decodeIngestJobBody,
  decodeOpenStreamBody,
  decodeSearchQuery
} from './companion/contracts.js'

export async function startRelay({ config, logger = null } = {}) {
  if (!config) {
    throw new Error('startRelay requires a resolved config')
  }

  const relayLogger = logger || createCliLogger(config.logging?.level || 'info')

  const service = await createRelayService({
    config,
    logger: relayLogger,
    runtimeFactory: async () => createRelayRuntime({ config, logger: relayLogger })
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
