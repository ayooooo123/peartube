import test from 'brittle'
import { createMusicBrainzProvider, MusicBrainzProviderError } from '../src/add/providers/musicbrainz.js'

// Payloads are trimmed copies of live MusicBrainz WS/2 and Cover Art Archive
// responses (Radiohead, "Airbag" / OK Computer), keeping every field this
// provider reads and the two facts that make MusicBrainz awkward: release
// genres come back empty while the release group carries them, and the archive
// hands out http:// urls.
const RECORDING_ID = '4a7fea2e-545b-4c63-bc9a-9943cc3a29d7'
const RELEASE_ID = '541a0976-ca45-3c0f-89e5-26bc376f58d1'
const RELEASE_GROUP_ID = 'b1392450-e666-3926-a536-22c65f834433'

function jsonResponse (body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, async json () { return body } }
}

// A clock the provider's rate limiter drives instead of real timers: `sleep`
// moves time forward and resolves immediately, so a one-request-per-second
// policy costs the test nothing.
function fakeClock () {
  let time = 0
  return {
    now: () => time,
    sleep: async (ms) => { time += ms }
  }
}

function routedFetch (routes, clock) {
  const calls = []
  const fetch = async (url, options = {}) => {
    calls.push({ url, options, at: clock.now() })
    for (const [pattern, response] of routes) {
      if (url.includes(pattern)) return typeof response === 'function' ? response(url, options) : response
    }
    throw new Error(`unexpected url ${url}`)
  }
  const matching = (pattern) => calls.filter((call) => call.url.includes(pattern))
  return { fetch, calls, matching }
}

function provider (fetch, clock, options = {}) {
  return createMusicBrainzProvider({ fetch, now: clock.now, sleep: clock.sleep, minIntervalMs: 1000, ...options })
}

const recordingSearchBody = {
  count: 2,
  recordings: [
    {
      id: RECORDING_ID,
      title: 'Airbag',
      length: 284400,
      'first-release-date': '1997-05-21',
      'artist-credit': [{ name: 'Radiohead', joinphrase: '' }],
      releases: [{ id: RELEASE_ID, title: 'OK Computer', date: '1997-06-16', 'release-group': { id: RELEASE_GROUP_ID } }]
    },
    {
      id: '11111111-1111-1111-1111-111111111111',
      title: 'Airbag (live)',
      length: 300000,
      'artist-credit': [{ name: 'Radiohead', joinphrase: ' feat. ' }, { name: 'A Choir', joinphrase: '' }],
      releases: [{ id: '22222222-2222-2222-2222-222222222222', title: 'I Might Be Wrong', date: '2001-11-12' }]
    },
    {
      id: '33333333-3333-3333-3333-333333333333',
      title: 'Airbag (rehearsal)',
      'artist-credit': [{ name: 'Radiohead', joinphrase: '' }],
      releases: []
    }
  ]
}

const releaseSearchBody = {
  count: 2,
  releases: [
    {
      id: RELEASE_ID,
      title: 'OK Computer',
      date: '1997-06-16',
      'artist-credit': [{ name: 'Radiohead', joinphrase: '' }],
      'release-group': { id: RELEASE_GROUP_ID }
    },
    {
      id: '44444444-4444-4444-4444-444444444444',
      title: 'OK Computer OKNOTOK 1997 2017',
      date: '2017-06-23',
      'artist-credit': [{ name: 'Radiohead', joinphrase: '' }]
    }
  ]
}

const recordingBody = {
  id: RECORDING_ID,
  title: 'Airbag',
  length: 284400,
  video: false,
  'first-release-date': '1997-05-21',
  'artist-credit': [{ name: 'Radiohead', joinphrase: '', artist: { id: 'a74b1b7f-71a5-4011-9441-d0b5e4122711', name: 'Radiohead' } }],
  genres: [{ id: 'g1', name: 'art rock', count: 2 }, { id: 'g2', name: 'alternative rock', count: 7 }],
  releases: [
    { id: RELEASE_ID, title: 'OK Computer', date: '1997-06-16', genres: [], 'release-group': { id: RELEASE_GROUP_ID, 'first-release-date': '1997-05-21', genres: [] } },
    { id: '55555555-5555-5555-5555-555555555555', title: 'OK Computer', date: '1997-07-01', 'release-group': { id: RELEASE_GROUP_ID, genres: [] } }
  ]
}

