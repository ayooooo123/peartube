import b4a from 'b4a'

import { CELL_SIZE, CellCodec } from './cell-codec.js'
import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import { destroyTakenM3EstablishedLink, takeM3EstablishedLink } from './guard-link.js'
import { BRANCH_CLASS, CELL_CLASS, DIRECTION } from './protocol.js'

export const DEFAULT_MAX_M3_ADJACENCY_RUNTIMES = 128
export const MAX_M3_ADJACENCY_RUNTIMES = 4096
export const TEST_ONLY_M3_ADJACENCY_OBSERVER = Symbol('test-only-m3-adjacency-observer')

// Deep test import only. Production tail capabilities are minted exclusively
// while an authenticated established link is adopted below.
export const TEST_ONLY_M3_TAIL_ISSUER = Object.freeze({
  issue({ initiator, sharedSecret, transcript, expiresAt }) {
    const capability = Object.freeze({})
    TAILS.set(capability, {
      initiator,
      secret: copy(sharedSecret, 32),
      transcript: copy(transcript, 290),
      expiresAt,
      used: false
    })
    return capability
  }
})

const INITIATOR_CELL_ID_DOMAIN = b4a.from('hyperdht-private-routes/m3/cell-id/initiator/v1')
const RESPONDER_CELL_ID_DOMAIN = b4a.from('hyperdht-private-routes/m3/cell-id/responder/v1')
const AUTHORITIES = new WeakSet()
const AUTHORITY_STATES = new WeakMap()
const RUNTIMES = new WeakMap()
const DESTROYED_RUNTIMES = new WeakSet()
const MOVED_RUNTIMES = new WeakSet()
const TAILS = new WeakMap()
const SPENT_TAILS = new WeakSet()
const FORWARDING_OWNERS = new WeakMap()
const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const fillIntrinsic = Uint8Array.prototype.fill
const setIntrinsic = Uint8Array.prototype.set

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function unavailable() {
  throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
}

function destroyed() {
  throw PrivateRouteError.ERR_DESTROYED()
}

function busy() {
  throw PrivateRouteError.ERR_BUSY()
}

function safeObject(value) {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
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

function fixed(value, size) {
  return length(value) === size
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) fillIntrinsic.call(value, 0)
  } catch {
    // Best-effort zeroization only.
  }
}

function copy(value, size) {
  if (!fixed(value, size)) invalid()
  const result = b4a.allocUnsafeSlow(size)
  try {
    setIntrinsic.call(result, value)
    return result
  } catch {
    clear(result)
    invalid()
  }
}

function same(left, right) {
  if (length(left) < 0 || length(left) !== length(right)) return false
  try {
    return b4a.equals(left, right)
  } catch {
    return false
  }
}

function nonzero(value) {
  if (length(value) < 0) return false
  for (let index = 0; index < value.byteLength; index++) {
    if (value[index] !== 0) return true
  }
  return false
}

function u64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= 0xffff_ffff_ffff_ffffn
}

function nowValue(now) {
  let value
  try {
    value = now()
  } catch {
    unavailable()
  }
  if (!Number.isSafeInteger(value) || value < 0) invalid()
  return BigInt(value)
}

function bindingKey(peerIdentity, localId) {
  try {
    return `${b4a.toString(peerIdentity, 'hex')}:${b4a.toString(localId, 'hex')}`
  } catch {
    invalid()
  }
}

function reserveBinding(authority, owner, state) {
  if (
    !safeObject(state) ||
    !fixed(state.peerIdentity, 32) ||
    !fixed(state.localId, 16) ||
    !nonzero(state.localId)
  ) {
    invalid()
  }
  const key = bindingKey(state.peerIdentity, state.localId)
  if (owner.reservations.has(key)) throw PrivateRouteError.ERR_REPLAY()
  const reservation = {
    authority,
    key,
    released: false,
    runtimeState: null,
    forwardingOwner: null
  }
  owner.reservations.set(key, reservation)
  return reservation
}

function hashOne(hash, label, completeOfferDigest) {
  const prefix = b4a.allocUnsafeSlow(2)
  prefix[0] = label.byteLength >>> 8
  prefix[1] = label.byteLength
  let output = null
  try {
    output = hash([prefix, label, completeOfferDigest])
    if (!fixed(output, 32)) invalid()
    return copy(output, 32)
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    clear(prefix)
    clear(output)
  }
}

