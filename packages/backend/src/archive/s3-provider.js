function assertString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function responseError(response, operation) {
  const error = new Error(`S3 ${operation} failed with HTTP ${response.status}`)
  error.statusCode = response.status
  return error
}

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
  const config = Object.freeze({
    provider: 's3',
    bucket: typeof options.bucket === 'string' ? options.bucket : '',
    prefix: typeof options.prefix === 'string' ? options.prefix : '',
  })
  let requests = 0
  let failures = 0

  function getStatus() {
    return { ...config, requests, failures, healthy: failures === 0 }
  }
  async function request(operation, key, init = {}) {
    assertString(key, 'key')
    requests++
    try {
      const signed = await sign({ operation, key, method: init.method || 'GET', headers: init.headers || {} })
      const response = await fetchImpl(assertString(signed.url, 'signed.url'), {
        ...init,
        headers: { ...(init.headers || {}), ...(signed.headers || {}) },
      })
      if (!response.ok) throw responseError(response, operation)
      return response
    } catch (error) {
      failures++
      throw error
    }
  }

  return {
    getStatus,
    async putBlock({ key, data, contentHash }) {
      const headers = {}
      if (contentHash) headers['x-amz-checksum-sha256'] = contentHash
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
        if (error.statusCode === 404) {
          failures--
          return false
        }
        throw error
      }
    },

    async deleteBlock({ key }) {
      await request('delete', key, { method: 'DELETE' })
      return { success: true, key }
    },
  }
}
