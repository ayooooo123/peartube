// Status API group, extracted from api.js.
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { getNetworkStats } from '../storage.js'
import { PROTOCOL_NAME } from '../types.js'
import { describeScopedTopic } from '../network/topics.js'

export function createStatusApi({ ctx, publicFeed, recentPlaybackTimings }) {
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
      const topicHex = b4a.toString(crypto.data(b4a.from(PROTOCOL_NAME, 'utf-8')), 'hex')
      const scopedTopics = [
        describeScopedTopic('bootstrap', { networkId: ctx.networkId || 'peartube-main', protocolMajor: 1 }),
      ]
      const networkDebug = getNetworkStats()
      const feedStats = publicFeed?.getStats?.() || {}
      // Report what the user can actually SEE. The raw entries map includes
      // hidden/filtered entries, so diagnostics (and the home screen's
      // discovery-state classifier) were fed counts that didn't match the
      // rendered feed.
      const visibleFeedEntries = (() => {
        try { return publicFeed?.getFeed?.()?.length ?? (publicFeed?.entries?.size || 0) } catch { return publicFeed?.entries?.size || 0 }
      })()
      const startupTiming = {
        storage: networkDebug?.startupTiming || null,
        publicFeed: feedStats.startupTiming || null,
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
            discoveredPeers: feedStats.directPeerDial?.discoveredPeers || 0,
          recentPeers: networkDebug?.hyperswarm?.recentPeers || [],
        },
        socket: {
          swarmPeers: ctx.swarm?.peers?.size || 0,
          swarmConnections: ctx.swarm?.connections?.size || 0,
          connecting: Number(ctx.swarm?.connecting || 0),
          recentConnections: networkDebug?.hyperswarm?.recentConnections || [],
          peerStates: networkDebug?.hyperswarm?.peerStates || [],
        },
        feed: {
          feedConnections: publicFeed?.feedConnections?.size || 0,
          feedEntries: visibleFeedEntries,
          directPeerDial: feedStats.directPeerDial || null,
          lastHaveFeed: feedStats.lastHaveFeed || null,
        },
        playback: {
          lastPreparePlayback: recentPlaybackTimings[recentPlaybackTimings.length - 1] || null,
          recentPreparePlayback: recentPlaybackTimings.slice(-5),
        },
        recommendedBoundary: null,
      }
      if (doctor.discovery.discoveredPeers === 0 && doctor.dht.bootstrapped === false) doctor.recommendedBoundary = 'dht-bootstrap'
      else if (doctor.discovery.discoveredPeers > 0 && doctor.socket.swarmConnections === 0) doctor.recommendedBoundary = 'transport-socket'
      else doctor.recommendedBoundary = 'content-playback-or-ui'
      return {
        swarmConnections: ctx.swarm?.connections?.size || 0,
        swarmPeers: ctx.swarm?.peers?.size || 0,
        feedConnections: publicFeed?.feedConnections?.size || 0,
        feedEntries: visibleFeedEntries,
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
        channelsLoaded: Math.max(ctx.channels?.size || 0, visibleFeedEntries),
      }
    },
  }
}
