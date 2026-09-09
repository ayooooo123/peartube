import b4a from 'b4a'

import {
  ERROR_CODES,
  CAPABILITY,
  DOMAIN,
  LINK_OPERATION,
  PROTOCOL_VERSION,
  ROLE,
  TOPOLOGY_ROLE,
  cryptoSuite,
  decodeRelayAdvertisement,
  decodeTopologyGrant,
  encodeUnsignedRelayAdvertisement,
  verifyTopologyGrant
} from '../../index.js'
import {
  CONTROL_COMMAND,
  CONTROL_EVENT,
  ControlFrameDecoder,
  encodeCanonical,
  encodeControlFrame
} from './control-channel.js'
import { createProcessCodecVectors } from './codec-vectors.js'

const SNAPSHOT_STATES = new Set([
  'NEW',
  'STARTING',
  'READY',
  'CONNECTING',
  'OPEN',
  'FAILED',
  'CLOSING',
  'CLOSED'
])
const ERROR_PHASES = new Set([
  'configured',
  'transport-start',
  'transport-connect',
  'private-register',
  'destination-register',
  'destination-receive',
  'destination-send',
  'source-register',
  'source-activate',
  'source-send',
  'source-receive'
])
const ROLE_POLICY = Object.freeze({
  source: Object.freeze({
    topologyRole: TOPOLOGY_ROLE.SOURCE,
    known: Object.freeze(['source', 'safety-guard', 'safety-final', 'private-entry']),
    contacts: Object.freeze(['safety-guard'])
  }),
  'safety-guard': Object.freeze({
    topologyRole: TOPOLOGY_ROLE.SAFETY_GUARD,
    known: Object.freeze(['source', 'safety-guard', 'safety-final']),
    contacts: Object.freeze(['source', 'safety-final'])
  }),
  'safety-final': Object.freeze({
    topologyRole: TOPOLOGY_ROLE.SAFETY_FINAL,
    known: Object.freeze(['safety-guard', 'safety-final', 'private-entry']),
    contacts: Object.freeze(['safety-guard', 'private-entry'])
  }),
  'private-entry': Object.freeze({
    topologyRole: TOPOLOGY_ROLE.PRIVATE_ENTRY,
    known: Object.freeze(['safety-final', 'private-entry', 'private-middle']),
    contacts: Object.freeze(['safety-final', 'private-middle'])
  }),
  'private-middle': Object.freeze({
    topologyRole: TOPOLOGY_ROLE.PRIVATE_MIDDLE,
    known: Object.freeze(['private-entry', 'private-middle', 'private-final']),
    contacts: Object.freeze(['private-entry', 'private-final'])
  }),
  'private-final': Object.freeze({
    topologyRole: TOPOLOGY_ROLE.PRIVATE_FINAL,
    known: Object.freeze(['private-middle', 'private-final', 'destination']),
    contacts: Object.freeze(['private-middle', 'destination'])
  }),
  destination: Object.freeze({
    topologyRole: TOPOLOGY_ROLE.DESTINATION,
    known: Object.freeze(['destination', 'private-entry', 'private-middle', 'private-final']),
    contacts: Object.freeze(['private-final'])
  })
})

function invalid(message = 'configuration audit failed') {
  throw new Error(message)
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, expected) {
  if (!object(value)) invalid()
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  if (actual.length !== keys.length) invalid()
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== keys[index]) invalid()
  }
}

function nonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function runtimeVersion(value) {
  return (
    typeof value === 'string' &&
    /^v(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})$/.test(value)
  )
}

function exactRoleSet(values, expected) {
  if (!Array.isArray(values) || values.length !== expected.length) invalid()
  const actual = values.map((value) => value?.role).sort()
  const allowed = [...expected].sort()
  if (!sameCanonical(actual, allowed)) invalid('role policy mismatch')
}

function fixedBuffer(value, size) {
  if (!b4a.isBuffer(value) || value.byteLength !== size) invalid()
}

