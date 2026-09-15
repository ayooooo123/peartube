import b4a from 'b4a'

import { PrivateRouteError } from './errors.js'
import {
  decodeRelayCapabilityAdvertisement,
  digestRelayCapabilityAdvertisement
} from './relay-capability.js'
import { isM3AdjacencyAuthority, revokeM3TailCapability } from './m3-adjacency-runtime.js'
import { BRANCH_CLASS, ROLE, roleForIdentity } from './protocol.js'

export const TEST_ONLY_BRANCH_CONSTRUCTION_OBSERVER = Symbol(
  'test-only-branch-construction-observer'
)

const STATES = new WeakMap()
const REQUESTS = new WeakMap()
const SESSIONS = new WeakMap()
const PAIR_TRANSFERS = new WeakMap()
const PATH_BINDINGS = new WeakMap()
const RESOURCE_OWNERS = new WeakMap()
const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const setIntrinsic = Uint8Array.prototype.set
const fillIntrinsic = Uint8Array.prototype.fill

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function destroyed() {
  throw PrivateRouteError.ERR_DESTROYED()
}

function busy() {
  throw PrivateRouteError.ERR_BUSY()
}

function replay() {
  throw PrivateRouteError.ERR_REPLAY()
}

function authentication() {
  throw PrivateRouteError.ERR_AUTHENTICATION()
}

function safeObject(value) {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

function exactKeys(value, expected, symbols = []) {
  let keys
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    return false
  }
  if (keys.length !== expected.length + symbols.length) return false
  for (const key of keys) {
    if (typeof key === 'string') {
      if (!expected.includes(key)) return false
    } else if (!symbols.includes(key)) {
      return false
    }
  }
  return true
}

function length(value) {
  try {
    return b4a.isBuffer(value) ? byteLengthGetter.call(value) : -1
  } catch {
    return -1
  }
}

function fixed(value, size) {
  return length(value) === size
}

function copy(value, size) {
  if (!fixed(value, size)) invalid()
  let result = null
  try {
    result = b4a.allocUnsafeSlow(size)
    if (!fixed(result, size)) invalid()
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
  } catch {
    // Best-effort zeroization only.
  }
}

function clearObjectBuffers(value, seen = new Set()) {
  if (!safeObject(value) || seen.has(value)) return
  seen.add(value)
  for (const child of Object.values(value)) {
    if (b4a.isBuffer(child)) clear(child)
    else clearObjectBuffers(child, seen)
  }
}

function same(left, right) {
  if (length(left) < 0 || length(left) !== length(right)) return false
  try {
    return b4a.equals(left, right)
  } catch {
    return false
  }
}

function nonzero(value) {
  if (length(value) < 0) return false
  for (const byte of value) if (byte !== 0) return true
  return false
}

function u64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= 0xffff_ffff_ffff_ffffn
}

function current(owner, lifecycle = owner.lifecycle, mutation = null) {
  let value
  try {
    value = owner.now()
  } catch {
    authentication()
  }
  assertMutation(owner, lifecycle, mutation)
  if (!u64(value)) invalid()
  return value
}

function option(value, name) {
  try {
    return value[name]
  } catch {
    invalid()
  }
}

function copyLimits(value) {
  if (!safeObject(value)) invalid()
  let keys
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    invalid()
  }
  if (keys.length > 32 || keys.some((key) => typeof key !== 'string')) invalid()
  const result = {}
  for (const key of keys) {
    const entry = option(value, key)
    if (
      !/^[a-z][a-zA-Z0-9]{0,63}$/.test(key) ||
      !(
        (Number.isSafeInteger(entry) && entry >= 0) ||
        (typeof entry === 'bigint' && u64(entry)) ||
        typeof entry === 'boolean'
      )
    ) {
      invalid()
    }
    result[key] = entry
  }
  return Object.freeze(result)
}

