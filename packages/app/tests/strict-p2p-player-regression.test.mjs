import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  PLAYBACK_ERROR_CODES,
  describePlaybackError,
  isPlaybackErrorCode,
  isPlaybackErrorRetryable,
} from '../lib/video-player/playback-errors.js'
import { startMediaPlayback } from '../components/routes/media-entity-loaders.js'

const appRoot = path.resolve(import.meta.dirname, '..')

const BACKEND_CODES = [
  'AVAILABILITY_BOUNDARY',
  'NO_COMPATIBLE_SOURCE',
  'PEER_TIMEOUT',
  'PEER_DISCONNECT',
  'RANGE_MISMATCH',
  'SESSION_LIMIT',
  'PREPARATION_DEADLINE',
  'PREPARATION_CANCELLED',
  'ATTEMPT_LIMIT',
]

test('the player knows every code the backend can send, and no others', () => {
  assert.deepEqual([...PLAYBACK_ERROR_CODES].sort(), [...BACKEND_CODES].sort())
})

test('every code renders one message and one honest retry affordance', () => {
  const messages = new Set()
  for (const code of PLAYBACK_ERROR_CODES) {
    const described = describePlaybackError(code)
    assert.equal(described.code, code)
    assert.equal(described.known, true)
    assert.ok(described.message.length > 0, `${code} has a message`)
    assert.ok(['automatic', 'manual', 'evidence'].includes(described.retry), `${code} has a retry policy`)
    messages.add(described.message)
    if (described.retry === 'evidence') {
      assert.equal(described.action, null, `${code} must not offer a retry that cannot help`)
      assert.equal(isPlaybackErrorRetryable(code), false)
    } else {
      assert.ok(described.action, `${code} offers an action`)
      assert.equal(isPlaybackErrorRetryable(code), true)
    }
  }
  assert.equal(messages.size, PLAYBACK_ERROR_CODES.length, 'no two codes share a message')
})

test('an unrecognised code is surfaced honestly instead of being guessed at', () => {
  const described = describePlaybackError('SOMETHING_NEW')
  assert.equal(described.known, false)
  assert.equal(described.code, 'UNKNOWN_PLAYBACK_ERROR')
  assert.equal(isPlaybackErrorCode('SOMETHING_NEW'), false)
  assert.equal(describePlaybackError(undefined).known, false)
  assert.equal(describePlaybackError({ errorCode: 'PEER_TIMEOUT' }).code, 'PEER_TIMEOUT')
})

test('availability copy never promises the title will come back', () => {
  for (const code of ['AVAILABILITY_BOUNDARY', 'NO_COMPATIBLE_SOURCE']) {
    const { message } = describePlaybackError(code)
    assert.doesNotMatch(message, /soon|shortly|later|will be|try again/i, `${code} must not promise a future`)
  }
})

test('a missing startup range reaches the player as a boundary, never as an origin hint', async () => {
  const rpc = {
    async prepareMediaPlayback() {
      return {
        success: false,
        errorCode: 'AVAILABILITY_BOUNDARY',
        error: 'Unavailable - no peer currently serves the required ranges.',
        retry: 'evidence',
        attempts: [{ publicationId: 'pub-a', errorCode: 'AVAILABILITY_BOUNDARY' }],
        sources: [],
      }
    },
  }

  await assert.rejects(
    () => startMediaPlayback({ rpc, entityId: 'work:movie-1' }),
    (error) => {
      const described = describePlaybackError(error.code)
      assert.equal(described.code, 'AVAILABILITY_BOUNDARY')
      assert.equal(described.retry, 'evidence')
      assert.doesNotMatch(error.message, /https?:\/\//, 'the player is never handed an origin')
      return true
    }
  )
})

test('the player never receives a URL for anything but the loopback blob server', async () => {
  const rpc = {
    async prepareMediaPlayback() {
      return {
        success: true,
        publicationId: 'pub-a',
        renditionId: 'rendition-a',
        coreKey: 'a'.repeat(64),
        attempts: [{ publicationId: 'pub-a', errorCode: null }],
        sources: [],
      }
    },
  }

  const prepared = await startMediaPlayback({ rpc, entityId: 'work:movie-1' })
  const serialized = JSON.stringify(prepared)
  assert.doesNotMatch(serialized, /https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\])/, 'no remote origin crosses the boundary')
  assert.equal(prepared.coreKey, 'a'.repeat(64), 'the player is handed a verified core, not a fetchable link')
})

test('no player module reaches for an HTTP media fetch of its own', () => {
  const playerFiles = [
    'lib/video-player/playerPort.ts',
    'lib/video-player/playback-errors.js',
    'components/routes/media-entity-loaders.js',
  ]
  for (const relative of playerFiles) {
    const source = fs.readFileSync(path.join(appRoot, relative), 'utf8')
    assert.doesNotMatch(
      source,
      /fetch\(\s*['"`]https?:\/\/(?!127\.0\.0\.1|localhost)/,
      `${relative} must not fetch remote media`
    )
    assert.doesNotMatch(source, /cdn\.|\.cloudfront\.|origin-fallback/i, `${relative} must not reference a CDN origin`)
  }
})
