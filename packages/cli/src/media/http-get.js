import { request as httpsRequest } from '#https'
import { request as httpRequest } from '#http'
import b4a from 'b4a'

// The HTTP client the relay actually has.
//
// Bare ships no global `fetch` and no global `AbortController`. A `fetch(...)`
// anywhere in the relay's graph is therefore a ReferenceError the moment the
// relay runs, and the test suite — which runs on Node, where both exist — is
// structurally incapable of noticing. Everything the relay pulls over HTTP goes
// through the #http/#https shims instead, which is the path the direct media
// downloader has used in production since before there was a machine API.
//
// This module carries NO SSRF guard and must only be aimed at an origin the
// relay itself chose. A stranger's url belongs to direct-download.js, which
// drives `requestOnce` one hop at a time precisely so it can re-check the
// address between hops and read the socket before the body; a client that
// follows redirects for you skips both of those silently.

const DEFAULT_MAX_REDIRECTS = 3

function requestFor (url) {
  return new URL(url).protocol === 'http:' ? httpRequest : httpsRequest
}

// One request, no redirect handling: the caller decides what to do with a 3xx,
// which is what lets a guarded caller re-check a hop before following it.
export function requestOnce (url, { headers = {}, timeoutMs = 0, timeoutMessage = 'HTTP request timed out' } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const doRequest = requestFor(url)
    let req
    try {
      req = doRequest(url, { method: 'GET', headers }, (res) => { settled = true; resolve(res) })
    } catch (err) {
      reject(err)
      return
    }
    // A timer plus `destroy` rather than an abort signal: Bare has no
    // AbortController, and this is the mechanism the transport offers anyway.
    if (timeoutMs > 0) {
      const timer = setTimeout(() => { if (!settled) { req.destroy?.(new Error(timeoutMessage)) } }, timeoutMs)
      timer?.unref?.()
    }
    req.on('error', (err) => { if (!settled) reject(err) })
    req.end()
  })
}

// Follows redirects and hands back the live response with its body unread, so
// the caller can refuse on status, content-type or content-length before a
// single byte is pulled.
export async function openResponse (url, {
  headers = {},
  timeoutMs = 0,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  timeoutMessage
} = {}) {
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const res = await requestOnce(current, { headers, timeoutMs, timeoutMessage })
    const status = res.statusCode || 0
    if (status >= 300 && status < 400 && res.headers?.location) {
      const next = new URL(res.headers.location, current).toString()
      res.destroy?.()
      current = next
      continue
    }
    return { res, finalUrl: current }
  }
  throw new Error('too many redirects')
}

// Buffers a bounded body. `maxBytes` is a hard stop on what is actually read
// rather than a check on the declared length, because content-length is the
// server's claim and this runs against origins the relay does not control.
export function readBody (res, { maxBytes = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let read = 0
    let done = false
    const finish = (err, value) => {
      if (done) return
      done = true
      if (err) reject(err); else resolve(value)
    }
    res.on('data', (chunk) => {
      read += chunk.byteLength ?? chunk.length ?? 0
      if (maxBytes > 0 && read > maxBytes) {
        res.destroy?.()
        finish(new Error(`response exceeded the ${maxBytes} byte ceiling`))
        return
      }
      chunks.push(chunk)
    })
    res.on('end', () => finish(null, chunks.length === 1 ? chunks[0] : b4a.concat(chunks)))
    res.on('error', (err) => finish(err))
  })
}