export function deriveM3CellIds(completeOfferDigest, { crypto = cryptoSuite } = {}) {
  const digest = copy(completeOfferDigest, 32)
  let hash
  try {
    hash = crypto && crypto.hash
  } catch {
    clear(digest)
    invalid()
  }
  if (typeof hash !== 'function') {
    clear(digest)
    invalid()
  }
  let initiator = null
  let responder = null
  try {
    initiator = hashOne(hash.bind(crypto), INITIATOR_CELL_ID_DOMAIN, digest)
    responder = hashOne(hash.bind(crypto), RESPONDER_CELL_ID_DOMAIN, digest)
    const initiatorCellId = copy(initiator.subarray(0, 16), 16)
    const responderCellId = copy(responder.subarray(0, 16), 16)
    if (
      !nonzero(initiatorCellId) ||
      !nonzero(responderCellId) ||
      same(initiatorCellId, responderCellId)
    ) {
      clear(initiatorCellId)
      clear(responderCellId)
      invalid()
    }
    return Object.freeze({ initiatorCellId, responderCellId })
  } finally {
    clear(digest)
    clear(initiator)
    clear(responder)
  }
}

function contextList(contexts) {
  const result = []
  for (const cellClass of [CELL_CLASS.CONTROL, CELL_CLASS.STREAM, CELL_CLASS.DATAGRAM]) {
    let pair
    try {
      pair = contexts[cellClass]
    } catch {
      invalid()
    }
    if (!safeObject(pair)) invalid()
    for (const direction of ['tx', 'rx']) {
      let context
      try {
        context = pair[direction]
      } catch {
        invalid()
      }
      if (
        !safeObject(context) ||
        !fixed(context.key, 32) ||
        !fixed(context.noncePrefix, 16) ||
        !safeObject(context.counter)
      ) {
        invalid()
      }
      result.push(context)
    }
  }
  return result
}

function validateState(state, ids) {
  if (
    !safeObject(state) ||
    typeof state.initiator !== 'boolean' ||
    !fixed(state.completeOfferDigest, 32) ||
    !fixed(state.localId, 16) ||
    !fixed(state.peerLocalId, 16) ||
    !nonzero(state.localId) ||
    !nonzero(state.peerLocalId) ||
    same(state.localId, state.peerLocalId) ||
    (state.branchClass !== BRANCH_CLASS.LOOKUP && state.branchClass !== BRANCH_CLASS.ANNOUNCE) ||
    !fixed(state.branchId, 16) ||
    !nonzero(state.branchId) ||
    !fixed(state.circuitId, 16) ||
    !nonzero(state.circuitId) ||
    !u64(state.generation) ||
    state.generation === 0n ||
    !Number.isInteger(state.extensionIndex) ||
    state.extensionIndex < 0 ||
    state.extensionIndex > 2 ||
    !fixed(state.localIdentity, 32) ||
    !fixed(state.peerIdentity, 32) ||
    same(state.localIdentity, state.peerIdentity) ||
    !u64(state.expiresAt) ||
    !safeObject(state.physicalChannel) ||
    typeof state.physicalChannel.destroy !== 'function' ||
    !same(state.localId, state.initiator ? ids.initiatorCellId : ids.responderCellId) ||
    !same(state.peerLocalId, state.initiator ? ids.responderCellId : ids.initiatorCellId)
  ) {
    invalid()
  }
  contextList(state.contexts)
}

function clearContexts(contexts) {
  let values = []
  try {
    values = contextList(contexts)
  } catch {
    values = []
  }
  for (const context of values) {
    clear(context.key)
    clear(context.noncePrefix)
    try {
      if (typeof context.counter.destroy === 'function') context.counter.destroy()
    } catch {}
  }
}

function releaseReservation(state) {
  const reservation = state && state.reservation
  if (!reservation || reservation.released) return
  reservation.released = true
  const owner = AUTHORITY_STATES.get(reservation.authority)
  if (owner && owner.reservations.get(reservation.key) === reservation) {
    owner.reservations.delete(reservation.key)
  }
  reservation.runtimeState = null
  reservation.forwardingOwner = null
}

function detachRuntimeState(state) {
  if (!state || state.cleared) return null
  state.cleared = true
  releaseReservation(state)
  const channel = state.physicalChannel
  state.physicalChannel = null
  return { state, channel }
}

