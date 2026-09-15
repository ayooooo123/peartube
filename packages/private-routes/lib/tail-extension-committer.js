import b4a from 'b4a'

import { PrivateRouteError } from './errors.js'
import { M3_CONTEXT_ENVELOPE_SIZE } from './m3-context.js'

const COMMITTERS = new WeakMap()
const SPENT_COMMITTERS = new WeakSet()
const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const setIntrinsic = Uint8Array.prototype.set
const fillIntrinsic = Uint8Array.prototype.fill

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function authentication() {
  throw PrivateRouteError.ERR_AUTHENTICATION()
}

function replay() {
  throw PrivateRouteError.ERR_REPLAY()
}

function busy() {
  throw PrivateRouteError.ERR_BUSY()
}

function object(value) {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

function option(value, key) {
  try {
    return value[key]
  } catch {
    invalid()
  }
}

function exactKeys(value, expected) {
  try {
    const keys = Reflect.ownKeys(value)
    return (
      keys.length === expected.length &&
      keys.every((key) => typeof key === 'string' && expected.includes(key))
    )
  } catch {
    return false
  }
}

function length(value) {
  try {
    return b4a.isBuffer(value) ? byteLengthGetter.call(value) : -1
  } catch {
    return -1
  }
}

function copy(value, size) {
  if (length(value) !== size) invalid()
  const result = b4a.allocUnsafeSlow(size)
  try {
    setIntrinsic.call(result, value)
    return result
  } catch {
    clear(result)
    invalid()
  }
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) fillIntrinsic.call(value, 0)
  } catch {}
}

function stateFor(committer) {
  const state = object(committer) ? COMMITTERS.get(committer) : null
  if (state) return state
  if (object(committer) && SPENT_COMMITTERS.has(committer)) replay()
  authentication()
}

function destroyState(state) {
  if (state.destroyed) return false
  state.destroyed = true
  state.lifecycle = null
  COMMITTERS.delete(state.committer)
  SPENT_COMMITTERS.add(state.committer)
  try {
    state.destroy()
  } catch {}
  return true
}

function begin(state) {
  if (state.mutating) {
    state.violated = true
    busy()
  }
  state.mutating = true
  state.violated = false
  return state.lifecycle
}

function assertState(state, lifecycle) {
  if (state.destroyed || state.lifecycle !== lifecycle) throw PrivateRouteError.ERR_DESTROYED()
  if (state.violated) invalid()
}

function validForwarding(value) {
  return (
    object(value) &&
    Object.isFrozen(value) &&
    exactKeys(value, ['diagnostics', 'destroy']) &&
    typeof option(value, 'diagnostics') === 'function' &&
    typeof option(value, 'destroy') === 'function'
  )
}

export function createTailExtensionCommitter(options = {}) {
  if (!object(options) || !exactKeys(options, ['enqueue', 'install', 'destroy'])) invalid()
  const enqueue = option(options, 'enqueue')
  const install = option(options, 'install')
  const destroy = option(options, 'destroy')
  if (
    typeof enqueue !== 'function' ||
    typeof install !== 'function' ||
    typeof destroy !== 'function'
  ) {
    invalid()
  }
  const committer = Object.freeze({})
  COMMITTERS.set(committer, {
    committer,
    enqueue,
    install,
    destroy,
    phase: 0,
    mutating: false,
    violated: false,
    destroyed: false,
    lifecycle: Object.freeze({})
  })
  return committer
}

export function isTailExtensionCommitter(value) {
  return object(value) && COMMITTERS.has(value)
}

export function destroyTailExtensionCommitter(committer) {
  const state = object(committer) ? COMMITTERS.get(committer) : null
  if (!state) return false
  if (state.mutating) state.violated = true
  return destroyState(state)
}

export function enqueueTailExtended(committer, envelope) {
  const state = stateFor(committer)
  if (state.phase !== 0) replay()
  const lifecycle = begin(state)
  let owned = null
  try {
    owned = copy(envelope, M3_CONTEXT_ENVELOPE_SIZE)
    state.enqueue(owned)
    owned = null
    assertState(state, lifecycle)
    state.phase = 1
    return true
  } catch (err) {
    if (!state.destroyed) destroyState(state)
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    state.mutating = false
    clear(owned)
  }
}

export function installTailExtension(committer, nextRuntime) {
  const state = stateFor(committer)
  if (state.phase !== 1 || !object(nextRuntime)) replay()
  const lifecycle = begin(state)
  let forwarding = null
  let published = false
  try {
    forwarding = state.install(nextRuntime)
    assertState(state, lifecycle)
    if (!validForwarding(forwarding)) invalid()
    COMMITTERS.delete(committer)
    SPENT_COMMITTERS.add(committer)
    state.phase = 2
    state.destroyed = true
    state.lifecycle = null
    published = true
    return forwarding
  } catch (err) {
    if (forwarding && typeof forwarding.destroy === 'function') {
      try {
        forwarding.destroy()
      } catch {}
      forwarding = null
    }
    if (!state.destroyed) destroyState(state)
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    state.mutating = false
    if (!published && forwarding && typeof forwarding.destroy === 'function') {
      try {
        forwarding.destroy()
      } catch {}
    }
  }
}
