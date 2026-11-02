// PearTube Cast & TV Receiver stack (peartube-cast/v1): mDNS LAN discovery, Noise P2P keypair
// pairing, token-gated LAN HTTP Range streaming, and Hybrid P2P swarm handoff — kept wet and tight
// outside Corestore so private pairing tokens never leak to replicating strangers.
import { createServer, request as httpRequest } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { isIPv4 } from 'node:net'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import Corestore from 'corestore'
import HyperDHT from 'hyperdht'
import BlobServer from 'hypercore-blob-server'
import ByteStream from 'hypercore-byte-stream'
import b4a from 'b4a'
import { createNode, formatWatchUri, parseUri } from './index.js'
import { createLan, interfaceAdapter, selfAddressAdapter } from './lan.js'
import { receiverPage } from './cast-ui.js'
import { qrSvg } from './qr.js'

const HEX64 = /^[0-9a-f]{64}$/
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const CAST_SERVICE_TYPE = 'peartube-cast'
const MAX_JSON_BODY = 64 * 1024
const BLOB_BLOCK_BYTES = 512 * 1024
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, range',
  'access-control-expose-headers': 'content-length, content-range, accept-ranges'
}
const LOW_DISK_BOOT_BYTES = 2 * 1024 * 1024 * 1024
const LOW_DISK_STREAM_BYTES = 1536 * 1024 * 1024
// The receiver's read-ahead, in seconds of the stream it plays: the full window while the disk has room for it,
// down to the floor as free space runs out, never planning to use the last STREAM_RESERVE_BYTES. Watched blocks are
// trimmed only once free space falls under TRIM_FREE_BYTES (or three full windows, if larger), keeping BEHIND_SECONDS
// (a skip back stays local), every EVICT_EVERY_MS. Until the player reports a duration, a stream is assumed to run
// at a 4K remux's ~64 Mbps.
const READ_AHEAD_SECONDS = 120
const MIN_READ_AHEAD_SECONDS = 20
const BEHIND_SECONDS = 30
const TRIM_FREE_BYTES = 4 * 1024 * 1024 * 1024
const STREAM_RESERVE_BYTES = 1024 * 1024 * 1024
const STREAM_FLOOR_BYTES = 256 * 1024 * 1024
const DEFAULT_STREAM_BYTES_PER_SEC = 8 * 1024 * 1024
const EVICT_EVERY_MS = 15_000

// Checks how much free flesh the filesystem still has for non-root UIDs before RocksDB gags on ENOSPC.
function freeDiskBytes (dir) {
  try {
    const st = statfsSync(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return Infinity
  }
}

// Purges stale receiver Corestores on boot when a tiny TV disk is choked, keeping pairing identity untouched.
export function reclaimLowDiskReceiverStorage (storage) {
  if (!storage) return false
  try {
    mkdirSync(storage, { recursive: true, mode: 0o700 })
    if (freeDiskBytes(storage) >= LOW_DISK_BOOT_BYTES) return false
    for (const name of readdirSync(storage)) {
      if (name === 'corestore' || name.startsWith('peer-')) {
        rmSync(join(storage, name), { recursive: true, force: true })
      }
    }
    return true
  } catch {
    return false
  }
}

const probedPeerDirs = new Map()

// Probes an external SSD/USB path with a real RocksDB Corestore lock+append before trusting it with P2P blocks.
export async function resolvePeerStorage (candidate, fallback) {
  if (!candidate || candidate === fallback) return fallback
  if (probedPeerDirs.has(candidate)) return probedPeerDirs.get(candidate) ? candidate : fallback
  const probeDir = join(candidate, '.rocksdb-probe')
  let ok = false
  let probe = null
  try {
    rmSync(probeDir, { recursive: true, force: true })
    mkdirSync(probeDir, { recursive: true })
    probe = new Corestore(probeDir)
    const c = probe.get({ name: 'probe' })
    await c.ready()
    await c.append(b4a.from('ok'))
    ok = true
  } catch {
    ok = false
  } finally {
    if (probe) await probe.close().catch(() => {})
    try { rmSync(probeDir, { recursive: true, force: true }) } catch {}
  }
  probedPeerDirs.set(candidate, ok)
  return ok ? candidate : fallback
}

// Constant-time byte stroke so a nosy neighbor on shared Wi-Fi cannot side-channel the TV PIN.
function safeEqual (a, b) {
  const ba = b4a.from(String(a || ''))
  const bb = b4a.from(String(b || ''))
  if (ba.length === 0 || ba.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i]
  return diff === 0
}

export function normalizePairCode (raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
}

function generatePairCode () {
  const bytes = randomBytes(6)
  let out = ''
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return out
}

function randomHex (bytes = 16) {
  return b4a.toString(randomBytes(bytes), 'hex')
}

function cleanName (v, fallback = 'PearTube TV') {
  return String(v || fallback).trim().slice(0, 80).toWellFormed() || fallback
}

// Safari/WebKit TV browsers demand video/* on 206 Range slices while native OxideAV/mpv probes raw bytes.

// Mints a pairing leash so phones and desktops can mount a receiver over LAN HTTP or Noise P2P.
export function formatReceiverUri ({ publicKey = '', deviceId = '', name = '', token = '', host = '', port = 0, p2p = false } = {}) {
  const target = (publicKey || deviceId || (host && port ? `${host}:${port}` : '')).toLowerCase()
  const q = []
  if (name) q.push(`name=${encodeURIComponent(cleanName(name))}`)
  if (token) q.push(`token=${encodeURIComponent(token)}`)
  if (host) q.push(`host=${encodeURIComponent(host)}`)
  if (port > 0) q.push(`port=${Number(port)}`)
  q.push(`p2p=${p2p ? 1 : 0}`)
  return `peartube://receiver/${target}${q.length ? `?${q.join('&')}` : ''}`
}

export function parseReceiverUri (input) {
  const m = String(input || '').trim().match(/^peartube:(?:\/\/)?(?:receiver|cast)\/([^?#]+)(?:\?([^#]*))?/i)
  if (!m) throw new Error('Expected a peartube://receiver/... URI')
  const clean = m[1].trim().toLowerCase()
  const q = {}
  for (const part of String(m[2] || '').split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const k = eq === -1 ? part : part.slice(0, eq)
    const v = eq === -1 ? '' : part.slice(eq + 1)
    try { q[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')) } catch { q[k] = v }
  }
  const publicKey = HEX64.test(clean) ? clean : (HEX64.test(String(q.pk || '').toLowerCase()) ? String(q.pk).toLowerCase() : '')
  const hp = !publicKey && clean.includes(':') ? clean : ''
  const host = q.host || (hp ? hp.slice(0, hp.lastIndexOf(':')) : '')
  const port = Number(q.port || (hp ? hp.slice(hp.lastIndexOf(':') + 1) : 0)) || 0
  const deviceId = !publicKey && !hp ? clean.replace(/[^0-9a-z_-]/g, '').slice(0, 64) : String(q.id || '').slice(0, 64)
  if (!publicKey && !deviceId && !(host && port > 0)) throw new Error('Receiver URI needs a 64-hex key, device ID, or host:port')
  return { action: 'receiver', publicKey, deviceId, host, port, token: String(q.token || ''), name: cleanName(q.name || q.alias || '', 'Paired TV'), p2p: q.p2p === '1' || Boolean(publicKey) }
}
function guessMediaMime (entry) {
  const s = `${entry?.title || ''} ${entry?.id || ''}`.toLowerCase()
  if (s.includes('.webm')) return 'video/webm'
  if (s.includes('.mkv')) return 'video/x-matroska'
  if (s.includes('.avi')) return 'video/x-msvideo'
  return 'video/mp4'
}

export function idleCastState () {
  return {
    status: 'idle',
    mode: null,
    entry: null,
    positionMs: 0,
    durationMs: null,
    playing: false,
    buffering: false,
    ended: false,
    p2pPeers: 0,
    cachedBytes: 0,
    seeding: false,
    volume: 1,
    muted: false,
    tracks: [],
    audio: null,
    subtitle: null,
    error: null,
    updatedAt: Date.now()
  }
}

async function readJsonBody (req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY) throw Object.assign(new Error('Body too large'), { status: 413 })
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try { return JSON.parse(b4a.toString(b4a.concat(chunks))) } catch { throw Object.assign(new Error('Body must be JSON'), { status: 400 }) }
}

// Tracks live sockets on an HTTP server so shutting down never hangs waiting on open SSE leashes.
function attachSocketTracker (srv) {
  const sockets = new Set()
  srv.on('connection', sock => {
    sockets.add(sock)
    sock.once('close', () => sockets.delete(sock))
  })
  srv.closeAllAndStop = () => new Promise(resolve => {
    for (const s of sockets) s.destroy()
    sockets.clear()
    try { srv.close(() => resolve()) } catch { resolve() }
  })
  return srv
}

function listenHttp (srv, port, host = '0.0.0.0', anyPort = true) {
  return new Promise((resolve, reject) => {
    const tryBind = p => {
      const onError = err => {
        srv.removeListener('listening', onListen)
        if (anyPort && p !== 0) tryBind(0)
        else reject(err)
      }
      const onListen = () => {
        srv.removeListener('error', onError)
        resolve(srv.address()?.port || p)
      }
      srv.once('error', onError)
      srv.once('listening', onListen)
      srv.listen(p, host)
    }
    tryBind(port)
  })
}

function httpJson (url, { method = 'GET', headers = {}, body = null, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== null ? b4a.from(JSON.stringify(body)) : null
    const reqHeaders = { ...headers }
    if (payload) {
      reqHeaders['content-type'] = 'application/json'
      reqHeaders['content-length'] = String(payload.length)
    }
    const req = httpRequest(url, { method, headers: reqHeaders }, res => {
      const chunks = []
      res.on('data', c => chunks.push(b4a.isBuffer(c) ? c : b4a.from(c)))
      res.on('end', () => {
        clearTimeout(timer)
        const text = b4a.toString(b4a.concat(chunks))
        let parsed = null
        try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { error: text || `HTTP ${res.statusCode}` } }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed)
        else reject(new Error(parsed?.error || `Receiver answered ${res.statusCode}`))
      })
    })
    const timer = setTimeout(() => { req.destroy(new Error('Receiver HTTP request timed out')) }, timeoutMs)
    timer.unref?.()
    req.once('error', err => { clearTimeout(timer); reject(err) })
    if (payload) req.write(payload)
    req.end()
  })
}

function writeJsonAtomic (file, data) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

function adapterForHost (host, customAdapter) {
  if (customAdapter) return typeof customAdapter === 'function' ? customAdapter(host) : customAdapter
  if (!host || host === '127.0.0.1') return selfAddressAdapter(host || '127.0.0.1')
  return interfaceAdapter(host)
}

function estimateBlobBlock (blob, byteStart) {
  const avgBs = Math.max(4096, Math.round((blob.byteLength || BLOB_BLOCK_BYTES) / Math.max(1, blob.blockLength)))
  return blob.blockOffset + Math.min(blob.blockLength - 1, Math.floor(Math.max(0, byteStart) / avgBs))
}

async function hasBlockCached (core, blob, byteStart) {
  if (!core?.opened || !blob || blob.blockLength <= 0) return false
  const blockIdx = estimateBlobBlock(blob, byteStart)
  return core.length > blockIdx && core.has(blockIdx)
}

// A remote holding the whole video (per-video cores start at block 0) makes P2P the right plane.
function hasActiveReplicationPeer (core, blob) {
  if (!core?.opened || !blob) return false
  return core.remoteContiguousLength >= blob.blockOffset + blob.blockLength
}

// Cached for 3 s per core so the 1 s status loop doesn't recount a 150k-block video every tick.
const cachedCounts = new WeakMap() // core -> { at, key, val }
async function countCachedBlobBytes (core, blob, totalSize) {
  if (!core?.opened || !blob || blob.blockLength <= 0 || core.length <= blob.blockOffset) return 0
  const key = `${blob.blockOffset}:${core.length}`
  const hit = cachedCounts.get(core)
  if (hit && hit.key === key && Date.now() - hit.at < 3000) return hit.val
  const end = Math.min(blob.blockOffset + blob.blockLength, core.length)
  const blocks = await core.count(blob.blockOffset, end)
  const val = blocks <= 0 ? 0 : (blocks >= blob.blockLength ? totalSize : Math.min(totalSize, Math.round((blocks / blob.blockLength) * totalSize)))
  cachedCounts.set(core, { at: Date.now(), key, val })
  return val
}

function sameBootstrap (a, b) {
  const norm = list => Array.isArray(list) && list.length
    ? list.map(n => typeof n === 'string' ? n : `${n.host}:${n.port}`).sort().join(',')
    : ''
  return norm(a) === norm(b)
}

function parseHttpRange (rangeHeader, totalSize) {
  if (!rangeHeader || typeof rangeHeader !== 'string' || !rangeHeader.startsWith('bytes=') || totalSize <= 0) {
    return { partial: false, start: 0, end: Math.max(0, totalSize - 1) }
  }
  const spec = rangeHeader.slice(6).split(',')[0].trim()
  const dash = spec.indexOf('-')
  if (dash === -1) return { invalid: true }
  const left = spec.slice(0, dash).trim()
  const right = spec.slice(dash + 1).trim()
  let start = 0
  let end = totalSize - 1
  if (left === '') {
    const suffix = Number(right)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true }
    start = Math.max(0, totalSize - suffix)
  } else {
    start = Number(left)
    end = right === '' ? totalSize - 1 : Math.min(totalSize - 1, Number(right))
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= totalSize || start > end) {
    return { invalid: true }
  }
  return { partial: true, start, end }
}

function pipeRangeSlice (targetUrl, start, end, res, { stallTimeoutMs = 0, clientClosed = () => false } = {}) {
  return new Promise((resolve, reject) => {
    let written = 0
    let settled = false
    const expected = end - start + 1
    let stallTimer = null
    const armStall = () => {
      if (stallTimeoutMs <= 0) return
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        if (!settled) {
          settled = true
          upstream.destroy(new Error('Upstream slice stalled'))
          reject(Object.assign(new Error('Upstream slice stalled'), { written }))
        }
      }, stallTimeoutMs)
      stallTimer.unref?.()
    }
    const upstream = httpRequest(targetUrl, { method: 'GET', headers: { range: `bytes=${start}-${end}` } }, upRes => {
      if (upRes.statusCode !== 200 && upRes.statusCode !== 206) {
        clearTimeout(stallTimer)
        settled = true
        upRes.resume?.()
        reject(Object.assign(new Error(`Upstream answered ${upRes.statusCode}`), { written }))
        return
      }
      armStall()
      const onResClose = () => { try { upstream.destroy() } catch {} }
      res.once('close', onResClose)
      upRes.on('data', chunk => {
        if (settled || clientClosed()) { try { upstream.destroy() } catch {} return }
        armStall()
        const buf = b4a.isBuffer(chunk) ? chunk : b4a.from(chunk)
        const rem = expected - written
        if (rem <= 0) return
        const slice = buf.byteLength > rem ? buf.subarray(0, rem) : buf
        written += slice.byteLength
        if (!res.write(slice)) {
          upRes.pause?.()
          res.once('drain', () => upRes.resume?.())
        }
      })
      upRes.once('end', () => {
        clearTimeout(stallTimer)
        res.removeListener('close', onResClose)
        if (settled) return
        settled = true
        if (written >= expected || clientClosed()) resolve(written)
        else reject(Object.assign(new Error('Upstream closed before slice finished'), { written }))
      })
      upRes.once('error', err => {
        clearTimeout(stallTimer)
        res.removeListener('close', onResClose)
        if (!settled) { settled = true; reject(Object.assign(err, { written })) }
      })
    })
    armStall()
    upstream.once('error', err => {
      clearTimeout(stallTimer)
      if (!settled) { settled = true; reject(Object.assign(err, { written })) }
    })
    upstream.end()
  })
}

