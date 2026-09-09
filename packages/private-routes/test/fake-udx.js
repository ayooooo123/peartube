import b4a from 'b4a'

export class FakeUdxAdapter {
  constructor(options = {}) {
    this.options = options
    this.instances = 0
    this.sockets = []
  }

  create() {
    this.instances++
    const socket = new FakeUdxSocket(this.options)
    this.sockets.push(socket)
    return {
      createSocket: () => socket
    }
  }
}

class FakeUdxSocket {
  constructor(options) {
    this.options = options
    this.binds = []
    this.sends = []
    this.closeCalls = 0
    this.closed = false
    this.listeners = new Map()
  }

  on(name, listener) {
    this.listeners.set(name, listener)
    return this
  }

  bind(port, host) {
    this.binds.push({ port, host })
    if (this.options.bindError) throw this.options.bindError
  }

  send(packet, port, host) {
    const call = { packet: b4a.from(packet), port, host }
    this.sends.push(call)
    if (this.options.send) return this.options.send(call, this)
    return Promise.resolve(true)
  }

  emitMessage(packet, host, port, family = 4) {
    const listener = this.listeners.get('message')
    if (listener) listener(b4a.from(packet), { host, port, family })
  }

  emitError(error) {
    const listener = this.listeners.get('error')
    if (listener) listener(error)
  }

  async close() {
    this.closeCalls++
    if (this.options.close) await this.options.close(this)
    this.closed = true
  }
}
