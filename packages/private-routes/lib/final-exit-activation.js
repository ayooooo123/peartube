import b4a from 'b4a'

import { DatagramReplayWindow, SenderCounter } from './counters.js'
import { PrivateRouteError } from './errors.js'
import {
  DHT_EXIT_ACTIVATE_SIZE,
  DHT_EXIT_OPEN_SIZE,
  DHT_EXIT_READY_SIZE,
  DHT_EXIT_READY_ACK_SIZE,
  decodeDhtExitActivate,
  decodeDhtExitOpen,
  decodeDhtExitReady,
  decodeDhtExitReadyAck,
  deriveFinalExitTestVector,
  dhtExitReadySignatureInput,
  digestDhtExitReady,
  digestDhtExitReadyAck,
  digestFinalExitTranscript,
  digestExitOriginServicePolicy,
  digestPayloadParameters,
  encodeDhtExitActivate,
  encodeDhtExitOpen,
  encodeDhtExitReady,
  encodeDhtExitReadyAck,
  encodeDhtExitReadyBody,
  encodeFinalExitTranscript
} from './final-exit.js'
import { consumeFinalExitHandoff, destroyFinalExitHandoffMaterial } from './final-exit-handoff.js'
import {
  decodeM3ContextEnvelope,
  encodeM3ContextAD,
  encodeM3ContextEnvelope
} from './m3-context.js'
import {
  createOpenRouteHandoff,
  destroyOpenRouteMaterial,
  revokeOpenRouteHandoff
} from './open-route-handoff.js'
import { CELL_CLASS, CONTEXT_CLASS, DIRECTION } from './protocol.js'
import { decodeTailControlTranscript, digestTailControlTranscript } from './tail-control.js'

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

function associatedData(state, counter, contextClass, direction) {
  return encodeM3ContextAD({
    contextClass,
    branchId: state.transcript.branchId,
    circuitId: state.transcript.circuitId,
    generation: state.transcript.generation,
    direction,
    innerCounter: counter
  })
}

function datagramState(state, contextClass, direction, sending) {
  const final = contextClass === CONTEXT_CLASS.FINAL_EXIT_FINALIZE_DATAGRAM
  if (!final && contextClass !== CONTEXT_CLASS.TAIL_FINALIZE_DATAGRAM) invalid()
  const material = final ? state.finalMaterial : state.material
  if (!material) authentication()
  if (direction === DIRECTION.FORWARD) {
    return {
      counter: sending
        ? final
          ? state.finalForwardTx
          : state.forwardTx
        : final
          ? state.finalForwardRx
          : state.forwardRx,
      key: material.finalizeForwardKey,
      noncePrefix: material.finalizeForwardNoncePrefix
    }
  }
  if (direction === DIRECTION.REVERSE) {
    return {
      counter: sending
        ? final
          ? state.finalReverseTx
          : state.reverseTx
        : final
          ? state.finalReverseRx
          : state.reverseRx,
      key: material.finalizeReverseKey,
      noncePrefix: material.finalizeReverseNoncePrefix
    }
  }
  invalid()
}

