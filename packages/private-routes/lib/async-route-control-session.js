import b4a from 'b4a'

import {
  ASYNC_CIRCUIT_STATE,
  ASYNC_REGISTRATION_STATE,
  destroyRemoteActivationVerifier,
  isRemoteActivationVerifier,
  transitionAsyncControlState
} from './activation.js'
import { PrivateRouteError } from './errors.js'
import {
  ACTOR_CONTROL_BODY_MAX,
  ACTOR_CONTROL_KIND,
  CIRCUIT_DESTROY_REASON
} from './remote-control.js'
import { isRemoteActorHost } from './remote-actor-host.js'

export const ASYNC_ROUTE_CONTROL_DEADLINE = 5_000

const MAX_UINT64 = (1n << 64n) - 1n
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const bufferByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get
const bufferFill = Uint8Array.prototype.fill
const bufferSet = Uint8Array.prototype.set

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function unavailable() {
  return PrivateRouteError.ROUTE_UNAVAILABLE()
}

function circuitState() {
  throw PrivateRouteError.CIRCUIT_STATE()
}

function object(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
    return value
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  }
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

function body(value) {
  const size = length(value)
  if (size < 0 || size > ACTOR_CONTROL_BODY_MAX) invalid()
  return copy(value)
}

function generation(value) {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_UINT64) invalid()
  return value
}

function stable(error) {
  return error instanceof PrivateRouteError ? error : unavailable()
}

function allZero(value) {
  if (!b4a.isBuffer(value)) return false
  for (const byte of value) if (byte !== 0) return false
  return true
}

class LocalAbortSignal {
  #listeners = new Set()
  aborted = false

  addEventListener(name, listener) {
    if (name !== 'abort' || typeof listener !== 'function') return
    this.#listeners.add(listener)
  }

  removeEventListener(name, listener) {
    if (name === 'abort') this.#listeners.delete(listener)
  }

  abort() {
    if (this.aborted) return
    this.aborted = true
    const listeners = Array.from(this.#listeners)
    this.#listeners.clear()
    for (const listener of listeners) {
      try {
        listener()
      } catch {}
    }
  }
}

export class AsyncRouteControlSession {
  #remote
  #actorId
  #now
  #timeout
  #lastNow = null
  #registrationDeadline = null
  #circuitDeadline = null
  #registrationState = ASYNC_REGISTRATION_STATE.NEW
  #circuitState = ASYNC_CIRCUIT_STATE.NEW
  #abortBody = null
  #circuitId = null
  #generation = null
  #current = null
  #stopped = false
  #stopPromise = null
  #ownedBytes = 0

  constructor(options = {}) {
    object(options)
    const { remote, actorId, now } = options
    if (
      !isRemoteActorHost(remote) ||
      !fixed(actorId, 16) ||
      allZero(actorId) ||
      typeof now !== 'function'
    )
      invalid()
    const timeout = options.timeout === undefined ? ASYNC_ROUTE_CONTROL_DEADLINE : options.timeout
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > ASYNC_ROUTE_CONTROL_DEADLINE)
      invalid()
    this.#remote = remote
    this.#actorId = copy(actorId)
    this.#ownedBytes = length(this.#actorId)
    this.#now = now
    this.#timeout = timeout
  }

  get registrationState() {
    return this.#registrationState
  }

  get circuitState() {
    return this.#circuitState
  }

  get stats() {
    return Object.freeze({
      waits: this.#current ? 1 : 0,
      timers: 0,
      ownedBytes: this.#ownedBytes - length(this.#actorId),
      registrationState: this.#registrationState,
      circuitState: this.#circuitState,
      stopped: this.#stopped
    })
  }