function copyBranch(input, expectedClass) {
  if (
    !safeObject(input) ||
    !exactKeys(input, [
      'branchClass',
      'branchId',
      'circuitId',
      'generation',
      'clientCircuitIdentity',
      'clientTailEphemeral',
      'deadline',
      'requestedLimits'
    ])
  ) {
    invalid()
  }
  const branch = {
    branchClass: expectedClass,
    branchId: null,
    circuitId: null,
    generation: 0n,
    clientCircuitIdentity: { publicKey: null, secretKey: null },
    clientTailEphemeral: { publicKey: null, secretKey: null },
    deadline: 0n,
    requestedLimits: null,
    advertisementDigest: null,
    advertisementEpoch: null,
    resource: null,
    completed: false,
    cleared: false
  }
  let complete = false
  try {
    const identity = option(input, 'clientCircuitIdentity')
    const tail = option(input, 'clientTailEphemeral')
    const requestedLimits = option(input, 'requestedLimits')
    const generation = option(input, 'generation')
    const deadline = option(input, 'deadline')
    let frozenLimits = false
    try {
      frozenLimits = safeObject(requestedLimits) && Object.isFrozen(requestedLimits)
    } catch {}
    if (
      option(input, 'branchClass') !== expectedClass ||
      !safeObject(identity) ||
      !exactKeys(identity, ['publicKey', 'secretKey']) ||
      !safeObject(tail) ||
      !exactKeys(tail, ['publicKey', 'secretKey']) ||
      !frozenLimits ||
      !u64(generation) ||
      generation === 0n ||
      !u64(deadline)
    ) {
      invalid()
    }
    branch.branchId = copy(option(input, 'branchId'), 16)
    branch.circuitId = copy(option(input, 'circuitId'), 16)
    branch.generation = generation
    branch.clientCircuitIdentity.publicKey = copy(option(identity, 'publicKey'), 32)
    branch.clientCircuitIdentity.secretKey = copy(option(identity, 'secretKey'), 64)
    branch.clientTailEphemeral.publicKey = copy(option(tail, 'publicKey'), 32)
    branch.clientTailEphemeral.secretKey = copy(option(tail, 'secretKey'), 32)
    branch.deadline = deadline
    branch.requestedLimits = copyLimits(requestedLimits)
    if (
      !nonzero(branch.branchId) ||
      !nonzero(branch.circuitId) ||
      same(branch.branchId, branch.circuitId) ||
      !nonzero(branch.clientCircuitIdentity.publicKey) ||
      !nonzero(branch.clientCircuitIdentity.secretKey) ||
      !nonzero(branch.clientTailEphemeral.publicKey) ||
      !nonzero(branch.clientTailEphemeral.secretKey)
    ) {
      invalid()
    }
    complete = true
    return branch
  } finally {
    if (!complete) clearBranch(branch)
  }
}

function clearBranch(branch) {
  if (!branch || branch.cleared) return
  branch.cleared = true
  clear(branch.branchId)
  clear(branch.circuitId)
  clear(branch.clientCircuitIdentity && branch.clientCircuitIdentity.publicKey)
  clear(branch.clientCircuitIdentity && branch.clientCircuitIdentity.secretKey)
  clear(branch.clientTailEphemeral && branch.clientTailEphemeral.publicKey)
  clear(branch.clientTailEphemeral && branch.clientTailEphemeral.secretKey)
  clear(branch.advertisementDigest)
  branch.branchId = null
  branch.circuitId = null
  branch.clientCircuitIdentity = null
  branch.clientTailEphemeral = null
  branch.requestedLimits = null
  branch.advertisementDigest = null
  branch.resource = null
  branch.completed = false
  branch.generation = 0n
  branch.deadline = 0n
  branch.advertisementEpoch = null
}

function copyPathBranch(branch, linkBinding) {
  const result = {
    branchClass: branch.branchClass,
    branchId: null,
    circuitId: null,
    generation: branch.generation,
    currentTailAdvertisementDigest: null,
    deadline: branch.deadline,
    linkBinding
  }
  let complete = false
  try {
    result.branchId = copy(branch.branchId, 16)
    result.circuitId = copy(branch.circuitId, 16)
    result.currentTailAdvertisementDigest = copy(branch.advertisementDigest, 32)
    complete = true
    return result
  } finally {
    if (!complete) clearPathBranch(result)
  }
}

