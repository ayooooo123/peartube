import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  MAX_INDEX_QUERY_DEADLINE_MS,
  MAX_INDEX_QUERY_RESULTS,
  decodeIndexQueryRequest,
  encodeIndexQueryRequest,
} from './query-codec.js'
import { mapIndexQueryResult } from './query-dispatcher.js'

const CURSOR_BYTES = 32
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{43}$/
const DEFAULT_INDEXER_ID = 'local-relay-index'

function fail(message, code = 'INDEX_QUERY_LOCAL_REJECTED') {
  const error = new Error(message)
  error.code = code
  throw error
}

function cursorToken(bytes) {
  return b4a.toString(bytes, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function createLocalIndexService({
  index,
  indexerId = DEFAULT_INDEXER_ID,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  maxCursors = MAX_INDEX_QUERY_RESULTS,
} = {}) {
  if (!index || typeof index.queryIndexPage !== 'function') throw new TypeError('local index service requires index.queryIndexPage')
  if (typeof indexerId !== 'string' || indexerId.length === 0 || b4a.byteLength(indexerId) > 256) throw new TypeError('local indexerId is invalid')
  if (typeof now !== 'function' || typeof randomBytes !== 'function') throw new TypeError('local index service adapters are invalid')
  if (!Number.isSafeInteger(maxCursors) || maxCursors < 1 || maxCursors > MAX_INDEX_QUERY_RESULTS) throw new TypeError('local index cursor limit is invalid')

  const cursors = new Map()
  let closed = false

  function currentTime() {
    const value = Number(now())
    if (!Number.isSafeInteger(value) || value < 0) fail('local index clock is invalid')
    return value
  }

  function pruneCursors(time = currentTime()) {
    for (const [token, record] of cursors) {
      if (record.expiresAt <= time) cursors.delete(token)
    }
  }

  function issueCursor(selectors, sourceRevision, continuation) {
    pruneCursors()
    if (cursors.size >= maxCursors) fail('local index cursor capacity is exhausted', 'INDEX_QUERY_OVERLOADED')
    for (let attempt = 0; attempt < 4; attempt++) {
      const bytes = b4a.from(randomBytes(CURSOR_BYTES))
      if (bytes.byteLength !== CURSOR_BYTES) fail('local index cursor entropy is invalid')
      const token = cursorToken(bytes)
      if (cursors.has(token)) continue
      cursors.set(token, {
        selectors: JSON.stringify(selectors),
        sourceRevision,
        continuation,
        expiresAt: currentTime() + MAX_INDEX_QUERY_DEADLINE_MS,
      })
      return token
    }
    fail('local index cursor allocation failed', 'INDEX_QUERY_OVERLOADED')
  }

  function resolveCursor(request) {
    if (request.cursor === null) return null
    pruneCursors()
    if (!CURSOR_PATTERN.test(request.cursor)) fail('local index cursor is invalid', 'INDEX_QUERY_INVALID_CURSOR')
    const record = cursors.get(request.cursor)
    if (!record || record.selectors !== JSON.stringify(request.selectors) ||
        (request.sourceRevision !== null && request.sourceRevision !== record.sourceRevision)) {
      fail('local index cursor is invalid', 'INDEX_QUERY_INVALID_CURSOR')
    }
    return record
  }

  return Object.freeze({
    indexerId,
    async queryIndexService({ indexerId: requestedIndexerId = indexerId, query, signal } = {}) {
      if (closed) fail('local index service is closed', 'INDEX_QUERY_CLOSED')
      if (requestedIndexerId !== indexerId) fail('local indexer identity mismatch')
      if (signal?.aborted) throw signal.reason || new Error('local index query aborted')
      const request = decodeIndexQueryRequest(encodeIndexQueryRequest(query))
      const cursor = resolveCursor(request)
      const page = await index.queryIndexPage({
        selectors: request.selectors,
        limit: request.limit,
        continuation: cursor?.continuation,
        sourceRevision: cursor?.sourceRevision ?? request.sourceRevision ?? undefined,
        signal,
      })
      if (!page || !Array.isArray(page.results) || typeof page.sourceRevision !== 'string') {
        fail('local index returned an invalid page')
      }
      const nextCursor = page.continuation === null
        ? null
        : issueCursor(request.selectors, page.sourceRevision, page.continuation)
      return {
        queryId: request.queryId,
        results: page.results.map(mapIndexQueryResult),
        nextCursor,
        sourceRevision: page.sourceRevision,
      }
    },
    close() {
      if (closed) return false
      closed = true
      cursors.clear()
      return true
    },
  })
}
