/**
 * Live Playback Service
 *
 * Renders a live core (see live-core-format.js) as standard live HLS on a
 * loopback HTTP server, so every player we ship (AVPlayer, ExoPlayer, MSE)
 * consumes P2P live streams natively:
 *
 *   GET /live/<coreKeyHex>/playlist.m3u8   sliding-window playlist from core state
 *   GET /live/<coreKeyHex>/init.mp4        block 1
 *   GET /live/<coreKeyHex>/seg-<seq>.m4s   block seq + FIRST_MEDIA_BLOCK
 *
 * Because segments ARE hypercore blocks, the playlist is a pure function of
 * core length plus per-block decode times (tfdt), and serving a segment is a
 * core.get() — replication fetches it from the swarm when it is not local.
 * Segment durations refine as blocks land: timing reads never wait on the
 * network (target duration is the fallback), so playlist rendering cannot
 * stall behind replication.
 */

import b4a from 'b4a'

import { loadBareOrNodeHttpModule } from '../runtime-modules.js'
import { retainSwarmDiscovery } from '../storage.js'
import {
  decodeControlBlock,
  isMediaFragmentBlock,
  parseInitSegmentTimescale,
  parseFragmentDecodeTime,
  DESCRIPTOR_BLOCK,
  INIT_SEGMENT_BLOCK,
  FIRST_MEDIA_BLOCK,
  DEFAULT_TARGET_FRAGMENT_DURATION_S,
} from './live-core-format.js'

const DEFAULT_LIVE_WINDOW_SEGMENTS = 120
const SEGMENT_FETCH_TIMEOUT_MS = 10000
const CONTROL_FETCH_TIMEOUT_MS = 3000
const ROUTE_PATTERN = /^\/live\/([0-9a-f]{64})\/(playlist\.m3u8|init\.mp4|seg-(\d+)\.m4s)$/
function assertContextRunning(ctx) {
  if (ctx?.lifecycle?.signal?.aborted) throw new Error('Backend is shutting down')
}

function ownCoreUntilSession(ctx, label, core) {
  if (typeof ctx?.ownResource === 'function') {
    return ctx.ownResource(label, core, 'close', 5000)
  }
  let active = true
  return {
    release() {
      active = false
    },
    async cleanup() {
      if (!active) return
      active = false
      await core?.close?.()
    },
  }
}

export class LivePlaybackService {
  constructor({ ctx, liveWindowSegments = DEFAULT_LIVE_WINDOW_SEGMENTS } = {}) {
    this.ctx = ctx
    this.liveWindowSegments = liveWindowSegments
    this.server = null
    this.port = 0
    this._serverReady = null
    this._sessions = new Map() // coreKeyHex → session
    this._closePromise = null
  }

