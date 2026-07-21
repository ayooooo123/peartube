import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTitleForTmdb, createTmdbClassifier, createTmdbDiscoverClient } from '../src/classification/tmdb.js'
import { RelayClassificationStore, classificationKey } from '../src/classification/store.js'
import { RelaySettings, resolveTmdbOptions } from '../src/settings.js'

function tmpStorage() {
  return mkdtempSync(join(tmpdir(), 'peartube-classify-'))
}

test('parseTitleForTmdb strips release noise and extracts year', function (t) {
  t.alike(parseTitleForTmdb('The Matrix (1999) 1080p BluRay x264'), { query: 'The Matrix', year: 1999 })
  t.alike(parseTitleForTmdb('Breaking Bad S01E03 [WEB-DL]'), { query: 'Breaking Bad', year: null })
  t.alike(parseTitleForTmdb('Some.Movie.2020.HDR.2160p'), { query: 'Some Movie', year: 2020 })
  t.alike(parseTitleForTmdb(''), { query: '', year: null })
})

test('classificationKey is stable for the same title', function (t) {
  t.is(classificationKey({ title: 'The Matrix (1999)' }), classificationKey({ title: 'the matrix 1999' }))
  t.is(classificationKey({ videoId: 'abc' }), 'id:abc')
})

test('createTmdbClassifier returns unknown when disabled', async function (t) {
  const classifier = createTmdbClassifier({ apiKey: '' })
  t.is(classifier.enabled, false)
  const result = await classifier.classify({ title: 'Anything' })
  t.is(result.type, 'unknown')
})

test('createTmdbClassifier picks the most popular movie/tv match', async function (t) {
  const calls = []
  const fetchFn = async (url) => {
    calls.push(url)
    const kind = url.includes('/search/movie') ? 'movie' : 'tv'
    return {
      ok: true,
      async json() {
        if (kind === 'movie') {
          return { results: [{ id: 603, title: 'The Matrix', release_date: '1999-03-30', popularity: 90, poster_path: '/m.jpg' }] }
        }
        return { results: [{ id: 1, name: 'Matrix Show', first_air_date: '2010-01-01', popularity: 5 }] }
      }
    }
  }
  const classifier = createTmdbClassifier({ apiKey: 'key', fetchFn })
  const result = await classifier.classify({ title: 'The Matrix 1999' })
  t.is(classifier.enabled, true)
  t.is(result.type, 'movie')
  t.is(result.tmdbId, 603)
  t.is(result.title, 'The Matrix')
  t.is(result.year, 1999)
  t.is(calls.length, 2, 'queries both movie and tv endpoints')
})

test('discover search keeps TV results that lack media_type (regression: /search/tv)', async function (t) {
  // TMDB's /search/{type} responses omit the media_type field that /trending
  // and /multi include. A TV hit carries `name`/`first_air_date`, so the shaper
  // must fall back to the queried type; otherwise it defaults to movie, reads
  // the title from `title` (undefined for TV), and drops every row — making TV
  // search silently return nothing.
  const fetchFn = async () => ({
    ok: true,
    async json () {
      return { results: [
        { id: 95396, name: 'Severance', first_air_date: '2022-02-18', popularity: 88, poster_path: '/s.jpg' },
        { id: 1, name: 'Other Show', first_air_date: '2019-01-01', popularity: 12 }
      ] }
    }
  })
  const discover = createTmdbDiscoverClient({ apiKey: 'key', fetchFn })
  const items = await discover.search({ query: 'severance', type: 'tv' })
  t.is(items.length, 2, 'TV search results are kept, not dropped')
  t.is(items[0].type, 'tv')
  t.is(items[0].title, 'Severance')
  t.is(items[0].tmdbId, 95396)
})

test('discover search keeps movie results that lack media_type', async function (t) {
  const fetchFn = async () => ({
    ok: true,
    async json () {
      return { results: [{ id: 603, title: 'The Matrix', release_date: '1999-03-31', popularity: 90, poster_path: '/m.jpg' }] }
    }
  })
  const discover = createTmdbDiscoverClient({ apiKey: 'key', fetchFn })
  const items = await discover.search({ query: 'matrix', type: 'movie' })
  t.is(items.length, 1)
  t.is(items[0].type, 'movie')
  t.is(items[0].title, 'The Matrix')
})

