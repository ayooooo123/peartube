import b4a from 'b4a'

import { PrivateRouteError } from './errors.js'
import { ROLE, roleForIdentity } from './protocol.js'

const MAX_U64 = 0xffff_ffff_ffff_ffffn
const CHECKERS = new WeakSet()
const COMPILER_CHECKERS = new WeakSet()
const SAFETY_INSTALLER_CHECKERS = new WeakSet()
const SAFETY_ROUTE_CHECKERS = new WeakSet()
const ROUTE_CANDIDATE_CHECKERS = new WeakSet()

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

export function createRouteCompilerAuthority() {
  const capabilities = new WeakMap()

  const issuer = Object.freeze({
    issue(open) {
      if (typeof open !== 'function') invalidRoute()
      const capability = Object.freeze({})
      capabilities.set(capability, open)
      return capability
    }
  })

  const checker = Object.freeze({
    open(capability, request) {
      const compile = isObject(capability) ? capabilities.get(capability) : null
      if (!compile) unauthorized()
      return compile(request)
    }
  })
  COMPILER_CHECKERS.add(checker)
  return Object.freeze({ issuer, checker })
}

export function isRouteCompilerChecker(value) {
  return isObject(value) && COMPILER_CHECKERS.has(value)
}

export function createRouteCandidateAuthority() {
  const capabilities = new WeakMap()
  const issuer = Object.freeze({
    issue(provider) {
      if (!exactKeys(provider, ['next']) || typeof provider.next !== 'function') invalidRoute()
      const capability = Object.freeze({})
      capabilities.set(capability, {
        next: provider.next.bind(provider),
        lastEpoch: null,
        busy: false
      })
      return capability
    }
  })
  const checker = Object.freeze({
    next(capability, currentEpoch, reason) {
      const state = isObject(capability) ? capabilities.get(capability) : null
      if (
        !state ||
        !u64(currentEpoch) ||
        (reason !== 'rotation' && reason !== 'relay-loss') ||
        state.busy ||
        (state.lastEpoch !== null && currentEpoch <= state.lastEpoch)
      )
        unauthorized()
      state.lastEpoch = currentEpoch
      state.busy = true
      try {
        const candidate = state.next(currentEpoch, reason)
        if (
          !exactKeys(candidate, ['descriptor', 'safety']) ||
          !Array.isArray(candidate.safety) ||
          candidate.safety.length < 1 ||
          candidate.safety.length > 3
        )
          invalidRoute()
        return Object.freeze({
          descriptor: candidate.descriptor,
          safety: Object.freeze([...candidate.safety])
        })
      } finally {
        state.busy = false
      }
    }
  })
  ROUTE_CANDIDATE_CHECKERS.add(checker)
  return Object.freeze({ issuer, checker })
}

export function isRouteCandidateChecker(value) {
  return isObject(value) && ROUTE_CANDIDATE_CHECKERS.has(value)
}

export function createSafetyInstallerAuthority() {
  const capabilities = new WeakMap()
  const routes = new WeakMap()

  const issuer = Object.freeze({
    issue(installer) {
      if (
        !isObject(installer) ||
        typeof installer.authenticate !== 'function' ||
        typeof installer.install !== 'function' ||
        typeof installer.rollback !== 'function' ||
        typeof installer.finalize !== 'function'
      )
        invalidRoute()
      const capability = Object.freeze({})
      capabilities.set(capability, installer)
      return capability
    }
  })

  function read(capability) {
    const installer = isObject(capability) ? capabilities.get(capability) : null
    if (!installer) unauthorized()
    return installer
  }

  const checker = Object.freeze({
    authenticate(capability, advertisement, binding) {
      return read(capability).authenticate(advertisement, binding)
    },
    install(capability, advertisement, binding) {
      return read(capability).install(advertisement, binding)
    },
    rollback(capability) {
      return read(capability).rollback()
    },
    finalize(capability, circuitContext) {
      if (!isObject(circuitContext)) unauthorized()
      const installed = read(capability).finalize(circuitContext)
      if (
        !exactKeys(installed, [
          'transcriptHash32',
          'attachEntry',
          'sendControl',
          'sendFrame',
          'sendReverseFrame',
          'destroy'
        ]) ||
        !fixed(installed.transcriptHash32, 32) ||
        typeof installed.attachEntry !== 'function' ||
        typeof installed.sendControl !== 'function' ||
        typeof installed.sendFrame !== 'function' ||
        typeof installed.sendReverseFrame !== 'function' ||
        typeof installed.destroy !== 'function'
      )
        invalidRoute()
      const routeCapability = Object.freeze({})
      const route = {
        circuitContext,
        transcriptHash32: b4a.from(installed.transcriptHash32),
        installed,
        live: true
      }
      routes.set(routeCapability, route)
      return routeCapability
    }
  })
  const routeChecker = Object.freeze({
    read(routeCapability, circuitContext) {
      const route = isObject(routeCapability) ? routes.get(routeCapability) : null
      if (!route || !route.live || route.circuitContext !== circuitContext) unauthorized()
      return Object.freeze({
        transcriptHash32: b4a.from(route.transcriptHash32),
        attachEntry(...args) {
          if (!route.live) unauthorized()
          return route.installed.attachEntry(...args)
        },
        sendControl(...args) {
          if (!route.live) unauthorized()
          return route.installed.sendControl(...args)
        },
        sendFrame(...args) {
          if (!route.live) unauthorized()
          return route.installed.sendFrame(...args)
        },
        sendReverseFrame(...args) {
          if (!route.live) unauthorized()
          return route.installed.sendReverseFrame(...args)
        },
        destroy() {
          if (!route.live) return
          route.live = false
          route.transcriptHash32.fill(0)
          return route.installed.destroy()
        }
      })
    }
  })
  SAFETY_INSTALLER_CHECKERS.add(checker)
  SAFETY_ROUTE_CHECKERS.add(routeChecker)
  return Object.freeze({ issuer, checker, routeChecker })
}

export function isSafetyInstallerChecker(value) {
  return isObject(value) && SAFETY_INSTALLER_CHECKERS.has(value)
}

export function isSafetyRouteChecker(value) {
  return isObject(value) && SAFETY_ROUTE_CHECKERS.has(value)
}
