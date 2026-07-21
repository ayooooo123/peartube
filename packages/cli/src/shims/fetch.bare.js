import https from 'bare-https'
import b4a from 'b4a'

// Minimal GET-only fetch() for the Bare relay runtime, which has no global
// fetch (so the TMDB classifier/discover client would otherwise silently
// disable themselves and never classify anything). Returns just enough of the
// WHATWG Response surface the callers touch — { ok, status, json(), text() } —
// backed by bare-https (TLS with CA roots bundled in the bare-tls addon, so it
// works even on the distroless relay image). Bare also lacks AbortController,
// so we enforce our own request timeout rather than relying on `signal`.
const DEFAULT_TIMEOUT_MS = 8000

export default function fetch (url, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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
      req = https.request(url, { method: 'GET' }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = b4a.toString(chunks.length === 1 ? chunks[0] : b4a.concat(chunks), 'utf8')
          const status = res.statusCode || 0
          finish(resolve, {
            ok: status >= 200 && status < 300,
            status,
            async json () { return JSON.parse(text) },
            async text () { return text }
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
    req.end()
  })
}
