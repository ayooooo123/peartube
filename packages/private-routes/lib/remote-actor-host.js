import b4a from 'b4a'

import {
  bindRemoteRegistrationVerifier,
  bindRemoteActivationVerifier,
  createActorCommandAdapter,
  destroyRemoteRegistrationVerifier,
  destroyRemoteActivationVerifier,
  validateActorCommandReplyBody,
  verifyRemoteRegistrationReply,
  verifyRemoteActivationReply
} from './activation.js'
import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import {
  ACTOR_CONTROL_BODY_MAX,
  ACTOR_CONTROL_KIND,
  ACTOR_ERROR_CODE,
  ActorControlCodec,
  readAuthenticatedRemoteActorEvent,
  validateActorReply
} from './remote-control.js'
import { DIRECTION } from './protocol.js'

export const REMOTE_ACTOR_DEADLINE = 5_000
export const DEFAULT_MAX_REMOTE_ACTORS = 128
export const DEFAULT_MAX_REMOTE_PENDING = 64
export const DEFAULT_MAX_REMOTE_REPLAYS = 64
export const DEFAULT_MAX_REMOTE_TOMBSTONES = 64

const MAX_UINT64 = (1n << 64n) - 1n
const ACTOR_HANDLES = new WeakMap()
const REMOTE_ACTOR_HOSTS = new WeakSet()
const REMOTE_ACTOR_DISPATCH = new WeakMap()
const REMOTE_ACTOR_FORWARD_DISPATCH = new WeakMap()
const REMOTE_ACTOR_TEST_DOUBLES = new WeakSet()
const FORWARDED_REQUEST = Symbol('forwarded-remote-actor-request')
const FORWARDED_AUTHORITY = Object.freeze({})
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const bufferByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get
const bufferFill = Uint8Array.prototype.fill
const bufferSet = Uint8Array.prototype.set
const REQUEST_KINDS = new Set([
  ACTOR_CONTROL_KIND.REGISTER_STAGE,
  ACTOR_CONTROL_KIND.REGISTER_PREPARE,
  ACTOR_CONTROL_KIND.REGISTER_FINALIZE,
  ACTOR_CONTROL_KIND.REGISTER_ABORT,
  ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
  ACTOR_CONTROL_KIND.CIRCUIT_DESTROY
])
const REPLY_KINDS = new Set([
  ACTOR_CONTROL_KIND.REGISTER_STAGED,
  ACTOR_CONTROL_KIND.REGISTER_PREPARED,
  ACTOR_CONTROL_KIND.REGISTER_FINALIZED,
  ACTOR_CONTROL_KIND.REGISTER_ABORTED,
  ACTOR_CONTROL_KIND.ACTIVATE_CREATED,
  ACTOR_CONTROL_KIND.CIRCUIT_DESTROYED,
  ACTOR_CONTROL_KIND.ERROR
])

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function unavailable() {
  return PrivateRouteError.ROUTE_UNAVAILABLE()
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function length(value) {
  try {
    return b4a.isBuffer(value) ? bufferByteLength.call(value) : -1
  } catch {
    return -1
  }
}

function fixed(value, size) {
  return length(value) === size
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) bufferFill.call(value, 0)
  } catch {}
}

function copy(value) {
  const size = length(value)
  if (size < 0) invalid()
  let output = null
  try {
    output = b4a.allocUnsafeSlow(size)
    bufferSet.call(output, value)
    return output
  } catch {
    clear(output)
    invalid()
  }
}

function same(left, right) {
  try {
    return length(left) >= 0 && length(left) === length(right) && b4a.equals(left, right)
  } catch {
    return false
  }
}

function allZero(value) {
  if (!b4a.isBuffer(value)) return false
  for (const byte of value) if (byte !== 0) return false
  return true
}

function hex(value) {
  try {
    return b4a.toString(value, 'hex')
  } catch {
    invalid()
  }
}

function bound(value, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback) invalid()
  return value
}

