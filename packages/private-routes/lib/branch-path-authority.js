import b4a from 'b4a'

import { takeBranchPathPairBinding } from './branch-construction-authority.js'
import { PrivateRouteError } from './errors.js'
import { BRANCH_CLASS, M3_LINK_ROLE, ROLE, roleForIdentity } from './protocol.js'
import { isRoutedCandidateDirectory } from './routed-candidate.js'

const STATES = new WeakMap()
const AUTHORIZATIONS = new WeakMap()
const RESERVATIONS = new WeakMap()
const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const fillIntrinsic = Uint8Array.prototype.fill
const setIntrinsic = Uint8Array.prototype.set

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

function safeObject(value) {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

function option(value, name) {
  try {
    return value[name]
  } catch {
    invalid()
  }
}

function exactKeys(value, expected) {
  try {
    const keys = Reflect.ownKeys(value)
    return (
      keys.length === expected.length &&
      keys.every((key) => typeof key === 'string' && expected.includes(key))
    )
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
  let result = null
  try {
    result = b4a.allocUnsafeSlow(valueLength)
    if (length(result) !== valueLength) invalid()
    setIntrinsic.call(result, value)
    return result
  } catch (err) {
    clear(result)
    if (err instanceof PrivateRouteError) throw err
    invalid()
  }
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) fillIntrinsic.call(value, 0)
  } catch {}
}

function same(left, right) {
  try {
    return length(left) === length(right) && b4a.equals(left, right)
  } catch {
    return false
  }
}

function uint64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= 0xffff_ffff_ffff_ffffn
}

function nonzero(value) {
  const valueLength = length(value)
  if (valueLength < 0) return false
  for (let index = 0; index < valueLength; index++) if (value[index] !== 0) return true
  return false
}

function canonicalEndpoint(value) {
  if (length(value) !== 19 || (value[0] !== 4 && value[0] !== 6)) return false
  if (value[17] === 0 && value[18] === 0) return false
  if (value[0] === 4) {
    for (let index = 1; index < 13; index++) if (value[index] !== 0) return false
  } else {
    let mapped = true
    for (let index = 1; index < 11; index++) if (value[index] !== 0) mapped = false
    if (mapped && value[11] === 0xff && value[12] === 0xff) return false
  }
  return true
}

function current(owner) {
  let value
  try {
    value = owner.now()
  } catch {
    invalid()
  }
  if (!uint64(value)) invalid()
  return value
}

function copyGuard(value) {
  if (!safeObject(value) || !exactKeys(value, ['relayIdentity', 'reachableEndpoint'])) invalid()
  const result = {}
  let complete = false
  try {
    result.relayIdentity = copy(option(value, 'relayIdentity'), 32)
    result.reachableEndpoint = copy(option(value, 'reachableEndpoint'), 19)
    if (
      !nonzero(result.relayIdentity) ||
      roleForIdentity(result.relayIdentity) !== ROLE.SAFETY ||
      !canonicalEndpoint(result.reachableEndpoint)
    ) {
      invalid()
    }
    complete = true
    return result
  } finally {
    if (!complete) clearNode(result)
  }
}

function copyBranch(value, expectedClass, guard) {
  if (
    !safeObject(value) ||
    !exactKeys(value, [
      'branchClass',
      'branchId',
      'circuitId',
      'generation',
      'currentTailAdvertisementDigest',
      'deadline',
      'linkBinding'
    ])
  ) {
    invalid()
  }
  const result = { index: 0, reservation: null }
  let complete = false
  try {
    result.branchClass = option(value, 'branchClass')
    if (result.branchClass !== expectedClass) invalid()
    result.branchId = copy(option(value, 'branchId'), 16)
    result.circuitId = copy(option(value, 'circuitId'), 16)
    result.generation = option(value, 'generation')
    result.currentTailIdentity = copy(guard.relayIdentity, 32)
    result.currentTailAdvertisementDigest = copy(
      option(value, 'currentTailAdvertisementDigest'),
      32
    )
    result.deadline = option(value, 'deadline')
    result.linkBinding = option(value, 'linkBinding')
    if (
      !uint64(result.generation) ||
      result.generation === 0n ||
      !uint64(result.deadline) ||
      result.deadline === 0n ||
      !nonzero(result.branchId) ||
      !nonzero(result.circuitId) ||
      same(result.branchId, result.circuitId) ||
      !safeObject(result.linkBinding) ||
      !Object.isFrozen(result.linkBinding) ||
      Reflect.ownKeys(result.linkBinding).length !== 0
    ) {
      invalid()
    }
    complete = true
    return result
  } finally {
    if (!complete) clearBranch(result)
  }
}

