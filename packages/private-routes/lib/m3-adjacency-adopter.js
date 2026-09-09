import { PrivateRouteError } from './errors.js'

const ADOPTERS = new WeakMap()
const ADOPTIONS = new WeakMap()
const SPENT_ADOPTIONS = new WeakSet()

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
  return value !== null && typeof value === 'object'
}

export function createM3ResponderAdopter(adopt, destroy) {
  if (typeof adopt !== 'function' || typeof destroy !== 'function') invalid()
  const capability = Object.freeze({})
  ADOPTERS.set(capability, Object.freeze({ adopt, destroy }))
  return capability
}

export function isM3ResponderAdopter(value) {
  return object(value) && ADOPTERS.has(value)
}

export function adoptM3ResponderLink(adopter, established) {
  const owner = object(adopter) ? ADOPTERS.get(adopter) : null
  if (!owner) authentication()
  const value = owner.adopt(established)
  if (!object(value)) invalid()
  const adoption = Object.freeze({})
  ADOPTIONS.set(adoption, { owner, value })
  return adoption
}

export function takeM3ResponderLink(adoption) {
  const state = object(adoption) ? ADOPTIONS.get(adoption) : null
  if (!state) {
    if (object(adoption) && SPENT_ADOPTIONS.has(adoption)) replay()
    authentication()
  }
  ADOPTIONS.delete(adoption)
  SPENT_ADOPTIONS.add(adoption)
  const value = state.value
  state.value = null
  return value
}

export function destroyM3ResponderLink(adoption) {
  const state = object(adoption) ? ADOPTIONS.get(adoption) : null
  if (!state) return false
  ADOPTIONS.delete(adoption)
  SPENT_ADOPTIONS.add(adoption)
  const value = state.value
  state.value = null
  try {
    state.owner.destroy(value)
  } catch {}
  return true
}
