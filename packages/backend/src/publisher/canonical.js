import b4a from 'b4a'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'

export function normalizeBytes(value, size = 32, name = 'bytes') {
  if (b4a.isBuffer(value) || value instanceof Uint8Array) {
    const out = b4a.from(value)
    if (size != null && out.byteLength !== size) throw new Error(`${name} must be ${size} bytes`)
    return out
  }
  if (typeof value === 'string' && /^(?:[0-9a-f]{2})+$/i.test(value)) {
    const out = b4a.from(value, 'hex')
    if (size != null && out.byteLength !== size) throw new Error(`${name} must be ${size} bytes`)
    return out
  }
  throw new Error(`${name} must be bytes or hex`)
}

export function toHex(value, size = 32, name = 'bytes') {
  return b4a.toString(normalizeBytes(value, size, name), 'hex')
}

export function sortPlain(value) {
  if (value === null || value === undefined) return null
  if (b4a.isBuffer(value) || value instanceof Uint8Array) return toHex(value)
  if (Array.isArray(value)) return value.map(sortPlain)
  if (typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      const next = value[key]
      if (next !== undefined) out[key] = sortPlain(next)
    }
    return out
  }
  return value
}

export function encodeCanonical(value) {
  return b4a.from(JSON.stringify(sortPlain(value)))
}

export function hashCanonical(domain, value) {
  const body = encodeCanonical(value)
  return crypto.hash(b4a.concat([
    c.encode(c.string, domain),
    c.encode(c.uint, body.byteLength),
    body,
  ]))
}

export function normalizeNonNegativeInteger(value, name, fallback = 0) {
  const next = value == null ? fallback : Number(value)
  if (!Number.isSafeInteger(next) || next < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return next
}

export function normalizeCapabilities(capabilities = []) {
  if (!Array.isArray(capabilities)) throw new Error('capabilities must be an array')
  return Array.from(new Set(capabilities.map(capability => {
    if (typeof capability !== 'string' || !/^[a-z0-9:._-]+$/i.test(capability)) {
      throw new Error('invalid capability')
    }
    return capability
  }))).sort()
}
