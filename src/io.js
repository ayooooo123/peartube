// Shared private-disk and HTTP plumbing kept wet in one place instead of five dry copies across src/.
import { writeFileSync, renameSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import b4a from 'b4a'

// Atomic 0600 JSON swap so a crash mid-stroke never leaves a half-written private file gaping on disk.
export function writeJsonAtomic (file, data, space = 0) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, space), { mode: 0o600 })
  renameSync(tmp, file)
}

// Single redirect-aware HTTP/HTTPS pipe for Node and Bare QuickJS worklets alike.
export function send (url, { method = 'GET', headers = {}, body = null, timeoutMs = 10_000, redirects = 0, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch { return reject(new Error('Not a valid link')) }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('Only http(s) links can be added'))
    const payload = body === null || body === undefined
      ? null
      : (b4a.isBuffer(body) ? body : (typeof body === 'string' ? b4a.from(body) : b4a.from(JSON.stringify(body))))
    const reqHeaders = { 'user-agent': 'PearTube', ...headers }
    if (payload) {
      if (!reqHeaders['content-type']) reqHeaders['content-type'] = 'application/json'
      reqHeaders['content-length'] = String(payload.byteLength)
    }
    let settled = false
    const done = (err, val) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      err ? reject(err) : resolve(val)
    }
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method, headers: reqHeaders }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5 && (method === 'GET' || method === 'HEAD')) {
        res.resume?.()
        done(null, send(new URL(res.headers.location, u).href, { method, headers, timeoutMs, redirects: redirects + 1, maxBytes }))
        return
      }
      const chunks = []
      let total = 0
      res.on('data', c => {
        if (method === 'HEAD') return
        const buf = b4a.isBuffer(c) ? c : b4a.from(c)
        total += buf.byteLength
        if (total > maxBytes) { req.destroy(); done(new Error(`HTTP response exceeded ${maxBytes} bytes`)); return }
        chunks.push(buf)
      })
      res.on('end', () => done(null, { status: res.statusCode || 0, headers: res.headers, url: u.href, body: b4a.toString(b4a.concat(chunks), 'utf8') }))
      res.on('error', err => done(err))
    })
    const timer = setTimeout(() => { req.destroy(); done(new Error('Timed out')) }, timeoutMs)
    timer.unref?.()
    req.on('error', err => done(err))
    if (payload) req.write(payload)
    req.end()
  })
}

export async function fetchJson (url, headers = {}, timeoutMs = 15_000) {
  const u = new URL(url)
  const res = await send(url, { headers: { accept: 'application/json', ...headers }, timeoutMs, maxBytes: 8 * 1024 * 1024 })
  if (res.status < 200 || res.status >= 300) throw new Error(`Feed ${u.host}${u.pathname} answered ${res.status}`)
  return JSON.parse(res.body)
}

export async function requestJson (url, opts = {}) {
  const res = await send(url, { ...opts, headers: { accept: 'application/json', ...opts.headers } })
  let data = null
  try { data = res.body ? JSON.parse(res.body) : {} } catch { data = { error: res.body || `HTTP ${res.status}` } }
  return { status: res.status, data }
}
