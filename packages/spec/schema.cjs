/* eslint-disable no-empty, @typescript-eslint/no-require-imports */
/**
 * PearTube HRPC Schema Definition
 *
 * Run with: node schema.js
 * Generates spec/schema and spec/hrpc directories
 */

const Hyperschema = require('hyperschema')
const HRPCBuilder = require('hrpc')

const SCHEMA_DIR = './spec/schema'
const HRPC_DIR = './spec/hrpc'

// Initialize schema
const schema = Hyperschema.from(SCHEMA_DIR)
const ns = schema.namespace('peartube')

// ============================================
// Common Types
// ============================================

ns.register({
  name: 'empty',
  fields: []
})

ns.register({
  name: 'error',
  fields: [
    { name: 'code', type: 'uint', required: false },
    { name: 'message', type: 'string', required: true }
  ]
})

ns.register({
  name: 'peer-performance-metric',
  fields: [
    { name: 'peerId', type: 'string', required: true },
    { name: 'latencyMs', type: 'uint', required: false },
    { name: 'handshakeDurationMs', type: 'uint', required: false },
    { name: 'socketStability', type: 'uint', required: false },
    { name: 'socketStabilityObserved', type: 'bool', required: false },
    { name: 'handshakeSuccesses', type: 'uint', required: false },
    { name: 'handshakeFailures', type: 'uint', required: false },
    { name: 'handshakes', type: 'uint', required: false },
    { name: 'udxThroughputBps', type: 'uint', required: false },
    { name: 'observedAt', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'resource-budget-state',
  fields: [
    { name: 'role', type: 'string', required: true },
    { name: 'memoryPressure', type: 'uint', required: false },
    { name: 'cpuPressure', type: 'uint', required: false },
    { name: 'maxFanout', type: 'uint', required: false },
    { name: 'maxRequestsPerWindow', type: 'uint', required: false },
    { name: 'maxFeedEntries', type: 'uint', required: false },
    { name: 'maxConcurrentSync', type: 'uint', required: false },
    { name: 'maxConcurrentProofs', type: 'uint', required: false },
    { name: 'maxConcurrentFetches', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'resource-allocation-state',
  fields: [
    { name: 'feedIndexers', type: 'uint', required: false },
    { name: 'autobaseLinearizationBuffers', type: 'uint', required: false },
    { name: 'activeSwarmConnections', type: 'uint', required: false },
    { name: 'maxConcurrentSync', type: 'uint', required: false },
    { name: 'maxConcurrentProofs', type: 'uint', required: false },
    { name: 'maxConcurrentFetches', type: 'uint', required: false },
    { name: 'memoryPressure', type: 'uint', required: false },
    { name: 'cpuPressure', type: 'uint', required: false }
  ]
})

// ============================================
// Identity Types
// ============================================

ns.register({
  name: 'identity',
  fields: [
    { name: 'publicKey', type: 'string', required: true },
    { name: 'driveKey', type: 'string', required: false },
    { name: 'name', type: 'string', required: false },
    { name: 'avatar', type: 'string', required: false },
    { name: 'seedPhrase', type: 'string', required: false },
    { name: 'createdAt', type: 'uint', required: false },
    { name: 'isActive', type: 'bool', required: false }
  ]
})

ns.register({
  name: 'create-identity-request',
  fields: [
    { name: 'name', type: 'string', required: false },
    { name: 'avatar', type: 'string', required: false }
  ]
})

ns.register({
  name: 'create-identity-response',
  fields: [
    { name: 'identity', type: '@peartube/identity', required: true }
  ]
})

ns.register({
  name: 'get-identity-request',
  fields: []
})

ns.register({
  name: 'get-identity-response',
  fields: [
    { name: 'identity', type: '@peartube/identity', required: false }
  ]
})

ns.register({
  name: 'get-identities-request',
  fields: []
})

ns.register({
  name: 'get-identities-response',
  fields: [
    { name: 'identities', type: '@peartube/identity', array: true }
  ]
})

ns.register({
  name: 'set-active-identity-request',
  fields: [
    { name: 'publicKey', type: 'string', required: true }
  ]
})

ns.register({
  name: 'set-active-identity-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'recover-identity-request',
  fields: [
    { name: 'seedPhrase', type: 'string', required: true },
    { name: 'name', type: 'string', required: false }
  ]
})

ns.register({
  name: 'recover-identity-response',
  fields: [
    { name: 'identity', type: '@peartube/identity', required: true }
  ]
})

// ============================================
// Device Attestation Types
// ============================================

ns.register({
  name: 'bootstrap-device-request',
  fields: [
    { name: 'mnemonic', type: 'string', required: true }
  ]
})

ns.register({
  name: 'bootstrap-device-response',
  fields: [
    { name: 'proof', type: 'buffer', required: true },
    { name: 'identityPublicKey', type: 'string', required: true }
  ]
})

ns.register({
  name: 'attest-device-request',
  fields: [
    { name: 'proof', type: 'buffer', required: true },
    { name: 'devicePublicKey', type: 'buffer', required: true }
  ]
})

ns.register({
  name: 'attest-device-response',
  fields: [
    { name: 'proof', type: 'buffer', required: true }
  ]
})

ns.register({
  name: 'verify-attestation-request',
  fields: [
    { name: 'proof', type: 'buffer', required: true }
  ]
})

ns.register({
  name: 'verify-attestation-response',
  fields: [
    { name: 'valid', type: 'bool', required: true },
    { name: 'identityPublicKey', type: 'string', required: true },
    { name: 'devicePublicKey', type: 'string', required: true }
  ]
})

// ============================================
// Channel Types
// ============================================

ns.register({
  name: 'channel',
  fields: [
    { name: 'publicKey', type: 'string', required: true },
    { name: 'name', type: 'string', required: false },
    { name: 'description', type: 'string', required: false },
    { name: 'avatar', type: 'string', required: false },
    { name: 'videoCount', type: 'uint', required: false },
    { name: 'subscriberCount', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'get-channel-request',
  fields: [
    { name: 'publicKey', type: 'string', required: false }
  ]
})

ns.register({
  name: 'get-channel-response',
  fields: [
    { name: 'channel', type: '@peartube/channel', required: false }
  ]
})

ns.register({
  name: 'update-channel-request',
  fields: [
    { name: 'name', type: 'string', required: false },
    { name: 'description', type: 'string', required: false },
    { name: 'avatar', type: 'string', required: false }
  ]
})

ns.register({
  name: 'update-channel-response',
  fields: [
    { name: 'channel', type: '@peartube/channel', required: true }
  ]
})

// ============================================
// Video Types
// ============================================

ns.register({
  name: 'video',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'title', type: 'string', required: true },
    { name: 'description', type: 'string', required: false },
    { name: 'path', type: 'string', required: false },
    { name: 'duration', type: 'uint', required: false },
    { name: 'thumbnail', type: 'string', required: false },
    { name: 'channelKey', type: 'string', required: false },
    { name: 'channelName', type: 'string', required: false },
    { name: 'createdAt', type: 'uint', required: false },
    { name: 'views', type: 'uint', required: false },
    { name: 'category', type: 'string', required: false },
    { name: 'blobId', type: 'string', required: false },
    { name: 'blobsCoreKey', type: 'string', required: false },
    { name: 'mimeType', type: 'string', required: false },
    { name: 'availability', type: 'string', required: false },
    { name: 'thumbnailBlobId', type: 'string', required: false },
    { name: 'thumbnailBlobsCoreKey', type: 'string', required: false },
    { name: 'thumbnailMimeType', type: 'string', required: false },
    { name: 'publicBeeKey', type: 'string', required: false },
    { name: 'byteAvailability', type: 'string', required: false },
    { name: 'hasHeadBlock', type: 'bool', required: false },
    { name: 'contiguousBlocks', type: 'uint', required: false },
    { name: 'readyForPlayback', type: 'bool', required: false },
  ]
})

ns.register({
  name: 'list-videos-request',
  fields: [
    { name: 'channelKey', type: 'string', required: false },
    { name: 'publicBeeKey', type: 'string', required: false },
    { name: 'limit', type: 'uint', required: false },
    { name: 'offset', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'list-videos-response',
  fields: [
    { name: 'videos', type: '@peartube/video', array: true }
  ]
})

ns.register({
  name: 'get-video-url-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'publicBeeKey', type: 'string', required: false },
    { name: 'blobId', type: 'string', required: false },
    { name: 'blobsCoreKey', type: 'string', required: false },
    { name: 'mimeType', type: 'string', required: false }
  ]
})

ns.register({
  name: 'get-video-url-response',
  fields: [
    { name: 'url', type: 'string', required: true }
  ]
})

ns.register({
  name: 'prepare-playback-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'publicBeeKey', type: 'string', required: false },
    { name: 'blobId', type: 'string', required: false },
    { name: 'blobsCoreKey', type: 'string', required: false },
    { name: 'mimeType', type: 'string', required: false }
  ]
})

ns.register({
  name: 'selected-blob-warmup',
  fields: [
    { name: 'blobsCoreKey', type: 'string', required: false },
    { name: 'blobId', type: 'string', required: false },
    { name: 'peerCount', type: 'uint', required: false },
    { name: 'hasHeadBlock', type: 'bool', required: false },
    { name: 'contiguousBlocks', type: 'uint', required: false },
    { name: 'readyForPlayback', type: 'bool', required: false },
    { name: 'blobPeerIdsJson', type: 'string', required: false },
    { name: 'sourceFeedPeerIdsJson', type: 'string', required: false },
    { name: 'sourceRelayPeerIdsJson', type: 'string', required: false },
    { name: 'retainedDiscoveryLabel', type: 'string', required: false },
    { name: 'retainedDiscoveryStatus', type: 'string', required: false },
    { name: 'feedRelayAlsoBlobPeer', type: 'bool', required: false },
    { name: 'promotedPeerHintsJson', type: 'string', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'peer-warmup',
  fields: [
    { name: 'peerCount', type: 'uint', required: false },
    { name: 'retained', type: 'bool', required: false },
    { name: 'timedOut', type: 'bool', required: false },
    { name: 'elapsedMs', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'prepare-playback-response',
  fields: [
    { name: 'url', type: 'string', required: false },
    { name: 'stats', type: '@peartube/video-stats', required: false },
    { name: 'warmupStarted', type: 'bool', required: true },
    { name: 'peerWarmupStarted', type: 'bool', required: false },
    { name: 'selectedBlobWarmup', type: '@peartube/selected-blob-warmup', required: false },
    { name: 'peerWarmup', type: '@peartube/peer-warmup', required: false }
  ]
})

ns.register({
  name: 'web-prepare-playback-response',
  fields: [
    { name: 'url', type: 'string', required: true },
    { name: 'transcoded', type: 'bool', required: false },
    { name: 'audioCodec', type: 'string', required: false },
    { name: 'videoCodec', type: 'string', required: false },
    { name: 'transcodeError', type: 'string', required: false },
    { name: 'stats', type: '@peartube/video-stats', required: false },
    { name: 'warmupStarted', type: 'bool', required: false },
    { name: 'peerWarmupStarted', type: 'bool', required: false },
    { name: 'selectedBlobWarmup', type: '@peartube/selected-blob-warmup', required: false },
    { name: 'peerWarmup', type: '@peartube/peer-warmup', required: false }
  ]
})

ns.register({
  name: 'get-video-data-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'publicBeeKey', type: 'string', required: false }
  ]
})

ns.register({
  name: 'get-video-data-response',
  fields: [
    { name: 'video', type: '@peartube/video', required: true }
  ]
})

ns.register({
  name: 'upload-video-request',
  fields: [
    { name: 'filePath', type: 'string', required: true },
    { name: 'title', type: 'string', required: true },
    { name: 'description', type: 'string', required: false },
    { name: 'category', type: 'string', required: false },
    { name: 'skipThumbnailGeneration', type: 'bool', required: false }
  ]
})

ns.register({
  name: 'upload-video-response',
  fields: [
    { name: 'video', type: '@peartube/video', required: true }
  ]
})

ns.register({
  name: 'download-video-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'destPath', type: 'string', required: true },
    { name: 'publicBeeKey', type: 'string', required: false }
  ]
})

ns.register({
  name: 'download-video-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'filePath', type: 'string', required: false },
    { name: 'size', type: 'uint', required: false },
    { name: 'error', type: 'string', required: false },
    { name: 'data', type: 'string', required: false }
  ]
})

ns.register({
  name: 'delete-video-request',
  fields: [
    { name: 'videoId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'delete-video-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

// Livestreaming structs
ns.register({
  name: 'start-livestream-request',
  fields: [
    { name: 'channelKey', type: 'string', required: false },
    { name: 'title', type: 'string', required: false },
    { name: 'targetFragmentDurationMs', type: 'uint', required: false },
    { name: 'width', type: 'uint', required: false },
    { name: 'height', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'start-livestream-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'videoId', type: 'string', required: false },
    { name: 'liveCoreKey', type: 'string', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'stop-livestream-request',
  fields: [
    { name: 'videoId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'livestream-status',
  fields: [
    { name: 'state', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: false },
    { name: 'liveCoreKey', type: 'string', required: false },
    { name: 'mediaBlocks', type: 'uint', required: false },
    { name: 'durationMs', type: 'uint', required: false },
    { name: 'peerCount', type: 'uint', required: false },
    { name: 'startedAt', type: 'uint', required: false },
    { name: 'endedAt', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'stop-livestream-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'status', type: '@peartube/livestream-status', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'get-livestream-status-request',
  fields: [
    { name: 'videoId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'get-livestream-status-response',
  fields: [
    { name: 'status', type: '@peartube/livestream-status', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'prepare-live-playback-request',
  fields: [
    { name: 'liveCoreKey', type: 'string', required: true }
  ]
})

ns.register({
  name: 'prepare-live-playback-response',
  fields: [
    { name: 'url', type: 'string', required: false },
    { name: 'isLive', type: 'bool', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'update-video-metadata-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'title', type: 'string', required: false },
    { name: 'description', type: 'string', required: false },
    { name: 'category', type: 'string', required: false }
  ]
})

ns.register({
  name: 'update-video-metadata-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

// ============================================
// Subscription Types
// ============================================

ns.register({
  name: 'subscription',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'channelName', type: 'string', required: false },
    { name: 'avatar', type: 'string', required: false },
    { name: 'subscribedAt', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'subscribe-channel-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true }
  ]
})

ns.register({
  name: 'subscribe-channel-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'unsubscribe-channel-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true }
  ]
})

ns.register({
  name: 'unsubscribe-channel-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'get-subscriptions-request',
  fields: []
})

ns.register({
  name: 'get-subscriptions-response',
  fields: [
    { name: 'subscriptions', type: '@peartube/subscription', array: true }
  ]
})

// ============================================
// Personal Sync Types (playlists / history / settings)
// Private per-identity multi-writer store, synced across the user's devices.
// ============================================

ns.register({
  name: 'playlist',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'name', type: 'string', required: false },
    { name: 'description', type: 'string', required: false },
    { name: 'createdAt', type: 'uint', required: false },
    { name: 'updatedAt', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'playlist-item',
  fields: [
    { name: 'playlistId', type: 'string', required: true },
    { name: 'videoKey', type: 'string', required: true },
    { name: 'channelKey', type: 'string', required: false },
    { name: 'videoId', type: 'string', required: false },
    { name: 'addedAt', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'history-entry',
  fields: [
    { name: 'eventId', type: 'string', required: false },
    { name: 'channelKey', type: 'string', required: false },
    { name: 'videoId', type: 'string', required: false },
    { name: 'videoKey', type: 'string', required: false },
    { name: 'title', type: 'string', required: false },
    { name: 'duration', type: 'uint', required: false },
    { name: 'position', type: 'uint', required: false },
    { name: 'completed', type: 'bool', required: false },
    { name: 'timestamp', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'resume-entry',
  fields: [
    { name: 'videoKey', type: 'string', required: true },
    { name: 'channelKey', type: 'string', required: false },
    { name: 'videoId', type: 'string', required: false },
    { name: 'position', type: 'uint', required: false },
    { name: 'duration', type: 'uint', required: false },
    { name: 'completed', type: 'bool', required: false },
    { name: 'updatedAt', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'personal-setting',
  fields: [
    { name: 'key', type: 'string', required: true },
    // JSON-encoded value so the setting can hold strings, numbers, or bools.
    { name: 'value', type: 'string', required: false }
  ]
})

ns.register({
  name: 'get-playlists-request',
  fields: []
})

ns.register({
  name: 'get-playlists-response',
  fields: [
    { name: 'playlists', type: '@peartube/playlist', array: true }
  ]
})

ns.register({
  name: 'get-playlist-items-request',
  fields: [
    { name: 'playlistId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'get-playlist-items-response',
  fields: [
    { name: 'items', type: '@peartube/playlist-item', array: true }
  ]
})

ns.register({
  name: 'create-playlist-request',
  fields: [
    { name: 'name', type: 'string', required: false },
    { name: 'description', type: 'string', required: false }
  ]
})

ns.register({
  name: 'create-playlist-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'id', type: 'string', required: false }
  ]
})

ns.register({
  name: 'update-playlist-request',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'name', type: 'string', required: false },
    { name: 'description', type: 'string', required: false }
  ]
})

ns.register({
  name: 'update-playlist-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'delete-playlist-request',
  fields: [
    { name: 'id', type: 'string', required: true }
  ]
})

ns.register({
  name: 'delete-playlist-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'add-to-playlist-request',
  fields: [
    { name: 'playlistId', type: 'string', required: true },
    { name: 'channelKey', type: 'string', required: false },
    { name: 'videoId', type: 'string', required: false },
    { name: 'videoKey', type: 'string', required: false }
  ]
})

ns.register({
  name: 'add-to-playlist-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'remove-from-playlist-request',
  fields: [
    { name: 'playlistId', type: 'string', required: true },
    { name: 'videoKey', type: 'string', required: true }
  ]
})

ns.register({
  name: 'remove-from-playlist-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'log-watch-history-request',
  fields: [
    { name: 'channelKey', type: 'string', required: false },
    { name: 'videoId', type: 'string', required: false },
    { name: 'videoKey', type: 'string', required: false },
    { name: 'title', type: 'string', required: false },
    { name: 'duration', type: 'uint', required: false },
    { name: 'position', type: 'uint', required: false },
    { name: 'completed', type: 'bool', required: false },
    { name: 'timestamp', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'log-watch-history-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'eventId', type: 'string', required: false }
  ]
})

ns.register({
  name: 'get-watch-history-request',
  fields: [
    { name: 'limit', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'get-watch-history-response',
  fields: [
    { name: 'entries', type: '@peartube/history-entry', array: true }
  ]
})

ns.register({
  name: 'get-resume-position-request',
  fields: [
    { name: 'videoKey', type: 'string', required: true }
  ]
})

ns.register({
  name: 'get-resume-position-response',
  fields: [
    { name: 'found', type: 'bool', required: true },
    { name: 'resume', type: '@peartube/resume-entry', required: false }
  ]
})

ns.register({
  name: 'list-resume-positions-request',
  fields: []
})

ns.register({
  name: 'list-resume-positions-response',
  fields: [
    { name: 'entries', type: '@peartube/resume-entry', array: true }
  ]
})

ns.register({
  name: 'set-personal-setting-request',
  fields: [
    { name: 'key', type: 'string', required: true },
    { name: 'value', type: 'string', required: false }
  ]
})

ns.register({
  name: 'set-personal-setting-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'get-personal-settings-request',
  fields: []
})

ns.register({
  name: 'get-personal-settings-response',
  fields: [
    { name: 'settings', type: '@peartube/personal-setting', array: true }
  ]
})

ns.register({
  name: 'provision-personal-encryption-request',
  fields: [
    // 32-byte secret (hex) from the device keychain; omit to have one generated.
    { name: 'secret', type: 'string', required: false }
  ]
})

ns.register({
  name: 'provision-personal-encryption-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'secret', type: 'string', required: false },
    { name: 'encrypted', type: 'bool', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'join-channel-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true }
  ]
})

ns.register({
  name: 'join-channel-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

// ============================================
// Public Feed Types
// ============================================

ns.register({
  name: 'feed-entry-preview-video',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'title', type: 'string', required: false },
    { name: 'duration', type: 'uint', required: false },
    { name: 'thumbnail', type: 'string', required: false },
    { name: 'path', type: 'string', required: false },
    { name: 'blobId', type: 'string', required: false },
    { name: 'blobsCoreKey', type: 'string', required: false },
    { name: 'mimeType', type: 'string', required: false },
    { name: 'uploadedAt', type: 'uint', required: false },
    { name: 'width', type: 'uint', required: false },
    { name: 'height', type: 'uint', required: false },
    { name: 'thumbnailBlobId', type: 'string', required: false },
    { name: 'thumbnailBlobsCoreKey', type: 'string', required: false },
    { name: 'thumbnailMimeType', type: 'string', required: false },
    { name: 'availability', type: 'string', required: false },
    { name: 'description', type: 'string', required: false },
    { name: 'thumbnailUrl', type: 'string', required: false },
    { name: 'byteAvailability', type: 'string', required: false },
    { name: 'channelKey', type: 'string', required: false },
    { name: 'driveKey', type: 'string', required: false },
    { name: 'publicBeeKey', type: 'string', required: false },
    { name: 'hasHeadBlock', type: 'bool', required: false },
    { name: 'contiguousBlocks', type: 'uint', required: false },
    { name: 'readyForPlayback', type: 'bool', required: false },
  ]
})

ns.register({
  name: 'feed-live-stream',
  fields: [
    { name: 'videoId', type: 'string', required: true },
    { name: 'liveCoreKey', type: 'string', required: true },
    { name: 'title', type: 'string', required: false },
    { name: 'startedAt', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'feed-entry',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'publicBeeKey', type: 'string', required: false },
    { name: 'channelName', type: 'string', required: false },
    { name: 'videoCount', type: 'uint', required: false },
    { name: 'peerCount', type: 'uint', required: false },
    { name: 'lastSeen', type: 'uint', required: false },
    { name: 'source', type: 'string', required: false },
    { name: 'manifestUpdatedAt', type: 'uint', required: false },
    { name: 'previewVideos', type: '@peartube/feed-entry-preview-video', array: true },
    { name: 'driveKey', type: 'string', required: false },
    { name: 'relayRole', type: 'string', required: false },
    { name: 'relayServing', type: 'bool', required: false },
    { name: 'previewVideosHash', type: 'string', required: false },
    { name: 'isLive', type: 'bool', required: false },
    { name: 'liveStreams', type: '@peartube/feed-live-stream', array: true }
  ]
})

ns.register({
  name: 'get-public-feed-request',
  fields: [
    { name: 'limit', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'get-public-feed-response',
  fields: [
    { name: 'entries', type: '@peartube/feed-entry', array: true }
  ]
})

ns.register({
  name: 'get-canonical-feed-request',
  fields: [
    { name: 'limit', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'get-canonical-feed-response',
  fields: [
    { name: 'version', type: 'uint', required: false },
    { name: 'savedAt', type: 'uint', required: false },
    { name: 'identityDriveKey', type: 'string', required: false },
    { name: 'entries', type: '@peartube/feed-entry', array: true },
    { name: 'videos', type: '@peartube/feed-entry-preview-video', array: true }
  ]
})

ns.register({
  name: 'refresh-feed-request',
  fields: []
})

ns.register({
  name: 'refresh-feed-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'submit-to-feed-request',
  fields: []
})

ns.register({
  name: 'submit-to-feed-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'unpublish-from-feed-request',
  fields: []
})

ns.register({
  name: 'unpublish-from-feed-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'is-channel-published-request',
  fields: []
})

ns.register({
  name: 'is-channel-published-response',
  fields: [
    { name: 'published', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'hide-channel-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true }
  ]
})

ns.register({
  name: 'hide-channel-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'get-channel-meta-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'publicBeeKey', type: 'string', required: false }
  ]
})

ns.register({
  name: 'get-channel-meta-response',
  fields: [
    { name: 'name', type: 'string', required: false },
    { name: 'description', type: 'string', required: false },
    { name: 'videoCount', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'get-swarm-status-request',
  fields: []
})

ns.register({
  name: 'get-swarm-status-response',
  fields: [
    { name: 'connected', type: 'bool', required: true },
    { name: 'peerCount', type: 'uint', required: false },
    { name: 'swarmConnections', type: 'uint', required: false },
    { name: 'swarmPeers', type: 'uint', required: false },
    { name: 'feedConnections', type: 'uint', required: false },
    { name: 'feedEntries', type: 'uint', required: false },
    { name: 'channelsLoaded', type: 'uint', required: false },
    { name: 'swarmOffline', type: 'bool', required: false },
    { name: 'swarmOfflineReason', type: 'string', required: false },
    { name: 'swarmListenResolved', type: 'bool', required: false },
    { name: 'peerPoolJoined', type: 'bool', required: false },
    { name: 'publicFeedDiscoveryJoined', type: 'bool', required: false },
    { name: 'feedTopicHex', type: 'string', required: false },
    { name: 'networkJson', type: 'string', required: false },
    { name: 'startupTimingJson', type: 'string', required: false },
    { name: 'doctorJson', type: 'string', required: false },
    { name: 'directPeerDialJson', type: 'string', required: false },
    { name: 'recommendedBoundary', type: 'string', required: false }
  ]
})

// ============================================
// Video Prefetch & Stats Types
// ============================================

ns.register({
  name: 'prefetch-video-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'publicBeeKey', type: 'string', required: false }
  ]
})

ns.register({
  name: 'prefetch-video-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'video-stats',
  fields: [
    { name: 'videoId', type: 'string', required: false },
    { name: 'channelKey', type: 'string', required: false },
    { name: 'status', type: 'string', required: false },
    { name: 'progress', type: 'uint', required: false },
    { name: 'totalBlocks', type: 'uint', required: false },
    { name: 'downloadedBlocks', type: 'uint', required: false },
    { name: 'totalBytes', type: 'uint', required: false },
    { name: 'downloadedBytes', type: 'uint', required: false },
    { name: 'peerCount', type: 'uint', required: false },
    { name: 'blobCoreKey', type: 'string', required: false },
    { name: 'blobPeerIdsJson', type: 'string', required: false },
    { name: 'blobPeersJson', type: 'string', required: false },
    { name: 'speedMBps', type: 'string', required: false },
    { name: 'uploadSpeedMBps', type: 'string', required: false },
    { name: 'elapsed', type: 'uint', required: false },
    { name: 'isComplete', type: 'bool', required: false }
  ]
})

ns.register({
  name: 'get-video-stats-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'get-video-stats-response',
  fields: [
    { name: 'stats', type: '@peartube/video-stats', required: false }
  ]
})

// ============================================
// Seeding Types
// ============================================

ns.register({
  name: 'seeding-config',
  fields: [
    { name: 'enabled', type: 'bool', required: false },
    { name: 'maxStorage', type: 'uint', required: false },
    { name: 'maxBandwidth', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'seeding-status',
  fields: [
    { name: 'enabled', type: 'bool', required: true },
    { name: 'usedStorage', type: 'uint', required: false },
    { name: 'maxStorage', type: 'uint', required: false },
    { name: 'seedingCount', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'get-seeding-status-request',
  fields: []
})

ns.register({
  name: 'get-seeding-status-response',
  fields: [
    { name: 'status', type: '@peartube/seeding-status', required: true }
  ]
})

ns.register({
  name: 'set-seeding-config-request',
  fields: [
    { name: 'config', type: '@peartube/seeding-config', required: true }
  ]
})

ns.register({
  name: 'set-seeding-config-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

// ============================================
// Transcode Settings
// ============================================

ns.register({
  name: 'transcode-settings',
  fields: [
    { name: 'videoToolboxDecodeEnabled', type: 'bool', required: true },
    { name: 'videoToolboxDecodeLocked', type: 'bool', required: false },
    { name: 'videoToolboxDecodeDefault', type: 'bool', required: false },
    { name: 'videoToolboxDecodeSource', type: 'string', required: false }
  ]
})

ns.register({
  name: 'get-transcode-settings-request',
  fields: []
})

ns.register({
  name: 'get-transcode-settings-response',
  fields: [
    { name: 'settings', type: '@peartube/transcode-settings', required: true }
  ]
})

ns.register({
  name: 'set-transcode-settings-request',
  fields: [
    { name: 'videoToolboxDecodeEnabled', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'set-transcode-settings-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'settings', type: '@peartube/transcode-settings', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'pin-channel-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true }
  ]
})

ns.register({
  name: 'pin-channel-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'unpin-channel-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true }
  ]
})

ns.register({
  name: 'unpin-channel-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'get-pinned-channels-request',
  fields: []
})

ns.register({
  name: 'get-pinned-channels-response',
  fields: [
    { name: 'channels', type: 'string', array: true }
  ]
})

// ============================================
// Storage Management Types
// ============================================

ns.register({
  name: 'get-storage-stats-request',
  fields: []
})

ns.register({
  name: 'get-storage-stats-response',
  fields: [
    { name: 'usedBytes', type: 'uint', required: true },
    { name: 'maxBytes', type: 'uint', required: true },
    { name: 'usedGB', type: 'string', required: true },
    { name: 'maxGB', type: 'uint', required: true },
    { name: 'seedCount', type: 'uint', required: true },
    { name: 'pinnedCount', type: 'uint', required: true },
    { name: 'totalStorageBytes', type: 'uint', required: false },
    { name: 'totalStorageGB', type: 'string', required: false },
    { name: 'untrackedStorageBytes', type: 'uint', required: false },
    { name: 'untrackedStorageGB', type: 'string', required: false }
  ]
})

ns.register({
  name: 'set-storage-limit-request',
  fields: [
    { name: 'maxGB', type: 'uint', required: true }
  ]
})

ns.register({
  name: 'set-storage-limit-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'relay-link',
  fields: [
    { name: 'mirrorKey', type: 'string', required: true },
    { name: 'label', type: 'string', required: false },
    { name: 'addedAt', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'add-relay-link-request',
  fields: [
    { name: 'mirrorKey', type: 'string', required: true },
    { name: 'label', type: 'string', required: false }
  ]
})

ns.register({
  name: 'add-relay-link-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'mirrorKey', type: 'string', required: false },
    { name: 'label', type: 'string', required: false }
  ]
})

ns.register({
  name: 'remove-relay-link-request',
  fields: [
    { name: 'mirrorKey', type: 'string', required: true }
  ]
})

ns.register({
  name: 'remove-relay-link-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'get-relay-links-request',
  fields: []
})

ns.register({
  name: 'get-relay-links-response',
  fields: [
    { name: 'links', type: '@peartube/relay-link', array: true }
  ]
})

ns.register({
  name: 'clear-cache-request',
  fields: []
})

ns.register({
  name: 'clear-cache-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'clearedBytes', type: 'uint', required: false }
  ]
})

// Upload offload: free a local upload's bytes once a full copy is seeded elsewhere
ns.register({
  name: 'assess-upload-offload-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'assess-upload-offload-response',
  fields: [
    { name: 'eligible', type: 'bool', required: true },
    { name: 'fullCopyPeers', type: 'uint', required: false },
    { name: 'relayHasFullCopy', type: 'bool', required: false },
    { name: 'ownDeviceHasFullCopy', type: 'bool', required: false },
    { name: 'byteLength', type: 'uint', required: false },
    { name: 'reason', type: 'string', required: false }
  ]
})

ns.register({
  name: 'offload-upload-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'offload-upload-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'freedBytes', type: 'uint', required: false },
    { name: 'reason', type: 'string', required: false }
  ]
})

// ============================================
// Thumbnail/Metadata Types
// ============================================

ns.register({
  name: 'get-video-thumbnail-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'thumbnailBlobId', type: 'string', required: false },
    { name: 'thumbnailBlobsCoreKey', type: 'string', required: false },
    { name: 'thumbnailMimeType', type: 'string', required: false }
  ]
})

ns.register({
  name: 'get-video-thumbnail-response',
  fields: [
    { name: 'url', type: 'string', required: false },
    { name: 'dataUrl', type: 'string', required: false },
    { name: 'exists', type: 'bool', required: false }
  ]
})

ns.register({
  name: 'get-video-metadata-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'get-video-metadata-response',
  fields: [
    { name: 'video', type: '@peartube/video', required: true }
  ]
})

ns.register({
  name: 'set-video-thumbnail-request',
  fields: [
    { name: 'videoId', type: 'string', required: true },
    { name: 'imageData', type: 'string', required: true },
    { name: 'mimeType', type: 'string', required: false }
  ]
})

ns.register({
  name: 'set-video-thumbnail-from-file-request',
  fields: [
    { name: 'videoId', type: 'string', required: true },
    { name: 'filePath', type: 'string', required: true }
  ]
})

ns.register({
  name: 'set-video-thumbnail-from-file-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'set-video-thumbnail-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

// ============================================
// Desktop-specific Types
// ============================================

// --- Desktop Browse Snapshot (bootstrap) ---

ns.register({
  name: 'desktop-browse-video',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'backendVideoId', type: 'string', required: true },
    { name: 'channelKey', type: 'string', required: true },
    { name: 'publicBeeKey', type: 'string', required: false },
    { name: 'title', type: 'string', required: true },
    { name: 'channelName', type: 'string', required: true },
    { name: 'durationText', type: 'string', required: false },
    { name: 'summary', type: 'string', required: false },
    { name: 'tags', type: 'string', array: true },
    { name: 'accentHex', type: 'string', required: false },
    { name: 'sections', type: 'string', array: true },
    { name: 'thumbnailUrl', type: 'string', required: false },
    { name: 'path', type: 'string', required: false },
    { name: 'blobId', type: 'string', required: false },
    { name: 'blobsCoreKey', type: 'string', required: false },
    { name: 'mimeType', type: 'string', required: false },
    { name: 'width', type: 'uint', required: false },
    { name: 'height', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'desktop-browse-sections',
  fields: [
    { name: 'home', type: '@peartube/desktop-browse-video', array: true },
    { name: 'subscriptions', type: '@peartube/desktop-browse-video', array: true },
    { name: 'library', type: '@peartube/desktop-browse-video', array: true },
    { name: 'studio', type: '@peartube/desktop-browse-video', array: true },
    { name: 'diagnostics', type: '@peartube/desktop-browse-video', array: true }
  ]
})

ns.register({
  name: 'desktop-browse-stats',
  fields: [
    { name: 'homeCount', type: 'uint', required: false },
    { name: 'subscriptionCount', type: 'uint', required: false },
    { name: 'libraryCount', type: 'uint', required: false },
    { name: 'channelCount', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'desktop-browse-state',
  fields: [
    { name: 'subscriptionChannelKeys', type: 'string', array: true },
    { name: 'identityChannelKeys', type: 'string', array: true },
    { name: 'activeIdentityName', type: 'string', required: false },
    { name: 'activeIdentityChannelKey', type: 'string', required: false },
    { name: 'activeChannelPublished', type: 'bool', required: false }
  ]
})

ns.register({
  name: 'desktop-browse-snapshot',
  fields: [
    { name: 'generatedAt', type: 'uint', required: false },
    { name: 'sections', type: '@peartube/desktop-browse-sections', required: true },
    { name: 'stats', type: '@peartube/desktop-browse-stats', required: true },
    { name: 'state', type: '@peartube/desktop-browse-state', required: true }
  ]
})

ns.register({
  name: 'desktop-bootstrap-request',
  fields: [
    { name: 'storagePath', type: 'string', required: true }
  ]
})

ns.register({
  name: 'desktop-bootstrap-response',
  fields: [
    { name: 'blobServerPort', type: 'uint', required: false },
    { name: 'blobServerReady', type: 'bool', required: false },
    { name: 'blobServerError', type: 'string', required: false },
    { name: 'protocolVersion', type: 'uint', required: false },
    { name: 'storagePath', type: 'string', required: false },
    { name: 'snapshot', type: '@peartube/desktop-browse-snapshot', required: true }
  ]
})

ns.register({
  name: 'desktop-shutdown-request',
  fields: []
})

ns.register({
  name: 'desktop-shutdown-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'desktop-refresh-browse-request',
  fields: []
})

ns.register({
  name: 'desktop-refresh-browse-response',
  fields: [
    { name: 'snapshot', type: '@peartube/desktop-browse-snapshot', required: true }
  ]
})

// --- FFmpeg Decode ---

ns.register({
  name: 'ffmpeg-decode-available-request',
  fields: []
})

ns.register({
  name: 'ffmpeg-decode-available-response',
  fields: [
    { name: 'available', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

// --- Update Channel Avatar ---

ns.register({
  name: 'update-channel-avatar-request',
  fields: [
    { name: 'filePath', type: 'string', required: false },
    { name: 'imageData', type: 'string', required: false },
    { name: 'mimeType', type: 'string', required: false }
  ]
})

ns.register({
  name: 'update-channel-avatar-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

// --- Transcode Operations ---

ns.register({
  name: 'transcode-start-request',
  fields: [
    { name: 'sourceUrl', type: 'string', required: true },
    { name: 'duration', type: 'uint', required: false },
    { name: 'title', type: 'string', required: false }
  ]
})

ns.register({
  name: 'transcode-start-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'sessionId', type: 'string', required: false },
    { name: 'transcodeUrl', type: 'string', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'transcode-stop-request',
  fields: [
    { name: 'sessionId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'transcode-stop-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'transcode-status-request',
  fields: [
    { name: 'sessionId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'transcode-status-response',
  fields: [
    { name: 'status', type: 'string', required: false },
    { name: 'progress', type: 'uint', required: false },
    { name: 'bytesWritten', type: 'uint', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

// --- Transcode Progress Event ---

ns.register({
  name: 'event-transcode-progress',
  fields: [
    { name: 'sessionId', type: 'string', required: true },
    { name: 'percent', type: 'uint', required: false },
    { name: 'bytesWritten', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'status',
  fields: [
    { name: 'ready', type: 'bool', required: true },
    { name: 'hasIdentity', type: 'bool', required: false },
    { name: 'blobServerPort', type: 'uint', required: false },
    { name: 'blobServerReady', type: 'bool', required: false },
    { name: 'blobServerError', type: 'string', required: false }
  ]
})

ns.register({
  name: 'get-status-request',
  fields: []
})

ns.register({
  name: 'get-status-response',
  fields: [
    { name: 'status', type: '@peartube/status', required: true }
  ]
})

ns.register({
  name: 'pick-video-file-request',
  fields: []
})

ns.register({
  name: 'pick-video-file-response',
  fields: [
    { name: 'filePath', type: 'string', required: false },
    { name: 'name', type: 'string', required: false },
    { name: 'size', type: 'uint', required: false },
    { name: 'cancelled', type: 'bool', required: false }
  ]
})

ns.register({
  name: 'pick-image-file-request',
  fields: []
})

ns.register({
  name: 'pick-image-file-response',
  fields: [
    { name: 'filePath', type: 'string', required: false },
    { name: 'name', type: 'string', required: false },
    { name: 'size', type: 'uint', required: false },
    { name: 'dataUrl', type: 'string', required: false },
    { name: 'cancelled', type: 'bool', required: false }
  ]
})

ns.register({
  name: 'get-blob-server-port-request',
  fields: []
})

ns.register({
  name: 'get-blob-server-port-response',
  fields: [
    { name: 'port', type: 'uint', required: true }
  ]
})

// ============================================
// Global Search
// ============================================

ns.register({
  name: 'search-result',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'score', type: 'string', required: false },
    { name: 'metadata', type: 'string', required: false }
  ]
})

ns.register({
  name: 'global-search-videos-request',
  fields: [
    { name: 'query', type: 'string', required: true },
    { name: 'topK', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'global-search-videos-response',
  fields: [
    { name: 'results', type: '@peartube/search-result', array: true, required: true }
  ]
})

// ============================================
// Multi-device channel pairing
// ============================================

ns.register({
  name: 'device',
  fields: [
    { name: 'keyHex', type: 'string', required: true },
    { name: 'role', type: 'string', required: false },
    { name: 'deviceName', type: 'string', required: false },
    { name: 'addedAt', type: 'uint', required: false },
    { name: 'blobDriveKey', type: 'string', required: false }
  ]
})

ns.register({
  name: 'create-device-invite-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true }
  ]
})

ns.register({
  name: 'create-device-invite-response',
  fields: [
    { name: 'inviteCode', type: 'string', required: true }
  ]
})

ns.register({
  name: 'pair-device-request',
  fields: [
    { name: 'inviteCode', type: 'string', required: true },
    { name: 'deviceName', type: 'string', required: false }
  ]
})

ns.register({
  name: 'pair-device-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'channelKey', type: 'string', required: true },
    { name: 'syncState', type: 'string', required: false },
    { name: 'videoCount', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'retry-sync-channel-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true }
  ]
})

ns.register({
  name: 'retry-sync-channel-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'state', type: 'string', required: false },
    { name: 'videoCount', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'list-devices-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true }
  ]
})

ns.register({
  name: 'list-devices-response',
  fields: [
    { name: 'devices', type: '@peartube/device', array: true, required: true }
  ]
})

// ============================================
// Event Types (for streaming/push notifications)
// ============================================

ns.register({
  name: 'event-ready',
  fields: [
    { name: 'blobServerPort', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'event-error',
  fields: [
    { name: 'code', type: 'string', required: false },
    { name: 'message', type: 'string', required: true },
    { name: 'retryable', type: 'bool', required: false }
  ]
})

ns.register({
  name: 'event-upload-progress',
  fields: [
    { name: 'videoId', type: 'string', required: true },
    { name: 'progress', type: 'uint', required: true },
    { name: 'bytesUploaded', type: 'uint', required: false },
    { name: 'totalBytes', type: 'uint', required: false },
    { name: 'speed', type: 'uint', required: false },  // bytes/sec
    { name: 'eta', type: 'uint', required: false }     // seconds remaining
  ]
})

ns.register({
  name: 'event-download-progress',
  fields: [
    { name: 'id', type: 'string', required: true },           // download ID: channelKey:videoId
    { name: 'progress', type: 'uint', required: true },       // 0-100
    { name: 'bytesDownloaded', type: 'uint', required: false },
    { name: 'totalBytes', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'event-feed-update',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'action', type: 'string', required: true }
  ]
})

ns.register({
  name: 'event-log',
  fields: [
    { name: 'level', type: 'string', required: true },
    { name: 'message', type: 'string', required: true },
    { name: 'timestamp', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'event-video-stats',
  fields: [
    { name: 'stats', type: '@peartube/video-stats', required: true }
  ]
})

// ============================================
// Channel Operation Types (for Autobase ops)
// ============================================

ns.register({
  name: 'channel-op-base',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: false } // Default: 1
  ]
})

ns.register({
  name: 'channel-op-update-channel',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: false },
    { name: 'key', type: 'string', required: false },
    { name: 'name', type: 'string', required: false },
    { name: 'description', type: 'string', required: false },
    { name: 'avatar', type: 'string', required: false },
    { name: 'updatedAt', type: 'uint', required: false },
    { name: 'updatedBy', type: 'string', required: false },
    { name: 'createdAt', type: 'uint', required: false },
    { name: 'createdBy', type: 'string', required: false }
  ]
})

ns.register({
  name: 'channel-op-add-video',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: false },
    { name: 'id', type: 'string', required: true },
    { name: 'title', type: 'string', required: true },
    { name: 'description', type: 'string', required: false },
    { name: 'path', type: 'string', required: false },
    { name: 'duration', type: 'uint', required: false },
    { name: 'thumbnail', type: 'string', required: false },
    { name: 'blobDriveKey', type: 'string', required: false },
    { name: 'mimeType', type: 'string', required: false },
    { name: 'size', type: 'uint', required: false },
    { name: 'uploadedAt', type: 'uint', required: false },
    { name: 'uploadedBy', type: 'string', required: false },
    { name: 'category', type: 'string', required: false },
    { name: 'views', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'channel-op-update-video',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: false },
    { name: 'id', type: 'string', required: true },
    { name: 'title', type: 'string', required: false },
    { name: 'description', type: 'string', required: false },
    { name: 'thumbnail', type: 'string', required: false },
    { name: 'category', type: 'string', required: false },
    { name: 'updatedAt', type: 'uint', required: false },
    { name: 'updatedBy', type: 'string', required: false }
  ]
})

ns.register({
  name: 'channel-op-delete-video',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: false },
    { name: 'id', type: 'string', required: true }
  ]
})

ns.register({
  name: 'channel-op-add-writer',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: false },
    { name: 'keyHex', type: 'string', required: true },
    { name: 'role', type: 'string', required: false },
    { name: 'deviceName', type: 'string', required: false },
    { name: 'addedAt', type: 'uint', required: false },
    { name: 'blobDriveKey', type: 'string', required: false }
  ]
})

ns.register({
  name: 'channel-op-upsert-writer',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: false },
    { name: 'keyHex', type: 'string', required: true },
    { name: 'role', type: 'string', required: false },
    { name: 'deviceName', type: 'string', required: false },
    { name: 'addedAt', type: 'uint', required: false },
    { name: 'blobDriveKey', type: 'string', required: false }
  ]
})

ns.register({
  name: 'channel-op-remove-writer',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: false },
    { name: 'keyHex', type: 'string', required: true },
    { name: 'ban', type: 'bool', required: false }
  ]
})

ns.register({
  name: 'channel-op-add-invite',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: false },
    { name: 'idHex', type: 'string', required: true },
    { name: 'inviteZ32', type: 'string', required: true },
    { name: 'publicKeyHex', type: 'string', required: false },
    { name: 'expires', type: 'uint', required: false },
    { name: 'createdAt', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'channel-op-delete-invite',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: false },
    { name: 'idHex', type: 'string', required: true }
  ]
})

// Placeholder for future phases
ns.register({
  name: 'channel-op-add-comment',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: false },
    { name: 'videoId', type: 'string', required: true },
    { name: 'commentId', type: 'string', required: true },
    { name: 'text', type: 'string', required: true },
    { name: 'authorKeyHex', type: 'string', required: true },
    { name: 'timestamp', type: 'uint', required: false },
    { name: 'parentId', type: 'string', required: false }
  ]
})

ns.register({
  name: 'channel-op-add-reaction',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: false },
    { name: 'videoId', type: 'string', required: true },
    { name: 'reactionType', type: 'string', required: true },
    { name: 'authorKeyHex', type: 'string', required: true },
    { name: 'timestamp', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'channel-op-remove-reaction',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: false },
    { name: 'videoId', type: 'string', required: true },
    { name: 'authorKeyHex', type: 'string', required: true }
  ]
})

ns.register({
  name: 'channel-op-hide-comment',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: false },
    { name: 'videoId', type: 'string', required: true },
    { name: 'commentId', type: 'string', required: true },
    { name: 'moderatorKeyHex', type: 'string', required: true }
  ]
})

ns.register({
  name: 'channel-op-remove-comment',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: false },
    { name: 'videoId', type: 'string', required: true },
    { name: 'commentId', type: 'string', required: true },
    { name: 'moderatorKeyHex', type: 'string', required: false },
    { name: 'authorKeyHex', type: 'string', required: false }
  ]
})

ns.register({
  name: 'channel-op-add-vector-index',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: false },
    { name: 'videoId', type: 'string', required: true },
    { name: 'vector', type: 'string', required: false }, // Base64 encoded vector
    { name: 'text', type: 'string', required: false },
    { name: 'metadata', type: 'string', required: false } // JSON string
  ]
})

ns.register({
  name: 'channel-op-log-watch-event',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: false },
    { name: 'videoId', type: 'string', required: true },
    { name: 'channelKey', type: 'string', required: false },
    { name: 'watcherKeyHex', type: 'string', required: false },
    { name: 'duration', type: 'uint', required: false },
    { name: 'completed', type: 'bool', required: false },
    { name: 'timestamp', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'channel-op-migrate-schema',
  fields: [
    { name: 'type', type: 'string', required: true },
    { name: 'schemaVersion', type: 'uint', required: true },
    { name: 'fromVersion', type: 'uint', required: true },
    { name: 'toVersion', type: 'uint', required: true },
    { name: 'migratedAt', type: 'uint', required: false }
  ]
})

// ============================================
// Comments RPC (matching existing schema.json)
// ============================================

ns.register({
  name: 'add-comment-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'text', type: 'string', required: true },
    { name: 'parentId', type: 'string', required: false },
    { name: 'authorChannelKey', type: 'string', required: false },
    { name: 'publicBeeKey', type: 'string', required: false }
  ]
})

ns.register({
  name: 'add-comment-response',
  fields: [
    { name: 'success', type: 'bool', required: false },
    { name: 'commentId', type: 'string', required: false },
    { name: 'queued', type: 'bool', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'list-comments-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'page', type: 'uint', required: false },
    { name: 'limit', type: 'uint', required: false },
    { name: 'publicBeeKey', type: 'string', required: false }
  ]
})

// comment type used by list-comments-response
ns.register({
  name: 'comment',
  fields: [
    { name: 'videoId', type: 'string', required: true },
    { name: 'commentId', type: 'string', required: true },
    { name: 'text', type: 'string', required: true },
    { name: 'authorKeyHex', type: 'string', required: true },
    { name: 'timestamp', type: 'uint', required: false },
    { name: 'parentId', type: 'string', required: false },
    { name: 'isAdmin', type: 'bool', required: false }
  ]
})

ns.register({
  name: 'list-comments-response',
  fields: [
    { name: 'success', type: 'bool', required: false },
    { name: 'comments', type: '@peartube/comment', array: true, required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'hide-comment-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'commentId', type: 'string', required: true },
    { name: 'publicBeeKey', type: 'string', required: false }
  ]
})

ns.register({
  name: 'hide-comment-response',
  fields: [
    { name: 'success', type: 'bool', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'remove-comment-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'commentId', type: 'string', required: true },
    { name: 'authorChannelKey', type: 'string', required: false },
    { name: 'publicBeeKey', type: 'string', required: false }
  ]
})

ns.register({
  name: 'remove-comment-response',
  fields: [
    { name: 'success', type: 'bool', required: false },
    { name: 'queued', type: 'bool', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

// ============================================
// Reactions RPC (matching existing schema.json)
// ============================================

ns.register({
  name: 'reaction-count',
  fields: [
    { name: 'reactionType', type: 'string', required: true },
    { name: 'count', type: 'uint', required: true }
  ]
})

ns.register({
  name: 'add-reaction-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'reactionType', type: 'string', required: true },
    { name: 'authorChannelKey', type: 'string', required: false },
    { name: 'publicBeeKey', type: 'string', required: false }
  ]
})

ns.register({
  name: 'add-reaction-response',
  fields: [
    { name: 'success', type: 'bool', required: false },
    { name: 'queued', type: 'bool', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'remove-reaction-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'authorChannelKey', type: 'string', required: false },
    { name: 'publicBeeKey', type: 'string', required: false }
  ]
})

ns.register({
  name: 'remove-reaction-response',
  fields: [
    { name: 'success', type: 'bool', required: false },
    { name: 'queued', type: 'bool', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'get-reactions-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'authorChannelKey', type: 'string', required: false },
    { name: 'publicBeeKey', type: 'string', required: false }
  ]
})

ns.register({
  name: 'get-reactions-response',
  fields: [
    { name: 'success', type: 'bool', required: false },
    { name: 'counts', type: '@peartube/reaction-count', array: true, required: true },
    { name: 'userReaction', type: 'string', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

// ============================================
// Casting Types
// ============================================

ns.register({
  name: 'cast-device',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
    { name: 'host', type: 'string', required: true },
    { name: 'port', type: 'uint', required: true },
    { name: 'protocol', type: 'string', required: true }
  ]
})

ns.register({
  name: 'cast-available-request',
  fields: []
})

ns.register({
  name: 'cast-available-response',
  fields: [
    { name: 'available', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'cast-start-discovery-request',
  fields: []
})

ns.register({
  name: 'cast-start-discovery-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'cast-stop-discovery-request',
  fields: []
})

ns.register({
  name: 'cast-stop-discovery-response',
  fields: [
    { name: 'success', type: 'bool', required: true }
  ]
})

ns.register({
  name: 'cast-get-devices-request',
  fields: []
})

ns.register({
  name: 'cast-get-devices-response',
  fields: [
    { name: 'devices', type: '@peartube/cast-device', array: true, required: true }
  ]
})

ns.register({
  name: 'cast-add-manual-device-request',
  fields: [
    { name: 'name', type: 'string', required: true },
    { name: 'host', type: 'string', required: true },
    { name: 'port', type: 'uint', required: false },
    { name: 'protocol', type: 'string', required: false }
  ]
})

ns.register({
  name: 'cast-add-manual-device-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'device', type: '@peartube/cast-device', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'cast-connect-request',
  fields: [
    { name: 'deviceId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'cast-connect-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'cast-disconnect-request',
  fields: []
})

ns.register({
  name: 'cast-disconnect-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'cast-play-request',
  fields: [
    { name: 'url', type: 'string', required: true },
    { name: 'contentType', type: 'string', required: true },
    { name: 'title', type: 'string', required: false },
    { name: 'thumbnail', type: 'string', required: false },
    { name: 'time', type: 'uint', required: false },
    { name: 'volume', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'cast-play-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'cast-pause-request',
  fields: []
})

ns.register({
  name: 'cast-pause-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'cast-resume-request',
  fields: []
})

ns.register({
  name: 'cast-resume-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'cast-stop-request',
  fields: []
})

ns.register({
  name: 'cast-stop-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'cast-seek-request',
  fields: [
    { name: 'time', type: 'uint', required: true }
  ]
})

ns.register({
  name: 'cast-seek-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'cast-set-volume-request',
  fields: [
    { name: 'volume', type: 'uint', required: true }
  ]
})

ns.register({
  name: 'cast-set-volume-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'cast-get-state-request',
  fields: []
})

ns.register({
  name: 'cast-get-state-response',
  fields: [
    { name: 'state', type: 'string', required: true },
    { name: 'currentTime', type: 'uint', required: false },
    { name: 'duration', type: 'uint', required: false },
    { name: 'volume', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'cast-is-connected-request',
  fields: []
})

ns.register({
  name: 'cast-is-connected-response',
  fields: [
    { name: 'connected', type: 'bool', required: true }
  ]
})

// Cast events
ns.register({
  name: 'event-cast-device-found',
  fields: [
    { name: 'device', type: '@peartube/cast-device', required: true }
  ]
})

ns.register({
  name: 'event-cast-device-lost',
  fields: [
    { name: 'deviceId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'event-cast-playback-state',
  fields: [
    { name: 'state', type: 'string', required: true }
  ]
})

ns.register({
  name: 'event-cast-time-update',
  fields: [
    { name: 'currentTime', type: 'uint', required: true }
  ]
})

// ============================================
// Search / Watch Events (appended for compat)
// ============================================

ns.register({
  name: 'search-videos-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'query', type: 'string', required: true },
    { name: 'topK', type: 'uint', required: false },
    { name: 'federated', type: 'bool', required: false }
  ]
})

ns.register({
  name: 'search-videos-response',
  fields: [
    { name: 'results', type: '@peartube/search-result', array: true, required: true }
  ]
})

ns.register({
  name: 'log-watch-event-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'duration', type: 'uint', required: false },
    { name: 'completed', type: 'bool', required: false },
    { name: 'share', type: 'bool', required: false }
  ]
})

ns.register({
  name: 'log-watch-event-response',
  fields: [
    { name: 'success', type: 'bool', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'index-video-vectors-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'index-video-vectors-response',
  fields: [
    { name: 'success', type: 'bool', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'recommendation',
  fields: [
    { name: 'videoId', type: 'string', required: true },
    { name: 'score', type: 'string', required: false },
    { name: 'reason', type: 'string', required: false }
  ]
})

ns.register({
  name: 'get-recommendations-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'limit', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'get-recommendations-response',
  fields: [
    { name: 'success', type: 'bool', required: false },
    { name: 'recommendations', type: '@peartube/recommendation', array: true, required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'get-video-recommendations-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'limit', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'get-video-recommendations-response',
  fields: [
    { name: 'success', type: 'bool', required: false },
    { name: 'recommendations', type: '@peartube/recommendation', array: true, required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

// Save schema to disk
Hyperschema.toDisk(schema)

console.log('Schema generated in', SCHEMA_DIR)

// ============================================
// HRPC Command Registration
// ============================================

const builder = HRPCBuilder.from(SCHEMA_DIR, HRPC_DIR)
const rpcNs = builder.namespace('peartube')

// Identity commands
rpcNs.register({
  name: 'create-identity',
  request: { name: '@peartube/create-identity-request', stream: false },
  response: { name: '@peartube/create-identity-response', stream: false }
})

rpcNs.register({
  name: 'get-identity',
  request: { name: '@peartube/get-identity-request', stream: false },
  response: { name: '@peartube/get-identity-response', stream: false }
})

rpcNs.register({
  name: 'get-identities',
  request: { name: '@peartube/get-identities-request', stream: false },
  response: { name: '@peartube/get-identities-response', stream: false }
})

rpcNs.register({
  name: 'set-active-identity',
  request: { name: '@peartube/set-active-identity-request', stream: false },
  response: { name: '@peartube/set-active-identity-response', stream: false }
})

rpcNs.register({
  name: 'recover-identity',
  request: { name: '@peartube/recover-identity-request', stream: false },
  response: { name: '@peartube/recover-identity-response', stream: false }
})

// Device Attestation commands
rpcNs.register({
  name: 'bootstrap-device',
  request: { name: '@peartube/bootstrap-device-request', stream: false },
  response: { name: '@peartube/bootstrap-device-response', stream: false }
})

rpcNs.register({
  name: 'attest-device',
  request: { name: '@peartube/attest-device-request', stream: false },
  response: { name: '@peartube/attest-device-response', stream: false }
})

rpcNs.register({
  name: 'verify-attestation',
  request: { name: '@peartube/verify-attestation-request', stream: false },
  response: { name: '@peartube/verify-attestation-response', stream: false }
})

// Channel commands
rpcNs.register({
  name: 'get-channel',
  request: { name: '@peartube/get-channel-request', stream: false },
  response: { name: '@peartube/get-channel-response', stream: false }
})

rpcNs.register({
  name: 'update-channel',
  request: { name: '@peartube/update-channel-request', stream: false },
  response: { name: '@peartube/update-channel-response', stream: false }
})

// Video commands
rpcNs.register({
  name: 'list-videos',
  request: { name: '@peartube/list-videos-request', stream: false },
  response: { name: '@peartube/list-videos-response', stream: false }
})

rpcNs.register({
  name: 'get-video-url',
  request: { name: '@peartube/get-video-url-request', stream: false },
  response: { name: '@peartube/get-video-url-response', stream: false }
})

rpcNs.register({
  name: 'prepare-playback',
  request: { name: '@peartube/prepare-playback-request', stream: false },
  response: { name: '@peartube/prepare-playback-response', stream: false }
})

rpcNs.register({
  name: 'web-prepare-playback',
  request: { name: '@peartube/prepare-playback-request', stream: false },
  response: { name: '@peartube/web-prepare-playback-response', stream: false }
})

rpcNs.register({
  name: 'get-video-data',
  request: { name: '@peartube/get-video-data-request', stream: false },
  response: { name: '@peartube/get-video-data-response', stream: false }
})

rpcNs.register({
  name: 'upload-video',
  request: { name: '@peartube/upload-video-request', stream: false },
  response: { name: '@peartube/upload-video-response', stream: false }
})

rpcNs.register({
  name: 'download-video',
  request: { name: '@peartube/download-video-request', stream: false },
  response: { name: '@peartube/download-video-response', stream: false }
})

rpcNs.register({
  name: 'delete-video',
  request: { name: '@peartube/delete-video-request', stream: false },
  response: { name: '@peartube/delete-video-response', stream: false }
})

// Livestreaming commands
rpcNs.register({
  name: 'start-livestream',
  request: { name: '@peartube/start-livestream-request', stream: false },
  response: { name: '@peartube/start-livestream-response', stream: false }
})

rpcNs.register({
  name: 'stop-livestream',
  request: { name: '@peartube/stop-livestream-request', stream: false },
  response: { name: '@peartube/stop-livestream-response', stream: false }
})

rpcNs.register({
  name: 'get-livestream-status',
  request: { name: '@peartube/get-livestream-status-request', stream: false },
  response: { name: '@peartube/get-livestream-status-response', stream: false }
})

rpcNs.register({
  name: 'prepare-live-playback',
  request: { name: '@peartube/prepare-live-playback-request', stream: false },
  response: { name: '@peartube/prepare-live-playback-response', stream: false }
})

// Subscription commands
rpcNs.register({
  name: 'subscribe-channel',
  request: { name: '@peartube/subscribe-channel-request', stream: false },
  response: { name: '@peartube/subscribe-channel-response', stream: false }
})

rpcNs.register({
  name: 'unsubscribe-channel',
  request: { name: '@peartube/unsubscribe-channel-request', stream: false },
  response: { name: '@peartube/unsubscribe-channel-response', stream: false }
})

rpcNs.register({
  name: 'get-subscriptions',
  request: { name: '@peartube/get-subscriptions-request', stream: false },
  response: { name: '@peartube/get-subscriptions-response', stream: false }
})

// Personal Sync commands (playlists / history / settings)
rpcNs.register({
  name: 'get-playlists',
  request: { name: '@peartube/get-playlists-request', stream: false },
  response: { name: '@peartube/get-playlists-response', stream: false }
})

rpcNs.register({
  name: 'get-playlist-items',
  request: { name: '@peartube/get-playlist-items-request', stream: false },
  response: { name: '@peartube/get-playlist-items-response', stream: false }
})

rpcNs.register({
  name: 'create-playlist',
  request: { name: '@peartube/create-playlist-request', stream: false },
  response: { name: '@peartube/create-playlist-response', stream: false }
})

rpcNs.register({
  name: 'update-playlist',
  request: { name: '@peartube/update-playlist-request', stream: false },
  response: { name: '@peartube/update-playlist-response', stream: false }
})

rpcNs.register({
  name: 'delete-playlist',
  request: { name: '@peartube/delete-playlist-request', stream: false },
  response: { name: '@peartube/delete-playlist-response', stream: false }
})

rpcNs.register({
  name: 'add-to-playlist',
  request: { name: '@peartube/add-to-playlist-request', stream: false },
  response: { name: '@peartube/add-to-playlist-response', stream: false }
})

rpcNs.register({
  name: 'remove-from-playlist',
  request: { name: '@peartube/remove-from-playlist-request', stream: false },
  response: { name: '@peartube/remove-from-playlist-response', stream: false }
})

rpcNs.register({
  name: 'log-watch-history',
  request: { name: '@peartube/log-watch-history-request', stream: false },
  response: { name: '@peartube/log-watch-history-response', stream: false }
})

rpcNs.register({
  name: 'get-watch-history',
  request: { name: '@peartube/get-watch-history-request', stream: false },
  response: { name: '@peartube/get-watch-history-response', stream: false }
})

rpcNs.register({
  name: 'get-resume-position',
  request: { name: '@peartube/get-resume-position-request', stream: false },
  response: { name: '@peartube/get-resume-position-response', stream: false }
})

rpcNs.register({
  name: 'list-resume-positions',
  request: { name: '@peartube/list-resume-positions-request', stream: false },
  response: { name: '@peartube/list-resume-positions-response', stream: false }
})

rpcNs.register({
  name: 'set-personal-setting',
  request: { name: '@peartube/set-personal-setting-request', stream: false },
  response: { name: '@peartube/set-personal-setting-response', stream: false }
})

rpcNs.register({
  name: 'get-personal-settings',
  request: { name: '@peartube/get-personal-settings-request', stream: false },
  response: { name: '@peartube/get-personal-settings-response', stream: false }
})

rpcNs.register({
  name: 'provision-personal-encryption',
  request: { name: '@peartube/provision-personal-encryption-request', stream: false },
  response: { name: '@peartube/provision-personal-encryption-response', stream: false }
})

rpcNs.register({
  name: 'join-channel',
  request: { name: '@peartube/join-channel-request', stream: false },
  response: { name: '@peartube/join-channel-response', stream: false }
})

// Public Feed commands
rpcNs.register({
  name: 'get-public-feed',
  request: { name: '@peartube/get-public-feed-request', stream: false },
  response: { name: '@peartube/get-public-feed-response', stream: false }
})

rpcNs.register({
  name: 'get-canonical-feed',
  request: { name: '@peartube/get-canonical-feed-request', stream: false },
  response: { name: '@peartube/get-canonical-feed-response', stream: false }
})

rpcNs.register({
  name: 'refresh-feed',
  request: { name: '@peartube/refresh-feed-request', stream: false },
  response: { name: '@peartube/refresh-feed-response', stream: false }
})

rpcNs.register({
  name: 'submit-to-feed',
  request: { name: '@peartube/submit-to-feed-request', stream: false },
  response: { name: '@peartube/submit-to-feed-response', stream: false }
})

rpcNs.register({
  name: 'unpublish-from-feed',
  request: { name: '@peartube/unpublish-from-feed-request', stream: false },
  response: { name: '@peartube/unpublish-from-feed-response', stream: false }
})

rpcNs.register({
  name: 'is-channel-published',
  request: { name: '@peartube/is-channel-published-request', stream: false },
  response: { name: '@peartube/is-channel-published-response', stream: false }
})

rpcNs.register({
  name: 'hide-channel',
  request: { name: '@peartube/hide-channel-request', stream: false },
  response: { name: '@peartube/hide-channel-response', stream: false }
})

rpcNs.register({
  name: 'get-channel-meta',
  request: { name: '@peartube/get-channel-meta-request', stream: false },
  response: { name: '@peartube/get-channel-meta-response', stream: false }
})

rpcNs.register({
  name: 'get-swarm-status',
  request: { name: '@peartube/get-swarm-status-request', stream: false },
  response: { name: '@peartube/get-swarm-status-response', stream: false }
})

// Multi-device pairing commands
rpcNs.register({
  name: 'create-device-invite',
  request: { name: '@peartube/create-device-invite-request', stream: false },
  response: { name: '@peartube/create-device-invite-response', stream: false }
})

rpcNs.register({
  name: 'pair-device',
  request: { name: '@peartube/pair-device-request', stream: false },
  response: { name: '@peartube/pair-device-response', stream: false }
})

rpcNs.register({
  name: 'list-devices',
  request: { name: '@peartube/list-devices-request', stream: false },
  response: { name: '@peartube/list-devices-response', stream: false }
})

rpcNs.register({
  name: 'retry-sync-channel',
  request: { name: '@peartube/retry-sync-channel-request', stream: false },
  response: { name: '@peartube/retry-sync-channel-response', stream: false }
})

// Video prefetch & stats commands
rpcNs.register({
  name: 'prefetch-video',
  request: { name: '@peartube/prefetch-video-request', stream: false },
  response: { name: '@peartube/prefetch-video-response', stream: false }
})

rpcNs.register({
  name: 'get-video-stats',
  request: { name: '@peartube/get-video-stats-request', stream: false },
  response: { name: '@peartube/get-video-stats-response', stream: false }
})

// Seeding commands
rpcNs.register({
  name: 'get-seeding-status',
  request: { name: '@peartube/get-seeding-status-request', stream: false },
  response: { name: '@peartube/get-seeding-status-response', stream: false }
})

rpcNs.register({
  name: 'set-seeding-config',
  request: { name: '@peartube/set-seeding-config-request', stream: false },
  response: { name: '@peartube/set-seeding-config-response', stream: false }
})

// Transcode settings commands
rpcNs.register({
  name: 'get-transcode-settings',
  request: { name: '@peartube/get-transcode-settings-request', stream: false },
  response: { name: '@peartube/get-transcode-settings-response', stream: false }
})

rpcNs.register({
  name: 'set-transcode-settings',
  request: { name: '@peartube/set-transcode-settings-request', stream: false },
  response: { name: '@peartube/set-transcode-settings-response', stream: false }
})

rpcNs.register({
  name: 'pin-channel',
  request: { name: '@peartube/pin-channel-request', stream: false },
  response: { name: '@peartube/pin-channel-response', stream: false }
})

rpcNs.register({
  name: 'unpin-channel',
  request: { name: '@peartube/unpin-channel-request', stream: false },
  response: { name: '@peartube/unpin-channel-response', stream: false }
})

rpcNs.register({
  name: 'get-pinned-channels',
  request: { name: '@peartube/get-pinned-channels-request', stream: false },
  response: { name: '@peartube/get-pinned-channels-response', stream: false }
})

// Storage management commands
rpcNs.register({
  name: 'get-storage-stats',
  request: { name: '@peartube/get-storage-stats-request', stream: false },
  response: { name: '@peartube/get-storage-stats-response', stream: false }
})

rpcNs.register({
  name: 'set-storage-limit',
  request: { name: '@peartube/set-storage-limit-request', stream: false },
  response: { name: '@peartube/set-storage-limit-response', stream: false }
})

rpcNs.register({
  name: 'clear-cache',
  request: { name: '@peartube/clear-cache-request', stream: false },
  response: { name: '@peartube/clear-cache-response', stream: false }
})

rpcNs.register({
  name: 'add-relay-link',
  request: { name: '@peartube/add-relay-link-request', stream: false },
  response: { name: '@peartube/add-relay-link-response', stream: false }
})

rpcNs.register({
  name: 'remove-relay-link',
  request: { name: '@peartube/remove-relay-link-request', stream: false },
  response: { name: '@peartube/remove-relay-link-response', stream: false }
})

rpcNs.register({
  name: 'get-relay-links',
  request: { name: '@peartube/get-relay-links-request', stream: false },
  response: { name: '@peartube/get-relay-links-response', stream: false }
})

rpcNs.register({
  name: 'assess-upload-offload',
  request: { name: '@peartube/assess-upload-offload-request', stream: false },
  response: { name: '@peartube/assess-upload-offload-response', stream: false }
})

rpcNs.register({
  name: 'offload-upload',
  request: { name: '@peartube/offload-upload-request', stream: false },
  response: { name: '@peartube/offload-upload-response', stream: false }
})

// Thumbnail/Metadata commands
rpcNs.register({
  name: 'get-video-thumbnail',
  request: { name: '@peartube/get-video-thumbnail-request', stream: false },
  response: { name: '@peartube/get-video-thumbnail-response', stream: false }
})

rpcNs.register({
  name: 'get-video-metadata',
  request: { name: '@peartube/get-video-metadata-request', stream: false },
  response: { name: '@peartube/get-video-metadata-response', stream: false }
})

rpcNs.register({
  name: 'set-video-thumbnail',
  request: { name: '@peartube/set-video-thumbnail-request', stream: false },
  response: { name: '@peartube/set-video-thumbnail-response', stream: false }
})

rpcNs.register({
  name: 'set-video-thumbnail-from-file',
  request: { name: '@peartube/set-video-thumbnail-from-file-request', stream: false },
  response: { name: '@peartube/set-video-thumbnail-from-file-response', stream: false }
})

// Desktop-specific commands
rpcNs.register({
  name: 'get-status',
  request: { name: '@peartube/get-status-request', stream: false },
  response: { name: '@peartube/get-status-response', stream: false }
})

rpcNs.register({
  name: 'pick-video-file',
  request: { name: '@peartube/pick-video-file-request', stream: false },
  response: { name: '@peartube/pick-video-file-response', stream: false }
})

rpcNs.register({
  name: 'pick-image-file',
  request: { name: '@peartube/pick-image-file-request', stream: false },
  response: { name: '@peartube/pick-image-file-response', stream: false }
})

rpcNs.register({
  name: 'get-blob-server-port',
  request: { name: '@peartube/get-blob-server-port-request', stream: false },
  response: { name: '@peartube/get-blob-server-port-response', stream: false }
})

// Global search
rpcNs.register({
  name: 'global-search-videos',
  request: { name: '@peartube/global-search-videos-request', stream: false },
  response: { name: '@peartube/global-search-videos-response', stream: false }
})

// Event streams (send-only, no response expected)
// Comment RPC methods
rpcNs.register({
  name: 'add-comment',
  request: { name: '@peartube/add-comment-request', stream: false },
  response: { name: '@peartube/add-comment-response', stream: false }
})

rpcNs.register({
  name: 'list-comments',
  request: { name: '@peartube/list-comments-request', stream: false },
  response: { name: '@peartube/list-comments-response', stream: false }
})

rpcNs.register({
  name: 'hide-comment',
  request: { name: '@peartube/hide-comment-request', stream: false },
  response: { name: '@peartube/hide-comment-response', stream: false }
})

rpcNs.register({
  name: 'remove-comment',
  request: { name: '@peartube/remove-comment-request', stream: false },
  response: { name: '@peartube/remove-comment-response', stream: false }
})

// Reaction RPC methods
rpcNs.register({
  name: 'add-reaction',
  request: { name: '@peartube/add-reaction-request', stream: false },
  response: { name: '@peartube/add-reaction-response', stream: false }
})

rpcNs.register({
  name: 'remove-reaction',
  request: { name: '@peartube/remove-reaction-request', stream: false },
  response: { name: '@peartube/remove-reaction-response', stream: false }
})

rpcNs.register({
  name: 'get-reactions',
  request: { name: '@peartube/get-reactions-request', stream: false },
  response: { name: '@peartube/get-reactions-response', stream: false }
})

rpcNs.register({
  name: 'event-ready',
  request: { name: '@peartube/event-ready', stream: false, send: true }
})

rpcNs.register({
  name: 'event-error',
  request: { name: '@peartube/event-error', stream: false, send: true }
})

rpcNs.register({
  name: 'event-upload-progress',
  request: { name: '@peartube/event-upload-progress', stream: false, send: true }
})

rpcNs.register({
  name: 'event-download-progress',
  request: { name: '@peartube/event-download-progress', stream: false, send: true }
})

rpcNs.register({
  name: 'event-feed-update',
  request: { name: '@peartube/event-feed-update', stream: false, send: true }
})

rpcNs.register({
  name: 'event-log',
  request: { name: '@peartube/event-log', stream: false, send: true }
})

rpcNs.register({
  name: 'event-video-stats',
  request: { name: '@peartube/event-video-stats', stream: false, send: true }
})

// Cast commands
rpcNs.register({
  name: 'cast-available',
  request: { name: '@peartube/cast-available-request', stream: false },
  response: { name: '@peartube/cast-available-response', stream: false }
})

rpcNs.register({
  name: 'cast-start-discovery',
  request: { name: '@peartube/cast-start-discovery-request', stream: false },
  response: { name: '@peartube/cast-start-discovery-response', stream: false }
})

rpcNs.register({
  name: 'cast-stop-discovery',
  request: { name: '@peartube/cast-stop-discovery-request', stream: false },
  response: { name: '@peartube/cast-stop-discovery-response', stream: false }
})

rpcNs.register({
  name: 'cast-get-devices',
  request: { name: '@peartube/cast-get-devices-request', stream: false },
  response: { name: '@peartube/cast-get-devices-response', stream: false }
})

rpcNs.register({
  name: 'cast-add-manual-device',
  request: { name: '@peartube/cast-add-manual-device-request', stream: false },
  response: { name: '@peartube/cast-add-manual-device-response', stream: false }
})

rpcNs.register({
  name: 'cast-connect',
  request: { name: '@peartube/cast-connect-request', stream: false },
  response: { name: '@peartube/cast-connect-response', stream: false }
})

rpcNs.register({
  name: 'cast-disconnect',
  request: { name: '@peartube/cast-disconnect-request', stream: false },
  response: { name: '@peartube/cast-disconnect-response', stream: false }
})

rpcNs.register({
  name: 'cast-play',
  request: { name: '@peartube/cast-play-request', stream: false },
  response: { name: '@peartube/cast-play-response', stream: false }
})

rpcNs.register({
  name: 'cast-pause',
  request: { name: '@peartube/cast-pause-request', stream: false },
  response: { name: '@peartube/cast-pause-response', stream: false }
})

rpcNs.register({
  name: 'cast-resume',
  request: { name: '@peartube/cast-resume-request', stream: false },
  response: { name: '@peartube/cast-resume-response', stream: false }
})

rpcNs.register({
  name: 'cast-stop',
  request: { name: '@peartube/cast-stop-request', stream: false },
  response: { name: '@peartube/cast-stop-response', stream: false }
})

rpcNs.register({
  name: 'cast-seek',
  request: { name: '@peartube/cast-seek-request', stream: false },
  response: { name: '@peartube/cast-seek-response', stream: false }
})

rpcNs.register({
  name: 'cast-set-volume',
  request: { name: '@peartube/cast-set-volume-request', stream: false },
  response: { name: '@peartube/cast-set-volume-response', stream: false }
})

rpcNs.register({
  name: 'cast-get-state',
  request: { name: '@peartube/cast-get-state-request', stream: false },
  response: { name: '@peartube/cast-get-state-response', stream: false }
})

rpcNs.register({
  name: 'cast-is-connected',
  request: { name: '@peartube/cast-is-connected-request', stream: false },
  response: { name: '@peartube/cast-is-connected-response', stream: false }
})

// Cast events
rpcNs.register({
  name: 'event-cast-device-found',
  request: { name: '@peartube/event-cast-device-found', stream: false, send: true }
})

rpcNs.register({
  name: 'event-cast-device-lost',
  request: { name: '@peartube/event-cast-device-lost', stream: false, send: true }
})

rpcNs.register({
  name: 'event-cast-playback-state',
  request: { name: '@peartube/event-cast-playback-state', stream: false, send: true }
})

rpcNs.register({
  name: 'event-cast-time-update',
  request: { name: '@peartube/event-cast-time-update', stream: false, send: true }
})

// Search / Watch events (appended for compat)
rpcNs.register({
  name: 'search-videos',
  request: { name: '@peartube/search-videos-request', stream: false },
  response: { name: '@peartube/search-videos-response', stream: false }
})

rpcNs.register({
  name: 'log-watch-event',
  request: { name: '@peartube/log-watch-event-request', stream: false },
  response: { name: '@peartube/log-watch-event-response', stream: false }
})

rpcNs.register({
  name: 'index-video-vectors',
  request: { name: '@peartube/index-video-vectors-request', stream: false },
  response: { name: '@peartube/index-video-vectors-response', stream: false }
})

rpcNs.register({
  name: 'get-recommendations',
  request: { name: '@peartube/get-recommendations-request', stream: false },
  response: { name: '@peartube/get-recommendations-response', stream: false }
})

rpcNs.register({
  name: 'get-video-recommendations',
  request: { name: '@peartube/get-video-recommendations-request', stream: false },
  response: { name: '@peartube/get-video-recommendations-response', stream: false }
})

rpcNs.register({
  name: 'update-video-metadata',
  request: { name: '@peartube/update-video-metadata-request', stream: false },
  response: { name: '@peartube/update-video-metadata-response', stream: false }
})

// Desktop lifecycle commands
rpcNs.register({
  name: 'desktop-bootstrap',
  request: { name: '@peartube/desktop-bootstrap-request', stream: false },
  response: { name: '@peartube/desktop-bootstrap-response', stream: false }
})

rpcNs.register({
  name: 'desktop-shutdown',
  request: { name: '@peartube/desktop-shutdown-request', stream: false },
  response: { name: '@peartube/desktop-shutdown-response', stream: false }
})

rpcNs.register({
  name: 'desktop-refresh-browse',
  request: { name: '@peartube/desktop-refresh-browse-request', stream: false },
  response: { name: '@peartube/desktop-refresh-browse-response', stream: false }
})

// FFmpeg decode availability
rpcNs.register({
  name: 'ffmpeg-decode-available',
  request: { name: '@peartube/ffmpeg-decode-available-request', stream: false },
  response: { name: '@peartube/ffmpeg-decode-available-response', stream: false }
})

// Channel avatar update
rpcNs.register({
  name: 'update-channel-avatar',
  request: { name: '@peartube/update-channel-avatar-request', stream: false },
  response: { name: '@peartube/update-channel-avatar-response', stream: false }
})

// Transcode operations
rpcNs.register({
  name: 'transcode-start',
  request: { name: '@peartube/transcode-start-request', stream: false },
  response: { name: '@peartube/transcode-start-response', stream: false }
})

rpcNs.register({
  name: 'transcode-stop',
  request: { name: '@peartube/transcode-stop-request', stream: false },
  response: { name: '@peartube/transcode-stop-response', stream: false }
})

rpcNs.register({
  name: 'transcode-status',
  request: { name: '@peartube/transcode-status-request', stream: false },
  response: { name: '@peartube/transcode-status-response', stream: false }
})

// Transcode progress event
rpcNs.register({
  name: 'event-transcode-progress',
  request: { name: '@peartube/event-transcode-progress', stream: false, send: true }
})

// Save HRPC interface to disk
HRPCBuilder.toDisk(builder)

// Generated JS is CommonJS because hyperschema/hrpc emit CommonJS runtime
// clients. Keep checked-in generated outputs lint-clean when lint:changed runs
// against newly tracked files.
{
  const fsLint = require('fs')
  const pathLint = require('path')
  const lintHeader = '/* eslint-disable @typescript-eslint/no-require-imports */\n'
  for (const generatedPath of [
    pathLint.join(SCHEMA_DIR, 'index.js'),
    pathLint.join(HRPC_DIR, 'index.js'),
    pathLint.join(HRPC_DIR, 'messages.js')
  ]) {
    let generatedSource = fsLint.readFileSync(generatedPath, 'utf-8')
    if (!generatedSource.startsWith(lintHeader)) {
      generatedSource = lintHeader + generatedSource
      fsLint.writeFileSync(generatedPath, generatedSource)
    }
  }
}

const { writeAppRpcAdapter } = require('./lib/app-rpc-adapter-codegen.cjs')
const appRpcMetadata = writeAppRpcAdapter({
  hrpcJsonPath: require('path').join(HRPC_DIR, 'hrpc.json'),
  outputPath: require('path').join(HRPC_DIR, 'app-rpc-adapter.mjs')
})

console.log('HRPC interface generated in', HRPC_DIR)
console.log('App RPC adapter generated with', appRpcMetadata.appCommands.length, 'app methods')

// Post-process: inject missing-handler guard into the dispatch loop.
// The RPC stream is hot from the moment the HRPC constructor runs, but
// handler registration is async — without the guard, any request that
// arrives before handlers are attached crashes with "is not a function".
{
  const fsPost = require('fs')
  const pathPost = require('path')
  const hrpcJsPath = pathPost.join(HRPC_DIR, 'index.js')
  let hrpcJs = fsPost.readFileSync(hrpcJsPath, 'utf-8')
  const guardLine = `      if (!command || typeof this._handlers[command] !== 'function') return\n`
  if (!hrpcJs.includes(guardLine)) {
    hrpcJs = hrpcJs.replace(
      '      const command = methods.get(req.command)\n      const responseEncoding',
      '      const command = methods.get(req.command)\n' + guardLine + '      const responseEncoding'
    )
    fsPost.writeFileSync(hrpcJsPath, hrpcJs)
  }
}