function sizedBuffer(value, minimum, maximum) {
  if (!b4a.isBuffer(value) || value.byteLength < minimum || value.byteLength > maximum) invalid()
}

function unsigned(value) {
  return typeof value === 'bigint' && value >= 0n
}

function address(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 45) invalid()
  const parts = value.split('.')
  if (
    parts.length !== 4 ||
    parts.some(
      (part) => !/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) < 0 || Number(part) > 255
    )
  ) {
    invalid()
  }
}

function port(value) {
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 65_535) invalid()
}

function auditAdvertisement(encoding, role, projection, relayRole) {
  sizedBuffer(encoding, 1, 1_024)
  let advertisement
  let unsignedEncoding = null
  let signedEncoding = null
  let domain = null
  try {
    advertisement = decodeRelayAdvertisement(encoding)
    exactKeys(advertisement, [
      'version',
      'identityKey',
      'routeEncryptionKey',
      'dial',
      'role',
      'capabilities',
      'epoch',
      'expiresAt',
      'relaySignature'
    ])
    fixedBuffer(advertisement.identityKey, 32)
    fixedBuffer(advertisement.routeEncryptionKey, 32)
    sizedBuffer(advertisement.dial, 1, 255)
    fixedBuffer(advertisement.relaySignature, 64)
    if (
      advertisement.version !== PROTOCOL_VERSION ||
      advertisement.role !== relayRole ||
      advertisement.capabilities !== CAPABILITY.KNOWN ||
      advertisement.epoch !== projection.epoch ||
      !unsigned(advertisement.epoch) ||
      !unsigned(advertisement.expiresAt) ||
      advertisement.expiresAt === 0n ||
      !b4a.equals(advertisement.identityKey, projection.local.identity32) ||
      !b4a.equals(advertisement.routeEncryptionKey, projection.local.routeEncryptionKey) ||
      b4a.toString(advertisement.dial) !== `live-route-${role}`
    ) {
      invalid()
    }
    unsignedEncoding = encodeUnsignedRelayAdvertisement(advertisement)
    domain = DOMAIN.RELAY_ADVERTISEMENT
    signedEncoding = b4a.concat([domain, unsignedEncoding])
    if (
      !cryptoSuite.verify(signedEncoding, advertisement.relaySignature, advertisement.identityKey)
    ) {
      invalid()
    }
  } catch {
    invalid()
  } finally {
    if (domain) domain.fill(0)
    if (signedEncoding) signedEncoding.fill(0)
    if (unsignedEncoding) unsignedEncoding.fill(0)
  }
}

function auditPayload(value) {
  exactKeys(value, [
    'descriptorId',
    'circuitId',
    'forwardKey',
    'forwardNoncePrefix',
    'reverseKey',
    'reverseNoncePrefix'
  ])
  fixedBuffer(value.descriptorId, 32)
  fixedBuffer(value.circuitId, 16)
  fixedBuffer(value.forwardKey, 32)
  fixedBuffer(value.forwardNoncePrefix, 16)
  fixedBuffer(value.reverseKey, 32)
  fixedBuffer(value.reverseNoncePrefix, 16)
}

function auditTraffic(value, sizes) {
  exactKeys(value, ['sendStream', 'sendDatagram', 'expectStream', 'expectDatagram'])
  fixedBuffer(value.sendStream, sizes.sendStream)
  fixedBuffer(value.sendDatagram, sizes.sendDatagram)
  fixedBuffer(value.expectStream, sizes.expectStream)
  fixedBuffer(value.expectDatagram, sizes.expectDatagram)
}

