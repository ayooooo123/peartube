import {
  INDEX_QUERY_ERROR_CODES,
  decodeIndexQueryError,
  decodeIndexQueryPage,
  decodeIndexQueryRequest,
  encodeIndexQueryCancel,
  encodeIndexQueryRequest,
} from './query-codec.js'
import {
  INDEX_QUERY_CANCEL_FRAME,
  INDEX_QUERY_ERROR_FRAME,
  INDEX_QUERY_PAGE_FRAME,
  INDEX_QUERY_REQUEST_FRAME,
} from './query-frames.js'
import { createSettledQueryIdWindow } from './query-id-window.js'
const MAX_PENDING_QUERIES = 32

function pendingLimit(value) {
  const limit = Number(value ?? MAX_PENDING_QUERIES)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PENDING_QUERIES) fail('maxPendingQueries is outside the bounded limit')
  return limit
}
function fail(message) {
  const error = new Error(message)
  error.code = 'INDEX_QUERY_REQUESTER_REJECTED'
  throw error
}

function abortError() {
  const error = new Error('index query aborted')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function detailFor(code) {
  switch (code) {
    case INDEX_QUERY_ERROR_CODES.DEADLINE_EXCEEDED: return 'query deadline exceeded'
    case INDEX_QUERY_ERROR_CODES.CLOSED: return 'query channel closed'
    default: return 'query service failed'
  }
}

export class IndexQueryRemoteError extends Error {
  constructor(queryId, code, detail) {
    super(detail)
    this.name = 'IndexQueryRemoteError'
    this.queryId = queryId
    this.code = code
    this.detail = detail
  }
}

export function createIndexQueryRequester({ limits = {}, send, ready = Promise.resolve() } = {}) {
  if (typeof send !== 'function') fail('bounded query frame sender is required')
  if (!ready || typeof ready.then !== 'function') fail('query requester ready promise is required')
  const maximumPending = pendingLimit(limits.maxPendingQueries)
  const settledIds = createSettledQueryIdWindow(limits)
  const pending = new Map()
  let closed = false
  let suspended = false

  function finish(tracked, error, page, remember = true) {
    if (pending.get(tracked.queryId) !== tracked) return false
    pending.delete(tracked.queryId)
    ;(limits.clearTimeout || clearTimeout)(tracked.timer)
    tracked.signal?.removeEventListener('abort', tracked.onAbort)
    if (remember && !settledIds.remember(tracked.queryId)) {
      error = new IndexQueryRemoteError(tracked.queryId, INDEX_QUERY_ERROR_CODES.OVERLOADED, detailFor(INDEX_QUERY_ERROR_CODES.OVERLOADED))
    }
    if (error) tracked.reject(error)
    else tracked.resolve(page)
    return true
  }

  function transmit(type, payload) {
    if (closed) return 'closed'
    try {
      const outcome = send(type, payload)
      if (outcome === true || outcome === 'sent') return 'sent'
      if (outcome === 'frame-too-large') return outcome
      return 'closed'
    } catch {
      return 'closed'
    }
  }

  function onFrame(frame) {
    if (frame.type === INDEX_QUERY_PAGE_FRAME) {
      const page = decodeIndexQueryPage(frame.payload)
      const tracked = pending.get(page.queryId)
      if (tracked && page.results.length > tracked.limit) {
        finish(tracked, new IndexQueryRemoteError(
          page.queryId,
          INDEX_QUERY_ERROR_CODES.RESULT_LIMIT_EXCEEDED,
          detailFor(INDEX_QUERY_ERROR_CODES.RESULT_LIMIT_EXCEEDED),
        ))
      } else if (tracked) {
        finish(tracked, null, page)
      }
      return
    }
    if (frame.type === INDEX_QUERY_ERROR_FRAME) {
      const remote = decodeIndexQueryError(frame.payload)
      const tracked = pending.get(remote.queryId)
      if (tracked) finish(tracked, new IndexQueryRemoteError(remote.queryId, remote.code, remote.detail))
      return
    }
    fail('frame type is not allowed on an index query requester')
  }

  function query(queryValue, signal) {
    const queryId = typeof queryValue?.queryId === 'string' ? queryValue.queryId : ''
    if (closed) return Promise.reject(new IndexQueryRemoteError(queryId, INDEX_QUERY_ERROR_CODES.CLOSED, detailFor(INDEX_QUERY_ERROR_CODES.CLOSED)))
    if (suspended) return Promise.reject(new IndexQueryRemoteError(queryId, INDEX_QUERY_ERROR_CODES.CLOSED, detailFor(INDEX_QUERY_ERROR_CODES.CLOSED)))
    if (signal?.aborted) return Promise.reject(abortError())
    if (pending.size >= maximumPending || !settledIds.canAdmit(pending.size)) {
      return Promise.reject(new IndexQueryRemoteError(queryId, INDEX_QUERY_ERROR_CODES.OVERLOADED, detailFor(INDEX_QUERY_ERROR_CODES.OVERLOADED)))
    }
    let payload
    let normalized
    try {
      payload = encodeIndexQueryRequest(queryValue)
      normalized = decodeIndexQueryRequest(payload)
    } catch (error) {
      return Promise.reject(error)
    }
    if (settledIds.has(normalized.queryId)) {
      return Promise.reject(new IndexQueryRemoteError(normalized.queryId, INDEX_QUERY_ERROR_CODES.INVALID_REQUEST, 'queryId was already settled'))
    }
    if (pending.has(normalized.queryId)) {
      return Promise.reject(new IndexQueryRemoteError(normalized.queryId, INDEX_QUERY_ERROR_CODES.INVALID_REQUEST, 'queryId is already pending'))
    }
    return new Promise((resolve, reject) => {
      const tracked = { queryId: normalized.queryId, limit: normalized.limit, signal, resolve, reject, timer: null, sent: false, onAbort: null }
      tracked.onAbort = () => {
        if (pending.get(tracked.queryId) !== tracked) return
        if (tracked.sent) transmit(INDEX_QUERY_CANCEL_FRAME, encodeIndexQueryCancel({ queryId: tracked.queryId }))
        finish(tracked, abortError())
      }
      if (signal) signal.addEventListener('abort', tracked.onAbort, { once: true })
      tracked.timer = (limits.setTimeout || setTimeout)(() => {
        if (pending.get(tracked.queryId) !== tracked) return
        if (tracked.sent) transmit(INDEX_QUERY_CANCEL_FRAME, encodeIndexQueryCancel({ queryId: tracked.queryId }))
        finish(tracked, new IndexQueryRemoteError(tracked.queryId, INDEX_QUERY_ERROR_CODES.DEADLINE_EXCEEDED, detailFor(INDEX_QUERY_ERROR_CODES.DEADLINE_EXCEEDED)))
      }, normalized.deadlineMs)
      tracked.timer?.unref?.()
      pending.set(normalized.queryId, tracked)
      ready.then(() => {
        if (pending.get(tracked.queryId) !== tracked) return
        const outcome = transmit(INDEX_QUERY_REQUEST_FRAME, payload)
        if (outcome === 'sent') {
          tracked.sent = true
        } else if (outcome === 'frame-too-large') {
          finish(tracked, new IndexQueryRemoteError(tracked.queryId, INDEX_QUERY_ERROR_CODES.INVALID_REQUEST, detailFor(INDEX_QUERY_ERROR_CODES.INVALID_REQUEST)), null, false)
        } else {
          finish(tracked, new IndexQueryRemoteError(tracked.queryId, INDEX_QUERY_ERROR_CODES.CLOSED, detailFor(INDEX_QUERY_ERROR_CODES.CLOSED)))
        }
      }, error => finish(tracked, error))
    })
  }

  function suspend() {
    if (closed || suspended) return false
    suspended = true
    for (const tracked of [...pending.values()]) {
      if (tracked.sent) transmit(INDEX_QUERY_CANCEL_FRAME, encodeIndexQueryCancel({ queryId: tracked.queryId }))
      finish(tracked, new IndexQueryRemoteError(tracked.queryId, INDEX_QUERY_ERROR_CODES.CLOSED, detailFor(INDEX_QUERY_ERROR_CODES.CLOSED)))
    }
    return true
  }

  function resume() {
    if (closed || !suspended) return false
    suspended = false
    return true
  }

  function close() {
    if (closed) return false
    closed = true
    const error = new IndexQueryRemoteError('', INDEX_QUERY_ERROR_CODES.CLOSED, detailFor(INDEX_QUERY_ERROR_CODES.CLOSED))
    for (const tracked of [...pending.values()]) finish(tracked, error, null, false)
    settledIds.close()
    return true
  }

  return Object.freeze({
    get pendingCount() { return pending.size },
    onFrame,
    query,
    suspend,
    resume,
    close,
  })
}
