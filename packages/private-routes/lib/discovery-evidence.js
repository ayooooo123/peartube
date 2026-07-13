import b4a from 'b4a'

import { decodeRelayAdvertisement, encodeUnsignedRelayAdvertisement } from './descriptor.js'
import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import { DOMAIN, ROLE, roleForIdentity } from './protocol.js'

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
