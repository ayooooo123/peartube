import b4a from 'b4a'
import c from 'compact-encoding'

import { INDEX_SCHEMA_LIMITS } from './schema.js'

export const INDEX_QUERY_REQUEST_DOMAIN = 'peartube.index-query.request.v1'
export const INDEX_QUERY_PAGE_DOMAIN = 'peartube.index-query.page.v1'
export const INDEX_QUERY_ERROR_DOMAIN = 'peartube.index-query.error.v1'
export const INDEX_QUERY_CANCEL_DOMAIN = 'peartube.index-query.cancel.v1'

export const MAX_INDEX_QUERY_FRAME_BYTES = 48 * 1024
const MAX_INDEX_QUERY_PAYLOAD_BYTES = MAX_INDEX_QUERY_FRAME_BYTES - 32
export const MAX_INDEX_QUERY_SELECTORS = 16
export const MAX_INDEX_QUERY_TEXT_BYTES = INDEX_SCHEMA_LIMITS.maxExternalIdentifierBytes
export const MAX_INDEX_QUERY_CURSOR_BYTES = 2 * 1024
export const MAX_INDEX_QUERY_RESULTS = 64
export const MAX_INDEX_QUERY_ERROR_DETAIL_BYTES = INDEX_SCHEMA_LIMITS.maxAdmissionReasonBytes
export const MAX_INDEX_QUERY_DEADLINE_MS = 30_000
export const MAX_INDEX_QUERY_ID_BYTES = 64
export const MAX_INDEX_QUERY_SOURCE_REVISION_BYTES = 64

export const INDEX_QUERY_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_CURSOR: 'INVALID_CURSOR',
  RESULT_LIMIT_EXCEEDED: 'RESULT_LIMIT_EXCEEDED',
  DEADLINE_EXCEEDED: 'DEADLINE_EXCEEDED',
  CANCELLED: 'CANCELLED',
  OVERLOADED: 'OVERLOADED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  CLOSED: 'CLOSED',
})

const ERROR_CODES = Object.freeze(Object.values(INDEX_QUERY_ERROR_CODES))
const ERROR_CODE_TO_NUMBER = new Map(ERROR_CODES.map((code, index) => [code, index + 1]))
const ERROR_NUMBER_TO_CODE = new Map(ERROR_CODES.map((code, index) => [index + 1, code]))
const SELECTOR_TYPE_TO_NUMBER = new Map([['exact-external-ref', 1], ['title-token-prefix', 2]])
const SELECTOR_NUMBER_TO_TYPE = new Map(Array.from(SELECTOR_TYPE_TO_NUMBER, ([type, number]) => [number, type]))
const RESULT_TYPE_TO_NUMBER = new Map([['external-ref', 1], ['title-token', 2]])
const RESULT_NUMBER_TO_TYPE = new Map(Array.from(RESULT_TYPE_TO_NUMBER, ([type, number]) => [number, type]))
const HEX_32 = /^[0-9a-f]{64}$/
const CURSOR_TEXT = /^[A-Za-z0-9_-]+$/
const SOURCE_REVISION = /^(0|[1-9]\d*):(0|[1-9]\d*)$/
const TOKEN = /^[\p{L}\p{N}]+$/u

function fail(message, code = 'INDEX_QUERY_CODEC_REJECTED') {
  const error = new Error(message)
  error.code = code
  throw error
}

function onlyFields(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`)
  const allowed = new Set(fields)
  for (const field of Object.keys(value)) if (!allowed.has(field)) fail(`${name} has unsupported fields`)
  for (const field of fields) if (!Object.hasOwn(value, field)) fail(`${name} must have exact fields`)
}

function boundedText(value, name, maximum, { form = 'NFC', allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) fail(`${name} must be bounded text`)
  if (value.normalize(form) !== value) fail(`${name} must be canonical ${form} text`)
  const encoded = b4a.from(value, 'utf8')
  if (encoded.byteLength > maximum || (!allowEmpty && encoded.byteLength === 0)) fail(`${name} exceeds its text bound`)
  if (!b4a.equals(b4a.from(b4a.toString(encoded, 'utf8'), 'utf8'), encoded)) fail(`${name} must be canonical UTF-8`)
  if (/\p{Cc}/u.test(value)) fail(`${name} contains control text`)
  return value
}

function protocolId(value, name = 'queryId') {
  boundedText(value, name, MAX_INDEX_QUERY_ID_BYTES)
  if (!HEX_32.test(value)) fail(`${name} must be a lowercase 32-byte hexadecimal identifier`)
  return value
}

function publisherId(value) {
  boundedText(value, 'publisherId', 64)
  if (!HEX_32.test(value)) fail('publisherId must be a lowercase 32-byte hexadecimal identifier')
  return value
}

function safeUint(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${name} must be a bounded safe integer`)
  return value
}

