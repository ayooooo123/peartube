/**
 * Device Discovery via mDNS
 *
 * Discovers FCast and Chromecast devices on the local network using mDNS.
 *
 * Service types:
 * - _fcast._tcp.local. - FCast receivers
 * - _googlecast._tcp.local. - Chromecast devices
 */

import { EventEmitter } from 'bare-events'

// mDNS multicast address and port
export const MDNS_ADDRESS = '224.0.0.251'
export const MDNS_PORT = 5353

// Service types
export const ServiceType = {
  FCAST: '_fcast._tcp.local.',
  CHROMECAST: '_googlecast._tcp.local.'
}

// DNS record types
const DNS_TYPE = {
  A: 1,
  PTR: 12,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  ANY: 255
}

// DNS classes
const DNS_CLASS = {
  IN: 1,
  ANY: 255
}

/**
 * Encode a DNS name (e.g., "_fcast._tcp.local.") into wire format
 */
function encodeName(name) {
  const parts = name.replace(/\.$/, '').split('.')
  const buffers = []
  for (const part of parts) {
    const partBuf = Buffer.from(part, 'utf8')
    buffers.push(Buffer.from([partBuf.length]))
    buffers.push(partBuf)
  }
  buffers.push(Buffer.from([0])) // null terminator
  return Buffer.concat(buffers)
}

/**
 * Decode a DNS name from wire format
 */
function decodeName(buffer, offset, message) {
  const parts = []
  let jumped = false
  let originalOffset = offset

  while (offset < buffer.length) {
    const len = buffer[offset]

    if (len === 0) {
      offset++
      break
    }

    // Check for compression pointer (starts with 11xxxxxx)
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) {
        originalOffset = offset + 2
      }
      offset = ((len & 0x3f) << 8) | buffer[offset + 1]
      jumped = true
      continue
    }

    offset++
    parts.push(buffer.slice(offset, offset + len).toString('utf8'))
    offset += len
  }

  return {
    name: parts.join('.'),
    offset: jumped ? originalOffset : offset
  }
}

/**
 * Build an mDNS query packet
 *
 * @param {string} serviceName - The service to query for
 * @param {boolean} unicastResponse - If true, request unicast response (QU bit)
 */
function buildQuery(serviceName, unicastResponse = true) {
  const name = encodeName(serviceName)

  // DNS header (12 bytes)
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0, 0)      // ID = 0 for mDNS
  header.writeUInt16BE(0, 2)      // Flags = 0 (standard query)
  header.writeUInt16BE(1, 4)      // QDCOUNT = 1
  header.writeUInt16BE(0, 6)      // ANCOUNT = 0
  header.writeUInt16BE(0, 8)      // NSCOUNT = 0
  header.writeUInt16BE(0, 10)     // ARCOUNT = 0

  // Question section
  const question = Buffer.alloc(4)
  question.writeUInt16BE(DNS_TYPE.PTR, 0)   // QTYPE = PTR
  // QCLASS = IN, with QU (unicast response) bit set if requested
  // QU bit is the high bit of the class field (0x8000)
  const qclass = unicastResponse ? (DNS_CLASS.IN | 0x8000) : DNS_CLASS.IN
  question.writeUInt16BE(qclass, 2)

  return Buffer.concat([header, name, question])
}

/**
 * Parse an mDNS response packet
 */
