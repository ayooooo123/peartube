// BareKit's file-launch path expects the worklet filename itself to end in `.bundle`.
export const BACKEND_BUNDLE_FILENAME = 'backend.bundle'
export const DOWNLOADER_WORKER_FILENAME = 'downloader-worker.bundle.js'
export const BACKEND_BUNDLE_VERSION_FILENAME = 'backend-bundle.version'

/**
 * @param {string} uri
 * @returns {string}
 */
function ensureTrailingSlash(uri) {
  return uri.endsWith('/') ? uri : `${uri}/`
}

/**
 * @param {string} storageUri
 */
export function createBundleCachePaths(storageUri) {
  const baseUri = ensureTrailingSlash(storageUri)

  return {
    backendBundleUri: `${baseUri}${BACKEND_BUNDLE_FILENAME}`,
    downloaderWorkerUri: `${baseUri}${DOWNLOADER_WORKER_FILENAME}`,
    versionMarkerUri: `${baseUri}${BACKEND_BUNDLE_VERSION_FILENAME}`,
  }
}

/**
 * @param {string} uri
 * @returns {string}
 */
export function normalizeBundleFilePath(uri) {
  return uri.startsWith('file://') ? uri.slice(7) : uri
}

/**
 * @param {{
 *   expectedVersionKey: string,
 *   cachedVersionKey: string | null,
 *   backendBundleExists: boolean,
 *   downloaderWorkerExists: boolean,
 *   needsDownloaderWorker: boolean
 * }} options
 * @returns {boolean}
 */
export function shouldReusePersistedBundleCache({
  expectedVersionKey,
  cachedVersionKey,
  backendBundleExists,
  downloaderWorkerExists,
  needsDownloaderWorker,
}) {
  if (!expectedVersionKey || !cachedVersionKey) return false
  if (expectedVersionKey !== cachedVersionKey) return false
  if (!backendBundleExists) return false
  if (needsDownloaderWorker && !downloaderWorkerExists) return false
  return true
}
