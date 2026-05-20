const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function toBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (typeof value === 'string') {
    const clean = value.trim().replace(/^0x/, '').replace(/[^0-9a-f]/gi, '').toLowerCase()
    if (clean.length === 0) return textEncoder.encode(value)
    const out = new Uint8Array(Math.ceil(clean.length / 2))
    for (let i = 0; i < out.length; i++) {
      const start = i * 2
      out[i] = parseInt(clean.slice(start, start + 2).padEnd(2, '0'), 16) || 0
    }
    return out
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return textEncoder.encode(String(value ?? ''))
}

function stableHash(input, seed = 0) {
  const bytes = toBytes(input)
  let h1 = 0x811c9dc5 ^ seed
  let h2 = 0x01000193 ^ (seed >>> 0)
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]
    h1 ^= byte
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= (byte + i + seed) & 0xff
    h2 = Math.imul(h2, 0x27d4eb2d)
  }
  return (((h1 >>> 0) << 1) ^ (h2 >>> 0)) >>> 0
}

function bytesToHex(bytes) {
  return Array.from(bytes || [], (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function createDescriptorBloom(options = {}) {
  const expectedItems = Math.max(1, Number(options.expectedItems || 256) || 256)
  const falsePositiveRate = Math.min(0.25, Math.max(0.0001, Number(options.falsePositiveRate || 0.02) || 0.02))
  const size = Math.max(8, Math.ceil((-expectedItems * Math.log(falsePositiveRate)) / (Math.LN2 ** 2)))
  const hashCount = Math.max(2, Math.round((size / expectedItems) * Math.LN2))
  const bits = new Uint8Array(Math.ceil(size / 8))
  const entries = new Set()

  function setBit(index) {
    const byteIndex = index >> 3
    const bitIndex = index & 7
    bits[byteIndex] |= 1 << bitIndex
  }

  function getBit(index) {
    const byteIndex = index >> 3
    const bitIndex = index & 7
    return Boolean(bits[byteIndex] & (1 << bitIndex))
  }

  function indexesFor(value) {
    const bytes = toBytes(value)
    const positions = []
    for (let i = 0; i < hashCount; i++) {
      positions.push(stableHash(bytes, i) % size)
    }
    return positions
  }

  return {
    size,
    hashCount,
    add(value) {
      const key = bytesToHex(toBytes(value))
      entries.add(key)
      for (const index of indexesFor(value)) setBit(index)
    },
    has(value) {
      for (const index of indexesFor(value)) {
        if (!getBit(index)) return false
      }
      return true
    },
    missing(values) {
      return Array.isArray(values)
        ? values.filter((value) => !this.has(value))
        : []
    },
    union(other) {
      const otherBits = other?.bits instanceof Uint8Array ? other.bits : null
      if (!otherBits) return this
      for (let i = 0; i < bits.length && i < otherBits.length; i++) bits[i] |= otherBits[i]
      return this
    },
    serialize() {
      return {
        version: 1,
        size,
        hashCount,
        bits: bytesToHex(bits),
        itemCount: entries.size,
      }
    },
    snapshot() {
      return {
        version: 1,
        size,
        hashCount,
        bits: new Uint8Array(bits),
        itemCount: entries.size,
      }
    },
    toJSON() {
      return this.serialize()
    },
    entries() {
      return Array.from(entries)
    },
    get bits() {
      return bits
    },
    get items() {
      return entries.size
    },
  }
}

export function decodeDescriptorBloom(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('decodeDescriptorBloom requires a bloom payload object')
  }
  const size = Math.max(8, Number(payload.size || 0) || 8)
  const hashCount = Math.max(2, Number(payload.hashCount || 0) || 2)
  const bitsHex = typeof payload.bits === 'string' ? payload.bits : ''
  const bits = toBytes(bitsHex)
  const bloom = createDescriptorBloom({ expectedItems: Math.max(1, Number(payload.itemCount || 0) || 1), falsePositiveRate: 0.02 })
  if (bits.length > 0) bloom.bits.set(bits.slice(0, bloom.bits.length))
  return {
    version: Number(payload.version || 1) || 1,
    size,
    hashCount,
    bits: bloom.bits,
    itemCount: Number(payload.itemCount || 0) || 0,
    has: bloom.has,
    add: bloom.add,
    missing: bloom.missing,
    serialize: bloom.serialize,
  }
}

export function compareDescriptorBlooms(localBloom, remoteBloom, candidateIds = []) {
  const remote = remoteBloom?.has ? remoteBloom : decodeDescriptorBloom(remoteBloom || {})
  const local = localBloom?.has ? localBloom : decodeDescriptorBloom(localBloom || {})
  const missing = Array.isArray(candidateIds)
    ? candidateIds.filter((id) => remote && !remote.has(id) && !local.has(id))
    : []
  return {
    missing,
    remoteMissing: Array.isArray(candidateIds) ? candidateIds.filter((id) => !remote.has?.(id)) : [],
    localMissing: Array.isArray(candidateIds) ? candidateIds.filter((id) => !local.has?.(id)) : [],
  }
}

export function bloomFilterKnownDescriptors(descriptors, options = {}) {
  const bloom = createDescriptorBloom(options)
  for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
    const id = typeof descriptor === 'string' ? descriptor : descriptor?.descriptorId || descriptor?.id || descriptor?.driveKey
    if (id) bloom.add(id)
  }
  return bloom
}

export default {
  createDescriptorBloom,
  decodeDescriptorBloom,
  compareDescriptorBlooms,
  bloomFilterKnownDescriptors,
}
