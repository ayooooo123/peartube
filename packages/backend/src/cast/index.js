/**
 * PearTube Cast - Chromecast sender SDK for Bare/Pear runtime
 *
 * Implements the Chromecast protocol (TLS + protobuf on port 8009) for casting
 * media to receiver devices.
 */

import { EventEmitter } from 'bare-events'
import { ChromecastDevice } from './chromecast.js'
import { DeviceDiscoverer } from './discovery.js'

/**
 * Protocol types supported
 */
export const ProtocolType = {
  CHROMECAST: 'chromecast'
}

/**
 * Device connection states
 */
export const ConnectionState = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ERROR: 'error'
}

/**
 * Playback states
 */
export const PlaybackState = {
  IDLE: 'idle',
  LOADING: 'loading',
  BUFFERING: 'buffering',
  PLAYING: 'playing',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  ERROR: 'error'
}

/**
 * Device information
 * @typedef {Object} DeviceInfo
 * @property {string} id - Unique device identifier
 * @property {string} name - Human-readable device name
 * @property {string} host - IP address or hostname
 * @property {number} port - Port number
 * @property {string} protocol - Protocol type ('chromecast')
 */

/**
 * Play options for media playback
 * @typedef {Object} PlayOptions
 * @property {string} url - Media URL to play
 * @property {string} contentType - MIME type of the media
 * @property {string} [title] - Optional title
 * @property {string} [thumbnail] - Optional thumbnail URL
 * @property {number} [time] - Start position in seconds
 * @property {number} [volume] - Volume (0.0 - 1.0)
 * @property {number} [speed] - Playback speed
 * @property {Object} [headers] - Request headers for the media URL
 * @property {Object} [metadata] - Additional metadata
 */

/**
 * CastContext - Main entry point for the casting SDK
 *
 * Manages device discovery and device connections.
 *
 * @example
 * const ctx = new CastContext()
 * ctx.on('deviceFound', (device) => console.log('Found:', device.name))
 * ctx.startDiscovery()
 */
export class CastContext extends EventEmitter {
  constructor() {
    super()
    this._discoverer = new DeviceDiscoverer()
    this._devices = new Map() // id -> DeviceInfo
    this._connectedDevice = null
    this._connectPromise = null
    this._resumeDiscoveryOnDisconnect = false

    // Forward discovery events
    this._discoverer.on('deviceFound', (device) => {
      this._devices.set(device.id, device)
      this.emit('deviceFound', device)
    })

    this._discoverer.on('deviceLost', (deviceId) => {
      this._devices.delete(deviceId)
      this.emit('deviceLost', deviceId)
    })

    this._discoverer.on('deviceChanged', (device) => {
      this._devices.set(device.id, device)
      this.emit('deviceChanged', device)
    })
  }

  /**
   * Start discovering cast devices on the network
   */
  async startDiscovery() {
    await this._discoverer.start()
  }

  /**
   * Stop device discovery
   */
  stopDiscovery() {
    this._discoverer.stop()
  }

  /**
   * Get all discovered devices
   * @returns {DeviceInfo[]}
   */
  getDevices() {
    return Array.from(this._devices.values())
  }

  addManualDevice(options) {
    const device = this._discoverer.addManualDevice(options)
    this._devices.set(device.id, device)
    return device
  }

  removeManualDevice(deviceId) {
    this._discoverer.removeManualDevice(deviceId)
    this._devices.delete(deviceId)
  }

  /**
   * Get a device by ID
   * @param {string} deviceId
   * @returns {DeviceInfo|undefined}
   */
  getDevice(deviceId) {
    return this._devices.get(deviceId)
  }

  /**
   * Create a device instance from DeviceInfo
   * @param {DeviceInfo} deviceInfo
   * @returns {ChromecastDevice}
   */
  createDevice(deviceInfo) {
    return new ChromecastDevice(deviceInfo)
  }

