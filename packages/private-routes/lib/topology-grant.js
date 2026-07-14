import b4a from 'b4a'

import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import {
  DOMAIN,
  LINK_OPERATION,
  PROTOCOL_VERSION,
  ROLE,
  TOPOLOGY_ROLE,
  roleForIdentity
} from './protocol.js'

export const TOPOLOGY_GRANT_FORMAT = 0
export const DEFAULT_MAX_TOPOLOGY_GRANTS = 16
export const DEFAULT_MAX_LINK_HANDLES = 16
export const TEST_ONLY_LINK_DIRECTORY_OBSERVER = Symbol('test-only-link-directory-observer')

const MAX_U64 = 0xffff_ffff_ffff_ffffn
const MAX_TIMER_DELAY = 0x7fff_ffff
const SIGNATURE_SIZE = 64
const MIN_UNSIGNED_SIZE = 175
const MAX_UNSIGNED_SIZE = 199
const VERIFIED_GRANTS = new WeakMap()
const LINK_HANDLES = new WeakMap()
const DIRECTORIES = new WeakMap()

function invalidRoute() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function unauthorized() {
  throw PrivateRouteError.UNAUTHORIZED()
}

function circuitLimit() {
  throw PrivateRouteError.CIRCUIT_LIMIT()
}

function circuitState() {
  throw PrivateRouteError.CIRCUIT_STATE()
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

function validU64(value) {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_U64
}

function copyEndpoint(value) {
  return {
    identity32: b4a.from(value.identity32),
    role: value.role,
    address: {
      family: value.address.family,
      host: value.address.host,
      port: value.address.port
    },
    operations: value.operations
  }
}

function publicEndpoint(value) {
  return {
    identity32: b4a.from(value.identity32),
    role: value.role,
    host: value.address.host,
    port: value.address.port,
    operations: value.operations
  }
}

function copyView(value) {
  return {
    digest32: b4a.from(value.digest32),
    encoding: b4a.from(value.encoding),
    grantId32: b4a.from(value.grantId32),
    local: copyEndpoint(value.local),
    peer: copyEndpoint(value.peer),
    epoch: value.epoch,
    notBefore: value.notBefore,
    expiresAt: value.expiresAt,
    runId32: b4a.from(value.runId32)
  }
}

function validateRole(role) {
  if (!Number.isInteger(role) || role < TOPOLOGY_ROLE.SOURCE || role > TOPOLOGY_ROLE.DESTINATION) {
    invalidRoute()
  }
}

function validateRoleBinding(identity32, role) {
  validateRole(role)
  if (role === TOPOLOGY_ROLE.SAFETY_GUARD || role === TOPOLOGY_ROLE.SAFETY_FINAL) {
    if (roleForIdentity(identity32) !== ROLE.SAFETY) unauthorized()
  } else if (
    role === TOPOLOGY_ROLE.PRIVATE_ENTRY ||
    role === TOPOLOGY_ROLE.PRIVATE_MIDDLE ||
    role === TOPOLOGY_ROLE.PRIVATE_FINAL
  ) {
    if (roleForIdentity(identity32) !== ROLE.PRIVATE) unauthorized()
  }
}

function parseIPv4(host) {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const bytes = b4a.allocUnsafe(4)
  for (let index = 0; index < parts.length; index++) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(parts[index])) return null
    const value = Number(parts[index])
    if (value > 255) return null
    bytes[index] = value
  }
  if (Array.from(bytes).join('.') !== host) return null
  return bytes
}

function canonicalIPv6(words) {
  let bestStart = -1
  let bestLength = 0
  for (let index = 0; index < words.length;) {
    if (words[index] !== 0) {
      index++
      continue
    }
    let end = index + 1
    while (end < words.length && words[end] === 0) end++
    const length = end - index
    if (length >= 2 && length > bestLength) {
      bestStart = index
      bestLength = length
    }
    index = end
  }

  const fields = words.map((word) => word.toString(16))
  if (bestStart === -1) return fields.join(':')
  const left = fields.slice(0, bestStart).join(':')
  const right = fields.slice(bestStart + bestLength).join(':')
  return `${left}::${right}`
}