// Byte-exact mid-stream HTTP->P2P splice: starts in 2ms over HTTP if cold, proactively cuts over to
// local P2P BlobServer once peers/blocks arrive, and seamlessly splices mid-response if initiator dies.
async function serveSpliceStream (media, req, res, onModeUpgrade) {
  const totalSize = Number(media.blob?.byteLength || media.entry?.size || 0)
  if (!totalSize) {
    const fallback = media.localP2PUrl || media.httpStreamUrl
    if (!fallback) { res.writeHead(404, CORS); res.end(); return }
    const r = httpRequest(fallback, { method: req.method, headers: req.headers.range ? { range: req.headers.range } : {} }, up => {
      res.writeHead(up.statusCode || 200, { ...CORS, ...(up.headers['content-type'] ? { 'content-type': up.headers['content-type'] } : {}) })
      up.on('data', c => res.write(c))
      up.once('end', () => res.end())
    })
    r.once('error', () => { if (!res.headersSent) res.writeHead(502, CORS); res.end() })
    r.end()
    return
  }
  const parsed = parseHttpRange(req.headers.range, totalSize)
  if (parsed.invalid) {
    res.writeHead(416, { ...CORS, 'content-range': `bytes */${totalSize}` })
    res.end()
    return
  }
  const { partial, start, end } = parsed
  const headers = {
    ...CORS,
    'accept-ranges': 'bytes',
    'content-type': media.mime || 'video/mp4',
    'content-length': String(end - start + 1)
  }
  if (partial) headers['content-range'] = `bytes ${start}-${end}/${totalSize}`
  res.writeHead(partial ? 206 : 200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  let clientClosed = false
  res.once('close', () => { clientClosed = true })
  res.once('error', () => { clientClosed = true })

  let cursor = start
  const COLD_HTTP_WINDOW = 1024 * 1024 // 1 MiB max before re-checking P2P peer/cache cutover
  let forceHttpFallback = false
  while (cursor <= end && !clientClosed) {
    const canHttp = Boolean(media.senderHttpAlive && media.httpStreamUrl)
    const spanEnd = Math.min(end, cursor + 4 * 1048576)
    const spanCached = await hasBlockCached(media.core, media.blob, cursor) && await hasBlockCached(media.core, media.blob, spanEnd)
    const useP2P = Boolean(media.localP2PUrl) && !forceHttpFallback && (
      !canHttp ||
      spanCached ||
      hasActiveReplicationPeer(media.core, media.blob)
    )
    if (useP2P) {
      onModeUpgrade?.(media.p2pMode)
      try {
        const n = await pipeRangeSlice(media.localP2PUrl, cursor, end, res, { stallTimeoutMs: canHttp ? 3500 : 0, clientClosed: () => clientClosed })
        cursor += n
        break
      } catch (err) {
        cursor += Number(err?.written) || 0
        if (!canHttp) break
        forceHttpFallback = true
      }
    }
    const sliceEnd = media.localP2PUrl ? Math.min(end, cursor + COLD_HTTP_WINDOW - 1) : end
    try {
      const n = await pipeRangeSlice(media.httpStreamUrl, cursor, sliceEnd, res, { stallTimeoutMs: 8000, clientClosed: () => clientClosed })
      cursor += n
    } catch (err) {
      cursor += Number(err?.written) || 0
      media.senderHttpAlive = false
      if (!media.localP2PUrl) break
      onModeUpgrade?.(media.p2pMode)
    }
  }
  if (!clientClosed) {
    try { res.end() } catch {}
  }
}

// A reader past its first HOLD_AFTER_BYTES is the player streaming, not probing a header or an index. It gets no more
// bytes while fewer than HOLD_LOW_SECONDS of the film lie downloaded ahead of it (HOLD_SECONDS when it has just
// started or seeked), until HOLD_SECONDS do or HOLD_MAX_MS passes. The player then waits once, through one
// "Buffering…", instead of resuming with a second in hand and stalling again moments later: on the Pi a fresh stretch
// stalled for 1-2 s at 16, 82 and 93 s while the read-ahead was still building.
const HOLD_AFTER_BYTES = 2 * 1024 * 1024
const HOLD_SECONDS = 10
const HOLD_LOW_SECONDS = 2
const HOLD_MAX_MS = 20_000
async function holdIfThin (media, reader) {
  const { core, blob } = media
  const bs = Math.ceil(blob.byteLength / blob.blockLength)
  const rate = media.avgRate || DEFAULT_STREAM_BYTES_PER_SEC
  const at = Math.min(blob.blockOffset + blob.blockLength, blob.blockOffset + Math.floor(reader.pos / bs))
  const blocksFor = seconds => Math.min(blob.blockOffset + blob.blockLength - at, Math.ceil((rate * seconds) / bs))
  const buffered = async seconds => {
    const n = blocksFor(seconds)
    return n <= 0 || (await core.count(at, at + n)) === n
  }
  const cushioned = reader.cushioned
  reader.cushioned = true
  if (await buffered(cushioned ? HOLD_LOW_SECONDS : HOLD_SECONDS)) return
  const deadline = Date.now() + HOLD_MAX_MS
  while (!reader.closed && Date.now() < deadline && !(await buffered(HOLD_SECONDS))) {
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

// Serves the receiver's own player straight from the video core, with no prefetch of its own. The stock blob server
// downloads from the read position to the end of the file on every request (the player asks for `bytes=N-`), so a
// 77 GB film filled a Pi's SD card; the receiver's read-ahead (`steerReadAhead`) keeps one sliding window instead.
// Each open response is a reader whose position the window follows.
function serveWindowedStream (media, req, res, onReader) {
  const total = media.blob.byteLength
  const parsed = parseHttpRange(req.headers.range, total)
  if (parsed.invalid) {
    res.writeHead(416, { ...CORS, 'content-range': `bytes */${total}` })
    res.end()
    return
  }
  const { partial, start, end } = parsed
  const headers = { ...CORS, 'accept-ranges': 'bytes', 'content-type': media.mime || 'video/mp4', 'content-length': String(end - start + 1) }
  if (partial) headers['content-range'] = `bytes ${start}-${end}/${total}`
  res.writeHead(partial ? 206 : 200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const reader = { pos: start, sent: 0, at: Date.now(), checkedAt: 0, holding: false, drained: true, cushioned: false, closed: false }
  // ByteStream closes the core it reads when it ends, so each reader gets its own session of the media's core.
  const rs = new ByteStream(media.core.session(), media.blob, { start, length: end - start + 1, prefetch: false })
  const finish = () => {
    reader.closed = true
    media.readers.delete(reader)
    rs.destroy()
  }
  const resume = () => { if (!reader.holding && reader.drained) rs.resume() }
  media.readers.add(reader)
  media.lastReaderAt = reader.at
  rs.on('data', chunk => {
    reader.pos += chunk.byteLength
    reader.sent += chunk.byteLength
    reader.at = Date.now()
    media.servedBytes += chunk.byteLength
    if (!res.write(chunk)) {
      reader.drained = false
      rs.pause()
    }
    if (reader.sent >= HOLD_AFTER_BYTES && !reader.holding && reader.at - reader.checkedAt >= 500) {
      reader.checkedAt = reader.at
      reader.holding = true
      rs.pause()
      holdIfThin(media, reader).catch(() => {}).finally(() => { reader.holding = false; resume() })
    }
  })
  res.on('drain', () => { reader.drained = true; resume() })
  rs.once('end', () => {
    media.readers.delete(reader)
    res.end()
  })
  rs.once('error', () => {
    finish()
    res.destroy()
  })
  res.once('close', finish)
  onReader()
}

// Persistent Noise P2P RPC client over HyperDHT: keeps one encrypted pipe throbbing per cast session.
function connectNoiseOnce (dht, publicKeyHex, { relayThrough = null, onState = null, onClose = null, attemptTimeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = dht.connect(b4a.from(publicKeyHex, 'hex'), relayThrough ? { relayThrough } : undefined)
    let opened = false
    let closed = false
    let seq = 1
    let buf = b4a.alloc(0)
    const pending = new Map()

    const failAll = err => {
      for (const [, p] of pending) p.reject(err)
      pending.clear()
    }

    const openTimer = setTimeout(() => {
      if (!opened) {
        closed = true
        const err = Object.assign(new Error('Timed out connecting to receiver over P2P Noise'), { code: 'ETIMEDOUT' })
        conn.destroy(err)
        reject(err)
      }
    }, attemptTimeoutMs)
    openTimer.unref?.()

    conn.on('error', err => {
      clearTimeout(openTimer)
      if (!opened) reject(err)
      failAll(err)
    })

    conn.once('close', () => {
      clearTimeout(openTimer)
      closed = true
      failAll(new Error('Receiver P2P Noise connection closed'))
      if (opened) onClose?.()
    })

    conn.once('connect', () => {
      clearTimeout(openTimer)
      conn.on('data', chunk => {
        buf = b4a.concat([buf, b4a.isBuffer(chunk) ? chunk : b4a.from(chunk)])
        for (let i = b4a.indexOf(buf, 10); i !== -1; i = b4a.indexOf(buf, 10)) {
          const line = b4a.toString(buf.subarray(0, i))
          buf = buf.subarray(i + 1)
          if (!line) continue
          let msg
          try { msg = JSON.parse(line) } catch { continue }
          if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id)
            pending.delete(msg.id)
            clearTimeout(p.timer)
            if (msg.ok) p.resolve(msg.result)
            else p.reject(new Error(msg.error || 'Receiver P2P error'))
          } else if (msg.event === 'state' && msg.state) {
            onState?.(msg.state)
          }
        }
      })
      const rpc = {
        get closed () { return closed },
        call (type, payload = {}, callTimeout = 10_000) {
          if (closed) return Promise.reject(new Error('P2P connection closed'))
          const id = seq++
          return new Promise((resCall, rejCall) => {
            const timer = setTimeout(() => {
              pending.delete(id)
              rejCall(Object.assign(new Error(`Receiver P2P ${type} timed out`), { code: 'ETIMEDOUT' }))
            }, callTimeout)
            timer.unref?.()
            pending.set(id, { resolve: resCall, reject: rejCall, timer })
            conn.write(b4a.from(JSON.stringify({ id, type, ...payload }) + '\n'))
          })
        },
        close () {
          closed = true
          failAll(new Error('Closed'))
          try { conn.destroy() } catch {}
        }
      }
      rpc.call('info', {}, 2500).then(
        () => { opened = true; resolve(rpc) },
        err => { rpc.close(); reject(err) }
      )
    })
  })
}

// Retries transient HyperDHT holepunch aborts while dht-rpc finishes its NAT check ( ~20-25s on 127.0.0.1 testnets).
async function connectNoiseRpc (dht, publicKeyHex, { relayThrough = null, onState = null, onClose = null, timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    const rem = deadline - Date.now()
    try {
      return await connectNoiseOnce(dht, publicKeyHex, { relayThrough, onState, onClose, attemptTimeoutMs: Math.min(30_000, rem) })
    } catch (err) {
      lastErr = err
      const retryable = err?.code === 'HOLEPUNCH_ABORTED' || err?.code === 'PEER_CONNECTION_FAILED' || err?.code === 'TRY_LATER' || err?.code === 'ERR_PRIVACY_UNAVAILABLE' || err?.code === 'ETIMEDOUT'
      if (!retryable || Date.now() + 1000 >= deadline) throw err
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  throw lastErr || new Error('Timed out connecting to receiver over P2P Noise')
}

// Standalone or embedded TV Receiver: advertises over mDNS, listens on Noise P2P when given a node,
// serves the 10-foot Smart TV Web Receiver at /tv, and upgrades HTTP Range streams to P2P swarm blocks.
export async function createReceiver ({
  storage,
  peerStorage = null,
  name = os.hostname?.() || 'PearTube TV',
  port = 8176,
  bindHost = '0.0.0.0',
  lanHost = null,
  node = null,
  allowPeerNode = Boolean(node),
  adapter = null,
  openAuth = false,
  anyPort = true,
  onCommand = null,
  onChange = null,
  // Inside the apps' worklet: managed peer nodes get the worklet's small request windows, like the app's own node.
  worklet = false
}) {
  mkdirSync(storage, { recursive: true, mode: 0o700 })
  const peerRoot = await resolvePeerStorage(peerStorage, storage)
  if (!node && allowPeerNode) reclaimLowDiskReceiverStorage(peerRoot)
  const idFile = join(storage, 'receiver.json')
  let identity = null
  try { identity = JSON.parse(readFileSync(idFile, 'utf8')) } catch {}
  if (!identity || !HEX64.test(String(identity.seed || ''))) {
    identity = {
      deviceId: randomHex(16),
      name: cleanName(name),
      seed: randomHex(32),
      pairToken: randomHex(16),
      pairCode: generatePairCode()
    }
    writeJsonAtomic(idFile, identity)
  } else if (name && identity.name !== cleanName(name)) {
    identity.name = cleanName(name)
    writeJsonAtomic(idFile, identity)
  }

  const webToken = randomHex(16)
  const p2pCapable = Boolean(node || allowPeerNode)
  const keyPair = p2pCapable ? HyperDHT.keyPair(b4a.from(identity.seed, 'hex')) : null
  const publicKey = keyPair ? b4a.toString(keyPair.publicKey, 'hex') : ''

  let currentHost = lanHost
  let actualPort = 0
  let closing = false
  let commandSeq = 0
  let state = idleCastState()
  let activeMedia = null
  let adHandle = null
  let managedPeerNode = null
  let managedPeerSig = ''
  let pairFailures = []
  let lastLoadedBlobs = ''
  let evicting = false
  let lastEvictAt = 0
  // The last few loads stay streamable by token (a replay after the end, a late seek), each with its own window.
  const streams = new Map()
  function rememberStream (media) {
    streams.set(media.token, media)
    while (streams.size > 4) {
      const [token, old] = streams.entries().next().value
      old.window?.range.destroy()
      streams.delete(token)
    }
  }

  // One sliding download window ahead of the player, sized in seconds of the stream (its average bitrate, or the
  // player's recent read rate up to twice that) and shrunk by the free disk. Every EVICT_EVERY_MS, watched blocks more
  // than BEHIND_SECONDS (at least 64 MiB) behind the earliest reader are cleared, so the cache stays about one window
  // plus that margin and each pass clears only ~15 s of the stream: never a disk-sized clear on an SD card.
  async function steerReadAhead (media) {
    const { core, blob } = media
    if (!core?.opened || core.closing || !blob?.blockLength) return
    const bs = Math.ceil(blob.byteLength / blob.blockLength)
    const readers = [...media.readers]
    const lead = readers.filter(r => r.sent >= 2 * 1024 * 1024).sort((a, b) => b.at - a.at)[0] || readers[readers.length - 1]
    const leadByte = lead ? lead.pos : (state.durationMs > 0 ? Math.floor((state.positionMs / state.durationMs) * blob.byteLength) : 0)
    const avg = media === activeMedia && state.durationMs > 0 ? blob.byteLength / (state.durationMs / 1000) : (media.avgRate || DEFAULT_STREAM_BYTES_PER_SEC)
    media.avgRate = avg
    const rate = Math.max(avg, Math.min(media.readRate, 2 * avg))
    const last = blob.blockOffset + blob.blockLength
    const first = Math.min(last - 1, blob.blockOffset + Math.floor(leadByte / bs))
    const fullEnd = Math.min(last, first + Math.ceil((rate * READ_AHEAD_SECONDS) / bs))
    const cachedAhead = (await core.count(first, fullEnd)) * bs
    const free = freeDiskBytes(peerRoot)
    // The floor keeps a jitter buffer when the reserve is already used, but never more than the disk can hold above
    // STREAM_FLOOR_BYTES: below that the window shrinks to the block being read and the player reads on demand.
    const wanted = Math.max(rate * MIN_READ_AHEAD_SECONDS, Math.min(rate * READ_AHEAD_SECONDS, free - STREAM_RESERVE_BYTES + cachedAhead))
    const ahead = Math.min(wanted, Math.max(0, free - STREAM_FLOOR_BYTES + cachedAhead))
    const end = Math.min(last, first + Math.max(1, Math.ceil(ahead / bs)))
    if (closing || !streams.has(media.token)) return
    const win = media.window
    const step = Math.max(4, Math.floor((end - first) / 8))
    if (!win || Math.abs(first - win.start) >= step || Math.abs(end - win.end) >= step) {
      const range = core.download({ start: first, end, linear: true })
      win?.range.destroy()
      media.window = { range, start: first, end }
    }
    // Trimming waits until the disk needs the space: each pass is block clears plus a compaction on the storage
    // thread, and on the Pi's SSD with 960 GB free that every-15 s burst only competed with playback. Under the
    // reserve it runs every 3 s and keeps only 64 MiB behind, so the disk never fills mid-film. It also waits while
    // the player starts or seeks (buffering, or a reader opened in the last 20 s) unless the disk is nearly full:
    // after a seek everything before the new spot counts as watched, and clearing hundreds of MB then held up the
    // new reads (the Pi went 10 s without receiving a byte). Each pass clears at most twice what the stream plays
    // between passes, so a backlog drains over several passes.
    const tight = free < STREAM_RESERVE_BYTES
    const needed = free < Math.max(TRIM_FREE_BYTES, 3 * rate * READ_AHEAD_SECONDS)
    const settling = (media === activeMedia && state.buffering) || Date.now() - (media.lastReaderAt || 0) < 20_000
    if (media.coreKeyHex && needed && !evicting && (!settling || free < STREAM_FLOOR_BYTES) && Date.now() - lastEvictAt >= (tight ? 3000 : EVICT_EVERY_MS)) {
      evicting = true
      lastEvictAt = Date.now()
      const playheadByte = Math.min(leadByte, ...readers.map(r => r.pos))
      const keepBehindBytes = tight ? 64 * 1024 * 1024 : Math.max(64 * 1024 * 1024, Math.ceil(rate * BEHIND_SECONDS))
      const maxBytes = Math.max(128 * 1024 * 1024, Math.ceil(rate * (EVICT_EVERY_MS / 1000) * 2))
      media.peerNode.evictBehind?.(media.coreKeyHex, blob, { playheadByte, keepBehindBytes, maxBytes }).catch(() => {}).finally(() => { evicting = false })
    }
  }

  let steering = false
  async function steerStreams () {
    if (steering || closing) return
    steering = true
    try {
      const now = Date.now()
      for (const media of streams.values()) {
        const seconds = Math.max(0.25, (now - media.rateAt) / 1000)
        media.readRate = 0.8 * media.readRate + 0.2 * ((media.servedBytes - media.rateServed) / seconds)
        media.rateAt = now
        media.rateServed = media.servedBytes
        if (media.readers.size > 0 || media === activeMedia) {
          await steerReadAhead(media).catch(() => {})
        } else if (media.window) {
          media.window.range.destroy()
          media.window = null
        }
      }
    } finally {
      steering = false
    }
  }
  const readAheadTimer = setInterval(steerStreams, 1000)
  readAheadTimer.unref?.()

  const sseClients = new Set()
  const webSseClients = new Set()
  const noiseSubscribers = new Set()
  const activeNoiseConns = new Set()

  function checkPairRateLimit () {
    const now = Date.now()
    pairFailures = pairFailures.filter(t => now - t < 15_000)
    if (pairFailures.length >= 6) throw Object.assign(new Error('Too many pairing attempts; wait 15 seconds'), { status: 429 })
  }

  function currentPeerNode () {
    return activeMedia?.peerNode || managedPeerNode || node
  }

  function capabilities () {
    return { http: true, p2p: p2pCapable, privateP2P: p2pCapable, tracks: true }
  }

  function pairingUri () {
    return formatReceiverUri({
      publicKey,
      deviceId: identity.deviceId,
      name: identity.name,
      token: identity.pairToken,
      host: currentHost || '',
      port: actualPort,
      p2p: p2pCapable
    })
  }

  let cachedQrUri = ''
  let cachedQrSvg = ''
  let cachedFreeBytes = 0
  let cachedFreeAt = 0
  let lastLocalNotifyKey = ''

  function currentFreeBytes () {
    const now = Date.now()
    if (now - cachedFreeAt >= 5000) {
      const f = freeDiskBytes(peerRoot)
      cachedFreeBytes = Number.isFinite(f) ? f : 0
      cachedFreeAt = now
    }
    return cachedFreeBytes
  }

  function publicInfo () {
    const pNode = currentPeerNode()
    const pStatus = pNode ? pNode.status() : null
    return {
      protocol: 'peartube-cast/v1',
      deviceId: identity.deviceId,
      name: identity.name,
      publicKey,
      swarmKey: pNode ? b4a.toString(pNode.swarm.keyPair.publicKey, 'hex') : '',
      host: currentHost || null,
      port: actualPort,
      capabilities: capabilities(),
      authRequired: !openAuth,
      routes: pStatus?.routes || null,
      storageFreeBytes: currentFreeBytes(),
      externalStorage: Boolean(String(peerRoot).startsWith('/mnt/expand/') || (peerStorage && peerRoot === peerStorage && peerRoot !== storage)),
      state
    }
  }

  function detailedInfo () {
    const uri = pairingUri()
    // Hold the rendered QR SVG hot in memory so playback state ticks never re-run Reed-Solomon math on QuickJS.
    if (uri !== cachedQrUri) {
      cachedQrUri = uri
      cachedQrSvg = qrSvg(uri)
    }
    return {
      ...publicInfo(),
      pairCode: openAuth ? 'OPEN' : identity.pairCode,
      pairingUri: uri,
      qrSvg: cachedQrSvg,
      listenUrl: `http://${currentHost || '127.0.0.1'}:${actualPort}`
    }
  }

  function notifyLocalHost (force = false) {
    if (!onChange) return
    const key = `${currentHost || ''}:${actualPort}:${identity.pairCode}:${state.status}:${state.mode || ''}:${state.p2pPeers || 0}:${state.playing}:${state.buffering}:${state.ended}:${state.error || ''}:${state.entry?.id || ''}`
    if (!force && key === lastLocalNotifyKey) return
    lastLocalNotifyKey = key
    onChange(state)
  }

  function broadcastState () {
    if (sseClients.size > 0) {
      const sseFrame = b4a.from(`data: ${JSON.stringify({ event: 'state', state })}\n\n`)
      for (const res of sseClients) { try { res.write(sseFrame) } catch { sseClients.delete(res) } }
    }
    if (noiseSubscribers.size > 0) {
      const noiseFrame = b4a.from(JSON.stringify({ event: 'state', state }) + '\n')
      for (const conn of noiseSubscribers) {
        if (conn.destroyed) noiseSubscribers.delete(conn)
        else { try { conn.write(noiseFrame) } catch { noiseSubscribers.delete(conn) } }
      }
    }
    notifyLocalHost(false)
  }

  function updateState (patch) {
    state = { ...state, ...patch, updatedAt: Date.now() }
    broadcastState()
    return state
  }

  function sendWebCommand (command) {
    const frame = b4a.from(`data: ${JSON.stringify({ event: 'command', command })}\n\n`)
    for (const res of webSseClients) { try { res.write(frame) } catch { webSseClients.delete(res) } }
  }


  async function ensurePeerNode (network = {}) {
    const wantPrivate = Boolean(network?.privateRouting)
    const wantBootstrap = Array.isArray(network?.bootstrap) && network.bootstrap.length ? network.bootstrap : null
    const wantRelayThrough = Array.isArray(network?.relayThrough) && network.relayThrough.length ? network.relayThrough : null
    const wantLan = wantPrivate ? Boolean(network?.lan) : true
    const sourceKey = HEX64.test(String(network?.sourceKey || '').toLowerCase()) ? String(network.sourceKey).toLowerCase() : ''
    const sourceKind = network?.sourceKind === 'channel' ? 'channel' : 'tracker'

    let peerNode = null
    if (
      node &&
      !node.closing &&
      Boolean(node.privateRouting) === wantPrivate &&
      (!wantBootstrap || sameBootstrap(node.bootstrap, wantBootstrap)) &&
      sameBootstrap(node.relayThrough || [], wantRelayThrough || []) &&
      (!wantPrivate || Boolean(node.hasLan?.()) === wantLan)
    ) {
      peerNode = node
    } else if (p2pCapable) {
      const trackerForPrivate = wantPrivate && sourceKind === 'tracker' && sourceKey ? sourceKey : ''
      const sig = JSON.stringify({ wantPrivate, wantBootstrap, wantRelayThrough, wantLan, trackerForPrivate })
      if (!managedPeerNode || managedPeerNode.closing || managedPeerSig !== sig) {
        const prev = managedPeerNode
        managedPeerNode = null
        managedPeerSig = ''
        if (prev) await prev.close().catch(() => {})
        const subDir = wantPrivate
          ? `peer-private-${(trackerForPrivate || sourceKey || 'default').slice(0, 12)}`
          : 'peer-public'
        managedPeerNode = await createNode({
          storage: join(peerRoot, subDir),
          tracker: trackerForPrivate || null,
          bootstrap: wantBootstrap || undefined,
          relayThrough: wantRelayThrough,
          privateRouting: wantPrivate,
          worklet,
          lan: wantLan && currentHost
            ? kp => createLan({ host: currentHost, keyPair: kp, adapter: adapterForHost(currentHost, adapter) })
            : null
        })
        managedPeerSig = sig
      }
      peerNode = managedPeerNode
    }

    if (peerNode && sourceKey) {
      if (wantPrivate) await peerNode.addSource({ key: sourceKey, kind: sourceKind })
      else peerNode.joinSourceSwarm?.(sourceKey)
    }
    return peerNode
  }

  async function prepareMediaLoad (cmd) {
    activeMedia = null
    const entry = cmd.entry ? {
      key: String(cmd.entry.key || ''),
      id: String(cmd.entry.id || 'stream'),
      title: cleanName(cmd.entry.title, cmd.entry.id || 'PearTube Stream'),
      size: Number(cmd.entry.size) || 0,
      sha256: String(cmd.entry.sha256 || '')
    } : { key: '', id: 'stream', title: 'PearTube Stream', size: 0, sha256: '' }

    const preferMode = cmd.preferMode === 'http' || cmd.preferMode === 'p2p' ? cmd.preferMode : 'auto'
    const httpStreamUrl = typeof cmd.httpStreamUrl === 'string' && /^https?:\/\//.test(cmd.httpStreamUrl) ? cmd.httpStreamUrl : null
    const magnetUrl = typeof cmd.magnetUrl === 'string' && cmd.magnetUrl.startsWith('peartube://watch/') ? cmd.magnetUrl : null
    const parsedWatch = magnetUrl ? (() => { try { return parseUri(magnetUrl) } catch { return null } })() : null
    const netCfg = {
      privateRouting: Boolean(cmd.network?.privateRouting ?? cmd.senderPrivateRouting),
      bootstrap: cmd.network?.bootstrap || null,
      relayThrough: cmd.network?.relayThrough || null,
      lan: cmd.network?.lan !== undefined ? Boolean(cmd.network.lan) : !Boolean(cmd.network?.privateRouting ?? cmd.senderPrivateRouting),
      sourceKey: cmd.network?.sourceKey || parsedWatch?.sourceKey || '',
      sourceKind: cmd.network?.sourceKind || parsedWatch?.sourceKind || 'tracker'
    }

    const wantP2P = Boolean(p2pCapable && magnetUrl && preferMode !== 'http')
    const p2pMode = netCfg.privateRouting ? 'private-p2p' : 'p2p'
    // Strict private-only casts (LAN disabled on initiator) never pull cleartext HTTP unless explicitly forced (`preferMode === 'http'`).
    const allowColdHttp = Boolean(httpStreamUrl && (preferMode === 'http' || (preferMode !== 'p2p' && (!netCfg.privateRouting || netCfg.lan))))

    let peerNode = null
    let localP2PUrl = null
    let core = null
    let blob = null

    if (wantP2P) {
      try {
        peerNode = await ensurePeerNode(netCfg)
        if (peerNode) {
          const targetBlobs = parsedWatch?.action === 'watch' ? parsedWatch.entry.blobs : ''
          const freeNow = freeDiskBytes(peerRoot)
          if (freeNow < LOW_DISK_BOOT_BYTES || (lastLoadedBlobs && targetBlobs && lastLoadedBlobs !== targetBlobs && freeNow < Math.max(3 * 1024 * 1024 * 1024, (entry.size || 0) + LOW_DISK_STREAM_BYTES))) {
            await peerNode.clearCache?.(null, { keepBlobsHex: freeNow < LOW_DISK_STREAM_BYTES ? null : targetBlobs }).catch(() => {})
          }
          if (targetBlobs) lastLoadedBlobs = targetBlobs
          if (!netCfg.privateRouting && cmd.senderLan) peerNode.dialLanPeer?.(cmd.senderLan)
          if (HEX64.test(String(cmd.senderPeerKey || '').toLowerCase())) {
            const senderKeyBuf = b4a.from(String(cmd.senderPeerKey).toLowerCase(), 'hex')
            if (!b4a.equals(senderKeyBuf, peerNode.swarm.keyPair.publicKey)) {
              if (!netCfg.privateRouting && peerNode.hasLan?.()) {
                const targetNode = peerNode
                setTimeout(() => {
                  if (!targetNode.closing && !targetNode.hasLanPeer?.(senderKeyBuf)) {
                    try { targetNode.swarm.joinPeer(senderKeyBuf) } catch {}
                  }
                }, 1500).unref?.()
              } else {
                try { peerNode.swarm.joinPeer(senderKeyBuf) } catch {}
              }
            }
          }
          const opened = await peerNode.openUri(magnetUrl, { joinSource: netCfg.privateRouting })
          localP2PUrl = opened?.entry?.streamUrl || null
          if (parsedWatch?.action === 'watch') {
            blob = parsedWatch.entry.blob
            core = await peerNode.blobCore(parsedWatch.entry.blobs)
          }
        }
      } catch (err) {
        if (!allowColdHttp) throw err
      }
    }

    const effectiveHttpUrl = allowColdHttp ? httpStreamUrl : null
    if (!localP2PUrl && !effectiveHttpUrl) {
      throw new Error('Cast load requires an allowed HTTP Range URL or a reachable P2P peartube://watch URI')
    }

    const loadToken = randomHex(16)
    // Native P2P receivers (Android TV / Pi 4 / Mac HTPC / daemon) hand OxideAV/mpv a direct loopback URL, and the
    // hybrid splice reads the same one. For a known blob that is the windowed route (bounded read-ahead), not the
    // node's blob server, which would download to the end of the film. External Smart TV Web browsers (!onCommand)
    // use the LAN-reachable /cast/v1/hybrid/<token> proxy.
    if (core && blob && localP2PUrl) localP2PUrl = `http://127.0.0.1:${actualPort}/cast/v1/p2p/${loadToken}`
    const directLocalP2P = Boolean(onCommand && localP2PUrl)
    const startOnP2P = Boolean(localP2PUrl && (directLocalP2P || !allowColdHttp || await hasBlockCached(core, blob, 0) || hasActiveReplicationPeer(core, blob)))
    const initialMode = startOnP2P ? p2pMode : 'http'
    activeMedia = {
      token: loadToken,
      entry,
      mime: guessMediaMime(entry),
      preferMode,
      privateRouting: netCfg.privateRouting,
      p2pMode,
      peerNode,
      httpStreamUrl: effectiveHttpUrl,
      localP2PUrl,
      core,
      coreKeyHex: parsedWatch?.action === 'watch' ? parsedWatch.entry.blobs : '',
      blob,
      senderHttpAlive: allowColdHttp,
      readers: new Set(),
      servedBytes: 0,
      readRate: 0,
      rateAt: Date.now(),
      rateServed: 0,
      avgRate: 0,
      window: null
    }
    if (core && blob) rememberStream(activeMedia)

    const hostForPlayer = onCommand ? '127.0.0.1' : (currentHost || '127.0.0.1')
    const streamUrl = directLocalP2P
      ? localP2PUrl
      : (localP2PUrl && allowColdHttp)
          ? `http://${hostForPlayer}:${actualPort}/cast/v1/hybrid/${loadToken}`
          : (localP2PUrl || effectiveHttpUrl)
    return {
      entry,
      mode: initialMode,
      streamUrl,
      httpFallbackUrl: effectiveHttpUrl,
      localP2PUrl,
      peerSwarmKey: peerNode ? b4a.toString(peerNode.swarm.keyPair.publicKey, 'hex') : '',
      peerLan: !netCfg.privateRouting ? (peerNode?.lanEndpoint?.() || null) : null
    }
  }

  async function applyCommand (cmd) {
    const action = String(cmd?.action || '')
    if (!action) throw Object.assign(new Error('action is required'), { status: 400 })
    if (action === 'status') return state

    if (action === 'load') {
      const prepared = await prepareMediaLoad(cmd)
      const startPositionMs = Math.max(0, Number(cmd.startPositionMs) || 0)
      const cachedBytes = await countCachedBlobBytes(activeMedia?.core, activeMedia?.blob, prepared.entry.size)
      const stNode = activeMedia?.peerNode?.status()
      const p2pPeers = stNode ? (stNode.peers + stNode.lanPeers) : 0
      updateState({
        status: 'loading',
        mode: prepared.mode,
        entry: prepared.entry,
        positionMs: startPositionMs,
        durationMs: null,
        playing: true,
        buffering: true,
        ended: false,
        p2pPeers,
        cachedBytes,
        seeding: cachedBytes > 0,
        tracks: [],
        audio: null,
        subtitle: null,
        error: null
      })
      const fullCmd = {
        seq: ++commandSeq,
        action: 'load',
        entry: prepared.entry,
        mode: prepared.mode,
        streamUrl: prepared.streamUrl,
        httpStreamUrl: prepared.httpFallbackUrl,
        startPositionMs
      }
      sendWebCommand(fullCmd)
      if (onCommand) await onCommand(fullCmd, { updateState, getState: () => state })
      return { ...state, peerSwarmKey: prepared.peerSwarmKey, peerLan: prepared.peerLan }
    }

    if (action === 'stop') {
      // Keep seededBlobs downloading & seeding in Corestore so this TV remains a normal swarm peer!
      activeMedia = null
      const fullCmd = { seq: ++commandSeq, action: 'stop' }
      sendWebCommand(fullCmd)
      if (onCommand) await onCommand(fullCmd, { updateState, getState: () => state })
      return updateState(idleCastState())
    }

    const nextPatch = {}
    if (action === 'play') { nextPatch.playing = true; nextPatch.status = 'playing'; nextPatch.ended = false }
    else if (action === 'pause') { nextPatch.playing = false; nextPatch.status = 'paused' }
    else if (action === 'togglePlay') { nextPatch.playing = !state.playing; nextPatch.status = nextPatch.playing ? 'playing' : 'paused' }
    else if (action === 'seek') { nextPatch.positionMs = Math.max(0, Number(cmd.positionMs) || 0); nextPatch.ended = false }
    else if (action === 'skip') { nextPatch.positionMs = Math.max(0, (state.positionMs || 0) + (Number(cmd.deltaMs) || 0)); nextPatch.ended = false }
    else if (action === 'selectAudio') { nextPatch.audio = Number(cmd.stream) }
    else if (action === 'selectSubtitle') { nextPatch.subtitle = Number(cmd.stream) }
    else if (action === 'volume') {
      if (typeof cmd.volume === 'number') nextPatch.volume = Math.max(0, Math.min(1, cmd.volume))
      if (typeof cmd.muted === 'boolean') nextPatch.muted = cmd.muted
    } else {
      throw Object.assign(new Error(`Unsupported cast action: ${action}`), { status: 400 })
    }

    const fullCmd = { seq: ++commandSeq, ...cmd, action, ...(nextPatch.positionMs !== undefined ? { positionMs: nextPatch.positionMs } : {}) }
    sendWebCommand(fullCmd)
    if (onCommand) await onCommand(fullCmd, { updateState, getState: () => state })
    return updateState(nextPatch)
  }

  function authorized (req, url) {
    if (openAuth) return true
    const header = String(req.headers.authorization || '')
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const queryTok = url.searchParams.get('token') || ''
    return safeEqual(bearer || queryTok, identity.pairToken)
  }

  const httpSrv = attachSocketTracker(createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const p = url.pathname

    if (req.method === 'GET' && (p === '/' || p === '/tv' || p === '/cast/receiver')) {
      res.writeHead(200, { ...CORS, 'content-type': 'text/html; charset=utf-8' })
      res.end(receiverPage({ mode: 'standalone', defaultName: identity.name }))
      return
    }

    const streamMatch = (req.method === 'GET' || req.method === 'HEAD') && p.match(/^\/cast\/v1\/p2p\/([0-9a-f]{32})$/)
    if (streamMatch) {
      const media = streams.get(streamMatch[1])
      if (!media) {
        res.writeHead(404, CORS)
        res.end()
        return
      }
      serveWindowedStream(media, req, res, steerStreams)
      return
    }

    const hybridMatch = (req.method === 'GET' || req.method === 'HEAD') && p.match(/^\/cast\/v1\/hybrid\/([0-9a-f]{32})$/)
    if (hybridMatch) {
      if (!activeMedia || !safeEqual(hybridMatch[1], activeMedia.token)) {
        res.writeHead(404, CORS)
        res.end()
        return
      }
      await serveSpliceStream(activeMedia, req, res, upgradedMode => {
        if (state.mode !== upgradedMode) updateState({ mode: upgradedMode })
      })
      return
    }

    if (req.method === 'GET' && p === '/cast/v1/events') {
      if (!authorized(req, url)) {
        res.writeHead(401, { ...CORS, 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      res.writeHead(200, { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(b4a.from(`data: ${JSON.stringify({ event: 'state', state })}\n\n`))
      sseClients.add(res)
      req.once('close', () => sseClients.delete(res))
      return
    }

    if (req.method === 'GET' && p === '/cast/v1/web-events') {
      if (!safeEqual(url.searchParams.get('token') || '', webToken)) {
        res.writeHead(401, { ...CORS, 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      res.writeHead(200, { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(b4a.from(': connected\n\n'))
      webSseClients.add(res)
      req.once('close', () => webSseClients.delete(res))
      return
    }

    let status = 200
    let payload
    try {
      if (req.method === 'GET' && p === '/cast/v1/info') {
        payload = publicInfo()
      } else if (req.method === 'GET' && p === '/cast/v1/web-info') {
        const remote = req.socket?.remoteAddress || ''
        const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || (currentHost && remote.endsWith(currentHost))
        const uri = pairingUri()
        payload = isLocal ? { ...detailedInfo(), webToken } : { ...publicInfo(), pairCode: openAuth ? 'OPEN' : identity.pairCode, pairingUri: uri, qrSvg: qrSvg(uri), webToken }
      } else if (req.method === 'POST' && p === '/cast/v1/web-state') {
        const body = await readJsonBody(req)
        if (!safeEqual(body.token || '', webToken)) throw Object.assign(new Error('Unauthorized'), { status: 401 })
        if (body.state && typeof body.state === 'object' && !onCommand) {
          const { mode: _ignoreMode, ...rest } = body.state
          updateState({ ...rest, mode: state.mode || body.state.mode || 'http' })
        }
        payload = { ok: true }
      } else if (req.method === 'POST' && p === '/cast/v1/pair') {
        checkPairRateLimit()
        const body = await readJsonBody(req)
        if (!openAuth && !safeEqual(normalizePairCode(body.code), identity.pairCode)) {
          pairFailures.push(Date.now())
          throw Object.assign(new Error('Invalid TV pairing code'), { status: 403 })
        }
        payload = {
          deviceId: identity.deviceId,
          name: identity.name,
          publicKey,
          swarmKey: node ? b4a.toString(node.swarm.keyPair.publicKey, 'hex') : '',
          port: actualPort,
          token: identity.pairToken,
          capabilities: capabilities()
        }
      } else if (req.method === 'POST' && p === '/cast/v1/command') {
        if (!authorized(req, url)) throw Object.assign(new Error('Unauthorized; pair with this TV first'), { status: 401 })
        const body = await readJsonBody(req)
        payload = { ok: true, state: await applyCommand(body) }
      } else {
        status = 404
        payload = { error: 'Not found' }
      }
    } catch (err) {
      status = err.status || 400
      payload = { error: err.message }
    }
    res.writeHead(status, { ...CORS, 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }))

  actualPort = await listenHttp(httpSrv, port, bindHost, anyPort)

  let noiseServer = null
  if (node?.swarm?.dht && keyPair) {
    noiseServer = node.swarm.dht.createServer(conn => {
      activeNoiseConns.add(conn)
      conn.on('error', () => {})
      conn.once('close', () => {
        activeNoiseConns.delete(conn)
        noiseSubscribers.delete(conn)
      })
      let buf = b4a.alloc(0)
      conn.on('data', chunk => {
        buf = b4a.concat([buf, b4a.isBuffer(chunk) ? chunk : b4a.from(chunk)])
        for (let i = b4a.indexOf(buf, 10); i !== -1; i = b4a.indexOf(buf, 10)) {
          const line = b4a.toString(buf.subarray(0, i))
          buf = buf.subarray(i + 1)
          if (!line) continue
          handleNoiseLine(conn, line)
        }
      })
    })
    await noiseServer.listen(keyPair)
  }

  async function handleNoiseLine (conn, line) {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    const reply = obj => { if (!conn.destroyed) try { conn.write(b4a.from(JSON.stringify({ id: msg.id, ...obj }) + '\n')) } catch {} }
    try {
      if (msg.type === 'info') {
        reply({ ok: true, result: publicInfo() })
      } else if (msg.type === 'pair') {
        checkPairRateLimit()
        if (!openAuth && !safeEqual(normalizePairCode(msg.code), identity.pairCode)) {
          pairFailures.push(Date.now())
          throw new Error('Invalid TV pairing code')
        }
        reply({ ok: true, result: { deviceId: identity.deviceId, name: identity.name, publicKey, port: actualPort, token: identity.pairToken, capabilities: capabilities() } })
      } else if (msg.type === 'subscribe') {
        if (!openAuth && !safeEqual(msg.token, identity.pairToken)) throw new Error('Unauthorized')
        noiseSubscribers.add(conn)
        reply({ ok: true, result: { state } })
      } else if (msg.type === 'cmd') {
        if (!openAuth && !safeEqual(msg.token, identity.pairToken)) throw new Error('Unauthorized')
        const next = await applyCommand(msg)
        reply({ ok: true, result: { ok: true, state: next } })
      } else {
        throw new Error(`Unknown Noise cast message: ${msg.type}`)
      }
    } catch (err) {
      reply({ ok: false, error: err.message })
    }
  }

  async function refreshMdns () {
    const prev = adHandle
    adHandle = null
    if (prev) await Promise.resolve(prev.stop?.()).catch(() => {})
    if (closing || (!currentHost && !adapter)) return
    try {
      const mdns = adapterForHost(currentHost, adapter)
      adHandle = mdns.advertise({
        name: `${identity.name} (${identity.deviceId.slice(0, 6)})`,
        type: CAST_SERVICE_TYPE,
        protocol: 'tcp',
        port: actualPort,
        txt: {
          proto: CAST_SERVICE_TYPE,
          v: '1',
          id: identity.deviceId,
          name: identity.name,
          h: currentHost || '127.0.0.1',
          pk: publicKey,
          p2p: p2pCapable ? '1' : '0',
          auth: openAuth ? 'open' : 'code'
        }
      }, { onError: () => {} })
    } catch {}
  }

  await refreshMdns()
  let statsBusy = false
  const peerStatsTimer = setInterval(async () => {
    if (closing || statsBusy || !activeMedia?.peerNode || !state.entry) return
    statsBusy = true
    try {
      const media = activeMedia
      const st = media.peerNode.status()
      const p2pPeers = (st.peers || 0) + (st.lanPeers || 0)
      const size = state.entry.size || media.blob?.byteLength || 0
      const cachedBytes = await countCachedBlobBytes(media.core, media.blob, size)
      if (media !== activeMedia) return
      const seeding = cachedBytes > 0
      const nextMode = (cachedBytes > 0 || hasActiveReplicationPeer(media.core, media.blob)) ? media.p2pMode : state.mode
      if (p2pPeers !== state.p2pPeers || cachedBytes !== state.cachedBytes || seeding !== state.seeding || nextMode !== state.mode) {
        updateState({ p2pPeers, cachedBytes, seeding, mode: nextMode })
      }
    } catch {} finally {
      statsBusy = false
    }
  }, 1000)
  peerStatsTimer.unref?.()


  return {
    get port () { return actualPort },
    get publicKey () { return publicKey },
    get deviceId () { return identity.deviceId },
    peerStatus: () => currentPeerNode()?.status() || null,
    info: detailedInfo,
    state: () => state,
    reportState (patch) {
      if (!patch || typeof patch !== 'object') return state
      if (patch.idle) {
        activeMedia = null
        return updateState(idleCastState())
      }
      const playing = Boolean(patch.playing)
      const ended = Boolean(patch.ended)
      const buffering = Boolean(patch.buffering)
      const error = patch.error ? String(patch.error) : null
      const status = !state.entry ? 'idle' : error ? 'error' : ended ? 'ended' : buffering ? 'buffering' : playing ? 'playing' : 'paused'
      const next = updateState({
        status,
        positionMs: Math.max(0, Number(patch.positionMs) || 0),
        durationMs: patch.durationMs != null && Number(patch.durationMs) > 0 ? Number(patch.durationMs) : state.durationMs,
        playing,
        buffering,
        ended,
        tracks: Array.isArray(patch.tracks) ? patch.tracks : state.tracks,
        audio: patch.audio !== undefined ? patch.audio : state.audio,
        subtitle: patch.subtitle !== undefined ? patch.subtitle : state.subtitle,
        videoDecoder: patch.videoDecoder !== undefined ? patch.videoDecoder : state.videoDecoder,
        droppedFrames: patch.droppedFrames !== undefined ? Number(patch.droppedFrames) || 0 : (state.droppedFrames || 0),
        error
      })
      // Playback finished, yet our Corestore keeps seeding the cached video P2P to the swarm!
      if (ended) activeMedia = null
      return next
    },
    command: applyCommand,
    rotateCode () {
      identity.pairCode = generatePairCode()
      identity.pairToken = randomHex(16)
      writeJsonAtomic(idFile, identity)
      notifyLocalHost(true)
      return detailedInfo()
    },
    async setHost (nextHost) {
      if (nextHost === currentHost) return
      currentHost = nextHost
      await refreshMdns()
      notifyLocalHost(true)
    },
    async close () {
      if (closing) return
      closing = true
      clearInterval(peerStatsTimer)
      clearInterval(readAheadTimer)
      for (const media of streams.values()) media.window?.range.destroy()
      streams.clear()
      activeMedia = null
      const prevAd = adHandle
      adHandle = null
      if (prevAd) await Promise.resolve(prevAd.stop?.()).catch(() => {})
      for (const c of activeNoiseConns) { try { c.destroy() } catch {} }
      activeNoiseConns.clear()
      noiseSubscribers.clear()
      if (noiseServer) await noiseServer.close().catch(() => {})
      if (managedPeerNode) {
        const m = managedPeerNode
        managedPeerNode = null
        await m.close().catch(() => {})
      }
      await httpSrv.closeAllAndStop()
    }
}
}

// Sender & Hub Cast Controller: discovers LAN mDNS receivers, dials Noise P2P keypairs across subnets,
// hosts zero-install Smart TV Web Receivers, and pumps token-gated HTTP Range bytes from Corestore.
export function createCastController ({
  storage,
  getNode,
  ensureNode = null,
  getLanHost = () => null,
  adapter = null,
  onchange = null,
  worklet = false
}) {
  mkdirSync(storage, { recursive: true, mode: 0o700 })
  const savedFile = join(storage, 'cast-receivers.json')
  const saved = new Map()
  try {
    for (const item of JSON.parse(readFileSync(savedFile, 'utf8'))) {
      if (item?.id) saved.set(item.id, item)
    }
  } catch {}

  const discovered = new Map()
  const webReceivers = new Map()
  const allowedCastBlobs = new Set()

  let browseHandle = null
  let browseHost = undefined
  let castBlobServer = null
  let castHubServer = null
  let castHubPort = 0
  let localReceiver = null
  let active = null
  let closing = false

  function emitChange () {
    if (!closing) onchange?.()
  }

  function persistSaved () {
    writeJsonAtomic(savedFile, [...saved.values()])
  }

  async function ensureLanBlobServer () {
    if (castBlobServer) return castBlobServer
    const node = getNode()
    if (!node) throw new Error('Node not started')
    // Stock hypercore-blob-server; its default random token keeps LAN links unguessable.
    const srv = new BlobServer(node.store.session(), {
      host: getLanHost() || '127.0.0.1',
      address: '0.0.0.0',
      port: 0,
      anyPort: true,
      resolve: key => allowedCastBlobs.has(b4a.toString(key, 'hex')) ? { key } : null
    })
    await srv.listen()
    castBlobServer = srv
    return srv
  }

  async function ensureWebHubServer () {
    if (castHubServer) return castHubPort
    const srv = attachSocketTracker(createServer(async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const p = url.pathname
      if (req.method === 'GET' && (p === '/' || p === '/tv')) {
        res.writeHead(200, { ...CORS, 'content-type': 'text/html; charset=utf-8' })
        res.end(receiverPage({ mode: 'hub', defaultName: 'Smart TV Browser' }))
        return
      }
      if (req.method === 'GET' && p === '/v1/cast/web-events') {
        handleWebEvents(req, res, url)
        return
      }
      if (req.method === 'GET' && p === '/cast/v1/events') {
        handleHubSenderEvents(req, res, url)
        return
      }
      let status = 200
      let payload
      try {
        if (req.method === 'POST' && p === '/v1/cast/web-register') {
          payload = await registerWebReceiver(await readJsonBody(req))
        } else if (req.method === 'POST' && p === '/v1/cast/web-state') {
          payload = updateWebReceiverState(await readJsonBody(req))
        } else if (p.startsWith('/cast/v1/')) {
          payload = await handleHubCastJson(req, url)
        } else {
          status = 404
          payload = { error: 'Not found' }
        }
      } catch (err) {
        status = err.status || 400
        payload = { error: err.message }
      }
      res.writeHead(status, { ...CORS, 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }))
    castHubPort = await listenHttp(srv, 8177, '0.0.0.0', true).catch(() => 0)
    castHubServer = castHubPort ? srv : null
    return castHubPort
  }

  async function registerWebReceiver ({ id, token, name }) {
    const cleanId = (id && webReceivers.has(id) && safeEqual(token, webReceivers.get(id).webToken))
      ? id
      : `web-${randomHex(8)}`
    let rec = webReceivers.get(cleanId)
    if (!rec) {
      rec = {
        id: cleanId,
        name: cleanName(name, 'Smart TV Browser'),
        webToken: randomHex(16),
        pairToken: randomHex(16),
        pairCode: generatePairCode(),
        clients: new Set(),
        senderSse: new Set(),
        seq: 0,
        state: idleCastState()
      }
      webReceivers.set(cleanId, rec)
      saved.set(cleanId, { id: cleanId, name: rec.name, host: '127.0.0.1', port: 0, publicKey: '', token: rec.pairToken, p2p: false, webHosted: true })
      persistSaved()
    } else if (name) {
      rec.name = cleanName(name, rec.name)
      const s = saved.get(cleanId)
      if (s) { s.name = rec.name; persistSaved() }
    }
    emitChange()
    const hubPort = castHubPort || Number(process.env.PEARTUBE_API_PORT || 8174)
    const uri = formatReceiverUri({
      deviceId: rec.id,
      name: rec.name,
      token: rec.pairToken,
      host: getLanHost() || '127.0.0.1',
      port: hubPort,
      p2p: false
    })
    return {
      id: rec.id,
      name: rec.name,
      webToken: rec.webToken,
      pairCode: 'OPEN',
      pairingUri: uri,
      qrSvg: qrSvg(uri)
    }
  }

  function handleHubSenderEvents (req, res, url) {
    const tok = url.searchParams.get('token') || ''
    const rec = [...webReceivers.values()].find(r => safeEqual(tok, r.pairToken)) || [...webReceivers.values()].find(r => r.clients.size > 0)
    if (!rec) {
      res.writeHead(401, { ...CORS, 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    res.writeHead(200, { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(b4a.from(`data: ${JSON.stringify({ event: 'state', state: rec.state })}\n\n`))
    rec.senderSse.add(res)
    req.once('close', () => rec.senderSse.delete(res))
  }

  async function handleHubCastJson (req, url) {
    const p = url.pathname
    const hubPort = castHubPort || Number(process.env.PEARTUBE_API_PORT || 8174)
    if (req.method === 'GET' && p === '/cast/v1/info') {
      const id = url.searchParams.get('id') || ''
      const rec = (id && webReceivers.get(id)) || [...webReceivers.values()].find(r => r.clients.size > 0) || webReceivers.values().next().value
      if (!rec) throw Object.assign(new Error('No active Smart TV browser receiver'), { status: 404 })
      return { protocol: 'peartube-cast/v1', deviceId: rec.id, name: rec.name, publicKey: '', swarmKey: '', host: getLanHost() || '127.0.0.1', port: hubPort, capabilities: { p2p: false, httpRange: true }, authRequired: false, state: rec.state }
    }
    if (req.method === 'POST' && p === '/cast/v1/pair') {
      const body = await readJsonBody(req)
      const cleanCode = normalizePairCode(body.code)
      const rec = (cleanCode && [...webReceivers.values()].find(r => safeEqual(cleanCode, r.pairCode))) || [...webReceivers.values()].find(r => r.clients.size > 0) || webReceivers.values().next().value
      if (!rec) throw Object.assign(new Error('No active Smart TV browser receiver'), { status: 404 })
      return { deviceId: rec.id, name: rec.name, publicKey: '', port: hubPort, token: rec.pairToken, capabilities: { p2p: false, httpRange: true } }
    }
    if (req.method === 'POST' && p === '/cast/v1/command') {
      const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
      const rec = (auth && [...webReceivers.values()].find(r => safeEqual(auth, r.pairToken))) || [...webReceivers.values()].find(r => r.clients.size > 0)
      if (!rec) throw Object.assign(new Error('No active Smart TV browser receiver'), { status: 404 })
      const cmd = await readJsonBody(req)
      const streamUrl = cmd.streamUrl || cmd.httpStreamUrl
      const nextCmd = cmd.action === 'load'
        ? { seq: ++rec.seq, action: 'load', entry: cmd.entry, mode: 'http', streamUrl, httpStreamUrl: streamUrl, startPositionMs: Math.max(0, Number(cmd.startPositionMs) || 0) }
        : { seq: ++rec.seq, ...cmd }
      const frame = b4a.from(`data: ${JSON.stringify({ event: 'command', command: nextCmd })}\n\n`)
      for (const client of rec.clients) { try { client.write(frame) } catch { rec.clients.delete(client) } }
      if (cmd.action === 'load') {
        rec.state = { ...idleCastState(), status: 'loading', mode: 'http', entry: cmd.entry || null, positionMs: nextCmd.startPositionMs || 0, playing: true, buffering: true }
      } else if (cmd.action === 'stop') {
        rec.state = idleCastState()
      }
      const stFrame = b4a.from(`data: ${JSON.stringify({ event: 'state', state: rec.state })}\n\n`)
      for (const s of rec.senderSse) { try { s.write(stFrame) } catch { rec.senderSse.delete(s) } }
      return { ok: true, state: rec.state }
    }
    return undefined
  }

  function handleWebEvents (req, res, url) {
    const id = url.searchParams.get('id') || ''
    const tok = url.searchParams.get('token') || ''
    const rec = webReceivers.get(id)
    if (!rec || !safeEqual(tok, rec.webToken)) {
      res.writeHead(401, { ...CORS, 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    res.writeHead(200, { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(b4a.from(': connected\n\n'))
    rec.clients.add(res)
    emitChange()
    req.once('close', () => {
      rec.clients.delete(res)
      emitChange()
    })
  }

  function updateWebReceiverState ({ id, token, state: next }) {
    const rec = webReceivers.get(id)
    if (!rec || !safeEqual(token, rec.webToken)) throw Object.assign(new Error('Unauthorized'), { status: 401 })
    if (next && typeof next === 'object') {
      rec.state = { ...rec.state, ...next, updatedAt: Date.now() }
      const stFrame = b4a.from(`data: ${JSON.stringify({ event: 'state', state: rec.state })}\n\n`)
      for (const s of rec.senderSse || []) { try { s.write(stFrame) } catch { rec.senderSse.delete(s) } }
      if (active?.receiverId === id) {
        active.state = rec.state
        emitChange()
      }
    }
    return { ok: true }
  }

  async function refreshBrowse (host) {
    if (host === browseHost && browseHandle) return
    const prev = browseHandle
    browseHandle = null
    browseHost = host
    if (prev) await Promise.resolve(prev.stop?.()).catch(() => {})
    if (closing || (!host && !adapter)) {
      discovered.clear()
      emitChange()
      return
    }
    try {
      const mdns = adapterForHost(host, adapter)
      browseHandle = mdns.browse({ type: CAST_SERVICE_TYPE, protocol: 'tcp' }, {
        onService (svc) {
          if (svc?.type !== CAST_SERVICE_TYPE && svc?.txt?.proto !== CAST_SERVICE_TYPE) return
          const txt = svc.txt || {}
          const id = String(txt.id || txt.pk || '').trim()
          if (!id || (localReceiver && id === localReceiver.deviceId)) return
          const addr = isIPv4(String(txt.h || '')) ? String(txt.h) : (Array.isArray(svc.addresses) ? svc.addresses.find(isIPv4) : null)
          if (!addr || !svc.port) return
          discovered.set(id, {
            id,
            name: cleanName(txt.name || svc.name, 'PearTube TV'),
            host: addr,
            port: Number(svc.port),
            publicKey: HEX64.test(String(txt.pk || '').toLowerCase()) ? String(txt.pk).toLowerCase() : '',
            p2p: txt.p2p === '1',
            auth: txt.auth === 'open' ? 'open' : 'code',
            seenAt: Date.now()
          })
          const existing = saved.get(id) || (txt.pk && [...saved.values()].find(s => s.publicKey && s.publicKey === String(txt.pk).toLowerCase()))
          if (existing) {
            existing.host = addr
            existing.port = Number(svc.port)
            if (txt.pk && HEX64.test(String(txt.pk).toLowerCase())) existing.publicKey = String(txt.pk).toLowerCase()
            existing.p2p = existing.p2p || txt.p2p === '1'
            persistSaved()
          }
          emitChange()
        },
        onServiceDown (svc) {
          const id = String(svc?.txt?.id || '')
          if (id && discovered.delete(id)) emitChange()
        },
        onError () {}
      })
    } catch {}
  }

  function listReceivers () {
    const merged = new Map()
    for (const [id, rec] of webReceivers) {
      if (rec.clients.size === 0 && active?.receiverId !== id) continue
      merged.set(id, {
        id,
        name: rec.name,
        host: getLanHost() || '127.0.0.1',
        port: castHubPort,
        publicKey: '',
        online: rec.clients.size > 0,
        paired: true,
        p2p: false,
        transport: 'web',
        auth: 'open'
      })
    }
    for (const [id, d] of discovered) {
      const pair = saved.get(id) || (d.publicKey ? [...saved.values()].find(s => s.publicKey === d.publicKey) : null)
      merged.set(pair?.id || id, {
        id: pair?.id || id,
        name: d.name || pair?.name || 'PearTube TV',
        host: d.host,
        port: d.port,
        publicKey: d.publicKey || pair?.publicKey || '',
        online: true,
        paired: Boolean(pair?.token) || d.auth === 'open',
        p2p: Boolean(d.p2p || pair?.p2p),
        transport: (d.publicKey || pair?.publicKey) ? 'lan+p2p' : 'lan',
        auth: d.auth
      })
    }
    for (const [id, s] of saved) {
      if (s.webHosted || merged.has(id)) continue
      if (s.host && s.port && [...discovered.values()].some(d => d.host === s.host && d.port === s.port)) continue
      merged.set(id, {
        id,
        name: s.name || 'Paired TV',
        host: s.host || null,
        port: s.port || 0,
        publicKey: s.publicKey || '',
        online: Boolean(s.publicKey) || active?.receiverId === id,
        paired: Boolean(s.token),
        p2p: Boolean(s.p2p || s.publicKey),
        transport: s.publicKey ? (s.host ? 'lan+p2p' : 'p2p') : 'lan',
        auth: 'code'
      })
    }
    return [...merged.values()]
  }

  async function pairReceiver ({ id = '', code = '', uri = '', host = '', port = 0, publicKey = '', name = '' } = {}) {
    if (uri) {
      const parsed = parseReceiverUri(uri)
      const recId = parsed.deviceId || parsed.publicKey || `${parsed.host}:${parsed.port}`
      const record = {
        id: recId,
        name: cleanName(parsed.name, 'Paired TV'),
        host: parsed.host || '',
        port: Number(parsed.port) || 0,
        publicKey: parsed.publicKey || '',
        token: parsed.token || '',
        p2p: Boolean(parsed.p2p || parsed.publicKey)
      }
      if (!record.token && code) {
        return pairReceiver({ id: recId, code, host: record.host, port: record.port, publicKey: record.publicKey, name: record.name })
      }
      if (record.host && record.port > 0) {
        try {
          const info = await httpJson(`http://${record.host}:${record.port}/cast/v1/info`, { timeoutMs: 2500 })
          if (info.deviceId) record.id = info.deviceId
          if (info.name) record.name = cleanName(info.name)
          if (info.publicKey) record.publicKey = info.publicKey
          record.p2p = Boolean(info.capabilities?.p2p || record.publicKey)
        } catch {}
      }
      saved.set(record.id, record)
      persistSaved()
      emitChange()
      return record
    }

    const disc = discovered.get(id) || [...discovered.values()].find(d => d.publicKey && d.publicKey === publicKey)
    const targetHost = host || disc?.host || ''
    const targetPort = Number(port || disc?.port || 0)
    const targetPk = (publicKey || disc?.publicKey || (HEX64.test(id.toLowerCase()) ? id.toLowerCase() : '')).toLowerCase()
    const cleanCode = normalizePairCode(code)

    if (targetHost && targetPort > 0) {
      try {
        const res = await httpJson(`http://${targetHost}:${targetPort}/cast/v1/pair`, {
          method: 'POST',
          body: { code: cleanCode, clientName: 'PearTube' },
          timeoutMs: 5000
        })
        const recId = res.deviceId || id || targetPk || `${targetHost}:${targetPort}`
        const record = {
          id: recId,
          name: cleanName(res.name || name || disc?.name, 'PearTube TV'),
          host: targetHost,
          port: res.port || targetPort,
          publicKey: res.publicKey || targetPk,
          token: res.token || '',
          p2p: Boolean(res.capabilities?.p2p || res.publicKey || targetPk)
        }
        saved.set(recId, record)
        persistSaved()
        emitChange()
        return record
      } catch (err) {
        if (!targetPk || /pairing code/i.test(err.message)) throw err
      }
    }

    if (targetPk) {
      const node = getNode() || (ensureNode ? await ensureNode() : null)
      if (!node?.swarm?.dht) throw new Error('Start PearTube P2P node before pairing over Noise public key')
      const rpc = await connectNoiseRpc(node.swarm.dht, targetPk, { relayThrough: node.swarm.relayThrough })
      try {
        const res = await rpc.call('pair', { code: cleanCode, clientName: 'PearTube' })
        const recId = res.deviceId || targetPk
        const record = {
          id: recId,
          name: cleanName(res.name || name, 'PearTube TV'),
          host: targetHost,
          port: targetPort,
          publicKey: res.publicKey || targetPk,
          token: res.token || '',
          p2p: true
        }
        saved.set(recId, record)
        persistSaved()
        emitChange()
        return record
      } finally {
        rpc.close()
      }
    }

    throw new Error('Receiver not reachable on LAN or P2P public key')
  }

  function removeReceiver (id) {
    const removed = saved.delete(id)
    if (removed) {
      persistSaved()
      emitChange()
    }
    return { removed }
  }

  function closeActiveTransport () {
    if (!active) return
    clearInterval(active.pollTimer)
    try { active.sseReq?.destroy() } catch {}
    try { active.noiseRpc?.close() } catch {}
    active = null
  }

  function subscribeHttpSse (baseUrl, token, sessionRef) {
    let lastSseAt = 0
    const url = `${baseUrl}/cast/v1/events${token ? `?token=${encodeURIComponent(token)}` : ''}`
    const req = httpRequest(url, res => {
      if (res.statusCode !== 200) { res.resume?.(); return }
      let buf = ''
      res.on('data', chunk => {
        if (active !== sessionRef) return
        lastSseAt = Date.now()
        buf += b4a.toString(b4a.isBuffer(chunk) ? chunk : b4a.from(chunk))
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue
            try {
              const ev = JSON.parse(line.slice(5).trim())
              if (ev.event === 'state' && ev.state && active === sessionRef) {
                sessionRef.state = ev.state
                emitChange()
              }
            } catch {}
          }
        }
      })
    })
    req.on('error', () => {})
    req.end()
    sessionRef.sseReq = req
    sessionRef.pollTimer = setInterval(async () => {
      if (active !== sessionRef || Date.now() - lastSseAt < 1200) return
      try {
        const info = await httpJson(`${baseUrl}/cast/v1/info`, { timeoutMs: 1500 })
        if (active === sessionRef && info?.state) {
          sessionRef.state = info.state
          emitChange()
        }
      } catch {}
    }, 1000)
    sessionRef.pollTimer.unref?.()
  }

  async function resolveEntryToCast (node, { key, uri }) {
    if (uri) {
      const opened = await node.openUri(uri)
      if (opened.action !== 'watch' || !opened.entry) throw new Error('URI is not a playable watch link')
      const raw = await node.findEntry(opened.entry.key)
      return { item: opened.entry, raw }
    }
    if (!key) throw new Error('Entry key or watch URI required to cast')
    const raw = await node.findEntry(key)
    if (!raw) throw new Error(`Entry not found: ${key}`)
    const list = await node.search(raw.id)
    const item = list.find(e => e.key === key) || {
      key,
      id: raw.id,
      title: raw.title,
      size: raw.size,
      sha256: raw.sha256,
      magnetUrl: formatWatchUri(raw)
    }
    return { item, raw }
  }

  async function castPlay ({ receiverId, key = null, uri = null, preferMode = 'auto', startPositionMs = 0 }) {
    const node = getNode() || (ensureNode ? await ensureNode() : null)
    if (!node) throw new Error('P2P node is not started')
    const { item, raw } = await resolveEntryToCast(node, { key, uri })
    const discTarget = discovered.get(receiverId)
    const pairTarget = saved.get(receiverId)
    const targetP2PCapable = Boolean(discTarget?.p2p || pairTarget?.p2p)
    // Don't pull a second uncached 4K stream onto the phone's Wi-Fi radio when a P2P TV receiver will stream directly from the swarm.
    if (!targetP2PCapable || item.local || (item.cachedBytes || 0) > 0) {
      await node.warm(raw)
    }
    allowedCastBlobs.add(raw.blobs)
    const lanHost = getLanHost()
    const blobSrv = await ensureLanBlobServer()
    const hostForReceiver = webReceivers.has(receiverId)
      ? (lanHost || '127.0.0.1')
      : (lanHost || (discovered.get(receiverId)?.host === '127.0.0.1' || saved.get(receiverId)?.host === '127.0.0.1' ? '127.0.0.1' : null))
    const httpStreamUrl = hostForReceiver
      ? blobSrv.getLink(b4a.from(raw.blobs, 'hex'), { host: hostForReceiver, blob: raw.blob, type: guessMediaMime(raw) })
      : null

    const loadPayload = {
      action: 'load',
      entry: { key: item.key, id: item.id, title: item.title, size: item.size, sha256: item.sha256 },
      httpStreamUrl,
      magnetUrl: item.magnetUrl || formatWatchUri(raw, item.source || '', item.sourceKind || ''),
      senderPeerKey: b4a.toString(node.swarm.keyPair.publicKey, 'hex'),
      senderPrivateRouting: Boolean(node.privateRouting),
      senderLan: !node.privateRouting ? (node.lanEndpoint?.() || null) : null,
      network: {
        privateRouting: Boolean(node.privateRouting),
        bootstrap: node.bootstrap || null,
        relayThrough: node.relayThrough || null,
        lan: Boolean(node.hasLan?.()),
        sourceKey: item.source && HEX64.test(item.source) ? item.source : '',
        sourceKind: item.sourceKind === 'channel' ? 'channel' : 'tracker'
      },
      preferMode,
      startPositionMs: Math.max(0, Number(startPositionMs) || 0)
    }
    // 1. Hosted Smart TV Web Receiver connected directly to our hub.
    if (webReceivers.has(receiverId)) {
      const rec = webReceivers.get(receiverId)
      if (!httpStreamUrl) throw new Error('Smart TV Web Receiver needs a LAN IPv4 address for HTTP streaming')
      closeActiveTransport()
      const cmd = { seq: ++rec.seq, action: 'load', entry: loadPayload.entry, mode: 'http', streamUrl: httpStreamUrl, httpStreamUrl, startPositionMs: loadPayload.startPositionMs }
      const frame = b4a.from(`data: ${JSON.stringify({ event: 'command', command: cmd })}\n\n`)
      for (const res of rec.clients) { try { res.write(frame) } catch { rec.clients.delete(res) } }
      rec.state = { ...idleCastState(), status: 'loading', mode: 'http', entry: loadPayload.entry, positionMs: loadPayload.startPositionMs, playing: true, buffering: true }
      active = { receiverId, receiverName: rec.name, transport: 'web', token: rec.pairToken, state: rec.state }
      emitChange()
      return status()
    }

    const disc = discovered.get(receiverId)
    const pair = saved.get(receiverId) || (disc?.publicKey ? [...saved.values()].find(s => s.publicKey === disc.publicKey) : null)
    const targetHost = disc?.host || pair?.host || ''
    const targetPort = Number(disc?.port || pair?.port || 0)
    const targetPk = (disc?.publicKey || pair?.publicKey || '').toLowerCase()
    const token = pair?.token || ''
    const receiverName = disc?.name || pair?.name || 'PearTube TV'

    if (!token && disc?.auth !== 'open') {
      throw new Error(`Pair with ${receiverName} using its 6-character TV code before casting`)
    }

    closeActiveTransport()

    // 2. Fast LAN HTTP + SSE baseline when receiver is reachable on the local network.
    if (targetHost && targetPort > 0) {
      const localLoad = (!httpStreamUrl && targetHost === '127.0.0.1')
        ? { ...loadPayload, httpStreamUrl: blobSrv.getLink(b4a.from(raw.blobs, 'hex'), { host: '127.0.0.1', blob: raw.blob, type: guessMediaMime(raw) }) }
        : loadPayload
      try {
        const baseUrl = `http://${targetHost}:${targetPort}`
        const info = await httpJson(`${baseUrl}/cast/v1/info`, { timeoutMs: 2500 }).catch(() => null)
        if (HEX64.test(String(info?.swarmKey || ''))) {
          const sk = b4a.from(info.swarmKey, 'hex')
          if (!b4a.equals(sk, node.swarm.keyPair.publicKey)) try { node.swarm.joinPeer(sk) } catch {}
        }
        const headers = token ? { authorization: `Bearer ${token}` } : {}
        const res = await httpJson(`${baseUrl}/cast/v1/command`, { method: 'POST', headers, body: localLoad, timeoutMs: 12_000 })
        if (!node.privateRouting && res.state?.peerLan) node.dialLanPeer?.(res.state.peerLan)
        if (HEX64.test(String(res.state?.peerSwarmKey || ''))) {
          const psk = b4a.from(res.state.peerSwarmKey, 'hex')
          if (!b4a.equals(psk, node.swarm.keyPair.publicKey)) {
            if (!node.privateRouting && node.hasLan?.() && targetHost !== '127.0.0.1') {
              setTimeout(() => {
                if (!node.closing && !node.hasLanPeer?.(psk)) {
                  try { node.swarm.joinPeer(psk) } catch {}
                }
              }, 1500).unref?.()
            } else {
              try { node.swarm.joinPeer(psk) } catch {}
            }
          }
        }
        const sessionRef = { receiverId, receiverName, transport: 'lan', baseUrl, token, publicKey: targetPk, state: res.state || idleCastState(), sseReq: null, noiseRpc: null }
        active = sessionRef
        subscribeHttpSse(baseUrl, token, sessionRef)
        emitChange()
        return status()
      } catch (err) {
        if (!targetPk || /unauthorized|pair/i.test(err.message)) throw err
      }
    }

    // 3. Cross-subnet / remote P2P Noise stream over HyperDHT using paired publicKey.
    if (targetPk) {
      const rpc = await connectNoiseRpc(node.swarm.dht, targetPk, {
        relayThrough: node.swarm.relayThrough,
        onState: nextState => {
          if (active?.noiseRpc === rpc) {
            active.state = nextState
            emitChange()
          }
        },
        onClose: () => {
          if (active?.noiseRpc === rpc) emitChange()
        }
      })
      try {
        await rpc.call('subscribe', { token })
        const res = await rpc.call('cmd', { token, ...loadPayload }, 20_000)
        if (HEX64.test(String(res.state?.peerSwarmKey || ''))) {
          const psk = b4a.from(res.state.peerSwarmKey, 'hex')
          if (!b4a.equals(psk, node.swarm.keyPair.publicKey)) try { node.swarm.joinPeer(psk) } catch {}
        }
        active = { receiverId, receiverName, transport: 'p2p', baseUrl: null, token, publicKey: targetPk, state: res.state || idleCastState(), sseReq: null, noiseRpc: rpc }
        return status()
      } catch (err) {
        rpc.close()
        throw err
      }
    }

    throw new Error(`Cannot reach receiver ${receiverName}`)
  }

  // Reconnects as a remote control to a TV receiver that is already playing autonomously P2P.
  async function castAttach ({ receiverId }) {
    const disc = discovered.get(receiverId)
    const pair = saved.get(receiverId) || (disc?.publicKey ? [...saved.values()].find(s => s.publicKey === disc.publicKey) : null)
    const targetHost = disc?.host || pair?.host || ''
    const targetPort = Number(disc?.port || pair?.port || 0)
    const targetPk = (disc?.publicKey || pair?.publicKey || '').toLowerCase()
    const token = pair?.token || ''
    const receiverName = disc?.name || pair?.name || 'PearTube TV'
    closeActiveTransport()
    if (targetHost && targetPort > 0) {
      const baseUrl = `http://${targetHost}:${targetPort}`
      const headers = token ? { authorization: `Bearer ${token}` } : {}
      const res = await httpJson(`${baseUrl}/cast/v1/command`, { method: 'POST', headers, body: { action: 'status' }, timeoutMs: 5000 })
      const sessionRef = { receiverId, receiverName, transport: 'lan', baseUrl, token, publicKey: targetPk, state: res.state || idleCastState(), sseReq: null, noiseRpc: null }
      active = sessionRef
      subscribeHttpSse(baseUrl, token, sessionRef)
      emitChange()
      return status()
    }
    if (targetPk) {
      const node = getNode() || (ensureNode ? await ensureNode() : null)
      if (!node?.swarm?.dht) throw new Error('Start PearTube P2P node before attaching over Noise public key')
      const rpc = await connectNoiseRpc(node.swarm.dht, targetPk, {
        relayThrough: node.swarm.relayThrough,
        onState: nextState => { if (active?.noiseRpc === rpc) { active.state = nextState; emitChange() } },
        onClose: () => { if (active?.noiseRpc === rpc) emitChange() }
      })
      await rpc.call('subscribe', { token })
      const res = await rpc.call('cmd', { token, action: 'status' })
      active = { receiverId, receiverName, transport: 'p2p', baseUrl: null, token, publicKey: targetPk, state: res.state || idleCastState(), sseReq: null, noiseRpc: rpc }
      emitChange()
      return status()
    }
    throw new Error(`Cannot reach receiver ${receiverName}`)
  }

  async function castControl (cmd) {
    if (!active) throw new Error('No active cast session')
    if (active.transport === 'web') {
      const rec = webReceivers.get(active.receiverId)
      if (!rec) throw new Error('Web TV disconnected')
      const fullCmd = { seq: ++rec.seq, ...cmd }
      const frame = b4a.from(`data: ${JSON.stringify({ event: 'command', command: fullCmd })}\n\n`)
      for (const res of rec.clients) { try { res.write(frame) } catch { rec.clients.delete(res) } }
      if (cmd.action === 'stop') {
        rec.state = idleCastState()
        closeActiveTransport()
      }
      emitChange()
      return status()
    }
    if (active.transport === 'lan' && active.baseUrl) {
      const headers = active.token ? { authorization: `Bearer ${active.token}` } : {}
      const res = await httpJson(`${active.baseUrl}/cast/v1/command`, { method: 'POST', headers, body: cmd, timeoutMs: 5000 })
      if (res.state) active.state = res.state
      if (cmd.action === 'stop') closeActiveTransport()
      emitChange()
      return status()
    }
    if (active.transport === 'p2p' && active.noiseRpc && !active.noiseRpc.closed) {
      const res = await active.noiseRpc.call('cmd', { token: active.token, ...cmd })
      if (res.state) active.state = res.state
      if (cmd.action === 'stop') closeActiveTransport()
      emitChange()
      return status()
    }
    throw new Error('Cast session transport disconnected')
  }

  async function castStop ({ stopPlayback = true } = {}) {
    if (!active) return status()
    if (stopPlayback) await castControl({ action: 'stop' }).catch(() => {})
    closeActiveTransport()
    allowedCastBlobs.clear()
    emitChange()
    return status()
  }

  async function startLocalReceiver ({ name = 'PearTube TV', port = 8176, openAuth = true, peerStorage = null, onCommand = null } = {}) {
    if (localReceiver) await localReceiver.close().catch(() => {})
    const node = getNode() || (ensureNode ? await ensureNode() : null)
    localReceiver = await createReceiver({
      storage,
      peerStorage,
      name,
      port,
      lanHost: getLanHost(),
      node,
      adapter,
      allowPeerNode: true,
      openAuth,
      onCommand,
      onChange: () => emitChange(),
      worklet
    })
    emitChange()
    return localReceiver.info()
  }

  async function stopLocalReceiver () {
    if (!localReceiver) return
    const prev = localReceiver
    localReceiver = null
    await prev.close().catch(() => {})
    emitChange()
  }

  function status () {
    const lanHost = getLanHost()
    return {
      webReceiverUrl: castHubPort && lanHost ? `http://${lanHost}:${castHubPort}/tv` : (castHubPort ? `http://127.0.0.1:${castHubPort}/tv` : null),
      receivers: localReceiver ? [] : listReceivers(),
      session: active ? {
        receiverId: active.receiverId,
        receiverName: active.receiverName,
        transport: active.transport,
        state: active.state
      } : null,
      receiverMode: localReceiver ? localReceiver.info() : null
    }
  }

  return {
    initHub: ensureWebHubServer,
    setLanHost: async host => {
      await refreshBrowse(host)
      await localReceiver?.setHost(host)
    },
    listReceivers,
    pairReceiver,
    removeReceiver,
    castPlay,
    castAttach,
    castControl,
    castStop,
    registerWebReceiver,
    handleWebEvents,
    updateWebReceiverState,
    handleHubSenderEvents,
    handleHubCastJson,
    webSetupQrSvg: url => url ? qrSvg(url) : '',
    startLocalReceiver,
    stopLocalReceiver,
    rotateLocalReceiverCode: () => localReceiver ? localReceiver.rotateCode() : null,
    reportLocalReceiverState: patch => localReceiver ? localReceiver.reportState(patch) : null,
    status,
    async close () {
      closing = true
      closeActiveTransport()
      allowedCastBlobs.clear()
      const prevBrowse = browseHandle
      browseHandle = null
      if (prevBrowse) await Promise.resolve(prevBrowse.stop?.()).catch(() => {})
      if (localReceiver) {
        const r = localReceiver
        localReceiver = null
        await r.close().catch(() => {})
      }
      if (castBlobServer) {
        const b = castBlobServer
        castBlobServer = null
        await b.close().catch(() => {})
      }
      if (castHubServer) {
        const h = castHubServer
        castHubServer = null
        await h.closeAllAndStop().catch(() => {})
      }
    }
  }
}
