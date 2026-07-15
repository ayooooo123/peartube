import b4a from 'b4a'

import { decodeRelayAdvertisement, encodeUnsignedRelayAdvertisement } from './descriptor.js'
import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import { DOMAIN, ROLE, roleForIdentity } from './protocol.js'
import { decodeCanonicalEndpoint, decodeRelayCapabilityAdvertisement } from './relay-capability.js'

export const PUBLIC_DHT = 0
export const DISCOVERY_MAX_AGE = 30_000n

const MAX_U64 = 0xffff_ffff_ffff_ffffn
const MAX_DIAL = 256
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

function validU64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_U64
}

function fixedBuffer(value, length) {
  return b4a.isBuffer(value) && value.byteLength === length
}

function validDial(value) {
  return b4a.isBuffer(value) && value.byteLength > 0 && value.byteLength <= MAX_DIAL
}

function copyState(state) {
  return {
    advertisementHash32: b4a.from(state.advertisementHash32),
    peerIdentity32: b4a.from(state.peerIdentity32),
    observedDial: b4a.from(state.observedDial),
    observedAt: state.observedAt,
    channel: state.channel,
    advertisementEncoding: b4a.from(state.advertisementEncoding),
    routeEncryptionKey: b4a.from(state.routeEncryptionKey),
    role: state.role,
    capabilities: state.capabilities,
    epoch: state.epoch,
    expiresAt: state.expiresAt
  }
}

function normalizeMaxAge(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) invalidRoute()
    return BigInt(value)
  }
  if (!validU64(value)) invalidRoute()
  return value
}

export function createDiscoveryEvidenceAuthority({ now, maxAge = DISCOVERY_MAX_AGE } = {}) {
  if (typeof now !== 'function') invalidRoute()
  const maximumAge = normalizeMaxAge(maxAge)
  if (maximumAge !== DISCOVERY_MAX_AGE) invalidRoute()
  const receipts = new WeakMap()
  const evidenceStates = new WeakMap()

  const receiptIssuer = Object.freeze({
    issue(value) {
      if (
        !exactKeys(value, [
          'advertisementHash32',
          'peerIdentity32',
          'observedDial',
          'observedAt',
          'channel'
        ]) ||
        !fixedBuffer(value.advertisementHash32, 32) ||
        !fixedBuffer(value.peerIdentity32, 32) ||
        !validDial(value.observedDial) ||
        !validU64(value.observedAt) ||
        value.channel !== PUBLIC_DHT
      ) {
        invalidRoute()
      }

      const receipt = Object.freeze({})
      receipts.set(receipt, {
        advertisementHash32: b4a.from(value.advertisementHash32),
        peerIdentity32: b4a.from(value.peerIdentity32),
        observedDial: b4a.from(value.observedDial),
        observedAt: value.observedAt,
        channel: value.channel,
        consumed: false
      })
      return receipt
    }
  })

  const verifier = Object.freeze({
    verify(encodedAdvertisement, receipt) {
      const receiptState = isObject(receipt) ? receipts.get(receipt) : null
      if (!receiptState) unauthorized()
      if (receiptState.consumed) throw PrivateRouteError.REPLAY()

      let advertisement
      try {
        advertisement = decodeRelayAdvertisement(encodedAdvertisement)
      } catch {
        throw PrivateRouteError.INVALID_DESCRIPTOR()
      }

      const current = now()
      if (!validU64(current)) invalidRoute()
      const advertisementHash32 = cryptoSuite.hash(encodedAdvertisement)
      const signed = b4a.concat([
        DOMAIN.RELAY_ADVERTISEMENT,
        encodeUnsignedRelayAdvertisement(advertisement)
      ])

      if (
        receiptState.channel !== PUBLIC_DHT ||
        !b4a.equals(receiptState.advertisementHash32, advertisementHash32) ||
        !b4a.equals(receiptState.peerIdentity32, advertisement.identityKey) ||
        !b4a.equals(receiptState.observedDial, advertisement.dial) ||
        receiptState.observedAt > current ||
        current - receiptState.observedAt > maximumAge ||
        advertisement.expiresAt <= current ||
        advertisement.role !== roleForIdentity(advertisement.identityKey) ||
        (advertisement.role !== ROLE.SAFETY && advertisement.role !== ROLE.PRIVATE) ||
        !cryptoSuite.verify(signed, advertisement.relaySignature, advertisement.identityKey)
      ) {
        unauthorized()
      }

      receiptState.consumed = true
      const evidence = Object.freeze({})
      evidenceStates.set(evidence, {
        advertisementHash32: b4a.from(advertisementHash32),
        peerIdentity32: b4a.from(advertisement.identityKey),
        observedDial: b4a.from(advertisement.dial),
        observedAt: receiptState.observedAt,
        channel: receiptState.channel,
        advertisementEncoding: b4a.from(encodedAdvertisement),
        routeEncryptionKey: b4a.from(advertisement.routeEncryptionKey),
        role: advertisement.role,
        capabilities: advertisement.capabilities,
        epoch: advertisement.epoch,
        expiresAt: advertisement.expiresAt
      })
      return evidence
    }
  })

  const checker = Object.freeze({
    isVerified(value) {
      return isObject(value) && evidenceStates.has(value)
    },
    read(value) {
      const state = isObject(value) ? evidenceStates.get(value) : null
      if (!state) unauthorized()
      return copyState(state)
    }
  })
  CHECKERS.add(checker)

  return Object.freeze({ receiptIssuer, verifier, checker })
}

