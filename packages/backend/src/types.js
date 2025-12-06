/**
 * Backend Core Types
 *
 * Type definitions for the shared backend core module.
 * Uses JSDoc for type safety in pure JavaScript.
 */

/**
 * @typedef {Object} StorageConfig
 * @property {string} storagePath - Path to storage directory
 * @property {number} [defaultTimeout=30000] - Default timeout for core operations
 */

/**
 * @typedef {Object} StorageContext
 * @property {import('corestore')} store - Corestore instance
 * @property {import('hyperbee')} metaDb - Metadata database (Hyperbee)
 * @property {import('hyperswarm')} swarm - Hyperswarm instance
 * @property {import('hypercore-blob-server')} blobServer - Blob server instance
 * @property {number} blobServerPort - Blob server port
 * @property {Map<string, import('hyperdrive')>} drives - Loaded drives cache
 */

/**
 * @typedef {Object} VideoStatsData
 * @property {string} driveKey - Channel/drive key
 * @property {string} videoPath - Path to video in drive
 * @property {'idle'|'connecting'|'resolving'|'downloading'|'complete'|'error'|'unknown'} status
 * @property {number} totalBlocks - Total blocks in video
 * @property {number} downloadedBlocks - Downloaded blocks count
 * @property {number} totalBytes - Total bytes
 * @property {number} downloadedBytes - Downloaded bytes
 * @property {number} peerCount - Connected peers
 * @property {number} [startTime] - When download started
 * @property {number} lastUpdate - Last update timestamp
 * @property {number} [initialBlocks] - Blocks already local when monitoring started
 * @property {string} [error] - Error message if any
 */

/**
 * @typedef {Object} VideoStats
 * @property {'connecting'|'resolving'|'downloading'|'complete'|'error'|'unknown'} status
 * @property {number} progress - Download progress percentage
 * @property {number} totalBlocks - Total blocks
 * @property {number} downloadedBlocks - Downloaded blocks
 * @property {number} totalBytes - Total bytes
 * @property {number} downloadedBytes - Downloaded bytes
 * @property {number} peerCount - Peer count
 * @property {string} speedMBps - Download speed in MB/s
 * @property {string} [uploadSpeedMBps] - Upload speed in MB/s
 * @property {number} elapsed - Elapsed time in seconds
 * @property {boolean} isComplete - Whether download is complete
 * @property {string} [error] - Error message if any
 */

/**
 * @typedef {Object} SeedingConfig
 * @property {number} maxStorageGB - Max storage for seeded content
 * @property {boolean} autoSeedWatched - Auto-seed watched videos
 * @property {boolean} autoSeedSubscribed - Auto-seed subscribed channels
 * @property {number} maxVideosPerChannel - Max videos to seed per channel
 */

/**
 * @typedef {Object} SeedInfo
 * @property {string} driveKey - Drive key
 * @property {string} videoPath - Video path
 * @property {'watched'|'pinned'|'subscribed'} reason - Why this is being seeded
 * @property {number} addedAt - When added
 * @property {number} blocks - Block count
 * @property {number} bytes - Byte count
 */

/**
 * @typedef {Object} PublicFeedEntry
 * @property {string} driveKey - Channel drive key
 * @property {number} addedAt - When discovered
 * @property {'peer'|'local'} source - How discovered
 */

/**
 * @typedef {Object} ChannelMetadata
 * @property {string} [name] - Channel name
 * @property {string} [description] - Channel description
 * @property {string} [thumbnail] - Thumbnail path
 * @property {number} [videoCount] - Number of videos
 * @property {string} [driveKey] - Drive key
 */

/**
 * @typedef {Object} Identity
 * @property {string} publicKey - Identity public key
 * @property {string} [driveKey] - Associated drive key
 * @property {string} [name] - Display name
 * @property {number} createdAt - Creation timestamp
 * @property {string} [secretKey] - Secret key (if writable)
 * @property {boolean} [isActive] - Whether this is the active identity
 */

/**
 * @typedef {Object} VideoMetadata
 * @property {string} id - Video ID
 * @property {string} title - Video title
 * @property {string} description - Video description
 * @property {string} path - Path in drive
 * @property {number} size - File size in bytes
 * @property {string} [mimeType] - MIME type
 * @property {number} uploadedAt - Upload timestamp
 * @property {string} [channelKey] - Channel key
 * @property {number} [duration] - Duration in seconds
 * @property {string} [thumbnail] - Thumbnail path
 */

export const FEED_TOPIC_STRING = 'peartube-public-feed-v1';
export const PROTOCOL_NAME = 'peartube-feed';
