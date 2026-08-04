import test from 'brittle'
import http from 'node:http'

import { createAssetSession } from '../src/assets/asset-session.js'
import { createMultiPeerScheduler } from '../src/playback/multi-peer-scheduler.js'
import {
  PLAYBACK_ERRORS,
  PLAYBACK_ERROR_CODES,
  RETRYABLE_PLAYBACK_ERROR_CODES,
  TERMINAL_PLAYBACK_ERROR_CODES,
  createPlaybackError,
  isPlaybackErrorCode,
  playbackErrorMessage,
  playbackErrorRetry,
} from '../src/playback/errors.js'
import {
  PLAYBACK_TRAFFIC_CLASSES,
  assertLoopbackPlaybackUrl,
  classifyPlaybackTraffic,
} from '../src/playback/transport-guard.js'
import { preparePlaybackSource } from '../src/playback/source-preparation.js'

const CORE_KEY = 'a'.repeat(64)
const OTHER_KEY = 'b'.repeat(64)

function manifest(renditions) {
  return { publicationId: 'pub-1', body: { publisherId: 'publisher-1', renditions } }
}

function rendition(overrides = {}) {
  return {
    renditionId: 'rendition-1',
    purpose: 'original',
    format: 'video/mp4',
    core: { key: CORE_KEY, length: 8 },
    ...overrides,
  }
}

test('every playback failure has exactly one code, message, and retry policy', (t) => {
  t.ok(PLAYBACK_ERROR_CODES.length > 0)
  for (const code of PLAYBACK_ERROR_CODES) {
    const entry = PLAYBACK_ERRORS[code]
    t.ok(entry.message.length > 0, `${code} has a message`)
    t.ok(['automatic', 'manual', 'evidence'].includes(entry.retry), `${code} has a retry policy`)
    t.is(playbackErrorMessage(code), entry.message)
    t.is(playbackErrorRetry(code), entry.retry)
    t.is(isPlaybackErrorCode(code), true)
  }
  for (const code of ['AVAILABILITY_BOUNDARY', 'NO_COMPATIBLE_SOURCE', 'PEER_TIMEOUT', 'PEER_DISCONNECT', 'RANGE_MISMATCH', 'SESSION_LIMIT']) {
    t.ok(PLAYBACK_ERROR_CODES.includes(code), `${code} is part of the transported vocabulary`)
  }
})

test('only failures another source might not share are retried automatically', (t) => {
  t.alike(
    [...RETRYABLE_PLAYBACK_ERROR_CODES].sort(),
    ['ATTEMPT_LIMIT', 'PEER_DISCONNECT', 'PEER_TIMEOUT', 'RANGE_MISMATCH', 'SESSION_LIMIT'].filter(
      code => RETRYABLE_PLAYBACK_ERROR_CODES.includes(code)
    ).sort()
  )
  for (const code of ['PEER_TIMEOUT', 'PEER_DISCONNECT', 'RANGE_MISMATCH', 'SESSION_LIMIT']) {
    t.ok(RETRYABLE_PLAYBACK_ERROR_CODES.includes(code), `${code} may try another source`)
  }
  for (const code of ['AVAILABILITY_BOUNDARY', 'NO_COMPATIBLE_SOURCE']) {
    t.ok(TERMINAL_PLAYBACK_ERROR_CODES.includes(code), `${code} cannot loop`)
    t.absent(RETRYABLE_PLAYBACK_ERROR_CODES.includes(code), `${code} is never retried automatically`)
  }
  t.absent(
    RETRYABLE_PLAYBACK_ERROR_CODES.some(code => TERMINAL_PLAYBACK_ERROR_CODES.includes(code)),
    'no code is both retryable and terminal'
  )
})

test('a playback error carries its own bounded code', (t) => {
  const error = createPlaybackError('RANGE_MISMATCH')
  t.is(error.errorCode, 'RANGE_MISMATCH')
  t.is(error.retry, 'automatic')
  t.is(error.message, PLAYBACK_ERRORS.RANGE_MISMATCH.message)
  t.is(createPlaybackError('not-a-code').errorCode, 'NO_COMPATIBLE_SOURCE', 'an unknown code degrades, never leaks')
})

test('only the loopback blob server may carry media bytes', (t) => {
  for (const url of ['http://127.0.0.1:9000/blob', 'http://localhost:9000/blob', 'http://[::1]:9000/blob']) {
    t.is(classifyPlaybackTraffic(url, 'media'), PLAYBACK_TRAFFIC_CLASSES.mediaLoopback, `${url} is the local pipe`)
    t.is(assertLoopbackPlaybackUrl(url), url)
  }
  for (const url of [
    'https://cdn.example.com/movie.mp4',
    'http://198.51.100.7:9000/blob',
    'https://127.0.0.1.example.com/blob',
    'ftp://127.0.0.1/blob',
  ]) {
    t.is(classifyPlaybackTraffic(url, 'media'), PLAYBACK_TRAFFIC_CLASSES.forbiddenOrigin, `${url} is not a media origin`)
    t.exception(() => assertLoopbackPlaybackUrl(url), /loopback/)
  }
})