function normalizeNamespace(value) {
  boundedText(value, 'selector namespace', INDEX_SCHEMA_LIMITS.maxExternalNamespaceBytes)
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value)) fail('selector namespace is not canonical')
  return value
}

function normalizeIdentifier(value) {
  return boundedText(value, 'selector identifier', INDEX_SCHEMA_LIMITS.maxExternalIdentifierBytes)
}

function normalizeTokenPrefix(value) {
  boundedText(value, 'selector token prefix', INDEX_SCHEMA_LIMITS.maxRelationEndpointBytes, { form: 'NFKC' })
  if (value.toLowerCase() !== value || !TOKEN.test(value)) fail('selector token prefix is not canonical')
  return value
}

function normalizeSelector(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('selector must be an object')
  if (value.type === 'exact-external-ref') {
    onlyFields(value, ['type', 'namespace', 'identifier'], 'exact external-reference selector')
    return Object.freeze({ type: value.type, namespace: normalizeNamespace(value.namespace), identifier: normalizeIdentifier(value.identifier) })
  }
  if (value.type === 'title-token-prefix') {
    onlyFields(value, ['type', 'prefix'], 'title-token prefix selector')
    return Object.freeze({ type: value.type, prefix: normalizeTokenPrefix(value.prefix) })
  }
  fail('selector type is invalid')
}

function selectorToken(selector) {
  return selector.type === 'exact-external-ref'
    ? `1\0${selector.namespace}\0${selector.identifier}`
    : `2\0${selector.prefix}`
}

export function normalizeIndexQuerySelectors(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_INDEX_QUERY_SELECTORS) fail('selectors exceed their bounded limit')
  const selectors = values.map(normalizeSelector)
  let previous = null
  for (const selector of selectors) {
    const current = selectorToken(selector)
    if (previous !== null && current <= previous) fail(previous === current ? 'selectors must be distinct' : 'selectors must be in canonical order')
    previous = current
  }
  return Object.freeze(selectors)
}

function normalizeCursorText(value, name = 'cursor') {
  if (value === null) return null
  boundedText(value, name, MAX_INDEX_QUERY_CURSOR_BYTES)
  if (!CURSOR_TEXT.test(value)) fail(`${name} is not canonical opaque text`)
  return value
}

function normalizeSourceRevision(value) {
  boundedText(value, 'sourceRevision', MAX_INDEX_QUERY_SOURCE_REVISION_BYTES)
  const match = SOURCE_REVISION.exec(value)
  if (!match) fail('sourceRevision is invalid')
  safeUint(Number(match[1]), 'source revision fork')
  safeUint(Number(match[2]), 'source revision length')
  return value
}

function normalizeRequest(value) {
  onlyFields(value, ['queryId', 'selectors', 'limit', 'cursor', 'deadlineMs'], 'query request')
  return Object.freeze({
    queryId: protocolId(value.queryId),
    selectors: normalizeIndexQuerySelectors(value.selectors),
    limit: safeUint(value.limit, 'query limit', 1, MAX_INDEX_QUERY_RESULTS),
    cursor: normalizeCursorText(value.cursor),
    deadlineMs: safeUint(value.deadlineMs, 'query deadlineMs', 1, MAX_INDEX_QUERY_DEADLINE_MS),
  })
}

