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
    { name: 'seedPhrase', type: 'string', required: true }
  ]
})

ns.register({
  name: 'recover-identity-response',
  fields: [
    { name: 'identity', type: '@peartube/identity', required: true }
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
    { name: 'category', type: 'string', required: false }
  ]
})

ns.register({
  name: 'list-videos-request',
  fields: [
    { name: 'channelKey', type: 'string', required: false },
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
    { name: 'videoId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'get-video-url-response',
  fields: [
    { name: 'url', type: 'string', required: true }
  ]
})

ns.register({
  name: 'get-video-data-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true }
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
    { name: 'destPath', type: 'string', required: true }
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
  name: 'feed-entry',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'channelName', type: 'string', required: false },
    { name: 'videoCount', type: 'uint', required: false },
    { name: 'peerCount', type: 'uint', required: false },
    { name: 'lastSeen', type: 'uint', required: false }
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
    { name: 'channelKey', type: 'string', required: true }
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
    { name: 'peerCount', type: 'uint', required: false }
  ]
})

// ============================================
// Video Prefetch & Stats Types
// ============================================

ns.register({
  name: 'prefetch-video-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true }
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
    { name: 'pinnedCount', type: 'uint', required: true }
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

// ============================================
// Thumbnail/Metadata Types
// ============================================

ns.register({
  name: 'get-video-thumbnail-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true }
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

ns.register({
  name: 'status',
  fields: [
    { name: 'ready', type: 'bool', required: true },
    { name: 'hasIdentity', type: 'bool', required: false },
    { name: 'blobServerPort', type: 'uint', required: false }
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
// Search, Comments, Reactions, Recommendations
// ============================================

ns.register({
  name: 'search-result',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'score', type: 'string', required: false }, // float encoded as string for portability
    { name: 'metadata', type: 'string', required: false } // JSON string
  ]
})

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
  name: 'index-video-vectors-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'index-video-vectors-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'comment',
  fields: [
    { name: 'videoId', type: 'string', required: true },
    { name: 'commentId', type: 'string', required: true },
    { name: 'text', type: 'string', required: true },
    { name: 'authorKeyHex', type: 'string', required: true },
    { name: 'timestamp', type: 'uint', required: false },
    { name: 'parentId', type: 'string', required: false }
  ]
})

ns.register({
  name: 'add-comment-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'text', type: 'string', required: true },
    { name: 'parentId', type: 'string', required: false }
  ]
})

ns.register({
  name: 'add-comment-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'commentId', type: 'string', required: false },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'list-comments-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'page', type: 'uint', required: false },
    { name: 'limit', type: 'uint', required: false }
  ]
})

ns.register({
  name: 'list-comments-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'comments', type: '@peartube/comment', array: true, required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'hide-comment-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'commentId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'hide-comment-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'remove-comment-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true },
    { name: 'commentId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'remove-comment-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

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
    { name: 'reactionType', type: 'string', required: true }
  ]
})

ns.register({
  name: 'add-reaction-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'remove-reaction-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'remove-reaction-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'get-reactions-request',
  fields: [
    { name: 'channelKey', type: 'string', required: true },
    { name: 'videoId', type: 'string', required: true }
  ]
})

ns.register({
  name: 'get-reactions-response',
  fields: [
    { name: 'success', type: 'bool', required: true },
    { name: 'counts', type: '@peartube/reaction-count', array: true, required: true },
    { name: 'userReaction', type: 'string', required: false },
    { name: 'error', type: 'string', required: false }
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
    { name: 'success', type: 'bool', required: true },
    { name: 'error', type: 'string', required: false }
  ]
})

ns.register({
  name: 'recommendation',
  fields: [
    { name: 'videoId', type: 'string', required: true },
    { name: 'score', type: 'string', required: false }, // float encoded as string
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
    { name: 'success', type: 'bool', required: true },
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
    { name: 'success', type: 'bool', required: true },
    { name: 'recommendations', type: '@peartube/recommendation', array: true, required: true },
    { name: 'error', type: 'string', required: false }
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
    { name: 'code', type: 'uint', required: false },
    { name: 'message', type: 'string', required: true }
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

// Search commands
rpcNs.register({
  name: 'search-videos',
  request: { name: '@peartube/search-videos-request', stream: false },
  response: { name: '@peartube/search-videos-response', stream: false }
})

rpcNs.register({
  name: 'index-video-vectors',
  request: { name: '@peartube/index-video-vectors-request', stream: false },
  response: { name: '@peartube/index-video-vectors-response', stream: false }
})

// Comments commands
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

// Reactions commands
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

// Recommendations commands
rpcNs.register({
  name: 'log-watch-event',
  request: { name: '@peartube/log-watch-event-request', stream: false },
  response: { name: '@peartube/log-watch-event-response', stream: false }
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

// Event streams (send-only, no response expected)
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

// Save HRPC interface to disk
HRPCBuilder.toDisk(builder)

console.log('HRPC interface generated in', HRPC_DIR)