function parseResponse(buffer) {
  if (buffer.length < 12) return null

  const result = {
    id: buffer.readUInt16BE(0),
    flags: buffer.readUInt16BE(2),
    qdcount: buffer.readUInt16BE(4),
    ancount: buffer.readUInt16BE(6),
    nscount: buffer.readUInt16BE(8),
    arcount: buffer.readUInt16BE(10),
    answers: [],
    additionals: []
  }

  // Skip if not a response
  if ((result.flags & 0x8000) === 0) return null

  let offset = 12

  // Skip questions
  for (let i = 0; i < result.qdcount && offset < buffer.length; i++) {
    const decoded = decodeName(buffer, offset, buffer)
    offset = decoded.offset + 4 // skip QTYPE and QCLASS
  }

  // Parse answers
  const parseRecords = (count) => {
    const records = []
    for (let i = 0; i < count && offset < buffer.length; i++) {
      try {
        const decoded = decodeName(buffer, offset, buffer)
        offset = decoded.offset

        if (offset + 10 > buffer.length) break

        const type = buffer.readUInt16BE(offset)
        const cls = buffer.readUInt16BE(offset + 2)
        const ttl = buffer.readUInt32BE(offset + 4)
        const rdlength = buffer.readUInt16BE(offset + 8)
        offset += 10

        if (offset + rdlength > buffer.length) break

        const rdata = buffer.slice(offset, offset + rdlength)
        offset += rdlength

        const record = { name: decoded.name, type, class: cls, ttl, rdata }

        // Parse specific record types
        if (type === DNS_TYPE.A && rdlength === 4) {
          record.address = `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`
        } else if (type === DNS_TYPE.SRV && rdlength >= 6) {
          record.priority = rdata.readUInt16BE(0)
          record.weight = rdata.readUInt16BE(2)
          record.port = rdata.readUInt16BE(4)
          const targetDecoded = decodeName(buffer, offset - rdlength + 6, buffer)
          record.target = targetDecoded.name
        } else if (type === DNS_TYPE.PTR) {
          const ptrDecoded = decodeName(buffer, offset - rdlength, buffer)
          record.ptr = ptrDecoded.name
        } else if (type === DNS_TYPE.TXT) {
          record.txt = {}
          let txtOffset = 0
          while (txtOffset < rdlength) {
            const txtLen = rdata[txtOffset]
            if (txtLen === 0) break
            const txtStr = rdata.slice(txtOffset + 1, txtOffset + 1 + txtLen).toString('utf8')
            const eqIdx = txtStr.indexOf('=')
            if (eqIdx > 0) {
              record.txt[txtStr.slice(0, eqIdx)] = txtStr.slice(eqIdx + 1)
            }
            txtOffset += 1 + txtLen
          }
        }

        records.push(record)
      } catch (e) {
        break
      }
    }
    return records
  }

  result.answers = parseRecords(result.ancount)
  result.additionals = parseRecords(result.arcount + result.nscount)

  return result
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
        this._socket = dgram.createSocket()
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
   * Send mDNS queries for FCast and Chromecast
   */
  async _sendQueries() {
    if (!this._socket) return

    try {
      // Query for FCast devices
      const fcastQuery = buildQuery(ServiceType.FCAST)
      await this._socket.send(fcastQuery, 0, fcastQuery.length, MDNS_PORT, MDNS_ADDRESS)

      // Query for Chromecast devices
      const castQuery = buildQuery(ServiceType.CHROMECAST)
      await this._socket.send(castQuery, 0, castQuery.length, MDNS_PORT, MDNS_ADDRESS)

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

      // Look for FCast or Chromecast PTR records
      const allRecords = [...response.answers, ...response.additionals]

      for (const record of allRecords) {
        if (record.type === DNS_TYPE.PTR) {
          const isFcast = record.name.includes('_fcast._tcp')
          const isChromecast = record.name.includes('_googlecast._tcp')

          if (isFcast || isChromecast) {
            // Find corresponding SRV and A records
            const instanceName = record.ptr
            const srvRecord = allRecords.find(r => r.type === DNS_TYPE.SRV && r.name === instanceName)
            const aRecord = allRecords.find(r => r.type === DNS_TYPE.A)
            const txtRecord = allRecords.find(r => r.type === DNS_TYPE.TXT && r.name === instanceName)

            if (srvRecord && aRecord) {
              const host = aRecord.address
              const port = srvRecord.port
              const protocol = isFcast ? 'fcast' : 'chromecast'
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
   * @param {number} [options.port] - Port number (default: 46899 for fcast, 8009 for chromecast)
   * @param {string} [options.protocol='fcast'] - Protocol type
   * @returns {Object} The device info
   */
  addManualDevice(options) {
    const protocol = options.protocol || 'fcast'
    const port = options.port || (protocol === 'chromecast' ? 8009 : 46899)
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