function normalizeExactResult(value) {
  onlyFields(value, ['type', 'publisherId', 'sourceRecordRef', 'namespace', 'identifier', 'entityKind', 'entityId', 'evidenceWeight'], 'external-reference result')
  const evidenceWeight = value.evidenceWeight === null ? null : safeUint(value.evidenceWeight, 'evidenceWeight')
  return Object.freeze({
    type: 'external-ref',
    publisherId: publisherId(value.publisherId),
    sourceRecordRef: boundedText(value.sourceRecordRef, 'sourceRecordRef', INDEX_SCHEMA_LIMITS.maxSourceRecordRefBytes),
    namespace: normalizeNamespace(value.namespace),
    identifier: normalizeIdentifier(value.identifier),
    entityKind: boundedText(value.entityKind, 'entityKind', INDEX_SCHEMA_LIMITS.maxEntityKindBytes),
    entityId: boundedText(value.entityId, 'entityId', INDEX_SCHEMA_LIMITS.maxEntityIdBytes),
    evidenceWeight,
  })
}

function normalizeTokenResult(value) {
  onlyFields(value, ['type', 'publisherId', 'sourceRecordRef', 'token', 'targetId'], 'title-token result')
  return Object.freeze({
    type: 'title-token',
    publisherId: publisherId(value.publisherId),
    sourceRecordRef: boundedText(value.sourceRecordRef, 'sourceRecordRef', INDEX_SCHEMA_LIMITS.maxSourceRecordRefBytes),
    token: normalizeTokenPrefix(value.token),
    targetId: boundedText(value.targetId, 'targetId', INDEX_SCHEMA_LIMITS.maxRelationEndpointBytes),
  })
}

function normalizeResult(value) {
  if (value?.type === 'external-ref') return normalizeExactResult(value)
  if (value?.type === 'title-token') return normalizeTokenResult(value)
  fail('query result type is invalid')
}

function normalizePage(value) {
  onlyFields(value, ['queryId', 'results', 'nextCursor', 'sourceRevision'], 'query page')
  if (!Array.isArray(value.results) || value.results.length > MAX_INDEX_QUERY_RESULTS) fail('results exceed their bounded limit')
  return Object.freeze({
    queryId: protocolId(value.queryId),
    results: Object.freeze(value.results.map(normalizeResult)),
    nextCursor: normalizeCursorText(value.nextCursor, 'nextCursor'),
    sourceRevision: normalizeSourceRevision(value.sourceRevision),
  })
}

function normalizeError(value) {
  onlyFields(value, ['queryId', 'code', 'detail'], 'query error')
  if (!ERROR_CODE_TO_NUMBER.has(value.code)) fail('query error code is invalid')
  return Object.freeze({
    queryId: protocolId(value.queryId),
    code: value.code,
    detail: boundedText(value.detail, 'query error detail', MAX_INDEX_QUERY_ERROR_DETAIL_BYTES, { allowEmpty: true }),
  })
}

function normalizeCancel(value) {
  onlyFields(value, ['queryId'], 'query cancel')
  return Object.freeze({ queryId: protocolId(value.queryId) })
}

function encodeSelector(state, selector) {
  c.uint.encode(state, SELECTOR_TYPE_TO_NUMBER.get(selector.type))
  if (selector.type === 'exact-external-ref') {
    c.string.encode(state, selector.namespace)
    c.string.encode(state, selector.identifier)
  } else c.string.encode(state, selector.prefix)
}

function preencodeSelector(state, selector) {
  c.uint.preencode(state, SELECTOR_TYPE_TO_NUMBER.get(selector.type))
  if (selector.type === 'exact-external-ref') {
    c.string.preencode(state, selector.namespace)
    c.string.preencode(state, selector.identifier)
  } else c.string.preencode(state, selector.prefix)
}

function decodeSelector(state) {
  const type = SELECTOR_NUMBER_TO_TYPE.get(c.uint.decode(state))
  if (type === 'exact-external-ref') return { type, namespace: c.string.decode(state), identifier: c.string.decode(state) }
  if (type === 'title-token-prefix') return { type, prefix: c.string.decode(state) }
  fail('selector type is invalid')
}

function preencodeResult(state, result) {
  c.uint.preencode(state, RESULT_TYPE_TO_NUMBER.get(result.type))
  c.string.preencode(state, result.publisherId)
  c.string.preencode(state, result.sourceRecordRef)
  if (result.type === 'external-ref') {
    c.string.preencode(state, result.namespace)
    c.string.preencode(state, result.identifier)
    c.string.preencode(state, result.entityKind)
    c.string.preencode(state, result.entityId)
    c.bool.preencode(state, result.evidenceWeight !== null)
    if (result.evidenceWeight !== null) c.uint.preencode(state, result.evidenceWeight)
  } else {
    c.string.preencode(state, result.token)
    c.string.preencode(state, result.targetId)
  }
}

