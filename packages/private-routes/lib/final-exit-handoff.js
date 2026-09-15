import b4a from 'b4a'

import { PrivateRouteError } from './errors.js'

const HANDOFFS = new WeakMap()
const OWNER_HANDOFFS = new WeakMap()
const SPENT_HANDOFFS = new WeakSet()
const DESTROYED_MATERIAL = new WeakSet()
const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const fillIntrinsic = Uint8Array.prototype.fill

const MATERIAL_KEYS = Object.freeze([
  'expiresAt',
  'finalizeForwardKey',
  'finalizeForwardNoncePrefix',
  'finalizeReverseKey',
  'finalizeReverseNoncePrefix',
  'initiator',
  'sharedSecret',
  'tailControl',
  'tailControlTranscript'
])

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

function length(value) {
  try {
    return b4a.isBuffer(value) ? byteLengthGetter.call(value) : -1
  } catch {
    return -1
  }
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) fillIntrinsic.call(value, 0)
  } catch {}
}

function validMaterial(owner, material) {
  try {
    const keys = Reflect.ownKeys(material)
    return (
      object(owner) &&
      object(material) &&
      keys.length === MATERIAL_KEYS.length &&
      keys.every((key) => typeof key === 'string' && MATERIAL_KEYS.includes(key)) &&
      typeof material.initiator === 'boolean' &&
      typeof material.expiresAt === 'bigint' &&
      material.expiresAt > 0n &&
      material.tailControl === owner &&
      length(material.sharedSecret) === 32 &&
      length(material.tailControlTranscript) === 290 &&
      length(material.finalizeForwardKey) === 32 &&
      length(material.finalizeReverseKey) === 32 &&
      length(material.finalizeForwardNoncePrefix) === 16 &&
      length(material.finalizeReverseNoncePrefix) === 16
    )
  } catch {
    return false
  }
}

export function createFinalExitHandoff(owner, material) {
  if (!validMaterial(owner, material) || OWNER_HANDOFFS.has(owner)) invalid()
  const handoff = Object.freeze({})
  HANDOFFS.set(handoff, { owner, material })
  OWNER_HANDOFFS.set(owner, handoff)
  return handoff
}

export function consumeFinalExitHandoff(handoff) {
  const record = object(handoff) ? HANDOFFS.get(handoff) : null
  if (!record) {
    if (object(handoff) && SPENT_HANDOFFS.has(handoff)) replay()
    authentication()
  }
  HANDOFFS.delete(handoff)
  OWNER_HANDOFFS.delete(record.owner)
  SPENT_HANDOFFS.add(handoff)
  return record.material
}

export function revokeFinalExitHandoff(owner) {
  if (!object(owner)) return false
  const handoff = OWNER_HANDOFFS.get(owner)
  if (!handoff) return false
  const record = HANDOFFS.get(handoff)
  OWNER_HANDOFFS.delete(owner)
  HANDOFFS.delete(handoff)
  SPENT_HANDOFFS.add(handoff)
  if (record) destroyFinalExitHandoffMaterial(record.material)
  return true
}

export function destroyFinalExitHandoffMaterial(material) {
  if (!object(material) || DESTROYED_MATERIAL.has(material)) return false
  DESTROYED_MATERIAL.add(material)
  for (const name of [
    'sharedSecret',
    'tailControlTranscript',
    'finalizeForwardKey',
    'finalizeReverseKey',
    'finalizeForwardNoncePrefix',
    'finalizeReverseNoncePrefix'
  ]) {
    let value = null
    try {
      value = material[name]
      material[name] = null
    } catch {}
    clear(value)
  }
  try {
    material.initiator = false
    material.expiresAt = 0n
    material.tailControl = null
  } catch {}
  return true
}
