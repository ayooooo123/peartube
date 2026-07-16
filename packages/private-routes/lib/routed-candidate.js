import b4a from 'b4a'

import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import {
  BRANCH_CLASS,
  M3_LINK_ROLE,
  M3_MESSAGE_ID,
  RELAY_CAPABILITY,
  ROLE,
  decodeM3Object,
  encodeM3Object,
  roleForIdentity
} from './protocol.js'
import {
  decodeRelayCapabilityAdvertisement,
  digestRelayCapabilityAdvertisement
} from './relay-capability.js'

const EVIDENCE = new WeakMap()
const EVIDENCE_PRODUCERS = new WeakMap()
const ROUTED_CANDIDATE_DIRECTORIES = new WeakSet()
const TAIL_RESPONSE_RESERVATIONS = new WeakMap()
const MAX_ADVERTISEMENTS = 8
const MAX_RESPONSE_BYTES = 4_449
const MAX_LIVE_CANDIDATES = 16
const MAX_CANDIDATE_STATES = 96
const MAX_REQUESTS_PER_INDEX = 3
const REQUEST_KEY_DOMAIN = b4a.from('hyperdht-private-routes/m3/routed-candidate/request-key/v1')
const ADMISSION_KEY_DOMAIN = b4a.from(
  'hyperdht-private-routes/m3/current-tail-candidate/admission-key/v1'
)
const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const fillIntrinsic = Uint8Array.prototype.fill
const setIntrinsic = Uint8Array.prototype.set
const subarrayIntrinsic = Uint8Array.prototype.subarray

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function authentication() {
  throw PrivateRouteError.ERR_AUTHENTICATION()
}

function replay() {
  throw PrivateRouteError.ERR_REPLAY()
}

function busy() {
  throw PrivateRouteError.ERR_BUSY()
}

function object(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
    return value
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    invalid()
  }
}

function option(value, name) {
  try {
    return value[name]
  } catch {
    invalid()
  }
}

function fixed(value, size) {
  try {
    return b4a.isBuffer(value) && byteLengthGetter.call(value) === size
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

function copy(value, size = null) {
  const valueLength = length(value)
  if (valueLength < 0 || (size !== null && valueLength !== size)) invalid()
  let output = null
  try {
    output = b4a.allocUnsafeSlow(valueLength)
    setIntrinsic.call(output, value)
    return output
  } catch (err) {
    clear(output)
    if (err instanceof PrivateRouteError) throw err
    invalid()
  }
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
  } catch {}
}

function equal(left, right) {
  try {
    return fixed(left, byteLengthGetter.call(right)) && b4a.equals(left, right)
  } catch {
    return false
  }
}

function uint64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= 0xffff_ffff_ffff_ffffn
}

function uint32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
}

function readUint16(buffer, offset) {
  return (buffer[offset] << 8) | buffer[offset + 1]
}

function readUint64(buffer, offset) {
  let value = 0n
  for (let index = 0; index < 8; index++) value = (value << 8n) | BigInt(buffer[offset + index])
  return value
}

function writeUint16(buffer, value, offset) {
  buffer[offset] = value >>> 8
  buffer[offset + 1] = value
}

function writeUint64(buffer, value, offset) {
  for (let index = offset + 7; index >= offset; index--) {
    buffer[index] = Number(value & 0xffn)
    value >>= 8n
  }
}

function nowValue(now) {
  let current
  try {
    current = now()
  } catch {
    invalid()
  }
  if (!uint64(current)) invalid()
  return current
}

function branchClass(value) {
  if (value !== BRANCH_CLASS.LOOKUP && value !== BRANCH_CLASS.ANNOUNCE) invalid()
  return value
}

function extensionIndex(value) {
  if (value !== 1 && value !== 2) invalid()
  return value
}

function requiredRole(value, index) {
  if (
    (index === 1 && value !== M3_LINK_ROLE.SAFETY_RELAY) ||
    (index === 2 && value !== M3_LINK_ROLE.DHT_EXIT)
  ) {
    invalid()
  }
  return value
}

function compatible(advertisement, material) {
  if (
    (advertisement.capabilityMask & material.requestedCapabilityMask) !==
    material.requestedCapabilityMask
  ) {
    return false
  }
  const role = roleForIdentity(advertisement.relayIdentity)
  if (material.requiredRole === M3_LINK_ROLE.SAFETY_RELAY) {
    return (
      role === ROLE.SAFETY &&
      (advertisement.capabilityMask & RELAY_CAPABILITY.CIRCUIT_RELAY_V1) !== 0
    )
  }
  return (
    role === ROLE.PRIVATE && (advertisement.capabilityMask & RELAY_CAPABILITY.DHT_EXIT_V1) !== 0
  )
}

function compareAdvertisement(left, right, target) {
  for (let index = 0; index < 32; index++) {
    const a = left.currentDhtNodeId[index] ^ target[index]
    const b = right.currentDhtNodeId[index] ^ target[index]
    if (a !== b) return a - b
  }
  const identity = b4a.compare(left.relayIdentity, right.relayIdentity)
  if (identity !== 0) return identity
  return left.epoch < right.epoch ? -1 : left.epoch > right.epoch ? 1 : 0
}