function zeroDetachedRuntimeState(detached) {
  if (!detached) return null
  const { state, channel } = detached
  clearContexts(state.contexts)
  clear(state.completeOfferDigest)
  clear(state.localId)
  clear(state.peerLocalId)
  clear(state.branchId)
  clear(state.circuitId)
  clear(state.localIdentity)
  clear(state.peerIdentity)
  return channel
}

function destroyChannel(channel) {
  try {
    if (channel) channel.destroy()
  } catch {}
}

function clearRuntimeState(state) {
  destroyChannel(zeroDetachedRuntimeState(detachRuntimeState(state)))
}

function sweepExpired(owner, current, excluded = null) {
  for (const reservation of [...owner.reservations.values()]) {
    if (reservation === excluded || reservation.released || !reservation.runtimeState) continue
    const state = reservation.runtimeState
    if (state.expiresAt > current) continue
    if (reservation.forwardingOwner) {
      destroyM3ForwardingOwner(reservation.forwardingOwner)
      continue
    }
    RUNTIMES.delete(state.runtime)
    DESTROYED_RUNTIMES.add(state.runtime)
    clearRuntimeState(state)
  }
}

function runtimeState(runtime) {
  const state = safeObject(runtime) ? RUNTIMES.get(runtime) : null
  if (state) return state
  if (MOVED_RUNTIMES.has(runtime)) destroyed()
  destroyed()
}

function checkRuntimeTime(state) {
  const owner = AUTHORITY_STATES.get(state.authority)
  if (!owner || nowValue(owner.now) >= state.expiresAt) {
    clearRuntimeState(state)
    RUNTIMES.delete(state.runtime)
    DESTROYED_RUNTIMES.add(state.runtime)
    destroyed()
  }
}

class M3AdjacencyRuntime {
  sealTail(options) {
    const state = runtimeState(this)
    if (state.installing) busy()
    checkRuntimeTime(state)
    let cellClass
    let payload
    try {
      cellClass = options.class
      payload = options.payload
    } catch {
      invalid()
    }
    if (
      cellClass !== CELL_CLASS.CONTROL &&
      cellClass !== CELL_CLASS.STREAM &&
      cellClass !== CELL_CLASS.DATAGRAM
    ) {
      invalid()
    }
    const context = state.contexts[cellClass].tx
    return state.codec.seal({
      key: context.key,
      noncePrefix: context.noncePrefix,
      senderCounter: context.counter,
      class: cellClass,
      direction: state.initiator ? DIRECTION.FORWARD : DIRECTION.REVERSE,
      epoch: state.generation,
      circuitId: state.peerLocalId,
      payload
    })
  }

  openTail(packet) {
    const state = runtimeState(this)
    if (state.installing) busy()
    checkRuntimeTime(state)
    if (!fixed(packet, CELL_SIZE)) invalid()
    const cellClass = packet[1]
    if (
      cellClass !== CELL_CLASS.CONTROL &&
      cellClass !== CELL_CLASS.STREAM &&
      cellClass !== CELL_CLASS.DATAGRAM
    ) {
      invalid()
    }
    const context = state.contexts[cellClass].rx
    const opened = state.codec.open(
      {
        key: context.key,
        noncePrefix: context.noncePrefix,
        receiver: context.counter,
        expectedClass: cellClass,
        expectedDirection: state.initiator ? DIRECTION.REVERSE : DIRECTION.FORWARD,
        expectedEpoch: state.generation,
        expectedCircuitId: state.localId
      },
      packet
    )
    return Array.isArray(opened) ? opened : [opened]
  }

  diagnostics() {
    const state = runtimeState(this)
    if (state.installing) busy()
    checkRuntimeTime(state)
    return Object.freeze({ state: 'TAIL_ENDPOINT', expiresAt: state.expiresAt })
  }

  revoke() {
    return this.#destroy()
  }

  destroy() {
    return this.#destroy()
  }

  #destroy() {
    const state = RUNTIMES.get(this)
    if (!state) {
      if (MOVED_RUNTIMES.has(this)) destroyed()
      return false
    }
    if (state.installing) busy()
    RUNTIMES.delete(this)
    DESTROYED_RUNTIMES.add(this)
    clearRuntimeState(state)
    return true
  }
}

