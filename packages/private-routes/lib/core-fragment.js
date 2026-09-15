import b4a from 'b4a'

import { cryptoSuite } from './crypto-suite.js'
import { PrivateRouteError } from './errors.js'
import {
  CONTEXT_CLASS,
  M3_MESSAGE_ID,
  M3_PROTOCOL_VERSION,
  decodeM3Object,
  encodeM3Object
} from './protocol.js'

export const ROUTED_FRAGMENT_DATA_BYTES = 1017
export const MAX_ROUTED_OBJECT_BYTES = 12_288
export const MAX_ROUTED_FRAGMENTS = 13
export const MAX_ROUTED_REASSEMBLIES = 4
export const MAX_ROUTED_RESERVED_BYTES = 49_152
export const ROUTED_REASSEMBLY_TIMEOUT = 5_000n

const MAX_ROUTE_PAYLOAD = 1073
const FIXED_BODY_BYTES = 48
const OBJECT_DIGEST_DOMAIN = b4a.from('hyperdht-private-routes/m3/core-fragment/object/v1')
const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get
const fillIntrinsic = Uint8Array.prototype.fill
const setIntrinsic = Uint8Array.prototype.set
const subarrayIntrinsic = Uint8Array.prototype.subarray

function invalid() {
  throw PrivateRouteError.INVALID_ROUTE()
}

function length(value) {
  try {
    return b4a.isBuffer(value) ? byteLengthGetter.call(value) : -1
  } catch {
    return -1
  }
}

function clear(value) {
  try {
    if (b4a.isBuffer(value)) fillIntrinsic.call(value, 0)
  } catch {}
}

function set(target, source, offset = 0) {
  try {
    setIntrinsic.call(target, source, offset)
  } catch {
    invalid()
  }
}

function subarray(value, start, end) {
  try {
    return subarrayIntrinsic.call(value, start, end)
  } catch {
    invalid()
  }
}

function copy(value) {
  let output = null
  try {
    const size = length(value)
    if (size < 0) invalid()
    output = b4a.allocUnsafeSlow(size)
    set(output, value)
    return output
  } catch (err) {
    clear(output)
    if (err instanceof PrivateRouteError) throw err
    invalid()
  }
}

function writeUint16(target, value, offset) {
  target[offset] = value >>> 8
  target[offset + 1] = value
}

function readUint16(target, offset) {
  return (target[offset] << 8) | target[offset + 1]
}

function writeUint32(target, value, offset) {
  target[offset] = value >>> 24
  target[offset + 1] = value >>> 16
  target[offset + 2] = value >>> 8
  target[offset + 3] = value
}

function readUint32(target, offset) {
  return (
    target[offset] * 0x1000000 +
    (target[offset + 1] << 16) +
    (target[offset + 2] << 8) +
    target[offset + 3]
  )
}

function nowValue(now) {
  let value
  try {
    value = now()
  } catch {
    invalid()
  }
  if (Number.isSafeInteger(value) && value >= 0) value = BigInt(value)
  if (typeof value !== 'bigint' || value < 0n || value > 0xffff_ffff_ffff_ffffn) invalid()
  return value
}

function contextClass(value) {
  if (value !== CONTEXT_CLASS.ROUTE_PAYLOAD && value !== CONTEXT_CLASS.TERMINAL_CONTROL_ORDERED) {
    invalid()
  }
  return value
}

function decodeCanonical(encoded) {
  const decoded = decodeM3Object(encoded)
  if (decoded.messageId === M3_MESSAGE_ID.CORE_FRAGMENT_V1) {
    clear(decoded.body)
    clear(decoded.authSuffix)
    invalid()
  }
  return decoded
}

