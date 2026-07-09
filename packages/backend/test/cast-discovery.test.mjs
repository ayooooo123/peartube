import test from 'brittle'
import { EventEmitter } from 'bare-events'
import * as discoveryModule from '../src/cast/discovery.js'
import {
  DeviceDiscoverer,
  MDNS_ADDRESS,
  MDNS_PORT,
  ServiceType
} from '../src/cast/discovery.js'
import { DNS_TYPE, parseResponse } from '../src/cast/mdns.js'

const INSTANCE = 'Kitchen TV._googlecast._tcp.local.'
const TARGET = 'kitchen-chromecast.local.'

class FakeSocket extends EventEmitter {
  constructor(options = {}) {
    super()
    this.options = options
    this.bindCalls = []
    this.sendCalls = []
    this.closeCalls = 0
    this.addMembershipCalls = []
    this.dropMembershipCalls = []
    this.on('error', () => {})

    if (options.hasMembership !== false) {
      this._socket = {
        addMembership: (address) => {
          this.addMembershipCalls.push(address)
          if (options.membershipEmitsError) this.fail(options.membershipEmitsError)
          if (options.membershipError) throw options.membershipError
        },
        dropMembership: (address) => {
          this.dropMembershipCalls.push(address)
          if (options.dropMembershipError) throw options.dropMembershipError
        }
      }
    }
  }

  bind(...args) {
    this.bindCalls.push(args)
    if (this.options.bindError) throw this.options.bindError
  }

  send(...args) {
    this.sendCalls.push(args)
    if (this.options.sendEmitsError) this.fail(this.options.sendEmitsError)
    if (this.options.sendError) return Promise.reject(this.options.sendError)
    return Promise.resolve()
  }

  close() {
    this.closeCalls++
    if (this.options.closeError) throw this.options.closeError
    return this.options.closePromise
  }

  listen() {
    this.emit('listening')
  }