export class M3AdjacencyAuthority {
  constructor(options = {}) {
    if (!safeObject(options)) invalid()
    let now
    let crypto
    let maximum
    let observe
    try {
      now = options.now
      crypto = options.crypto === undefined ? cryptoSuite : options.crypto
      maximum = options.maxRuntimes
      observe = options[TEST_ONLY_M3_ADJACENCY_OBSERVER]
    } catch {
      invalid()
    }
    if (
      typeof now !== 'function' ||
      !safeObject(crypto) ||
      typeof crypto.hash !== 'function' ||
      typeof crypto.seal !== 'function' ||
      typeof crypto.open !== 'function' ||
      typeof crypto.randomBytes !== 'function' ||
      (maximum !== undefined &&
        (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_M3_ADJACENCY_RUNTIMES)) ||
      (observe !== undefined && typeof observe !== 'function')
    ) {
      invalid()
    }
    const state = {
      authority: this,
      now,
      crypto,
      maxRuntimes: maximum === undefined ? DEFAULT_MAX_M3_ADJACENCY_RUNTIMES : maximum,
      observe: observe || null,
      reservations: new Map()
    }
    AUTHORITIES.add(this)
    AUTHORITY_STATES.set(this, state)
  }

  adopt(establishedHandle) {
    const owner = AUTHORITY_STATES.get(this)
    if (!owner) destroyed()
    let state = null
    let ids = null
    let reservation = null
    let runtime = null
    let tail = null
    let adopted = false
    try {
      state = takeM3EstablishedLink(establishedHandle)
      reservation = reserveBinding(this, owner, state)
      ids = deriveM3CellIds(state.completeOfferDigest, { crypto: owner.crypto })
      validateState(state, ids)
      const current = nowValue(owner.now)
      sweepExpired(owner, current, reservation)
      if (state.expiresAt <= current) unavailable()
      if (owner.reservations.size > owner.maxRuntimes) busy()
      if (owner.observe) {
        try {
          owner.observe(Object.freeze({ type: 'reserved' }))
        } catch {}
      }
      if (owner.reservations.get(reservation.key) !== reservation || reservation.released)
        destroyed()

      runtime = new M3AdjacencyRuntime()
      tail = Object.freeze({})
      const tailSecret = state.tailSharedSecret || state.clientTailEphemeralSecretKey || null
      const tailTranscript = state.tailControlTranscript || null
      state.tailSharedSecret = null
      state.tailControlTranscript = null
      state.clientTailEphemeralSecretKey = null
      const runtimeValue = {
        ...state,
        authority: this,
        codec: new CellCodec({ crypto: owner.crypto, cellSize: CELL_SIZE }),
        cleared: false,
        epoch: state.generation,
        expiresAt: state.expiresAt,
        installing: false,
        reservation,
        runtime
      }
      reservation.runtimeState = runtimeValue
      RUNTIMES.set(runtime, runtimeValue)
      TAILS.set(tail, {
        initiator: state.initiator,
        secret: tailSecret,
        transcript: tailTranscript,
        expiresAt: state.expiresAt,
        used: false
      })
      adopted = true
      return Object.freeze({ runtime, tail })
    } catch (err) {
      if (reservation && !reservation.released) {
        const ownerState = AUTHORITY_STATES.get(this)
        if (ownerState && ownerState.reservations.get(reservation.key) === reservation) {
          ownerState.reservations.delete(reservation.key)
        }
        reservation.released = true
      }
      if (err instanceof PrivateRouteError) throw err
      unavailable()
    } finally {
      if (!adopted && state) destroyTakenM3EstablishedLink(state)
      if (ids) {
        clear(ids.initiatorCellId)
        clear(ids.responderCellId)
      }
    }
  }

  diagnostics() {
    const state = AUTHORITY_STATES.get(this)
    if (!state) destroyed()
    sweepExpired(state, nowValue(state.now))
    return Object.freeze({
      activeRuntimes: state.reservations.size,
      maxRuntimes: state.maxRuntimes
    })
  }
}

export function isM3AdjacencyAuthority(value) {
  return safeObject(value) && AUTHORITIES.has(value)
}

export function revokeM3TailCapability(capability) {
  const state = safeObject(capability) ? TAILS.get(capability) : null
  if (!state) return false
  TAILS.delete(capability)
  SPENT_TAILS.add(capability)
  clear(state.secret)
  clear(state.transcript)
  state.secret = null
  state.transcript = null
  state.used = true
  return true
}

