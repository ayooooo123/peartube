// PearTube Cast & TV Receiver stack (peartube-cast/v1). A receiver is a node with a player: senders find it by mDNS or
// by its key, connect to it as to any peer, and pair with and control it on a channel of that one connection
// (src/cast-control.js). The film reaches it over the same connection and the swarm. Pairing secrets stay outside
// Corestore, so they never reach replicating strangers.
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { isIPv4 } from 'node:net'
import os from 'node:os'
import hypercoreCrypto from 'hypercore-crypto'
import Corestore from 'corestore'
import HyperDHT from 'hyperdht'
import ByteStream from 'hypercore-byte-stream'
import b4a from 'b4a'
import { HEX64, RECEIVER_PORT, cleanName, formatReceiverUri, formatWatchUri, parseUri } from './protocol.js'
import { interfaceAdapter, selfAddressAdapter } from './lan.js'
import { qrSvg } from './qr.js'
import { openControl, serveControl } from './cast-control.js'

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const CAST_SERVICE_TYPE = 'peartube-cast'
// Senders and receivers on one LAN join this LAN-only topic, so LAN discovery links their nodes (src/lan.js connects
// only peers that share a topic) before a cast needs the link.
const CAST_LAN_TOPIC = hypercoreCrypto.hash(b4a.from('peartube-cast/v1'))
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
  const bytes = hypercoreCrypto.randomBytes(6)
  let out = ''
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return out
}

function randomHex (bytes = 16) {
  return b4a.toString(hypercoreCrypto.randomBytes(bytes), 'hex')
}

// The content type of the loopback stream. PearTube's player probes the bytes, so this is only a hint.
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

function writeJsonAtomic (file, data) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