const releaseBody = {
  id: RELEASE_ID,
  title: 'OK Computer',
  date: '1997-06-16',
  country: 'GB',
  status: 'Official',
  'artist-credit': [{ name: 'Radiohead', joinphrase: '' }],
  // The live payload really does look like this: nothing on the release, the
  // taxonomy one level up on the release group.
  genres: [],
  'cover-art-archive': { artwork: true, front: true, back: true, count: 12, darkened: false },
  'release-group': {
    id: RELEASE_GROUP_ID,
    title: 'OK Computer',
    'first-release-date': '1997-05-21',
    'primary-type': 'Album',
    genres: [
      { id: 'g3', name: 'art rock', count: 13 },
      { id: 'g4', name: 'alternative rock', count: 26 },
      { id: 'g5', name: 'britpop', count: 1 }
    ]
  },
  media: [
    {
      position: 1,
      format: 'CD',
      'track-count': 2,
      tracks: [
        { id: 't1', position: 1, number: 'A1', title: 'Airbag', length: 284000, recording: { id: RECORDING_ID, title: 'Airbag', length: 284400 } },
        { id: 't2', position: 2, number: 'A2', title: 'Paranoid Android', length: 383000, recording: { id: '66666666-6666-6666-6666-666666666666', title: 'Paranoid Android', length: 383426 } }
      ]
    },
    {
      position: 2,
      format: 'CD',
      'track-count': 1,
      tracks: [
        { id: 't3', position: 1, number: 'B1', title: 'Lull', length: 145000, recording: { id: '77777777-7777-7777-7777-777777777777', title: 'Lull', length: 145000 } }
      ]
    }
  ]
}

const coverArtBody = {
  release: `https://musicbrainz.org/release/${RELEASE_ID}`,
  images: [
    {
      id: '1111',
      front: false,
      back: true,
      types: ['Back'],
      image: 'http://coverartarchive.org/release/541a0976/1111.jpg',
      thumbnails: { small: 'http://coverartarchive.org/release/541a0976/1111-250.jpg', large: 'http://coverartarchive.org/release/541a0976/1111-500.jpg' }
    },
    {
      id: '2222',
      front: true,
      back: false,
      types: ['Front'],
      image: 'http://coverartarchive.org/release/541a0976/2222.jpg',
      thumbnails: { small: 'http://coverartarchive.org/release/541a0976/2222-250.jpg', large: 'http://coverartarchive.org/release/541a0976/2222-500.jpg' }
    }
  ]
}