function validateAdvertisementCollection(advertisements, material, current) {
  if (!Array.isArray(advertisements)) invalid()
  const advertisementCount = option(advertisements, 'length')
  if (
    !Number.isInteger(advertisementCount) ||
    advertisementCount < 0 ||
    advertisementCount > material.maximumResults ||
    advertisementCount > MAX_ADVERTISEMENTS
  ) {
    authentication()
  }
  const decoded = []
  let complete = false
  try {
    const identities = new Set()
    const endpoints = new Set()
    let previous = null
    for (let index = 0; index < advertisementCount; index++) {
      const advertisement = decodeRelayCapabilityAdvertisement(option(advertisements, index), {
        now: current
      })
      decoded.push(advertisement)
      const identity = b4a.toString(advertisement.relayIdentity, 'hex')
      const endpoint = b4a.toString(advertisement.reachableEndpoint, 'hex')
      if (
        identities.has(identity) ||
        endpoints.has(endpoint) ||
        !compatible(advertisement, material) ||
        (previous && compareAdvertisement(previous, advertisement, material.randomTarget) >= 0)
      ) {
        authentication()
      }
      identities.add(identity)
      endpoints.add(endpoint)
      previous = advertisement
    }
    complete = true
    return decoded
  } finally {
    if (!complete) for (const advertisement of decoded) clearAdvertisement(advertisement)
  }
}

function clearAdvertisement(value) {
  if (!value) return
  for (const field of [
    'relayIdentity',
    'currentDhtNodeId',
    'reachableEndpoint',
    'routeEncryptionPublicKey',
    'signature'
  ]) {
    clear(value[field])
  }
}

function clearEvidence(value) {
  if (!value) return
  for (const field of [
    'encodedResponse',
    'queryNonce',
    'randomTarget',
    'currentTailIdentity',
    'currentTailAdvertisementDigest',
    'branchId',
    'circuitId'
  ]) {
    clear(value[field])
    value[field] = null
  }
  value.requestedCapabilityMask = 0
  value.maximumResults = 0
  value.branchClass = -1
  value.generation = 0n
  value.extensionIndex = -1
  value.requiredRole = -1
  value.requestDeadline = 0n
  value.tailExpiresAt = 0n
}

function normalizeEvidence(value) {
  value = object(value)
  const result = {}
  let complete = false
  try {
    const extension = extensionIndex(option(value, 'extensionIndex'))
    result.encodedResponse = copy(option(value, 'encodedResponse'))
    result.queryNonce = copy(option(value, 'queryNonce'), 32)
    result.randomTarget = copy(option(value, 'randomTarget'), 32)
    result.requestedCapabilityMask = option(value, 'requestedCapabilityMask')
    result.maximumResults = option(value, 'maximumResults')
    result.currentTailIdentity = copy(option(value, 'currentTailIdentity'), 32)
    result.currentTailAdvertisementDigest = copy(
      option(value, 'currentTailAdvertisementDigest'),
      32
    )
    result.branchClass = branchClass(option(value, 'branchClass'))
    result.branchId = copy(option(value, 'branchId'), 16)
    result.circuitId = copy(option(value, 'circuitId'), 16)
    result.generation = option(value, 'generation')
    result.extensionIndex = extension
    result.requiredRole = requiredRole(option(value, 'requiredRole'), extension)
    result.requestDeadline = option(value, 'requestDeadline')
    result.tailExpiresAt = option(value, 'tailExpiresAt')
    if (
      result.encodedResponse.byteLength < 49 ||
      result.encodedResponse.byteLength > MAX_RESPONSE_BYTES ||
      !uint32(result.requestedCapabilityMask) ||
      result.requestedCapabilityMask === 0 ||
      !Number.isInteger(result.maximumResults) ||
      result.maximumResults < 1 ||
      result.maximumResults > MAX_ADVERTISEMENTS ||
      !uint64(result.generation) ||
      !uint64(result.requestDeadline) ||
      !uint64(result.tailExpiresAt)
    ) {
      invalid()
    }
    complete = true
    return result
  } finally {
    if (!complete) clearEvidence(result)
  }
}

export function publishAuthenticatedDiscoveryEvidence(producer, value) {
  const owner =
    producer !== null && typeof producer === 'object' ? EVIDENCE_PRODUCERS.get(producer) : null
  if (!owner || !owner.active) authentication()
  if (owner.publishing) {
    owner.publishViolated = true
    busy()
  }
  owner.publishing = true
  owner.publishViolated = false
  const lifecycle = owner.lifecycle
  let material = null
  let state = null
  let published = false
  try {
    material = normalizeEvidence(value)
    assertEvidenceOwner(owner, lifecycle)
    const current = nowValue(owner.now)
    assertEvidenceOwner(owner, lifecycle)
    sweepEvidenceOwner(owner, current)
    if (material.requestDeadline <= current) authentication()
    const key = requestKey(material)
    const previous = owner.evidenceRequests.get(key)
    if (previous && previous.deadline !== material.requestDeadline) authentication()
    if (previous && previous.count >= MAX_REQUESTS_PER_INDEX) busy()
    owner.evidenceRequests.set(key, {
      count: previous ? previous.count + 1 : 1,
      deadline: previous ? previous.deadline : material.requestDeadline
    })
    if (owner.evidenceLive >= MAX_LIVE_CANDIDATES || owner.evidence.size >= MAX_CANDIDATE_STATES) {
      busy()
    }
    const capability = Object.freeze({})
    state = {
      capability,
      material,
      owner,
      active: true,
      deadline: material.requestDeadline
    }
    assertEvidenceOwner(owner, lifecycle)
    EVIDENCE.set(capability, state)
    owner.evidence.add(state)
    owner.evidenceLive++
    published = true
    material = null
    return capability
  } finally {
    if (!published) {
      clearEvidence(material)
      if (state) {
        EVIDENCE.delete(state.capability)
        owner.evidence.delete(state)
      }
    }
    owner.publishing = false
  }
}

