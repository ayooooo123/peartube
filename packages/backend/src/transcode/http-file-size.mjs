/**
 * Get file size from HTTP HEAD/Range request
 */

import http from 'bare-http1'

export async function getHttpFileSize(url) {
  return new Promise((resolve, reject) => {
    let parsedUrl
    try {
      parsedUrl = new URL(url)
    } catch (e) {
      reject(new Error(`Invalid URL: ${url}`))
      return
    }

    const options = {
      method: 'GET',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'Range': 'bytes=0-0'
      }
    }

    const req = http.request(options, (res) => {
      const contentRange = res.headers['content-range']
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/)
        if (match) {
          const size = parseInt(match[1], 10)
          res.on('data', () => {})
          res.on('end', () => resolve(size))
          return
        }
      }

      const contentLength = parseInt(res.headers['content-length'], 10) || 0
      res.on('data', () => {})
      res.on('end', () => resolve(contentLength))
    })

    req.on('error', reject)
    req.setTimeout(30000, () => {
      req.destroy()
      reject(new Error('HTTP timeout'))
    })
    req.end()
  })
}
