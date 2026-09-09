import b4a from 'b4a'

import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import { RELAY_CAPABILITY } from './protocol.js'

export const MAX_COMPATIBLE_BOOTSTRAPS = 3
export const MAX_DIRECT_GUARD_CHALLENGES = 3

const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const setIntrinsic = Uint8Array.prototype.set
const subarrayIntrinsic = Uint8Array.prototype.subarray
const fillIntrinsic = Uint8Array.prototype.fill

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function unavailable() {
  throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
}

function length(value) {
  try {
    return b4a.isBuffer(value) ? byteLengthGetter.call(value) : -1
  } catch {
    return -1
  }
}

function copy(value, size) {
  if (length(value) !== size) invalid()
  const output = b4a.allocUnsafeSlow(size)
  try {
    setIntrinsic.call(output, value)
  } catch {
    invalid()
  }
  return output
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) fillIntrinsic.call(value, 0)
  } catch {
    // JavaScript zeroization is best-effort.
  }
}

function clearValidatedProjection(value) {
  if (value === null || typeof value !== 'object') return
  for (const name of ['queryNonce', 'returnRoutabilityCookie']) {
    try {
      clear(value[name])
    } catch {
      // Cleanup must not replace the discovery result.
    }
  }
}

function safe(value, name) {
  try {
    if (value === null || typeof value !== 'object') invalid()
    return value[name]
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  }
}

function endpointKey(value) {
  if (typeof value === 'string') return `s:${value}`
  if (length(value) > 0 && length(value) <= 256) return `b:${b4a.toString(value, 'hex')}`
  invalid()
}

function identityKey(value) {
  return length(value) === 32 ? b4a.toString(value, 'hex') : null
}

function xorCompare(left, right, target) {
  for (let index = 0; index < 32; index++) {
    const a = left[index] ^ target[index]
    const b = right[index] ^ target[index]
    if (a !== b) return a - b
  }
  return 0
}

