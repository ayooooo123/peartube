import { createBackendContext } from '@peartube/backend'
import { PROTOCOL_VERSION } from '@peartube/host/contracts'
import { createDiagnosticScope } from './diagnostic-scope.js'
import { normalizeNetworkTrust } from './preferences.js'

// Opens the universal PearTube backend for a single `peartube add` command,
// forwarding authenticated relay configuration and routing backend diagnostics
// to the injected stderr logger.
export async function openAddRuntime ({
  storagePath,
  network = {},
  logger,
  target = console,
  backendFactory = createBackendContext
} = {}) {
  if (!storagePath) throw new Error('openAddRuntime requires a storagePath')
  if (!logger || typeof logger.log !== 'function') throw new Error('openAddRuntime requires a logger')

  const scope = createDiagnosticScope({ logger, target })
  scope.install()

  let backend
  try {
    const trust = normalizeNetworkTrust(network)
    backend = await backendFactory({
      storagePath,
      platform: 'cli',
      role: 'hybrid',
      expectedProtocolVersion: PROTOCOL_VERSION,
      network: {
        trustedRelayKeys: trust.trustedRelayKeys
      },
      ipcLog: (message) => {
        const emit = logger.debug || logger.log
        emit.call(logger, message)
      }
    })
  } catch (error) {
    scope.restore()
    throw error
  }

  return {
    backend,
    ctx: backend.ctx,
    api: backend.api,
    identityManager: backend.identityManager,
    uploadManager: backend.uploadManager,
    seedingManager: backend.seedingManager,
    seedPinClients: backend.seedPinClients,
    metadataBee: backend.ctx?.metaDb || null,
    async close () {
      try {
        await backend.destroy()
      } finally {
        scope.restore()
      }
    }
  }
}
