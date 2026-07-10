/**
 * FCast Device Implementation (https://fcast.org)
 *
 * FCast receivers (FUTO / Grayjay ecosystem) accept a plain TCP connection on
 * port 46899 and exchange length-prefixed JSON messages — see
 * ./fcast-protocol.js for the wire format. Unlike Chromecast there is no TLS,
 * no protobuf, no app launch handshake and no media session: once connected,
 * a single Play message starts playback and the receiver streams
 * PlaybackUpdate messages back.
 *
 * Receivers are full media players (ExoPlayer / AVPlayer / mpv), so PearTube
 * plays the original file directly — no cast transcode pipeline needed.
 *
 * Exposes the same surface as ChromecastDevice so CastContext can drive
 * either interchangeably: connect/disconnect/isConnected, play/pause/resume/
 * stop/seek/setVolume, getPlaybackState, and the events connectionStateChanged,
 * playbackStateChanged, timeChanged, durationChanged, volumeChanged, error.
 */

import { EventEmitter } from 'bare-events'
import tcp from 'bare-tcp'
import {
  FCAST_PORT,
  FCAST_PROTOCOL_VERSION,
  Opcode,
  PlaybackState,
  encodeMessage,
  FCastDecoder
} from './fcast-protocol.js'

export { FCAST_PORT }

const PING_INTERVAL = 5000
// Receivers speaking protocol v1 never answer Ping and may be silent while
// idle, so only declare the connection dead after a long quiet period.
const SILENCE_TIMEOUT = 60000
const LOCALHOST_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1'])

function mapPlaybackState(state) {
  switch (state) {
    case PlaybackState.PLAYING:
      return 'playing'
    case PlaybackState.PAUSED:
      return 'paused'
    case PlaybackState.IDLE:
    default:
      return 'idle'
  }
}

async function getLocalIPv4(targetHost) {
  let targetPrefix = null
  if (typeof targetHost === 'string') {
    const parts = targetHost.split('.')
    if (parts.length === 4) {
      targetPrefix = parts.slice(0, 3).join('.')
    }
  }

  try {
    const mod = await import('udx-native')
    const UDX = (mod && mod.default) ? mod.default : mod
    const udx = new UDX()
    let fallback = null

    for (const iface of udx.networkInterfaces()) {
      if (iface.family !== 4 || iface.internal) continue
      if (targetPrefix && iface.host.startsWith(`${targetPrefix}.`)) {
        return iface.host
      }
      if (iface.name === 'en0' || iface.name === 'wlan0') return iface.host
      if (!fallback) fallback = iface.host
    }

    return fallback
  } catch {
    return null
  }
}

function rewriteUrlHost(url, host) {
  try {
    const parsed = new URL(url)
    parsed.hostname = host
    return parsed.toString()
  } catch {
    return url
  }
}

/**
 * FCastDevice - Handles communication with an FCast receiver
 */
export class FCastDevice extends EventEmitter {
  constructor(deviceInfo) {
    super()
    this.deviceInfo = deviceInfo
    this._connected = false
    this._connectPromise = null
    this._socket = null
    this._socketHandlers = null
    this._decoder = new FCastDecoder()
    this._pingTimer = null
    this._lastInboundAt = 0
    this._receiverVersion = null
    this._playWaiter = null

    this._state = {
      state: 'idle',
      currentTime: 0,
      duration: 0,
      volume: 1.0
    }
  }

