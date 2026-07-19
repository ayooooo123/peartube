import test from 'node:test'
import assert from 'node:assert/strict'

import {
  consumeStagedWebChannelPlayback,
  createChannelPlaybackPayload,
  stageWebChannelPlayback,
} from '../lib/channel-playback-handoff.js'
import { resolveArtworkCandidates } from '../lib/channel-artwork.js'

function artworkState(url, nextIndex, provisional = false, failedUrls = []) {
  return { url, nextIndex, provisional, failedUrls }
}

test('structured playback payload retains remote and direct-blob context for native and web consumers', () => {
  const payload = createChannelPlaybackPayload({
    item: {
      id: 'video-id',
      title: 'Episode title',
      blobId: 'video-blob',
      blobsCoreKey: 'video-core',
      mimeType: 'video/mp4',
      thumbnailBlobId: 'thumb-blob',
      thumbnailBlobsCoreKey: 'thumb-core',
      thumbnailMimeType: 'image/jpeg',
      publicBeeKey: 'item-bee',
    },
    channelKey: 'channel-key',
    publicBeeKey: 'route-bee',
    thumbnailUrl: 'http://127.0.0.1/thumb',
    channelName: 'Channel',
  })

  assert.deepEqual(payload, {
    id: 'video-id',
    title: 'Episode title',
    blobId: 'video-blob',
    blobsCoreKey: 'video-core',
    mimeType: 'video/mp4',
    thumbnailBlobId: 'thumb-blob',
    thumbnailBlobsCoreKey: 'thumb-core',
    thumbnailMimeType: 'image/jpeg',
    publicBeeKey: 'route-bee',
    channelKey: 'channel-key',
    thumbnailUrl: 'http://127.0.0.1/thumb',
    channel: { name: 'Channel' },
  })
})

test('web playback handoff stages the same structured payload consumed by the watch route', () => {
  const dispatched = []
  const target = {
    dispatchEvent(event) {
      dispatched.push(event)
    },
  }
  const payload = createChannelPlaybackPayload({
    item: {
      id: 'video-id',
      blobId: 'video-blob',
      blobsCoreKey: 'video-core',
      publicBeeKey: 'item-bee',
    },
    channelKey: 'channel-key',
    publicBeeKey: '',
    channelName: 'Channel',
  })

  stageWebChannelPlayback(target, payload)

  assert.strictEqual(target.__peartubePendingWatchVideo, payload)
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].type, 'peartube:watch-video')
  assert.strictEqual(dispatched[0].detail.video, payload)
  assert.equal(dispatched[0].detail.video.publicBeeKey, 'item-bee')
  assert.equal(dispatched[0].detail.video.blobId, 'video-blob')
  assert.equal(dispatched[0].detail.video.blobsCoreKey, 'video-core')
})

test('staged structured playback wins over stale legacy video data and is consumed once', () => {
  const target = {}
  const structured = createChannelPlaybackPayload({
    item: {
      id: 'video-id',
      title: 'Structured title',
      blobId: 'structured-blob',
      blobsCoreKey: 'structured-core',
      publicBeeKey: 'structured-bee',
    },
    channelKey: 'channel-key',
    publicBeeKey: '',
    channelName: 'Structured channel',
  })
  const legacy = [{
    id: 'video-id',
    title: 'Stale title',
    channelKey: 'channel-key',
    blobId: 'stale-blob',
  }]
  stageWebChannelPlayback(target, structured)

  const first = consumeStagedWebChannelPlayback(target, 'channel-key', 'video-id', legacy)
  assert.strictEqual(first, structured)
  assert.equal(first.publicBeeKey, 'structured-bee')
  assert.equal(first.blobId, 'structured-blob')
  assert.equal(first.blobsCoreKey, 'structured-core')
  assert.equal(Object.hasOwn(target, '__peartubePendingWatchVideo'), false)

  const second = consumeStagedWebChannelPlayback(target, 'channel-key', 'video-id', legacy)
  assert.equal(second.title, 'Stale title')
})

test('artwork resolution preserves mapper order when a higher-role remote precedes a lower-role blob', async () => {
  const blobCalls = []
  const result = await resolveArtworkCandidates([
    { kind: 'remote', role: 'backdrop', url: 'https://example.test/backdrop.jpg' },
    { kind: 'blob', role: 'banner', blobId: 'banner', blobsCoreKey: 'core', mimeType: 'image/jpeg' },
  ], async (candidate) => {
    blobCalls.push(candidate.blobId)
    return 'http://127.0.0.1/banner'
  })

  assert.deepEqual(result, artworkState('https://example.test/backdrop.jpg', 1))
  assert.deepEqual(blobCalls, [])
})

