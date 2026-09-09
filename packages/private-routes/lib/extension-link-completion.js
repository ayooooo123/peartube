import { PrivateRouteError } from './errors.js'

const COMPLETIONS = new WeakMap()
const TAKEN = new WeakMap()
const SPENT = new WeakSet()

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

export function createExtensionLinkCompletion(material, destroy) {
  if (!object(material) || typeof destroy !== 'function') invalid()
  const capability = Object.freeze({})
  COMPLETIONS.set(capability, { material, destroy })
  return capability
}

export function takeExtensionLinkCompletion(capability) {
  const state = object(capability) ? COMPLETIONS.get(capability) : null
  if (!state) {
    if (object(capability) && SPENT.has(capability)) replay()
    authentication()
  }
  COMPLETIONS.delete(capability)
  SPENT.add(capability)
  TAKEN.set(state.material, state)
  return state.material
}

export function destroyTakenExtensionLinkCompletion(material) {
  const state = object(material) ? TAKEN.get(material) : null
  if (!state) return false
  TAKEN.delete(material)
  try {
    state.destroy(material)
  } catch {}
  return true
}

export function destroyExtensionLinkCompletion(capability) {
  const state = object(capability) ? COMPLETIONS.get(capability) : null
  if (!state) return false
  COMPLETIONS.delete(capability)
  SPENT.add(capability)
  try {
    state.destroy(state.material)
  } catch {}
  return true
}
