import test from 'brittle'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createTvdbProvider, TvdbProviderError } from '../src/add/providers/tvdb.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'))

const API_KEY = 'tvdb-secret-key-do-not-leak'

function jsonResponse (body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, async json () { return body } }
}

const loginOk = (token = 'session-token-1') => jsonResponse({ status: 'success', data: { token } })

// Routes are [urlSubstring, responder]; a responder may be a value or a
// function of (url, options) so a route can change answer per call.
function routedFetch (routes) {
  const calls = []
  const fetch = async (url, options = {}) => {
    calls.push({ url, options })
    for (const [pattern, response] of routes) {
      if (url.includes(pattern)) {
        return typeof response === 'function' ? response(url, options) : response
      }
    }
    throw new Error(`unexpected url ${url}`)
  }
  return {
    fetch,
    calls,
    logins: () => calls.filter((call) => call.url.includes('/login')),
    dataCalls: () => calls.filter((call) => !call.url.includes('/login'))
  }
}

// A provider whose token exchange succeeds and whose data routes come from the
// caller, which is the shape almost every case below wants.
function harness (routes, options = {}) {
  const routed = routedFetch([['/login', () => loginOk()], ...routes])
  return { ...routed, provider: createTvdbProvider({ apiKey: API_KEY, fetch: routed.fetch, ...options }) }
}

