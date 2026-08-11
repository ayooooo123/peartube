import b4a from 'b4a'

export const COMPANION_CONTRACT_LIMITS = Object.freeze({
  maxErrorBytes: 512,
  maxErrorCodeBytes: 64,
  maxErrorMessageBytes: 256,
  maxFieldBytes: 64,
  maxIdBytes: 128,
  maxIdentifierBytes: 512,
  maxNamespaceBytes: 64,
  maxTitleBytes: 256,
  maxCursorBytes: 512,
  maxCandidates: 64,
  defaultSearchLimit: 20,
  maxJsonDepth: 16,
  maxJsonFields: 128,
  maxJsonStringBytes: 4096
})

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CANDIDATE_REF = /^[A-Za-z0-9_-]{43}$/
const KIND = new Set(['movie', 'episode'])
const CANONICAL_NAMESPACE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/
const SEARCH_FIELDS = new Set(['namespace', 'identifier', 'kind', 'season', 'episode', 'title', 'year', 'limit', 'cursor'])
const OPEN_FIELDS = new Set(['candidateRef'])
const INGEST_FIELDS = new Set(['idempotencyKey', 'request', 'spool', 'sourceCapability'])
const FORBIDDEN_INGEST_FIELD = /(?:url|uri|link|href|magnet|torrent|cookie|authorization|credential|secret|password|passkey|tracker|header)/i

function byteLength (value) {
  return b4a.byteLength(String(value))
}

function containsControlCharacter (value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 31 || (code >= 127 && code <= 159)) return true
  }
  return false
}

function boundedString (value, field, maximum, { pattern = null, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || byteLength(value) > maximum || containsControlCharacter(value)) {
    throw new CompanionContractError(400, 'INVALID_FIELD', `Invalid ${field}`, field)
  }
  if (pattern && !pattern.test(value)) throw new CompanionContractError(400, 'INVALID_FIELD', `Invalid ${field}`, field)
  return value
}

function canonicalString (value, field, maximum, pattern = null) {
  const result = boundedString(value, field, maximum, { pattern })
  const encoded = b4a.from(result, 'utf8')
  if (result.normalize('NFC') !== result || b4a.toString(encoded, 'utf8') !== result) {
    throw new CompanionContractError(400, 'INVALID_FIELD', `Invalid ${field}`, field)
  }
  return result
}

function positiveIntegerText (value, field, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^[1-9][0-9]*$/.test(value || '')) throw new CompanionContractError(400, 'INVALID_FIELD', `Invalid ${field}`, field)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number > maximum) throw new CompanionContractError(400, 'INVALID_FIELD', `Invalid ${field}`, field)
  return number
}

function optionalQueryValue (values, field) {
  const entries = values.getAll(field)
  if (entries.length > 1) throw new CompanionContractError(400, 'DUPLICATE_FIELD', `Duplicate ${field}`, field)
  return entries.length === 0 ? null : entries[0]
}

function onlyFields (value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CompanionContractError(400, 'INVALID_BODY', `${label} must be an object`)
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new CompanionContractError(400, 'UNKNOWN_FIELD', `Unknown ${label} field`, field)
  }
  return value
}

export class CompanionContractError extends Error {
  constructor (statusCode, code, message, field = null) {
    const safeCode = typeof code === 'string' && ERROR_CODE.test(code) ? code : 'INTERNAL_ERROR'
    const safeMessage = typeof message === 'string' && message.length > 0 && byteLength(message) <= COMPANION_CONTRACT_LIMITS.maxErrorMessageBytes
      ? message
      : 'Companion request failed'
    super(safeMessage)
    this.name = 'CompanionContractError'
    this.statusCode = Number.isSafeInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500
    this.code = safeCode
    this.field = typeof field === 'string' && FIELD.test(field) ? field : null
  }
}

export function errorBody (error) {
  const known = error instanceof CompanionContractError
  const result = {
    error: {
      code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : 'Companion request failed'
    }
  }
  if (known && error.field) result.error.field = error.field
  if (byteLength(JSON.stringify(result)) > COMPANION_CONTRACT_LIMITS.maxErrorBytes) {
    return { error: { code: 'INTERNAL_ERROR', message: 'Companion request failed' } }
  }
  return result
}