function clearPathBranch(branch) {
  if (!branch) return
  clear(branch.branchId)
  clear(branch.circuitId)
  clear(branch.currentTailAdvertisementDigest)
  branch.branchId = null
  branch.circuitId = null
  branch.currentTailAdvertisementDigest = null
  branch.linkBinding = null
  branch.generation = 0n
  branch.deadline = 0n
}

function clearPathBinding(material) {
  if (!material) return
  clear(material.guardRelayIdentity)
  clear(material.guardReachableEndpoint)
  material.guardRelayIdentity = null
  material.guardReachableEndpoint = null
  clearPathBranch(material.lookup)
  clearPathBranch(material.announce)
  material.lookup = null
  material.announce = null
}

function clearLease(lease) {
  if (!lease) return
  clear(lease.relayIdentity)
  clear(lease.reachableEndpoint)
  clear(lease.advertisementDigest)
}

function notify(owner, event) {
  if (!owner.observe) return
  try {
    owner.observe(Object.freeze({ ...event }))
  } catch {
    // Test-only observation cannot affect protocol behavior.
  }
}

function notifyAndCheck(owner, lifecycle, event, mutation = null) {
  notify(owner, event)
  assertMutation(owner, lifecycle, mutation)
}

function liveOwner(authority) {
  const owner = safeObject(authority) ? STATES.get(authority) : null
  if (!owner || owner.destroyed) destroyed()
  return owner
}

function assertMutation(owner, lifecycle, mutation = null) {
  if (owner.destroyed || owner.lifecycle !== lifecycle) destroyed()
  if (mutation && mutation.violated) invalid()
}

function beginSessionMutation(session) {
  const state = safeObject(session) ? SESSIONS.get(session) : null
  if (!state) replay()
  const owner = liveOwner(state.authority)
  if (state.mutating) {
    state.violated = true
    busy()
  }
  if (state.completed) replay()
  state.mutating = true
  state.violated = false
  const lifecycle = owner.lifecycle
  try {
    if (state.branch.deadline <= current(owner, lifecycle, state)) authentication()
    return { owner, state, lifecycle }
  } catch (err) {
    state.mutating = false
    throw err
  }
}

function endSessionMutation(state) {
  if (state) state.mutating = false
}

function decodeAdvertisement(owner, lifecycle, mutation, encoded) {
  let decoded = null
  let digest = null
  try {
    const now = current(owner, lifecycle, mutation)
    decoded = decodeRelayCapabilityAdvertisement(encoded, { now })
    assertMutation(owner, lifecycle, mutation)
    digest = digestRelayCapabilityAdvertisement(encoded, { now })
    assertMutation(owner, lifecycle, mutation)
    if (roleForIdentity(decoded.relayIdentity) !== ROLE.SAFETY) authentication()
    return {
      relayIdentity: copy(decoded.relayIdentity, 32),
      reachableEndpoint: copy(decoded.reachableEndpoint, 19),
      advertisementDigest: copy(digest, 32),
      epoch: decoded.epoch
    }
  } catch (err) {
    if (err instanceof PrivateRouteError) throw err
    authentication()
  } finally {
    clearObjectBuffers(decoded)
    clear(digest)
  }
}

function clearAdvertisement(value) {
  if (!value) return
  clear(value.relayIdentity)
  clear(value.reachableEndpoint)
  clear(value.advertisementDigest)
}

function destroyResource(record) {
  if (!record || record.closed || typeof record.destroy !== 'function') return
  record.closed = true
  try {
    Reflect.apply(record.destroy, record.value, [])
  } catch {}
}