function encodeResult(state, result) {
  c.uint.encode(state, RESULT_TYPE_TO_NUMBER.get(result.type))
  c.string.encode(state, result.publisherId)
  c.string.encode(state, result.sourceRecordRef)
  if (result.type === 'external-ref') {
    c.string.encode(state, result.namespace)
    c.string.encode(state, result.identifier)
    c.string.encode(state, result.entityKind)
    c.string.encode(state, result.entityId)
    c.bool.encode(state, result.evidenceWeight !== null)
    if (result.evidenceWeight !== null) c.uint.encode(state, result.evidenceWeight)
  } else {
    c.string.encode(state, result.token)
    c.string.encode(state, result.targetId)
  }
}

function decodeResult(state) {
  const type = RESULT_NUMBER_TO_TYPE.get(c.uint.decode(state))
  if (!type) fail('query result type is invalid')
  const publisherId = c.string.decode(state)
  const sourceRecordRef = c.string.decode(state)
  if (type === 'external-ref') {
    const namespace = c.string.decode(state)
    const identifier = c.string.decode(state)
    const entityKind = c.string.decode(state)
    const entityId = c.string.decode(state)
    const evidenceWeight = c.bool.decode(state) ? c.uint.decode(state) : null
    return { type, publisherId, sourceRecordRef, namespace, identifier, entityKind, entityId, evidenceWeight }
  }
  return { type, publisherId, sourceRecordRef, token: c.string.decode(state), targetId: c.string.decode(state) }
}

function fixedCodec(domain, preencodeBody, encodeBody, decodeBody) {
  return {
    preencode(state, value) {
      c.string.preencode(state, domain)
      preencodeBody(state, value)
    },
    encode(state, value) {
      c.string.encode(state, domain)
      encodeBody(state, value)
    },
    decode(state) {
      if (c.string.decode(state) !== domain) fail('query codec domain is invalid')
      return decodeBody(state)
    },
  }
}

const requestCodec = fixedCodec(INDEX_QUERY_REQUEST_DOMAIN,
  (state, value) => {
    c.string.preencode(state, value.queryId)
    c.uint.preencode(state, value.selectors.length)
    for (const selector of value.selectors) preencodeSelector(state, selector)
    c.uint.preencode(state, value.limit)
    c.bool.preencode(state, value.cursor !== null)
    if (value.cursor !== null) c.string.preencode(state, value.cursor)
    c.uint.preencode(state, value.deadlineMs)
  },
  (state, value) => {
    c.string.encode(state, value.queryId)
    c.uint.encode(state, value.selectors.length)
    for (const selector of value.selectors) encodeSelector(state, selector)
    c.uint.encode(state, value.limit)
    c.bool.encode(state, value.cursor !== null)
    if (value.cursor !== null) c.string.encode(state, value.cursor)
    c.uint.encode(state, value.deadlineMs)
  },
  state => {
    const queryId = c.string.decode(state)
    const count = c.uint.decode(state)
    if (count > MAX_INDEX_QUERY_SELECTORS) fail('selectors exceed their bounded limit')
    const selectors = new Array(count)
    for (let index = 0; index < count; index++) selectors[index] = decodeSelector(state)
    const limit = c.uint.decode(state)
    const cursor = c.bool.decode(state) ? c.string.decode(state) : null
    const deadlineMs = c.uint.decode(state)
    return { queryId, selectors, limit, cursor, deadlineMs }
  })

