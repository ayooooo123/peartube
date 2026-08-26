import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PLAYBACK_ERROR_CODES,
  classifyPlayerError,
} from '../lib/video-player/playback-errors.js'

// Verbatim from an Android run against a live relay: 400KB of filler bytes
// named .mp4. Every re-attach re-read all 409,600 bytes and media3 rejected
// them identically, so the only correct answer is "stop".
const ANDROID_UNPARSEABLE = {
  message: [
    'A playback exception has occurred: Source error None of the available extractors',
    '(FlvExtractor, FlacExtractor, WavExtractor, Mp4Extractor) could read the stream.',
    '{contentIsMalformed=false, dataType=1}',
    'sniff failures: [NoDeclaredBrand, NoDeclaredBrand]',
  ].join(' '),
  engine: 'expo-video',
}

test('an unparseable container is terminal, so the player never re-reads it', () => {
  const classified = classifyPlayerError(ANDROID_UNPARSEABLE)

  assert.equal(classified.terminal, true)
  assert.equal(classified.code, 'NO_COMPATIBLE_SOURCE')
  assert.equal(classified.retry, 'evidence')
  assert.equal(classified.action, null, 'a retry affordance here would be a lie')
  assert.equal(classified.detail, ANDROID_UNPARSEABLE.message, 'the platform wording survives for logs')
})

test('the terminal message tells the viewer the source cannot be played', () => {
  const { message } = classifyPlayerError(ANDROID_UNPARSEABLE)

  assert.match(message, /can play this title|cannot/i)
  assert.doesNotMatch(message, /loading|starting|connecting|buffering|awaiting/i)
})

test('demuxer tokens from every platform that reports no code are terminal', () => {
  const undecodable = [
    'A playback exception has occurred: Source error Unexpected exception loading stream ParserException',
    'ERROR_CODE_PARSING_CONTAINER_MALFORMED',
    'ERROR_CODE_DECODING_FORMAT_UNSUPPORTED',
    'MediaCodecRenderer$DecoderInitializationException: Decoder init failed',
    '{contentIsMalformed=true, dataType=1}',
    'DEMUXER_ERROR_COULD_NOT_OPEN',
    'The operation could not be completed (AVFoundationErrorDomain error -11828.)',
    'This media format is not supported',
  ]

  for (const message of undecodable) {
    const classified = classifyPlayerError({ message })
    assert.equal(classified.terminal, true, `${message} must not loop`)
    assert.equal(classified.code, 'NO_COMPATIBLE_SOURCE', message)
  }
})

test('transport failures stay recoverable so a stalled range request can retry', () => {
  const transport = [
    'A playback exception has occurred: Source error Unable to connect to http://127.0.0.1:9000/blobs/1',
    'A playback exception has occurred: Source error Response code: 416',
    'A playback exception has occurred: Source error java.net.SocketTimeoutException: timeout',
    'A playback exception has occurred: Unexpected runtime error',
  ]

  for (const message of transport) {
    const classified = classifyPlayerError({ message })
    assert.equal(classified.terminal, false, `${message} may retry within the attempt cap`)
  }
})

test('an unnamed failure stays recoverable and is surfaced as an honest unknown', () => {
  const classified = classifyPlayerError({ message: 'A playback exception has occurred: ' })

  assert.equal(classified.terminal, false)
  assert.equal(classified.known, false)
  assert.equal(classified.code, 'UNKNOWN_PLAYBACK_ERROR')
  assert.equal(classifyPlayerError(undefined).terminal, false)
  assert.equal(classifyPlayerError(null).terminal, false)
})

test('MediaError numbers are read before any message token', () => {
  // Nested under `error` is how HTMLMediaElement hands the fatal detail over.
  assert.equal(classifyPlayerError({ error: { code: 4 } }).code, 'NO_COMPATIBLE_SOURCE')
  assert.equal(classifyPlayerError({ error: { code: 4 } }).terminal, true)
  assert.equal(classifyPlayerError({ code: 3 }).terminal, true, 'a decode failure is deterministic')
  assert.equal(classifyPlayerError({ code: 2 }).code, 'PEER_DISCONNECT')
  assert.equal(classifyPlayerError({ code: 2 }).terminal, false, 'a network drop may retry')
  assert.equal(classifyPlayerError({ code: 1 }).code, 'PREPARATION_CANCELLED')
  assert.equal(classifyPlayerError({ code: 1 }).terminal, true, 'an abort needs a new user action')
  // A network code must not be overridden by prose that happens to say "not
  // supported"; the structured number is the stronger evidence.
  assert.equal(classifyPlayerError({ code: 2, message: 'format not supported' }).code, 'PEER_DISCONNECT')
})

test('a code the app already speaks is honoured instead of re-derived', () => {
  assert.equal(classifyPlayerError({ errorCode: 'AVAILABILITY_BOUNDARY' }).terminal, true)
  assert.equal(classifyPlayerError({ errorCode: 'RANGE_MISMATCH' }).terminal, true)
  assert.equal(classifyPlayerError({ errorCode: 'PEER_TIMEOUT' }).terminal, false)
  assert.equal(classifyPlayerError({ errorCode: 'SESSION_LIMIT' }).terminal, false)
})

test('every vocabulary code has a decided retryability, none guessed at', () => {
  const recoverable = []
  for (const code of PLAYBACK_ERROR_CODES) {
    const classified = classifyPlayerError({ errorCode: code })
    assert.equal(classified.known, true, code)
    assert.equal(typeof classified.terminal, 'boolean', code)
    if (!classified.terminal) recoverable.push(code)
  }
  assert.deepEqual(recoverable, ['PEER_TIMEOUT', 'PEER_DISCONNECT', 'SESSION_LIMIT'])
})