export function encodeRoutedCoreObjects(encoded) {
  let canonical = null
  let decoded = null
  let digest = null
  let body = null
  const outputs = []
  try {
    canonical = copy(encoded)
    decoded = decodeCanonical(canonical)
    const totalObjectBytes = canonical.byteLength
    if (totalObjectBytes > MAX_ROUTED_OBJECT_BYTES) invalid()
    if (totalObjectBytes <= MAX_ROUTE_PAYLOAD) {
      outputs.push(copy(canonical))
      return outputs
    }
    const fragmentCount = Math.ceil(totalObjectBytes / ROUTED_FRAGMENT_DATA_BYTES)
    if (fragmentCount < 2 || fragmentCount > MAX_ROUTED_FRAGMENTS) invalid()
    digest = cryptoSuite.hash([OBJECT_DIGEST_DOMAIN, canonical])
    if (length(digest) !== 32) invalid()
    for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex++) {
      const fragmentOffset = fragmentIndex * ROUTED_FRAGMENT_DATA_BYTES
      const fragmentDataBytes = Math.min(
        ROUTED_FRAGMENT_DATA_BYTES,
        totalObjectBytes - fragmentOffset
      )
      body = b4a.allocUnsafeSlow(FIXED_BODY_BYTES + fragmentDataBytes)
      writeUint16(body, decoded.messageId, 0)
      set(body, digest, 2)
      writeUint32(body, totalObjectBytes, 34)
      writeUint16(body, fragmentIndex, 38)
      writeUint16(body, fragmentCount, 40)
      writeUint32(body, fragmentOffset, 42)
      writeUint16(body, fragmentDataBytes, 46)
      set(body, subarray(canonical, fragmentOffset, fragmentOffset + fragmentDataBytes), 48)
      outputs.push(encodeM3Object({ messageId: M3_MESSAGE_ID.CORE_FRAGMENT_V1, body }))
      clear(body)
      body = null
    }
    return outputs
  } catch (err) {
    for (const output of outputs) clear(output)
    outputs.length = 0
    if (err instanceof PrivateRouteError) throw err
    invalid()
  } finally {
    clear(canonical)
    if (decoded) {
      clear(decoded.body)
      clear(decoded.authSuffix)
    }
    clear(digest)
    clear(body)
  }
}

function clearEntry(entry) {
  if (!entry) return
  clear(entry.bytes)
  clear(entry.digest)
  entry.bytes = null
  entry.digest = null
  entry.received.clear()
}

export class RoutedCoreReassembler {
  #now
  #entries
  #reserved
  #destroyed

