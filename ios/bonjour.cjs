const EventEmitter = require('bare-events')

// iOS resolves the two declared service types through the system Bonjour daemon.
// This implements the BonjourAdapter dependency without a multicast entitlement.
let next = 0
const handles = new Map()
const send = msg => Bare.IPC.write(JSON.stringify({ event: 'bonjour', ...msg }) + '\n')
Bare.on('appEvent', msg => {
  if (msg.event !== 'bonjour') return
  const handle = handles.get(msg.handle)
  if (!handle) return
  if (msg.action === 'error') handle.owner.onError(new Error(msg.error))
  else if (msg.action === 'up' || msg.action === 'down') handle.emit(msg.action, msg.service)
})

class Handle extends EventEmitter {
  constructor (owner, operation, record) {
    super()
    this.owner = owner
    this.id = ++next
    this.stopped = false
    handles.set(this.id, this)
    owner.handles.add(this)
    send({ operation, handle: this.id, record })
  }

  stop (callback) {
    if (!this.stopped) {
      this.stopped = true
      handles.delete(this.id)
      this.owner.handles.delete(this)
      send({ operation: 'stop', handle: this.id })
    }
    callback?.()
  }
}

class Bonjour {
  constructor (options, onError = () => {}) {
    this.onError = onError
    this.handles = new Set()
  }

  publish (record) { return new Handle(this, 'publish', record) }

  find (query, callback) {
    const browser = new Handle(this, 'browse', query)
    if (callback) browser.on('up', callback)
    return browser
  }

  unpublishAll (callback) {
    for (const handle of [...this.handles]) handle.stop()
    callback?.()
  }

  destroy (callback) { this.unpublishAll(callback) }
}
module.exports = { Bonjour, default: Bonjour }
