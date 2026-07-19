import test from 'brittle'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createTmdbProvider, TmdbProviderError } from '../src/add/providers/tmdb.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'))

function jsonResponse (body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, async json () { return body } }
}

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
  return { fetch, calls }
}

test('search normalizes tv and movie results, drops people, and derives badges', async (t) => {
  const { fetch, calls } = routedFetch([['/search/multi', jsonResponse(fixture('tmdb-search.json'))]])
  const provider = createTmdbProvider({ apiKey: 'token', fetch })
  const results = await provider.search('anything')

  t.is(results.length, 3, 'person result is ignored, tv/movie kept')
  const [show, movie, noDate] = results
  t.is(show.kind, 'tv')
  t.is(show.mediaId, '1396')
  t.is(show.id, 'tmdb:tv:1396')
  t.is(show.title, 'Breaking Bad')
  t.is(show.year, 2008)
  t.is(show.badge, 'TV')
  t.ok(show.description.length > 0)
  t.is(show.artwork.find((art) => art.role === 'poster').path, '/poster-bb.jpg')
  t.ok(show.artwork.find((art) => art.role === 'poster').url.includes('/poster-bb.jpg'))
  t.is(movie.kind, 'movie')
  t.is(movie.badge, 'Movie')
  t.is(movie.year, 1999)
  t.absent(movie.artwork.some((art) => art.role === 'backdrop'), 'null backdrop yields no record')
  t.is(noDate.year, null, 'empty air date is null, not NaN')
  t.ok(calls[0].url.includes('/search/multi'))
  t.ok(calls[0].url.includes('query=anything'))
})

test('getShow returns a channel profile with ascending seasons', async (t) => {
  const { fetch } = routedFetch([['/tv/1396', jsonResponse(fixture('tmdb-tv.json'))]])
  const provider = createTmdbProvider({ apiKey: 'token', fetch })
  const show = await provider.getShow('1396')

  t.is(show.kind, 'channel')
  t.is(show.profileKind, 'tvShow')
  t.is(show.mediaProvider, 'tmdb')
  t.is(show.mediaId, '1396')
  t.is(show.year, 2008)
  t.alike(show.seasons.map((season) => season.seasonNumber), [0, 1, 2], 'seasons sorted ascending')
  t.is(show.seasons.find((season) => season.seasonNumber === 1).episodeCount, 7)
})

test('getSeason returns episodes sorted by number with stills and air dates', async (t) => {
  const { fetch } = routedFetch([['/tv/1396/season/1', jsonResponse(fixture('tmdb-season.json'))]])
  const provider = createTmdbProvider({ apiKey: 'token', fetch })
  const episodes = await provider.getSeason('1396', 1)

  t.alike(episodes.map((episode) => episode.episodeNumber), [1, 2], 'episodes sorted ascending')
  const [pilot] = episodes
  t.is(pilot.seasonNumber, 1)
  t.is(pilot.title, 'Pilot')
  t.is(pilot.airDate, '2008-01-20')
  t.is(pilot.artwork.find((art) => art.role === 'still').path, '/still-101.jpg')
})

test('getMovie returns a movie profile with runtime and artwork', async (t) => {
  const { fetch } = routedFetch([['/movie/603', jsonResponse(fixture('tmdb-movie.json'))]])
  const provider = createTmdbProvider({ apiKey: 'token', fetch })
  const movie = await provider.getMovie('603')

  t.is(movie.kind, 'channel')
  t.is(movie.profileKind, 'movie')
  t.is(movie.mediaId, '603')
  t.is(movie.year, 1999)
  t.is(movie.runtime, 136)
  t.is(movie.artwork.find((art) => art.role === 'poster').path, '/poster-matrix.jpg')
})

async function caught (promise) {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

test('missing api key throws a typed error before any request', async (t) => {
  const provider = createTmdbProvider({ apiKey: '', fetch: async () => { t.fail('should not fetch') } })
  const error = await caught(provider.search('x'))
  t.ok(error instanceof TmdbProviderError)
  t.is(error.code, 'ERR_TMDB_MISSING_KEY')
})

test('http, rate limit, invalid json, and abort map to typed provider errors', async (t) => {
  const httpProvider = createTmdbProvider({ apiKey: 'token', fetch: async () => jsonResponse({}, { status: 404 }) })
  const httpError = await caught(httpProvider.search('x'))
  t.is(httpError.code, 'ERR_TMDB_HTTP')
  t.is(httpError.status, 404)

  const rateProvider = createTmdbProvider({ apiKey: 'token', fetch: async () => jsonResponse({}, { status: 429 }) })
  t.is((await caught(rateProvider.search('x'))).code, 'ERR_TMDB_RATE_LIMIT')

  const badJson = createTmdbProvider({ apiKey: 'token', fetch: async () => ({ ok: true, status: 200, async json () { throw new SyntaxError('bad json') } }) })
  t.is((await caught(badJson.search('x'))).code, 'ERR_TMDB_INVALID_JSON')

  const aborted = createTmdbProvider({ apiKey: 'token', fetch: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) } })
  t.is((await caught(aborted.search('x'))).code, 'ERR_TMDB_TIMEOUT')
})
