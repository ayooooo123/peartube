import { createIndexFederation } from './search/index-federation.js'
import { createScopedAssetAvailabilityProbe, createSourceVerifier } from './search/source-verifier.js'
import {
  searchIndexCandidatesForTransport,
  verifyIndexCandidateForTransport,
} from './search/candidate-contract.js'

function getBlobServerStatus(backend) {
  const ctx = backend?.ctx
  const port = Number(ctx?.blobServer?.port || ctx?.blobServerPort || 0) || 0
  const error = ctx?.blobServer?._peartubeListenError || ctx?.blobServerError || null
  return {
    blobServerPort: port > 0 ? port : null,
    blobServerReady: port > 0 && !error,
    blobServerError: error ? (error?.message || String(error)) : null
  }
}

function getBlobServerPort(backend) {
  return getBlobServerStatus(backend).blobServerPort || 0
}

function getIdentityCount(backend) {
  return backend?.identityManager?.getIdentities?.().length || 0
}

function safeJson(value) {
  if (value == null) return null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

export function createIndexVerificationRuntime({
  services,
  catalogRegistry,
  availabilityProbe,
  localIndexServiceId = null,
  localAvailabilityProbe = null,
  scopedNetwork,
  lifecycle,
  cache = new Map(),
  now = Date.now,
  limits = {},
} = {}) {
  const federation = createIndexFederation({ services, cache, limits, now })
  const networkProbe = availabilityProbe || createScopedAssetAvailabilityProbe({ scopedNetwork, now })
  if (localIndexServiceId !== null && (typeof localIndexServiceId !== 'string' || localIndexServiceId.length === 0)) {
    throw new TypeError('localIndexServiceId must be non-empty text')
  }
  if (localAvailabilityProbe !== null && typeof localAvailabilityProbe !== 'function') {
    throw new TypeError('localAvailabilityProbe must be a function')
  }
  const probe = localIndexServiceId !== null && localAvailabilityProbe !== null
    ? async request => {
        const local = request.sourceIndexers?.some(source => source?.indexerId === localIndexServiceId)
        if (local) {
          try {
            const available = await localAvailabilityProbe(request)
            if (available?.peers > 0) return available
          } catch (error) {
            if (request.signal?.aborted) throw error
          }
        }
        return networkProbe(request)
      }
    : networkProbe
  const verifier = createSourceVerifier({
    federation,
    catalogRegistry,
    availabilityProbe: probe,
    now,
    limits,
  })
  let closed = false
  const runtime = Object.freeze({
    searchIndexCandidates({ selector, limit, signal } = {}) {
      if (closed) {
        const error = new Error('Index verification runtime is closed')
        error.code = 'INDEX_VERIFICATION_CLOSED'
        throw error
      }
      return federation.search({ selector, ...(limit === undefined ? {} : { limit }), signal })
    },
    verifyIndexCandidate({ candidateRef, signal } = {}) {
      if (closed) {
        const error = new Error('Index verification runtime is closed')
        error.code = 'INDEX_VERIFICATION_CLOSED'
        throw error
      }
      return verifier.verifySelectedCandidate({ candidateRef, signal })
    },
    async close() {
      if (closed) return false
      closed = true
      await verifier.close()
      await federation.close()
      return true
    },
  })
  lifecycle?.ownResource?.('index verification runtime', runtime, 'close')
  return runtime
}

export function requireHostProtocolVersion(protocolVersion, callerName) {
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion <= 0) {
    throw new Error(`${callerName} requires protocolVersion from @peartube/host`)
  }

  return protocolVersion
}