test('artwork resolution advances through failed blobs, same-role remote fallback, and later roles', async () => {
  const failedBlobCalls = []
  const remoteFallback = await resolveArtworkCandidates([
    { kind: 'blob', role: 'thumbnail', blobId: 'first', blobsCoreKey: 'core-1', mimeType: 'image/jpeg' },
    { kind: 'remote', role: 'thumbnail', url: 'https://example.test/thumbnail.jpg' },
    { kind: 'blob', role: 'avatar', blobId: 'later', blobsCoreKey: 'core-2', mimeType: 'image/jpeg' },
  ], async (candidate) => {
    failedBlobCalls.push(candidate.blobId)
    return null
  })
  assert.deepEqual(remoteFallback, artworkState('https://example.test/thumbnail.jpg', 2))
  assert.deepEqual(failedBlobCalls, ['first'])

  const laterRoleCalls = []
  const laterRole = await resolveArtworkCandidates([
    { kind: 'blob', role: 'thumbnail', blobId: 'first', blobsCoreKey: 'core-1', mimeType: 'image/jpeg' },
    { kind: 'remote', role: 'thumbnail', url: '' },
    { kind: 'blob', role: 'avatar', blobId: 'later', blobsCoreKey: 'core-2', mimeType: 'image/jpeg' },
  ], async (candidate) => {
    laterRoleCalls.push(candidate.blobId)
    return candidate.blobId === 'later' ? 'http://127.0.0.1/avatar' : null
  })
  assert.deepEqual(laterRole, artworkState('http://127.0.0.1/avatar', 3))
  assert.deepEqual(laterRoleCalls, ['first', 'later'])
})

test('remote image failures resume at the next candidate through exhaustion', async () => {
  const candidates = [
    { kind: 'remote', role: 'thumbnail', url: 'https://example.test/first.jpg' },
    { kind: 'remote', role: 'poster', url: 'https://example.test/second.jpg' },
    { kind: 'blob', role: 'avatar', blobId: 'avatar', blobsCoreKey: 'core', mimeType: 'image/jpeg' },
  ]
  const resolveBlob = async (candidate) => (
    candidate.blobId === 'avatar' ? 'http://127.0.0.1/avatar' : null
  )

  const first = await resolveArtworkCandidates(candidates, resolveBlob)
  assert.deepEqual(first, artworkState('https://example.test/first.jpg', 1))
  const second = await resolveArtworkCandidates(candidates, resolveBlob, { startIndex: first.nextIndex })
  assert.deepEqual(second, artworkState('https://example.test/second.jpg', 2))
  const third = await resolveArtworkCandidates(candidates, resolveBlob, { startIndex: second.nextIndex })
  assert.deepEqual(third, artworkState('http://127.0.0.1/avatar', 3))
  assert.deepEqual(
    await resolveArtworkCandidates(candidates, resolveBlob, { startIndex: third.nextIndex }),
    artworkState(null, 3),
  )
})

test('an unavailable blob resolver yields provisional fallback that retries preferred blobs when ready', async () => {
  const candidates = [
    { kind: 'blob', role: 'thumbnail', blobId: 'preferred', blobsCoreKey: 'core', mimeType: 'image/jpeg' },
    { kind: 'remote', role: 'thumbnail', url: 'https://example.test/fallback.jpg' },
  ]
  let calls = 0
  const resolveBlob = async () => {
    calls += 1
    return 'http://127.0.0.1/preferred'
  }

  const provisional = await resolveArtworkCandidates(
    candidates,
    resolveBlob,
    { blobResolverAvailable: false },
  )
  assert.deepEqual(provisional, artworkState('https://example.test/fallback.jpg', 2, true))
  assert.equal(calls, 0)
  assert.deepEqual(
    await resolveArtworkCandidates(candidates, resolveBlob, {
      startIndex: provisional.nextIndex,
      blobResolverAvailable: false,
      initialProvisional: provisional.provisional,
    }),
    artworkState(null, 2, true),
  )
  assert.deepEqual(
    await resolveArtworkCandidates(candidates, resolveBlob, {
      startIndex: 0,
      blobResolverAvailable: true,
    }),
    artworkState('http://127.0.0.1/preferred', 1),
  )
  assert.equal(calls, 1)
})

test('artwork resolution suppresses late blob completion after its request becomes stale', async () => {
  let resolveBlob
  let stale = false
  const blob = new Promise((resolve) => {
    resolveBlob = resolve
  })
  const resolving = resolveArtworkCandidates([
    { kind: 'blob', role: 'thumbnail', blobId: 'first', blobsCoreKey: 'core', mimeType: 'image/jpeg' },
  ], () => blob, { isStale: () => stale })

  stale = true
  resolveBlob('http://127.0.0.1/late')
  assert.equal(await resolving, null)
})

