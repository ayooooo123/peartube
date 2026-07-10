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
const MAX_CAST_INSTANCES = 256
const MAX_A_TARGETS = 512
const MAX_A_ADDRESSES_PER_TARGET = 8

class FakeSocket extends EventEmitter {
  constructor(options = {}) {
    super()
    this.options = options
    this.bindCalls = []
    this.sendCalls = []
    this.closeCalls = 0
    this.addMembershipCalls = []
    this.addMembershipInterfaceCalls = []
    this.dropMembershipCalls = []
    this.dropMembershipInterfaceCalls = []
    this.on('error', () => {})

    if (options.hasMembership !== false) {
      this._socket = {
        addMembership: (address, interfaceAddress) => {
          this.addMembershipCalls.push(address)
          this.addMembershipInterfaceCalls.push(interfaceAddress)
          if (interfaceAddress && options.interfaceMembershipError) {
            throw options.interfaceMembershipError
          }
          if (options.membershipEmitsError) this.fail(options.membershipEmitsError)
          if (options.membershipError) throw options.membershipError
        },
        dropMembership: (address, interfaceAddress) => {
          this.dropMembershipCalls.push(address)
          this.dropMembershipInterfaceCalls.push(interfaceAddress)
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
  let resolveLocalIPv4Calls = 0

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
    async resolveLocalIPv4() {
      resolveLocalIPv4Calls++
      if (dependencies.resolveLocalIPv4) return dependencies.resolveLocalIPv4()
      return dependencies.localIp || null
    },
    logger: dependencies.logger || { error() {} }
  })

  return {
    discoverer,
    createOptions,
    intervals,
    clearIntervalCalls,
    get loadCalls() { return attemptIndex },
    get resolveLocalIPv4Calls() { return resolveLocalIPv4Calls }
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

test('start joins and leaves multicast on the resolved LAN interface', async (t) => {
  const socketA = new FakeSocket()
  const socketB = new FakeSocket()
  const localIps = ['192.168.1.25', '192.168.1.26']
  const fixture = createLifecycleFixture(
    [{ socket: socketA }, { socket: socketB }],
    { resolveLocalIPv4: () => localIps.shift() }
  )

  const firstStart = fixture.discoverer.start()
  await flushMicrotasks()
  socketA.listen()
  await firstStart

  t.alike(socketA.bindCalls, [[MDNS_PORT, '0.0.0.0']])
  t.alike(socketA.addMembershipCalls, [MDNS_ADDRESS])
  t.alike(socketA.addMembershipInterfaceCalls, ['192.168.1.25'])
  await fixture.discoverer.stop()
  t.alike(socketA.dropMembershipInterfaceCalls, ['192.168.1.25'])

  const secondStart = fixture.discoverer.start()
  await flushMicrotasks()
  socketB.listen()
  await secondStart

  t.is(fixture.resolveLocalIPv4Calls, 2)
  t.alike(socketB.addMembershipInterfaceCalls, ['192.168.1.26'])
})

test('an interface-scoped membership failure retries the default interface', async (t) => {
  const socket = new FakeSocket({
    interfaceMembershipError: new Error('interface unavailable')
  })
  const fixture = createLifecycleFixture(
    [{ socket }],
    { localIp: '192.168.1.25' }
  )

  const started = fixture.discoverer.start()
  await flushMicrotasks()
  socket.listen()
  await started

  t.ok(fixture.discoverer.isRunning())
  t.alike(socket.addMembershipCalls, [MDNS_ADDRESS, MDNS_ADDRESS])
  t.alike(socket.addMembershipInterfaceCalls, ['192.168.1.25', undefined])
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

test('record cache does not add ttl-zero records', (t) => {
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

test('record cache rejects unrelated service metadata and bounds pending A records', (t) => {
  const helpers = getDiscoveryHelpers(t)
  if (!helpers) return
  const cache = helpers.createDiscoveryRecordCache()

  for (let i = 0; i < 10000; i++) {
    const service = i % 2 === 0
      ? `Noise ${i}._airplay._tcp.local.`
      : `Noise ${i}._googlecast._tcp.local.evil.`
    helpers.applyDiscoveryRecord(cache, {
      name: service,
      type: DNS_TYPE.SRV,
      ttl: 120,
      target: `noise-${i}.local.`,
      port: 8009
    })
    helpers.applyDiscoveryRecord(cache, {
      name: service,
      type: DNS_TYPE.TXT,
      ttl: 120,
      txt: { fn: `Noise ${i}` }
    })
  }

  for (let targetIndex = 0; targetIndex < 300; targetIndex++) {
    for (let addressIndex = 1; addressIndex <= 12; addressIndex++) {
      helpers.applyDiscoveryRecord(cache, {
        name: `noise-${targetIndex}.local.`,
        type: DNS_TYPE.A,
        ttl: 120,
        address: `10.${Math.floor(targetIndex / 256)}.${targetIndex % 256}.${addressIndex}`
      })
    }
  }

  const addressSets = Array.from(cache.addressesByTarget.values())
  t.is(cache.srvByInstance.size, 0)
  t.is(cache.txtByInstance.size, 0)
  t.ok(cache.addressesByTarget.size <= 256)
  t.not(cache.addressesByTarget.has('noise-0.local'))
  t.ok(cache.addressesByTarget.has('noise-299.local'))
  t.ok(addressSets.every(addresses => addresses.size <= 8))
  t.ok(addressSets.reduce((total, addresses) => total + addresses.size, 0) <= 256 * 8)
})

test('an early A record resolves after bounded pending traffic and a later Chromecast chain', (t) => {
  const helpers = getDiscoveryHelpers(t)
  if (!helpers) return
  const cache = helpers.createDiscoveryRecordCache()

  helpers.applyDiscoveryRecord(cache, {
    name: TARGET,
    type: DNS_TYPE.A,
    ttl: 120,
    address: '192.168.1.25'
  })
  for (let i = 0; i < 255; i++) {
    helpers.applyDiscoveryRecord(cache, {
      name: `pending-${i}.local.`,
      type: DNS_TYPE.A,
      ttl: 120,
      address: `10.0.${Math.floor(i / 256)}.${i % 256}`
    })
  }
  helpers.applyDiscoveryRecord(cache, {
    name: INSTANCE,
    type: DNS_TYPE.SRV,
    ttl: 120,
    target: TARGET,
    port: 8009
  })
  helpers.applyDiscoveryRecord(cache, {
    name: ServiceType.CHROMECAST,
    type: DNS_TYPE.PTR,
    ttl: 120,
    ptr: INSTANCE
  })

  t.alike(helpers.buildDiscoveredDevices(cache), [{
    id: '192.168.1.25:8009',
    name: 'kitchen tv',
    host: '192.168.1.25',
    port: 8009,
    protocol: 'chromecast'
  }])
})

test('a referenced Chromecast A target survives pending-cache churn', (t) => {
  const helpers = getDiscoveryHelpers(t)
  if (!helpers) return
  const cache = helpers.createDiscoveryRecordCache()

  for (const parsedRecord of parseResponse(completeChromecastPacket()).records) {
    helpers.applyDiscoveryRecord(cache, parsedRecord)
  }
  for (let i = 0; i < 512; i++) {
    helpers.applyDiscoveryRecord(cache, {
      name: `churn-${i}.local.`,
      type: DNS_TYPE.A,
      ttl: 120,
      address: `10.1.${Math.floor(i / 256)}.${i % 256}`
    })
  }

  t.ok(cache.addressesByTarget.size <= 257)
  t.alike(helpers.buildDiscoveredDevices(cache), [{
    id: '192.168.1.25:8009',
    name: 'Kitchen TV',
    host: '192.168.1.25',
    port: 8009,
    protocol: 'chromecast'
  }])
})

function stressInstance(index, prefix = 'Stress') {
  return `${prefix} ${String(index).padStart(5, '0')}._googlecast._tcp.local.`
}

function stressTarget(index, prefix = 'stress') {
  return `${prefix}-${String(index).padStart(5, '0')}.local.`
}

function stressAddress(index) {
  return `10.${Math.floor(index / 65536)}.${Math.floor(index / 256) % 256}.${index % 256}`
}

function applyCompleteCacheChain(helpers, cache, index, prefix = 'Stress') {
  const instance = stressInstance(index, prefix)
  const target = stressTarget(index, prefix.toLowerCase())
  const address = stressAddress(index)
  helpers.applyDiscoveryRecord(cache, {
    name: ServiceType.CHROMECAST,
    type: DNS_TYPE.PTR,
    ttl: 120,
    ptr: instance
  })
  helpers.applyDiscoveryRecord(cache, {
    name: instance,
    type: DNS_TYPE.SRV,
    ttl: 120,
    target,
    port: 8009
  })
  helpers.applyDiscoveryRecord(cache, {
    name: instance,
    type: DNS_TYPE.TXT,
    ttl: 120,
    txt: { fn: `${prefix} ${index}` }
  })
  helpers.applyDiscoveryRecord(cache, {
    name: target,
    type: DNS_TYPE.A,
    ttl: 120,
    address
  })
  return {
    instance: instance.toLowerCase().replace(/\.$/, ''),
    target: target.toLowerCase().replace(/\.$/, ''),
    address
  }
}

test('complete valid-looking Chromecast chains stay within total cache bounds', (t) => {
  const helpers = getDiscoveryHelpers(t)
  if (!helpers) return
  const cache = helpers.createDiscoveryRecordCache()
  let earliest
  let newest

  for (let i = 0; i < 2000; i++) {
    const chain = applyCompleteCacheChain(helpers, cache, i)
    if (i === 0) earliest = chain
    newest = chain
  }

  const devices = helpers.buildDiscoveredDevices(cache)
  const addressCount = Array.from(cache.addressesByTarget.values())
    .reduce((total, addresses) => total + addresses.size, 0)
  t.ok(cache.ptrInstances.size <= MAX_CAST_INSTANCES)
  t.ok(cache.srvByInstance.size <= MAX_CAST_INSTANCES)
  t.ok(cache.txtByInstance.size <= MAX_CAST_INSTANCES)
  t.ok(cache.instanceRecency?.size <= MAX_CAST_INSTANCES)
  t.ok(cache.addressesByTarget.size <= MAX_A_TARGETS)
  t.ok(cache.addressTargetRecency?.size <= MAX_A_TARGETS)
  t.ok(addressCount <= MAX_A_TARGETS * MAX_A_ADDRESSES_PER_TARGET)
  t.not(cache.ptrInstances.has(earliest.instance))
  t.not(cache.srvByInstance.has(earliest.instance))
  t.not(cache.txtByInstance.has(earliest.instance))
  t.not(cache.instanceRecency?.has(earliest.instance))
  t.ok(cache.ptrInstances.has(newest.instance))
  t.ok(cache.srvByInstance.has(newest.instance))
  t.ok(cache.txtByInstance.has(newest.instance))
  t.ok(cache.instanceRecency?.has(newest.instance))
  t.ok(devices.some(device => (
    device.id === `${newest.address}:8009` && device.name === 'Stress 1999'
  )))
})

test('valid-looking SRV and TXT records without PTR stay instance-bounded', (t) => {
  const helpers = getDiscoveryHelpers(t)
  if (!helpers) return
  const cache = helpers.createDiscoveryRecordCache()

  for (let i = 0; i < 2000; i++) {
    const instance = stressInstance(i, 'Metadata')
    helpers.applyDiscoveryRecord(cache, {
      name: instance,
      type: DNS_TYPE.SRV,
      ttl: 120,
      target: stressTarget(i, 'metadata'),
      port: 8009
    })
    helpers.applyDiscoveryRecord(cache, {
      name: instance,
      type: DNS_TYPE.TXT,
      ttl: 120,
      txt: { fn: `Metadata ${i}` }
    })
  }

  const earliest = stressInstance(0, 'Metadata').toLowerCase().replace(/\.$/, '')
  const newest = stressInstance(1999, 'Metadata').toLowerCase().replace(/\.$/, '')
  t.is(cache.ptrInstances.size, 0)
  t.ok(cache.srvByInstance.size <= MAX_CAST_INSTANCES)
  t.ok(cache.txtByInstance.size <= MAX_CAST_INSTANCES)
  t.ok(cache.instanceRecency?.size <= MAX_CAST_INSTANCES)
  t.not(cache.srvByInstance.has(earliest))
  t.not(cache.txtByInstance.has(earliest))
  t.ok(cache.srvByInstance.has(newest))
  t.ok(cache.txtByInstance.has(newest))
})

test('instance LRU refreshes on positive records but not PTR goodbyes', (t) => {
  const helpers = getDiscoveryHelpers(t)
  if (!helpers) return
  const cache = helpers.createDiscoveryRecordCache()

  for (let i = 0; i < MAX_CAST_INSTANCES; i++) {
    helpers.applyDiscoveryRecord(cache, {
      name: ServiceType.CHROMECAST,
      type: DNS_TYPE.PTR,
      ttl: 120,
      ptr: stressInstance(i, 'Recency')
    })
  }
  helpers.applyDiscoveryRecord(cache, {
    name: stressInstance(0, 'Recency'),
    type: DNS_TYPE.TXT,
    ttl: 120,
    txt: { fn: 'Refreshed' }
  })
  helpers.applyDiscoveryRecord(cache, {
    name: ServiceType.CHROMECAST,
    type: DNS_TYPE.PTR,
    ttl: 0,
    ptr: stressInstance(1, 'Recency')
  })
  helpers.applyDiscoveryRecord(cache, {
    name: ServiceType.CHROMECAST,
    type: DNS_TYPE.PTR,
    ttl: 120,
    ptr: stressInstance(MAX_CAST_INSTANCES, 'Recency')
  })

  const instance0 = stressInstance(0, 'Recency').toLowerCase().replace(/\.$/, '')
  const instance1 = stressInstance(1, 'Recency').toLowerCase().replace(/\.$/, '')
  const instance2 = stressInstance(2, 'Recency').toLowerCase().replace(/\.$/, '')
  const newest = stressInstance(MAX_CAST_INSTANCES, 'Recency').toLowerCase().replace(/\.$/, '')
  t.ok(cache.ptrInstances.has(instance0))
  t.not(cache.instanceRecency.has(instance1))
  t.ok(cache.ptrInstances.has(instance2))
  t.ok(cache.ptrInstances.has(newest))
  t.is(cache.instanceRecency.size, MAX_CAST_INSTANCES)
})

test('PTR goodbyes and later instance churn stay bounded without stale resurrection', (t) => {
  const helpers = getDiscoveryHelpers(t)
  if (!helpers) return
  const cache = helpers.createDiscoveryRecordCache()
  let newest

  for (let i = 0; i < 2000; i++) newest = applyCompleteCacheChain(helpers, cache, i, 'Goodbye')
  helpers.applyDiscoveryRecord(cache, {
    name: ServiceType.CHROMECAST,
    type: DNS_TYPE.PTR,
    ttl: 0,
    ptr: stressInstance(1999, 'Goodbye')
  })
  for (let i = 0; i < 3000; i++) {
    helpers.applyDiscoveryRecord(cache, {
      name: ServiceType.CHROMECAST,
      type: DNS_TYPE.PTR,
      ttl: 0,
      ptr: stressInstance(i, 'Goodbye Churn')
    })
  }
  for (let i = 0; i < 2000; i++) {
    helpers.applyDiscoveryRecord(cache, {
      name: ServiceType.CHROMECAST,
      type: DNS_TYPE.PTR,
      ttl: 120,
      ptr: stressInstance(i, 'Replacement')
    })
  }

  t.ok(cache.ptrInstances.size <= MAX_CAST_INSTANCES)
  t.ok(cache.srvByInstance.size <= MAX_CAST_INSTANCES)
  t.ok(cache.txtByInstance.size <= MAX_CAST_INSTANCES)
  t.ok(cache.instanceRecency?.size <= MAX_CAST_INSTANCES)
  t.ok(cache.addressesByTarget.size <= MAX_A_TARGETS)
  t.not(cache.ptrInstances.has(newest.instance))
  t.not(cache.srvByInstance.has(newest.instance))
  t.not(cache.txtByInstance.has(newest.instance))
  t.not(helpers.buildDiscoveredDevices(cache).some(device => device.id === `${newest.address}:8009`))
})

test('exact Chromecast PTR owners reject non-Chromecast instance targets', (t) => {
  const helpers = getDiscoveryHelpers(t)
  if (!helpers) return
  const cache = helpers.createDiscoveryRecordCache()

  for (const ptr of [
    'Kitchen TV._airplay._tcp.local.',
    'Kitchen TV._googlecast._tcp.local.evil.',
    '_googlecast._tcp.local.'
  ]) {
    helpers.applyDiscoveryRecord(cache, {
      name: ServiceType.CHROMECAST,
      type: DNS_TYPE.PTR,
      ttl: 120,
      ptr
    })
  }

  t.is(cache.ptrInstances.size, 0)
  t.is(cache.instanceRecency?.size, 0)
})

test('A-target LRU refresh preserves referenced and recently refreshed targets', (t) => {
  const helpers = getDiscoveryHelpers(t)
  if (!helpers) return
  const cache = helpers.createDiscoveryRecordCache()
  const retained = applyCompleteCacheChain(helpers, cache, 1, 'Retained')

  for (let i = 0; i < 256; i++) {
    helpers.applyDiscoveryRecord(cache, {
      name: `pending-lru-${i}.local.`,
      type: DNS_TYPE.A,
      ttl: 120,
      address: `10.20.${Math.floor(i / 256)}.${i % 256}`
    })
  }
  helpers.applyDiscoveryRecord(cache, {
    name: 'pending-lru-0.local.',
    type: DNS_TYPE.A,
    ttl: 120,
    address: '10.20.0.0'
  })
  helpers.applyDiscoveryRecord(cache, {
    name: 'pending-lru-256.local.',
    type: DNS_TYPE.A,
    ttl: 120,
    address: '10.20.1.0'
  })

  t.ok(cache.addressesByTarget.has(retained.target))
  t.ok(cache.addressesByTarget.has('pending-lru-0.local'))
  t.not(cache.addressesByTarget.has('pending-lru-1.local'))
  t.ok(cache.addressesByTarget.has('pending-lru-256.local'))
  t.ok(cache.addressesByTarget.size <= MAX_A_TARGETS)
  t.ok(helpers.buildDiscoveredDevices(cache).some(device => device.id === `${retained.address}:8009`))
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
  events.length = 0
  socket.emit('message', responsePacket([aRecord(TARGET, '192.168.1.9')]), {})

  t.alike(discoverer.getDevices(), [{
    id: '192.168.1.9:8009',
    name: 'Kitchen TV',
    host: '192.168.1.9',
    port: 8009,
    protocol: 'chromecast'
  }])
  t.alike(events, [
    ['lost', '192.168.1.20:8009'],
    ['found', '192.168.1.9:8009']
  ])
})

test('a reentrant clear aborts stale events from an endpoint transition', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const events = []
  discoverer.on('deviceLost', id => {
    events.push(['lost', id])
    if (id === '192.168.1.20:8009') discoverer.clearDevices()
  })
  discoverer.on('deviceFound', device => events.push(['found', device.id]))

  socket.emit('message', completeServicePacket({ address: '192.168.1.20' }), {})
  events.length = 0
  socket.emit('message', responsePacket([aRecord(TARGET, '192.168.1.9')]), {})

  t.alike(discoverer.getDevices(), [])
  t.alike(events, [
    ['lost', '192.168.1.20:8009']
  ])
})

test('a reentrant no-op does not suppress the next endpoint event', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const events = []
  discoverer.on('deviceLost', id => {
    events.push(['lost', id])
    if (id === '192.168.1.20:8009') {
      discoverer.removeManualDevice('192.168.1.80:8009')
    }
  })
  discoverer.on('deviceFound', device => events.push(['found', device.id]))

  socket.emit('message', completeServicePacket({ address: '192.168.1.20' }), {})
  events.length = 0
  socket.emit('message', responsePacket([aRecord(TARGET, '192.168.1.9')]), {})

  t.alike(events, [
    ['lost', '192.168.1.20:8009'],
    ['found', '192.168.1.9:8009']
  ])
  t.alike(discoverer.getDevices(), [{
    id: '192.168.1.9:8009',
    name: 'Kitchen TV',
    host: '192.168.1.9',
    port: 8009,
    protocol: 'chromecast'
  }])
})

test('reentrant manual insertion publishes every pending endpoint exactly once', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const observed = new Map()
  const events = []
  discoverer.on('deviceFound', device => {
    observed.set(device.id, device)
    events.push(['found', device.id])
  })
  discoverer.on('deviceChanged', device => {
    observed.set(device.id, device)
    events.push(['changed', device.id])
  })
  discoverer.on('deviceLost', id => {
    observed.delete(id)
    events.push(['lost', id])
    if (id === '192.168.1.20:8009') {
      discoverer.addManualDevice({ name: 'Manual TV', host: '192.168.1.80' })
    }
  })

  socket.emit('message', completeServicePacket({ address: '192.168.1.20' }), {})
  events.length = 0
  socket.emit('message', responsePacket([aRecord(TARGET, '192.168.1.9')]), {})

  t.alike(events, [
    ['lost', '192.168.1.20:8009'],
    ['found', '192.168.1.9:8009'],
    ['found', '192.168.1.80:8009']
  ])
  t.alike(Array.from(observed.values()), discoverer.getDevices())
  t.ok(observed.has('192.168.1.9:8009'))
  t.ok(observed.has('192.168.1.80:8009'))
})

test('reentrant clear publishes every loss from the observer snapshot', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const officeInstance = 'Office TV._googlecast._tcp.local.'
  const officeTarget = 'office-chromecast.local.'
  const observed = new Map()
  const events = []
  discoverer.on('deviceFound', device => {
    observed.set(device.id, device)
    events.push(['found', device.id])
  })
  discoverer.on('deviceChanged', device => {
    observed.set(device.id, device)
    events.push(['changed', device.id])
  })
  discoverer.on('deviceLost', id => {
    observed.delete(id)
    events.push(['lost', id])
    if (id === '192.168.1.20:8009') discoverer.clearDevices()
  })

  socket.emit('message', responsePacket([
    ptrRecord(ServiceType.CHROMECAST, INSTANCE),
    ptrRecord(ServiceType.CHROMECAST, officeInstance),
    srvRecord(INSTANCE, 8009, TARGET),
    srvRecord(officeInstance, 8009, officeTarget),
    txtRecord(INSTANCE, { fn: 'Kitchen TV' }),
    txtRecord(officeInstance, { fn: 'Office TV' }),
    aRecord(TARGET, '192.168.1.20'),
    aRecord(officeTarget, '192.168.1.40')
  ]), {})
  events.length = 0
  socket.emit('message', responsePacket([aRecord(TARGET, '192.168.1.9')]), {})

  t.alike(events, [
    ['lost', '192.168.1.20:8009'],
    ['lost', '192.168.1.40:8009']
  ])
  t.alike(Array.from(observed.values()), [])
  t.alike(discoverer.getDevices(), [])
})

test('TXT updates change the visible device without changing its endpoint', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const events = []
  discoverer.on('deviceFound', device => events.push(['found', device.id]))
  discoverer.on('deviceLost', id => events.push(['lost', id]))
  discoverer.on('deviceChanged', device => events.push(['changed', device]))

  socket.emit('message', completeServicePacket({ txt: { fn: 'Kitchen' } }), {})
  events.length = 0
  socket.emit('message', responsePacket([
    txtRecord(INSTANCE, { fn: 'Kitchen TV' })
  ]), {})

  t.alike(events, [['changed', {
    id: '192.168.1.25:8009',
    name: 'Kitchen TV',
    host: '192.168.1.25',
    port: 8009,
    protocol: 'chromecast'
  }]])
})

test('an A goodbye selects the next address and stale repeats emit nothing', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const events = []
  discoverer.on('deviceFound', device => events.push(['found', device.id]))
  discoverer.on('deviceLost', id => events.push(['lost', id]))
  discoverer.on('deviceChanged', device => events.push(['changed', device.id]))

  socket.emit('message', completeServicePacket({ address: '192.168.1.20' }), {})
  socket.emit('message', responsePacket([aRecord(TARGET, '192.168.1.9')]), {})
  events.length = 0
  socket.emit('message', responsePacket([
    aRecord(TARGET, '192.168.1.9', { ttl: 0 })
  ]), {})

  t.alike(events, [
    ['lost', '192.168.1.9:8009'],
    ['found', '192.168.1.20:8009']
  ])
  t.is(discoverer.getDevices()[0]?.host, '192.168.1.20')

  events.length = 0
  socket.emit('message', responsePacket([
    aRecord(TARGET, '192.168.1.9', { ttl: 0 })
  ]), {})
  t.alike(events, [])
})

test('a stale SRV goodbye cannot remove its replacement', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const targetB = 'replacement-chromecast.local.'
  const events = []
  discoverer.on('deviceFound', device => events.push(['found', device.id]))
  discoverer.on('deviceLost', id => events.push(['lost', id]))
  discoverer.on('deviceChanged', device => events.push(['changed', device.id]))

  socket.emit('message', completeServicePacket({ address: '192.168.1.20' }), {})
  socket.emit('message', responsePacket([
    aRecord(targetB, '192.168.1.30'),
    srvRecord(INSTANCE, 8009, targetB)
  ]), {})
  events.length = 0
  socket.emit('message', responsePacket([
    srvRecord(INSTANCE, 8009, TARGET, { ttl: 0 })
  ]), {})

  t.alike(events, [])
  t.is(discoverer.getDevices()[0]?.host, '192.168.1.30')

  socket.emit('message', responsePacket([
    srvRecord(INSTANCE, 8009, targetB, { ttl: 0 })
  ]), {})
  t.alike(events, [['lost', '192.168.1.30:8009']])
  t.alike(discoverer.getDevices(), [])
})

test('a stale TXT goodbye cannot remove its replacement', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const events = []
  discoverer.on('deviceFound', device => events.push(['found', device.id]))
  discoverer.on('deviceLost', id => events.push(['lost', id]))
  discoverer.on('deviceChanged', device => events.push(['changed', device.name]))

  socket.emit('message', completeServicePacket({ txt: { fn: 'Old' } }), {})
  socket.emit('message', responsePacket([txtRecord(INSTANCE, { fn: 'New' })]), {})
  events.length = 0
  socket.emit('message', responsePacket([
    txtRecord(INSTANCE, { fn: 'Old' }, { ttl: 0 })
  ]), {})

  t.alike(events, [])
  t.is(discoverer.getDevices()[0]?.name, 'New')

  socket.emit('message', responsePacket([
    txtRecord(INSTANCE, { fn: 'New' }, { ttl: 0 })
  ]), {})
  t.alike(events, [['changed', 'kitchen tv']])
  t.is(discoverer.getDevices()[0]?.name, 'kitchen tv')
})

