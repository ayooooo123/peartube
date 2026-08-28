import b4a from 'b4a'

// Minimal fetch() for the Bare relay runtime, which has no global fetch.
// Supports GET, PUT, POST, DELETE, HEAD with headers, request bodies,
// and WHATWG Response surface — { ok, status, headers, json(), text(), arrayBuffer() }.
//
// bare-https (and its bare-tls addon) is loaded LAZILY on first use, inside a
// guard, and never at module-eval time. This is deliberate: this module is in
// the relay service's import graph, so a top-level addon import that failed to
// load (missing prebuild, runtime lib, etc.) would crash relay startup and take
// the whole web UI down. Lazy loading degrades a broken TLS stack to "TMDB
// disabled" instead of a dead relay. Bare also lacks AbortController, so we
// enforce our own request timeout rather than relying on `signal`.
const DEFAULT_TIMEOUT_MS = 8000

let httpsPromise = null
let httpPromise = null

function loadClient (isHttps) {
  if (isHttps) {
    if (!httpsPromise) {
      httpsPromise = import('bare-https')
        .then((mod) => mod?.default ?? mod)
        .catch(() => null)
    }
    return httpsPromise
  }
  if (!httpPromise) {
    httpPromise = import('bare-http1')
      .then((mod) => mod?.default ?? mod)
      .catch(() => null)
  }
  return httpPromise
}
export default async function fetch (url, { method = 'GET', headers = {}, body = null, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const targetUrl = typeof url === 'string' ? new URL(url) : url
  const isHttps = targetUrl.protocol === 'https:'
  const client = await loadClient(isHttps)
  if (!client || typeof client.request !== 'function') {
    throw new Error(`${isHttps ? 'bare-https' : 'bare-http1'} is unavailable in this runtime`)
  }

  return new Promise((resolve, reject) => {
    let settled = false

    const cleanup = () => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener?.('abort', onAbort)
    }
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      cleanup()
      fn(arg)
    }
    const fail = (err) => {
      req?.destroy?.(err)
      finish(reject, err)
    }

    const onAbort = () => fail(new Error('fetch aborted'))
    const timer = setTimeout(() => fail(new Error('fetch timeout')), timeoutMs)
    timer?.unref?.()

    let req
    try {
      req = client.request(targetUrl, { method, headers }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const raw = chunks.length === 1 ? chunks[0] : b4a.concat(chunks)
          const status = res.statusCode || 0
          finish(resolve, {
            ok: status >= 200 && status < 300,
            status,
            headers: res.headers || {},
            async arrayBuffer () {
              const buf = b4a.isBuffer(raw) ? raw : b4a.from(raw)
              return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
            },
            async text () { return b4a.toString(raw, 'utf8') },
            async json () { return JSON.parse(b4a.toString(raw, 'utf8')) }
          })
        })
        res.on('error', fail)
      })
    } catch (err) {
      finish(reject, err)
      return
    }

    req.on('error', fail)
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener?.('abort', onAbort, { once: true })
    }

    if (body) {
      if (b4a.isBuffer(body) || typeof body === 'string' || body instanceof Uint8Array) {
        req.write(body)
      }
    }
    req.end()
  })
}