function errorCode(error) {
  if (!(error instanceof PrivateRouteError)) return ACTOR_ERROR_CODE.ROUTE_UNAVAILABLE
  switch (error.code) {
    case 'UNAUTHORIZED':
      return ACTOR_ERROR_CODE.UNAUTHORIZED
    case 'CIRCUIT_LIMIT':
      return ACTOR_ERROR_CODE.CIRCUIT_LIMIT
    case 'CIRCUIT_STATE':
      return ACTOR_ERROR_CODE.CIRCUIT_STATE
    default:
      return ACTOR_ERROR_CODE.ROUTE_UNAVAILABLE
  }
}

function remoteError(code) {
  switch (code) {
    case ACTOR_ERROR_CODE.UNAUTHORIZED:
      return PrivateRouteError.UNAUTHORIZED()
    case ACTOR_ERROR_CODE.CIRCUIT_LIMIT:
      return PrivateRouteError.CIRCUIT_LIMIT()
    case ACTOR_ERROR_CODE.CIRCUIT_STATE:
      return PrivateRouteError.CIRCUIT_STATE()
    case ACTOR_ERROR_CODE.ROUTE_UNAVAILABLE:
    default:
      return unavailable()
  }
}

function digest(message) {
  const value = cryptoSuite.hash([message])
  if (!fixed(value, 32)) {
    clear(value)
    invalid()
  }
  return value
}