export function revokeAuthenticatedDiscoveryEvidence(producer, capability) {
  const owner =
    producer !== null && typeof producer === 'object' ? EVIDENCE_PRODUCERS.get(producer) : null
  const state =
    capability !== null && typeof capability === 'object' ? EVIDENCE.get(capability) : null
  if (!owner || !owner.active || !state || state.owner !== owner || !state.active) return false
  if (owner.publishing) {
    owner.publishViolated = true
    busy()
  }
  EVIDENCE.delete(capability)
  owner.evidence.delete(state)
  owner.evidenceLive--
  clearEvidence(state.material)
  state.material = null
  state.active = false
  state.capability = null
  state.owner = null
  state.deadline = 0n
  return true
}

function assertEvidenceOwner(owner, lifecycle) {
  if (!owner.active || lifecycle !== owner.lifecycle) throw PrivateRouteError.ERR_DESTROYED()
  if (owner.publishViolated) {
    owner.directory.destroy()
    invalid()
  }
}

function sweepEvidenceOwner(owner, current) {
  for (const state of owner.evidence) {
    if (state.deadline <= current) {
      EVIDENCE.delete(state.capability)
      if (state.active) {
        clearEvidence(state.material)
        state.material = null
        state.active = false
        owner.evidenceLive--
      }
      owner.evidence.delete(state)
      state.capability = null
      state.owner = null
      state.deadline = 0n
    }
  }
  for (const [key, request] of owner.evidenceRequests) {
    if (request.deadline <= current) owner.evidenceRequests.delete(key)
  }
}

function takeEvidence(capability, owner) {
  const state =
    capability !== null && typeof capability === 'object' ? EVIDENCE.get(capability) : null
  if (!state || state.owner !== owner || !owner.active) authentication()
  if (!state.active) replay()
  const material = state.material
  state.active = false
  state.material = null
  owner.evidenceLive--
  return material
}

export function encodeRelayDiscoverResponse(options = {}) {
  let queryNonce = null
  let responseTimeMs = null
  let advertisements = null
  let body = null
  const ownedAdvertisements = []
  try {
    options = object(options)
    queryNonce = copy(option(options, 'queryNonce'), 32)
    responseTimeMs = option(options, 'responseTimeMs')
    advertisements = option(options, 'advertisements')
    if (!uint64(responseTimeMs) || !Array.isArray(advertisements)) invalid()
    const advertisementCount = option(advertisements, 'length')
    if (
      !Number.isInteger(advertisementCount) ||
      advertisementCount < 0 ||
      advertisementCount > MAX_ADVERTISEMENTS
    ) {
      invalid()
    }
    let bodyLength = 41
    for (let index = 0; index < advertisementCount; index++) {
      const advertisement = option(advertisements, index)
      const advertisementLength = length(advertisement)
      if (advertisementLength < 260 || advertisementLength > 548) invalid()
      ownedAdvertisements.push(copy(advertisement, advertisementLength))
      bodyLength += 2 + advertisementLength
    }
    if (bodyLength + 8 > MAX_RESPONSE_BYTES) invalid()
    body = b4a.allocUnsafeSlow(bodyLength)
    setIntrinsic.call(body, queryNonce, 0)
    writeUint64(body, responseTimeMs, 32)
    body[40] = ownedAdvertisements.length
    let offset = 41
    for (const advertisement of ownedAdvertisements) {
      const advertisementLength = length(advertisement)
      writeUint16(body, advertisementLength, offset)
      setIntrinsic.call(body, advertisement, offset + 2)
      offset += 2 + advertisementLength
    }
    return encodeM3Object({ messageId: M3_MESSAGE_ID.RELAY_DISCOVER_RESPONSE_V1, body })
  } finally {
    clear(queryNonce)
    clear(body)
    for (const advertisement of ownedAdvertisements) clear(advertisement)
  }
}

export function decodeRelayDiscoverResponse(encoded) {
  encoded = copy(encoded)
  let body = null
  const advertisements = []
  let complete = false
  try {
    if (encoded.byteLength < 49 || encoded.byteLength > MAX_RESPONSE_BYTES) invalid()
    const object = decodeM3Object(encoded)
    body = object.body
    if (
      object.messageId !== M3_MESSAGE_ID.RELAY_DISCOVER_RESPONSE_V1 ||
      length(object.authSuffix) !== 0 ||
      body.byteLength < 41 ||
      body[40] > MAX_ADVERTISEMENTS
    ) {
      invalid()
    }
    let offset = 41
    for (let index = 0; index < body[40]; index++) {
      if (offset + 2 > body.byteLength) invalid()
      const advertisementLength = readUint16(body, offset)
      if (
        advertisementLength < 260 ||
        advertisementLength > 548 ||
        offset + 2 + advertisementLength > body.byteLength
      ) {
        invalid()
      }
      advertisements.push(copy(subarray(body, offset + 2, offset + 2 + advertisementLength)))
      offset += 2 + advertisementLength
    }
    if (offset !== body.byteLength) invalid()
    const result = Object.freeze({
      queryNonce: copy(subarray(body, 0, 32), 32),
      responseTimeMs: readUint64(body, 32),
      advertisements: Object.freeze(advertisements)
    })
    complete = true
    return result
  } finally {
    clear(encoded)
    clear(body)
    if (!complete) for (const advertisement of advertisements) clear(advertisement)
  }
}

