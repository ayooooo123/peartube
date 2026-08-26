import b4a from 'b4a'

import { createNetworkAdmission } from './admission.js'
import {
  MAX_PEER_FRAME_BYTES,
  PEER_FRAME_TYPE_NAMES,
  decodePeerFrame,
} from './frame.js'
import { PROTOCOL_MAJOR } from './version.js'

export const ASSET_RENDITION_CAPABILITY = 'asset-rendition:v2'
export const ARCHIVE_RANGE_CAPABILITY = 'archive-range:v1'
export const ARCHIVE_DISCOVERY_CAPABILITY = 'archive-discovery:v1'
export const INDEX_QUERY_CAPABILITY = 'index-query:v1'
export const SCOPED_NETWORK_PROTOCOL = 'peartube/scoped-network'

const PURPOSE_CODES = Object.freeze({ bootstrap: 1, publisher: 2, asset: 3, archive: 5, 'archive-discovery': 6, index: 7, moderation: 8 })
const PURPOSE_NAMES = new Map(Object.entries(PURPOSE_CODES).map(([name, code]) => [code, name]))
const MAX_HELLO_BYTES = 2048
const MAX_CAPABILITIES = 16
const MAX_CAPABILITY_BYTES = 128

function fail(message, code = 'SCOPED_NETWORK_REJECTED') {
  const error = new Error(message)
  error.code = code
  throw error
}

function exactBuffer(value, size, name) {
  const buffer = b4a.from(value || [])
  if (buffer.byteLength !== size) fail(`${name} must be ${size} bytes`)
  return buffer
}

function normalizeCapabilities(values) {
  if (!Array.isArray(values) || values.length > MAX_CAPABILITIES) fail('capabilities exceed bounded limit')
  const result = []
  for (const value of values) {
    const capability = String(value || '')
    const encoded = b4a.from(capability)
    if (!capability || encoded.byteLength > MAX_CAPABILITY_BYTES) fail('capability exceeds bounded limit')
    if (result.includes(capability)) fail('capabilities must be distinct')
    result.push(capability)
  }
  return result.sort()
}

export function encodeScopedHello(input = {}) {
  const purposeCode = PURPOSE_CODES[input.purpose]
  if (!purposeCode) fail('unknown purpose')
  const topic = exactBuffer(input.topic, 32, 'topic')
  const protocolMajor = Number(input.protocolMajor ?? PROTOCOL_MAJOR)
  const maxFrameBytes = Number(input.maxFrameBytes ?? MAX_PEER_FRAME_BYTES)
  if (!Number.isSafeInteger(protocolMajor) || protocolMajor < 1 || protocolMajor > 255) fail('invalid protocol major')
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 32 || maxFrameBytes > MAX_PEER_FRAME_BYTES) fail('invalid frame limit')
  const capabilities = normalizeCapabilities(input.capabilities || [])
  let length = 40
  for (const capability of capabilities) length += 1 + b4a.byteLength(capability)
  if (length > MAX_HELLO_BYTES) fail('hello exceeds bounded limit')
  const output = b4a.alloc(length)
  let offset = 0
  output.writeUInt8(1, offset++)
  output.writeUInt8(protocolMajor, offset++)
  output.writeUInt8(purposeCode, offset++)
  output.writeUInt8(capabilities.length, offset++)
  output.writeUInt32BE(maxFrameBytes, offset); offset += 4
  b4a.copy(topic, output, offset); offset += 32
  for (const capability of capabilities) {
    const encoded = b4a.from(capability)
    output.writeUInt8(encoded.byteLength, offset++)
    b4a.copy(encoded, output, offset); offset += encoded.byteLength
  }
  return output
}

