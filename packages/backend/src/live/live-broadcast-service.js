/**
 * Live Broadcast Service
 *
 * Lifecycle for outgoing live streams: creates the per-stream hypercore,
 * wires encoder output through FMP4Segmenter into LiveCoreWriter, announces
 * the core on the swarm, and seals the session on stop.
 *
 * The byte source is injected: anything producing fragmented-MP4 bytes
 * (bare-ffmpeg capture/encode on desktop, a file remux, a test fixture)
 * drives a session via write()/notifyKeyframe(). Encoder wiring lives with
 * the platform integrations, not here.
 *
 *   source bytes ─→ session.write(chunk)
 *   video keyframes ─→ session.notifyKeyframe(pts, timeBase)
 *   stop ─→ EOS marker appended, core stays seeded (the core IS the recording)
 */

import crypto from 'hypercore-crypto'
import b4a from 'b4a'

import { FMP4Segmenter } from '../transcode/fmp4-segmenter.mjs'
import { LiveCoreWriter } from './live-core-writer.js'
import { DEFAULT_TARGET_FRAGMENT_DURATION_S, FIRST_MEDIA_BLOCK } from './live-core-format.js'

export class LiveBroadcastSession {
  constructor({ core, writer, segmenter, videoId, liveCoreKey, announced }) {
    this.core = core
    this.writer = writer
    this.segmenter = segmenter
    this.videoId = videoId
    this.liveCoreKey = liveCoreKey
    this.announced = announced
    this.startedAt = Date.now()
    this.endedAt = null
  }

  get state() {
    return this.writer.state
  }

  /** Raw fMP4 bytes from the encoder/muxer (IOContext onwrite). */
  write(chunk) {
    if (this.endedAt) throw new Error('Live session has ended')
    return this.segmenter.write(chunk)
  }

  /** Forward video keyframe PTS so segment durations are exact. */
  notifyKeyframe(pts, timeBase) {
    this.segmenter.notifyKeyframe(pts, timeBase)
  }

  getStats() {
    return {
      state: this.writer.state,
      videoId: this.videoId,
      liveCoreKey: this.liveCoreKey,
      mediaBlocks: this.writer.mediaBlocks,
      durationS: this.writer.segmentDurations.reduce((sum, d) => sum + d, 0),
      peerCount: this.core.peers?.length ?? 0,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    }
  }

  /**
   * Seal the stream: flush trailing segmenter state, append the EOS marker,
   * and wait for every block to land. The core keeps seeding — sealed live
   * cores are the recording.
   */
  async stop() {
    if (this.endedAt) {
      await this.writer.flush()
      return this.getStats()
    }
    this.endedAt = Date.now()
    this.segmenter.finish() // flushes the trailing segment + calls setFinished()
    await this.writer.flush()
    return this.getStats()
  }
}

export class LiveBroadcastService {
  constructor({ ctx }) {
    this.ctx = ctx
    this.sessions = new Map() // videoId → LiveBroadcastSession
  }

  /**
   * Start a live session on a fresh single-writer core.
   *
   * @param {Object} options
   * @param {string} [options.title]
   * @param {string} [options.channelKey]
   * @param {number} [options.targetFragmentDuration] seconds, default 1
   * @param {Object} [options.codecs] codec descriptor for the stream descriptor block
   */
  async startBroadcast({
    title = null,
    channelKey = null,
    targetFragmentDuration = DEFAULT_TARGET_FRAGMENT_DURATION_S,
    codecs = null,
    width = 0,
    height = 0,
  } = {}) {
    if (!this.ctx?.store) throw new Error('Storage not initialized')

    const videoId = b4a.toString(crypto.randomBytes(16), 'hex')
    const core = this.ctx.store.get({ name: `peartube-live-${videoId}` })
    await core.ready()

    const writer = new LiveCoreWriter(core, {
      videoId,
      channelKey,
      title,
      targetFragmentDuration,
      codecs,
      width,
      height,
    })
    await writer.open()

    const segmenter = new FMP4Segmenter(writer, { targetDuration: targetFragmentDuration })

    let announced = false
    if (this.ctx.swarm && core.discoveryKey) {
      try {
        this.ctx.swarm.join(core.discoveryKey, { server: true, client: true })
        announced = true
      } catch { /* announce is best-effort; local playback still works */ }
    }

    const session = new LiveBroadcastSession({
      core,
      writer,
      segmenter,
      videoId,
      liveCoreKey: b4a.toString(core.key, 'hex'),
      announced,
    })
    this.sessions.set(videoId, session)
    return session
  }

  getSession(videoId) {
    return this.sessions.get(videoId) || null
  }

  async stopBroadcast(videoId) {
    const session = this.sessions.get(videoId)
    if (!session) throw new Error('No live session: ' + videoId)
    const stats = await session.stop()
    return stats
  }

  async closeAll() {
    for (const session of this.sessions.values()) {
      try { await session.stop() } catch { /* best effort */ }
    }
    this.sessions.clear()
  }
}

export { FIRST_MEDIA_BLOCK }

export function createLiveBroadcastService(ctx) {
  return new LiveBroadcastService({ ctx })
}
