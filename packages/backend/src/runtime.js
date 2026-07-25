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
    }
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
    autoAttachSharedAppHandlers = false,
    loadSharedAppHandlers = () => import('./mobile-handlers.js')
  } = options

  if (!autoAttachSharedAppHandlers) return false

  const { attachMobileHandlers } = await loadSharedAppHandlers()
  if (typeof attachMobileHandlers !== 'function') return false

  attachMobileHandlers(backend, {
    api,
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

