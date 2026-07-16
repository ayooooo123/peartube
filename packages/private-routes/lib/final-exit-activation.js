import b4a from 'b4a'

import { DatagramReplayWindow, SenderCounter } from './counters.js'
import { PrivateRouteError } from './errors.js'
import {
  DHT_EXIT_ACTIVATE_SIZE,
  decodeDhtExitActivate,
  digestExitOriginServicePolicy,
  digestPayloadParameters,
  encodeDhtExitActivate
} from './final-exit.js'
import { consumeFinalExitHandoff, destroyFinalExitHandoffMaterial } from './final-exit-handoff.js'
import {
  decodeM3ContextEnvelope,
  encodeM3ContextAD,
  encodeM3ContextEnvelope
} from './m3-context.js'
import { CELL_CLASS, CONTEXT_CLASS, DIRECTION } from './protocol.js'
import { decodeTailControlTranscript } from './tail-control.js'

const ROUTE_FRAME_SIZE = 1100
const ROUTE_PLAINTEXT_SIZE = 1076
const MAX_ROUTE_PAYLOAD = 1073
const AEAD_TAG_SIZE = 16
const FINALIZATION_TIMEOUT_MS = 5_000n
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

function same(left, right) {
  try {
    return fixed(left, length(right)) && b4a.equals(left, right)
  } catch {
    return false
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

function associatedData(state, counter) {
  return encodeM3ContextAD({
    contextClass: CONTEXT_CLASS.TAIL_FINALIZE_DATAGRAM,
    branchId: state.transcript.branchId,
    circuitId: state.transcript.circuitId,
    generation: state.transcript.generation,
    direction: DIRECTION.FORWARD,
    innerCounter: counter
  })
}

function sealFrame(state, encoded, randomBytes) {
  const counter = state.tx.next()
  let ad = null
  let plaintext = null
  let padding = null
  let ciphertext = null
  let frame = null
  try {
    ad = associatedData(state, counter)
    plaintext = b4a.allocUnsafeSlow(ROUTE_PLAINTEXT_SIZE)
    plaintext[0] = CELL_CLASS.CONTROL
    writeUint16(plaintext, encoded.byteLength, 1)
    set(plaintext, encoded, 3)
    padding = random(randomBytes, MAX_ROUTE_PAYLOAD - encoded.byteLength)
    set(plaintext, padding, 3 + encoded.byteLength)
    ciphertext = state.crypto.seal({
      key: state.material.finalizeForwardKey,
      noncePrefix: state.material.finalizeForwardNoncePrefix,
      counter,
      associatedData: ad,
      plaintext
    })
    if (!fixed(ciphertext, ROUTE_PLAINTEXT_SIZE + AEAD_TAG_SIZE)) invalid()
    frame = b4a.allocUnsafeSlow(ROUTE_FRAME_SIZE)
    writeUint64(frame, counter)
    set(frame, ciphertext, 8)
    return encodeM3ContextEnvelope({
      contextClass: CONTEXT_CLASS.TAIL_FINALIZE_DATAGRAM,
      frame
    })
  } finally {
    clear(ad)
    clear(plaintext)
    clear(padding)
    clear(ciphertext)
    clear(frame)
  }
}

function openFrame(state, envelope) {
  let decoded = null
  let ad = null
  let plaintext = null
  let encoded = null
  try {
    decoded = decodeM3ContextEnvelope(envelope)
    if (decoded.contextClass !== CONTEXT_CLASS.TAIL_FINALIZE_DATAGRAM) invalid()
    const counter = readUint64(decoded.frame)
    ad = associatedData(state, counter)
    plaintext = state.crypto.open({
      key: state.material.finalizeForwardKey,
      noncePrefix: state.material.finalizeForwardNoncePrefix,
      counter,
      associatedData: ad,
      ciphertext: subarray(decoded.frame, 8, ROUTE_FRAME_SIZE)
    })
    if (!fixed(plaintext, ROUTE_PLAINTEXT_SIZE) || plaintext[0] !== CELL_CLASS.CONTROL) invalid()
    const payloadLength = readUint16(plaintext, 1)
    if (payloadLength !== DHT_EXIT_ACTIVATE_SIZE) invalid()
    encoded = copy(subarray(plaintext, 3, 3 + payloadLength))
    try {
      state.rx.acceptAuthenticated(counter)
    } catch (err) {
      if (err instanceof PrivateRouteError && err.code === 'REPLAY') {
        clear(encoded)
        encoded = null
        return null
      }
      throw err
    }
    const result = encoded
    encoded = null
    return result
  } finally {
    if (decoded) clear(decoded.frame)
    clear(ad)
    clear(plaintext)
    clear(encoded)
  }
}

function clearTranscript(transcript) {
  if (!transcript) return
  for (const name of [
    'branchId',
    'circuitId',
    'clientTailEphemeralPublicKey',
    'advertisedTailRouteEncryptionPublicKey',
    'candidateAdvertisementDigest',
    'clientNonce',
    'tailIdentity',
    'admittedLimitsDigest'
  ]) {
    clear(transcript[name])
  }
}

function clearActivation(activation) {
  if (!activation) return
  clear(activation.clientActivationNonce)
  clear(activation.exitOriginCommandPolicyDigest)
  clear(activation.payloadParametersDigest)
}

function activationProjection(activation) {
  return Object.freeze({
    clientActivationNonce: copy(activation.clientActivationNonce),
    exitOriginCommandPolicyDigest: copy(activation.exitOriginCommandPolicyDigest),
    payloadParametersDigest: copy(activation.payloadParametersDigest)
  })
}

export class FinalExitActivationSession {
  #state

  constructor(handoff, options) {
    let material = null
    let tailControl = null
    let transcript = null
    let policyDigest = null
    let payloadDigest = null
    try {
      material = consumeFinalExitHandoff(handoff)
      tailControl = material.tailControl
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
      const current = nowValue(now)
      if (current >= material.expiresAt) throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
      transcript = decodeTailControlTranscript(material.tailControlTranscript)
      if (transcript.extensionIndex !== 2) authentication()
      policyDigest = digestExitOriginServicePolicy()
      payloadDigest = digestPayloadParameters(option(options, 'payloadParameters'))
      this.#state = {
        activation: null,
        activationEncoded: null,
        crypto,
        deadline: null,
        destroyed: false,
        material,
        mutating: false,
        now,
        payloadDigest,
        policyDigest,
        rx: material.initiator ? null : new DatagramReplayWindow({ window: 64 }),
        state: 'TAIL_READY',
        transcript,
        tx: material.initiator ? new SenderCounter() : null,
        violated: false
      }
      material = null
      tailControl = null
      transcript = null
      policyDigest = null
      payloadDigest = null
      Object.freeze(this)
    } catch (err) {
      destroyFinalExitHandoffMaterial(material)
      try {
        if (tailControl) tailControl.destroy()
      } catch {}
      clearTranscript(transcript)
      clear(policyDigest)
      clear(payloadDigest)
      if (err instanceof PrivateRouteError) throw err
      invalid()
    }
  }

  sealActivate(options) {
    const state = this.#begin()
    let nonce = null
    let encoded = null
    try {
      if (!state.material.initiator || state.state !== 'TAIL_READY') authentication()
      this.#checkDeadline(state, true)
      const randomBytes = option(object(options), 'randomBytes')
      if (typeof randomBytes !== 'function') invalid()
      nonce = random(randomBytes, 32)
      this.#assertLive(state)
      encoded = encodeDhtExitActivate({
        clientActivationNonce: nonce,
        exitOriginCommandPolicyDigest: state.policyDigest,
        payloadParametersDigest: state.payloadDigest
      })
      const envelope = sealFrame(state, encoded, randomBytes)
      this.#assertLive(state)
      state.activationEncoded = copy(encoded)
      state.activation = Object.freeze({
        clientActivationNonce: copy(nonce),
        exitOriginCommandPolicyDigest: copy(state.policyDigest),
        payloadParametersDigest: copy(state.payloadDigest)
      })
      state.state = 'ACTIVATING'
      return envelope
    } catch (err) {
      this.#terminate()
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      clear(nonce)
      clear(encoded)
    }
  }

  retryActivate(options) {
    const state = this.#begin()
    try {
      if (!state.material.initiator || state.state !== 'ACTIVATING') authentication()
      const randomBytes = option(object(options), 'randomBytes')
      if (typeof randomBytes !== 'function') invalid()
      this.#checkDeadline(state)
      const envelope = sealFrame(state, state.activationEncoded, randomBytes)
      this.#assertLive(state)
      return envelope
    } catch (err) {
      this.#terminate()
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
    }
  }

  openActivate(envelope) {
    const state = this.#begin()
    let encoded = null
    let activation = null
    try {
      if (
        state.material.initiator ||
        (state.state !== 'TAIL_READY' && state.state !== 'FINALIZING')
      ) {
        authentication()
      }
      this.#checkDeadline(state, state.state === 'TAIL_READY')
      encoded = openFrame(state, envelope)
      this.#assertLive(state)
      if (encoded === null) return null
      activation = decodeDhtExitActivate(encoded)
      if (
        !same(activation.exitOriginCommandPolicyDigest, state.policyDigest) ||
        !same(activation.payloadParametersDigest, state.payloadDigest)
      ) {
        authentication()
      }
      if (state.activationEncoded && !same(encoded, state.activationEncoded)) authentication()
      if (!state.activationEncoded) {
        state.activationEncoded = copy(encoded)
        state.activation = Object.freeze({
          clientActivationNonce: copy(activation.clientActivationNonce),
          exitOriginCommandPolicyDigest: copy(activation.exitOriginCommandPolicyDigest),
          payloadParametersDigest: copy(activation.payloadParametersDigest)
        })
        state.state = 'FINALIZING'
      }
      return activationProjection(state.activation)
    } catch (err) {
      this.#terminate()
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      clear(encoded)
      clearActivation(activation)
    }
  }

  diagnostics() {
    const state = this.#state
    return Object.freeze({ state: !state || state.destroyed ? 'DESTROYED' : state.state })
  }

  destroy() {
    const state = this.#state
    if (!state || state.destroyed) return false
    this.#terminate()
    return true
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

  #checkDeadline(state, start = false) {
    this.#assertLive(state)
    const current = nowValue(state.now)
    this.#assertLive(state)
    if (state.deadline === null) {
      if (!start) invalid()
      const deadline = current + FINALIZATION_TIMEOUT_MS
      state.deadline = deadline < state.material.expiresAt ? deadline : state.material.expiresAt
    }
    if (current >= state.deadline) {
      throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
    }
  }

  #terminate() {
    const state = this.#state
    if (!state || state.destroyed) return false
    state.destroyed = true
    const tailControl = state.material && state.material.tailControl
    destroyFinalExitHandoffMaterial(state.material)
    state.material = null
    try {
      if (tailControl) tailControl.destroy()
    } catch {}
    try {
      if (state.tx) state.tx.destroy()
    } catch {}
    try {
      if (state.rx) state.rx.destroy()
    } catch {}
    clearTranscript(state.transcript)
    clear(state.policyDigest)
    clear(state.payloadDigest)
    clear(state.activationEncoded)
    clearActivation(state.activation)
    state.transcript = null
    state.policyDigest = null
    state.payloadDigest = null
    state.activationEncoded = null
    state.activation = null
    state.deadline = null
    state.crypto = null
    state.now = null
    state.tx = null
    state.rx = null
    state.state = 'DESTROYED'
    return true
  }
}
