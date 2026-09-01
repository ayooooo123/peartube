function assertString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function responseError(response, operation) {
  const error = new Error(`S3 ${operation} failed with HTTP ${response.status}`)
  error.statusCode = response.status
  return error
}

// Archiving one title is hundreds of block requests, and an object store will
// occasionally reset a connection or answer 500/503. Without a retry a single
// transient blip fails the whole archive - which is exactly what happened here:
// a bare `fetch failed` part-way through a 20 MiB title.
//
// Every operation this provider issues is idempotent - blocks are addressed by
// core and index and their bytes are fixed - so a retry can never write
// something different from what the first attempt would have written.
const MAX_ATTEMPTS = 4
const RETRY_BASE_MS = 200
const MAX_GET_ATTEMPTS = 2
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000

// 4xx is the caller's fault and will fail identically forever; 408 and 429 are
// the exceptions the spec carves out for "come back later".
function isRetryable(error) {
  const status = error?.statusCode
  if (status === undefined) return true // network-level: no response at all
  if (status === 408 || status === 429) return true
  return status >= 500
}

function backoffMs(attempt) {
  // Exponential with jitter, so a relay retrying many blocks at once does not
  // resend them all on the same beat.
  return (RETRY_BASE_MS * (2 ** (attempt - 1))) * (0.5 + Math.random())
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * S3 archive access through presigned URLs.
 *
 * Signing stays outside the backend so this works in Bare and desktop runtimes
 * without pulling a Node-only AWS SDK into the universal backend.
 */
export function createS3ArchiveProvider(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required')
  const sign = options.sign
  if (typeof sign !== 'function') throw new TypeError('sign is required')
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000) {
    throw new TypeError('requestTimeoutMs must be between 1 and 60000')
  }
  async function attempt(operation, key, init) {
    const signed = await sign({ operation, key, method: init.method || 'GET', headers: init.headers || {} })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
    try {
      const response = await fetchImpl(assertString(signed.url, 'signed.url'), {
        ...init,
        headers: { ...(init.headers || {}), ...(signed.headers || {}) },
        signal: controller.signal,
      })
      if (!response.ok) throw responseError(response, operation)
      return response
    } catch (error) {
      if (controller.signal.aborted) {
        const timeoutError = new Error(`S3 ${operation} timed out`)
        timeoutError.code = 'S3_REQUEST_TIMEOUT'
        throw timeoutError
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
  async function request(operation, key, init = {}) {
    assertString(key, 'key')
    const maxAttempts = operation === 'get' ? MAX_GET_ATTEMPTS : MAX_ATTEMPTS
    for (let n = 1; ; n++) {
      try {
        return await attempt(operation, key, init)
      } catch (error) {
        // A HEAD that answers 404 is a normal answer to "is this block here?",
        // and hasBlock() reads it as `false`. Retrying it would turn every
        // absent block into four requests and a delay.
        if (n >= maxAttempts || !isRetryable(error)) throw error
        await sleep(backoffMs(n))
      }
    }
  }

  return {
    /**
     * `checksumSha256Base64` is named for its exact wire format because that
     * is the whole contract: S3 wants the BASE64 of the raw SHA-256 digest.
     * A hex digest, or a hash that is not SHA-256, is rejected outright -
     * Backblaze answers `400 InvalidDigest` - so a vaguely named "hash"
     * parameter here is a live foot-gun rather than a convenience.
     */
    async putBlock({ key, data, checksumSha256Base64 }) {
      const headers = {}
      if (checksumSha256Base64) headers['x-amz-checksum-sha256'] = checksumSha256Base64
      await request('put', key, { method: 'PUT', headers, body: data })
      return { success: true, key }
    },

    async getBlock({ key, range } = {}) {
      const headers = range ? { Range: `bytes=${range.start}-${range.end ?? ''}` } : {}
      const response = await request('get', key, { headers })
      return response.arrayBuffer()
    },
    async hasBlock({ key }) {
      try {
        await request('head', key, { method: 'HEAD' })
        return true
      } catch (error) {
        if (error.statusCode === 404) return false
        throw error
      }
    },

    async deleteBlock({ key }) {
      await request('delete', key, { method: 'DELETE' })
      return { success: true, key }
    },
  }
}
