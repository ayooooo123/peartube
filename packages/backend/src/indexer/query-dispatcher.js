import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  INDEX_QUERY_ERROR_CODES,
  MAX_INDEX_QUERY_CURSOR_BYTES,
  MAX_INDEX_QUERY_ERROR_DETAIL_BYTES,
  MAX_INDEX_QUERY_RESULTS,
  decodeIndexQueryCancel,
  decodeIndexQueryRequest,
  encodeIndexQueryError,
  encodeIndexQueryPage,
} from './query-codec.js'
import {
  INDEX_QUERY_CANCEL_FRAME,
  INDEX_QUERY_ERROR_FRAME,
  INDEX_QUERY_PAGE_FRAME,
  INDEX_QUERY_REQUEST_FRAME,
} from './query-frames.js'
export {
  INDEX_QUERY_CANCEL_FRAME,
  INDEX_QUERY_ERROR_FRAME,
  INDEX_QUERY_PAGE_FRAME,
  INDEX_QUERY_REQUEST_FRAME,
} from './query-frames.js'
import { createSettledQueryIdWindow } from './query-id-window.js'


const MAX_PENDING_QUERIES = 32
const EXECUTION_BUDGETS = new WeakMap()
const DEFAULT_MAX_CURSORS = 1024
const MAX_CURSORS = 4096
const DEFAULT_CURSOR_LIFETIME_MS = 30_000
const MAX_CURSOR_LIFETIME_MS = 300_000
const CURSOR_TOKEN_BYTES = 32

function boundedOption(value, fallback, maximum, name) {
  const next = Number(value ?? fallback)
  if (!Number.isSafeInteger(next) || next < 1 || next > maximum) fail(`${name} is outside the bounded limit`)
  return next
}