  fail(error = new Error('socket failed')) {
    this.emit('error', error)
  }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createLogger() {
  const errors = []
  return {
    errors,
    error(...args) {
      errors.push(args)
    }
  }
}

function createLifecycleFixture(attempts = [{ socket: new FakeSocket() }], dependencies = {}) {
  const createOptions = []
  const intervals = []
  const clearIntervalCalls = []
  let attemptIndex = 0

  const discoverer = new DeviceDiscoverer({
    loadDgram: async () => {
      const attempt = attempts[attemptIndex++]
      if (!attempt) throw new Error('unexpected discovery attempt')
      if (attempt.loadError) throw attempt.loadError

      return {
        createSocket(options) {
          createOptions.push(options)
          if (attempt.createError) throw attempt.createError
          return attempt.socket
        }
      }
    },
    setInterval(callback, delay) {
      const interval = { callback, delay }
      intervals.push(interval)
      return interval
    },
    clearInterval(interval) {
      clearIntervalCalls.push(interval)
    },
    logger: dependencies.logger || { error() {} }
  })

  return {
    discoverer,
    createOptions,
    intervals,
    clearIntervalCalls,
    get loadCalls() { return attemptIndex }
  }
}

test('start binds the shared mDNS socket before joining, querying, and scheduling', async (t) => {
  const socket = new FakeSocket()
  const fixture = createLifecycleFixture([{ socket }])

  const started = fixture.discoverer.start()
  await flushMicrotasks()

  t.alike(fixture.createOptions, [{ type: 'udp4', reuseAddress: true }])
  t.alike(socket.bindCalls, [[MDNS_PORT, '0.0.0.0']])
  t.alike(socket.addMembershipCalls, [])
  t.is(socket.sendCalls.length, 0)
  t.is(fixture.intervals.length, 0)

  socket.listen()
  await started

  t.alike(socket.addMembershipCalls, [MDNS_ADDRESS])
  t.is(socket.sendCalls.length, 1)
  const [query = Buffer.alloc(12), offset, length, port, address] = socket.sendCalls[0] || []
  t.is(query.readUInt16BE(4), 1)
  t.is(query.readUInt16BE(query.length - 4), 12)
  t.is(query.readUInt16BE(query.length - 2), 1)
  t.is(offset, 0)
  t.is(length, query.length)
  t.is(port, MDNS_PORT)
  t.is(address, MDNS_ADDRESS)
  t.is(fixture.intervals.length, 1)
  t.is(fixture.intervals[0]?.delay, 5000)
})

test('concurrent start calls share a promise and a running start reuses the socket', async (t) => {
  const socket = new FakeSocket()
  const fixture = createLifecycleFixture([{ socket }])

  const first = fixture.discoverer.start()
  const concurrent = fixture.discoverer.start()

  t.is(concurrent, first)
  await flushMicrotasks()
  t.is(fixture.loadCalls, 1)
  socket.listen()
  await first

  t.is(fixture.discoverer._startPromise, null)
  await fixture.discoverer.start()
  t.is(fixture.loadCalls, 1)
  t.is(socket.bindCalls.length, 1)
})

test('reentrant start from a manual device listener shares the published promise', async (t) => {
  const socket = new FakeSocket()
  const fixture = createLifecycleFixture([{ socket }])
  fixture.discoverer.addManualDevice({ name: 'Manual TV', host: '192.168.1.80' })
  let reentrantStart
  fixture.discoverer.on('deviceFound', () => {
    reentrantStart = fixture.discoverer.start()
  })

  const firstStart = fixture.discoverer.start()

  t.is(reentrantStart, firstStart)
  await flushMicrotasks()
  socket.listen()
  await firstStart
  t.is(fixture.loadCalls, 1)
})

test('stop cancels a pending start and ignores callbacks from its old socket', async (t) => {
  const socketA = new FakeSocket()
  const socketB = new FakeSocket()
  const fixture = createLifecycleFixture([{ socket: socketA }, { socket: socketB }])

  const firstStart = fixture.discoverer.start()
  await flushMicrotasks()
  const stopped = fixture.discoverer.stop()

  await Promise.all([firstStart, stopped])
  t.is(socketA.closeCalls, 1)
  t.not(fixture.discoverer.isRunning())

  socketA.listen()
  socketA.fail(new Error('late socket A error'))
  await flushMicrotasks()
  t.is(fixture.intervals.length, 0)

  const secondStart = fixture.discoverer.start()
  await flushMicrotasks()
  socketB.listen()
  await secondStart

  t.ok(fixture.discoverer.isRunning())
  t.is(socketB.closeCalls, 0)
})

test('start during deferred stop waits for cleanup and then starts a new socket', async (t) => {
  const close = createDeferred()
  const socketA = new FakeSocket({ closePromise: close.promise })
  const socketB = new FakeSocket()
  const fixture = createLifecycleFixture([{ socket: socketA }, { socket: socketB }])

  const firstStart = fixture.discoverer.start()
  await flushMicrotasks()
  socketA.listen()
  await firstStart

  const stopped = fixture.discoverer.stop()
  const restarted = fixture.discoverer.start()
  let restartSettled = false
  restarted.then(() => { restartSettled = true })
  await flushMicrotasks()

  t.is(fixture.loadCalls, 1)
  t.is(socketB.bindCalls.length, 0)
  t.not(restartSettled)

  close.resolve()
  await stopped
  await flushMicrotasks()

  t.is(fixture.loadCalls, 2)
  t.alike(socketB.bindCalls, [[MDNS_PORT, '0.0.0.0']])
  t.not(restartSettled)

  socketB.listen()
  await restarted
  t.ok(restartSettled)
  t.ok(fixture.discoverer.isRunning())
})

test('stop cancels a restart queued during deferred cleanup', async (t) => {
  const close = createDeferred()
  const socketA = new FakeSocket({ closePromise: close.promise })
  const socketB = new FakeSocket()
  const fixture = createLifecycleFixture([{ socket: socketA }, { socket: socketB }])

  const firstStart = fixture.discoverer.start()
  await flushMicrotasks()
  socketA.listen()
  await firstStart

  const firstStop = fixture.discoverer.stop()
  const queuedStart = fixture.discoverer.start()
  const cancellingStop = fixture.discoverer.stop()
  t.is(cancellingStop, firstStop)
  close.resolve()
  await Promise.all([firstStop, queuedStart, cancellingStop])
  await flushMicrotasks()

  t.is(fixture.loadCalls, 1)
  t.is(socketB.bindCalls.length, 0)
  t.not(fixture.discoverer.isRunning())
})

function startupFailureTest(name, firstAttempt) {
  test(`${name} failure returns to manual mode and permits retry`, async (t) => {
    const retrySocket = new FakeSocket()
    const fixture = createLifecycleFixture([firstAttempt, { socket: retrySocket }])
    const manual = fixture.discoverer.addManualDevice({
      name: 'Manual TV',
      host: '192.168.1.80'
    })

    const failedStart = fixture.discoverer.start()
    await flushMicrotasks()
    if (firstAttempt.socket && !firstAttempt.socket.options.bindError) {
      firstAttempt.socket.listen()
    }
    await failedStart

    t.not(fixture.discoverer.isRunning())
    t.alike(fixture.discoverer.getDevices(), [manual])
    if (firstAttempt.socket) t.is(firstAttempt.socket.closeCalls, 1)

    const retried = fixture.discoverer.start()
    await flushMicrotasks()
    retrySocket.listen()
    await retried

    t.ok(fixture.discoverer.isRunning())
    t.is(fixture.loadCalls, 2)
  })
}

startupFailureTest('dgram load', { loadError: new Error('load failed') })
startupFailureTest('socket creation', { createError: new Error('create failed') })
startupFailureTest('socket bind', {
  socket: new FakeSocket({ bindError: new Error('bind failed') })
})
startupFailureTest('multicast membership', {
  socket: new FakeSocket({ membershipError: new Error('membership failed') })
})

test('startup failure cleanup serializes stop and queued retry', async (t) => {
  const close = createDeferred()
  const socketA = new FakeSocket({
    membershipError: new Error('membership failed'),
    closePromise: close.promise
  })
  const socketB = new FakeSocket()
  const fixture = createLifecycleFixture([{ socket: socketA }, { socket: socketB }])

  const failedStart = fixture.discoverer.start()
  await flushMicrotasks()
  socketA.listen()
  const stopped = fixture.discoverer.stop()
  t.is(fixture.discoverer.stop(), stopped)
  await flushMicrotasks()
  const retried = fixture.discoverer.start()
  await flushMicrotasks()

  t.is(fixture.loadCalls, 1)
  t.is(socketB.bindCalls.length, 0)

  close.resolve()
  await Promise.all([failedStart, stopped])
  await flushMicrotasks()

  t.is(fixture.loadCalls, 2)
  t.alike(socketB.bindCalls, [[MDNS_PORT, '0.0.0.0']])
  t.ok(fixture.discoverer._startPromise)
  socketB.listen()
  await retried
  t.ok(fixture.discoverer.isRunning())
  t.is(fixture.discoverer._startPromise, null)
})

function synchronousStartupErrorTest(name, socketOptions) {
  test(`synchronous ${name} socket errors clean startup and permit retry`, async (t) => {
    const socketA = new FakeSocket(socketOptions)
    const socketB = new FakeSocket()
    const fixture = createLifecycleFixture([{ socket: socketA }, { socket: socketB }])

    const firstStart = fixture.discoverer.start()
    await flushMicrotasks()
    socketA.listen()
    await firstStart

    t.not(fixture.discoverer.isRunning())
    t.is(socketA.closeCalls, 1)
    t.alike(socketA.dropMembershipCalls, [MDNS_ADDRESS])
    t.is(fixture.intervals.length, 0)

    const retried = fixture.discoverer.start()
    await flushMicrotasks()
    socketB.listen()
    await retried

    t.ok(fixture.discoverer.isRunning())
    t.is(fixture.loadCalls, 2)
  })
}

synchronousStartupErrorTest('membership', {
  membershipEmitsError: new Error('membership emitted an error')
})
synchronousStartupErrorTest('send', {
  sendEmitsError: new Error('send emitted an error')
})

test('running socket errors clean up and permit a successful retry', async (t) => {
  const socketA = new FakeSocket()
  const socketB = new FakeSocket()
  const fixture = createLifecycleFixture([{ socket: socketA }, { socket: socketB }])

  const firstStart = fixture.discoverer.start()
  await flushMicrotasks()
  socketA.listen()
  await firstStart
  socketA.fail()
  await flushMicrotasks()

  t.not(fixture.discoverer.isRunning())
  t.alike(socketA.dropMembershipCalls, [MDNS_ADDRESS])
  t.alike(fixture.clearIntervalCalls, [fixture.intervals[0]])
  t.is(socketA.closeCalls, 1)

  const retried = fixture.discoverer.start()
  await flushMicrotasks()
  socketB.listen()
  await retried

  t.ok(fixture.discoverer.isRunning())
})

test('startup and running socket failures preserve concrete diagnostics', async (t) => {
  const startupError = new Error('bind diagnostics')
  const runningError = new Error('running diagnostics')
  const startupLogger = createLogger()
  const runningLogger = createLogger()
  const startupFixture = createLifecycleFixture([{
    socket: new FakeSocket({ bindError: startupError })
  }], { logger: startupLogger })
  const runningSocket = new FakeSocket()
  const runningFixture = createLifecycleFixture([{
    socket: runningSocket
  }], { logger: runningLogger })

  await startupFixture.discoverer.start()
  const runningStart = runningFixture.discoverer.start()
  await flushMicrotasks()
  runningSocket.listen()
  await runningStart
  runningSocket.fail(runningError)
  await flushMicrotasks()

  t.is(startupLogger.errors.length, 1)
  t.ok(String(startupLogger.errors[0]?.[0]).includes('startup'))
  t.is(startupLogger.errors[0]?.[1], startupError)
  t.is(runningLogger.errors.length, 1)
  t.ok(String(runningLogger.errors[0]?.[0]).includes('running'))
  t.is(runningLogger.errors[0]?.[1], runningError)
})

test('explicit stop and stale socket errors do not log failures', async (t) => {
  const logger = createLogger()
  const socket = new FakeSocket()
  const fixture = createLifecycleFixture([{ socket }], { logger })
  const started = fixture.discoverer.start()
  await flushMicrotasks()
  socket.listen()
  await started

  await fixture.discoverer.stop()
  socket.fail(new Error('stale after explicit stop'))
  await flushMicrotasks()

  t.alike(logger.errors, [])
})

test('rejected async close cannot wedge cleanup or retry', async (t) => {
  const close = createDeferred()
  const socketA = new FakeSocket({ closePromise: close.promise })
  const socketB = new FakeSocket()
  const fixture = createLifecycleFixture([{ socket: socketA }, { socket: socketB }])
  const firstStart = fixture.discoverer.start()
  await flushMicrotasks()
  socketA.listen()
  await firstStart

  const stopped = fixture.discoverer.stop()
  close.reject(new Error('close rejected'))
  await stopped
  const restarted = fixture.discoverer.start()
  await flushMicrotasks()
  socketB.listen()
  await restarted

  t.ok(fixture.discoverer.isRunning())
  t.is(fixture.loadCalls, 2)
})

test('repeated stop drops membership and closes the socket only once', async (t) => {
  const socket = new FakeSocket()
  const fixture = createLifecycleFixture([{ socket }])
  const started = fixture.discoverer.start()
  await flushMicrotasks()
  socket.listen()
  await started

  await Promise.all([
    fixture.discoverer.stop(),
    fixture.discoverer.stop(),
    fixture.discoverer.stop()
  ])

  t.alike(socket.dropMembershipCalls, [MDNS_ADDRESS])
  t.is(socket.closeCalls, 1)
  t.is(fixture.clearIntervalCalls.length, 1)
  t.not(fixture.discoverer.isRunning())
})

test('late errors from an old generation cannot alter a new running socket', async (t) => {
  const socketA = new FakeSocket()
  const socketB = new FakeSocket()
  const fixture = createLifecycleFixture([{ socket: socketA }, { socket: socketB }])

  const firstStart = fixture.discoverer.start()
  await flushMicrotasks()
  socketA.listen()
  await firstStart
  await fixture.discoverer.stop()

  const secondStart = fixture.discoverer.start()
  await flushMicrotasks()
  socketB.listen()
  await secondStart
  socketA.fail(new Error('late error'))
  await flushMicrotasks()

  t.ok(fixture.discoverer.isRunning())
  t.is(socketB.closeCalls, 0)
  t.alike(socketB.dropMembershipCalls, [])
  t.is(fixture.clearIntervalCalls.length, 1)
})

function dnsName(name) {
  const parts = []
  for (const label of name.replace(/\.$/, '').split('.')) {
    const data = Buffer.from(label)
    parts.push(Buffer.from([data.length]), data)
  }
  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

function record(name, type, rdata, { ttl = 120 } = {}) {
  const header = Buffer.alloc(10)
  header.writeUInt16BE(type, 0)
  header.writeUInt16BE(1, 2)
  header.writeUInt32BE(ttl, 4)
  header.writeUInt16BE(rdata.length, 8)
  return Buffer.concat([dnsName(name), header, rdata])
}

function responsePacket(records) {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(records.length, 6)
  return Buffer.concat([header, ...records])
}

function ptrRecord(service, instance, options) {
  return record(service, DNS_TYPE.PTR, dnsName(instance), options)
}

function srvRecord(instance, port, target, options) {
  const srv = Buffer.alloc(6)
  srv.writeUInt16BE(port, 4)
  return record(instance, DNS_TYPE.SRV, Buffer.concat([srv, dnsName(target)]), options)
}

function txtRecord(instance, values, options) {
  const entries = Object.entries(values).map(([key, value]) => {
    const txt = Buffer.from(`${key}=${value}`)
    return Buffer.concat([Buffer.from([txt.length]), txt])
  })
  return record(instance, DNS_TYPE.TXT, Buffer.concat(entries), options)
}

function aRecord(target, address, options) {
  return record(target, DNS_TYPE.A, Buffer.from(address.split('.').map(Number)), options)
}

function completeServicePacket({
  service = ServiceType.CHROMECAST,
  instance = INSTANCE,
  target = TARGET,
  address = '192.168.1.25',
  port = 8009,
  txt = { fn: 'Kitchen TV' }
} = {}) {
  return responsePacket([
    ptrRecord(service, instance),
    srvRecord(instance, port, target),
    txtRecord(instance, txt),
    aRecord(target, address)
  ])
}

function completeChromecastPacket() {
  return completeServicePacket()
}

function getDiscoveryHelpers(t) {
  const helpers = {
    createDiscoveryRecordCache: discoveryModule.createDiscoveryRecordCache,
    applyDiscoveryRecord: discoveryModule.applyDiscoveryRecord,
    buildDiscoveredDevices: discoveryModule.buildDiscoveredDevices
  }

  for (const helper of Object.values(helpers)) t.is(typeof helper, 'function')
  if (Object.values(helpers).some(helper => typeof helper !== 'function')) return null
  return helpers
}

async function startActiveDiscovery(t) {
  const socket = new FakeSocket()
  const fixture = createLifecycleFixture([{ socket }])
  const started = fixture.discoverer.start()
  await flushMicrotasks()
  socket.listen()
  await started
  t.ok(fixture.discoverer.isRunning())
  return { ...fixture, socket }
}

test('complete Chromecast packet still populates idle discoverer state', (t) => {
  const discoverer = new DeviceDiscoverer()

  discoverer._handleMessage(completeChromecastPacket())

  t.alike(discoverer.getDevices(), [{
    id: '192.168.1.25:8009',
    name: 'Kitchen TV',
    host: '192.168.1.25',
    port: 8009,
    protocol: 'chromecast'
  }])
})

test('record cache normalizes parsed Chromecast records and builds a device', (t) => {
  const helpers = getDiscoveryHelpers(t)
  if (!helpers) return

  const instance = 'Kitchen\\032TV._GoogleCast._TCP.Local.'
  const target = 'Kitchen-Chromecast.Local.'
  const parsed = parseResponse(responsePacket([
    ptrRecord('_GoogleCast._TCP.Local.', instance),
    srvRecord(instance, 8009, target),
    txtRecord(instance, { md: 'Living Room Cast' }),
    aRecord(target, '192.168.1.25')
  ]))
  const cache = helpers.createDiscoveryRecordCache()

  for (const parsedRecord of parsed.records) {
    helpers.applyDiscoveryRecord(cache, parsedRecord)
  }

  t.alike(helpers.buildDiscoveredDevices(cache), [{
    id: '192.168.1.25:8009',
    name: 'Living Room Cast',
    host: '192.168.1.25',
    port: 8009,
    protocol: 'chromecast'
  }])
})

test('record cache temporarily ignores ttl-zero records', (t) => {
  const helpers = getDiscoveryHelpers(t)
  if (!helpers) return

  const parsed = parseResponse(responsePacket([
    ptrRecord(ServiceType.CHROMECAST, INSTANCE),
    srvRecord(INSTANCE, 8009, TARGET),
    aRecord(TARGET, '192.168.1.20'),
    aRecord(TARGET, '192.168.1.9', { ttl: 0 })
  ]))
  const cache = helpers.createDiscoveryRecordCache()
  for (const parsedRecord of parsed.records) {
    helpers.applyDiscoveryRecord(cache, parsedRecord)
  }

  t.is(helpers.buildDiscoveredDevices(cache)[0]?.host, '192.168.1.20')
})

test('active discovery resolves records received across four packets', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const found = []
  discoverer.on('deviceFound', device => found.push(device))

  const packets = [
    responsePacket([aRecord(TARGET, '192.168.1.25')]),
    responsePacket([txtRecord(INSTANCE, { fn: 'Kitchen TV' })]),
    responsePacket([srvRecord(INSTANCE, 8009, TARGET)]),
    responsePacket([ptrRecord(ServiceType.CHROMECAST, INSTANCE)])
  ]

  for (const packet of packets.slice(0, -1)) {
    socket.emit('message', packet, {})
    t.alike(discoverer.getDevices(), [])
    t.alike(found, [])
  }
  socket.emit('message', packets.at(-1), {})

  const expected = {
    id: '192.168.1.25:8009',
    name: 'Kitchen TV',
    host: '192.168.1.25',
    port: 8009,
    protocol: 'chromecast'
  }
  t.alike(discoverer.getDevices(), [expected])
  t.alike(found, [expected])
})

test('each Chromecast instance resolves through its own SRV target', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const officeInstance = 'Office TV._googlecast._tcp.local.'
  const officeTarget = 'office-chromecast.local.'

  socket.emit('message', responsePacket([
    ptrRecord(ServiceType.CHROMECAST, INSTANCE),
    ptrRecord(ServiceType.CHROMECAST, officeInstance),
    srvRecord(INSTANCE, 8009, TARGET),
    srvRecord(officeInstance, 8009, officeTarget),
    txtRecord(INSTANCE, { fn: 'Kitchen TV' }),
    txtRecord(officeInstance, { fn: 'Office TV' }),
    aRecord(officeTarget, '192.168.1.40'),
    aRecord(TARGET, '192.168.1.25')
  ]), {})

  t.alike(discoverer.getDevices(), [{
    id: '192.168.1.25:8009',
    name: 'Kitchen TV',
    host: '192.168.1.25',
    port: 8009,
    protocol: 'chromecast'
  }, {
    id: '192.168.1.40:8009',
    name: 'Office TV',
    host: '192.168.1.40',
    port: 8009,
    protocol: 'chromecast'
  }])
})