function parseIPv6(host) {
  if (
    host.length === 0 ||
    host !== host.toLowerCase() ||
    host.includes('%') ||
    host.includes('.')
  ) {
    return null
  }
  const marker = host.indexOf('::')
  if (marker !== -1 && marker !== host.lastIndexOf('::')) return null

  const leftText = marker === -1 ? host : host.slice(0, marker)
  const rightText = marker === -1 ? '' : host.slice(marker + 2)
  const left = leftText === '' ? [] : leftText.split(':')
  const right = rightText === '' ? [] : rightText.split(':')
  if (left.some((part) => part === '') || right.some((part) => part === '')) return null
  if (marker === -1 ? left.length !== 8 : left.length + right.length >= 8) return null

  const words = []
  for (const part of left) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null
    words.push(Number.parseInt(part, 16))
  }
  if (marker !== -1) {
    while (words.length < 8 - right.length) words.push(0)
  }
  for (const part of right) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null
    words.push(Number.parseInt(part, 16))
  }
  if (words.length !== 8 || canonicalIPv6(words) !== host) return null

  const bytes = b4a.allocUnsafe(16)
  for (let index = 0; index < words.length; index++) {
    bytes[index * 2] = words[index] >>> 8
    bytes[index * 2 + 1] = words[index]
  }
  return bytes
}

function parseAddress(host) {
  if (typeof host !== 'string') invalidRoute()
  const ipv4 = parseIPv4(host)
  if (ipv4) return { family: 4, bytes: ipv4, host }
  const ipv6 = parseIPv6(host)
  if (ipv6) return { family: 6, bytes: ipv6, host }
  invalidRoute()
}

function hostFromAddress(family, bytes) {
  if (family === 4 && bytes.byteLength === 4) return Array.from(bytes).join('.')
  if (family === 6 && bytes.byteLength === 16) {
    const words = []
    for (let index = 0; index < 16; index += 2) words.push(bytes[index] * 0x100 + bytes[index + 1])
    return canonicalIPv6(words)
  }
  invalidRoute()
}

function normalizeEndpoint(value) {
  if (!exactKeys(value, ['identity32', 'role', 'host', 'port', 'operations'])) invalidRoute()
  if (!fixed(value.identity32, 32)) invalidRoute()
  validateRoleBinding(value.identity32, value.role)
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 0xffff) invalidRoute()
  if (
    !Number.isInteger(value.operations) ||
    value.operations < LINK_OPERATION.INITIATE ||
    (value.operations & ~LINK_OPERATION.KNOWN) !== 0
  ) {
    invalidRoute()
  }
  const address = parseAddress(value.host)
  return {
    identity32: b4a.from(value.identity32),
    role: value.role,
    address: { ...address, port: value.port },
    operations: value.operations
  }
}

function normalizeGrant(value, signed) {
  const fields = [
    'version',
    'format',
    'grantId32',
    'endpointA',
    'endpointB',
    'epoch',
    'notBefore',
    'expiresAt',
    'runId32'
  ]
  if (signed) fields.push('signature')
  if (!exactKeys(value, fields)) invalidRoute()
  if (value.version !== PROTOCOL_VERSION || value.format !== TOPOLOGY_GRANT_FORMAT) invalidRoute()
  if (!fixed(value.grantId32, 32) || !fixed(value.runId32, 32)) invalidRoute()
  if (!validU64(value.epoch) || !validU64(value.notBefore) || !validU64(value.expiresAt)) {
    invalidRoute()
  }
  if (value.notBefore >= value.expiresAt) invalidRoute()
  if (signed && !fixed(value.signature, SIGNATURE_SIZE)) invalidRoute()

  let endpointA = normalizeEndpoint(value.endpointA)
  let endpointB = normalizeEndpoint(value.endpointB)
  const ordering = b4a.compare(endpointA.identity32, endpointB.identity32)
  if (ordering === 0) invalidRoute()
  if (ordering > 0) [endpointA, endpointB] = [endpointB, endpointA]

  return {
    version: value.version,
    format: value.format,
    grantId32: b4a.from(value.grantId32),
    endpointA,
    endpointB,
    epoch: value.epoch,
    notBefore: value.notBefore,
    expiresAt: value.expiresAt,
    runId32: b4a.from(value.runId32),
    ...(signed ? { signature: b4a.from(value.signature) } : {})
  }
}

