function boundedInteger(value, name, fallback) {
  const next = value == null ? fallback : Number(value)
  if (!Number.isSafeInteger(next) || next < 0) throw new Error(`${name} must be a non-negative integer`)
  return next
}

export function createPlaybackResourcePolicy(options = {}) {
  const limits = {
    maxPeers: boundedInteger(options.maxPeers, 'maxPeers', 8),
    maxRequests: boundedInteger(options.maxRequests, 'maxRequests', 16),
    maxInFlightBytes: boundedInteger(options.maxInFlightBytes, 'maxInFlightBytes', 64 * 1024 * 1024),
    maxDiskBytes: boundedInteger(options.maxDiskBytes, 'maxDiskBytes', 512 * 1024 * 1024),
    deadlineMs: boundedInteger(options.deadlineMs, 'deadlineMs', 15000),
  }

  return {
    limits() {
      return { ...limits }
    },
    evaluate(state = {}) {
      const foreground = state.foreground !== false
      const discoveryAllowed = state.userAllowsP2P !== false
      const unconstrained = state.metered !== true && state.thermalState !== 'serious' && state.thermalState !== 'critical'
      const powered = state.charging !== false
      const contribute = state.permissions?.contribute === true &&
        state.migrationRequired !== true
      const archive = state.permissions?.archive === true &&
        state.migrationRequired !== true
      return {
        localPlayback: true,
        peerDiscovery: discoveryAllowed && foreground && unconstrained,
        upload: (contribute || archive) && foreground && unconstrained && powered,
        cacheFill: discoveryAllowed && foreground && unconstrained,
        contributionCache: contribute && foreground && unconstrained,
        archiving: archive && foreground && unconstrained && powered,
      }
    },
  }
}
