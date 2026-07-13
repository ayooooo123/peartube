import b4a from 'b4a'

import { isCircuitChecker } from './circuit-authority.js'
import { isVerifiedDescriptor, readVerifiedDescriptor } from './descriptor.js'
import { isDiscoveryEvidenceChecker } from './discovery-evidence.js'
import { PrivateRouteError } from './errors.js'
import { ROLE, roleForIdentity } from './protocol.js'

const MAX_U64 = 0xffff_ffff_ffff_ffffn
const INVALID_CONTEXT = Symbol('invalid-context')

// Experimental implementation safety bounds. These are not stable wire-protocol limits.
export const MAX_IDENTITIES = 4096
export const MAX_PUBLIC_EPOCHS_PER_IDENTITY = 8
export const MAX_ROUTE_EPOCHS_PER_IDENTITY = 8
export const MAX_CIRCUITS_PER_EPOCH = 128

const DEFAULT_LIMITS = Object.freeze({
  maxIdentities: MAX_IDENTITIES,
  maxPublicEpochsPerIdentity: MAX_PUBLIC_EPOCHS_PER_IDENTITY,
  maxRouteEpochsPerIdentity: MAX_ROUTE_EPOCHS_PER_IDENTITY,
  maxCircuitsPerEpoch: MAX_CIRCUITS_PER_EPOCH
})

export const PRIVACY_PROVENANCE = Object.freeze({
  PRIVATE_ONLY: 'private-only',
  ROUTE_ENTRY: 'route-entry',
  PUBLIC: 'public'
})

export const PRIVACY_OPERATION = Object.freeze({
  GUARD_DIAL: 'guard-dial',
  ROUTE_ENTRY_DIAL: 'route-entry-dial',
  ROUTE_FORWARD: 'route-forward',
  DIRECT_DIAL: 'direct-dial',
  DIRECT_PING: 'direct-ping',
  PUBLIC_RETURN: 'public-return'
})

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

function exactContextValue(value, name) {
  if (!isObject(value)) return INVALID_CONTEXT
  try {
    const keys = Reflect.ownKeys(value)
    if (keys.length !== 1 || keys[0] !== name) return INVALID_CONTEXT
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return INVALID_CONTEXT
    }
    return descriptor.value
  } catch {
    return INVALID_CONTEXT
  }
}

function fixed(value, size) {
  return b4a.isBuffer(value) && value.byteLength === size
}

function u64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_U64
}

function normalizeLimits(limits) {
  if (limits === undefined) return DEFAULT_LIMITS
  if (!exactKeys(limits, Object.keys(DEFAULT_LIMITS))) invalidRoute()
  const normalized = {}
  for (const [name, maximum] of Object.entries(DEFAULT_LIMITS)) {
    const value = limits[name]
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) invalidRoute()
    normalized[name] = value
  }
  return Object.freeze(normalized)
}

function currentTime(now) {
  const value = now()
  if (!u64(value)) invalidRoute()
  return value
}

function identityHex(identity) {
  if (!fixed(identity, 32)) throw PrivateRouteError.INVALID_IDENTITY()
  return b4a.toString(identity, 'hex')
}

function copyCircuit(value) {
  return {
    circuitId: b4a.from(value.circuitId),
    epoch: value.epoch,
    finalSafetyIdentity32: b4a.from(value.finalSafetyIdentity32),
    entryIdentity32: b4a.from(value.entryIdentity32),
    expiresAt: value.expiresAt
  }
}

function circuitKey(value) {
  return `${b4a.toString(value.circuitId, 'hex')}:${b4a.toString(
    value.finalSafetyIdentity32,
    'hex'
  )}:${b4a.toString(value.entryIdentity32, 'hex')}:${value.epoch}:${value.expiresAt}`
}

function claimsConflict(left, right) {
  return (
    left.epoch === right.epoch &&
    (!b4a.equals(left.dial, right.dial) ||
      !b4a.equals(left.routeEncryptionKey, right.routeEncryptionKey) ||
      left.capabilities !== right.capabilities)
  )
}

function validCircuit(value) {
  return (
    isObject(value) &&
    fixed(value.circuitId, 16) &&
    u64(value.epoch) &&
    fixed(value.finalSafetyIdentity32, 32) &&
    fixed(value.entryIdentity32, 32) &&
    u64(value.expiresAt) &&
    roleForIdentity(value.finalSafetyIdentity32) === ROLE.SAFETY &&
    roleForIdentity(value.entryIdentity32) === ROLE.PRIVATE
  )
}

