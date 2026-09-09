import b4a from 'b4a'

import { PrivateRouteError } from './errors.js'

const LINK_OFFER_SIZE = 374
const LINK_ACCEPT_SIZE = 285
const REDACTED_RESPONDER_PROOF_SIZE = 378
const CANONICAL_ENDPOINT_SIZE = 19
const OFFER_RECEIVERS = new WeakMap()
const RESPONSE_RECEIVERS = new WeakMap()
const RESPONSE_WRITERS = new WeakMap()
const SPENT_OFFER_RECEIVERS = new WeakSet()
const SPENT_RESPONSE_RECEIVERS = new WeakSet()
const SPENT_RESPONSE_WRITERS = new WeakSet()
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

function channel(value) {
  return object(value) && typeof option(value, 'destroy') === 'function'
}

function destroy(callback) {
  try {
    callback()
  } catch {}
}

function destroyedOrReplay(value, spent) {
  if (object(value) && spent.has(value)) replay()
  authentication()
}

export function createExtensionOfferReceiver(options = {}) {
  if (!object(options)) invalid()
  let observedPredecessorEndpoint = null
  try {
    const receiveObject = option(options, 'receiveObject')
    const takePhysicalChannel = option(options, 'takePhysicalChannel')
    const sendObject = option(options, 'sendObject')
    const finish = option(options, 'finish')
    const destroy = option(options, 'destroy')
    if (
      typeof receiveObject !== 'function' ||
      typeof takePhysicalChannel !== 'function' ||
      typeof sendObject !== 'function' ||
      typeof finish !== 'function' ||
      typeof destroy !== 'function'
    ) {
      invalid()
    }
    observedPredecessorEndpoint = copy(
      option(options, 'observedPredecessorEndpoint'),
      CANONICAL_ENDPOINT_SIZE
    )
    const receiver = Object.freeze({})
    OFFER_RECEIVERS.set(receiver, {
      receiveObject,
      takePhysicalChannel,
      sendObject,
      finish,
      destroy,
      observedPredecessorEndpoint
    })
    observedPredecessorEndpoint = null
    return receiver
  } finally {
    clear(observedPredecessorEndpoint)
  }
}

export function isExtensionOfferReceiver(value) {
  return object(value) && OFFER_RECEIVERS.has(value)
}

export function destroyExtensionOfferReceiver(receiver) {
  const state = object(receiver) ? OFFER_RECEIVERS.get(receiver) : null
  if (!state) return false
  OFFER_RECEIVERS.delete(receiver)
  SPENT_OFFER_RECEIVERS.add(receiver)
  clear(state.observedPredecessorEndpoint)
  destroy(state.destroy)
  return true
}

export function takeExtensionOffer(receiver) {
  const state = object(receiver) ? OFFER_RECEIVERS.get(receiver) : null
  if (!state) destroyedOrReplay(receiver, SPENT_OFFER_RECEIVERS)
  OFFER_RECEIVERS.delete(receiver)
  SPENT_OFFER_RECEIVERS.add(receiver)
  let offer = null
  let extra = null
  let observedPredecessorEndpoint = null
  let physicalChannel = null
  let responseWriter = null
  let transferred = false
  try {
    offer = copy(state.receiveObject(), LINK_OFFER_SIZE)
    extra = state.receiveObject()
    if (extra !== null) invalid()
    observedPredecessorEndpoint = state.observedPredecessorEndpoint
    state.observedPredecessorEndpoint = null
    physicalChannel = state.takePhysicalChannel()
    if (!channel(physicalChannel)) invalid()
    responseWriter = Object.freeze({})
    RESPONSE_WRITERS.set(responseWriter, {
      sendObject: state.sendObject,
      finish: state.finish,
      phase: 0
    })
    const result = Object.freeze({
      offer,
      observedPredecessorEndpoint,
      physicalChannel,
      responseWriter
    })
    offer = null
    observedPredecessorEndpoint = null
    physicalChannel = null
    responseWriter = null
    transferred = true
    return result
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    clear(extra)
    clear(offer)
    clear(observedPredecessorEndpoint)
    clear(state.observedPredecessorEndpoint)
    state.observedPredecessorEndpoint = null
    if (!transferred) {
      if (responseWriter) {
        RESPONSE_WRITERS.delete(responseWriter)
        SPENT_RESPONSE_WRITERS.add(responseWriter)
      }
      if (physicalChannel) {
        try {
          physicalChannel.destroy()
        } catch {}
      } else {
        destroy(state.destroy)
      }
    }
  }
}