function requestKey(value) {
  const input = b4a.allocUnsafeSlow(42)
  let digest = null
  try {
    input[0] = value.branchClass
    setIntrinsic.call(input, value.branchId, 1)
    setIntrinsic.call(input, value.circuitId, 17)
    writeUint64(input, value.generation, 33)
    input[41] = value.extensionIndex
    digest = cryptoSuite.hash([REQUEST_KEY_DOMAIN, input])
    return b4a.toString(digest, 'hex')
  } finally {
    clear(input)
    clear(digest)
  }
}

function copyCandidate(state) {
  const result = {}
  let complete = false
  try {
    result.advertisement = copy(state.advertisement)
    result.advertisementDigest = copy(state.advertisementDigest, 32)
    result.relayIdentity = copy(state.relayIdentity, 32)
    result.reachableEndpoint = copy(state.reachableEndpoint, 19)
    result.routeEncryptionPublicKey = copy(state.routeEncryptionPublicKey, 32)
    result.currentTailIdentity = copy(state.currentTailIdentity, 32)
    result.currentTailAdvertisementDigest = copy(state.currentTailAdvertisementDigest, 32)
    result.branchClass = state.branchClass
    result.branchId = copy(state.branchId, 16)
    result.circuitId = copy(state.circuitId, 16)
    result.generation = state.generation
    result.extensionIndex = state.extensionIndex
    result.requiredRole = state.requiredRole
    result.epoch = state.epoch
    result.deadline = state.deadline
    complete = true
    return Object.freeze(result)
  } finally {
    if (!complete) clearCandidate(result)
  }
}

function clearCandidate(state) {
  if (!state) return
  for (const field of [
    'advertisement',
    'advertisementDigest',
    'relayIdentity',
    'reachableEndpoint',
    'routeEncryptionPublicKey',
    'currentTailIdentity',
    'currentTailAdvertisementDigest',
    'branchId',
    'circuitId'
  ]) {
    clear(state[field])
    state[field] = null
  }
  state.live = false
  state.branchClass = -1
  state.generation = 0n
  state.extensionIndex = -1
  state.requiredRole = -1
  state.epoch = 0n
  state.candidateDeadline = 0n
  state.deadline = 0n
}

function createCandidateState(material, response, advertisement, index, current, deadline) {
  const state = {
    live: true,
    tombstoneDeadline: material.requestDeadline,
    candidateDeadline: deadline,
    branchClass: material.branchClass,
    generation: material.generation,
    extensionIndex: material.extensionIndex,
    requiredRole: material.requiredRole,
    epoch: advertisement.epoch,
    deadline
  }
  let complete = false
  try {
    state.advertisement = copy(response.advertisements[index])
    state.advertisementDigest = digestRelayCapabilityAdvertisement(response.advertisements[index], {
      now: current
    })
    state.relayIdentity = copy(advertisement.relayIdentity, 32)
    state.reachableEndpoint = copy(advertisement.reachableEndpoint, 19)
    state.routeEncryptionPublicKey = copy(advertisement.routeEncryptionPublicKey, 32)
    state.currentTailIdentity = copy(material.currentTailIdentity, 32)
    state.currentTailAdvertisementDigest = copy(material.currentTailAdvertisementDigest, 32)
    state.branchId = copy(material.branchId, 16)
    state.circuitId = copy(material.circuitId, 16)
    complete = true
    return state
  } finally {
    if (!complete) clearCandidate(state)
  }
}

class RoutedCandidateDirectory {
  #owner
  #now
  #candidates
  #states
  #requests
  #live
  #destroyed
  #mutating
  #violated
  #lifecycle

  constructor(owner, options = {}) {
    options = object(options)
    const now = option(options, 'now')
    if (typeof now !== 'function') invalid()
    this.#owner = owner
    this.#now = now
    owner.now = now
    this.#candidates = new WeakMap()
    this.#states = new Set()
    this.#requests = new Map()
    this.#live = 0
    this.#destroyed = false
    this.#mutating = false
    this.#violated = false
    this.#lifecycle = Object.freeze({})
    ROUTED_CANDIDATE_DIRECTORIES.add(this)
  }

