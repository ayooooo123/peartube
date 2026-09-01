import b4a from 'b4a'

import { BOOTSTRAP_PROVENANCE, createBootstrapReferralAuthority } from './discovery-evidence.js'
import {
  adoptBranchEstablishedLink,
  completeBranchConstruction,
  failBranchConstruction,
  initializeBranchGuardLease,
  readBranchConstructionDeadline,
  readBranchConstructionSetup,
  takeBranchConstructionRequest,
  validateBranchGuardLease
} from './branch-construction-authority.js'
import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import { digestPayloadParameters } from './final-exit.js'
import {
  abortIndexZeroGuardLink,
  completeIndexZeroGuardLink,
  createIndexZeroGuardLinkOffer,
  destroyM3EstablishedLink,
  readM3EstablishedLink
} from './guard-link.js'
import { revokeM3TailCapability } from './m3-adjacency-runtime.js'
import {
  decodeCanonicalEndpoint,
  decodeRelayCapabilityAdvertisement,
  digestRelayCapabilityAdvertisement
} from './relay-capability.js'
import { M3_MESSAGE_ID, M3_PROTOCOL_VERSION, decodeM3Object, encodeM3Object } from './protocol.js'
import { createTailControlSession } from './tail-control.js'

const CAPS_RESPONSE_DOMAIN = b4a.from('hyperdht-private-routes/m3/caps-response/v1')
const CORE_FRAGMENT_DOMAIN = b4a.from('hyperdht-private-routes/m3/core-fragment/object/v1')
const EXCHANGE_TIMEOUT = 5_000n
const DIRECT_FRAGMENT_DATA = 1_144
const DIRECT_OBJECT_BYTES = 12_288
const DIRECT_REASSEMBLY_BYTES = 24_576
const DIRECT_REASSEMBLIES = 2
const MAX_RESPONSE_DATAGRAMS = 32
const GUARD_ESTABLISH_TIMEOUT = 5_000n
const GUARD_LINK_TRANSFERS = new WeakMap()
const CONSTRUCTED_GUARD_BRANCHES = new WeakMap()
const GUARD_READY_TRANSFERS = new WeakSet()
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

function destroyed() {
  throw PrivateRouteError.ERR_DESTROYED()
}

function unauthorized() {
  throw PrivateRouteError.ERR_AUTHENTICATION()
}

export function consumeBootstrapGuardLink(capability) {
  const state =
    capability !== null && typeof capability === 'object'
      ? GUARD_LINK_TRANSFERS.get(capability)
      : null
  if (!state) throw PrivateRouteError.ERR_REPLAY()
  let current = null
  try {
    current = state.now()
  } catch {}
  if (!uint64(current) || current >= state.expiresAt) {
    closeGuardTransfer(capability, state)
    throw PrivateRouteError.ERR_REPLAY()
  }
  const advertisements = Object.freeze(
    state.advertisements.map((entry) =>
      Object.freeze({
        provenance: entry.provenance,
        advertisement: copy(entry.advertisement, 548)
      })
    )
  )
  const result = Object.freeze({
    established: state.established,
    pinnedGuard: Object.freeze({
      relayIdentity: copy(state.pinnedGuard.relayIdentity, 32),
      reachableEndpoint: copy(state.pinnedGuard.reachableEndpoint, 19),
      advertisementDigest: copy(state.pinnedGuard.advertisementDigest, 32),
      epoch: state.pinnedGuard.epoch
    }),
    advertisements
  })
  GUARD_LINK_TRANSFERS.delete(capability)
  if (state.timer !== null) {
    try {
      state.clearTimer(state.timer)
    } catch {}
    state.timer = null
  }
  clear(state.pinnedGuard.relayIdentity)
  clear(state.pinnedGuard.reachableEndpoint)
  clear(state.pinnedGuard.advertisementDigest)
  for (const entry of state.advertisements) clear(entry.advertisement)
  return result
}

function closeGuardTransfer(capability, state) {
  if (GUARD_LINK_TRANSFERS.get(capability) !== state) return false
  GUARD_LINK_TRANSFERS.delete(capability)
  if (state.timer !== null) {
    try {
      state.clearTimer(state.timer)
    } catch {}
    state.timer = null
  }
  clear(state.pinnedGuard.relayIdentity)
  clear(state.pinnedGuard.reachableEndpoint)
  clear(state.pinnedGuard.advertisementDigest)
  for (const entry of state.advertisements) clear(entry.advertisement)
  try {
    destroyM3EstablishedLink(state.established)
  } catch {}
  return true
}

export function revokeBootstrapGuardLink(capability) {
  const state =
    capability !== null && typeof capability === 'object'
      ? GUARD_LINK_TRANSFERS.get(capability)
      : null
  if (!state) throw PrivateRouteError.ERR_REPLAY()
  return closeGuardTransfer(capability, state)
}

function constructedGuardBranch(runtime, tailControl) {
  const resource = Object.freeze({
    destroy() {
      const state = CONSTRUCTED_GUARD_BRANCHES.get(resource)
      if (!state) return false
      CONSTRUCTED_GUARD_BRANCHES.delete(resource)
      try {
        state.tailControl.destroy()
      } finally {
        state.runtime.destroy()
      }
      return true
    }
  })
  CONSTRUCTED_GUARD_BRANCHES.set(resource, { runtime, tailControl })
  return resource
}

// Deep production import used by RouteManager after the paired construction
// authority releases both branches atomically.
export function consumeConstructedGuardBranch(resource) {
  const state =
    resource !== null && typeof resource === 'object'
      ? CONSTRUCTED_GUARD_BRANCHES.get(resource)
      : null
  if (!state) throw PrivateRouteError.ERR_REPLAY()
  CONSTRUCTED_GUARD_BRANCHES.delete(resource)
  return Object.freeze({ runtime: state.runtime, tailControl: state.tailControl })
}

export function consumeBootstrapGuardReady(capability) {
  if (
    capability === null ||
    typeof capability !== 'object' ||
    !GUARD_READY_TRANSFERS.has(capability)
  ) {
    throw PrivateRouteError.ERR_REPLAY()
  }
  GUARD_READY_TRANSFERS.delete(capability)
  return true
}

function abortBoundary() {
  const listeners = new Set()
  const signal = {
    aborted: false,
    addEventListener(name, listener) {
      if (name === 'abort' && typeof listener === 'function') listeners.add(listener)
    },
    removeEventListener(name, listener) {
      if (name === 'abort') listeners.delete(listener)
    }
  }
  return {
    signal,
    abort() {
      if (signal.aborted) return
      signal.aborted = true
      for (const listener of listeners) {
        try {
          listener()
        } catch {}
      }
      listeners.clear()
    }
  }
}