function clearNode(node) {
  if (!node) return
  clear(node.relayIdentity)
  clear(node.reachableEndpoint)
  node.relayIdentity = null
  node.reachableEndpoint = null
}

function clearBranch(branch) {
  if (!branch) return
  clear(branch.branchId)
  clear(branch.circuitId)
  clear(branch.currentTailIdentity)
  clear(branch.currentTailAdvertisementDigest)
  branch.branchId = null
  branch.circuitId = null
  branch.currentTailIdentity = null
  branch.currentTailAdvertisementDigest = null
  branch.reservation = null
  branch.linkBinding = null
  branch.generation = 0n
  branch.deadline = 0n
  branch.index = -1
}

function clearPathBranchMaterial(branch) {
  if (!branch) return
  clear(branch.branchId)
  clear(branch.circuitId)
  clear(branch.currentTailAdvertisementDigest)
  branch.branchId = null
  branch.circuitId = null
  branch.currentTailAdvertisementDigest = null
  branch.linkBinding = null
}

function clearProjection(value) {
  if (!value) return
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
    clear(value[field])
    try {
      value[field] = null
    } catch {}
  }
}

function clearAuthorization(state) {
  if (!state) return
  clearProjection(state)
  state.authorization = null
  state.reservation = null
  state.branch = null
  state.pairBinding = null
  state.branchLinkBinding = null
  state.owner = null
  state.deadline = 0n
  state.extensionIndex = -1
}

function projectionsEqual(left, right) {
  return (
    left.branchClass === right.branchClass &&
    left.generation === right.generation &&
    left.extensionIndex === right.extensionIndex &&
    left.requiredRole === right.requiredRole &&
    left.epoch === right.epoch &&
    left.deadline === right.deadline &&
    same(left.advertisement, right.advertisement) &&
    same(left.advertisementDigest, right.advertisementDigest) &&
    same(left.relayIdentity, right.relayIdentity) &&
    same(left.reachableEndpoint, right.reachableEndpoint) &&
    same(left.routeEncryptionPublicKey, right.routeEncryptionPublicKey) &&
    same(left.currentTailIdentity, right.currentTailIdentity) &&
    same(left.currentTailAdvertisementDigest, right.currentTailAdvertisementDigest) &&
    same(left.branchId, right.branchId) &&
    same(left.circuitId, right.circuitId)
  )
}

function expectedRole(index) {
  return index === 1 ? M3_LINK_ROLE.SAFETY_RELAY : M3_LINK_ROLE.DHT_EXIT
}