export function sendExtensionAccept(writer, encodedAccept) {
  const state = object(writer) ? RESPONSE_WRITERS.get(writer) : null
  if (!state) destroyedOrReplay(writer, SPENT_RESPONSE_WRITERS)
  if (state.phase !== 0) replay()
  let accept = null
  try {
    accept = copy(encodedAccept, LINK_ACCEPT_SIZE)
    state.sendObject(accept)
    accept = null
    state.phase = 1
    return true
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    clear(accept)
  }
}

export function sendExtensionProof(writer, encodedProof) {
  const state = object(writer) ? RESPONSE_WRITERS.get(writer) : null
  if (!state) destroyedOrReplay(writer, SPENT_RESPONSE_WRITERS)
  if (state.phase !== 1) replay()
  let proof = null
  try {
    proof = copy(encodedProof, REDACTED_RESPONDER_PROOF_SIZE)
    state.sendObject(proof)
    proof = null
    state.phase = 2
    return true
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    clear(proof)
  }
}

export function finishExtensionResponse(writer) {
  const state = object(writer) ? RESPONSE_WRITERS.get(writer) : null
  if (!state) destroyedOrReplay(writer, SPENT_RESPONSE_WRITERS)
  if (state.phase !== 2) replay()
  RESPONSE_WRITERS.delete(writer)
  SPENT_RESPONSE_WRITERS.add(writer)
  try {
    state.finish()
    return true
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  }
}

export function destroyExtensionResponseWriter(writer) {
  if (!object(writer) || !RESPONSE_WRITERS.has(writer)) return false
  RESPONSE_WRITERS.delete(writer)
  SPENT_RESPONSE_WRITERS.add(writer)
  return true
}

export function createExtensionResponseReceiver(options = {}) {
  if (!object(options)) invalid()
  const receiveObject = option(options, 'receiveObject')
  const takePhysicalChannel = option(options, 'takePhysicalChannel')
  const destroy = option(options, 'destroy')
  if (
    typeof receiveObject !== 'function' ||
    typeof takePhysicalChannel !== 'function' ||
    typeof destroy !== 'function'
  ) {
    invalid()
  }
  const receiver = Object.freeze({})
  RESPONSE_RECEIVERS.set(receiver, { receiveObject, takePhysicalChannel, destroy })
  return receiver
}

export function isExtensionResponseReceiver(value) {
  return object(value) && RESPONSE_RECEIVERS.has(value)
}

export function destroyExtensionResponseReceiver(receiver) {
  const state = object(receiver) ? RESPONSE_RECEIVERS.get(receiver) : null
  if (!state) return false
  RESPONSE_RECEIVERS.delete(receiver)
  SPENT_RESPONSE_RECEIVERS.add(receiver)
  destroy(state.destroy)
  return true
}

export function takeExtensionResponse(receiver) {
  const state = object(receiver) ? RESPONSE_RECEIVERS.get(receiver) : null
  if (!state) destroyedOrReplay(receiver, SPENT_RESPONSE_RECEIVERS)
  RESPONSE_RECEIVERS.delete(receiver)
  SPENT_RESPONSE_RECEIVERS.add(receiver)
  let accept = null
  let proof = null
  let extra = null
  let physicalChannel = null
  let transferred = false
  try {
    accept = copy(state.receiveObject(), LINK_ACCEPT_SIZE)
    proof = copy(state.receiveObject(), REDACTED_RESPONDER_PROOF_SIZE)
    extra = state.receiveObject()
    if (extra !== null) invalid()
    physicalChannel = state.takePhysicalChannel()
    if (!channel(physicalChannel)) invalid()
    const result = Object.freeze({ accept, proof, physicalChannel })
    accept = null
    proof = null
    physicalChannel = null
    transferred = true
    return result
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    clear(accept)
    clear(proof)
    clear(extra)
    if (!transferred) {
      if (physicalChannel) {
        try {
          physicalChannel.destroy()
        } catch {}
      } else {
        destroy(state.destroy)
      }
    }
  }
}