function cursorToken(bytes) {
  return b4a.toString(bytes, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fail(message) {
  const error = new Error(message)
  error.code = 'INDEX_QUERY_DISPATCH_REJECTED'
  throw error
}

function currentTime(limits) {
  const value = typeof limits.now === 'function' ? limits.now() : (limits.now ?? Date.now())
  if (!Number.isSafeInteger(value) || value < 0) fail('current time must be a non-negative safe integer')
  return value
}

function pendingLimit(value) {
  const next = Number(value ?? MAX_PENDING_QUERIES)
  if (!Number.isSafeInteger(next) || next < 1 || next > 1024) fail('maxPendingQueries is outside its bound')
  return next
}
function executionLimit(value) {
  const limit = Number(value ?? MAX_PENDING_QUERIES)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PENDING_QUERIES) fail('maxExecutingQueries is outside the bounded limit')
  return limit
}

function acquireExecution(indexStore, requestedLimit) {
  let budget = EXECUTION_BUDGETS.get(indexStore)
  if (!budget) {
    budget = { active: 0 }
    EXECUTION_BUDGETS.set(indexStore, budget)
  }
  if (budget.active >= requestedLimit) return null
  budget.active++
  let released = false
  return () => {
    if (released) return
    released = true
    budget.active--
  }
}


function detailFor(code) {
  switch (code) {
    case INDEX_QUERY_ERROR_CODES.INVALID_REQUEST: return 'query request is invalid'
    case INDEX_QUERY_ERROR_CODES.INVALID_CURSOR: return 'query cursor is invalid or stale'
    case INDEX_QUERY_ERROR_CODES.RESULT_LIMIT_EXCEEDED: return 'query result exceeds a bounded response limit'
    case INDEX_QUERY_ERROR_CODES.DEADLINE_EXCEEDED: return 'query deadline exceeded'
    case INDEX_QUERY_ERROR_CODES.CANCELLED: return 'query was cancelled'
    case INDEX_QUERY_ERROR_CODES.OVERLOADED: return 'query service is at its pending-request limit'
    case INDEX_QUERY_ERROR_CODES.CLOSED: return 'query channel closed'
    default: return 'query service failed'
  }
}

function classifyStoreError(error) {
  if (error?.code === 'INDEX_QUERY_STALE_REVISION') return INDEX_QUERY_ERROR_CODES.INVALID_CURSOR
  if (typeof error?.code === 'string' && error.code.startsWith('INDEX_ADMISSION_')) return INDEX_QUERY_ERROR_CODES.INVALID_REQUEST
  if (error?.code === 'INDEX_QUERY_RESULT_LIMIT') return INDEX_QUERY_ERROR_CODES.RESULT_LIMIT_EXCEEDED
  return INDEX_QUERY_ERROR_CODES.INTERNAL_ERROR
}

function requiredCapabilities(selectors) {
  const capabilities = []
  if (selectors.some(selector => selector.type === 'exact-external-ref')) capabilities.push('exact-external-ref')
  if (selectors.some(selector => selector.type === 'title-token-prefix')) capabilities.push('text-prefix')
  if (selectors.some(selector => selector.type === 'publication-by-work')) capabilities.push('publication-by-work')
  if (selectors.some(selector => selector.type === 'rendition-by-publication')) capabilities.push('rendition-by-publication')
  return capabilities
}

function mapResult(row) {
  if (row && row.namespace !== undefined && row.normalizedIdentifier !== undefined) {
    return {
      type: 'external-ref',
      publisherId: row.publisherId,
      sourceRecordRef: row.sourceRecordRef,
      namespace: row.namespace,
      identifier: row.normalizedIdentifier,
      entityKind: row.entityKind,
      entityId: row.entityId,
      evidenceWeight: row.evidenceWeight ?? null,
    }
  }
  if (row?.relationType === 'title-token') {
    return {
      type: 'title-token',
      publisherId: row.publisherId,
      sourceRecordRef: row.sourceRecordRef,
      token: row.fromId,
      targetId: row.toId,
    }
  }
  if (row?.publicationId && row.workEntityId && row.manifestId && !row.renditionId) {
    return {
      type: 'publication',
      publisherId: row.publisherId,
      sourceRecordRef: row.sourceRecordRef,
      publicationId: row.publicationId,
      workEntityId: row.workEntityId,
      normalizedTitle: row.normalizedTitle ?? null,
      releaseYear: row.releaseYear ?? null,
      manifestId: row.manifestId,
      provenanceSummary: row.provenanceSummary ?? null,
    }
  }
  if (row?.publicationId && row.renditionId && row.assetId) {
    return {
      type: 'rendition',
      publisherId: row.publisherId,
      sourceRecordRef: row.sourceRecordRef,
      publicationId: row.publicationId,
      renditionId: row.renditionId,
      assetId: row.assetId,
      format: row.format ?? null,
      codec: row.codec ?? null,
      dimensions: row.dimensions ?? null,
      mediaFeatures: row.mediaFeatures ?? null,
      byteLength: row.byteLength ?? null,
    }
  }
  fail('index store returned an unsupported query result')
}

function emitTelemetry(limits, startedAt, code, count, capability) {
  if (typeof limits.onQueryTelemetry !== 'function') return
  try {
    limits.onQueryTelemetry({
      code,
      count,
      durationMs: Math.max(0, currentTime(limits) - startedAt),
      capability,
    })
  } catch {}
}

export function createIndexQueryDispatcher({ indexStore, announcement, limits = {}, send } = {}) {
  if (!indexStore || typeof indexStore.queryIndexPage !== 'function') fail('indexStore.queryIndexPage is required')
  if (!announcement || !Array.isArray(announcement.queryCapabilities)) fail('verified index service announcement is required')
  if (typeof send !== 'function') fail('bounded query frame sender is required')
  let configuredAnnouncement = announcement
  const maximumPending = pendingLimit(limits.maxPendingQueries)
  const maximumExecuting = executionLimit(limits.maxExecutingQueries)
  const pending = new Map()
  const settledIds = createSettledQueryIdWindow(limits)
  const maximumCursors = boundedOption(limits.maxCursors, DEFAULT_MAX_CURSORS, MAX_CURSORS, 'maxCursors')
  const cursorLifetimeMs = boundedOption(limits.cursorLifetimeMs, DEFAULT_CURSOR_LIFETIME_MS, MAX_CURSOR_LIFETIME_MS, 'cursorLifetimeMs')
  const indexerId = b4a.toString(announcement.indexerId, 'hex')
  const cursors = new Map()

  function pruneCursors(now = currentTime(limits)) {
    for (const [token, record] of cursors) {
      if (record.expiresAt <= now) cursors.delete(token)
    }
  }

  function lookupCursor(token, selectors) {
    pruneCursors()
    if (typeof token !== 'string' || token.length > MAX_INDEX_QUERY_CURSOR_BYTES || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const record = cursors.get(token)
    if (!record || record.indexerId !== indexerId || record.selectors !== JSON.stringify(selectors)) return null
    return record
  }

  function issueCursor(selectors, sourceRevision, continuation) {
    let serialized
    try {
      serialized = JSON.stringify(continuation)
    } catch {}
    if (!serialized || b4a.byteLength(serialized) > MAX_INDEX_QUERY_CURSOR_BYTES) {
      const error = new Error('cursor continuation exceeds bounded limit')
      error.code = 'INDEX_QUERY_RESULT_LIMIT'
      throw error
    }
    continuation = JSON.parse(serialized)
    pruneCursors()
    if (cursors.size >= maximumCursors) return null
    const randomBytes = limits.randomBytes || crypto.randomBytes
    for (let attempt = 0; attempt < 4; attempt++) {
      const bytes = b4a.from(randomBytes(CURSOR_TOKEN_BYTES))
      if (bytes.byteLength !== CURSOR_TOKEN_BYTES) fail('cursor random source must return 32 bytes')
      const token = cursorToken(bytes)
      if (cursors.has(token)) continue
      cursors.set(token, {
        indexerId,
        selectors: JSON.stringify(selectors),
        sourceRevision,
        continuation,
        expiresAt: currentTime(limits) + cursorLifetimeMs,
      })
      return token
    }
    return null
  }
  let closed = false

  function transmit(type, payload) {
    const result = send(type, payload)
    if (result === true || result === 'sent') return 'sent'
    if (result === 'frame-too-large') return result
    return 'closed'
  }

  function sendError(queryId, code) {
    const detail = detailFor(code).slice(0, MAX_INDEX_QUERY_ERROR_DETAIL_BYTES)
    return transmit(INDEX_QUERY_ERROR_FRAME, encodeIndexQueryError({ queryId, code, detail }))
  }

  function settle(tracked, code, count = 0, remember = true) {
    if (pending.get(tracked.queryId) !== tracked) return false
    pending.delete(tracked.queryId)
    ;(limits.clearTimeout || clearTimeout)(tracked.timer)
    tracked.controller.abort()
    if (remember && !settledIds.remember(tracked.queryId)) code = INDEX_QUERY_ERROR_CODES.OVERLOADED
    emitTelemetry(limits, tracked.startedAt, code, count, tracked.capability)
    return true
  }

  function releaseExecution(tracked) {
    tracked.executionRelease?.()
    tracked.executionRelease = null
  }

  async function run(tracked) {
    if (currentTime(limits) - tracked.startedAt >= tracked.request.deadlineMs) {
      if (settle(tracked, INDEX_QUERY_ERROR_CODES.DEADLINE_EXCEEDED)) {
        sendError(tracked.queryId, INDEX_QUERY_ERROR_CODES.DEADLINE_EXCEEDED)
      }
      releaseExecution(tracked)
      return
    }
    try {
      let storeWork
      try {
        storeWork = indexStore.queryIndexPage({
          selectors: tracked.request.selectors,
          limit: tracked.request.limit,
          continuation: tracked.cursor?.continuation,
          sourceRevision: tracked.cursor?.sourceRevision ?? tracked.request.sourceRevision ?? undefined,
          signal: tracked.controller.signal,
        })
      } catch (error) {
        releaseExecution(tracked)
        throw error
      }
      const page = await Promise.resolve(storeWork).finally(() => releaseExecution(tracked))
      if (pending.get(tracked.queryId) !== tracked) return
      if (!page || !Array.isArray(page.results) || page.results.length > tracked.request.limit || page.results.length > MAX_INDEX_QUERY_RESULTS) {
        if (settle(tracked, INDEX_QUERY_ERROR_CODES.RESULT_LIMIT_EXCEEDED)) sendError(tracked.queryId, INDEX_QUERY_ERROR_CODES.RESULT_LIMIT_EXCEEDED)
        return
      }
      const results = page.results.map(mapResult)
      let nextCursor = null
      if (page.continuation !== null) {
        nextCursor = issueCursor(tracked.request.selectors, page.sourceRevision, page.continuation)
        if (nextCursor === null) {
          if (settle(tracked, INDEX_QUERY_ERROR_CODES.OVERLOADED)) sendError(tracked.queryId, INDEX_QUERY_ERROR_CODES.OVERLOADED)
          return
        }
      }
      let payload
      try {
        payload = encodeIndexQueryPage({ queryId: tracked.queryId, results, nextCursor, sourceRevision: page.sourceRevision })
      } catch {
        if (nextCursor !== null) cursors.delete(nextCursor)
        if (settle(tracked, INDEX_QUERY_ERROR_CODES.RESULT_LIMIT_EXCEEDED)) sendError(tracked.queryId, INDEX_QUERY_ERROR_CODES.RESULT_LIMIT_EXCEEDED)
        return
      }
      const outcome = transmit(INDEX_QUERY_PAGE_FRAME, payload)
      if (outcome === 'sent') {
        settle(tracked, 'OK', results.length)
      } else if (outcome === 'frame-too-large') {
        if (nextCursor !== null) cursors.delete(nextCursor)
        if (settle(tracked, INDEX_QUERY_ERROR_CODES.RESULT_LIMIT_EXCEEDED)) sendError(tracked.queryId, INDEX_QUERY_ERROR_CODES.RESULT_LIMIT_EXCEEDED)
      } else {
        if (nextCursor !== null) cursors.delete(nextCursor)
        close('query-response-send-failed')
      }
    } catch (error) {
      if (pending.get(tracked.queryId) !== tracked) return
      const code = classifyStoreError(error)
      if (settle(tracked, code)) sendError(tracked.queryId, code)
    }
  }

  function start(frame) {
    if (closed) fail('index query dispatcher is closed')
    const request = decodeIndexQueryRequest(frame.payload)
    if (pending.has(request.queryId) || settledIds.has(request.queryId)) return sendError(request.queryId, INDEX_QUERY_ERROR_CODES.INVALID_REQUEST)
    const capabilities = requiredCapabilities(request.selectors)
    if (!capabilities.every(capability => configuredAnnouncement.queryCapabilities.includes(capability))) {
      return sendError(request.queryId, INDEX_QUERY_ERROR_CODES.INVALID_REQUEST)
    }
    if (pending.size >= maximumPending || !settledIds.canAdmit(pending.size)) return sendError(request.queryId, INDEX_QUERY_ERROR_CODES.OVERLOADED)
    let cursor = null
    if (request.cursor !== null) {
      cursor = lookupCursor(request.cursor, request.selectors)
      if (cursor === null) return sendError(request.queryId, INDEX_QUERY_ERROR_CODES.INVALID_CURSOR)
      if (request.sourceRevision !== null && request.sourceRevision !== cursor.sourceRevision) {
        return sendError(request.queryId, INDEX_QUERY_ERROR_CODES.INVALID_CURSOR)
      }
    }
    const startedAt = currentTime(limits)
    const executionRelease = acquireExecution(indexStore, maximumExecuting)
    if (executionRelease === null) return sendError(request.queryId, INDEX_QUERY_ERROR_CODES.OVERLOADED)
    const tracked = {
      queryId: request.queryId,
      request,
      cursor,
      capability: capabilities.join('+'),
      controller: new AbortController(),
      startedAt,
      timer: null,
      executionRelease,
    }
    try {
      tracked.timer = (limits.setTimeout || setTimeout)(() => {
        if (!settle(tracked, INDEX_QUERY_ERROR_CODES.DEADLINE_EXCEEDED)) return
        sendError(request.queryId, INDEX_QUERY_ERROR_CODES.DEADLINE_EXCEEDED)
      }, request.deadlineMs)
    } catch (error) {
      releaseExecution(tracked)
      throw error
    }
    tracked.timer?.unref?.()
    pending.set(request.queryId, tracked)
    run(tracked)
  }

  function cancel(frame) {
    const message = decodeIndexQueryCancel(frame.payload)
    const tracked = pending.get(message.queryId)
    if (tracked) settle(tracked, INDEX_QUERY_ERROR_CODES.CANCELLED)
  }

  function onFrame(frame) {
    if (frame.type === INDEX_QUERY_REQUEST_FRAME) return start(frame)
    if (frame.type === INDEX_QUERY_CANCEL_FRAME) return cancel(frame)
    fail('frame type is not allowed on an index query dispatcher')
  }

  function refreshAnnouncement(nextAnnouncement) {
    if (closed) fail('index query dispatcher is closed')
    if (!nextAnnouncement || !Array.isArray(nextAnnouncement.queryCapabilities)) fail('verified index service announcement is required')
    if (
      b4a.toString(nextAnnouncement.indexerId, 'hex') !== indexerId ||
      !b4a.equals(nextAnnouncement.transportPublicKey, configuredAnnouncement.transportPublicKey)
    ) fail('index query dispatcher announcement identity changed')
    configuredAnnouncement = nextAnnouncement
    return true
  }

  function close(reason = 'closed') {
    if (closed) return false
    closed = true
    for (const tracked of [...pending.values()]) settle(tracked, reason === 'cancelled' ? INDEX_QUERY_ERROR_CODES.CANCELLED : INDEX_QUERY_ERROR_CODES.CLOSED, 0, false)
    settledIds.close()
    cursors.clear()
    return true
  }

  return Object.freeze({
    get pendingCount() { return pending.size },
    onFrame,
    refreshAnnouncement,
    close,
  })
}