function unrefTimer(timer) {
  try {
    if (timer && typeof timer.unref === 'function') timer.unref()
  } catch {}
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

function length(value) {
  try {
    return b4a.isBuffer(value) ? byteLengthGetter.call(value) : -1
  } catch {
    return -1
  }
}

function copy(value, maximum = 12_288) {
  const size = length(value)
  if (size < 0 || size > maximum) invalid()
  const output = b4a.allocUnsafeSlow(size)
  try {
    setIntrinsic.call(output, value)
  } catch {
    invalid()
  }
  return output
}

function subarray(value, start, end) {
  try {
    return subarrayIntrinsic.call(value, start, end)
  } catch {
    invalid()
  }
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) fillIntrinsic.call(value, 0)
  } catch {
    // Best-effort zeroization.
  }
}

function clearCapsBinding(binding) {
  if (!binding || typeof binding !== 'object') return
  clear(binding.queryNonce)
  clear(binding.returnRoutabilityCookie)
}

function clearCandidateProjection(candidate) {
  if (!candidate || typeof candidate !== 'object') return
  for (const name of [
    'advertisement',
    'relayIdentity',
    'currentDhtNodeId',
    'reachableEndpoint',
    'routeEncryptionPublicKey'
  ]) {
    clear(candidate[name])
  }
  clearCapsBinding(candidate.capsBinding)
}

function endpointKey(endpoint) {
  if (typeof endpoint === 'string' && endpoint.length > 0 && endpoint.length <= 256) {
    return `s:${endpoint}`
  }
  if (length(endpoint) > 0 && length(endpoint) <= 256) return `b:${b4a.toString(endpoint, 'hex')}`
  invalid()
}

function validQuery(query) {
  const mask = safe(query, 'requestedCapabilityMask')
  const maximumResults = safe(query, 'maximumResults')
  if (
    !Number.isSafeInteger(mask) ||
    mask <= 0 ||
    mask > 7 ||
    length(safe(query, 'randomTarget')) !== 32 ||
    length(safe(query, 'queryNonce')) !== 32 ||
    !Number.isSafeInteger(maximumResults) ||
    maximumResults < 1 ||
    maximumResults > 8
  ) {
    invalid()
  }
}

function checker(value) {
  return value !== null && typeof value === 'object' && typeof value.isValidated === 'function'
}

function uint64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= 0xffff_ffff_ffff_ffffn
}

function writeUint16(output, value, offset) {
  output[offset] = value >>> 8
  output[offset + 1] = value
}

function writeUint32(output, value, offset) {
  output[offset] = value >>> 24
  output[offset + 1] = value >>> 16
  output[offset + 2] = value >>> 8
  output[offset + 3] = value
}