function strictJsonParser (source) {
  let index = 0
  let fields = 0

  function fail () {
    throw new CompanionContractError(400, 'MALFORMED_JSON', 'Malformed JSON body')
  }

  function whitespace () {
    while (index < source.length && /[ \t\r\n]/.test(source[index])) index++
  }

  function string () {
    if (source[index] !== '"') fail()
    const start = index++
    while (index < source.length) {
      const char = source[index++]
      if (char === '"') {
        try {
          const value = JSON.parse(source.slice(start, index))
          if (byteLength(value) > COMPANION_CONTRACT_LIMITS.maxJsonStringBytes) {
            throw new CompanionContractError(400, 'INVALID_FIELD', 'JSON string exceeds its bound')
          }
          return value
        } catch (error) {
          if (error instanceof CompanionContractError) throw error
          fail()
        }
      }
      if (char === '\\') {
        if (index >= source.length) fail()
        const escape = source[index++]
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(index, index + 4))) fail()
          index += 4
        } else if (!'"\\/bfnrt'.includes(escape)) fail()
      } else if (char < ' ') fail()
    }
    fail()
  }

  function number () {
    const match = source.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/)
    if (!match) fail()
    index += match[0].length
    const value = Number(match[0])
    if (!Number.isFinite(value)) fail()
    return value
  }

  function value (depth) {
    if (depth > COMPANION_CONTRACT_LIMITS.maxJsonDepth) {
      throw new CompanionContractError(400, 'INVALID_BODY', 'JSON body exceeds its depth bound')
    }
    whitespace()
    const char = source[index]
    if (char === '"') return string()
    if (char === '{') return object(depth + 1)
    if (char === '[') return array(depth + 1)
    if (source.startsWith('true', index)) { index += 4; return true }
    if (source.startsWith('false', index)) { index += 5; return false }
    if (source.startsWith('null', index)) { index += 4; return null }
    return number()
  }

  function object (depth) {
    index++
    whitespace()
    const result = {}
    const names = new Set()
    if (source[index] === '}') { index++; return result }
    while (index < source.length) {
      whitespace()
      const name = string()
      if (names.has(name)) throw new CompanionContractError(400, 'DUPLICATE_FIELD', 'Duplicate JSON field', boundedFieldName(name))
      names.add(name)
      fields++
      if (fields > COMPANION_CONTRACT_LIMITS.maxJsonFields) {
        throw new CompanionContractError(400, 'INVALID_BODY', 'JSON body has too many fields')
      }
      whitespace()
      if (source[index++] !== ':') fail()
      const child = value(depth)
      Object.defineProperty(result, name, { value: child, enumerable: true, configurable: true, writable: true })
      whitespace()
      const delimiter = source[index++]
      if (delimiter === '}') return result
      if (delimiter !== ',') fail()
    }
    fail()
  }

  function array (depth) {
    index++
    whitespace()
    const result = []
    if (source[index] === ']') { index++; return result }
    while (index < source.length) {
      result.push(value(depth))
      if (result.length > COMPANION_CONTRACT_LIMITS.maxJsonFields) {
        throw new CompanionContractError(400, 'INVALID_BODY', 'JSON array exceeds its bound')
      }
      whitespace()
      const delimiter = source[index++]
      if (delimiter === ']') return result
      if (delimiter !== ',') fail()
    }
    fail()
  }

  whitespace()
  if (index >= source.length) fail()
  const result = value(0)
  whitespace()
  if (index !== source.length) fail()
  return result
}

function boundedFieldName (value) {
  return typeof value === 'string' && FIELD.test(value) ? value : null
}

export function decodeJsonBody (body) {
  let source
  try {
    source = b4a.toString(b4a.from(body || b4a.alloc(0)), 'utf8')
  } catch {
    throw new CompanionContractError(400, 'MALFORMED_JSON', 'Malformed JSON body')
  }
  return strictJsonParser(source)
}