function writeU16(buffer, value, offset) {
  buffer[offset] = value >>> 8
  buffer[offset + 1] = value
}

function writeU32(buffer, value, offset) {
  buffer[offset] = value >>> 24
  buffer[offset + 1] = value >>> 16
  buffer[offset + 2] = value >>> 8
  buffer[offset + 3] = value
}

function writeU64(buffer, value, offset) {
  for (let shift = 56n; shift >= 0n; shift -= 8n)
    buffer[offset++] = Number((value >> shift) & 0xffn)
  return offset
}

function writeEndpoint(buffer, value, offset) {
  buffer.set(value.identity32, offset)
  offset += 32
  buffer[offset++] = value.role
  buffer[offset++] = value.address.family
  buffer.set(value.address.bytes, offset)
  offset += value.address.bytes.byteLength
  writeU16(buffer, value.address.port, offset)
  offset += 2
  buffer[offset++] = value.operations
  return offset
}

function encodeNormalizedUnsigned(value) {
  const size =
    4 +
    1 +
    32 +
    32 +
    1 +
    1 +
    value.endpointA.address.bytes.byteLength +
    2 +
    1 +
    32 +
    1 +
    1 +
    value.endpointB.address.bytes.byteLength +
    2 +
    1 +
    8 +
    8 +
    8 +
    32
  const buffer = b4a.allocUnsafe(size)
  let offset = 0
  writeU32(buffer, value.version, offset)
  offset += 4
  buffer[offset++] = value.format
  buffer.set(value.grantId32, offset)
  offset += 32
  offset = writeEndpoint(buffer, value.endpointA, offset)
  offset = writeEndpoint(buffer, value.endpointB, offset)
  offset = writeU64(buffer, value.epoch, offset)
  offset = writeU64(buffer, value.notBefore, offset)
  offset = writeU64(buffer, value.expiresAt, offset)
  buffer.set(value.runId32, offset)
  return buffer
}

export function encodeUnsignedTopologyGrant(value) {
  return encodeNormalizedUnsigned(normalizeGrant(value, false))
}

export function encodeTopologyGrant(value) {
  const normalized = normalizeGrant(value, true)
  return b4a.concat([encodeNormalizedUnsigned(normalized), normalized.signature])
}

function createReader(buffer) {
  if (
    !b4a.isBuffer(buffer) ||
    buffer.byteLength < MIN_UNSIGNED_SIZE ||
    buffer.byteLength > MAX_UNSIGNED_SIZE + 64
  ) {
    invalidRoute()
  }
  let offset = 0
  function take(size) {
    if (offset + size > buffer.byteLength) invalidRoute()
    const value = b4a.from(buffer.subarray(offset, offset + size))
    offset += size
    return value
  }
  return {
    u8() {
      return take(1)[0]
    },
    u16() {
      const bytes = take(2)
      return bytes[0] * 0x100 + bytes[1]
    },
    u32() {
      const bytes = take(4)
      return bytes[0] * 0x1000000 + bytes[1] * 0x10000 + bytes[2] * 0x100 + bytes[3]
    },
    u64() {
      const bytes = take(8)
      let value = 0n
      for (const byte of bytes) value = (value << 8n) | BigInt(byte)
      return value
    },
    take,
    done() {
      if (offset !== buffer.byteLength) invalidRoute()
    }
  }
}

function decodeEndpoint(reader) {
  const identity32 = reader.take(32)
  const role = reader.u8()
  const family = reader.u8()
  if (family !== 4 && family !== 6) invalidRoute()
  const address = reader.take(family === 4 ? 4 : 16)
  return {
    identity32,
    role,
    host: hostFromAddress(family, address),
    port: reader.u16(),
    operations: reader.u8()
  }
}