  admit(capability) {
    const operation = this.#begin()
    const current = operation.current
    let material = null
    let response = null
    let decoded = []
    const candidates = []
    let inserted = false
    try {
      material = takeEvidence(capability, this.#owner)
      const key = requestKey(material)
      const request = this.#requests.get(key)
      if (
        request &&
        (request.deadline !== material.requestDeadline || request.count >= MAX_REQUESTS_PER_INDEX)
      ) {
        if (request.deadline !== material.requestDeadline) authentication()
        busy()
      }
      this.#requests.set(key, {
        count: request ? request.count + 1 : 1,
        deadline: request ? request.deadline : material.requestDeadline
      })
      if (current >= material.requestDeadline || current >= material.tailExpiresAt) authentication()
      response = decodeRelayDiscoverResponse(material.encodedResponse)
      if (
        !equal(response.queryNonce, material.queryNonce) ||
        response.responseTimeMs > current ||
        response.advertisements.length > material.maximumResults ||
        this.#live + response.advertisements.length > MAX_LIVE_CANDIDATES ||
        this.#states.size + response.advertisements.length > MAX_CANDIDATE_STATES
      ) {
        if (
          this.#live + response.advertisements.length > MAX_LIVE_CANDIDATES ||
          this.#states.size + response.advertisements.length > MAX_CANDIDATE_STATES
        ) {
          busy()
        }
        authentication()
      }
      decoded = validateAdvertisementCollection(response.advertisements, material, current)
      for (let index = 0; index < decoded.length; index++) {
        const advertisement = decoded[index]
        const deadline = [
          material.requestDeadline,
          material.tailExpiresAt,
          advertisement.expiresAtMs
        ].reduce((minimum, value) => (value < minimum ? value : minimum))
        if (deadline <= current) authentication()
        const state = createCandidateState(
          material,
          response,
          advertisement,
          index,
          current,
          deadline
        )
        const candidate = Object.freeze({})
        state.candidate = candidate
        this.#candidates.set(candidate, state)
        this.#states.add(state)
        this.#live++
        candidates.push(candidate)
      }
      inserted = true
      this.#assert(operation.lifecycle)
      return Object.freeze(candidates)
    } finally {
      if (!inserted) {
        for (const candidate of candidates) {
          const state = this.#candidates.get(candidate)
          if (state) {
            this.#candidates.delete(candidate)
            this.#states.delete(state)
            if (state.live) this.#live--
            clearCandidate(state)
            state.candidate = null
          }
        }
      }
      clearEvidence(material)
      if (response) {
        clear(response.queryNonce)
        for (const advertisement of response.advertisements) clear(advertisement)
      }
      for (const advertisement of decoded) clearAdvertisement(advertisement)
      this.#end()
    }
  }

  read(candidate) {
    const operation = this.#begin()
    try {
      const state = this.#candidate(candidate)
      const result = copyCandidate(state)
      this.#assert(operation.lifecycle)
      return result
    } finally {
      this.#end()
    }
  }

  consume(candidate) {
    const operation = this.#begin()
    try {
      const state = this.#candidate(candidate)
      const result = copyCandidate(state)
      this.#assert(operation.lifecycle)
      state.live = false
      this.#live--
      clearCandidate(state)
      return result
    } finally {
      this.#end()
    }
  }

  diagnostics() {
    if (this.#destroyed)
      return Object.freeze({ state: 'DESTROYED', live: 0, states: 0, requests: 0 })
    const operation = this.#begin()
    try {
      return Object.freeze({
        state: 'ACTIVE',
        live: this.#live,
        states: this.#states.size,
        requests: this.#requests.size
      })
    } finally {
      this.#end()
    }
  }

  destroy() {
    if (this.#destroyed) return false
    this.#destroyed = true
    this.#lifecycle = Object.freeze({})
    this.#owner.active = false
    this.#owner.lifecycle = Object.freeze({})
    EVIDENCE_PRODUCERS.delete(this.#owner.producer)
    for (const evidence of this.#owner.evidence) {
      EVIDENCE.delete(evidence.capability)
      clearEvidence(evidence.material)
      evidence.material = null
      evidence.active = false
      evidence.capability = null
      evidence.owner = null
      evidence.deadline = 0n
    }
    this.#owner.evidence.clear()
    this.#owner.evidenceRequests.clear()
    this.#owner.evidenceLive = 0
    this.#owner.now = null
    for (const state of this.#states) {
      clearCandidate(state)
      if (state.candidate) this.#candidates.delete(state.candidate)
      state.candidate = null
    }
    this.#states.clear()
    this.#requests.clear()
    this.#live = 0
    this.#now = null
    this.#owner = null
    ROUTED_CANDIDATE_DIRECTORIES.delete(this)
    return true
  }

  #candidate(candidate) {
    const state =
      candidate !== null && typeof candidate === 'object' ? this.#candidates.get(candidate) : null
    if (!state || !state.live) replay()
    return state
  }

  #begin() {
    if (this.#destroyed) throw PrivateRouteError.ERR_DESTROYED()
    if (this.#mutating) {
      this.#violated = true
      busy()
    }
    this.#mutating = true
    this.#violated = false
    const lifecycle = this.#lifecycle
    try {
      const current = nowValue(this.#now)
      this.#assert(lifecycle)
      sweepEvidenceOwner(this.#owner, current)
      this.#sweep(current)
      return { current, lifecycle }
    } catch (err) {
      this.#mutating = false
      throw err
    }
  }

  #assert(lifecycle) {
    if (this.#destroyed || lifecycle !== this.#lifecycle) {
      throw PrivateRouteError.ERR_DESTROYED()
    }
    if (this.#violated) {
      this.destroy()
      invalid()
    }
  }

  #end() {
    this.#mutating = false
  }

  #sweep(current) {
    for (const state of this.#states) {
      if (state.live && state.deadline <= current) {
        this.#live--
        clearCandidate(state)
      }
      if (state.tombstoneDeadline <= current) {
        if (state.live) this.#live--
        clearCandidate(state)
        if (state.candidate) this.#candidates.delete(state.candidate)
        state.candidate = null
        this.#states.delete(state)
      }
    }
    for (const [key, request] of this.#requests) {
      if (request.deadline <= current) this.#requests.delete(key)
    }
  }
}

// Deep production check used by the manager-owned BranchPathAuthority. It
// prevents a caller-supplied object with read()/consume() methods from minting
// path-extension authority.
export function isRoutedCandidateDirectory(value) {
  return value !== null && typeof value === 'object' && ROUTED_CANDIDATE_DIRECTORIES.has(value)
}