export function decodeSearchQuery (values) {
  if (!values || typeof values.getAll !== 'function') throw new CompanionContractError(400, 'INVALID_QUERY', 'Invalid search query')
  for (const [field] of values) {
    if (!SEARCH_FIELDS.has(field)) throw new CompanionContractError(400, 'UNKNOWN_FIELD', 'Unknown search field', boundedFieldName(field))
  }

  const raw = Object.fromEntries([...SEARCH_FIELDS].map(field => [field, optionalQueryValue(values, field)]))
  const kind = boundedString(raw.kind, 'kind', 16)
  if (!KIND.has(kind)) throw new CompanionContractError(400, 'INVALID_FIELD', 'Invalid kind', 'kind')

  const hasExact = raw.namespace !== null || raw.identifier !== null
  const hasFallback = raw.title !== null || raw.year !== null
  if (hasExact === hasFallback) throw new CompanionContractError(400, 'INVALID_QUERY', 'Provide exactly one exact or title selector')

  let selector
  if (hasExact) {
    if (raw.namespace === null || raw.identifier === null) throw new CompanionContractError(400, 'INVALID_QUERY', 'Exact selector requires namespace and identifier')
    selector = {
      namespace: canonicalString(raw.namespace, 'namespace', COMPANION_CONTRACT_LIMITS.maxNamespaceBytes, CANONICAL_NAMESPACE),
      identifier: canonicalString(raw.identifier, 'identifier', COMPANION_CONTRACT_LIMITS.maxIdentifierBytes),
      kind
    }
  } else {
    if (raw.title === null) throw new CompanionContractError(400, 'INVALID_QUERY', 'Title selector requires title', 'title')
    selector = { title: boundedString(raw.title, 'title', COMPANION_CONTRACT_LIMITS.maxTitleBytes), kind }
    if (raw.year !== null) selector.year = positiveIntegerText(raw.year, 'year', 9999)
  }

  if (kind === 'episode') {
    if (raw.season === null || raw.episode === null) throw new CompanionContractError(400, 'INVALID_QUERY', 'Episode selector requires season and episode')
    selector.season = positiveIntegerText(raw.season, 'season')
    selector.episode = positiveIntegerText(raw.episode, 'episode')
  } else if (raw.season !== null || raw.episode !== null) {
    throw new CompanionContractError(400, 'INVALID_QUERY', 'Movie selector cannot include season or episode')
  }

  const limit = raw.limit === null
    ? COMPANION_CONTRACT_LIMITS.defaultSearchLimit
    : positiveIntegerText(raw.limit, 'limit', COMPANION_CONTRACT_LIMITS.maxCandidates)
  const cursor = raw.cursor === null
    ? null
    : boundedString(raw.cursor, 'cursor', COMPANION_CONTRACT_LIMITS.maxCursorBytes, { pattern: /^[A-Za-z0-9._~-]+$/ })
  return { selector, limit, cursor }
}

export function decodeOpenStreamBody (body) {
  const value = onlyFields(decodeJsonBody(body), OPEN_FIELDS, 'stream-open body')
  return { candidateRef: boundedString(value.candidateRef, 'candidateRef', 64, { pattern: CANDIDATE_REF }) }
}

function inspectIngestValue (value, depth = 0) {
  if (depth > COMPANION_CONTRACT_LIMITS.maxJsonDepth) throw new CompanionContractError(400, 'INVALID_BODY', 'Ingest request exceeds its depth bound')
  if (typeof value === 'string') {
    if (byteLength(value) > COMPANION_CONTRACT_LIMITS.maxJsonStringBytes || /^(?:(?:https?|magnet|ipfs|pear|blob|data|file|ftp|rtsp):|\/\/)/i.test(value)) {
      throw new CompanionContractError(400, 'INVALID_FIELD', 'Ingest request contains prohibited data')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) inspectIngestValue(child, depth + 1)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [field, child] of Object.entries(value)) {
    if (FORBIDDEN_INGEST_FIELD.test(field)) throw new CompanionContractError(400, 'UNKNOWN_FIELD', 'Ingest request contains a prohibited field', boundedFieldName(field))
    inspectIngestValue(child, depth + 1)
  }
}

export function decodeIngestJobBody (body) {
  const value = onlyFields(decodeJsonBody(body), INGEST_FIELDS, 'ingest-job body')
  const idempotencyKey = boundedString(value.idempotencyKey, 'idempotencyKey', 128, { pattern: ID })
  if (!value.request || typeof value.request !== 'object' || Array.isArray(value.request)) {
    throw new CompanionContractError(400, 'INVALID_FIELD', 'Invalid request', 'request')
  }
  inspectIngestValue(value.request)
  const result = { idempotencyKey, request: value.request }
  if (value.spool !== undefined) {
    if (value.spool !== null && (!value.spool || typeof value.spool !== 'object' || Array.isArray(value.spool))) {
      throw new CompanionContractError(400, 'INVALID_FIELD', 'Invalid spool', 'spool')
    }
    inspectIngestValue(value.spool)
    result.spool = value.spool
  }
  if (value.sourceCapability !== undefined) {
    result.sourceCapability = boundedString(value.sourceCapability, 'sourceCapability', 256, { pattern: /^[A-Za-z0-9._~-]+$/ })
  }
  return result
}

export function decodeId (value, field) {
  return boundedString(value, field, COMPANION_CONTRACT_LIMITS.maxIdBytes, { pattern: ID })
}