function validateCandidate(owner, branch, candidate, now) {
  if (
    candidate.branchClass !== branch.branchClass ||
    candidate.generation !== branch.generation ||
    candidate.extensionIndex !== branch.index + 1 ||
    candidate.extensionIndex < 1 ||
    candidate.extensionIndex > 2 ||
    candidate.requiredRole !== expectedRole(candidate.extensionIndex) ||
    !same(candidate.branchId, branch.branchId) ||
    !same(candidate.circuitId, branch.circuitId) ||
    !same(candidate.currentTailIdentity, branch.currentTailIdentity) ||
    !same(candidate.currentTailAdvertisementDigest, branch.currentTailAdvertisementDigest) ||
    !uint64(candidate.deadline)
  ) {
    authentication()
  }
  const deadline = candidate.deadline < branch.deadline ? candidate.deadline : branch.deadline
  if (deadline <= now) authentication()
  for (const node of owner.nodes) {
    if (
      same(candidate.relayIdentity, node.relayIdentity) ||
      same(candidate.reachableEndpoint, node.reachableEndpoint)
    ) {
      authentication()
    }
  }
  for (const state of owner.authorizations) {
    if (
      state.status === 'LIVE' &&
      (same(candidate.relayIdentity, state.relayIdentity) ||
        same(candidate.reachableEndpoint, state.reachableEndpoint))
    ) {
      authentication()
    }
  }
  return deadline
}

function ownedAuthorization(owner, branch, projection, deadline) {
  const state = {
    owner,
    branch,
    status: 'LIVE',
    consumed: false,
    deadline,
    branchClass: projection.branchClass,
    generation: projection.generation,
    extensionIndex: projection.extensionIndex,
    requiredRole: projection.requiredRole,
    epoch: projection.epoch
  }
  let complete = false
  try {
    state.advertisement = copy(projection.advertisement)
    state.advertisementDigest = copy(projection.advertisementDigest, 32)
    state.relayIdentity = copy(projection.relayIdentity, 32)
    state.reachableEndpoint = copy(projection.reachableEndpoint, 19)
    state.routeEncryptionPublicKey = copy(projection.routeEncryptionPublicKey, 32)
    state.currentTailIdentity = copy(projection.currentTailIdentity, 32)
    state.currentTailAdvertisementDigest = copy(projection.currentTailAdvertisementDigest, 32)
    state.branchId = copy(projection.branchId, 16)
    state.circuitId = copy(projection.circuitId, 16)
    state.authorization = Object.freeze({})
    state.reservation = Object.freeze({})
    state.pairBinding = owner.pairBinding
    state.branchLinkBinding = branch.linkBinding
    complete = true
    return state
  } finally {
    if (!complete) clearAuthorization(state)
  }
}

function liveOwner(authority) {
  const owner = safeObject(authority) ? STATES.get(authority) : null
  if (!owner || owner.destroyed) throw PrivateRouteError.ERR_DESTROYED()
  return owner
}

function begin(owner) {
  if (owner.mutating) {
    owner.violated = true
    busy()
  }
  owner.mutating = true
  owner.violated = false
  const lifecycle = owner.lifecycle
  try {
    const now = current(owner)
    assertLive(owner, lifecycle)
    sweep(owner, now)
    assertLive(owner, lifecycle)
    return { now, lifecycle }
  } catch (err) {
    owner.mutating = false
    throw err
  }
}

function assertLive(owner, lifecycle) {
  if (owner.destroyed || owner.lifecycle !== lifecycle) throw PrivateRouteError.ERR_DESTROYED()
  if (owner.violated) {
    destroyOwner(owner)
    invalid()
  }
}

function end(owner) {
  owner.mutating = false
}

function releaseLive(state) {
  const owner = state.owner
  if (state.status !== 'LIVE') replay()
  state.status = 'FAILED'
  owner.liveReservations--
  if (state.branch && state.branch.reservation === state) state.branch.reservation = null
  clearProjection(state)
}

function sweep(owner, now) {
  for (const state of owner.authorizations) {
    if (state.deadline > now) continue
    if (state.status === 'LIVE') releaseLive(state)
    AUTHORIZATIONS.delete(state.authorization)
    RESERVATIONS.delete(state.reservation)
    owner.authorizations.delete(state)
    clearAuthorization(state)
  }
}