test('mismatched staged playback is preserved while the requested legacy item is selected', () => {
  const pending = { id: 'other-video', channelKey: 'channel-key', blobId: 'pending-blob' }
  const target = { __peartubePendingWatchVideo: pending }
  const legacy = [{ id: 'video-id', channelKey: 'channel-key', title: 'Legacy' }]

  assert.equal(
    consumeStagedWebChannelPlayback(target, 'channel-key', 'video-id', legacy).title,
    'Legacy',
  )
  assert.strictEqual(target.__peartubePendingWatchVideo, pending)
  assert.strictEqual(
    consumeStagedWebChannelPlayback(target, 'channel-key', 'other-video', legacy),
    pending,
  )
  assert.equal(Object.hasOwn(target, '__peartubePendingWatchVideo'), false)
})

test('artwork resolution honors an expired per-item deadline without starting blob work', async () => {
  let calls = 0
  const result = await resolveArtworkCandidates([
    { kind: 'blob', role: 'thumbnail', blobId: 'first', blobsCoreKey: 'core', mimeType: 'image/jpeg' },
  ], async () => {
    calls += 1
    return 'http://127.0.0.1/too-late'
  }, { deadline: Date.now() - 1 })

  assert.deepEqual(result, artworkState(null, 1))
  assert.equal(calls, 0)
})

test('a preferred blob timing out still falls through to a later remote candidate', async () => {
  const never = new Promise(() => {})
  const result = await resolveArtworkCandidates([
    { kind: 'blob', role: 'thumbnail', blobId: 'preferred', blobsCoreKey: 'core', mimeType: 'image/jpeg' },
    { kind: 'remote', role: 'thumbnail', url: 'https://example.test/fallback.jpg' },
  ], () => never, { deadline: Date.now() + 5 })

  assert.deepEqual(result, artworkState('https://example.test/fallback.jpg', 2))
})

test('an expired blob deadline skips every remaining blob without hiding later remotes', async () => {
  let blobCalls = 0
  const result = await resolveArtworkCandidates([
    { kind: 'blob', role: 'thumbnail', blobId: 'first', blobsCoreKey: 'core-1', mimeType: 'image/jpeg' },
    { kind: 'blob', role: 'poster', blobId: 'second', blobsCoreKey: 'core-2', mimeType: 'image/jpeg' },
    { kind: 'remote', role: 'poster', url: 'https://example.test/poster.jpg' },
  ], async () => {
    blobCalls += 1
    return 'http://127.0.0.1/unexpected'
  }, { deadline: Date.now() - 1 })

  assert.deepEqual(result, artworkState('https://example.test/poster.jpg', 3))
  assert.equal(blobCalls, 0)
})

test('failed duplicate remote URLs are skipped across roles in favor of a new URL', async () => {
  const candidates = [
    { kind: 'remote', role: 'thumbnail', url: 'https://example.test/x.jpg' },
    { kind: 'remote', role: 'poster', url: 'https://example.test/x.jpg' },
    { kind: 'remote', role: 'avatar', url: 'https://example.test/y.jpg' },
  ]
  const first = await resolveArtworkCandidates(candidates, null)
  const afterError = await resolveArtworkCandidates(candidates, null, {
    startIndex: first.nextIndex,
    failedUrls: [...first.failedUrls, first.url],
  })

  assert.deepEqual(first, artworkState('https://example.test/x.jpg', 1))
  assert.deepEqual(
    afterError,
    artworkState('https://example.test/y.jpg', 3, false, ['https://example.test/x.jpg']),
  )
})

test('a blob URL that already failed is skipped and duplicate blob candidates resolve once', async () => {
  const calls = []
  const candidates = [
    { kind: 'blob', role: 'thumbnail', blobId: 'same', blobsCoreKey: 'core', mimeType: 'image/jpeg' },
    { kind: 'blob', role: 'poster', blobId: 'same', blobsCoreKey: 'core', mimeType: 'image/jpeg' },
    { kind: 'remote', role: 'poster', url: 'https://example.test/y.jpg' },
  ]
  const result = await resolveArtworkCandidates(candidates, async (candidate) => {
    calls.push(candidate.blobId)
    return 'https://example.test/x.jpg'
  }, { failedUrls: ['https://example.test/x.jpg'] })

  assert.deepEqual(
    result,
    artworkState('https://example.test/y.jpg', 3, false, ['https://example.test/x.jpg']),
  )
  assert.deepEqual(calls, ['same'])
})

test('failed artwork URL history stays bounded while candidate progression exhausts', async () => {
  const failedUrls = Array.from({ length: 20 }, (_, index) => `https://example.test/${index}.jpg`)
  const result = await resolveArtworkCandidates([
    { kind: 'remote', role: 'thumbnail', url: failedUrls.at(-1) },
  ], null, { failedUrls })

  assert.equal(result.url, null)
  assert.equal(result.nextIndex, 1)
  assert.equal(result.failedUrls.length <= 8, true)
  assert.deepEqual(result.failedUrls, failedUrls.slice(-8))
})