function decodeValue(buffer, signed) {
  if (!b4a.isBuffer(buffer)) invalidRoute()
  const maximum = MAX_UNSIGNED_SIZE + (signed ? SIGNATURE_SIZE : 0)
  const minimum = MIN_UNSIGNED_SIZE + (signed ? SIGNATURE_SIZE : 0)
  if (buffer.byteLength < minimum || buffer.byteLength > maximum) invalidRoute()
  const reader = createReader(buffer)
  const value = {
    version: reader.u32(),
    format: reader.u8(),
    grantId32: reader.take(32),
    endpointA: decodeEndpoint(reader),
    endpointB: decodeEndpoint(reader),
    epoch: reader.u64(),
    notBefore: reader.u64(),
    expiresAt: reader.u64(),
    runId32: reader.take(32)
  }
  if (signed) value.signature = reader.take(SIGNATURE_SIZE)
  reader.done()
  const normalized = normalizeGrant(value, signed)
  if (!b4a.equals(normalized.endpointA.identity32, value.endpointA.identity32)) invalidRoute()
  return {
    version: normalized.version,
    format: normalized.format,
    grantId32: normalized.grantId32,
    endpointA: publicEndpoint(normalized.endpointA),
    endpointB: publicEndpoint(normalized.endpointB),
    epoch: normalized.epoch,
    notBefore: normalized.notBefore,
    expiresAt: normalized.expiresAt,
    runId32: normalized.runId32,
    ...(signed ? { signature: normalized.signature } : {})
  }
}

export function decodeUnsignedTopologyGrant(buffer) {
  return decodeValue(buffer, false)
}

export function decodeTopologyGrant(buffer) {
  return decodeValue(buffer, true)
}

export function signTopologyGrant(value, secretKey) {
  const unsigned = encodeUnsignedTopologyGrant(value)
  const digest = cryptoSuite.hash([DOMAIN.TOPOLOGY_GRANT, unsigned])
  const signature = cryptoSuite.sign(digest, secretKey)
  return b4a.concat([unsigned, signature])
}

export function verifyTopologyGrant(encoding, authorityPublicKey, options) {
  if (!fixed(authorityPublicKey, 32)) unauthorized()
  if (!exactKeys(options, ['localIdentity32', 'now'])) invalidRoute()
  if (!fixed(options.localIdentity32, 32) || !validU64(options.now)) invalidRoute()

  const decoded = decodeTopologyGrant(encoding)
  const unsigned = b4a.from(encoding.subarray(0, encoding.byteLength - SIGNATURE_SIZE))
  const signedDigest = cryptoSuite.hash([DOMAIN.TOPOLOGY_GRANT, unsigned])
  if (!cryptoSuite.verify(signedDigest, decoded.signature, authorityPublicKey)) unauthorized()
  if (options.now < decoded.notBefore || options.now >= decoded.expiresAt) unauthorized()

  let local = decoded.endpointA
  let peer = decoded.endpointB
  if (b4a.equals(options.localIdentity32, decoded.endpointB.identity32)) {
    local = decoded.endpointB
    peer = decoded.endpointA
  } else if (!b4a.equals(options.localIdentity32, decoded.endpointA.identity32)) {
    unauthorized()
  }

  const grant = Object.freeze({})
  VERIFIED_GRANTS.set(grant, {
    digest32: cryptoSuite.hash(encoding),
    encoding: b4a.from(encoding),
    grantId32: b4a.from(decoded.grantId32),
    local: {
      identity32: b4a.from(local.identity32),
      role: local.role,
      address: {
        family: local.host.includes(':') ? 6 : 4,
        host: local.host,
        port: local.port
      },
      operations: local.operations
    },
    peer: {
      identity32: b4a.from(peer.identity32),
      role: peer.role,
      address: {
        family: peer.host.includes(':') ? 6 : 4,
        host: peer.host,
        port: peer.port
      },
      operations: peer.operations
    },
    epoch: decoded.epoch,
    notBefore: decoded.notBefore,
    expiresAt: decoded.expiresAt,
    runId32: b4a.from(decoded.runId32)
  })
  return grant
}

export function readVerifiedTopologyGrant(value) {
  const state = isObject(value) ? VERIFIED_GRANTS.get(value) : null
  if (!state) unauthorized()
  return copyView(state)
}

function keyFor(digest32) {
  if (!fixed(digest32, 32)) unauthorized()
  return b4a.toString(digest32, 'hex')
}

function validateBound(value, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback) invalidRoute()
  return value
}

function snapshot(state) {
  return {
    grants: state.grants.size,
    handles: state.handles.size,
    tombstones: state.tombstones.size,
    timers: state.timers.size,
    destroyed: state.destroyed
  }
}