function validEvidence(value) {
  return (
    isObject(value) &&
    fixed(value.peerIdentity32, 32) &&
    fixed(value.observedDial, value.observedDial?.byteLength) &&
    value.observedDial.byteLength > 0 &&
    value.observedDial.byteLength <= 256 &&
    fixed(value.routeEncryptionKey, 32) &&
    u64(value.epoch) &&
    u64(value.expiresAt) &&
    Number.isInteger(value.capabilities) &&
    value.role === roleForIdentity(value.peerIdentity32)
  )
}

function validDescriptorState(value) {
  const entry = value?.entry
  return (
    isObject(value) &&
    isObject(entry) &&
    fixed(entry.identityKey, 32) &&
    fixed(entry.routeEncryptionKey, 32) &&
    b4a.isBuffer(entry.dial) &&
    entry.dial.byteLength > 0 &&
    entry.dial.byteLength <= 256 &&
    u64(entry.epoch) &&
    u64(entry.expiresAt) &&
    Number.isInteger(entry.capabilities) &&
    entry.role === ROLE.PRIVATE &&
    roleForIdentity(entry.identityKey) === ROLE.PRIVATE &&
    value.epoch === entry.epoch &&
    value.expiresAt <= entry.expiresAt
  )
}

export class PrivacyDomainRegistry {
  #evidenceChecker
  #descriptorChecker
  #circuitChecker
  #now
  #limits
  #records = new Map()
  #nextGlobalSweepAt = null
  #expirableRecords = 0
  #sweepCount = 0