function destroyOwner(owner) {
  if (owner.destroyed) return false
  owner.destroyed = true
  owner.lifecycle = Object.freeze({})
  for (const state of owner.authorizations) {
    state.status = 'DESTROYED'
    if (state.branch && state.branch.reservation === state) state.branch.reservation = null
    AUTHORIZATIONS.delete(state.authorization)
    RESERVATIONS.delete(state.reservation)
    clearAuthorization(state)
  }
  owner.authorizations.clear()
  owner.pending.clear()
  for (const node of owner.nodes) clearNode(node)
  owner.nodes.length = 0
  clearBranch(owner.lookup)
  clearBranch(owner.announce)
  owner.lookup = null
  owner.announce = null
  owner.candidateDirectory = null
  owner.pairBinding = null
  owner.now = null
  owner.liveReservations = 0
  return true
}

class BranchPathAuthority {
  constructor(options) {
    if (!safeObject(options) || !exactKeys(options, ['now', 'candidateDirectory', 'pairBinding'])) {
      invalid()
    }
    const now = option(options, 'now')
    const candidateDirectory = option(options, 'candidateDirectory')
    if (typeof now !== 'function' || !isRoutedCandidateDirectory(candidateDirectory)) invalid()
    let paired = null
    let guard = null
    let lookup = null
    let announce = null
    try {
      paired = takeBranchPathPairBinding(option(options, 'pairBinding'))
      guard = copyGuard({
        relayIdentity: paired.guardRelayIdentity,
        reachableEndpoint: paired.guardReachableEndpoint
      })
      lookup = copyBranch(paired.lookup, BRANCH_CLASS.LOOKUP, guard)
      announce = copyBranch(paired.announce, BRANCH_CLASS.ANNOUNCE, guard)
      if (
        same(lookup.branchId, announce.branchId) ||
        same(lookup.circuitId, announce.circuitId) ||
        lookup.generation === announce.generation ||
        lookup.linkBinding === announce.linkBinding ||
        !isRoutedCandidateDirectory(candidateDirectory)
      ) {
        invalid()
      }
      const owner = {
        authority: this,
        now,
        candidateDirectory,
        lookup,
        announce,
        pairBinding: Object.freeze({}),
        nodes: [guard],
        authorizations: new Set(),
        pending: new Set(),
        liveReservations: 0,
        destroyed: false,
        mutating: false,
        violated: false,
        lifecycle: Object.freeze({})
      }
      STATES.set(this, owner)
      guard = null
      lookup = null
      announce = null
    } finally {
      clear(paired && paired.guardRelayIdentity)
      clear(paired && paired.guardReachableEndpoint)
      clearPathBranchMaterial(paired && paired.lookup)
      clearPathBranchMaterial(paired && paired.announce)
      clearNode(guard)
      clearBranch(lookup)
      clearBranch(announce)
    }
    Object.freeze(this)
  }

  reserve(candidate) {
    const owner = liveOwner(this)
    if (owner.pending.size + owner.liveReservations >= 2) busy()
    const pending = Object.freeze({})
    owner.pending.add(pending)
    let operation = null
    let projection = null
    let consumed = null
    let state = null
    let inserted = false
    try {
      operation = begin(owner)
      projection = owner.candidateDirectory.read(candidate)
      assertLive(owner, operation.lifecycle)
      const branch = projection.branchClass === BRANCH_CLASS.LOOKUP ? owner.lookup : owner.announce
      if (branch.reservation !== null) busy()
      if (owner.liveReservations >= 2) busy()
      const deadline = validateCandidate(owner, branch, projection, operation.now)
      state = ownedAuthorization(owner, branch, projection, deadline)
      branch.reservation = state
      owner.authorizations.add(state)
      owner.liveReservations++
      inserted = true
      consumed = owner.candidateDirectory.consume(candidate)
      assertLive(owner, operation.lifecycle)
      if (!projectionsEqual(projection, consumed)) authentication()
      AUTHORIZATIONS.set(state.authorization, state)
      RESERVATIONS.set(state.reservation, state)
      return state.authorization
    } finally {
      if (inserted && (!state || !AUTHORIZATIONS.has(state.authorization))) {
        if (state.status === 'LIVE' && state.owner === owner && state.branch) {
          owner.liveReservations--
          if (state.branch.reservation === state) state.branch.reservation = null
        }
        owner.authorizations.delete(state)
        clearAuthorization(state)
      }
      clearProjection(projection)
      clearProjection(consumed)
      owner.pending.delete(pending)
      if (operation) end(owner)
    }
  }