test('shared endpoint remains until every PTR instance says goodbye', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const secondInstance = 'Second TV._googlecast._tcp.local.'
  const lost = []
  discoverer.on('deviceLost', id => lost.push(id))

  socket.emit('message', responsePacket([
    ptrRecord(ServiceType.CHROMECAST, INSTANCE),
    ptrRecord(ServiceType.CHROMECAST, secondInstance),
    srvRecord(INSTANCE, 8009, TARGET),
    srvRecord(secondInstance, 8009, TARGET),
    txtRecord(INSTANCE, { fn: 'Shared TV' }),
    txtRecord(secondInstance, { fn: 'Shared TV' }),
    aRecord(TARGET, '192.168.1.25')
  ]), {})
  lost.length = 0

  socket.emit('message', responsePacket([
    ptrRecord(ServiceType.CHROMECAST, INSTANCE, { ttl: 0 })
  ]), {})
  t.alike(lost, [])
  t.is(discoverer.getDevices().length, 1)

  socket.emit('message', responsePacket([
    ptrRecord(ServiceType.CHROMECAST, secondInstance, { ttl: 0 })
  ]), {})
  t.alike(lost, ['192.168.1.25:8009'])
  t.alike(discoverer.getDevices(), [])
})

test('manual overlays mask discovered endpoint changes and goodbyes', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const events = []
  discoverer.on('deviceFound', device => events.push(['found', device.id]))
  discoverer.on('deviceLost', id => events.push(['lost', id]))
  discoverer.on('deviceChanged', device => events.push(['changed', device.id]))

  socket.emit('message', completeServicePacket({ address: '192.168.1.20' }), {})
  events.length = 0
  const manual20 = discoverer.addManualDevice({
    name: 'Manual 20',
    host: '192.168.1.20'
  })
  const manual9 = discoverer.addManualDevice({
    name: 'Manual 9',
    host: '192.168.1.9'
  })
  t.alike(events, [
    ['changed', '192.168.1.20:8009'],
    ['found', '192.168.1.9:8009']
  ])

  events.length = 0
  socket.emit('message', responsePacket([
    txtRecord(INSTANCE, { fn: 'Hidden Rename' })
  ]), {})
  socket.emit('message', responsePacket([
    aRecord(TARGET, '192.168.1.9')
  ]), {})
  socket.emit('message', responsePacket([
    ptrRecord(ServiceType.CHROMECAST, INSTANCE, { ttl: 0 })
  ]), {})

  t.alike(events, [])
  const visible = new Map(discoverer.getDevices().map(device => [device.id, device]))
  t.alike(visible.get(manual20.id), manual20)
  t.alike(visible.get(manual9.id), manual9)
})