test('RelayClassificationStore caches results and avoids re-classifying', async function (t) {
  const storagePath = tmpStorage()
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))

  let classifyCalls = 0
  const classifier = {
    enabled: true,
    async classify() {
      classifyCalls += 1
      return { type: 'movie', tmdbId: 1, title: 'X', year: 2000 }
    }
  }

  const store = await RelayClassificationStore.open({ storagePath })
  const first = await store.classifyVideo({ classifier, videoId: 'v1', title: 'X (2000)' })
  const second = await store.classifyVideo({ classifier, videoId: 'v1', title: 'X (2000)' })
  t.is(first.type, 'movie')
  t.is(second.type, 'movie')
  t.is(classifyCalls, 1, 'cached on the second call')

  const reopened = await RelayClassificationStore.open({ storagePath })
  t.is(reopened.get({ videoId: 'v1' }).tmdbId, 1, 'cache persists to disk')
})

test('RelayClassificationStore returns null when classifier disabled and uncached', async function (t) {
  const storagePath = tmpStorage()
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))
  const store = await RelayClassificationStore.open({ storagePath })
  const result = await store.classifyVideo({ classifier: { enabled: false }, videoId: 'v9', title: 'Nope' })
  t.is(result, null)
})

test('resolveTmdbOptions lets runtime settings override config', async function (t) {
  const storagePath = tmpStorage()
  t.teardown(() => rmSync(storagePath, { recursive: true, force: true }))
  const settings = await RelaySettings.open({ storagePath })

  const config = { classification: { tmdb: { enabled: false, apiKey: '', baseUrl: 'https://api', language: 'en-US' } } }
  t.is(resolveTmdbOptions(config, settings).enabled, false)

  await settings.set('tmdbApiKey', 'runtime-key')
  await settings.set('tmdbEnabled', true)
  const resolved = resolveTmdbOptions(config, settings)
  t.is(resolved.apiKey, 'runtime-key')
  t.is(resolved.enabled, true)
})


test('TMDB clients honor enabled=false even when an API key exists', async function (t) {
  let fetchCalls = 0
  const fetchFn = async () => {
    fetchCalls += 1
    return { ok: true, async json() { return { results: [{ id: 1, title: 'Should Not Fetch', popularity: 1 }] } } }
  }

  const classifier = createTmdbClassifier({ apiKey: 'key', enabled: false, fetchFn })
  const discover = createTmdbDiscoverClient({ apiKey: 'key', enabled: false, fetchFn })

  t.is(classifier.enabled, false)
  t.is(discover.enabled, false)
  t.is((await classifier.classify({ title: 'The Matrix' })).type, 'unknown')
  t.alike(await discover.search({ query: 'matrix' }), [])
  t.is(fetchCalls, 0, 'disabled clients never call TMDB')
})

test('discover.seasons shapes and sorts TMDB seasons, dropping empty ones', async function (t) {
  const fetchFn = async () => ({
    ok: true,
    async json () {
      return {
        seasons: [
          { season_number: 2, name: 'Season 2', episode_count: 8, air_date: '2023-01-01' },
          { season_number: 1, name: 'Season 1', episode_count: 9, air_date: '2022-01-01' },
          { season_number: 0, name: 'Specials', episode_count: 0 }
        ]
      }
    }
  })
  const discover = createTmdbDiscoverClient({ apiKey: 'k', fetchFn })
  const seasons = await discover.seasons({ tmdbId: '95396' })
  t.is(seasons.length, 2, 'empty (0-episode) specials dropped')
  t.is(seasons[0].season, 1, 'sorted ascending')
  t.is(seasons[0].episodeCount, 9)
})

test('discover.episodes shapes and sorts TMDB episodes', async function (t) {
  const fetchFn = async () => ({
    ok: true,
    async json () {
      return {
        episodes: [
          { season_number: 1, episode_number: 2, name: 'Two', overview: 'b', air_date: '2022-01-08' },
          { season_number: 1, episode_number: 1, name: 'One', overview: 'a', air_date: '2022-01-01' }
        ]
      }
    }
  })
  const discover = createTmdbDiscoverClient({ apiKey: 'k', fetchFn })
  const eps = await discover.episodes({ tmdbId: '95396', season: 1 })
  t.is(eps.length, 2)
  t.is(eps[0].episode, 1, 'sorted ascending')
  t.is(eps[0].title, 'One')
  t.is(eps[1].episode, 2)
})

test('discover season/episode fetch is disabled without a key', async function (t) {
  const discover = createTmdbDiscoverClient({ apiKey: '' })
  t.alike(await discover.seasons({ tmdbId: '1' }), [])
  t.alike(await discover.episodes({ tmdbId: '1', season: 1 }), [])
})