function auditSourceRoute(route, projections) {
  exactKeys(route, [
    'safetyAdvertisements',
    'entryActorId',
    'descriptor',
    'registrationCapsule',
    'prepareCapsule',
    'finalizeCapsule',
    'abortCapsule',
    'registrations',
    'activation',
    'payload',
    'traffic'
  ])
  if (!Array.isArray(route.safetyAdvertisements) || route.safetyAdvertisements.length !== 2)
    invalid()
  for (const [index, safetyRole] of ['safety-guard', 'safety-final'].entries()) {
    auditAdvertisement(
      route.safetyAdvertisements[index],
      safetyRole,
      projections.get(safetyRole),
      ROLE.SAFETY
    )
    if (
      !b4a.equals(
        route.safetyAdvertisements[index],
        projections.get(safetyRole).route.advertisement
      )
    )
      invalid()
  }
  fixedBuffer(route.entryActorId, 16)
  if (!b4a.equals(route.entryActorId, projections.get('private-entry').route.actorId)) invalid()
  fixedBuffer(route.descriptor, 1_272)
  fixedBuffer(route.registrationCapsule, 2_758)
  fixedBuffer(route.prepareCapsule, 258)
  fixedBuffer(route.finalizeCapsule, 258)
  fixedBuffer(route.abortCapsule, 258)
  if (!Array.isArray(route.registrations) || route.registrations.length !== 3) invalid()
  for (const registration of route.registrations) {
    exactKeys(registration, ['message'])
    fixedBuffer(registration.message, 290)
  }
  for (const [index, privateRole] of [
    'private-entry',
    'private-middle',
    'private-final'
  ].entries()) {
    if (
      !b4a.equals(
        route.registrations[index].message,
        projections.get(privateRole).route.registration.message
      )
    ) {
      invalid()
    }
  }
  exactKeys(route.activation, [
    'body',
    'circuitId',
    'generation',
    'entryIdentity',
    'entryRouteEncryptionKey',
    'endpointIdentity',
    'routeSigningKey',
    'destinationRouteEncryptionKey',
    'sourceEphemeralSecretKey',
    'entryChallenge',
    'destinationChallenge'
  ])
  fixedBuffer(route.activation.body, 1_130)
  fixedBuffer(route.activation.circuitId, 16)
  if (!unsigned(route.activation.generation) || route.activation.generation === 0n) invalid()
  for (const key of [
    'entryIdentity',
    'entryRouteEncryptionKey',
    'endpointIdentity',
    'routeSigningKey',
    'destinationRouteEncryptionKey',
    'sourceEphemeralSecretKey',
    'entryChallenge',
    'destinationChallenge'
  ]) {
    fixedBuffer(route.activation[key], 32)
  }
  const entry = projections.get('private-entry')
  const destination = projections.get('destination')
  const source = projections.get('source')
  if (
    !b4a.equals(route.activation.circuitId, source.linkCircuitId) ||
    !b4a.equals(route.activation.entryIdentity, entry.local.identity32) ||
    !b4a.equals(route.activation.entryRouteEncryptionKey, entry.local.routeEncryptionKey) ||
    !b4a.equals(route.activation.endpointIdentity, destination.local.identity32) ||
    !b4a.equals(route.activation.routeSigningKey, destination.route.routeSigningKey) ||
    !b4a.equals(
      route.activation.destinationRouteEncryptionKey,
      destination.local.routeEncryptionKey
    )
  ) {
    invalid()
  }
  auditPayload(route.payload)
  if (
    !b4a.equals(route.payload.circuitId, route.activation.circuitId) ||
    !b4a.equals(route.payload.descriptorId, destination.route.descriptorId) ||
    !sameCanonical(route.payload, destination.route.payload)
  ) {
    invalid()
  }
  auditTraffic(route.traffic, {
    sendStream: 38,
    sendDatagram: 257,
    expectStream: 43,
    expectDatagram: 263
  })
}

function auditPrivateRoute(role, route, projection) {
  exactKeys(route, ['actorId', 'advertisement', 'registration'])
  fixedBuffer(route.actorId, 16)
  auditAdvertisement(route.advertisement, role, projection, ROLE.PRIVATE)
  exactKeys(route.registration, ['message', 'sealedTemplate'])
  fixedBuffer(route.registration.message, 290)
  const sealedSize = role === 'private-entry' ? 870 : role === 'private-middle' ? 541 : 213
  fixedBuffer(route.registration.sealedTemplate, sealedSize)
}