async function caught (promise) {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

test('every request identifies the client and asks for json, even when the caller blanks the agent', async (t) => {
  const clock = fakeClock()
  const { fetch, calls } = routedFetch([['ws/2/release?query=', jsonResponse(releaseSearchBody)]], clock)
  const blanked = provider(fetch, clock, { userAgent: '   ' })
  await blanked.search('ok computer', { kind: 'release' })

  const [call] = calls
  const agent = call.options.headers['User-Agent']
  t.ok(typeof agent === 'string' && agent.trim().length > 0, 'a blank userAgent cannot strip the header')
  t.ok(/peartube/i.test(agent), 'the agent names the application')
  t.ok(agent.includes('https://github.com/'), 'the agent carries a contact url')
  t.is(call.options.headers.Accept, 'application/json')
  t.ok(call.url.includes('fmt=json'), 'json is requested explicitly')

  const named = provider(fetch, clock, { userAgent: 'Custom/9.9 ( mailto:someone@example.com )' })
  await named.search('ok computer', { kind: 'release' })
  t.is(calls[1].options.headers['User-Agent'], 'Custom/9.9 ( mailto:someone@example.com )', 'a real agent is honoured')
})

test('timeoutMs bounds a request the caller did not bound itself', async (t) => {
  const clock = fakeClock()
  const { fetch, calls } = routedFetch([['ws/2/recording?query=', jsonResponse({ recordings: [] })]], clock)
  await provider(fetch, clock, { timeoutMs: 5000 }).search('x', { kind: 'track' })
  t.ok(calls[0].options.signal instanceof AbortSignal, 'the deadline reaches fetch')
  t.absent(calls[0].options.signal.aborted, 'and only bites later')

  const controller = new AbortController()
  const { fetch: passthrough, calls: own } = routedFetch([['ws/2/recording?query=', jsonResponse({ recordings: [] })]], clock)
  await provider(passthrough, clock).search('x', { kind: 'track', signal: controller.signal })
  t.is(own[0].options.signal, controller.signal, 'a caller that brought its own signal keeps it')
})

test('concurrent calls queue one interval apart on the injected clock', async (t) => {
  const clock = fakeClock()
  const { fetch, calls } = routedFetch([
    ['ws/2/recording?query=', jsonResponse({ recordings: [] })]
  ], clock)
  const client = provider(fetch, clock, { minIntervalMs: 1000 })

  const startedAt = Date.now()
  await Promise.all([
    client.search('one', { kind: 'track' }),
    client.search('two', { kind: 'track' }),
    client.search('three', { kind: 'track' })
  ])

  t.is(calls.length, 3)
  t.is(calls[0].at, 0)
  t.is(calls[1].at - calls[0].at, 1000, 'the second request waited a full interval')
  t.is(calls[2].at - calls[1].at, 1000, 'and so did the third')
  t.ok(Date.now() - startedAt < 250, 'the wait was on the injected clock, not the wall clock')
})

test('search merges both kinds, honours the limit, and derives ids, badges and years', async (t) => {
  const clock = fakeClock()
  const { fetch, calls } = routedFetch([
    ['ws/2/recording?query=', jsonResponse(recordingSearchBody)],
    ['ws/2/release?query=', jsonResponse(releaseSearchBody)]
  ], clock)
  const client = provider(fetch, clock, { searchLimit: 2 })
  const results = await client.search('airbag')

  t.is(results.length, 2, 'the merged list is cut to the search limit')
  t.ok(calls.every((call) => call.url.includes('limit=2')), 'the limit reaches MusicBrainz too')

  const [track, release] = results
  t.is(track.kind, 'track')
  t.is(track.badge, 'Track')
  t.is(track.provider, 'musicbrainz')
  t.is(track.mediaProvider, 'musicbrainz')
  t.is(track.mediaId, RECORDING_ID)
  t.is(track.id, `musicbrainz:track:${RECORDING_ID}`)
  t.is(track.title, 'Airbag')
  t.is(track.year, 1997)
  t.is(track.description, 'Radiohead — OK Computer', 'the artist credit stands in for the summary MusicBrainz never returns')
  t.alike(track.artwork, [], 'search results carry no artwork: one archive request per hit is not worth it')

  t.is(release.kind, 'release')
  t.is(release.badge, 'Release')
  t.is(release.id, `musicbrainz:release:${RELEASE_ID}`)
  t.is(release.year, 1997)
  t.is(release.description, 'Radiohead')
})

test('search joins multi-artist credits and reports an undated recording as year null', async (t) => {
  const clock = fakeClock()
  const { fetch } = routedFetch([['ws/2/recording?query=', jsonResponse(recordingSearchBody)]], clock)
  const results = await provider(fetch, clock).search('airbag', { kind: 'track' })

  t.is(results[1].description, 'Radiohead feat. A Choir — I Might Be Wrong', 'joinphrases are honoured')
  t.is(results[2].year, null, 'a recording with no release date has no year, not NaN')
  t.is(results[2].description, 'Radiohead')
})

test('getRecording keeps the exact milliseconds and reports whole minutes', async (t) => {
  const clock = fakeClock()
  const { fetch, matching } = routedFetch([
    ['coverartarchive.org/release/', jsonResponse(coverArtBody)],
    [`ws/2/recording/${RECORDING_ID}`, jsonResponse(recordingBody)]
  ], clock)
  const recording = await provider(fetch, clock).getRecording(RECORDING_ID)

  t.is(recording.durationMs, 284400, 'the only precise number survives untouched')
  t.is(recording.runtime, 5, '284400ms is five whole minutes')
  t.is(recording.kind, 'track')
  t.is(recording.mediaId, RECORDING_ID)
  t.is(recording.id, `musicbrainz:track:${RECORDING_ID}`)
  t.is(recording.title, 'Airbag')
  t.is(recording.artist, 'Radiohead')
  t.is(recording.description, 'Radiohead — OK Computer')
  t.is(recording.firstReleaseDate, '1997-05-21', 'the recording knows when it first appeared, ahead of this pressing')
  t.absent('releaseDate' in recording, 'one date field, precisely named')
  t.is(recording.year, 1997)
  t.is(recording.release.mediaId, RELEASE_ID, 'the earliest release is the one carried forward')
  t.is(recording.releaseGroupId, RELEASE_GROUP_ID)
  t.alike(recording.genres, ['alternative rock', 'art rock'], 'the recording had its own genres, most used first')
  t.is(matching('ws/2/release-group/').length, 0, 'no second lookup when the first response already answered')

  const [poster] = recording.artwork
  t.is(poster.role, 'poster')
  t.is(poster.provider, 'musicbrainz')
  t.is(poster.url, 'https://coverartarchive.org/release/541a0976/2222-500.jpg', 'the front cover, upgraded to https')
  t.is(poster.path, '/release/541a0976/2222-500.jpg')
  t.is(poster.size, 'large')
})

test('a release dated to the day outranks a bare year inside it', async (t) => {
  // Live data: "Airbag" appears on both the album, dated 1997-05-21, and a
  // Mercury Prize compilation dated only "1997". Compared as strings the
  // compilation wins, and the track ends up described by, and illustrated
  // with, a sampler it happens to be on.
  const clock = fakeClock()
  const ambiguous = {
    ...recordingBody,
    releases: [
      { id: '88888888-8888-8888-8888-888888888888', title: '1997 Mercury Music Prize: Albums of the Year', date: '1997', 'release-group': { id: '99999999-9999-9999-9999-999999999999' } },
      { id: RELEASE_ID, title: 'OK Computer', date: '1997-05-21', 'release-group': { id: RELEASE_GROUP_ID } }
    ]
  }
  const { fetch } = routedFetch([
    ['coverartarchive.org/release/', jsonResponse(coverArtBody)],
    [`ws/2/recording/${RECORDING_ID}`, jsonResponse(ambiguous)]
  ], clock)
  const recording = await provider(fetch, clock).getRecording(RECORDING_ID)

  t.is(recording.release.mediaId, RELEASE_ID, 'the precisely dated album wins')
  t.is(recording.description, 'Radiohead — OK Computer')
})

test('a recording with no genres of its own falls back to one release-group lookup', async (t) => {
  const clock = fakeClock()
  const { fetch, matching } = routedFetch([
    ['coverartarchive.org/release/', jsonResponse({ error: 'Not Found' }, { status: 404 })],
    [`ws/2/recording/${RECORDING_ID}`, jsonResponse({ ...recordingBody, genres: [] })],
    [`ws/2/release-group/${RELEASE_GROUP_ID}`, jsonResponse({ id: RELEASE_GROUP_ID, genres: [{ name: 'britpop', count: 1 }, { name: 'alternative rock', count: 26 }] })]
  ], clock)
  const recording = await provider(fetch, clock).getRecording(RECORDING_ID)

  const [lookup] = matching('ws/2/release-group/')
  t.ok(lookup, 'the release group was consulted exactly once')
  t.is(matching('ws/2/release-group/').length, 1)
  t.ok(lookup.url.includes('inc=genres'), 'and only for its genres')
  t.alike(recording.genres, ['alternative rock', 'britpop'])
  t.alike(recording.artwork, [], 'a 404 from the cover art archive is an answer, not a failure')
})

test('getRelease prefers release-group genres over the empty list on the release', async (t) => {
  const clock = fakeClock()
  const { fetch, calls } = routedFetch([
    ['coverartarchive.org/release/', jsonResponse(coverArtBody)],
    [`ws/2/release/${RELEASE_ID}`, jsonResponse(releaseBody)]
  ], clock)
  const release = await provider(fetch, clock).getRelease(RELEASE_ID)

  t.alike(release.genres, ['alternative rock', 'art rock', 'britpop'], 'release.genres was [], the release group had the taxonomy')
  t.is(release.kind, 'release')
  t.is(release.id, `musicbrainz:release:${RELEASE_ID}`)
  t.is(release.mediaId, RELEASE_ID)
  t.is(release.title, 'OK Computer')
  t.is(release.artist, 'Radiohead')
  t.is(release.description, 'Radiohead')
  t.is(release.date, '1997-06-16')
  t.absent('releaseDate' in release, 'a release has a date of its own; no alias for it')
  t.is(release.firstReleaseDate, '1997-05-21', 'the release group knows when the album first appeared')
  t.is(release.year, 1997)
  t.is(release.releaseGroupId, RELEASE_GROUP_ID)
  t.is(release.trackCount, 3, 'both discs count')
  t.is(release.durationMs, 812000)
  t.is(release.runtime, 14)
  t.alike(release.tracks.map((track) => track.title), ['Airbag', 'Paranoid Android', 'Lull'])
  t.alike(release.tracks[2], { position: 1, discNumber: 2, number: 'B1', title: 'Lull', mediaId: '77777777-7777-7777-7777-777777777777', durationMs: 145000 })
  t.is(release.artwork[0].url, 'https://coverartarchive.org/release/541a0976/2222-500.jpg')
  t.is(calls.filter((call) => call.url.includes('coverartarchive')).length, 1)
})

test('a release with genres nowhere emits none rather than an empty list', async (t) => {
  const clock = fakeClock()
  const bare = {
    ...releaseBody,
    genres: [],
    'cover-art-archive': { artwork: false, front: false, back: false, count: 0, darkened: false },
    'release-group': { id: RELEASE_GROUP_ID, title: 'OK Computer', genres: [] }
  }
  const { fetch, calls } = routedFetch([[`ws/2/release/${RELEASE_ID}`, jsonResponse(bare)]], clock)
  const release = await provider(fetch, clock).getRelease(RELEASE_ID)

  t.absent('genres' in release, 'absent metadata is absent, not []')
  t.is(release.genres, undefined)
  t.is(calls.length, 1, 'a release that declares no artwork is not asked for any')
  t.alike(release.artwork, [])
})

test('genres present only on the release itself are still read', async (t) => {
  const clock = fakeClock()
  const local = {
    ...releaseBody,
    genres: [{ name: 'trip hop', count: 4 }],
    'cover-art-archive': { artwork: false, count: 0 },
    'release-group': { id: RELEASE_GROUP_ID, genres: [] }
  }
  const { fetch } = routedFetch([[`ws/2/release/${RELEASE_ID}`, jsonResponse(local)]], clock)
  const release = await provider(fetch, clock).getRelease(RELEASE_ID)
  t.alike(release.genres, ['trip hop'])
})

test('cover art failures never fail the lookup', async (t) => {
  const clock = fakeClock()
  const { fetch } = routedFetch([
    ['coverartarchive.org/release/', jsonResponse('<!doctype html>', { status: 500 })],
    [`ws/2/release/${RELEASE_ID}`, jsonResponse(releaseBody)]
  ], clock)
  const release = await provider(fetch, clock).getRelease(RELEASE_ID)
  t.is(release.title, 'OK Computer')
  t.alike(release.artwork, [], 'a broken archive costs the artwork, not the metadata')

  const { fetch: refused } = routedFetch([
    ['coverartarchive.org/release/', () => { throw new Error('socket hang up') }],
    [`ws/2/release/${RELEASE_ID}`, jsonResponse(releaseBody)]
  ], clock)
  const second = await provider(refused, clock).getRelease(RELEASE_ID)
  t.alike(second.artwork, [])
})

test('503 and 429 both mean rate limited; other failures map to their own codes', async (t) => {
  const clock = fakeClock()
  const rated = provider(async () => jsonResponse({ error: 'slow down' }, { status: 503 }), clock)
  const rateError = await caught(rated.search('x', { kind: 'track' }))
  t.ok(rateError instanceof MusicBrainzProviderError)
  t.is(rateError.code, 'ERR_MUSICBRAINZ_RATE_LIMIT', '503 is how MusicBrainz says slow down')
  t.is(rateError.status, 503)

  const throttled = provider(async () => jsonResponse({}, { status: 429 }), clock)
  const throttledError = await caught(throttled.search('x', { kind: 'track' }))
  t.is(throttledError.code, 'ERR_MUSICBRAINZ_RATE_LIMIT')
  t.is(throttledError.status, 429)

  const missing = provider(async () => jsonResponse({}, { status: 404 }), clock)
  const missingError = await caught(missing.getRecording(RECORDING_ID))
  t.is(missingError.code, 'ERR_MUSICBRAINZ_HTTP')
  t.is(missingError.status, 404)

  const badJson = provider(async () => ({ ok: true, status: 200, async json () { throw new SyntaxError('bad json') } }), clock)
  t.is((await caught(badJson.search('x', { kind: 'track' }))).code, 'ERR_MUSICBRAINZ_INVALID_JSON')

  const aborted = provider(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }, clock)
  t.is((await caught(aborted.search('x', { kind: 'track' }))).code, 'ERR_MUSICBRAINZ_TIMEOUT')

  // The deadline built from `timeoutMs` rejects with TimeoutError, not
  // AbortError; reading it as a network fault hid a real timeout once.
  const expired = provider(async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) }, clock)
  t.is((await caught(expired.search('x', { kind: 'track' }))).code, 'ERR_MUSICBRAINZ_TIMEOUT')

  const offline = provider(async () => { throw new Error('getaddrinfo ENOTFOUND') }, clock)
  t.is((await caught(offline.search('x', { kind: 'track' }))).code, 'ERR_MUSICBRAINZ_NETWORK')
})

test('an unknown search kind is refused before any request', async (t) => {
  const clock = fakeClock()
  const client = provider(async () => { t.fail('should not fetch') }, clock)
  const error = await caught(client.search('x', { kind: 'album' }))
  t.ok(error instanceof MusicBrainzProviderError)
  t.is(error.code, 'ERR_MUSICBRAINZ_UNKNOWN_KIND')
})

test('an aborted signal is honoured while the request is still queued', async (t) => {
  const clock = fakeClock()
  const { fetch, calls } = routedFetch([['ws/2/recording?query=', jsonResponse({ recordings: [] })]], clock)
  const client = provider(fetch, clock)
  const controller = new AbortController()
  const first = client.search('one', { kind: 'track' })
  const second = client.search('two', { kind: 'track', signal: controller.signal })
  controller.abort()

  await first
  t.is((await caught(second)).code, 'ERR_MUSICBRAINZ_TIMEOUT')
  t.is(calls.length, 1, 'the queued request never went out')
})
