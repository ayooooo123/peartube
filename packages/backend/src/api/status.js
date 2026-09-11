// Status API group, extracted from api.js.
import b4a from 'b4a'
import { getNetworkStats } from '../storage.js'
import { describeScopedTopic } from '../network/topics.js'
import { PROTOCOL_MAJOR } from '../network/version.js'

export function createStatusApi({ ctx, recentPlaybackTimings = [] }) {
  return {
    /**
     * Get backend status
     * @returns {Object}
     */
    getStatus() {
      return {
        connected: true,
        peers: ctx.swarm?.connections?.size || 0,
        blobServerPort: ctx.blobServer?.port || ctx.blobServerPort || 0,
        blobServerHost: ctx.blobServerHost || '127.0.0.1',
        version: '0.1.115'
      }
    },

    /**
     * Get swarm status for debugging
     * @returns {Object}
     */
    getSwarmStatus() {
      const swarm = ctx.swarm
      const networkDebug = getNetworkStats()
      const doctor = buildDoctor(ctx, networkDebug, recentPlaybackTimings)
      return {
        swarmConnections: swarm?.connections?.size || 0,
        swarmPeers: swarm?.peers?.size || 0,
        scopedTopics: resolveScopedTopics(ctx),
        network: networkDebug,
        startupTiming: {
          storage: networkDebug?.startupTiming || null,
        },
        doctor,
        swarmOffline: Boolean(swarm?._peartubeOffline),
        swarmOfflineReason: swarm?._peartubeOfflineReason || null,
        swarmListenResolved: Boolean(swarm?._peartubeListenResolved),
        peerPoolJoined: Boolean(ctx.peerPoolDiscovery),
        swarmPublicKey: resolveSwarmPublicKey(swarm),
        channelsLoaded: ctx.channels?.size || 0,
      }
    },
  }
}

function resolveScopedTopics(ctx) {
  const topics = ctx.scopedNetwork?.getDiagnostics?.().topics
  if (topics) return topics
  return [
    describeScopedTopic('bootstrap', {
      networkId: ctx.networkId || 'peartube-main',
      protocolMajor: PROTOCOL_MAJOR,
    }),
  ]
}

function resolveSwarmPublicKey(swarm) {
  const key = swarm?.keyPair?.publicKey
  if (key) {
    return b4a.toString(key, 'hex').slice(0, 32)
  }
  return 'unknown'
}

function buildDoctorDht(swarm) {
  const dht = swarm?.dht
  return {
    bootstrapped: dht?.bootstrapped ?? null,
    firewalled: dht?.firewalled ?? null,
    online: dht?.online ?? null,
    ephemeral: dht?.ephemeral ?? null,
  }
}

function buildDoctorDiscovery(ctx, hyperswarm) {
  const recentPeers = hyperswarm?.recentPeers || []
  return {
    peerPoolJoined: Boolean(ctx.peerPoolDiscovery),
    discoveredPeers: recentPeers.length,
    recentPeers,
  }
}

function buildDoctorSocket(swarm, hyperswarm) {
  return {
    swarmPeers: swarm?.peers?.size || 0,
    swarmConnections: swarm?.connections?.size || 0,
    connecting: Number(swarm?.connecting || 0),
    recentConnections: hyperswarm?.recentConnections || [],
    peerStates: hyperswarm?.peerStates || [],
  }
}

function buildDoctorPlayback(ctx, recentPlaybackTimings) {
  return {
    lastPreparePlayback: recentPlaybackTimings[recentPlaybackTimings.length - 1] || null,
    recentPreparePlayback: recentPlaybackTimings.slice(-5),
    transport: {
      mediaOrigin: 'peer-only',
      mediaLoopbackHost: ctx.blobServerHost || '127.0.0.1',
      mediaLoopbackPort: ctx.blobServer?.port || ctx.blobServerPort || 0,
      httpMediaFallback: false,
      controlPlanePurposes: ['manifest', 'artwork', 'diagnostics'],
    },
  }
}

function calculateRecommendedBoundary(discovery, dht, socket) {
  if (discovery.discoveredPeers === 0 && dht.bootstrapped === false) {
    return 'dht-bootstrap'
  }
  if (discovery.discoveredPeers > 0 && socket.swarmConnections === 0) {
    return 'transport-socket'
  }
  return 'content-playback-or-ui'
}

function buildDoctor(ctx, networkDebug, recentPlaybackTimings) {
  const hyperswarm = networkDebug?.hyperswarm
  const dht = buildDoctorDht(ctx.swarm)
  const discovery = buildDoctorDiscovery(ctx, hyperswarm)
  const socket = buildDoctorSocket(ctx.swarm, hyperswarm)
  const playback = buildDoctorPlayback(ctx, recentPlaybackTimings)
  const recommendedBoundary = calculateRecommendedBoundary(discovery, dht, socket)

  return {
    dht,
    discovery,
    socket,
    playback,
    recommendedBoundary,
  }
}
