/**
 * FCast Protocol Implementation
 *
 * FCast is a simple TCP-based casting protocol on port 46899.
 * Packet format: [size:uint32_le][opcode:uint8][body:json]
 *
 * Protocol specification: https://fcast.org/protocol-v3
 */

import { EventEmitter } from 'bare-events'
import tcp from 'bare-tcp'
import Buffer from 'bare-buffer'

// Default FCast port
export const FCAST_PORT = 46899

// FCast opcodes
export const Opcode = {
  // Sender -> Receiver
  PLAY: 1,
  PAUSE: 2,
  RESUME: 3,
  STOP: 4,
  SEEK: 5,
  SET_VOLUME: 8,
  SET_SPEED: 10,
  VERSION: 11,

  // Receiver -> Sender
  PLAYBACK_UPDATE: 6,
  VOLUME_UPDATE: 7,
  PLAYBACK_ERROR: 9,
  VERSION_RESULT: 12,
  INITIAL_INFO: 14
}

/**
 * FCastDevice - Handles communication with an FCast receiver
 */
export class FCastDevice extends EventEmitter {
  constructor(deviceInfo) {
    super()
    this.deviceInfo = deviceInfo
    this._socket = null
    this._connected = false
    this._buffer = Buffer.alloc(0)

    // Playback state
    this._state = {
      state: 'idle',
      currentTime: 0,
      duration: 0,
      volume: 1.0,
      speed: 1.0
    }
  }

