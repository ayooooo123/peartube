/**
 * Platform Detection Module
 *
 * Detects the current platform and provides platform-specific information.
 * Works in both frontend (React Native / Web) and backend (Bare / Pear) contexts.
 */

/**
 * @typedef {import('./types.js').PlatformType} PlatformType
 * @typedef {import('./types.js').PlatformCategory} PlatformCategory
 * @typedef {import('./types.js').LayoutInsets} LayoutInsets
 * @typedef {import('./types.js').PlatformCapabilities} PlatformCapabilities
 * @typedef {import('./types.js').PlatformInfo} PlatformInfo
 */

// Pear title bar heights
const PEAR_TITLE_BAR_MACOS = 28;
const PEAR_TITLE_BAR_WINDOWS = 38;
const PEAR_TITLE_BAR_LINUX = 38;

/**
 * Check if running in Bare runtime (backend)
 * @returns {boolean}
 */
export function isBare() {
  return typeof globalThis.Bare !== 'undefined';
}

/**
 * Check if running in Pear runtime (desktop app)
 * @returns {boolean}
 */
export function isPear() {
  return typeof globalThis.Pear !== 'undefined';
}

/**
 * Check if running in React Native
 * @returns {boolean}
 */
export function isReactNative() {
  return typeof navigator !== 'undefined' &&
         navigator.product === 'ReactNative';
}

/**
 * Check if running in a web browser
 * @returns {boolean}
 */
export function isWeb() {
  return typeof window !== 'undefined' &&
         typeof document !== 'undefined' &&
         !isPear() &&
         !isReactNative();
}

/**
 * Detect the specific platform type
 * @returns {PlatformType}
 */
export function detectPlatform() {
  // Backend contexts
  if (isBare()) {
    return 'bare';
  }

  // Pear desktop app
  if (isPear()) {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
    if (ua.includes('mac')) return 'pear-macos';
    if (ua.includes('win')) return 'pear-windows';
    return 'pear-linux';
  }

  // React Native
  if (isReactNative()) {
    // Check Platform.OS if available
    try {
      const { Platform } = require('react-native');
      if (Platform.OS === 'ios') return 'ios';
      if (Platform.OS === 'android') return 'android';
    } catch (e) {
      // React Native not available
    }
    return 'ios'; // Default assumption
  }

  // Regular web browser
  return 'web';
}

/**
 * Get the platform category
 * @param {PlatformType} platform
 * @returns {PlatformCategory}
 */
export function getPlatformCategory(platform) {
  switch (platform) {
    case 'ios':
    case 'android':
      return 'mobile';
    case 'pear-macos':
    case 'pear-windows':
    case 'pear-linux':
      return 'desktop';
    case 'bare':
      return 'desktop'; // Bare runs on desktop as backend
    case 'web':
    default:
      return 'web';
  }
}

/**
 * Get layout insets for the platform
 * @param {PlatformType} platform
 * @returns {LayoutInsets}
 */
export function getLayoutInsets(platform) {
  switch (platform) {
    case 'pear-macos':
      return { top: PEAR_TITLE_BAR_MACOS, bottom: 0, left: 0, right: 0 };
    case 'pear-windows':
    case 'pear-linux':
      return { top: PEAR_TITLE_BAR_WINDOWS, bottom: 0, left: 0, right: 0 };
    case 'ios':
      // iOS insets are dynamic, should use SafeAreaContext
      return { top: 47, bottom: 34, left: 0, right: 0 };
    case 'android':
      // Android status bar is typically 24dp
      return { top: 24, bottom: 0, left: 0, right: 0 };
    default:
      return { top: 0, bottom: 0, left: 0, right: 0 };
  }
}

/**
 * Get platform capabilities
 * @param {PlatformType} platform
 * @returns {PlatformCapabilities}
 */
export function getPlatformCapabilities(platform) {
  switch (platform) {
    case 'pear-macos':
    case 'pear-windows':
    case 'pear-linux':
      return {
        hasFilePicker: true,
        hasCamera: false,
        hasNotifications: true,
        hasBackgroundTasks: true,
        hasP2P: true,
        hasNativeUI: false
      };
    case 'ios':
    case 'android':
      return {
        hasFilePicker: true,
        hasCamera: true,
        hasNotifications: true,
        hasBackgroundTasks: false, // Limited on mobile
        hasP2P: true,
        hasNativeUI: true
      };
    case 'bare':
      return {
        hasFilePicker: false,
        hasCamera: false,
        hasNotifications: false,
        hasBackgroundTasks: true,
        hasP2P: true,
        hasNativeUI: false
      };
    case 'web':
    default:
      return {
        hasFilePicker: true,
        hasCamera: true,
        hasNotifications: true,
        hasBackgroundTasks: false,
        hasP2P: false,
        hasNativeUI: false
      };
  }
}

/**
 * Get full platform information
 * @returns {PlatformInfo}
 */
export function getPlatformInfo() {
  const type = detectPlatform();
  return {
    type,
    category: getPlatformCategory(type),
    insets: getLayoutInsets(type),
    capabilities: getPlatformCapabilities(type),
    storagePath: '' // Set by platform-specific initialization
  };
}

/**
 * Check if platform is desktop (Pear)
 * @param {PlatformType} [platform]
 * @returns {boolean}
 */
export function isDesktop(platform) {
  const p = platform || detectPlatform();
  return p.startsWith('pear-');
}

/**
 * Check if platform is mobile (iOS/Android)
 * @param {PlatformType} [platform]
 * @returns {boolean}
 */
export function isMobile(platform) {
  const p = platform || detectPlatform();
  return p === 'ios' || p === 'android';
}

// Export singleton values for quick access
export const currentPlatform = detectPlatform();
export const currentCategory = getPlatformCategory(currentPlatform);
export const currentCapabilities = getPlatformCapabilities(currentPlatform);
