/**
 * Platform Storage Module
 *
 * Provides platform-specific storage path utilities.
 */

import { detectPlatform, isBare, isPear } from './detection.js';

/**
 * @typedef {import('./types.js').PlatformType} PlatformType
 */

/**
 * Get the default storage directory for the platform
 *
 * @param {Object} [options]
 * @param {string} [options.appName='peartube'] - Application name for storage dir
 * @param {string} [options.providedPath] - Externally provided path (e.g., from Bare.argv)
 * @returns {string}
 */
export function getStoragePath(options = {}) {
  const { appName = 'peartube', providedPath } = options;

  // If a path was provided externally (e.g., from mobile app via Bare.argv)
  if (providedPath) {
    return providedPath;
  }

  const platform = detectPlatform();

  // Pear desktop - use Pear.config.storage
  if (isPear()) {
    try {
      return globalThis.Pear?.config?.storage || `./storage`;
    } catch (e) {
      return `./storage`;
    }
  }

  // Bare runtime (mobile backend) - should receive path from argv
  if (isBare()) {
    try {
      return globalThis.Bare?.argv?.[0] || `./storage`;
    } catch (e) {
      return `./storage`;
    }
  }

  // Platform-specific defaults (these are fallbacks, real paths come from native)
  switch (platform) {
    case 'pear-macos':
      return `~/Library/Application Support/${appName}`;
    case 'pear-windows':
      return `%APPDATA%/${appName}`;
    case 'pear-linux':
      return `~/.config/${appName}`;
    case 'ios':
      // iOS documents directory - must be provided by native
      return `./Documents/${appName}`;
    case 'android':
      // Android files directory - must be provided by native
      return `./files/${appName}`;
    default:
      return `./storage`;
  }
}

/**
 * Get the data subdirectory for P2P storage (corestore, drives, etc.)
 *
 * @param {string} basePath - Base storage path
 * @returns {string}
 */
export function getDataPath(basePath) {
  return `${basePath}/data`;
}

/**
 * Get the cache directory
 *
 * @param {string} basePath - Base storage path
 * @returns {string}
 */
export function getCachePath(basePath) {
  return `${basePath}/cache`;
}

/**
 * Get the logs directory
 *
 * @param {string} basePath - Base storage path
 * @returns {string}
 */
export function getLogsPath(basePath) {
  return `${basePath}/logs`;
}

/**
 * Get the temp directory for uploads
 *
 * @param {string} basePath - Base storage path
 * @returns {string}
 */
export function getTempPath(basePath) {
  return `${basePath}/temp`;
}

/**
 * Storage path configuration
 *
 * @param {string} basePath - Base storage path
 * @returns {Object}
 */
export function getStoragePaths(basePath) {
  return {
    base: basePath,
    data: getDataPath(basePath),
    cache: getCachePath(basePath),
    logs: getLogsPath(basePath),
    temp: getTempPath(basePath)
  };
}