function terminalize(owner, { closeResources, type }) {
  if (owner.destroyed) return []
  owner.destroyed = true
  owner.lifecycle = Object.freeze({})
  if (owner.transfer) PAIR_TRANSFERS.delete(owner.transfer)
  owner.transfer = null
  for (const request of owner.requests) REQUESTS.delete(request)
  owner.requests.length = 0
  for (const session of owner.sessions) {
    const state = SESSIONS.get(session)
    SESSIONS.delete(session)
    if (state) {
      state.authority = null
      state.branch = null
      state.completed = true
      state.setupRead = true
      state.guardRead = true
      state.mutating = false
      state.violated = false
    }
  }
  owner.sessions.clear()
  const resources = [...owner.resources]
  owner.resources.clear()
  for (const record of resources) RESOURCE_OWNERS.delete(record.value)
  if (owner.lookup) owner.lookup.resource = null
  if (owner.announce) owner.announce.resource = null
  owner.completedBranches = 0
  clearLease(owner.lease)
  owner.lease = null
  clearBranch(owner.lookup)
  clearBranch(owner.announce)
  owner.lookup = null
  owner.announce = null
  owner.authority = null
  owner.adjacencyAuthority = null
  owner.pairIssued = true
  owner.now = null
  const observe = owner.observe
  owner.observe = null
  if (observe) {
    try {
      observe(Object.freeze({ type, completedBranches: 0 }))
    } catch {}
  }
  if (closeResources) for (const record of resources) destroyResource(record)
  return resources
}

class BranchConstructionAuthority {
  constructor(options) {
    if (!safeObject(options)) invalid()
    let symbols
    let hasAdjacencyAuthority
    try {
      symbols = Reflect.ownKeys(options).includes(TEST_ONLY_BRANCH_CONSTRUCTION_OBSERVER)
        ? [TEST_ONLY_BRANCH_CONSTRUCTION_OBSERVER]
        : []
      hasAdjacencyAuthority = Reflect.ownKeys(options).includes('adjacencyAuthority')
    } catch {
      invalid()
    }
    const expected = hasAdjacencyAuthority
      ? ['lookup', 'announce', 'now', 'adjacencyAuthority']
      : ['lookup', 'announce', 'now']
    if (!exactKeys(options, expected, symbols)) invalid()
    const now = option(options, 'now')
    const adjacencyAuthority = hasAdjacencyAuthority ? option(options, 'adjacencyAuthority') : null
    const observe = option(options, TEST_ONLY_BRANCH_CONSTRUCTION_OBSERVER)
    if (
      typeof now !== 'function' ||
      (adjacencyAuthority !== null && !isM3AdjacencyAuthority(adjacencyAuthority)) ||
      (observe !== undefined && typeof observe !== 'function')
    ) {
      invalid()
    }
    let lookup = null
    let announce = null
    try {
      lookup = copyBranch(option(options, 'lookup'), BRANCH_CLASS.LOOKUP)
      announce = copyBranch(option(options, 'announce'), BRANCH_CLASS.ANNOUNCE)
      if (
        same(lookup.branchId, announce.branchId) ||
        same(lookup.circuitId, announce.circuitId) ||
        lookup.generation === announce.generation ||
        same(lookup.clientCircuitIdentity.publicKey, announce.clientCircuitIdentity.publicKey) ||
        same(lookup.clientTailEphemeral.publicKey, announce.clientTailEphemeral.publicKey)
      ) {
        invalid()
      }
      const owner = {
        authority: this,
        adjacencyAuthority,
        now,
        observe: observe || null,
        lookup,
        announce,
        lease: null,
        destroyed: false,
        lifecycle: Object.freeze({}),
        completedBranches: 0,
        pairIssued: false,
        transfer: null,
        requests: [],
        sessions: new Set(),
        resources: new Set()
      }
      const bootstrapRequest = Object.freeze({})
      const revalidationRequest = Object.freeze({})
      REQUESTS.set(bootstrapRequest, {
        authority: this,
        branch: lookup,
        kind: 'bootstrap',
        consumed: false
      })
      REQUESTS.set(revalidationRequest, {
        authority: this,
        branch: announce,
        kind: 'revalidation',
        consumed: false
      })
      owner.requests.push(bootstrapRequest, revalidationRequest)
      STATES.set(this, owner)
      this.bootstrapRequest = bootstrapRequest
      this.revalidationRequest = revalidationRequest
      lookup = null
      announce = null
    } finally {
      clearBranch(lookup)
      clearBranch(announce)
    }
    Object.freeze(this)
  }

  takePair() {
    const owner = liveOwner(this)
    const lifecycle = owner.lifecycle
    if (owner.pairIssued) replay()
    if (owner.completedBranches !== 2 || !owner.lookup.resource || !owner.announce.resource) busy()
    const transfer = Object.freeze({})
    owner.pairIssued = true
    owner.transfer = transfer
    PAIR_TRANSFERS.set(transfer, owner)
    notifyAndCheck(owner, lifecycle, { type: 'pair-ready', completedBranches: 2 })
    return transfer
  }

