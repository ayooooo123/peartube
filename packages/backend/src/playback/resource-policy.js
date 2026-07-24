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
      const allowed = state.userAllowsP2P !== false
      const unconstrained = state.metered !== true && state.thermalState !== 'serious' && state.thermalState !== 'critical'
      const powered = state.charging !== false
      return {
        localPlayback: true,
        peerDiscovery: allowed && foreground && unconstrained,
        upload: allowed && foreground && unconstrained && powered,
        cacheFill: allowed && foreground && unconstrained,
        archiving: allowed && foreground && unconstrained && powered,
      }
    },
  }
}