test('removing a manual collision reveals cached discovery or loses an unowned endpoint', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const events = []
  discoverer.on('deviceFound', device => events.push(['found', device.id]))
  discoverer.on('deviceLost', id => events.push(['lost', id]))
  discoverer.on('deviceChanged', device => events.push(['changed', device]))

  socket.emit('message', completeServicePacket({ txt: { fn: 'Discovered TV' } }), {})
  discoverer.addManualDevice({ name: 'Manual TV', host: '192.168.1.25' })
  events.length = 0
  discoverer.removeManualDevice('192.168.1.25:8009')

  t.alike(events, [['changed', {
    id: '192.168.1.25:8009',
    name: 'Discovered TV',
    host: '192.168.1.25',
    port: 8009,
    protocol: 'chromecast'
  }]])

  discoverer.addManualDevice({ name: 'Manual Only', host: '192.168.1.80' })
  events.length = 0
  discoverer.removeManualDevice('192.168.1.80:8009')
  t.alike(events, [['lost', '192.168.1.80:8009']])
})

test('clearDevices loses the merged public view and empties every store', async (t) => {
  const { discoverer, socket } = await startActiveDiscovery(t)
  const lost = []
  discoverer.on('deviceLost', id => lost.push(id))

  socket.emit('message', completeChromecastPacket(), {})
  discoverer.addManualDevice({ name: 'Manual TV', host: '192.168.1.80' })
  lost.length = 0
  discoverer.clearDevices()

  t.alike(lost, ['192.168.1.25:8009', '192.168.1.80:8009'])
  t.alike(discoverer.getDevices(), [])
  t.is(discoverer._manualDevices.size, 0)
  t.is(discoverer._discoveredDevices.size, 0)
  t.is(discoverer._devices.size, 0)
  t.is(discoverer._recordCache.ptrInstances.size, 0)
  t.is(discoverer._recordCache.srvByInstance.size, 0)
  t.is(discoverer._recordCache.txtByInstance.size, 0)
  t.is(discoverer._recordCache.addressesByTarget.size, 0)
  t.is(discoverer._recordCache.instanceRecency?.size, 0)
  t.is(discoverer._recordCache.addressTargetRecency?.size, 0)
})

