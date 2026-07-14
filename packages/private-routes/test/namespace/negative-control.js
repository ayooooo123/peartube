import b4a from 'b4a'

import { PrivateRouteError } from '../../lib/errors.js'
import { UdxAdapter } from '../../lib/udx-adapter.js'

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function endpoint(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.host !== 'string' ||
    !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value.host) ||
    value.host.split('.').some((part) => Number(part) > 255) ||
    !Number.isSafeInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535
  ) {
    invalid()
  }
  return Object.freeze({ host: value.host, port: value.port })
}

export class NegativeControlDialer {
  #adapter
  #bind
  #target
  #payload
  #invocations = 0
  #closed = false
  #sockets = new Set()

  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) invalid()
    const adapter = options.adapter || new UdxAdapter()
    if (!adapter || typeof adapter.create !== 'function') invalid()
    if (
      !b4a.isBuffer(options.payload) ||
      options.payload.byteLength < 1 ||
      options.payload.byteLength > 1_200
    ) {
      invalid()
    }
    this.#adapter = adapter
    this.#bind = endpoint(options.bind)
    this.#target = endpoint(options.target)
    this.#payload = b4a.from(options.payload)
  }

  get invocations() {
    return this.#invocations
  }

  async dial() {
    if (this.#closed) throw PrivateRouteError.ROUTE_UNAVAILABLE()
    this.#invocations++
    let socket = null
    const payload = b4a.from(this.#payload)
    try {
      const udx = this.#adapter.create()
      if (!udx || typeof udx.createSocket !== 'function') invalid()
      socket = udx.createSocket()
      if (
        !socket ||
        typeof socket.bind !== 'function' ||
        typeof socket.send !== 'function' ||
        typeof socket.close !== 'function'
      ) {
        invalid()
      }
      this.#sockets.add(socket)
      socket.bind(this.#bind.port, this.#bind.host)
      const sent = await socket.send(payload, this.#target.port, this.#target.host)
      if (sent !== true) throw PrivateRouteError.ROUTE_UNAVAILABLE()
      return true
    } catch {
      throw PrivateRouteError.ROUTE_UNAVAILABLE()
    } finally {
      payload.fill(0)
      if (socket) {
        this.#sockets.delete(socket)
        try {
          await socket.close()
        } catch {}
      }
    }
  }

  async close() {
    if (this.#closed) return false
    this.#closed = true
    this.#payload.fill(0)
    const closing = []
    for (const socket of this.#sockets) {
      try {
        closing.push(Promise.resolve(socket.close()))
      } catch {}
    }
    this.#sockets.clear()
    await Promise.allSettled(closing)
    return true
  }
}

export class NegativeControlListener {
  #adapter
  #bind
  #expectedSourceHost
  #payload
  #schedule
  #cancel
  #timeout
  #socket = null
  #timer = null
  #state = 'new'
  #received
  #resolve
  #reject

  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) invalid()
    const adapter = options.adapter || new UdxAdapter()
    if (
      !adapter ||
      typeof adapter.create !== 'function' ||
      typeof options.expectedSourceHost !== 'string' ||
      !b4a.isBuffer(options.payload) ||
      options.payload.byteLength < 1 ||
      options.payload.byteLength > 1_200 ||
      typeof options.schedule !== 'function' ||
      typeof options.cancel !== 'function' ||
      !Number.isSafeInteger(options.timeout) ||
      options.timeout < 1 ||
      options.timeout > 10_000
    ) {
      invalid()
    }
    endpoint({ host: options.expectedSourceHost, port: 1 })
    this.#adapter = adapter
    this.#bind = endpoint(options.bind)
    this.#expectedSourceHost = options.expectedSourceHost
    this.#payload = b4a.from(options.payload)
    this.#schedule = options.schedule
    this.#cancel = options.cancel
    this.#timeout = options.timeout
    this.#received = new Promise((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
    })
    void this.#received.catch(() => {})
  }

  #settle(error, value = null) {
    if (this.#state !== 'open') return false
    this.#state = error ? 'failed' : 'received'
    if (this.#timer !== null) {
      try {
        this.#cancel(this.#timer)
      } catch {}
      this.#timer = null
    }
    if (error) this.#reject(error)
    else this.#resolve(value)
    return true
  }

  async start() {
    if (this.#state !== 'new') throw PrivateRouteError.ROUTE_UNAVAILABLE()
    try {
      const udx = this.#adapter.create()
      if (!udx || typeof udx.createSocket !== 'function') invalid()
      const socket = udx.createSocket()
      if (
        !socket ||
        typeof socket.on !== 'function' ||
        typeof socket.bind !== 'function' ||
        typeof socket.close !== 'function'
      ) {
        invalid()
      }
      this.#socket = socket
      this.#state = 'open'
      socket.on('message', (packet, from) => {
        if (
          !b4a.isBuffer(packet) ||
          !b4a.equals(packet, this.#payload) ||
          !from ||
          from.host !== this.#expectedSourceHost ||
          !Number.isSafeInteger(from.port)
        ) {
          this.#settle(PrivateRouteError.ROUTE_UNAVAILABLE())
          return
        }
        this.#settle(null, Object.freeze({ bytes: packet.byteLength, sourcePort: from.port }))
      })
      socket.bind(this.#bind.port, this.#bind.host)
      this.#timer = this.#schedule(
        () => this.#settle(PrivateRouteError.ROUTE_UNAVAILABLE()),
        this.#timeout
      )
      if (this.#timer === null || this.#timer === undefined) invalid()
      return true
    } catch {
      const error = PrivateRouteError.ROUTE_UNAVAILABLE()
      if (this.#state === 'open') this.#settle(error)
      else {
        this.#state = 'failed'
        this.#reject(error)
      }
      const socket = this.#socket
      this.#socket = null
      this.#payload.fill(0)
      if (socket) {
        try {
          await socket.close()
        } catch {}
      }
      throw error
    }
  }

  wait() {
    return this.#received
  }

  async close() {
    if (this.#state === 'closed') return false
    if (this.#state === 'open') this.#settle(PrivateRouteError.ROUTE_UNAVAILABLE())
    this.#state = 'closed'
    this.#payload.fill(0)
    const socket = this.#socket
    this.#socket = null
    if (socket) {
      try {
        await socket.close()
      } catch {}
    }
    return true
  }
}

function cliPort(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,5}$/.test(value)) invalid()
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) invalid()
  return port
}

function cliPayload(value) {
  if (
    typeof value !== 'string' ||
    value.length < 2 ||
    value.length > 2_400 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(value)
  ) {
    invalid()
  }
  return b4a.from(value, 'hex')
}

export async function runNegativeControlCli(options = {}) {
  const argv = options.argv || globalThis.process?.argv?.slice(2)
  const stdout = options.stdout || globalThis.process?.stdout
  if (!Array.isArray(argv) || !stdout || typeof stdout.write !== 'function') invalid()
  const adapter = options.adapter || new UdxAdapter()
  if (argv[0] === 'dial' && argv.length === 6) {
    const payload = cliPayload(argv[5])
    const dialer = new NegativeControlDialer({
      bind: { host: argv[1], port: cliPort(argv[2]) },
      target: { host: argv[3], port: cliPort(argv[4]) },
      payload,
      adapter
    })
    payload.fill(0)
    try {
      await dialer.dial()
      stdout.write(`{"event":"sent","invocations":${dialer.invocations}}\n`)
      return true
    } finally {
      await dialer.close()
    }
  }
  if (argv[0] === 'listen' && argv.length === 5) {
    const payload = cliPayload(argv[4])
    const listener = new NegativeControlListener({
      bind: { host: argv[1], port: cliPort(argv[2]) },
      expectedSourceHost: argv[3],
      payload,
      adapter,
      schedule: options.schedule || setTimeout,
      cancel: options.cancel || clearTimeout,
      timeout: options.timeout || 5_000
    })
    payload.fill(0)
    try {
      await listener.start()
      stdout.write('{"event":"ready"}\n')
      const received = await listener.wait()
      stdout.write(
        `{"event":"received","bytes":${received.bytes},"sourcePort":${received.sourcePort}}\n`
      )
      return true
    } finally {
      await listener.close()
    }
  }
  invalid()
}

if (import.meta.main) {
  void runNegativeControlCli().catch(() => {
    globalThis.process.stderr.write('negative control failed\n')
    globalThis.process.exitCode = 1
  })
}
