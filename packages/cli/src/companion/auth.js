import b4a from 'b4a'
import sodium from 'sodium-universal'

export const CONTROL_AUTH_HEADERS = Object.freeze({
  client: 'X-PearTube-Client',
  timestamp: 'X-PearTube-Timestamp',
  nonce: 'X-PearTube-Nonce',
  mac: 'X-PearTube-MAC'
})

const BODY_HASH_BYTES = 32
const MAX_CLIENT_BYTES = 128
const MAX_NONCE_BYTES = 128
const MAX_PATH_BYTES = 8192
const UPPER_HEX = '0123456789ABCDEF'

function encodeFormComponent (value) {
  const bytes = b4a.from(value, 'utf8')
  let encoded = ''
  for (const byte of bytes) {
    if (
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2a ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f
    ) {
      encoded += String.fromCharCode(byte)
    } else if (byte === 0x20) {
      encoded += '+'
    } else {
      encoded += `%${UPPER_HEX[byte >>> 4]}${UPPER_HEX[byte & 0x0f]}`
    }
  }
  return encoded
}

export class CompanionAuthError extends Error {
  constructor (code, message, statusCode = 401) {
    super(message)
    this.name = 'CompanionAuthError'
    this.code = code
    this.statusCode = statusCode
  }
}

function authError (code, message, statusCode = 401) {
  return new CompanionAuthError(code, message, statusCode)
}

function asBuffer (value) {
  if (typeof value === 'string') return b4a.from(value)
  if (value == null) return b4a.alloc(0)
  if (ArrayBuffer.isView(value)) return value
  throw new TypeError('Companion request body must be bytes or a string')
}

function header (headers, name) {
  if (!headers) return ''
  if (typeof headers.get === 'function') return headers.get(name) || ''
  const lower = name.toLowerCase()
  if (headers[lower] !== undefined) return String(headers[lower])
  if (headers[name] !== undefined) return String(headers[name])
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return Array.isArray(value) ? value.join(',') : String(value)
  }
  return ''
}

function keyFromSecret (secret) {
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) {
    throw authError(
      'AUTH_CONFIGURATION_INVALID',
      'Companion shared secret must be 64 lowercase hexadecimal characters',
      503
    )
  }
  return b4a.from(secret, 'hex')
}

export function canonicalizePathAndQuery (rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/') || rawPath.startsWith('//')) {
    throw authError('INVALID_REQUEST_TARGET', 'Invalid companion request target', 400)
  }
  if (b4a.from(rawPath).byteLength > MAX_PATH_BYTES || rawPath.includes('#')) {
    throw authError('INVALID_REQUEST_TARGET', 'Invalid companion request target', 400)
  }

  let url
  try {
    url = new URL(rawPath, 'http://companion.invalid')
  } catch {
    throw authError('INVALID_REQUEST_TARGET', 'Invalid companion request target', 400)
  }
  if (url.protocol !== 'http:' || url.hostname !== 'companion.invalid' || url.port) {
    throw authError('INVALID_REQUEST_TARGET', 'Invalid companion request target', 400)
  }

  const entries = Array.from(url.searchParams)

  entries.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1
    if (leftValue === rightValue) return 0
    return leftValue < rightValue ? -1 : 1
  })
  if (!entries.length) return url.pathname

  let query = ''
  for (const [key, value] of entries) {
    if (query) query += '&'
    query += `${encodeFormComponent(key)}=${encodeFormComponent(value)}`
  }
  return `${url.pathname}?${query}`
}

export function createBodyHasher () {
  const state = b4a.alloc(sodium.crypto_generichash_STATEBYTES)
  sodium.crypto_generichash_init(state, null, BODY_HASH_BYTES)
  let finalized = false

  return {
    update (chunk) {
      if (finalized) throw new Error('Companion body hash is already finalized')
      sodium.crypto_generichash_update(state, asBuffer(chunk))
    },
    digest () {
      if (finalized) throw new Error('Companion body hash is already finalized')
      finalized = true
      const digest = b4a.alloc(BODY_HASH_BYTES)
      sodium.crypto_generichash_final(state, digest)
      return b4a.toString(digest, 'hex')
    }
  }
}

export function hashControlBody (body) {
  const digest = b4a.alloc(BODY_HASH_BYTES)
  sodium.crypto_generichash(digest, asBuffer(body))
  return b4a.toString(digest, 'hex')
}

export function canonicalControlRequest ({ method, path, timestamp, nonce, bodyHash }) {
  const normalizedMethod = typeof method === 'string' ? method.trim().toUpperCase() : ''
  if (!/^[A-Z]+$/.test(normalizedMethod)) {
    throw authError('INVALID_REQUEST', 'Invalid companion authentication')
  }
  const timestampText = String(timestamp)
  if (!/^(0|[1-9]\d*)$/.test(timestampText) || !Number.isSafeInteger(Number(timestampText))) {
    throw authError('INVALID_REQUEST', 'Invalid companion authentication')
  }
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) {
    throw authError('INVALID_REQUEST', 'Invalid companion authentication')
  }
  if (typeof bodyHash !== 'string' || !/^[a-f0-9]{64}$/.test(bodyHash)) {
    throw authError('INVALID_REQUEST', 'Invalid companion authentication')
  }
  return b4a.from([
    normalizedMethod,
    canonicalizePathAndQuery(path),
    timestampText,
    nonce,
    bodyHash
  ].join('\n'))
}

