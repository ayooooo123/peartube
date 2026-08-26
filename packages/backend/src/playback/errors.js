/**
 * The complete playback error vocabulary.
 *
 * Every failure a viewer can hit resolves to exactly one of these codes, one
 * message, and one retry policy. There is no generic "playback failed" escape
 * hatch: an unmapped condition is a bug, not a category.
 *
 * `retry` values:
 *   `automatic` - preparation may try another equivalent source inside the
 *                 current deadline and attempt cap.
 *   `manual`    - only a new user action can change the outcome.
 *   `evidence`  - nothing changes until fresh availability evidence or a new
 *                 device capability arrives. Retrying the same request in a
 *                 loop cannot help.
 */
export const PLAYBACK_ERRORS = Object.freeze({
  AVAILABILITY_BOUNDARY: Object.freeze({
    message: 'Unavailable - no peer currently serves the required ranges.',
    retry: 'evidence',
  }),
  NO_COMPATIBLE_SOURCE: Object.freeze({
    message: 'No source on this device can play this title right now.',
    retry: 'evidence',
  }),
  PEER_TIMEOUT: Object.freeze({
    message: 'The peer serving this title stopped responding.',
    retry: 'automatic',
  }),
  PEER_DISCONNECT: Object.freeze({
    message: 'The peer serving this title disconnected.',
    retry: 'automatic',
  }),
  RANGE_MISMATCH: Object.freeze({
    message: 'This source did not serve the ranges it advertised.',
    retry: 'automatic',
  }),
  SESSION_LIMIT: Object.freeze({
    message: 'Too many playback sessions are open on this device.',
    retry: 'automatic',
  }),
  PREPARATION_DEADLINE: Object.freeze({
    message: 'Playback did not start in time. Try again.',
    retry: 'manual',
  }),
  PREPARATION_CANCELLED: Object.freeze({
    message: 'Playback preparation was cancelled.',
    retry: 'manual',
  }),
  ATTEMPT_LIMIT: Object.freeze({
    message: 'Every currently reachable source failed to start.',
    retry: 'manual',
  }),
})

export const PLAYBACK_ERROR_CODES = Object.freeze(Object.keys(PLAYBACK_ERRORS))

/**
 * Codes a different equivalent source might not share, so bounded failover may
 * try the next one. Everything else describes the title or the device, and
 * retrying another source cannot change it.
 */
export const RETRYABLE_PLAYBACK_ERROR_CODES = Object.freeze(
  PLAYBACK_ERROR_CODES.filter(code => PLAYBACK_ERRORS[code].retry === 'automatic')
)

/**
 * Codes that must stop preparation immediately. These are exactly the failures
 * an alternate source cannot fix, so walking the failover order would only burn
 * the deadline and hand the viewer a slower version of the same answer.
 */
export const TERMINAL_PLAYBACK_ERROR_CODES = Object.freeze(
  PLAYBACK_ERROR_CODES.filter(code => PLAYBACK_ERRORS[code].retry === 'evidence')
)

export function isPlaybackErrorCode(code) {
  return typeof code === 'string' && Object.hasOwn(PLAYBACK_ERRORS, code)
}

export function playbackErrorMessage(code) {
  return PLAYBACK_ERRORS[code]?.message || PLAYBACK_ERRORS.NO_COMPATIBLE_SOURCE.message
}

export function playbackErrorRetry(code) {
  return PLAYBACK_ERRORS[code]?.retry || 'manual'
}

/**
 * A playback failure carrying its own code. Throwing this is how a transport
 * layer reports a bounded reason instead of an opaque string.
 */
export function createPlaybackError(code, { cause } = {}) {
  const error = new Error(playbackErrorMessage(code))
  error.errorCode = isPlaybackErrorCode(code) ? code : 'NO_COMPATIBLE_SOURCE'
  error.retry = playbackErrorRetry(error.errorCode)
  if (cause !== undefined) error.cause = cause
  return error
}