// Deep production import used only by TailControlSession. Ownership moves out
// of the adjacency authority once and raw key material is never returned by a
// public package API.
export function takeM3TailCapability(capability) {
  const state = safeObject(capability) ? TAILS.get(capability) : null
  if (!state) {
    if (safeObject(capability) && SPENT_TAILS.has(capability)) {
      throw PrivateRouteError.ERR_REPLAY()
    }
    invalid()
  }
  TAILS.delete(capability)
  SPENT_TAILS.add(capability)
  state.used = true
  return state
}

export function createM3ForwardingOwner(destroy) {
  if (typeof destroy !== 'function') invalid()
  const capability = Object.freeze({})
  FORWARDING_OWNERS.set(capability, { destroy, destroying: false })
  return capability
}

function destroyM3ForwardingOwner(capability) {
  const state = FORWARDING_OWNERS.get(capability)
  if (!state || state.destroying) return false
  state.destroying = true
  try {
    state.destroy()
  } finally {
    state.destroying = false
  }
  return true
}

function validateInstallState(previous, next, serviceIdentity, current, maxCircuits) {
  if (
    previous === next ||
    previous.authority !== next.authority ||
    previous.initiator !== false ||
    next.initiator !== true ||
    !same(previous.localIdentity, serviceIdentity) ||
    !same(next.localIdentity, serviceIdentity) ||
    previous.branchClass !== next.branchClass ||
    !same(previous.branchId, next.branchId) ||
    !same(previous.circuitId, next.circuitId) ||
    previous.generation !== next.generation ||
    !(
      (previous.extensionIndex === 0 && next.extensionIndex === 1) ||
      (previous.extensionIndex === 1 && next.extensionIndex === 2)
    ) ||
    same(previous.peerIdentity, next.peerIdentity) ||
    same(previous.localId, next.localId) ||
    previous.expiresAt <= current ||
    next.expiresAt <= current
  ) {
    invalid()
  }
  const owner = AUTHORITY_STATES.get(previous.authority)
  if (!owner || owner.maxRuntimes > maxCircuits) invalid()
}

export function beginM3Install(previousRuntime, nextRuntime) {
  const previous = safeObject(previousRuntime) ? RUNTIMES.get(previousRuntime) : null
  const next = safeObject(nextRuntime) ? RUNTIMES.get(nextRuntime) : null
  if (!previous || !next || previous.installing || next.installing) invalid()
  previous.installing = true
  next.installing = true
  return { previous, next, previousRuntime, nextRuntime, committed: false }
}

export function validateM3Install(plan, serviceIdentity, maxCircuits, current) {
  if (
    !plan ||
    plan.committed ||
    !plan.previous.installing ||
    !plan.next.installing ||
    RUNTIMES.get(plan.previousRuntime) !== plan.previous ||
    RUNTIMES.get(plan.nextRuntime) !== plan.next
  ) {
    invalid()
  }
  validateInstallState(plan.previous, plan.next, serviceIdentity, BigInt(current), maxCircuits)
  return plan
}

export function abortM3Install(plan) {
  if (!plan || plan.committed) return false
  plan.previous.installing = false
  plan.next.installing = false
  return true
}

export function commitM3Install(plan, expiresAt, forwardingOwner) {
  if (
    !plan ||
    plan.committed ||
    !plan.previous.installing ||
    !plan.next.installing ||
    RUNTIMES.get(plan.previousRuntime) !== plan.previous ||
    RUNTIMES.get(plan.nextRuntime) !== plan.next ||
    !FORWARDING_OWNERS.has(forwardingOwner)
  ) {
    invalid()
  }
  plan.committed = true
  RUNTIMES.delete(plan.previousRuntime)
  RUNTIMES.delete(plan.nextRuntime)
  MOVED_RUNTIMES.add(plan.previousRuntime)
  MOVED_RUNTIMES.add(plan.nextRuntime)
  plan.previous.installing = false
  plan.next.installing = false
  plan.previous.expiresAt = expiresAt
  plan.next.expiresAt = expiresAt
  plan.previous.reservation.forwardingOwner = forwardingOwner
  plan.next.reservation.forwardingOwner = forwardingOwner
  return Object.freeze({ previous: plan.previous, next: plan.next })
}

export function releaseM3InstalledPair(previous, next) {
  const previousDetached = detachRuntimeState(previous)
  const nextDetached = detachRuntimeState(next)
  const previousChannel = zeroDetachedRuntimeState(previousDetached)
  const nextChannel = zeroDetachedRuntimeState(nextDetached)
  destroyChannel(previousChannel)
  destroyChannel(nextChannel)
}
