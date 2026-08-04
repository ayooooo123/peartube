/**
 * The player's view of the one playback error vocabulary.
 *
 * Every code the backend can return maps to exactly one message and one retry
 * affordance here. A code the app does not recognise is surfaced as an honest
 * unknown rather than silently retried or relabelled as "unavailable", because
 * guessing would let a real regression look like a network hiccup.
 */

export const PLAYBACK_RETRY_POLICIES = Object.freeze({
  automatic: 'automatic',
  manual: 'manual',
  evidence: 'evidence',
})

const PLAYBACK_ERROR_PRESENTATION = Object.freeze({
  AVAILABILITY_BOUNDARY: Object.freeze({
    message: 'Unavailable - no peer currently serves the required ranges.',
    retry: 'evidence',
    action: null,
  }),
  NO_COMPATIBLE_SOURCE: Object.freeze({
    message: 'No source on this device can play this title right now.',
    retry: 'evidence',
    action: null,
  }),
  PEER_TIMEOUT: Object.freeze({
    message: 'The peer serving this title stopped responding.',
    retry: 'automatic',
    action: 'Try again',
  }),
  PEER_DISCONNECT: Object.freeze({
    message: 'The peer serving this title disconnected.',
    retry: 'automatic',
    action: 'Try again',
  }),
  RANGE_MISMATCH: Object.freeze({
    message: 'This source did not serve the ranges it advertised.',
    retry: 'automatic',
    action: 'Try again',
  }),
  SESSION_LIMIT: Object.freeze({
    message: 'Too many playback sessions are open on this device.',
    retry: 'automatic',
    action: 'Try again',
  }),
  PREPARATION_DEADLINE: Object.freeze({
    message: 'Playback did not start in time.',
    retry: 'manual',
    action: 'Try again',
  }),
  PREPARATION_CANCELLED: Object.freeze({
    message: 'Playback preparation was cancelled.',
    retry: 'manual',
    action: 'Play',
  }),
  ATTEMPT_LIMIT: Object.freeze({
    message: 'Every currently reachable source failed to start.',
    retry: 'manual',
    action: 'Try again',
  }),
})

export const PLAYBACK_ERROR_CODES = Object.freeze(Object.keys(PLAYBACK_ERROR_PRESENTATION))

const UNKNOWN = Object.freeze({
  code: 'UNKNOWN_PLAYBACK_ERROR',
  message: 'Playback stopped for an unrecognised reason.',
  retry: 'manual',
  action: 'Try again',
  known: false,
})

export function isPlaybackErrorCode(code) {
  return typeof code === 'string' && Object.hasOwn(PLAYBACK_ERROR_PRESENTATION, code)
}

/**
 * One description per failure, for the player overlay and for Other Sources.
 * `retry: 'automatic'` means the backend already exhausted its own bounded
 * failover for this attempt; the affordance offers a fresh attempt, never a
 * silent loop.
 */
export function describePlaybackError(input) {
  const code = typeof input === 'string' ? input : input?.errorCode
  if (!isPlaybackErrorCode(code)) return UNKNOWN
  const presentation = PLAYBACK_ERROR_PRESENTATION[code]
  return {
    code,
    message: presentation.message,
    retry: presentation.retry,
    action: presentation.action,
    known: true,
  }
}

/** Whether offering a retry affordance can honestly change anything. */
export function isPlaybackErrorRetryable(input) {
  return describePlaybackError(input).retry !== PLAYBACK_RETRY_POLICIES.evidence
}
