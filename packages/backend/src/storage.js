let castActive = false

export async function shutdownBackend(ctx) {
  if (!ctx || ctx._isShutdown) return
  ctx._isShutdown = true
  await ctx.engineAdapter?.close?.().catch(() => {})
  await ctx.metaDb?.close?.().catch(() => {})
}

export async function initializeStorage({ storagePath } = {}) {
  return { storagePath, channels: new Map(), blobServerPort: 0, blobServerHost: '127.0.0.1' }
}

export async function loadChannel() { return null }
export async function createChannel() { throw new Error('Old Autobase channel creation removed; use @peartube/engine') }
export async function pairDevice() { return { success: false, error: 'Device pairing removed in engine v0' } }
export function deriveDeterministicChannelSeed() { return null }
export function retainSwarmDiscovery() { return null }
export async function suspendNetworking() {}
export async function resumeNetworking() {}
export function getNetworkStats() { return { peerCount: 0, swarmConnections: 0 } }
export function getNetworkStatsReadable() { return { connected: false, peerCount: 0 } }
export function getVideoUrlFromBlob() { throw new Error('Old Hyperblobs playback removed; use engine.getVideoUrl') }
export function setCastActive(active) { castActive = Boolean(active) }
export function isCastActive() { return castActive }
export async function prefetchVideoForCast() { return { success: true, skipped: true, reason: 'Engine-first backend does not prefetch through legacy storage' } }
