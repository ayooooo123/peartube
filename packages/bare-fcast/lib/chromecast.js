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
    parts.push(encodeFieldBytes(7, payloadBinary))
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
    this._socket = null
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
  }

  /**
   * Connect to the Chromecast device
   */
  async connect(timeout = 5000) {
    if (this._connected) return
    if (this._connectPromise) return this._connectPromise

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
        this._handleAppData(data)
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
    this._cleanupConnection()
    this._connected = false
    this.emit('connectionStateChanged', 'disconnected')
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
        metadata
      }
    }

    console.log('[Chromecast] sending LOAD to transport', this._transportId)
    this._sendMediaMessage(payload)
    try {
      this._sendMediaMessage({ type: 'GET_STATUS', requestId: this._nextRequestId() })
    } catch {}
    this._state.state = 'loading'
    this.emit('playbackStateChanged', 'loading')
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
      if (this._connected) {
        this._sendHeartbeat({ type: 'PING' })
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
    this._statusTimer = setInterval(() => {
      if (this._connected && this._transportId) {
        this._sendMediaMessage({ type: 'GET_STATUS', requestId: this._nextRequestId() })
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
    if (!this._socket) {
      throw new Error('Not connected')
    }

    const payloadUtf8 = typeof payload === 'string' ? payload : JSON.stringify(payload)
    const message = encodeCastMessage({
      sourceId: SOURCE_ID,
      destinationId,
      namespace,
      payloadUtf8
    })

    this._socket.write(message)
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
    this._buffer = Buffer.concat([this._buffer, data])

    while (this._buffer.length >= 4) {
      const length = this._buffer.readUInt32BE(0)
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
      this._sendHeartbeat({ type: 'PONG' })
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
        const app = status.applications.find((entry) => entry.appId === DEFAULT_MEDIA_RECEIVER_APP_ID) || status.applications[0]
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
        console.log('[Chromecast] MEDIA_STATUS', JSON.stringify(payload.status?.[0] || payload.status || {}))
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
    this._connected = false
    this.emit('connectionStateChanged', 'error')
    this.emit('error', err)
    this._cleanupConnection(err)
  }

  _handleDisconnect() {
    if (!this._connected && !this._connecting) return
    this._cleanupConnection(new Error('Connection closed'))
    this._connected = false
    this._connecting = false
    this.emit('connectionStateChanged', 'disconnected')
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

  _cleanupConnection(err) {
    if (this._cleanupInProgress) return
    this._cleanupInProgress = true
    this._stopHeartbeat()
    this._stopStatusPolling()

    if (this._socket) {
      try {
        this._socket.removeAllListeners?.()
        this._socket.destroy()
      } catch {}
      this._socket = null
    }

    this._buffer = Buffer.alloc(0)
    this._transportId = null
    this._mediaSessionId = null
    this._launchWaiters = []
    this._activeConnectToken = 0
    this._finalizeConnect(err || new Error('Connection closed'))
    this._cleanupInProgress = false
  }
}

export default ChromecastDevice
