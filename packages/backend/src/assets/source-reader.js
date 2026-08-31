import b4a from 'b4a'
import crypto from 'hypercore-crypto'

export const MAX_SOURCE_BYTE_LENGTH = 256 * 1024 * 1024 * 1024

const SOURCE_READER = Symbol('peartube.source-reader')
const IDENTITY_KINDS = new Set(['sha256', 'etag'])

function cancelledError () {
  const error = new Error('source read cancelled')
  error.code = 'ASSET_WRITE_CANCELLED'
  return error
}

function assertActive (signal) {
  if (signal?.aborted) throw cancelledError()
}

function boundedText (value, name, maxBytes) {
  if (typeof value !== 'string' || value.length === 0 || b4a.byteLength(value) > maxBytes || value.includes('\0')) {
    throw new Error(`${name} must be a bounded non-empty string`)
  }
  return value
}

function normalizeIdentity (identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) || !IDENTITY_KINDS.has(identity.kind)) {
    throw new Error("source identity kind must be 'sha256' or 'etag'")
  }
  let value = boundedText(identity.value, 'source identity value', 512)
  if (identity.kind === 'sha256') {
    value = value.toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('sha256 source identity must be 32-byte lowercase hex')
  }
  return { kind: identity.kind, value }
}

function normalizeDescription (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('source describe() must return an object')
  const byteLength = value.byteLength
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_SOURCE_BYTE_LENGTH) {
    throw new Error('source byteLength exceeds the hostile-input ceiling')
  }
  return {
    identity: normalizeIdentity(value.identity),
    byteLength,
    mimeType: boundedText(value.mimeType, 'source mimeType', 256),
  }
}

function sameIdentity (left, right) {
  return left.kind === right.kind && left.value === right.value
}

function sourceChangedError () {
  const error = new Error('source identity or byte length changed between opens')
  error.code = 'ASSET_SOURCE_IDENTITY_CHANGED'
  return error
}

function normalizeRange (description, maxReadBytes, input = {}) {
  const offset = input.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > description.byteLength) {
    throw new Error('source range offset is outside the described byte length')
  }
  const length = input.length ?? (description.byteLength - offset)
  if (!Number.isSafeInteger(length) || length < 0 || length > maxReadBytes || offset + length > description.byteLength) {
    throw new Error('source range length is outside the described byte length or maxReadBytes')
  }
  return { offset, length }
}

function asAsyncIterable (source) {
  if (source && typeof source[Symbol.asyncIterator] === 'function') return source
  if (source && typeof source[Symbol.iterator] === 'function') {
    return (async function * () { yield * source })()
  }
  throw new Error('source implementation must return an iterable of Uint8Array chunks')
}

