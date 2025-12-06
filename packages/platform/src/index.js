/**
 * Platform Abstraction Layer
 *
 * Provides platform detection, storage utilities, and RPC abstraction for PearTube.
 * Works across desktop (Pear), mobile (React Native), and web.
 */

// Platform detection
export {
  isBare,
  isPear,
  isReactNative,
  isWeb,
  isDesktop,
  isMobile,
  detectPlatform,
  getPlatformCategory,
  getLayoutInsets,
  getPlatformCapabilities,
  getPlatformInfo,
  currentPlatform,
  currentCategory,
  currentCapabilities
} from './detection.js';

// Storage utilities
export {
  getStoragePath,
  getDataPath,
  getCachePath,
  getLogsPath,
  getTempPath,
  getStoragePaths
} from './storage.js';

// Re-export types (for documentation/JSDoc purposes)
export * from './types.js';

// RPC is exported from platform-specific files:
// - rpc.native.ts for React Native (mobile)
// - rpc.web.ts for Pear (desktop)
// Apps should import from the appropriate file based on platform.
