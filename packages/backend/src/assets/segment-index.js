import b4a from 'b4a'

import {
  encodeCanonical,
  hashCanonical,
  normalizeNonNegativeInteger,
  sortPlain,
  toHex,
} from '../publisher/canonical.js'

export const SEGMENT_INDEX_VERSION = 1
export const SEGMENT_INDEX_ID_DOMAIN = 'peartube.asset.segment-index.v1'
export const MAX_SEGMENT_INDEX_ENTRIES = 100000

function normalizeBoundedString(value, name, max = 128) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${name} must be bounded string`)
  return value
}

function normalizeCoreRef(core = {}, name = 'core') {
  return {
    key: toHex(core.key, 32, `${name}.key`),
    length: normalizeNonNegativeInteger(core.length, `${name}.length`, 0),
    treeHash: toHex(core.treeHash, 32, `${name}.treeHash`),
    byteLength: normalizeNonNegativeInteger(core.byteLength, `${name}.byteLength`, 0),
  }
}

function normalizeEntry(entry = {}, previous = null, mediaByteLength = 0) {
  const out = {
    timeStartMs: normalizeNonNegativeInteger(entry.timeStartMs, 'timeStartMs', 0),
    durationMs: normalizeNonNegativeInteger(entry.durationMs, 'durationMs', 0),
    byteStart: normalizeNonNegativeInteger(entry.byteStart, 'byteStart', 0),
    byteEnd: normalizeNonNegativeInteger(entry.byteEnd, 'byteEnd', 0),
    independent: Boolean(entry.independent),
  }
  if (out.durationMs <= 0) throw new Error('durationMs must be positive')
  if (out.byteEnd <= out.byteStart) throw new Error('byteEnd must be greater than byteStart')
  if (out.byteEnd > mediaByteLength) throw new Error('segment bytes exceed media byte length')
  if (previous) {
    if (out.byteStart < previous.byteEnd) throw new Error('segment byte ranges must be monotonic and non-overlapping')
    if (out.timeStartMs < previous.timeStartMs + previous.durationMs) throw new Error('segment times must be monotonic and non-overlapping')
  }
  return out
}

function unsignedSegmentIndexDescriptor(input = {}) {
  const mediaByteLength = normalizeNonNegativeInteger(input.mediaByteLength, 'mediaByteLength', 0)
  const entries = input.entries || []
  if (!Array.isArray(entries)) throw new Error('entries must be an array')
  if (entries.length > MAX_SEGMENT_INDEX_ENTRIES) throw new Error('segment index entry count exceeds maximum')
  let previous = null
  const normalizedEntries = entries.map((entry) => {
    const next = normalizeEntry(entry, previous, mediaByteLength)
    previous = next
    return next
  })
  const body = {
    version: SEGMENT_INDEX_VERSION,
    codec: normalizeBoundedString(input.codec, 'codec'),
    mediaByteLength,
    entryCount: normalizedEntries.length,
    entries: normalizedEntries,
    indexCore: input.indexCore ? normalizeCoreRef(input.indexCore, 'indexCore') : null,
  }
  body.digest = b4a.toString(hashCanonical(`${SEGMENT_INDEX_ID_DOMAIN}.digest`, { ...body, digest: undefined }), 'hex')
  return body
}

export function deriveSegmentIndexId(input = {}) {
  return b4a.toString(hashCanonical(SEGMENT_INDEX_ID_DOMAIN, unsignedSegmentIndexDescriptor(input)), 'hex')
}

export function createSegmentIndexDescriptor(input = {}) {
  const body = unsignedSegmentIndexDescriptor(input)
  return { ...body, id: deriveSegmentIndexId(body) }
}

export function encodeSegmentIndex(input = {}) {
  return encodeCanonical(createSegmentIndexDescriptor(input))
}

export function decodeSegmentIndex(buffer) {
  const parsed = JSON.parse(b4a.toString(b4a.from(buffer), 'utf8'))
  return createSegmentIndexDescriptor(parsed)
}

export { normalizeCoreRef }
