// Cinemeta artwork without a subprocess: posters, backdrops and the shared metadata lookup.
// Split out of identify.js so the apps' Bare worklet serves /v1/poster and /v1/backdrop on its
// own loopback hole without dragging `bare-subprocess` (`ubit`) into the app bundle.
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import b4a from 'b4a'

export function send (url, { method = 'GET', headers = {}, timeoutMs = 10_000, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch { return reject(new Error('Not a valid link')) }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('Only http(s) links can be added'))
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method, headers: { 'user-agent': 'PearTube', ...headers } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume()
        resolve(send(new URL(res.headers.location, u).href, { method, headers, timeoutMs, redirects: redirects + 1 }))
        return
      }
      const chunks = []
      res.on('data', c => { if (method !== 'HEAD') chunks.push(c) })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, url: u.href, body: b4a.toString(b4a.concat(chunks), 'utf8') }))
      res.on('error', reject)
    })
    req.setTimeout?.(timeoutMs, () => req.destroy(new Error('Timed out')))
    req.on('error', reject)
    req.end()
  })
}

const metaCache = new Map()
const NEGATIVE_TTL_MS = 300_000
async function metaFor (base, imdb) {
  if (!base || !/^tt\d{5,10}$/.test(imdb)) return null
  const hit = metaCache.get(imdb)
  // A failure is not a fact: retry it after a few minutes instead of poisoning the title forever.
  if (hit && (hit.meta || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.meta
  // Cinemeta answers the wrong `type` with a redirect and an empty meta sometimes, so take the first
  // answer that actually carries art rather than the first answer at all.
  let meta = null
  for (const type of ['movie', 'series']) {
    const res = await send(`${base}/meta/${type}/${imdb}.json`, { timeoutMs: 8000 }).catch(() => null)
    let m = null
    try { m = res?.status === 200 ? JSON.parse(res.body).meta || null : null } catch {}
    if (!m) continue
    if (!meta) meta = m
    if (typeof m.poster === 'string' && m.poster) { meta = m; break }
  }
  if (metaCache.size > 2000) metaCache.clear()
  metaCache.set(imdb, { meta, at: Date.now() })
  return meta
}

const artOf = (meta, field) => (meta && typeof meta[field] === 'string' && meta[field]) || null
export async function posterUrl (base, imdb) { return artOf(await metaFor(base, imdb), 'poster') }
// A wide still for heroes and rails; the poster is the honest fallback when Cinemeta has none.
export async function backdropUrl (base, imdb) {
  const meta = await metaFor(base, imdb)
  return artOf(meta, 'background') || artOf(meta, 'poster')
}
