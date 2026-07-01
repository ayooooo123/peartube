// Pure thumbnail-URL selection shared by the native feed/discover screens.
// Kept in plain .mjs (like feed-thumbnail-resolve-key.mjs) so the behavior can be
// unit-tested directly without transpiling the .ts wrapper.

const LOOPBACK_THUMBNAIL_URL_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//i

// A loopback blob-server URL is valid only for the backend process/port that
// minted it — after a restart (new port) or on another device it points at
// nothing. Such a URL must never be reused directly; it has to be re-resolved
// through a fresh HRPC call for the current process.
export function isLoopbackThumbnailUrl(value) {
  return typeof value === 'string' && LOOPBACK_THUMBNAIL_URL_RE.test(value)
}

export function hasThumbnailBlobRef(video) {
  return Boolean(video?.thumbnailBlobId && video?.thumbnailBlobsCoreKey)
}

export function getInlineThumbnailUrl(video) {
  const value = video?.thumbnailUrl || video?.thumbnail || null
  return typeof value === 'string' && value.length > 0 ? value : null
}

// Pick the URL to hand the <Image> loader for a feed/rail card.
//
// Order of preference:
//  1. A freshly-resolved current-process URL from the thumbnail cache.
//  2. A process-independent inline URL — a remote http(s) thumbnail (archived /
//     imported videos) or a self-contained data: URL. These render no matter
//     which backend process is alive, so prefer them even when blob refs exist.
//     (Regression guard: previously any video WITH blob refs discarded its inline
//     URL and forced a flaky blob resolve, so archived cards went blank while
//     blob-only cards rendered — "some load, others don't".)
//  3. Otherwise nothing: either there is no inline URL, or the only inline URL is
//     a stale loopback blob-server URL that must never paint. When blob refs are
//     present an HRPC resolve fills the cache (path 1) on a later pass.
export function getRenderableThumbnailUrl(video, cachedUrl, opts = { native: true }) {
  if (cachedUrl) return cachedUrl

  const inlineUrl = getInlineThumbnailUrl(video)
  if (opts && opts.native === false) return inlineUrl

  if (inlineUrl && !isLoopbackThumbnailUrl(inlineUrl)) return inlineUrl

  return null
}