async function nextWithSignal (iterator, signal) {
  assertActive(signal)
  if (!signal) return iterator.next()
  let onAbort
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(cancelledError())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([iterator.next(), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export function isSourceReader (value) {
  return value?.[SOURCE_READER] === true
}

export function createSourceReader (implementation = {}) {
  if (isSourceReader(implementation)) return implementation
  if (!implementation || typeof implementation.describe !== 'function' ||
      typeof implementation.open !== 'function' || typeof implementation.close !== 'function') {
    throw new Error('SourceReader requires describe(), open(), and close()')
  }
  if (typeof implementation.resumable !== 'boolean') throw new Error('SourceReader resumable must be a boolean')
  const maxReadBytes = implementation.maxReadBytes
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 1 || maxReadBytes > MAX_SOURCE_BYTE_LENGTH) {
    throw new Error('SourceReader maxReadBytes must be a positive safe integer within the hostile-input ceiling')
  }

  let baseline = null
  let closed = false
  let opened = false

  async function describe ({ signal } = {}) {
    if (closed) throw new Error('SourceReader is closed')
    assertActive(signal)
    const next = normalizeDescription(await implementation.describe({ signal }))
    assertActive(signal)
    if (next.byteLength > maxReadBytes && implementation.resumable === false) {
      throw new Error('one-shot source byteLength exceeds maxReadBytes')
    }
    if (baseline === null) baseline = next
    else if (!sameIdentity(baseline.identity, next.identity) || baseline.byteLength !== next.byteLength) throw sourceChangedError()
    return { identity: { ...baseline.identity }, byteLength: baseline.byteLength, mimeType: baseline.mimeType }
  }

  return Object.freeze({
    [SOURCE_READER]: true,
    resumable: implementation.resumable,
    maxReadBytes,
    describe,
    open (input = {}) {
      return (async function * () {
        const signal = input.signal
        const description = await describe({ signal })
        if (!implementation.resumable && opened) throw new Error('one-shot SourceReader may only be opened once')
        const range = normalizeRange(description, maxReadBytes, input)
        opened = true
        const source = asAsyncIterable(implementation.open({ ...range, signal }))
        const iterator = source[Symbol.asyncIterator]()
        let read = 0
        try {
          while (true) {
            const step = await nextWithSignal(iterator, signal)
            if (step.done) break
            const value = step.value
            if (!(value instanceof Uint8Array)) throw new Error('source chunks must be Uint8Array values')
            if (value.byteLength === 0) continue
            read += value.byteLength
            if (read > range.length) {
              const error = new Error(`source range overran its requested ${range.length} bytes`)
              error.code = 'ASSET_SOURCE_LONG_READ'
              throw error
            }
            yield value
          }
          assertActive(signal)
          if (read !== range.length) {
            const error = new Error(`source range ended after ${read} of ${range.length} requested bytes`)
            error.code = 'SOURCE_RANGE_SHORT'
            throw error
          }
        } finally {
          if (typeof iterator.return === 'function') {
            const closing = Promise.resolve(iterator.return())
            if (signal?.aborted) closing.catch(() => {})
            else await closing
          }
        }
      })()
    },
    async close (reason) {
      if (closed) return
      closed = true
      await implementation.close(reason)
    },
  })
}

function localIdentity (label, bytes) {
  return { kind: 'etag', value: `${label}:${b4a.toString(crypto.hash(bytes), 'hex')}` }
}

export function createBufferSourceReader (value, { mimeType = 'application/octet-stream' } = {}) {
  if (!(value instanceof Uint8Array)) throw new Error('buffer source must be a Uint8Array')
  const bytes = value
  return createSourceReader({
    resumable: true,
    maxReadBytes: Math.max(1, bytes.byteLength),
    async describe () {
      return { identity: localIdentity('buffer-blake2b', bytes), byteLength: bytes.byteLength, mimeType }
    },
    open ({ offset, length }) {
      return (async function * () {
        if (length > 0) yield bytes.subarray(offset, offset + length)
      })()
    },
    async close () {},
  })
}

export function createFileSourceReader ({ fs, path, mimeType = 'application/octet-stream' } = {}) {
  if (!fs || typeof fs.statSync !== 'function' || typeof fs.createReadStream !== 'function') {
    throw new Error('file SourceReader requires statSync() and createReadStream()')
  }
  const initial = fs.statSync(path)
  const byteLength = initial.size
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_SOURCE_BYTE_LENGTH) {
    throw new Error('source byteLength exceeds the hostile-input ceiling')
  }
  const token = ['file', initial.dev ?? '', initial.ino ?? '', byteLength, initial.mtimeMs ?? initial.mtime?.getTime?.() ?? ''].join(':')
  return createSourceReader({
    resumable: true,
    maxReadBytes: MAX_SOURCE_BYTE_LENGTH,
    async describe () {
      const stat = fs.statSync(path)
      const current = ['file', stat.dev ?? '', stat.ino ?? '', stat.size, stat.mtimeMs ?? stat.mtime?.getTime?.() ?? ''].join(':')
      return { identity: { kind: 'etag', value: current || token }, byteLength: stat.size, mimeType }
    },
    open ({ offset, length, signal }) {
      if (length === 0) return (async function * () {})()
      const stream = fs.createReadStream(path, { start: offset, end: offset + length - 1 })
      if (signal && typeof stream.destroy === 'function') {
        const abort = () => stream.destroy(cancelledError())
        signal.addEventListener('abort', abort, { once: true })
        stream.once?.('close', () => signal.removeEventListener('abort', abort))
      }
      return stream
    },
    async close () {},
  })
}

export function createOneShotSourceReader ({ source, identity, byteLength, mimeType = 'application/octet-stream' } = {}) {
  let consumed = false
  return createSourceReader({
    resumable: false,
    maxReadBytes: Math.max(1, byteLength),
    async describe () { return { identity, byteLength, mimeType } },
    open ({ offset, length }) {
      if (consumed || offset !== 0 || length !== byteLength) throw new Error('one-shot source can only be opened once for its full range')
      consumed = true
      return asAsyncIterable(source)
    },
    async close (reason) {
      if (reason && typeof source?.destroy === 'function') source.destroy(reason)
    },
  })
}
