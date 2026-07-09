/**
 * Device Discovery via mDNS
 *
 * Discovers Chromecast devices on the local network using mDNS.
 *
 * Service types:
 * - _googlecast._tcp.local. - Chromecast devices
 */

import { EventEmitter } from 'bare-events'
import {
  DNS_TYPE,
  MDNS_ADDRESS,
  MDNS_PORT,
  buildQuery,
  parseResponse
} from './mdns.js'

export { MDNS_ADDRESS, MDNS_PORT }

// Service types
export const ServiceType = {
  CHROMECAST: '_googlecast._tcp.local.'
}


/**
 * DeviceDiscoverer - Discovers cast devices on the network using mDNS
 */
export class DeviceDiscoverer extends EventEmitter {
  constructor(dependencies = {}) {
    super()
    this._loadDgram = dependencies.loadDgram || (() => import('bare-dgram'))
    this._setInterval = dependencies.setInterval || globalThis.setInterval
    this._clearInterval = dependencies.clearInterval || globalThis.clearInterval
    this._state = 'idle'
    this._generation = 0
    this._startPromise = null
    this._settleStart = null
    this._stopPromise = null
    this._devices = new Map()
    this._manualDevices = new Map()
    this._socket = null
    this._membershipSocket = null
    this._queryInterval = null
    this._queryIntervalSocket = null
  }

  /**
   * Start device discovery
   */
  start() {
    if (this._state === 'starting') return this._startPromise
    if (this._state === 'running') return Promise.resolve()
    if (this._state === 'stopping') return this._stopPromise || Promise.resolve()

    this._state = 'starting'
    const generation = ++this._generation
    this._startPromise = this._startMdns(generation)

    // Emit any manual devices
    for (const device of this._manualDevices.values()) {
      this.emit('deviceFound', device)
    }

    return this._startPromise
  }

  /**
   * Start mDNS socket
   */
  _startMdns(generation) {
    let resolveStart
    let settled = false
    const startPromise = new Promise((resolve) => {
      resolveStart = resolve
    })

    const settle = (cleanup = Promise.resolve()) => {
      if (settled) return
      settled = true
      if (this._settleStart === settle) this._settleStart = null
      Promise.resolve(cleanup).catch(() => {}).then(resolveStart)
    }

    const fail = (socket) => {
      if (settled) return
      const cleanup = socket && this._socket === socket
        ? this._cleanupSocket(socket)
        : Promise.resolve()
      const finished = cleanup.then(() => {
        if (generation === this._generation && this._state === 'starting') {
          this._state = 'idle'
        }
      })
      settle(finished)
    }

    this._settleStart = settle

    Promise.resolve()
      .then(() => this._loadDgram())
      .then((dgram) => {
        if (generation !== this._generation || this._state !== 'starting') {
          settle()
          return
        }

        let socket
        try {
          socket = dgram.createSocket({ type: 'udp4', reuseAddress: true })
          this._socket = socket

          socket.on('error', () => {
            if (generation !== this._generation || this._socket !== socket) return
            if (this._state === 'starting') {
              fail(socket)
              return
            }
            if (this._state !== 'running') return

            const errorGeneration = ++this._generation
            this._state = 'stopping'
            const cleanup = this._cleanupSocket(socket)
            const stopped = cleanup.then(() => {
              if (errorGeneration === this._generation && this._state === 'stopping') {
                this._state = 'idle'
              }
              if (this._stopPromise === stopped) this._stopPromise = null
            })
            this._stopPromise = stopped
          })

          socket.on('message', (msg, rinfo) => {
            if (generation !== this._generation || this._socket !== socket) return
            this._handleMessage(msg, rinfo)
          })

          socket.on('listening', () => {
            const isStaleStart = () => (
              generation !== this._generation ||
              this._state !== 'starting' ||
              this._socket !== socket
            )
            if (isStaleStart()) return

            try {
              const innerSocket = socket._socket
              if (!innerSocket || typeof innerSocket.addMembership !== 'function') {
                throw new Error('Multicast membership is not supported')
              }

              this._membershipSocket = socket
              try {
                innerSocket.addMembership(MDNS_ADDRESS)
              } catch (err) {
                if (this._membershipSocket === socket) this._membershipSocket = null
                throw err
              }
              if (isStaleStart()) return

              this._sendQuery(generation, socket)
              if (isStaleStart()) return

              const interval = this._setInterval(() => {
                if (
                  generation === this._generation &&
                  this._state === 'running' &&
                  this._socket === socket
                ) {
                  this._sendQuery(generation, socket)
                }
              }, 5000)
              if (isStaleStart()) {
                try {
                  this._clearInterval(interval)
                } catch {}
                return
              }

              this._queryInterval = interval
              this._queryIntervalSocket = socket
              this._state = 'running'
              settle()
            } catch {
              fail(socket)
            }
          })

          socket.bind(MDNS_PORT, '0.0.0.0')
        } catch {
          fail(socket)
        }
      })
      .catch(() => fail(null))

    return startPromise
  }

