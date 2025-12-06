/**
 * Platform Types
 *
 * Type definitions for the platform abstraction layer.
 * Includes RPC types derived from HRPC schema.
 */

/**
 * @typedef {'ios' | 'android' | 'pear-macos' | 'pear-windows' | 'pear-linux' | 'web' | 'bare'} PlatformType
 */

/**
 * Video stats from P2P download
 * @typedef {Object} VideoStats
 * @property {'connecting' | 'resolving' | 'downloading' | 'complete' | 'error' | 'unknown'} status
 * @property {number} progress - Download progress (0-100)
 * @property {number} totalBlocks - Total blocks in video
 * @property {number} downloadedBlocks - Downloaded blocks
 * @property {number} totalBytes - Total bytes
 * @property {number} downloadedBytes - Downloaded bytes
 * @property {number} peerCount - Connected peers
 * @property {string} speedMBps - Download speed
 * @property {string} [uploadSpeedMBps] - Upload speed
 * @property {number} elapsed - Elapsed time in ms
 * @property {boolean} isComplete - Whether download is complete
 */

/**
 * @typedef {'mobile' | 'desktop' | 'web'} PlatformCategory
 */

/**
 * @typedef {Object} LayoutInsets
 * @property {number} top - Space for status bar / title bar
 * @property {number} bottom - Space for home indicator / bottom nav
 * @property {number} left - Left safe area (notch devices)
 * @property {number} right - Right safe area (notch devices)
 */

/**
 * @typedef {Object} PlatformCapabilities
 * @property {boolean} hasFilePicker - Can pick files from filesystem
 * @property {boolean} hasCamera - Can access camera
 * @property {boolean} hasNotifications - Supports notifications
 * @property {boolean} hasBackgroundTasks - Supports background execution
 * @property {boolean} hasP2P - Supports P2P networking
 * @property {boolean} hasNativeUI - Uses native UI components
 */

/**
 * @typedef {Object} PlatformInfo
 * @property {PlatformType} type - Specific platform type
 * @property {PlatformCategory} category - Platform category
 * @property {LayoutInsets} insets - Layout insets for safe areas
 * @property {PlatformCapabilities} capabilities - Platform capabilities
 * @property {string} storagePath - Base storage path for app data
 */

/**
 * @typedef {Object} FilePickerResult
 * @property {boolean} cancelled - Whether user cancelled
 * @property {string} [filePath] - Path to selected file
 * @property {string} [name] - File name
 * @property {number} [size] - File size in bytes
 * @property {string} [mimeType] - MIME type
 * @property {string} [uri] - URI (mobile platforms)
 */

/**
 * @typedef {Object} FilePickerOptions
 * @property {string[]} [allowedTypes] - Allowed MIME types
 * @property {boolean} [multiple] - Allow multiple selection
 */

// Export empty object to make this a module
export {};