test('a numerically lower address moves an endpoint with lost before found', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const events = []
  discoverer.on('deviceLost', id => events.push(['lost', id]))
  discoverer.on('deviceFound', device => events.push(['found', device.id]))
  discoverer.on('deviceChanged', device => events.push(['changed', device.id]))

  socket.emit('message', completeServicePacket({ address: '192.168.1.20' }), {})
  socket.emit('message', responsePacket([aRecord(TARGET, '192.168.1.9')]), {})

  t.alike(discoverer.getDevices(), [{
    id: '192.168.1.9:8009',
    name: 'Kitchen TV',
    host: '192.168.1.9',
    port: 8009,
    protocol: 'chromecast'
  }])
  t.alike(events, [
    ['found', '192.168.1.20:8009'],
    ['lost', '192.168.1.20:8009'],
    ['found', '192.168.1.9:8009']
  ])
})

test('replaying a complete response does not emit duplicate discovery events', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const found = []
  const changed = []
  discoverer.on('deviceFound', device => found.push(device))
  discoverer.on('deviceChanged', device => changed.push(device))
  const packet = completeChromecastPacket()

  socket.emit('message', packet, {})
  socket.emit('message', packet, {})

  t.is(found.length, 1)
  t.alike(changed, [])
})

test('a complete AirPlay chain does not create a Chromecast device', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const found = []
  discoverer.on('deviceFound', device => found.push(device))

  socket.emit('message', completeServicePacket({
    service: '_airplay._tcp.local.',
    instance: 'Kitchen TV._airplay._tcp.local.',
    target: 'airplay-tv.local.',
    address: '192.168.1.70',
    port: 7000
  }), {})

  t.alike(discoverer.getDevices(), [])
  t.alike(found, [])
})

test('instances sharing an endpoint use the lowest normalized representative', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const alphaInstance = 'Alpha._googlecast._tcp.local.'
  const zuluInstance = 'Zulu._googlecast._tcp.local.'

  socket.emit('message', responsePacket([
    ptrRecord(ServiceType.CHROMECAST, zuluInstance),
    ptrRecord(ServiceType.CHROMECAST, alphaInstance),
    srvRecord(zuluInstance, 8009, TARGET),
    srvRecord(alphaInstance, 8009, TARGET),
    txtRecord(zuluInstance, { fn: 'Zulu TV' }),
    txtRecord(alphaInstance, { fn: 'Alpha TV' }),
    aRecord(TARGET, '192.168.1.25')
  ]), {})

  t.alike(discoverer.getDevices(), [{
    id: '192.168.1.25:8009',
    name: 'Alpha TV',
    host: '192.168.1.25',
    port: 8009,
    protocol: 'chromecast'
  }])
})