function auditDestinationRoute(route, projections) {
  exactKeys(route, [
    'actorId',
    'descriptorId',
    'routeSigningKey',
    'routeSigningSecretKey',
    'routeEncryptionKey',
    'routeEncryptionSecretKey',
    'finalToken',
    'privateAdvertisements',
    'payload',
    'traffic'
  ])
  fixedBuffer(route.actorId, 16)
  fixedBuffer(route.descriptorId, 32)
  fixedBuffer(route.routeSigningKey, 32)
  fixedBuffer(route.routeSigningSecretKey, 64)
  fixedBuffer(route.routeEncryptionKey, 32)
  fixedBuffer(route.routeEncryptionSecretKey, 32)
  fixedBuffer(route.finalToken, 64)
  const projection = projections.get('destination')
  if (
    !b4a.equals(route.routeSigningKey, projection.local.identity32) ||
    !b4a.equals(route.routeSigningSecretKey, projection.local.identitySecretKey) ||
    !b4a.equals(route.routeEncryptionKey, projection.local.routeEncryptionKey) ||
    !b4a.equals(route.routeEncryptionSecretKey, projection.local.routeEncryptionSecretKey)
  ) {
    invalid()
  }
  if (!Array.isArray(route.privateAdvertisements) || route.privateAdvertisements.length !== 3)
    invalid()
  for (const [index, privateRole] of [
    'private-entry',
    'private-middle',
    'private-final'
  ].entries()) {
    const privateProjection = projections.get(privateRole)
    auditAdvertisement(
      route.privateAdvertisements[index],
      privateRole,
      privateProjection,
      ROLE.PRIVATE
    )
    if (!b4a.equals(route.privateAdvertisements[index], privateProjection.route.advertisement))
      invalid()
  }
  auditPayload(route.payload)
  if (!b4a.equals(route.payload.descriptorId, route.descriptorId)) invalid()
  auditTraffic(route.traffic, {
    sendStream: 43,
    sendDatagram: 263,
    expectStream: 38,
    expectDatagram: 257
  })
}

function auditProjectionSchema(role, projection, projections) {
  exactKeys(projection, [
    'version',
    'role',
    'topologyRole',
    'bind',
    'local',
    'linkAuthorityPublicKey',
    'epoch',
    'runId32',
    'linkCircuitId',
    'known',
    'contacts',
    'grants',
    'route',
    ...(projection.negativeControl === undefined ? [] : ['negativeControl'])
  ])
  exactKeys(projection.bind, ['host', 'port'])
  address(projection.bind.host)
  port(projection.bind.port)
  exactKeys(
    projection.local,
    role === 'source'
      ? ['identity32', 'identitySecretKey']
      : ['identity32', 'identitySecretKey', 'routeEncryptionKey', 'routeEncryptionSecretKey']
  )
  fixedBuffer(projection.local.identity32, 32)
  fixedBuffer(projection.local.identitySecretKey, 64)
  if (role !== 'source') {
    fixedBuffer(projection.local.routeEncryptionKey, 32)
    fixedBuffer(projection.local.routeEncryptionSecretKey, 32)
  }
  fixedBuffer(projection.linkAuthorityPublicKey, 32)
  if (!unsigned(projection.epoch)) invalid()
  fixedBuffer(projection.runId32, 32)
  fixedBuffer(projection.linkCircuitId, 16)
  if (!Array.isArray(projection.known)) invalid()
  for (const value of projection.known) {
    exactKeys(value, ['role', 'identity32'])
    fixedBuffer(value.identity32, 32)
  }
  if (!Array.isArray(projection.contacts)) invalid()
  for (const value of projection.contacts) {
    exactKeys(value, ['role', 'identity32', 'routeEncryptionKey', 'actorId'])
    fixedBuffer(value.identity32, 32)
    if (value.routeEncryptionKey !== null) fixedBuffer(value.routeEncryptionKey, 32)
    if (value.actorId !== null) fixedBuffer(value.actorId, 16)
  }
  if (!Array.isArray(projection.grants) || projection.grants.length !== projection.contacts.length)
    invalid()
  for (const grant of projection.grants) sizedBuffer(grant, 1, 1_024)
  if (role === 'source') auditSourceRoute(projection.route, projections)
  else if (role === 'safety-guard' || role === 'safety-final') {
    exactKeys(projection.route, ['advertisement'])
    auditAdvertisement(projection.route.advertisement, role, projection, ROLE.SAFETY)
  } else if (role.startsWith('private-')) auditPrivateRoute(role, projection.route, projection)
  else auditDestinationRoute(projection.route, projections)
  if (projection.negativeControl !== undefined) {
    if (role !== 'source') invalid()
    exactKeys(projection.negativeControl, ['bind', 'target', 'payload'])
    exactKeys(projection.negativeControl.bind, ['host', 'port'])
    exactKeys(projection.negativeControl.target, ['host', 'port'])
    address(projection.negativeControl.bind.host)
    port(projection.negativeControl.bind.port)
    address(projection.negativeControl.target.host)
    port(projection.negativeControl.target.port)
    sizedBuffer(projection.negativeControl.payload, 1, 1_200)
  }
}