function sealFrame(state, encoded, randomBytes, contextClass, direction) {
  const selected = datagramState(state, contextClass, direction, true)
  if (!selected.counter) authentication()
  const counter = selected.counter.next()
  let ad = null
  let plaintext = null
  let padding = null
  let ciphertext = null
  let frame = null
  try {
    ad = associatedData(state, counter, contextClass, direction)
    plaintext = b4a.allocUnsafeSlow(ROUTE_PLAINTEXT_SIZE)
    plaintext[0] = CELL_CLASS.DATAGRAM
    writeUint16(plaintext, encoded.byteLength, 1)
    set(plaintext, encoded, 3)
    padding = random(randomBytes, MAX_ROUTE_PAYLOAD - encoded.byteLength)
    set(plaintext, padding, 3 + encoded.byteLength)
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
    return encodeM3ContextEnvelope({
      contextClass,
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

function openFrame(state, envelope, contextClass, direction, expectedSize) {
  let decoded = null
  let ad = null
  let plaintext = null
  let encoded = null
  try {
    decoded = decodeM3ContextEnvelope(envelope)
    if (decoded.contextClass !== contextClass) invalid()
    const selected = datagramState(state, contextClass, direction, false)
    if (!selected.counter) authentication()
    const counter = readUint64(decoded.frame)
    ad = associatedData(state, counter, contextClass, direction)
    plaintext = state.crypto.open({
      key: selected.key,
      noncePrefix: selected.noncePrefix,
      counter,
      associatedData: ad,
      ciphertext: subarray(decoded.frame, 8, ROUTE_FRAME_SIZE)
    })
    if (!fixed(plaintext, ROUTE_PLAINTEXT_SIZE) || plaintext[0] !== CELL_CLASS.DATAGRAM) invalid()
    const payloadLength = readUint16(plaintext, 1)
    if (payloadLength !== expectedSize) invalid()
    encoded = copy(subarray(plaintext, 3, 3 + payloadLength))
    try {
      selected.counter.acceptAuthenticated(counter)
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

function clearReady(ready) {
  if (!ready) return
  for (const value of Object.values(ready)) clear(value)
}

function readyProjection(ready) {
  return Object.freeze({
    branchClass: ready.branchClass,
    branchId: copy(ready.branchId),
    circuitId: copy(ready.circuitId),
    generation: ready.generation,
    exitIdentity: copy(ready.exitIdentity),
    clientActivationNonce: copy(ready.clientActivationNonce),
    exitOriginCommandPolicyDigest: copy(ready.exitOriginCommandPolicyDigest),
    payloadParametersDigest: copy(ready.payloadParametersDigest),
    finalExitTranscriptDigest: copy(ready.finalExitTranscriptDigest),
    readyNonce: copy(ready.readyNonce)
  })
}

function clearAck(ack) {
  if (!ack) return
  for (const value of Object.values(ack)) clear(value)
}

function clearOpen(open) {
  if (!open) return
  for (const value of Object.values(open)) clear(value)
}

function openProjection(open) {
  return Object.freeze({
    branchClass: open.branchClass,
    branchId: copy(open.branchId),
    circuitId: copy(open.circuitId),
    generation: open.generation,
    ackDigest: copy(open.ackDigest),
    clientActivationNonce: copy(open.clientActivationNonce),
    exitOriginCommandPolicyDigest: copy(open.exitOriginCommandPolicyDigest),
    payloadParametersDigest: copy(open.payloadParametersDigest)
  })
}

function clearFinalMaterial(material) {
  if (!material) return
  for (const value of Object.values(material)) clear(value)
}

function destroyCounter(state, name) {
  const counter = state[name]
  state[name] = null
  try {
    if (counter) counter.destroy()
  } catch {}
}

function clearMaterialField(material, name) {
  if (!material) return
  let value = null
  try {
    value = material[name]
    material[name] = null
  } catch {}
  clear(value)
}

function eraseOrderedTailControl(state) {
  const tailControl = state.material && state.material.tailControl
  if (state.material) state.material.tailControl = null
  try {
    if (tailControl) tailControl.destroy()
  } catch {}
  clearMaterialField(state.material, 'sharedSecret')
}

function installRetiredFinalizationState(state) {
  eraseOrderedTailControl(state)
  if (state.initiator) {
    destroyCounter(state, 'forwardTx')
    destroyCounter(state, 'finalForwardTx')
    clearMaterialField(state.material, 'finalizeForwardKey')
    clearMaterialField(state.material, 'finalizeForwardNoncePrefix')
    clearMaterialField(state.finalMaterial, 'finalizeForwardKey')
    clearMaterialField(state.finalMaterial, 'finalizeForwardNoncePrefix')
  } else {
    destroyCounter(state, 'reverseTx')
    clearMaterialField(state.material, 'finalizeReverseKey')
    clearMaterialField(state.material, 'finalizeReverseNoncePrefix')
  }
}

function eraseRetiredFinalizationState(state) {
  for (const name of [
    'forwardTx',
    'forwardRx',
    'reverseTx',
    'reverseRx',
    'finalForwardTx',
    'finalForwardRx',
    'finalReverseTx',
    'finalReverseRx'
  ]) {
    destroyCounter(state, name)
  }
  for (const name of [
    'finalizeForwardKey',
    'finalizeForwardNoncePrefix',
    'finalizeReverseKey',
    'finalizeReverseNoncePrefix'
  ]) {
    clearMaterialField(state.material, name)
    clearMaterialField(state.finalMaterial, name)
  }
  clear(state.activationEncoded)
  clearActivation(state.activation)
  clear(state.readyEncoded)
  clearReady(state.ready)
  clear(state.ackEncoded)
  clearAck(state.ack)
  clear(state.openEncoded)
  clearOpen(state.open)
  state.activationEncoded = null
  state.activation = null
  state.readyEncoded = null
  state.ready = null
  state.ackEncoded = null
  state.ack = null
  state.openEncoded = null
  state.open = null
  state.graceDeadline = null
  state.graceRetired = true
}

function buildOpenRouteMaterial(state) {
  const material = {}
  let complete = false
  try {
    material.initiator = state.initiator
    material.expiresAt = state.material.expiresAt
    material.branchClass = state.transcript.branchClass
    material.branchId = copy(state.transcript.branchId)
    material.circuitId = copy(state.transcript.circuitId)
    material.generation = state.transcript.generation
    material.exitIdentity = copy(state.transcript.tailIdentity)
    material.policyDigest = copy(state.policyDigest)
    material.payloadDigest = copy(state.payloadDigest)
    for (const name of [
      'payloadForwardKey',
      'payloadReverseKey',
      'payloadForwardNoncePrefix',
      'payloadReverseNoncePrefix',
      'controlForwardKey',
      'controlReverseKey',
      'controlForwardNoncePrefix',
      'controlReverseNoncePrefix'
    ]) {
      material[name] = copy(state.finalMaterial[name])
    }
    complete = true
    return material
  } finally {
    if (!complete) destroyOpenRouteMaterial(material)
  }
}

function buildFinalTranscript(state, activation) {
  let tailDigest = null
  let encoded = null
  let digest = null
  let complete = false
  try {
    tailDigest = digestTailControlTranscript(state.material.tailControlTranscript)
    encoded = encodeFinalExitTranscript({
      branchClass: state.transcript.branchClass,
      branchId: state.transcript.branchId,
      circuitId: state.transcript.circuitId,
      generation: state.transcript.generation,
      tailControlTranscriptDigest: tailDigest,
      exitAdvertisementDigest: state.transcript.candidateAdvertisementDigest,
      exitIdentity: state.transcript.tailIdentity,
      clientActivationNonce: activation.clientActivationNonce,
      exitOriginCommandPolicyDigest: activation.exitOriginCommandPolicyDigest,
      payloadParametersDigest: activation.payloadParametersDigest
    })
    digest = digestFinalExitTranscript(encoded)
    complete = true
    return { encoded, digest }
  } finally {
    clear(tailDigest)
    if (!complete) {
      clear(encoded)
      clear(digest)
    }
  }
}

function installFinalMaterial(state, transcript) {
  if (state.finalMaterial || state.finalTranscript || state.finalTranscriptDigest) invalid()
  const material = deriveFinalExitTestVector(state.material.sharedSecret, transcript.encoded)
  state.finalMaterial = material
  state.finalTranscript = transcript.encoded
  state.finalTranscriptDigest = transcript.digest
  transcript.encoded = null
  transcript.digest = null
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
        typeof crypto.open !== 'function' ||
        typeof crypto.sign !== 'function' ||
        typeof crypto.verify !== 'function'
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
        ack: null,
        ackEncoded: null,
        activation: null,
        activationEncoded: null,
        crypto,
        deadline: null,
        destroyed: false,
        finalMaterial: null,
        finalForwardRx: material.initiator ? null : new DatagramReplayWindow({ window: 64 }),
        finalForwardTx: material.initiator ? new SenderCounter() : null,
        finalReverseRx: material.initiator ? new DatagramReplayWindow({ window: 64 }) : null,
        finalReverseTx: material.initiator ? null : new SenderCounter(),
        finalTranscript: null,
        finalTranscriptDigest: null,
        forwardRx: material.initiator ? null : new DatagramReplayWindow({ window: 64 }),
        forwardTx: material.initiator ? new SenderCounter() : null,
        graceDeadline: null,
        graceRetired: false,
        initiator: material.initiator,
        material,
        mutating: false,
        now,
        open: null,
        openEncoded: null,
        openHandoff: null,
        payloadDigest,
        policyDigest,
        ready: null,
        readyEncoded: null,
        reverseRx: material.initiator ? new DatagramReplayWindow({ window: 64 }) : null,
        reverseTx: material.initiator ? null : new SenderCounter(),
        state: 'TAIL_READY',
        transcript,
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
      if (!state.initiator || state.state !== 'TAIL_READY') authentication()
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
      const envelope = sealFrame(
        state,
        encoded,
        randomBytes,
        CONTEXT_CLASS.TAIL_FINALIZE_DATAGRAM,
        DIRECTION.FORWARD
      )
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
      if (!state.initiator || state.state !== 'ACTIVATING') authentication()
      const randomBytes = option(object(options), 'randomBytes')
      if (typeof randomBytes !== 'function') invalid()
      this.#checkDeadline(state)
      const envelope = sealFrame(
        state,
        state.activationEncoded,
        randomBytes,
        CONTEXT_CLASS.TAIL_FINALIZE_DATAGRAM,
        DIRECTION.FORWARD
      )
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
      if (state.initiator || (state.state !== 'TAIL_READY' && state.state !== 'FINALIZING')) {
        authentication()
      }
      this.#checkDeadline(state, state.state === 'TAIL_READY')
      encoded = openFrame(
        state,
        envelope,
        CONTEXT_CLASS.TAIL_FINALIZE_DATAGRAM,
        DIRECTION.FORWARD,
        DHT_EXIT_ACTIVATE_SIZE
      )
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
        const finalTranscript = buildFinalTranscript(state, state.activation)
        try {
          installFinalMaterial(state, finalTranscript)
        } finally {
          clear(finalTranscript.encoded)
          clear(finalTranscript.digest)
        }
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

  sealReady(options) {
    const state = this.#begin()
    let secretKey = null
    let readyNonce = null
    let body = null
    let input = null
    let signature = null
    let encoded = null
    let ready = null
    try {
      if (
        state.initiator ||
        state.state !== 'FINALIZING' ||
        state.readyEncoded ||
        !state.finalTranscriptDigest
      ) {
        authentication()
      }
      this.#checkDeadline(state)
      options = object(options)
      const randomBytes = option(options, 'randomBytes')
      secretKey = copy(option(options, 'identitySecretKey'))
      if (typeof randomBytes !== 'function' || !fixed(secretKey, 64)) invalid()
      readyNonce = random(randomBytes, 32)
      this.#assertLive(state)
      body = encodeDhtExitReadyBody({
        branchClass: state.transcript.branchClass,
        branchId: state.transcript.branchId,
        circuitId: state.transcript.circuitId,
        generation: state.transcript.generation,
        exitIdentity: state.transcript.tailIdentity,
        clientActivationNonce: state.activation.clientActivationNonce,
        exitOriginCommandPolicyDigest: state.policyDigest,
        payloadParametersDigest: state.payloadDigest,
        finalExitTranscriptDigest: state.finalTranscriptDigest,
        readyNonce
      })
      input = dhtExitReadySignatureInput(body)
      signature = state.crypto.sign(input, secretKey)
      this.#assertLive(state)
      if (
        !fixed(signature, 64) ||
        !state.crypto.verify(input, signature, state.transcript.tailIdentity)
      ) {
        invalid()
      }
      this.#assertLive(state)
      encoded = encodeDhtExitReady({
        branchClass: state.transcript.branchClass,
        branchId: state.transcript.branchId,
        circuitId: state.transcript.circuitId,
        generation: state.transcript.generation,
        exitIdentity: state.transcript.tailIdentity,
        clientActivationNonce: state.activation.clientActivationNonce,
        exitOriginCommandPolicyDigest: state.policyDigest,
        payloadParametersDigest: state.payloadDigest,
        finalExitTranscriptDigest: state.finalTranscriptDigest,
        readyNonce,
        signature
      })
      const envelope = sealFrame(
        state,
        encoded,
        randomBytes,
        CONTEXT_CLASS.TAIL_FINALIZE_DATAGRAM,
        DIRECTION.REVERSE
      )
      this.#assertLive(state)
      ready = decodeDhtExitReady(encoded)
      state.readyEncoded = copy(encoded)
      state.ready = ready
      ready = null
      return envelope
    } catch (err) {
      this.#terminate()
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      clear(secretKey)
      clear(readyNonce)
      clear(body)
      clear(input)
      clear(signature)
      clear(encoded)
      clearReady(ready)
    }
  }

  retryReady(options) {
    const state = this.#begin()
    try {
      if (state.initiator || state.state !== 'FINALIZING' || !state.readyEncoded) {
        authentication()
      }
      const randomBytes = option(object(options), 'randomBytes')
      if (typeof randomBytes !== 'function') invalid()
      this.#checkDeadline(state)
      const envelope = sealFrame(
        state,
        state.readyEncoded,
        randomBytes,
        CONTEXT_CLASS.TAIL_FINALIZE_DATAGRAM,
        DIRECTION.REVERSE
      )
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

  openReady(envelope) {
    const state = this.#begin()
    let encoded = null
    let ready = null
    let input = null
    let finalTranscript = null
    try {
      if (
        !state.initiator ||
        (state.state !== 'ACTIVATING' && state.state !== 'ACKING' && state.state !== 'OPEN')
      ) {
        authentication()
      }
      const retired = state.state === 'OPEN'
      if (retired) {
        if (!this.#checkGrace(state)) return null
      } else {
        this.#checkDeadline(state)
      }
      encoded = openFrame(
        state,
        envelope,
        CONTEXT_CLASS.TAIL_FINALIZE_DATAGRAM,
        DIRECTION.REVERSE,
        DHT_EXIT_READY_SIZE
      )
      this.#assertLive(state)
      if (encoded === null) return null
      if (state.readyEncoded) {
        if (!same(encoded, state.readyEncoded)) authentication()
        if (retired) return null
        return readyProjection(state.ready)
      }
      ready = decodeDhtExitReady(encoded)
      input = dhtExitReadySignatureInput(ready.body)
      const signatureValid = state.crypto.verify(
        input,
        ready.signature,
        state.transcript.tailIdentity
      )
      this.#assertLive(state)
      if (!signatureValid) authentication()
      finalTranscript = buildFinalTranscript(state, state.activation)
      if (
        ready.branchClass !== state.transcript.branchClass ||
        !same(ready.branchId, state.transcript.branchId) ||
        !same(ready.circuitId, state.transcript.circuitId) ||
        ready.generation !== state.transcript.generation ||
        !same(ready.exitIdentity, state.transcript.tailIdentity) ||
        !same(ready.clientActivationNonce, state.activation.clientActivationNonce) ||
        !same(ready.exitOriginCommandPolicyDigest, state.policyDigest) ||
        !same(ready.payloadParametersDigest, state.payloadDigest) ||
        !same(ready.finalExitTranscriptDigest, finalTranscript.digest)
      ) {
        authentication()
      }
      installFinalMaterial(state, finalTranscript)
      state.readyEncoded = copy(encoded)
      state.ready = ready
      ready = null
      state.state = 'ACKING'
      return readyProjection(state.ready)
    } catch (err) {
      this.#terminate()
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      clear(encoded)
      clearReady(ready)
      clear(input)
      if (finalTranscript) {
        clear(finalTranscript.encoded)
        clear(finalTranscript.digest)
      }
    }
  }

  sealAck(options) {
    const state = this.#begin()
    let readyDigest = null
    let encoded = null
    let ack = null
    try {
      if (!state.initiator || state.state !== 'ACKING' || state.ackEncoded) {
        authentication()
      }
      const randomBytes = option(object(options), 'randomBytes')
      if (typeof randomBytes !== 'function') invalid()
      this.#checkDeadline(state)
      readyDigest = digestDhtExitReady(state.readyEncoded)
      encoded = encodeDhtExitReadyAck({
        branchClass: state.transcript.branchClass,
        branchId: state.transcript.branchId,
        circuitId: state.transcript.circuitId,
        generation: state.transcript.generation,
        clientActivationNonce: state.activation.clientActivationNonce,
        readyDigest
      })
      const envelope = sealFrame(
        state,
        encoded,
        randomBytes,
        CONTEXT_CLASS.FINAL_EXIT_FINALIZE_DATAGRAM,
        DIRECTION.FORWARD
      )
      this.#assertLive(state)
      ack = decodeDhtExitReadyAck(encoded)
      state.ackEncoded = copy(encoded)
      state.ack = ack
      ack = null
      return envelope
    } catch (err) {
      this.#terminate()
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      clear(readyDigest)
      clear(encoded)
      clearAck(ack)
    }
  }

  retryAck(options) {
    const state = this.#begin()
    try {
      if (!state.initiator || state.state !== 'ACKING' || !state.ackEncoded) {
        authentication()
      }
      const randomBytes = option(object(options), 'randomBytes')
      if (typeof randomBytes !== 'function') invalid()
      this.#checkDeadline(state)
      const envelope = sealFrame(
        state,
        state.ackEncoded,
        randomBytes,
        CONTEXT_CLASS.FINAL_EXIT_FINALIZE_DATAGRAM,
        DIRECTION.FORWARD
      )
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

  openRetiredActivate(envelope, options) {
    const state = this.#begin()
    let encoded = null
    try {
      if (state.initiator || state.state !== 'OPEN') authentication()
      if (!this.#checkGrace(state)) return null
      const randomBytes = option(object(options), 'randomBytes')
      if (typeof randomBytes !== 'function') invalid()
      encoded = openFrame(
        state,
        envelope,
        CONTEXT_CLASS.TAIL_FINALIZE_DATAGRAM,
        DIRECTION.FORWARD,
        DHT_EXIT_ACTIVATE_SIZE
      )
      this.#assertLive(state)
      if (encoded === null) return null
      if (!same(encoded, state.activationEncoded)) authentication()
      const response = sealFrame(
        state,
        state.openEncoded,
        randomBytes,
        CONTEXT_CLASS.FINAL_EXIT_FINALIZE_DATAGRAM,
        DIRECTION.REVERSE
      )
      this.#assertLive(state)
      return response
    } catch (err) {
      this.#terminate()
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      clear(encoded)
    }
  }

  openAck(envelope, options) {
    const state = this.#begin()
    let encoded = null
    let ack = null
    let readyDigest = null
    let ackDigest = null
    let openEncoded = null
    let open = null
    try {
      if (state.initiator || (state.state !== 'FINALIZING' && state.state !== 'OPEN')) {
        authentication()
      }
      const retired = state.state === 'OPEN'
      if (retired && !this.#checkGrace(state)) return null
      const randomBytes = option(object(options), 'randomBytes')
      if (typeof randomBytes !== 'function') invalid()
      if (!retired) this.#checkDeadline(state)
      encoded = openFrame(
        state,
        envelope,
        CONTEXT_CLASS.FINAL_EXIT_FINALIZE_DATAGRAM,
        DIRECTION.FORWARD,
        DHT_EXIT_READY_ACK_SIZE
      )
      this.#assertLive(state)
      if (encoded === null) return null
      ack = decodeDhtExitReadyAck(encoded)
      readyDigest = digestDhtExitReady(state.readyEncoded)
      if (
        ack.branchClass !== state.transcript.branchClass ||
        !same(ack.branchId, state.transcript.branchId) ||
        !same(ack.circuitId, state.transcript.circuitId) ||
        ack.generation !== state.transcript.generation ||
        !same(ack.clientActivationNonce, state.activation.clientActivationNonce) ||
        !same(ack.readyDigest, readyDigest) ||
        (state.ackEncoded && !same(encoded, state.ackEncoded))
      ) {
        authentication()
      }
      if (!state.ackEncoded) {
        ackDigest = digestDhtExitReadyAck(encoded)
        openEncoded = encodeDhtExitOpen({
          branchClass: state.transcript.branchClass,
          branchId: state.transcript.branchId,
          circuitId: state.transcript.circuitId,
          generation: state.transcript.generation,
          ackDigest,
          clientActivationNonce: state.activation.clientActivationNonce,
          exitOriginCommandPolicyDigest: state.policyDigest,
          payloadParametersDigest: state.payloadDigest
        })
        open = decodeDhtExitOpen(openEncoded)
      }
      const semanticOpen = state.openEncoded || openEncoded
      const response = sealFrame(
        state,
        semanticOpen,
        randomBytes,
        CONTEXT_CLASS.FINAL_EXIT_FINALIZE_DATAGRAM,
        DIRECTION.REVERSE
      )
      this.#assertLive(state)
      if (!state.ackEncoded) {
        state.ackEncoded = copy(encoded)
        state.ack = ack
        ack = null
        state.openEncoded = copy(openEncoded)
        state.open = open
        open = null
        this.#enterOpen(state)
      }
      return response
    } catch (err) {
      this.#terminate()
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      clear(encoded)
      clearAck(ack)
      clear(readyDigest)
      clear(ackDigest)
      clear(openEncoded)
      clearOpen(open)
    }
  }

  retryOpen(options) {
    const state = this.#begin()
    try {
      if (state.initiator || state.state !== 'OPEN' || !state.openEncoded) {
        authentication()
      }
      if (!this.#checkGrace(state)) return null
      const randomBytes = option(object(options), 'randomBytes')
      if (typeof randomBytes !== 'function') invalid()
      const envelope = sealFrame(
        state,
        state.openEncoded,
        randomBytes,
        CONTEXT_CLASS.FINAL_EXIT_FINALIZE_DATAGRAM,
        DIRECTION.REVERSE
      )
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

  openOpen(envelope) {
    const state = this.#begin()
    let encoded = null
    let open = null
    let ackDigest = null
    try {
      if (!state.initiator || (state.state !== 'ACKING' && state.state !== 'OPEN')) {
        authentication()
      }
      const retired = state.state === 'OPEN'
      if (retired) {
        if (!this.#checkGrace(state)) return null
      } else {
        this.#checkDeadline(state)
      }
      if (!state.ackEncoded) authentication()
      encoded = openFrame(
        state,
        envelope,
        CONTEXT_CLASS.FINAL_EXIT_FINALIZE_DATAGRAM,
        DIRECTION.REVERSE,
        DHT_EXIT_OPEN_SIZE
      )
      this.#assertLive(state)
      if (encoded === null) return null
      if (state.openEncoded) {
        if (!same(encoded, state.openEncoded)) authentication()
        return null
      }
      open = decodeDhtExitOpen(encoded)
      ackDigest = digestDhtExitReadyAck(state.ackEncoded)
      if (
        open.branchClass !== state.transcript.branchClass ||
        !same(open.branchId, state.transcript.branchId) ||
        !same(open.circuitId, state.transcript.circuitId) ||
        open.generation !== state.transcript.generation ||
        !same(open.ackDigest, ackDigest) ||
        !same(open.clientActivationNonce, state.activation.clientActivationNonce) ||
        !same(open.exitOriginCommandPolicyDigest, state.policyDigest) ||
        !same(open.payloadParametersDigest, state.payloadDigest)
      ) {
        authentication()
      }
      state.openEncoded = copy(encoded)
      state.open = open
      open = null
      this.#enterOpen(state)
      return openProjection(state.open)
    } catch (err) {
      this.#terminate()
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
      clear(encoded)
      clearOpen(open)
      clear(ackDigest)
    }
  }

  expireGrace() {
    const state = this.#begin()
    try {
      if (state.state !== 'OPEN' || state.graceRetired) return false
      if (this.#checkGrace(state)) return false
      return true
    } catch (err) {
      this.#terminate()
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
    }
  }

  takeOpenHandoff(...args) {
    if (args.length !== 0) invalid()
    const state = this.#begin()
    let material = null
    let handoff = null
    try {
      if (state.state !== 'OPEN' || state.openHandoff || !state.finalMaterial) {
        authentication()
      }
      material = buildOpenRouteMaterial(state)
      handoff = createOpenRouteHandoff(this, material)
      material = null
      state.openHandoff = handoff
      return handoff
    } catch (err) {
      destroyOpenRouteMaterial(material)
      this.#terminate()
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      state.mutating = false
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

  #enterOpen(state) {
    this.#assertLive(state)
    const current = nowValue(state.now)
    this.#assertLive(state)
    state.graceDeadline =
      current > MAX_UINT64 - FINALIZATION_TIMEOUT_MS
        ? MAX_UINT64
        : current + FINALIZATION_TIMEOUT_MS
    state.state = 'OPEN'
    installRetiredFinalizationState(state)
  }

  #checkGrace(state) {
    this.#assertLive(state)
    if (state.graceRetired || state.graceDeadline === null) return false
    const current = nowValue(state.now)
    this.#assertLive(state)
    if (current < state.graceDeadline) return true
    eraseRetiredFinalizationState(state)
    return false
  }

  #terminate() {
    const state = this.#state
    if (!state || state.destroyed) return false
    state.destroyed = true
    revokeOpenRouteHandoff(this)
    const tailControl = state.material && state.material.tailControl
    destroyFinalExitHandoffMaterial(state.material)
    state.material = null
    try {
      if (tailControl) tailControl.destroy()
    } catch {}
    for (const counter of [
      state.forwardTx,
      state.forwardRx,
      state.reverseTx,
      state.reverseRx,
      state.finalForwardTx,
      state.finalForwardRx,
      state.finalReverseTx,
      state.finalReverseRx
    ]) {
      try {
        if (counter) counter.destroy()
      } catch {}
    }
    clearTranscript(state.transcript)
    clear(state.policyDigest)
    clear(state.payloadDigest)
    clear(state.activationEncoded)
    clearActivation(state.activation)
    clear(state.readyEncoded)
    clearReady(state.ready)
    clear(state.ackEncoded)
    clearAck(state.ack)
    clear(state.openEncoded)
    clearOpen(state.open)
    clear(state.finalTranscript)
    clear(state.finalTranscriptDigest)
    clearFinalMaterial(state.finalMaterial)
    state.transcript = null
    state.policyDigest = null
    state.payloadDigest = null
    state.activationEncoded = null
    state.activation = null
    state.readyEncoded = null
    state.ready = null
    state.ackEncoded = null
    state.ack = null
    state.openEncoded = null
    state.open = null
    state.openHandoff = null
    state.finalTranscript = null
    state.finalTranscriptDigest = null
    state.finalMaterial = null
    state.deadline = null
    state.graceDeadline = null
    state.graceRetired = true
    state.crypto = null
    state.now = null
    state.initiator = false
    state.forwardTx = null
    state.forwardRx = null
    state.reverseTx = null
    state.reverseRx = null
    state.finalForwardTx = null
    state.finalForwardRx = null
    state.finalReverseTx = null
    state.finalReverseRx = null
    state.state = 'DESTROYED'
    return true
  }
}