export function createNonceStore ({ maxEntries = 4096 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error('Companion nonce store maxEntries must be a positive integer')
  }
  const entries = new Map()
  const entryKey = (client, nonce) => `${client}\u0000${nonce}`

  return {
    get size () {
      return entries.size
    },
    has (client, nonce) {
      return entries.has(entryKey(client, nonce))
    },
    add (client, nonce, timestamp) {
      const key = entryKey(client, nonce)
      if (entries.has(key) || entries.size >= maxEntries) return false
      entries.set(key, Number(timestamp))
      return true
    },
    prune (minimumTimestamp) {
      for (const [key, timestamp] of entries) {
        if (timestamp >= minimumTimestamp) continue
        entries.delete(key)
      }
    }
  }
}

export function signControlRequest ({ method, path, body = b4a.alloc(0), timestamp, nonce, client, secret }) {
  const bodyHash = hashControlBody(body)
  const canonical = canonicalControlRequest({ method, path, timestamp, nonce, bodyHash })
  const mac = b4a.alloc(sodium.crypto_auth_BYTES)
  const key = keyFromSecret(secret)
  try {
    sodium.crypto_auth(mac, canonical, key)
  } finally {
    sodium.sodium_memzero(key)
  }
  return {
    [CONTROL_AUTH_HEADERS.client]: client,
    [CONTROL_AUTH_HEADERS.timestamp]: String(timestamp),
    [CONTROL_AUTH_HEADERS.nonce]: nonce,
    [CONTROL_AUTH_HEADERS.mac]: b4a.toString(mac, 'hex')
  }
}

export function prevalidateControlRequest ({
  headers,
  client,
  clock = Date.now,
  maxClockSkewMs = 30_000
}) {
  const requestClient = header(headers, CONTROL_AUTH_HEADERS.client)
  const timestampText = header(headers, CONTROL_AUTH_HEADERS.timestamp)
  const nonce = header(headers, CONTROL_AUTH_HEADERS.nonce)
  const macHex = header(headers, CONTROL_AUTH_HEADERS.mac)
  if (!requestClient || !timestampText || !nonce || !macHex) {
    throw authError('AUTH_REQUIRED', 'Companion authentication is required')
  }
  if (b4a.from(requestClient).byteLength > MAX_CLIENT_BYTES || requestClient !== client) {
    throw authError('INVALID_MAC', 'Invalid companion authentication')
  }
  if (!/^(0|[1-9]\d*)$/.test(timestampText)) {
    throw authError('INVALID_MAC', 'Invalid companion authentication')
  }
  const timestamp = Number(timestampText)
  const now = Number(clock())
  if (!Number.isSafeInteger(timestamp) || !Number.isFinite(now)) {
    throw authError('INVALID_MAC', 'Invalid companion authentication')
  }
  const skew = Number(maxClockSkewMs)
  if (!Number.isFinite(skew) || skew <= 0 || Math.abs(now - timestamp) > skew) {
    throw authError('STALE_REQUEST', 'Stale companion request')
  }
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) {
    throw authError('INVALID_REQUEST', 'Invalid companion authentication')
  }
  if (!/^[a-fA-F0-9]+$/.test(macHex) || macHex.length !== sodium.crypto_auth_BYTES * 2) {
    throw authError('INVALID_MAC', 'Invalid companion authentication')
  }
  return Object.freeze({ client: requestClient, timestamp, nonce, macHex, now, skew })
}

export function verifyPrevalidatedControlRequest ({
  method,
  path,
  bodyHash,
  metadata,
  secret,
  nonceStore = createNonceStore()
}) {
  if (!metadata || typeof metadata !== 'object' ||
      typeof metadata.client !== 'string' ||
      !Number.isSafeInteger(metadata.timestamp) ||
      typeof metadata.nonce !== 'string' ||
      typeof metadata.macHex !== 'string' ||
      !Number.isFinite(metadata.now) ||
      !Number.isFinite(metadata.skew)) {
    throw authError('INVALID_MAC', 'Invalid companion authentication')
  }
  const canonical = canonicalControlRequest({
    method,
    path,
    timestamp: metadata.timestamp,
    nonce: metadata.nonce,
    bodyHash
  })
  nonceStore.prune(metadata.now - metadata.skew)
  if (nonceStore.has(metadata.client, metadata.nonce)) {
    throw authError('NONCE_REPLAY', 'Companion nonce replay', 409)
  }

  const mac = b4a.from(metadata.macHex, 'hex')
  const key = keyFromSecret(secret)
  let valid
  try {
    valid = sodium.crypto_auth_verify(mac, canonical, key)
  } finally {
    sodium.sodium_memzero(key)
  }
  if (!valid) {
    throw authError('INVALID_MAC', 'Invalid companion authentication')
  }
  if (!nonceStore.add(metadata.client, metadata.nonce, metadata.timestamp)) {
    throw authError('NONCE_STORE_FULL', 'Companion authentication capacity exhausted', 503)
  }
  return {
    client: metadata.client,
    timestamp: metadata.timestamp,
    nonce: metadata.nonce
  }
}

export function verifyControlRequest ({
  method,
  path,
  bodyHash,
  headers,
  secret,
  client,
  clock = Date.now,
  nonceStore = createNonceStore(),
  maxClockSkewMs = 30_000
}) {
  const metadata = prevalidateControlRequest({ headers, client, clock, maxClockSkewMs })
  return verifyPrevalidatedControlRequest({
    method,
    path,
    bodyHash,
    metadata,
    secret,
    nonceStore
  })
}