function roleForIdentity(identity, identities) {
  for (const [role, expected] of identities) if (b4a.equals(identity, expected)) return role
  invalid()
}

function auditGrantPolicy(projection, identities, projections) {
  const peerRoles = new Set()
  for (const encoding of projection.grants) {
    const grant = decodeTopologyGrant(encoding)
    verifyTopologyGrant(encoding, projection.linkAuthorityPublicKey, {
      localIdentity32: projection.local.identity32,
      now: grant.notBefore
    })
    fixedBuffer(grant.grantId32, 32)
    fixedBuffer(grant.runId32, 32)
    fixedBuffer(grant.signature, 64)
    if (
      grant.version !== PROTOCOL_VERSION ||
      grant.format !== 0 ||
      grant.epoch !== projection.epoch ||
      grant.expiresAt <= grant.notBefore ||
      !b4a.equals(grant.runId32, projection.runId32)
    ) {
      invalid()
    }
    const operations = new Set()
    const endpointRoles = []
    for (const key of ['endpointA', 'endpointB']) {
      const endpoint = grant[key]
      const role = roleForIdentity(endpoint.identity32, identities)
      const expected = projections.get(role)
      endpointRoles.push(role)
      if (
        endpoint.role !== ROLE_POLICY[role].topologyRole ||
        endpoint.host !== expected.bind.host ||
        endpoint.port !== expected.bind.port ||
        (endpoint.operations !== LINK_OPERATION.INITIATE &&
          endpoint.operations !== LINK_OPERATION.ACCEPT)
      ) {
        invalid()
      }
      operations.add(endpoint.operations)
    }
    if (operations.size !== 2) invalid()
    const peerRole = endpointRoles.find((role) => role !== projection.role)
    if (
      !endpointRoles.includes(projection.role) ||
      !peerRole ||
      !ROLE_POLICY[projection.role].contacts.includes(peerRole)
    ) {
      invalid()
    }
    if (peerRoles.has(peerRole)) invalid()
    peerRoles.add(peerRole)
    const bilateralCopies = projections
      .get(peerRole)
      .grants.filter((peerEncoding) => b4a.equals(peerEncoding, encoding))
    if (bilateralCopies.length !== 1) invalid()
  }
  if (!sameCanonical([...peerRoles].sort(), [...ROLE_POLICY[projection.role].contacts].sort())) {
    invalid()
  }
}

function sameCanonical(left, right) {
  let leftBytes = null
  let rightBytes = null
  try {
    leftBytes = encodeCanonical(left)
    rightBytes = encodeCanonical(right)
    return b4a.equals(leftBytes, rightBytes)
  } finally {
    if (leftBytes) leftBytes.fill(0)
    if (rightBytes) rightBytes.fill(0)
  }
}

function grantFingerprint(encoding) {
  const digest = cryptoSuite.hash([b4a.from('private-route-process-link-v0'), encoding])
  const fingerprint = b4a.toString(digest.subarray(0, 8), 'hex')
  digest.fill(0)
  return fingerprint
}

