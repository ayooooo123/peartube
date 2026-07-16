import b4a from 'b4a'

import { RoutedCoreReassembler, encodeRoutedCoreObjects } from './core-fragment.js'
import { SenderCounter } from './counters.js'
import { PrivateRouteError } from './errors.js'
import {
  decodeM3ContextEnvelope,
  encodeM3ContextAD,
  encodeM3ContextEnvelope
} from './m3-context.js'
import { consumeOpenRouteHandoff, destroyOpenRouteMaterial } from './open-route-handoff.js'
import { CELL_CLASS, CONTEXT_CLASS, DIRECTION } from './protocol.js'

const ROUTE_FRAME_SIZE = 1100
const ROUTE_PLAINTEXT_SIZE = 1076
const MAX_ROUTE_PAYLOAD = 1073
const AEAD_TAG_SIZE = 16
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn
const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const fillIntrinsic = Uint8Array.prototype.fill
const setIntrinsic = Uint8Array.prototype.set
const subarrayIntrinsic = Uint8Array.prototype.subarray

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function authentication() {
  throw PrivateRouteError.ERR_AUTHENTICATION()
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

function option(value, name) {
  try {
    return value[name]
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

function fixed(value, size) {
  return length(value) === size
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) fillIntrinsic.call(value, 0)
  } catch {}
}

function set(target, source, offset = 0) {
  try {
    setIntrinsic.call(target, source, offset)
  } catch {
    invalid()
  }
}

function subarray(value, start, end) {
  try {
    return subarrayIntrinsic.call(value, start, end)
  } catch {
    invalid()
  }
}

function copy(value) {
  let output = null
  try {
    if (length(value) < 0) invalid()
    output = b4a.allocUnsafeSlow(length(value))
    set(output, value)
    return output
  } catch (err) {
    clear(output)
    if (err instanceof PrivateRouteError) throw err
    invalid()
  }
}

function nowValue(now) {
  let value
  try {
    value = now()
  } catch {
    invalid()
  }
  if (Number.isSafeInteger(value) && value >= 0) value = BigInt(value)
  if (typeof value !== 'bigint' || value < 0n || value > MAX_UINT64) invalid()
  return value
}

function random(randomBytes, size) {
  let value = null
  try {
    value = randomBytes(size)
    if (!fixed(value, size)) invalid()
    return copy(value)
  } finally {
    clear(value)
  }
}

function writeUint16(target, value, offset) {
  target[offset] = value >>> 8
  target[offset + 1] = value
}

function readUint16(target, offset) {
  return (target[offset] << 8) | target[offset + 1]
}

function writeUint64(target, value, offset = 0) {
  for (let index = offset + 7; index >= offset; index--) {
    target[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function readUint64(target, offset = 0) {
  let value = 0n
  for (let index = offset; index < offset + 8; index++) {
    value = (value << 8n) | BigInt(target[index])
  }
  return value
}

function contextDefinition(contextClass) {
  if (contextClass === CONTEXT_CLASS.ROUTE_PAYLOAD) {
    return {
      cellClass: CELL_CLASS.STREAM,
      keyPrefix: 'payload',
      rxName: 'payloadRx',
      txName: 'payloadTx'
    }
  }
  if (contextClass === CONTEXT_CLASS.TERMINAL_CONTROL_ORDERED) {
    return {
      cellClass: CELL_CLASS.CONTROL,
      keyPrefix: 'control',
      rxName: 'controlRx',
      txName: 'controlTx'
    }
  }
  invalid()
}

function direction(state, sending) {
  if (sending) return state.material.initiator ? DIRECTION.FORWARD : DIRECTION.REVERSE
  return state.material.initiator ? DIRECTION.REVERSE : DIRECTION.FORWARD
}

function directionalMaterial(state, definition, selectedDirection) {
  const suffix = selectedDirection === DIRECTION.FORWARD ? 'Forward' : 'Reverse'
  return {
    key: state.material[`${definition.keyPrefix}${suffix}Key`],
    noncePrefix: state.material[`${definition.keyPrefix}${suffix}NoncePrefix`]
  }
}

function associatedData(state, contextClass, selectedDirection, counter) {
  return encodeM3ContextAD({
    contextClass,
    branchId: state.material.branchId,
    circuitId: state.material.circuitId,
    generation: state.material.generation,
    direction: selectedDirection,
    innerCounter: counter
  })
}

function sealFrame(state, contextClass, payload, randomBytes) {
  const definition = contextDefinition(contextClass)
  const selectedDirection = direction(state, true)
  const selected = directionalMaterial(state, definition, selectedDirection)
  const counter = state[definition.txName].next()
  let ad = null
  let plaintext = null
  let padding = null
  let ciphertext = null
  let frame = null
  try {
    ad = associatedData(state, contextClass, selectedDirection, counter)
    plaintext = b4a.allocUnsafeSlow(ROUTE_PLAINTEXT_SIZE)
    plaintext[0] = definition.cellClass
    writeUint16(plaintext, payload.byteLength, 1)
    set(plaintext, payload, 3)
    padding = random(randomBytes, MAX_ROUTE_PAYLOAD - payload.byteLength)
    set(plaintext, padding, 3 + payload.byteLength)
    ciphertext = state.crypto.seal({
      key: selected.key,
      noncePrefix: selected.noncePrefix,
      counter,
      associatedData: ad,
      plaintext
    })
    if (!fixed(ciphertext, ROUTE_PLAINTEXT_SIZE + AEAD_TAG_SIZE)) invalid()
    frame = b4a.allocUnsafeSlow(ROUTE_FRAME_SIZE)
    writeUint64(frame, counter)
    set(frame, ciphertext, 8)
    return encodeM3ContextEnvelope({ contextClass, frame })
  } finally {
    clear(ad)
    clear(plaintext)
    clear(padding)
    clear(ciphertext)
    clear(frame)
  }
}

function openFrame(state, contextClass, envelope) {
  const definition = contextDefinition(contextClass)
  const selectedDirection = direction(state, false)
  const selected = directionalMaterial(state, definition, selectedDirection)
  let decoded = null
  let ad = null
  let plaintext = null
  let payload = null
  try {
    decoded = decodeM3ContextEnvelope(envelope)
    if (decoded.contextClass !== contextClass) invalid()
    const counter = readUint64(decoded.frame)
    ad = associatedData(state, contextClass, selectedDirection, counter)
    plaintext = state.crypto.open({
      key: selected.key,
      noncePrefix: selected.noncePrefix,
      counter,
      associatedData: ad,
      ciphertext: subarray(decoded.frame, 8, ROUTE_FRAME_SIZE)
    })
    if (!fixed(plaintext, ROUTE_PLAINTEXT_SIZE) || plaintext[0] !== definition.cellClass) {
      invalid()
    }
    if (counter !== state[definition.rxName]) authentication()
    const payloadLength = readUint16(plaintext, 1)
    if (payloadLength > MAX_ROUTE_PAYLOAD) invalid()
    payload = copy(subarray(plaintext, 3, 3 + payloadLength))
    if (counter === MAX_UINT64) state[definition.rxName] = null
    else state[definition.rxName] = counter + 1n
    const result = payload
    payload = null
    return result
  } finally {
    if (decoded) clear(decoded.frame)
    clear(ad)
    clear(plaintext)
    clear(payload)
  }
}

export class OpenRouteSession {
  #state

  constructor(handoff, options) {
    let material = null
    try {
      material = consumeOpenRouteHandoff(handoff)
      options = object(options)
      const now = option(options, 'now')
      const crypto = option(options, 'crypto')
      if (
        typeof now !== 'function' ||
        !object(crypto) ||
        typeof crypto.seal !== 'function' ||
        typeof crypto.open !== 'function'
      ) {
        invalid()
      }
      if (nowValue(now) >= material.expiresAt) {
        throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
      }
      this.#state = {
        controlRx: 0n,
        controlTx: new SenderCounter(),
        crypto,
        destroyed: false,
        material,
        mutating: false,
        now,
        payloadRx: 0n,
        payloadTx: new SenderCounter(),
        reassembler: new RoutedCoreReassembler({ now }),
        violated: false
      }
      material = null
      Object.freeze(this)
    } catch (err) {
      destroyOpenRouteMaterial(material)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    }
  }

  sealPayload(payload, options) {
    return this.#seal(CONTEXT_CLASS.ROUTE_PAYLOAD, payload, options)
  }

  openPayload(envelope) {
    return this.#open(CONTEXT_CLASS.ROUTE_PAYLOAD, envelope)
  }

  sealPayloadObject(encoded, options) {
    return this.#sealObject(CONTEXT_CLASS.ROUTE_PAYLOAD, encoded, options)
  }

  openPayloadObject(envelope) {
    return this.#openObject(CONTEXT_CLASS.ROUTE_PAYLOAD, envelope)
  }

  sealControl(payload, options) {
    return this.#seal(CONTEXT_CLASS.TERMINAL_CONTROL_ORDERED, payload, options)
  }

  openControl(envelope) {
    return this.#open(CONTEXT_CLASS.TERMINAL_CONTROL_ORDERED, envelope)
  }

  sealControlObject(encoded, options) {
    return this.#sealObject(CONTEXT_CLASS.TERMINAL_CONTROL_ORDERED, encoded, options)
  }

  openControlObject(envelope) {
    return this.#openObject(CONTEXT_CLASS.TERMINAL_CONTROL_ORDERED, envelope)
  }

  diagnostics() {
    const state = this.#state
    return Object.freeze({ state: !state || state.destroyed ? 'DESTROYED' : 'OPEN' })
  }

  destroy() {
    const state = this.#state
    if (!state || state.destroyed) return false
    this.#terminate()
    return true
  }

  #seal(contextClass, payload, options) {
    const state = this.#begin()
    let owned = null
    try {
      owned = copy(payload)
      if (owned.byteLength > MAX_ROUTE_PAYLOAD) invalid()
      const randomBytes = option(object(options), 'randomBytes')
      if (typeof randomBytes !== 'function') invalid()
      this.#checkExpiry(state)
      const envelope = sealFrame(state, contextClass, owned, randomBytes)
      this.#assertLive(state)
      return envelope
    } catch (err) {
      this.#terminate()
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      clear(owned)
    }
  }

  #open(contextClass, envelope) {
    const state = this.#begin()
    try {
      this.#checkExpiry(state)
      const payload = openFrame(state, contextClass, envelope)
      this.#assertLive(state)
      return payload
    } catch (err) {
      this.#terminate()
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
    }
  }

  #sealObject(contextClass, encoded, options) {
    const state = this.#begin()
    let objects = null
    const envelopes = []
    try {
      objects = encodeRoutedCoreObjects(encoded)
      const randomBytes = option(object(options), 'randomBytes')
      if (typeof randomBytes !== 'function') invalid()
      this.#checkExpiry(state)
      for (const semantic of objects) {
        envelopes.push(sealFrame(state, contextClass, semantic, randomBytes))
        this.#assertLive(state)
      }
      return envelopes
    } catch (err) {
      for (const envelope of envelopes) clear(envelope)
      envelopes.length = 0
      this.#terminate()
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      if (objects) {
        for (const semantic of objects) clear(semantic)
      }
    }
  }

  #openObject(contextClass, envelope) {
    const state = this.#begin()
    let semantic = null
    try {
      this.#checkExpiry(state)
      semantic = openFrame(state, contextClass, envelope)
      this.#assertLive(state)
      return state.reassembler.accept(semantic, contextClass)
    } catch (err) {
      this.#terminate()
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      clear(semantic)
    }
  }

  #begin() {
    const state = this.#state
    if (!state || state.destroyed) throw PrivateRouteError.ERR_DESTROYED()
    if (state.mutating) {
      state.violated = true
      throw PrivateRouteError.ERR_BUSY()
    }
    state.mutating = true
    state.violated = false
    return state
  }

  #assertLive(state) {
    if (state.destroyed) throw PrivateRouteError.ERR_DESTROYED()
    if (state.violated) invalid()
  }

  #checkExpiry(state) {
    this.#assertLive(state)
    const current = nowValue(state.now)
    this.#assertLive(state)
    if (current >= state.material.expiresAt) {
      throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
    }
  }

  #terminate() {
    const state = this.#state
    if (!state || state.destroyed) return false
    state.destroyed = true
    try {
      state.payloadTx.destroy()
    } catch {}
    try {
      state.controlTx.destroy()
    } catch {}
    try {
      state.reassembler.destroy()
    } catch {}
    destroyOpenRouteMaterial(state.material)
    state.material = null
    state.crypto = null
    state.now = null
    state.payloadTx = null
    state.controlTx = null
    state.payloadRx = null
    state.controlRx = null
    state.reassembler = null
    return true
  }
}
