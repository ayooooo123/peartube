import { createBackendContext } from '@peartube/backend/orchestrator'
import { shutdownBackend } from '@peartube/backend/storage'
import { createDiagnosticScope } from './diagnostic-scope.js'
import { normalizeNetworkTrust } from './preferences.js'

// Opens the universal PearTube backend for a single `peartube add` command,
// forwarding normalized trusted-relay / blind-peer configuration and routing
// legacy console.* diagnostics to the injected stderr logger. Never spins up a
// second backend or shells out for P2P behavior.
export async function openAddRuntime ({ storagePath, network = {}, logger, target = console } = {}) {
  if (!storagePath) throw new Error('openAddRuntime requires a storagePath')
  if (!logger || typeof logger.log !== 'function') throw new Error('openAddRuntime requires a logger')

  const scope = createDiagnosticScope({ logger, target })
  scope.install()

  let backend
  try {
    const trust = normalizeNetworkTrust(network)
    backend = await createBackendContext({
      storagePath,
      network: {
        ...network,
        trustedRelayKeys: trust.trustedRelayKeys,
        blindPeerMirrors: trust.blindPeerMirrors
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
    publicFeed: backend.publicFeed,
    seedingManager: backend.seedingManager,
    seedPinClients: backend.seedPinClients,
    metadataBee: backend.ctx?.metaDb || null,
    async close () {
      try {
        await shutdownBackend(backend.ctx)
      } finally {
        scope.restore()
      }
    }
  }
}
