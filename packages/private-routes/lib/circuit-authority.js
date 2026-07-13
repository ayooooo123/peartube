import b4a from 'b4a'

import { PrivateRouteError } from './errors.js'
import { ROLE, roleForIdentity } from './protocol.js'

const MAX_U64 = 0xffff_ffff_ffff_ffffn
const CHECKERS = new WeakSet()

function unauthorized() {
  throw PrivateRouteError.UNAUTHORIZED()
}

function invalidRoute() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function exactKeys(value, expected) {
  if (!isObject(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function fixed(value, size) {
  return b4a.isBuffer(value) && value.byteLength === size
}

function u64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_U64
}

function copy(state) {
  return {
    circuitId: b4a.from(state.circuitId),
    epoch: state.epoch,
    finalSafetyIdentity32: b4a.from(state.finalSafetyIdentity32),
    entryIdentity32: b4a.from(state.entryIdentity32),
    expiresAt: state.expiresAt
  }
}

export function createCircuitAuthority() {
  const contexts = new WeakMap()

  const issuer = Object.freeze({
    issueFinalSafety(value) {
      if (
        !exactKeys(value, [
          'circuitId',
          'epoch',
          'finalSafetyIdentity32',
          'entryIdentity32',
          'expiresAt'
        ]) ||
        !fixed(value.circuitId, 16) ||
        !u64(value.epoch) ||
        !fixed(value.finalSafetyIdentity32, 32) ||
        !fixed(value.entryIdentity32, 32) ||
        !u64(value.expiresAt)
      ) {
        invalidRoute()
      }
      if (
        roleForIdentity(value.finalSafetyIdentity32) !== ROLE.SAFETY ||
        roleForIdentity(value.entryIdentity32) !== ROLE.PRIVATE
      ) {
        unauthorized()
      }

      const context = Object.freeze({})
      contexts.set(context, copy(value))
      return context
    }
  })

  const checker = Object.freeze({
    read(value) {
      const state = isObject(value) ? contexts.get(value) : null
      if (!state) unauthorized()
      return copy(state)
    }
  })
  CHECKERS.add(checker)

  return Object.freeze({ issuer, checker })
}

export function isCircuitChecker(value) {
  return isObject(value) && CHECKERS.has(value)
}