function observe(state) {
  if (state.observer) state.observer(snapshot(state))
}

function currentTime(state) {
  const value = state.now()
  if (!validU64(value)) invalidRoute()
  return value
}

function cancelTimer(state, key) {
  if (!state.timers.has(key)) return
  const timer = state.timers.get(key)
  state.timers.delete(key)
  state.cancel(timer)
}

function closeRecord(state, key, reason, tombstone) {
  const record = state.grants.get(key)
  if (!record) return
  cancelTimer(state, key)
  state.grants.delete(key)
  const handle = state.handles.get(key)
  state.handles.delete(key)
  if (tombstone) state.tombstones.add(key)
  try {
    if (handle) state.onClose(handle, reason)
  } finally {
    if (handle) LINK_HANDLES.delete(handle)
    observe(state)
  }
}

function scheduleExpiry(state, key) {
  const record = state.grants.get(key)
  if (!record) return
  const now = currentTime(state)
  if (now >= record.expiresAt) {
    closeRecord(state, key, 'expired', true)
    return
  }
  const remaining = record.expiresAt - now
  const delay = remaining > BigInt(MAX_TIMER_DELAY) ? MAX_TIMER_DELAY : Number(remaining)
  const timer = state.schedule(() => {
    state.timers.delete(key)
    if (state.destroyed || !state.grants.has(key)) return
    if (currentTime(state) >= record.expiresAt) closeRecord(state, key, 'expired', true)
    else scheduleExpiry(state, key)
  }, delay)
  state.timers.set(key, timer)
}

function ensureOpen(state) {
  if (state.destroyed) circuitState()
}

export class LinkDirectory {
  constructor(options = {}) {
    if (!isObject(options)) invalidRoute()
    const {
      localIdentity32,
      localRole,
      authorityPublicKey,
      epoch,
      runId32,
      now,
      schedule,
      cancel,
      onClose,
      maxGrants,
      maxHandles
    } = options
    if (!fixed(localIdentity32, 32) || !fixed(authorityPublicKey, 32) || !fixed(runId32, 32)) {
      invalidRoute()
    }
    validateRoleBinding(localIdentity32, localRole)
    if (!validU64(epoch)) invalidRoute()
    if (
      typeof now !== 'function' ||
      typeof schedule !== 'function' ||
      typeof cancel !== 'function' ||
      typeof onClose !== 'function'
    ) {
      invalidRoute()
    }
    const observer = options[TEST_ONLY_LINK_DIRECTORY_OBSERVER]
    if (observer !== undefined && typeof observer !== 'function') invalidRoute()

    DIRECTORIES.set(this, {
      localIdentity32: b4a.from(localIdentity32),
      localRole,
      authorityPublicKey: b4a.from(authorityPublicKey),
      epoch,
      runId32: b4a.from(runId32),
      now,
      schedule,
      cancel,
      onClose,
      observer,
      maxGrants: validateBound(maxGrants, DEFAULT_MAX_TOPOLOGY_GRANTS),
      maxHandles: validateBound(maxHandles, DEFAULT_MAX_LINK_HANDLES),
      grants: new Map(),
      handles: new Map(),
      tombstones: new Set(),
      timers: new Map(),
      destroyed: false
    })
  }

  add(encoding) {
    const state = DIRECTORIES.get(this)
    ensureOpen(state)
    const current = currentTime(state)
    const verified = verifyTopologyGrant(b4a.from(encoding), state.authorityPublicKey, {
      localIdentity32: state.localIdentity32,
      now: current
    })
    const grant = readVerifiedTopologyGrant(verified)
    const key = keyFor(grant.digest32)
    if (state.tombstones.has(key)) unauthorized()
    if (
      grant.local.role !== state.localRole ||
      grant.epoch !== state.epoch ||
      !b4a.equals(grant.runId32, state.runId32)
    ) {
      unauthorized()
    }
    if (state.grants.has(key)) return b4a.from(grant.digest32)
    if (state.grants.size >= state.maxGrants) circuitLimit()
    state.grants.set(key, grant)
    try {
      scheduleExpiry(state, key)
    } catch (error) {
      state.grants.delete(key)
      throw error
    }
    observe(state)
    return b4a.from(grant.digest32)
  }

