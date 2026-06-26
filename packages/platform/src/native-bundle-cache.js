// BareKit's file-launch path expects the worklet filename itself to end in `.bundle`.
export const BACKEND_BUNDLE_FILENAME = 'backend.bundle'
export const DOWNLOADER_WORKER_FILENAME = 'downloader-worker.bundle.js'
export const BACKEND_BUNDLE_VERSION_FILENAME = 'backend-bundle.version'

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * FNV-1a 32-bit hash of an ASCII-bounded string. Matches OUR previously
 * persisted fingerprints exactly across runs so cache hits are deterministic.
 * @param {string} input
 * @returns {string} 8-character lower-hex digest
 */
export function fnv1aHashString(input) {
  if (typeof input !== 'string' || input.length === 0) return '00000000'
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff
    hash = Math.imul(hash, FNV_PRIME)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Compute a cheap content fingerprint that is stable for identical bundle
 * outputs and discriminative across builds. The native backend bundle is large,
 * but hashing the full string here is intentional: playback fixes often land in
 * the middle of the packed Bare bundle, and sampled edge hashes can miss those
 * edits, causing updated APKs to keep launching stale persisted worklets.
 * @param {string | null | undefined} source
 * @returns {string}
 */
export function fingerprintBundleSource(source) {
  if (typeof source !== 'string' || source.length === 0) return '0:00000000'
  const len = source.length
  return `${len}:${fnv1aHashString(source)}`
}

/**
 * Build a cache version key that includes a content fingerprint of the embedded
 * bundle sources. This guarantees that the persisted bundle cache is
 * invalidated whenever the embedded backend bundle changes between releases,
 * even if the app's marketing version and native build version do not change.
 *
 * Without this, two installs that share the same `version` and `versionCode`
 * (which is the default for a hand-managed `android/app/build.gradle`) would
 * keep launching the original cached bundle even after the embedded JS bundle
 * shipped fresh backend code.
 *
 * @param {{
 *   baseKey?: string | null | undefined,
 *   backendSource?: string | null | undefined,
 *   downloaderWorkerSource?: string | null | undefined,
 * }} options
 * @returns {string | undefined}
 */
export function buildBundleVersionKey(options = {}) {
  const baseKey = options.baseKey
  if (typeof baseKey !== 'string' || baseKey.length === 0) return undefined
  const backendFingerprint = fingerprintBundleSource(options.backendSource)
  const downloaderFingerprint = fingerprintBundleSource(options.downloaderWorkerSource)
  return `${baseKey}:b=${backendFingerprint}:w=${downloaderFingerprint}`
}

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
