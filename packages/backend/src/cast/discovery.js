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
  compareIpv4,
  normalizeDnsName,
  parseResponse
} from './mdns.js'

export { MDNS_ADDRESS, MDNS_PORT }

// Service types
export const ServiceType = {
  CHROMECAST: '_googlecast._tcp.local.'
}

const NORMALIZED_CHROMECAST_SERVICE = normalizeDnsName(ServiceType.CHROMECAST)
const DEVICE_FIELDS = ['id', 'name', 'host', 'port', 'protocol', 'manual']

export function createDiscoveryRecordCache() {
  return {
    ptrInstances: new Set(),
    srvByInstance: new Map(),
    txtByInstance: new Map(),
    addressesByTarget: new Map()
  }
}

export function applyDiscoveryRecord(cache, record) {
  if (!cache || !record || !(record.ttl > 0)) return

  if (record.type === DNS_TYPE.PTR) {
    if (typeof record.name !== 'string' || typeof record.ptr !== 'string') return
    if (normalizeDnsName(record.name) !== NORMALIZED_CHROMECAST_SERVICE) return
    cache.ptrInstances.add(normalizeDnsName(record.ptr))
    return
  }

  if (record.type === DNS_TYPE.SRV) {
    if (
      typeof record.name !== 'string' ||
      typeof record.target !== 'string' ||
      !Number.isInteger(record.port)
    ) return
    cache.srvByInstance.set(normalizeDnsName(record.name), {
      target: normalizeDnsName(record.target),
      port: record.port
    })
    return
  }

  if (record.type === DNS_TYPE.TXT) {
    if (
      typeof record.name !== 'string' ||
      !record.txt ||
      typeof record.txt !== 'object'
    ) return
    cache.txtByInstance.set(normalizeDnsName(record.name), { ...record.txt })
    return
  }

  if (record.type === DNS_TYPE.A) {
    if (typeof record.name !== 'string' || typeof record.address !== 'string') return
    const target = normalizeDnsName(record.name)
    let addresses = cache.addressesByTarget.get(target)
    if (!addresses) {
      addresses = new Set()
      cache.addressesByTarget.set(target, addresses)
    }
    addresses.add(record.address)
  }
}

export function buildDiscoveredDevices(cache) {
  const devices = new Map()
  const instances = Array.from(cache.ptrInstances).sort()

  for (const instance of instances) {
    const srv = cache.srvByInstance.get(instance)
    if (!srv) continue

    const addresses = cache.addressesByTarget.get(srv.target)
    if (!addresses || addresses.size === 0) continue

    const host = Array.from(addresses).sort(compareIpv4)[0]
    const id = `${host}:${srv.port}`
    if (devices.has(id)) continue

    const txt = cache.txtByInstance.get(instance)
    const instanceLabel = instance.split('.')[0].replace(/\\032/g, ' ')
    const name = txt?.fn || txt?.md || instanceLabel
    devices.set(id, {
      id,
      name,
      host,
      port: srv.port,
      protocol: 'chromecast'
    })
  }

  return Array.from(devices.values())
}