  diagnostics() {
    const owner = STATES.get(this)
    if (!owner || owner.destroyed) {
      return Object.freeze({ state: 'DESTROYED', completedBranches: 0 })
    }
    return Object.freeze({ state: 'ACTIVE', completedBranches: owner.completedBranches })
  }

  destroy() {
    const owner = STATES.get(this)
    if (!owner || owner.destroyed) return false
    terminalize(owner, { closeResources: true, type: 'destroyed' })
    return true
  }
}

export function createBranchConstructionAuthority(options) {
  return new BranchConstructionAuthority(options)
}

export function takeBranchConstructionRequest(request) {
  const requestState = safeObject(request) ? REQUESTS.get(request) : null
  if (!requestState || requestState.consumed) replay()
  const owner = liveOwner(requestState.authority)
  if (requestState.kind === 'revalidation' && owner.lease === null) busy()
  requestState.consumed = true
  const lifecycle = owner.lifecycle
  const session = Object.freeze({})
  const state = {
    authority: requestState.authority,
    branch: requestState.branch,
    kind: requestState.kind,
    guardValidated: false,
    setupRead: false,
    guardRead: false,
    completed: false,
    mutating: true,
    violated: false
  }
  SESSIONS.set(session, state)
  owner.sessions.add(session)
  try {
    if (requestState.branch.deadline <= current(owner, lifecycle, state)) authentication()
    state.mutating = false
    notifyAndCheck(
      owner,
      lifecycle,
      { type: 'request-consumed', branchClass: requestState.branch.branchClass },
      state
    )
    return session
  } catch (err) {
    SESSIONS.delete(session)
    owner.sessions.delete(session)
    state.authority = null
    state.branch = null
    state.completed = true
    state.mutating = false
    throw err
  }
}

function clearSetup(value) {
  if (!value) return
  clear(value.branchId)
  clear(value.circuitId)
  clear(value.clientCircuitIdentity && value.clientCircuitIdentity.publicKey)
  clear(value.clientCircuitIdentity && value.clientCircuitIdentity.secretKey)
  clear(value.clientTailEphemeral && value.clientTailEphemeral.publicKey)
  clear(value.clientTailEphemeral && value.clientTailEphemeral.secretKey)
}

// Deep production import used by BootstrapIO and GuardRevalidationIO. The
// projection is an owned copy and must be erased by the IO actor.
export function readBranchConstructionSetup(session) {
  const { owner, state, lifecycle } = beginSessionMutation(session)
  let result = null
  let complete = false
  try {
    if (state.setupRead || state.completed) replay()
    state.setupRead = true
    const branch = state.branch
    result = {
      kind: state.kind,
      branchClass: branch.branchClass,
      branchId: copy(branch.branchId, 16),
      circuitId: copy(branch.circuitId, 16),
      generation: branch.generation,
      clientCircuitIdentity: Object.freeze({
        publicKey: copy(branch.clientCircuitIdentity.publicKey, 32),
        secretKey: copy(branch.clientCircuitIdentity.secretKey, 64)
      }),
      clientTailEphemeral: Object.freeze({
        publicKey: copy(branch.clientTailEphemeral.publicKey, 32),
        secretKey: copy(branch.clientTailEphemeral.secretKey, 32)
      }),
      deadline: branch.deadline,
      requestedLimits: branch.requestedLimits
    }
    assertMutation(owner, lifecycle, state)
    complete = true
    return Object.freeze(result)
  } catch (err) {
    if (!owner.destroyed) terminalize(owner, { closeResources: true, type: 'destroyed' })
    throw err
  } finally {
    if (!complete) clearSetup(result)
    endSessionMutation(state)
  }
}