  async register(options = {}) {
    object(options)
    if (this.#registrationState !== ASYNC_REGISTRATION_STATE.NEW) circuitState()
    let stage = null
    let prepare = null
    let finalize = null
    let abort = null
    let context = null
    try {
      stage = body(options.stage)
      prepare = body(options.prepare)
      finalize = body(options.finalize)
      abort = body(options.abort)
      context = this.#begin(options.signal)
      this.#registrationDeadline = context.deadline
      const acknowledgements = await this.#stage(stage, abort, context)
      try {
        await this.#prepare(prepare, context)
        await this.#finalize(finalize, context)
        return Object.freeze({ registered: true, acknowledgements: copy(acknowledgements) })
      } finally {
        clear(acknowledgements)
      }
    } catch (err) {
      if (context) await this.#rollbackRegistration(context)
      throw stable(err)
    } finally {
      if (context) this.#finish(context)
      clear(stage)
      clear(prepare)
      clear(finalize)
      clear(abort)
      if (this.#registrationState !== ASYNC_REGISTRATION_STATE.ABORTING) this.#clearAbortBody()
    }
  }

  async stage(stageValue, options = {}) {
    object(options)
    let stage = null
    let abort = null
    let context = null
    try {
      stage = body(stageValue)
      abort = body(options.abort)
      context = this.#begin(options.signal)
      this.#registrationDeadline = context.deadline
      return await this.#stage(stage, abort, context)
    } catch (err) {
      if (context) await this.#rollbackRegistration(context)
      throw stable(err)
    } finally {
      if (context) this.#finish(context)
      clear(stage)
      clear(abort)
      if (
        this.#registrationState !== ASYNC_REGISTRATION_STATE.STAGED &&
        this.#registrationState !== ASYNC_REGISTRATION_STATE.ABORTING
      )
        this.#clearAbortBody()
    }
  }

  async prepare(prepareValue, options = {}) {
    object(options)
    let prepare = null
    let context = null
    try {
      prepare = body(prepareValue)
      context = this.#begin(options.signal, false, this.#registrationDeadline)
      return await this.#prepare(prepare, context)
    } catch (err) {
      if (context) await this.#rollbackRegistration(context)
      throw stable(err)
    } finally {
      if (context) this.#finish(context)
      clear(prepare)
      if (this.#registrationState === ASYNC_REGISTRATION_STATE.ABORTED) this.#clearAbortBody()
    }
  }

  async finalize(finalizeValue, options = {}) {
    object(options)
    let finalize = null
    let context = null
    try {
      finalize = body(finalizeValue)
      context = this.#begin(options.signal, false, this.#registrationDeadline)
      return await this.#finalize(finalize, context)
    } catch (err) {
      if (context) await this.#rollbackRegistration(context)
      throw stable(err)
    } finally {
      if (context) this.#finish(context)
      clear(finalize)
      if (
        this.#registrationState !== ASYNC_REGISTRATION_STATE.PREPARED &&
        this.#registrationState !== ASYNC_REGISTRATION_STATE.ABORTING
      )
        this.#clearAbortBody()
    }
  }

  async abort(abortValue, options = {}) {
    object(options)
    if (this.#registrationState === ASYNC_REGISTRATION_STATE.ABORTED) return true
    let supplied = null
    let context = null
    try {
      supplied = abortValue === undefined ? null : body(abortValue)
      context = this.#begin(options.signal, false, this.#registrationDeadline)
      const value = supplied || this.#abortBody
      if (!value) invalid()
      return await this.#abortRegistration(value, context)
    } finally {
      if (context) this.#finish(context)
      clear(supplied)
      if (this.#registrationState === ASYNC_REGISTRATION_STATE.ABORTED) this.#clearAbortBody()
    }
  }

  async activate(options = {}) {
    object(options)
    if (this.#circuitState !== ASYNC_CIRCUIT_STATE.NEW) circuitState()
    let activationBody = null
    let circuitId = null
    let context = null
    let activationVerifier = null
    try {
      activationBody = body(options.body)
      circuitId = copy(options.circuitId)
      if (!fixed(circuitId, 16) || allZero(circuitId)) invalid()
      const nextGeneration = generation(options.generation)
      activationVerifier = options.activationVerifier
      if (!isRemoteActivationVerifier(activationVerifier)) invalid()
      context = this.#begin(options.signal)
      this.#circuitDeadline = context.deadline
      this.#circuitState = transitionAsyncControlState('circuit', this.#circuitState, 'activate')
      this.#replaceCircuit(circuitId, nextGeneration)
      const response = await this.#request(
        context,
        ACTOR_CONTROL_KIND.ACTIVATE_CREATE,
        circuitId,
        nextGeneration,
        activationBody,
        { activationVerifier }
      )
      this.#circuitState = transitionAsyncControlState('circuit', this.#circuitState, 'opened')
      this.#circuitDeadline = null
      return response
    } catch (err) {
      if (context) await this.#destroyAfterFailure(context, CIRCUIT_DESTROY_REASON.TRANSPORT_LOST)
      throw stable(err)
    } finally {
      if (context) this.#finish(context)
      clear(activationBody)
      clear(circuitId)
      if (activationVerifier) destroyRemoteActivationVerifier(activationVerifier)
    }
  }

  async destroy(reason = CIRCUIT_DESTROY_REASON.REQUESTED, options = {}) {
    object(options)
    if (this.#circuitState === ASYNC_CIRCUIT_STATE.DESTROYED) return true
    if (
      this.#circuitState !== ASYNC_CIRCUIT_STATE.ACTIVATING &&
      this.#circuitState !== ASYNC_CIRCUIT_STATE.OPEN &&
      this.#circuitState !== ASYNC_CIRCUIT_STATE.DESTROYING
    )
      circuitState()
    if (this.#current) {
      if (this.#circuitState !== ASYNC_CIRCUIT_STATE.ACTIVATING) circuitState()
      this.#current.signal.abort()
      await this.#current.finished
      if (this.#circuitState === ASYNC_CIRCUIT_STATE.DESTROYED) return true
    }
    const retrying = this.#circuitState === ASYNC_CIRCUIT_STATE.DESTROYING
    const context = this.#begin(options.signal, false, retrying ? this.#circuitDeadline : null)
    if (!retrying) this.#circuitDeadline = context.deadline
    try {
      return await this.#destroyCircuit(reason, context)
    } finally {
      this.#finish(context)
    }
  }

  async expire(options = {}) {
    if (this.#registrationState !== ASYNC_REGISTRATION_STATE.FINALIZED) circuitState()
    this.#registrationState = transitionAsyncControlState(
      'registration',
      this.#registrationState,
      'expire'
    )
    await this.#destroyTerminalCircuit(CIRCUIT_DESTROY_REASON.EXPIRED, options)
    return true
  }

  async revoke(options = {}) {
    if (this.#registrationState !== ASYNC_REGISTRATION_STATE.FINALIZED) circuitState()
    this.#registrationState = transitionAsyncControlState(
      'registration',
      this.#registrationState,
      'revoke'
    )
    await this.#destroyTerminalCircuit(CIRCUIT_DESTROY_REASON.REVOKED, options)
    return true
  }

  stop() {
    if (this.#stopPromise) return this.#stopPromise
    this.#stopped = true
    this.#stopPromise = this.#stop()
    return this.#stopPromise
  }

  async #stop() {
    try {
      const active = this.#current
      if (active) {
        active.signal.abort()
        await active.finished
      }
      if (
        this.#abortBody &&
        (this.#registrationState === ASYNC_REGISTRATION_STATE.STAGED ||
          this.#registrationState === ASYNC_REGISTRATION_STATE.PREPARED ||
          this.#registrationState === ASYNC_REGISTRATION_STATE.ABORTING)
      ) {
        let context = null
        try {
          context = this.#begin(undefined, true, this.#registrationDeadline)
          await this.#abortRegistration(this.#abortBody, context)
        } catch {}
        if (context) this.#finish(context)
      }
      if (
        this.#circuitState === ASYNC_CIRCUIT_STATE.OPEN ||
        this.#circuitState === ASYNC_CIRCUIT_STATE.DESTROYING
      ) {
        let context = null
        try {
          context = this.#begin(
            undefined,
            true,
            this.#circuitState === ASYNC_CIRCUIT_STATE.DESTROYING ? this.#circuitDeadline : null
          )
          await this.#destroyCircuit(CIRCUIT_DESTROY_REASON.TRANSPORT_LOST, context)
        } catch {}
        if (context) this.#finish(context)
      }
      return true
    } finally {
      this.#clearAbortBody()
      this.#clearCircuit()
      clear(this.#actorId)
      this.#actorId = b4a.alloc(0)
      this.#ownedBytes = 0
    }
  }

  async #destroyTerminalCircuit(reason, options) {
    const active = this.#current
    if (active && this.#circuitState === ASYNC_CIRCUIT_STATE.ACTIVATING) {
      active.signal.abort()
      await active.finished
    }
    if (
      this.#circuitState === ASYNC_CIRCUIT_STATE.OPEN ||
      this.#circuitState === ASYNC_CIRCUIT_STATE.DESTROYING
    )
      await this.destroy(reason, options)
  }

  async #stage(stage, abort, context) {
    const next = transitionAsyncControlState('registration', this.#registrationState, 'stage')
    this.#replaceAbortBody(abort)
    const response = await this.#request(
      context,
      ACTOR_CONTROL_KIND.REGISTER_STAGE,
      b4a.alloc(16),
      0n,
      stage
    )
    this.#registrationState = next
    return response
  }

  async #prepare(prepare, context) {
    const next = transitionAsyncControlState('registration', this.#registrationState, 'prepare')
    let response = null
    try {
      response = await this.#request(
        context,
        ACTOR_CONTROL_KIND.REGISTER_PREPARE,
        b4a.alloc(16),
        0n,
        prepare
      )
      this.#registrationState = next
      return true
    } finally {
      clear(response)
    }
  }

  async #finalize(finalize, context) {
    const next = transitionAsyncControlState('registration', this.#registrationState, 'finalize')
    let response = null
    try {
      response = await this.#request(
        context,
        ACTOR_CONTROL_KIND.REGISTER_FINALIZE,
        b4a.alloc(16),
        0n,
        finalize
      )
      this.#registrationState = next
      return true
    } finally {
      clear(response)
    }
  }

  async #rollbackRegistration(context) {
    if (
      !context.dispatched &&
      this.#registrationState !== ASYNC_REGISTRATION_STATE.STAGED &&
      this.#registrationState !== ASYNC_REGISTRATION_STATE.PREPARED
    )
      return false
    if (!this.#abortBody) return false
    if (
      this.#registrationState !== ASYNC_REGISTRATION_STATE.STAGED &&
      this.#registrationState !== ASYNC_REGISTRATION_STATE.PREPARED
    ) {
      try {
        await this.#cleanupRequest(
          context,
          ACTOR_CONTROL_KIND.REGISTER_ABORT,
          b4a.alloc(16),
          0n,
          this.#abortBody
        )
      } catch {}
      return true
    }
    try {
      return await this.#abortRegistration(this.#abortBody, context, true)
    } catch {
      return false
    }
  }

  async #abortRegistration(abort, context, cleanup = false) {
    if (this.#registrationState === ASYNC_REGISTRATION_STATE.ABORTED) return true
    this.#registrationState = transitionAsyncControlState(
      'registration',
      this.#registrationState,
      'abort'
    )
    if (cleanup)
      await this.#cleanupRequest(
        context,
        ACTOR_CONTROL_KIND.REGISTER_ABORT,
        b4a.alloc(16),
        0n,
        abort
      )
    else await this.#request(context, ACTOR_CONTROL_KIND.REGISTER_ABORT, b4a.alloc(16), 0n, abort)
    this.#registrationState = transitionAsyncControlState(
      'registration',
      this.#registrationState,
      'aborted'
    )
    return true
  }

  async #destroyAfterFailure(context, reason) {
    if (
      this.#circuitState !== ASYNC_CIRCUIT_STATE.ACTIVATING &&
      this.#circuitState !== ASYNC_CIRCUIT_STATE.OPEN
    )
      return
    this.#circuitState = transitionAsyncControlState('circuit', this.#circuitState, 'destroy')
    let cleaned = false
    try {
      await this.#cleanupRequest(
        context,
        ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
        this.#circuitId,
        this.#generation,
        b4a.from([reason])
      )
      cleaned = true
    } catch {}
    if (cleaned) {
      this.#circuitState = transitionAsyncControlState('circuit', this.#circuitState, 'destroyed')
      this.#clearCircuit()
    }
  }

  async #destroyCircuit(reason, context) {
    if (!Number.isInteger(reason) || !Object.values(CIRCUIT_DESTROY_REASON).includes(reason))
      invalid()
    if (this.#circuitState === ASYNC_CIRCUIT_STATE.DESTROYED) return true
    if (
      this.#circuitState !== ASYNC_CIRCUIT_STATE.OPEN &&
      this.#circuitState !== ASYNC_CIRCUIT_STATE.DESTROYING
    )
      circuitState()
    this.#circuitState = transitionAsyncControlState('circuit', this.#circuitState, 'destroy')
    await this.#request(
      context,
      ACTOR_CONTROL_KIND.CIRCUIT_DESTROY,
      this.#circuitId,
      this.#generation,
      b4a.from([reason])
    )
    this.#circuitState = transitionAsyncControlState('circuit', this.#circuitState, 'destroyed')
    this.#clearCircuit()
    return true
  }

  #begin(externalSignal, stopping = false, retainedDeadline = null) {
    if ((this.#stopped && !stopping) || this.#current) circuitState()
    const startedAt = this.#readNow()
    if (startedAt > Number.MAX_SAFE_INTEGER - this.#timeout) throw unavailable()
    const deadline = retainedDeadline === null ? startedAt + this.#timeout : retainedDeadline
    if (!Number.isSafeInteger(deadline) || deadline < 0 || deadline > startedAt + this.#timeout)
      throw unavailable()
    const signal = new LocalAbortSignal()
    let removeExternal = null
    if (externalSignal !== undefined) {
      object(externalSignal)
      let add
      let remove
      let aborted
      try {
        add = externalSignal.addEventListener
        remove = externalSignal.removeEventListener
        aborted = externalSignal.aborted
      } catch {
        invalid()
      }
      if (typeof add !== 'function' || typeof remove !== 'function') invalid()
      const onAbort = () => signal.abort()
      try {
        add.call(externalSignal, 'abort', onAbort, { once: true })
        removeExternal = () => remove.call(externalSignal, 'abort', onAbort)
        if (aborted || externalSignal.aborted) signal.abort()
      } catch {
        try {
          if (removeExternal) removeExternal()
        } catch {}
        invalid()
      }
    }
    let finish
    const finished = new Promise((resolve) => {
      finish = resolve
    })
    const context = {
      deadline,
      signal,
      removeExternal,
      dispatched: false,
      finished,
      finish
    }
    this.#current = context
    return context
  }

  #finish(context) {
    if (this.#current !== context) return
    this.#current = null
    if (context.removeExternal) {
      try {
        context.removeExternal()
      } catch {
        this.#stopped = true
      }
    }
    context.signal.abort()
    context.finish()
  }

  async #request(context, kind, circuitId, generationValue, requestBody, extra = {}) {
    if (this.#current !== context || context.signal.aborted) throw unavailable()
    let result
    try {
      if (kind === ACTOR_CONTROL_KIND.REGISTER_STAGE) context.dispatched = true
      result = await this.#remote.request(
        kind,
        this.#actorId,
        circuitId,
        generationValue,
        requestBody,
        Object.freeze({ deadline: context.deadline, signal: context.signal, ...extra })
      )
    } catch (err) {
      throw stable(err)
    }
    if (
      this.#current !== context ||
      context.signal.aborted ||
      this.#readNow() >= context.deadline
    ) {
      clear(result)
      throw unavailable()
    }
    if (length(result) < 0 || length(result) > ACTOR_CONTROL_BODY_MAX) {
      clear(result)
      throw unavailable()
    }
    const output = copy(result)
    clear(result)
    return output
  }

  async #cleanupRequest(context, kind, circuitId, generationValue, requestBody) {
    let response = null
    try {
      response = await this.#remote.request(
        kind,
        this.#actorId,
        circuitId,
        generationValue,
        requestBody,
        Object.freeze({ deadline: context.deadline })
      )
      return true
    } catch (err) {
      throw stable(err)
    } finally {
      clear(response)
    }
  }

  #readNow() {
    let value
    try {
      value = this.#now()
    } catch {
      this.#stopped = true
      throw unavailable()
    }
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      (this.#lastNow !== null && value < this.#lastNow)
    ) {
      this.#stopped = true
      throw unavailable()
    }
    this.#lastNow = value
    return value
  }

  #replaceAbortBody(value) {
    this.#clearAbortBody()
    this.#abortBody = copy(value)
    this.#ownedBytes += length(this.#abortBody)
  }

  #clearAbortBody() {
    if (!this.#abortBody) return
    this.#ownedBytes -= length(this.#abortBody)
    clear(this.#abortBody)
    this.#abortBody = null
  }

  #replaceCircuit(circuitId, nextGeneration) {
    this.#clearCircuit()
    this.#circuitId = copy(circuitId)
    this.#generation = nextGeneration
    this.#ownedBytes += length(this.#circuitId)
  }

  #clearCircuit() {
    if (!this.#circuitId) return
    this.#ownedBytes -= length(this.#circuitId)
    clear(this.#circuitId)
    this.#circuitId = null
    this.#generation = null
    this.#circuitDeadline = null
  }
}

export { ASYNC_CIRCUIT_STATE, ASYNC_REGISTRATION_STATE }