  async ensureServer() {
    assertContextRunning(this.ctx)
    if (this._serverReady) return this._serverReady
    this._serverReady = (async () => {
      const http = await loadBareOrNodeHttpModule()
      assertContextRunning(this.ctx)
      await new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
          this._handleRequest(req, res).catch((err) => {
            try {
              if (!res.headersSent) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'text/plain')
              }
              res.end('Internal error: ' + (err?.message || 'unknown'))
            } catch { /* connection gone */ }
          })
        })
        this.server = server
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address?.() || null
          this.port = addr?.port || 0
          resolve()
        })
      })
      assertContextRunning(this.ctx)
      return this.port
    })()
    return this._serverReady
  }

  async getPlaybackUrl(liveCoreKeyHex) {
    assertContextRunning(this.ctx)
    const keyHex = String(liveCoreKeyHex || '').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error('Invalid live core key')
    await this.ensureServer()
    // Touch the session so swarm discovery starts before the player connects.
    await this._getSession(keyHex)
    return `http://127.0.0.1:${this.port}/live/${keyHex}/playlist.m3u8`
  }

  close() {
    if (this._closePromise) return this._closePromise
    this._closePromise = (async () => {
      for (const session of this._sessions.values()) {
        try { await session.core?.close?.() } catch { /* best effort */ }
      }
      this._sessions.clear()
      if (this.server) {
        const server = this.server
        await new Promise((resolve) => {
          try { server.close(() => resolve()) } catch { resolve() }
        })
        if (this.server === server) this.server = null
        this._serverReady = null
        this.port = 0
      }
    })()
    return this._closePromise
  }

  // ─── Session state ──────────────────────────────────────────────────────────

  async _getSession(keyHex) {
    let session = this._sessions.get(keyHex)
    if (session) return session
    assertContextRunning(this.ctx)

    const core = this.ctx.store.get(b4a.from(keyHex, 'hex'))
    const coreOwnership = ownCoreUntilSession(this.ctx, `live playback core ${keyHex.slice(0, 16)}`, core)
    try {
      await core.ready()
      assertContextRunning(this.ctx)
      if (this.ctx.swarm && core.discoveryKey) {
        try { retainSwarmDiscovery(this.ctx, core.discoveryKey, { label: `live:${keyHex.slice(0, 16)}` }) } catch { /* best effort */ }
      }
      try { core.update({ wait: true }).catch(() => {}) } catch { /* best effort */ }

      session = {
        core,
        descriptor: null,
        timescale: null,
        eosBlock: null,
        decodeTimes: new Map(), // block index → tfdt decode time (media timescale units)
      }
      this._sessions.set(keyHex, session)
      coreOwnership.release()
      return session
    } catch (error) {
      await coreOwnership.cleanup()
      throw error
    }
  }

  async _getDescriptor(session) {
    if (session.descriptor) return session.descriptor
    const block = await session.core.get(DESCRIPTOR_BLOCK, { wait: true, timeout: SEGMENT_FETCH_TIMEOUT_MS })
    const control = decodeControlBlock(block)
    if (!control || control.type !== 'descriptor') throw new Error('Live core has no stream descriptor')
    session.descriptor = control
    return control
  }

  _targetDuration(session) {
    const target = Number(session.descriptor?.targetFragmentDuration)
    return Number.isFinite(target) && target > 0 ? target : DEFAULT_TARGET_FRAGMENT_DURATION_S
  }

  /**
   * Local-only block read used for playlist timing/classification. Never
   * waits on replication: playlist rendering must not stall at the live edge.
   */
  async _getLocalBlock(session, index) {
    try {
      return await session.core.get(index, { wait: false })
    } catch {
      return null
    }
  }

  async _refreshEos(session) {
    if (session.eosBlock !== null) return
    const length = session.core.length
    if (length <= FIRST_MEDIA_BLOCK) return
    const lastBlock = await this._getLocalBlock(session, length - 1)
    if (!lastBlock) return
    const control = decodeControlBlock(lastBlock)
    if (control?.type === 'eos') session.eosBlock = length - 1
  }

  async _decodeTimeFor(session, index) {
    if (session.decodeTimes.has(index)) return session.decodeTimes.get(index)
    const block = await this._getLocalBlock(session, index)
    if (!block || !isMediaFragmentBlock(block)) return null
    const time = parseFragmentDecodeTime(block)
    if (time !== null) session.decodeTimes.set(index, time)
    return time
  }

  // ─── HTTP ───────────────────────────────────────────────────────────────────

  async _handleRequest(req, res) {
    const method = (req.method || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET,HEAD')
      res.end()
      return
    }

    let pathname
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname
    } catch {
      res.statusCode = 400
      res.end()
      return
    }

    const match = pathname.match(ROUTE_PATTERN)
    if (!match) {
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/plain')
      res.end('Not found')
      return
    }

    const [, keyHex, fileName, seqStr] = match
    const session = await this._getSession(keyHex)

    if (fileName === 'playlist.m3u8') {
      const playlist = await this._renderPlaylist(session)
      this._send(res, method, Buffer.from(playlist), 'application/vnd.apple.mpegurl')
      return
    }

    if (fileName === 'init.mp4') {
      const block = await session.core.get(INIT_SEGMENT_BLOCK, { wait: true, timeout: SEGMENT_FETCH_TIMEOUT_MS })
      this._send(res, method, block, 'video/mp4')
      return
    }

    const blockIndex = FIRST_MEDIA_BLOCK + Number(seqStr)
    const block = await session.core.get(blockIndex, { wait: true, timeout: SEGMENT_FETCH_TIMEOUT_MS })
    if (!isMediaFragmentBlock(block)) {
      // Control block (eos) or malformed — not a media segment.
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/plain')
      res.end('Not a media segment')
      return
    }
    const time = parseFragmentDecodeTime(block)
    if (time !== null) session.decodeTimes.set(blockIndex, time)
    this._send(res, method, block, 'video/iso.segment')
  }

  _send(res, method, payload, contentType) {
    res.statusCode = 200
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Length', String(payload.length))
    res.setHeader('Cache-Control', 'no-store')
    if (method === 'HEAD') {
      res.end()
      return
    }
    res.end(payload)
  }

  async _renderPlaylist(session) {
    // Populates session.descriptor (target fragment duration) on first render.
    await this._getDescriptor(session)
    try { session.core.update({ wait: false }).catch?.(() => {}) } catch { /* best effort */ }
    await this._refreshEos(session)

    const targetDuration = this._targetDuration(session)
    const length = session.core.length
    const ended = session.eosBlock !== null
    const mediaEndExclusive = ended ? session.eosBlock : length
    const totalSegments = Math.max(0, mediaEndExclusive - FIRST_MEDIA_BLOCK)

    // Ended streams expose the full recording (free DVR); live streams expose
    // a sliding window ending at the live edge.
    const windowStart = ended
      ? FIRST_MEDIA_BLOCK
      : Math.max(FIRST_MEDIA_BLOCK, mediaEndExclusive - this.liveWindowSegments)

    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(targetDuration))}`,
      `#EXT-X-MEDIA-SEQUENCE:${windowStart - FIRST_MEDIA_BLOCK}`,
      '#EXT-X-MAP:URI="init.mp4"',
    ]
    if (ended) lines.splice(2, 0, '#EXT-X-PLAYLIST-TYPE:VOD')

    if (totalSegments > 0) {
      const timescale = session.timescale ?? await this._resolveTimescale(session)
      for (let block = windowStart; block < mediaEndExclusive; block++) {
        const duration = await this._segmentDuration(session, block, mediaEndExclusive, timescale, targetDuration)
        lines.push(`#EXTINF:${duration.toFixed(3)},`)
        lines.push(`seg-${block - FIRST_MEDIA_BLOCK}.m4s`)
      }
    }

    if (ended) lines.push('#EXT-X-ENDLIST')
    lines.push('')

    return lines.join('\n')
  }

  async _resolveTimescale(session) {
    if (session.timescale) return session.timescale
    const initBlock = await this._getLocalBlock(session, INIT_SEGMENT_BLOCK)
    if (!initBlock) return null
    const timescale = parseInitSegmentTimescale(initBlock)
    if (timescale) session.timescale = timescale
    return timescale
  }

  async _segmentDuration(session, block, mediaEndExclusive, timescale, targetDuration) {
    if (!timescale) return targetDuration
    const current = await this._decodeTimeFor(session, block)
    if (current === null || block + 1 >= mediaEndExclusive) return targetDuration
    const next = await this._decodeTimeFor(session, block + 1)
    if (next === null || next <= current) return targetDuration
    const duration = (next - current) / timescale
    // Guard against absurd tfdt jumps poisoning the playlist.
    return duration > 0 && duration < targetDuration * 20 ? duration : targetDuration
  }
}

export function createLivePlaybackService(ctx, options = {}) {
  return new LivePlaybackService({ ctx, ...options })
}