function noRawAddresses(value, addresses) {
  const encoded = encodeCanonical(value)
  try {
    const text = b4a.toString(encoded)
    for (const address of addresses) if (text.includes(address)) invalid('raw address leak')
  } finally {
    encoded.fill(0)
  }
}

function auditSnapshotShape(record, expectedRole, expectedFingerprints, addresses) {
  exactKeys(record, ['event', 'role', 'state', 'links', 'counters', 'fingerprints', 'resources'])
  if (
    record.role !== expectedRole ||
    !SNAPSHOT_STATES.has(record.state) ||
    !nonnegative(record.links) ||
    !Array.isArray(record.fingerprints) ||
    !sameCanonical(record.fingerprints, expectedFingerprints)
  ) {
    invalid()
  }
  exactKeys(record.counters, ['queuedPackets', 'queuedBytes', 'inFlightSends'])
  exactKeys(record.resources, ['bindings', 'waits', 'timers', 'openSockets'])
  for (const value of Object.values(record.counters)) if (!nonnegative(value)) invalid()
  for (const value of Object.values(record.resources)) if (!nonnegative(value)) invalid()
  noRawAddresses(record, addresses)
}

export function createConfigurationAuditor(fixture) {
  if (!object(fixture) || !(fixture.projections instanceof Map) || !Array.isArray(fixture.roles)) {
    invalid()
  }
  const roles = [...fixture.roles]
  const expected = new Map()
  const frames = new Map()
  const fingerprints = new Map()
  const codecVectors = createProcessCodecVectors()
  const addresses = []
  const identities = new Map()
  const policyRoles = Object.keys(ROLE_POLICY)
  if (
    roles.length !== policyRoles.length ||
    !sameCanonical([...roles].sort(), policyRoles.sort())
  ) {
    invalid('role policy mismatch')
  }
  for (const role of roles) {
    const projection = fixture.projections.get(role)
    if (!object(projection) || projection.role !== role || !object(projection.bind)) invalid()
    if (!ROLE_POLICY[role]) invalid()
    identities.set(role, projection.local?.identity32)
  }
  const authorityKey = fixture.projections.get(roles[0]).linkAuthorityPublicKey
  for (const role of roles) {
    const projection = fixture.projections.get(role)
    auditProjectionSchema(role, projection, fixture.projections)
    exactRoleSet(projection.known, ROLE_POLICY[role].known)
    exactRoleSet(projection.contacts, ROLE_POLICY[role].contacts)
    if (
      projection.topologyRole !== ROLE_POLICY[role].topologyRole ||
      !b4a.equals(projection.linkAuthorityPublicKey, authorityKey)
    ) {
      invalid('role policy mismatch')
    }
    auditGrantPolicy(projection, identities, fixture.projections)
    expected.set(role, projection)
    frames.set(role, encodeControlFrame({ command: CONTROL_COMMAND.CONFIGURE, projection }))
    fingerprints.set(role, projection.grants.map(grantFingerprint).sort())
    addresses.push(projection.bind.host)
    if (projection.negativeControl) {
      addresses.push(projection.negativeControl.bind.host, projection.negativeControl.target.host)
    }
  }
  for (const role of roles) {
    const projection = expected.get(role)
    for (const value of [...projection.known, ...projection.contacts]) {
      if (!b4a.equals(value.identity32, identities.get(value.role)))
        invalid('identity policy mismatch')
    }
    for (const contact of projection.contacts) {
      const peer = expected.get(contact.role)
      const expectedRouteEncryptionKey = peer.local.routeEncryptionKey || null
      const expectedActorId = peer.route.actorId || null
      if (
        (contact.routeEncryptionKey === null) !== (expectedRouteEncryptionKey === null) ||
        (contact.actorId === null) !== (expectedActorId === null) ||
        (contact.routeEncryptionKey !== null &&
          !b4a.equals(contact.routeEncryptionKey, expectedRouteEncryptionKey)) ||
        (contact.actorId !== null && !b4a.equals(contact.actorId, expectedActorId))
      ) {
        invalid('contact policy mismatch')
      }
    }
  }

  const auditConfiguration = (role, projection, serialized) => {
    if (!expected.has(role) || !b4a.isBuffer(serialized)) invalid()
    const allowed = expected.get(role)
    if (!sameCanonical(projection, allowed)) invalid('semantic projection mismatch')
    if (!b4a.equals(serialized, frames.get(role))) invalid('serialized projection mismatch')
    if ('path' in projection || 'projections' in projection || 'addresses' in projection) invalid()
    if (!Array.isArray(projection.known) || !Array.isArray(projection.contacts)) invalid()
    auditProjectionSchema(role, projection, expected)
    exactRoleSet(projection.known, ROLE_POLICY[role].known)
    exactRoleSet(projection.contacts, ROLE_POLICY[role].contacts)
    const allowedKnown = new Set(
      allowed.known.map((value) => b4a.toString(value.identity32, 'hex'))
    )
    for (const value of projection.known) {
      if (!allowedKnown.has(b4a.toString(value.identity32, 'hex'))) invalid()
    }
    const allowedContacts = new Set(
      allowed.contacts.map((value) => b4a.toString(value.identity32, 'hex'))
    )
    for (const encoding of projection.grants) {
      const grant = decodeTopologyGrant(encoding)
      const endpoints = [grant.endpointA.identity32, grant.endpointB.identity32]
      const localIndex = endpoints.findIndex((identity) =>
        b4a.equals(identity, projection.local.identity32)
      )
      if (localIndex === -1) invalid()
      if (!allowedContacts.has(b4a.toString(endpoints[1 - localIndex], 'hex'))) invalid()
    }
    if (projection.grants.length !== allowedContacts.size) invalid()
    const decoder = new ControlFrameDecoder()
    try {
      const commands = decoder.push(serialized)
      if (
        commands.length !== 1 ||
        commands[0].command !== CONTROL_COMMAND.CONFIGURE ||
        !sameCanonical(commands[0].projection, allowed)
      ) {
        invalid()
      }
    } finally {
      decoder.destroy()
    }
    return Object.freeze({
      role,
      fingerprints: Object.freeze([...fingerprints.get(role)]),
      bytes: serialized.byteLength
    })
  }

  const auditEvent = (role, record) => {
    if (!expected.has(role) || !object(record) || record.role !== role) invalid()
    switch (record.event) {
      case CONTROL_EVENT.CONFIGURED:
        exactKeys(record, [
          'event',
          'role',
          'state',
          'runtime',
          'runtimeVersion',
          'adapter',
          'udxVersion',
          'codecVectors'
        ])
        if (
          record.state !== 'CONFIGURED' ||
          (record.runtime !== 'node' && record.runtime !== 'bare') ||
          typeof record.runtimeVersion !== 'string' ||
          !runtimeVersion(record.runtimeVersion) ||
          (record.runtime === 'node') !== (record.adapter === 'node-process') ||
          (record.adapter !== 'node-process' && record.adapter !== 'bare-process') ||
          record.udxVersion !== '1.20.7' ||
          !sameCanonical(record.codecVectors, codecVectors)
        ) {
          invalid()
        }
        break
      case CONTROL_EVENT.PREPARED: {
        const snapshot = { ...record }
        for (const key of [
          'runtime',
          'runtimeVersion',
          'adapter',
          'udxVersion',
          'codecVectors',
          'milestone'
        ])
          delete snapshot[key]
        exactKeys(record, [
          'event',
          'role',
          'state',
          'links',
          'counters',
          'fingerprints',
          'resources',
          'runtime',
          'runtimeVersion',
          'adapter',
          'udxVersion',
          'codecVectors',
          'milestone'
        ])
        if (
          !runtimeVersion(record.runtimeVersion) ||
          (record.runtime !== 'node' && record.runtime !== 'bare') ||
          (record.runtime === 'node') !== (record.adapter === 'node-process') ||
          record.udxVersion !== '1.20.7' ||
          !sameCanonical(record.codecVectors, codecVectors) ||
          record.milestone !==
            (role.startsWith('private-') || role === 'destination'
              ? 'actor-registered'
              : 'transport-open')
        )
          invalid()
        auditSnapshotShape(snapshot, role, fingerprints.get(role), addresses)
        if (record.state !== 'OPEN') invalid()
        break
      }
      case CONTROL_EVENT.READY: {
        const snapshot = { ...record }
        delete snapshot.runtime
        delete snapshot.runtimeVersion
        delete snapshot.adapter
        delete snapshot.udxVersion
        delete snapshot.codecVectors
        delete snapshot.milestone
        delete snapshot.traffic
        exactKeys(record, [
          'event',
          'role',
          'state',
          'links',
          'counters',
          'fingerprints',
          'resources',
          'runtime',
          'runtimeVersion',
          'adapter',
          'udxVersion',
          'codecVectors',
          'milestone',
          'traffic'
        ])
        exactKeys(record.traffic, ['streamBytes', 'datagramBytes'])
        if (
          (record.runtime !== 'node' && record.runtime !== 'bare') ||
          typeof record.runtimeVersion !== 'string' ||
          !runtimeVersion(record.runtimeVersion) ||
          (record.runtime === 'node') !== (record.adapter === 'node-process') ||
          (record.adapter !== 'node-process' && record.adapter !== 'bare-process') ||
          record.udxVersion !== '1.20.7' ||
          !sameCanonical(record.codecVectors, codecVectors) ||
          record.milestone !==
            (role === 'source'
              ? 'created-and-traffic-verified'
              : role === 'destination'
                ? 'traffic-exchanged'
                : role.startsWith('private-')
                  ? 'actor-registered'
                  : 'transport-open') ||
          !nonnegative(record.traffic.streamBytes) ||
          !nonnegative(record.traffic.datagramBytes) ||
          ((role === 'source' || role === 'destination') &&
            (record.traffic.streamBytes === 0 || record.traffic.datagramBytes === 0)) ||
          (role !== 'source' &&
            role !== 'destination' &&
            (record.traffic.streamBytes !== 0 || record.traffic.datagramBytes !== 0))
        ) {
          invalid()
        }
        auditSnapshotShape(snapshot, role, fingerprints.get(role), addresses)
        if (record.state !== 'OPEN') invalid()
        break
      }
      case CONTROL_EVENT.SNAPSHOT:
      case CONTROL_EVENT.CLOSED:
        auditSnapshotShape(record, role, fingerprints.get(role), addresses)
        if (record.event === CONTROL_EVENT.CLOSED && record.state !== 'CLOSED') invalid()
        break
      case CONTROL_EVENT.RETRY:
        exactKeys(record, ['event', 'role', 'code', 'negativeControlInvocations'])
        if (
          role !== 'source' ||
          !expected.get(role).negativeControl ||
          record.code !== 'ROUTE_UNAVAILABLE' ||
          record.negativeControlInvocations !== 0
        ) {
          invalid()
        }
        break
      case CONTROL_EVENT.ERROR:
        exactKeys(record, ['event', 'role', 'state', 'code', 'phase'])
        if (
          !SNAPSHOT_STATES.has(record.state) ||
          !ERROR_CODES.includes(record.code) ||
          !ERROR_PHASES.has(record.phase)
        )
          invalid()
        break
      default:
        invalid()
    }
    noRawAddresses(record, addresses)
    return true
  }

  const auditDiagnostic = (role, record) => {
    exactKeys(record, ['role', 'code'])
    if (record.role !== role || !ERROR_CODES.includes(record.code)) invalid()
    noRawAddresses(record, addresses)
    return true
  }

  const destroy = () => {
    for (const frame of frames.values()) frame.fill(0)
    frames.clear()
    expected.clear()
    fingerprints.clear()
  }

  return Object.freeze({ auditConfiguration, auditEvent, auditDiagnostic, destroy })
}
