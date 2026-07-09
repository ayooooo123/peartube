import test from 'brittle'
import { EventEmitter } from 'bare-events'
import {
  DeviceDiscoverer,
  MDNS_ADDRESS,
  MDNS_PORT,
  ServiceType
} from '../src/cast/discovery.js'

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

function createLifecycleFixture(attempts = [{ socket: new FakeSocket() }]) {
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
    }
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

function record(name, type, rdata) {
  const header = Buffer.alloc(10)
  header.writeUInt16BE(type, 0)
  header.writeUInt16BE(1, 2)
  header.writeUInt32BE(120, 4)
  header.writeUInt16BE(rdata.length, 8)
  return Buffer.concat([dnsName(name), header, rdata])
}

function completeChromecastPacket() {
  const srv = Buffer.alloc(6)
  srv.writeUInt16BE(8009, 4)
  const txt = Buffer.from('fn=Kitchen TV')
  const records = [
    record(ServiceType.CHROMECAST, 12, dnsName(INSTANCE)),
    record(INSTANCE, 33, Buffer.concat([srv, dnsName(TARGET)])),
    record(INSTANCE, 16, Buffer.concat([Buffer.from([txt.length]), txt])),
    record(TARGET, 1, Buffer.from([192, 168, 1, 25]))
  ]
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(records.length, 6)
  return Buffer.concat([header, ...records])
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
