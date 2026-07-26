// Status API group, extracted from api.js.
import b4a from 'b4a'
import { getNetworkStats } from '../storage.js'
import { describeScopedTopic } from '../network/topics.js'

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
      const scopedTopics = ctx.scopedNetwork?.getDiagnostics?.().topics || [
        describeScopedTopic('bootstrap', { networkId: ctx.networkId || 'peartube-main', protocolMajor: 1 }),
      ]
      const networkDebug = getNetworkStats()
      const startupTiming = {
        storage: networkDebug?.startupTiming || null,
      }
      const doctor = {
        dht: {
          bootstrapped: ctx.swarm?.dht?.bootstrapped ?? null,
          firewalled: ctx.swarm?.dht?.firewalled ?? null,
          online: ctx.swarm?.dht?.online ?? null,
          ephemeral: ctx.swarm?.dht?.ephemeral ?? null,
        },
        discovery: {
          peerPoolJoined: Boolean(ctx.peerPoolDiscovery),
          discoveredPeers: networkDebug?.hyperswarm?.recentPeers?.length || 0,
          recentPeers: networkDebug?.hyperswarm?.recentPeers || [],
        },
        socket: {
          swarmPeers: ctx.swarm?.peers?.size || 0,
          swarmConnections: ctx.swarm?.connections?.size || 0,
          connecting: Number(ctx.swarm?.connecting || 0),
          recentConnections: networkDebug?.hyperswarm?.recentConnections || [],
          peerStates: networkDebug?.hyperswarm?.peerStates || [],
        },
        playback: {
          lastPreparePlayback: recentPlaybackTimings[recentPlaybackTimings.length - 1] || null,
          recentPreparePlayback: recentPlaybackTimings.slice(-5),
          // Strict P2P is a claim this device can be held to. Media bytes reach
          // the player only through the loopback blob server, which exposes
          // already-authorized Hypercore blocks and cannot fetch over HTTP;
          // everything allowed to leave the device is control plane.
          transport: {
            mediaOrigin: 'peer-only',
            mediaLoopbackHost: ctx.blobServerHost || '127.0.0.1',
            mediaLoopbackPort: ctx.blobServer?.port || ctx.blobServerPort || 0,
            httpMediaFallback: false,
            controlPlanePurposes: ['manifest', 'artwork', 'authentication', 'license', 'diagnostics'],
          },
        },
        recommendedBoundary: null,
      }
      if (doctor.discovery.discoveredPeers === 0 && doctor.dht.bootstrapped === false) doctor.recommendedBoundary = 'dht-bootstrap'
      else if (doctor.discovery.discoveredPeers > 0 && doctor.socket.swarmConnections === 0) doctor.recommendedBoundary = 'transport-socket'
      else doctor.recommendedBoundary = 'content-playback-or-ui'
      return {
        swarmConnections: ctx.swarm?.connections?.size || 0,
        swarmPeers: ctx.swarm?.peers?.size || 0,
        scopedTopics,
        network: networkDebug,
        startupTiming,
        doctor,
        swarmOffline: Boolean(ctx.swarm?._peartubeOffline),
        swarmOfflineReason: ctx.swarm?._peartubeOfflineReason || null,
        swarmListenResolved: Boolean(ctx.swarm?._peartubeListenResolved),
        peerPoolJoined: Boolean(ctx.peerPoolDiscovery),
        swarmPublicKey: ctx.swarm?.keyPair?.publicKey
          ? b4a.toString(ctx.swarm.keyPair.publicKey, 'hex').slice(0, 32)
          : 'unknown',
        channelsLoaded: ctx.channels?.size || 0,
      }
    },
  }
}