  /**
   * Send mDNS queries for Chromecast
   */
  _sendQuery(generation, socket) {
    if (generation !== this._generation || this._socket !== socket) return
    const query = buildQuery(ServiceType.CHROMECAST)
    try {
      const sent = socket.send(query, 0, query.length, MDNS_PORT, MDNS_ADDRESS)
      Promise.resolve(sent).catch(() => {})
    } catch {}
  }

  /**
   * Handle incoming mDNS message
   */
  _handleMessage(msg, rinfo) {
    try {
      const response = parseResponse(msg)
      if (!response) return

      // Look for Chromecast PTR records
      const allRecords = response.records

      for (const record of allRecords) {
        if (record.type === DNS_TYPE.PTR) {
          const isChromecast = record.name.includes('_googlecast._tcp')

          if (isChromecast) {
            // Find corresponding SRV and A records
            const instanceName = record.ptr
            const srvRecord = allRecords.find(r => r.type === DNS_TYPE.SRV && r.name === instanceName)
            const aRecord = allRecords.find(r => r.type === DNS_TYPE.A)
            const txtRecord = allRecords.find(r => r.type === DNS_TYPE.TXT && r.name === instanceName)

            if (srvRecord && aRecord) {
              const host = aRecord.address
              const port = srvRecord.port
              const protocol = 'chromecast'
              const id = `${host}:${port}`

              // Extract friendly name from TXT record or instance name
              let name = instanceName.split('.')[0].replace(/\\032/g, ' ')
              if (txtRecord?.txt?.fn) {
                name = txtRecord.txt.fn
              } else if (txtRecord?.txt?.md) {
                name = txtRecord.txt.md
              }

              const device = { id, name, host, port, protocol }

              if (!this._devices.has(id)) {
                this._devices.set(id, device)
                console.log('[Discovery] Found device:', name, host, port, protocol)
                this.emit('deviceFound', device)
              }
            }
          }
        }
      }
    } catch (err) {
      // Ignore parse errors
    }
  }

  /**
   * Stop mDNS discovery
   */
  _cleanupSocket(socket) {
    if (!socket || this._socket !== socket) return Promise.resolve()

    this._socket = null

    if (this._queryIntervalSocket === socket) {
      const interval = this._queryInterval
      this._queryInterval = null
      this._queryIntervalSocket = null
      if (interval !== null) {
        try {
          this._clearInterval(interval)
        } catch {}
      }
    }

    if (this._membershipSocket === socket) {
      this._membershipSocket = null
      try {
        const innerSocket = socket._socket
        if (innerSocket && typeof innerSocket.dropMembership === 'function') {
          innerSocket.dropMembership(MDNS_ADDRESS)
        }
      } catch {}
    }

    try {
      return Promise.resolve(socket.close()).catch(() => {})
    } catch {
      return Promise.resolve()
    }
  }

  /**
   * Stop device discovery
   */
  stop() {
    if (this._state === 'idle') return Promise.resolve()
    if (this._state === 'stopping') return this._stopPromise || Promise.resolve()

    const settleStart = this._settleStart
    const socket = this._socket
    const stopGeneration = ++this._generation
    this._state = 'stopping'
    const cleanup = this._cleanupSocket(socket)
    const stopped = cleanup.then(() => {
      if (stopGeneration === this._generation && this._state === 'stopping') {
        this._state = 'idle'
      }
      if (this._stopPromise === stopped) this._stopPromise = null
    })
    this._stopPromise = stopped
    if (settleStart) settleStart(stopped)
    return stopped
  }

  /**
   * Check if discovery is running
   */
  isRunning() {
    return this._state === 'starting' || this._state === 'running'
  }

  /**
   * Add a device manually
   * Useful when mDNS discovery is not available
   *
   * @param {Object} options
   * @param {string} options.name - Device name
   * @param {string} options.host - IP address or hostname
   * @param {number} [options.port] - Port number (default: 8009 for chromecast)
   * @param {string} [options.protocol='chromecast'] - Protocol type
   * @returns {Object} The device info
   */
  addManualDevice(options) {
    const protocol = options.protocol || 'chromecast'
    const port = options.port || 8009
    const id = `${options.host}:${port}`

    const device = {
      id,
      name: options.name || `${protocol} @ ${options.host}`,
      host: options.host,
      port,
      protocol,
      manual: true
    }

    this._manualDevices.set(id, device)
    this._devices.set(id, device)

    if (this.isRunning()) {
      this.emit('deviceFound', device)
    }

    return device
  }

  /**
   * Remove a manually added device
   * @param {string} deviceId
   */
  removeManualDevice(deviceId) {
    const device = this._manualDevices.get(deviceId)
    if (device) {
      this._manualDevices.delete(deviceId)
      this._devices.delete(deviceId)
      this.emit('deviceLost', deviceId)
    }
  }

  /**
   * Get all discovered devices
   * @returns {Object[]}
   */
  getDevices() {
    return Array.from(this._devices.values())
  }

  /**
   * Clear all devices
   */
  clearDevices() {
    for (const id of this._devices.keys()) {
      this.emit('deviceLost', id)
    }
    this._devices.clear()
    this._manualDevices.clear()
  }
}

export default DeviceDiscoverer