  authorize(value) {
    const state = DIRECTORIES.get(this)
    ensureOpen(state)
    if (
      !exactKeys(value, [
        'digest32',
        'operation',
        'localIdentity32',
        'localRole',
        'peerIdentity32',
        'peerRole',
        'epoch',
        'runId32'
      ]) ||
      !fixed(value.localIdentity32, 32) ||
      !fixed(value.peerIdentity32, 32) ||
      !fixed(value.runId32, 32) ||
      !validU64(value.epoch) ||
      (value.operation !== LINK_OPERATION.INITIATE && value.operation !== LINK_OPERATION.ACCEPT)
    ) {
      unauthorized()
    }
    const key = keyFor(value.digest32)
    const grant = state.grants.get(key)
    if (!grant || state.tombstones.has(key)) unauthorized()
    if (currentTime(state) >= grant.expiresAt) {
      closeRecord(state, key, 'expired', true)
      unauthorized()
    }
    if (
      !b4a.equals(value.localIdentity32, state.localIdentity32) ||
      value.localRole !== state.localRole ||
      !b4a.equals(value.localIdentity32, grant.local.identity32) ||
      value.localRole !== grant.local.role ||
      !b4a.equals(value.peerIdentity32, grant.peer.identity32) ||
      value.peerRole !== grant.peer.role ||
      value.epoch !== state.epoch ||
      value.epoch !== grant.epoch ||
      !b4a.equals(value.runId32, state.runId32) ||
      !b4a.equals(value.runId32, grant.runId32) ||
      (grant.local.operations & value.operation) !== value.operation
    ) {
      unauthorized()
    }
    if (state.handles.has(key)) return state.handles.get(key)
    if (state.handles.size >= state.maxHandles) circuitLimit()

    const handle = Object.freeze({})
    LINK_HANDLES.set(handle, {
      digest32: b4a.from(grant.digest32),
      localIdentity32: b4a.from(grant.local.identity32),
      localRole: grant.local.role,
      localAddress: { ...grant.local.address },
      peerIdentity32: b4a.from(grant.peer.identity32),
      peerRole: grant.peer.role,
      peerAddress: { ...grant.peer.address },
      epoch: grant.epoch,
      runId32: b4a.from(grant.runId32),
      operations: grant.local.operations
    })
    state.handles.set(key, handle)
    observe(state)
    return handle
  }

  revoke(value) {
    const state = DIRECTORIES.get(this)
    ensureOpen(state)
    if (
      !exactKeys(value, ['digest32', 'epoch', 'runId32']) ||
      !validU64(value.epoch) ||
      !fixed(value.runId32, 32) ||
      value.epoch !== state.epoch ||
      !b4a.equals(value.runId32, state.runId32)
    ) {
      unauthorized()
    }
    const key = keyFor(value.digest32)
    if (!state.grants.has(key) || state.tombstones.has(key)) unauthorized()
    closeRecord(state, key, 'revoked', true)
  }

  destroy() {
    const state = DIRECTORIES.get(this)
    if (state.destroyed) return
    state.destroyed = true
    for (const key of Array.from(state.grants.keys())) closeRecord(state, key, 'destroyed', false)
    for (const key of Array.from(state.timers.keys())) cancelTimer(state, key)
    state.grants.clear()
    state.handles.clear()
    state.tombstones.clear()
    observe(state)
    b4a.fill(state.localIdentity32, 0)
    b4a.fill(state.authorityPublicKey, 0)
    b4a.fill(state.runId32, 0)
    state.now = null
    state.schedule = null
    state.cancel = null
    state.onClose = null
    state.observer = null
  }
}

export function readLinkHandle(value) {
  const state = isObject(value) ? LINK_HANDLES.get(value) : null
  if (!state) unauthorized()
  return {
    digest32: b4a.from(state.digest32),
    localIdentity32: b4a.from(state.localIdentity32),
    localRole: state.localRole,
    localAddress: { ...state.localAddress },
    peerIdentity32: b4a.from(state.peerIdentity32),
    peerRole: state.peerRole,
    peerAddress: { ...state.peerAddress },
    epoch: state.epoch,
    runId32: b4a.from(state.runId32),
    operations: state.operations
  }
}