  constructor({ evidenceChecker, descriptorChecker, circuitChecker, now, limits } = {}) {
    if (
      !isObject(evidenceChecker) ||
      typeof evidenceChecker.isVerified !== 'function' ||
      typeof evidenceChecker.read !== 'function' ||
      !isObject(descriptorChecker) ||
      typeof descriptorChecker.isVerified !== 'function' ||
      typeof descriptorChecker.read !== 'function' ||
      !isObject(circuitChecker) ||
      typeof circuitChecker.read !== 'function' ||
      typeof now !== 'function'
    ) {
      invalidRoute()
    }
    if (
      !isDiscoveryEvidenceChecker(evidenceChecker) ||
      !isCircuitChecker(circuitChecker) ||
      descriptorChecker.isVerified !== isVerifiedDescriptor ||
      descriptorChecker.read !== readVerifiedDescriptor
    ) {
      unauthorized()
    }
    this.#evidenceChecker = Object.freeze({
      isVerified: evidenceChecker.isVerified.bind(evidenceChecker),
      read: evidenceChecker.read.bind(evidenceChecker)
    })
    this.#descriptorChecker = Object.freeze({
      isVerified: isVerifiedDescriptor,
      read: readVerifiedDescriptor
    })
    this.#circuitChecker = Object.freeze({
      read: circuitChecker.read.bind(circuitChecker)
    })
    this.#now = now
    this.#limits = normalizeLimits(limits)
  }

  get size() {
    return this.#records.size
  }

  get sweepCount() {
    return this.#sweepCount
  }

  #record(identity, current) {
    const key = identityHex(identity)
    const record = this.#records.get(key)
    if (record) {
      if (!record.quarantined) this.#pruneRecord(record, current)
      return record
    }
    if (this.#records.size >= this.#limits.maxIdentities) {
      // Capacity exhaustion is intentionally fail-closed. The receipt issuer/upstream owns
      // admission and rate policy; this registry makes no production-anonymity claim.
      if (this.#nextGlobalSweepAt === null || current < this.#nextGlobalSweepAt) {
        throw PrivateRouteError.CIRCUIT_LIMIT()
      }
      this.#prune(current)
    }
    if (this.#records.size >= this.#limits.maxIdentities) {
      throw PrivateRouteError.CIRCUIT_LIMIT()
    }
    const created = {
      identity: b4a.from(identity),
      provenance: new Set(),
      publicEvidence: new Map(),
      routeEpochs: new Map(),
      nextExpiryAt: null,
      quarantined: false
    }
    this.#records.set(key, created)
    return created
  }

  learnPublic(evidence) {
    if (!this.#evidenceChecker.isVerified(evidence)) unauthorized()
    let state
    try {
      state = this.#evidenceChecker.read(evidence)
    } catch {
      unauthorized()
    }
    const current = currentTime(this.#now)
    if (!validEvidence(state) || state.expiresAt <= current) unauthorized()
    const record = this.#record(state.peerIdentity32, current)
    if (record.quarantined) return
    const claim = {
      dial: b4a.from(state.observedDial),
      routeEncryptionKey: b4a.from(state.routeEncryptionKey),
      capabilities: state.capabilities,
      epoch: state.epoch
    }
    const existingPublic = record.publicEvidence.get(state.epoch)
    if (
      (existingPublic !== undefined && claimsConflict(existingPublic, claim)) ||
      [...record.routeEpochs.values()].some(
        (route) => route.dial !== undefined && claimsConflict(route, claim)
      )
    ) {
      this.#quarantine(record)
      return
    }
    if (
      existingPublic === undefined &&
      record.publicEvidence.size >= this.#limits.maxPublicEpochsPerIdentity
    ) {
      throw PrivateRouteError.CIRCUIT_LIMIT()
    }
    record.provenance.add(PRIVACY_PROVENANCE.PUBLIC)
    record.publicEvidence.set(state.epoch, {
      peerIdentity32: b4a.from(state.peerIdentity32),
      observedDial: b4a.from(state.observedDial),
      dial: b4a.from(state.observedDial),
      routeEncryptionKey: b4a.from(state.routeEncryptionKey),
      role: state.role,
      capabilities: state.capabilities,
      epoch: state.epoch,
      expiresAt:
        existingPublic !== undefined && existingPublic.expiresAt > state.expiresAt
          ? existingPublic.expiresAt
          : state.expiresAt
    })
    this.#noteExpiry(record, record.publicEvidence.get(state.epoch).expiresAt)
  }

  learnRoute(identity, material) {
    identityHex(identity)
    const current = currentTime(this.#now)
    if (!isObject(material)) invalidRoute()

    if (material.provenance === PRIVACY_PROVENANCE.PRIVATE_ONLY) {
      if (!exactKeys(material, ['provenance', 'epoch', 'expiresAt'])) invalidRoute()
      if (!u64(material.epoch) || !u64(material.expiresAt) || material.expiresAt <= current)
        invalidRoute()
      const record = this.#record(identity, current)
      if (record.quarantined) return
      const existing = record.routeEpochs.get(material.epoch)
      if (!existing && record.routeEpochs.size >= this.#limits.maxRouteEpochsPerIdentity) {
        throw PrivateRouteError.CIRCUIT_LIMIT()
      }
      record.provenance.add(PRIVACY_PROVENANCE.PRIVATE_ONLY)
      if (existing) {
        if (
          existing.privateOnlyExpiresAt === undefined ||
          material.expiresAt > existing.privateOnlyExpiresAt
        ) {
          existing.privateOnlyExpiresAt = material.expiresAt
        }
      } else {
        record.routeEpochs.set(material.epoch, {
          provenance: PRIVACY_PROVENANCE.PRIVATE_ONLY,
          epoch: material.epoch,
          privateOnlyExpiresAt: material.expiresAt
        })
      }
      this.#noteExpiry(record, record.routeEpochs.get(material.epoch).privateOnlyExpiresAt)
      return
    }

    if (material.provenance !== PRIVACY_PROVENANCE.ROUTE_ENTRY) unauthorized()
    if (!exactKeys(material, ['provenance', 'descriptor', 'circuitContext'])) unauthorized()
    if (!this.#descriptorChecker.isVerified(material.descriptor)) unauthorized()
    let descriptor
    let circuit
    try {
      descriptor = this.#descriptorChecker.read(material.descriptor)
      circuit = this.#circuitChecker.read(material.circuitContext)
    } catch {
      unauthorized()
    }
    if (!validDescriptorState(descriptor) || !validCircuit(circuit)) unauthorized()
    if (
      !b4a.equals(descriptor.entry.identityKey, identity) ||
      !b4a.equals(circuit.entryIdentity32, identity) ||
      descriptor.entry.epoch !== circuit.epoch ||
      descriptor.entry.expiresAt <= current ||
      circuit.expiresAt <= current
    ) {
      unauthorized()
    }

    const record = this.#record(identity, current)
    if (record.quarantined) return
    const routeClaim = {
      epoch: descriptor.entry.epoch,
      dial: descriptor.entry.dial,
      routeEncryptionKey: descriptor.entry.routeEncryptionKey,
      capabilities: descriptor.entry.capabilities
    }
    const existing = record.routeEpochs.get(descriptor.entry.epoch)
    if (
      (record.publicEvidence.has(routeClaim.epoch) &&
        claimsConflict(record.publicEvidence.get(routeClaim.epoch), routeClaim)) ||
      (existing?.dial !== undefined && claimsConflict(existing, routeClaim))
    ) {
      this.#quarantine(record)
      return
    }

    if (!existing && record.routeEpochs.size >= this.#limits.maxRouteEpochsPerIdentity) {
      throw PrivateRouteError.CIRCUIT_LIMIT()
    }

    let route = existing
    const binding = copyCircuit(circuit)
    const bindingKey = circuitKey(binding)
    if (
      route?.provenance === PRIVACY_PROVENANCE.ROUTE_ENTRY &&
      !route.circuits.has(bindingKey) &&
      route.circuits.size >= this.#limits.maxCircuitsPerEpoch
    ) {
      throw PrivateRouteError.CIRCUIT_LIMIT()
    }
    record.provenance.add(PRIVACY_PROVENANCE.ROUTE_ENTRY)
    if (!route || route.provenance !== PRIVACY_PROVENANCE.ROUTE_ENTRY) {
      route = {
        provenance: PRIVACY_PROVENANCE.ROUTE_ENTRY,
        epoch: descriptor.entry.epoch,
        expiresAt: descriptor.expiresAt,
        dial: b4a.from(descriptor.entry.dial),
        routeEncryptionKey: b4a.from(descriptor.entry.routeEncryptionKey),
        capabilities: descriptor.entry.capabilities,
        role: descriptor.entry.role,
        privateOnlyExpiresAt: existing?.privateOnlyExpiresAt,
        circuits: new Map()
      }
      record.routeEpochs.set(descriptor.entry.epoch, route)
    } else if (descriptor.expiresAt > route.expiresAt) {
      route.expiresAt = descriptor.expiresAt
    }
    route.circuits.set(bindingKey, binding)
    this.#noteExpiry(record, route.expiresAt)
    this.#noteExpiry(record, binding.expiresAt)
  }

  allows(identity, operation, context) {
    if (!fixed(identity, 32)) return false
    const current = currentTime(this.#now)
    const key = b4a.toString(identity, 'hex')
    const record = this.#records.get(key)
    if (!record || record.quarantined) return false
    this.#pruneRecord(record, current)
    if (this.#isEmpty(record)) {
      this.#records.delete(key)
      return false
    }

    switch (operation) {
      case PRIVACY_OPERATION.GUARD_DIAL:
        return (
          exactContextValue(context, 'selectedGuard') === true &&
          this.#hasLivePublic(record, current, ROLE.SAFETY) &&
          roleForIdentity(record.identity) === ROLE.SAFETY
        )
      case PRIVACY_OPERATION.ROUTE_ENTRY_DIAL:
        return this.#allowsRouteEntryDial(record, context, current)
      case PRIVACY_OPERATION.ROUTE_FORWARD:
        return this.#allowsRouteForward(record, context, current)
      case PRIVACY_OPERATION.DIRECT_DIAL:
      case PRIVACY_OPERATION.DIRECT_PING:
        return false
      case PRIVACY_OPERATION.PUBLIC_RETURN:
        return (
          exactContextValue(context, 'consumer') === 'relay-discovery' &&
          this.#hasLivePublic(record, current)
        )
      default:
        return false
    }
  }

  #allowsRouteEntryDial(record, context, current) {
    let circuit
    try {
      circuit = this.#circuitChecker.read(context)
    } catch {
      return false
    }
    if (!validCircuit(circuit) || circuit.expiresAt <= current) return false
    const route = record.routeEpochs.get(circuit.epoch)
    const installedCircuit = route?.circuits?.get(circuitKey(circuit))
    return (
      route?.provenance === PRIVACY_PROVENANCE.ROUTE_ENTRY &&
      route.expiresAt > current &&
      route.role === ROLE.PRIVATE &&
      installedCircuit !== undefined &&
      installedCircuit.expiresAt > current &&
      b4a.equals(record.identity, circuit.entryIdentity32) &&
      b4a.equals(installedCircuit.circuitId, circuit.circuitId) &&
      b4a.equals(installedCircuit.finalSafetyIdentity32, circuit.finalSafetyIdentity32) &&
      b4a.equals(installedCircuit.entryIdentity32, circuit.entryIdentity32) &&
      installedCircuit.epoch === circuit.epoch
    )
  }

  #hasLivePublic(record, current, role) {
    for (const evidence of record.publicEvidence.values()) {
      if (evidence.expiresAt > current && (role === undefined || evidence.role === role))
        return true
    }
    return false
  }

  #prune(current) {
    this.#sweepCount++
    for (const [identity, record] of this.#records) {
      if (record.quarantined) continue
      this.#pruneRecord(record, current)
      if (this.#isEmpty(record)) this.#records.delete(identity)
    }
    this.#recomputeExpiryWatermark()
  }

  #pruneRecord(record, current) {
    for (const [epoch, evidence] of record.publicEvidence) {
      if (evidence.expiresAt <= current) record.publicEvidence.delete(epoch)
    }

    for (const [epoch, route] of record.routeEpochs) {
      if (route.provenance === PRIVACY_PROVENANCE.ROUTE_ENTRY && route.expiresAt <= current) {
        if (route.privateOnlyExpiresAt !== undefined && route.privateOnlyExpiresAt > current) {
          record.routeEpochs.set(epoch, {
            provenance: PRIVACY_PROVENANCE.PRIVATE_ONLY,
            epoch,
            privateOnlyExpiresAt: route.privateOnlyExpiresAt
          })
        } else {
          record.routeEpochs.delete(epoch)
        }
        continue
      }

      if (route.circuits) {
        for (const [key, circuit] of route.circuits) {
          if (circuit.expiresAt <= current) route.circuits.delete(key)
        }
      }
      if (
        route.provenance === PRIVACY_PROVENANCE.PRIVATE_ONLY &&
        route.privateOnlyExpiresAt <= current
      ) {
        record.routeEpochs.delete(epoch)
      }
    }
    this.#refreshRecordExpiry(record)
  }

  #noteExpiry(record, expiresAt) {
    if (record.nextExpiryAt === null) this.#expirableRecords++
    if (record.nextExpiryAt === null || expiresAt < record.nextExpiryAt) {
      record.nextExpiryAt = expiresAt
    }
    if (this.#nextGlobalSweepAt === null || expiresAt < this.#nextGlobalSweepAt) {
      this.#nextGlobalSweepAt = expiresAt
    }
  }

  #refreshRecordExpiry(record) {
    const previous = record.nextExpiryAt
    const next = this.#recordExpiryAt(record)
    record.nextExpiryAt = next
    if (previous === null && next !== null) this.#expirableRecords++
    if (previous !== null && next === null) this.#expirableRecords--
    if (next !== null && (this.#nextGlobalSweepAt === null || next < this.#nextGlobalSweepAt)) {
      this.#nextGlobalSweepAt = next
    }
    if (this.#expirableRecords === 0) this.#nextGlobalSweepAt = null
  }

  #recordExpiryAt(record) {
    let next = null
    const include = (expiresAt) => {
      if (expiresAt !== undefined && (next === null || expiresAt < next)) next = expiresAt
    }
    for (const evidence of record.publicEvidence.values()) include(evidence.expiresAt)
    for (const route of record.routeEpochs.values()) {
      if (route.provenance === PRIVACY_PROVENANCE.ROUTE_ENTRY) include(route.expiresAt)
      include(route.privateOnlyExpiresAt)
      for (const circuit of route.circuits?.values() ?? []) include(circuit.expiresAt)
    }
    return next
  }

  #recomputeExpiryWatermark() {
    this.#nextGlobalSweepAt = null
    this.#expirableRecords = 0
    for (const record of this.#records.values()) {
      if (record.quarantined) continue
      record.nextExpiryAt = this.#recordExpiryAt(record)
      if (record.nextExpiryAt === null) continue
      this.#expirableRecords++
      if (this.#nextGlobalSweepAt === null || record.nextExpiryAt < this.#nextGlobalSweepAt) {
        this.#nextGlobalSweepAt = record.nextExpiryAt
      }
    }
  }

  #quarantine(record) {
    if (record.nextExpiryAt !== null) this.#expirableRecords--
    record.provenance.clear()
    record.publicEvidence.clear()
    for (const route of record.routeEpochs.values()) route.circuits?.clear()
    record.routeEpochs.clear()
    delete record.provenance
    delete record.publicEvidence
    delete record.routeEpochs
    delete record.nextExpiryAt
    record.quarantined = true
    if (this.#expirableRecords === 0) this.#nextGlobalSweepAt = null
  }

  #isEmpty(record) {
    return record.publicEvidence.size === 0 && record.routeEpochs.size === 0
  }

  #allowsRouteForward(record, context, current) {
    const epoch = exactContextValue(context, 'epoch')
    if (!u64(epoch)) return false
    for (const route of record.routeEpochs.values()) {
      if (epoch !== route.epoch) continue
      const liveRouteEntry =
        route.provenance === PRIVACY_PROVENANCE.ROUTE_ENTRY && route.expiresAt > current
      const livePrivateOnly =
        route.privateOnlyExpiresAt !== undefined && route.privateOnlyExpiresAt > current
      if (liveRouteEntry || livePrivateOnly) return true
    }
    return false
  }
}