export function readPinnedBranchGuard(session) {
  const { owner, state, lifecycle } = beginSessionMutation(session)
  let result = null
  let complete = false
  try {
    if (state.kind !== 'revalidation' || state.guardRead || !owner.lease) invalid()
    state.guardRead = true
    result = {
      relayIdentity: copy(owner.lease.relayIdentity, 32),
      reachableEndpoint: copy(owner.lease.reachableEndpoint, 19),
      advertisementDigest: copy(owner.lease.advertisementDigest, 32),
      epoch: owner.lease.epoch,
      deadline: state.branch.deadline
    }
    assertMutation(owner, lifecycle, state)
    complete = true
    return Object.freeze(result)
  } catch (err) {
    if (!owner.destroyed) terminalize(owner, { closeResources: true, type: 'destroyed' })
    throw err
  } finally {
    if (!complete && result) clearLease(result)
    endSessionMutation(state)
  }
}

export function readBranchConstructionDeadline(session) {
  const { owner, state, lifecycle } = beginSessionMutation(session)
  try {
    const deadline = state.branch.deadline
    assertMutation(owner, lifecycle, state)
    return deadline
  } catch (err) {
    if (!owner.destroyed) terminalize(owner, { closeResources: true, type: 'destroyed' })
    throw err
  } finally {
    endSessionMutation(state)
  }
}

// Deep production import. The local M3 authority consumes the authenticated
// established-link handle and returns only its runtime and opaque tail brand.
export function adoptBranchEstablishedLink(session, established) {
  const { owner, state, lifecycle } = beginSessionMutation(session)
  let adopted = null
  let complete = false
  try {
    if (!state.setupRead || state.completed || !owner.adjacencyAuthority) invalid()
    adopted = owner.adjacencyAuthority.adopt(established)
    assertMutation(owner, lifecycle, state)
    complete = true
    return adopted
  } catch (err) {
    if (!owner.destroyed) terminalize(owner, { closeResources: true, type: 'destroyed' })
    throw err
  } finally {
    if (!complete && adopted) {
      try {
        revokeM3TailCapability(adopted.tail)
      } catch {}
      try {
        adopted.runtime.destroy()
      } catch {}
    }
    endSessionMutation(state)
  }
}

export function failBranchConstruction(session) {
  const state = safeObject(session) ? SESSIONS.get(session) : null
  if (!state) return false
  if (state.mutating) {
    state.violated = true
    busy()
  }
  const owner = liveOwner(state.authority)
  terminalize(owner, { closeResources: true, type: 'destroyed' })
  return true
}

export function initializeBranchGuardLease(session, encodedAdvertisement) {
  const { owner, state, lifecycle } = beginSessionMutation(session)
  let advertisement = null
  let lease = null
  let branchDigest = null
  let published = false
  try {
    if (state.kind !== 'bootstrap' || owner.lease !== null || state.guardValidated) replay()
    advertisement = decodeAdvertisement(owner, lifecycle, state, encodedAdvertisement)
    lease = {
      relayIdentity: copy(advertisement.relayIdentity, 32),
      reachableEndpoint: copy(advertisement.reachableEndpoint, 19),
      advertisementDigest: copy(advertisement.advertisementDigest, 32),
      epoch: advertisement.epoch
    }
    branchDigest = copy(advertisement.advertisementDigest, 32)
    assertMutation(owner, lifecycle, state)
    owner.lease = lease
    lease = null
    state.branch.advertisementDigest = branchDigest
    branchDigest = null
    state.branch.advertisementEpoch = advertisement.epoch
    state.guardValidated = true
    published = true
    notifyAndCheck(
      owner,
      lifecycle,
      { type: 'guard-pinned', branchClass: state.branch.branchClass },
      state
    )
    return true
  } catch (err) {
    if (published && !owner.destroyed) {
      terminalize(owner, { closeResources: true, type: 'destroyed' })
    }
    throw err
  } finally {
    clearAdvertisement(advertisement)
    clearLease(lease)
    clear(branchDigest)
    endSessionMutation(state)
  }
}

