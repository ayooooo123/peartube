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
    protocolVersion: fields[1] ?? 0,
    sourceId: fields[2]?.toString('utf8'),
    destinationId: fields[3]?.toString('utf8'),
    namespace: fields[4]?.toString('utf8'),
    payloadType: fields[5] ?? 0,
    payloadUtf8: fields[6] ? fields[6].toString('utf8') : null,
    payloadBinary: fields[7] ?? null
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
    const UDX = mod?.default || mod
    const udx = new UDX()
    let fallback = null

    for (const iface of udx.networkInterfaces()) {
      if (iface.family !== 4 || iface.internal) continue
      if (targetPrefix && iface.host.startsWith(`${targetPrefix}.`)) {
        return iface.host
      }
      if (iface.name === 'en0') return iface.host
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

      // Fix 1: Wrap TLS connection in try-catch to handle native crashes gracefully
      let socket
      try {
        console.log('[Chromecast] About to call tls.createConnection to', this.deviceInfo.host, this.deviceInfo.port || CHROMECAST_PORT)
        socket = tls.createConnection(this.deviceInfo.port || CHROMECAST_PORT, this.deviceInfo.host)
        console.log('[Chromecast] tls.createConnection returned successfully')
      } catch (err) {
        clearTimeout(timer)
        this._connecting = false
        this._connectPromise = null
        this._connectResolve = null
        this._connectReject = null
        this.emit('connectionStateChanged', 'error')
        this.emit('error', err)
        reject(err)
        return
      }

      this._socket = socket

      // Fix 5: Add early handshake timeout (native TLS can hang)
      const handshakeTimeout = setTimeout(() => {
        if (!this._connected && socket && this._activeConnectToken === token) {
          console.error('[Chromecast] TLS handshake timeout')
          try { socket.destroy?.() } catch {}
          this._handleError(new Error('TLS handshake timeout'))
        }
      }, 3000)

      const onConnect = () => {
        if (this._activeConnectToken !== token) return
        clearTimeout(timer)
        clearTimeout(handshakeTimeout)
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
        this._handleAppData(data)
      }

      const onError = (err) => {
        if (this._activeConnectToken !== token) return
        clearTimeout(timer)
        clearTimeout(handshakeTimeout)
        this._handleError(err)
      }

      const onClose = () => {
        if (this._activeConnectToken !== token) return
        clearTimeout(timer)
        clearTimeout(handshakeTimeout)
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

    // Debounce: prevent rapid consecutive LOAD calls that cause native crashes
    const now = Date.now()
    if (this._loadInProgress) {
      console.warn('[Chromecast] LOAD already in progress, ignoring duplicate play()')
      return
    }
    if (now - this._lastLoadTime < this._loadDebounceMs) {
      console.warn('[Chromecast] play() called too soon after previous LOAD, ignoring')
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
      try {
        const parsed = new URL(mediaUrl)
        console.log('[Chromecast] LOAD', {
          host: this.deviceInfo?.host,
          contentType,
          urlHost: parsed.host,
        })
      } catch {}
      const metadata = {
        metadataType: 0,
        title: options.title || '',
        images: options.thumbnail ? [{ url: options.thumbnail }] : []
      }

      // Support LIVE streamType for real-time transcoding (no seeking)
      const streamType = options.streamType || 'BUFFERED'

      const payload = {
        type: 'LOAD',
        requestId: this._nextRequestId(),
        autoplay: true,
        currentTime: options.time || 0,
        media: {
          contentId: mediaUrl,
          streamType,
          contentType,
          metadata,
          ...(options.duration ? { duration: options.duration } : {})
        }
      }

      console.log('[Chromecast] sending LOAD to transport', this._transportId)
      this._sendMediaMessage(payload)
      try {
        this._sendMediaMessage({ type: 'GET_STATUS', requestId: this._nextRequestId() })
      } catch {}
      this._state.state = 'loading'
      this.emit('playbackStateChanged', 'loading')
    } finally {
      // Clear load-in-progress after a short delay to allow the LOAD to complete
      setTimeout(() => {
        this._loadInProgress = false
      }, 500)
    }
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
      throw new Error('No media session')
    }
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
    this._heartbeatTimer = setInterval(() => {
      if (this._connected && this._socket) {
        try {
          this._sendHeartbeat({ type: 'PING' })
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

  _sendCastMessage(namespace, payload, destinationId) {
    // Guard socket writes with null/connection checks
    if (!this._socket || !this._connected) {
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
      this._socket.write(message)
    } catch (err) {
      // Socket may have closed between check and write
      console.error('[Chromecast] Socket write error:', err?.message || err)
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
    if (!message?.namespace || !message.payloadUtf8) return

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
    }
  }

  _handleReceiver(payload) {
    if (payload.type === 'RECEIVER_STATUS' && payload.status) {
      try {
        console.log('[Chromecast] RECEIVER_STATUS apps:', payload.status.applications?.map((app) => ({
          appId: app.appId,
          transportId: app.transportId
        })) || []);
      } catch {}
      const status = payload.status
      if (status.volume && typeof status.volume.level === 'number') {
        if (this._state.volume !== status.volume.level) {
          this._state.volume = status.volume.level
          this.emit('volumeChanged', status.volume.level)
        }
      }

      if (Array.isArray(status.applications)) {
        const app = status.applications.find((entry) => entry.appId === DEFAULT_MEDIA_RECEIVER_APP_ID)
        if (app?.transportId) {
          this._transportId = app.transportId
          console.log('[Chromecast] using transportId', this._transportId)
          this._sendConnect(app.transportId)
          this._launchWaiters.splice(0).forEach((resolve) => resolve(app.transportId))
        }
      }
    }
  }

  _handleMedia(payload) {
    if (payload.type === 'MEDIA_STATUS') {
      try {
        const s = payload.status?.[0] || payload.status || {}
        // Log key fields for debugging drops
        console.log('[Chromecast] MEDIA_STATUS playerState:', s.playerState,
          'idleReason:', s.idleReason || 'none',
          'time:', s.currentTime?.toFixed(1) || 0,
          'buffering:', s.playerState === 'BUFFERING' ? 'YES' : 'no')
      } catch {}
      const status = Array.isArray(payload.status) ? payload.status[0] : null
      if (!status) return

      if (typeof status.mediaSessionId === 'number') {
        this._mediaSessionId = status.mediaSessionId
      }

      if (typeof status.currentTime === 'number') {
        this._state.currentTime = status.currentTime
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
        }
        if (status.playerState === 'IDLE' && status.idleReason) {
          console.warn('[Chromecast] Media idle reason:', status.idleReason)
          if (status.idleReason === 'ERROR') {
            const errType = status?.error?.type || 'unknown'
            console.warn('[Chromecast] Media error:', errType)
            this.emit('error', new Error(`Chromecast media error: ${errType}`))
          }
        }
      }
    }
  }

  _handleError(err) {
    if (!err) return
    const wasConnected = this._connected
    this._connected = false
    this.emit('connectionStateChanged', 'error')
    this.emit('error', err)
    try {
      console.warn('[Chromecast] socket error, graceful:', wasConnected, err?.message || err)
    } catch {}
    this._scheduleCleanup(err, { graceful: wasConnected })
  }

  _handleDisconnect() {
    if (!this._connected && !this._connecting) return
    const wasConnected = this._connected
    this._connected = false
    this._connecting = false
    this.emit('connectionStateChanged', 'disconnected')
    try {
      console.warn('[Chromecast] socket closed, graceful:', wasConnected)
    } catch {}
    this._scheduleCleanup(new Error('Connection closed'), { graceful: wasConnected })
  }

  _scheduleCleanup(err, options = {}) {
    const graceful = options?.graceful === true
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
    if (!handlers || !socket?.off) {
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
          socket.once?.('close', finish)
        } catch {}

        try {
          socket.end?.()
        } catch {}

        closeTimer = setTimeout(() => {
          try {
            console.warn('[Chromecast] socket end timeout, forcing destroy')
          } catch {}
          try {
            socket.destroy?.()
          } catch {}
          finish()
        }, 1500)
        return
      }

      try {
        console.log('[Chromecast] socket destroy requested (non-graceful)')
      } catch {}
      try {
        socket.destroy?.()
      } catch {}
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
      reject?.(err)
    } else {
      resolve?.()
    }
  }

  async _cleanupConnection(err) {
    if (this._cleanupInProgress) return
    this._cleanupInProgress = true
    try {
      this._stopHeartbeat()
      this._stopStatusPolling()

      try {
        console.log('[Chromecast] cleanup start, graceful:', this._gracefulClose, err?.message || err)
      } catch {}
      await this._closeSocket()

      this._buffer = Buffer.alloc(0)
      this._transportId = null
      this._mediaSessionId = null
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
      resolve?.()
    }
  }
}

export default ChromecastDevice