test('manifests, artwork, and diagnostics are control plane, not media', (t) => {
  for (const purpose of ['manifest', 'artwork', 'diagnostics']) {
    t.is(
      classifyPlaybackTraffic('https://provider.example.com/endpoint', purpose),
      PLAYBACK_TRAFFIC_CLASSES.controlPlane,
      `${purpose} may leave the device`
    )
  }
  // The control-plane set is closed. An unlisted purpose is not a narrower kind
  // of control plane; it is an origin the player must never reach.
  t.is(
    classifyPlaybackTraffic('https://provider.example.com/endpoint', 'anything-else'),
    PLAYBACK_TRAFFIC_CLASSES.forbiddenOrigin,
    'an unlisted purpose cannot excuse a remote host'
  )
  t.is(
    classifyPlaybackTraffic('https://provider.example.com/segment.m4s', 'media'),
    PLAYBACK_TRAFFIC_CLASSES.forbiddenOrigin,
    'the same host carrying media is still forbidden'
  )
})

test('an asset session opens only the cores its signed manifest names', async (t) => {
  const opened = []
  const session = createAssetSession({
    manifest: manifest([rendition()]),
    openCore: async key => { opened.push(key); return { close() {} } },
  })

  t.is(await session.authorizeCore({ renditionId: 'rendition-1', coreKey: CORE_KEY }), true)
  t.is(await session.authorizeCore({ renditionId: 'rendition-1', coreKey: OTHER_KEY }), false, 'a substituted key is refused')
  t.is(await session.authorizeCore({ renditionId: 'unknown', coreKey: CORE_KEY }), false, 'an unlisted rendition is refused')
  t.alike(opened, [CORE_KEY], 'only the authorized core was ever opened')
  session.close()
})

test('a session refuses blocked and superseded renditions', async (t) => {
  const session = createAssetSession({
    manifest: manifest([
      rendition({ renditionId: 'blocked', blocked: true }),
      rendition({ renditionId: 'old', superseded: true }),
    ]),
    openCore: async () => ({ close() {} }),
  })

  t.is(await session.authorizeCore({ renditionId: 'blocked', coreKey: CORE_KEY }), false)
  t.is(await session.authorizeCore({ renditionId: 'old', coreKey: CORE_KEY }), false)
  t.is(session.isAuthorizedCore(CORE_KEY), false, 'no live rendition claims that core')
})

test('reads outside the signed block range are a range mismatch', async (t) => {
  const session = createAssetSession({
    manifest: manifest([rendition()]),
    openCore: async () => ({ close() {} }),
  })
  await session.authorizeCore({ renditionId: 'rendition-1', coreKey: CORE_KEY })

  t.is(session.authorizeRange({ renditionId: 'rendition-1', range: { start: 0, end: 8 } }), true)
  t.is(session.authorizeRange({ renditionId: 'rendition-1', range: { start: 0, end: 9 } }), false, 'past the signed length')
  t.is(session.authorizeRange({ renditionId: 'rendition-1', range: { start: 5, end: 5 } }), false, 'empty range')
  t.is(session.authorizeRange({ renditionId: 'rendition-1', range: { start: -1, end: 4 } }), false, 'negative start')
  t.is(session.authorizeRange({ renditionId: 'unauthorized', range: { start: 0, end: 4 } }), false)
})

test('a session caps how many cores it holds open', async (t) => {
  const session = createAssetSession({
    manifest: manifest([
      rendition({ renditionId: 'r1', core: { key: '1'.repeat(64), length: 4 } }),
      rendition({ renditionId: 'r2', core: { key: '2'.repeat(64), length: 4 } }),
    ]),
    openCore: async () => ({ close() {} }),
    maxActiveCores: 1,
  })

  t.is(await session.authorizeCore({ renditionId: 'r1', coreKey: '1'.repeat(64) }), true)
  await t.exception(
    session.authorizeCore({ renditionId: 'r2', coreKey: '2'.repeat(64) }),
    /Too many playback sessions/
  )
  t.is(session.activeCoreCount(), 1)
})

test('a closed session authorizes nothing further', async (t) => {
  const session = createAssetSession({ manifest: manifest([rendition()]), openCore: async () => ({ close() {} }) })
  await session.authorizeCore({ renditionId: 'rendition-1', coreKey: CORE_KEY })
  session.close()

  t.is(session.activeCoreCount(), 0)
  t.is(await session.authorizeCore({ renditionId: 'rendition-1', coreKey: CORE_KEY }), false)
  t.is(session.authorizeRange({ renditionId: 'rendition-1', range: { start: 0, end: 4 } }), false)
})

test('local complete playback needs no peer at all', async (t) => {
  const scheduler = createMultiPeerScheduler({
    local: { hasRange: () => true },
    peers: [],
  })
  const result = await scheduler.requestRange({ start: 0, end: 4 })

  t.is(result.status, 'ok')
  t.is(result.source, 'local')
  t.is(result.originAttempted, false)
  t.is(scheduler.metrics().peerRequests, 0, 'a local copy never touches the network')
})

