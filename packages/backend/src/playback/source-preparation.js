import { areSourcesEquivalent, selectPlaybackSource } from '../media-graph/source-selector.js'
import { RETRYABLE_PLAYBACK_ERROR_CODES } from './errors.js'
import { createAbortController } from '../abort-controller.js'

const DEFAULT_DEADLINE_MS = 15_000
const DEFAULT_MAX_ATTEMPTS = 3

/** Distinguishes "the deadline won the race" from any value an opener returns. */
const DEADLINE = Symbol('preparation-deadline')

// One retry rule, defined once: `playback/errors.js` decides which failures
// another equivalent source might not share. Everything else stops the walk,
// because no alternate source can change a device or title fact.
const RETRYABLE_ERROR_CODES = new Set(RETRYABLE_PLAYBACK_ERROR_CODES)

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

async function closeQuietly(session) {
  if (!session) return
  try {
    await session.close?.()
  } catch {
    // A source we are already abandoning cannot fail us twice.
  }
}

/**
 * Prepare playback for one entity by walking the selector's failover order.
 *
 * One deadline and one attempt cap cover every attempt together, so a slow
 * chain of sources cannot outlive the viewer's patience by multiplying
 * per-attempt timeouts. Every attempt that does not become the live session is
 * closed before the next one opens, and the walk is restricted to sources the
 * selector proved equivalent to the winner: failover never crosses to another
 * edition, cut, or episode, and never downgrades a protected title to a public
 * lookalike.
 */
export async function preparePlaybackSource(options = {}) {
  const sources = Array.isArray(options.sources) ? options.sources : []
  const openSession = options.openSession
  if (typeof openSession !== 'function') throw new TypeError('openSession is required')
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const deadlineMs = positiveInteger(options.deadlineMs, DEFAULT_DEADLINE_MS)
  const maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS)
  const startedAt = now()
  const deadlineAt = startedAt + deadlineMs

  const selection = selectPlaybackSource(sources, {
    capabilities: options.capabilities,
    selectedPublicationId: options.selectedPublicationId,
    now: startedAt,
  })
  if (!selection.selected) {
    return {
      success: false,
      errorCode: 'NO_COMPATIBLE_SOURCE',
      attempts: [],
      candidates: selection.candidates,
    }
  }

  const order = [selection.selected, ...selection.failoverOrder]
  const attempts = []
  const attempted = new Set()
  let lastErrorCode = 'NO_COMPATIBLE_SOURCE'

  for (const source of order) {
    if (attempts.length >= maxAttempts) {
      lastErrorCode = 'ATTEMPT_LIMIT'
      break
    }
    // The winner is equivalent to itself; this re-check keeps a caller-supplied
    // order from smuggling in a non-equivalent source.
    if (!areSourcesEquivalent(source, selection.selected)) continue
    const publicationId = String(source.publicationId || '')
    if (attempted.has(publicationId)) continue
    attempted.add(publicationId)

    const remainingMs = deadlineAt - now()
    if (remainingMs <= 0) {
      lastErrorCode = 'PREPARATION_DEADLINE'
      attempts.push({ publicationId, errorCode: 'PREPARATION_DEADLINE' })
      break
    }

    // One cancellation tree: the caller's signal and the shared deadline both
    // abort the in-flight attempt, and an opener that ignores the abort loses
    // the race and has its late session closed rather than leaked.
    const controller = createAbortController()
    const abortAttempt = () => controller.abort()
    options.signal?.addEventListener?.('abort', abortAttempt, { once: true })
    let deadlineTimer = null
    const expired = new Promise(resolve => {
      deadlineTimer = setTimeout(() => {
        controller.abort()
        resolve(DEADLINE)
      }, remainingMs)
      deadlineTimer?.unref?.()
    })

    let session = null
    try {
      const attempt = Promise.resolve(
        openSession({ source, publicationId, remainingMs, deadlineAt, signal: controller.signal })
      )
      session = await Promise.race([attempt, expired])
      if (session === DEADLINE) {
        void attempt.then(closeQuietly, () => {})
        lastErrorCode = 'PREPARATION_DEADLINE'
        attempts.push({ publicationId, errorCode: lastErrorCode })
        break
      }
    } catch (error) {
      lastErrorCode = error?.errorCode || 'PEER_TIMEOUT'
      attempts.push({ publicationId, errorCode: lastErrorCode })
      // One rule for both paths: only an automatically retryable code earns
      // another attempt. Anything else stops here.
      if (!RETRYABLE_ERROR_CODES.has(lastErrorCode)) break
      continue
    } finally {
      clearTimeout(deadlineTimer)
      options.signal?.removeEventListener?.('abort', abortAttempt)
    }

    if (options.signal?.aborted === true) {
      await closeQuietly(session)
      lastErrorCode = 'PREPARATION_CANCELLED'
      attempts.push({ publicationId, errorCode: lastErrorCode })
      break
    }

    if (session?.success === true) {
      attempts.push({ publicationId, errorCode: null })
      return {
        success: true,
        publicationId,
        renditionId: source.renditionId || null,
        session,
        attempts,
        candidates: selection.candidates,
      }
    }

    lastErrorCode = session?.errorCode || 'PEER_TIMEOUT'
    attempts.push({ publicationId, errorCode: lastErrorCode })
    await closeQuietly(session)
    if (!RETRYABLE_ERROR_CODES.has(lastErrorCode)) break
  }

  // Walking off the end of the failover order means every equivalent source
  // already had its turn. Reporting the last per-source code would tell the
  // client another automatic attempt is possible when none is; the individual
  // reasons stay visible in `attempts`.
  const exhausted = RETRYABLE_ERROR_CODES.has(lastErrorCode)
  return {
    success: false,
    errorCode: exhausted ? 'ATTEMPT_LIMIT' : lastErrorCode,
    attempts,
    candidates: selection.candidates,
  }
}
