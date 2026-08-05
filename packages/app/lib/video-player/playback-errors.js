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

/**
 * Codes an automatic source re-attach inside the player can plausibly clear:
 * the peer went away or the device was over its session budget, so reading the
 * same ranges again is a different question. Every other code in the vocabulary
 * needs new availability evidence, a new device capability, or a user action
 * (vertical-slice plan, Task 5), so looping on it only re-reads bytes that were
 * already rejected.
 */
const PLAYER_RECOVERABLE_CODES = Object.freeze([
  'PEER_TIMEOUT',
  'PEER_DISCONNECT',
  'SESSION_LIMIT',
])

// HTMLMediaElement MediaError numbers. The only structured error code any
// playback surface here actually hands us: expo-video's native PlaybackError
// record carries a message and nothing else, on both Android and iOS.
const MEDIA_ERROR_CODE_TO_PLAYBACK_CODE = Object.freeze({
  1: 'PREPARATION_CANCELLED', // MEDIA_ERR_ABORTED
  2: 'PEER_DISCONNECT', // MEDIA_ERR_NETWORK
  3: 'NO_COMPATIBLE_SOURCE', // MEDIA_ERR_DECODE
  4: 'NO_COMPATIBLE_SOURCE', // MEDIA_ERR_SRC_NOT_SUPPORTED
})

/**
 * Mechanical tokens the demuxers themselves emit when a container or codec
 * cannot be read. Matched only because the native layer exposes no code:
 * media3 folds the exception name and cause into a message string and
 * expo-video forwards just that string. These are identifier-shaped fragments
 * from media3/AVFoundation/Chromium, never prose we wrote, and none of them
 * appear in a transport failure (those read "Unable to connect", "Response
 * code: 416").
 *
 * `contentIsMalformed` is deliberately matched only when true: a file of filler
 * bytes named .mp4 reports `contentIsMalformed=false` and is still unreadable,
 * which is what the extractor and sniff tokens catch.
 */
const UNDECODABLE_SOURCE_TOKENS = [
  /None of the available extractors/i,
  /sniff failures/i,
  /UnrecognizedInputFormatException/,
  /ParserException/,
  /DecoderInitializationException/,
  /contentIsMalformed=true/,
  /ERROR_CODE_PARSING_/,
  /ERROR_CODE_DECODING_FORMAT_UNSUPPORTED/,
  /ERROR_CODE_DECODER_INIT_FAILED/,
  /DEMUXER_ERROR_/,
  /MEDIA_ERR_SRC_NOT_SUPPORTED/,
  // AVErrorFileFormatNotRecognized; AVFoundation reports the raw number.
  /-11828\b/,
  /not supported|unsupported|cannot be played/i,
]

function readPlayerErrorFields(error) {
  if (typeof error === 'string') return { errorCode: undefined, code: NaN, message: error }
  if (!error || typeof error !== 'object') return { errorCode: undefined, code: NaN, message: '' }
  const nested = error.error && typeof error.error === 'object' ? error.error : null
  return {
    errorCode: typeof error.errorCode === 'string' ? error.errorCode : nested?.errorCode,
    code: Number(error.code ?? nested?.code),
    message: String(error.message ?? nested?.message ?? ''),
  }
}

/**
 * Classify a failure raised by the playback surface itself (expo-video on
 * native, HTMLMediaElement on web) into this vocabulary, and say whether the
 * player may re-attach the source automatically.
 *
 * Structured input wins: an `errorCode` we already speak, then the MediaError
 * number, and only then the demuxer message tokens for the platforms that
 * expose nothing else.
 *
 * An unrecognised failure stays recoverable. The player's bounded re-attach
 * budget is the safety net there — refusing to retry what we cannot name would
 * strand playback that a buffer refill fixes — and once that budget is spent
 * the error is surfaced as the honest unknown.
 */
export function classifyPlayerError(error) {
  const { errorCode, code, message } = readPlayerErrorFields(error)

  let resolved = isPlaybackErrorCode(errorCode) ? errorCode : undefined
  if (!resolved && Number.isInteger(code)) {
    resolved = MEDIA_ERROR_CODE_TO_PLAYBACK_CODE[code]
  }
  if (!resolved && UNDECODABLE_SOURCE_TOKENS.some((token) => token.test(message))) {
    resolved = 'NO_COMPATIBLE_SOURCE'
  }

  const described = describePlaybackError(resolved)
  return {
    ...described,
    // Keep the platform's own wording for logs; the user sees the vocabulary
    // message, which is the only one we can promise means what it says.
    detail: message || null,
    terminal: described.known && !PLAYER_RECOVERABLE_CODES.includes(described.code),
  }
}
