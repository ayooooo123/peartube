/**
 * Chromecast Protocol Implementation
 *
 * Chromecast uses the Google Cast protocol:
 * - TLS connection on port 8009
 * - Protocol Buffers for message encoding
 * - JSON payloads within protobuf messages
 *
 * Namespaces:
 * - urn:x-cast:com.google.cast.tp.connection
 * - urn:x-cast:com.google.cast.tp.heartbeat
 * - urn:x-cast:com.google.cast.receiver
 * - urn:x-cast:com.google.cast.media
 *
 * Default Media Receiver App ID: CC1AD845
 */

import { EventEmitter } from 'bare-events'
import tls from 'bare-tls'
import Buffer from 'bare-buffer'
import os from 'bare-os'

// Default Chromecast port
export const CHROMECAST_PORT = 8009

// Default Media Receiver app ID
export const DEFAULT_MEDIA_RECEIVER_APP_ID = 'CC1AD845'

// Cast namespaces
export const Namespace = {
  CONNECTION: 'urn:x-cast:com.google.cast.tp.connection',
  HEARTBEAT: 'urn:x-cast:com.google.cast.tp.heartbeat',
  RECEIVER: 'urn:x-cast:com.google.cast.receiver',
  MEDIA: 'urn:x-cast:com.google.cast.media'
}

const SOURCE_ID = 'sender-0'
const RECEIVER_ID = 'receiver-0'
const HEARTBEAT_INTERVAL = 5000
const LOCALHOST_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0'])

function encodeVarint(value) {
  const bytes = []
  let v = value >>> 0
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  bytes.push(v)
  return Buffer.from(bytes)
}

function decodeVarint(buffer, offset) {
  let result = 0
  let shift = 0
  let pos = offset

  while (pos < buffer.length) {
    const byte = buffer[pos]
    result |= (byte & 0x7f) << shift
    pos += 1
    if ((byte & 0x80) === 0) {
      break
    }
    shift += 7
  }

  return { value: result, bytes: pos - offset }
}

function encodeFieldVarint(fieldNumber, value) {
  const tag = (fieldNumber << 3) | 0
  return Buffer.concat([encodeVarint(tag), encodeVarint(value)])
}

function encodeFieldBytes(fieldNumber, data) {
  const tag = (fieldNumber << 3) | 2
  return Buffer.concat([encodeVarint(tag), encodeVarint(data.length), data])
}

function encodeFieldString(fieldNumber, value) {
  const data = Buffer.from(value, 'utf8')
  return encodeFieldBytes(fieldNumber, data)
}

function encodeCastMessage({ sourceId, destinationId, namespace, payloadUtf8, payloadBinary }) {
  const parts = [
    encodeFieldVarint(1, 0),
    encodeFieldString(2, sourceId),
    encodeFieldString(3, destinationId),
    encodeFieldString(4, namespace)
  ]

  if (payloadBinary) {
    parts.push(encodeFieldVarint(5, 1))
    parts.push(encodeFieldBytes(7, Buffer.from(payloadBinary)))
  } else {
    parts.push(encodeFieldVarint(5, 0))
    parts.push(encodeFieldString(6, payloadUtf8 || ''))
  }

  const body = Buffer.concat(parts)
  const framed = Buffer.alloc(4 + body.length)
  framed.writeUInt32BE(body.length, 0)
  body.copy(framed, 4)
  return framed
}

function decodeCastMessage(buffer) {
  let offset = 0
  const fields = {}

  while (offset < buffer.length) {
    const { value: tag, bytes: tagBytes } = decodeVarint(buffer, offset)
    if (!tagBytes) break
    offset += tagBytes

    const field = tag >> 3
    const wire = tag & 0x7

    if (wire === 0) {
      const { value, bytes } = decodeVarint(buffer, offset)
      offset += bytes
      fields[field] = value
    } else if (wire === 2) {
      const { value: length, bytes } = decodeVarint(buffer, offset)
      offset += bytes
      if (offset + length > buffer.length) break
      fields[field] = buffer.slice(offset, offset + length)
      offset += length
    } else {
      break
    }
  }

  return {
    protocolVersion: (fields[1] != null) ? fields[1] : 0,
    sourceId: fields[2] ? fields[2].toString('utf8') : undefined,
    destinationId: fields[3] ? fields[3].toString('utf8') : undefined,
    namespace: fields[4] ? fields[4].toString('utf8') : undefined,
    payloadType: (fields[5] != null) ? fields[5] : 0,
    payloadUtf8: fields[6] ? fields[6].toString('utf8') : null,
    payloadBinary: (fields[7] != null) ? fields[7] : null
  }
}

function mapPlayerState(state, idleReason) {
  switch (state) {
    case 'PLAYING':
      return 'playing'
    case 'PAUSED':
      return 'paused'
    case 'BUFFERING':
      return 'buffering'
    case 'IDLE':
      return idleReason === 'FINISHED' ? 'stopped' : 'idle'
    default:
      return 'idle'
  }
}