export function createRoutedCandidateAuthority(options) {
  const owner = {
    active: true,
    directory: null,
    evidence: new Set(),
    evidenceLive: 0,
    evidenceRequests: new Map(),
    lifecycle: Object.freeze({}),
    now: null,
    producer: null,
    publishing: false,
    publishViolated: false
  }
  const evidenceProducer = Object.freeze({})
  owner.producer = evidenceProducer
  EVIDENCE_PRODUCERS.set(evidenceProducer, owner)
  let directory = null
  try {
    directory = new RoutedCandidateDirectory(owner, options)
    owner.directory = directory
    return Object.freeze({ directory, evidenceProducer })
  } catch (err) {
    owner.active = false
    EVIDENCE_PRODUCERS.delete(evidenceProducer)
    throw err
  }
}

function admissionKey(value, digest) {
  const input = b4a.allocUnsafeSlow(179)
  let commitment = null
  try {
    setIntrinsic.call(input, value.queryNonce, 0)
    input[32] = value.branchClass
    setIntrinsic.call(input, value.branchId, 33)
    setIntrinsic.call(input, value.circuitId, 49)
    writeUint64(input, value.generation, 65)
    input[73] = value.extensionIndex
    input[74] = value.requiredRole
    setIntrinsic.call(input, value.currentTailIdentity, 75)
    setIntrinsic.call(input, value.currentTailAdvertisementDigest, 107)
    setIntrinsic.call(input, digest, 139)
    writeUint64(input, value.requestDeadline, 171)
    commitment = cryptoSuite.hash([ADMISSION_KEY_DOMAIN, input])
    return b4a.toString(commitment, 'hex')
  } finally {
    clear(input)
    clear(commitment)
  }
}

function normalizeAdmissionRequest(value) {
  value = object(value)
  const result = {}
  let complete = false
  try {
    const index = extensionIndex(option(value, 'extensionIndex'))
    result.queryNonce = copy(option(value, 'queryNonce'), 32)
    result.branchClass = branchClass(option(value, 'branchClass'))
    result.branchId = copy(option(value, 'branchId'), 16)
    result.circuitId = copy(option(value, 'circuitId'), 16)
    result.generation = option(value, 'generation')
    result.extensionIndex = index
    result.requiredRole = requiredRole(option(value, 'requiredRole'), index)
    result.currentTailIdentity = copy(option(value, 'currentTailIdentity'), 32)
    result.currentTailAdvertisementDigest = copy(
      option(value, 'currentTailAdvertisementDigest'),
      32
    )
    result.requestDeadline = option(value, 'requestDeadline')
    if (!uint64(result.generation) || !uint64(result.requestDeadline)) invalid()
    complete = true
    return result
  } finally {
    if (!complete) clearAdmissionRequest(result)
  }
}

function clearAdmissionRequest(value) {
  if (!value) return
  for (const field of [
    'queryNonce',
    'branchId',
    'circuitId',
    'currentTailIdentity',
    'currentTailAdvertisementDigest'
  ]) {
    clear(value[field])
  }
  value.branchClass = -1
  value.generation = 0n
  value.extensionIndex = -1
  value.requiredRole = -1
  value.requestDeadline = 0n
}

const TAIL_ADMISSION_PRODUCERS = new WeakMap()
const TAIL_ADMISSION_CONSUMERS = new WeakMap()
const TAIL_CANDIDATE_ADMISSIONS = new WeakMap()

function sweepTailAdmissions(owner, current) {
  for (const [key, state] of owner.states) {
    if (state.deadline <= current) {
      TAIL_CANDIDATE_ADMISSIONS.delete(state.admission)
      terminalizeTailReservation(state.reservation)
      if (!state.consumed) owner.live--
      owner.states.delete(key)
    }
  }
  for (const [key, request] of owner.requests) {
    if (request.deadline <= current) owner.requests.delete(key)
  }
}

function assertTailAuthority(owner, lifecycle) {
  if (owner.destroyed || lifecycle !== owner.lifecycle) {
    throw PrivateRouteError.ERR_DESTROYED()
  }
  if (owner.violated) {
    destroyTailAuthority(owner)
    invalid()
  }
}

function beginTailAuthority(owner) {
  if (!owner || owner.destroyed) throw PrivateRouteError.ERR_DESTROYED()
  if (owner.mutating) {
    owner.violated = true
    busy()
  }
  owner.mutating = true
  owner.violated = false
  const lifecycle = owner.lifecycle
  try {
    const current = nowValue(owner.now)
    assertTailAuthority(owner, lifecycle)
    sweepTailAdmissions(owner, current)
    return { current, lifecycle }
  } catch (err) {
    owner.mutating = false
    throw err
  }
}

function endTailAuthority(owner) {
  if (owner) owner.mutating = false
}

function destroyTailAuthority(owner) {
  if (!owner || owner.destroyed) return false
  owner.destroyed = true
  owner.lifecycle = Object.freeze({})
  for (const reservation of owner.reservations) terminalizeTailReservation(reservation)
  for (const state of owner.states.values()) {
    TAIL_CANDIDATE_ADMISSIONS.delete(state.admission)
    state.admission = null
  }
  owner.states.clear()
  owner.requests.clear()
  owner.live = 0
  owner.now = null
  TAIL_ADMISSION_PRODUCERS.delete(owner.producer)
  TAIL_ADMISSION_CONSUMERS.delete(owner.consumer)
  return true
}