  /**
   * Connect to the FCast receiver
   */
  async connect(timeout = 5000) {
    if (this._connected) return
    if (this._connectPromise) return this._connectPromise

    this.emit('connectionStateChanged', 'connecting')

    this._connectPromise = new Promise((resolve, reject) => {
      let settled = false

      const finishResolve = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this._connectPromise = null
        resolve()
      }

      const finishReject = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this._connectPromise = null
        this._teardown()
        this.emit('connectionStateChanged', 'error')
        reject(err)
      }

      const timer = setTimeout(() => {
        finishReject(new Error('FCast connection timeout'))
      }, Math.max(1000, timeout))

      let socket
      try {
        socket = tcp.createConnection(this.deviceInfo.port || FCAST_PORT, this.deviceInfo.host)
      } catch (err) {
        finishReject(err)
        return
      }
      this._socket = socket

      const onConnect = () => {
        this._connected = true
        this._lastInboundAt = Date.now()
        this.emit('connectionStateChanged', 'connected')
        try {
          this._send(Opcode.VERSION, { version: FCAST_PROTOCOL_VERSION })
        } catch { /* best-effort: v1 receivers ignore it anyway */ }
        this._startPing()
        finishResolve()
      }

      const onData = (data) => {
        this._handleData(data)
      }

      const onError = (err) => {
        if (!settled) {
          finishReject(err)
          return
        }
        this._handleDisconnect(err)
      }

      const onClose = () => {
        if (!settled) {
          finishReject(new Error('FCast connection closed'))
          return
        }
        this._handleDisconnect()
      }

      this._socketHandlers = { onConnect, onData, onError, onClose }
      socket.on('connect', onConnect)
      socket.on('data', onData)
      socket.on('error', onError)
      socket.on('close', onClose)
    })

    return this._connectPromise
  }

  /**
   * Disconnect from the receiver
   */
  async disconnect() {
    const wasConnected = this._connected
    this._teardown()
    if (wasConnected) {
      this.emit('connectionStateChanged', 'disconnected')
    }
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this._connected
  }

  /**
   * Play media
   *
   * @param {Object} options
   * @param {string} options.url - Media URL
   * @param {string} [options.contentType] - MIME type (FCast "container")
   * @param {number} [options.time] - Start position in seconds
   * @param {number} [options.volume] - Volume 0.0-1.0
   * @param {number} [options.speed] - Playback speed
   * @param {Object} [options.headers] - Request headers for the media URL
   * @param {number} [options.startTimeoutMs] - How long to wait for playback to start
   */
  async play(options) {
    if (!this._connected) {
      throw new Error('Not connected')
    }

    let mediaUrl = options.url
    try {
      const parsed = new URL(mediaUrl)
      if (LOCALHOST_HOSTS.has(parsed.hostname)) {
        const localIp = await getLocalIPv4(this.deviceInfo.host)
        if (localIp) {
          mediaUrl = rewriteUrlHost(mediaUrl, localIp)
          console.log('[FCast] Rewriting media URL host to', localIp)
        }
      }
    } catch { /* not a parseable URL — send as-is */ }

    const body = {
      container: options.contentType || 'video/mp4',
      url: mediaUrl,
      time: Number.isFinite(options?.time) ? Math.max(0, Number(options.time)) : 0,
      speed: Number.isFinite(options?.speed) && options.speed > 0 ? Number(options.speed) : 1
    }
    if (options.headers && typeof options.headers === 'object') {
      body.headers = options.headers
    }

    console.log('[FCast] PLAY', { host: this.deviceInfo?.host, container: body.container, time: body.time })

    this._send(Opcode.PLAY, body)
    this._state.state = 'loading'
    this.emit('playbackStateChanged', 'loading')

    if (Number.isFinite(options?.volume)) {
      try {
        this._send(Opcode.SET_VOLUME, { volume: Math.max(0, Math.min(1, Number(options.volume))) })
      } catch { /* volume is cosmetic; never fail play over it */ }
    }

    await this._waitForPlaybackStart(options?.startTimeoutMs)
  }

  _waitForPlaybackStart(timeoutMs = 30000) {
    const immediate = this._state?.state
    if (immediate === 'playing' || immediate === 'paused') return Promise.resolve(immediate)

    return new Promise((resolve, reject) => {
      let timer = null

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (this._playWaiter === waiter) this._playWaiter = null
      }

      const waiter = {
        resolve: (state) => {
          cleanup()
          resolve(state)
        },
        reject: (err) => {
          cleanup()
          reject(err)
        }
      }

      timer = setTimeout(() => {
        waiter.reject(new Error('Timed out waiting for FCast playback to start'))
      }, Math.max(3000, Number(timeoutMs) || 30000))

      this._playWaiter = waiter
    })
  }

  /**
   * Pause playback
   */
  async pause() {
    if (!this._connected) throw new Error('Not connected')
    this._send(Opcode.PAUSE)
  }

  /**
   * Resume playback
   */
  async resume() {
    if (!this._connected) throw new Error('Not connected')
    this._send(Opcode.RESUME)
  }

  /**
   * Stop playback
   */
  async stop() {
    if (!this._connected) throw new Error('Not connected')
    this._send(Opcode.STOP)
    this._state.state = 'stopped'
    this.emit('playbackStateChanged', 'stopped')
  }

  /**
   * Seek to position (seconds)
   */
  async seek(time) {
    if (!this._connected) throw new Error('Not connected')
    this._send(Opcode.SEEK, { time: Math.max(0, Number(time) || 0) })
  }

  /**
   * Set volume (0.0 - 1.0)
   */
  async setVolume(volume) {
    if (!this._connected) throw new Error('Not connected')
    const level = Math.max(0, Math.min(1, Number(volume) || 0))
    this._send(Opcode.SET_VOLUME, { volume: level })
    this._state.volume = level
    this.emit('volumeChanged', level)
  }

  /**
   * Set playback speed
   */
  async setSpeed(speed) {
    if (!this._connected) throw new Error('Not connected')
    this._send(Opcode.SET_SPEED, { speed: Math.max(0.25, Number(speed) || 1) })
  }

  /**
   * Get current playback state
   */
  getPlaybackState() {
    return { ...this._state }
  }

  _send(opcode, body) {
    const socket = this._socket
    if (!socket || socket.destroyed) {
      throw new Error('FCast socket closed')
    }
    socket.write(encodeMessage(opcode, body))
  }

  _startPing() {
    if (this._pingTimer) return
    this._pingTimer = setInterval(() => {
      if (!this._connected || !this._socket) return
      if (Date.now() - this._lastInboundAt > SILENCE_TIMEOUT) {
        const err = new Error('FCast receiver silent for ' + Math.round(SILENCE_TIMEOUT / 1000) + 's')
        this.emit('error', err)
        this._handleDisconnect(err)
        return
      }
      try {
        this._send(Opcode.PING)
      } catch { /* socket teardown races the timer; close handler owns cleanup */ }
    }, PING_INTERVAL)
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer)
      this._pingTimer = null
    }
  }

  _handleData(data) {
    this._lastInboundAt = Date.now()

    let messages
    try {
      messages = this._decoder.push(data)
    } catch (err) {
      // Framing is corrupt — the stream cannot recover.
      this.emit('error', err)
      this._handleDisconnect(err)
      return
    }

    for (const message of messages) {
      try {
        this._handleMessage(message)
      } catch (err) {
        console.warn('[FCast] Failed to handle message:', err?.message)
      }
    }
  }

  _handleMessage({ opcode, body }) {
    switch (opcode) {
      case Opcode.PLAYBACK_UPDATE:
        this._handlePlaybackUpdate(body || {})
        break

      case Opcode.VOLUME_UPDATE: {
        const volume = Number(body?.volume)
        if (Number.isFinite(volume) && this._state.volume !== volume) {
          this._state.volume = volume
          this.emit('volumeChanged', volume)
        }
        break
      }

      case Opcode.PLAYBACK_ERROR: {
        const message = typeof body?.message === 'string' && body.message
          ? body.message
          : 'FCast receiver reported a playback error'
        const err = new Error(message)
        if (this._playWaiter) {
          this._playWaiter.reject(err)
        } else {
          this.emit('error', err)
        }
        break
      }

      case Opcode.VERSION: {
        const version = Number(body?.version)
        if (Number.isFinite(version)) {
          this._receiverVersion = version
          console.log('[FCast] Receiver protocol version:', version)
        }
        break
      }

      case Opcode.PING:
        try {
          this._send(Opcode.PONG)
        } catch { /* socket teardown races inbound pings */ }
        break

      case Opcode.PONG:
      case Opcode.NONE:
        break

      default:
        // Future opcodes (playlists, events, ...) — ignore.
        break
    }
  }

  _handlePlaybackUpdate(update) {
    const time = Number(update.time)
    if (Number.isFinite(time) && time >= 0) {
      this._state.currentTime = time
      this.emit('timeChanged', time)
    }

    const duration = Number(update.duration)
    if (Number.isFinite(duration) && duration > 0 && this._state.duration !== duration) {
      this._state.duration = duration
      this.emit('durationChanged', duration)
    }

    if (update.state !== undefined) {
      const nextState = mapPlaybackState(Number(update.state))

      if (this._playWaiter && (nextState === 'playing' || nextState === 'paused')) {
        this._playWaiter.resolve(nextState)
      }

      // While a Play is in flight the receiver may still report idle for its
      // previous (stopped) media — don't clobber our 'loading' state with it.
      const suppressIdle = nextState === 'idle' && this._state.state === 'loading'

      if (!suppressIdle && this._state.state !== nextState) {
        this._state.state = nextState
        this.emit('playbackStateChanged', nextState)
      }
    }
  }

  _handleDisconnect(err) {
    if (!this._connected && !this._socket) return
    const wasConnected = this._connected
    this._teardown(err)
    if (wasConnected) {
      this.emit('connectionStateChanged', 'disconnected')
    }
  }

  _teardown(err) {
    this._connected = false
    this._stopPing()

    if (this._playWaiter) {
      this._playWaiter.reject(err || new Error('FCast connection closed'))
    }

    const socket = this._socket
    if (socket) {
      this._socket = null
      const handlers = this._socketHandlers
      this._socketHandlers = null
      if (handlers && socket.off) {
        try {
          socket.off('connect', handlers.onConnect)
          socket.off('data', handlers.onData)
          socket.off('error', handlers.onError)
          socket.off('close', handlers.onClose)
        } catch { /* best-effort detach */ }
      }
      try {
        socket.destroy()
      } catch { /* socket may already be destroyed */ }
    }

    this._decoder = new FCastDecoder()
    this._state = { state: 'idle', currentTime: 0, duration: 0, volume: this._state.volume }
  }
}

export default FCastDevice
