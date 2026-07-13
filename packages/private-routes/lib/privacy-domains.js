import b4a from 'b4a'

import { isCircuitChecker } from './circuit-authority.js'
import { isVerifiedDescriptor, readVerifiedDescriptor } from './descriptor.js'
import { isDiscoveryEvidenceChecker } from './discovery-evidence.js'
import { PrivateRouteError } from './errors.js'
import { ROLE, roleForIdentity } from './protocol.js'

const MAX_U64 = 0xffff_ffff_ffff_ffffn

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

function fixed(value, size) {
  return b4a.isBuffer(value) && value.byteLength === size
}

function u64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_U64
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
  #records = new Map()

  constructor({ evidenceChecker, descriptorChecker, circuitChecker, now } = {}) {
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
    this.#evidenceChecker = evidenceChecker
    this.#descriptorChecker = descriptorChecker
    this.#circuitChecker = circuitChecker
    this.#now = now
  }

  #record(identity) {
    const key = identityHex(identity)
    let record = this.#records.get(key)
    if (!record) {
      record = {
        identity: b4a.from(identity),
        provenance: new Set(),
        publicEvidence: new Map(),
        routeEpochs: new Map(),
        caps: new Map(),
        quarantined: false
      }
      this.#records.set(key, record)
    }
    return record
  }

  learnPublic(evidence) {
    if (!this.#evidenceChecker.isVerified(evidence)) unauthorized()
    let state
    try {
      state = this.#evidenceChecker.read(evidence)
    } catch {
      unauthorized()
    }
    if (!validEvidence(state) || state.expiresAt <= currentTime(this.#now)) unauthorized()

    const record = this.#record(state.peerIdentity32)
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
      record.quarantined = true
      return
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
      expiresAt: state.expiresAt
    })
  }

  learnRoute(identity, material) {
    const record = this.#record(identity)
    const current = currentTime(this.#now)
    if (!isObject(material)) invalidRoute()

    if (material.provenance === PRIVACY_PROVENANCE.PRIVATE_ONLY) {
      if (!exactKeys(material, ['provenance', 'epoch', 'expiresAt'])) invalidRoute()
      if (!u64(material.epoch) || !u64(material.expiresAt) || material.expiresAt <= current)
        invalidRoute()
      record.provenance.add(PRIVACY_PROVENANCE.PRIVATE_ONLY)
      record.routeEpochs.set(material.epoch, {
        provenance: PRIVACY_PROVENANCE.PRIVATE_ONLY,
        epoch: material.epoch,
        expiresAt: material.expiresAt
      })
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
      record.quarantined = true
      return
    }

    record.provenance.add(PRIVACY_PROVENANCE.ROUTE_ENTRY)
    let route = existing
    if (!route || route.provenance !== PRIVACY_PROVENANCE.ROUTE_ENTRY) {
      route = {
        provenance: PRIVACY_PROVENANCE.ROUTE_ENTRY,
        epoch: descriptor.entry.epoch,
        expiresAt: descriptor.expiresAt,
        dial: b4a.from(descriptor.entry.dial),
        routeEncryptionKey: b4a.from(descriptor.entry.routeEncryptionKey),
        capabilities: descriptor.entry.capabilities,
        role: descriptor.entry.role,
        circuits: new Map()
      }
      record.routeEpochs.set(descriptor.entry.epoch, route)
    } else if (descriptor.expiresAt > route.expiresAt) {
      route.expiresAt = descriptor.expiresAt
    }
    const binding = copyCircuit(circuit)
    route.circuits.set(circuitKey(binding), binding)
    record.caps.set(circuitKey(binding), binding)
  }

  allows(identity, operation, context) {
    if (!fixed(identity, 32)) return false
    const record = this.#records.get(b4a.toString(identity, 'hex'))
    if (!record || record.quarantined) return false
    const current = currentTime(this.#now)

    switch (operation) {
      case PRIVACY_OPERATION.GUARD_DIAL:
        return (
          context?.selectedGuard === true &&
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
        return context?.consumer === 'relay-discovery' && this.#hasLivePublic(record, current)
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

  #allowsRouteForward(record, context, current) {
    if (!exactKeys(context, ['epoch']) || !u64(context.epoch)) return false
    for (const route of record.routeEpochs.values()) {
      if (route.expiresAt <= current) continue
      if (context !== undefined && context.epoch !== route.epoch) continue
      if (
        route.provenance === PRIVACY_PROVENANCE.ROUTE_ENTRY ||
        route.provenance === PRIVACY_PROVENANCE.PRIVATE_ONLY
      ) {
        return true
      }
    }
    return false
  }
}