// A receiver's saved identity: its name, the seed of the key senders pair with, and its pairing secrets.
function loadIdentity (storage, name = '') {
  mkdirSync(storage, { recursive: true, mode: 0o700 })
  const file = join(storage, 'receiver.json')
  let identity = null
  try { identity = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  if (!identity || !HEX64.test(String(identity.seed || ''))) {
    identity = { deviceId: randomHex(16), name: cleanName(name), seed: randomHex(32), pairToken: randomHex(16), pairCode: generatePairCode() }
    writeJsonAtomic(file, identity)
  } else if (name && identity.name !== cleanName(name)) {
    identity.name = cleanName(name)
    writeJsonAtomic(file, identity)
  }
  return identity
}

// The key a receiver's node runs under. A host opens that node with it, so the key senders paired with stays the
// same after a restart.
export function receiverKeyPair (storage) {
  return HyperDHT.keyPair(b4a.from(loadIdentity(storage).seed, 'hex'))
}

function adapterForHost (host, customAdapter) {
  if (customAdapter) return typeof customAdapter === 'function' ? customAdapter(host) : customAdapter
  if (!host || host === '127.0.0.1') return selfAddressAdapter(host || '127.0.0.1')
  return interfaceAdapter(host)
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

// A TV receiver on `node`, the node the host opened for it (with `receiverKeyPair`, so pairings last). It advertises
// itself over mDNS, answers senders on the cast channel of their connection to that node, downloads what they cast
// over the swarm, and serves it to its own player on a loopback port.
export async function createReceiver ({
  storage,
  // Where the node keeps the films it plays, when that is another disk than `storage`.
  peerStorage = null,
  name = os.hostname?.() || 'PearTube TV',
  port = RECEIVER_PORT,
  lanHost = null,
  node,
  adapter = null,
  // No pairing for senders in the same room: any sender on a LAN link may cast.
  openAuth = false,
  onCommand = null,
  onChange = null
}) {
  if (!node) throw new Error('A receiver needs a node')
  const identity = loadIdentity(storage, name)
  const peerRoot = await resolvePeerStorage(peerStorage, storage)
  const publicKey = node.peerKey
  node.joinLanTopic('cast', CAST_LAN_TOPIC)

  let currentHost = lanHost
  let actualPort = 0
  let closing = false
  let commandSeq = 0
  let state = idleCastState()
  let activeMedia = null
  let adHandle = null
  // Wrong pairing codes, counted apart for LAN links and all others: a stranger across the internet cannot lock out
  // pairing in the room.
  const pairFailures = { lan: [], far: [] }
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
      node.evictBehind?.(media.coreKeyHex, blob, { playheadByte, keepBehindBytes, maxBytes }).catch(() => {}).finally(() => { evicting = false })
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

  // Cast channels senders have open, those sent each state change, and those with a write pending.
  const controls = new Set()
  const subscribers = new Set()
  const backpressured = new WeakSet()

  function pairingUri () {
    return formatReceiverUri({ publicKey, deviceId: identity.deviceId, name: identity.name, token: identity.pairToken, p2p: true })
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

  // What this device's own screen shows: who the receiver is, how to pair with it, and what it plays.
  function info () {
    const uri = pairingUri()
    // Hold the rendered QR SVG hot in memory so playback state ticks never re-run Reed-Solomon math on QuickJS.
    if (uri !== cachedQrUri) {
      cachedQrUri = uri
      cachedQrSvg = qrSvg(uri)
    }
    return {
      protocol: 'peartube-cast/v1',
      deviceId: identity.deviceId,
      name: identity.name,
      publicKey,
      host: currentHost || null,
      port: actualPort,
      authRequired: !openAuth,
      routes: node.status().routes,
      storageFreeBytes: currentFreeBytes(),
      externalStorage: Boolean(String(peerRoot).startsWith('/mnt/expand/') || (peerStorage && peerRoot === peerStorage && peerRoot !== storage)),
      state,
      pairCode: openAuth ? 'OPEN' : identity.pairCode,
      pairingUri: uri,
      qrSvg: cachedQrSvg
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
    for (const control of subscribers) {
      if (backpressured.has(control) || control.push({ event: 'state', state }) !== false) continue
      backpressured.add(control)
      control.conn.once('drain', () => {
        backpressured.delete(control)
        if (!closing && subscribers.has(control)) control.push({ event: 'state', state })
      })
    }
    notifyLocalHost(false)
  }

  function updateState (patch) {
    state = { ...state, ...patch, updatedAt: Date.now() }
    broadcastState()
    return state
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

    // The film comes over the swarm this node is on, public or private as the node is set: a cast never switches it.
    const watch = typeof cmd.magnetUrl === 'string' && cmd.magnetUrl.startsWith('peartube://watch/') ? parseUri(cmd.magnetUrl) : null
    if (watch?.action !== 'watch') throw new Error('A cast load needs a peartube://watch link')
    const { blobs, blob } = watch.entry
    const freeNow = freeDiskBytes(peerRoot)
    if (freeNow < LOW_DISK_BOOT_BYTES || (lastLoadedBlobs && lastLoadedBlobs !== blobs && freeNow < Math.max(3 * 1024 * 1024 * 1024, (entry.size || 0) + LOW_DISK_STREAM_BYTES))) {
      await node.clearCache?.(null, { keepBlobsHex: freeNow < LOW_DISK_STREAM_BYTES ? null : blobs }).catch(() => {})
    }
    lastLoadedBlobs = blobs
    await node.openUri(cmd.magnetUrl)
    const core = await node.blobCore(blobs)
    const token = randomHex(16)
    activeMedia = {
      token,
      entry,
      mime: guessMediaMime(entry),
      core,
      coreKeyHex: blobs,
      blob,
      readers: new Set(),
      servedBytes: 0,
      readRate: 0,
      rateAt: Date.now(),
      rateServed: 0,
      avgRate: 0,
      window: null
    }
    rememberStream(activeMedia)
    // The player reads the windowed route (bounded read-ahead), not the node's blob server, which would download to
    // the end of the film.
    return { entry, mode: node.privateRouting ? 'private-p2p' : 'p2p', streamUrl: `http://127.0.0.1:${actualPort}/cast/v1/p2p/${token}` }
  }

  async function applyCommand (cmd) {
    const action = String(cmd?.action || '')
    if (!action) throw Object.assign(new Error('action is required'), { status: 400 })
    if (action === 'status') return state

    if (action === 'load') {
      const prepared = await prepareMediaLoad(cmd)
      const startPositionMs = Math.max(0, Number(cmd.startPositionMs) || 0)
      const cachedBytes = await countCachedBlobBytes(activeMedia?.core, activeMedia?.blob, prepared.entry.size)
      const stNode = node.status()
      const p2pPeers = stNode.peers + stNode.lanPeers
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
      const fullCmd = { seq: ++commandSeq, action: 'load', entry: prepared.entry, mode: prepared.mode, streamUrl: prepared.streamUrl, startPositionMs }
      if (onCommand) await onCommand(fullCmd, { updateState, getState: () => state })
      return state
    }

    if (action === 'stop') {
      // Keep seededBlobs downloading & seeding in Corestore so this TV remains a normal swarm peer!
      activeMedia = null
      const fullCmd = { seq: ++commandSeq, action: 'stop' }
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
    if (onCommand) await onCommand(fullCmd, { updateState, getState: () => state })
    return updateState(nextPatch)
  }

  // The receiver's own player reads the film here. The port answers this device only.
  const httpSrv = attachSocketTracker(createServer((req, res) => {
    const p = new URL(req.url || '/', 'http://127.0.0.1').pathname
    const streamMatch = (req.method === 'GET' || req.method === 'HEAD') && p.match(/^\/cast\/v1\/p2p\/([0-9a-f]{32})$/)
    const media = streamMatch && streams.get(streamMatch[1])
    if (media) return serveWindowedStream(media, req, res, steerStreams)
    // Playback telemetry for a tool on this device (android/capture-network.mjs through `adb forward`).
    if (req.method === 'GET' && p === '/cast/v1/info') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ deviceId: identity.deviceId, name: identity.name, routes: node.status().routes, state }))
      return
    }
    res.writeHead(404, CORS)
    res.end()
  }))

  actualPort = await listenHttp(httpSrv, port, '127.0.0.1')

  function failedPairings (onLan) {
    const now = Date.now()
    const kind = onLan ? 'lan' : 'far'
    pairFailures[kind] = pairFailures[kind].filter(t => now - t < 15_000)
    if (pairFailures[kind].length >= 6) throw new Error('Too many pairing attempts; wait 15 seconds')
    return pairFailures[kind]
  }
  // Pairing and remote control: the only way in besides this device's own screen. Any peer that connects to the node
  // can send these, so each request is checked. An open receiver is open to the room it is in (LAN links), not to
  // every peer on the internet.
  async function onControl ({ id: _id, type, token, ...msg }, control) {
    const onLan = node.isLanConnection(control.conn)
    const trusted = openAuth && onLan
    if (type === 'pair') {
      const failures = failedPairings(onLan)
      if (!trusted && !safeEqual(normalizePairCode(msg.code), identity.pairCode)) {
        failures.push(Date.now())
        throw new Error('Invalid TV pairing code')
      }
      // An open receiver takes any LAN link without a code, so it hands that peer no permanent token: a saved one
      // would keep working from anywhere after the room is left.
      return { deviceId: identity.deviceId, name: identity.name, publicKey, token: trusted ? '' : identity.pairToken }
    }
    if (!trusted && !safeEqual(token, identity.pairToken)) throw new Error('Unauthorized; pair with this TV first')
    if (type === 'subscribe') {
      subscribers.add(control)
      return { state }
    }
    if (type === 'cmd') return { ok: true, state: await applyCommand(msg) }
    throw new Error(`Unknown cast message: ${type}`)
  }
  const unserve = new Map() // connection -> stops answering on it
  function serve (conn) {
    unserve.set(conn, serveControl(conn, {
      onRequest: onControl,
      onOpen: control => controls.add(control),
      onClose: control => {
        controls.delete(control)
        subscribers.delete(control)
      }
    }))
    conn.once('close', () => unserve.delete(conn))
  }
  const stopServing = node.onConnection(serve)
  for (const conn of node.peerConnections()) serve(conn)

  // The advertisement names the node's LAN endpoint, the address a sender dials. It is renewed when that changes.
  let adSig = ''

  async function refreshMdns () {
    const lan = node.lanEndpoint()
    const sig = `${currentHost}|${lan?.port || 0}`
    if (adHandle && sig === adSig) return
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
        port: lan?.port || RECEIVER_PORT,
        txt: {
          proto: CAST_SERVICE_TYPE,
          v: '2',
          id: identity.deviceId,
          name: identity.name,
          h: currentHost || '127.0.0.1',
          pk: publicKey,
          lp: String(lan?.port || 0),
          auth: openAuth ? 'open' : 'code'
        }
      }, { onError: () => {} })
      adSig = sig
    } catch {}
  }

  await refreshMdns()
  let statsBusy = false
  const peerStatsTimer = setInterval(async () => {
    if (closing || statsBusy || !activeMedia || !state.entry) return
    statsBusy = true
    try {
      const media = activeMedia
      const st = node.status()
      const p2pPeers = (st.peers || 0) + (st.lanPeers || 0)
      const size = state.entry.size || media.blob?.byteLength || 0
      const cachedBytes = await countCachedBlobBytes(media.core, media.blob, size)
      if (media !== activeMedia) return
      const seeding = cachedBytes > 0
      if (p2pPeers !== state.p2pPeers || cachedBytes !== state.cachedBytes || seeding !== state.seeding) {
        updateState({ p2pPeers, cachedBytes, seeding })
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
    peerStatus: () => node.status(),
    info,
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
    async setHost (nextHost) {
      const moved = nextHost !== currentHost
      currentHost = nextHost
      await refreshMdns()
      if (moved) notifyLocalHost(true)
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
      stopServing()
      for (const stop of unserve.values()) stop()
      unserve.clear()
      for (const control of [...controls]) control.close()
      await httpSrv.closeAllAndStop()
    }
}
}

// The sender's side: finds receivers by mDNS, keeps the ones it paired with, and casts to one over this device's
// node. It also runs this device's own receiver, when the device is a TV.
export function createCastController ({
  storage,
  getNode,
  ensureNode = null,
  getLanHost = () => null,
  adapter = null,
  onchange = null
}) {
  mkdirSync(storage, { recursive: true, mode: 0o700 })
  const savedFile = join(storage, 'cast-receivers.json')
  const saved = new Map() // receiver id -> { id, name, publicKey, token }
  try {
    for (const item of JSON.parse(readFileSync(savedFile, 'utf8'))) {
      if (item?.id) saved.set(item.id, item)
    }
  } catch {}

  const discovered = new Map()
  let browseHandle = null
  let browseHost = undefined
  let localReceiver = null
  let active = null
  let closing = false

  function emitChange () {
    if (!closing) onchange?.()
  }

  function persistSaved () {
    writeJsonAtomic(savedFile, [...saved.values()])
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
          if (!addr) return
          const lanPort = Number(txt.lp) || 0
          discovered.set(id, {
            id,
            name: cleanName(txt.name || svc.name, 'PearTube TV'),
            host: addr,
            publicKey: HEX64.test(String(txt.pk || '').toLowerCase()) ? String(txt.pk).toLowerCase() : '',
            // Where the receiver's node answers on this LAN.
            lan: lanPort > 0 ? { host: addr, port: lanPort } : null,
            auth: txt.auth === 'open' ? 'open' : 'code',
            // Receivers from before the cast channel advertise v1 and cannot be reached.
            current: txt.v === '2'
          })
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

  const pairedWith = disc => saved.get(disc.id) || [...saved.values()].find(s => s.publicKey && s.publicKey === disc.publicKey) || null

  function listReceivers () {
    const merged = new Map()
    for (const d of discovered.values()) {
      const pair = pairedWith(d)
      merged.set(pair?.id || d.id, {
        id: pair?.id || d.id,
        name: d.name || pair?.name || 'PearTube TV',
        host: d.host,
        publicKey: pair?.publicKey || d.publicKey,
        online: true,
        paired: Boolean(pair?.token) || d.auth === 'open',
        p2p: true,
        transport: 'lan+p2p',
        auth: d.auth,
        // A receiver from before this protocol cannot be cast to until it updates.
        current: d.current
      })
    }
    for (const [id, s] of saved) {
      if (merged.has(id) || !s.publicKey) continue
      merged.set(id, { id, name: s.name || 'Paired TV', host: null, publicKey: s.publicKey, online: true, paired: Boolean(s.token), p2p: true, transport: 'p2p', auth: 'code', current: true })
    }
    return [...merged.values()]
  }

  // What is known about a receiver: what pairing saved and what mDNS shows now. The saved key wins: mDNS is unsigned.
  function receiverTarget (receiverId) {
    const disc = discovered.get(receiverId) || null
    const pair = saved.get(receiverId) || (disc && pairedWith(disc))
    return {
      publicKey: pair?.publicKey || disc?.publicKey || '',
      lan: disc?.lan || null,
      current: disc ? disc.current : true,
      token: pair?.token || '',
      name: disc?.name || pair?.name || 'PearTube TV',
      auth: disc?.auth || 'code'
    }
  }

  // Connects this device's node to the receiver's node, on the LAN when mDNS showed its address, and opens the cast
  // channel on that connection (src/cast-control.js).
  async function connectReceiver ({ publicKey, lan = null, current = true }, handlers = {}) {
    if (!HEX64.test(publicKey)) throw new Error('This receiver has no key: pair it again with its link or code')
    if (!current) throw new Error('This receiver runs an older PearTube: update it')
    const node = getNode() || (ensureNode ? await ensureNode() : null)
    if (!node) throw new Error('P2P node is not started')
    node.joinLanTopic('cast', CAST_LAN_TOPIC)
    const conn = await node.connectPeer(publicKey, { lan })
    const control = await openControl(conn, handlers)
    control.transport = node.isLanConnection(conn) ? 'lan' : 'p2p'
    return control
  }

  // Pairs with a receiver: by its link, which carries the token, or by the 6-character code on its screen. `address`
  // is a receiver's 64-hex key as a user typed it.
  async function pairReceiver ({ id = '', code = '', uri = '', address = '', publicKey = '', name = '' } = {}) {
    let token = ''
    if (uri) {
      const parsed = parseUri(uri)
      if (parsed.action !== 'receiver') throw new Error('Expected a peartube://receiver/... URI')
      ;({ publicKey, token } = parsed)
      id = id || parsed.deviceId
      name = name || parsed.name
    }
    if (address) publicKey = String(address).trim()
    const disc = discovered.get(id) || [...discovered.values()].find(d => d.publicKey && d.publicKey === publicKey.toLowerCase()) || null
    const key = (publicKey || disc?.publicKey || id).toLowerCase()
    if (!HEX64.test(key)) throw new Error('Enter a receiver link or its 64-hex key')
    let record = { id: disc?.id || id || key, name: cleanName(name || disc?.name, 'PearTube TV'), publicKey: key, token }
    if (!token) {
      const control = await connectReceiver({ publicKey: key, lan: disc?.lan, current: disc ? disc.current : true })
      try {
        const res = await control.call('pair', { code: normalizePairCode(code) })
        record = { id: res.deviceId || record.id, name: cleanName(res.name || record.name, 'PearTube TV'), publicKey: key, token: res.token || '' }
      } finally {
        control.close()
      }
    }
    saved.set(record.id, record)
    persistSaved()
    emitChange()
    return record
  }

  function removeReceiver (id) {
    const removed = saved.delete(id)
    if (removed) {
      persistSaved()
      emitChange()
    }
    return { removed }
  }

  // Each cast or attach owns the session only while no newer cast, attach or stop came after it: those take
  // seconds, and one that finishes after it was replaced must not install its connection.
  let attempt = 0
  function closeActiveTransport () {
    attempt++
    const session = active
    active = null
    session?.control?.close()
  }
  function claim (mine, session) {
    if (mine !== attempt) {
      session.control?.close()
      throw new Error('A newer cast or stop replaced this one')
    }
    active = session
    return session
  }

  // Opens the control channel for a cast or an attach. The session shows state pushes once `claim` makes it active.
  async function openSession (receiverId, target) {
    const session = { receiverId, receiverName: target.name, transport: '', token: target.token, state: idleCastState(), control: null }
    session.control = await connectReceiver(target, {
      onEvent: msg => {
        if (active !== session || msg.event !== 'state' || !msg.state) return
        session.state = msg.state
        emitChange()
      },
      // The channel closes with its connection, and a LAN link can replace a DHT link under a session. Take the
      // remote back on the link that is left; if the TV is gone, the session ends.
      onClose: () => {
        if (active !== session) return
        active = null
        emitChange()
        if (!closing) castAttach({ receiverId }).catch(() => {})
      }
    })
    session.transport = session.control.transport
    return session
  }

  // Opens a session with a receiver and sends it `command`: a load, or a status read to take over a TV that plays.
  async function startSession (receiverId, command, timeoutMs) {
    const target = receiverTarget(receiverId)
    if (!target.token && target.auth !== 'open') {
      throw new Error(`Pair with ${target.name} using its 6-character TV code before casting`)
    }
    closeActiveTransport()
    const mine = attempt
    // A LAN link can replace the DHT link while the channel opens, closing the channel with the old connection. One
    // retry opens the session again on the link that is left, instead of making the sender wait out the command timeout.
    for (let tries = 0; ; tries++) {
      let session = null
      try {
        session = await openSession(receiverId, target)
        await session.control.call('subscribe', { token: target.token })
        const res = await session.control.call('cmd', { token: target.token, ...command }, timeoutMs)
        if (res.state) session.state = res.state
        claim(mine, session)
        emitChange()
        return status()
      } catch (err) {
        session?.control?.close()
        if (tries > 0 || closing || err?.message !== 'Receiver connection closed') throw err
      }
    }
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

  async function castPlay ({ receiverId, key = null, uri = null, startPositionMs = 0 }) {
    const node = getNode() || (ensureNode ? await ensureNode() : null)
    if (!node) throw new Error('P2P node is not started')
    const { item, raw } = await resolveEntryToCast(node, { key, uri })
    // A sender that holds the film opens it, so the TV fetches it from this device over their connection. One that
    // does not leaves the download to the TV: no second 4K stream onto a phone's Wi-Fi.
    if (item.local || (item.cachedBytes || 0) > 0) await node.warm(raw)
    return startSession(receiverId, {
      action: 'load',
      entry: { key: item.key, id: item.id, title: item.title, size: item.size, sha256: item.sha256 },
      // With its channel, so the TV joins that channel's swarm.
      magnetUrl: formatWatchUri(raw, item.source || '', 'channel'),
      startPositionMs: Math.max(0, Number(startPositionMs) || 0)
    }, 20_000)
  }

  // Reconnects as a remote control to a TV receiver that is already playing on its own.
  function castAttach ({ receiverId }) {
    return startSession(receiverId, { action: 'status' }, 10_000)
  }

  async function castControl (cmd) {
    const session = active
    if (!session) throw new Error('No active cast session')
    const res = await session.control.call('cmd', { token: session.token, ...cmd })
    if (res.state) session.state = res.state
    if (cmd.action === 'stop' && active === session) closeActiveTransport()
    emitChange()
    return status()
  }

  async function castStop ({ stopPlayback = true } = {}) {
    // Also retires a cast still negotiating, so it can't take over after this stop.
    if (active && stopPlayback) await castControl({ action: 'stop' }).catch(() => {})
    closeActiveTransport()
    emitChange()
    return status()
  }

  async function startLocalReceiver ({ name = 'PearTube TV', port = RECEIVER_PORT, openAuth = true, peerStorage = null, onCommand = null } = {}) {
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
      openAuth,
      onCommand,
      onChange: () => emitChange()
    })
    emitChange()
    return localReceiver.info()
  }

  function status () {
    return {
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
    setLanHost: async host => {
      // Looking for TVs on this LAN is when this device's node should become reachable to them.
      getNode()?.joinLanTopic('cast', CAST_LAN_TOPIC)
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
    startLocalReceiver,
    reportLocalReceiverState: patch => localReceiver ? localReceiver.reportState(patch) : null,
    status,
    async close () {
      closing = true
      closeActiveTransport()
      const prevBrowse = browseHandle
      browseHandle = null
      if (prevBrowse) await Promise.resolve(prevBrowse.stop?.()).catch(() => {})
      if (localReceiver) {
        const r = localReceiver
        localReceiver = null
        await r.close().catch(() => {})
      }
    }
  }
}
