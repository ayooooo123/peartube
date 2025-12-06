/**
 * Platform Abstraction Layer
 *
 * Provides platform detection and utilities for PearTube.
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