  /**
   * Connect to a device by ID
   * @param {string} deviceId
   * @returns {Promise<ChromecastDevice>}
   */
  async connect(deviceId, options = {}) {
    const deviceInfo = this._devices.get(deviceId)
    if (!deviceInfo) {
      throw new Error(`Device not found: ${deviceId}`)
    }

    if (this._connectedDevice && this._connectedDevice.deviceInfo?.id === deviceId && this._connectedDevice.isConnected()) {
      return this._connectedDevice
    }

    if (this._connectPromise) return this._connectPromise

    this._connectPromise = (async () => {
      const connectTimeout = Number.isFinite(options?.timeout)
        ? Math.max(1000, Number(options.timeout))
        : 9000
      const maxAttempts = Number.isFinite(options?.attempts)
        ? Math.max(1, Math.floor(Number(options.attempts)))
        : 2

      const wasDiscovering = this._discoverer.isRunning?.() === true
      if (wasDiscovering) {
        this._resumeDiscoveryOnDisconnect = true
        this._discoverer.stop()
      }

      try {
        // Disconnect from current device if any
        if (this._connectedDevice) {
          await this.disconnect()
        }

        let lastError = null
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const device = this.createDevice(deviceInfo)
          try {
            // Forward device events BEFORE connect so errors during
            // the TLS handshake are not unhandled.
            device.on('connectionStateChanged', (state) => {
              this.emit('connectionStateChanged', state)
              if (state === ConnectionState.DISCONNECTED) {
                this._connectedDevice = null
              }
            })

            device.on('playbackStateChanged', (state) => {
              this.emit('playbackStateChanged', state)
            })

            device.on('timeChanged', (time) => {
              this.emit('timeChanged', time)
            })

            device.on('durationChanged', (duration) => {
              this.emit('durationChanged', duration)
            })

            device.on('volumeChanged', (volume) => {
              this.emit('volumeChanged', volume)
            })

            device.on('error', (error) => {
              this.emit('error', error)
            })

            device.on('reconnecting', (payload) => {
              this.emit('reconnecting', payload)
            })

            device.on('reconnectFailed', (payload) => {
              this.emit('reconnectFailed', payload)
            })

            await device.connect(connectTimeout)
            this._connectedDevice = device

            return device
          } catch (err) {
            lastError = err
            try {
              await device.disconnect()
            } catch (disconnectErr) {
              this.emit('error', disconnectErr)
            }

            if (attempt < maxAttempts) {
              await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
              continue
            }
          }
        }

        throw (lastError || new Error('Failed to connect to cast device'))
      } catch (err) {
        this._connectedDevice = null
        if (this._resumeDiscoveryOnDisconnect) {
          this._resumeDiscoveryOnDisconnect = false
          this.startDiscovery().catch(() => {})
        }
        throw err
      } finally {
        this._connectPromise = null
      }
    })()

    return this._connectPromise
  }

  /**
   * Disconnect from the current device
   */
  async disconnect() {
    if (this._connectedDevice) {
      await this._connectedDevice.disconnect()
      this._connectedDevice = null
    }
    if (this._resumeDiscoveryOnDisconnect) {
      this._resumeDiscoveryOnDisconnect = false
      this.startDiscovery().catch(() => {})
    }
  }

  /**
   * Get the currently connected device
   * @returns {ChromecastDevice|null}
   */
  getConnectedDevice() {
    return this._connectedDevice
  }

  /**
   * Check if connected to a device
   * @returns {boolean}
   */
  isConnected() {
    return this._connectedDevice !== null && this._connectedDevice.isConnected()
  }

  /**
   * Play media on the connected device
   * @param {PlayOptions} options
   */
  async play(options) {
    if (!this._connectedDevice) {
      throw new Error('Not connected to any device')
    }
    return this._connectedDevice.play(options)
  }

  /**
   * Pause playback
   */
  async pause() {
    if (!this._connectedDevice) {
      throw new Error('Not connected to any device')
    }
    return this._connectedDevice.pause()
  }

  /**
   * Resume playback
   */
  async resume() {
    if (!this._connectedDevice) {
      throw new Error('Not connected to any device')
    }
    return this._connectedDevice.resume()
  }

  /**
   * Stop playback
   */
  async stop() {
    if (!this._connectedDevice) {
      throw new Error('Not connected to any device')
    }
    return this._connectedDevice.stop()
  }

  /**
   * Seek to position
   * @param {number} time - Position in seconds
   */
  async seek(time) {
    if (!this._connectedDevice) {
      throw new Error('Not connected to any device')
    }
    return this._connectedDevice.seek(time)
  }

  /**
   * Set volume
   * @param {number} volume - Volume (0.0 - 1.0)
   */
  async setVolume(volume) {
    if (!this._connectedDevice) {
      throw new Error('Not connected to any device')
    }
    return this._connectedDevice.setVolume(volume)
  }

  /**
   * Get current playback state
   * @returns {Object}
   */
  getPlaybackState() {
    if (!this._connectedDevice) {
      return {
        state: PlaybackState.IDLE,
        currentTime: 0,
        duration: 0,
        volume: 1.0
      }
    }
    return this._connectedDevice.getPlaybackState()
  }

  /**
   * Clean up resources
   */
  destroy() {
    this.stopDiscovery()
    if (this._connectedDevice) {
      this._connectedDevice.disconnect()
      this._connectedDevice = null
    }
    this._devices.clear()
  }
}

// Export classes
export { ChromecastDevice } from './chromecast.js'
export { DeviceDiscoverer } from './discovery.js'

// Default export
export default CastContext