function getLocalIPv4(targetHost) {
  let targetPrefix = null
  if (typeof targetHost === 'string') {
    const parts = targetHost.split('.')
    if (parts.length === 4) {
      targetPrefix = parts.slice(0, 3).join('.')
    }
  }

  try {
    const interfaces = os.networkInterfaces()
    let fallback = null

    for (const name in interfaces) {
      const addresses = interfaces[name]
      if (!Array.isArray(addresses)) continue

      for (const iface of addresses) {
        const address = iface?.address
        if (!address || iface.internal) continue
        if (iface.family !== 4 && iface.family !== 'IPv4') continue
        if (targetPrefix && address.startsWith(`${targetPrefix}.`)) {
          return address
        }
        if (name === 'en0') return address
        if (!fallback) fallback = address
      }
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
 * ChromecastDevice - Handles communication with a Chromecast receiver
 */
export class ChromecastDevice extends EventEmitter {
  constructor(deviceInfo) {
    super()
    this.deviceInfo = deviceInfo
    this._connected = false
    this._connecting = false
    this._connectPromise = null
    this._connectResolve = null
    this._connectReject = null
    this._connectTimer = null
    this._connectToken = 0
    this._activeConnectToken = 0
    this._cleanupInProgress = false
    this._cleanupScheduled = false
    this._cleanupPromise = null
    this._cleanupResolve = null
    this._gracefulClose = false
    this._socket = null
    this._socketHandlers = null
    this._buffer = Buffer.alloc(0)
    this._heartbeatTimer = null
    this._missedHeartbeats = 0
    this._statusTimer = null
    this._transportId = null
    this._mediaSessionId = null
    this._requestId = 1
    this._launchWaiters = []

    // Playback state
    this._state = {
      state: 'idle',
      currentTime: 0,
      duration: 0,
      volume: 1.0
    }

    // LOAD debouncing to prevent rapid consecutive calls
    this._loadInProgress = false
    this._lastLoadTime = 0
    this._loadDebounceMs = 1000 // Minimum 1 second between LOAD calls
    this._lastEmittedError = null
    this._loadStartedAt = 0
    this._lastLoadRequest = null
    this._lastMediaStatus = null
    this._loadPlayNudged = false
    this._loadStatusProbeSent = false
    this._loadRetrySent = false
    this._loadErrorRetrySent = false
    this._intentionalStopAt = 0 // Track stop() calls to suppress stale IDLE:ERROR
    this._shouldAutoReconnect = true
    this._lastPlayOptions = null
    this._reconnectInProgress = false
    this._reconnectSession = 0
    // If play() is called repeatedly during debounce, keep only the latest request.
    this._pendingLoadOptions = null
    this._pendingLoadTimer = null
    this._recentWrites = []
    this._recentWriteLimit = 128
  }

  _schedulePendingLoad(delayMs) {
    if (this._pendingLoadTimer) {
      try { clearTimeout(this._pendingLoadTimer) } catch (e) {}
      this._pendingLoadTimer = null
    }

    const ms = Math.max(0, Math.floor(delayMs || 0))
    this._pendingLoadTimer = setTimeout(() => {
      this._pendingLoadTimer = null
      const next = this._pendingLoadOptions
      this._pendingLoadOptions = null
      if (!next) return
      this.play(next).catch(() => {})
    }, ms)
  }

  /**
   * Connect to the Chromecast device
   */
  async connect(timeout = 5000) {
    if (this._connected) return
    if (this._connectPromise) return this._connectPromise

    // Fix 3: Wait for any pending cleanup to complete before starting new connection
    if (this._cleanupPromise) {
      try {
        await this._cleanupPromise
      } catch {}
    }

    this.emit('connectionStateChanged', 'connecting')
    this._connecting = true

    const token = ++this._connectToken
    this._activeConnectToken = token

    this._connectPromise = new Promise((resolve, reject) => {
      this._connectResolve = resolve
      this._connectReject = reject

      const timer = setTimeout(() => {
        if (this._activeConnectToken !== token) return
        this._handleError(new Error('Connection timeout'))
      }, timeout)
      this._connectTimer = timer

      const socket = tls.createConnection(this.deviceInfo.port || CHROMECAST_PORT, this.deviceInfo.host)
      this._socket = socket

      const onConnect = () => {
        if (this._activeConnectToken !== token) return
        clearTimeout(timer)
        this._connected = true
        this._connecting = false
        this.emit('connectionStateChanged', 'connected')
        this._startHeartbeat()
        this._sendConnect(RECEIVER_ID)
        this._sendReceiverMessage({ type: 'GET_STATUS', requestId: this._nextRequestId() })
        this._launchDefaultReceiver().catch(() => {})
        this._startStatusPolling()
        this._finalizeConnect()
      }

      const onData = (data) => {
        if (this._activeConnectToken !== token && !this._connected) return
        try {
          this._handleAppData(data)
        } catch (err) {
          console.error('[Chromecast] onData error:', (err && err.message) ? err.message : err)
        }
      }

      const onError = (err) => {
        if (this._activeConnectToken !== token) return
        clearTimeout(timer)
        this._handleError(err)
      }

      const onClose = () => {
        if (this._activeConnectToken !== token) return
        clearTimeout(timer)
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
   * Disconnect from the device
   */
  async disconnect() {
    this._shouldAutoReconnect = false
    this._lastPlayOptions = null
    this._reconnectSession += 1
    this._reconnectInProgress = false
    const wasConnected = this._connected
    this._connected = false
    this.emit('connectionStateChanged', 'disconnected')
    try {
      console.log('[Chromecast] disconnect requested, graceful:', wasConnected)
    } catch {}
    return this._scheduleCleanup(null, { graceful: wasConnected })
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this._connected
  }

  /**
   * Play media
   */
  async play(options) {
    if (!this._connected) {
      throw new Error('Not connected')
    }

    this._shouldAutoReconnect = true
    this._reconnectSession += 1
    this._reconnectInProgress = false
    const currentTime = typeof options?.time === 'number' ? options.time : this._state.currentTime
    this._lastPlayOptions = {
      ...(options || {}),
      ...(typeof currentTime === 'number' ? { time: currentTime } : {})
    }

    // Debounce: prevent rapid consecutive LOAD calls that cause native crashes
    const now = Date.now()
    if (this._loadInProgress) {
      console.warn('[Chromecast] LOAD already in progress, queueing latest play()')
      this._pendingLoadOptions = options
      this._schedulePendingLoad(250)
      return
    }
    if (now - this._lastLoadTime < this._loadDebounceMs) {
      console.warn('[Chromecast] play() called too soon after previous LOAD, queueing latest')
      this._pendingLoadOptions = options
      this._schedulePendingLoad(this._loadDebounceMs - (now - this._lastLoadTime) + 50)
      return
    }
    this._loadInProgress = true
    this._lastLoadTime = now

    try {
      await this._ensureTransport()
      if (!this._transportId) {
        throw new Error('Chromecast transport not ready')
      }

      let mediaUrl = options.url
      try {
        const parsed = new URL(mediaUrl)
        if (LOCALHOST_HOSTS.has(parsed.hostname)) {
          const localIp = await getLocalIPv4(this.deviceInfo.host)
          if (localIp) {
            mediaUrl = rewriteUrlHost(mediaUrl, localIp)
            console.log('[Chromecast] Rewriting media URL host to', localIp)
          }
        }
      } catch {}

      const contentType = options.contentType || 'video/mp4'
      const requestedStartTime = Number.isFinite(options?.time)
        ? Math.max(0, Number(options.time))
        : 0
      try {
        const parsed = new URL(mediaUrl)
        console.log('[Chromecast] LOAD', {
          host: (this.deviceInfo && this.deviceInfo.host) ? this.deviceInfo.host : undefined,
          contentType,
          urlHost: parsed.host,
          streamType: options.streamType,
          duration: options.duration,
        })
      } catch (e) {}
      // Use MovieMediaMetadata (type 1) for video content
      // This provides proper movie-style UI with auto-hiding title overlay
      const metadata = {
        metadataType: 1,  // MovieMediaMetadata (0=Generic, 1=Movie, 2=TvShow, 3=MusicTrack, 4=Photo)
        title: options.title || '',
        images: options.thumbnail ? [{ url: options.thumbnail }] : []
      }

      const isHlsContent = /mpegurl/i.test(contentType) || /\.m3u8(?:$|\?)/i.test(mediaUrl)
      const streamType = isHlsContent ? 'LIVE' : (options.streamType || 'BUFFERED')

      const mediaPayload = {
        contentId: mediaUrl,
        contentUrl: mediaUrl,
        streamType,
        contentType,
        metadata,
        ...(isHlsContent ? {
          hlsSegmentFormat: 'fmp4',
          hlsVideoSegmentFormat: 'fmp4',
        } : {}),
        ...(!isHlsContent && options.duration ? { duration: options.duration } : {})
      }

      const payload = {
        type: 'LOAD',
        requestId: this._nextRequestId(),
        autoplay: true,
        currentTime: requestedStartTime,
        media: mediaPayload
      }

      try {
        console.log('[Chromecast] LOAD media payload', {
          contentId: mediaPayload.contentId,
          contentUrl: mediaPayload.contentUrl,
          contentType: mediaPayload.contentType,
          streamType: mediaPayload.streamType,
          duration: mediaPayload.duration,
          hlsSegmentFormat: mediaPayload.hlsSegmentFormat,
          hlsVideoSegmentFormat: mediaPayload.hlsVideoSegmentFormat,
        })
      } catch {}

      console.log('[Chromecast] sending LOAD to transport', this._transportId)
      this._lastEmittedError = null
      this._lastLoadRequest = {
        contentId: mediaUrl,
        contentType,
        streamType,
        time: requestedStartTime,
        media: mediaPayload,
        startedAt: Date.now(),
      }
      this._loadPlayNudged = false
      this._loadStatusProbeSent = false
      this._loadRetrySent = false
      this._loadErrorRetrySent = false
      this._sendMediaMessage(payload)
      try {
        this._sendMediaMessage({ type: 'GET_STATUS', requestId: this._nextRequestId() })
      } catch {}
      this._loadStartedAt = Date.now()
      this._state.state = 'loading'
      this.emit('playbackStateChanged', 'loading')
      await this._waitForPlaybackStart(options?.startTimeoutMs)
    } finally {
      // Clear load-in-progress after a short delay to allow the LOAD to complete
      setTimeout(() => {
        this._loadInProgress = false
        if (this._pendingLoadOptions && !this._pendingLoadTimer) {
          this._schedulePendingLoad(150)
        }
      }, 500)
    }
  }

  async _waitForPlaybackStart(timeoutMs = 30000) {
    const immediateState = this._state?.state
    if (immediateState === 'playing' || immediateState === 'buffering' || immediateState === 'paused') {
      return immediateState
    }

    return new Promise((resolve, reject) => {
      let settled = false
      let timer = null

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        this.off('playbackStateChanged', onPlaybackStateChanged)
        this.off('mediaStatus', onMediaStatus)
        this.off('error', onError)
        this.off('connectionStateChanged', onConnectionStateChanged)
      }

      const finishResolve = (state) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(state)
      }

      const finishReject = (err) => {
        if (settled) return
        settled = true
        cleanup()
        reject(err)
      }

      const onPlaybackStateChanged = (state) => {
        if (state === 'playing' || state === 'buffering' || state === 'paused') {
          finishResolve(state)
          return
        }
        if (state === 'error') {
          if (!this._loadErrorRetrySent) {
            this._loadErrorRetrySent = true
            try {
              const retry = this._lastLoadRequest
              if (retry?.contentId) {
                this._sendMediaMessage({
                  type: 'LOAD',
                  requestId: this._nextRequestId(),
                  autoplay: true,
                  currentTime: Number.isFinite(retry.time) ? Math.max(0, Number(retry.time)) : 0,
                  media: retry.media || {
                    contentId: retry.contentId,
                    streamType: retry.streamType || 'BUFFERED',
                    contentType: retry.contentType || 'application/vnd.apple.mpegurl',
                    metadata: {
                      metadataType: 0,
                      title: 'PearTube',
                    },
                  },
                })
                this._loadStartedAt = Date.now()
                return
              }
            } catch {}
          }
          finishReject(new Error('Chromecast reported a media error while starting playback'))
        }
      }

      const onMediaStatus = (status) => {
        if (!status || typeof status !== 'object') return
        const playerState = status.playerState || null
        if (!playerState) return
        if (playerState === 'IDLE' && status.idleReason === 'ERROR') {
          if (!this._loadErrorRetrySent) {
            this._loadErrorRetrySent = true
            try {
              const retry = this._lastLoadRequest
              if (retry?.contentId) {
                this._sendMediaMessage({
                  type: 'LOAD',
                  requestId: this._nextRequestId(),
                  autoplay: true,
                  currentTime: Number.isFinite(retry.time) ? Math.max(0, Number(retry.time)) : 0,
                  media: retry.media || {
                    contentId: retry.contentId,
                    streamType: retry.streamType || 'BUFFERED',
                    contentType: retry.contentType || 'application/vnd.apple.mpegurl',
                    metadata: {
                      metadataType: 0,
                      title: 'PearTube',
                    },
                  },
                })
                this._loadStartedAt = Date.now()
                return
              }
            } catch {}
          }
          finishReject(new Error('Chromecast reported IDLE:ERROR while starting playback'))
          return
        }
        if (playerState === 'IDLE' && !status.idleReason) {
          const loadAgeMs = this._loadStartedAt > 0 ? (Date.now() - this._loadStartedAt) : 0
          const hasSession = typeof status.mediaSessionId === 'number'
          if (hasSession && loadAgeMs > 2500 && !this._loadPlayNudged) {
            this._loadPlayNudged = true
            try {
              this._sendMediaMessage({
                type: 'PLAY',
                requestId: this._nextRequestId(),
                mediaSessionId: status.mediaSessionId,
              })
              this._sendMediaMessage({
                type: 'GET_STATUS',
                requestId: this._nextRequestId(),
              })
            } catch {}
            return
          }
          if (loadAgeMs > 3000 && !hasSession && !this._loadRetrySent) {
            if (!this._loadStatusProbeSent) {
              this._loadStatusProbeSent = true
              try {
                this._sendMediaMessage({
                  type: 'GET_STATUS',
                  requestId: this._nextRequestId(),
                })
              } catch {}
              return
            }
          }
          if (loadAgeMs > 9000 && !hasSession && !this._loadRetrySent) {
            this._loadRetrySent = true
            try {
              const retry = this._lastLoadRequest
              if (retry?.contentId) {
                this._sendMediaMessage({
                  type: 'LOAD',
                  requestId: this._nextRequestId(),
                  autoplay: true,
                  currentTime: Number.isFinite(retry.time) ? Math.max(0, Number(retry.time)) : 0,
                  media: retry.media || {
                    contentId: retry.contentId,
                    streamType: retry.streamType || 'BUFFERED',
                    contentType: retry.contentType || 'application/vnd.apple.mpegurl',
                    metadata: {
                      metadataType: 0,
                      title: 'PearTube',
                    },
                  },
                })
                this._loadStartedAt = Date.now()
                return
              }
            } catch {}
          }
          if (loadAgeMs > 15000 && !hasSession) {
            finishReject(new Error('Chromecast stayed IDLE without media session after LOAD'))
          }
        }
      }

      const onError = (err) => {
        finishReject(err instanceof Error ? err : new Error(String(err || 'Chromecast playback failed')))
      }

      const onConnectionStateChanged = (state) => {
        if (state === 'disconnected' || state === 'error') {
          finishReject(new Error('Chromecast disconnected while starting playback'))
        }
      }

      timer = setTimeout(() => {
        const last = this._lastMediaStatus || null
        const lastState = last && last.playerState ? String(last.playerState) : 'unknown'
        const lastIdleReason = last && last.idleReason ? String(last.idleReason) : 'none'
        const load = this._lastLoadRequest || null
        const loadUrl = load && load.contentId ? String(load.contentId) : 'unknown'
        finishReject(new Error('Timed out waiting for Chromecast playback to start (state=' + lastState + ', idle=' + lastIdleReason + ', url=' + loadUrl + ')'))
    }, Math.max(3000, Number(timeoutMs) || 30000))

      this.on('playbackStateChanged', onPlaybackStateChanged)
      this.on('mediaStatus', onMediaStatus)
      this.on('error', onError)
      this.on('connectionStateChanged', onConnectionStateChanged)
    })
  }

  /**
   * Pause playback
   */
  async pause() {
    if (!this._connected) {
      throw new Error('Not connected')
    }
    if (!this._mediaSessionId) {
      throw new Error('No media session')
    }
    this._sendMediaMessage({
      type: 'PAUSE',
      requestId: this._nextRequestId(),
      mediaSessionId: this._mediaSessionId
    })
  }

  /**
   * Resume playback
   */
  async resume() {
    if (!this._connected) {
      throw new Error('Not connected')
    }
    if (!this._mediaSessionId) {
      throw new Error('No media session')
    }
    this._sendMediaMessage({
      type: 'PLAY',
      requestId: this._nextRequestId(),
      mediaSessionId: this._mediaSessionId
    })
  }

  /**
   * Stop playback
   */
   async stop() {
    if (!this._connected) {
      throw new Error('Not connected')
    }
    if (!this._mediaSessionId) {
      return
    }
    this._intentionalStopAt = Date.now()
    this._shouldAutoReconnect = false
    this._lastPlayOptions = null
    this._reconnectSession += 1
    this._reconnectInProgress = false
    this._sendMediaMessage({
      type: 'STOP',
      requestId: this._nextRequestId(),
      mediaSessionId: this._mediaSessionId
    })
    this._state.state = 'stopped'
    this.emit('playbackStateChanged', 'stopped')
  }

  /**
   * Seek to position
   */
  async seek(time) {
    if (!this._connected) {
      throw new Error('Not connected')
    }
    if (!this._mediaSessionId) {
      throw new Error('No media session')
    }
    this._sendMediaMessage({
      type: 'SEEK',
      requestId: this._nextRequestId(),
      mediaSessionId: this._mediaSessionId,
      currentTime: time
    })
  }

  /**
   * Set volume
   */
  async setVolume(volume) {
    if (!this._connected) {
      throw new Error('Not connected')
    }
    this._sendReceiverMessage({
      type: 'SET_VOLUME',
      requestId: this._nextRequestId(),
      volume: { level: volume }
    })
    this._state.volume = volume
    this.emit('volumeChanged', volume)
  }

  /**
   * Get current playback state
   */
  getPlaybackState() {
    return { ...this._state }
  }

  _nextRequestId() {
    const id = this._requestId
    this._requestId += 1
    return id
  }

  _startHeartbeat() {
    if (this._heartbeatTimer) return
    this._missedHeartbeats = 0
    this._heartbeatTimer = setInterval(() => {
      if (this._connected && this._socket) {
        try {
          this._sendHeartbeat({ type: 'PING' })
          this._missedHeartbeats += 1
          console.warn('[Chromecast] Heartbeat miss #' + this._missedHeartbeats + ' — no PONG for ' + (this._missedHeartbeats * 5) + 's')
      if (this._missedHeartbeats >= 6) {
        const err = new Error('Chromecast heartbeat timeout after ' + this._missedHeartbeats + ' missed PONGs')
            this.emit('error', err)
            this._handleDisconnect(err)
          }
        } catch (err) {
          // Socket closed, will be handled by disconnect
        }
      }
    }, HEARTBEAT_INTERVAL)
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
  }

  _startStatusPolling() {
    if (this._statusTimer) return
    let pollCount = 0
    this._statusTimer = setInterval(() => {
      if (this._connected && this._transportId && this._socket) {
        pollCount++
        // Log every 6th poll (every 30 seconds) to confirm polling is active
        if (pollCount % 6 === 0) {
          console.log('[Chromecast] Status poll #' + pollCount + ' (connected:', this._connected, ')')
        }
        try {
          this._sendMediaMessage({ type: 'GET_STATUS', requestId: this._nextRequestId() })
        } catch (err) {
          // Socket closed, will be handled by disconnect
        }
      }
    }, 5000)
  }

  _stopStatusPolling() {
    if (this._statusTimer) {
      clearInterval(this._statusTimer)
      this._statusTimer = null
    }
  }

  _isSocketWritable() {
    const socket = this._socket
    if (!socket || socket.destroyed) return false
    if (!socket._handle) return false
    const raw = socket.socket
    if (raw && raw.readyState && raw.readyState !== 'open') return false
    return true
  }

  _retainWriteBuffer(buffer) {
    if (!buffer) return
    this._recentWrites.push(buffer)
    if (this._recentWrites.length > this._recentWriteLimit) {
      this._recentWrites.shift()
    }
  }

  _sendCastMessage(namespace, payload, destinationId) {
    // Guard socket writes with null/connection checks
    if (!this._connected || !this._isSocketWritable()) {
      console.warn('[Chromecast] Cannot send message: not connected')
      return
    }

    // Check if socket is still writable
    if (this._socket.destroyed || this._socket.writableEnded) {
      throw new Error('Socket closed')
    }

    const payloadUtf8 = typeof payload === 'string' ? payload : JSON.stringify(payload)
    const message = encodeCastMessage({
      sourceId: SOURCE_ID,
      destinationId,
      namespace,
      payloadUtf8
    })

    try {
      this._retainWriteBuffer(message)
      this._socket.write(message)
    } catch (err) {
      // Socket may have closed between check and write
      console.error('[Chromecast] Socket write error:', (err && err.message) ? err.message : err)
      this._handleError(err)
    }
  }

  _sendConnect(destinationId) {
    this._sendCastMessage(Namespace.CONNECTION, { type: 'CONNECT' }, destinationId)
  }

  _sendHeartbeat(payload) {
    this._sendCastMessage(Namespace.HEARTBEAT, payload, RECEIVER_ID)
  }

  _sendReceiverMessage(payload) {
    this._sendCastMessage(Namespace.RECEIVER, payload, RECEIVER_ID)
  }

  _sendMediaMessage(payload) {
    const destinationId = this._transportId || RECEIVER_ID
    this._sendCastMessage(Namespace.MEDIA, payload, destinationId)
  }

  async _launchDefaultReceiver() {
    if (!this._connected) return
    this._sendReceiverMessage({
      type: 'LAUNCH',
      requestId: this._nextRequestId(),
      appId: DEFAULT_MEDIA_RECEIVER_APP_ID
    })
  }

  async _ensureTransport(timeout = 5000) {
    if (this._transportId) {
      this._sendConnect(this._transportId)
      return
    }

    const waitForTransport = new Promise((resolve, reject) => {
      const waiter = (transportId) => {
        clearTimeout(timer)
        resolve(transportId)
      }
      const timer = setTimeout(() => {
        const idx = this._launchWaiters.indexOf(waiter)
        if (idx >= 0) this._launchWaiters.splice(idx, 1)
        reject(new Error('Timed out waiting for Chromecast app'))
      }, timeout)

      this._launchWaiters.push(waiter)
    })

    this._sendReceiverMessage({ type: 'GET_STATUS', requestId: this._nextRequestId() })
    this._sendReceiverMessage({
      type: 'LAUNCH',
      requestId: this._nextRequestId(),
      appId: DEFAULT_MEDIA_RECEIVER_APP_ID
    })

    await waitForTransport

    if (this._transportId) {
      this._sendConnect(this._transportId)
    }
  }

  _handleAppData(data) {
    // Fix 2: Add buffer size limit to prevent unbounded memory growth
    const MAX_BUFFER_SIZE = 10 * 1024 * 1024 // 10MB limit

    if (this._buffer.length + data.length > MAX_BUFFER_SIZE) {
      console.error('[Chromecast] Buffer overflow, disconnecting')
      this._handleError(new Error('Buffer overflow'))
      return
    }

    this._buffer = Buffer.concat([this._buffer, data])

    while (this._buffer.length >= 4) {
      const length = this._buffer.readUInt32BE(0)

      // Sanity check: reject obviously invalid lengths
      if (length > MAX_BUFFER_SIZE) {
        console.error('[Chromecast] Invalid message length:', length)
        this._handleError(new Error('Invalid message length'))
        return
      }

      if (this._buffer.length < 4 + length) break

      const payload = this._buffer.slice(4, 4 + length)
      this._buffer = this._buffer.slice(4 + length)

      const message = decodeCastMessage(payload)
      this._handleMessage(message)
    }
  }

  _handleMessage(message) {
    if (!message || !message.namespace || !message.payloadUtf8) return

    let payload
    try {
      payload = JSON.parse(message.payloadUtf8)
    } catch {
      return
    }

    if (message.namespace === Namespace.HEARTBEAT) {
      this._handleHeartbeat(payload)
    } else if (message.namespace === Namespace.RECEIVER) {
      this._handleReceiver(payload)
    } else if (message.namespace === Namespace.MEDIA) {
      this._handleMedia(payload)
    }
  }

  _handleHeartbeat(payload) {
    if (payload.type === 'PING') {
      try {
        this._sendHeartbeat({ type: 'PONG' })
      } catch (err) {
        // Socket closed
      }
    } else if (payload.type === 'PONG') {
      this._missedHeartbeats = 0
    }
  }

  _handleReceiver(payload) {
    if (payload.type === 'RECEIVER_STATUS' && payload.status) {
      const apps = payload.status.applications || []
      try {
        console.log('[Chromecast] RECEIVER_STATUS apps:', apps.map(function(app) {
          return { appId: app.appId, transportId: app.transportId }
        }))
      } catch (e) {}
      const status = payload.status
      if (status.volume && typeof status.volume.level === 'number') {
        if (this._state.volume !== status.volume.level) {
          this._state.volume = status.volume.level
          this.emit('volumeChanged', status.volume.level)
        }
      }

      if (Array.isArray(apps)) {
        const mediaApp = apps.find(function(entry) { return entry.appId === DEFAULT_MEDIA_RECEIVER_APP_ID })
        if (mediaApp && mediaApp.transportId) {
          this._transportId = mediaApp.transportId
          console.log('[Chromecast] using transportId', this._transportId)
          this._sendConnect(mediaApp.transportId)
          this._launchWaiters.splice(0).forEach(function(resolve) { resolve(mediaApp.transportId) })
        } else if (this._transportId && this._state.state === 'loading') {
          const loadingForMs = this._loadStartedAt > 0 ? (Date.now() - this._loadStartedAt) : 0
          if (loadingForMs < 8000) {
            return
          }
          const otherApps = apps.filter(function(a) { return a.appId !== DEFAULT_MEDIA_RECEIVER_APP_ID })
          if (otherApps.length > 0) {
            console.error('[Chromecast] Media receiver app replaced while loading! New apps:', otherApps.map(function(a) { return a.appId }))
            console.error('[Chromecast] This indicates LOAD failed silently - Chromecast could not fetch the media URL')
            this._state.state = 'error'
            this.emit('playbackStateChanged', 'error')
            this.emit('error', new Error('Chromecast LOAD failed - media receiver app was replaced'))
          }
        }
      }
    }
  }

  _handleMedia(payload) {
    // Log ALL media namespace messages for debugging
    if (payload.type && payload.type !== 'MEDIA_STATUS') {
      console.log('[Chromecast] Media message type:', payload.type)
      try {
        console.log('[Chromecast] Media message payload:', JSON.stringify(payload))
      } catch (e) {
        console.log('[Chromecast] Media message keys:', Object.keys(payload))
      }
    }

    // Handle LOAD_FAILED explicitly
    if (payload.type === 'LOAD_FAILED') {
      console.error('[Chromecast] LOAD_FAILED received!')
      try {
        console.error('[Chromecast] LOAD_FAILED details:', JSON.stringify(payload))
      } catch (e) {}
      this._loadStartedAt = 0
      this._state.state = 'error'
      this.emit('playbackStateChanged', 'error')
      this.emit('error', new Error('Chromecast LOAD_FAILED'))
      return
    }

    // Handle LOAD_CANCELLED
    if (payload.type === 'LOAD_CANCELLED') {
      console.warn('[Chromecast] LOAD_CANCELLED received')
      this._loadStartedAt = 0
      this._state.state = 'stopped'
      this.emit('playbackStateChanged', 'stopped')
      return
    }

    // Handle INVALID_REQUEST
    if (payload.type === 'INVALID_REQUEST') {
      // INVALID_MEDIA_SESSION_ID is benign — it fires when status polling or
      // stop() runs before/after a media session exists.  Do NOT surface it as
      // an error; just log and move on.
      if (payload.reason === 'INVALID_MEDIA_SESSION_ID') {
        console.log('[Chromecast] INVALID_MEDIA_SESSION_ID (benign, no active media session)')
        this._mediaSessionId = null
        return
      }
      console.error('[Chromecast] INVALID_REQUEST received!')
      try {
        console.error('[Chromecast] INVALID_REQUEST details:', JSON.stringify(payload))
      } catch (e) {}
      this.emit('error', new Error('Chromecast INVALID_REQUEST: ' + (payload.reason || 'unknown')))
      return
    }

    if (payload.type === 'MEDIA_STATUS') {
      // Handle status as array or object (Chromecast can send either)
      const status = Array.isArray(payload.status)
        ? payload.status[0]
        : (payload.status && typeof payload.status === 'object' ? payload.status : null)

      // Log key fields for debugging - use status if available
      try {
        const s = status || {}
        const timeStr = (typeof s.currentTime === 'number') ? s.currentTime.toFixed(1) : '0'
        console.log('[Chromecast] MEDIA_STATUS playerState:', s.playerState,
          'idleReason:', s.idleReason || 'none',
          'time:', timeStr,
          'buffering:', s.playerState === 'BUFFERING' ? 'YES' : 'no')
      } catch (e) {}

      if (!status) return

      this._lastMediaStatus = {
        playerState: status.playerState || null,
        idleReason: status.idleReason || null,
        mediaSessionId: typeof status.mediaSessionId === 'number' ? status.mediaSessionId : null,
        currentTime: typeof status.currentTime === 'number' ? status.currentTime : null,
      }
      this.emit('mediaStatus', this._lastMediaStatus)

      if (typeof status.mediaSessionId === 'number') {
        this._mediaSessionId = status.mediaSessionId
      }

      if (typeof status.currentTime === 'number') {
        this._state.currentTime = status.currentTime
        if (this._lastPlayOptions) {
          this._lastPlayOptions = {
            ...this._lastPlayOptions,
            time: status.currentTime
          }
        }
        this.emit('timeChanged', status.currentTime)
      }

      if (status.media && typeof status.media.duration === 'number') {
        this._state.duration = status.media.duration
        this.emit('durationChanged', status.media.duration)
      }

      if (status.playerState) {
        const nextState = mapPlayerState(status.playerState, status.idleReason)
        if (this._state.state !== nextState) {
          this._state.state = nextState
          this.emit('playbackStateChanged', nextState)
          if (nextState === 'playing' || nextState === 'paused' || nextState === 'buffering') {
            this._loadStartedAt = 0
            this._intentionalStopAt = 0
          }
        }
        if (status.playerState === 'IDLE' && status.idleReason) {
          console.warn('[Chromecast] Media idle reason:', status.idleReason)
          if (status.idleReason === 'ERROR') {
            // Suppress stale IDLE:ERROR that arrives after intentional stop() (pre-LOAD cleanup)
            // or while a new LOAD is in flight. These belong to the OLD media session.
            const sinceStopped = this._intentionalStopAt > 0 ? (Date.now() - this._intentionalStopAt) : Infinity
            const now = Date.now()
            const loadingForMs = this._loadStartedAt > 0 ? (now - this._loadStartedAt) : 0
            const suppressLoadingError = this._loadStartedAt > 0 && loadingForMs < 1500
            if (sinceStopped < 8000 || suppressLoadingError) {
              console.log('[Chromecast] Suppressing stale IDLE:ERROR (stop ' + Math.round(sinceStopped) + 'ms ago, loadingForMs:', loadingForMs + ')')
              return
            }

            this._loadStartedAt = 0

            let errType = 'unknown'
            let detailedCode = null
            try {
              errType = (status.extendedStatus && status.extendedStatus.playerState)
                || (status.error && status.error.type)
                || (status.media && status.media.contentId ? 'LOAD_FAILED' : 'unknown')
              detailedCode = (status.extendedStatus && status.extendedStatus.media && status.extendedStatus.media.customData && status.extendedStatus.media.customData.errorCode)
                || (status.error && status.error.detailedErrorCode)
                || (status.error && status.error.reason)
                || null
            } catch (e) {}
            const errMsg = detailedCode
              ? 'Chromecast media error: ' + errType + ' (' + detailedCode + ')'
              : 'Chromecast media error: ' + errType

            // Only emit once per unique error — status polling re-sends the same
            // IDLE:ERROR every 5s which causes an alert storm in the UI.
            if (this._lastEmittedError !== errMsg) {
              this._lastEmittedError = errMsg
              try {
                console.warn('[Chromecast] Full MEDIA_STATUS on ERROR:', JSON.stringify(status))
              } catch (e) {
                console.warn('[Chromecast] Full MEDIA_STATUS keys:', Object.keys(status))
              }
              console.warn('[Chromecast] Media error type:', errType)
              if (detailedCode) {
                console.warn('[Chromecast] Media error detailedCode:', detailedCode)
              }
              try {
                if (status.error) {
                  console.warn('[Chromecast] Media error details:', JSON.stringify(status.error))
                }
                if (status.extendedStatus) {
                  console.warn('[Chromecast] Media extendedStatus:', JSON.stringify(status.extendedStatus))
                }
              } catch (e) {}
              this.emit('error', new Error(errMsg))
            }
          }
        }
      }
    }
  }

  _handleError(err) {
    if (!err) return
    const wasConnected = this._connected
    const shouldReconnect = this._shouldAutoReconnect === true && wasConnected
    this._connected = false
    this.emit('connectionStateChanged', 'error')
    this.emit('error', err)
    try {
      console.warn('[Chromecast] socket error, graceful:', wasConnected, (err && err.message) ? err.message : err)
    } catch {}
    this._scheduleCleanup(err, { graceful: wasConnected })
    if (shouldReconnect) {
      this._attemptReconnect().catch(() => {})
    }
  }

  _handleDisconnect(err) {
    if (!this._connected && !this._connecting) return
    const wasConnected = this._connected
    const shouldReconnect = this._shouldAutoReconnect === true && wasConnected
    this._connected = false
    this._connecting = false
    this.emit('connectionStateChanged', 'disconnected')
    try {
      console.warn('[Chromecast] socket closed, graceful:', wasConnected)
    } catch {}
    this._scheduleCleanup(err || new Error('Connection closed'), { graceful: wasConnected })
    if (shouldReconnect) {
      this._attemptReconnect().catch(() => {})
    }
  }

  async _attemptReconnect() {
    if (this._reconnectInProgress) return
    if (this._shouldAutoReconnect !== true) return

    const maxAttempts = 3
    const reconnectSession = this._reconnectSession
    this._reconnectInProgress = true

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (this._shouldAutoReconnect !== true || reconnectSession !== this._reconnectSession) {
          return
        }

        const delay = 2000 * Math.pow(2, attempt - 1)
        this.emit('reconnecting', { attempt, maxAttempts })
        await new Promise((resolve) => setTimeout(resolve, delay))

        if (this._shouldAutoReconnect !== true || reconnectSession !== this._reconnectSession) {
          return
        }

        try {
          await this.connect()

          if (this._lastPlayOptions) {
            const resumeTime = typeof this._state.currentTime === 'number'
              ? this._state.currentTime
              : this._lastPlayOptions.time
            const resumeOptions = {
              ...this._lastPlayOptions,
              ...(typeof resumeTime === 'number' ? { time: resumeTime } : {})
            }
            this._lastPlayOptions = resumeOptions
            await this.play(resumeOptions)
          }

          return
        } catch (reconnectErr) {
          if (attempt === maxAttempts) {
            this.emit('reconnectFailed', { attempts: maxAttempts })
            return
          }
        }
      }
    } finally {
      if (reconnectSession === this._reconnectSession) {
        this._reconnectInProgress = false
      }
    }
  }

  _scheduleCleanup(err, options) {
    options = options || {}
    const graceful = options.graceful === true
    if (graceful) this._gracefulClose = true

    if (!this._cleanupPromise) {
      this._cleanupPromise = new Promise((resolve) => {
        this._cleanupResolve = resolve
      })
    }

    if (this._cleanupScheduled || this._cleanupInProgress) return this._cleanupPromise
    this._cleanupScheduled = true
    try {
      console.log('[Chromecast] cleanup scheduled, graceful:', graceful)
    } catch {}
    setTimeout(() => {
      this._cleanupScheduled = false
      Promise.resolve(this._cleanupConnection(err)).catch(() => {})
    }, 0)
    return this._cleanupPromise
  }

  _detachSocketHandlers(socket) {
    const handlers = this._socketHandlers
    if (!handlers || !socket || !socket.off) {
      this._socketHandlers = null
      return
    }
    try {
      socket.off('connect', handlers.onConnect)
      socket.off('data', handlers.onData)
      socket.off('error', handlers.onError)
      socket.off('close', handlers.onClose)
    } catch {}
    this._socketHandlers = null
  }

  _closeSocket() {
    const socket = this._socket
    if (!socket) return Promise.resolve()
    this._socket = null
    this._detachSocketHandlers(socket)

    if (socket.destroyed || !socket._handle) {
      try {
        console.log('[Chromecast] socket already destroyed, skipping close')
      } catch {}
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      let settled = false
      let closeTimer = null
      const finish = () => {
        if (settled) return
        settled = true
        if (closeTimer) {
          clearTimeout(closeTimer)
          closeTimer = null
        }
        try {
          console.log('[Chromecast] socket cleanup finished')
        } catch {}
        resolve()
      }

      const shouldEnd = this._gracefulClose && typeof socket.end === 'function'
      if (shouldEnd) {
        try {
          console.log('[Chromecast] socket end requested')
        } catch {}
        try {
          if (socket.once) socket.once('close', finish)
        } catch (e) {}

        try {
          if (socket.end) socket.end()
        } catch (e) {}

        closeTimer = setTimeout(function() {
          try {
            console.warn('[Chromecast] socket end timeout, forcing destroy')
          } catch (e) {}
          try {
            if (socket.destroy) socket.destroy()
          } catch (e) {}
          finish()
        }, 1500)
        return
      }

      try {
        console.log('[Chromecast] socket destroy requested (non-graceful)')
      } catch (e) {}
      try {
        if (socket.destroy) socket.destroy()
      } catch (e) {}
      finish()
    })
  }

  _finalizeConnect(err) {
    if (!this._connectPromise) return
    const resolve = this._connectResolve
    const reject = this._connectReject
    this._connectPromise = null
    this._connectResolve = null
    this._connectReject = null
    if (this._connectTimer) {
      clearTimeout(this._connectTimer)
      this._connectTimer = null
    }
    this._connecting = false
    if (err) {
      if (reject) reject(err)
    } else {
      if (resolve) resolve()
    }
  }

  async _cleanupConnection(err) {
    if (this._cleanupInProgress) return
    this._cleanupInProgress = true
    try {
      this._stopHeartbeat()
      this._stopStatusPolling()

      try {
        console.log('[Chromecast] cleanup start, graceful:', this._gracefulClose, (err && err.message) ? err.message : err)
      } catch (e) {}
      await this._closeSocket()

      this._buffer = Buffer.alloc(0)
      this._transportId = null
      this._mediaSessionId = null
      this._recentWrites = []
      this._launchWaiters = []
      this._activeConnectToken = 0
      this._finalizeConnect(err || new Error('Connection closed'))
    } finally {
      this._cleanupInProgress = false
      this._gracefulClose = false
      try {
        console.log('[Chromecast] cleanup done')
      } catch {}
      const resolve = this._cleanupResolve
      this._cleanupResolve = null
      this._cleanupPromise = null
      if (resolve) resolve()
    }
  }
}

export default ChromecastDevice