  constructor(options) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) invalid()
    let now
    try {
      now = options.now
    } catch {
      invalid()
    }
    if (typeof now !== 'function') invalid()
    nowValue(now)
    this.#now = now
    this.#entries = new Map()
    this.#reserved = 0
    this.#destroyed = false
    Object.freeze(this)
  }

  accept(encoded, selectedContextClass) {
    if (this.#destroyed) throw PrivateRouteError.ERR_DESTROYED()
    selectedContextClass = contextClass(selectedContextClass)
    const current = nowValue(this.#now)
    this.#expire(current)
    let canonical = null
    let decoded = null
    let complete = null
    let completeDecoded = null
    let calculated = null
    try {
      canonical = copy(encoded)
      decoded = decodeM3Object(canonical)
      if (decoded.messageId !== M3_MESSAGE_ID.CORE_FRAGMENT_V1) {
        if (canonical.byteLength > MAX_ROUTE_PAYLOAD) invalid()
        const result = canonical
        canonical = null
        return result
      }
      if (decoded.authSuffix.byteLength !== 0 || decoded.body.byteLength < FIXED_BODY_BYTES) {
        invalid()
      }
      const body = decoded.body
      const objectMessageId = readUint16(body, 0)
      const objectDigest = subarray(body, 2, 34)
      const totalObjectBytes = readUint32(body, 34)
      const fragmentIndex = readUint16(body, 38)
      const fragmentCount = readUint16(body, 40)
      const fragmentOffset = readUint32(body, 42)
      const fragmentDataBytes = readUint16(body, 46)
      const expectedCount = Math.ceil(totalObjectBytes / ROUTED_FRAGMENT_DATA_BYTES)
      const expectedBytes =
        fragmentIndex + 1 === fragmentCount
          ? totalObjectBytes - fragmentOffset
          : ROUTED_FRAGMENT_DATA_BYTES
      if (
        objectMessageId === M3_MESSAGE_ID.CORE_FRAGMENT_V1 ||
        totalObjectBytes <= MAX_ROUTE_PAYLOAD ||
        totalObjectBytes > MAX_ROUTED_OBJECT_BYTES ||
        fragmentCount !== expectedCount ||
        fragmentCount < 2 ||
        fragmentCount > MAX_ROUTED_FRAGMENTS ||
        fragmentIndex >= fragmentCount ||
        fragmentOffset !== fragmentIndex * ROUTED_FRAGMENT_DATA_BYTES ||
        fragmentDataBytes !== expectedBytes ||
        fragmentDataBytes < 1 ||
        body.byteLength !== FIXED_BODY_BYTES + fragmentDataBytes
      ) {
        invalid()
      }
      const key = `${selectedContextClass}:${b4a.toString(objectDigest, 'hex')}`
      let entry = this.#entries.get(key)
      const data = subarray(body, FIXED_BODY_BYTES)
      if (!entry) {
        if (
          fragmentIndex !== 0 ||
          this.#entries.size >= MAX_ROUTED_REASSEMBLIES ||
          this.#reserved + totalObjectBytes > MAX_ROUTED_RESERVED_BYTES ||
          readUint32(data, 0) !== M3_PROTOCOL_VERSION ||
          readUint16(data, 4) !== objectMessageId ||
          readUint16(data, 6) !== totalObjectBytes - 8
        ) {
          invalid()
        }
        entry = {
          bytes: b4a.allocUnsafeSlow(totalObjectBytes),
          contextClass: selectedContextClass,
          digest: copy(objectDigest),
          expiresAt:
            current > 0xffff_ffff_ffff_ffffn - ROUTED_REASSEMBLY_TIMEOUT
              ? 0xffff_ffff_ffff_ffffn
              : current + ROUTED_REASSEMBLY_TIMEOUT,
          fragmentCount,
          messageId: objectMessageId,
          nextFragmentIndex: 0,
          received: new Set(),
          totalObjectBytes
        }
        this.#entries.set(key, entry)
        this.#reserved += totalObjectBytes
      } else if (
        entry.contextClass !== selectedContextClass ||
        entry.totalObjectBytes !== totalObjectBytes ||
        entry.fragmentCount !== fragmentCount ||
        entry.messageId !== objectMessageId ||
        !b4a.equals(entry.digest, objectDigest)
      ) {
        invalid()
      }
      if (entry.received.has(fragmentIndex)) {
        if (
          !b4a.equals(
            subarray(entry.bytes, fragmentOffset, fragmentOffset + fragmentDataBytes),
            data
          )
        ) {
          invalid()
        }
        return null
      }
      if (fragmentIndex !== entry.nextFragmentIndex) invalid()
      set(entry.bytes, data, fragmentOffset)
      entry.received.add(fragmentIndex)
      entry.nextFragmentIndex++
      if (entry.nextFragmentIndex !== fragmentCount) return null
      complete = copy(entry.bytes)
      calculated = cryptoSuite.hash([OBJECT_DIGEST_DOMAIN, complete])
      completeDecoded = decodeM3Object(complete)
      if (
        length(calculated) !== 32 ||
        !b4a.equals(calculated, entry.digest) ||
        completeDecoded.messageId !== objectMessageId
      ) {
        invalid()
      }
      this.#entries.delete(key)
      this.#reserved -= entry.totalObjectBytes
      clearEntry(entry)
      const result = complete
      complete = null
      return result
    } catch (err) {
      if (err instanceof PrivateRouteError) throw err
      invalid()
    } finally {
      clear(canonical)
      if (decoded) {
        clear(decoded.body)
        clear(decoded.authSuffix)
      }
      if (completeDecoded) {
        clear(completeDecoded.body)
        clear(completeDecoded.authSuffix)
      }
      clear(complete)
      clear(calculated)
    }
  }

  destroy() {
    if (this.#destroyed) return false
    this.#destroyed = true
    for (const entry of this.#entries.values()) clearEntry(entry)
    this.#entries.clear()
    this.#reserved = 0
    this.#now = null
    return true
  }

  #expire(current) {
    for (const [key, entry] of this.#entries) {
      if (current < entry.expiresAt) continue
      this.#entries.delete(key)
      this.#reserved -= entry.totalObjectBytes
      clearEntry(entry)
    }
  }
}