export function validateBranchGuardLease(session, encodedAdvertisement) {
  const { owner, state, lifecycle } = beginSessionMutation(session)
  let advertisement = null
  let branchDigest = null
  let published = false
  try {
    if (state.kind !== 'revalidation' || owner.lease === null || state.guardValidated) replay()
    advertisement = decodeAdvertisement(owner, lifecycle, state, encodedAdvertisement)
    if (
      !same(advertisement.relayIdentity, owner.lease.relayIdentity) ||
      !same(advertisement.reachableEndpoint, owner.lease.reachableEndpoint) ||
      advertisement.epoch < owner.lease.epoch ||
      (advertisement.epoch === owner.lease.epoch &&
        !same(advertisement.advertisementDigest, owner.lease.advertisementDigest))
    ) {
      authentication()
    }
    branchDigest = copy(advertisement.advertisementDigest, 32)
    assertMutation(owner, lifecycle, state)
    state.branch.advertisementDigest = branchDigest
    branchDigest = null
    state.branch.advertisementEpoch = advertisement.epoch
    state.guardValidated = true
    published = true
    notifyAndCheck(
      owner,
      lifecycle,
      { type: 'guard-revalidated', branchClass: state.branch.branchClass },
      state
    )
    return true
  } catch (err) {
    if (published && !owner.destroyed) {
      terminalize(owner, { closeResources: true, type: 'destroyed' })
    }
    throw err
  } finally {
    clearAdvertisement(advertisement)
    clear(branchDigest)
    endSessionMutation(state)
  }
}

export function completeBranchConstruction(session, resource) {
  const { owner, state, lifecycle } = beginSessionMutation(session)
  let record = null
  let published = false
  try {
    if (!state.guardValidated || !safeObject(resource)) invalid()
    if (RESOURCE_OWNERS.has(resource)) replay()
    record = { value: resource, destroy: null, closed: false }
    RESOURCE_OWNERS.set(resource, record)
    owner.resources.add(record)
    let destroyMethod
    try {
      destroyMethod = resource.destroy
    } catch {
      invalid()
    }
    record.destroy = destroyMethod
    assertMutation(owner, lifecycle, state)
    if (typeof destroyMethod !== 'function') invalid()
    state.completed = true
    state.branch.completed = true
    state.branch.resource = record
    owner.completedBranches++
    published = true
    notifyAndCheck(
      owner,
      lifecycle,
      { type: 'branch-completed', branchClass: state.branch.branchClass },
      state
    )
    return true
  } catch (err) {
    if (published && !owner.destroyed) {
      terminalize(owner, { closeResources: true, type: 'destroyed' })
    } else if (record && !published) {
      owner.resources.delete(record)
      if (RESOURCE_OWNERS.get(resource) === record) RESOURCE_OWNERS.delete(resource)
      if (owner.destroyed) destroyResource(record)
    }
    throw err
  } finally {
    endSessionMutation(state)
  }
}

export function consumeBranchConstructionPair(transfer) {
  const owner = safeObject(transfer) ? PAIR_TRANSFERS.get(transfer) : null
  if (!owner || owner.destroyed || owner.transfer !== transfer) replay()
  const lookup = owner.lookup.resource.value
  const announce = owner.announce.resource.value
  const pathBinding = Object.freeze({})
  let material = null
  let published = false
  try {
    material = {
      guardRelayIdentity: null,
      guardReachableEndpoint: null,
      lookup: null,
      announce: null
    }
    material.guardRelayIdentity = copy(owner.lease.relayIdentity, 32)
    material.guardReachableEndpoint = copy(owner.lease.reachableEndpoint, 19)
    material.lookup = copyPathBranch(owner.lookup, Object.freeze({}))
    material.announce = copyPathBranch(owner.announce, Object.freeze({}))
    PATH_BINDINGS.set(pathBinding, material)
    published = true
  } finally {
    if (!published) clearPathBinding(material)
  }
  terminalize(owner, { closeResources: false, type: 'pair-transferred' })
  return Object.freeze({ lookup, announce, pathBinding })
}

// Deep production transfer consumed only by BranchPathAuthority after both
// authenticated index-zero branches have moved to RouteManager.
export function takeBranchPathPairBinding(binding) {
  const material = safeObject(binding) ? PATH_BINDINGS.get(binding) : null
  if (!material) replay()
  PATH_BINDINGS.delete(binding)
  return material
}

export function revokeBranchPathPairBinding(binding) {
  const material = safeObject(binding) ? PATH_BINDINGS.get(binding) : null
  if (!material) return false
  PATH_BINDINGS.delete(binding)
  clearPathBinding(material)
  return true
}
