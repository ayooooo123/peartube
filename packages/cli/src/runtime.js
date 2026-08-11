import b4a from 'b4a'

import { createBackendContext } from '@peartube/backend'
import { PROTOCOL_VERSION } from '@peartube/host/contracts'

const HEX_32 = /^[0-9a-f]{64}$/

function normalizeHexList (values = []) {
  if (!Array.isArray(values)) return []
  const seen = new Set()
  const normalized = []
  for (const value of values) {
    const hex = String(value || '').trim().toLowerCase()
    if (!HEX_32.test(hex) || seen.has(hex)) continue
    seen.add(hex)
    normalized.push(hex)
  }
  return normalized
}

function trustedSignerBytes (values) {
  return normalizeHexList(values).map((hex) => b4a.from(hex, 'hex'))
}

function roleCount (values, role) {
  if (!Array.isArray(values)) return 0
  return values.reduce((count, value) => count + (value?.role === role ? 1 : 0), 0)
}

function counter (counters, ...names) {
  for (const name of names) {
    const value = Number(counters?.[name])
    if (Number.isSafeInteger(value) && value >= 0) return value
  }
  return 0
}

export async function createRelayRuntime ({ config, logger, dependencies = null } = {}) {
  if (!config?.storage?.path) throw new Error('relay runtime requires config.storage.path')
  const backendFactory = dependencies?.createBackendContext || createBackendContext
  const networkConfig = config.network || {}
  const trustedBootstrapSigners = trustedSignerBytes(networkConfig.trustedBootstrapSigners)
  const trustedBootstrapRootIds = normalizeHexList(networkConfig.trustedBootstrapRootIds)
  const bootstrapEnabled = networkConfig.bootstrapEnabled !== false && config.discovery?.enabled !== false
  const maxBytes = Number.isSafeInteger(config.storage.maxBytes) && config.storage.maxBytes > 0
    ? config.storage.maxBytes
    : 0
  const maxConcurrent = Number.isSafeInteger(config.seedPin?.maxConcurrent) && config.seedPin.maxConcurrent > 0
    ? config.seedPin.maxConcurrent
    : 1

  const backend = await backendFactory({
    storagePath: config.storage.path,
    platform: 'relay',
    role: 'relay',
    expectedProtocolVersion: PROTOCOL_VERSION,
    network: {
      networkId: networkConfig.networkId || 'peartube-main',
      trustedBootstrapSigners,
      trustedBootstrapRootIds,
      bootstrapEnabled
    },
    resources: {
      profile: { maxBytesPerDay: maxBytes },
      maxConcurrentSync: maxConcurrent,
      maxConcurrentProofs: maxConcurrent,
      maxConcurrentFetches: maxConcurrent
    },
    seedPin: config.seedPin || {},
    operability: {
      operatorMode: config.mode || 'community'
    },
    ipcLog: (message) => logger?.runtime?.debug?.(message)
  })

  if (!backend?.ctx || !backend?.api || typeof backend.destroy !== 'function') {
    await backend?.destroy?.().catch(() => {})
    throw new Error('universal backend returned an incomplete relay context')
  }

  let closed = false
  let started = false
  const runtime = {
    backend,
    ctx: backend.ctx,
    api: backend.api,
    scopedNetwork: backend.scopedNetwork,
    seedingManager: backend.seedingManager,
    identityManager: backend.identityManager,
    uploadManager: backend.uploadManager,
    seedPin: backend.seedPin,
    seedPinClients: backend.seedPinClients,

    async start () {
      if (closed) throw new Error('relay runtime is closed')
      if (started) return
      started = true
      logger?.runtime?.info?.('Relay universal backend ready', {
        platform: 'relay',
        networkId: networkConfig.networkId || 'peartube-main'
      })
    },

    async followPublisher (request) {
      return backend.api.followPublisher(request)
    },

    async unfollowPublisher (request) {
      return backend.api.unfollowPublisher(request)
    },

    async publishPublisherCatalog (request) {
      return backend.api.publishLocalPublisherCatalog(request)
    },

    async resolvePublisherCatalog (request) {
      return backend.api.resolveLocalPublisherCatalog(request)
    },

    async publishBootstrapLocator (request) {
      return backend.api.publishBootstrapLocator(request)
    },

    async listBootstrapLocators () {
      return backend.api.listBootstrapLocators()
    },

    async retainRendition (request) {
      return backend.api.retainAuthorizedRendition(request)
    },

    async releaseRendition (request) {
      return backend.api.releaseAuthorizedRendition(request)
    },

    async retainArchive (request) {
      return backend.api.retainAuthorizedArchive(request)
    },

    async releaseArchive (request) {
      return backend.api.releaseAuthorizedArchive(request)
    },

    async refreshAuthorization (trustedClients) {
      if (typeof backend.api.refreshScopedAuthorization !== 'function') return false
      const result = await backend.api.refreshScopedAuthorization({
        trustedClients: normalizeHexList(trustedClients)
      })
      return result?.status === 'updated'
    },

    async requestCatalogSync () {
      const locators = await backend.api.listBootstrapLocators()
      return Array.isArray(locators) ? locators.length : 0
    },

    async resolveCandidate (candidate = {}) {
      const publisherId = candidate.publisherId || null
      if (!publisherId) return { ...candidate }
      const catalog = await backend.api.resolveLocalPublisherCatalog({ publisherId })
      return { ...candidate, publisherId, catalog }
    },

    setCandidateHandler () {
      // Candidate delivery belongs to the backend's scoped publisher manager.
      // Callers explicitly follow authenticated publishers through followPublisher.
    },

    async getDiagnostics () {
      const [scoped, locators, seedRetention, archive, storage, policyResult] = await Promise.all([
        backend.api.getScopedNetworkDiagnostics(),
        backend.api.listBootstrapLocators(),
        backend.seedingManager?.getStatus?.() || {},
        backend.api.getArchiveOperatorStatus?.({}) || {},
        backend.api.getStorageStats?.() || {},
        backend.api.getNetworkPolicy?.() || {}
      ])
      const counters = scoped?.counters || {}
      const swarm = backend.ctx?.swarm
      const publisherTopics = roleCount(scoped?.topics, 'publisher')
      const assetTopics = roleCount(scoped?.topics, 'asset')
      const policy = policyResult?.policy || {}
      return {
        policy: {
          policyVersion: Number(policy.policyVersion) || 0,
          consentVersion: Number(policy.consentVersion) || 0,
          migrationRequired: policy.migrationRequired !== false,
          effectiveRole: policy.effectiveRole || 'watch-only',
          permissions: {
            contribute: policy.permissions?.contribute === true,
            archive: policy.permissions?.archive === true
          },
          contributionBudgetBytes: Number(policy.contributionBudgetBytes) || 0,
          archiveBudgetBytes: Number(policy.archiveBudgetBytes) || 0,
          selectedIndexers: []
        },
        network: {
          status: scoped?.status || 'unknown',
          protocolMajor: scoped?.protocolMajor ?? PROTOCOL_VERSION,
          networkId: scoped?.networkId || networkConfig.networkId || 'peartube-main',
          peers: swarm?.peers?.size || 0,
          connections: swarm?.connections?.size || 0,
          dht: {
            bootstrapped: swarm?.dht?.bootstrapped ?? null,
            firewalled: swarm?.dht?.firewalled ?? null,
            online: swarm?.dht?.online ?? null
          },
          offline: Boolean(swarm?._peartubeOffline),
          offlineReason: swarm?._peartubeOfflineReason || null,
          listenResolved: Boolean(swarm?._peartubeListenResolved),
          lastErrors: Array.isArray(scoped?.recentErrors)
            ? scoped.recentErrors.slice(-8).map(error => String(error?.code || 'SCOPED_NETWORK_ERROR').slice(0, 64))
            : []
        },
        publisher: {
          catalogs: counter(counters, 'publisherCatalogs', 'catalogs') || publisherTopics,
          followed: counter(counters, 'publishersFollowed', 'followedPublishers'),
          lastErrorCode: scoped?.lastErrorCode || null
        },
        bootstrap: {
          joined: bootstrapEnabled && scoped?.status === 'ready',
          locators: Array.isArray(locators) ? locators.length : 0,
          rejected: counter(counters, 'locatorsRejected', 'bootstrapRejected'),
          maxLocators: counter(counters, 'maxLocators', 'bootstrapLimit')
        },
        assets: {
          retainedRenditions: counter(counters, 'retainedRenditions'),
          activeSessions: roleCount(scoped?.sessions, 'asset'),
          topics: assetTopics,
          activeUploads: Array.isArray(scoped?.sessions)
            ? scoped.sessions.reduce((total, session) => total + Number(session.assetResponseCount || 0), 0)
            : 0,
          uploadedBytes: Number(scoped?.policy?.uploadedBytes) || 0,
          maxSessions: counter(counters, 'maxAssetSessions', 'assetSessionLimit')
        },
        seedRetention: seedRetention || {},
        archive: archive || {},
        storage: storage || {}
      }
    },

    async getNetworkStats () {
      return this.getDiagnostics()
    },

    async close () {
      if (closed) return
      closed = true
      await backend.destroy()
    }
  }

  return runtime
}
