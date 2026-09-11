import * as runtimeFs from '#fs'
import { createBackendContext } from '@peartube/backend'
import { STORAGE_FORMAT_VERSION } from '@peartube/backend/storage'
import { createLocalFileSourceGrantRegistry } from '../runtime.js'
import { createRelayPublisherShell } from '../publisher-shell.js'
import { createDiagnosticScope } from './diagnostic-scope.js'
import { normalizeNetworkTrust } from './preferences.js'

async function closeResources (resources, primaryError = null) {
  const errors = []
  for (const resource of resources) {
    try {
      await resource?.close?.()
    } catch (error) {
      errors.push(error)
    }
  }
  if (primaryError) errors.unshift(primaryError)
  if (errors.length === 0) return
  if (errors.length === 1) throw errors[0]
  throw new AggregateError(errors, 'runtime shutdown failed')
}

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
  const localFileSourceGrants = createLocalFileSourceGrantRegistry({ fs: runtimeFs })

  try {
    const trust = normalizeNetworkTrust(network)
    backend = await backendFactory({
      storagePath,
      platform: 'cli',
      role: 'hybrid',
      expectedStorageFormatVersion: STORAGE_FORMAT_VERSION,
      provider: {
        sourceGrantResolver: Object.freeze({
          async resolve ({ token, adapterId, acquisitionId, principalId, expiresAt }) {
            if (adapterId === 'local-file') {
              return localFileSourceGrants.resolver.resolve({ token, adapterId, acquisitionId, principalId, expiresAt })
            }
            const error = new Error(`Unsupported source grant adapter: ${adapterId}`)
            error.code = 'SOURCE_GRANT_UNAVAILABLE'
            throw error
          },
          async revoke ({ token, adapterId }) {
            if (adapterId === 'local-file') {
              return localFileSourceGrants.revoke(token)
            }
            return false
          }
        }),
        principalId: 'local-provider'
      },
      networkPolicy: {
        uploadPermission: 'enabled'
      },
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

  const publisherShell = createRelayPublisherShell({
    api: backend.api,
    storagePath,
    fs: runtimeFs,
    logger: {
      log: (...args) => logger?.debug?.(...args) || logger?.log?.(...args),
      info: (...args) => logger?.info?.(...args),
      warn: (...args) => logger?.warn?.(...args),
      error: (...args) => logger?.error?.(...args),
      debug: (...args) => logger?.debug?.(...args)
    }
  })

  let ensuredPublisher = null
  async function ensureLocalPublisher () {
    if (ensuredPublisher) return ensuredPublisher
    ensuredPublisher = await publisherShell.ensureLocalPublisher()
    const provider = backend.provider || backend.ctx?.providerService
    if (provider?.getAcquisitionPolicy && provider?.setAcquisitionPolicy) {
      const current = await provider.getAcquisitionPolicy().catch(() => null)
      if (current) {
        const allowedPublisherIds = [...new Set([...(current.allowedPublisherIds || []), ensuredPublisher.publisherId])].sort()
        const allowedAdapterIds = [...new Set([...(current.allowedAdapterIds || []), 'local-file'])].sort()
        const needsUpdate = current.migrationRequired === true ||
          current.enabled !== true ||
          current.requesterMode !== 'local-only' ||
          !allowedPublisherIds.every(id => (current.allowedPublisherIds || []).includes(id)) ||
          !allowedAdapterIds.every(id => (current.allowedAdapterIds || []).includes(id))
        if (needsUpdate) {
          await provider.setAcquisitionPolicy({
            policy: {
              policyVersion: 1,
              consentVersion: 1,
              migrationRequired: false,
              enabled: true,
              acceptPublicRequests: false,
              requesterMode: 'local-only',
              allowedPublisherIds,
              allowedAdapterIds,
              maxQueuedJobs: 64,
              maxConcurrentJobs: 4,
              maxConcurrentPerRequester: 4,
              maxRequestBytes: 64 * 1024,
              maxAcquireBytesPer24h: 107374182400,
              maxAcquireBytesPerSecond: 64 * 1024 * 1024,
              maxStagingBytes: 107374182400,
              minFreeDiskBytes: 1,
              maxJobRuntimeMs: 24 * 60 * 60 * 1000,
              sourceGrantTtlMs: 24 * 60 * 60 * 1000,
              publicRequestsPerMinute: 1,
              maxAttempts: 3,
              retryBaseMs: 1000,
              retryMaxMs: 60 * 1000
            },
            expectedRevision: current.revision,
            consent: true
          })
        }
      }
    }
    return ensuredPublisher
  }

  return {
    backend,
    ctx: backend.ctx,
    api: backend.api,
    provider: backend.provider || backend.ctx?.providerService || null,
    acquisitionManager: backend.acquisitionManager || backend.ctx?.acquisitionManager || null,
    issueLocalProviderResolution: backend.issueLocalProviderResolution || backend.ctx?.issueLocalProviderResolution || null,
    publisherShell,
    ensureLocalPublisher,
    localFileSourceGrants,
    storagePath,
    identityManager: backend.identityManager,
    uploadManager: backend.uploadManager,
    seedingManager: backend.seedingManager,
    seedPinClients: backend.seedPinClients,
    metadataBee: backend.ctx?.metaDb || null,
    async close () {
      let backendError = null
      try {
        await backend.destroy()
      } catch (error) {
        backendError = error
      } finally {
        try {
          await closeResources([localFileSourceGrants], backendError)
        } finally {
          scope.restore()
        }
      }
    }
  }
}
