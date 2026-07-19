import Protomux from 'protomux'

import {
  PIN_REQUEST_ENCODING,
  PIN_RESPONSE_ENCODING,
  SEED_PIN_ERROR_CODES,
  SEED_PIN_PROTOCOL,
  SEED_PIN_PROTOCOL_VERSION,
  MAX_STATUS_EXPIRY_WINDOW_MS,
  STATUS_REQUEST_ENCODING,
  STATUS_RESPONSE_ENCODING,
  createSeedPinStatusRequest,
  isInvalidSeedPinWireMessage,
} from './protocol.js'

const DEFAULT_REQUEST_TIMEOUT = 10_000
const DEFAULT_STATUS_TTL = 60_000
const MAX_RESUME_REQUESTS = 256
export const MAX_TIMER_DELAY_MS = 0x7fffffff

export class SeedPinProtocolError extends Error {
  constructor (code, message) {
    super(message || code)
    this.name = 'SeedPinProtocolError'
    this.code = code
    this.retryable = code === SEED_PIN_ERROR_CODES.BUSY ||
      code === SEED_PIN_ERROR_CODES.CAPACITY_EXCEEDED ||
      code === SEED_PIN_ERROR_CODES.WORKER_UNAVAILABLE ||
      code === SEED_PIN_ERROR_CODES.INTERNAL
  }
}

export class SeedPinTransportError extends Error {
  constructor (code, message) {
    super(message || code)
    this.name = 'SeedPinTransportError'
    this.code = code
    this.retryable = true
  }
}

export class SeedPinClient {
  constructor (streamOrMux, options = {}) {
    this.mux = Protomux.from(streamOrMux)
    this.identityPublicKey = options.identityPublicKey
    this.deviceKeyPair = options.deviceKeyPair
    this.deviceProof = options.deviceProof
    this.requestTimeout = normalizeBoundedPositiveInteger(
      options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT,
      'requestTimeout',
      MAX_TIMER_DELAY_MS,
    )
    this.statusTtl = normalizeBoundedPositiveInteger(
      options.statusTtl ?? DEFAULT_STATUS_TTL,
      'statusTtl',
      MAX_STATUS_EXPIRY_WINDOW_MS,
    )
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.pending = new Map()
    this.nextCorrelationId = 1
    this.closed = false

    this._onTransportCloseBound = this._onTransportClose.bind(this)
    this._onTransportErrorBound = this._onTransportError.bind(this)
    this.mux.stream.on('close', this._onTransportCloseBound)
    this.mux.stream.on('end', this._onTransportCloseBound)
    this.mux.stream.on('error', this._onTransportErrorBound)

    this.channel = this.mux.createChannel({
      protocol: SEED_PIN_PROTOCOL,
      messages: [
        { encoding: PIN_REQUEST_ENCODING },
        { encoding: PIN_RESPONSE_ENCODING, onmessage: (message) => this._onResponse('pin', message) },
        { encoding: STATUS_REQUEST_ENCODING },
        { encoding: STATUS_RESPONSE_ENCODING, onmessage: (message) => this._onResponse('status', message) },
      ],
      onclose: () => this._onTransportClose(),
    })
    if (this.channel === null) {
      this._removeTransportListeners()
      throw new SeedPinTransportError('TRANSPORT_CLOSED', 'Seed pin protocol channel is unavailable')
    }
    this.pinMessage = this.channel.messages[0]
    this.statusMessage = this.channel.messages[2]
    this.channel.open()
  }

  get pendingCount () {
    return this.pending.size
  }

  opened () {
    return this.channel.fullyOpened()
  }

  pin (request, options = {}) {
    if (!request || typeof request !== 'object') {
      return Promise.reject(new TypeError('request is required'))
    }
    return this._call(this.pinMessage, 'pin', {
      version: SEED_PIN_PROTOCOL_VERSION,
      requestId: request.requestId,
      request,
    }, options.timeout)
  }

  status (requestId, options = {}) {
    const now = normalizeNonnegativeInteger(this.now(), 'now')
    const expiresAt = options.expiresAt ?? now + this.statusTtl
    const request = createSeedPinStatusRequest({
      requestId,
      expiresAt,
      identityPublicKey: this.identityPublicKey,
      deviceKeyPair: this.deviceKeyPair,
      deviceProof: this.deviceProof,
    })
    return this._call(this.statusMessage, 'status', {
      version: SEED_PIN_PROTOCOL_VERSION,
      requestId,
      request,
    }, options.timeout)
  }