function readRequestId(bytes) {
  if (!fixed(bytes, 8)) invalid()
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

function queue(sendControl, message) {
  let accepted
  try {
    accepted = sendControl(message)
  } catch {
    throw unavailable()
  }
  if (accepted !== true) throw unavailable()
}

function clearMessage(value) {
  if (!value) return
  clear(value.actorId)
  clear(value.circuitId)
  clear(value.body)
}

function destroyVerifier(value) {
  destroyRemoteRegistrationVerifier(value)
  destroyRemoteActivationVerifier(value)
}

export class RemoteActorHost {
  #sendControl
  #control
  #now
  #randomBytes
  #schedule
  #cancel
  #maxActors
  #maxPending
  #maxReplay
  #maxTombstones
  #codec = new ActorControlCodec()
  #actors = new Map()
  #actorCapabilities = new WeakSet()
  #pending = new Map()
  #inbound = new Map()
  #replay = new Map()
  #tombstones = new Map()
  #destroyed = false
  #busy = false
  #lastNow = null
  #ownedBytes = 0

  constructor(options = {}) {
    if (!isObject(options)) invalid()
    const { control, sendControl, now, randomBytes, schedule, cancel } = options
    if (
      !isObject(control) ||
      typeof sendControl !== 'function' ||
      typeof now !== 'function' ||
      typeof randomBytes !== 'function' ||
      typeof schedule !== 'function' ||
      typeof cancel !== 'function'
    ) {
      invalid()
    }
    this.#control = control
    this.#sendControl = sendControl
    this.#now = now
    this.#randomBytes = randomBytes
    this.#schedule = schedule
    this.#cancel = cancel
    this.#maxActors = bound(options.maxActors, DEFAULT_MAX_REMOTE_ACTORS)
    this.#maxPending = bound(options.maxPending, DEFAULT_MAX_REMOTE_PENDING)
    this.#maxReplay = bound(options.maxReplay, DEFAULT_MAX_REMOTE_REPLAYS)
    this.#maxTombstones = bound(options.maxTombstones, DEFAULT_MAX_REMOTE_TOMBSTONES)
    REMOTE_ACTOR_HOSTS.add(this)
    REMOTE_ACTOR_DISPATCH.set(this, (...args) => genuineRemoteActorRequest.call(this, ...args))
    REMOTE_ACTOR_FORWARD_DISPATCH.set(this, (kind, actorId, circuitId, generation, body) =>
      genuineRemoteActorRequest.call(this, kind, actorId, circuitId, generation, body, {
        [FORWARDED_REQUEST]: FORWARDED_AUTHORITY
      })
    )
  }

  get stats() {
    return Object.freeze({
      actors: this.#actors.size,
      pending: this.#pending.size,
      inbound: this.#inbound.size,
      replay: this.#replay.size,
      tombstones: this.#tombstones.size,
      ownedBytes: this.#ownedBytes,
      timers: Array.from(this.#pending.values()).filter((record) => record.timer !== null).length,
      destroyed: this.#destroyed
    })
  }

  register(actorId, actor) {
    if (this.#destroyed) throw PrivateRouteError.CIRCUIT_STATE()
    if (this.#busy) {
      this.#failClosed()
      throw PrivateRouteError.CIRCUIT_STATE()
    }
    this.#busy = true
    try {
      if (!fixed(actorId, 16) || allZero(actorId)) invalid()
      const key = hex(actorId)
      if (this.#actors.has(key)) throw PrivateRouteError.CIRCUIT_STATE()
      if (this.#actors.size >= this.#maxActors) throw PrivateRouteError.CIRCUIT_LIMIT()
      if (isObject(actor) && this.#actorCapabilities.has(actor)) {
        throw PrivateRouteError.CIRCUIT_STATE()
      }
      const handle = Object.freeze({})
      const id = copy(actorId)
      try {
        const adapter = createActorCommandAdapter(actor)
        this.#actors.set(key, { id, adapter, handle })
        this.#actorCapabilities.add(actor)
        ACTOR_HANDLES.set(handle, this)
        return handle
      } catch (err) {
        clear(id)
        throw err
      }
    } finally {
      this.#busy = false
    }
  }

  receiveAuthenticated(event) {
    if (this.#destroyed) return Promise.reject(PrivateRouteError.CIRCUIT_STATE())
    if (this.#busy) {
      this.#failClosed()
      return Promise.reject(PrivateRouteError.CIRCUIT_STATE())
    }
    this.#busy = true
    let decoded = null
    let authenticated = null
    try {
      authenticated = readAuthenticatedRemoteActorEvent(event, this.#control)
      const message = authenticated.message
      decoded = this.#codec.decode(message)
      const expectedDirection = REQUEST_KINDS.has(decoded.kind)
        ? DIRECTION.FORWARD
        : DIRECTION.REVERSE
      if (authenticated.direction !== expectedDirection) invalid()
      if (REQUEST_KINDS.has(decoded.kind)) return this.#receiveRequest(message, decoded)
      if (REPLY_KINDS.has(decoded.kind)) return this.#receiveReply(message, decoded)
      invalid()
    } catch (err) {
      const hadPending = this.#pending.size > 0
      if (hadPending) this.#failClosed()
      return Promise.reject(hadPending ? unavailable() : err)
    } finally {
      clearMessage(decoded)
      if (authenticated) {
        clear(authenticated.message)
        clear(authenticated.circuitId)
      }
      this.#busy = false
    }
  }

  request(kind, actorId, circuitId, generation, body, options = {}) {
    if (this.#destroyed) return Promise.reject(PrivateRouteError.CIRCUIT_STATE())
    if (
      !REQUEST_KINDS.has(kind) ||
      !fixed(actorId, 16) ||
      allZero(actorId) ||
      !fixed(circuitId, 16) ||
      typeof generation !== 'bigint' ||
      generation < 0n ||
      generation > MAX_UINT64 ||
      length(body) < 0 ||
      length(body) > ACTOR_CONTROL_BODY_MAX ||
      !isObject(options)
    ) {
      return Promise.reject(PrivateRouteError.INVALID_ROUTE())
    }
    if (this.#busy) {
      this.#failClosed()
      return Promise.reject(PrivateRouteError.CIRCUIT_STATE())
    }
    if (this.#pending.size >= this.#maxPending || this.#tombstones.size >= this.#maxTombstones) {
      return Promise.reject(PrivateRouteError.CIRCUIT_LIMIT())
    }
    this.#busy = true
    let request = null
    let encoded = null
    let requestDigest = null
    let record = null
    let promise = null
    let verifier = null
    let verifierBound = false
    try {
      const now = this.#readNow()
      if (this.#destroyed) throw PrivateRouteError.CIRCUIT_STATE()
      const deadline =
        options.deadline === undefined ? now + REMOTE_ACTOR_DEADLINE : options.deadline
      if (
        !Number.isSafeInteger(deadline) ||
        deadline <= now ||
        deadline > now + REMOTE_ACTOR_DEADLINE
      ) {
        invalid()
      }
      const forwarded = options[FORWARDED_REQUEST] === FORWARDED_AUTHORITY
      const registrationVerifier = options.registrationVerifier
      const activationVerifier = options.activationVerifier
      if (
        (kind === ACTOR_CONTROL_KIND.REGISTER_STAGE &&
          !forwarded &&
          !isObject(registrationVerifier)) ||
        (kind !== ACTOR_CONTROL_KIND.REGISTER_STAGE && registrationVerifier !== undefined) ||
        (kind === ACTOR_CONTROL_KIND.ACTIVATE_CREATE &&
          !forwarded &&
          !isObject(activationVerifier)) ||
        (kind !== ACTOR_CONTROL_KIND.ACTIVATE_CREATE && activationVerifier !== undefined)
      )
        invalid()
      verifier = registrationVerifier || activationVerifier
      const requestId = this.#requestId()
      if (this.#destroyed) throw PrivateRouteError.CIRCUIT_STATE()
      if (kind === ACTOR_CONTROL_KIND.REGISTER_STAGE && !forwarded) {
        bindRemoteRegistrationVerifier(verifier, body)
        verifierBound = true
      } else if (kind === ACTOR_CONTROL_KIND.ACTIVATE_CREATE && !forwarded) {
        bindRemoteActivationVerifier(verifier, body, circuitId, generation)
        verifierBound = true
      }
      request = {
        version: 0,
        kind,
        flags: 0,
        requestId,
        actorId: copy(actorId),
        circuitId: copy(circuitId),
        generation,
        body: copy(body)
      }
      encoded = this.#codec.encode(request)
      requestDigest = digest(encoded)
      let resolve
      let reject
      promise = new Promise((res, rej) => {
        resolve = res
        reject = rej
      })
      record = {
        key: requestId.toString(),
        request,
        digest: requestDigest,
        deadline,
        timer: null,
        signal: null,
        removeAbort: null,
        abort: null,
        verifier,
        resolve,
        reject,
        settled: false
      }
      request = null
      requestDigest = null
      this.#pending.set(record.key, record)
      this.#ownedBytes += this.#recordBytes(record)
      this.#attachSignal(record, options.signal)
      if (record.settled || this.#destroyed) return promise
      this.#armTimer(record, deadline - now)
      if (record.settled || this.#destroyed) return promise
      queue(this.#sendControl, encoded)
      return promise
    } catch (err) {
      if (record) {
        if (!record.settled) {
          this.#dropPending(record, err instanceof PrivateRouteError ? err : unavailable())
        }
        return promise
      }
      if (verifierBound) destroyVerifier(verifier)
      return Promise.reject(err instanceof PrivateRouteError ? err : unavailable())
    } finally {
      clearMessage(request)
      clear(encoded)
      clear(requestDigest)
      this.#busy = false
    }
  }

  notify() {
    if (this.#destroyed) throw PrivateRouteError.CIRCUIT_STATE()
    // v0 defines no one-way actor kind. Request ID zero is therefore never
    // emitted until a future protocol version explicitly allowlists one.
    invalid()
  }

  destroy() {
    if (this.#destroyed) return
    this.#destroyed = true
    for (const record of Array.from(this.#pending.values())) {
      this.#dropPending(record, unavailable())
    }
    for (const record of this.#actors.values()) {
      try {
        record.adapter.destroy()
      } catch {}
      clear(record.id)
      ACTOR_HANDLES.delete(record.handle)
    }
    for (const record of this.#inbound.values()) clear(record.digest)
    for (const record of this.#replay.values()) {
      clear(record.digest)
      clear(record.reply)
    }
    for (const record of this.#tombstones.values()) this.#clearTombstone(record)
    this.#actors.clear()
    this.#actorCapabilities = new WeakSet()
    this.#pending.clear()
    this.#inbound.clear()
    this.#replay.clear()
    this.#tombstones.clear()
    this.#ownedBytes = 0
  }

  async #receiveRequest(message, request) {
    let requestDigest = null
    let reply = null
    let errorBody = null
    let key = null
    let record = null
    try {
      requestDigest = digest(message)
      key = request.requestId.toString()
      const active = this.#inbound.get(key)
      if (active) {
        if (!same(active.digest, requestDigest)) throw PrivateRouteError.REPLAY()
        return Promise.resolve(true)
      }
      const replay = this.#replay.get(key)
      if (replay) {
        if (!same(replay.digest, requestDigest)) throw PrivateRouteError.REPLAY()
        queue(this.#sendControl, replay.reply)
        return Promise.resolve(true)
      }
      if (this.#inbound.size >= this.#maxPending || this.#replay.size >= this.#maxReplay) {
        throw PrivateRouteError.CIRCUIT_LIMIT()
      }
      const actor = this.#actors.get(hex(request.actorId))
      record = { digest: copy(requestDigest), bytes: length(message) }
      this.#inbound.set(key, record)
      this.#ownedBytes += length(record.digest) + record.bytes
      try {
        if (!actor) throw unavailable()
        reply = await actor.adapter.execute(message)
      } catch (err) {
        if (this.#destroyed || this.#inbound.get(key) !== record) throw unavailable()
        errorBody = b4a.allocUnsafeSlow(33)
        errorBody[0] = errorCode(err)
        errorBody.set(requestDigest, 1)
        reply = this.#codec.encode({
          version: 0,
          kind: ACTOR_CONTROL_KIND.ERROR,
          flags: 0,
          requestId: request.requestId,
          actorId: request.actorId,
          circuitId: request.circuitId,
          generation: request.generation,
          body: errorBody
        })
      }
      if (this.#destroyed || this.#inbound.get(key) !== record) throw unavailable()
      const retainedReply = copy(reply)
      if (this.#destroyed || this.#inbound.get(key) !== record) {
        clear(retainedReply)
        throw unavailable()
      }
      this.#inbound.delete(key)
      this.#ownedBytes -= length(record.digest) + record.bytes
      this.#replay.set(key, { digest: record.digest, reply: retainedReply })
      this.#ownedBytes += length(record.digest) + length(retainedReply)
      record = null
      queue(this.#sendControl, reply)
      if (this.#destroyed || this.#replay.get(key)?.reply !== retainedReply) throw unavailable()
      return true
    } catch (err) {
      throw err instanceof PrivateRouteError ? err : unavailable()
    } finally {
      if (record && key !== null && this.#inbound.get(key) === record) {
        this.#inbound.delete(key)
        this.#ownedBytes -= length(record.digest) + record.bytes
        clear(record.digest)
      }
      clear(requestDigest)
      clear(reply)
      clear(errorBody)
    }
  }

  #receiveReply(message, reply) {
    const key = reply.requestId.toString()
    let record = this.#pending.get(key)
    let tombstone = this.#tombstones.get(key)
    if (!record && !tombstone) {
      this.#failClosed()
      return Promise.reject(unavailable())
    }
    let responseDigest = null
    let verified = null
    let body = null
    try {
      if (record) {
        const now = this.#readNow()
        if (this.#destroyed) throw unavailable()
        if (now >= record.deadline) {
          if (!this.#finishPending(record, unavailable(), null)) throw unavailable()
          record = null
          tombstone = this.#tombstones.get(key)
          if (!tombstone) throw unavailable()
        }
      }
      const expected = record || tombstone
      verified = validateActorReply(expected.request, reply, expected.digest)
      if (verified.kind !== ACTOR_CONTROL_KIND.ERROR) {
        validateActorCommandReplyBody(verified.kind, verified.body)
        if (record && verified.kind === ACTOR_CONTROL_KIND.REGISTER_STAGED && expected.verifier) {
          verifyRemoteRegistrationReply(expected.verifier, expected.request.body, verified.body)
          expected.verifier = null
        } else if (
          record &&
          verified.kind === ACTOR_CONTROL_KIND.ACTIVATE_CREATED &&
          expected.verifier
        ) {
          verifyRemoteActivationReply(
            expected.verifier,
            expected.request.body,
            expected.request.circuitId,
            expected.request.generation,
            verified.body
          )
          expected.verifier = null
        }
      }
      responseDigest = digest(message)
      if (tombstone) {
        if (tombstone.responseDigest && !same(tombstone.responseDigest, responseDigest)) {
          this.#failClosed()
          return Promise.reject(unavailable())
        }
        if (!tombstone.responseDigest) {
          tombstone.responseDigest = copy(responseDigest)
          this.#ownedBytes += length(responseDigest)
        }
        return Promise.resolve(true)
      }
      if (verified.kind === ACTOR_CONTROL_KIND.ERROR) {
        if (!this.#finishPending(record, remoteError(verified.body[0]), responseDigest)) {
          throw unavailable()
        }
      } else {
        body = copy(verified.body)
        if (!this.#finishPending(record, null, responseDigest, body)) throw unavailable()
        body = null
      }
      return Promise.resolve(true)
    } catch {
      this.#failClosed()
      return Promise.reject(unavailable())
    } finally {
      clear(responseDigest)
      clearMessage(verified)
      clear(body)
    }
  }

  #requestId() {
    for (let attempt = 0; attempt < 8; attempt++) {
      let bytes = null
      try {
        bytes = this.#randomBytes(8)
        const value = readRequestId(bytes)
        const key = value.toString()
        if (value !== 0n && !this.#pending.has(key) && !this.#tombstones.has(key)) return value
      } finally {
        clear(bytes)
      }
    }
    invalid()
  }

  #readNow() {
    let value
    try {
      value = this.#now()
    } catch {
      this.#failClosed()
      throw unavailable()
    }
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      (this.#lastNow !== null && value < this.#lastNow)
    ) {
      this.#failClosed()
      throw unavailable()
    }
    this.#lastNow = value
    return value
  }

  #armTimer(record, delay) {
    const timer = { handle: null, active: true, armed: false }
    record.timer = timer
    let handle
    try {
      handle = this.#schedule(delay, () => {
        if (!timer.armed) {
          this.#failClosed()
          return
        }
        this.#expire(record, timer)
      })
    } catch {
      record.timer = null
      this.#failClosed()
      throw unavailable()
    }
    timer.handle = handle
    if (handle === undefined || handle === null) {
      this.#failClosed()
      throw unavailable()
    }
    timer.armed = true
    if (this.#destroyed || record.settled || record.timer !== timer || !timer.active) {
      try {
        this.#cancel(handle)
      } catch {}
      this.#failClosed()
      throw unavailable()
    }
  }

  #expire(record, timer) {
    if (this.#destroyed || record.settled || record.timer !== timer || !timer.active) return
    let now
    try {
      now = this.#readNow()
    } catch {
      return
    }
    if (now < record.deadline) {
      timer.active = false
      record.timer = null
      try {
        this.#cancel(timer.handle)
        this.#armTimer(record, record.deadline - now)
      } catch {
        this.#failClosed()
      }
      return
    }
    timer.active = false
    record.timer = null
    this.#finishPending(record, unavailable(), null)
  }

  #attachSignal(record, signal) {
    if (signal === undefined) return
    if (!isObject(signal)) invalid()
    let add
    let remove
    let aborted
    try {
      add = signal.addEventListener
      remove = signal.removeEventListener
      aborted = signal.aborted
    } catch {
      invalid()
    }
    if (typeof add !== 'function' || typeof remove !== 'function') invalid()
    if (this.#destroyed || record.settled || this.#pending.get(record.key) !== record) {
      throw unavailable()
    }
    const abort = () => {
      if (!record.settled) this.#finishPending(record, unavailable(), null)
    }
    record.signal = signal
    record.removeAbort = remove
    record.abort = abort
    try {
      add.call(signal, 'abort', abort, { once: true })
      if (this.#destroyed || record.settled || this.#pending.get(record.key) !== record) {
        try {
          remove.call(signal, 'abort', abort)
        } catch {
          this.#failClosed()
        }
        throw unavailable()
      }
      const currentAborted = signal.aborted
      if (this.#destroyed || record.settled || this.#pending.get(record.key) !== record) {
        try {
          remove.call(signal, 'abort', abort)
        } catch {
          this.#failClosed()
        }
        throw unavailable()
      }
      if (aborted || currentAborted) abort()
    } catch {
      if (this.#destroyed || record.settled || this.#pending.get(record.key) !== record) {
        try {
          remove.call(signal, 'abort', abort)
        } catch {}
      }
      this.#failClosed()
      throw unavailable()
    }
  }

  #detachSignal(record) {
    const { signal, removeAbort, abort } = record
    record.signal = null
    record.removeAbort = null
    record.abort = null
    if (!signal || !removeAbort || !abort) return true
    try {
      removeAbort.call(signal, 'abort', abort)
      return true
    } catch {
      return false
    }
  }

  #finishPending(record, error, responseDigest, body = null) {
    if (record.settled) {
      clear(body)
      return false
    }
    if (this.#tombstones.size >= this.#maxTombstones) {
      clear(body)
      this.#failClosed()
      return false
    }
    if (!this.#cancelTimer(record) || !this.#detachSignal(record)) {
      clear(body)
      this.#failClosed()
      return false
    }
    if (this.#destroyed || record.settled || this.#pending.get(record.key) !== record) {
      clear(body)
      return false
    }
    record.settled = true
    this.#pending.delete(record.key)
    const tombstone = {
      request: record.request,
      digest: record.digest,
      responseDigest: responseDigest ? copy(responseDigest) : null
    }
    destroyVerifier(record.verifier)
    record.verifier = null
    record.request = null
    record.digest = null
    this.#tombstones.set(record.key, tombstone)
    if (tombstone.responseDigest) this.#ownedBytes += length(tombstone.responseDigest)
    if (error) record.reject(error)
    else record.resolve(body)
    return true
  }

  #dropPending(record, error, cancelTimer = true) {
    if (record.settled) return
    record.settled = true
    this.#pending.delete(record.key)
    const timerCancelled = !cancelTimer || this.#cancelTimer(record)
    const signalDetached = this.#detachSignal(record)
    this.#ownedBytes -= this.#recordBytes(record)
    destroyVerifier(record.verifier)
    record.verifier = null
    clearMessage(record.request)
    clear(record.digest)
    record.request = null
    record.digest = null
    record.reject(error)
    if (!timerCancelled || !signalDetached) this.#failClosed()
  }

  #cancelTimer(record) {
    const timer = record.timer
    record.timer = null
    if (!timer || !timer.active) return true
    timer.active = false
    try {
      this.#cancel(timer.handle)
      return true
    } catch {
      return false
    }
  }

  #recordBytes(record) {
    if (!record.request || !record.digest) return 0
    return (
      length(record.request.actorId) +
      length(record.request.circuitId) +
      length(record.request.body) +
      length(record.digest)
    )
  }

  #clearTombstone(record) {
    clearMessage(record.request)
    clear(record.digest)
    clear(record.responseDigest)
  }

  #failClosed() {
    if (this.#destroyed) return
    this.destroy()
  }
}

const genuineRemoteActorRequest = RemoteActorHost.prototype.request

// Package-internal brand consumed by AsyncRouteControlSession. A plain object
// with a request-shaped method is not an authenticated actor boundary.
export function isRemoteActorHost(value) {
  try {
    return REMOTE_ACTOR_HOSTS.has(value)
  } catch {
    return false
  }
}

// Package-internal non-virtual dispatch. Async control never calls a mutable
// instance property at its authentication boundary.
export function requestRemoteActorHost(host, ...args) {
  const dispatch = REMOTE_ACTOR_DISPATCH.get(host)
  if (!dispatch) return Promise.reject(PrivateRouteError.INVALID_ROUTE())
  return dispatch(...args)
}

// Package-internal relay-to-next-hop dispatch. It preserves authenticated
// request/reply framing and structural reply validation while deliberately
// leaving the full registration/CREATED transcript verifier at the source.
export function forwardRemoteActorHost(host, kind, actorId, circuitId, generation, body) {
  const dispatch = REMOTE_ACTOR_FORWARD_DISPATCH.get(host)
  if (!dispatch) return Promise.reject(PrivateRouteError.INVALID_ROUTE())
  return dispatch(kind, actorId, circuitId, generation, body)
}

export function isRemoteActorHostTestDouble(host) {
  return REMOTE_ACTOR_TEST_DOUBLES.has(host)
}

// Test-only seam, deliberately absent from the package root export map. It
// preserves unit fault injection without weakening production dispatch.
export function createRemoteActorHostTestDouble(request) {
  if (typeof request !== 'function') invalid()
  const host = new RemoteActorHost({
    control: {},
    sendControl() {
      return true
    },
    now: () => 0,
    randomBytes: () => b4a.alloc(8, 1),
    schedule() {
      return Object.freeze({})
    },
    cancel() {}
  })
  REMOTE_ACTOR_DISPATCH.set(host, request)
  REMOTE_ACTOR_TEST_DOUBLES.add(host)
  return host
}
