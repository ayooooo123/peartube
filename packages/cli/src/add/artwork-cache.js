const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15000

export class ArtworkCacheError extends Error {
  constructor (message, { code } = {}) {
    super(message)
    this.name = 'ArtworkCacheError'
    this.code = code
  }
}

// Downloads selected artwork with abort/time/size limits, requires image/*,
// stores bytes in channel blobs, and retains the remote provenance URL. Optional
// artwork failure is reported as a warning rather than aborting the row.
export function createArtworkCache ({
  fetch: fetchImpl,
  blobStore,
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('artwork cache requires fetch')
  if (!blobStore || typeof blobStore.put !== 'function') throw new Error('artwork cache requires a blob store')

  async function cacheOne (candidate) {
    const url = candidate.url
    if (!url) throw new ArtworkCacheError('artwork candidate has no url', { code: 'ERR_ARTWORK_NO_URL' })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await doFetch(url, { signal: controller.signal })
      if (!response.ok) {
        throw new ArtworkCacheError(`artwork request failed (${response.status})`, { code: 'ERR_ARTWORK_HTTP' })
      }
      const mime = String(response.headers?.get?.('content-type') || '').split(';')[0].trim()
      if (!/^image\//i.test(mime)) {
        throw new ArtworkCacheError(`artwork is not an image (${mime || 'unknown'})`, { code: 'ERR_ARTWORK_MIME' })
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > maxBytes) {
        throw new ArtworkCacheError(`artwork exceeds ${maxBytes} bytes`, { code: 'ERR_ARTWORK_TOO_LARGE' })
      }
      const blob = await blobStore.put(buffer, { mimeType: mime, role: candidate.role })
      return {
        role: candidate.role || 'poster',
        provider: candidate.provider || null,
        provenanceUrl: url,
        mimeType: mime,
        blobKey: blob.key || blob.blobKey || blob.id || null,
        bytes: buffer.length
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async cacheArtwork (candidates = [], { required = false } = {}) {
      const refs = []
      const warnings = []
      for (const candidate of candidates) {
        try {
          refs.push(await cacheOne(candidate))
        } catch (error) {
          if (required) throw error
          warnings.push({ role: candidate.role || null, url: candidate.url || null, code: error.code || 'ERR_ARTWORK', message: error.message })
        }
      }
      return { refs, warnings }
    }
  }
}
