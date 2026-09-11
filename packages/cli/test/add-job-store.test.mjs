import test from 'brittle'
import { buildMovieItemDraft } from '../src/add/content-model.js'
import {
  canonicalLocalFileSelector,
  canonicalLocalResolutionRecord,
  executeLocalFileAcquisition,
  normalizeLocalDurationSeconds
} from '../src/local-file-acquisition.js'
import { createLocalFileSourceGrantRegistry } from '../src/runtime.js'

test('canonical local identity is content SHA-256 only', (t) => {
  const sha256 = 'a'.repeat(64)
  const canon = canonicalLocalResolutionRecord({
    sha256,
    byteLength: 1024,
    title: 'The Matrix',
    fileName: 'matrix.mp4',
    kind: 'movie',
    namespace: 'tmdb',
    identifier: '603',
  })
  t.is(canon.idempotencyKey, `local_${sha256.slice(0, 32)}`)
  t.alike(canon.selector, { kind: 'movie', namespace: 'tmdb', identifier: '603' })
  t.is(canon.expectedBytes, 1024)
  t.is(canon.sourceFileName, 'matrix.mp4')
  t.absent(String(canon.idempotencyKey).includes('/'))
  t.absent(String(JSON.stringify(canon)).includes('http'))

  t.exception(() => canonicalLocalResolutionRecord({
    sha256: 'v1',
    byteLength: 1,
    title: 'bad',
    fileName: 'bad.mp4',
  }), /64-hex/)
})

test('local selectors require real external strings or a valid digest', (t) => {
  t.alike(canonicalLocalFileSelector({ namespace: ' tmdb ', identifier: ' 603 ' }), {
    kind: 'movie', namespace: 'tmdb', identifier: '603',
  })
  t.alike(canonicalLocalFileSelector({
    kind: 'episode', namespace: ' tmdb ', identifier: ' 1396 ', season: 1, episode: 2,
  }), { kind: 'episode', namespace: 'tmdb', identifier: '1396', season: 1, episode: 2 })

  for (const external of [
    { namespace: {}, identifier: '603' },
    { namespace: 'tmdb', identifier: 603 },
    { namespace: '  ', identifier: '603' },
    { namespace: 'tmdb', identifier: '  ' },
    { namespace: ['tmdb'], identifier: { id: '603' } },
  ]) {
    t.exception(() => canonicalLocalFileSelector(external), /64-hex/)
    t.exception(() => canonicalLocalFileSelector({ ...external, sha256: 'not-a-digest' }), /64-hex/)
    t.alike(canonicalLocalFileSelector({ ...external, sha256: `sha256:${'AB'.repeat(32)}` }), {
      kind: 'movie', namespace: 'peartube', identifier: 'ab'.repeat(16),
    })
  }
})

test('duration normalizer rounds finite seconds', (t) => {
  t.is(normalizeLocalDurationSeconds(42.4), 42)
  t.is(normalizeLocalDurationSeconds('90'), 90)
  t.is(normalizeLocalDurationSeconds(0), null)
  t.is(normalizeLocalDurationSeconds(Number.NaN), null)
  t.is(normalizeLocalDurationSeconds(null), null)
})

test('aborting a local acquisition waits for reader cancellation and private grant disposal', async (t) => {
  const events = []
  const controller = new AbortController()
  const grants = createLocalFileSourceGrantRegistry({ now: () => 1_000 })
  const publisherId = 'c'.repeat(64)
  const acquisitionId = 'acq-local-abort'
  let job = { acquisitionId, state: 'queued' }
  let grantToken = null
  let cancelCalls = 0
  let readerStarted
  let startReader
  let readerFinished
  let finishReader

  readerStarted = new Promise(resolve => { startReader = resolve })
  readerFinished = new Promise(resolve => { finishReader = resolve })

  const runtime = {
    issueLocalProviderResolution: () => ({ resolutionRef: 'local-resolution' }),
    localFileSourceGrants: grants,
    provider: {
      async requestAcquisition () {
        return { ...job }
      },
      async attachSourceGrant ({ grant }) {
        grantToken = grant.token
        job = { ...job, state: 'acquiring' }
        events.push('reader-started')
        startReader()
        void (async () => {
          await readerFinished
          events.push('reader-finished')
        })()
        return { ...job }
      },
      async getAcquisition () {
        return { ...job }
      },
      async cancelAcquisition ({ acquisitionId: requestedId }) {
        cancelCalls += 1
        t.is(requestedId, acquisitionId)
        events.push('cancel-start')
        job = { ...job, state: 'cancelled' }
        finishReader()
        await new Promise(resolve => setImmediate(resolve))
        events.push('reader-closed')
        await grants.revoke(grantToken)
        events.push('cancel-done')
        return { ...job }
      }
    }
  }

  const running = executeLocalFileAcquisition({
    runtime,
    publisherId,
    now: () => 1_000,
    input: {
      idempotencyKey: 'local_abort_test',
      path: '/private/staged/video.mp4',
      expectedBytes: 1,
      signal: controller.signal,
      dispose: () => events.push('dispose'),
      awaitCompletion: true
    }
  })

  await readerStarted
  controller.abort()
  const result = await running

  t.is(result.state, 'cancelled')
  t.is(result.sourceAccepted, true)
  t.is(cancelCalls, 1)
  t.alike(events, ['reader-started', 'cancel-start', 'reader-finished', 'reader-closed', 'dispose', 'cancel-done'])
})

test('CLI discovery may carry URL artwork and identityUrl without putting them in canonical identity', (t) => {
  const movieDetails = {
    title: 'The Matrix',
    mediaId: '603',
    artwork: [
      { url: 'https://image.tmdb.org/t/p/w500/matrix.jpg', role: 'poster' },
      { url: 'https://image.tmdb.org/t/p/original/backdrop.jpg', role: 'backdrop' },
    ],
  }
  const source = {
    provider: 'youtube',
    sourceVideoId: 'v123',
    identityUrl: 'https://youtube.com/watch?v=v123',
    displayUrl: 'https://youtube.com/watch?v=v123',
  }
  const draft = buildMovieItemDraft(movieDetails, source, {
    mediaProvider: 'tmdb',
    mediaId: '603',
  })

  t.is(draft.title, 'The Matrix')
  t.is(draft.mediaProvider, 'tmdb')
  t.is(draft.mediaId, '603')
  t.is(draft.sourceProvider, 'youtube')
  t.is(draft.identityUrl, source.identityUrl)
  t.is(draft.artwork.length, 2)
  t.ok(draft.artwork.every((entry) => entry.url), 'discovery artwork remains URL-bearing')

  // Canonical acquisition identity never absorbs discovery locators.
  const canon = canonicalLocalResolutionRecord({
    sha256: 'b'.repeat(64),
    byteLength: 2048,
    title: draft.title,
    fileName: 'matrix.mp4',
    kind: 'movie',
    namespace: draft.mediaProvider,
    identifier: draft.mediaId,
  })
  t.absent(String(JSON.stringify(canon)).includes('youtube.com'))
  t.absent(String(JSON.stringify(canon)).includes('tmdb.org'))
  t.absent(String(JSON.stringify(canon)).includes(source.identityUrl))
})