export function buildSharedSystemHandlers(backend, options = {}) {
  const protocolVersion = requireHostProtocolVersion(
    options.protocolVersion,
    'buildSharedSystemHandlers'
  )

  return {
    async DesktopBootstrap(req) {
      const emptySnapshot = {
        generatedAt: Date.now(),
        sections: { home: [], subscriptions: [], library: [], studio: [], diagnostics: [] },
        stats: { homeCount: 0, subscriptionCount: 0, libraryCount: 0, channelCount: 0 },
        state: { subscriptionChannelKeys: [], identityChannelKeys: [], activeIdentityName: '', activeIdentityChannelKey: '', activeChannelPublished: false }
      }
      return {
        ...getBlobServerStatus(backend),
        protocolVersion,
        storagePath: req?.storagePath || '',
        snapshot: emptySnapshot
      }
    },
    async DesktopShutdown() {
      return { success: true }
    },
    async DesktopRefreshBrowse() {
      return {
        snapshot: {
          generatedAt: Date.now(),
          sections: { home: [], subscriptions: [], library: [], studio: [], diagnostics: [] },
          stats: { homeCount: 0, subscriptionCount: 0, libraryCount: 0, channelCount: 0 },
          state: { subscriptionChannelKeys: [], identityChannelKeys: [], activeIdentityName: '', activeIdentityChannelKey: '', activeChannelPublished: false }
        }
      }
    },
    async FfmpegDecodeAvailable() {
      return { available: false, error: 'Not supported on this platform' }
    },
    async GetStatus() {
      return {
        status: {
          ready: true,
          hasIdentity: getIdentityCount(backend) > 0,
          protocolVersion,
          ...getBlobServerStatus(backend)
        }
      }
    },
    async GetBlobServerPort() {
      return { port: getBlobServerPort(backend) }
    },
    async GetSwarmStatus() {
      const swarmStatus = backend?.api?.getSwarmStatus?.() || {}
      const swarmConnections = swarmStatus.swarmConnections ?? 0
      const peerCount = swarmStatus.peerCount ?? swarmConnections

      return {
        connected: (swarmConnections || peerCount) > 0,
        peerCount,
        swarmConnections,
        swarmPeers: swarmStatus.swarmPeers ?? 0,
        channelsLoaded: swarmStatus.channelsLoaded ?? 0,
        swarmOffline: Boolean(swarmStatus.swarmOffline),
        swarmOfflineReason: swarmStatus.swarmOfflineReason ?? null,
        swarmListenResolved: Boolean(swarmStatus.swarmListenResolved),
        peerPoolJoined: Boolean(swarmStatus.peerPoolJoined),
        networkJson: safeJson(swarmStatus.network),
        startupTimingJson: safeJson(swarmStatus.startupTiming),
        doctorJson: safeJson(swarmStatus.doctor),
        recommendedBoundary: swarmStatus.recommendedBoundary ?? swarmStatus.doctor?.recommendedBoundary ?? null,
        network: swarmStatus.network ?? null,
        startupTiming: swarmStatus.startupTiming ?? null,
        doctor: swarmStatus.doctor ?? null,
      }
    },
    async SearchIndexCandidates(request) {
      return searchIndexCandidatesForTransport(backend?.api, request)
    },
    async VerifyIndexCandidate(request) {
      return verifyIndexCandidateForTransport(backend?.api, request)
    },
  }
}

export async function attachSharedAppHandlers(options) {
  const {
    backend,
    api,
    identityManager,
    uploadManager,
    ctx,
    rpc,
    storagePath,
    protocolVersion,
    autoAttachSharedAppHandlers = false,
    loadSharedAppHandlers = () => import('./mobile-handlers.js')
  } = options

  if (!autoAttachSharedAppHandlers) return false

  const { attachMobileHandlers } = await loadSharedAppHandlers()
  if (typeof attachMobileHandlers !== 'function') return false

  attachMobileHandlers(backend, {
    api,
    protocolVersion,
    identityManager,
    uploadManager,
    ctx,
    initializeIdentityFromMnemonic:
      typeof backend?.initializeIdentityFromMnemonic === 'function'
        ? backend.initializeIdentityFromMnemonic.bind(backend)
        : async () => ({ needsRestart: false }),
    rpc,
    fs: null,
    path: null,
    storagePath,
    generateAndStoreThumbnail: async () => null,
    transcoder: {
      async startTranscode() {
        return { success: false, error: 'Transcoding is not wired in the embedded native host yet.' }
      },
      stopTranscode() {
        return { success: false, error: 'Transcoding is not wired in the embedded native host yet.' }
      },
      getStatus() {
        return { status: 'unavailable', progress: 0, bytesWritten: 0, error: 'Transcoding is not wired in the embedded native host yet.' }
      }
    }
  })

  return true
}