export function createCurrentTailCandidateAdmissionAuthority(options = {}) {
  options = object(options)
  const now = option(options, 'now')
  if (typeof now !== 'function') invalid()
  const producer = Object.freeze({})
  const consumer = Object.freeze({})
  const owner = {
    producer,
    consumer,
    now,
    states: new Map(),
    requests: new Map(),
    reservations: new Set(),
    live: 0,
    destroyed: false,
    mutating: false,
    violated: false,
    lifecycle: Object.freeze({})
  }
  TAIL_ADMISSION_PRODUCERS.set(producer, owner)
  TAIL_ADMISSION_CONSUMERS.set(consumer, owner)
  return Object.freeze({
    producer,
    consumer,
    diagnostics() {
      if (owner.destroyed) {
        return Object.freeze({ state: 'DESTROYED', live: 0, states: 0, requests: 0 })
      }
      const operation = beginTailAuthority(owner)
      try {
        assertTailAuthority(owner, operation.lifecycle)
        return Object.freeze({
          state: 'ACTIVE',
          live: owner.live,
          states: owner.states.size,
          requests: owner.requests.size
        })
      } finally {
        endTailAuthority(owner)
      }
    },
    destroy() {
      return destroyTailAuthority(owner)
    }
  })
}

export function isCurrentTailCandidateAdmissionPair(producer, consumer) {
  const producerOwner =
    producer !== null && typeof producer === 'object'
      ? TAIL_ADMISSION_PRODUCERS.get(producer)
      : null
  const consumerOwner =
    consumer !== null && typeof consumer === 'object'
      ? TAIL_ADMISSION_CONSUMERS.get(consumer)
      : null
  return !!producerOwner && producerOwner === consumerOwner && !producerOwner.destroyed
}

export function reserveCurrentTailCandidateResponse(producer, value) {
  const owner =
    producer !== null && typeof producer === 'object'
      ? TAIL_ADMISSION_PRODUCERS.get(producer)
      : null
  const operation = beginTailAuthority(owner)
  let request = null
  const inserted = []
  let requestKeyValue = null
  let previousRequest = null
  let randomTarget = null
  let decoded = null
  const ownedAdvertisements = []
  try {
    request = normalizeAdmissionRequest(value)
    assertTailAuthority(owner, operation.lifecycle)
    const advertisements = option(object(value), 'advertisements')
    randomTarget = copy(option(value, 'randomTarget'), 32)
    const requestedCapabilityMask = option(value, 'requestedCapabilityMask')
    const maximumResults = option(value, 'maximumResults')
    assertTailAuthority(owner, operation.lifecycle)
    if (!Array.isArray(advertisements)) invalid()
    const sourceAdvertisementCount = option(advertisements, 'length')
    assertTailAuthority(owner, operation.lifecycle)
    if (
      request.requestDeadline <= operation.current ||
      !uint32(requestedCapabilityMask) ||
      requestedCapabilityMask === 0 ||
      !Number.isInteger(maximumResults) ||
      maximumResults < 1 ||
      maximumResults > MAX_ADVERTISEMENTS ||
      !Number.isInteger(sourceAdvertisementCount) ||
      sourceAdvertisementCount < 0 ||
      sourceAdvertisementCount > MAX_ADVERTISEMENTS
    ) {
      invalid()
    }
    for (let index = 0; index < sourceAdvertisementCount; index++) {
      let encoded = null
      try {
        encoded = copy(option(advertisements, index))
        assertTailAuthority(owner, operation.lifecycle)
        ownedAdvertisements.push(encoded)
        encoded = null
      } finally {
        clear(encoded)
      }
    }
    decoded = validateAdvertisementCollection(
      ownedAdvertisements,
      {
        randomTarget,
        requestedCapabilityMask,
        maximumResults,
        requiredRole: request.requiredRole
      },
      operation.current
    )
    assertTailAuthority(owner, operation.lifecycle)
    const advertisementCount = ownedAdvertisements.length
    requestKeyValue = requestKey(request)
    previousRequest = owner.requests.get(requestKeyValue) || null
    if (previousRequest && previousRequest.deadline !== request.requestDeadline) authentication()
    if (previousRequest && previousRequest.count >= MAX_REQUESTS_PER_INDEX) busy()
    owner.requests.set(requestKeyValue, {
      count: previousRequest ? previousRequest.count + 1 : 1,
      deadline: previousRequest ? previousRequest.deadline : request.requestDeadline
    })
    if (
      owner.live + advertisementCount > MAX_LIVE_CANDIDATES ||
      owner.states.size + advertisementCount > MAX_CANDIDATE_STATES
    ) {
      busy()
    }
    for (let index = 0; index < advertisementCount; index++) {
      const encoded = ownedAdvertisements[index]
      let digest = null
      try {
        assertTailAuthority(owner, operation.lifecycle)
        digest = digestRelayCapabilityAdvertisement(encoded, { now: operation.current })
        const key = admissionKey(request, digest)
        if (owner.states.has(key)) replay()
        owner.states.set(key, {
          admission: Object.freeze({}),
          consumed: false,
          deadline: request.requestDeadline,
          key,
          published: false,
          reservation: null
        })
        owner.live++
        inserted.push(key)
      } finally {
        clear(digest)
      }
    }
    assertTailAuthority(owner, operation.lifecycle)
    const reservation = Object.freeze({})
    const reservationState = {
      reservation,
      owner,
      keys: inserted.slice(),
      active: true
    }
    TAIL_RESPONSE_RESERVATIONS.set(reservation, reservationState)
    owner.reservations.add(reservationState)
    for (const key of inserted) owner.states.get(key).reservation = reservationState
    return reservation
  } catch (err) {
    for (const key of inserted) {
      const state = owner && owner.states.get(key)
      if (state) TAIL_CANDIDATE_ADMISSIONS.delete(state.admission)
      if (state && !state.consumed) owner.live--
      if (owner) owner.states.delete(key)
    }
    throw err
  } finally {
    clearAdmissionRequest(request)
    clear(randomTarget)
    for (const advertisement of ownedAdvertisements) clear(advertisement)
    if (decoded) for (const advertisement of decoded) clearAdvertisement(advertisement)
    endTailAuthority(owner)
  }
}