export function decodeScopedHello(input) {
  const buffer = b4a.from(input || [])
  if (buffer.byteLength < 40 || buffer.byteLength > MAX_HELLO_BYTES) fail('invalid bounded hello')
  let offset = 0
  if (buffer.readUInt8(offset++) !== 1) fail('unsupported hello version')
  const protocolMajor = buffer.readUInt8(offset++)
  const purpose = PURPOSE_NAMES.get(buffer.readUInt8(offset++))
  if (!purpose) fail('unknown purpose')
  const count = buffer.readUInt8(offset++)
  if (count > MAX_CAPABILITIES) fail('capabilities exceed bounded limit')
  const maxFrameBytes = buffer.readUInt32BE(offset); offset += 4
  if (maxFrameBytes < 32 || maxFrameBytes > MAX_PEER_FRAME_BYTES) fail('invalid frame limit')
  const topic = b4a.from(buffer.subarray(offset, offset + 32)); offset += 32
  const capabilities = []
  for (let index = 0; index < count; index++) {
    if (offset >= buffer.byteLength) fail('truncated hello')
    const length = buffer.readUInt8(offset++)
    if (!length || length > MAX_CAPABILITY_BYTES || offset + length > buffer.byteLength) fail('truncated capability')
    const capability = b4a.toString(buffer.subarray(offset, offset + length)); offset += length
    if (!b4a.equals(b4a.from(capability), buffer.subarray(offset - length, offset))) fail('noncanonical capability')
    capabilities.push(capability)
  }
  if (offset !== buffer.byteLength) fail('trailing hello bytes')
  return { protocolMajor, purpose, topic, maxFrameBytes, capabilities: normalizeCapabilities(capabilities) }
}

export function createScopedProtocolSession(options = {}) {
  const purpose = String(options.purpose || '')
  const topic = exactBuffer(options.topic, 32, 'topic')
  const protocolMajor = Number(options.protocolMajor ?? PROTOCOL_MAJOR)
  const requiredCapability = String(options.requiredCapability || '')
  const peerId = String(options.peerId || 'unknown')
  const admission = options.admission?.reserve ? options.admission : createNetworkAdmission(options.admission)
  const localMaxFrameBytes = Number(options.maxFrameBytes || MAX_PEER_FRAME_BYTES)
  let state = 'noise-authenticated'
  let negotiatedMaxFrameBytes = null
  let lastRequestId = 0
  let activated = false
  let closed = false

  return {
    get state() { return state },
    get maxFrameBytes() { return negotiatedMaxFrameBytes || localMaxFrameBytes },
    async acceptHello(encoded) {
      if (closed) fail('session is closed')
      const bytes = encoded?.byteLength ?? 0
      if (bytes < 40 || bytes > MAX_HELLO_BYTES) fail('invalid bounded hello')
      const reservation = admission.reserve({ peerId, bytes, verify: true })
      if (!reservation.accepted) fail(reservation.reason, 'SCOPED_NETWORK_ADMISSION_REJECTED')
      try {
        const hello = decodeScopedHello(encoded)
        if (hello.purpose !== purpose) fail('purpose mismatch')
        if (!b4a.equals(hello.topic, topic)) fail('topic mismatch')
        if (hello.protocolMajor !== protocolMajor) fail('major mismatch')
        if (!hello.capabilities.includes(requiredCapability)) fail('required capability missing')
        negotiatedMaxFrameBytes = Math.min(localMaxFrameBytes, hello.maxFrameBytes)
        state = 'active'
        if (!activated) {
          activated = true
          await options.onActivate?.({ peerId, purpose, topic, capabilities: hello.capabilities, maxFrameBytes: negotiatedMaxFrameBytes })
        }
        return { purpose, topic: b4a.from(topic), protocolMajor, maxFrameBytes: negotiatedMaxFrameBytes }
      } finally {
        reservation.release('complete')
      }
    },
    async receive(encoded) {
      if (state !== 'active') fail('handshake required')
      const bytes = encoded?.byteLength ?? 0
      if (bytes > negotiatedMaxFrameBytes) fail('frame exceeds negotiated maximum')
      const frame = decodePeerFrame(b4a.from(encoded), { typeCodes: PEER_FRAME_TYPE_NAMES })
      if (frame.purpose !== purpose) fail('purpose mismatch')
      if (frame.protocolMajor !== protocolMajor) fail('major mismatch')
      if (!Number.isSafeInteger(frame.requestId) || frame.requestId <= lastRequestId) fail('replay rejected')
      lastRequestId = frame.requestId
      const admissionExempt = options.isAdmissionExempt?.(frame) === true
      const reservation = admissionExempt ? null : admission.reserve({ peerId, bytes, verify: purpose === 'bootstrap' })
      if (reservation && !reservation.accepted) fail(reservation.reason, 'SCOPED_NETWORK_ADMISSION_REJECTED')
      try {
        return await options.onFrame?.(frame, { peerId, purpose, topic })
      } finally {
        reservation?.release('complete')
      }
    },
    close(reason = 'closed') {
      if (closed) return false
      closed = true
      state = 'closed'
      admission.disconnect(peerId)
      options.onClose?.(reason)
      return true
    },
  }
}