test('remote playback is served by peers and reports a bounded code when none can', async (t) => {
  const served = await createMultiPeerScheduler({
    local: { hasRange: () => false },
    peers: [{ id: 'peer-a', connected: true, ranges: [{ start: 0, end: 8 }], verify: () => true }],
  }).requestRange({ start: 0, end: 4 })
  t.is(served.status, 'ok')
  t.is(served.source, 'peer')
  t.is(served.originAttempted, false)

  const missing = await createMultiPeerScheduler({ local: { hasRange: () => false }, peers: [] })
    .requestRange({ start: 0, end: 4 })
  t.is(missing.status, 'unavailable')
  t.is(missing.errorCode, 'AVAILABILITY_BOUNDARY')
  t.is(missing.originAttempted, false, 'no origin was tried, because there is none')
})

test('a peer that fails verification is a range mismatch, not an empty network', async (t) => {
  const result = await createMultiPeerScheduler({
    local: { hasRange: () => false },
    peers: [{ id: 'liar', connected: true, ranges: [{ start: 0, end: 8 }], verify: async () => false }],
  }).requestRange({ start: 0, end: 4 })

  t.is(result.status, 'unavailable')
  t.is(result.errorCode, 'RANGE_MISMATCH')
  t.is(playbackErrorRetry(result.errorCode), 'automatic', 'another source may still have the bytes')
})

test('a disconnected peer cannot serve, and the answer stays inside the vocabulary', async (t) => {
  const result = await createMultiPeerScheduler({
    local: { hasRange: () => false },
    peers: [{ id: 'gone', connected: false, ranges: [{ start: 0, end: 8 }], verify: () => true }],
  }).requestRange({ start: 0, end: 4 })

  t.is(result.errorCode, 'AVAILABILITY_BOUNDARY')
  t.is(isPlaybackErrorCode(result.errorCode), true)
})

test('a missing startup range leaves no half-open session and names no origin', async (t) => {
  const closed = []
  const result = await preparePlaybackSource({
    sources: [{
      publicationId: 'pub-1',
      entityId: 'work:1',
      renditionId: 'rendition-1',
      publicationAuthorized: true,
      availability: { state: 'healthy', requiredRangeCount: 1, reachableRangeCount: 1, completePeerCount: 2 },
    }],
    now: () => 1_700_000_000_000,
    openSession: async () => ({
      success: false,
      errorCode: 'AVAILABILITY_BOUNDARY',
      close: () => closed.push('pub-1'),
    }),
  })

  t.is(result.success, false)
  t.is(result.errorCode, 'AVAILABILITY_BOUNDARY')
  t.alike(closed, ['pub-1'], 'the half-open attempt was closed')
  const serialized = JSON.stringify(result)
  t.absent(/https?:\/\//.test(serialized), 'the failure names no origin or CDN')
})

test('an HTTP trap receives zero media requests while two peers serve playback', async (t) => {
  const trapped = []
  const trap = http.createServer((request, response) => {
    trapped.push(request.url)
    response.statusCode = 200
    response.end('trap')
  })
  await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise(resolve => trap.close(resolve)))

  const trapUrl = `http://127.0.0.1:${trap.address().port}/segment.m4s`
  // The trap is a legitimate loopback address, so the URL guard alone cannot
  // catch it. What keeps it empty is that the transport has no HTTP branch.
  const scheduler = createMultiPeerScheduler({
    local: { hasRange: () => false },
    peers: [
      { id: 'peer-a', connected: true, ranges: [{ start: 0, end: 4 }], verify: () => true, originUrl: trapUrl },
      { id: 'peer-b', connected: true, ranges: [{ start: 4, end: 8 }], verify: () => true, originUrl: trapUrl },
    ],
  })

  const first = await scheduler.requestRange({ start: 0, end: 4 })
  const second = await scheduler.requestRange({ start: 4, end: 8 })
  const beyond = await scheduler.requestRange({ start: 8, end: 12 })

  t.is(first.source, 'peer')
  t.is(second.source, 'peer')
  t.is(beyond.status, 'unavailable')
  t.is(beyond.errorCode, 'AVAILABILITY_BOUNDARY', 'a gap fails rather than falling back to the trap')
  t.alike(trapped, [], 'the HTTP trap received nothing')
  t.is(scheduler.metrics().peerRequests, 2)
})

test('a redirect to an origin cannot be laundered into a media URL', (t) => {
  for (const url of [
    'http://127.0.0.1:9000/redirect?to=https://cdn.example.com/movie.mp4',
    'https://cdn.example.com/redirect?to=http://127.0.0.1:9000/blob',
  ]) {
    const classification = classifyPlaybackTraffic(url, 'media')
    if (url.startsWith('http://127.0.0.1')) {
      t.is(classification, PLAYBACK_TRAFFIC_CLASSES.mediaLoopback, 'the loopback server itself never follows the query')
    } else {
      t.is(classification, PLAYBACK_TRAFFIC_CLASSES.forbiddenOrigin, 'a remote host is forbidden whatever it points at')
    }
  }
})
