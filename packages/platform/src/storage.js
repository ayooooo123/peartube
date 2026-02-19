/**
 * Platform Storage Module
 *
 * Provides platform-specific storage path utilities.
 * Uses bare-storage for cross-platform directory resolution when running
 * in Bare/Pear runtime, with fallbacks for web/React Native contexts.
 */

import { detectPlatform, isBare, isPear } from './detection.js';

/**
 * @typedef {import('./types.js').PlatformType} PlatformType
 */

/** @type {any} */
let _bareStorage = null;
let _bareStorageLoaded = false;

function getBareStorage() {
  if (_bareStorageLoaded) return _bareStorage;
  _bareStorageLoaded = true;
  try {
    _bareStorage = require('bare-storage');
  } catch {}
  return _bareStorage;
}

/**
 * Get the default storage directory for the platform
 *
 * Uses bare-storage.persistent() for cross-platform path resolution in Bare
 * runtime. Falls back to manual paths for web/React Native contexts.
 *
 * @param {Object} [options]
 * @param {string} [options.appName='peartube'] - Application name for storage dir
 * @param {string} [options.providedPath] - Externally provided path (e.g., from Bare.argv)
 * @returns {string}
 */
export function getStoragePath(options = {}) {
  const { appName = 'peartube', providedPath } = options;

  if (providedPath) {
    return providedPath;
  }

  // Pear desktop - use Pear.config.storage (set via --store flag)
  if (isPear()) {
    try {
      const pearStorage = globalThis.Pear?.config?.storage;
      if (pearStorage) return pearStorage;
    } catch {}
  }

  // Bare/Pear runtime - use bare-storage for cross-platform path resolution
  if (isBare() || isPear()) {
    const bs = getBareStorage();
    if (bs) return `${bs.persistent()}/${appName}`;
  }

  // Bare runtime without bare-storage - check argv
  if (isBare()) {
    try {
      const arg0 = globalThis.Bare?.argv?.[0];
      if (typeof arg0 === 'string' && arg0.length > 0) return arg0;
    } catch {}
  }

  return `./storage`;
}

/**
 * Get a platform-appropriate ephemeral (cache/temp) directory.
 *
 * Uses bare-storage.ephemeral() when available. Data stored here may be
 * wiped by the OS during storage pressure.
 *
 * @param {Object} [options]
 * @param {string} [options.appName='peartube'] - Application name for cache dir
 * @returns {string}
 */
export function getEphemeralPath(options = {}) {
  const { appName = 'peartube' } = options;

  const bs = getBareStorage();
  if (bs) {
    return `${bs.ephemeral()}/${appName}`;
  }

  // Fallback: use base storage + /cache
  return `${getStoragePath(options)}/cache`;
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
