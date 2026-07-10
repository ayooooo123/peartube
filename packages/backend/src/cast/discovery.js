/**
 * Device Discovery via mDNS
 *
 * Discovers cast devices on the local network using mDNS.
 *
 * Service types:
 * - _googlecast._tcp.local. - Chromecast devices
 * - _fcast._tcp.local.      - FCast receivers (https://fcast.org)
 */

import { EventEmitter } from 'bare-events'

// mDNS multicast address and port
export const MDNS_ADDRESS = '224.0.0.251'
export const MDNS_PORT = 5353
// RFC 6762 §11: mDNS packets SHOULD be sent with IP TTL 255. Some responders
// drop queries with a lower TTL, and the kernel default for multicast is 1.
export const MDNS_TTL = 255

// Service types
export const ServiceType = {
  CHROMECAST: '_googlecast._tcp.local.',
  FCAST: '_fcast._tcp.local.'
}

// Default connect port per protocol (Chromecast: TLS 8009, FCast: TCP 46899)
const DEFAULT_PROTOCOL_PORTS = {
  chromecast: 8009,
  fcast: 46899
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
 * Encode a DNS name into wire format
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
  let jumps = 0
  let originalOffset = offset

  while (offset < buffer.length) {
    const len = buffer[offset]

    if (len === 0) {
      offset++
      break
    }

    // Check for compression pointer (starts with 11xxxxxx)
    if ((len & 0xc0) === 0xc0) {
      // Guard against malformed packets whose pointers form a loop.
      if (++jumps > 32) break
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
    this._txSockets = new Map() // iface IPv4 -> query socket bound to it
    this._queryInterval = null
    this._localIp = undefined
    this._localIps = undefined
  }

  /**
   * Best-effort enumerate ALL of this host's usable LAN IPv4 addresses.
   *
   * Multicast must be joined — and queries must egress — on the correct
   * interface, but on a multi-homed host we cannot reliably guess which one
   * that is: phones have wlan0 + rmnet/cellular + VPN at once, desktops have
   * ethernet + Wi-Fi + docker/VM bridges. Guessing a single interface (the
   * previous behaviour) silently picked a bridge or the wrong NIC and
   * discovery went dark. So we operate on every candidate interface instead.
   *
   * Wi-Fi-looking interfaces (wlan0/en0) are ordered first so the preferred
   * address (used for logging / single-address callers) stays stable.
   */
  async _resolveLocalIPv4s() {
    if (this._localIps !== undefined) return this._localIps
    this._localIps = []
    try {
      const mod = await import('udx-native')
      const UDX = (mod && mod.default) ? mod.default : mod
      const udx = new UDX()
      const preferred = []
      const rest = []
      for (const iface of udx.networkInterfaces()) {
        if (iface.family !== 4 || iface.internal) continue
        const host = iface.host
        if (!host || host.startsWith('127.') || host.startsWith('169.254.')) continue
        // Prefer the well-known Wi-Fi interface names where we can tell.
        if (iface.name === 'wlan0' || iface.name === 'en0') preferred.push(host)
        else rest.push(host)
      }
      this._localIps = [...new Set([...preferred, ...rest])]
    } catch {
      this._localIps = []
    }
    return this._localIps
  }

  /**
   * Best-effort resolve this host's preferred LAN IPv4 address (first usable
   * interface, Wi-Fi first). Returns null when it cannot be determined.
   */
  async _resolveLocalIPv4() {
    if (this._localIp !== undefined) return this._localIp
    const ips = await this._resolveLocalIPv4s()
    this._localIp = ips.length > 0 ? ips[0] : null
    return this._localIp
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

    const localIps = await this._resolveLocalIPv4s()
    const localIp = await this._resolveLocalIPv4()
    if (localIp) {
      console.log('[Discovery] LAN IPv4 interfaces:', localIps.join(', '))
    } else {
      console.warn('[Discovery] Could not determine any LAN IPv4; using the default interface only')
    }

    // mDNS responders send their answers — and the periodic *unsolicited*
    // announcements Cast devices emit — to the multicast group 224.0.0.251 on
    // UDP port 5353. To receive them the socket MUST bind 0.0.0.0:5353:
    //
    //  - Binding a *specific unicast* interface address (the previous "bind to
    //    Wi-Fi" attempt) makes the kernel drop inbound multicast, because the
    //    datagram's destination is the group address, not our unicast address.
    //    The interface is selected by the multicast membership join instead.
    //  - Binding an *ephemeral* port only ever caught a legacy one-shot unicast
    //    reply (RFC 6762 §6.7), never the multicast announcements — so the
    //    picker stayed empty whenever a device didn't unicast back.
    //
    // Fall back to an ephemeral port if 5353 can't be bound (some other mDNS
    // stack may already hold it without SO_REUSEPORT); legacy unicast replies
    // still work there.
    const bindTargets = [
      { port: MDNS_PORT, host: '0.0.0.0' },
      { port: 0, host: '0.0.0.0' },
    ]

    let lastErr = null
    for (const target of bindTargets) {
      try {
        await this._bindMdnsSocket(dgram, target, localIps)
        return
      } catch (err) {
        lastErr = err
        console.warn('[Discovery] mDNS bind ' + target.host + ':' + target.port + ' failed:', err?.message)
        // Tear the failed socket down before retrying on the next target.
        if (this._socket) {
          try { this._socket.close() } catch { /* best-effort teardown */ }
          this._socket = null
        }
        if (this._queryInterval) {
          clearInterval(this._queryInterval)
          this._queryInterval = null
        }
      }
    }

    throw (lastErr || new Error('Failed to bind mDNS socket'))
  }

  /**
   * Create and bind a fresh mDNS socket to the given target, joining the
   * multicast group on every resolved LAN interface once it is listening.
   * Resolves when listening, rejects on bind/socket error.
   */
  _bindMdnsSocket(dgram, target, localIps) {
    return new Promise((resolve, reject) => {
      let settled = false
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
          if (!settled) {
            settled = true
            reject(err)
          } else {
            this._stopMdns()
          }
        })

        this._socket.on('message', (msg, rinfo) => {
          this._handleMessage(msg, rinfo)
        })

        this._socket.on('listening', () => {
          const addr = this._socket.address()
          console.log('[Discovery] mDNS socket listening on', addr?.address || '?', 'port', addr?.port || 'unknown')

          // Join the group on every LAN interface so multicast is delivered
          // no matter which NIC the Chromecast is reachable on (phones with
          // Wi-Fi + cellular, desktops with ethernet + Wi-Fi + bridges).
          this._joinMulticast(localIps)

          // Per-interface query sockets: steer query egress out each NIC and
          // catch unicast (QU) replies even where multicast RX is filtered.
          this._startTxSockets(dgram, localIps)

          // Send initial queries
          this._sendQueries()

          // Send periodic queries every 5 seconds
          this._queryInterval = setInterval(() => {
            if (this._running) {
              this._sendQueries()
            }
          }, 5000)

          if (!settled) {
            settled = true
            resolve()
          }
        })

        console.log('[Discovery] Binding to ' + target.host + ':' + target.port + '...')
        this._socket.bind(target.port, target.host)
      } catch (err) {
        if (!settled) {
          settled = true
          reject(err)
        }
      }
    })
  }

  /**
   * Join the mDNS multicast group on every given interface.
   *
   * udx-native's underlying socket exposes addMembership(address[, iface]).
   * Passing the interface address makes the kernel deliver multicast
   * responses arriving on that NIC — without it, a multi-homed device can
   * join on the wrong interface and never see Chromecast announcements.
   * Joining on all interfaces means we no longer have to guess which NIC
   * shares a subnet with the Chromecast.
   */
  _joinMulticast(localIps) {
    try {
      const innerSocket = this._socket?._socket
      if (!innerSocket || typeof innerSocket.addMembership !== 'function') {
        console.warn('[Discovery] Multicast not supported, relying on unicast responses')
        return
      }

      let joined = 0
      for (const localIp of (localIps || [])) {
        try {
          innerSocket.addMembership(MDNS_ADDRESS, localIp)
          joined++
          console.log('[Discovery] Joined multicast group', MDNS_ADDRESS, 'on', localIp)
        } catch (ifaceErr) {
          console.warn('[Discovery] Multicast join failed on', localIp + ':', ifaceErr.message)
        }
      }

      if (joined === 0) {
        innerSocket.addMembership(MDNS_ADDRESS)
        console.log('[Discovery] Joined multicast group', MDNS_ADDRESS, 'on the default interface')
      }
    } catch (e) {
      // Multicast join is optional - we can still send queries and receive
      // unicast (QU) responses.
      console.warn('[Discovery] Could not join multicast group:', e.message)
    }
  }

  /**
   * Bind one query socket per LAN interface.
   *
   * Two reasons these exist alongside the main 0.0.0.0:5353 socket:
   *
   *  1. TX egress: udx-native has no IP_MULTICAST_IF, so multicast sent from
   *     the wildcard socket follows the default route — on a phone that can
   *     be cellular/VPN and the query never reaches the Chromecast. Sending
   *     from a socket bound to an interface's own address makes the kernel
   *     route the multicast query out THAT interface (Linux/Android resolve
   *     the output device from the source address for multicast).
   *  2. Unicast replies: our queries set the QU bit, so responders may reply
   *     unicast to the query's source address:port. That lands on these
   *     sockets directly, which keeps discovery alive on networks (common
   *     mesh/enterprise APs) that filter downstream multicast entirely.
   */
  _startTxSockets(dgram, localIps) {
    for (const ip of (localIps || [])) {
      if (this._txSockets.has(ip)) continue
      try {
        let sock
        try {
          sock = dgram.createSocket({ type: 'udp4', reuseAddress: true })
        } catch {
          sock = dgram.createSocket('udp4')
        }
        sock.on('error', (err) => {
          console.warn('[Discovery] Query socket error on', ip + ':', err?.message)
          if (this._txSockets.get(ip) === sock) this._txSockets.delete(ip)
          try { sock.close() } catch { /* best-effort teardown */ }
        })
        sock.on('message', (msg, rinfo) => {
          this._handleMessage(msg, rinfo)
        })
        sock.bind(0, ip)
        this._txSockets.set(ip, sock)
        console.log('[Discovery] Query socket bound on', ip)
      } catch (err) {
        console.warn('[Discovery] Could not bind query socket on', ip + ':', err?.message)
      }
    }
  }

  /**
   * Send one query buffer from one socket, with the mDNS-standard IP TTL
   * where the inner udx socket allows it (the bare-dgram wrapper cannot set
   * a TTL, and the kernel default multicast TTL of 1 is dropped by some
   * responders that expect 255 per RFC 6762 §11).
   */
  async _sendQuery(socket, query) {
    const inner = socket?._socket
    if (inner && typeof inner.send === 'function') {
      await inner.send(query, MDNS_PORT, MDNS_ADDRESS, MDNS_TTL)
      return
    }
    await socket.send(query, 0, query.length, MDNS_PORT, MDNS_ADDRESS)
  }

  /**
   * Send mDNS queries for Chromecast from the main socket and from every
   * per-interface query socket.
   */
  async _sendQueries() {
    if (!this._socket) return

    // One QU (unicast-reply) and one QM (multicast-reply) query per service
    // type — receivers vary in which they answer.
    const queries = []
    for (const serviceName of Object.values(ServiceType)) {
      queries.push(buildQuery(serviceName, true))
      queries.push(buildQuery(serviceName, false))
    }

    let sent = 0

    for (const query of queries) {
      try {
        await this._sendQuery(this._socket, query)
        sent++
      } catch (err) {
        console.warn('[Discovery] Error sending query on main socket:', err?.message)
      }
    }

    for (const [ip, sock] of [...this._txSockets]) {
      for (const query of queries) {
        try {
          await this._sendQuery(sock, query)
          sent++
        } catch (err) {
          // An interface that cannot route multicast (cellular, downed VPN)
          // fails on every tick — drop its socket instead of spamming warnings.
          console.warn('[Discovery] Dropping query socket on', ip + ':', err?.message)
          this._txSockets.delete(ip)
          try { sock.close() } catch { /* best-effort teardown */ }
          break
        }
      }
    }

    if (sent > 0) {
      console.log('[Discovery] Sent', sent, 'mDNS queries to', MDNS_ADDRESS + ':' + MDNS_PORT)
    } else {
      console.warn('[Discovery] No mDNS queries could be sent')
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
      const allRecords = [...response.answers, ...response.additionals]

      for (const record of allRecords) {
        if (record.type === DNS_TYPE.PTR) {
          const serviceProtocol = record.name.includes('_googlecast._tcp')
            ? 'chromecast'
            : (record.name.includes('_fcast._tcp') ? 'fcast' : null)

          if (serviceProtocol) {
            // Find corresponding SRV and A records
            const instanceName = record.ptr
            const srvRecord = allRecords.find(r => r.type === DNS_TYPE.SRV && r.name === instanceName)
            // Prefer the A record whose name matches the SRV target so we pair
            // the right IP with the right device when several answer at once;
            // fall back to any A record (single-device case).
            const aRecord = (srvRecord?.target
              && allRecords.find(r => r.type === DNS_TYPE.A && r.name === srvRecord.target))
              || allRecords.find(r => r.type === DNS_TYPE.A)
            const txtRecord = allRecords.find(r => r.type === DNS_TYPE.TXT && r.name === instanceName)

            if (srvRecord && aRecord) {
              const host = aRecord.address
              const port = srvRecord.port
              const protocol = serviceProtocol
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
          for (const localIp of (this._localIps || [])) {
            try { innerSocket.dropMembership(MDNS_ADDRESS, localIp) } catch { /* not joined on this iface */ }
          }
          try { innerSocket.dropMembership(MDNS_ADDRESS) } catch { /* not joined on the default iface */ }
        }
      } catch (e) { /* best-effort: group may not have been joined */ }

      try {
        this._socket.close()
      } catch (e) { /* best-effort: socket may already be closed */ }

      this._socket = null
    }

    for (const sock of this._txSockets.values()) {
      try { sock.close() } catch { /* best-effort: socket may already be closed */ }
    }
    this._txSockets.clear()

    // Re-resolve the interfaces on the next start in case the network changed.
    this._localIp = undefined
    this._localIps = undefined
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
   * @param {number} [options.port] - Port number (default: 8009 for chromecast, 46899 for fcast)
   * @param {string} [options.protocol='chromecast'] - Protocol type ('chromecast' | 'fcast')
   * @returns {Object} The device info
   */
  addManualDevice(options) {
    const protocol = options.protocol || 'chromecast'
    const port = options.port || DEFAULT_PROTOCOL_PORTS[protocol] || 8009
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