function lexCompare(left, right) {
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function prefixKey(endpoint) {
  if (length(endpoint) !== 19) invalid()
  if (endpoint[0] === 4) return `4:${endpoint[13]}.${endpoint[14]}.${endpoint[15]}`
  if (endpoint[0] === 6) {
    return `6:${b4a.toString(subarrayIntrinsic.call(endpoint, 1, 7), 'hex')}`
  }
  invalid()
}

export function selectDiverseRelayCapabilities(
  candidates,
  { target, maximumResults, excludeIdentities = [] } = {}
) {
  if (
    !Array.isArray(candidates) ||
    !Number.isSafeInteger(maximumResults) ||
    maximumResults < 1 ||
    maximumResults > 8 ||
    !Array.isArray(excludeIdentities)
  ) {
    invalid()
  }
  const targetBytes = copy(target, 32)
  const excluded = new Set(excludeIdentities.map(identityKey))
  if (excluded.has(null)) invalid()
  const normalized = []
  for (const candidate of candidates) {
    const relayIdentity = copy(safe(candidate, 'relayIdentity'), 32)
    const currentDhtNodeId = copy(safe(candidate, 'currentDhtNodeId'), 32)
    const reachableEndpoint = copy(safe(candidate, 'reachableEndpoint'), 19)
    normalized.push({ candidate, relayIdentity, currentDhtNodeId, reachableEndpoint })
  }
  normalized.sort((left, right) => {
    const distance = xorCompare(left.currentDhtNodeId, right.currentDhtNodeId, targetBytes)
    if (distance !== 0) return distance
    return lexCompare(left.relayIdentity, right.relayIdentity)
  })
  const selected = []
  const identities = new Set(excluded)
  const prefixes = new Set()
  for (const value of normalized) {
    const identity = identityKey(value.relayIdentity)
    const prefix = prefixKey(value.reachableEndpoint)
    if (identities.has(identity) || prefixes.has(prefix)) continue
    identities.add(identity)
    prefixes.add(prefix)
    selected.push(value.candidate)
    if (selected.length === maximumResults) break
  }
  return Object.freeze(selected)
}

export class CompatibleDiscovery {
  constructor({
    bootstrapIO,
    directory,
    allowLegacyDiscovery = true,
    establishGuardLink = undefined,
    guardLinkSetup = undefined,
    now,
    randomBytes = cryptoSuite.randomBytes
  } = {}) {
    if (
      bootstrapIO === null ||
      typeof bootstrapIO !== 'object' ||
      directory === null ||
      typeof directory !== 'object' ||
      typeof directory.admit !== 'function' ||
      typeof directory.validate !== 'function' ||
      typeof directory.isValidated !== 'function' ||
      typeof directory.read !== 'function' ||
      typeof now !== 'function' ||
      typeof randomBytes !== 'function' ||
      typeof allowLegacyDiscovery !== 'boolean' ||
      establishGuardLink !== undefined
    ) {
      invalid()
    }
    this._io = bootstrapIO
    this._directory = directory
    this._allowLegacy = allowLegacyDiscovery
    this._now = now
    this._randomBytes = randomBytes
    this._guardLinkSetup = guardLinkSetup
    this._counters = {
      publicProbeCount: 0,
      candidateRejectCount: 0,
      activeValidationCount: 0
    }
    this._prospectiveProbeCount = 0
    this._destroyed = false
    this._completed = false
  }

  get counters() {
    return { ...this._counters }
  }

  diagnostics() {
    return Object.freeze({
      state: this._completed ? 'completed' : this._destroyed ? 'destroyed' : 'discovering',
      publicProbeCount: this._counters.publicProbeCount,
      candidateRejectCount: this._counters.candidateRejectCount,
      activeValidationCount: this._counters.activeValidationCount,
      errorCategory: null
    })
  }

  async _caps(endpoint, requestedCapabilityMask) {
    this._counters.publicProbeCount++
    let generatedTarget = null
    let generatedNonce = null
    let randomTarget = null
    let queryNonce = null
    try {
      generatedTarget = this._randomBytes(32)
      randomTarget = copy(generatedTarget, 32)
      generatedNonce = this._randomBytes(32)
      queryNonce = copy(generatedNonce, 32)
      return await this._io.capsQuery(endpoint, {
        requestedCapabilityMask,
        randomTarget,
        queryNonce,
        maximumResults: 8
      })
    } finally {
      clear(generatedTarget)
      clear(generatedNonce)
      clear(randomTarget)
      clear(queryNonce)
    }
  }

  _complete(value) {
    this._completed = true
    this._io = null
    this._directory = null
    this._guardLinkSetup = null
    this._now = null
    this._randomBytes = null
    return value
  }

  _entries(response) {
    if (response === null || response === undefined) return []
    const entries = safe(response, 'advertisements')
    if (!Array.isArray(entries) || entries.length > 8) invalid()
    return entries
  }

  async _tryEntry(entry, requestedCapabilityMask, queriedEndpoint, seenEndpoints, seenIdentities) {
    if (this._counters.activeValidationCount >= MAX_DIRECT_GUARD_CHALLENGES) return null
    let endpoint
    let advertisement
    let hint
    try {
      const opaque = this._io.usesOpaqueDiscoveryAuthority === true
      endpoint = opaque ? safe(entry, 'provenance') : safe(entry, 'endpoint')
      advertisement = safe(entry, 'advertisement')
      hint = opaque ? entry : safe(entry, 'validated')
      const endpointIdentity = opaque
        ? `p:${identityKey(safe(entry, 'relayIdentity'))}`
        : endpointKey(endpoint)
      if (seenEndpoints.has(endpointIdentity)) {
        this._counters.candidateRejectCount++
        return null
      }
      const relayIdentity = hint && identityKey(safe(hint, 'relayIdentity'))
      if (relayIdentity && seenIdentities.has(relayIdentity)) {
        this._counters.candidateRejectCount++
        return null
      }
      if (
        hint &&
        (!Number.isSafeInteger(safe(hint, 'capabilityMask')) ||
          (safe(hint, 'capabilityMask') & requestedCapabilityMask) !== requestedCapabilityMask ||
          !(safe(hint, 'capabilityMask') & RELAY_CAPABILITY.CIRCUIT_RELAY_V1) ||
          safe(hint, 'capabilityMask') & RELAY_CAPABILITY.DHT_EXIT_V1)
      ) {
        this._counters.candidateRejectCount++
        return null
      }
      seenEndpoints.add(endpointIdentity)
      if (relayIdentity) seenIdentities.add(relayIdentity)

      let activeEntry = entry
      const isSelf = opaque
        ? safe(entry, 'self') === true
        : endpointKey(endpoint) === endpointKey(queriedEndpoint)
      if (!isSelf) {
        if (this._prospectiveProbeCount >= MAX_DIRECT_GUARD_CHALLENGES) return null
        this._prospectiveProbeCount++
        let probeTarget = endpoint
        if (opaque) {
          if (typeof this._io.admitReferral !== 'function') invalid()
          const provenance = safe(entry, 'provenance')
          if (provenance === undefined || provenance === null) invalid()
          probeTarget = this._io.admitReferral(provenance)
        }
        const selfResponse = await this._caps(probeTarget, requestedCapabilityMask)
        const selfEntries = this._entries(selfResponse)
        activeEntry = opaque
          ? selfEntries.find((value) => safe(value, 'self') === true)
          : selfEntries.find(
              (value) => endpointKey(safe(value, 'endpoint')) === endpointKey(endpoint)
            )
        if (!activeEntry) {
          this._counters.candidateRejectCount++
          return null
        }
        advertisement = safe(activeEntry, 'advertisement')
        hint = opaque ? activeEntry : safe(activeEntry, 'validated')
      }

      const admitted = opaque
        ? this._io.admitCandidate(safe(activeEntry, 'provenance'), this._directory)
        : this._directory.admit(advertisement, {
            observedEndpoint: endpoint,
            capsBinding: activeEntry.capsBinding || null
          })
      this._counters.activeValidationCount++
      const validated = await this._directory.validate(admitted, (challenge) =>
        this._io.usesOpaqueDiscoveryAuthority === true
          ? this._io.activeChallenge(admitted, challenge)
          : this._io.activeChallenge(
              endpoint,
              Object.freeze({ admitted, challenge, validated: hint })
            )
      )
      if (!this._directory.isValidated(validated)) {
        this._counters.candidateRejectCount++
        return null
      }
      let state = null
      try {
        state = this._directory.read(validated)
        if ((state.capabilityMask & requestedCapabilityMask) !== requestedCapabilityMask) {
          this._counters.candidateRejectCount++
          return null
        }
        if (typeof this._io.pinGuard !== 'function') invalid()
        return await this._io.pinGuard(validated, this._guardLinkSetup)
      } finally {
        clearValidatedProjection(state)
      }
    } catch {
      this._counters.candidateRejectCount++
      return null
    }
  }

  async _tryResponse(response, mask, queriedEndpoint, seenEndpoints, seenIdentities) {
    for (const entry of this._entries(response)) {
      const validated = await this._tryEntry(
        entry,
        mask,
        queriedEndpoint,
        seenEndpoints,
        seenIdentities
      )
      if (validated) return validated
      if (this._counters.activeValidationCount >= MAX_DIRECT_GUARD_CHALLENGES) break
    }
    return null
  }

  async discoverGuard({ bootstraps, requestedCapabilityMask } = {}) {
    if (
      this._destroyed ||
      this._completed ||
      !Array.isArray(bootstraps) ||
      bootstraps.length === 0 ||
      !Number.isSafeInteger(requestedCapabilityMask) ||
      requestedCapabilityMask <= 0 ||
      requestedCapabilityMask > 7
    ) {
      invalid()
    }
    const seenEndpoints = new Set()
    const seenIdentities = new Set()
    let compatibleResponseSeen = false
    try {
      for (const bootstrap of bootstraps.slice(0, MAX_COMPATIBLE_BOOTSTRAPS)) {
        const response = await this._caps(bootstrap, requestedCapabilityMask)
        if (response) compatibleResponseSeen = true
        const validated = await this._tryResponse(
          response,
          requestedCapabilityMask,
          bootstrap,
          seenEndpoints,
          seenIdentities
        )
        if (validated) {
          return this._complete(validated)
        }
        if (this._counters.activeValidationCount >= MAX_DIRECT_GUARD_CHALLENGES) unavailable()
      }

      if (this._allowLegacy && !compatibleResponseSeen) {
        this._counters.publicProbeCount++
        const referrals = await this._io.legacyFindNode(
          bootstraps[0],
          copy(this._randomBytes(32), 32)
        )
        if (!Array.isArray(referrals)) invalid()
        const opaque = this._io.usesOpaqueDiscoveryAuthority === true
        const seenLegacyReferrals = new Set()
        for (const referral of referrals) {
          if (
            this._counters.activeValidationCount >= MAX_DIRECT_GUARD_CHALLENGES ||
            this._prospectiveProbeCount >= MAX_DIRECT_GUARD_CHALLENGES
          ) {
            break
          }
          const referralIdentity = opaque ? referral : endpointKey(referral)
          if (
            seenLegacyReferrals.has(referralIdentity) ||
            (!opaque && seenEndpoints.has(referralIdentity))
          ) {
            this._counters.candidateRejectCount++
            continue
          }
          seenLegacyReferrals.add(referralIdentity)
          this._prospectiveProbeCount++
          const response = await this._caps(referral, requestedCapabilityMask)
          const validated = await this._tryResponse(
            response,
            requestedCapabilityMask,
            referral,
            seenEndpoints,
            seenIdentities
          )
          if (validated) {
            return this._complete(validated)
          }
        }
      }
      unavailable()
    } catch (err) {
      this._destroyed = true
      try {
        this._io.destroy()
      } catch {}
      if (err instanceof PrivateRouteError && err.code === 'ERR_PRIVACY_UNAVAILABLE') throw err
      unavailable()
    }
  }
}