const pageCodec = fixedCodec(INDEX_QUERY_PAGE_DOMAIN,
  (state, value) => {
    c.string.preencode(state, value.queryId)
    c.uint.preencode(state, value.results.length)
    for (const result of value.results) preencodeResult(state, result)
    c.bool.preencode(state, value.nextCursor !== null)
    if (value.nextCursor !== null) c.string.preencode(state, value.nextCursor)
    c.string.preencode(state, value.sourceRevision)
  },
  (state, value) => {
    c.string.encode(state, value.queryId)
    c.uint.encode(state, value.results.length)
    for (const result of value.results) encodeResult(state, result)
    c.bool.encode(state, value.nextCursor !== null)
    if (value.nextCursor !== null) c.string.encode(state, value.nextCursor)
    c.string.encode(state, value.sourceRevision)
  },
  state => {
    const queryId = c.string.decode(state)
    const count = c.uint.decode(state)
    if (count > MAX_INDEX_QUERY_RESULTS) fail('results exceed their bounded limit')
    const results = new Array(count)
    for (let index = 0; index < count; index++) results[index] = decodeResult(state)
    const nextCursor = c.bool.decode(state) ? c.string.decode(state) : null
    return { queryId, results, nextCursor, sourceRevision: c.string.decode(state) }
  })

const errorCodec = fixedCodec(INDEX_QUERY_ERROR_DOMAIN,
  (state, value) => {
    c.string.preencode(state, value.queryId)
    c.uint.preencode(state, ERROR_CODE_TO_NUMBER.get(value.code))
    c.string.preencode(state, value.detail)
  },
  (state, value) => {
    c.string.encode(state, value.queryId)
    c.uint.encode(state, ERROR_CODE_TO_NUMBER.get(value.code))
    c.string.encode(state, value.detail)
  },
  state => {
    const queryId = c.string.decode(state)
    const code = ERROR_NUMBER_TO_CODE.get(c.uint.decode(state))
    if (!code) fail('query error code is invalid')
    return { queryId, code, detail: c.string.decode(state) }
  })

const cancelCodec = fixedCodec(INDEX_QUERY_CANCEL_DOMAIN,
  (state, value) => c.string.preencode(state, value.queryId),
  (state, value) => c.string.encode(state, value.queryId),
  state => ({ queryId: c.string.decode(state) }))

function encodeCanonical(codec, value, normalize, maximum = MAX_INDEX_QUERY_PAYLOAD_BYTES) {
  const normalized = normalize(value)
  const encoded = c.encode(codec, normalized)
  if (encoded.byteLength > maximum) fail('query frame exceeds maximum bytes')
  return encoded
}

function decodeCanonical(codec, input, normalize, maximum = MAX_INDEX_QUERY_PAYLOAD_BYTES) {
  if ((!b4a.isBuffer(input) && !(input instanceof Uint8Array)) || input.byteLength > maximum) fail('query frame exceeds maximum bytes')
  const bytes = b4a.from(input)
  const state = c.state(0, bytes.byteLength, bytes)
  let decoded
  try {
    decoded = codec.decode(state)
  } catch (error) {
    if (error?.code === 'INDEX_QUERY_CODEC_REJECTED') throw error
    fail('query frame is truncated or malformed')
  }
  if (state.start !== state.end) fail('query frame has trailing bytes')
  const normalized = normalize(decoded)
  const canonical = c.encode(codec, normalized)
  if (!b4a.equals(canonical, bytes)) fail('query frame is noncanonical')
  return normalized
}

export function encodeIndexQueryRequest(value) { return encodeCanonical(requestCodec, value, normalizeRequest) }
export function decodeIndexQueryRequest(value) { return decodeCanonical(requestCodec, value, normalizeRequest) }
export function encodeIndexQueryPage(value) { return encodeCanonical(pageCodec, value, normalizePage) }
export function decodeIndexQueryPage(value) { return decodeCanonical(pageCodec, value, normalizePage) }
export function encodeIndexQueryError(value) { return encodeCanonical(errorCodec, value, normalizeError) }
export function decodeIndexQueryError(value) { return decodeCanonical(errorCodec, value, normalizeError) }
export function encodeIndexQueryCancel(value) { return encodeCanonical(cancelCodec, value, normalizeCancel) }
export function decodeIndexQueryCancel(value) { return decodeCanonical(cancelCodec, value, normalizeCancel) }


export const IndexQueryV1 = Object.freeze({ encode: encodeIndexQueryRequest, decode: decodeIndexQueryRequest })
export const IndexQueryPageV1 = Object.freeze({ encode: encodeIndexQueryPage, decode: decodeIndexQueryPage })