  diagnostics() {
    const owner = STATES.get(this)
    if (!owner || owner.destroyed) {
      return Object.freeze({
        state: 'DESTROYED',
        liveReservations: 0,
        retainedAuthorizations: 0,
        lookupIndex: -1,
        announceIndex: -1
      })
    }
    begin(owner)
    try {
      return Object.freeze({
        state: 'ACTIVE',
        liveReservations: owner.liveReservations,
        retainedAuthorizations: owner.authorizations.size,
        lookupIndex: owner.lookup.index,
        announceIndex: owner.announce.index
      })
    } finally {
      end(owner)
    }
  }

  destroy() {
    const owner = STATES.get(this)
    if (!owner || owner.destroyed) return false
    return destroyOwner(owner)
  }
}

export function createBranchPathAuthority(options) {
  return new BranchPathAuthority(options)
}

export function takeBranchPathAuthorization(authorization) {
  const state = safeObject(authorization) ? AUTHORIZATIONS.get(authorization) : null
  if (!state || state.status !== 'LIVE' || state.consumed) replay()
  const owner = liveOwner(state.owner.authority)
  const operation = begin(owner)
  let result = null
  let complete = false
  try {
    if (state.deadline <= operation.now) replay()
    result = {}
    result.advertisement = copy(state.advertisement)
    result.advertisementDigest = copy(state.advertisementDigest, 32)
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
    result.reservation = state.reservation
    assertLive(owner, operation.lifecycle)
    state.consumed = true
    complete = true
    return Object.freeze(result)
  } finally {
    if (!complete) clearProjection(result)
    end(owner)
  }
}

export function completeBranchPathReservation(reservation) {
  const state = safeObject(reservation) ? RESERVATIONS.get(reservation) : null
  if (!state || state.status !== 'LIVE' || !state.consumed) replay()
  const owner = liveOwner(state.owner.authority)
  const operation = begin(owner)
  let tailIdentity = null
  let tailDigest = null
  let node = null
  let complete = false
  try {
    if (state.deadline <= operation.now) replay()
    tailIdentity = copy(state.relayIdentity, 32)
    tailDigest = copy(state.advertisementDigest, 32)
    node = {}
    node.relayIdentity = copy(state.relayIdentity, 32)
    node.reachableEndpoint = copy(state.reachableEndpoint, 19)
    assertLive(owner, operation.lifecycle)
    const branch = state.branch
    if (branch.reservation !== state || owner.liveReservations < 1) invalid()
    owner.nodes.push(node)
    const previousTailIdentity = branch.currentTailIdentity
    const previousTailDigest = branch.currentTailAdvertisementDigest
    branch.currentTailIdentity = tailIdentity
    branch.currentTailAdvertisementDigest = tailDigest
    branch.index = state.extensionIndex
    branch.reservation = null
    owner.liveReservations--
    state.status = 'COMMITTED'
    clearProjection(state)
    clear(previousTailIdentity)
    clear(previousTailDigest)
    tailIdentity = null
    tailDigest = null
    node = null
    complete = true
    return true
  } finally {
    if (!complete) {
      clear(tailIdentity)
      clear(tailDigest)
      clearNode(node)
    }
    end(owner)
  }
}

export function failBranchPathReservation(reservation) {
  const state = safeObject(reservation) ? RESERVATIONS.get(reservation) : null
  if (!state || state.status !== 'LIVE') replay()
  const owner = liveOwner(state.owner.authority)
  begin(owner)
  try {
    releaseLive(state)
    return true
  } finally {
    end(owner)
  }
}