function devicesEqual(left, right) {
  return DEVICE_FIELDS.every(field => left?.[field] === right?.[field])
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
    this._logger = dependencies.logger || console
    this._state = 'idle'
    this._desiredRunning = false
    this._generation = 0
    this._startPromise = null
    this._settleStart = null
    this._stopPromise = null
    this._queuedStartPromise = null
    this._resolveQueuedStart = null
    this._devices = new Map()
    this._manualDevices = new Map()
    this._recordCache = createDiscoveryRecordCache()
    this._discoveredDevices = new Map()
    this._socket = null
    this._membershipSocket = null
    this._queryInterval = null
    this._queryIntervalSocket = null
  }

  /**
   * Start device discovery
   */
  start() {
    this._desiredRunning = true
    if (this._state === 'starting') return this._startPromise
    if (this._state === 'running') return Promise.resolve()
    if (this._state === 'stopping') return this._queueStartAfterCleanup()

    return this._beginStart()
  }

  _beginStart() {
    this._state = 'starting'
    const generation = ++this._generation
    const startPromise = this._startMdns(generation)
    this._startPromise = startPromise
    startPromise.then(() => {
      if (this._startPromise === startPromise) this._startPromise = null
    })

    // Emit any manual devices
    for (const device of this._manualDevices.values()) {
      this.emit('deviceFound', device)
    }

    return startPromise
  }

  _queueStartAfterCleanup() {
    if (this._queuedStartPromise) return this._queuedStartPromise
    this._queuedStartPromise = new Promise((resolve) => {
      this._resolveQueuedStart = resolve
    })
    return this._queuedStartPromise
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

    const fail = (socket, error) => {
      if (settled) return
      this._desiredRunning = false
      ++this._generation
      this._state = 'stopping'
      const cleanup = this._beginOwnedCleanup(socket)
      this._logError('[Discovery] mDNS startup failed', error)
      settle(cleanup)
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

          socket.on('error', (error) => {
            if (generation !== this._generation || this._socket !== socket) return
            if (this._state === 'starting') {
              fail(socket, error)
              return
            }
            if (this._state !== 'running') return

            this._desiredRunning = false
            ++this._generation
            this._state = 'stopping'
            this._beginOwnedCleanup(socket)
            this._logError('[Discovery] running mDNS socket failed', error)
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
            } catch (error) {
              fail(socket, error)
            }
          })

          socket.bind(MDNS_PORT, '0.0.0.0')
        } catch (error) {
          fail(socket, error)
        }
      })
      .catch((error) => fail(null, error))

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

      const before = new Map(this._devices)
      for (const record of response.records) {
        applyDiscoveryRecord(this._recordCache, record)
      }
      this._discoveredDevices = new Map(
        buildDiscoveredDevices(this._recordCache).map(device => [device.id, device])
      )
      this._reconcileDevices(before)
    } catch (err) {
      // Ignore parse errors
    }
  }

  _reconcileDevices(before) {
    const after = new Map(this._discoveredDevices)
    for (const [id, device] of this._manualDevices) after.set(id, device)
    this._devices = after

    if (!this.isRunning()) return

    for (const id of before.keys()) {
      if (!after.has(id)) this.emit('deviceLost', id)
    }

    for (const [id, device] of after) {
      const previous = before.get(id)
      if (!previous) {
        this.emit('deviceFound', device)
      } else if (!devicesEqual(previous, device)) {
        this.emit('deviceChanged', device)
      }
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

  _beginOwnedCleanup(socket) {
    if (this._stopPromise) return this._stopPromise

    const cleanup = Promise.resolve()
      .then(() => this._cleanupSocket(socket))
      .catch(() => {})
      .then(() => {
        if (this._stopPromise !== cleanup) return

        this._stopPromise = null
        this._state = 'idle'
        const resolveQueuedStart = this._resolveQueuedStart
        const hadQueuedStart = this._queuedStartPromise !== null
        this._resolveQueuedStart = null
        this._queuedStartPromise = null

        if (!hadQueuedStart) return
        if (!this._desiredRunning) {
          resolveQueuedStart()
          return
        }

        const restarted = this._beginStart()
        restarted.then(resolveQueuedStart)
      })

    this._stopPromise = cleanup
    return cleanup
  }

  _logError(message, error) {
    try {
      this._logger?.error?.(message, error)
    } catch {}
  }

  /**
   * Stop device discovery
   */
  stop() {
    this._desiredRunning = false
    if (this._state === 'idle') {
      if (this._resolveQueuedStart) this._resolveQueuedStart()
      this._resolveQueuedStart = null
      this._queuedStartPromise = null
      return Promise.resolve()
    }
    if (this._state === 'stopping') return this._stopPromise || Promise.resolve()

    const settleStart = this._settleStart
    const socket = this._socket
    ++this._generation
    this._state = 'stopping'
    const cleanup = this._beginOwnedCleanup(socket)
    if (settleStart) settleStart(cleanup)
    return cleanup
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