  /**
   * Connect to the FCast receiver
   * @param {number} [timeout=5000] - Connection timeout in ms
   */
  async connect(timeout = 5000) {
    if (this._connected) return

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._socket) {
          this._socket.destroy()
          this._socket = null
        }
        reject(new Error('Connection timeout'))
      }, timeout)

      this._socket = tcp.connect(this.deviceInfo.port || FCAST_PORT, this.deviceInfo.host)

      this._socket.on('connect', () => {
        clearTimeout(timer)
        this._connected = true
        this.emit('connectionStateChanged', 'connected')

        // Request version info
        this._sendMessage(Opcode.VERSION, {})
        resolve()
      })

      this._socket.on('data', (data) => {
        this._handleData(data)
      })

      this._socket.on('error', (err) => {
        clearTimeout(timer)
        this._connected = false
        this.emit('connectionStateChanged', 'error')
        this.emit('error', err)
        reject(err)
      })

      this._socket.on('close', () => {
        this._connected = false
        this.emit('connectionStateChanged', 'disconnected')
      })
    })
  }

  /**
   * Disconnect from the receiver
   */
  async disconnect() {
    if (this._socket) {
      this._socket.destroy()
      this._socket = null
    }
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
   * @param {Object} options - Play options
   */
  async play(options) {
    const message = {
      container: options.contentType,
      url: options.url,
      time: options.time || 0,
      volume: options.volume !== undefined ? options.volume : 1.0,
      speed: options.speed || 1.0
    }

    if (options.headers) {
      message.headers = options.headers
    }

    if (options.metadata || options.title) {
      message.metadata = options.metadata || {}
      if (options.title) {
        message.metadata.title = options.title
      }
      if (options.thumbnail) {
        message.metadata.iconUrl = options.thumbnail
      }
    }

    this._sendMessage(Opcode.PLAY, message)
    this._state.state = 'loading'
    this.emit('playbackStateChanged', 'loading')
  }

  /**
   * Pause playback
   */
  async pause() {
    this._sendMessage(Opcode.PAUSE, {})
  }

  /**
   * Resume playback
   */
  async resume() {
    this._sendMessage(Opcode.RESUME, {})
  }

  /**
   * Stop playback
   */
  async stop() {
    this._sendMessage(Opcode.STOP, {})
    this._state.state = 'stopped'
    this.emit('playbackStateChanged', 'stopped')
  }

  /**
   * Seek to position
   * @param {number} time - Position in seconds
   */
  async seek(time) {
    this._sendMessage(Opcode.SEEK, { time })
  }

  /**
   * Set volume
   * @param {number} volume - Volume (0.0 - 1.0)
   */
  async setVolume(volume) {
    this._sendMessage(Opcode.SET_VOLUME, { volume })
    this._state.volume = volume
    this.emit('volumeChanged', volume)
  }

  /**
   * Set playback speed
   * @param {number} speed - Playback speed (1.0 = normal)
   */
  async setSpeed(speed) {
    this._sendMessage(Opcode.SET_SPEED, { speed })
    this._state.speed = speed
  }

  /**
   * Get current playback state
   */
  getPlaybackState() {
    return { ...this._state }
  }

  /**
   * Send a message to the receiver
   * @private
   */
  _sendMessage(opcode, body) {
    if (!this._socket || !this._connected) {
      throw new Error('Not connected')
    }

    const jsonBody = JSON.stringify(body)
    const bodyBuffer = Buffer.from(jsonBody, 'utf8')

    // Packet: [size:uint32_le][opcode:uint8][body:json]
    const packet = Buffer.alloc(4 + 1 + bodyBuffer.length)
    packet.writeUInt32LE(1 + bodyBuffer.length, 0) // size = opcode + body
    packet.writeUInt8(opcode, 4)
    bodyBuffer.copy(packet, 5)

    this._socket.write(packet)
  }

  /**
   * Handle incoming data
   * @private
   */
  _handleData(data) {
    // Append to buffer
    this._buffer = Buffer.concat([this._buffer, data])

    // Process complete messages
    while (this._buffer.length >= 4) {
      const size = this._buffer.readUInt32LE(0)

      // Check if we have the full message
      if (this._buffer.length < 4 + size) {
        break
      }

      // Extract message
      const opcode = this._buffer.readUInt8(4)
      const bodyBuffer = this._buffer.slice(5, 4 + size)
      let body = {}

      if (bodyBuffer.length > 0) {
        try {
          body = JSON.parse(bodyBuffer.toString('utf8'))
        } catch (e) {
          console.warn('[FCast] Failed to parse message body:', e)
        }
      }

      // Remove processed message from buffer
      this._buffer = this._buffer.slice(4 + size)

      // Handle message
      this._handleMessage(opcode, body)
    }
  }

  /**
   * Handle a parsed message
   * @private
   */
  _handleMessage(opcode, body) {
    switch (opcode) {
      case Opcode.PLAYBACK_UPDATE:
        this._handlePlaybackUpdate(body)
        break

      case Opcode.VOLUME_UPDATE:
        this._state.volume = body.volume
        this.emit('volumeChanged', body.volume)
        break

      case Opcode.PLAYBACK_ERROR:
        this._state.state = 'error'
        this.emit('playbackStateChanged', 'error')
        this.emit('error', new Error(body.message || 'Playback error'))
        break

      case Opcode.VERSION_RESULT:
        this.emit('versionInfo', body)
        break

      case Opcode.INITIAL_INFO:
        // Receiver sent initial state info
        if (body.volume !== undefined) {
          this._state.volume = body.volume
        }
        break

      default:
        console.log('[FCast] Unknown opcode:', opcode, body)
    }
  }

  /**
   * Handle playback update message
   * @private
   */
  _handlePlaybackUpdate(body) {
    // Map FCast state to our states
    // FCast states: 0=idle, 1=playing, 2=paused
    const stateMap = {
      0: 'idle',
      1: 'playing',
      2: 'paused'
    }

    if (body.state !== undefined) {
      const newState = stateMap[body.state] || 'idle'
      if (this._state.state !== newState) {
        this._state.state = newState
        this.emit('playbackStateChanged', newState)
      }
    }

    if (body.time !== undefined) {
      this._state.currentTime = body.time
      this.emit('timeChanged', body.time)
    }

    if (body.duration !== undefined) {
      this._state.duration = body.duration
      this.emit('durationChanged', body.duration)
    }

    if (body.speed !== undefined) {
      this._state.speed = body.speed
    }
  }
}

export default FCastDevice