export function isDiscoveryEvidenceChecker(value) {
  return isObject(value) && CHECKERS.has(value)
}

export const BOOTSTRAP_PROVENANCE = Object.freeze({
  CAPS_RESPONSE: 0,
  LEGACY_FIND_NODE: 1
})

const BOOTSTRAP_REFERRAL_CHECKERS = new WeakSet()

function bootstrapCopy(value, size) {
  if (!fixedBuffer(value, size)) invalidRoute()
  return b4a.from(value)
}

function readBootstrapBinding(value, now) {
  if (!exactKeys(value, ['queryNonce', 'cookieExpiresAtMs', 'returnRoutabilityCookie'])) {
    invalidRoute()
  }
  let queryNonce = null
  let returnRoutabilityCookie = null
  let transferred = false
  try {
    queryNonce = bootstrapCopy(value.queryNonce, 32)
    returnRoutabilityCookie = bootstrapCopy(value.returnRoutabilityCookie, 32)
    const cookieExpiresAtMs = value.cookieExpiresAtMs
    if (
      !validU64(cookieExpiresAtMs) ||
      cookieExpiresAtMs <= now ||
      cookieExpiresAtMs - now > 5_000n
    ) {
      invalidRoute()
    }
    transferred = true
    return { queryNonce, cookieExpiresAtMs, returnRoutabilityCookie }
  } finally {
    if (!transferred) {
      if (queryNonce) b4a.fill(queryNonce, 0)
      if (returnRoutabilityCookie) b4a.fill(returnRoutabilityCookie, 0)
    }
  }
}

function clearCapabilityAdvertisement(advertisement) {
  if (!advertisement) return
  for (const name of [
    'relayIdentity',
    'currentDhtNodeId',
    'reachableEndpoint',
    'routeEncryptionPublicKey',
    'signature'
  ]) {
    if (advertisement[name]) b4a.fill(advertisement[name], 0)
  }
}