async function caught (promise) {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

test('login happens once and the bearer token is reused across calls', async (t) => {
  const { provider, calls, logins, dataCalls } = harness([
    ['/series/81189/extended', jsonResponse(fixture('tvdb-series.json'))],
    ['/movies/604/extended', jsonResponse(fixture('tvdb-movie.json'))]
  ])

  await provider.getShow('81189')
  await provider.getMovie('604')

  t.is(logins().length, 1, 'token exchange happens once, not per request')
  t.is(logins()[0].options.method, 'POST')
  t.is(calls[0].url, 'https://api4.thetvdb.com/v4/login', 'login is the first call')
  for (const call of dataCalls()) {
    t.is(call.options.headers.Authorization, 'Bearer session-token-1', 'every data call carries the cached token')
  }
  t.absent(dataCalls().some((call) => call.url.includes(API_KEY)), 'the api key never rides in a url')
})

test('concurrent first calls share a single token exchange', async (t) => {
  const { provider, logins } = harness([
    ['/series/81189/extended', jsonResponse(fixture('tvdb-series.json'))],
    ['/movies/604/extended', jsonResponse(fixture('tvdb-movie.json'))]
  ])

  await Promise.all([provider.getShow('81189'), provider.getMovie('604')])
  t.is(logins().length, 1, 'a race for the token still logs in once')
})

test('a 401 refreshes the token once and retries the request', async (t) => {
  let logins = 0
  let showCalls = 0
  const routed = routedFetch([
    ['/login', () => { logins += 1; return loginOk(`session-token-${logins}`) }],
    ['/series/81189/extended', () => {
      showCalls += 1
      return showCalls === 1 ? jsonResponse({ status: 'failure' }, { status: 401 }) : jsonResponse(fixture('tvdb-series.json'))
    }]
  ])
  const provider = createTvdbProvider({ apiKey: API_KEY, fetch: routed.fetch })

  const show = await provider.getShow('81189')

  t.is(show.name, 'Breaking Bad', 'the retry result is returned')
  t.is(logins, 2, 'exactly one re-login')
  t.is(showCalls, 2, 'exactly one retry')
  t.is(routed.dataCalls()[0].options.headers.Authorization, 'Bearer session-token-1')
  t.is(routed.dataCalls()[1].options.headers.Authorization, 'Bearer session-token-2', 'retry uses the refreshed token')
})

test('a second 401 fails instead of looping', async (t) => {
  let logins = 0
  const routed = routedFetch([
    ['/login', () => { logins += 1; return loginOk(`session-token-${logins}`) }],
    ['/series/81189/extended', () => jsonResponse({ status: 'failure' }, { status: 401 })]
  ])
  const provider = createTvdbProvider({ apiKey: API_KEY, fetch: routed.fetch })

  const error = await caught(provider.getShow('81189'))

  t.ok(error instanceof TvdbProviderError)
  t.is(error.code, 'ERR_TVDB_HTTP')
  t.is(error.status, 401)
  t.is(logins, 2, 'no more than one re-login attempt')
  t.is(routed.dataCalls().length, 2, 'no more than one retry')
  t.absent(error.message.includes(API_KEY), 'the api key stays out of the message')
})

test('a refreshed token is reused by later calls', async (t) => {
  let logins = 0
  let showCalls = 0
  const routed = routedFetch([
    ['/login', () => { logins += 1; return loginOk(`session-token-${logins}`) }],
    ['/series/81189/extended', () => {
      showCalls += 1
      return showCalls === 1 ? jsonResponse({}, { status: 401 }) : jsonResponse(fixture('tvdb-series.json'))
    }],
    ['/movies/604/extended', jsonResponse(fixture('tvdb-movie.json'))]
  ])
  const provider = createTvdbProvider({ apiKey: API_KEY, fetch: routed.fetch })

  await provider.getShow('81189')
  await provider.getMovie('604')

  t.is(logins, 2, 'the refreshed token is cached, not re-fetched')
  t.is(routed.dataCalls().at(-1).options.headers.Authorization, 'Bearer session-token-2')
})

test('missing api key throws a typed error before any request', async (t) => {
  for (const apiKey of [undefined, '', '   ']) {
    let fetched = 0
    const provider = createTvdbProvider({ apiKey, fetch: async () => { fetched += 1; return loginOk() } })
    const error = await caught(provider.search('x'))
    t.ok(error instanceof TvdbProviderError)
    t.is(error.code, 'ERR_TVDB_MISSING_KEY')
    t.is(fetched, 0, 'no network call is attempted without a key')
  }
})

test('the login body omits pin when unset and sends it when set', async (t) => {
  const withoutPin = harness([['/series/81189/extended', jsonResponse(fixture('tvdb-series.json'))]])
  await withoutPin.provider.getShow('81189')
  const bare = JSON.parse(withoutPin.logins()[0].options.body)
  t.alike(Object.keys(bare), ['apikey'], 'pin is omitted entirely, not sent as null or ""')
  t.is(bare.apikey, API_KEY)
  t.is(withoutPin.logins()[0].options.headers['Content-Type'], 'application/json')

  const withPin = harness([['/series/81189/extended', jsonResponse(fixture('tvdb-series.json'))]], { pin: '4321' })
  await withPin.provider.getShow('81189')
  t.alike(JSON.parse(withPin.logins()[0].options.body), { apikey: API_KEY, pin: '4321' })

  const emptyPin = harness([['/series/81189/extended', jsonResponse(fixture('tvdb-series.json'))]], { pin: '' })
  await emptyPin.provider.getShow('81189')
  t.alike(Object.keys(JSON.parse(emptyPin.logins()[0].options.body)), ['apikey'], 'a blank pin is treated as unset')
})

test('search maps series and movies to the shared item shape and drops other types', async (t) => {
  const { provider, dataCalls } = harness([['/search', jsonResponse(fixture('tvdb-search.json'))]])
  const results = await provider.search('breaking bad')

  t.is(results.length, 3, 'person and company results are ignored')
  const [show, movie, noDate] = results

  t.is(show.kind, 'tv')
  t.is(show.provider, 'tvdb')
  t.is(show.mediaProvider, 'tvdb')
  t.is(show.mediaId, '81189')
  t.is(show.id, 'tvdb:tv:81189')
  t.is(show.title, 'Breaking Bad')
  t.is(show.year, 2008)
  t.is(show.badge, 'TV')
  t.ok(show.description.length > 0)
  const poster = show.artwork.find((art) => art.role === 'poster')
  t.is(poster.provider, 'tvdb')
  t.is(poster.path, 'https://artworks.thetvdb.com/banners/posters/81189-6.jpg')
  t.is(poster.url, 'https://artworks.thetvdb.com/banners/posters/81189-6.jpg')

  t.is(movie.kind, 'movie')
  t.is(movie.badge, 'Movie')
  t.is(movie.mediaId, '604')
  t.is(movie.id, 'tvdb:movie:604')
  t.is(movie.year, 1999)
  t.is(
    movie.artwork.find((art) => art.role === 'poster').url,
    'https://artworks.thetvdb.com/banners/movies/604/posters/604.jpg',
    'an http artwork url is upgraded to https'
  )
  t.is(
    movie.artwork.find((art) => art.role === 'poster').path,
    'http://artworks.thetvdb.com/banners/movies/604/posters/604.jpg',
    'path keeps exactly what tvdb returned'
  )

  t.is(noDate.year, null, 'no air date and no year is null, not 0 or NaN')
  t.is(noDate.description, '')
  t.is(noDate.mediaId, '424242', 'a missing tvdb_id falls back to the prefixed object id')
  t.is(
    noDate.artwork.find((art) => art.role === 'poster').url,
    'https://artworks.thetvdb.com/banners/posters/424242-1.jpg',
    'a relative artwork path resolves against the artwork host'
  )

  const search = dataCalls()[0]
  t.ok(search.url.startsWith('https://api4.thetvdb.com/v4/search?'))
  t.ok(search.url.includes('query=breaking%20bad'))
})

test('search honours searchLimit after filtering', async (t) => {
  const { provider } = harness([['/search', jsonResponse(fixture('tvdb-search.json'))]], { searchLimit: 2 })
  const results = await provider.search('breaking bad')
  t.is(results.length, 2)
  t.alike(results.map((item) => item.kind), ['tv', 'movie'])
})

test('getShow returns a channel profile with official seasons ascending', async (t) => {
  const { provider, dataCalls } = harness([['/series/81189/extended', jsonResponse(fixture('tvdb-series.json'))]])
  const show = await provider.getShow('81189')

  t.is(show.kind, 'channel')
  t.is(show.profileKind, 'tvShow')
  t.is(show.provider, 'tvdb')
  t.is(show.mediaProvider, 'tvdb')
  t.is(show.mediaId, '81189')
  t.is(show.name, 'Breaking Bad')
  t.ok(show.description.length > 0)
  t.is(show.year, 2008)
  t.is(show.originalLanguage, 'eng')
  t.alike(show.seasons.map((season) => season.seasonNumber), [0, 1, 2], 'dvd-order duplicate dropped, ascending')
  t.alike(show.seasons.map((season) => season.name), ['Specials', 'Season 1', 'The One With The Plane'])
  t.alike(show.seasons.map((season) => season.episodeCount), [null, null, null], 'tvdb does not report per-season counts')
  t.alike(show.seasons.map((season) => season.airDate), [null, null, null])

  t.alike(show.artwork.map((art) => art.role), ['poster', 'backdrop'], 'icon artwork is ignored')
  t.is(show.artwork[0].url, 'https://artworks.thetvdb.com/banners/posters/81189-6.jpg')
  t.is(
    show.artwork[1].url,
    'https://artworks.thetvdb.com/banners/fanart/original/81189-3.jpg',
    'the highest scoring backdrop wins'
  )
  t.ok(dataCalls()[0].url.endsWith('/series/81189/extended'))
})

test('getSeason returns episodes for the requested season only, sorted ascending', async (t) => {
  const { provider, dataCalls } = harness([['/series/81189/episodes/default', jsonResponse(fixture('tvdb-episodes.json'))]])
  const episodes = await provider.getSeason('81189', 1)

  t.alike(episodes.map((episode) => episode.episodeNumber), [1, 2], 'season 2 leakage filtered, sorted ascending')
  const [pilot, second] = episodes
  t.is(pilot.seasonNumber, 1)
  t.is(pilot.title, 'Pilot')
  t.is(pilot.airDate, '2008-01-20')
  t.ok(pilot.description.length > 0)
  const still = pilot.artwork.find((art) => art.role === 'still')
  t.is(still.url, 'https://artworks.thetvdb.com/banners/episodes/81189/349232.jpg')
  t.is(second.artwork[0].url, 'http://artworks.thetvdb.com/banners/episodes/81189/349233.jpg'.replace('http://', 'https://'))

  const request = dataCalls()[0]
  t.ok(request.url.includes('/series/81189/episodes/default'))
  t.ok(request.url.includes('season=1'), 'the season filter is sent to the api as well')
})

test('getSeason can request specials as season zero', async (t) => {
  const specials = { status: 'success', data: { series: { id: 81189 }, episodes: [{ name: 'Good Cop Bad Cop', seasonNumber: 0, number: 1, aired: '', overview: null, image: null }] } }
  const { provider, dataCalls } = harness([['/series/81189/episodes/default', jsonResponse(specials)]])
  const episodes = await provider.getSeason('81189', 0)

  t.ok(dataCalls()[0].url.includes('season=0'), 'season zero is not dropped as falsy')
  t.is(episodes.length, 1)
  t.is(episodes[0].airDate, null, 'a blank air date is null')
  t.is(episodes[0].description, '')
  t.alike(episodes[0].artwork, [], 'no image means no artwork record')
})

test('getMovie returns a movie profile with runtime and artwork', async (t) => {
  const { provider, dataCalls } = harness([['/movies/604/extended', jsonResponse(fixture('tvdb-movie.json'))]])
  const movie = await provider.getMovie('604')

  t.is(movie.kind, 'channel')
  t.is(movie.profileKind, 'movie')
  t.is(movie.provider, 'tvdb')
  t.is(movie.mediaProvider, 'tvdb')
  t.is(movie.mediaId, '604')
  t.is(movie.title, 'The Matrix')
  t.ok(movie.description.length > 0)
  t.is(movie.year, 1999)
  t.is(movie.originalLanguage, 'eng')
  t.is(movie.runtime, 136)
  t.alike(movie.artwork.map((art) => art.role), ['poster', 'backdrop'])
  t.is(movie.artwork[0].path, 'https://artworks.thetvdb.com/banners/movies/604/posters/604.jpg')
  t.ok(dataCalls()[0].url.endsWith('/movies/604/extended'))
})

test('absent runtime, year and language are null rather than 0 or empty string', async (t) => {
  const sparse = { status: 'success', data: { id: 7, name: 'Unreleased', overview: '', originalLanguage: '', runtime: null } }
  const { provider } = harness([['/movies/7/extended', jsonResponse(sparse)]])
  const movie = await provider.getMovie('7')

  t.is(movie.year, null)
  t.is(movie.runtime, null)
  t.is(movie.originalLanguage, null)
  t.alike(movie.artwork, [])

  const sparseShow = { status: 'success', data: { id: 8, name: 'Unaired', seasons: null, artworks: null } }
  const showHarness = harness([['/series/8/extended', jsonResponse(sparseShow)]])
  const show = await showHarness.provider.getShow('8')
  t.is(show.year, null)
  t.is(show.originalLanguage, null)
  t.alike(show.seasons, [])
  t.alike(show.artwork, [])
})

test('year falls back to the bare year field when no date is present', async (t) => {
  const noDate = { status: 'success', data: { id: 9, name: 'Yearly', year: '2021', runtime: 0 } }
  const { provider } = harness([['/movies/9/extended', jsonResponse(noDate)]])
  const movie = await provider.getMovie('9')
  t.is(movie.year, 2021)
  t.is(movie.runtime, 0, 'a real zero runtime is preserved')
})

test('each failure mode maps to its own typed code and never echoes the key', async (t) => {
  const cases = [
    ['ERR_TVDB_HTTP', 404, () => jsonResponse({ message: 'not found' }, { status: 404 })],
    ['ERR_TVDB_RATE_LIMIT', 429, () => jsonResponse({}, { status: 429 })],
    ['ERR_TVDB_HTTP', 500, () => jsonResponse({}, { status: 500 })]
  ]
  for (const [code, status, responder] of cases) {
    const { provider } = harness([['/search', responder]])
    const error = await caught(provider.search('x'))
    t.is(error.code, code, `status ${status} maps to ${code}`)
    t.is(error.status, status)
    t.absent(error.message.includes(API_KEY))
  }

  const badJson = harness([['/search', { ok: true, status: 200, async json () { throw new SyntaxError('bad json') } }]])
  t.is((await caught(badJson.provider.search('x'))).code, 'ERR_TVDB_INVALID_JSON')

  const network = harness([['/search', () => { throw new Error(`socket hang up for ${API_KEY}`) }]])
  const networkError = await caught(network.provider.search('x'))
  t.is(networkError.code, 'ERR_TVDB_NETWORK')
  t.absent(networkError.message.includes(API_KEY), 'a cause mentioning the key is not echoed')

  const aborted = harness([['/search', () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }]])
  t.is((await caught(aborted.provider.search('x'))).code, 'ERR_TVDB_TIMEOUT')
})