  resume (requestIds, options = {}) {
    if (!Array.isArray(requestIds)) return Promise.reject(new TypeError('requestIds must be an array'))
    if (requestIds.length > MAX_RESUME_REQUESTS) {
      return Promise.reject(new RangeError(`requestIds cannot contain more than ${MAX_RESUME_REQUESTS} entries`))
    }
    return Promise.all(requestIds.map((requestId) => this.status(requestId, options)))
  }

  close () {
    if (this.closed) return
    this.closed = true
    this._removeTransportListeners()
    this._rejectAll(new SeedPinTransportError('TRANSPORT_CLOSED', 'Seed pin transport closed'))
    this.channel.close()
  }

  _call (messageType, kind, body, timeout) {
    if (this.closed || this.channel.closed || this.mux.stream.destroyed) {
      return Promise.reject(new SeedPinTransportError('TRANSPORT_CLOSED', 'Seed pin transport is closed'))
    }
    const requestTimeout = normalizeBoundedPositiveInteger(
      timeout ?? this.requestTimeout,
      'timeout',
      MAX_TIMER_DELAY_MS,
    )
    const correlationId = this._allocateCorrelationId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(correlationId)) return
        reject(new SeedPinTransportError('TIMEOUT', 'Seed pin request timed out'))
      }, requestTimeout)
      this.pending.set(correlationId, {
        requestId: body.requestId,
        kind,
        resolve,
        reject,
        timer,
      })
      try {
        const sent = messageType.send({ ...body, correlationId })
        if (sent === false && (this.channel.closed || this.mux.stream.destroyed)) {
          this._rejectPending(correlationId, new SeedPinTransportError(
            'TRANSPORT_CLOSED',
            'Seed pin transport closed before send',
          ))
        }
      } catch (error) {
        this._rejectPending(correlationId, error)
      }
    })
  }

  _allocateCorrelationId () {
    const start = this.nextCorrelationId
    do {
      const candidate = this.nextCorrelationId
      this.nextCorrelationId = candidate === Number.MAX_SAFE_INTEGER ? 1 : candidate + 1
      if (!this.pending.has(candidate)) return candidate
    } while (this.nextCorrelationId !== start)
    throw new SeedPinTransportError('TRANSPORT_BUSY', 'No seed pin correlation IDs are available')
  }

  _onResponse (kind, message) {
    if (isInvalidSeedPinWireMessage(message)) return
    const pending = this.pending.get(message.correlationId)
    if (!pending || pending.kind !== kind || pending.requestId !== message.requestId) return
    this.pending.delete(message.correlationId)
    clearTimeout(pending.timer)
    if (message.ok) {
      if (message.code !== null || message.error !== null || message.status === null ||
          message.status.requestId !== message.requestId) {
        pending.reject(new SeedPinTransportError('INVALID_RESPONSE', 'Seed pin response was invalid'))
        return
      }
      pending.resolve(message.status)
      return
    }
    if (message.code === null || message.error === null || message.status !== null) {
      pending.reject(new SeedPinTransportError('INVALID_RESPONSE', 'Seed pin response was invalid'))
      return
    }
    pending.reject(new SeedPinProtocolError(message.code, message.error))
  }

  _rejectPending (correlationId, error) {
    const pending = this.pending.get(correlationId)
    if (!pending) return
    this.pending.delete(correlationId)
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  _rejectAll (error) {
    for (const [correlationId, pending] of this.pending) {
      this.pending.delete(correlationId)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  _onTransportError () {
    this._onTransportClose()
  }

  _onTransportClose () {
    if (this.closed) return
    this.closed = true
    this._removeTransportListeners()
    this._rejectAll(new SeedPinTransportError('TRANSPORT_CLOSED', 'Seed pin transport disconnected'))
  }

  _removeTransportListeners () {
    this.mux.stream.off('close', this._onTransportCloseBound)
    this.mux.stream.off('end', this._onTransportCloseBound)
    this.mux.stream.off('error', this._onTransportErrorBound)
  }
}

function normalizeNonnegativeInteger (value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative safe integer`)
  }
  return value
}
function normalizeBoundedPositiveInteger (value, name, max) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${max}`)
  }
  return value
}