export function createBootstrapReferralAuthority({ now, maxEvidence = 64 } = {}) {
  if (
    typeof now !== 'function' ||
    !Number.isSafeInteger(maxEvidence) ||
    maxEvidence < 1 ||
    maxEvidence > 4096
  ) {
    invalidRoute()
  }
  const states = new WeakMap()
  const live = new Set()
  const spent = new WeakSet()
  let issued = 0

  function clearBootstrapState(state) {
    if (!state) return
    b4a.fill(state.endpoint, 0)
    if (state.advertisement) b4a.fill(state.advertisement, 0)
    if (state.capsBinding) {
      b4a.fill(state.capsBinding.queryNonce, 0)
      b4a.fill(state.capsBinding.returnRoutabilityCookie, 0)
    }
  }

  function issue(state) {
    if (issued >= maxEvidence) throw PrivateRouteError.ERR_BUSY()
    const evidence = Object.freeze({})
    states.set(evidence, { ...state, consumed: false })
    live.add(evidence)
    issued++
    return evidence
  }

  const capsIssuer = Object.freeze({
    issue(value) {
      if (!exactKeys(value, ['advertisement', 'capsBinding'])) invalidRoute()
      const current = now()
      if (!validU64(current)) invalidRoute()
      let advertisement = null
      let endpoint = null
      let advertisementBytes = null
      let binding = null
      let transferred = false
      try {
        advertisement = decodeRelayCapabilityAdvertisement(value.advertisement, {
          now: current
        })
        binding = readBootstrapBinding(value.capsBinding, current)
        endpoint = b4a.from(advertisement.reachableEndpoint)
        advertisementBytes = b4a.from(value.advertisement)
        const evidence = issue({
          provenance: BOOTSTRAP_PROVENANCE.CAPS_RESPONSE,
          endpoint,
          advertisement: advertisementBytes,
          capsBinding: binding
        })
        transferred = true
        return evidence
      } finally {
        clearCapabilityAdvertisement(advertisement)
        if (!transferred) {
          if (endpoint) b4a.fill(endpoint, 0)
          if (advertisementBytes) b4a.fill(advertisementBytes, 0)
          if (binding) {
            b4a.fill(binding.queryNonce, 0)
            b4a.fill(binding.returnRoutabilityCookie, 0)
          }
        }
      }
    }
  })

  const legacyIssuer = Object.freeze({
    issue(value) {
      if (!exactKeys(value, ['endpoint'])) invalidRoute()
      const endpoint = decodeCanonicalEndpoint(value.endpoint)
      let transferred = false
      try {
        const evidence = issue({
          provenance: BOOTSTRAP_PROVENANCE.LEGACY_FIND_NODE,
          endpoint,
          advertisement: null,
          capsBinding: null
        })
        transferred = true
        return evidence
      } finally {
        if (!transferred) b4a.fill(endpoint, 0)
      }
    }
  })

  const checker = Object.freeze({
    isReferral(value) {
      const state = isObject(value) ? states.get(value) : null
      return Boolean(state && !state.consumed)
    },
    readReferral(value) {
      const state = isObject(value) ? states.get(value) : null
      if (!state) unauthorized()
      return {
        provenance: state.provenance,
        endpoint: b4a.from(state.endpoint),
        advertisement: state.advertisement ? b4a.from(state.advertisement) : null,
        capsBinding: state.capsBinding
          ? {
              queryNonce: b4a.from(state.capsBinding.queryNonce),
              cookieExpiresAtMs: state.capsBinding.cookieExpiresAtMs,
              returnRoutabilityCookie: b4a.from(state.capsBinding.returnRoutabilityCookie)
            }
          : null
      }
    },
    consumeReferral(value) {
      const state = isObject(value) ? states.get(value) : null
      if (!state) {
        if (isObject(value) && spent.has(value)) throw PrivateRouteError.ERR_REPLAY()
        unauthorized()
      }
      const result = {
        provenance: state.provenance,
        endpoint: b4a.from(state.endpoint),
        advertisement: state.advertisement ? b4a.from(state.advertisement) : null,
        capsBinding: state.capsBinding
          ? {
              queryNonce: b4a.from(state.capsBinding.queryNonce),
              cookieExpiresAtMs: state.capsBinding.cookieExpiresAtMs,
              returnRoutabilityCookie: b4a.from(state.capsBinding.returnRoutabilityCookie)
            }
          : null
      }
      states.delete(value)
      live.delete(value)
      spent.add(value)
      issued--
      clearBootstrapState(state)
      return result
    }
  })
  const destroy = () => {
    for (const evidence of live) {
      clearBootstrapState(states.get(evidence))
      states.delete(evidence)
      spent.add(evidence)
    }
    live.clear()
    issued = 0
  }
  BOOTSTRAP_REFERRAL_CHECKERS.add(checker)
  return Object.freeze({ capsIssuer, legacyIssuer, checker, destroy })
}

export function isBootstrapReferralChecker(value) {
  return isObject(value) && BOOTSTRAP_REFERRAL_CHECKERS.has(value)
}