test('record goodbyes match normalized SRV names and semantic TXT content', (t) => {
  const helpers = getDiscoveryHelpers(t)
  if (!helpers) return
  const cache = helpers.createDiscoveryRecordCache()
  const normalizedInstance = INSTANCE.toLowerCase().replace(/\.$/, '')

  helpers.applyDiscoveryRecord(cache, {
    name: INSTANCE,
    type: DNS_TYPE.SRV,
    ttl: 120,
    target: 'Kitchen-Chromecast.LOCAL.',
    port: 8009
  })
  helpers.applyDiscoveryRecord(cache, {
    name: INSTANCE,
    type: DNS_TYPE.TXT,
    ttl: 120,
    txt: { fn: 'Kitchen TV', md: 'Chromecast' }
  })
  helpers.applyDiscoveryRecord(cache, {
    name: INSTANCE.toUpperCase(),
    type: DNS_TYPE.SRV,
    ttl: 0,
    target: 'kitchen-chromecast.local',
    port: 8009
  })
  helpers.applyDiscoveryRecord(cache, {
    name: INSTANCE,
    type: DNS_TYPE.TXT,
    ttl: 0,
    txt: { md: 'Chromecast', fn: 'Kitchen TV' }
  })

  t.is(cache.srvByInstance.has(normalizedInstance), false)
  t.is(cache.txtByInstance.has(normalizedInstance), false)
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
