const EventEmitter = require('bare-events')
const net = require('bare-net')
const tls = require('bare-tls')

class TLSNetSocket extends tls.Socket {
  ref() {
    this.socket.ref()
  }

  unref() {
    this.socket.unref()
  }
}

class TLSNetServer extends EventEmitter {
  constructor(opts = {}, onconnection) {
    if (typeof opts === 'function') {
      onconnection = opts
      opts = {}
    }

    const {
      cert = null,
      key = null,
      host = null,
      eagerOpen = true,
      allowHalfOpen = true
    } = opts

    super()

    this._opts = {
      cert,
      key,
      host,
      eagerOpen,
      allowHalfOpen
    }

    this._server = net.createServer(opts)
    this._server
      .on('listening', this._onlistening.bind(this))
      .on('connection', this._onconnection.bind(this))
      .on('error', this._onerror.bind(this))
      .on('close', this._onclose.bind(this))

    if (onconnection) this.on('connection', onconnection)
  }

  get listening() {
    return this._server.listening
  }

  address() {
    return this._server.address()
  }

  listen(...args) {
    this._server.listen(...args)
    return this
  }

  close(onclose) {
    if (onclose) this.once('close', onclose)
    this._server.close()
  }

  ref() {
    this._server.ref()
  }

  unref() {
    this._server.unref()
  }

  _onlistening() {
    this.emit('listening')
  }

  _onconnection(socket) {
    this.emit(
      'connection',
      new TLSNetSocket(socket, { ...this._opts, isServer: true })
    )
  }

  _onerror(err) {
    this.emit('error', err)
  }

  _onclose() {
    this.emit('close')
  }
}

exports.createConnection = function createConnection(...args) {
  let opts = {}
  let onconnect

  if (typeof args[0] === 'string') {
    // createConnection(path[, onconnect])
    opts.path = args[0]
    onconnect = args[1]
  } else if (typeof args[0] === 'number') {
    // createConnection(port[, host][, onconnect])
    opts.port = args[0]

    if (typeof args[1] === 'function') {
      onconnect = args[1]
    } else {
      opts.host = args[1]
      onconnect = args[2]
    }
  } else {
    // createConnection(opts[, onconnect])
    opts = args[0] || {}
    onconnect = args[1]
  }

  return new TLSNetSocket(net.createConnection(opts, onconnect), opts)
}

exports.createServer = function createServer(opts, onconnection) {
  return new TLSNetServer(opts, onconnection)
}
