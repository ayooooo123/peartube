const { Duplex } = require('bare-stream')
const binding = require('./binding')
const constants = require('./lib/constants')
const errors = require('./lib/errors')

const readBufferSize = 65536

const context = binding.context()

exports.Socket = class TLSSocket extends Duplex {
  static _buffer = Buffer.alloc(readBufferSize)

  constructor(socket, opts = {}) {
    const {
      isServer = false,
      cert = null,
      key = null,
      host = null,
      eagerOpen = true,
      allowHalfOpen = true
    } = opts

    super({ eagerOpen })

    this._state = 0

    this._socket = socket
    this._key = key
    this._cert = cert
    this._allowHalfOpen = allowHalfOpen

    this._pendingOpen = null
    this._pendingWrite = null

    this._buffer = []
    this._buffered = 0

    this._handle = binding.init(
      context,
      isServer,
      cert,
      key,
      host,
      this,
      this._onread,
      this._onwrite
    )
  }

  get socket() {
    return this._socket
  }

  get encrypted() {
    return true
  }

  _onconnect() {
    this._state |= constants.state.HANDSHAKE

    this.emit('connect')

    const cb = this._pendingOpen
    this._pendingOpen = null
    cb(null)
  }

  _ondata(data) {
    this._buffer.push(data)
    this._buffered += data.byteLength

    while (this._buffered > 0) {
      if (this._state & constants.state.HANDSHAKE) {
        let read
        try {
          read = binding.read(this._handle, TLSSocket._buffer)
        } catch (err) {
          return this.destroy(errors.from(err))
        }

        if (read < 0) break

        if (read === 0) {
          this.push(null)
          if (this._allowHalfOpen === false) this.end()
          return
        }

        const copy = Buffer.allocUnsafe(read)
        copy.set(TLSSocket._buffer.subarray(0, read))

        this.push(copy)
      } else {
        try {
          if (binding.handshake(this._handle)) this._onconnect()
          else break
        } catch (err) {
          if (this._pendingOpen) this._pendingOpen(errors.from(err))
          else this.destroy(errors.from(err))
          return
        }
      }
    }
  }

  _ondrain() {
    const cb = this._pendingWrite
    this._pendingWrite = null
    if (cb) cb(null)
  }

  _onend() {
    this.push(null)
  }

  _onerror(err) {
    this.destroy(err)
  }

  _onread(data) {
    if (this._buffered < data.byteLength) return 0

    const buffer =
      this._buffer.length === 1 ? this._buffer[0] : Buffer.concat(this._buffer)

    data.set(buffer.subarray(0, data.byteLength))

    this._buffered -= data.byteLength
    this._buffer = this._buffered > 0 ? [buffer.subarray(data.byteLength)] : []

    return data.byteLength
  }

  _onwrite(data) {
    if (this._socket.write(Buffer.from(data))) this._pendingWrite = null

    return data.byteLength
  }

  _attach() {
    this._ondata = this._ondata.bind(this)
    this._ondrain = this._ondrain.bind(this)
    this._onend = this._onend.bind(this)
    this._onerror = this._onerror.bind(this)

    this._socket
      .on('data', this._ondata)
      .on('drain', this._ondrain)
      .on('end', this._onend)
      .on('error', this._onerror)
  }

  _detach() {
    this._socket
      .off('data', this._ondata)
      .off('drain', this._ondrain)
      .off('end', this._onend)
      .off('error', this._onerror)
  }

  _open(cb) {
    this._pendingOpen = cb
    this._attach()

    try {
      if (binding.handshake(this._handle)) this._onconnect()
    } catch (err) {
      this._pendingOpen = null

      cb(errors.from(err))
    }
  }

  _write(data, encoding, cb) {
    this._pendingWrite = cb

    try {
      binding.write(this._handle, data)

      if (this._pendingWrite !== null) return

      cb(null)
    } catch (err) {
      this._pendingWrite = null

      cb(errors.from(err))
    }
  }

  _final(cb) {
    try {
      binding.shutdown(this._handle)

      cb(null)
    } catch (err) {
      cb(err)
    }

    this._socket.end()
  }

  _predestroy() {
    this._detach()
    binding.destroy(this._handle)
    this._handle = null
  }

  _destroy(err, cb) {
    this._detach()
    if (this._handle) {
      binding.destroy(this._handle)
      this._handle = null
    }
    cb(err)
  }
}

exports.TLSSocket = exports.Socket // For Node.js compatibility

exports.constants = constants
exports.errors = errors

const net = require('./net')

exports.createConnection = net.createConnection
exports.createServer = net.createServer

// For Node.js compatibility
exports.connect = exports.createConnection