function writeUint64(output, value, offset) {
  for (let index = offset + 7; index >= offset; index--) {
    output[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function readUint16(input, offset) {
  return (input[offset] << 8) | input[offset + 1]
}

function readUint32(input, offset) {
  return (
    input[offset] * 0x1000000 +
    (input[offset + 1] << 16) +
    (input[offset + 2] << 8) +
    input[offset + 3]
  )
}

function readUint64(input, offset) {
  let value = 0n
  for (let index = offset; index < offset + 8; index++) {
    value = (value << 8n) | BigInt(input[index])
  }
  return value
}

function equal(left, right) {
  try {
    return length(left) === length(right) && b4a.equals(left, right)
  } catch {
    return false
  }
}

function nonzero(value) {
  if (length(value) < 1) return false
  for (const byte of value) if (byte !== 0) return true
  return false
}

function signatureInput(domain, messageId, body) {
  const output = b4a.allocUnsafeSlow(2 + domain.byteLength + 8 + body.byteLength)
  writeUint16(output, domain.byteLength, 0)
  setIntrinsic.call(output, domain, 2)
  writeUint32(output, M3_PROTOCOL_VERSION, 2 + domain.byteLength)
  writeUint16(output, messageId, 6 + domain.byteLength)
  writeUint16(output, body.byteLength, 8 + domain.byteLength)
  setIntrinsic.call(output, body, 10 + domain.byteLength)
  return output
}

function encodeCapsQuery(query, phase, expiresAt = 0n, cookie = b4a.alloc(32)) {
  const body = b4a.allocUnsafeSlow(110)
  writeUint32(body, safe(query, 'requestedCapabilityMask'), 0)
  setIntrinsic.call(body, safe(query, 'randomTarget'), 4)
  setIntrinsic.call(body, safe(query, 'queryNonce'), 36)
  body[68] = safe(query, 'maximumResults')
  body[69] = phase
  writeUint64(body, expiresAt, 70)
  setIntrinsic.call(body, cookie, 78)
  return encodeM3Object({ messageId: M3_MESSAGE_ID.CAPS_QUERY_V1, body })
}

function compareBytes(left, right) {
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function compareAdvertisements(left, right, target) {
  for (let index = 0; index < 32; index++) {
    const a = left.currentDhtNodeId[index] ^ target[index]
    const b = right.currentDhtNodeId[index] ^ target[index]
    if (a !== b) return a - b
  }
  const identity = compareBytes(left.relayIdentity, right.relayIdentity)
  if (identity !== 0) return identity
  return left.epoch < right.epoch ? -1 : left.epoch > right.epoch ? 1 : 0
}

export class BootstrapIO {
  constructor({
    socketFactory,
    candidateChecker,
    configuredBootstraps,
    guardHandshakeFactory = null,
    now,
    randomBytes,
    setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout,
    normalDht: _normalDht,
    constructionRequest = null,
    constructionSession = null
  } = {}) {
    if (
      typeof socketFactory !== 'function' ||
      !checker(candidateChecker) ||
      !Array.isArray(configuredBootstraps) ||
      configuredBootstraps.length === 0 ||
      typeof now !== 'function' ||
      typeof randomBytes !== 'function' ||
      typeof setTimer !== 'function' ||
      typeof clearTimer !== 'function' ||
      (guardHandshakeFactory !== null &&
        (typeof guardHandshakeFactory !== 'object' ||
          typeof guardHandshakeFactory.openGuard !== 'function'))
    ) {
      invalid()
    }
    this._socketFactory = socketFactory
    if (constructionRequest !== null && constructionSession !== null) invalid()
    this._constructionSession =
      constructionSession !== null
        ? constructionSession
        : constructionRequest === null
          ? null
          : takeBranchConstructionRequest(constructionRequest)
    this._authorityDeadline = this._constructionSession
      ? readBranchConstructionDeadline(this._constructionSession)
      : null
    this._constructionComplete = false
    this._candidateChecker = candidateChecker
    this._guardHandshakeFactory = guardHandshakeFactory
    const referralAuthority = createBootstrapReferralAuthority({ now })
    this._capsReferralIssuer = referralAuthority.capsIssuer
    this._legacyReferralIssuer = referralAuthority.legacyIssuer
    this._referralChecker = referralAuthority.checker
    this._destroyReferralAuthority = referralAuthority.destroy
    this._configured = new Map()
    for (const endpoint of configuredBootstraps) {
      const canonical = decodeCanonicalEndpoint(endpoint)
      const key = endpointKey(canonical)
      if (!this._configured.has(key) && this._configured.size < 3) {
        this._configured.set(key, canonical)
      } else {
        clear(canonical)
      }
    }
    this._now = now
    this._randomBytes = randomBytes
    this._setTimer = setTimer
    this._clearTimer = clearTimer
    this._socket = null
    this._ready = false
    this._destroyed = false
    this._state = 'NEW'
    this._legacyUsed = false
    this._configuredProbes = new Set()
    this._referralProbes = new Set()
    this._challengeCount = 0
    this._addresses = new Map()
    this._referrals = new Map()
    this._advertisements = []
    this._queryNonces = new Set()
    this._capsInFlight = false
    this._capsFragmented = false
    this._reassemblies = new Map()
    this._reservedReassemblyBytes = 0
    this._timeoutErrors = new WeakSet()
    this._counters = {
      publicProbeCount: 0,
      candidateRejectCount: 0,
      activeValidationCount: 0
    }
  }

  get destroyed() {
    return this._destroyed
  }

  get counters() {
    return { ...this._counters }
  }

  get usesOpaqueDiscoveryAuthority() {
    return true
  }

  async ready() {
    if (this._destroyed) destroyed()
    if (this._ready) return
    let socket
    try {
      socket = this._socketFactory()
      if (
        socket === null ||
        typeof socket !== 'object' ||
        typeof socket.bind !== 'function' ||
        typeof socket.send !== 'function' ||
        typeof socket.receive !== 'function' ||
        typeof socket.abort !== 'function' ||
        typeof socket.destroy !== 'function'
      ) {
        invalid()
      }
      this._socket = socket
      await socket.bind()
      this._ready = true
      this._state = 'DISCOVERING'
    } catch (err) {
      this.destroy()
      if (err instanceof PrivateRouteError) throw err
      invalid()
    }
  }

  _assertLive() {
    this._assertNotDestroyed()
    if (!this._ready || !this._socket) invalid()
    if (this._state !== 'DISCOVERING') destroyed()
  }

  _assertNotDestroyed() {
    if (this._destroyed) destroyed()
  }

  _clampDeadline(current, deadline) {
    if (!uint64(current) || !uint64(deadline)) invalid()
    if (this._authorityDeadline !== null && this._authorityDeadline < deadline) {
      deadline = this._authorityDeadline
    }
    if (deadline <= current) throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
    return deadline
  }

  _resolveProbe(target) {
    const referral =
      target !== null && typeof target === 'object' ? this._referrals.get(target) : null
    if (referral) {
      if (referral.used) unauthorized()
      referral.used = true
      const key = endpointKey(referral.endpoint)
      if (this._referralProbes.has(key)) invalid()
      if (this._referralProbes.size >= 3) {
        throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
      }
      this._referralProbes.add(key)
      return { endpoint: referral.endpoint, key }
    }
    const key = endpointKey(target)
    if (this._configured.has(key)) {
      if (this._configuredProbes.has(key)) invalid()
      this._configuredProbes.add(key)
      return { endpoint: this._configured.get(key), key }
    }
    unauthorized()
  }

  _clearReassemblies() {
    for (const state of this._reassemblies.values()) clear(state.bytes)
    this._reassemblies.clear()
    this._reservedReassemblyBytes = 0
  }

  _rememberAddress(key, endpoint) {
    clear(this._addresses.get(key))
    this._addresses.set(key, copy(endpoint, 19))
  }

  _timed(operation, deadline, endpoint) {
    const current = this._now()
    this._assertNotDestroyed()
    if (!uint64(current) || !uint64(deadline) || deadline <= current) {
      try {
        this._socket.abort(endpoint)
      } catch {}
      const error = PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
      this._timeoutErrors.add(error)
      throw error
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = this._setTimer(
        () => {
          if (settled) return
          settled = true
          try {
            this._socket.abort(endpoint)
          } catch {}
          this._clearReassemblies()
          const error = PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
          this._timeoutErrors.add(error)
          reject(error)
        },
        Number(deadline - current)
      )
      Promise.resolve(operation).then(
        (value) => {
          if (settled) return
          settled = true
          this._clearTimer(timer)
          resolve(value)
        },
        (err) => {
          if (settled) return
          settled = true
          this._clearTimer(timer)
          reject(err)
        }
      )
    })
  }

  async _send(endpoint, datagram, deadline) {
    if (length(datagram) < 8 || length(datagram) > 1_200) invalid()
    await this._timed(this._socket.send(endpoint, datagram), deadline, endpoint)
    this._assertLive()
  }

  async _receive(endpoint, deadline) {
    const packet = await this._timed(this._socket.receive(), deadline, endpoint)
    this._assertLive()
    const sourceEndpoint = decodeCanonicalEndpoint(safe(packet, 'sourceEndpoint'))
    const datagram = copy(safe(packet, 'datagram'), 1_200)
    if (!equal(sourceEndpoint, endpoint)) unauthorized()
    if (datagram.byteLength < 8 || datagram.byteLength > 1_200) invalid()
    return datagram
  }

  _acceptFragment(object, current) {
    if (object.messageId !== M3_MESSAGE_ID.CORE_FRAGMENT_V1) invalid()
    const body = object.body
    if (body.byteLength < 48) invalid()
    const objectMessageId = readUint16(body, 0)
    const objectDigest = copy(subarray(body, 2, 34), 32)
    const totalObjectBytes = readUint32(body, 34)
    const fragmentIndex = readUint16(body, 38)
    const fragmentCount = readUint16(body, 40)
    const fragmentOffset = readUint32(body, 42)
    const fragmentDataBytes = readUint16(body, 46)
    if (
      objectMessageId !== M3_MESSAGE_ID.CAPS_RESPONSE_V1 ||
      totalObjectBytes < 407 ||
      totalObjectBytes > DIRECT_OBJECT_BYTES ||
      fragmentCount !== Math.ceil(totalObjectBytes / DIRECT_FRAGMENT_DATA) ||
      fragmentCount < 1 ||
      fragmentCount > 11 ||
      fragmentIndex >= fragmentCount ||
      fragmentOffset !== fragmentIndex * DIRECT_FRAGMENT_DATA ||
      fragmentDataBytes !==
        (fragmentIndex + 1 === fragmentCount
          ? totalObjectBytes - fragmentOffset
          : DIRECT_FRAGMENT_DATA) ||
      body.byteLength !== 48 + fragmentDataBytes
    ) {
      invalid()
    }
    const key = b4a.toString(objectDigest, 'hex')
    let state = this._reassemblies.get(key)
    if (!state) {
      if (
        fragmentIndex !== 0 ||
        this._reassemblies.size >= DIRECT_REASSEMBLIES ||
        this._reservedReassemblyBytes + totalObjectBytes > DIRECT_REASSEMBLY_BYTES
      ) {
        throw PrivateRouteError.ERR_BUSY()
      }
      state = {
        bytes: b4a.allocUnsafeSlow(totalObjectBytes),
        digest: objectDigest,
        expiresAt: current + EXCHANGE_TIMEOUT,
        fragmentCount,
        received: new Set(),
        totalObjectBytes
      }
      this._reassemblies.set(key, state)
      this._reservedReassemblyBytes += totalObjectBytes
    } else if (
      state.totalObjectBytes !== totalObjectBytes ||
      state.fragmentCount !== fragmentCount ||
      state.expiresAt <= current
    ) {
      invalid()
    }
    const data = subarray(body, 48)
    if (state.received.has(fragmentIndex)) {
      if (!equal(subarray(state.bytes, fragmentOffset, fragmentOffset + fragmentDataBytes), data)) {
        invalid()
      }
      return null
    }
    setIntrinsic.call(state.bytes, data, fragmentOffset)
    state.received.add(fragmentIndex)
    if (state.received.size !== fragmentCount) return null
    const complete = copy(state.bytes, DIRECT_OBJECT_BYTES)
    const digest = cryptoSuite.hash([CORE_FRAGMENT_DOMAIN, complete])
    if (!equal(digest, state.digest)) {
      clear(complete)
      invalid()
    }
    if (readUint16(complete, 4) !== objectMessageId) {
      clear(complete)
      invalid()
    }
    this._clearReassemblies()
    return complete
  }

  async _receiveCapsResponse(endpoint, deadline) {
    for (let count = 0; count < MAX_RESPONSE_DATAGRAMS; count++) {
      const datagram = await this._receive(endpoint, deadline)
      const object = decodeM3Object(datagram)
      if (object.messageId === M3_MESSAGE_ID.CAPS_RESPONSE_V1) return datagram
      if (object.messageId !== M3_MESSAGE_ID.CORE_FRAGMENT_V1) invalid()
      this._capsFragmented = true
      const complete = this._acceptFragment(object, this._now())
      if (complete) return complete
    }
    throw PrivateRouteError.ERR_BUSY()
  }

  _decodeCapsResponse(encoded, endpoint, query, binding, deadline) {
    const object = decodeM3Object(encoded)
    if (object.messageId !== M3_MESSAGE_ID.CAPS_RESPONSE_V1) invalid()
    const body = object.body
    const responderIdentity = copy(subarray(body, 0, 32), 32)
    if (!equal(subarray(body, 32, 64), safe(query, 'queryNonce'))) unauthorized()
    const responseTime = readUint64(body, 64)
    const current = this._now()
    const count = body[72]
    if (
      !uint64(current) ||
      !uint64(responseTime) ||
      responseTime > current ||
      current >= deadline ||
      count < 1 ||
      count > safe(query, 'maximumResults') ||
      count > 8
    ) {
      unauthorized()
    }
    const ranges = []
    let offset = 73
    for (let index = 0; index < count; index++) {
      if (offset + 2 > body.byteLength) invalid()
      const advertisementBytes = readUint16(body, offset)
      offset += 2
      if (
        advertisementBytes < 260 ||
        advertisementBytes > 548 ||
        offset + advertisementBytes > body.byteLength
      ) {
        invalid()
      }
      ranges.push([offset, offset + advertisementBytes])
      offset += advertisementBytes
    }
    if (offset !== body.byteLength) invalid()
    const input = signatureInput(CAPS_RESPONSE_DOMAIN, M3_MESSAGE_ID.CAPS_RESPONSE_V1, body)
    const signatureValid = cryptoSuite.verify(input, object.authSuffix, responderIdentity)
    clear(input)
    if (!signatureValid) unauthorized()
    const seenDigests = new Set()
    const seenIdentities = new Set()
    const decodedEntries = []
    let selfCount = 0
    for (const [start, end] of ranges) {
      const advertisement = copy(subarray(body, start, end), 548)
      const decoded = decodeRelayCapabilityAdvertisement(advertisement, { now: current })
      const digest = digestRelayCapabilityAdvertisement(advertisement, { now: current })
      const digestKey = b4a.toString(digest, 'hex')
      const identityKey = b4a.toString(decoded.relayIdentity, 'hex')
      if (seenDigests.has(digestKey) || seenIdentities.has(identityKey)) invalid()
      seenDigests.add(digestKey)
      seenIdentities.add(identityKey)
      const self =
        equal(decoded.relayIdentity, responderIdentity) &&
        equal(decoded.reachableEndpoint, endpoint)
      if (self) selfCount++
      decodedEntries.push({ advertisement, decoded, self })
    }
    for (let index = 1; index < decodedEntries.length; index++) {
      if (
        compareAdvertisements(
          decodedEntries[index - 1].decoded,
          decodedEntries[index].decoded,
          safe(query, 'randomTarget')
        ) >= 0
      ) {
        invalid()
      }
    }
    if (selfCount !== 1) unauthorized()
    return Object.freeze({
      fragmented: this._capsFragmented,
      advertisements: Object.freeze(
        decodedEntries.map(({ advertisement, decoded, self }) => {
          const capsBinding = {
            queryNonce: copy(safe(query, 'queryNonce'), 32),
            cookieExpiresAtMs: binding.cookieExpiresAtMs,
            returnRoutabilityCookie: copy(binding.returnRoutabilityCookie, 32)
          }
          try {
            const provenance = this._capsReferralIssuer.issue({ advertisement, capsBinding })
            return Object.freeze({
              advertisement,
              provenance,
              relayIdentity: copy(decoded.relayIdentity, 32),
              currentDhtNodeId: copy(decoded.currentDhtNodeId, 32),
              capabilityMask: decoded.capabilityMask,
              capacityClass: decoded.capacityClass,
              epoch: decoded.epoch,
              self
            })
          } finally {
            clearCapsBinding(capsBinding)
          }
        })
      )
    })
  }

  async capsQuery(target, query) {
    this._assertLive()
    validQuery(query)
    this._assertLive()
    if (this._capsInFlight) throw PrivateRouteError.ERR_BUSY()
    this._capsInFlight = true
    this._capsFragmented = false
    let queryScratch = null
    let returnRoutabilityCookie = null
    let endpoint = null
    try {
      queryScratch = {
        requestedCapabilityMask: safe(query, 'requestedCapabilityMask'),
        randomTarget: copy(safe(query, 'randomTarget'), 32),
        queryNonce: copy(safe(query, 'queryNonce'), 32),
        maximumResults: safe(query, 'maximumResults')
      }
      this._assertLive()
      const { endpoint: unresolvedEndpoint, key } = this._resolveProbe(target)
      endpoint = decodeCanonicalEndpoint(unresolvedEndpoint)
      const nonceKey = b4a.toString(queryScratch.queryNonce, 'hex')
      if (this._queryNonces.has(nonceKey)) invalid()
      this._queryNonces.add(nonceKey)
      this._rememberAddress(key, endpoint)
      this._counters.publicProbeCount++
      const startedAt = this._now()
      this._assertLive()
      if (!uint64(startedAt)) invalid()
      const deadline = this._clampDeadline(startedAt, startedAt + EXCHANGE_TIMEOUT)
      try {
        await this._send(endpoint, encodeCapsQuery(queryScratch, 0), deadline)
        const challengeObject = decodeM3Object(await this._receive(endpoint, deadline))
        if (
          challengeObject.messageId !== M3_MESSAGE_ID.CAPS_COOKIE_CHALLENGE_V1 ||
          !equal(subarray(challengeObject.body, 0, 32), queryScratch.queryNonce)
        ) {
          unauthorized()
        }
        const cookieExpiresAtMs = readUint64(challengeObject.body, 32)
        const current = this._now()
        this._assertLive()
        returnRoutabilityCookie = copy(subarray(challengeObject.body, 40, 72), 32)
        let nonzeroCookie = false
        for (const byte of returnRoutabilityCookie) nonzeroCookie ||= byte !== 0
        if (
          !uint64(current) ||
          cookieExpiresAtMs <= current ||
          cookieExpiresAtMs > deadline ||
          !nonzeroCookie
        ) {
          unauthorized()
        }
        await this._send(
          endpoint,
          encodeCapsQuery(queryScratch, 1, cookieExpiresAtMs, returnRoutabilityCookie),
          deadline
        )
        const encoded = await this._receiveCapsResponse(endpoint, deadline)
        return this._decodeCapsResponse(
          encoded,
          endpoint,
          queryScratch,
          { cookieExpiresAtMs, returnRoutabilityCookie },
          deadline
        )
      } finally {
        this._clearReassemblies()
      }
    } catch (err) {
      if (err !== null && typeof err === 'object' && this._timeoutErrors.has(err)) return null
      throw err
    } finally {
      this._capsInFlight = false
      clear(queryScratch && queryScratch.randomTarget)
      clear(queryScratch && queryScratch.queryNonce)
      clear(returnRoutabilityCookie)
      clear(endpoint)
    }
  }

  async legacyFindNode(endpoint, target) {
    this._assertLive()
    if (this._legacyUsed) invalid()
    const key = endpointKey(endpoint)
    const configured = this._configured.get(key)
    if (!configured || length(target) !== 32) invalid()
    this._legacyUsed = true
    let dialEndpoint = null
    let targetScratch = null
    try {
      dialEndpoint = decodeCanonicalEndpoint(configured)
      targetScratch = copy(target, 32)
      this._rememberAddress(key, dialEndpoint)
      this._counters.publicProbeCount++
      const legacyFindNode = this._socket.legacyFindNode
      if (typeof legacyFindNode !== 'function') invalid()
      const current = this._now()
      this._assertLive()
      if (!uint64(current)) invalid()
      const referrals = await this._timed(
        legacyFindNode.call(this._socket, dialEndpoint, targetScratch),
        this._clampDeadline(current, current + EXCHANGE_TIMEOUT),
        dialEndpoint
      )
      if (!Array.isArray(referrals) || referrals.length > 20) invalid()
      const unique = []
      const seen = new Set()
      for (const referral of referrals) {
        const key = endpointKey(referral)
        if (seen.has(key)) continue
        seen.add(key)
        unique.push(referral)
        if (unique.length === 3) break
      }
      return Object.freeze(
        unique.map((value) =>
          this.admitReferral(this._legacyReferralIssuer.issue({ endpoint: value }))
        )
      )
    } finally {
      clear(dialEndpoint)
      clear(targetScratch)
    }
  }

  async activeChallenge(admittedCandidate, challenge) {
    this._assertLive()
    if (length(challenge) !== 184) invalid()
    const challengeObject = decodeM3Object(challenge)
    if (challengeObject.messageId !== M3_MESSAGE_ID.ACTIVE_CHALLENGE_V1) invalid()
    if (this._challengeCount >= 3) throw PrivateRouteError.ERR_PRIVACY_UNAVAILABLE()
    this._challengeCount++
    this._counters.activeValidationCount++
    let candidate = null
    let endpoint = null
    try {
      if (
        typeof this._candidateChecker.isAdmitted !== 'function' ||
        typeof this._candidateChecker.readAdmitted !== 'function' ||
        !this._candidateChecker.isAdmitted(admittedCandidate)
      ) {
        unauthorized()
      }
      this._assertLive()
      candidate = this._candidateChecker.readAdmitted(admittedCandidate)
      this._assertLive()
      const projectedEndpoint = safe(candidate, 'reachableEndpoint')
      const storedEndpoint = this._addresses.get(endpointKey(projectedEndpoint))
      if (!storedEndpoint) unauthorized()
      endpoint = decodeCanonicalEndpoint(storedEndpoint)
      if (
        safe(candidate, 'capsBinding') === null ||
        typeof safe(candidate, 'capsBinding') !== 'object'
      ) {
        unauthorized()
      }
      this._assertLive()
      const current = this._now()
      this._assertLive()
      if (!uint64(current)) invalid()
      let deadline = current + EXCHANGE_TIMEOUT
      const challengeExpiresAt = readUint64(challengeObject.body, 96)
      const cookieExpiresAt = readUint64(challengeObject.body, 136)
      if (challengeExpiresAt < deadline) deadline = challengeExpiresAt
      if (cookieExpiresAt < deadline) deadline = cookieExpiresAt
      deadline = this._clampDeadline(current, deadline)
      await this._send(endpoint, copy(challenge, 184), deadline)
      const response = await this._receive(endpoint, deadline)
      const responseObject = decodeM3Object(response)
      if (responseObject.messageId !== M3_MESSAGE_ID.ACTIVE_CHALLENGE_RESPONSE_V1) unauthorized()
      return response
    } finally {
      clearCandidateProjection(candidate)
      clear(endpoint)
    }
  }

  admitReferral(evidence) {
    this._assertLive()
    if (
      !this._referralChecker.isReferral(evidence) ||
      typeof this._referralChecker.consumeReferral !== 'function'
    ) {
      unauthorized()
    }
    const state = this._referralChecker.consumeReferral(evidence)
    const endpoint = safe(state, 'endpoint')
    endpointKey(endpoint)
    const capability = Object.freeze({})
    this._referrals.set(capability, {
      endpoint,
      advertisement: safe(state, 'advertisement'),
      capsBinding: safe(state, 'capsBinding'),
      used: false
    })
    return capability
  }

  admitCandidate(evidence, directory) {
    this._assertLive()
    if (
      !this._referralChecker.isReferral(evidence) ||
      directory === null ||
      typeof directory !== 'object' ||
      typeof directory.admit !== 'function'
    ) {
      unauthorized()
    }
    if (typeof this._referralChecker.consumeReferral !== 'function') unauthorized()
    const state = this._referralChecker.consumeReferral(evidence)
    try {
      if (!state.advertisement || !state.capsBinding) unauthorized()
      return directory.admit(state.advertisement, {
        observedEndpoint: state.endpoint,
        capsBinding: state.capsBinding
      })
    } finally {
      clear(state.endpoint)
      clear(state.advertisement)
      clearCapsBinding(state.capsBinding)
    }
  }

  async pinGuard(validated, setup) {
    this._assertLive()
    this._state = 'PINNING'
    const candidateChecker = this._candidateChecker
    const guardHandshakeFactory = this._guardHandshakeFactory
    let guardAdmission = null
    let guardAdmissionOwned = false
    let established = null
    let channel = null
    let closeChannel = null
    let physicalChannel = null
    let pendingOffer = null
    let timer = null
    let deadlineReject = null
    let advertisement = null
    let relayIdentity = null
    let reachableEndpoint = null
    let advertisementDigest = null
    let clientIdentity = null
    let clientTail = null
    let consumedAdmission = null
    let admissionProjection = null
    let setupBranchId = null
    let setupCircuitId = null
    let identitySeed = null
    let tailSeed = null
    let identityScratch = null
    let tailScratch = null
    let constructionSetup = null
    let adopted = null
    let tailControl = null
    let branchResource = null
    let receiveReady = null
    let readyEnvelope = null
    try {
      const isValidated = candidateChecker && candidateChecker.isValidated
      this._assertNotDestroyed()
      const reserveGuardAdmission = candidateChecker && candidateChecker.reserveGuardAdmission
      this._assertNotDestroyed()
      const readGuardAdmission = candidateChecker && candidateChecker.readGuardAdmission
      this._assertNotDestroyed()
      const consumeGuardAdmission = candidateChecker && candidateChecker.consumeGuardAdmission
      this._assertNotDestroyed()
      const revokeGuardAdmission = candidateChecker && candidateChecker.revokeGuardAdmission
      this._assertNotDestroyed()
      const openGuard = guardHandshakeFactory && guardHandshakeFactory.openGuard
      this._assertNotDestroyed()
      if (
        typeof isValidated !== 'function' ||
        typeof reserveGuardAdmission !== 'function' ||
        typeof readGuardAdmission !== 'function' ||
        typeof consumeGuardAdmission !== 'function' ||
        typeof revokeGuardAdmission !== 'function' ||
        typeof openGuard !== 'function'
      ) {
        unauthorized()
      }
      const current = this._now()
      this._assertNotDestroyed()
      if (!uint64(current) || !isValidated.call(candidateChecker, validated)) unauthorized()
      let setupSource = setup
      if (this._constructionSession) {
        constructionSetup = readBranchConstructionSetup(this._constructionSession)
        setupSource = constructionSetup
        clientIdentity = {
          publicKey: copy(constructionSetup.clientCircuitIdentity.publicKey, 32),
          secretKey: copy(constructionSetup.clientCircuitIdentity.secretKey, 64)
        }
        clientTail = {
          publicKey: copy(constructionSetup.clientTailEphemeral.publicKey, 32),
          secretKey: copy(constructionSetup.clientTailEphemeral.secretKey, 32)
        }
      } else {
        this._assertNotDestroyed()
        identityScratch = this._randomBytes(32)
        this._assertNotDestroyed()
        identitySeed = copy(identityScratch, 32)
        clear(identityScratch)
        identityScratch = null
        tailScratch = this._randomBytes(32)
        this._assertNotDestroyed()
        tailSeed = copy(tailScratch, 32)
        clear(tailScratch)
        tailScratch = null
        clientIdentity = cryptoSuite.keyPair(identitySeed)
        clientTail = cryptoSuite.encryptionKeyPair(tailSeed)
        clear(identitySeed)
        clear(tailSeed)
        identitySeed = null
        tailSeed = null
      }
      const setupBranchClass = safe(setupSource, 'branchClass')
      setupBranchId = copy(safe(setupSource, 'branchId'), 16)
      setupCircuitId = copy(safe(setupSource, 'circuitId'), 16)
      const setupGeneration = safe(setupSource, 'generation')
      this._assertNotDestroyed()
      guardAdmission = reserveGuardAdmission.call(candidateChecker, validated, {
        clientIdentity: clientIdentity.publicKey,
        branchClass: setupBranchClass,
        branchId: setupBranchId,
        circuitId: setupCircuitId,
        generation: setupGeneration
      })
      guardAdmissionOwned = true
      this._assertNotDestroyed()
      admissionProjection = readGuardAdmission.call(candidateChecker, guardAdmission)
      this._assertNotDestroyed()
      const state = admissionProjection
      advertisement = copy(safe(state, 'advertisement'), 548)
      const decoded = decodeRelayCapabilityAdvertisement(advertisement, { now: current })
      reachableEndpoint = decodeCanonicalEndpoint(safe(state, 'reachableEndpoint'))
      relayIdentity = copy(safe(state, 'relayIdentity'), 32)
      const challengeExpiresAtMs = safe(state, 'challengeExpiresAtMs')
      const cookieExpiresAtMs = safe(state, 'cookieExpiresAtMs')
      if (
        !equal(reachableEndpoint, decoded.reachableEndpoint) ||
        !equal(relayIdentity, decoded.relayIdentity) ||
        safe(state, 'epoch') !== decoded.epoch ||
        !uint64(challengeExpiresAtMs) ||
        !uint64(cookieExpiresAtMs) ||
        challengeExpiresAtMs <= current ||
        cookieExpiresAtMs <= current ||
        !equal(safe(state, 'clientIdentity'), clientIdentity.publicKey) ||
        safe(state, 'branchClass') !== setupBranchClass ||
        !equal(safe(state, 'branchId'), setupBranchId) ||
        !equal(safe(state, 'circuitId'), setupCircuitId) ||
        safe(state, 'generation') !== setupGeneration
      ) {
        unauthorized()
      }
      advertisementDigest = digestRelayCapabilityAdvertisement(advertisement, {
        now: current
      })
      if (!equal(safe(state, 'advertisementDigest'), advertisementDigest)) unauthorized()
      let deadline = current + GUARD_ESTABLISH_TIMEOUT
      if (decoded.expiresAtMs < deadline) deadline = decoded.expiresAtMs
      if (challengeExpiresAtMs < deadline) deadline = challengeExpiresAtMs
      if (cookieExpiresAtMs < deadline) deadline = cookieExpiresAtMs
      deadline = this._clampDeadline(current, deadline)
      if (deadline <= current) unauthorized()
      const deadlinePromise = new Promise((resolve, reject) => {
        deadlineReject = reject
      })
      timer = this._setTimer(
        () => {
          timer = null
          deadlineReject(PrivateRouteError.ERR_PRIVACY_UNAVAILABLE())
        },
        Number(deadline - current)
      )
      this._assertNotDestroyed()
      unrefTimer(timer)
      let openingActive = true
      const opening = Promise.resolve().then(() => {
        this._assertNotDestroyed()
        return openGuard.call(guardHandshakeFactory, copy(reachableEndpoint, 19))
      })
      void opening.then(
        (lateChannel) => {
          if (openingActive) return
          try {
            if (lateChannel && typeof lateChannel.destroy === 'function') lateChannel.destroy()
          } catch {}
        },
        () => {}
      )
      try {
        channel = await Promise.race([opening, deadlinePromise])
      } finally {
        openingActive = false
      }
      this._assertNotDestroyed()
      let sendOffer = null
      let receiveAccept = null
      let takePhysicalChannel = null
      if (channel !== null && typeof channel === 'object') {
        sendOffer = channel.sendOffer
        this._assertNotDestroyed()
        receiveAccept = channel.receiveAccept
        this._assertNotDestroyed()
        receiveReady = channel.receiveReady
        this._assertNotDestroyed()
        takePhysicalChannel = channel.takePhysicalChannel
        this._assertNotDestroyed()
        closeChannel = channel.destroy
        this._assertNotDestroyed()
      }
      if (
        channel === null ||
        typeof channel !== 'object' ||
        typeof sendOffer !== 'function' ||
        typeof receiveAccept !== 'function' ||
        (this._constructionSession && typeof receiveReady !== 'function') ||
        typeof takePhysicalChannel !== 'function' ||
        typeof closeChannel !== 'function'
      ) {
        invalid()
      }
      consumedAdmission = consumeGuardAdmission.call(candidateChecker, guardAdmission)
      this._assertNotDestroyed()
      guardAdmissionOwned = false
      guardAdmission = null
      if (
        !equal(safe(consumedAdmission, 'advertisement'), advertisement) ||
        !equal(safe(consumedAdmission, 'advertisementDigest'), advertisementDigest) ||
        !equal(safe(consumedAdmission, 'reachableEndpoint'), reachableEndpoint) ||
        !equal(safe(consumedAdmission, 'relayIdentity'), relayIdentity) ||
        safe(consumedAdmission, 'challengeExpiresAtMs') !== challengeExpiresAtMs ||
        safe(consumedAdmission, 'cookieExpiresAtMs') !== cookieExpiresAtMs ||
        !equal(safe(consumedAdmission, 'clientIdentity'), clientIdentity.publicKey) ||
        safe(consumedAdmission, 'branchClass') !== setupBranchClass ||
        !equal(safe(consumedAdmission, 'branchId'), setupBranchId) ||
        !equal(safe(consumedAdmission, 'circuitId'), setupCircuitId) ||
        safe(consumedAdmission, 'generation') !== setupGeneration
      ) {
        unauthorized()
      }
      const initiated = createIndexZeroGuardLinkOffer({
        advertisement,
        now: current,
        randomBytes: (size) => {
          const bytes = this._randomBytes(size)
          this._assertNotDestroyed()
          return bytes
        },
        branchClass: setupBranchClass,
        branchId: setupBranchId,
        circuitId: setupCircuitId,
        generation: setupGeneration,
        clientCircuitIdentity: clientIdentity,
        clientTailEphemeral: clientTail,
        payloadParametersDigest: digestPayloadParameters(decoded),
        requestedLimits: safe(setupSource, 'requestedLimits')
      })
      pendingOffer = initiated.pending
      await Promise.race([
        Promise.resolve().then(() => {
          this._assertNotDestroyed()
          return sendOffer.call(channel, copy(initiated.offer, 374))
        }),
        deadlinePromise
      ])
      this._assertNotDestroyed()
      const accept = await Promise.race([
        Promise.resolve().then(() => {
          this._assertNotDestroyed()
          return receiveAccept.call(channel)
        }),
        deadlinePromise
      ])
      this._assertNotDestroyed()
      physicalChannel = takePhysicalChannel.call(channel)
      this._assertNotDestroyed()
      if (
        physicalChannel === null ||
        typeof physicalChannel !== 'object' ||
        typeof physicalChannel.destroy !== 'function'
      ) {
        invalid()
      }
      const acceptedAt = this._now()
      this._assertNotDestroyed()
      const transferredPhysicalChannel = physicalChannel
      physicalChannel = null
      established = completeIndexZeroGuardLink(initiated.pending, accept, {
        advertisement,
        physicalChannel: transferredPhysicalChannel,
        now: acceptedAt
      })
      pendingOffer = null
      const link = readM3EstablishedLink(established)
      if (
        !equal(link.peerIdentity, relayIdentity) ||
        !uint64(link.expiresAt) ||
        !uint64(acceptedAt) ||
        link.expiresAt <= acceptedAt ||
        link.expiresAt > decoded.expiresAtMs
      ) {
        unauthorized()
      }
      if (this._constructionSession) {
        adopted = adoptBranchEstablishedLink(this._constructionSession, established)
        established = null
        tailControl = createTailControlSession(adopted.tail, {
          now: this._now,
          crypto: cryptoSuite
        })
        adopted = { runtime: adopted.runtime, tail: null }
        readyEnvelope = await Promise.race([
          Promise.resolve().then(() => {
            this._assertNotDestroyed()
            return receiveReady.call(channel)
          }),
          deadlinePromise
        ])
        this._assertNotDestroyed()
        tailControl.openReady(readyEnvelope)
        clear(readyEnvelope)
        readyEnvelope = null
        if (constructionSetup.kind === 'bootstrap') {
          initializeBranchGuardLease(this._constructionSession, advertisement)
        } else if (constructionSetup.kind === 'revalidation') {
          validateBranchGuardLease(this._constructionSession, advertisement)
        } else {
          invalid()
        }
        branchResource = constructedGuardBranch(adopted.runtime, tailControl)
        adopted = null
        tailControl = null
        completeBranchConstruction(this._constructionSession, branchResource)
        branchResource = null
        this._constructionComplete = true
      }
      if (timer !== null) {
        this._clearTimer(timer)
        timer = null
      }
      if (this._constructionSession) {
        const guardReady = Object.freeze({})
        GUARD_READY_TRANSFERS.add(guardReady)
        const ownedChannel = channel
        channel = null
        closeChannel.call(ownedChannel)
        this._assertNotDestroyed()
        this.destroy()
        return guardReady
      }
      const pinnedGuard = Object.freeze({
        relayIdentity: copy(relayIdentity, 32),
        reachableEndpoint: copy(reachableEndpoint, 19),
        advertisementDigest: copy(advertisementDigest, 32),
        epoch: decoded.epoch
      })
      const advertisements = Object.freeze([
        Object.freeze({
          provenance: BOOTSTRAP_PROVENANCE.CAPS_RESPONSE,
          advertisement: copy(advertisement, 548)
        })
      ])
      const guardLink = Object.freeze({})
      const transferState = {
        established,
        pinnedGuard,
        advertisements,
        clearTimer: this._clearTimer,
        expiresAt: 0n,
        now: this._now,
        timer: null
      }
      let transferDeadline = link.expiresAt
      if (challengeExpiresAtMs < transferDeadline) transferDeadline = challengeExpiresAtMs
      if (cookieExpiresAtMs < transferDeadline) transferDeadline = cookieExpiresAtMs
      if (decoded.expiresAtMs < transferDeadline) transferDeadline = decoded.expiresAtMs
      const transferCurrent = this._now()
      this._assertNotDestroyed()
      if (!uint64(transferCurrent) || transferDeadline <= transferCurrent) unauthorized()
      transferState.expiresAt = transferDeadline
      transferState.timer = this._setTimer(
        () => {
          transferState.timer = null
          void closeGuardTransfer(guardLink, transferState)
        },
        Number(transferDeadline - transferCurrent)
      )
      this._assertNotDestroyed()
      unrefTimer(transferState.timer)
      const ownedChannel = channel
      channel = null
      closeChannel.call(ownedChannel)
      this._assertNotDestroyed()
      GUARD_LINK_TRANSFERS.set(guardLink, transferState)
      established = null
      this.destroy()
      return guardLink
    } catch (err) {
      if (guardAdmissionOwned) {
        try {
          const revokeGuardAdmission = candidateChecker && candidateChecker.revokeGuardAdmission
          if (typeof revokeGuardAdmission === 'function') {
            revokeGuardAdmission.call(candidateChecker, guardAdmission)
          }
        } catch {}
        guardAdmissionOwned = false
      }
      if (timer !== null) {
        try {
          this._clearTimer(timer)
        } catch {}
      }
      if (established) destroyM3EstablishedLink(established)
      if (branchResource) {
        try {
          branchResource.destroy()
        } catch {}
        branchResource = null
      }
      if (tailControl) {
        try {
          tailControl.destroy()
        } catch {}
        tailControl = null
      }
      if (adopted) {
        try {
          if (adopted.tail) revokeM3TailCapability(adopted.tail)
        } catch {}
        try {
          if (adopted.runtime) adopted.runtime.destroy()
        } catch {}
        adopted = null
      }
      if (pendingOffer) abortIndexZeroGuardLink(pendingOffer)
      if (physicalChannel) {
        try {
          physicalChannel.destroy()
        } catch {}
      }
      if (channel) {
        try {
          if (typeof closeChannel === 'function') closeChannel.call(channel)
          else if (typeof channel.destroy === 'function') channel.destroy()
        } catch {}
      }
      this.destroy()
      if (err instanceof PrivateRouteError) throw err
      unauthorized()
    } finally {
      clear(advertisement)
      clear(relayIdentity)
      clear(reachableEndpoint)
      clear(advertisementDigest)
      clear(clientIdentity && clientIdentity.secretKey)
      clear(clientTail && clientTail.secretKey)
      clear(setupBranchId)
      clear(setupCircuitId)
      clear(identitySeed)
      clear(tailSeed)
      clear(identityScratch)
      clear(tailScratch)
      clear(readyEnvelope)
      clear(constructionSetup && constructionSetup.branchId)
      clear(constructionSetup && constructionSetup.circuitId)
      clear(
        constructionSetup &&
          constructionSetup.clientCircuitIdentity &&
          constructionSetup.clientCircuitIdentity.publicKey
      )
      clear(
        constructionSetup &&
          constructionSetup.clientCircuitIdentity &&
          constructionSetup.clientCircuitIdentity.secretKey
      )
      clear(
        constructionSetup &&
          constructionSetup.clientTailEphemeral &&
          constructionSetup.clientTailEphemeral.publicKey
      )
      clear(
        constructionSetup &&
          constructionSetup.clientTailEphemeral &&
          constructionSetup.clientTailEphemeral.secretKey
      )
      if (admissionProjection) {
        clear(admissionProjection.advertisement)
        clear(admissionProjection.advertisementDigest)
        clear(admissionProjection.reachableEndpoint)
        clear(admissionProjection.relayIdentity)
        clear(admissionProjection.clientIdentity)
        clear(admissionProjection.branchId)
        clear(admissionProjection.circuitId)
      }
      if (consumedAdmission) {
        clear(consumedAdmission.advertisement)
        clear(consumedAdmission.advertisementDigest)
        clear(consumedAdmission.reachableEndpoint)
        clear(consumedAdmission.relayIdentity)
        clear(consumedAdmission.clientIdentity)
        clear(consumedAdmission.branchId)
        clear(consumedAdmission.circuitId)
      }
    }
  }

  async privateReady() {
    this.destroy()
  }

  scratchState() {
    return Object.freeze({
      addresses: this._addresses.size,
      referrals: this._referrals.size,
      advertisements: this._advertisements.length,
      configuredProbes: this._configuredProbes.size,
      reassemblies: this._reassemblies.size,
      reservedReassemblyBytes: this._reservedReassemblyBytes
    })
  }

  diagnostics() {
    return Object.freeze({
      state: this._destroyed ? 'destroyed' : this._state.toLowerCase(),
      publicProbeCount: this._counters.publicProbeCount,
      activeValidationCount: this._counters.activeValidationCount,
      candidateRejectCount: this._counters.candidateRejectCount,
      errorCategory: null
    })
  }

  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    this._state = 'DESTROYED'
    const socket = this._socket
    this._socket = null
    this._socketFactory = null
    this._candidateChecker = null
    this._guardHandshakeFactory = null
    this._authorityDeadline = null
    if (this._constructionSession && !this._constructionComplete) {
      try {
        failBranchConstruction(this._constructionSession)
      } catch {}
    }
    try {
      if (this._destroyReferralAuthority) this._destroyReferralAuthority()
    } catch {}
    this._destroyReferralAuthority = null
    this._referralChecker = null
    this._capsReferralIssuer = null
    this._legacyReferralIssuer = null
    for (const advertisement of this._advertisements) clear(advertisement)
    this._advertisements.length = 0
    this._clearReassemblies()
    for (const endpoint of this._addresses.values()) clear(endpoint)
    this._addresses.clear()
    for (const state of this._referrals.values()) {
      clear(state.endpoint)
      clear(state.advertisement)
      if (state.capsBinding) {
        clear(state.capsBinding.queryNonce)
        clear(state.capsBinding.returnRoutabilityCookie)
      }
    }
    this._referrals.clear()
    this._referralProbes.clear()
    this._configuredProbes.clear()
    for (const endpoint of this._configured.values()) clear(endpoint)
    this._configured.clear()
    this._queryNonces.clear()
    try {
      if (socket) socket.destroy()
    } catch {}
  }
}
