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
  constructor() {
    super()
    this._running = false
    this._devices = new Map()
    this._manualDevices = new Map()
    this._socket = null
    this._queryInterval = null
  }

  /**
   * Start device discovery
   */
  async start() {
    if (this._running) return
    this._running = true

    // Emit any manual devices
    for (const device of this._manualDevices.values()) {
      this.emit('deviceFound', device)
    }

    // Try to start mDNS discovery
    try {
      await this._startMdns()
    } catch (err) {
      console.warn('[Discovery] mDNS not available, using manual mode only:', err.message)
    }
  }

  /**
   * Start mDNS socket
   */
  async _startMdns() {
    // Try to import bare-dgram
    let dgram
    try {
      dgram = await import('bare-dgram')
      console.log('[Discovery] bare-dgram loaded successfully')
    } catch (e) {
      throw new Error('bare-dgram not available: ' + e.message)
    }

    return new Promise((resolve, reject) => {
      try {
        console.log('[Discovery] Creating UDP socket...')
        try {
          this._socket = dgram.createSocket({ type: 'udp4', reuseAddress: true })
        } catch {
          try {
            this._socket = dgram.createSocket('udp4')
          } catch {
            this._socket = dgram.createSocket()
          }
        }
        console.log('[Discovery] Socket created')

        this._socket.on('error', (err) => {
          console.error('[Discovery] Socket error:', err.message)
          this._stopMdns()
          reject(err)
        })

        this._socket.on('message', (msg, rinfo) => {
          this._handleMessage(msg, rinfo)
        })

        this._socket.on('listening', () => {
          const addr = this._socket.address()
          console.log('[Discovery] mDNS socket listening on port', addr?.port || 'unknown')

          // Try to join multicast group using underlying udx-native socket
          try {
            // Access the underlying udx-native socket which has addMembership
            const innerSocket = this._socket._socket
            if (innerSocket && typeof innerSocket.addMembership === 'function') {
              innerSocket.addMembership(MDNS_ADDRESS)
              console.log('[Discovery] Joined multicast group', MDNS_ADDRESS)
            } else {
              console.warn('[Discovery] Multicast not supported, sending queries anyway')
            }
          } catch (e) {
            // Multicast join is optional - we can still send queries
            console.warn('[Discovery] Could not join multicast group:', e.message)
          }

          // Send initial queries
          this._sendQueries()

          // Send periodic queries every 5 seconds
          this._queryInterval = setInterval(() => {
            if (this._running) {
              this._sendQueries()
            }
          }, 5000)

          resolve()
        })

        // Bind to a random port on all IPv4 interfaces
        // We explicitly use '0.0.0.0' to avoid IPv6 issues
        console.log('[Discovery] Binding to 0.0.0.0:0...')
        this._socket.bind(0, '0.0.0.0')
      } catch (err) {
        console.error('[Discovery] Failed to start mDNS:', err.message)
        reject(err)
      }
    })
  }

  /**
   * Send mDNS queries for Chromecast
   */
  async _sendQueries() {
    if (!this._socket) return

    try {
      const queries = [buildQuery(ServiceType.CHROMECAST)]

      for (const query of queries) {
        await this._socket.send(query, 0, query.length, MDNS_PORT, MDNS_ADDRESS)
      }

      console.log('[Discovery] Sent mDNS queries to', MDNS_ADDRESS + ':' + MDNS_PORT)
    } catch (err) {
      console.warn('[Discovery] Error sending queries:', err.message)
    }
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
  _stopMdns() {
    if (this._queryInterval) {
      clearInterval(this._queryInterval)
      this._queryInterval = null
    }

    if (this._socket) {
      // Try to leave multicast group using inner udx-native socket
      try {
        const innerSocket = this._socket._socket
        if (innerSocket && typeof innerSocket.dropMembership === 'function') {
          innerSocket.dropMembership(MDNS_ADDRESS)
        }
      } catch (e) {}

      try {
        this._socket.close()
      } catch (e) {}

      this._socket = null
    }
  }

  /**
   * Stop device discovery
   */
  stop() {
    this._running = false
    this._stopMdns()
    console.log('[Discovery] Stopped')
  }

  /**
   * Check if discovery is running
   */
  isRunning() {
    return this._running
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

    if (this._running) {
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
