import b4a from 'b4a'

import { ERROR_CODES, cryptoSuite, decodeTopologyGrant } from '../../index.js'
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
  for (const role of roles) {
    const projection = fixture.projections.get(role)
    if (!object(projection) || projection.role !== role || !object(projection.bind)) invalid()
    expected.set(role, projection)
    frames.set(role, encodeControlFrame({ command: CONTROL_COMMAND.CONFIGURE, projection }))
    fingerprints.set(role, projection.grants.map(grantFingerprint).sort())
    addresses.push(projection.bind.host)
    if (projection.negativeControl) {
      addresses.push(projection.negativeControl.bind.host, projection.negativeControl.target.host)
    }
  }

  const auditConfiguration = (role, projection, serialized) => {
    if (!expected.has(role) || !b4a.isBuffer(serialized)) invalid()
    const allowed = expected.get(role)
    if (!sameCanonical(projection, allowed)) invalid('semantic projection mismatch')
    if (!b4a.equals(serialized, frames.get(role))) invalid('serialized projection mismatch')
    if ('path' in projection || 'projections' in projection || 'addresses' in projection) invalid()
    if (!Array.isArray(projection.known) || !Array.isArray(projection.contacts)) invalid()
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
          !record.runtimeVersion.startsWith('v') ||
          (record.adapter !== 'node-process' && record.adapter !== 'bare-process') ||
          record.udxVersion !== '1.20.7' ||
          !sameCanonical(record.codecVectors, codecVectors)
        ) {
          invalid()
        }
        break
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
          !record.runtimeVersion.startsWith('v') ||
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
        exactKeys(record, ['event', 'role', 'state', 'code'])
        if (!SNAPSHOT_STATES.has(record.state) || !ERROR_CODES.includes(record.code)) invalid()
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