function terminalizeTailReservation(state) {
  if (!state || !state.active) return false
  const owner = state.owner
  TAIL_RESPONSE_RESERVATIONS.delete(state.reservation)
  if (owner) owner.reservations.delete(state)
  state.active = false
  state.owner = null
  state.reservation = null
  state.keys.length = 0
  return true
}

export function commitCurrentTailCandidateResponse(producer, reservation) {
  const owner =
    producer !== null && typeof producer === 'object'
      ? TAIL_ADMISSION_PRODUCERS.get(producer)
      : null
  const state =
    reservation !== null && typeof reservation === 'object'
      ? TAIL_RESPONSE_RESERVATIONS.get(reservation)
      : null
  if (!owner || owner.destroyed || !state || !state.active || state.owner !== owner) return false
  if (owner.mutating) {
    owner.violated = true
    busy()
  }
  const admissions = []
  for (const key of state.keys) {
    const admission = owner.states.get(key)
    if (admission && admission.reservation === state) {
      admission.reservation = null
      admission.published = true
      TAIL_CANDIDATE_ADMISSIONS.set(admission.admission, { owner, state: admission })
      admissions.push(admission.admission)
    }
  }
  terminalizeTailReservation(state)
  return Object.freeze(admissions)
}

export function rollbackCurrentTailCandidateResponse(producer, reservation) {
  const owner =
    producer !== null && typeof producer === 'object'
      ? TAIL_ADMISSION_PRODUCERS.get(producer)
      : null
  const state =
    reservation !== null && typeof reservation === 'object'
      ? TAIL_RESPONSE_RESERVATIONS.get(reservation)
      : null
  if (!owner || owner.destroyed || !state || !state.active || state.owner !== owner) return false
  if (owner.mutating) {
    owner.violated = true
    busy()
  }
  owner.mutating = true
  const lifecycle = owner.lifecycle
  try {
    assertTailAuthority(owner, lifecycle)
    for (const key of state.keys) {
      const admission = owner.states.get(key)
      if (!admission || admission.consumed) {
        terminalizeTailReservation(state)
        return false
      }
    }
    for (const key of state.keys) {
      const admission = owner.states.get(key)
      if (admission) TAIL_CANDIDATE_ADMISSIONS.delete(admission.admission)
      owner.states.delete(key)
      owner.live--
    }
    return terminalizeTailReservation(state)
  } finally {
    owner.mutating = false
  }
}

export function consumeCurrentTailCandidateAdmission(consumer, value) {
  const owner =
    consumer !== null && typeof consumer === 'object'
      ? TAIL_ADMISSION_CONSUMERS.get(consumer)
      : null
  const operation = beginTailAuthority(owner)
  let request = null
  let digest = null
  try {
    request = normalizeAdmissionRequest(value)
    digest = copy(option(object(value), 'candidateAdvertisementDigest'), 32)
    assertTailAuthority(owner, operation.lifecycle)
    if (request.requestDeadline <= operation.current) authentication()
    const state = owner.states.get(admissionKey(request, digest))
    if (!state) authentication()
    if (state.deadline !== request.requestDeadline) authentication()
    if (!state.published || state.reservation) authentication()
    if (state.consumed) replay()
    state.consumed = true
    owner.live--
    return true
  } finally {
    clearAdmissionRequest(request)
    clear(digest)
    endTailAuthority(owner)
  }
}

export function consumeCurrentTailCandidateAdmissionHandle(consumer, admission) {
  const owner =
    consumer !== null && typeof consumer === 'object'
      ? TAIL_ADMISSION_CONSUMERS.get(consumer)
      : null
  const operation = beginTailAuthority(owner)
  try {
    const binding =
      admission !== null && typeof admission === 'object'
        ? TAIL_CANDIDATE_ADMISSIONS.get(admission)
        : null
    if (!binding || binding.owner !== owner || !binding.state.published) authentication()
    const state = binding.state
    if (state.deadline <= operation.current) authentication()
    if (state.consumed) replay()
    state.consumed = true
    owner.live--
    return true
  } finally {
    endTailAuthority(owner)
  }
}

export function revokeCurrentTailCandidateAdmissionHandle(consumer, admission) {
  const owner =
    consumer !== null && typeof consumer === 'object'
      ? TAIL_ADMISSION_CONSUMERS.get(consumer)
      : null
  const binding =
    admission !== null && typeof admission === 'object'
      ? TAIL_CANDIDATE_ADMISSIONS.get(admission)
      : null
  if (!owner || owner.destroyed || !binding || binding.owner !== owner) return false
  if (owner.mutating) {
    owner.violated = true
    busy()
  }
  const state = binding.state
  if (owner.states.get(state.key) !== state) return false
  if (state.consumed) return false
  TAIL_CANDIDATE_ADMISSIONS.delete(admission)
  owner.states.delete(state.key)
  if (!state.consumed) owner.live--
  state.admission = null
  state.published = false
  return true
}