test('login failures surface as typed errors without leaking the key', async (t) => {
  const routed = routedFetch([['/login', () => jsonResponse({ message: 'unauthorized' }, { status: 401 })]])
  const provider = createTvdbProvider({ apiKey: API_KEY, fetch: routed.fetch })
  const error = await caught(provider.search('x'))
  t.is(error.code, 'ERR_TVDB_HTTP')
  t.is(error.status, 401)
  t.is(routed.calls.length, 1, 'a rejected login is not retried')
  t.absent(error.message.includes(API_KEY))

  const tokenless = routedFetch([['/login', () => jsonResponse({ status: 'success', data: {} })]])
  const noToken = createTvdbProvider({ apiKey: API_KEY, fetch: tokenless.fetch })
  const tokenError = await caught(noToken.search('x'))
  t.is(tokenError.code, 'ERR_TVDB_INVALID_JSON')
  t.absent(tokenError.message.includes(API_KEY))

  const rateLimited = routedFetch([['/login', () => jsonResponse({}, { status: 429 })]])
  const throttled = createTvdbProvider({ apiKey: API_KEY, fetch: rateLimited.fetch })
  t.is((await caught(throttled.search('x'))).code, 'ERR_TVDB_RATE_LIMIT')
})

test('a failed login is not cached, so a later call retries it', async (t) => {
  let logins = 0
  const routed = routedFetch([
    ['/login', () => { logins += 1; return logins === 1 ? jsonResponse({}, { status: 500 }) : loginOk() }],
    ['/series/81189/extended', jsonResponse(fixture('tvdb-series.json'))]
  ])
  const provider = createTvdbProvider({ apiKey: API_KEY, fetch: routed.fetch })

  t.is((await caught(provider.getShow('81189'))).code, 'ERR_TVDB_HTTP')
  const show = await provider.getShow('81189')
  t.is(show.name, 'Breaking Bad', 'the second attempt logs in again and succeeds')
  t.is(logins, 2)
})

test('timeoutMs aborts a stalled request as a timeout', async (t) => {
  const hanging = async (url, options = {}) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    }, { once: true })
  })
  const provider = createTvdbProvider({ apiKey: API_KEY, fetch: hanging, timeoutMs: 10 })
  t.is((await caught(provider.search('x'))).code, 'ERR_TVDB_TIMEOUT')
})

test('a caller signal aborts in flight requests', async (t) => {
  const controller = new AbortController()
  const hanging = async (url, options = {}) => {
    queueMicrotask(() => controller.abort())
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }, { once: true })
    })
  }
  const provider = createTvdbProvider({ apiKey: API_KEY, fetch: hanging })
  t.is((await caught(provider.search('x', { signal: controller.signal }))).code, 'ERR_TVDB_TIMEOUT')
})
